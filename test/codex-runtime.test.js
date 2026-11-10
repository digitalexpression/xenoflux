import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexRuntime } from '../src/codex-runtime.js';
import { createClientRuntime } from '../src/client-runtime.js';
import { validateNativeRequest } from '../src/native-requests.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-codex-runtime-'));
  const executable = join(directory, 'server.cjs'), log = join(directory, 'requests.jsonl');
  await writeFile(executable, `
const fs=require('node:fs');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
 const m=JSON.parse(line),reply=result=>send({id:m.id,result});
 if(m.method==='initialize') return reply({serverInfo:{name:'fixture'}});
 if(m.method==='thread/start') return reply({thread:{id:'session',cwd:process.cwd()}});
 if(m.method==='turn/start') {
  reply({turn:{id:'turn'}});
  return send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'session',turnId:'turn',itemId:'command',startedAtMs:1,command:'printf fixture',cwd:process.cwd(),availableDecisions:['accept','decline']}});
 }
 if(m.method==='thread/read') return reply({thread:{id:m.params.threadId,turns:[]}});
 if(m.method==='fixture/complete') { send({method:'turn/completed',params:{threadId:'session',turn:{id:'turn',status:'completed'}}}); return reply({}); }
 if(m.method==='turn/interrupt') return reply({});
});`, { mode: 0o600 });
  const runtime = createCodexRuntime();
  let received;
  const approval = new Promise(resolve => { received = resolve; });
  const handle = await runtime.initialize({ executable: process.execPath, args: [executable], workspace: directory,
    processOptions: { env: { HOME: directory, PATH: process.env.PATH }, stdoutPath: join(directory, 'stdout'), stderrPath: join(directory, 'stderr'), timeoutMs: 5000 } },
  { initializeParams: { clientInfo: { name: 'fixture', version: '1' } }, onEvent: packet => {
    if (packet.value?.method?.endsWith('requestApproval')) received(validateNativeRequest(packet.value));
  } });
  t.after(async () => { await runtime.cancel(handle); await rm(directory, { recursive: true, force: true }); });
  return { runtime, handle, approval, requests: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('Codex operations require an initialized session and one exact native reply', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.submit(f.handle, { threadId: 'session' }), /initialized session/);
  await f.runtime.createSession(f.handle, { ephemeral: false });
  await assert.rejects(f.runtime.inspect(f.handle, { sessionId: 'missing' }), /exact existing/);
  const turn = await f.runtime.submit(f.handle, { threadId: 'session', input: [] });
  assert.equal(turn.turn.id, 'turn');
  await assert.rejects(f.runtime.submit(f.handle, { threadId: 'session' }), /one submission/);
  const request = await f.approval;
  assert.throws(() => f.runtime.respond(f.handle, { ...request, params: { ...request.params, command: 'changed' } }, { decision: 'accept' }), /changed/);
  assert.throws(() => f.runtime.respond(f.handle, request, { decision: 'acceptForSession' }), /decision|response|approval/i);
  f.runtime.respond(f.handle, request, { decision: 'accept' });
  assert.throws(() => f.runtime.respond(f.handle, request, { decision: 'accept' }), /Stale/);
  assert.equal((await f.runtime.inspect(f.handle, { sessionId: 'session', turnId: 'turn' })).thread.id, 'session');
  const messages = await f.requests();
  assert.equal(messages.filter(message => message.method === 'turn/start').length, 1);
  assert.equal(messages.filter(message => message.result?.decision === 'accept').length, 1);
});

test('independent Codex handles fence foreign and cancelled replies and report shutdown separately', async t => {
  const a = await fixture(t), b = await fixture(t);
  await Promise.all([a, b].map(async f => {
    await f.runtime.createSession(f.handle, {});
    await f.runtime.submit(f.handle, { threadId: 'session', input: [] });
  }));
  const request = await a.approval;
  assert.throws(() => b.runtime.respond(a.handle, request, { decision: 'accept' }), /Foreign/);
  const cancelled = await a.runtime.cancel(a.handle);
  assert.equal(cancelled.turn.status, 'acknowledged');
  assert.equal(cancelled.shutdown.groupTerminated, true);
  assert.throws(() => a.runtime.respond(a.handle, request, { decision: 'accept' }), /stopped/);
  b.runtime.respond(b.handle, await b.approval, { decision: 'accept' });
  assert.equal((await b.runtime.inspect(b.handle, { sessionId: 'session', turnId: 'turn' })).thread.id, 'session');
});

test('inspection without attached native state submits no task and initializes no runtime', () => {
  let calls = 0;
  const runtime = createClientRuntime({ runtimes: { codex: { initialize() { calls++; } } } });
  assert.equal(runtime.inspect({ client: 'codex', jobId: 'job', profileId: 'profile', sessionId: 'missing' }).status, 'unavailable');
  assert.equal(calls, 0);
});

test('terminal native turns invalidate pending approval answers and qualified reads reject another client', async t => {
  const f = await fixture(t);
  await f.runtime.createSession(f.handle, {});
  await f.runtime.submit(f.handle, { threadId: 'session', input: [] });
  const request = await f.approval;
  await f.runtime.request(f.handle, 'fixture/complete', {});
  assert.throws(() => f.runtime.respond(f.handle, request, { decision: 'accept' }), /Stale/);
  await assert.rejects(f.runtime.inspect(f.handle, { client: 'claude-code', sessionId: 'session' }), /scope/);
  assert.equal((await f.requests()).filter(message => message.result?.decision).length, 0);
});
