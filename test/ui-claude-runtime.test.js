import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { createUiRunsFixture } from '../test-support/ui-runs-fixture.js';
import { readAuditRecord } from '../src/audit-experiment-store.js';

const summarySource = await readFile(new URL('../web/src/lib/replay-agent-summary.ts', import.meta.url), 'utf8');
const { deriveAgentSummaries } = await import('data:text/javascript;base64,'
  + Buffer.from(stripTypeScriptTypes(summarySource)).toString('base64'));

async function until(action, done, label) {
  let last;
  for (let i = 0; i < 300; i++) {
    last = await action();
    if (done(last)) return last;
    await setTimeout(25);
  }
  assert.fail(label + ': ' + JSON.stringify(last));
}

test('ordinary Claude review uses the selected profile, frozen inputs and pinned SDK through the controller', async t => {
  const app = await createUiRunsFixture({ mode: { mixedClaude: true }, reviewContext: {
    accessOptions: { inspectResources: async () => [] } } });
  t.after(() => app.close());
  const comparison = await app.provider.runPreview({ task: 'Fixture comparison', a: 'baseline', b: 'strict-review',
    repository: app.repository, commit: 'HEAD', checks: [] });
  assert.equal(comparison.ready, true);
  const started = await app.provider.startRun({ previewToken: comparison.previewToken });
  const run = await until(() => app.provider.run(started), value => ['finished', 'finished-partial', 'failed'].includes(value.state), 'Source comparison');
  assert.equal(run.state, 'finished', JSON.stringify(run));
  const ref = 'e.' + started.id;
  const selection = { profile: 'Default', client: 'claude-code', workspace: app.repository };
  assert.equal((await app.provider.catalog(selection)).status, 'unavailable');
  const discovered = await app.provider.refreshCatalog({ ...selection, requestId: randomUUID() });
  assert.equal(discovered.status, 'ready', JSON.stringify(discovered));
  assert.equal(discovered.scope.environmentBinding.client, 'claude-code');
  assert.equal((await app.provider.catalog(selection)).models[0].model, 'sonnet');
  assert.equal((await app.provider.catalog({ profile: 'Default', workspace: app.repository })).status, 'unavailable');
  const preview = await app.provider.previewReviewTask({ ref, profile: 'Default', client: 'claude-code', cwd: app.repository,
    prompt: 'Inspect these frozen files.', execution: { model: 'sonnet', reasoningEffort: 'low' } });
  assert.match(preview.summary, /ordinary Claude Code review/);
  const task = await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  const repeated = await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  assert.equal(repeated.id, task.id);
  const result = await until(() => app.provider.reviewTask(task), value =>
    ['completed', 'failed', 'uncertain'].includes(value.status) && value.shutdown !== null, 'Claude review');
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.response.text, 'Claude fixture completed.');
  assert.equal(result.nativeReference.client, 'claude-code');
  assert.equal(result.nativeReference.turnId, null);
  assert.equal(result.nativeReference.sessionId, result.response.threadId);
  assert.equal(result.shutdown.groupTerminated, true);
  const taskPath = join(app.store.directory, 'review-tasks', task.id, 'task.json');
  const saved = await until(async () => JSON.parse(await readFile(taskPath, 'utf8')),
    value => value.reservation?.status === 'released', 'Claude review release');
  const proof = saved.capture.shutdown;
  assert.equal(proof.groupTerminated, true);
  assert.equal(proof.mainCloseJoined, true);
  assert.equal(proof.sdkIteratorJoined, true);
  assert.equal(proof.inputIteratorJoined, true);
  assert.equal(proof.pendingApprovals, 0);
  assert.equal(proof.interruptRequested, false);
  assert.equal(proof.interruptAcknowledged, null);
  assert.deepEqual(proof.remainingPids, []);
  assert.equal(proof.escapedDescendantsUnverified, true);
  assert.equal(proof.observationFailed, false);
  await app.restartServer();
  const reopened = await app.provider.reviewTask(task);
  assert.equal(reopened.status, 'completed');
  assert.equal(reopened.response.text, result.response.text);
  const savedAgain = JSON.parse(await readFile(taskPath, 'utf8'));
  assert.deepEqual(savedAgain.capture.shutdown, proof);
  assert.deepEqual(savedAgain.shutdown, saved.shutdown);
  assert.equal(savedAgain.inputsVerifiedAfterCompletion, true);
});

test('ordinary Claude survivor completes exact approvals, checks and lock release with an optional command closure', async t => {
  const app = await createUiRunsFixture({ mode: { mixedClaude: true } });
  t.after(() => app.close());
  const preview = await app.provider.runPreview({ task: 'closure-controller-idle', a: 'Default', b: 'Default',
    clients: { a: 'claude-code', b: 'claude-code' }, repository: app.repository, commit: 'HEAD',
    checks: [{ name: 'marker', command: '/bin/test -f xfx-local-marker.txt' }] });
  assert.equal(preview.ready, true, JSON.stringify(preview));
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  for (let side = 0; side < 2; side++) {
    const waiting = await until(() => app.provider.run(started), value => value.pendingRequests.length > 0 || value.state !== 'running', 'Closure approval');
    assert.equal(waiting.pendingRequests.length, 1, JSON.stringify(waiting));
    const request = waiting.pendingRequests[0];
    assert.equal(request.method, 'claude/tool/requestApproval');
    assert.equal(request.params.input.command, '/usr/bin/touch xfx-local-marker.txt');
    assert.equal(request.params.itemId, request.item.id);
    await app.provider.respondRun({ ...started, requestId: request.requestId, response: { decision: 'accept' } });
    await assert.rejects(app.provider.respondRun({ ...started, requestId: request.requestId, response: { decision: 'accept' } }), { status: 409 });
  }
  const progress = await until(() => app.provider.run(started), value => value.state !== 'running', 'Closure survivor completion');
  assert.ok(['finished', 'finished-partial'].includes(progress.state), JSON.stringify(progress));
  const parent = await readAuditRecord(app.store, started.id);
  assert.deepEqual(parent.report.failures, []);
  assert.equal(app.calls.checks.length, 2);
  for (const leg of parent.report.runs) {
    assert.equal(leg.task.status, 'passed');
    assert.equal(leg.checks[0].status, 'passed');
    const child = await readAuditRecord(app.store, leg.id);
    assert.equal(child.report.capture.commandClosure.receiptCount, 1);
    assert.equal(child.report.capture.commandClosure.advisory, true);
    assert.equal(child.report.capture.commandClosure.hostIdleObserved, true);
    assert.equal(child.report.capture.shutdown.groupTerminated, true);
    assert.equal(child.state.reservation, null);
    assert.equal(child.state.process, null);
    assert.equal(await readFile(join(child.state.workspace.directory, 'xfx-local-marker.txt'), 'utf8'), 'fixture marker\n');
  }
  await assert.rejects(access(join(app.root, 'default-user-home', '.claude', '.run-lock')), { code: 'ENOENT' });
  const report = await app.provider.report({ ref: 'e.' + started.id });
  for (const side of ['a', 'b']) {
    const replay = report.replay[side], root = replay.sessions.find(row => row.parentId === null);
    assert.equal(deriveAgentSummaries(replay).get(root.id).result.text, 'Claude closure fixture completed.');
  }
});

test('successful ordinary Claude comparison exposes its exact closing response and persisted shutdown proof', async t => {
  const app = await createUiRunsFixture({ mode: { mixedClaude: true } });
  t.after(() => app.close());
  const preview = await app.provider.runPreview({ task: 'closing-response', a: 'Default', b: 'Default',
    clients: { a: 'claude-code', b: 'claude-code' }, repository: app.repository, commit: 'HEAD', checks: [] });
  assert.equal(preview.ready, true, JSON.stringify(preview));
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  const progress = await until(() => app.provider.run(started), value => value.state !== 'running', 'Successful Claude comparison');
  assert.ok(['finished', 'finished-partial'].includes(progress.state), JSON.stringify(progress));
  const report = await app.provider.report({ ref: 'e.' + started.id });
  for (const side of ['a', 'b']) {
    const replay = report.replay[side], session = replay.sessions.find(row => row.parentId === null);
    const result = deriveAgentSummaries(replay).get(session.id).result;
    assert.equal(result?.text, 'Claude fixture final response.');
    assert.equal(session.events.find(event => event.id === result.event.id).body, 'Claude fixture final response.');
    assert.equal(session.events[0].body, 'Claude fixture progress.');
    assert.equal(session.events.at(-1).kind, 'session');
    assert.equal(session.events.at(-1).status, 'completed');
    assert.ok(session.events.every(event => event.turnId === null));
    assert.equal(session.status, 'partial');
  }
  const parent = await readAuditRecord(app.store, started.id);
  for (const { id } of parent.state.runs) {
    const child = await readAuditRecord(app.store, id), proof = child.report.capture.shutdown;
    assert.equal(child.state.process, null);
    assert.equal(proof.groupTerminated, true);
    assert.equal(proof.mainCloseJoined, true);
    assert.equal(proof.sdkIteratorJoined, true);
    assert.equal(proof.inputIteratorJoined, true);
    assert.equal(proof.pendingApprovals, 0);
    assert.deepEqual(proof.remainingPids, []);
    assert.equal(proof.interruptRequested, false);
    assert.equal(proof.interruptAcknowledged, null);
    assert.equal(proof.observationFailed, false);
    assert.equal(proof.escapedDescendantsUnverified, true);
    assert.equal(child.report.coverage.agents, 'partial');
    assert.deepEqual(child.captureCheckpoint.capture.shutdown, proof);
  }
});

test('ordinary Claude comparison retains a safe rate-limit failure in progress and parent reports', async t => {
  const app = await createUiRunsFixture({ mode: { mixedClaude: true } });
  t.after(() => app.close());
  const preview = await app.provider.runPreview({ task: 'captured-rate-limit', a: 'Default', b: 'Default',
    clients: { a: 'claude-code', b: 'claude-code' }, repository: app.repository, commit: 'HEAD', checks: [] });
  assert.equal(preview.ready, true, JSON.stringify(preview));
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  const progress = await until(() => app.provider.run(started), value => value.state !== 'running', 'Rate-limited Claude comparison');
  assert.equal(progress.state, 'failed');
  const parent = await readAuditRecord(app.store, started.id);
  const message = 'Claude Code reached its native usage limit. The task did not complete.';
  assert.equal(parent.report.status, 'failed');
  assert.equal(parent.report.failures.length, 2);
  assert.ok(parent.report.failures.every(error => error.code === 'claude-native-rate-limit' && error.message === message));
  assert.ok(progress.columns.every(column => /usage or rate limit/.test(column.failure)));
  const report = await app.provider.report({ ref: 'e.' + started.id });
  assert.match(JSON.stringify(report), /usage (?:or rate )?limit/);
  for (const side of ['a', 'b']) {
    const replay = report.replay[side], session = replay.sessions.find(row => row.parentId === null);
    assert.equal(deriveAgentSummaries(replay).get(session.id).result, null);
    assert.equal(session.events.at(-1).status, 'failed');
  }
  for (const { id } of parent.state.runs) {
    const child = await readAuditRecord(app.store, id);
    const leg = parent.report.runs.find(run => run.id === id);
    assert.equal(leg.error.code, 'claude-native-rate-limit');
    assert.equal(leg.error.message, message);
    assert.equal(leg.task.status, 'failed');
    assert.equal(leg.task.nativeTurnStatus, 'failed');
    assert.equal(child.report.turns[0].model, null);
    assert.equal(child.report.capture.errors[0].code, 'claude-native-rate-limit');
    assert.equal(child.report.capture.errors[1].message, 'Claude event arrived after the terminal result');
    assert.equal(child.report.capture.shutdown.groupTerminated, true);
    assert.equal(child.report.capture.shutdown.sdkIteratorJoined, true);
    assert.equal(child.report.capture.shutdown.interruptRequested, false);
    assert.deepEqual(child.captureCheckpoint.capture.shutdown, child.report.capture.shutdown);
  }
});
