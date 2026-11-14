import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureFrozenSessionReplay } from '../src/audit-runner.js';
import { projectRetainedAuditRun } from '../src/audit-replay.js';
import { createExperiment, createExperimentRun, finalizeAuditRecord, readAuditRecord } from '../src/audit-experiment-store.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
import { auditRetainedNativeSession } from '../src/audit-session.js';

const root = '11111111-1111-4111-8111-111111111111';
const child = '33333333-3333-4333-8333-333333333333';
const fingerprint = 'a'.repeat(64);
const replay = events => ({ schemaVersion: 1, kind: 'session-replay', sessions: [{ id: root, parentId: null,
  depth: 0, status: 'ready', source: { fingerprint }, limits: [], events }] });
const native = value => ({ status: 'ready', source: { nativeSessionId: root, clientVersion: '9.0.0', fingerprint }, sessionReplay: value });

test('completed run replay is frozen with a source fingerprint and explicit read boundary', async () => {
  const calls = [];
  const deps = { readReplay: async (...args) => { calls.push(args); return native(replay([{ id: 'first', sessionId: root,
    sourceLine: 1, kind: 'message', body: 'recorded' }])); } };
  const capturedRun = { source: { threadId: root, version: '8.0.0', workspace: '/workspace' },
    agents: [{ id: root, parentId: null }, { id: child, parentId: root }] };
  const savedProfile = { profileId: 'p', profileName: 'Default', home: '/saved/home' };
  const runDirectory = '/store/audits/run';
  const captured = await captureFrozenSessionReplay(deps, {}, savedProfile, capturedRun, runDirectory, '2026-10-29T00:00:00.000Z');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].includeReplay, true);
  assert.equal(calls[0][1], savedProfile, 'capture reads the exact run-bound profile object');
  assert.equal(calls[0][3].childIndexHome, join(runDirectory, 'runtime', 'sqlite'));
  assert.equal(calls[0][3].recordedAgents, capturedRun.agents, 'capture uses the completed run actor lineage');
  assert.deepEqual(captured.replayCapture, { status: 'partial', capturedAt: '2026-10-29T00:00:00.000Z',
    sourceFingerprint: fingerprint, boundary: 'finalized-native-history-snapshot' });
  assert.equal(captured.sessionReplay.sessions[0].events[0].body, 'recorded');
  assert.match(captured.sessionReplay.sessions[0].limits[0].message, /later activity is outside this replay/);
});

test('completed captures retain the native turn model and effort alongside the frozen replay', async () => {
  const turnId = '22222222-2222-4222-8222-222222222222';
  const original = { source: { threadId: root, workspace: '/workspace', model: 'startup-model' },
    agents: [{ id: root, parentId: null }], turns: [{ agentId: root, turnId, status: 'completed' }],
    settingsEvidence: { confirmed: { model: 'startup-model' } } };
  const captured = await captureFrozenSessionReplay({ readReplay: async () => ({ ...native(replay([])),
    turns: [{ agentId: root, turnId, model: 'observed-model', reasoningEffort: 'low', sourceLine: 10,
      recordedAt: '2026-10-29T00:00:01.000Z', workspaceMatched: true }] }) }, {}, {}, original, undefined);
  assert.equal(captured.turns?.[0].model, 'observed-model');
  assert.equal(captured.turns?.[0].reasoningEffort, 'low');
  assert.equal(captured.turns?.[0].sourceLine, 10);
  assert.equal(captured.nativeControls?.turns[0].sourceFingerprint, fingerprint);
  assert.equal(captured.turns?.[0].status, 'completed');
  assert.equal(original.turns[0].model, undefined);
  assert.deepEqual(original.settingsEvidence, { confirmed: { model: 'startup-model' } });
});

test('frozen report replay survives reopen unchanged even when native history grows', async () => {
  const frozen = replay([{ id: 'first', sessionId: root, sourceLine: 1, kind: 'message' }]);
  const profile = { profileId: 'p', profileName: 'Default', home: '/home', executable: '/codex' };
  const baseline = { repository: '/repo', commit: 'commit', tree: 'tree' };
  const spec = { repository: '/repo', revision: 'commit', profiles: [{ name: 'Default', executable: '/codex' }],
    setup: [], checks: [], limits: { runMs: 1, experimentMs: 2 } };
  const parent = { id: 'parent', record: { kind: 'audit-experiment', baseline: { repository: baseline }, spec, task: 'task' },
    state: { runs: [{ id: 'run', profileId: 'p' }] } };
  const current = { id: 'run', directory: '/store/run', record: { kind: 'audit-experiment-run', experimentId: 'parent', profile, baseline },
    report: { kind: 'audit-run', id: 'run', status: 'complete', profile,
      source: { kind: 'native-app-server-v2', threadId: root, workspace: '/workspace', version: '9.0.0' },
      agents: [{ id: root, parentId: null }, { id: child, parentId: root }], turns: [], sessionReplay: frozen } };
  let readOptions;
  const adapters = { read: async () => structuredClone(parent), readNative: async (_profile, _id, options) => { readOptions = options; return ({ status: 'ready',
    source: { nativeSessionId: root, clientVersion: '9.0.0', fingerprint }, turns: [],
    sessionReplay: replay([{ id: 'first', sessionId: root, sourceLine: 1, kind: 'message' },
      { id: 'later', sessionId: root, sourceLine: 2, kind: 'message' }]) }); } };
  const shown = await projectRetainedAuditRun({}, current, { ...adapters, includeReplay: true });
  assert.equal(readOptions.recordedAgents, current.report.agents, 'reopen uses lineage saved with the selected run');
  assert.deepEqual(shown.sessionReplay, frozen);
  assert.equal(shown.sessionReplay.sessions[0].events.some(event => event.id === 'later'), false);
  assert.deepEqual(current.report.sessionReplay, frozen);
});

test('mismatched native source is not frozen into a completed run', async () => {
  const deps = { readReplay: async () => ({ ...native(replay([])), source: { ...native(replay([])).source,
    nativeSessionId: '33333333-3333-4333-8333-333333333333', clientVersion: 'other' } }) };
  const captured = await captureFrozenSessionReplay(deps, {}, { profileName: 'Default' },
    { source: { threadId: root, version: '9.0.0' } }, undefined);
  assert.equal(captured.replayCapture.status, 'unavailable');
  assert.equal(captured.sessionReplay.sessions[0].status, 'unavailable');
});

test('qualified missing or foreign native state never falls back to a Codex history read', async () => {
  let reads = 0;
  const deps = { readReplay: async () => { reads++; return native(replay([])); } };
  const profile = { profileId: 'profile', client: 'claude-code' };
  const reference = { client: 'claude-code', jobId: 'run', profileId: 'profile', sessionId: root };
  const run = { id: 'run', source: { threadId: root }, nativeReference: reference };
  const missingReader = await captureFrozenSessionReplay(deps, {}, profile, run, undefined);
  assert.equal(missingReader.replayCapture.status, 'unavailable');
  assert.match(missingReader.sessionReplay.sessions[0].reason, /no retained native history reader/);
  const missingId = await captureFrozenSessionReplay(deps, {}, { ...profile, client: 'codex' },
    { ...run, nativeReference: { ...reference, client: 'codex', sessionId: null } }, undefined);
  assert.equal(missingId.replayCapture.status, 'unavailable');
  assert.equal(missingId.sessionReplay, undefined);
  assert.equal(reads, 0);
});

test('reopen preserves a foreign client record even when its compatibility thread ID looks like Codex', async () => {
  const original = { id: 'run', source: { kind: 'native-app-server-v2', threadId: root },
    clientIdentity: { client: 'claude-code' },
    nativeReference: { client: 'claude-code', jobId: 'run', profileId: 'profile', sessionId: root } };
  let reads = 0;
  const report = await projectRetainedAuditRun({}, { id: 'run', report: original,
    record: { kind: 'audit-experiment-run', profile: { profileId: 'profile', client: 'claude-code' } } },
  { read: async () => { reads++; }, readNative: async () => { reads++; } });
  assert.deepEqual(report, original);
  assert.equal(reads, 0);
});

test('new capture requires agreement between indexed, app-server, and replay actor sets', async () => {
  const childAgent = { id: child, parentId: root };
  const discovery = { schemaVersion: 1, kind: 'native-child-discovery', rootId: root, complete: true,
    edges: [{ id: child, parentId: root }], fingerprint: 'b'.repeat(64), indexFingerprint: 'c'.repeat(64), capturedAt: '2026-10-29T00:00:00.000Z' };
  let options;
  const deps = { readReplay: async (_store, _profile, _id, value) => {
    options = value;
    return { ...native({ schemaVersion: 1, kind: 'session-replay', sessions: [
      { id: root, parentId: null, depth: 0, status: 'ready', source: { fingerprint }, limits: [], events: [] },
      { id: child, parentId: root, depth: 1, status: 'ready', source: { fingerprint }, limits: [], events: [] },
    ] }), coverage: { agents: 'complete' } };
  } };
  const captured = await captureFrozenSessionReplay(deps, {}, {}, { source: { threadId: root, version: 'new-version' },
    agents: [{ id: root, parentId: null }, childAgent], childDiscovery: discovery }, undefined,
  '2026-10-29T00:00:00.000Z');
  assert.deepEqual(options.recordedDiscovery, discovery);
  assert.equal(captured.replayCapture.status, 'ready');
  assert.equal(captured.replayCapture.childDiscovery.status, 'complete');
  assert.equal(captured.coverage.agents, 'complete');

  const mismatched = await captureFrozenSessionReplay({ readReplay: async () => ({ ...native(replay([])),
    coverage: { agents: 'complete' } }) }, {}, {}, { source: { threadId: root }, agents: [{ id: root, parentId: null }, childAgent],
    childDiscovery: { ...discovery, edges: [] } }, undefined, '2026-10-29T00:00:00.000Z');
  assert.equal(mismatched.replayCapture.status, 'partial');
  assert.equal(mismatched.coverage.agents, 'partial');
  assert.ok(mismatched.sessionReplay.sessions[0].limits.some(limit => limit.kind === 'child-discovery-partial'));
});

test('failed capture freezes unavailable coverage instead of discovering later content on reopen', async () => {
  const deps = { readReplay: async () => { throw Error('source unavailable'); } };
  const captured = await captureFrozenSessionReplay(deps, {}, { profileName: 'Default' },
    { source: { threadId: root, version: '9.0.0' } }, undefined, '2026-10-29T00:00:00.000Z');
  assert.equal(captured.sessionReplay.sessions[0].status, 'unavailable');
  assert.match(captured.sessionReplay.sessions[0].limits[0].message, /unavailable evidence is frozen/);
  assert.equal(captured.replayCapture.sourceFingerprint, null);
});

test('frozen replay stays below the durable run cap by explicitly omitting excess bodies', async () => {
  const body = 'x'.repeat(1024 * 1024), events = Array.from({ length: 13 }, (_, index) => ({
    id: `${root}:${fingerprint}:${index + 1}`, sessionId: root, turnId: null, kind: 'message', label: 'Message',
    timestamp: null, sourceLine: index + 1, body, bodyStatus: 'included', bodyBytes: Buffer.byteLength(body),
  }));
  const deps = { readReplay: async () => native(replay(events)) };
  const captured = await captureFrozenSessionReplay(deps, {}, {}, { source: { threadId: root, version: '9.0.0' } }, undefined,
    '2026-10-29T00:00:00.000Z');
  assert.ok(Buffer.byteLength(JSON.stringify({ sessionReplay: captured.sessionReplay, replayCapture: captured.replayCapture }))
    < 12 * 1024 * 1024);
  assert.ok(captured.sessionReplay.sessions[0].events.some(event => event.bodyReason === 'frozen-report-size-limit'));
});

test('frozen replay persists through the run store, retained read, and source-free export', async t => {
  const directory = await mkdtemp('/private/tmp/xfx-replay-capture-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nativeHome = join(directory, 'native-home');
  const store = { directory: join(directory, 'store') }, profile = { id: 'p', profileId: 'p', profileName: 'Default',
    home: nativeHome, userHome: nativeHome, executable: '/codex', version: '9.0.0' };
  await mkdir(store.directory, { mode: 0o700 });
  await chmod(store.directory, 0o700);
  await mkdir(nativeHome, { mode: 0o700 }); await chmod(nativeHome, 0o700);
  const baseline = { repository: '/repo', commit: 'commit', tree: 'tree' };
  const spec = { repository: '/repo', revision: 'commit', task: 'task', profiles: [{ name: 'Default', executable: '/codex' }],
    setup: [], checks: [], limits: { runMs: 100, experimentMs: 200 } };
  const experiment = await createExperiment(store, { spec, task: 'task', profiles: [profile], baseline: { repository: baseline } });
  const run = await createExperimentRun(store, { experimentId: experiment.id, profile, baseline });
  const sessionDirectory = join(profile.home, 'sessions', '2026', '10', '29');
  const rollout = join(sessionDirectory, `rollout-2026-10-29T00-00-00-${root}.jsonl`);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(run.directory, 'runtime', 'sqlite'), { recursive: true, mode: 0o700 });
  const rows = [
    { timestamp: '2026-10-29T00:00:00.000Z', type: 'session_meta', payload: { id: root, session_id: root, cli_version: '9.0.0', cwd: '/workspace' } },
    { timestamp: '2026-10-29T00:00:01.000Z', type: 'turn_context', payload: { turn_id: '22222222-2222-4222-8222-222222222222', cwd: '/workspace', model: 'fixture', effort: 'medium' } },
    { timestamp: '2026-10-29T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user',
      turn_id: '22222222-2222-4222-8222-222222222222', content: [{ type: 'input_text', text: 'captured fixture message' }] } },
  ];
  await writeFile(rollout, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
  const observed = await auditRetainedNativeSession(profile, root, { includeReplay: true, actionRepoRoot: '/workspace' });
  assert.equal(observed.status, 'partial', JSON.stringify({ status: observed.status, reason: observed.reason, warnings: observed.warnings }));
  let captureOptions;
  const capture = await captureFrozenSessionReplay({ readReplay: (_store, savedProfile, id, options) => {
    assert.equal(savedProfile.home, nativeHome); assert.equal(id, root);
    captureOptions = options;
    return auditRetainedNativeSession(savedProfile, id, options);
  } }, store, profile, { source: { threadId: root, workspace: '/workspace', version: '9.0.0' },
    agents: [{ id: root, parentId: null }],
    turns: [{ agentId: root, turnId: '22222222-2222-4222-8222-222222222222', status: 'completed' }] },
  join(store.directory, 'audits', run.id), '2026-10-29T00:00:00.000Z');
  const frozen = capture.sessionReplay, captureBoundary = capture.replayCapture;
  assert.equal(captureOptions.childIndexHome, join(store.directory, 'audits', run.id, 'runtime', 'sqlite'));
  assert.equal(captureBoundary.status, 'partial');
  assert.ok(frozen.sessions[0].limits.some(limit => limit.kind === 'child-discovery-partial'));
  assert.ok(frozen.sessions[0].events.some(event => event.body === 'captured fixture message'));
  const report = { schemaVersion: 1, kind: 'audit-run', id: run.id, status: 'complete', profile,
    source: { kind: 'native-app-server-v2', threadId: root, workspace: '/workspace', version: '9.0.0' },
    agents: [{ id: root, parentId: null }, { id: child, parentId: root }], turns: capture.turns, nativeControls: capture.nativeControls,
    sessionReplay: frozen, replayCapture: captureBoundary };
  await finalizeAuditRecord(store, run.id, report);
  const saved = await readAuditRecord(store, run.id);
  assert.deepEqual(saved.report.sessionReplay, frozen);
  assert.deepEqual(saved.report.replayCapture, captureBoundary);
  assert.equal(saved.report.turns[0].model, 'fixture');
  assert.equal(saved.report.turns[0].reasoningEffort, 'medium');
  const later = replay([{ id: `${root}:${fingerprint}:1`, sessionId: root, turnId: null, kind: 'message',
    label: 'Assistant message', timestamp: null, sourceLine: 1, bodyStatus: 'unavailable' },
    { id: `${root}:${fingerprint}:2`, sessionId: root, turnId: null, kind: 'message',
      label: 'Later message', timestamp: null, sourceLine: 2, bodyStatus: 'unavailable' }]);
  let retainedReads = 0;
  const shown = await projectRetainedAuditRun(store, saved, { read: async (_store, id) => readAuditRecord(store, id), includeReplay: true,
    readNative: async () => { retainedReads++; return { status: 'ready', source: { nativeSessionId: root, clientVersion: '9.0.0', fingerprint },
      turns: [], sessionReplay: later }; } });
  assert.equal(retainedReads, 0);
  assert.deepEqual(shown.sessionReplay, frozen);
  assert.equal(shown.sessionReplay.sessions[0].events.some(event => event.sourceLine === 2), false);
  const receipt = await exportAuditReport(saved.report, { output: join(directory, 'frozen.json'), includeReplayContent: true });
  const reopened = await readAuditReport(receipt.output);
  assert.deepEqual(reopened.sessionReplay, frozen);
  assert.deepEqual(reopened.replayCapture, captureBoundary);
  assert.deepEqual(reopened.turns, report.turns);
  assert.deepEqual(reopened.nativeControls, report.nativeControls);
});
