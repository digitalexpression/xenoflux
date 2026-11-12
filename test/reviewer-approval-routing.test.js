import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUiRunsFixture } from '../test-support/ui-runs-fixture.js';
import { createUiRuns } from '../src/ui-runs.js';
import { runAuditCapture } from '../src/audit-capture.js';
import { readAuditRecord } from '../src/audit-experiment-store.js';

async function waitFor(read, predicate) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Comparison fixture did not reach the expected state');
}

async function fixture(t, reviewer) {
  const app = await createUiRunsFixture();
  t.after(() => app.close());
  const script = join(app.root, 'approval-routing.cjs'), wire = join(app.root, 'wire.jsonl');
  await writeFile(script, `
const {randomUUID}=require('node:crypto'),fs=require('node:fs');
const threadId=randomUUID(),turnId=randomUUID(),itemId='marker-command';
const send=message=>process.stdout.write(JSON.stringify(message)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 fs.appendFileSync(${JSON.stringify(wire)},line+'\\n');
 const m=JSON.parse(line),reply=result=>send({id:m.id,result});
 if(m.method==='initialize')return reply({});
 if(m.method==='skills/list')return reply({data:[]});
 if(m.method==='thread/start'){
   if(process.argv[2]==='unsupported')return send({id:m.id,error:{code:-32602,message:'unknown approval reviewer option'}});
   return reply({cwd:process.cwd(),thread:{id:threadId,cwd:process.cwd()},approvalPolicy:m.params.approvalPolicy,
     sandbox:{type:m.params.sandbox==='read-only'?'readOnly':'workspaceWrite',networkAccess:false},
     ...(process.argv[2]==='missing'?{}:{approvalsReviewer:process.argv[2]})});
 }
 if(m.method==='turn/start'){
   reply({turn:{id:turnId}});
   return send({id:'native-approval',method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId,startedAtMs:1,
     command:'printf exact-marker',cwd:process.cwd(),availableDecisions:['accept','decline']}});
 }
 if(m.id==='native-approval'&&m.result?.decision==='accept')send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
});`, { mode: 0o600 });
  const captures = [];
  const service = createUiRuns({ store: app.store, defaultUserHome: join(app.root, 'default-user-home'),
    context: { ...app.runContext, capture: async input => {
      const result = await runAuditCapture({ ...input, profile: { ...input.profile, executable: process.execPath },
        processOptions: { ...input.processOptions, args: [script, reviewer] } });
      captures.push({ status: result.process.status, reason: result.run.reason, errors: result.capture.errors, warnings: result.run.warnings });
      return result;
    } } });
  t.after(() => service.close());
  return { app, service, captures, input: { task: 'Run the exact marker fixture.', a: 'baseline', b: 'strict-review', repository: app.repository,
    commit: 'HEAD', checks: [], execution: { a: { permissionMode: 'read-only' }, b: { permissionMode: 'read-only' } }, advanced: { approvalsReviewer: 'user' } },
  messages: async () => (await readFile(wire, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('comparison freezes user approval routing, answers exact requests once, and retains native confirmation', async t => {
  const f = await fixture(t, 'user');
  await assert.rejects(f.service.runPreview({ ...f.input, advanced: { ...f.input.advanced, approvalsReviewer: 'auto_review' } }), { status: 400 });
  const preview = await f.service.runPreview(f.input);
  assert.equal(preview.ready, true);
  assert.equal(preview.approvalsReviewer, 'user');
  f.input.advanced.approvalsReviewer = 'auto_review';
  const started = await f.service.startRun({ previewToken: preview.previewToken });
  assert.deepEqual(await f.service.startRun({ previewToken: preview.previewToken }), started);
  for (const side of ['a', 'b']) {
    const value = await waitFor(() => f.service.run(started), run => run.state !== 'running' || run.pendingRequests.some(request => request.side === side));
    const request = value.pendingRequests.find(request => request.side === side);
    assert.ok(request, JSON.stringify({ state: value.state, captures: f.captures }));
    assert.equal(request.method, 'item/commandExecution/requestApproval');
    assert.equal(request.params.command, 'printf exact-marker');
    assert.equal(request.params.itemId, 'marker-command');
    const answer = { ...started, requestId: request.requestId, response: { decision: 'accept' } };
    await f.service.respondRun(answer);
    await assert.rejects(f.service.respondRun(answer), { status: 409, code: 'stale-run-request' });
  }
  const done = await waitFor(() => f.service.run(started), run => run.state !== 'running');
  assert.match(done.state, /^finished/);
  const wire = await f.messages();
  assert.deepEqual(wire.filter(row => row.method === 'thread/start').map(row => row.params.approvalsReviewer), ['user', 'user']);
  assert.equal(wire.filter(row => row.method === 'turn/start').length, 2);
  assert.equal(wire.filter(row => row.id === 'native-approval' && row.result?.decision === 'accept').length, 2);
  const parent = await readAuditRecord(f.app.store, started.id);
  assert.equal(parent.record.spec.approvalsReviewer, 'user');
  assert.equal(parent.report.limits.approvalsReviewer, 'user');
  const receipt = JSON.parse(await readFile(join(f.app.store.directory, 'ui-runs', `${started.id}.json`), 'utf8'));
  assert.equal(receipt.approvalsReviewer, 'user');
  for (const { id } of parent.state.runs) {
    const { report } = await readAuditRecord(f.app.store, id);
    const { requested, sent, confirmed, observed } = report.settingsEvidence;
    assert.deepEqual(requested.approvalsReviewer, { value: 'user', source: 'frozen-comparison-spec' });
    assert.deepEqual(sent.approvalsReviewer, { value: 'user', source: 'thread/start' });
    assert.deepEqual(confirmed.approvalsReviewer, { value: 'user', source: 'thread/start' });
    assert.equal(observed, null);
  }
});

for (const reviewer of ['missing', 'auto_review', 'unsupported']) test(`unconfirmed ${reviewer} reviewer fails before any model turn`, async t => {
  const f = await fixture(t, reviewer);
  const preview = await f.service.runPreview(f.input);
  assert.equal(preview.ready, true);
  const started = await f.service.startRun({ previewToken: preview.previewToken });
  const done = await waitFor(() => f.service.run(started), run => run.state !== 'running');
  assert.equal(done.state, 'failed');
  assert.match(done.columns[0].failure ?? '', /did not confirm user approval routing/, JSON.stringify(f.captures));
  const wire = await f.messages();
  assert.equal(wire.filter(row => row.method === 'thread/start').length, 1, 'remaining side stops after failed confirmation');
  assert.equal(wire.filter(row => row.method === 'turn/start').length, 0);
  const parent = await readAuditRecord(f.app.store, started.id);
  const { report } = await readAuditRecord(f.app.store, parent.state.runs[0].id);
  assert.equal(report.capture.settingsEvidence.confirmed?.approvalsReviewer?.value ?? null, reviewer === 'auto_review' ? 'auto_review' : null);
});
