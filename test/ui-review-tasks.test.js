import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUiReviewTasks } from '../src/ui-review-tasks.js';
import { buildAuditReviewPacket } from '../src/audit-review.js';

const run = id => ({ id, source: { threadId: `${id}-thread` }, turns: [], checks: [] });
const comparison = { schemaVersion: 1, kind: 'audit-comparison', id: 'fixture-pair', status: 'partial',
  left: run('left'), right: run('right') };
const waitFor = async (fn, predicate, message) => {
  for (let i = 0; i < 100; i++) { const value = await fn(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
};

async function fixture(t, { delayed = false, nativeRequest = false, responseOverride, observeProcess, releaseFailures = 0,
  realReservations = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'xfx-ui-review-task-')));
  await mkdir(join(directory, 'profile'), { mode: 0o700 });
  const store = { directory };
  const profile = { profileId: 'fixture-profile', profileName: 'Strict', home: join(directory, 'profile'),
    nativeRoot: join(directory, 'profile'), reservationRoot: join(directory, 'profile'), environmentId: 'fixture',
    executable: '/fixture/codex', executableIdentity: 'fixture-identity', executableSource: 'registered',
    version: 'fixture', versionSource: 'registered', cwd: directory, env: { HOME: directory, PATH: '/usr/bin' },
    settingsIdentity: { fingerprint: 'fixture' } };
  const calls = { capture: 0, acquired: 0, released: 0, profileReleased: 0 };
  let continueCapture, releaseRequested = false, currentComparison = comparison;
  const lockOptions = { lockPath: join(directory, 'desktop.lock'), isAlive: () => false };
  const reservationOverrides = realReservations ? {} : {
    reserve: async () => {}, release: async () => {
      calls.profileReleased++;
      if (releaseFailures > 0) { releaseFailures--; throw new Error('fixture release contention'); }
    },
  };
  const service = createUiReviewTasks({ store, defaultUserHome: directory, resolveComparison: async ref => ({ value: currentComparison, title: `Report ${ref}` }),
    admission: { acquire: async () => { calls.acquired++; }, release: () => { calls.released++; } },
    context: { resolveProfile: async () => profile, recheckProfile: async () => profile,
      ...reservationOverrides, lockOptions, observeProcess: observeProcess ?? (async () => ({ status: 'unknown' })),
      capture: async input => {
        calls.capture++;
        await input.processOptions.onSpawn({ pid: 1234, processIdentity: { pid: 1234, started: 'fixture', host: 'fixture' } });
        await input.onTurn({ threadId: 'fixture-thread', turnId: 'fixture-turn' });
        if (nativeRequest) {
          const request = { method: 'item/tool/requestUserInput', id: 'fixture-request', params: { threadId: 'fixture-thread', turnId: 'fixture-turn',
            itemId: 'fixture-item', questions: [{ id: 'confirm', header: 'Confirm', question: 'May I proceed?', options: [{ label: 'Yes', description: 'Proceed once.' }] }] } };
          await input.onNativeRequest(request, { signal: input.processOptions.signal, item: { id: 'fixture-item', kind: 'user-input' } });
        }
        if (delayed && !releaseRequested && !input.processOptions.signal?.aborted) await new Promise(resolve => {
          continueCapture = resolve;
          input.processOptions.signal?.addEventListener('abort', resolve, { once: true });
        });
        if (input.processOptions.signal?.aborted) return { process: { status: 'cancelled', exitCode: null, elapsedMs: 4, shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } },
          run: { source: { threadId: 'fixture-thread' }, turns: [] }, capture: { status: 'unavailable' } };
        return { process: { status: 'exited', exitCode: 0, elapsedMs: 4, shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } },
          run: { source: { threadId: 'fixture-thread' }, turns: [{ turnId: 'fixture-turn' }] },
          capture: { status: 'ready', effectiveSettings: { model: 'fixture model' } },
          response: responseOverride ?? { status: 'complete', text: 'Scoped review response', threadId: 'fixture-thread', turnId: 'fixture-turn', source: 'recorded-assistant-turn' } };
      } } });
  t.after(async () => { releaseRequested = true; continueCapture?.(); await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, service, calls, setComparison: value => { currentComparison = value; }, profile, lockOptions,
    releaseCapture: () => { if (continueCapture) continueCapture(); else releaseRequested = true; } };
}

test('review preview is ephemeral and Start durably snapshots then returns while native capture runs', async t => {
  const app = await fixture(t, { delayed: true });
  const preview = await app.service.previewReviewTask({ ref: 's.fixture', profile: 'Strict', prompt: 'Check evidence.' });
  assert.equal(preview.ready, true);
  assert.match(preview.effectivePrompt, /Frozen report:/);
  await assert.rejects(readFile(join(app.store.directory, 'review-tasks')));
  const started = await app.service.startReviewTask({ ref: 's.fixture', previewToken: preview.previewToken });
  assert.equal(started.id, preview.previewToken);
  await waitFor(async () => app.calls.capture, count => count === 1, 'Capture did not start after durable acknowledgement');
  await waitFor(async () => JSON.parse(await readFile(join(app.store.directory, 'review-tasks', started.id, 'task.json'), 'utf8')), value => value.turnId === 'fixture-turn', 'Turn checkpoint was not persisted');
  const persisted = JSON.parse(await readFile(join(app.store.directory, 'review-tasks', started.id, 'task.json'), 'utf8'));
  assert.ok(['starting', 'running'].includes(persisted.status));
  assert.equal(persisted.profile.name, 'Strict');
  assert.equal(persisted.turnId, 'fixture-turn');
  assert.match(await readFile(join(app.store.directory, 'review-tasks', started.id, 'prompt.md'), 'utf8'), /Frozen evidence:/);
  assert.deepEqual(await app.service.startReviewTask({ ref: 's.fixture', previewToken: preview.previewToken }), started);
  assert.equal(app.calls.capture, 1);
  app.releaseCapture();
  const done = await waitFor(() => app.service.reviewTask({ id: started.id }), task => task.status === 'completed', 'Review did not complete');
  assert.equal(done.response.text, 'Scoped review response');
  assert.deepEqual(done.nativeSettings, { model: 'fixture model' });
  assert.equal(done.shutdown.groupTerminated, true);
  await waitFor(async () => app.calls.released, count => count === 1, 'Profile reservation was not released');
  const frozen = await app.service.frozenComparison(started.id);
  assert.equal(frozen.value.kind, 'audit-comparison');
  assert.equal(frozen.comparisonFingerprint, persisted.sourceEvidenceFingerprint);
});

test('review source bytes are verified and a changed frozen export is refused', async t => {
  const app = await fixture(t);
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const started = await app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken });
  await waitFor(() => app.service.reviewTask({ id: started.id }), task => task.status === 'completed', 'Review did not complete');
  const evidencePath = join(app.store.directory, 'review-tasks', started.id, 'report.md.audit.json');
  await writeFile(evidencePath, '{}\n');
  await assert.rejects(app.service.frozenComparison(started.id), { code: 'review-source-changed' });
});

test('completed response survives release contention and a later read retries cleanup without recapturing', async t => {
  const app = await fixture(t, { releaseFailures: 1 });
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const { id } = await app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken });
  const taskPath = join(app.store.directory, 'review-tasks', id, 'task.json');
  const pending = await waitFor(async () => JSON.parse(await readFile(taskPath, 'utf8')),
    task => task.status === 'completed' && task.reservation?.status === 'uncertain',
    'Completed response was not retained after release contention');

  assert.equal(app.calls.capture, 1);
  assert.equal(app.calls.profileReleased, 1);
  assert.equal(pending.response.status, 'complete');
  assert.equal(pending.shutdown.groupTerminated, true);
  const retried = await app.service.reviewTask({ id });
  assert.equal(retried.status, 'completed');
  assert.equal(retried.response.text, 'Scoped review response');
  assert.equal(retried.shutdown.groupTerminated, true);
  assert.doesNotMatch(retried.limits.join(' '), /cleanup is pending/);
  assert.equal(JSON.parse(await readFile(taskPath, 'utf8')).reservation.status, 'released');
  assert.equal(app.calls.profileReleased, 2);
  assert.equal(app.calls.capture, 1);
});

test('default review reservation reclaims a validated dead profile operation guard', async t => {
  const app = await fixture(t, { realReservations: true });
  const operation = `${app.lockOptions.lockPath}.operation`;
  const owner = { kind: 'desktop-instance-operation', host: hostname(), pid: 2147483647,
    runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', storePath: app.store.directory,
    profileId: app.profile.profileId,
    journalPath: join(app.store.directory, 'desktop-instances', `${app.profile.profileId}.json`) };
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  await mkdir(operation, { mode: 0o700 });
  await writeFile(join(operation, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });

  const { id } = await app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken });
  const task = await waitFor(() => app.service.reviewTask({ id }), value => value.status === 'completed', 'Review did not complete');

  assert.equal(task.response.text, 'Scoped review response');
  assert.equal(app.calls.capture, 1);
  await waitFor(async () => JSON.parse(await readFile(join(app.store.directory, 'review-tasks', id, 'task.json'), 'utf8')),
    value => value.reservation.status === 'released', 'Review reservation cleanup did not finish');
  await assert.rejects(readFile(join(operation, 'owner.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(app.profile.reservationRoot, '.run-lock')), { code: 'ENOENT' });
});


test('native requests remain explicit and persist as answered before the capture resumes', async t => {
  const app = await fixture(t, { nativeRequest: true });
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const { id } = await app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken });
  const waiting = await waitFor(() => app.service.reviewTask({ id }), task => task.status === 'waiting-for-user', 'Native request was not surfaced');
  assert.equal(waiting.pendingRequests.length, 1);
  const answered = await app.service.respondReviewTask({ id, requestId: waiting.pendingRequests[0].requestId,
    response: { answers: { confirm: { answers: ['Yes'] } } } });
  assert.deepEqual(answered.pendingRequests, []);
  await assert.rejects(app.service.respondReviewTask({ id, requestId: waiting.pendingRequests[0].requestId,
    response: { answers: { confirm: { answers: ['Yes'] } } } }), { code: 'stale-review-request' });
  const done = await waitFor(() => app.service.reviewTask({ id }), task => task.status === 'completed', 'Review did not complete after explicit response');
  assert.equal(done.response.text, 'Scoped review response');
});

test('cancel stops an active task and replaying the same token against another ref is rejected', async t => {
  const app = await fixture(t, { delayed: true });
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const { id } = await app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken });
  await waitFor(async () => app.calls.capture, count => count === 1, 'Capture did not start');
  await assert.rejects(app.service.startReviewTask({ ref: 'other.report', previewToken: preview.previewToken }), { code: 'review-task-source-mismatch' });
  const cancelled = await app.service.cancelReviewTask({ id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.response, null);
  assert.equal(cancelled.cancellation.reason, 'user-cancel');
  assert.equal(cancelled.shutdown.groupTerminated, true);
});

test('closing waits for active review shutdown and its durable cancellation record', async t => {
  const app = await fixture(t, { delayed: true });
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const { id } = await app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken });
  await waitFor(async () => app.calls.capture, count => count === 1, 'Capture did not start');

  await app.service.close();

  const task = JSON.parse(await readFile(join(app.store.directory, 'review-tasks', id, 'task.json'), 'utf8'));
  assert.equal(task.status, 'cancelled');
  assert.equal(task.cancellation.reason, 'coordinator-shutdown');
  assert.equal(task.shutdown.groupTerminated, true);
  assert.equal(task.reservation.status, 'released');
});


test('a blank or mismatched assistant response is never marked complete', async t => {
  for (const [name, response] of [
    ['blank', { status: 'complete', text: '  ', threadId: 'fixture-thread', turnId: 'fixture-turn', source: 'recorded-assistant-turn' }],
    ['wrong-turn', { status: 'complete', text: 'Foreign response', threadId: 'fixture-thread', turnId: 'other-turn', source: 'recorded-assistant-turn' }],
  ]) {
    await t.test(name, async child => {
      const app = await fixture(child, { responseOverride: response });
      const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
      const { id } = await app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken });
      const done = await waitFor(() => app.service.reviewTask({ id }), task => task.status === 'failed', 'Invalid response was marked complete');
      assert.equal(done.response, null);
      assert.match(done.error, /response-(?:text-unavailable|turn-mismatch)/);
    });
  }
});

test('an incomplete durable attempt is preserved and never relaunched', async t => {
  const app = await fixture(t);
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const taskRoot = join(app.store.directory, 'review-tasks', preview.previewToken);
  await mkdir(taskRoot, { recursive: true, mode: 0o700 });
  const recordPath = join(taskRoot, 'task.json');
  await writeFile(recordPath, '{}\n', { mode: 0o600 });
  const replay = await app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken });
  assert.equal(replay.id, preview.previewToken);
  const detail = await app.service.reviewTask({ id: replay.id });
  assert.equal(detail.status, 'uncertain');
  assert.equal(detail.shutdown.groupTerminated, false);
  await assert.rejects(app.service.assertAvailable(), { code: 'review-uncertain' });
  assert.equal(await readFile(recordPath, 'utf8'), '{}\n');
  assert.equal(app.calls.capture, 0);
});


async function writeRecoveryFixture(app, preview, { status = 'running', captureIntent = true, process = true,
  processPid = 4101, coordinatorPid = 4102 } = {}) {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const taskRoot = join(app.store.directory, 'review-tasks', id);
  await mkdir(taskRoot, { recursive: true, mode: 0o700 });
  const processIdentity = { pid: processPid, started: 'fixture-child', command: 'fixture-native', host: hostname() };
  const coordinatorIdentity = { pid: coordinatorPid, started: 'fixture-coordinator', command: 'fixture-test', host: hostname() };
  const owner = { kind: 'review-task', runId: id, host: hostname(), pid: coordinatorPid,
    storePath: app.store.directory, profileId: app.profile.profileId, home: app.profile.home, coordinatorIdentity };
  const task = { schemaVersion: 1, kind: 'xfx-review-task', id, status, phase: status,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceRef: 'saved.report', sourceTitle: 'Recovery fixture',
    sourceEvidenceFingerprint: buildAuditReviewPacket(comparison).evidenceFingerprint, inputFingerprint: 'a'.repeat(64),
    inputReportSha256: preview.inputs[1].sha256, reportMarkdownSha256: preview.inputs[0].sha256,
    promptSha256: preview.inputs[2].sha256, includeRecordedContent: false,
    inputs: preview.inputs.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    profile: { name: app.profile.profileName, id: app.profile.profileId, home: app.profile.home,
      nativeRoot: app.profile.nativeRoot, reservationRoot: app.profile.reservationRoot }, cwd: app.profile.cwd, timeoutMs: null,
    threadId: process ? 'fixture-thread' : null, turnId: process ? 'fixture-turn' : null,
    process: process ? { pid: processPid, processIdentity } : null, captureIntent,
    reservation: { root: app.profile.reservationRoot, owner, status: 'held' },
    shutdown: { status: 'uncertain', groupTerminated: false }, pendingRequests: [], response: null };
  await writeFile(join(taskRoot, 'task.json'), `${JSON.stringify(task)}\n`, { mode: 0o600 });
  return { id, taskRoot, processIdentity, coordinatorIdentity };
}

test('recovery interrupts and releases only after both saved process identities are stopped', async t => {
  const observations = new Map();
  const app = await fixture(t, { observeProcess: async identity => observations.get(identity.pid) ?? { status: 'unknown' } });
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const saved = await writeRecoveryFixture(app, preview);
  observations.set(saved.processIdentity.pid, { status: 'stopped' });
  observations.set(saved.coordinatorIdentity.pid, { status: 'stopped' });
  const recovered = await app.service.reviewTask({ id: saved.id });
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.shutdown.groupTerminated, true);
  assert.equal(app.calls.profileReleased, 1);
  const persisted = JSON.parse(await readFile(join(saved.taskRoot, 'task.json'), 'utf8'));
  assert.equal(persisted.reservation.status, 'released');
  await app.service.assertAvailable();
  assert.equal(app.calls.capture, 0);
});

test('recovery keeps ownership when either identity is live or unknown, and when capture intent lacks a child checkpoint', async t => {
  const scenarios = [
    { name: 'coordinator live', processStatus: 'stopped', coordinatorStatus: 'live', process: true, captureIntent: true },
    { name: 'coordinator unknown', processStatus: 'stopped', coordinatorStatus: 'unknown', process: true, captureIntent: true },
    { name: 'child live', processStatus: 'live', coordinatorStatus: 'stopped', process: true, captureIntent: true },
    { name: 'capture intent without child identity', processStatus: 'unknown', coordinatorStatus: 'stopped', process: false, captureIntent: true },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async child => {
    const observations = new Map();
    const app = await fixture(child, { observeProcess: async identity => observations.get(identity.pid) ?? { status: 'unknown' } });
    const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
    const saved = await writeRecoveryFixture(app, preview, scenario);
    if (scenario.process) observations.set(saved.processIdentity.pid, { status: scenario.processStatus });
    observations.set(saved.coordinatorIdentity.pid, { status: scenario.coordinatorStatus });
    const detail = await app.service.reviewTask({ id: saved.id });
    assert.equal(detail.status, 'uncertain');
    assert.equal(app.calls.profileReleased, 0);
    await assert.rejects(app.service.assertAvailable(), { code: 'review-uncertain' });
    assert.equal(app.calls.capture, 0);
  });
});

test('recovery can release a reservation when the coordinator stopped before capture intent', async t => {
  const observations = new Map();
  const app = await fixture(t, { observeProcess: async identity => observations.get(identity.pid) ?? { status: 'unknown' } });
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const saved = await writeRecoveryFixture(app, preview, { status: 'starting', captureIntent: false, process: false });
  observations.set(saved.coordinatorIdentity.pid, { status: 'stopped' });
  const recovered = await app.service.reviewTask({ id: saved.id });
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.shutdown.groupTerminated, true);
  assert.equal(app.calls.profileReleased, 1);
  assert.equal(app.calls.capture, 0);
});

test('a stale preview is refused before creating a durable attempt', async t => {
  const app = await fixture(t);
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const changed = structuredClone(comparison);
  changed.left.turns.push({ turnId: 'new-source-turn', status: 'completed' });
  app.setComparison(changed);
  await assert.rejects(app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken }), { code: 'review-preview-stale' });
  await assert.rejects(readFile(join(app.store.directory, 'review-tasks')));
  assert.equal(app.calls.capture, 0);
});

test('polls that overlap owned completion never mistake their snapshot for coordinator loss', async t => {
  const app = await fixture(t, { delayed: true });
  const preview = await app.service.previewReviewTask({ ref: 'saved.report', profile: 'Strict' });
  const { id } = await app.service.startReviewTask({ ref: 'saved.report', previewToken: preview.previewToken });
  await waitFor(() => app.service.reviewTask({ id }), task => task.status === 'running', 'Review did not start');
  const reads = Array.from({ length: 30 }, () => app.service.reviewTask({ id }));
  app.releaseCapture();
  for (const task of await Promise.all(reads)) assert.ok(['running', 'completed'].includes(task.status), task.status);
  await waitFor(() => app.service.reviewTask({ id }), task => task.status === 'completed', 'Review did not complete');
});

test('an unknown task stays unavailable without starting or recreating work', async t => {
  const app = await fixture(t);
  await assert.rejects(app.service.reviewTask({ id: '10000000-0000-0000-0000-000000000001' }), { status: 404, code: 'review-task-not-found' });
  assert.equal(app.calls.capture, 0);
});
