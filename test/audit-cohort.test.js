import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/profiles.js';
import { createAuditCohort, validateAuditCohortSpec } from '../src/audit-cohort.js';
import { compareAuditRuns } from '../src/audit-report.js';
import { readAuditRecord } from '../src/audit-experiment-store.js';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-cohort-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'store'); await mkdir(directory, { mode: 0o700 });
  return { root, store: new Store(directory), specPath: join(root, 'cohort.json') };
}

function run(profile, id, status = 'complete', profileId = `profile-${profile}`, runId = `run-${id}`) {
  return { schemaVersion: 1, kind: 'audit-run', id: runId, status,
    profile: { profileId, profileName: profile },
    source: { kind: 'native-rollout', provider: 'codex', client: 'cli', nativeSessionId: id },
    turns: [{ agentId: `agent-${id}`, turnId: `turn-${id}`, status: 'completed' }],
    events: [], actions: [], checks: [{ name: 'contract', status: 'passed', exitCode: 0, recipeFingerprint: 'recipe-a' }],
    usage: { totals: null }, metrics: { processElapsedMs: 12 }, execution: { status: 'exited', exitCode: 0 },
    outcome: { status: 'completed' }, coverage: { source: 'complete' }, warnings: [] };
}

async function writeSpec(path, value) { await writeFile(path, JSON.stringify(value), { mode: 0o600 }); }
const pair = (leftId, rightId) => ({ left: { profile: 'Alpha', id: leftId }, right: { profile: 'Beta', id: rightId } });

test('selected native sessions persist as a repeated cohort with unknown planned denominator', async t => {
  const f = await fixture(t);
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', sameTask: 'support-ticket-17', variables: ['model'],
    pairs: [pair(ids[0], ids[1]), pair(ids[2], ids[3])] });
  const value = await createAuditCohort(f.store, f.specPath, { readNative: async (_store, profile, id) => run(profile, id) });
  assert.equal(value.kind, 'audit-series-report');
  assert.equal(value.cohort.source, 'selected-existing-sessions');
  assert.equal(value.cohort.selectedPairCount, 2);
  assert.equal(value.cohort.plannedPairCount, null);
  assert.equal(value.trials.length, 2);
  assert.equal(value.trials[0].selection.declaration.taskId, 'support-ticket-17');
  assert.deepEqual(value.trials[0].selection.declaredVariables, ['model']);
  const saved = await readAuditRecord(f.store, value.id);
  assert.equal(saved.finalized, true);
  assert.equal(saved.record.spec.kind, 'audit-cohort');
  assert.equal(saved.report.cohort.plannedPairCount, null);
});

test('failed, missing and unavailable selections remain explicit cohort slots', async t => {
  const f = await fixture(t);
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    pair(ids[0], ids[1]), pair(ids[2], ids[3]),
  ] });
  const value = await createAuditCohort(f.store, f.specPath, { readNative: async (_store, profile, id) => {
    if (id === ids[2]) throw new Error('fixture read failure');
    return run(profile, id, id === ids[3] ? 'failed' : 'complete');
  } });
  assert.equal(value.trials.length, 2);
  assert.equal(value.trials[1].profiles[0].status, 'unavailable');
  assert.match(value.trials[1].profiles[0].reason, /could not be read safely/);
  assert.equal(value.trials[1].selection.requested.left.id, ids[2]);
  assert.equal(value.trials[1].profiles[1].status, 'failed');
  assert.equal(value.cohort.selectedPairCount, 2);
  assert.equal(value.cohort.plannedPairCount, null);
});

test('schema and explicit native duplicate errors happen before any session read', async t => {
  const f = await fixture(t), duplicate = { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    pair(ids[0], ids[1]), pair(ids[0], ids[3]),
  ] };
  await writeSpec(f.specPath, duplicate);
  let reads = 0;
  await assert.rejects(createAuditCohort(f.store, f.specPath, { readNative: async () => { reads++; } }), /may appear only once/);
  assert.equal(reads, 0);
  assert.throws(() => validateAuditCohortSpec({ schemaVersion: 1, kind: 'audit-cohort', extra: true, pairs: [pair(ids[0], ids[1])] }), /unsupported/);
});

test('a native profile/session cannot be repeated through distinct source declarations', async t => {
  const f = await fixture(t);
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    pair(ids[0], ids[1]), pair(ids[2], ids[3]),
  ] });
  await assert.rejects(createAuditCohort(f.store, f.specPath, { readNative: async (_store, profile, id) =>
    run(profile === 'Alpha' && id === ids[2] ? 'Alpha' : profile, id === ids[2] ? ids[0] : id) }), /underlying profile\/session/);
});

test('frozen run reports resolve relative to the spec and form a replayable cohort', async t => {
  const f = await fixture(t);
  const leftA = run('Alpha', ids[0]), rightA = run('Beta', ids[1]);
  const leftB = run('Alpha', ids[2]), rightB = run('Beta', ids[3]);
  for (const [name, value] of [['left-a.json', leftA], ['right-a.json', rightA], ['left-b.json', leftB], ['right-b.json', rightB]])
    await writeFile(join(f.root, name), JSON.stringify(value), { mode: 0o600 });
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', variables: ['model'], pairs: [
    { left: { report: 'left-a.json' }, right: { report: 'right-a.json' } },
    { left: { report: 'left-b.json' }, right: { report: 'right-b.json' } },
  ] });
  const value = await createAuditCohort(f.store, f.specPath);
  assert.equal(value.trials.length, 2);
  assert.equal(value.trials[0].profiles[0].run.source.nativeSessionId, ids[0]);
  assert.equal(value.trials[1].profiles[1].run.source.nativeSessionId, ids[3]);
  assert.deepEqual(value.trials[0].selection.declaredVariables, ['model']);
  assert.equal(value.cohort.plannedPairCount, null);
  const replay = await readAuditRecord(f.store, value.id);
  assert.equal(replay.report.trials.length, 2);
  assert.equal(replay.report.trials[0].profiles[0].run.source.nativeSessionId, ids[0]);
});

test('frozen comparison reports are retained as selected cohort pairs', async t => {
  const f = await fixture(t), reports = [];
  for (const [index, idsForPair] of [ids.slice(0, 2), ids.slice(2, 4)].entries()) {
    const comparison = compareAuditRuns(run('Alpha', idsForPair[0]), run('Beta', idsForPair[1]), {
      taskAssociation: { status: 'user-declared', taskId: 'fixture-task' }, declaredVariables: ['model'],
    });
    const path = `comparison-${index}.json`;
    await writeFile(join(f.root, path), JSON.stringify(comparison), { mode: 0o600 });
    reports.push({ comparison: path });
  }
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: reports });
  const value = await createAuditCohort(f.store, f.specPath);
  assert.equal(value.trials.length, 2);
  assert.deepEqual(value.trials[0].selection.declaredVariables, ['model']);
  assert.equal(value.trials[0].selection.taskAssociation.status, 'user-declared');
  assert.equal(value.trials[0].profiles[0].run.source.nativeSessionId, ids[0]);
});

test('same profile arms and reused frozen run UUIDs are rejected', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'run.json'), JSON.stringify(run('Alpha', ids[0])), { mode: 0o600 });
  await writeFile(join(f.root, 'other.json'), JSON.stringify(run('Beta', ids[1])), { mode: 0o600 });
  await writeFile(join(f.root, 'other-2.json'), JSON.stringify(run('Beta', ids[3])), { mode: 0o600 });
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    { left: { report: 'run.json' }, right: { report: 'other.json' } },
    { left: { report: 'run.json' }, right: { report: 'other-2.json' } },
  ] });
  await assert.rejects(createAuditCohort(f.store, f.specPath), /underlying profile\/session/);
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    { left: { report: 'run.json' }, right: { report: 'other.json' } },
    { left: { report: 'run.json' }, right: { report: 'other-2.json' } },
  ] });
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    { left: { profile: 'Alpha', id: ids[0] }, right: { profile: 'Alpha', id: ids[1] } },
  ] });
  await assert.rejects(createAuditCohort(f.store, f.specPath, { readNative: async (_store, profile, id) => run(profile, id) }), /two distinct stable profile/);
});

test('missing frozen run report stays an explicit unavailable slot', async t => {
  const f = await fixture(t);
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    { left: { report: 'does-not-exist.json' }, right: { report: 'also-missing.json' } },
  ] });
  const value = await createAuditCohort(f.store, f.specPath);
  assert.equal(value.trials.length, 1);
  assert.equal(value.trials[0].profiles[0].status, 'partial');
  assert.equal(value.trials[0].selection.requested.left.kind, 'frozen-report');
});

test('same-name profile arms retain distinct profile IDs in the cohort', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'default-left.json'), JSON.stringify(run('Default', ids[0], 'complete', 'default-left-id')), { mode: 0o600 });
  await writeFile(join(f.root, 'default-right.json'), JSON.stringify(run('Default', ids[1], 'complete', 'default-right-id')), { mode: 0o600 });
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    { left: { report: 'default-left.json' }, right: { report: 'default-right.json' } },
  ] });
  const value = await createAuditCohort(f.store, f.specPath);
  assert.equal(value.profiles[0].profileId, 'default-left-id');
  assert.equal(value.profiles[1].profileId, 'default-right-id');
  assert.equal(value.trials[0].profiles[0].run.profileId, 'default-left-id');
  assert.equal(value.trials[0].profiles[1].run.profileId, 'default-right-id');
});

test('same-name owners with the same native session UUID remain distinct by profile ID', async t => {
  const f = await fixture(t), sharedSessionId = ids[0];
  await writeFile(join(f.root, 'owner-left.json'), JSON.stringify(run('Default', sharedSessionId, 'complete', 'owner-left', 'run-owner-left')), { mode: 0o600 });
  await writeFile(join(f.root, 'owner-right.json'), JSON.stringify(run('Default', sharedSessionId, 'complete', 'owner-right', 'run-owner-right')), { mode: 0o600 });
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    { left: { report: 'owner-left.json' }, right: { report: 'owner-right.json' } },
  ] });
  const value = await createAuditCohort(f.store, f.specPath);
  assert.equal(value.trials[0].profiles[0].run.profileId, 'owner-left');
  assert.equal(value.trials[0].profiles[1].run.profileId, 'owner-right');
});

test('an unavailable first slot does not erase the later known arm identity', async t => {
  const f = await fixture(t);
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    pair(ids[0], ids[1]), pair(ids[2], ids[3]),
  ] });
  const value = await createAuditCohort(f.store, f.specPath, { readNative: async (_store, profile, id) => {
    if (id === ids[0]) throw new Error('session unavailable before profile identity was observed');
    return run(profile === 'Alpha' ? 'Default' : 'Other', id,
      'complete', profile === 'Alpha' ? 'default-known-id' : 'other-known-id');
  } });
  assert.equal(value.profiles[0].profileName, 'Default');
  assert.equal(value.profiles[0].profileId, 'default-known-id');
  assert.equal(value.profiles[1].profileName, 'Other');
  assert.equal(value.profiles[1].profileId, 'other-known-id');
  assert.equal(value.trials[1].profiles[0].run.profileId, 'default-known-id');
  assert.equal(value.trials[0].profiles[0].status, 'unavailable');
  assert.match(value.trials[0].profiles[0].reason, /could not be read safely/);
});

test('a missing side keeps unavailable status and reason after its stable profile ID is known', async t => {
  const f = await fixture(t);
  await writeSpec(f.specPath, { schemaVersion: 1, kind: 'audit-cohort', pairs: [
    pair(ids[0], ids[1]), pair(ids[2], ids[3]),
  ] });
  const value = await createAuditCohort(f.store, f.specPath, { readNative: async (_store, profile, id) => {
    if (id === ids[2]) throw new Error('fixture unavailable');
    return run(profile, id, 'complete', profile === 'Alpha' ? 'stable-left-id' : 'stable-right-id');
  } });
  assert.equal(value.trials[1].profiles.find(row => row.profileId === 'stable-left-id').status, 'unavailable');
  assert.match(value.trials[1].profiles.find(row => row.profileId === 'stable-left-id').reason, /could not be read safely/);
  assert.equal(value.trials[1].profiles.find(row => row.profileId === 'stable-left-id').run, null);
});
