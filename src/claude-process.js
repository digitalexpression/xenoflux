// Own the selected SDK child and track descendants even if they leave its process group.
import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { getAuditProcessIdentity } from './audit-process.js';

const exec = promisify(execFile);
const systemEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};

export async function claudeDeadline(promise, ms, message, signal) {
  let timer, abort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      abort = () => reject(new Error('Claude operation cancelled'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function processTable() {
  const { stdout } = await exec('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,uid=,lstart=,state=,command='],
    { env: systemEnv, maxBuffer: 4 * 1024 * 1024, timeout: 1000 });
  const rows = new Map();
  for (const line of stdout.split('\n').filter(value => value.trim())) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.+)$/);
    if (!m) throw new Error('Claude process ancestry could not be observed');
    const [, pid, ppid, pgid, uid, started, state, args] = m;
    if (!state.startsWith('Z')) rows.set(+pid, { pid: +pid, ppid: +ppid, pgid: +pgid, uid: +uid, started, args });
  }
  return rows;
}

export async function claudeProcessCwd(pid) {
  const { stdout } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
    { env: systemEnv, maxBuffer: 32 * 1024, timeout: 1500 });
  const paths = stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  if (paths.length !== 1) throw new Error('Claude process working directory was not observable');
  return paths[0];
}

const sameBirth = (left, right) => left && right && left.pid === right.pid && left.pgid === right.pgid
  && left.uid === right.uid && left.started === right.started;
const same = (left, right) => sameBirth(left, right) && left.args === right.args;

export function ownClaudeProcess({ stdoutPath, stderrPath, outputLimitBytes, onFrame, onInput, stop,
  snapshot = processTable, spawnProcess = spawn }) {
  const startedAt = Date.now();
  let out, err, child, output, outputDone, closeInfo, owned, checkpointed, interval, sweep, identityFrozen = false, degraded = false, observationError = null;
  let bytes = 0, truncated = false, pending = Buffer.alloc(0);
  const seen = new Map(), changes = new Set(), closed = deferred(), firstIdentity = deferred();
  const accountType = frame => frame?.type === 'control_response' || frame?.type === 'auth_status';
  const observe = () => sweep ??= snapshot().then(rows => {
    if (!child?.pid) return rows;
    const row = rows.get(child.pid);
    if (!owned && row) {
      if (row.ppid !== process.pid || row.uid !== process.getuid() || row.pgid !== row.pid)
        throw new Error('Claude process ownership could not be verified');
      owned = row; seen.set(row.pid, row); firstIdentity.resolve(row);
    }
    if (owned && sameBirth(owned, row) && row.args !== owned.args && !identityFrozen) {
      owned = row; seen.set(row.pid, row);
    }
    // ps can lose argv while a process is exiting. Do not signal a changed
    // observation; distinguish a surviving identity change from a vanished PID.
    for (const prior of seen.values()) {
      const current = rows.get(prior.pid);
      if (sameBirth(prior, current) && !same(prior, current)) {
        if (changes.has(prior.pid)) stop(new Error('Claude process arguments changed during capture'));
        changes.add(prior.pid);
      } else changes.delete(prior.pid);
    }
    const valid = new Set([...seen.values()].filter(prior => same(prior, rows.get(prior.pid))).map(prior => prior.pid));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values()) {
        if (row.uid !== process.getuid() || valid.has(row.pid) || !valid.has(row.ppid)) continue;
        const prior = seen.get(row.pid);
        if (prior && !same(prior, row)) continue;
        if (seen.size >= 2048) throw new Error('Claude descendant observation limit exceeded');
        valid.add(row.pid); seen.set(row.pid, row); changed = true;
      }
    }
    return rows;
  }).catch(error => { degraded = true; observationError ??= error.message; firstIdentity.reject(error); stop(error); return null; })
    .finally(() => { sweep = null; });
  function consume(chunk, stream) {
    bytes += chunk.length;
    if (bytes > outputLimitBytes) { truncated = true; throw new Error('Claude native output limit exceeded'); }
    if (stream === 'stderr') return; // Native diagnostics can contain account or tool secrets.
    pending = Buffer.concat([pending, chunk]);
    for (let at = pending.indexOf(10); at >= 0; at = pending.indexOf(10)) {
      const line = pending.subarray(0, at);
      pending = pending.subarray(at + 1);
      if (!line.length) continue;
      const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (!accountType(frame)) writeSync(out, line), writeSync(out, '\n');
      onFrame(frame);
    }
  }
  function start(options) {
    if (child) throw new Error('Claude attempted to start another process');
    out = openSync(stdoutPath, 'wx', 0o600);
    err = openSync(stderrPath, 'wx', 0o600);
    child = spawnProcess(options.command, options.args, { cwd: options.cwd, env: options.env, detached: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', error => { firstIdentity.reject(error); stop(new Error('Selected Claude executable did not start')); });
    child.once('close', (exitCode, signal) => { closeInfo = { exitCode, signal }; closed.resolve(); });
    child.stdin.on('error', () => {});
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, encoding, callback) => {
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      try {
        const text = Buffer.isBuffer(chunk) ? new TextDecoder('utf-8', { fatal: true }).decode(chunk) : chunk;
        if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || !text.endsWith('\n'))
          throw new Error('Claude SDK wrote an incomplete or oversized input frame');
        for (const line of text.trimEnd().split('\n')) onInput(JSON.parse(line));
        return write(chunk, encoding, callback);
      } catch (error) { stop(error); callback?.(error); return false; }
    };
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (...args) => {
      if (args[0] != null && typeof args[0] !== 'function') {
        stop(new Error('Claude SDK attempted to send data while closing stdin'));
        return end();
      }
      return end(...args);
    };
    output = new Transform({ transform(chunk, _encoding, callback) {
      try { consume(chunk, 'stdout'); callback(null, chunk); }
      catch (error) { stop(error); callback(error); }
    }, flush(callback) {
      if (pending.length) { stop(new Error('Claude protocol stream ended with an incomplete frame')); callback(); }
      else callback();
    } });
    output.on('error', () => {});
    outputDone = finished(output).catch(() => {});
    child.stdout.on('error', error => stop(error));
    child.stdout.pipe(output);
    child.stderr.on('data', chunk => { try { consume(chunk, 'stderr'); } catch (error) { stop(error); } });
    void observe();
    interval = setInterval(() => { void observe(); }, 150);
    return { stdin: child.stdin, stdout: output, get killed() { return child.killed; },
      get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
      kill: name => child.kill(name), on: (...args) => child.on(...args), once: (...args) => child.once(...args),
      off: (...args) => child.off(...args) };
  }
  async function identity(signal, freeze = false) {
    await claudeDeadline(firstIdentity.promise, 3000, 'Claude process identity timed out', signal);
    const rows = await observe();
    if (!same(owned, rows?.get(owned.pid))) throw new Error('Claude process identity changed');
    const current = await getAuditProcessIdentity(owned.pid);
    if (!current || current.host !== hostname() || !same(owned, (await observe())?.get(owned.pid)))
      throw new Error('Claude native process identity could not be checkpointed');
    if (freeze) identityFrozen = true;
    checkpointed = current;
    return { pid: owned.pid, processIdentity: current, nativeAncestry: { root: owned } };
  }
  async function stopOwned() {
    async function signalOwned(name) {
      const rows = await observe();
      if (!rows) return;
      for (const prior of [...seen.values()].reverse()) {
        if (!same(prior, rows.get(prior.pid))) continue;
        try { process.kill(prior.pid, name); } catch (error) { if (error.code !== 'ESRCH') degraded = true; }
      }
    }
    if (child) {
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        await Promise.race([closed.promise, delay(signal === 'SIGTERM' ? 2200 : 500)]);
        await signalOwned(signal);
      }
      await Promise.race([closed.promise, delay(900)]);
    }
    clearInterval(interval);
    let remaining = [];
    if (child) {
      let rows = await observe();
      if (rows && [...seen.values()].some(row => sameBirth(row, rows.get(row.pid)))) {
        await delay(100); rows = await observe();
      }
      if (!rows) degraded = true;
      remaining = [...seen.values()].filter(prior => sameBirth(prior, rows?.get(prior.pid)));
      if (owned) {
        try { process.kill(-owned.pgid, 0); degraded = true; observationError ??= 'Claude process group still exists'; }
        catch (error) { if (error.code !== 'ESRCH') degraded = true; }
      }
      if (!closeInfo) {
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
        output.destroy();
      }
      // The SDK may stop consuming the readable after an interrupt result.
      // Drain already processed bytes after the underlying pipes have closed.
      if (closeInfo) output.resume();
      try { await claudeDeadline(outputDone, 500, 'Claude output did not close'); }
      catch { degraded = true; observationError ??= 'Claude output stream did not close'; output.destroy(); }
    }
    if (out !== undefined) closeSync(out);
    if (err !== undefined) closeSync(err);
    const confirmed = !child || Boolean(owned && closeInfo && !degraded && !remaining.length);
    return { status: confirmed ? truncated ? 'output-limit' : child ? 'exited' : 'spawn-failed' : 'shutdown-failed',
      elapsedMs: Date.now() - startedAt, pid: child?.pid ?? null,
      ...(checkpointed ? { processIdentity: checkpointed } : {}),
      exitCode: closeInfo?.exitCode ?? null, signal: closeInfo?.signal ?? null,
      output: { bytes, truncated }, shutdown: { groupTerminated: confirmed, mainCloseJoined: !child || Boolean(closeInfo),
        observedDescendants: Math.max(0, seen.size - 1), remainingPids: remaining.map(row => row.pid),
        escapedDescendantsUnverified: Boolean(child), observationError } };
  }
  return { start, identity, stop: stopOwned };
}
