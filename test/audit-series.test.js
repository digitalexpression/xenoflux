import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/profiles.js';
import { runAuditSeries, resumeAuditSeries, buildAuditSeriesReport, auditSeriesLifecycle } from '../src/audit-series.js';
import { createExperiment, createExperimentRun, writeAuditState, finalizeAuditRecord,
  readAuditRecord, reserveAuditProfile, inspectAuditReservation } from '../src/audit-experiment-store.js';

const commit = 'a'.repeat(40), tree = 'b'.repeat(40);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-series-unit-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = join(root, 'store'); await mkdir(storeDirectory, { mode: 0o700 });
  const store = new Store(storeDirectory), repository = join(root, 'repository');
  const profiles = [];
  for (const [i, name] of ['Alpha', 'Beta'].entries()) {
    const home = join(root, `home-${i}`); await mkdir(home, { mode: 0o700 });
    profiles.push({ profileId: `profile-${i}`, profileName: name, home, userHome: home, nativeRoot: home,
      executable: join(root, 'fake-codex'), executableIdentity: { dev: 1, ino: i + 1 }, version: '1.2.3',
      bindingRepository: null, environmentId: `environment-${i}`, reservationRoot: home, env: { PATH: '/usr/bin:/bin' } });
  }
  const spec = { schemaVersion: 1, repository, revision: 'fixture-revision', task: 'Produce the declared result.',
    profiles: profiles.map(profile => ({ name: profile.profileName })),
    limits: { runMs: 1000, experimentMs: 4000, outputBytes: 4096 }, setup: [],
    checks: [{ name: 'contract', argv: ['/usr/bin/true'], timeoutMs: 1000 }], sandbox: 'read-only', allowIncompleteCapture: true,
    quality: { id: 'fixture-quality', version: '1', checks: [{ name: 'contract' }] },
    trials: { count: 2, order: 'balanced', budgetMs: 2000 }, variables: ['profile'] };
  const context = {
    baseDirectory: join(store.directory, 'audits'),
    inspectRepository: async path => ({ repository: path, commit, tree, sourceHead: commit, sourceDirty: false, files: 1, bytes: 10, clean: true }),
    resolveProfile: async (_store, selection) => profiles.find(profile => profile.profileName === (typeof selection === 'string'
      ? selection : selection.name) || profile.profileId === selection),
    observeAccess: async () => ({ status: 'ready', clients: [], sourceReservation: null }),
    snapshotSettings: async () => ({ status: 'ready', fingerprint: 'settings-fixture' }),
    settingsIdentity: () => 'settings-fixture',
    probeVersion: async () => '1.2.3',
  };
  return { root, store, repository, profiles, spec, context };
}

function fakeRun(profile, id, { checkStatus = 'passed' } = {}) {
  return { schemaVersion: 1, kind: 'audit-run', id, status: 'complete', profile: {
    profileId: profile.profileId, profileName: profile.profileName }, source: { threadId: `thread-${profile.profileId}` },
    turns: [{ agentId: `thread-${profile.profileId}`, turnId: `turn-${id}`, status: 'completed' }],
    execution: { status: 'exited', exitCode: 0, elapsedMs: 5 },
    task: { nativeTurnStatus: 'completed' }, outcome: { nativeTurnStatus: 'completed' },
    checks: [{ name: 'contract', status: checkStatus, exitCode: checkStatus === 'passed' ? 0 : 1 }],
    workspace: { taskEnd: { fingerprint: `task-${id}`, fileCount: 1, captureComplete: true, timing: 'task-end' } },
    profileSettings: { status: 'unchanged' }, runningClients: { status: 'unchanged' },
    metrics: { processElapsedMs: 5 }, coverage: { skills: 'complete', timeline: 'complete', agents: 'complete' },
    agents: [], warnings: [] };
}

function fakeTrialReport(spec, experimentId) {
  return { schemaVersion: 1, kind: 'audit-experiment-report', id: experimentId, status: 'complete',
    baseline: { repository: spec.repository, commit, tree },
    runs: spec.profiles.map((selection, index) => fakeRun({ profileId: `profile-${selection.name === 'Alpha' ? 0 : 1}`,
      profileName: selection.name }, `${experimentId}-${index}`)), execution: { status: 'complete' },
    coverage: { execution: 'complete' }, warnings: [] };
}

async function startAtPreparedSlot(f, trialCount = 2) {
  const spec = { ...f.spec, trials: { ...f.spec.trials, count: trialCount, budgetMs: 2000 * trialCount } };
  const initial = await runAuditSeries(f.store, spec, { ...f.context,
    onTrialPrepared: async ({ slot }) => { if (slot.index === 1) throw new Error('fixture stops after durable starting state'); },
    runTrial: async () => { throw new Error('prepared-slot fixture must not execute a child'); } });
  assert.equal(initial.status, 'blocked');
  const series = await readAuditRecord(f.store, initial.id);
  assert.equal(series.state.trials[0].status, 'starting');
  return { spec, series };
}

async function makeChildWithHeldRun(f, series, { coordinatorLive = false, checkStatus = 'passed' } = {}) {
  const slot = series.record.plan[0], selected = f.profiles[0],
    baseline = { repository: { repository: f.repository, commit, tree }, source: 'committed-snapshot' };
  const child = await createExperiment(f.store, { id: slot.experimentId,
    spec: { ...f.spec, trials: undefined, quality: undefined, variables: undefined }, task: f.spec.task,
    profiles: f.profiles.map(({ profileId, profileName, home }) => ({ profileId, profileName, home })), baseline,
    series: { id: series.id, trialIndex: slot.trialIndex } });
  const run = await createExperimentRun(f.store, { experimentId: child.id,
    profile: { profileId: selected.profileId, profileName: selected.profileName, home: selected.home, nativeRoot: selected.nativeRoot },
    baseline });
  const owner = { kind: 'audit-experiment', host: hostname(), pid: 24680, runId: run.id,
    experimentId: child.id, storePath: f.store.directory, profileId: selected.profileId, home: selected.home };
  await reserveAuditProfile({ root: selected.nativeRoot, owner });
  await writeAuditState(f.store, run.id, { status: 'complete', phase: 'complete',
    coordinator: { pid: coordinatorLive ? process.pid : 987654321, host: hostname(),
      processIdentity: { started: true, pid: coordinatorLive ? process.pid : 987654321, host: hostname() } },
    reservation: { root: selected.nativeRoot, owner, status: 'held' }, process: null, workspace: null });
  const runReport = fakeRun(selected, run.id, { checkStatus });
  await finalizeAuditRecord(f.store, run.id, runReport);
  await writeAuditState(f.store, child.id, { status: 'complete', phase: 'finished',
    coordinator: { pid: 987654321, host: hostname(), processIdentity: null } });
  await finalizeAuditRecord(f.store, child.id, { schemaVersion: 1, kind: 'audit-experiment-report', id: child.id,
    status: 'complete', baseline, runs: [runReport], comparisons: [], execution: { status: 'complete' },
    coverage: { execution: 'complete' }, warnings: [] });
  return { child: await readAuditRecord(f.store, child.id), run: await readAuditRecord(f.store, run.id), owner, slot };
}

test('reconciles a held unfinished run before the next slot despite a finalized child status; blocked recovery stops the series', async t => {
  await t.test('successful recovery precedes unused slot execution', async subtest => {
    const f = await fixture(subtest), { series } = await startAtPreparedSlot(f);
    const { child, run, owner } = await makeChildWithHeldRun(f, series);
    let trialCalls = 0;
    const result = await resumeAuditSeries(f.store, series.id, { ...f.context,
      observeProcess: async () => ({ status: 'stopped' }),
      runTrial: async (_store, trial, options) => {
        trialCalls++;
        const recoveredChild = await readAuditRecord(f.store, child.id), recoveredRun = await readAuditRecord(f.store, run.id);
        assert.ok(recoveredRun.recovery, 'member recovery receipt exists before next trial begins');
        assert.equal(await inspectAuditReservation({ root: owner.home, owner }), null, 'held profile lease was released first');
        return fakeTrialReport(trial, options.experimentId);
      } });
    assert.equal(result.kind, 'audit-series-report');
    assert.equal(trialCalls, 1, 'only the unused second slot executes');
    assert.equal((await readAuditRecord(f.store, run.id)).finalized, true);
    assert.equal((await readAuditRecord(f.store, child.id)).report.status, 'complete');
  });

  await t.test('uncertain recovery blocks all unused trials and preserves its lease', async subtest => {
    const f = await fixture(subtest), { series } = await startAtPreparedSlot(f);
    const { run, owner } = await makeChildWithHeldRun(f, series, { coordinatorLive: true });
    let trialCalls = 0;
    const result = await resumeAuditSeries(f.store, series.id, { ...f.context,
      observeProcess: async () => ({ status: 'unknown' }),
      runTrial: async () => { trialCalls++; return fakeTrialReport(f.spec, randomUUID()); } });
    assert.equal(result.status, 'blocked');
    assert.equal(trialCalls, 0, 'blocked recovery prevents later slot execution');
    assert.equal((await readAuditRecord(f.store, run.id)).recovery, null);
    assert.deepEqual(await inspectAuditReservation({ root: owner.home, owner }), owner, 'uncertain lease is retained');
  });
});

test('series report regeneration prefers current recovered child/member reports over stale parent summary', async t => {
  const f = await fixture(t), { series } = await startAtPreparedSlot(f);
  const { child, slot } = await makeChildWithHeldRun(f, series, { checkStatus: 'passed' });
  const stale = fakeRun(f.profiles[0], 'stale-run', { checkStatus: 'failed' });
  const refreshedState = await readAuditRecord(f.store, series.id);
  await writeAuditState(f.store, series.id, { trials: refreshedState.state.trials.map(item => item.experimentId === slot.experimentId
    ? { ...item, status: 'recorded', summary: { index: slot.index, experimentId: slot.experimentId,
      status: 'complete', profileOrder: slot.profileOrder, runs: [stale] } } : item) });
  const regenerated = await buildAuditSeriesReport(f.store, series.id);
  const alpha = regenerated.trials[0].profiles.find(item => item.profileName === 'Alpha');
  assert.equal(alpha.run.id, (await readAuditRecord(f.store, child.id)).state.runs[0].id);
  assert.equal(alpha.quality.criteria.find(item => item.id === 'check:contract').status, 'passed');
  assert.equal(alpha.quality.status, 'passed');
});

test('initial execution blocks before the next slot when a returned trial leaves a held member reservation', async t => {
  const f = await fixture(t); let calls = 0, held;
  const result = await runAuditSeries(f.store, f.spec, { ...f.context,
    runTrial: async (_store, trial, options) => {
      calls++;
      const series = await readAuditRecord(f.store, options.series.id);
      held = await makeChildWithHeldRun(f, series, { checkStatus: 'passed' });
      return fakeTrialReport(trial, options.experimentId); // Superficially complete; persisted member is unreconciled.
    } });
  assert.equal(result.status, 'blocked');
  assert.equal(calls, 1, 'the second planned slot never starts');
  assert.equal(result.warnings.some(warning => warning.code === 'series-trial-recovery-required'), true,
    'the recovery guard is visible in the report');
  const series = await readAuditRecord(f.store, result.id);
  assert.equal(series.state.status, 'blocked');
  assert.equal(series.state.trials[1].status, 'not-started');
  assert.equal(series.finalized, false);
  assert.deepEqual(await inspectAuditReservation({ root: held.owner.home, owner: held.owner }), held.owner,
    'the uncertain held lease remains intact');
});

test('a starting slot without a child is never retried and stays in the planned denominator', async t => {
  const f = await fixture(t), { series } = await startAtPreparedSlot(f, 2);
  const firstId = series.record.plan[0].experimentId, plannedIds = series.record.plan.map(slot => slot.experimentId);
  await assert.rejects(readAuditRecord(f.store, firstId), /Audit record is invalid|ENOENT/,
    'no child exists for the interrupted starting slot');
  const calls = [];
  const result = await resumeAuditSeries(f.store, series.id, { ...f.context,
    runTrial: async (_store, trial, options) => {
      calls.push(options.series.trialIndex);
      return fakeTrialReport(trial, options.experimentId);
    } });
  assert.deepEqual(calls, [1], 'the child-creation gap is accounted for without retry');
  assert.deepEqual(result.plan.map(slot => slot.experimentId), plannedIds, 'the original trial UUID plan remains stable');
  assert.equal(result.profiles.every(profile => profile.planned === 2 && profile.executed === 1), true);
  assert.equal(result.profiles.every(profile => profile.quality.denominator === 2 && profile.quality.notRun === 1), true);
  assert.equal(result.coverage.plannedSlots, 2);
  assert.equal(result.coverage.missingSlots, 1);
});

test('settings metadata drift blocks the next pending slot without profile mutation or restoration', async t => {
  const f = await fixture(t), { series } = await startAtPreparedSlot(f);
  const originalProfiles = structuredClone(f.profiles), calls = [];
  const result = await resumeAuditSeries(f.store, series.id, { ...f.context,
    settingsIdentity: () => 'settings-changed-since-freeze',
    runTrial: async () => { calls.push('started'); return null; } });
  assert.equal(result.status, 'blocked');
  assert.equal(calls.length, 0, 'profile identity drift is detected before a pending trial starts');
  assert.deepEqual(f.profiles, originalProfiles, 'fixture profile settings metadata is observed but never restored or mutated');
  const state = await readAuditRecord(f.store, series.id);
  assert.equal(state.state.trials[1].status, 'not-started');
  assert.ok(state.state.warnings.some(warning => warning.code === 'series-settings-drift'));
});

test('frozen task tampering blocks resume before any trial executes', async t => {
  const f = await fixture(t), { series } = await startAtPreparedSlot(f);
  const recordPath = join(series.directory, 'series.json');
  const saved = JSON.parse(await readFile(recordPath, 'utf8'));
  saved.spec.task = 'Tampered after series freeze.';
  await writeFile(recordPath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  let calls = 0;
  await assert.rejects(resumeAuditSeries(f.store, series.id, { ...f.context,
    runTrial: async () => { calls++; return null; } }), error => error.code === 'series-frozen-definition-changed');
  assert.equal(calls, 0, 'the frozen recipe mismatch prevents pending task execution');
  assert.equal((await readAuditRecord(f.store, series.id)).state.trials[1].status, 'not-started');
});

test('native config is frozen into the series recipe and cannot drift on resume', async t => {
  const f = await fixture(t);
  f.spec.profiles[0].nativeConfig = { forced_login_method: 'chatgpt', model_reasoning_effort: 'low', plan_mode_reasoning_effort: 'low' };
  const { series } = await startAtPreparedSlot(f);
  assert.deepEqual(series.record.profiles[0].nativeConfig, f.spec.profiles[0].nativeConfig);
  assert.deepEqual(series.record.spec.profiles[0].nativeConfig, f.spec.profiles[0].nativeConfig);
  assert.ok(series.record.recipe.fingerprint, 'native config is included in the frozen recipe fingerprint');
  const recordPath = join(series.directory, 'series.json'), saved = JSON.parse(await readFile(recordPath, 'utf8'));
  saved.spec.profiles[0].nativeConfig.forced_login_method = 'api';
  await writeFile(recordPath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(resumeAuditSeries(f.store, series.id, { ...f.context,
    runTrial: async () => assert.fail('tampered native config must stop resume') }),
  error => error.code === 'series-frozen-definition-changed');
});

test('series recovery and cleanup lifecycle calls do not advance pending slots', async t => {
  const f = await fixture(t), { series } = await startAtPreparedSlot(f);
  const before = (await readAuditRecord(f.store, series.id)).state.trials;
  const recovered = await auditSeriesLifecycle(f.store, series.id, 'recover', { apply: true,
    ...f.context, observeProcess: async () => ({ status: 'stopped' }) });
  assert.equal(recovered.kind, 'audit-series-recovery');
  assert.equal(recovered.status, 'recovered');
  assert.ok(recovered.actions.every(action => action.status === 'no-started-experiment'));
  const afterRecovery = (await readAuditRecord(f.store, series.id)).state.trials;
  assert.deepEqual(afterRecovery.map(item => ({ id: item.experimentId, status: item.status })),
    before.map(item => ({ id: item.experimentId, status: item.status })));
  const cleaned = await auditSeriesLifecycle(f.store, series.id, 'clean', { apply: true });
  assert.equal(cleaned.kind, 'audit-series-cleanup');
  assert.equal(cleaned.status, 'cleaned');
  const afterCleanup = (await readAuditRecord(f.store, series.id)).state.trials;
  assert.deepEqual(afterCleanup.map(item => ({ id: item.experimentId, status: item.status })),
    before.map(item => ({ id: item.experimentId, status: item.status })));
});
