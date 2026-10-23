// Bounded owner for non-interactive audit commands. Output is written only to
// caller-selected, exclusive private files; callbacks receive parsed JSONL.
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';

const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const DEFAULT_LIMIT = 8 * 1024 * 1024;
const MAX_LINE = 256 * 1024;
const MAX_INPUT_CHUNK = 256 * 1024;
const isAsyncIterable = value => value && typeof value[Symbol.asyncIterator] === 'function';

function validate(o) {
  if (!o || typeof o.executable !== 'string' || !o.executable.startsWith('/') || o.executable.includes('\0') ||
      !Array.isArray(o.args) || o.args.some(x => typeof x !== 'string' || x.includes('\0')) ||
      typeof o.cwd !== 'string' || !o.cwd.startsWith('/') || o.cwd.includes('\0') ||
      !o.env || Object.getPrototypeOf(o.env) !== Object.prototype ||
      Object.entries(o.env).some(([k, v]) => !k || k.includes('=') || k.includes('\0') || typeof v !== 'string' || v.includes('\0')) ||
      typeof o.stdoutPath !== 'string' || !o.stdoutPath.startsWith('/') ||
      typeof o.stderrPath !== 'string' || !o.stderrPath.startsWith('/') ||
      !Number.isFinite(o.timeoutMs) || o.timeoutMs < 1 ||
      (o.outputLimitBytes !== undefined && (!Number.isSafeInteger(o.outputLimitBytes) || o.outputLimitBytes < 1)) ||
      (o.input !== undefined && typeof o.input !== 'string' && !Buffer.isBuffer(o.input) && !isAsyncIterable(o.input)) ||
      (o.signal !== undefined && typeof o.signal?.addEventListener !== 'function') ||
      ['onSpawn', 'onEvent'].some(k => o[k] !== undefined && typeof o[k] !== 'function')) {
    throw new TypeError('Invalid audit process options');
  }
}

function alive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}

async function stopGroup(pid) {
  const signal = name => { if (alive(pid)) { try { process.kill(-pid, name); } catch {} } };
  const wait = async ms => {
    const end = Date.now() + ms;
    while (alive(pid) && Date.now() < end) await delay(Math.min(20, end - Date.now()));
    return !alive(pid);
  };
  if (!await wait(50)) signal('SIGTERM');
  if (!await wait(400)) signal('SIGKILL');
  if (!await wait(1000)) return { groupTerminated: false, escapedDescendantsUnverified: true };
  return { groupTerminated: true, escapedDescendantsUnverified: true };
}

async function identity(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'pid=,lstart=,comm='], { timeout: 1500, maxBuffer: 4096 });
    const line = stdout.trim();
    const m = line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/);
    if (!m || Number(m[1]) !== pid) return null;
    return { pid, started: m[2].trim(), command: m[3].trim(), host: hostname() };
  } catch { return null; }
}

/** Return same-host process metadata when the platform probe can observe it. */
export async function getAuditProcessIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  return identity(pid);
}

/** Read-only recovery observation. Stored identity is never used to signal. */
export async function observeAuditProcess(expected, { identityProbe = identity } = {}) {
  if (!expected || !Number.isSafeInteger(expected.pid) || expected.pid < 1 || typeof expected.started !== 'string' || typeof expected.host !== 'string') return { status: 'unknown' };
  if (expected.host !== hostname()) return { status: 'unknown' };
  let current;
  try { current = await identityProbe(expected.pid); } catch { current = null; }
  if (!current) {
    try { process.kill(expected.pid, 0); return { status: 'unknown' }; }
    catch (error) {
      if (error?.code !== 'ESRCH') return { status: 'unknown' };
    }
    // A detached leader can exit before its children. Absence of its PID
    // does not establish that the owned group stopped; recovery never signals
    // this saved group, including when the read-only probe is denied.
    try { process.kill(-expected.pid, 0); return { status: 'unknown' }; }
    catch (error) {
      return { status: error?.code === 'ESRCH' ? 'stopped' : 'unknown' };
    }
  }
  if (current.started !== expected.started) return { status: 'different' };
  // exec() replaces a wrapper's command without ending its process. A command
  // change with the same start identity cannot prove the recorded owner stopped.
  if (expected.command && current.command !== expected.command) return { status: 'unknown' };
  return { status: 'running', processIdentity: current };
}

export async function runAuditProcess(options = {}) {
  validate(options);
  const { executable, args, cwd, env, input, timeoutMs, outputLimitBytes = DEFAULT_LIMIT,
    stdoutPath, stderrPath, signal, onSpawn, onEvent } = options;
  if (signal?.aborted) return { status: 'cancelled', exitCode: null, signal: null, elapsedMs: 0, pid: null, processIdentity: null, shutdown: { groupTerminated: true, escapedDescendantsUnverified: true }, output: { bytes: 0, truncated: false } };

  let out, err;
  try {
    out = await open(stdoutPath, 'wx', 0o600);
    err = await open(stderrPath, 'wx', 0o600);
  } catch {
    await out?.close().catch(() => {});
    throw new Error('Unable to create exclusive audit output files');
  }

  const startedAt = Date.now();
  let child;
  try {
    child = spawn(executable, args, { cwd, env: { ...env }, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    await Promise.all([out.close(), err.close()]);
    return { status: 'spawn-failed', exitCode: null, signal: null, elapsedMs: Date.now() - startedAt, pid: null, processIdentity: null, shutdown: { groupTerminated: true, escapedDescendantsUnverified: true }, output: { bytes: 0, truncated: false } };
  }

  let status = null, exitCode = null, exitSignal = null, total = 0, truncated = false, firstError = null;
  let stopWriter;
  const writerStopped = new Promise(resolve => { stopWriter = resolve; });
  let forceResolve;
  const forced = new Promise(resolve => { forceResolve = resolve; });
  const trigger = kind => { status ||= kind; stopWriter(); forceResolve(); };
  let lineNumber = { stdout: 0, stderr: 0 }, lineBuffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const files = { stdout: out, stderr: err };
  const fail = reason => { if (!firstError) firstError = reason; };
  const emitLines = async (stream, chunk, final = false) => {
    const combined = Buffer.concat([lineBuffers[stream], chunk]);
    let offset = 0;
    while (true) {
      const nl = combined.indexOf(10, offset);
      if (nl < 0) break;
      const line = combined.subarray(offset, nl);
      offset = nl + 1;
      lineNumber[stream]++;
      if (line.length > MAX_LINE) { await onEvent?.({ stream, lineNumber: lineNumber[stream], parseError: 'line-too-long' }); continue; }
      try { await onEvent?.({ stream, lineNumber: lineNumber[stream], value: JSON.parse(line.toString('utf8')) }); }
      catch (e) { if (e instanceof SyntaxError) await onEvent?.({ stream, lineNumber: lineNumber[stream], parseError: 'invalid-json' }); else throw e; }
    }
    lineBuffers[stream] = combined.subarray(offset);
    if (lineBuffers[stream].length > MAX_LINE) {
      lineBuffers[stream] = Buffer.alloc(0);
      lineNumber[stream]++;
      await onEvent?.({ stream, lineNumber: lineNumber[stream], parseError: 'line-too-long' });
    }
    if (final && lineBuffers[stream].length) {
      lineNumber[stream]++;
      try { await onEvent?.({ stream, lineNumber: lineNumber[stream], value: JSON.parse(lineBuffers[stream].toString('utf8')) }); }
      catch (e) { if (e instanceof SyntaxError) await onEvent?.({ stream, lineNumber: lineNumber[stream], parseError: 'invalid-json' }); else throw e; }
      lineBuffers[stream] = Buffer.alloc(0);
    }
  };

  const processChunk = async (stream, chunk) => {
    const remaining = Math.max(0, outputLimitBytes - total);
    const accepted = chunk.subarray(0, remaining);
    total += accepted.length;
    if (accepted.length) {
      await files[stream].write(accepted);
      await emitLines(stream, accepted);
    }
    if (accepted.length < chunk.length) { truncated = true; child.stdout.pause(); child.stderr.pause(); trigger('output-limit'); }
  };
  const attach = (stream, readable) => readable.on('data', chunk => {
    readable.pause();
    processChunk(stream, chunk).then(() => {
      if (status !== 'output-limit' && !firstError) readable.resume();
    }).catch(e => { fail(e); trigger('failed'); });
  });
  attach('stdout', child.stdout); attach('stderr', child.stderr);

  const exited = new Promise(resolve => {
    child.once('error', e => { fail(e); status ||= 'spawn-failed'; stopWriter(); forceResolve(); resolve(); });
    child.once('close', (code, sig) => { exitCode = code; exitSignal = sig; stopWriter(); resolve(); });
  });
  let abortHandler;
  const aborted = new Promise(resolve => {
    abortHandler = () => { trigger('cancelled'); resolve(); };
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
  const timer = setTimeout(() => trigger('timeout'), timeoutMs);
  let processIdentity = null;
  let inputIterator;
  const writeInput = async () => {
    if (input === undefined) { child.stdin.end(); return; }
    const source = isAsyncIterable(input) ? input : (async function* () { yield input; })();
    inputIterator = source[Symbol.asyncIterator]();
    const writeChunk = async chunk => {
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) throw new TypeError('Invalid audit input chunk');
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (size > MAX_INPUT_CHUNK) throw new RangeError('Audit input chunk exceeds limit');
      if (status !== null || child.stdin.destroyed) return false;
      if (!child.stdin.write(chunk)) {
        await Promise.race([
          new Promise((resolve, reject) => {
            child.stdin.once('drain', resolve);
            child.stdin.once('error', reject);
            child.stdin.once('close', resolve);
          }),
          writerStopped,
        ]);
      }
      return status === null && !child.stdin.destroyed;
    };
    while (status === null && !child.stdin.destroyed) {
      const next = inputIterator.next();
      const result = await Promise.race([next, writerStopped.then(() => ({ stopped: true }))]);
      if (result?.stopped || status !== null) break;
      if (result.done) { child.stdin.end(); return; }
      if (!await writeChunk(result.value)) break;
    }
    if (inputIterator.return) void Promise.resolve(inputIterator.return()).catch(() => {});
  };
  try {
    if (child.pid) processIdentity = await identity(child.pid);
    try { await onSpawn?.({ pid: child.pid, processIdentity }); }
    catch (e) { fail(e); status ||= 'failed'; }
    if (signal?.aborted) trigger('cancelled');
    if (!firstError && status === null) writeInput().catch(e => { fail(e); trigger('failed'); });
    else child.stdin.end();
    if (status === null) await Promise.race([exited, aborted, forced]);
    if (status === 'timeout' || status === 'cancelled' || status === 'output-limit' || status === 'failed') {
      if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
    }
    let shutdown = { groupTerminated: true, escapedDescendantsUnverified: true };
    if (child.pid) shutdown = await stopGroup(child.pid);
    if (!shutdown.groupTerminated) status = 'shutdown-failed';
    if (status === null) status = firstError ? 'failed' : 'exited';
    for (const stream of ['stdout', 'stderr']) {
      try { await emitLines(stream, Buffer.alloc(0), true); }
      catch (e) { fail(e); status = 'failed'; }
    }
    if (inputIterator?.return) void Promise.resolve(inputIterator.return()).catch(() => {});
    if (firstError && status === 'exited') status = 'failed';
    return { status, exitCode, signal: exitSignal, elapsedMs: Date.now() - startedAt, pid: child.pid,
      processIdentity, shutdown, output: { bytes: total, truncated } };
  } finally {
    clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    await Promise.all([out.close().catch(() => {}), err.close().catch(() => {})]);
  }
}
