import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, chmod, symlink, lstat, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import {
  createExperiment, createExperimentRun, createAuditSeries, createAuditEvaluation, finalizeAuditRecord, inspectAuditReservation,
  readAuditRecord, recordAuditCleanup, recordAuditRecovery, releaseAuditProfileReservation, reserveAuditProfile, writeAuditState,
  writeAuditCaptureCheckpoint,
} from '../src/audit-experiment-store.js';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-store-')));
  await chmod(base, 0o700);
  const directory = join(base, '.xfx'); await mkdir(directory, { mode: 0o700 });
  const home = join(base, 'profile'); await mkdir(home, { mode: 0o700 });
  t.after(() => rm(base, { recursive: true, force: true }));
  return { store: { directory }, home };
}

const uuid = () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function reservationOwner(home, experimentId, storePath, runId = uuid()) {
  return { kind: 'audit-experiment', host: hostname(), pid: process.pid, runId, experimentId,
    storePath, profileId: 'profile-1', home };
}

test('experiment and run state survive reopening by exact UUID and final reports are immutable', async t => {
  const f = await fixture(t);
  const experiment = await createExperiment(f.store, { spec: { profiles: ['A', 'B'] }, task: 'compare task', profiles: [{ id: 'A' }, { id: 'B' }] });
  assert.equal((await readAuditRecord(f.store, experiment.id)).state.status, 'prepared');
  const run = await createExperimentRun(f.store, { experimentId: experiment.id, profile: { id: 'A' } });
  await writeAuditState(f.store, run.id, { status: 'running', pid: process.pid });
  const resumed = await readAuditRecord(f.store, run.id);
  assert.equal(resumed.state.status, 'running');
  assert.equal(resumed.record.experimentId, experiment.id);
  const report = await finalizeAuditRecord(f.store, run.id, { status: 'partial', result: { answer: 42 } });
  assert.equal(report.id, run.id);
  assert.equal(report.kind, 'audit-run');
  const reopened = await readAuditRecord(f.store, run.id);
  assert.equal(reopened.finalized, true);
  assert.deepEqual(reopened.report.result, { answer: 42 });
  const cleanup = await recordAuditCleanup(f.store, run.id, { status: 'cleaned', workspaceRemoved: true });
  assert.equal(cleanup.kind, 'audit-cleanup');
  assert.equal((await readAuditRecord(f.store, run.id)).report.kind, 'audit-run');
  await assert.rejects(recordAuditCleanup(f.store, run.id, { status: 'changed' }), /immutable/);
  const recovery = await recordAuditRecovery(f.store, run.id, { status: 'reconciled', active: false });
  assert.equal(recovery.alreadyRecovered, false);
  const retry = await recordAuditRecovery(f.store, run.id, { status: 'different' });
  assert.equal(retry.alreadyRecovered, true);
  assert.deepEqual(retry.receipt, recovery.receipt);
  assert.deepEqual((await readAuditRecord(f.store, run.id)).recovery, recovery.receipt);
  await assert.rejects(finalizeAuditRecord(f.store, run.id, { status: 'ready' }), /immutable/);
  await assert.rejects(writeAuditState(f.store, run.id, { status: 'failed' }), /immutable/);
});

test('normalized in-memory capture checkpoints persist by run identity and reject identity drift', async t => {
  const f = await fixture(t), experiment = await createExperiment(f.store, { spec: {}, task: 'x', profiles: [] });
  const profileHome = join(f.home, 'native', 'codex-home');
  await mkdir(join(f.home, 'native'), { mode: 0o700 }); await mkdir(profileHome, { mode: 0o700 });
  const runRecord = await createExperimentRun(f.store, { experimentId: experiment.id,
    profile: { id: 'profile-1', home: profileHome } });
  const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const run = { status: 'partial', source: { threadId }, profile: { home: profileHome }, agents: [], events: [] };
  const capture = { status: 'partial', observer: { savedSettingsChanged: false } };
  await writeAuditCaptureCheckpoint(f.store, runRecord.id, { run, capture });
  const saved = await readAuditRecord(f.store, runRecord.id);
  assert.equal(saved.captureCheckpoint.threadId, threadId);
  assert.deepEqual(saved.captureCheckpoint.run, run);
  assert.deepEqual(saved.captureCheckpoint.capture, capture);
  await writeAuditCaptureCheckpoint(f.store, runRecord.id, { run: { ...run, events: [{ type: 'second-snapshot' }] }, capture });
  assert.equal((await readAuditRecord(f.store, runRecord.id)).captureCheckpoint.run.events.length, 1);
  await assert.rejects(writeAuditCaptureCheckpoint(f.store, runRecord.id, {
    run: { ...run, source: { threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }, capture }), /identity changed/);
  await assert.rejects(writeAuditCaptureCheckpoint(f.store, runRecord.id, {
    run: { ...run, profile: { home: f.home } }, capture }), /profile-home identity changed/);
});

test('run creation is linked durably from experiment state', async t => {
  const f = await fixture(t);
  const experiment = await createExperiment(f.store, { spec: {}, task: 'x', profiles: [] });
  const run = await createExperimentRun(f.store, { experimentId: experiment.id, profile: { id: 'profile-1' } });
  const state = (await readAuditRecord(f.store, experiment.id)).state;
  assert.deepEqual(state.runs, [{ id: run.id, profileId: 'profile-1', status: 'prepared' }]);
});

test('series manifest freezes ordered UUID trial slots and preassigned child IDs are exclusive', async t => {
  const f = await fixture(t), trialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const series = await createAuditSeries(f.store, { spec: { task: 'frozen' }, baseline: { commit: 'abc' },
    profiles: [{ id: 'p1', settingsToken: 'hash', env: { PATH: '/bin' } }],
    plan: [{ trialIndex: 0, experimentId: trialId }], recipe: { fingerprint: 'recipe-hash' } });
  const reopened = await readAuditRecord(f.store, series.id);
  assert.equal(reopened.record.kind, 'audit-series');
  assert.equal(reopened.state.kind, 'audit-series-state');
  assert.deepEqual(reopened.state.trials, [{ experimentId: trialId, trialIndex: 0, status: 'not-started' }]);
  const child = await createExperiment(f.store, { id: trialId, series: { id: series.id, trialIndex: 0 }, spec: {}, task: 'frozen', profiles: [] });
  assert.equal(child.id, trialId);
  assert.deepEqual((await readAuditRecord(f.store, trialId)).record.series, { id: series.id, trialIndex: 0 });
  await assert.rejects(createExperiment(f.store, { id: trialId, spec: {}, task: 'rerun', profiles: [] }));
});

test('series and evaluation records require matching report kinds and evaluation is immutable', async t => {
  const f = await fixture(t), series = await createAuditSeries(f.store, { spec: {}, baseline: {}, profiles: [],
    plan: [{ trialIndex: 0, experimentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], recipe: {} });
  await assert.rejects(finalizeAuditRecord(f.store, series.id, { kind: 'audit-run' }), /Expected final report kind audit-series-report/);
  await finalizeAuditRecord(f.store, series.id, { trials: [] });
  const evaluation = await createAuditEvaluation(f.store, { source: { id: series.id, kind: 'audit-series-report' },
    reviews: [{ reviewer: 'local', findings: [] }], report: { status: 'complete', result: { accepted: true } } });
  assert.equal(evaluation.record.kind, 'audit-evaluation');
  assert.equal(evaluation.state.kind, 'audit-evaluation-state');
  assert.equal(evaluation.report.kind, 'audit-evaluation-report');
  assert.deepEqual(evaluation.record.reviews, [{ reviewer: 'local', findings: [] }]);
  await assert.rejects(finalizeAuditRecord(f.store, evaluation.id, { result: 'replacement' }), /immutable/);
  await assert.rejects(writeAuditState(f.store, evaluation.id, { status: 'changed' }), /immutable/);
});

test('record reader rejects mismatched state or unknown manifest kinds', async t => {
  const f = await fixture(t), series = await createAuditSeries(f.store, { spec: {}, baseline: {}, profiles: [],
    plan: [{ trialIndex: 0, experimentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], recipe: {} });
  await writeFile(join(series.directory, 'state.json'), JSON.stringify({ schemaVersion: 1, kind: 'audit-experiment-state', id: series.id }));
  await assert.rejects(readAuditRecord(f.store, series.id), /invalid/);
  await writeFile(join(series.directory, 'state.json'), JSON.stringify({ schemaVersion: 1, kind: 'audit-series-state', id: series.id }));
  await writeFile(join(series.directory, 'series.json'), JSON.stringify({ schemaVersion: 1, kind: 'unknown-kind', id: series.id }));
  await assert.rejects(readAuditRecord(f.store, series.id), /invalid/);
});

test('final report publication is exclusive under concurrent finalizers', async t => {
  const f = await fixture(t);
  const experiment = await createExperiment(f.store, { spec: {}, task: 'x', profiles: [] });
  const results = await Promise.allSettled([
    finalizeAuditRecord(f.store, experiment.id, { winner: 'one' }),
    finalizeAuditRecord(f.store, experiment.id, { winner: 'two' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.ok(['one', 'two'].includes((await readAuditRecord(f.store, experiment.id)).report.winner));
});

test('unsafe IDs, symlink record paths and hard-linked metadata are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(readAuditRecord(f.store, '../escape'), /UUID/);
  const experiment = await createExperiment(f.store, { spec: {}, task: 'x', profiles: [] });
  const original = join(experiment.directory, 'state.json');
  const saved = await readFile(original);
  await rm(original); await symlink(join(f.store.directory, 'not-a-state'), original);
  await assert.rejects(readAuditRecord(f.store, experiment.id));
  await rm(original);
  const outside = join(f.store.directory, 'state-copy'); await writeFile(outside, saved, { mode: 0o600 });
  const { link } = await import('node:fs/promises'); await link(outside, original);
  await assert.rejects(readAuditRecord(f.store, experiment.id), /Unsafe/);
});

test('audit-only home lease blocks a colliding audit owner and releases only its exact owner', async t => {
  const f = await fixture(t), experimentId = uuid(), root = join(f.home, 'native');
  await mkdir(root, { mode: 0o700 });
  const home = join(root, 'codex-home'); await mkdir(home, { mode: 0o700 });
  const owner = reservationOwner(home, experimentId, f.store.directory);
  assert.equal(await inspectAuditReservation({ root, owner }), null);
  const reservation = await reserveAuditProfile({ root, owner });
  assert.equal((await inspectAuditReservation({ root, owner })).runId, owner.runId);
  const foreign = reservationOwner(home, experimentId, f.store.directory, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await assert.rejects(reserveAuditProfile({ root, owner: foreign }), /locked/);
  await assert.rejects(releaseAuditProfileReservation({ root, owner: foreign }), /another operation/);
  assert.equal(await lstat(reservation.lock).then(stat => stat.isDirectory()), true);
  const foreignLock = join(root, '.run-lock'); await mkdir(foreignLock, { mode: 0o700 });
  const nativeOwnerPath = join(foreignLock, 'owner.json');
  await writeFile(nativeOwnerPath, '{"kind":"desktop-instance","pid":999}\n', { mode: 0o600 });
  const before = await readFile(nativeOwnerPath, 'utf8');
  assert.equal(await releaseAuditProfileReservation({ root, owner }), true);
  assert.equal(await inspectAuditReservation({ root, owner }), null);
  assert.equal(await readFile(nativeOwnerPath, 'utf8'), before);
});

test('foreign native reservation is ignored and preserved byte for byte', async t => {
  const f = await fixture(t), lock = join(f.home, '.run-lock');
  await mkdir(lock, { mode: 0o700 });
  const ownerPath = join(lock, 'owner.json');
  const foreign = { kind: 'desktop-instance', host: 'other-host', pid: 999, instanceId: 'keep' };
  await writeFile(ownerPath, JSON.stringify(foreign), { mode: 0o600 });
  const before = await readFile(ownerPath, 'utf8');
  const owner = reservationOwner(f.home, uuid(), f.store.directory);
  const reservation = await reserveAuditProfile({ root: f.home, owner });
  await releaseAuditProfileReservation({ root: f.home, owner });
  assert.equal(await readFile(ownerPath, 'utf8'), before);
  assert.ok(reservation.lock.includes('/audits/leases/'));
});

test('an empty native reservation remains untouched while audit uses its private lease namespace', async t => {
  const f = await fixture(t), lock = join(f.home, '.run-lock');
  await mkdir(lock, { mode: 0o700 });
  const owner = reservationOwner(f.home, uuid(), f.store.directory);
  const reservation = await reserveAuditProfile({ root: f.home, owner });
  assert.equal((await lstat(lock)).isDirectory(), true);
  await assert.rejects(lstat(join(lock, 'owner.json')), { code: 'ENOENT' });
  await releaseAuditProfileReservation({ root: f.home, owner });
  assert.ok(reservation.lock.includes('/audits/leases/'));
});

test('malformed native reservation metadata is never read or changed by an audit lease', async t => {
  const f = await fixture(t), lock = join(f.home, '.run-lock');
  await mkdir(lock, { mode: 0o700 });
  const ownerPath = join(lock, 'owner.json');
  await writeFile(ownerPath, '{broken', { mode: 0o600 });
  const before = await readFile(ownerPath, 'utf8');
  const owner = reservationOwner(f.home, uuid(), f.store.directory);
  assert.equal(await inspectAuditReservation({ root: f.home, owner }), null);
  await reserveAuditProfile({ root: f.home, owner });
  await releaseAuditProfileReservation({ root: f.home, owner });
  assert.equal(await readFile(ownerPath, 'utf8'), before);
  assert.equal((await lstat(lock)).isDirectory(), true);
});

test('a canonical owned 0755 default home supports an audit lease without changing source mode or native lock', async t => {
  const f = await fixture(t), defaultHome = join(f.home, 'default-codex');
  await mkdir(defaultHome, { mode: 0o755 }); await chmod(defaultHome, 0o755);
  const nativeLock = join(defaultHome, '.run-lock'); await mkdir(nativeLock, { mode: 0o700 });
  const nativeOwner = join(nativeLock, 'owner.json');
  await writeFile(nativeOwner, '{"kind":"running-desktop-client","pid":123}\n', { mode: 0o600 });
  const bytes = await readFile(nativeOwner, 'utf8'), owner = reservationOwner(defaultHome, uuid(), f.store.directory);
  assert.equal(await inspectAuditReservation({ root: defaultHome, owner }), null);
  const lease = await reserveAuditProfile({ root: defaultHome, owner });
  assert.equal((await inspectAuditReservation({ root: defaultHome, owner })).runId, owner.runId);
  await releaseAuditProfileReservation({ root: defaultHome, owner });
  assert.equal((await lstat(defaultHome)).mode & 0o777, 0o755);
  assert.equal(await readFile(nativeOwner, 'utf8'), bytes);
  assert.ok(lease.lock.includes('/audits/leases/'));
});

test('a non-private 0755 named-profile native root remains rejected', async t => {
  const f = await fixture(t), root = join(f.home, 'named-native');
  await mkdir(root, { mode: 0o755 }); await chmod(root, 0o755);
  const home = join(root, 'codex-home'); await mkdir(home, { mode: 0o700 });
  const owner = reservationOwner(home, uuid(), f.store.directory);
  await assert.rejects(reserveAuditProfile({ root, owner }), /private directory/);
  await assert.rejects(inspectAuditReservation({ root, owner }), /private directory/);
});
