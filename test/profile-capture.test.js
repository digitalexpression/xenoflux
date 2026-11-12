import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAuditCapture } from '../src/audit-capture.js';
import { createClientRuntime } from '../src/client-runtime.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

// An owned fixture executable exercises the actual pipes/process shutdown. It
// records requests and models a native home with its ordinary launch routing.
async function fixture(t, scenario = 'complete') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profile-capture-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), cwd = join(dir, 'repo');
  await mkdir(home, { mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
  const executable = join(dir, 'codex'), transcript = join(dir, 'requests.jsonl');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(transcript)};
const scenario = ${JSON.stringify(scenario)};
fs.writeFileSync(${JSON.stringify(join(dir, 'launch.json'))}, JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()}));
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const reply = (id,result) => send({jsonrpc:'2.0',id,result});
const finalItem = {type:'agentMessage',id:'answer',phase:'final_answer',text:'  Exact answer.\\nUnicode: café  '};
if (scenario==='empty') finalItem.text = '  ';
const partial = () => send({method:'item/completed',params:{threadId:'owned',turnId:'turn',item:finalItem}});
const complete = () => { partial(); send({method:'turn/completed',params:{threadId:'owned',turn:{id:'turn',status:scenario==='failed'?'failed':'completed',...(scenario==='settings-midturn'?{model:'changed-model',reasoningEffort:'low'}:{})}}}); };
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(log,line+'\\n');
 if (m.result) { complete(); return; }
 if (m.method==='initialize') return reply(m.id,{});
 if (m.method==='skills/list') return reply(m.id,{data:[]});
 if (m.method==='model/list') return reply(m.id,{data:[{id:'fixture-model',model:'profile-model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'low'}]}],nextCursor:null});
 if (m.method==='thread/start') {
   if (scenario==='save-trust' && m.params.cwd) fs.appendFileSync(process.env.CODEX_HOME+'/config.toml','\\n[projects.native_saved_trust]\\ntrust_level = "trusted"\\n');
   const cwd=scenario==='wrong-cwd'?'/different-workspace':process.cwd();
   return reply(m.id,{thread:{...(scenario==='missing-thread'?{}:{id:'owned'}),...(scenario==='missing-cwd'?{}:{cwd})},...(scenario==='missing-cwd'?{}:{cwd}),model:'profile-model',reasoningEffort:'high',approvalPolicy:'on-request'});
 }
 if (m.method==='turn/start') {
   if (scenario==='missing-turn') return reply(m.id,{turn:{status:'inProgress'}});
   reply(m.id,{turn:{id:'turn',status:'inProgress',...(scenario==='settings-ack-only'?{model:'ack-model',reasoningEffort:'low'}:{})}});
   if (scenario==='settings-midturn') send({method:'turn/started',params:{threadId:'owned',turn:{id:'turn',status:'inProgress',model:'profile-model',reasoningEffort:'high'}}});
   if (scenario==='exit') return process.exit(0);
   if (scenario==='stall') return;
   if (['approval', 'unknown', 'file', 'permissions', 'input', 'missing-file'].includes(scenario)) {
     partial();
     const common = {threadId:'owned',turnId:'turn',itemId:'command'};
     const requests = {
       unknown: {method:'item/unknown/requestApproval',params:common},
       approval: {method:'item/commandExecution/requestApproval',params:{...common,startedAtMs:1,command:'cat report.md',cwd:process.cwd(),availableDecisions:['accept','decline']}},
       file: {method:'item/fileChange/requestApproval',params:{...common,startedAtMs:1,reason:'Change a file',grantRoot:process.cwd()}},
       permissions: {method:'item/permissions/requestApproval',params:{...common,startedAtMs:1,cwd:process.cwd(),permissions:{network:{enabled:true}}}},
       input: {method:'item/tool/requestUserInput',params:{...common,questions:[{id:'q',header:'Question',question:'Choose',options:[{label:'A',description:'First'}]}]}}
     };
     if (scenario==='file') send({method:'item/started',params:{...common,item:{id:'command',type:'fileChange',status:'inProgress',changes:[{path:'report.md',kind:{type:'update',move_path:null},diff:'@@ -1 +1 @@\\n-old\\n+new'}]}}});
     return send({jsonrpc:'2.0',id:1,...requests[scenario==='missing-file'?'file':scenario]});
   }
   if (scenario==='overflow') return process.stdout.write('x'.repeat(8192));
   return complete();
 }
 if (m.method==='thread/read') { if (scenario==='nonzero-after-answer') process.exitCode=3; return reply(m.id,{thread:{id:scenario==='wrong-thread'?'foreign':'owned',turns:[
   {id:'unrelated',status:'completed',items:[{...finalItem,text:'Wrong turn'}]},
   {id:'turn',status:scenario==='failed'?'failed':'completed',items:[{...finalItem,id:'commentary',phase:'commentary',text:'Not the answer'},finalItem]}
 ]}}); }
});
`;
  await writeFile(executable, script, { mode: 0o700 });
  const env = { HOME: home, CODEX_HOME: home, CODEX_SQLITE_HOME: home, PATH: process.env.PATH, PROFILE_MARKER: 'ordinary' };
  const profile = { executable, home, userHome: home, cwd, env, launchArgs: ['-c', `sqlite_home=${JSON.stringify(home)}`] };
  return { dir, transcript, options: { executionMode: 'profile', profile, workspace: cwd, task: 'Read the frozen report.',
    processOptions: { env, stdoutPath: join(dir, 'stdout'), stderrPath: join(dir, 'stderr') }, onSession: async () => {} } };
}
const requests = async f => (await readFile(f.transcript, 'utf8')).trim().split('\n').map(JSON.parse);

test('ordinary execution inherits settings and captures only the exact recorded answer after checkpoint', async t => {
  const f = await fixture(t); let checkpoint = false;
  const result = await runAuditCapture({ ...f.options, onSession: async (run, capture) => {
    if (capture.checkpoint !== 'native-session-started') return;
    assert.equal(run.source.threadId, 'owned');
    assert.equal((await requests(f)).some(m => m.method === 'turn/start'), false);
    checkpoint = true;
  } });
  assert.equal(checkpoint, true);
  assert.equal(result.process.status, 'exited');
  assert.equal(result.process.shutdown.groupTerminated, true);
  assert.equal(result.response.status, 'complete');
  assert.equal(result.response.source, 'thread/read');
  assert.equal(result.response.text, '  Exact answer.\nUnicode: café  ');
  assert.equal(result.response.threadId, 'owned'); assert.equal(result.response.turnId, 'turn');
  assert.equal(result.capture.effectiveSettings.model, 'profile-model');
  assert.equal(result.capture.effectiveSettings.modelProvider, null);
  assert.deepEqual(result.capture.settingsEvidence.requested, { source: 'frozen-execution-selection' });
  assert.deepEqual(result.capture.settingsEvidence.sent, { source: 'process-local-native-config', model: null, reasoningEffort: null });
  assert.equal(result.capture.settingsEvidence.confirmed.reasoningEffort, 'high');
  assert.equal(result.capture.settingsEvidence.observed, null);
  const launch = JSON.parse(await readFile(join(f.dir, 'launch.json')));
  assert.deepEqual(launch.args, [...f.options.profile.launchArgs, 'app-server']);
  assert.equal(launch.env.CODEX_SQLITE_HOME, f.options.profile.home);
  assert.equal(launch.env.PROFILE_MARKER, 'ordinary');
  assert.equal(launch.env.TMPDIR, undefined);
  for (const message of (await requests(f)).filter(m => ['thread/start', 'turn/start'].includes(m.method))) {
    for (const key of ['sandbox','sandboxPolicy','approvalPolicy','model','effort','config']) assert.equal(Object.hasOwn(message.params, key), false);
    if (message.method === 'thread/start') assert.equal(Object.hasOwn(message.params, 'cwd'), false);
    else assert.equal(message.params.cwd, f.options.workspace);
  }
  assert.equal((await readdir(f.dir)).includes('runtime'), false);
  assert.equal((await requests(f)).some(m => m.method === 'command/exec'), false);
});

test('ordinary thread startup inherits its workspace without persisting native project trust', async t => {
  const f = await fixture(t, 'save-trust');
  const config = join(f.options.profile.home, 'config.toml'), original = 'model = "saved-model"\n';
  await writeFile(config, original, { mode: 0o600 });
  const result = await runAuditCapture(f.options);
  assert.equal(result.response.status, 'complete');
  assert.equal(await readFile(config, 'utf8'), original);
  assert.equal(result.capture.effectiveSettings.approvalPolicy, 'on-request');
});

test('ordinary inherited workspace must be confirmed before any model turn', async t => {
  for (const scenario of ['missing-cwd', 'wrong-cwd']) await t.test(scenario, async t => {
    const f = await fixture(t, scenario);
    const result = await runAuditCapture(f.options);
    assert.equal((await requests(f)).some(m => m.method === 'turn/start'), false);
    assert.equal(result.response.status, 'unavailable');
    assert.equal(result.process.shutdown.groupTerminated, true);
    assert.ok(result.run.warnings.includes('native-workspace-mismatch'));
  });
});

test('a rejected durable checkpoint sends no turn', async t => {
  const f = await fixture(t);
  const result = await runAuditCapture({ ...f.options, onSession: async () => { throw new Error('disk failed'); } });
  assert.equal((await requests(f)).some(m => m.method === 'turn/start'), false);
  assert.equal(result.response.status, 'unavailable');
  assert.ok(result.run.warnings.includes('session-checkpoint-failed'));
});

test('native request id may equal a client RPC id; only the explicit response returns on that connection', async t => {
  const f = await fixture(t, 'approval'); let seen;
  const result = await runAuditCapture({ ...f.options, onNativeRequest: async request => {
    seen = request;
    assert.equal((await requests(f)).some(m => m.result?.decision), false);
    return { decision: 'decline' };
  } });
  assert.equal(seen.params.command, 'cat report.md');
  assert.equal(result.response.status, 'complete');
  assert.deepEqual((await requests(f)).find(m => m.result?.decision), { jsonrpc: '2.0', id: 1, result: { decision: 'decline' } });
});

test('cancel while waiting for human input stops the process and ignores late replies', async t => {
  const f = await fixture(t, 'approval'), controller = new AbortController(); let answer, requestSignal;
  const result = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, signal: controller.signal },
    onNativeRequest: (_request, { signal }) => {
      requestSignal = signal; setTimeout(() => controller.abort(), 20);
      return new Promise(resolve => { answer = resolve; });
    } });
  assert.equal(result.process.status, 'cancelled');
  assert.equal(result.process.shutdown.groupTerminated, true);
  assert.equal(requestSignal.aborted, true);
  assert.equal(result.response.status, 'partial');
  assert.equal(result.response.text, '  Exact answer.\nUnicode: café  ');
  answer({ decision: 'accept' }); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await requests(f)).some(m => m.result), false);
});

for (const scenario of ['unknown', 'approval']) test(`${scenario}: unsupported or unhandled request fails visibly with partial output`, async t => {
  const f = await fixture(t, scenario);
  const result = await runAuditCapture(f.options);
  assert.equal(result.process.shutdown.groupTerminated, true);
  assert.match(result.run.reason, /item\/(unknown|commandExecution)\/requestApproval/);
  assert.equal(result.response.status, 'partial');
  assert.equal((await requests(f)).some(m => m.result), false);
});

for (const scenario of ['wrong-thread', 'failed', 'exit', 'empty']) test(`${scenario}: cannot produce a successful response`, async t => {
  const f = await fixture(t, scenario);
  const result = await runAuditCapture(f.options);
  assert.notEqual(result.response.status, 'complete');
});

test('explicit timeout and process output limits remain enforced', async t => {
  const f = await fixture(t, 'stall');
  const result = await runAuditCapture({ ...f.options, processOptions: { ...f.options.processOptions, timeoutMs: 400 } });
  assert.equal(result.process.status, 'timeout');
  const overflow = await fixture(t, 'overflow');
  const bounded = await runAuditCapture({ ...overflow.options, processOptions: { ...overflow.options.processOptions, outputLimitBytes: 4096 } });
  assert.equal(bounded.process.status, 'output-limit');
  assert.equal(bounded.process.output.truncated, true);
});

test('profile mode rejects audit overrides and requires an explicit mode/checkpoint/cwd/environment', async t => {
  const f = await fixture(t);
  for (const patch of [{ executionMode: undefined }, { sandbox: 'read-only' }, { selectedSkills: [] }, { preflightOnly: false },
    { requiredContext: [] }, { telemetryFactory: () => {} }, { onSession: undefined }, { workspace: '/different' },
    { profile: { ...f.options.profile, nativeConfig: {} } },
    { processOptions: { ...f.options.processOptions, args: [] } },
    { processOptions: { ...f.options.processOptions, env: {} } }]) {
    await assert.rejects(runAuditCapture({ ...f.options, ...patch }), TypeError);
  }
});

for (const [scenario, answer] of [['file', {decision:'decline'}], ['permissions', {permissions:{},scope:'turn'}],
  ['input', {answers:{q:{answers:['A']}}}]]) test(`routes native ${scenario} requests through the shared connection`, async t => {
  const f = await fixture(t, scenario); let count = 0;
  const result = await runAuditCapture({...f.options, onNativeRequest: async (_request, { item }) => {
    count++;
    if (scenario === 'file') { assert.equal(item.type, 'fileChange'); assert.match(item.changes[0].diff, /-old\n\+new/); }
    return answer; }});
  assert.equal(count, 1);
  assert.equal(result.response.status, 'complete');
  assert.deepEqual((await requests(f)).find(m => m.result).result, answer);
});

test('invalid explicit approval is never sent and fails visibly', async t => {
  const f = await fixture(t, 'approval');
  const result = await runAuditCapture({...f.options, onNativeRequest: async () => ({decision:'acceptForSession'})});
  assert.equal(result.response.status, 'partial');
  assert.match(result.run.reason, /not offered/);
  assert.equal((await requests(f)).some(m => m.result), false);
});

test('retained completed answer stays distinct from a later process failure', async t => {
  const f = await fixture(t, 'nonzero-after-answer');
  const result = await runAuditCapture(f.options);
  assert.equal(result.process.exitCode, 3);
  assert.equal(result.response.status, 'complete');
  assert.equal(result.capture.status, 'partial');
});

test('file approval without the matching native action fails without asking for blind consent', async t => {
  const f = await fixture(t, 'missing-file'); let asked = false;
  const result = await runAuditCapture({...f.options, onNativeRequest: async () => { asked = true; return {decision:'accept'}; }});
  assert.equal(asked, false);
  assert.equal(result.response.status, 'partial');
  assert.match(result.run.reason, /details unavailable: item\/fileChange\/requestApproval/);
});

test('turn acknowledgement is checkpointed with the owning native IDs', async t => {
  const f = await fixture(t); const turns = [];
  const result = await runAuditCapture({ ...f.options, onTurn: async turn => {
    assert.equal((await requests(f)).some(message => message.method === 'turn/start'), true);
    turns.push(turn);
  } });
  assert.deepEqual(turns, [{ threadId: 'owned', turnId: 'turn' }]);
  assert.equal(result.response.status, 'complete');
});


test('profile runtime keeps requested, sent, confirmed and absent observations separate through export and reopen', async t => {
  const f = await fixture(t, 'settings-ack-only'), checkpoints = [];
  const result = await createClientRuntime().capture({ ...f.options, jobId: 'profile-job', limits: { id: 'profile-job' },
    profile: { ...f.options.profile, profileId: 'fixture-profile' },
    execution: { model: 'profile-model', reasoningEffort: 'high' },
    onSession: async (run, capture) => { checkpoints.push(structuredClone({ run, capture })); } });
  assert.equal(result.response.status, 'complete');
  const evidence = result.capture.settingsEvidence;
  assert.deepEqual(evidence.requested, { source: 'frozen-execution-selection', model: 'profile-model', reasoningEffort: 'high' });
  assert.deepEqual(evidence.sent, { source: 'process-local-native-config', model: 'profile-model', reasoningEffort: 'high' });
  assert.equal(evidence.confirmed.source, 'thread/start');
  assert.equal(evidence.confirmed.model, 'profile-model');
  assert.equal(evidence.confirmed.reasoningEffort, 'high');
  assert.equal(evidence.confirmed.modelProvider, null);
  assert.equal(evidence.observed, null, 'Thread settings and turn/start response are not turn-event observations');
  assert.ok(checkpoints.length > 0);
  assert.ok(checkpoints.every(checkpoint => checkpoint.capture.settingsEvidence.observed === null));
  assert.deepEqual(result.run.settingsEvidence, evidence);
  const output = join(f.dir, 'settings-evidence.json');
  await exportAuditReport(result.run, { output });
  const reopened = await readAuditReport(output);
  assert.deepEqual(reopened.settingsEvidence, evidence);
  assert.deepEqual(reopened.nativeReference, result.run.nativeReference);
});

test('native turn events retain settings changes within the turn without rewriting requested or confirmed facts', async t => {
  const f = await fixture(t, 'settings-midturn');
  const result = await createClientRuntime().capture({ ...f.options, jobId: 'profile-job', limits: { id: 'profile-job' },
    profile: { ...f.options.profile, profileId: 'fixture-profile' }, execution: { model: 'profile-model', reasoningEffort: 'high' } });
  assert.equal(result.response.status, 'complete');
  const evidence = result.capture.settingsEvidence;
  assert.equal(evidence.requested.reasoningEffort, 'high');
  assert.equal(evidence.sent.reasoningEffort, 'high');
  assert.equal(evidence.confirmed.reasoningEffort, 'high');
  assert.equal(evidence.observed.source, 'native-turn-event');
  assert.deepEqual(evidence.observed.turns.map(({ threadId, turnId, model, reasoningEffort }) => ({ threadId, turnId, model, reasoningEffort })), [
    { threadId: 'owned', turnId: 'turn', model: 'profile-model', reasoningEffort: 'high' },
    { threadId: 'owned', turnId: 'turn', model: 'changed-model', reasoningEffort: 'low' },
  ]);
  assert.ok(evidence.observed.turns.every(turn => (turn.modelProvider ?? null) === null));
});


test('missing native session or turn acknowledgements never receive local surrogate IDs or another submission', async t => {
  for (const scenario of ['missing-thread', 'missing-turn']) await t.test(scenario, async t => {
    const f = await fixture(t, scenario);
    const result = await createClientRuntime().capture({ ...f.options, jobId: 'profile-job', limits: { id: 'profile-job' },
      profile: { ...f.options.profile, profileId: 'fixture-profile' } });
    const submitted = await requests(f);
    assert.equal(submitted.filter(message => message.method === 'thread/start').length, 1);
    assert.equal(submitted.filter(message => message.method === 'turn/start').length, scenario === 'missing-thread' ? 0 : 1);
    assert.equal(result.response.status, 'unavailable');
    assert.equal(result.run.nativeReference.sessionId, scenario === 'missing-thread' ? null : 'owned');
    assert.equal(result.run.nativeReference.turnId, null);
    assert.equal(result.capture.settingsEvidence.observed, null);
  });
});
