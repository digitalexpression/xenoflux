import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRetainedAuditRun } from '../src/audit-replay.js';

const root = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const fingerprint = 'a'.repeat(64);
function fixture() {
  const profile = { profileId: 'default', profileName: 'Default', home: '/fixture/native', executable: '/fixture/codex',
    nativeConfig: { model: 'configured-model', model_reasoning_effort: 'medium', plan_mode_reasoning_effort: 'low', forced_login_method: 'chatgpt' } };
  const baseline = { repository: '/fixture/task', commit: 'abc', tree: 'def' };
  const quality = { id: 'quality', version: '1', checks: [{ name: 'acceptance', required: true }],
    rubric: { id: 'review', version: '1', required: true, criteria: [{ id: 'correctness', label: 'Correctness', maxScore: 4 }] } };
  const spec = { repository: baseline.repository, revision: baseline.commit, task: 'frozen task',
    profiles: [{ name: 'Default', executable: profile.executable, nativeConfig: profile.nativeConfig }],
    setup: [], checks: [{ name: 'acceptance', argv: ['false'] }], limits: { runMs: 100, experimentMs: 100 }, quality };
  const current = { id: 'run', directory: '/fixture/store/audits/run', record: { kind: 'audit-experiment-run', experimentId: 'parent', profile, baseline },
    report: { schemaVersion: 1, kind: 'audit-run', id: 'run', status: 'failed', profile,
      source: { kind: 'native-app-server-v2', threadId: root, workspace: '/fixture/workspace', version: '9.0.0', model: 'startup-model', reasoningEffort: 'high' },
      agents: [{ id: root, parentId: null }], turns: [{ agentId: root, turnId, status: 'completed' }],
      execution: { status: 'exited', exitCode: 0 }, checks: [{ name: 'acceptance', status: 'failed', exitCode: 1 }],
      outcome: { task: { nativeTurnStatus: 'completed' } }, artifacts: [] } };
  const { task, ...savedSpec } = spec;
  const parent = structuredClone({ id: 'parent', record: { kind: 'audit-experiment', baseline: { repository: baseline }, spec: savedSpec, task },
    state: { runs: [{ id: 'run', profileId: 'default' }] } });
  const native = { status: 'ready', source: { nativeSessionId: root, clientVersion: '9.0.0', fingerprint },
    turns: [{ agentId: root, turnId, model: 'actual-model', reasoningEffort: 'low', sourceLine: 8, workspaceMatched: true }],
    actionCoverage: 'partial', actions: [{ kind: 'visible-test', name: 'run-test-file', targets: ['test/visible.test.js'], subjects: [],
      agentId: root, turnId, callId: 'call-test', sourceLine: 10, resultSourceLine: 12, resultIndex: 0, resultScope: 'action', exitCode: 0, sourceFingerprint: fingerprint }] };
  return { current, parent, native, adapters: { read: async () => structuredClone(parent), readNative: async () => structuredClone(native) } };
}

test('retained projection joins exact turn context, keeps control scopes and original check failure, and leaves review pending', async () => {
  const f = fixture(), before = structuredClone(f.current);
  const run = await projectRetainedAuditRun({}, f.current, f.adapters);
  assert.deepEqual(f.current, before);
  assert.equal(run.turns[0].model, 'actual-model');
  assert.equal(run.nativeControls.configured.model, 'configured-model');
  assert.equal(run.nativeControls.startup.model, 'startup-model');
  assert.equal(run.nativeControls.turns[0].sourceLine, 8);
  assert.equal(run.actions[0].callId, 'call-test');
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.checks, before.report.checks);
  assert.equal(run.quality.status, 'failed');
  assert.equal(run.quality.rubric.status, 'pending-review');
  assert.equal(run.reportProjection.nativeSourceFingerprint, fingerprint);
});

test('missing source does not substitute startup/configuration controls or invent named actions', async () => {
  const f = fixture();
  f.adapters.readNative = async () => ({ status: 'not-found', source: {}, turns: [] });
  const run = await projectRetainedAuditRun({}, f.current, f.adapters);
  assert.equal(run.turns[0].model, undefined);
  assert.deepEqual(run.nativeControls.turns, []);
  assert.equal(run.actions, undefined);
  assert.equal(run.reportProjection.native, 'not-found');
  assert.equal(run.quality.rubric.status, 'pending-review');
});

test('foreign thread/version/turn cannot supply controls or action ownership', async () => {
  for (const change of [f => { f.native.source.nativeSessionId = turnId; },
    f => { f.native.source.clientVersion = 'other'; }, f => { f.native.turns[0].turnId = root; }]) {
    const f = fixture(); change(f);
    const run = await projectRetainedAuditRun({}, f.current, f.adapters);
    assert.equal(run.turns[0].model, undefined);
    assert.equal(run.nativeControls.turns.length, 0);
    assert.equal(run.actions?.length ?? 0, 0);
  }
});

test('a changed parent recipe/baseline/profile refuses enrichment before source reads', async () => {
  for (const change of [f => { f.parent.record.baseline.repository.tree = 'changed'; },
    f => { f.parent.state.runs[0].profileId = 'other'; },
    f => { f.parent.record.spec.profiles[0].nativeConfig.model = 'changed'; }]) {
    const f = fixture(); change(f); let reads = 0;
    f.adapters.readNative = async () => { reads++; throw Error('must not read'); };
    const run = await projectRetainedAuditRun({}, f.current, f.adapters);
    assert.equal(run.reportProjection.context, 'unavailable');
    assert.equal(reads, 0);
    assert.equal(run.turns[0].model, undefined);
  }
});

test('recorded condition fingerprints cannot be replaced by a changed parent definition', async () => {
  const f = fixture();
  const initial = await projectRetainedAuditRun({}, f.current, f.adapters);
  f.current.report.comparisonConditions = initial.comparisonConditions;
  f.parent.record.task = 'different task';
  let read = false;
  f.adapters.readNative = async () => { read = true; return f.native; };
  const run = await projectRetainedAuditRun({}, f.current, f.adapters);
  assert.equal(run.reportProjection.context, 'unavailable');
  assert.equal(read, false);
  assert.deepEqual(run.comparisonConditions, initial.comparisonConditions);
});

test('conflicting original turn controls remain unknown instead of being overwritten', async () => {
  const f = fixture();
  f.current.report.turns[0].model = 'contradictory-original-model';
  const run = await projectRetainedAuditRun({}, f.current, f.adapters);
  assert.equal(run.turns[0].model, null);
  assert.equal(run.turns[0].reasoningEffort, null);
  assert.equal(run.reportProjection.native, 'conflicting-turn-controls');
});

test('duplicate turn contexts cannot choose a favorable model or attach action success', async () => {
  const f = fixture();
  f.native.turns.push({ ...f.native.turns[0], model: 'different-model' });
  const run = await projectRetainedAuditRun({}, f.current, f.adapters);
  assert.equal(run.reportProjection.native, 'partial');
  assert.equal(run.turns[0].model, undefined);
  assert.deepEqual(run.nativeControls.turns, []);
  assert.deepEqual(run.actions, []);
});
