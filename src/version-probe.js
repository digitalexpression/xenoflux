// Bounded native version preflight. It owns only its detached process group.
import { spawn } from 'node:child_process';

const MESSAGES = {
  INVALID_OPTIONS: 'Invalid version probe options',
  RPC_TIMEOUT: 'Version probe timed out',
  PROTOCOL_ERROR: 'Version probe failed',
  OUTPUT_LIMIT: 'Version output limit exceeded',
  CANCELLED: 'Version probe cancelled',
  SHUTDOWN_FAILED: 'Version probe shutdown failed',
  VERSION_MISMATCH: 'Codex version output is not recognized',
  UNSUPPORTED_PLATFORM: 'Version probing requires macOS or Linux',
};
const probeError = code => Object.assign(new Error(MESSAGES[code] ?? 'Version probe failed'), { code });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function validOptions({ executable, cwd, env, timeoutMs, maxBytes, signal, args }) {
  if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0') ||
      typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0') ||
      !env || Object.getPrototypeOf(env) !== Object.prototype ||
      Object.entries(env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0')) ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0 ||
      !Array.isArray(args) || args.length > 100
        || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function'))) throw probeError('INVALID_OPTIONS');
}

/** Run only a bounded native `--version` preflight in its own process group. */
async function probeMetadata({ executable, cwd, env, signal, timeoutMs = 2000, maxBytes = 65536, args, allowedExits = [0] }) {
  validOptions({ executable, cwd, env, timeoutMs, maxBytes, signal, args });
  if (!['darwin', 'linux'].includes(process.platform)) throw probeError('UNSUPPORTED_PLATFORM');
  if (signal?.aborted) throw probeError('CANCELLED');
  let child;
  try {
    child = spawn(executable, args, { cwd, env: { ...env }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw probeError('PROTOCOL_ERROR'); }

  let bytes = 0;
  let stdout = Buffer.alloc(0);
  let exited = false;
  let childClosed = false;
  let exitCode = null;
  let settled = false;
  let finishing = null;
  let abortHandler;
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const groupAlive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (caught) { return caught?.code === 'EPERM'; }
  };
  const waitGroup = async ms => {
    const until = Date.now() + ms;
    while (groupAlive() && Date.now() < until) await delay(Math.min(25, Math.max(1, until - Date.now())));
    return !groupAlive();
  };
  const waitStreams = async ms => {
    const until = Date.now() + ms;
    while (!childClosed && Date.now() < until) await delay(Math.min(25, Math.max(1, until - Date.now())));
    return childClosed;
  };
  const signalGroup = kind => {
    if (!groupAlive()) return;
    try { process.kill(-child.pid, kind); } catch { /* checked by waitGroup */ }
  };
  const cleanup = async () => {
    if (!(await waitGroup(100))) {
      signalGroup('SIGTERM');
      if (!(await waitGroup(400))) {
        signalGroup('SIGKILL');
        if (!(await waitGroup(800))) throw probeError('SHUTDOWN_FAILED');
      }
    }
    if (!(await waitStreams(250))) throw probeError('SHUTDOWN_FAILED');
  };
  const finish = code => {
    if (finishing) return finishing;
    finishing = (async () => {
      let finalCode = code;
      try { await cleanup(); } catch (caught) { finalCode = caught?.code === 'SHUTDOWN_FAILED' ? 'SHUTDOWN_FAILED' : 'PROTOCOL_ERROR'; }
      settled = true;
      clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      resolveResult({ code: finalCode });
    })();
    return finishing;
  };
  const completeNormally = () => {
    if (settled || finishing || !exited || !childClosed) return;
    if (groupAlive()) { void finish('PROTOCOL_ERROR'); return; }
    settled = true;
    clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    resolveResult({ code: allowedExits.includes(exitCode) ? null : 'PROTOCOL_ERROR' });
  };
  const count = chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) { void finish('OUTPUT_LIMIT'); return false; }
    return true;
  };
  child.stdout.on('data', chunk => { if (count(chunk)) stdout = Buffer.concat([stdout, Buffer.from(chunk)]); });
  child.stderr.on('data', count);
  child.stdout.on('close', completeNormally);
  child.stderr.on('close', completeNormally);
  child.on('exit', code => { exited = true; exitCode = code; completeNormally(); });
  child.on('close', () => { childClosed = true; completeNormally(); });
  child.on('error', () => { void finish('PROTOCOL_ERROR'); });
  abortHandler = () => { void finish('CANCELLED'); };
  if (signal) signal.addEventListener('abort', abortHandler, { once: true });
  const timer = setTimeout(() => { void finish('RPC_TIMEOUT'); }, timeoutMs);

  const outcome = await result;
  if (outcome.code) throw probeError(outcome.code);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(stdout); } catch { throw probeError('PROTOCOL_ERROR'); }
  return { text, exitCode };
}

export async function probeVersion({ args = ['--version'], ...options } = {}) {
  if (!Array.isArray(args) || args.at(-1) !== '--version') throw probeError('INVALID_OPTIONS');
  const { text } = await probeMetadata({ ...options, args });
  const match = /^\s*codex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/i.exec(text);
  if (!match) throw probeError('VERSION_MISMATCH');
  return match[1];
}

export async function probeNativeProfileVersion(client, options) {
  const { text } = await probeMetadata({ ...options, args: ['--version'] });
  const match = (client === 'claude-code'
    ? /^\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s+\(Claude Code\)\s*$/i
    : /^\s*(?:GitHub )?Copilot CLI(?: Version)?[: ]+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*[0-9A-Za-z-])?)\.?(?:\s+.*)?\s*$/i).exec(text);
  if (!match) throw new Error('Unrecognized native CLI version');
  return match[1];
}

export async function probeClaudeAccount(options) {
  const { text, exitCode } = await probeMetadata({ ...options, args: ['auth', 'status'], timeoutMs: 10000,
    maxBytes: 16384, allowedExits: [0, 1] });
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Unrecognized Claude sign-in status'); }
  if (value?.loggedIn === false && exitCode === 1) return { state: 'signed-out' };
  if (value?.loggedIn === true && exitCode === 0 && ['claude.ai', 'oauth', 'claudeai'].includes(value.authMethod))
    return { state: 'signed-in', route: 'native subscription' };
  return { state: 'unverified' };
}
