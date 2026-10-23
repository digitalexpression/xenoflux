import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runAuditProcess, observeAuditProcess } from '../src/audit-process.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-audit-process-'));
  let runId = 0;
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    run: (script, extra = {}) => {
      const id = ++runId;
      return runAuditProcess({ executable: process.execPath, args: ['-e', script], cwd: dir,
        env: { PATH: process.env.PATH || '' }, timeoutMs: 3000, stdoutPath: join(dir, `stdout-${id}`), stderrPath: join(dir, `stderr-${id}`), ...extra });
    },
  };
}

test('captures JSONL incrementally, reports malformed lines, and keeps output files private', async t => {
  const f = await fixture(t), events = [];
  const result = await f.run("process.stdout.write('{\\\"ok\\\":1}\\nnot-json\\n'); process.stderr.write('{\\\"err\\\":true}\\n')", { onEvent: e => events.push(e) });
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  // Independent OS pipes do not establish ordering between stdout and stderr.
  assert.deepEqual(events.filter(e => e.stream === 'stdout').map(e => e.parseError || e.value), [{ ok: 1 }, 'invalid-json']);
  assert.deepEqual(events.filter(e => e.stream === 'stderr').map(e => e.parseError || e.value), [{ err: true }]);
  assert.equal((await stat(join(f.dir, 'stdout-1'))).mode & 0o777, 0o600);
  assert.equal('contents' in result.output, false);
});

test('timeout and cancellation terminate the owned group', async t => {
  const f = await fixture(t);
  const timed = await f.run('setInterval(() => {}, 1000)', { timeoutMs: 40 });
  assert.equal(timed.status, 'timeout');
  assert.equal(timed.shutdown.groupTerminated, true);

  const controller = new AbortController();
  const running = f.run('setInterval(() => {}, 1000)', { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  const cancelled = await running;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.shutdown.groupTerminated, true);
});

test('caps combined output and stops when an event consumer fails', async t => {
  const f = await fixture(t);
  const capped = await f.run("setInterval(() => process.stdout.write('0123456789'), 1)", { outputLimitBytes: 2048 });
  assert.equal(capped.status, 'output-limit');
  assert.equal(capped.output.bytes, 2048);
  assert.equal(capped.output.truncated, true);

  const failed = await f.run("process.stdout.write('{\\\"a\\\":1}\\n'); setInterval(() => {}, 1000)", {
    onEvent: () => { throw new Error('consumer failed'); },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.shutdown.groupTerminated, true);
});

test('cleans descendants after leader exit without affecting an unrelated process', async t => {
  const f = await fixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-unrelated.pid, 'SIGKILL'); } catch {} });
  const script = "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.exit(0);";
  const result = await f.run(script);
  assert.equal(result.status, 'exited');
  assert.equal(result.shutdown.groupTerminated, true);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test('persists and observes same-host process identity without signaling stored PIDs', async t => {
  const f = await fixture(t);
  let saved;
  const result = await f.run('setInterval(() => {}, 1000)', {
    timeoutMs: 70,
    onSpawn: value => { saved = value.processIdentity; },
  });
  assert.equal(result.status, 'timeout');
  if (saved?.host) {
    assert.equal((await observeAuditProcess(saved)).status, 'stopped');
    assert.equal((await observeAuditProcess({ ...saved, host: 'different-host' })).status, 'unknown');
  } else {
    assert.equal((await observeAuditProcess({ pid: result.pid, started: 'unknown', host: 'unknown' })).status, 'unknown');
  }
});

test('duplex async input can await parsed server responses and begins only after spawn persistence', async t => {
  const f = await fixture(t), messages = [];
  let persisted = false, release;
  const response = new Promise(resolve => { release = resolve; });
  const input = (async function* () {
    assert.equal(persisted, true);
    yield '{"kind":"start"}\n';
    await response;
    yield '{"kind":"continue"}\n';
  })();
  const script = `let b=''; process.stdout.write(JSON.stringify({kind:'request'})+'\\n'); process.stdin.on('data',c=>{b+=c; const i=b.indexOf('\\n'); if(i<0)return; const m=JSON.parse(b.slice(0,i)); b=b.slice(i+1); if(m.kind==='start') process.stdout.write(JSON.stringify({kind:'ready'})+'\\n'); else { process.stdout.write(JSON.stringify({kind:'done'})+'\\n'); process.exit(0); }});`;
  const result = await f.run(script, {
    input,
    onSpawn: async () => { await new Promise(resolve => setTimeout(resolve, 15)); persisted = true; },
    onEvent: event => {
      messages.push(event.value?.kind);
      if (event.value?.kind === 'ready') release();
    },
  });
  assert.equal(result.status, 'exited');
  assert.deepEqual(messages, ['request', 'ready', 'done']);
});

test('cancellation interrupts a producer stalled on next without waiting for its promise', async t => {
  const f = await fixture(t), controller = new AbortController();
  const input = (async function* () {
    yield 'first\n';
    await new Promise(() => {});
  })();
  const running = f.run('setInterval(() => {}, 1000)', { input, signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.shutdown.groupTerminated, true);
});

test('identity probe denial does not misreport a live process as stopped', async () => {
  const observation = await observeAuditProcess({ pid: process.pid, started: 'valid-but-unobservable', host: hostname() }, {
    identityProbe: async () => null,
  });
  assert.equal(observation.status, 'unknown');
});

test('a live wrapper exec command change does not establish that its recorded owner stopped', { timeout: 10000 }, async t => {
  const child = spawn('/bin/sh', ['-c',
    `printf 'wrapper-ready\\n'; read ignored; exec "$1" -e 'process.stdout.write(JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)'`, 'owned-wrapper', process.execPath],
  { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  await once(child.stdout, 'data');
  const saved = { pid: child.pid, started: 'fixture-start', command: '/bin/sh', host: hostname() };
  const ready = once(child.stdout, 'data');
  child.stdin.end('continue\n');
  const [output] = await ready;
  const current = { ...saved, pid: JSON.parse(output).pid, command: process.execPath };
  assert.equal(saved.pid, current.pid);
  assert.equal(saved.started, current.started);
  assert.notEqual(saved.command, current.command);
  assert.equal((await observeAuditProcess(saved, { identityProbe: async () => current })).status, 'unknown');
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  const reused = await observeAuditProcess(saved, { identityProbe: async () => ({ ...current, started: 'different-start' }) });
  assert.equal(reused.status, 'different');
});

test('a missing leader with a surviving group is uncertain until the owned group stops', { timeout: 10000 }, async t => {
  const leader = spawn(process.execPath, ['-e', String.raw`
    const {spawn}=require('node:child_process');
    process.stdin.once('data',()=>{
      const child=spawn(process.execPath,['-e',"process.on('SIGHUP',()=>{});setInterval(()=>{},1000);process.send('ready');"],
        {stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>process.stdout.write(JSON.stringify({pid:child.pid})+'\n',()=>process.exit(0)));
    });`], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { process.kill(-leader.pid, 'SIGKILL'); } catch {} });
  const identity = { pid: leader.pid, started: 'fixture-start', command: process.execPath, host: hostname() };
  const closed = once(leader, 'close');
  leader.stdin.end('start');
  let output = '';
  for await (const chunk of leader.stdout) output += chunk;
  const [code] = await closed;
  assert.equal(code, 0);
  const child = JSON.parse(output);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  assert.doesNotThrow(() => process.kill(-leader.pid, 0));
  assert.equal((await observeAuditProcess(identity)).status, 'unknown');
  assert.doesNotThrow(() => process.kill(child.pid, 0), 'recovery observation must not signal a saved group');
  process.kill(-leader.pid, 'SIGKILL');
  const deadline = Date.now() + 3000;
  let observed;
  do {
    observed = await observeAuditProcess(identity);
    if (observed.status === 'stopped') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(observed.status, 'stopped');
});

test('owned group shutdown does not claim or terminate an escaped detached child', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let escaped;
  t.after(() => { if (escaped) { try { process.kill(-escaped, 'SIGKILL'); } catch {} } });
  const script = String.raw`
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000);process.send('ready');"],
      {detached:true,stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>process.stdout.write(JSON.stringify({escapedPid:child.pid})+'\n',()=>process.exit(0)));`;
  const result = await f.run(script, { onEvent: event => { escaped = event.value?.escapedPid ?? escaped; } });
  assert.equal(result.status, 'exited');
  assert.equal(result.shutdown.groupTerminated, true);
  assert.equal(result.shutdown.escapedDescendantsUnverified, true);
  assert.ok(escaped);
  assert.doesNotThrow(() => process.kill(escaped, 0));
  assert.doesNotThrow(() => process.kill(-escaped, 0));
});
