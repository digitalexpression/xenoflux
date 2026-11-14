import test from 'node:test';
import assert from 'node:assert/strict';
import { presentSession } from '../src/audit-session-presentation.js';

test('session origin distinguishes historical readers, retained captures and unknown evidence', () => {
  const origins = [
    ['native-rollout', 'codex', 'Historical import'],
    ['claude-code-sdk-file-import', 'claude-code', 'Historical import'],
    ['copilot-sdk-session-import', 'copilot', 'Historical import'],
    ['native-app-server-v2', 'codex', 'Retained xfx capture'],
    ['claude-agent-sdk', 'claude-code', 'Retained xfx capture'],
    ['copilot-sdk-stdio', 'copilot', 'Retained xfx capture'],
    ['unrecognized-reader', 'codex', 'Capture origin unknown'],
  ];
  for (const [kind, client, mode] of origins) {
    const view = presentSession({ source: { kind }, clientIdentity: { client },
      nativeReference: { client, sessionId: 'one-native-session' } });
    assert.equal(view.mode, mode, kind);
    assert.equal(view.client, client, kind);
    assert.equal(view.sessionId, 'one-native-session', kind);
    assert.deepEqual(view.agents, [], 'origin alone cannot invent execution actors');
    assert.equal(view.replay, null, 'origin alone cannot invent a second session or history');
    assert.equal(view.execution.state, 'unknown', 'a successful import is not historical task completion');
    assert.equal(view.limits.some(limit => /not an xfx-owned execution capture/.test(limit)), mode === 'Historical import');
  }
  assert.equal(presentSession({}).mode, 'Capture origin unknown');
});

test('import read context identifies the reader without establishing the historical execution surface', () => {
  for (const [client, kind] of [['codex', 'native-rollout'], ['claude-code', 'claude-code-sdk-file-import'],
    ['copilot', 'copilot-sdk-session-import']]) {
    const view = presentSession({ source: { kind, readContext: { profileId: 'reader', profileName: 'Reader profile',
      rootMode: 'explicit', surface: 'desktop', executionLocation: 'local' } },
    profile: { profileName: 'Recorded profile' }, clientIdentity: { client, surface: null } });
    assert.equal(view.mode, 'Historical import');
    assert.equal(view.surface, null, client);
    assert.equal(view.readContext, 'Reader profile · explicit · desktop · local');
    assert.equal(view.setupHref, `/profiles/Reader%20profile/setup?client=${client}`);
    assert.match(view.limits.join('\n'), /historical harness.*not reconstructed/);
  }
});

test('settings retain separate requested, sent, confirmed and observed values', () => {
  const view = presentSession({ profile: { execution: { model: 'profile-default', reasoningEffort: 'profile-effort' } },
    settingsEvidence: {
      requested: { model: 'requested-model', reasoningEffort: 'low', permissionMode: { value: 'requested-policy' } },
      sent: { model: { value: 'sent-model' }, reasoningEffort: 'medium', permissionMode: 'sent-policy' },
      confirmed: { model: 'confirmed-model', reasoningEffort: { value: 'high' }, permissionMode: 'confirmed-policy' },
      observed: { model: 'observed-model', reasoningEffort: 'max', permissionMode: { value: 'observed-policy' } },
    } });
  assert.deepEqual(view.settings, [
    { name: 'Model', requested: 'requested-model', sent: 'sent-model', confirmed: 'confirmed-model', observed: 'observed-model' },
    { name: 'Reasoning effort', requested: 'low', sent: 'medium', confirmed: 'high', observed: 'max' },
    { name: 'Permission mode', requested: 'requested-policy', sent: 'sent-policy', confirmed: 'confirmed-policy', observed: 'observed-policy' },
  ]);
});

test('requested defaults and confirmed settings never fill missing evidence stages', () => {
  const view = presentSession({ profile: { execution: { model: 'requested-model', reasoningEffort: 'low', permissionMode: 'requested-policy' } },
    settingsEvidence: { confirmed: { model: 'confirmed-model' } } });
  assert.deepEqual(view.settings, [
    { name: 'Model', requested: 'requested-model', sent: null, confirmed: 'confirmed-model', observed: null },
    { name: 'Reasoning effort', requested: 'low', sent: null, confirmed: null, observed: null },
    { name: 'Permission mode', requested: 'requested-policy', sent: null, confirmed: null, observed: null },
  ]);
  assert.ok(presentSession({}).settings.every(row => Object.values(row).slice(1).every(value => value === null)));
});

test('retained native configuration supplies requested effort without implying sent or observed effort', () => {
  const view = presentSession({ nativeControls: { configured: { model: 'requested-model', modelReasoningEffort: 'high' } } });
  assert.deepEqual(view.settings.find(row => row.name === 'Reasoning effort'), {
    name: 'Reasoning effort', requested: 'high', sent: null, confirmed: null, observed: null,
  });
});

test('turn observations retain source order and attribution rather than sorting by clocks', () => {
  const run = { turns: [
    { agentId: 'root', turnId: 'later-clock', model: 'first-model', reasoningEffort: 'low',
      recordedAt: '2026-11-13T12:01:00Z', sourceLine: 8 },
    { agentId: 'child', turnId: 'earlier-clock', model: 'second-model', reasoningEffort: 'high',
      recordedAt: '2026-11-13T12:00:00Z', sourceLine: 12 },
    { turnId: 'unknown-clock', sourceLine: 20 },
  ] };
  const before = structuredClone(run);
  assert.deepEqual(presentSession(run).turns, [
    { agentId: 'root', turnId: 'later-clock', model: 'first-model', effort: 'low', recordedAt: '2026-11-13T12:01:00Z', sourceLine: 8, source: 'Retained turn record' },
    { agentId: 'child', turnId: 'earlier-clock', model: 'second-model', effort: 'high', recordedAt: '2026-11-13T12:00:00Z', sourceLine: 12, source: 'Retained turn record' },
    { agentId: null, turnId: 'unknown-clock', model: null, effort: null, recordedAt: null, sourceLine: 20, source: 'Retained turn record' },
  ]);
  assert.deepEqual(run, before, 'presentation preserves retained source evidence');
});

test('native turn settings remain attributed observations without replacing root settings or merging repeated records', () => {
  const run = { source: { kind: 'native-app-server-v2', threadId: 'root' },
    turns: [{ agentId: 'root', turnId: 'turn-1', model: 'retained-model', reasoningEffort: 'low', sourceLine: 12 }],
    settingsEvidence: {
      requested: { model: 'requested-model' }, confirmed: { model: 'confirmed-model' },
      observed: { source: 'native-turn-event', turns: [
        { threadId: 'child', turnId: 'child-turn', model: 'child-model', reasoningEffort: 'high', sourceLine: 30 },
        { threadId: 'root', turnId: 'turn-1', model: 'observed-root-model', reasoningEffort: 'medium', sourceLine: 10 },
        { threadId: 'root', turnId: 'turn-1', model: 'observed-root-model', reasoningEffort: 'medium', sourceLine: 40 },
      ] },
    } };
  const before = structuredClone(run);
  const view = presentSession(run);
  assert.deepEqual(view.turns, [
    { agentId: 'root', turnId: 'turn-1', model: 'retained-model', effort: 'low', recordedAt: null, sourceLine: 12, source: 'Retained turn record' },
    { agentId: 'child', turnId: 'child-turn', model: 'child-model', effort: 'high', recordedAt: null, sourceLine: 30, source: 'native-turn-event' },
    { agentId: 'root', turnId: 'turn-1', model: 'observed-root-model', effort: 'medium', recordedAt: null, sourceLine: 10, source: 'native-turn-event' },
    { agentId: 'root', turnId: 'turn-1', model: 'observed-root-model', effort: 'medium', recordedAt: null, sourceLine: 40, source: 'native-turn-event' },
  ]);
  assert.deepEqual(view.settings.find(row => row.name === 'Model'), {
    name: 'Model', requested: 'requested-model', sent: null, confirmed: 'confirmed-model', observed: null,
  }, 'turn events do not establish one session-wide observed model');
  assert.deepEqual(run, before, 'projection keeps native observations unchanged');
});

test('absent token evidence stays unknown for each actor and the workflow', () => {
  const view = presentSession({ source: { kind: 'native-rollout' },
    agents: [{ id: 'root', parentId: null }, { id: 'child', parentId: 'root' }] });
  assert.equal(view.coverage.find(row => row.name === 'Token usage').state, 'unknown');
  const unknownCounters = { input: null, cachedInput: null, output: null, reasoning: null, total: null };
  assert.deepEqual(view.workflow.counters, unknownCounters);
  assert.notEqual(view.workflow.usageStatus, 'validated');
  assert.equal(view.workflow.runnerDurationMs, null);
  for (const actor of view.agents) {
    assert.deepEqual(actor.counters, unknownCounters);
    assert.match(actor.usageNote, /not recorded/);
    assert.equal(actor.durationMs, null);
  }
  assert.match(view.limits.join('\n'), /Missing usage is unknown, not zero/);
});

test('text-only imports disclose unavailable actor ownership and usage', () => {
  const view = presentSession({ source: { kind: 'claude-code-sdk-file-import' }, clientIdentity: { client: 'claude-code' } });
  assert.match(view.workflow.coverageNote, /conversation text.*ownership and usage were not captured/);
  assert.deepEqual(view.agents, []);
  assert.equal(view.workflow.counters.total, null);
});

test('owned coverage separates the captured skill catalog from limited invocation evidence', () => {
  const run = { source: { kind: 'native-app-server-v2' },
    coverage: { skills: 'partial', skillInventory: 'complete', skillUsage: 'partial', skillInvocationTelemetry: 'empty' } };
  const before = structuredClone(run);
  const { coverage } = presentSession(run);
  assert.equal(coverage.some(row => row.name === 'Skills'), false);
  assert.equal(coverage.find(row => row.name === 'Skill catalog').state, 'complete');
  assert.match(coverage.find(row => row.name === 'Skill catalog').note, /does not prove.*invocation/);
  assert.equal(coverage.find(row => row.name === 'Skill use').state, 'empty');
  assert.match(coverage.find(row => row.name === 'Skill use').note, /No invocation telemetry.*unknown/);
  assert.deepEqual(run, before);
});

test('skill use reports the retained telemetry scope separately from required capture', () => {
  for (const state of ['observed', 'empty', 'partial', 'unsupported']) {
    const { coverage } = presentSession({ coverage: { skillInventory: 'complete', skillUsage: 'partial',
      skillInvocationTelemetry: state, captureRequirements: 'complete' } });
    assert.equal(coverage.find(row => row.name === 'Skill use').state, state);
    assert.match(coverage.find(row => row.name === 'Skill use').note, /unknown|not establish every/);
    assert.equal(coverage.find(row => row.name === 'Required capture').state, 'complete');
    assert.match(coverage.find(row => row.name === 'Required capture').note, /declared.*checks/);
  }
  assert.equal(presentSession({ coverage: { skillUsage: 'partial' } }).coverage.find(row => row.name === 'Skill use').state, 'partial');
  assert.equal(presentSession({}).coverage.some(row => row.name === 'Required capture'), false);
});

test('skill references retain their own evidence without inventing transcript lines', () => {
  const sourceTime = { schemaVersion: 1,
    nativeEvent: { source: 'event.timestamp', clock: 'producer-reported', unixNano: '1794597132233000000' },
    otlpEvent: { source: 'timeUnixNano', clock: 'otlp-event', unixNano: null },
    otlpObserved: { source: 'observedTimeUnixNano', clock: 'otlp-observed', unixNano: '1794597132233858000' },
    clockRelationship: 'unknown' };
  const run = { skills: [{ name: 'review', observations: [
    { kind: 'native-selection-accepted', agentId: 'root', turnId: 'turn-1', evidence: 'structured turn/start skill input' },
    { kind: 'definition-read-observed', agentId: 'root', turnId: 'turn-1', sourceLine: 59, itemId: 'read-1', evidence: { source: 'app-server-command' } },
    { kind: 'native-invocation-observed', agentId: 'root', turnId: 'turn-1', metadata: {
      source: 'native-otel-skill-invocation', observationId: 'receipt:1', invocationType: 'explicit', sourceTime, timestampNs: null } },
    { kind: 'native-invocation-observed', agentId: 'root', turnId: 'turn-1', metadata: {
      source: 'native-otel-skill-invocation', observationId: 'receipt:2', invocationType: 'implicit', timestampNs: '1794597136983000000' } },
    { kind: 'mentioned', agentId: 'root', turnId: 'turn-1' },
  ] }, { name: 'catalog entry', observations: [] }] };
  const before = structuredClone(run);
  const { skills } = presentSession(run);
  assert.deepEqual(skills[0].observations.map(row => row.sourceRef), [
    { kind: 'structured-selection', source: 'structured turn/start skill input' },
    { kind: 'file-line', line: 59, itemId: 'read-1', source: 'app-server-command' },
    { kind: 'native-telemetry', source: 'native-otel-skill-invocation', observationId: 'receipt:1', invocationType: 'explicit', sourceTime, timestampNs: null,
      timestamps: [{ clock: 'producer-reported', source: 'event.timestamp', iso: '2026-11-13T19:12:12.233000000Z' },
        { clock: 'otlp-observed', source: 'observedTimeUnixNano', iso: '2026-11-13T19:12:12.233858000Z' }] },
    { kind: 'native-telemetry', source: 'native-otel-skill-invocation', observationId: 'receipt:2', invocationType: 'implicit', sourceTime: null, timestampNs: '1794597136983000000',
      timestamps: [{ clock: 'unattributed', source: 'timestampNs', iso: '2026-11-13T19:12:16.983000000Z' }] },
    { kind: 'unavailable' },
  ]);
  assert.deepEqual(skills[0].observations.map(row => row.sourceLine), [null, 59, null, null, null]);
  assert.deepEqual(skills[1].observations, []);
  assert.deepEqual(run, before, 'presentation does not alter original observations or source clock metadata');
});

test('only an owned canonical empty check recipe establishes that verification was not selected', () => {
  const conditions = { schemaVersion: 1, checkRecipes: [] };
  const run = { source: { kind: 'native-app-server-v2' }, comparisonConditions: conditions,
    coverage: { outcome: 'unavailable' } };
  const verification = presentSession(run).coverage.find(row => row.name === 'Task verification');
  assert.equal(verification.state, 'No checks selected');
  assert.match(verification.note, /completion.*separate/);
  for (const other of [
    { ...run, comparisonConditions: undefined, checks: [] },
    { ...run, comparisonConditions: { schemaVersion: 1, checkRecipes: [{ name: 'test' }] } },
    { ...run, source: { kind: 'native-rollout' } },
  ]) {
    const { coverage } = presentSession(other);
    assert.equal(coverage.some(row => row.name === 'Task verification'), false);
    assert.equal(coverage.find(row => row.name === 'Outcome').state, 'unavailable');
  }
});

test('historical and empty event coverage explains its limits without inventing absence', () => {
  const { coverage } = presentSession({ source: { kind: 'native-rollout' },
    coverage: { skills: 'partial', tools: 'none-recorded', mcp: 'none-recorded', hooks: 'none-recorded' } });
  assert.equal(coverage.find(row => row.name === 'Skills').state, 'partial');
  assert.match(coverage.find(row => row.name === 'Skills').note, /history reader/);
  for (const name of ['Tools', 'MCP', 'Hooks']) {
    const row = coverage.find(row => row.name === name);
    assert.equal(row.state, 'none-recorded');
    assert.match(row.note, /not recorded.*does not prove/);
  }
  assert.equal(presentSession({}).coverage.find(row => row.name === 'Tools').state, 'unknown');
});
