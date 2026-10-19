import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createAuditSeries, readAuditRecord, writeAuditState } from '../src/audit-experiment-store.js';
import { auditQualityFingerprint } from '../src/audit-quality.js';
import { validateAuditSpec } from '../src/audit-spec.js';
import { resumeAuditSeries } from '../src/audit-series.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-series-lock-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = { directory: join(root, '.xfx') };
  await mkdir(store.directory, { mode: 0o700 });
  const baseline = { repository: '/tmp/fixture-repository', commit: '0123456789abcdef', tree: 'abcdef0123456789' };
  const checks = [{ name: 'smoke', argv: ['true'], timeoutMs: 1000 }];
  const spec = { schemaVersion: 1, repository: baseline.repository, revision: baseline.commit,
    task: 'Fixture task', profiles: ['Alpha', 'Beta'].map((name, index) => ({ name,
      executable: `/tmp/codex-${name.toLowerCase()}`, version: '1.2.3', skills: [] })),
    limits: { runMs: 1000, experimentMs: 5000, outputBytes: 1024, maxRuns: 2 }, setup: [], checks,
    sandbox: 'read-only', allowIncompleteCapture: true,
    quality: { schemaVersion: 1, id: 'fixture-quality', version: '1', checks: [{ name: 'smoke', required: true }] },
    trials: { count: 1, order: 'balanced', budgetMs: 5000 }, variables: [] };
  const frozenSpec = validateAuditSpec(spec);
  const profiles = spec.profiles.map((selection, index) => ({ profileId: `profile-${index}`, profileName: selection.name,
    home: `/tmp/home-${index}`, userHome: `/tmp/user-home-${index}`, nativeRoot: `/tmp/native-${index}`,
    environmentId: null, executable: selection.executable, executableIdentity: `exe-${index}`, version: selection.version,
    bindingRepository: baseline.repository, env: {}, settingsIdentity: { algorithm: 'fixture', digest: `settings-${index}` } }));
  const childId = uuid(2), plan = [{ index: 1, trialIndex: 0, experimentId: childId, profileOrder: ['Alpha', 'Beta'], budgetMs: 5000 }];
  const recipe = { fingerprint: digest({ spec: { ...frozenSpec, revision: baseline.commit }, baseline: {
    repository: baseline.repository, commit: baseline.commit, tree: baseline.tree }, profiles, plan }),
  qualityFingerprint: auditQualityFingerprint(frozenSpec.quality, frozenSpec.checks), criteria: frozenSpec.quality,
  meta: { adapterVersion: 1, taskFingerprint: digest(frozenSpec.task), checkRecipes: frozenSpec.checks.map(check => ({ name: check.name,
    fingerprint: digest(check) })), variables: frozenSpec.variables, order: frozenSpec.trials.order, trialCount: frozenSpec.trials.count,
    taskBudgetMs: frozenSpec.trials.budgetMs,
    checkSemantics: 'Command exits 0 for a declared pass; this is evidence for its frozen named criterion.',
    cachePolicy: 'No cache reset; source settings metadata and observed model/tool/skill differences are reported, not causal controls.' } };
  const current = await createAuditSeries(store, { spec: frozenSpec, baseline, profiles,
    plan, recipe });
  await writeAuditState(store, current.id, { coordinatorReleased: true });
  return { store, current: await readAuditRecord(store, current.id), childId };
}

async function writeCoordinator(path, owner) {
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, 'owner.json'), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

function staleOwner(store, seriesId) {
  return { kind: 'audit-series', seriesId, storePath: store.directory, runId: uuid(10),
    pid: 987654, host: hostname(), processIdentity: { pid: 987654, host: hostname(), started: true } };
}

test('concurrent resumes cannot retire the same stale generation or replace the new owner', async t => {
  const f = await fixture(t), path = join(f.current.directory, '.coordinator-lock'), stale = staleOwner(f.store, f.current.id);
  await writeCoordinator(path, stale);
  let secondSawStale;
  const secondObserved = new Promise(resolve => { secondSawStale = resolve; });
  let releaseSecondObserver;
  const secondGate = new Promise(resolve => { releaseSecondObserver = resolve; });
  let observeCount = 0, resolverCalls = 0, tasks = 0, releaseFirstResolver, firstResolverEntered;
  const firstResolverGate = new Promise(resolve => { releaseFirstResolver = resolve; });
  const firstResolverAtGate = new Promise(resolve => { firstResolverEntered = resolve; });
  const context = {
    observeProcess: async identity => {
      observeCount++;
      assert.equal(identity.pid, stale.pid);
      if (observeCount === 1) { secondSawStale(); await secondGate; }
      return { status: 'stopped' };
    },
    resolveProfile: async (_store, selection) => {
      resolverCalls++;
      if (resolverCalls === 1) { firstResolverEntered(); await firstResolverGate; }
      const profile = f.current.record.profiles.find(item => item.profileName === selection.name);
      return { ...profile, env: {} };
    },
    snapshotSettings: async profile => ({ status: 'ready', index: profile.profileName === 'Alpha' ? 0 : 1 }),
    settingsIdentity: snapshot => snapshot.status === 'ready'
      ? { algorithm: 'fixture', digest: `settings-${snapshot.index}` } : null,
    runTrial: async (_store, _spec, options) => {
      tasks++;
      return { schemaVersion: 1, kind: 'audit-experiment-report', id: options.experimentId,
        status: 'complete', runs: [] };
    },
  };

  // The losing resume observes stale generation S and pauses before retiring it.
  const second = resumeAuditSeries(f.store, f.current.id, context);
  await secondObserved;
  // The winner observes S, retires it and claims A, then pauses after claim.
  const first = resumeAuditSeries(f.store, f.current.id, context);
  await firstResolverAtGate;
  const acquired = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
  assert.notEqual(acquired.runId, stale.runId);

  // Release the loser, which had already observed S. Its deterministic
  // tombstone is occupied, so it must leave A in place and start no task.
  releaseSecondObserver();
  const secondResult = await second;
  assert.equal(secondResult.status, 'blocked');
  assert.equal(tasks, 0);
  assert.deepEqual(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')), acquired);
  await lstat(`${path}.retired-${stale.runId}`);
  releaseFirstResolver();
  const firstResult = await first;
  assert.equal(tasks, 1);
  assert.ok(['complete', 'partial'].includes(firstResult.status));
});

test('live and uncertain series coordinator owners block resume without starting tasks', async t => {
  for (const status of ['live', 'unknown']) {
    const f = await fixture(t), path = join(f.current.directory, '.coordinator-lock'), owner = staleOwner(f.store, f.current.id);
    await writeCoordinator(path, owner);
    let tasks = 0;
    const result = await resumeAuditSeries(f.store, f.current.id, {
      observeProcess: async () => ({ status }), runTrial: async () => { tasks++; },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(tasks, 0);
    assert.deepEqual(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')), owner);
  }
});
