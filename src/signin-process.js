import { spawn } from 'node:child_process';
import { getAuditProcessIdentity } from './audit-process.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const limit = 64 * 1024;

export function createSigninDecoder(client, onProgress) {
  let text = '', last = '';
  return (chunk, final = false) => {
    text = (text + chunk).slice(-limit);
    const clean = text.replace(/\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, ' $1 ')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    let browserUrl, claudeAuthorization = false;
    if (client === 'copilot' && /https:\/\/github\.com\/login\/device(?:\s|$)/.test(clean)) browserUrl = 'https://github.com/login/device';
    if (client === 'claude-code') for (const match of clean.matchAll(/https:\/\/[^\s<>"'\x00-\x1f]+/g)) {
      if (!final && match.index + match[0].length === clean.length) continue;
      try {
        const url = new URL(match[0]);
        const authorization = (['claude.ai', 'claude.com', 'platform.claude.com'].includes(url.hostname) && url.pathname === '/oauth/authorize')
          || (url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize');
        if (url.protocol === 'https:' && authorization && !url.username && !url.password && !url.port && !url.hash
          && ![...url.searchParams].some(([key, value]) => /^(?:access_token|refresh_token|id_token|token|client_secret|authorization)$/i.test(key) || key === 'code' && value !== 'true')) claudeAuthorization = true;
      } catch {}
    }
    const code = client === 'copilot' ? clean.match(/(?:one-time code|https:\/\/github\.com\/login\/device\s+and enter code)[:\s(]*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i)?.[1]?.toUpperCase() : undefined;
    const progress = { ...(claudeAuthorization ? { state: 'waiting-for-browser' } : {}), ...(browserUrl ? { browserUrl } : {}), ...(code ? { deviceCode: code } : {}) };
    const signature = JSON.stringify(progress);
    if ((claudeAuthorization || browserUrl || code) && signature !== last) { last = signature; onProgress(progress); }
  };
}

export async function runSigninProcess({ executable, args, cwd, env, client, signal, timeoutMs = 300000, onProgress, onSpawn }) {
  if (signal?.aborted) return { status: 'cancelled', exitCode: null, shutdown: { groupTerminated: true } };
  const child = spawn(executable, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let reason, bytes = 0, failure, exitCode = null, exitSignal = null;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const stop = state => { reason ??= state; finish(); };
  const decoders = { stdout: createSigninDecoder(client, progress => onProgress?.(progress)), stderr: createSigninDecoder(client, progress => onProgress?.(progress)) };
  const consume = (stream, chunk) => {
    bytes += chunk.length;
    if (bytes > limit) { stop('output-limit'); return; }
    try { decoders[stream](chunk.toString('utf8')); } catch (error) { failure = error; stop('failed'); }
  };
  child.stdout.on('data', chunk => consume('stdout', chunk)); child.stderr.on('data', chunk => consume('stderr', chunk));
  child.once('error', () => stop('spawn-failed'));
  child.once('close', (code, sig) => { exitCode = code; exitSignal = sig; finish(); });
  const abort = () => stop('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const alive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  };
  const wait = async ms => {
    const until = Date.now() + ms;
    while (alive() && Date.now() < until) await delay(20);
    return !alive();
  };
  let processIdentity;
  try {
    if (child.pid) processIdentity = await getAuditProcessIdentity(child.pid);
    await onSpawn?.(processIdentity);
    await finished;
  } catch (error) { failure = error; reason ??= 'failed'; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  if (!await wait(50)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    if (!await wait(500)) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
  const groupTerminated = await wait(1000);
  for (const decoder of Object.values(decoders)) decoder('', true);
  return { status: reason ?? (failure ? 'failed' : 'exited'), exitCode, signal: exitSignal,
    processIdentity, shutdown: { groupTerminated, escapedDescendantsUnverified: true } };
}
