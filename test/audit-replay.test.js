import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveRetainedAuditRun, joinRetainedNativeTurnEvidence, projectRetainedAuditRun } from '../src/audit-replay.js';
import { buildAuditExplanation, freezeAuditComparisonEvidence } from '../src/audit-explanation.js';
import { buildAuditComparisonConditions } from '../src/audit-conditions.js';

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
    taskContract: { id: 'named-files', editableFiles: ['README.md'] },
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

test('foreign thread or turn cannot supply controls or action ownership', async () => {
  for (const change of [f => { f.native.source.nativeSessionId = turnId; },
    f => { f.native.turns[0].turnId = root; }]) {
    const f = fixture(); change(f);
    const run = await projectRetainedAuditRun({}, f.current, f.adapters);
    assert.equal(run.turns[0].model, undefined);
    assert.equal(run.nativeControls.turns.length, 0);
    assert.equal(run.actions?.length ?? 0, 0);
  }
});

test('provider version drift alone does not block exact session and turn evidence', async () => {
  const f = fixture(); f.native.source.clientVersion = 'different-provider-release';
  const run = await projectRetainedAuditRun({}, f.current, f.adapters);
  assert.equal(run.turns[0].model, 'actual-model');
  assert.equal(run.nativeControls.turns[0].source, 'turn_context');
  assert.equal(run.reportProjection.nativeSourceFingerprint, fingerprint);
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

test('opt-in replay does not backfill an unfrozen report from later native history', async () => {
  const f = fixture(), before = structuredClone(f.current);
  f.native.sessionReplay = { schemaVersion: 1, kind: 'session-replay', sessions: [{ id: root, parentId: null,
    status: 'ready', source: { fingerprint }, limits: [], events: [] }] };
  const without = await projectRetainedAuditRun({}, f.current, f.adapters);
  assert.equal(without.sessionReplay, undefined);
  let requested;
  const withReplay = await projectRetainedAuditRun({}, f.current, { ...f.adapters, includeReplay: true,
    readNative: async (profile, id, options) => { requested = options.includeReplay; return f.native; } });
  assert.equal(requested, true);
  assert.equal(withReplay.sessionReplay.sessions[0].id, root);
  assert.ok(withReplay.sessionReplay.sessions[0].limits.some(limit => limit.kind === 'source-unavailable'
    && /no frozen replay capture boundary/.test(limit.message)));
  assert.deepEqual(f.native.sessionReplay.sessions[0].limits, []);
  assert.deepEqual(f.current, before);
  f.native.source.nativeSessionId = turnId;
  const unavailable = await projectRetainedAuditRun({}, f.current, { ...f.adapters, includeReplay: true });
  assert.equal(unavailable.sessionReplay.sessions[0].status, 'unavailable');
  assert.deepEqual(unavailable.sessionReplay.sessions[0].events, []);
});

test('finalized replay keeps all normalized report evidence fixed as native history grows or disappears', async () => {
  let stableConditions;
  for (const sourceChange of ['grown', 'deleted']) {
    const f = fixture();
    f.current.report = { ...f.current.report,
      turns: [{ agentId: root, turnId, model: 'captured-model', reasoningEffort: 'low' }],
      nativeControls: { configured: { model: 'captured-config' }, startup: { model: 'captured-startup' }, turns: [] },
      actions: [{ kind: 'visible-test', name: 'captured-action', callId: 'captured-call' }],
      actionCoverage: 'partial',
      comparisonEvidence: { fingerprint: 'captured-evidence' },
      quality: { status: 'captured-quality' },
      sessionReplay: { schemaVersion: 1, kind: 'session-replay', sessions: [{ id: root,
        parentId: null, depth: 0, status: 'ready', source: { fingerprint }, events: [{ id: 'captured-event', body: 'captured' }], limits: [] }] },
      replayCapture: { status: 'ready', boundary: 'finalized-native-history-snapshot', sourceFingerprint: fingerprint } };
    const checkpointArtifact = { kind: 'recorded-file-change', path: 'README.md', status: 'modified',
      agentId: root, turnId, sourceLine: 22 };
    f.current.captureCheckpoint = { threadId: root, profileHome: '/fixture/native', run: {
      source: { threadId: root }, artifacts: [checkpointArtifact,
        { ...checkpointArtifact, path: 'unowned.txt', turnId: 'unowned-turn' }] } };
    const capturedEvidence = structuredClone(f.current.report);
    let reads = 0;
    f.adapters.readNative = async () => {
      reads++;
      if (sourceChange === 'deleted') throw Error('native history disappeared');
      return { ...f.native,
        turns: [{ ...f.native.turns[0], model: 'later-model' }],
        actions: [{ ...f.native.actions[0], callId: 'later-call' }],
        sessionReplay: { schemaVersion: 1, kind: 'session-replay', sessions: [{ id: root,
          parentId: null, depth: 0, status: 'ready', source: { fingerprint }, events: [{ id: 'later-event' }], limits: [] }] } };
    };
    const withoutReplay = await projectRetainedAuditRun({}, f.current, f.adapters);
    assert.equal(withoutReplay.sessionReplay, undefined);
    assert.deepEqual(withoutReplay.turns, capturedEvidence.turns);
    assert.equal(reads, 0);
    const projected = await projectRetainedAuditRun({}, f.current, { ...f.adapters, includeReplay: true });
    assert.equal(reads, 0, `${sourceChange}: finalized report must not reopen native source`);
    assert.deepEqual(projected.comparisonConditions, withoutReplay.comparisonConditions);
    if (stableConditions) assert.deepEqual(projected.comparisonConditions, stableConditions);
    else stableConditions = projected.comparisonConditions;
    for (const key of ['turns', 'nativeControls', 'actions', 'actionCoverage', 'quality', 'sessionReplay', 'replayCapture']) {
      assert.deepEqual(projected[key], capturedEvidence[key], `${sourceChange}: ${key} remains at capture boundary`);
    }
    assert.equal(projected.comparisonEvidence, undefined);
    assert.deepEqual(projected.comparisonConditions.editableFiles, ['README.md']);
    assert.deepEqual(projected.artifacts, [checkpointArtifact]);
    assert.equal(projected.reportProjection.native, 'frozen');
    assert.equal(projected.reportProjection.sourceAttestation, 'finalized-native-history-snapshot');
    const evidence = freezeAuditComparisonEvidence(projected);
    assert.deepEqual(evidence.conditions.editableFiles, ['README.md']);
    const counterpart = { ...structuredClone(projected), id: 'other-run' };
    assert.equal(buildAuditExplanation(projected, counterpart).findings.find(finding => finding.rule === 'editable-file-boundary').classification, 'similar');
  }
});

test('an inherited executable can reopen exact retained evidence while a refused join preserves the frozen core', async () => {
  const f = fixture();
  delete f.parent.record.spec.profiles[0].executable;
  f.current.report.comparisonEvidence = freezeAuditComparisonEvidence(f.current.report);
  const projected = await projectRetainedAuditRun({}, f.current, f.adapters);
  assert.equal(projected.reportProjection.context, 'verified');
  assert.equal(freezeAuditComparisonEvidence(projected).verification.nativeCompletion, 'completed');

  f.current.record.profile = { ...f.current.record.profile, executable: '/fixture/different' };
  let reads = 0;
  const refused = await projectRetainedAuditRun({}, f.current, { ...f.adapters, readNative: async () => { reads++; } });
  assert.equal(reads, 0);
  assert.equal(refused.reportProjection.context, 'unavailable');
  assert.deepEqual(refused.comparisonEvidence, f.current.report.comparisonEvidence);
  assert.equal(freezeAuditComparisonEvidence(refused).verification.nativeCompletion, 'completed');
});

function frozenFixture() {
  const f = fixture();
  f.current.report.comparisonConditions = buildAuditComparisonConditions({
    spec: { ...f.parent.record.spec, task: f.parent.record.task }, baseline: f.current.record.baseline,
    profile: f.parent.record.spec.profiles[0], profileOrder: ['Default'], trialIndex: null });
  const event = { id: `${root}:${fingerprint}:8`, sessionId: root, turnId, sourceLine: 8,
    kind: 'message', label: 'Assistant message', role: 'assistant', timestamp: null,
    body: null, bodyStatus: 'omitted', bodyReason: 'content-not-selected', bodyBytes: 12 };
  f.current.report.sessionReplay = { schemaVersion: 1, kind: 'session-replay', sessions: [{ id: root,
    parentId: null, depth: 0, status: 'ready', source: { fingerprint }, events: [event], limits: [
      { kind: 'capture-boundary', message: 'Frozen at the original completion.' },
      { kind: 'unprojected-records', message: 'Old unsupported, streaming metadata, or private reasoning.' },
    ] }] };
  f.current.report.replayCapture = { status: 'ready', boundary: 'finalized-native-history-snapshot', sourceFingerprint: fingerprint };
  f.current.report.coverage = { agents: 'complete', usage: 'complete', workspaceDiff: 'complete', skills: 'partial' };
  f.current.report.settingsEvidence = { requested: { model: 'request-model' }, confirmed: { model: 'startup-model' } };
  f.native.sessionReplay = structuredClone(f.current.report.sessionReplay);
  f.native.sessionReplay.sessions[0].events = [{ ...event, label: 'Reinterpreted assistant message',
    body: 'kept private', bodyStatus: 'included', bodyReason: undefined }];
  f.native.sessionReplay.sessions[0].limits = [{ kind: 'unprojected-records', message: 'Metadata records are outside conversation replay.' }];
  f.current.report.comparisonEvidence = freezeAuditComparisonEvidence(f.current.report);
  const originalReportFingerprint = createHash('sha256').update(JSON.stringify(f.current.report)).digest('hex');
  return { ...f, originalReportFingerprint };
}

test('explicit derived evidence keeps owned receipts and source omissions while joining exact frozen native turns', async () => {
  const f = frozenFixture(), before = structuredClone(f.current);
  const run = await deriveRetainedAuditRun({}, f.current, { native: f.native,
    originalReportFingerprint: f.originalReportFingerprint, read: f.adapters.read });
  assert.deepEqual(f.current, before);
  assert.equal(run.turns[0].model, 'actual-model');
  assert.equal(run.turns[0].reasoningEffort, 'low');
  assert.equal(run.turns[0].status, 'completed');
  assert.equal(run.nativeControls.turns[0].sourceLine, 8);
  assert.equal(run.nativeControls.turns[0].sourceFingerprint, fingerprint);
  assert.deepEqual(run.coverage, before.report.coverage);
  assert.deepEqual(run.settingsEvidence, before.report.settingsEvidence);
  assert.deepEqual(run.execution, before.report.execution);
  assert.deepEqual(run.checks, before.report.checks);
  assert.equal(run.sessionReplay.sessions[0].events[0].label, 'Reinterpreted assistant message');
  assert.equal(run.sessionReplay.sessions[0].events[0].body, null);
  assert.equal(run.sessionReplay.sessions[0].events[0].bodyStatus, 'omitted');
  assert.equal(run.sessionReplay.sessions[0].events[0].bodyReason, 'content-not-selected');
  assert.deepEqual(run.sessionReplay.sessions[0].limits, [
    { kind: 'capture-boundary', message: 'Frozen at the original completion.' },
    { kind: 'unprojected-records', message: 'Metadata records are outside conversation replay.' },
  ]);
  assert.match(before.report.sessionReplay.sessions[0].limits[1].message, /Old unsupported/);
  assert.equal(run.reportProjection.originalReportFingerprint, f.originalReportFingerprint);
  assert.equal(run.reportProjection.nativeSourceFingerprint, fingerprint);
  assert.equal(run.comparisonEvidence, undefined);
  assert.equal(freezeAuditComparisonEvidence(run).status, 'recorded');
});

test('derived evidence refuses changed original reports, native bytes, actors and child source bindings', async () => {
  const child = '33333333-3333-4333-8333-333333333333';
  for (const change of [f => { f.current.report.status = 'changed'; },
    f => { f.native.source.fingerprint = 'b'.repeat(64); },
    f => { f.native.source.nativeSessionId = child; },
    f => { f.native.sessionReplay.sessions[0].source.fingerprint = 'b'.repeat(64); },
    f => { f.native.sessionReplay.sessions.push({ ...f.native.sessionReplay.sessions[0], id: child, parentId: root }); },
    f => { f.parent.record.task = 'changed task'; }]) {
    const f = frozenFixture(); change(f);
    await assert.rejects(deriveRetainedAuditRun({}, f.current, { native: f.native,
      originalReportFingerprint: f.originalReportFingerprint, read: f.adapters.read }));
  }
});

test('native turn evidence requires exact owned actor, turn and workspace identity', () => {
  const child = '33333333-3333-4333-8333-333333333333';
  const childTurn = '44444444-4444-4444-8444-444444444444';
  const f = fixture();
  f.current.report.agents.push({ id: child, parentId: root });
  f.current.report.turns.push({ agentId: child, turnId: childTurn });
  f.native.agents = [{ id: child, parentId: root, status: 'ready', source: { fingerprint: 'b'.repeat(64) } }];
  f.native.turns.push({ agentId: child, turnId: childTurn, model: 'child-model', reasoningEffort: 'medium',
    sourceLine: 9, workspaceMatched: true, status: 'completed' });
  const joined = joinRetainedNativeTurnEvidence(f.current.report, f.native, f.current.record.profile);
  assert.equal(joined.fields.turns[1].model, 'child-model');
  assert.equal(joined.fields.turns[1].status, 'completed');
  assert.equal(joined.fields.nativeControls.turns[1].sourceFingerprint, 'b'.repeat(64));
  for (const change of [n => { n.turns[1].workspaceMatched = null; },
    n => { n.turns[1].turnId = root; }, n => { n.agents[0].parentId = child; },
    n => { n.agents[0].status = 'unavailable'; }, n => { n.turns.push({ ...n.turns[1] }); }]) {
    const native = structuredClone(f.native); change(native);
    const refused = joinRetainedNativeTurnEvidence(f.current.report, native, f.current.record.profile);
    assert.equal(refused.fields.turns[1].model, undefined);
    assert.equal(refused.fields.nativeControls.turns.some(turn => turn.agentId === child), false);
  }
});

test('partial native fields keep independently captured turn settings without inventing a combined native proof', () => {
  const f = fixture();
  f.current.report.turns[0].model = 'captured-model';
  f.native.turns[0].model = null;
  const joined = joinRetainedNativeTurnEvidence(f.current.report, f.native, f.current.record.profile);
  assert.equal(joined.fields.turns[0].model, 'captured-model');
  assert.equal(joined.fields.turns[0].reasoningEffort, 'low');
  assert.deepEqual(joined.fields.nativeControls.turns, []);
  assert.equal(freezeAuditComparisonEvidence({ ...f.current.report, ...joined.fields }).status, 'recorded');
});
