// Bounded native metadata preflight. It owns only its detached process group.
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

/** Run a bounded native metadata preflight in its own process group. */
async function probeMetadata({ executable, cwd, env, signal, timeoutMs = 2000, maxBytes = 65536, args, allowedExits = [0], protocol }) {
  validOptions({ executable, cwd, env, timeoutMs, maxBytes, signal, args });
  if (!['darwin', 'linux'].includes(process.platform)) throw probeError('UNSUPPORTED_PLATFORM');
  if (signal?.aborted) throw probeError('CANCELLED');
  let child;
  try {
    child = spawn(executable, args, { cwd, env: { ...env }, shell: false, detached: true, stdio: [protocol ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  } catch { throw probeError('PROTOCOL_ERROR'); }

  let bytes = 0;
  let stdout = Buffer.alloc(0);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
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
    resolveResult({ code: allowedExits.includes(exitCode) && !(protocol && stdout.length) ? null : 'PROTOCOL_ERROR' });
  };
  const count = chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) { void finish('OUTPUT_LIMIT'); return false; }
    return true;
  };
  child.stdout.on('data', chunk => {
    if (settled || finishing || !count(chunk)) return;
    stdout = Buffer.concat([stdout, chunk]);
    if (!protocol) return;
    try {
      let newline;
      while ((newline = stdout.indexOf(10)) !== -1) {
        const line = utf8.decode(stdout.subarray(0, newline)).trim();
        stdout = stdout.subarray(newline + 1);
        if (line && protocol.onMessage(JSON.parse(line), send)) child.stdin.end();
      }
    } catch { void finish('PROTOCOL_ERROR'); }
  });
  child.stderr.on('data', count);
  child.stdout.on('close', completeNormally);
  child.stderr.on('close', completeNormally);
  child.on('exit', code => { exited = true; exitCode = code; completeNormally(); });
  child.on('close', () => { childClosed = true; completeNormally(); });
  child.on('error', () => { void finish('PROTOCOL_ERROR'); });
  abortHandler = () => { void finish('CANCELLED'); };
  if (signal) signal.addEventListener('abort', abortHandler, { once: true });
  const timer = setTimeout(() => { void finish('RPC_TIMEOUT'); }, timeoutMs);
  if (protocol) {
    child.stdin.on('error', () => { if (!exited) void finish('PROTOCOL_ERROR'); });
    send(protocol.initialize);
  }

  const outcome = await result;
  if (outcome.code) throw probeError(outcome.code);
  let text;
  try { text = utf8.decode(stdout); } catch { throw probeError('PROTOCOL_ERROR'); }
  return { text, exitCode };
}

export async function probeVersion({ args = ['--version'], ...options } = {}) {
  if (!Array.isArray(args) || args.at(-1) !== '--version') throw probeError('INVALID_OPTIONS');
  const { text } = await probeMetadata({ ...options, args });
  const match = /^\s*codex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/i.exec(text);
  if (!match) throw probeError('VERSION_MISMATCH');
  return match[1];
}

export async function probeCodexEmbeddedCli({ resume, ...options } = {}) {
  const { text } = await probeMetadata({ ...options, args: resume ? ['resume', '--help'] : ['--help'] });
  return /^[ \t]+--no-daemon(?:[ \t]|$)/m.test(text);
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
  const configDirectory = options.env?.CLAUDE_CONFIG_DIR;
  if (configDirectory && value?.configDirectory !== undefined && value.configDirectory !== configDirectory)
    return { state: 'unverified' };
  if (value?.loggedIn === false && exitCode === 1) return { state: 'signed-out' };
  if (value?.loggedIn === true && exitCode === 0 && ['claude.ai', 'oauth', 'claudeai'].includes(value.authMethod)) {
    const accountLabel = safeAccountEmail(value.email);
    return { state: 'signed-in', route: 'native subscription', ...(accountLabel ? { accountLabel } : {}) };
  }
  return { state: 'unverified' };
}

export function safeAccountEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@<>\p{Cc}\p{Cf}]+@[^\s@<>\p{Cc}\p{Cf}]+$/u.test(value)
    ? value : undefined;
}

function codexAccountObservation(account) {
  if (account === null) return { state: 'signed-out' };
  if (account.type === 'apiKey') return { state: 'signed-in', accountLabel: 'API key' };
  if (account.type !== 'chatgpt') return { state: 'unverified' };
  const accountLabel = safeAccountEmail(account.email);
  return { state: 'signed-in', ...(accountLabel ? { accountLabel } : {}) };
}

export async function probeCodexAccount({ timeoutMs = 10000, ...options }) {
  let initialized = false, observation;
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { clientInfo: { name: 'xfx-account-check', title: 'Xenoflux Account Check', version: '1' }, capabilities: null } };
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  const protocol = {
    initialize,
    onMessage(message, send) {
      if (!isObject(message)) throw probeError('PROTOCOL_ERROR');
      if (typeof message.method === 'string' && !Object.hasOwn(message, 'id')) return false;
      if (message.error || Object.hasOwn(message, 'method') || !isObject(message.result)) throw probeError('PROTOCOL_ERROR');
      if (!initialized && message.id === 1) {
        initialized = true;
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({ jsonrpc: '2.0', id: 2, method: 'account/read', params: { refreshToken: false } });
        return false;
      }
      if (initialized && !observation && message.id === 2
        && (message.result.account === null || isObject(message.result.account))) {
        observation = codexAccountObservation(message.result.account);
        return true;
      }
      throw probeError('PROTOCOL_ERROR');
    },
  };
  await probeMetadata({ ...options, args: ['app-server'], timeoutMs, protocol });
  if (!observation) throw probeError('PROTOCOL_ERROR');
  return observation;
}
