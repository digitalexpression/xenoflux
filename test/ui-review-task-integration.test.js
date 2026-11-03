import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { chmod, rm, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createUiRunsFixture } from '../test-support/ui-runs-fixture.js';
import { record } from '../src/metadata.js';

const input = app => ({ task: 'Disposable paired review fixture', files: '', a: 'baseline', b: 'strict-review',
  repository: app.repository, commit: 'HEAD', checks: [] });
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await timeout(20); }
  assert.fail(message);
}

async function seedComparison(app) {
  const preview = await app.provider.runPreview(input(app));
  assert.equal(preview.ready, true);
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  const run = await until(() => app.provider.run({ id: started.id }), value => value.state !== 'running', 'fixture comparison did not finish');
  assert.equal(run.state, 'finished');
  return `e.${started.id}`;
}

function nativeRequest() {
  return { id: 7, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'review-thread', turnId: 'review-turn', itemId: 'command-1', startedAtMs: 1,
    command: 'cat report.md', cwd: '/fixture/repository', availableDecisions: ['accept', 'decline'],
  } };
}
function captured(status, aborted = false) {
  return { process: { status: aborted ? 'cancelled' : 'exited', exitCode: aborted ? null : 0, elapsedMs: 4,
    shutdown: { groupTerminated: true, escapedDescendantsUnverified: true }, output: { bytes: 100, truncated: false } },
  run: { status: status === 'complete' ? 'ready' : 'partial', reason: status === 'complete' ? null : 'Fixture cancelled',
    source: { threadId: 'review-thread' }, agents: [{ id: 'review-thread', sessionId: 'review-session' }], turns: [], events: [], warnings: [] },
  capture: { status: status === 'complete' ? 'ready' : 'partial', checkpoint: 'final', errors: [], effectiveSettings: { model: 'fixture-model' } },
  response: { status, text: aborted ? 'partial fixture response' : '  A retained fixture response.  ',
    threadId: 'review-thread', turnId: 'review-turn', source: 'thread/read' } };
}

function reviewContext(mode = 'complete') {
  const calls = { captures: 0, process: null, waiting: null };
  const capture = async options => {
    calls.captures++;
    const processIdentity = { pid: 51001, started: 'fixture-review', command: 'fixture-capture', host: 'test' };
    await options.processOptions.onSpawn({ pid: processIdentity.pid, processIdentity });
    const session = { status: 'partial', source: { threadId: 'review-thread' }, agents: [], turns: [], events: [], warnings: [] };
    await options.onSession(session, { checkpoint: 'native-session-started', effectiveSettings: { model: 'fixture-model' } });
    await options.onTurn({ threadId: 'review-thread', turnId: 'review-turn' });
    if (mode === 'approval') {
      const request = nativeRequest();
      calls.waiting = options.onNativeRequest(request, { signal: options.processOptions.signal, item: null });
      await calls.waiting;
    } else if (mode === 'cancel') {
      await new Promise(resolve => {
        const stop = () => resolve();
        if (options.processOptions.signal.aborted) stop();
        else options.processOptions.signal.addEventListener('abort', stop, { once: true });
      });
    }
    const result = captured(mode === 'cancel' ? 'partial' : 'complete', mode === 'cancel');
    await options.onSession(result.run, result.capture);
    return result;
  };
  return { calls, context: { capture, accessOptions: {
    inspectResources: async () => ({ clients: [], pids: [], records: 0, partial: false }), processSnapshot: async () => [],
  } } };
}

function fakeCodexServer(earlyApproval = false) {
  return `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('codex 0.153.4\\n'); process.exit(0); }
const fs = require('node:fs');
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
const earlyApproval = ${JSON.stringify(earlyApproval)};
const threadId = 'ordinary-review-thread', sessionId = 'ordinary-review-session', turnId = 'ordinary-review-turn';
const responseText = 'Reviewed the frozen report through the selected profile.';
let cwd = null, prompt = null;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', line => {
  const message = JSON.parse(line), { id, method, params = {} } = message;
  const result = value => send({ jsonrpc: '2.0', id, result: value });
  if (method === 'initialize') return result({ serverInfo: { name: 'fixture-codex', version: '0.153.4' } });
  if (method === 'initialized') return;
  if (method === 'skills/list') return result({ data: [{ cwd: params.cwds[0], skills: [], errors: [] }] });
  if (method === 'thread/start') {
    cwd = params.cwd;
    result({ cwd, model: 'gpt-6-luna', reasoningEffort: 'medium', thread: { id: threadId, sessionId, cwd } });
    send({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: threadId, sessionId, cwd } } });
    return;
  }
  if (method === 'turn/start') {
    prompt = params.input[0].text;
    const marker = 'Frozen report: ';
    const reportPath = prompt.slice(prompt.indexOf(marker) + marker.length).split(String.fromCharCode(10))[0].trim();
    let reportText;
    try { reportText = fs.readFileSync(reportPath, 'utf8'); } catch { process.exit(31); }
    fs.writeFileSync(__filename + '.observed', JSON.stringify({ cwd: process.cwd(), reportPath, reportText, prompt }));
    if (earlyApproval) send({ jsonrpc: '2.0', id: 41, method: 'item/commandExecution/requestApproval', params: {
      threadId, turnId, itemId: 'early-command', startedAtMs: 1, command: 'cat report.md',
      cwd: process.cwd(), availableDecisions: ['accept', 'decline'],
    } });
    setTimeout(() => {
      result({ turn: { id: turnId, status: 'inProgress' } });
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      if (!earlyApproval) send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    }, earlyApproval ? 400 : 0);
    return;
  }
  if (id === 41) {
    if (!earlyApproval || message.result?.decision !== 'decline') process.exit(32);
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    return;
  }
  if (method === 'thread/read') return result({ thread: { id: threadId, sessionId, turns: [{ id: turnId, status: 'completed', itemsView: 'full',
    items: [{ id: 'report-read', type: 'commandExecution', command: 'cat report.md', status: 'completed',
      aggregatedOutput: 'report evidence '.repeat(22000), exitCode: 0 },
      { id: 'assistant-final', type: 'agentMessage', phase: 'final_answer', text: responseText }] }] } });
  if (method === 'turn/interrupt') return result({});
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported fixture method' } });
});
`;
}

async function fixture(t, mode = 'complete') {
  const harness = reviewContext(mode);
  const app = await createUiRunsFixture({ mode: {}, reviewContext: harness.context });
  t.after(() => app.close());
  return { ...app, reviewCalls: harness.calls };
}

async function previewTask(app, ref) {
  const options = await app.provider.reviews({ ref });
  assert.equal(options.reviewOptions.profiles.find(profile => profile.name === 'baseline').ready, true);
  const preview = await app.provider.previewReviewTask({ ref, profile: 'baseline', cwd: app.repository,
    prompt: 'Check the frozen comparison and cite it.', includeRecordedContent: false, timeoutMs: null });
  assert.equal(preview.ready, true);
  assert.equal(preview.timeoutMs, null);
  assert.equal(preview.inputs.length, 3);
  return preview;
}

async function staleTaskSnapshot(app, id, { unsafeReplacement = false } = {}) {
  const path = join(app.store.directory, 'review-tasks', id, 'task.json'), originalLstat = fsPromises.lstat;
  let injected = false, before, stale, current;
  fsPromises.lstat = async (...args) => {
    if (injected || args[0] !== path) return originalLstat(...args);
    before = await originalLstat(...args);
    injected = true;
    const value = JSON.parse(await readFile(path, 'utf8'));
    await record(path, value);
    if (unsafeReplacement) await chmod(path, 0o644);
    current = await originalLstat(path);
    stale = Object.assign(Object.create(Object.getPrototypeOf(before)), before, { nlink: 0 });
    return stale;
  };
  syncBuiltinESMExports();
  let returned;
  try { returned = await app.provider.reviewTask({ id }); }
  finally { fsPromises.lstat = originalLstat; syncBuiltinESMExports(); }
  if (unsafeReplacement) await chmod(path, 0o600);
  const fresh = await app.provider.reviewTask({ id });
  return { returned, fresh, injected,
    before: { dev: before.dev, ino: before.ino, mode: before.mode, nlink: before.nlink },
    stale: { dev: stale.dev, ino: stale.ino, mode: stale.mode, nlink: stale.nlink },
    current: { dev: current.dev, ino: current.ino, mode: current.mode, nlink: current.nlink } };
}

test('review response and frozen citations reopen after the originating comparison record disappears', async t => {
  const app = await fixture(t);
  const ref = await seedComparison(app);
  const preview = await previewTask(app, ref);
  const started = await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  assert.equal(started.id, preview.previewToken);
  const task = await until(() => app.provider.reviewTask({ id: started.id }), value => value.status === 'completed', 'review task did not complete');
  assert.equal(task.status, 'completed');
  assert.equal(task.response.status, 'complete');
  assert.equal(task.response.text, '  A retained fixture response.  ');
  assert.equal(app.reviewCalls.captures, 1);

  await app.restartServer();
  await rm(join(app.store.directory, 'audits'), { recursive: true, force: true });
  assert.deepEqual(await app.provider.startReviewTask({ ref, previewToken: preview.previewToken }),
    { id: preview.previewToken }, 'same UUID reads durable attempt before needing volatile report or preview');
  assert.equal(app.reviewCalls.captures, 1, 'replayed Start never repeats model work');
  const frozen = await app.provider.report({ ref: `r.${started.id}` });
  assert.equal(frozen.title, task.title);
  assert.ok(frozen.a.profile && frozen.b.profile);
  assert.equal(frozen.verification.reviews.href, `/reports/r.${started.id}/reviews`);
  const reviews = await app.provider.reviews({ ref: `r.${started.id}` });
  assert.ok(reviews.reviewTasks.some(row => row.id === started.id && row.status === 'completed'));
  const reread = await app.provider.reviewTask({ id: started.id });
  assert.equal(reread.response.text, '  A retained fixture response.  ');
});

test('native approval waits on the review connection, records waiting state, and consumes one explicit answer', async t => {
  const app = await fixture(t, 'approval');
  const ref = await seedComparison(app), preview = await previewTask(app, ref);
  await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  const waiting = await until(() => app.provider.reviewTask({ id: preview.previewToken }), task => task.status === 'waiting-for-user', 'approval was not made visible');
  assert.equal(waiting.pendingRequests.length, 1);
  assert.equal(waiting.pendingRequests[0].method, 'item/commandExecution/requestApproval');
  assert.equal(waiting.pendingRequests[0].params.command, 'cat report.md');
  await assert.rejects(app.provider.respondReviewTask({ id: waiting.id, requestId: waiting.pendingRequests[0].requestId, response: { decision: 'acceptForSession' } }), /not offered/);
  const result = await app.provider.respondReviewTask({ id: waiting.id, requestId: waiting.pendingRequests[0].requestId, response: { decision: 'decline' } });
  assert.equal(result.id, waiting.id);
  assert.deepEqual(result.pendingRequests, [], 'response clears the durable pending request before returning');
  const completed = await until(() => app.provider.reviewTask({ id: waiting.id }),
    task => task.status !== 'running' && task.status !== 'waiting-for-user', 'review did not finish after approval');
  assert.equal(completed.status, 'completed');
  await assert.rejects(app.provider.respondReviewTask({ id: waiting.id, requestId: waiting.pendingRequests[0].requestId, response: { decision: 'decline' } }), /no longer waiting/);
});

test('review task reads retry only safe atomic task-record replacements after a stale link-count snapshot', async t => {
  const app = await fixture(t, 'approval');
  const ref = await seedComparison(app), preview = await previewTask(app, ref);
  await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  const waiting = await until(() => app.provider.reviewTask({ id: preview.previewToken }), task => task.status === 'waiting-for-user', 'approval was not made visible');
  const safe = await staleTaskSnapshot(app, waiting.id);
  const unsafe = await staleTaskSnapshot(app, waiting.id, { unsafeReplacement: true });
  assert.equal(safe.injected, true);
  assert.equal(safe.before.nlink, 1);
  assert.deepEqual([safe.stale.dev, safe.stale.ino, safe.stale.mode], [safe.before.dev, safe.before.ino, safe.before.mode]);
  assert.equal(safe.stale.nlink, 0);
  assert.notDeepEqual([safe.current.dev, safe.current.ino], [safe.before.dev, safe.before.ino]);
  assert.equal(safe.current.nlink, 1);
  assert.equal(safe.returned.status, 'waiting-for-user');
  assert.equal(safe.fresh.status, 'waiting-for-user');
  assert.equal(unsafe.injected, true);
  assert.equal(unsafe.current.mode & 0o077, 0o044);
  assert.equal(unsafe.returned.status, 'uncertain');
  assert.equal(unsafe.returned.error, 'durable-task-record-incomplete');
  assert.equal(unsafe.fresh.status, 'waiting-for-user');
  assert.equal(app.reviewCalls.captures, 1);
  await app.provider.respondReviewTask({ id: waiting.id, requestId: waiting.pendingRequests[0].requestId, response: { decision: 'decline' } });
  const completed = await until(() => app.provider.reviewTask({ id: waiting.id }), task => task.status === 'completed', 'review did not finish after approval');
  assert.equal(completed.status, 'completed');
});

test('review preview leaves no durable task or profile reservation', async t => {
  const app = await fixture(t);
  const ref = await seedComparison(app), options = await app.provider.reviews({ ref });
  const preview = await app.provider.previewReviewTask({ ref, profile: 'baseline', cwd: app.repository,
    prompt: 'A review prompt.', includeRecordedContent: false, timeoutMs: null });
  assert.equal(preview.ready, true);
  await assert.rejects(import('node:fs/promises').then(fs => fs.readdir(join(app.store.directory, 'review-tasks'))), { code: 'ENOENT' });
  assert.ok(options.reviewOptions.workspaces.some(row => row.path === app.repository && row.available));
});

test('ordinary review uses real capture against a disposable fake Codex executable', async t => {
  const app = await createUiRunsFixture({ mode: {}, reviewContext: { accessOptions: {
    inspectResources: async () => ({ clients: [], pids: [], records: 0, partial: false }), processSnapshot: async () => [],
  } } });
  t.after(() => app.close());
  await writeFile(app.executable, fakeCodexServer(), { mode: 0o700 });
  await chmod(app.executable, 0o700);
  const configPath = join(app.homes.baseline.home, 'config.toml');
  const configBefore = await readFile(configPath, 'utf8');
  const ref = await seedComparison(app);
  const preview = await previewTask(app, ref);
  const started = await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  const task = await until(() => app.provider.reviewTask({ id: started.id }), value => value.status === 'completed' || value.status === 'failed',
    'real capture did not reach a terminal state');
  assert.equal(task.status, 'completed', JSON.stringify(task));
  assert.equal(task.response.text, 'Reviewed the frozen report through the selected profile.');
  assert.equal(task.response.threadId, 'ordinary-review-thread');
  assert.equal(task.response.turnId, 'ordinary-review-turn');
  assert.deepEqual(task.shutdown, { status: 'confirmed', groupTerminated: true, processStatus: 'exited', exitCode: 0 });
  const observed = JSON.parse(await readFile(`${app.executable}.observed`, 'utf8'));
  assert.equal(observed.cwd, app.repository);
  assert.ok(observed.reportPath.endsWith('/report.md'));
  assert.ok(observed.reportText.trim().length > 0, 'fake Codex read the report file named in the actual task prompt');
  assert.ok(observed.prompt.includes(observed.reportPath));
  assert.equal(await readFile(configPath, 'utf8'), configBefore, 'ordinary review did not alter selected profile config');
});

test('early native approval remains waiting after delayed turn/start acknowledgement', async t => {
  const app = await createUiRunsFixture({ mode: {}, reviewContext: { accessOptions: {
    inspectResources: async () => ({ clients: [], pids: [], records: 0, partial: false }), processSnapshot: async () => [],
  } } });
  t.after(() => app.close());
  await writeFile(app.executable, fakeCodexServer(true), { mode: 0o700 });
  await chmod(app.executable, 0o700);
  const ref = await seedComparison(app), preview = await previewTask(app, ref);
  const started = await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  const waiting = await until(() => app.provider.reviewTask({ id: started.id }), task =>
    task.turnId === 'ordinary-review-turn' && task.pendingRequests.length === 1,
  'early approval and turn checkpoint were not both persisted');
  assert.equal(waiting.status, 'waiting-for-user');
  const result = await app.provider.respondReviewTask({ id: waiting.id,
    requestId: waiting.pendingRequests[0].requestId, response: { decision: 'decline' } });
  assert.deepEqual(result.pendingRequests, []);
  const completed = await until(() => app.provider.reviewTask({ id: waiting.id }), task =>
    task.status === 'completed' || task.status === 'failed', 'review did not finish after early approval');
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
});

test('cancel preserves partial response and releases shared admission only after owned shutdown', async t => {
  const app = await fixture(t, 'cancel');
  const ref = await seedComparison(app), comparisonPreview = await app.provider.runPreview(input(app));
  assert.equal(comparisonPreview.ready, true);
  const preview = await previewTask(app, ref);
  await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  const running = await until(() => app.provider.reviewTask({ id: preview.previewToken }), task => task.status === 'running', 'review did not start');
  await assert.rejects(app.provider.startRun({ previewToken: comparisonPreview.previewToken }), /active|running|admission|reserved/i,
    'an active review holds the shared admission lock against a comparison start');
  const cancelled = await app.provider.cancelReviewTask({ id: running.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.response.status, 'partial');
  assert.equal(cancelled.response.text, 'partial fixture response');
  const comparison = await app.provider.startRun({ previewToken: comparisonPreview.previewToken });
  const finished = await until(() => app.provider.run({ id: comparison.id }), value => value.state !== 'running',
    'comparison could not start after the cancelled review released shared admission');
  assert.equal(finished.state, 'finished');
});
