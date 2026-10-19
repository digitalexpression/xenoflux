import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditExitCode, compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
import { evaluateCaptureRequirements } from '../src/audit-evidence.js';
import { mergeAuditSkillTelemetry } from '../src/audit-skill-usage.js';
import { nativeUsageAccounting } from '../src/audit-usage.js';

const complete = {
  schemaVersion: 1, kind: 'audit-run', id: 'run-a', status: 'ready',
  profile: { profileId: 'profile-a', profileName: 'A' }, source: {
    kind: 'native-rollout', nativeSessionId: 'native-123', path: '/private/home/sessions/rollout.jsonl',
    clientVersion: '1.2.3', fingerprint: 'abc123', originator: 'codex-cli',
  },
  agents: [{ id: 'root', depth: 0, name: 'Primary' }, { id: 'child', parentId: 'root', depth: 1, name: 'Worker' }],
  turns: [
    { agentId: 'root', turnId: 't1', model: 'model-a', reasoningEffort: 'high', sourceLine: 4 },
    { agentId: 'child', turnId: 't2', model: 'model-a', reasoningEffort: 'high', sourceLine: 9 },
  ],
  skills: [{ id: 'project:review', name: 'review', origin: 'project', scope: 'repository', path: 'skills/review/SKILL.md',
    observations: [{ kind: 'definition-read', agentId: 'child', turnId: 't2', sourceLine: 12 }] }],
  events: [{ agentId: 'child', turnId: 't2', kind: 'tool-call', recordedAt: '2026-01-01T00:00:00Z', sourceLine: 13,
    metadata: { tool: 'Read', callId: 'call-1', itemType: 'command_execution', status: 'completed' } }],
  metrics: { elapsedMs: 100 }, usage: { inputTokens: 50 },
  coverage: { timeline: 'ready', agents: 'ready', skills: 'partial', usage: 'ready', workspaceDiff: 'unknown', outcome: 'unknown' },
  outcome: { status: 'unverified' }, artifacts: [], warnings: [],
};

test('compares skill identity and attributed evidence across all origins and agents', () => {
  const right = structuredClone(complete);
  right.id = 'run-b'; right.profile = { profileId: 'profile-b', profileName: 'B' };
  right.skills = [
    { id: 'project:review', name: 'review', origin: 'project', scope: 'repository', status: 'present', observations: [] },
    { id: 'plugin:review', name: 'review', origin: 'plugin', provider: 'vendor.plugin', scope: 'plugin',
      observations: [{ kind: 'invoked', agentId: 'root', turnId: 't1', sourceLine: 21 }] },
  ];
  const result = compareAuditRuns(complete, right);
  assert.equal(result.kind, 'audit-comparison');
  assert.equal(result.comparison.skills.length, 2, 'same names from distinct origins remain distinct');
  assert.deepEqual(result.comparison.skills.find(skill => skill.id === 'project:review').left.observations[0], {
    kind: 'definition-read', agentId: 'child', turnId: 't2', sourceLine: 12,
  });
  assert.equal(result.comparison.skills.find(skill => skill.id === 'plugin:review').right.origin, 'plugin');
  const report = renderAudit(result);
  assert.match(report, /definition-read by agent child, turn t2 line 12/);
  assert.match(report, /invoked by agent root, turn t1 line 21/);
  assert.match(report, /do not establish that a profile setup caused an outcome or is a winner/);
});

test('compares and renders canonical resource provenance without claiming runtime use', () => {
  const provenance = fingerprint => ({ schemaVersion: 1, status: 'complete', counts: { observed: 1, omitted: 0, snapshots: 2 }, resources: [
    { identity: { origin: 'project', provider: 'sample.plugin', location: 'workspace/skills/review' }, canonicalRef: 'workspace/.codex/skills/review',
      aliases: ['workspace/.agents/skills/review'], version: '1.2.3', catalogs: [{ agentId: 'root', phase: 'after-task', status: 'present' }],
      name: 'review', scope: 'project', nativeSkillIds: ['a'.repeat(24)], agentIds: ['root'], snapshots: [
      { phase: 'before-task', capturedAt: '2026-10-19T10:10:30.000Z', status: 'present', definition: { status: 'present', fingerprint },
        manifest: { status: 'present', fingerprint: 'c'.repeat(64), scope: 'plugin-manifest-allowlist', version: '1.2.3' } },
      { phase: 'after-task', capturedAt: '2026-10-19T10:20:30.000Z', status: 'present', definition: { status: 'present', fingerprint },
        manifest: { status: 'present', fingerprint: 'c'.repeat(64), scope: 'plugin-manifest-allowlist', version: '1.2.3' } },
    ] },
  ] });
  const left = { ...complete, sourceWorkspace: { sourceCommit: 'commit', sourceTree: 'tree' }, resourceProvenance: provenance('a'.repeat(64)) };
  const right = { ...structuredClone(complete), id: 'run-b', sourceWorkspace: { sourceCommit: 'commit', sourceTree: 'tree' }, resourceProvenance: provenance('b'.repeat(64)) };
  const report = compareAuditRuns(left, right);
  assert.equal(report.comparison.resourceProvenance.status, 'complete');
  assert.equal(report.comparison.resourceProvenance.changes[0].status, 'changed');
  assert.equal(report.comparison.resourceProvenance.sameBaseline, true);
  const text = renderAudit(report, { format: 'markdown' });
  assert.match(text, /Resource provenance comparison: complete/);
  assert.ok(text.includes('max 2 snapshots/resource'));
  assert.match(text, /changed/);
  assert.ok(text.includes('project · provider sample') && text.includes('workspace/skills/review'));
  assert.ok(text.includes('provider sample'));
  assert.ok(text.includes('canonical workspace/\\.codex/skills/review'));
  assert.ok(text.includes('Aliases: workspace/\\.agents/skills/review'));
  assert.ok(text.includes('2026\\-10\\-19T10:20:30\\.000Z'));
  assert.ok(text.includes('manifest present'));
  assert.ok(text.includes('manifest present') && text.includes('version 1\\.2\\.3'));
  assert.ok(text.includes('stability between endpoints is not proven'));
  assert.ok(text.includes('do not establish that a resource was loaded or used'));
});

test('per-run show renders evaluated capture acceptance and normalized telemetry diagnostics', () => {
  const run = structuredClone(complete);
  run.status = 'ready';
  run.source.threadId = 'root';
  run.source.persistence = 'native-owned-session';
  run.capture = { status: 'partial', observer: { transport: 'loopback-otlp-http-json', savedSettingsChanged: false,
    nativeSessionStorage: 'profile-owned-new-rollouts', profileHomeUsedForReadOnlySettingsAndSkills: true,
    runtime: { sqlite: 'private-per-process', logs: 'private-per-process', temporaryFiles: 'private-per-process', threadPersistence: 'native-owned-session' },
    effects: ['PRIVATE_EFFECT_DETAIL'] } };
  run.coverage.agents = 'complete';
  run.agents = [{ id: 'root', parentId: null, depth: 0 }, { id: 'child', parentId: 'root', depth: 1 }];
  run.turns = [{ agentId: 'root', turnId: 'root-turn' }, { agentId: 'child', turnId: 'child-turn' }];
  run.usage = { root: { total: { inputTokens: 10 } }, observations: [{ agentId: 'root', turnId: 'root-turn',
    total: { inputTokens: 10 }, disposition: 'accepted' }] };
  run.skills = [{ id: 'project:review', name: 'review', origin: 'project', scope: 'repository', catalogs: [{ agentId: 'child' }], observations: [] }];
  run.captureAcceptance = evaluateCaptureRequirements(run, { minAgents: 2, usage: { agents: 'root', fields: ['inputTokens'], minTurns: 1 } });
  assert.equal(run.captureAcceptance.status, 'passed');
  mergeAuditSkillTelemetry(run, { events: [], metadata: { transport: 'otlp-http-json', receivedBytes: 250, rejectedRequests: 1,
    journal: { status: 'partial', bytes: 128, eventCount: 0 } } });
  assert.equal(run.skillTelemetry.diagnostics.missingness.byAgent.child.project.catalogCount, 1);
  const report = renderAudit(run);
  assert.match(report, /Capture acceptance: passed · mode declared-observations/);
  assert.match(report, /usage:root:root-turn · passed/);
  assert.match(report, /Skill-use capability: enabled-empty · delivery unknown/);
  assert.match(report, /Skill telemetry transport: observed · received 250 bytes · rejected 1/);
  assert.match(report, /Skill telemetry journal: partial · 128 bytes · 0 events/);
  assert.match(report, /Skill telemetry child · project · catalog 1 · invocations 0 · unknown/);
  assert.match(report, /Native storage: session native-owned-session · rollouts profile-owned-new-rollouts · SQLite private-per-process/);
  assert.match(report, /saved settings changed false/);
  assert.equal(report.includes('PRIVATE_EFFECT_DETAIL'), false);
});

test('reports observed plugin use only from attributed skill and MCP call evidence', () => {
  const run = structuredClone(complete);
  run.coverage = { skillInvocationTelemetry: 'partial', tools: 'partial', mcp: 'partial' };
  run.skillInvocations = [
    { agentId: 'root', turnId: 't1', skillName: 'plugin-skill', skillId: 's1', pluginId: 'vendor.plugin', resolution: 'resolved', invocationType: 'explicit', sourceLine: 30 },
    { agentId: 'root', turnId: 't1', skillName: 'plugin-skill', skillId: 's1', pluginId: 'vendor.plugin', resolution: 'resolved', invocationType: 'explicit', sourceLine: 30 },
    { agentId: 'child', turnId: 't2', skillName: 'unclear', resolution: 'ambiguous', sourceLine: 31 },
  ];
  run.toolInvocations = [{ agentId: 'child', turnId: 't2', itemId: 'mcp-1', kind: 'mcp', pluginId: 'vendor.plugin', toolName: 'search', status: 'failed', success: false, durationMs: 12, failureReason: 'timeout', sourceLine: 32 }];
  run.mcp = { servers: [{ name: 'search', pluginId: 'vendor.plugin', status: 'failed', failureReason: 'server-start-failed' }] };
  run.skills.push({ id: 'catalog-only', name: 'catalog-only', pluginId: 'catalog.plugin', origin: 'plugin', availability: 'ready', observations: [] });
  const report = renderAudit(run, { format: 'markdown' });
  assert.ok(report.includes('vendor\\.plugin · 2 observed uses'));
  assert.match(report, /Plugin identity or actor unknown: 1 observed skill events/);
  assert.ok(report.includes('Catalog and ready\\-state records are not use evidence'));
  assert.ok(!report.includes('catalog\\.plugin · 1 observed use'));
  assert.match(report, /12 ms/);
  assert.match(report, /failure timeout/);
  assert.ok(report.includes('failure server\\-start\\-failed'));
  const compared = compareAuditRuns(run, { ...structuredClone(run), id: 'run-other' });
  assert.equal(compared.comparison.plugins.left.byPlugin[0].count, 2);
  assert.equal(compared.comparison.plugins.left.status, 'partial-or-unknown');
  assert.match(renderAudit(compared, { format: 'markdown' }), /Left observed plugin use/);
});

test('plugin-use projection deduplicates native replay identity and keeps ownership uncertainty separate', () => {
  const run = structuredClone(complete);
  run.coverage = { skillInvocationTelemetry: 'partial', tools: 'partial' };
  run.skills.push({ id: 'known-project-skill', name: 'local', origin: 'project', scope: 'project', observations: [] });
  run.skills.push({ id: 'known-profile-skill', name: 'local-profile', origin: 'profile', scope: 'profile', observations: [] });
  run.skillInvocations = [
    { agentId: 'child', turnId: 't2', skillName: 'vendor-skill', scope: 'plugin', pluginId: 'vendor.plugin', invocationType: 'explicit', resolution: 'resolved', timestampNs: '100', source: 'native-event', sourceLine: 1 },
    { agentId: 'child', turnId: 't2', skillName: 'vendor-skill', scope: 'plugin', pluginId: 'vendor.plugin', invocationType: 'explicit', resolution: 'resolved', timestampNs: '100', source: 'native-event', sourceLine: 99 },
    { agentId: 'child', turnId: 't2', skillName: 'vendor-skill', scope: 'plugin', pluginId: 'vendor.plugin', invocationType: 'explicit', resolution: 'resolved', timestampNs: '101', source: 'native-event', sourceLine: 100 },
    { agentId: 'root', turnId: 't1', skillName: 'local', skillId: 'known-project-skill', scope: 'project', invocationType: 'explicit', resolution: 'catalogued' },
    { agentId: 'root', turnId: 't1', skillName: 'local-profile', skillId: 'known-profile-skill', scope: 'user', invocationType: 'implicit', resolution: 'catalogued' },
    { agentId: 'root', turnId: 't1', skillName: 'late-plugin', pluginId: 'late.plugin', invocationType: 'explicit', resolution: 'unknown' },
    { turnId: 't1', skillName: 'orphan', pluginId: 'orphan.plugin', invocationType: 'explicit', resolution: 'resolved' },
  ];
  run.toolInvocations = [
    { agentId: 'child', turnId: 't2', itemId: 'call-a', kind: 'mcp', serverName: 'independent', toolName: 'read' },
    { agentId: 'child', turnId: 't2', itemId: 'call-a', kind: 'mcp', serverName: 'independent', toolName: 'read' },
  ];
  const report = renderAudit(run);
  assert.match(report, /vendor\.plugin · 2 observed uses/);
  assert.match(report, /late\.plugin · 1 observed uses/);
  assert.doesNotMatch(report, /orphan\.plugin · 1 observed use/);
  assert.match(report, /Plugin identity or actor unknown: 1 observed skill events/);
  assert.match(report, /MCP plugin ownership unknown: 1 observed calls/);
  assert.doesNotMatch(report, /known-project-skill.*observed use/);
});

test('plugin-use projection counts explicit plugin command calls across root and child actors', () => {
  const run = structuredClone(complete);
  run.coverage = { skillInvocationTelemetry: 'observed', tools: 'partial' };
  run.skillInvocations = [];
  run.toolInvocations = [
    { agentId: 'root', turnId: 't1', itemId: 'cmd-root', kind: 'command', toolName: 'plugin-script', pluginId: 'vendor.command' },
    { agentId: 'root', turnId: 't1', itemId: 'cmd-root', kind: 'command', toolName: 'plugin-script', pluginId: 'vendor.command' },
    { agentId: 'child', turnId: 't2', itemId: 'cmd-child', kind: 'command', toolName: 'plugin-script', pluginId: 'vendor.command' },
    { agentId: 'child', turnId: 't2', itemId: 'ordinary', kind: 'command', toolName: 'shell', pluginId: null },
    { agentId: 'child', turnId: 't2', itemId: 'independent-mcp', kind: 'mcp', toolName: 'read', pluginId: null },
  ];
  const report = renderAudit(run);
  assert.match(report, /vendor\.command · 2 observed uses/);
  assert.match(report, /plugin-command-call agent root turn t1/);
  assert.match(report, /plugin-command-call agent child turn t2/);
  assert.match(report, /MCP plugin ownership unknown: 1 observed calls/);
  assert.doesNotMatch(report, /Unknown plugin identity:.*shell/);
});

test('compares different scripts within one plugin without merging their call counts', () => {
  const left = { ...structuredClone(complete), coverage: { tools: 'observed' }, toolInvocations: [
    { agentId: 'root', turnId: 't1', itemId: 'script-a', kind: 'command', pluginId: 'official.plugin', toolName: 'command', scriptPath: 'scripts/check.py', status: 'completed' },
    { agentId: 'child', turnId: 't2', itemId: 'script-b', kind: 'command', pluginId: 'official.plugin', toolName: 'command', scriptPath: 'skills/review/scripts/audit.py', status: 'completed' },
  ] };
  const right = { ...structuredClone(left), toolInvocations: [left.toolInvocations[1]] };
  const comparison = compareAuditRuns(left, right);
  const counts = comparison.comparison.tools.counts;
  assert.equal(counts.length, 2);
  assert.deepEqual(counts.map(row => [row.identity.scriptPath, row.left, row.right, row.delta]).sort(), [
    ['scripts/check.py', 1, 0, -1], ['skills/review/scripts/audit.py', 1, 1, 0],
  ]);
  assert.match(renderAudit(comparison), /script scripts\/check\.py: 1 → 0/);
  assert.match(renderAudit(left), /script skills\/review\/scripts\/audit\.py/);
});

test('keeps metric deltas unknown and avoids percentage division by zero', () => {
  const left = { ...structuredClone(complete), metrics: { elapsedMs: 0, tokenTotal: null } };
  const right = { ...structuredClone(complete), metrics: { elapsedMs: 7, tokenTotal: 9 } };
  const result = compareAuditRuns(left, right);
  assert.equal(result.comparison.metrics.elapsedMs.delta, 7);
  assert.equal(result.comparison.metrics.elapsedMs.percentDelta, null);
  assert.equal(result.comparison.metrics.tokenTotal.status, 'unknown');
  assert.equal(result.comparison.metrics.tokenTotal.delta, null);
});

test('does not claim model or effort sets match when any turn observation is missing', () => {
  const left = structuredClone(complete);
  const right = structuredClone(complete);
  left.turns.push({ agentId: 'child', turnId: 't3', model: null, reasoningEffort: null, sourceLine: 15 });
  const result = compareAuditRuns(left, right);
  assert.equal(result.comparison.models.status, 'unknown');
  assert.deepEqual(result.comparison.models.left, ['model-a']);
  assert.equal(result.comparison.reasoningEfforts.status, 'unknown');
});

test('validates expected model and effort as a paired bounded plain-text input', () => {
  assert.throws(() => compareAuditRuns(complete, complete, { expectModel: 'x' }), /supplied together/);
  assert.throws(() => compareAuditRuns(complete, complete, { expectModel: 'x\u202e', expectEffort: 'high' }), /plain text/);
  assert.throws(() => compareAuditRuns(complete, complete, { expectModel: 'x'.repeat(257), expectEffort: 'high' }), /256 characters/);
  assert.throws(() => compareAuditRuns(complete, complete, { expectModel: 'model', expectEffort: 'x'.repeat(65) }), /64 characters/);
});

test('checks expectations on child turns and retains agent, turn, and source line', () => {
  const right = structuredClone(complete);
  right.turns[1].model = 'different-model';
  right.turns[1].reasoningEffort = 'low';
  right.coverage = Object.fromEntries(Object.keys(complete.coverage).map(key => [key, 'ready']));
  const left = structuredClone(complete);
  left.coverage = Object.fromEntries(Object.keys(complete.coverage).map(key => [key, 'ready']));
  const result = compareAuditRuns(left, right, { expectModel: 'model-a', expectEffort: 'high' });
  assert.equal(result.comparison.expectation.status, 'different');
  assert.deepEqual(result.comparison.expectation.mismatches.map(item => [item.side, item.agentId, item.turnId, item.sourceLine, item.field]), [
    ['right', 'child', 't2', 9, 'model'], ['right', 'child', 't2', 9, 'reasoningEffort'],
  ]);
  assert.match(renderAudit(result), /agent child · turn t2 · line 9/);
  assert.equal(auditExitCode(result), 3);
});

test('renders partial and missing sides without hiding usable evidence', () => {
  const missing = { kind: 'audit-run', id: 'missing', status: 'not-found', profile: { profileName: 'B' }, coverage: {} };
  const result = compareAuditRuns(complete, missing);
  const report = renderAudit(result);
  assert.match(report, /Left: A/);
  assert.match(report, /Right: B · missing · not-found/);
  assert.match(report, /unknown\/unavailable/);
  assert.equal(auditExitCode(result), 1);
  assert.equal(auditExitCode({ ...result, right: { ...missing, status: 'partial' } }), 2);
  assert.equal(auditExitCode({ ...result, right: { ...missing, status: 'unavailable' } }), 2);
});

test('sanitizes terminal controls, escapes Markdown fields, and bounds event output', () => {
  const run = structuredClone(complete);
  run.profile.profileName = 'safe\u001b[31m [link](javascript:bad)\u202e';
  run.events = Array.from({ length: 55 }, (_, i) => ({ kind: `event_${i}`, sourceLine: i + 1 }));
  run.events[0].metadata = { tool: 'Read', callId: 'call-1', itemType: 'command_execution', status: 'completed' };
  const terminal = renderAudit(run);
  assert.doesNotMatch(terminal, /\u001b|\u202e/);
  assert.match(terminal, /native-123/);
  assert.match(terminal, /client 1\.2\.3/);
  assert.match(terminal, /run-a/);
  assert.match(terminal, /tool=Read, callId=call-1, itemType=command_execution, status=completed/);
  assert.match(terminal, /additional events omitted \(of 55 total\)/);
  assert.match(renderAudit(run, { format: 'markdown' }), /\\\[link\\\]\\\(javascript:bad\\\)/);
});

test('renders broad setup resource comparison and preserves unavailable coverage', () => {
  const result = {
    kind: 'audit-profile-comparison',
    left: { profile: { profileName: 'A' }, coverage: { skills: 'partial' } },
    right: { profile: { profileName: 'B' }, coverage: { skills: 'ready' } },
    comparison: { resources: {
      added: [{ name: 'skill-x', category: 'skill', origin: 'system', status: 'present' }],
      removed: [], changed: [{ name: 'shared', category: 'agent', origin: 'user', path: '/home/.codex/agents/a.md',
        before: { version: '1', fingerprint: 'old' }, after: { version: '2', fingerprint: 'new' } }],
      unchanged: [], unavailable: [{ name: 'blocked', category: 'plugin', origin: 'plugin', path: '/plugins/x', status: 'unreadable',
        comparison: 'unverified-on-left', reason: 'The left inventory is incomplete.' }],
    } },
  };
  const report = renderAudit(result);
  assert.match(report, /skill-x · skill · system · present/);
  assert.match(report, /blocked · plugin · plugin · unreadable/);
  assert.match(report, /unverified-on-left/);
  assert.match(report, /The left inventory is incomplete/);
  assert.match(report, /Before: version=1, fingerprint=old/);
  assert.match(report, /After: version=2, fingerprint=new/);
  assert.match(report, /skills: partial/);
});

test('renders public setup values, event operations, and child source provenance', () => {
  const setup = {
    kind: 'audit-profile-comparison',
    left: { profile: { profileName: 'A' }, coverage: {} },
    right: { profile: { profileName: 'B' }, coverage: {} },
    comparison: { resources: { added: [], removed: [], unchanged: [], unavailable: [], changed: [
      { name: 'model', category: 'config', left: { value: 'model-a' }, right: { value: 'model-b' } },
    ] } },
  };
  const setupReport = renderAudit(setup);
  assert.match(setupReport, /value="model-a"/);
  assert.match(setupReport, /value="model-b"/);

  const run = structuredClone(complete);
  run.agents[1].source = { path: '/private/child.jsonl', fingerprint: 'child-fingerprint' };
  run.events = [{ kind: 'tool-call', agentId: 'child', turnId: 't2', sourceLine: 31,
    metadata: { tool: 'MCP', operations: ['search'], resourcePaths: ['docs/spec.md'] } }];
  const report = renderAudit(run);
  assert.match(report, /source \/private\/child\.jsonl · fingerprint child-fingerprint/);
  assert.match(report, /operations=\[search\]/);
  assert.match(report, /resourcePaths=\[docs\/spec\.md\]/);
});

test('compares usage totals from the per-scope totals envelope', () => {
  const left = { ...structuredClone(complete), usage: { status: 'ready', totals: { scope: 'selected-session-only', values: { inputTokens: 20 } } } };
  const right = { ...structuredClone(complete), usage: { status: 'ready', totals: { scope: 'selected-session-only', values: { inputTokens: 12 } } } };
  const result = compareAuditRuns(left, right);
  assert.equal(result.comparison.metrics.inputTokens.delta, -8);
});

test('compares only source-reported root token totals and preserves per-agent counters without summing', () => {
  const left = structuredClone(complete);
  const right = structuredClone(complete);
  left.source.threadId = 'root-left'; right.source.threadId = 'root-right';
  left.agents = [{ id: 'root-left', parentId: null, depth: 0 }, { id: 'child-left', parentId: 'root-left', depth: 1 }];
  right.agents = [{ id: 'root-right', parentId: null, depth: 0 }, { id: 'child-right', parentId: 'root-right', depth: 1 }];
  left.usage = {
    'root-left': { last: { inputTokens: 10 }, total: { inputTokens: 100, outputTokens: 20 }, snapshots: 3 },
    'child-left': { last: { inputTokens: 5 }, total: { inputTokens: 50 }, snapshots: 2 },
  };
  right.usage = {
    'root-right': { last: { inputTokens: 8 }, total: { inputTokens: 80, outputTokens: 25 }, snapshots: 4 },
    'child-right': { last: { inputTokens: 9 }, total: { inputTokens: 90 }, snapshots: 2 },
  };
  const result = compareAuditRuns(left, right);
  assert.equal(result.comparison.usage.scope, 'root-agent-source-reported');
  assert.equal(result.comparison.usage.deltas.inputTokens.delta, -20);
  assert.equal(result.comparison.usage.deltas.outputTokens.delta, 5);
  assert.equal(result.comparison.usage.workflowTotal, null);
  assert.equal(result.comparison.usage.workflowTotalStatus, 'unknown');
  assert.equal(result.comparison.usage.byAgent.left.length, 2);
  assert.equal(result.comparison.usage.byAgent.left.find(agent => agent.agentId === 'child-left').total.inputTokens, 50);
  const report = renderAudit(result);
  assert.match(report, /Root-session token comparison: source-reported · scope root-agent-source-reported/);
  assert.match(report, /Workflow-wide total: unknown/);
  assert.match(report, /Per-agent source counters:/);
  assert.doesNotMatch(report, /inputTokens[^\n]*150/);
  assert.equal(result.comparison.usage.workflow.status, 'unknown');
});

test('compares workflow totals only when the native accounting contract is validated', () => {
  const accounting = nativeUsageAccounting('0.163.0-alpha.10.2');
  const make = (inputTokens, outputTokens) => ({ ...structuredClone(complete), source: { ...complete.source, kind: 'native-app-server-v2',
      version: accounting.version, historyMode: 'paginated', freshThread: true },
    usage: { totals: { scope: 'selected-session-only', values: { inputTokens: 500 } },
    accounting, workflow: { status: 'partial', scope: 'captured-workflow-agents', reason: 'some agent fields unavailable',
      derivation: { method: 'sum-final-owned-thread-counters-once', basis: 'full-capture-before-export-bounds', agents: 2, turns: 4, observations: 4 },
      values: { inputTokens, outputTokens, cachedInputTokens: null, reasoningOutputTokens: 3, cacheWriteInputTokens: 1, totalTokens: null },
      fields: { inputTokens: { status: 'observed' }, outputTokens: { status: 'observed' }, cachedInputTokens: { status: 'partial' },
        reasoningOutputTokens: { status: 'observed' }, cacheWriteInputTokens: { status: 'observed' }, totalTokens: { status: 'partial' } } } } });
  const left = make(100, 40), right = make(80, null);
  const compared = compareAuditRuns(left, right);
  assert.equal(compared.comparison.usage.workflow.status, 'partial');
  assert.equal(compared.comparison.usage.workflow.fields.inputTokens.delta, -20);
  assert.equal(compared.comparison.usage.workflow.fields.outputTokens.delta, null);
  assert.equal(compared.comparison.usage.workflow.fields.outputTokens.status, 'unknown');
  assert.equal(compared.comparison.usage.workflowTotal, null);
  assert.match(renderAudit(left), /Workflow-wide total: partial · scope captured-workflow-agents/);
  assert.match(renderAudit(compared), /Workflow totals: partial · scope captured-workflow-agents/);
  assert.doesNotMatch(renderAudit(compared), /Workflow-wide total: unknown/);
  const unavailable = structuredClone(left);
  unavailable.usage.workflow.status = 'unavailable';
  unavailable.usage.workflow.reason = 'history-incomplete-after-reset';
  assert.match(renderAudit(unavailable), /history-incomplete-after-reset/);
  const unverified = structuredClone(right);
  unverified.usage.accounting.sourceRevision = 'other';
  assert.equal(compareAuditRuns(left, unverified).comparison.usage.workflow.status, 'unknown');
  const wrongSource = structuredClone(right);
  wrongSource.source.kind = 'native-rollout';
  assert.equal(compareAuditRuns(left, wrongSource).comparison.usage.workflow.status, 'unknown');
  assert.match(renderAudit(wrongSource), /Workflow-wide total: unknown/);
  const staleA = structuredClone(complete), staleB = structuredClone(complete);
  staleA.metrics['workflow.inputTokens'] = 300;
  staleB.metrics['workflow.inputTokens'] = 200;
  const staleComparison = compareAuditRuns(staleA, staleB);
  assert.equal(staleComparison.comparison.metrics['workflow.inputTokens'], undefined);
  assert.equal(staleComparison.comparison.usage.workflow.status, 'unknown');
});

test('reports safe hook observations and compares only uniquely aligned event evidence', () => {
  const make = (id, hookRunId, durationMs) => {
    const run = structuredClone(complete);
    run.id = id;
    run.coverage = { ...run.coverage, hooks: 'complete', agents: 'complete' };
    run.agents = [{ id: `root-${id}`, parentId: null, depth: 0, role: 'root' },
      { id: `worker-${id}`, parentId: `root-${id}`, depth: 1, role: 'review' }];
    run.turns = [{ agentId: `root-${id}`, turnId: `turn-${id}` }];
    run.hookInvocations = [{ agentId: `root-${id}`, turnId: `turn-${id}`, hookRunId, eventName: 'preToolUse',
      scope: 'turn', sourceKind: 'project', handlerType: 'command', executionMode: 'sync', status: 'completed',
      startedAtSeconds: 10, completedAtSeconds: 11, durationMs, source: 'hook/completed', sourceLine: 44,
      sourcePath: '/PRIVATE/SECRET', output: 'PRIVATE_OUTPUT', statusMessage: 'PRIVATE_MESSAGE' }];
    return run;
  };
  const left = make('left', 'hook-left', 5), right = make('right', 'hook-right', 8);
  const comparison = compareAuditRuns(left, right);
  assert.equal(comparison.comparison.hooks.status, 'recorded-observations-comparable');
  assert.equal(comparison.comparison.hooks.counts[0].delta, 0);
  assert.equal(comparison.comparison.hooks.counts[0].identity.agentRole, 'root');
  const report = renderAudit(comparison);
  assert.match(report, /Hook invocations: observed/);
  assert.match(report, /Hook comparison: recorded-observations-comparable/);
  assert.doesNotMatch(report, /PRIVATE|SECRET/);

  left.hookInvocations[0].turnId = null;
  left.hookInvocations[0].scope = 'thread';
  right.hookInvocations[0].turnId = null;
  right.hookInvocations[0].scope = 'thread';
  assert.equal(compareAuditRuns(left, right).comparison.hooks.counts[0].identity.turnOrdinal, null);
});

test('reports and compares only verified whole-turn usage, keeping response last separate', () => {
  const contract = nativeUsageAccounting('0.163.0-alpha.10.2');
  let turnComparison;
  const make = (id, turnTotal) => {
    const run = structuredClone(complete);
    run.source = { kind: 'native-app-server-v2', threadId: `root-${id}`, version: contract.version,
      historyMode: contract.historyMode, freshThread: contract.freshThread };
    run.agents = [{ id: `root-${id}`, parentId: null, depth: 0, role: 'root' }];
    run.turns = [{ agentId: `root-${id}`, turnId: `turn-${id}` }];
    run.usage = { accounting: contract, observations: [
      { source: 'thread/tokenUsage/updated', sourceLine: 10, agentId: `root-${id}`, turnId: `turn-${id}`, last: { inputTokens: 12 }, total: { inputTokens: turnTotal } },
      { source: 'thread/tokenUsage/updated', sourceLine: 11, agentId: `root-${id}`, turnId: `turn-${id}`, last: { inputTokens: 3 }, total: { inputTokens: turnTotal } },
    ], turns: { status: 'complete', scope: 'captured-owned-thread-turns', reason: null, contract,
      turns: [{ agentId: `root-${id}`, turnId: `turn-${id}`, status: 'complete', values: { inputTokens: turnTotal,
        outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, cacheWriteInputTokens: 0, totalTokens: turnTotal },
        fields: Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens'].map(field => [field, { status: 'observed' }])) }],
      derivation: { method: 'difference-cumulative-thread-boundaries' } } };
    return run;
  };
  const left = make('a', 20), right = make('b', 15);
  const compared = compareAuditRuns(left, right);
  assert.equal(compared.comparison.usage.turns.status, 'complete');
  assert.equal(compared.comparison.usage.turns.fields.inputTokens[0].delta, -5);
  const report = renderAudit(compared);
  assert.match(report, /Verified whole-turn comparison: complete/);
  assert.match(report, /Verified whole-turn totals: complete/);
  assert.match(report, /last.*inputTokens.*3/);

  const unverified = structuredClone(right);
  unverified.source.kind = 'native-rollout';
  assert.equal(compareAuditRuns(left, unverified).comparison.usage.turns.status, 'unknown');
  assert.match(renderAudit(unverified), /Verified whole-turn totals: unknown/);

  const frozenChildLeft = structuredClone(left), frozenChildRight = structuredClone(right);
  for (const [run, childTokens] of [[frozenChildLeft, 9], [frozenChildRight, 6]]) {
    const root = run.agents[0];
    const childId = `child-${run.id}`;
    const childTurnId = `child-turn-${run.id}`;
    run.agents.push({ id: childId, parentId: root.id, depth: 1, role: 'review' });
    run.turns.push({ agentId: childId, turnId: childTurnId });
    run.usage.turns.turns.push({ agentId: childId, turnId: childTurnId, status: 'complete',
      values: { inputTokens: childTokens }, fields: { inputTokens: { status: 'observed' } } });
  }
  turnComparison = compareAuditRuns(frozenChildLeft, frozenChildRight).comparison.usage.turns;
  assert.equal(turnComparison.status, 'complete', 'frozen child roles and ordinals support unambiguous pairing');
  assert.equal(turnComparison.fields.inputTokens.find(row => row.roleAndOrdinal === 'root/review · turn 0').delta, -3);

  const ambiguousLeft = structuredClone(left), ambiguousRight = structuredClone(right);
  for (const run of [ambiguousLeft, ambiguousRight]) {
    const root = run.agents[0];
    run.agents = [root, { id: `child-a-${run.id}`, parentId: root.id, depth: 1, role: 'worker' },
      { id: `child-b-${run.id}`, parentId: root.id, depth: 1, role: 'worker' }];
    run.turns = [{ agentId: root.id, turnId: `root-turn-${run.id}` },
      { agentId: run.agents[1].id, turnId: `child-turn-a-${run.id}` },
      { agentId: run.agents[2].id, turnId: `child-turn-b-${run.id}` }];
    run.usage.turns.turns[0].turnId = run.turns[0].turnId;
    run.usage.turns.turns[0].agentId = root.id;
    run.usage.turns.turns.push(...run.turns.slice(1).map((turn, index) => ({ ...turn, status: 'complete',
      values: { inputTokens: index + 2 }, fields: { inputTokens: { status: 'observed' } } })));
  }
  turnComparison = compareAuditRuns(ambiguousLeft, ambiguousRight).comparison.usage.turns;
  assert.equal(turnComparison.status, 'partial', 'duplicate sibling roles cannot be uniquely aligned');
  assert.equal(turnComparison.fields.inputTokens[0].delta, -5, 'the uniquely aligned root delta remains useful');

  const omittedLeft = structuredClone(left), omittedRight = structuredClone(right);
  omittedLeft.usage.turns.turnsOmitted = 1;
  turnComparison = compareAuditRuns(omittedLeft, omittedRight).comparison.usage.turns;
  assert.equal(turnComparison.status, 'partial', 'precomputed summaries with omitted turns are not complete comparisons');
  assert.equal(turnComparison.fields.inputTokens[0].delta, -5, 'retained verified turn pairs still have a scoped delta');

  const invalidField = structuredClone(right);
  invalidField.usage.turns.turns[0].fields.inputTokens.status = 'invalid';
  turnComparison = compareAuditRuns(left, invalidField).comparison.usage.turns;
  assert.equal(turnComparison.fields.inputTokens[0].delta, null, 'numeric values with invalid field evidence do not yield a delta');
});

test('uses app-server threadId and version as native source provenance fallbacks', () => {
  const run = structuredClone(complete);
  run.source = { kind: 'native-app-server-v2', threadId: 'thread-9', version: '2.1.0' };
  const report = renderAudit(run);
  assert.match(report, /Native session: thread-9 · client 2\.1\.0/);
});

test('renders a bounded experiment preview without task text or commands', () => {
  const preview = {
    kind: 'audit-experiment-preview', status: 'ready',
    baseline: { repository: '/work/repo', commit: 'abc123', tree: 'tree456' },
    profiles: [{ profileName: 'Default', profileId: 'profile-1', home: '/private/codex', executable: '/usr/bin/codex', version: '1.2', status: 'ready', busy: false }],
    limits: { timeoutMs: 900000, maxRuns: 2 },
    setup: [{ name: 'dependencies', command: 'SECRET_SETUP_COMMAND' }],
    checks: [{ name: 'tests', argv: ['SECRET_TEST_COMMAND'] }],
    warnings: ['capture will be partial'],
    failures: [{ scope: 'profile', profile: 'Default', code: 'profile-busy', message: 'The profile is already in use.', argv: ['PRIVATE_ARG'] }],
    capture: { status: 'partial', capabilities: { sessionEvents: true }, errors: [{ code: 'skill-read-not-observable', agentId: 'root' }] },
  };
  const rendered = renderAudit(preview);
  assert.match(rendered, /Baseline: \/work\/repo · commit abc123/);
  assert.match(rendered, /Default · ID profile-1/);
  assert.match(rendered, /timeoutMs/);
  assert.match(rendered, /dependencies/);
  assert.match(rendered, /skill-read-not-observable/);
  assert.match(rendered, /profile-busy/);
  assert.match(rendered, /already in use/);
  assert.doesNotMatch(rendered, /SECRET_SETUP_COMMAND|SECRET_TEST_COMMAND|PRIVATE_ARG/);
  assert.equal(auditExitCode(preview), 0);
});

test('renders experiment reports with process, verification, capture, workspace, and M1 evidence', () => {
  const run = structuredClone(complete);
  run.profile.profileName = 'Research'; run.id = 'run-real';
  run.execution = { status: 'complete', exitCode: 0, elapsedMs: 1250, argv: ['SECRET_ARGV'] };
  run.outcome.checks = [{ name: 'tests', status: 'passed', exitCode: 0, durationMs: 400, command: 'SECRET_CHECK' }];
  run.capture = { status: 'partial', capabilities: { nativeEvents: true }, errors: [{ code: 'root-token-missing', origin: 'primary' }],
    byAgent: [{ agentId: 'child', status: 'complete' }], byOrigin: [{ origin: 'plugin', status: 'partial' }] };
  run.workspace = { taskEnd: { status: 'captured', path: '/work/repo', tree: 'tree-a', dirty: true },
    checkEnd: { status: 'captured', path: '/work/repo', tree: 'tree-b', dirty: false } };
  run.setupSnapshot = { status: 'captured', fingerprint: 'setup-hash', config: { secret: 'SECRET_CONFIG' } };
  run.artifacts = [{ kind: 'patch', path: 'src/file.js' }];
  const report = { kind: 'audit-experiment-report', id: 'experiment-id', status: 'complete', baseline: { repository: '/work/repo', commit: 'abc123', tree: 'tree456' },
    runs: [run], comparisons: [compareAuditRuns(complete, run)], execution: { elapsedMs: 1400, status: 'complete', exitCode: 0 },
    coverage: { execution: 'complete', capture: 'partial' }, warnings: [] };
  const rendered = renderAudit(report, { format: 'markdown' });
  for (const expected of ['Research', 'Process:', 'Verification checks:', 'tests: passed', 'Capture evidence: partial',
    'Workspace snapshots:', 'Tool counts']) assert.ok(rendered.includes(expected), `expected report to include ${expected}`);
  assert.match(rendered, /experiment\\-id/);
  assert.match(rendered, /root\\-token\\-missing/);
  assert.match(rendered, /tree\\-a/);
  assert.match(rendered, /src\/file\\.js/);
  assert.doesNotMatch(rendered, /SECRET_ARGV|SECRET_CHECK|SECRET_CONFIG/);
});

test('renders recovery and cleanup actions and derives experiment exit precedence', () => {
  const lifecycle = { kind: 'audit-experiment-recovery', id: 'exp-1', status: 'blocked', reason: { kind: 'incomplete-evidence', message: 'manual review' },
    actions: [{ kind: 'reservation-retained', reason: 'owner cannot be verified', path: '/private/run.lock' }],
    runs: [{ id: 'run-1', status: 'interrupted', profile: { profileName: 'A' }, execution: { status: 'unknown' } }], warnings: ['workspace retained'] };
  const rendered = renderAudit(lifecycle);
  assert.match(rendered, /reservation-retained/);
  assert.match(rendered, /run-1/);
  assert.equal(auditExitCode(lifecycle), 2, 'incomplete evidence is an incomplete audit result');
  assert.equal(auditExitCode({ ...lifecycle, exitCode: 2 }), 2);

  const report = { kind: 'audit-experiment-report', status: 'timeout', exitCode: 0, runs: [], coverage: {} };
  assert.equal(auditExitCode(report), 124);
  assert.equal(auditExitCode({ ...report, status: 'cancelled' }), 130);
  assert.equal(auditExitCode({ ...report, status: 'complete', strictFailure: true, exitCode: 0 }), 4);
  assert.equal(auditExitCode({ ...report, status: 'partial', exitCode: 0 }), 2);
  assert.equal(auditExitCode({ ...report, status: 'complete', coverage: { execution: 'complete', capture: 'complete' }, exitCode: 99 }), 0);
  assert.equal(auditExitCode({ ...report, status: 'complete', coverage: { execution: 'complete', capture: 'partial' } }), 2);
  assert.equal(auditExitCode({ ...report, status: 'blocked', reason: { kind: 'coverage' } }), 2);
});

test('compares recorded behavior, artifacts, agents, and outcome evidence without scoring quality', () => {
  const left = structuredClone(complete);
  const right = structuredClone(complete);
  for (const run of [left, right]) run.coverage = Object.fromEntries(Object.keys(run.coverage).map(key => [key, 'ready']));
  left.events = [{ kind: 'tool-call', agentId: 'root', turnId: 't1', sourceLine: 17, metadata: { tool: 'Read' } }];
  right.events = [
    { kind: 'tool-call', agentId: 'root', turnId: 't1', sourceLine: 18, metadata: { tool: 'Read' } },
    { kind: 'tool-call', agentId: 'child', turnId: 't2', sourceLine: 21, metadata: { tool: 'Write', callId: 'w-1' } },
    { kind: 'tool-error', agentId: 'child', turnId: 't2', sourceLine: 22, metadata: { tool: 'Write', callId: 'w-1', error: true } },
  ];
  left.artifacts = [{ kind: 'recorded-file-change', path: 'a.txt', status: 'added', agentId: 'root', turnId: 't1', sourceLine: 20 }];
  right.artifacts = [{ kind: 'recorded-file-change', path: 'b.txt', status: 'added', agentId: 'child', turnId: 't2', sourceLine: 23 }];
  left.outcome = { status: 'claim-recorded', claim: { success: true, status: 'completed', agentId: 'root', turnId: 't1', sourceLine: 25 }, checks: [{ name: 'tests', status: 'passed', sourceLine: 26 }] };
  right.outcome = { status: 'claim-recorded', claim: { success: false, status: 'failed', agentId: 'root', turnId: 't1', sourceLine: 28 }, checks: [{ name: 'tests', status: 'failed', sourceLine: 29 }] };
  right.usage = { status: 'partial', totals: null, byAgent: [{ agentId: 'child', totals: { scope: 'child-session', values: { input_tokens: 14 } } }] };
  const result = compareAuditRuns(left, right);
  assert.equal(result.comparison.behavior.countDelta, 2);
  assert.equal(result.comparison.behavior.tools.Read.delta, 0);
  assert.equal(result.comparison.behavior.tools.Write.delta, 1);
  assert.equal(result.comparison.agents.left.childCount, 1);
  assert.equal(result.comparison.artifacts.status, 'known');
  assert.deepEqual(result.comparison.artifacts.added.map(item => item.path), ['b.txt']);
  assert.deepEqual(result.comparison.artifacts.removed.map(item => item.path), ['a.txt']);
  assert.equal(result.comparison.outcomes.claimStatus, 'different');
  const report = renderAudit(result);
  assert.match(report, /Event kind counts/);
  assert.match(report, /Tool counts/);
  assert.match(report, /Recorded outcome evidence/);
  assert.match(report, /child-session/);
  assert.match(report, /input_tokens/);
  assert.match(report, /do not establish task quality or a winner/);
});

test('reports normalized tool and MCP runtime evidence with coverage-aware identity deltas', () => {
  const left = structuredClone(complete), right = structuredClone(complete);
  left.coverage = { ...left.coverage, tools: 'ready', mcp: 'ready' };
  right.coverage = { ...right.coverage, tools: 'partial', mcp: 'ready' };
  left.toolInvocations = [{ agentId: 'root', turnId: 't1', itemId: 'item-a', kind: 'mcp', server: 'docs',
    pluginId: 'vendor.docs', namespace: 'search', tool: 'query', status: 'completed', success: true,
    durationMs: 18, startedAtMs: 10, completedAtMs: 28, source: 'native', sourceLine: 41,
    arguments: 'SECRET_ARGS', result: 'SECRET_RESULT', error: 'SECRET_ERROR' }];
  right.toolInvocations = [{ agentId: 'child', turnId: 't2', itemId: 'item-b', kind: 'mcp', server: 'docs',
    pluginId: 'vendor.docs', namespace: 'search', tool: 'query', status: 'failed', error: true,
    durationMs: 25, source: 'native', sourceLine: 52, arguments: 'OTHER_SECRET' },
  { agentId: 'child', kind: 'dynamic', tool: 'lookup', status: 'completed' }];
  left.mcp = { inventory: 'not-requested', servers: [{ name: 'docs', pluginId: 'vendor.docs', status: 'ready', source: 'config', sourceLine: 7,
    definition: 'SECRET_DEFINITION' }] };
  right.mcp = { servers: [{ name: 'docs', pluginId: 'vendor.docs', status: 'ready', source: 'config', sourceLine: 8 }] };

  const result = compareAuditRuns(left, right);
  const report = renderAudit(result);
  const runReport = renderAudit(left);
  assert.equal(result.comparison.tools.status, 'partial-or-unknown');
  assert.equal(result.comparison.tools.counts.find(row => row.identity.toolName === 'query').delta, null);
  assert.equal(result.comparison.mcp.status, 'known');
  assert.equal(result.comparison.mcp.counts[0].delta, 0);
  assert.match(runReport, /Calls by agent:/);
  assert.match(runReport, /18 ms across 1 timed calls/);
  assert.match(runReport, /MCP runtime usage: 1 observed calls/);
  assert.match(runReport, /inventory not-requested/);
  assert.match(report, /Tool invocation comparison: partial-or-unknown/);
  assert.match(report, /delta unknown \(partial-or-unknown\)/);
  assert.match(report, /MCP runtime comparison: known/);
  assert.doesNotMatch(`${report}\n${runReport}`, /SECRET_ARGS|SECRET_RESULT|SECRET_ERROR|SECRET_DEFINITION|OTHER_SECRET/);
});

test('keeps tool and MCP absence unknown without coverage and labels legacy timeline fallback', () => {
  const run = structuredClone(complete);
  run.toolInvocations = undefined;
  run.mcp = undefined;
  run.coverage = { timeline: 'ready' };
  const report = renderAudit(run);
  assert.match(report, /Tool\/MCP runtime evidence: tools unknown/);
  assert.match(report, /Legacy event fallback: complete/);
  assert.match(report, /MCP runtime usage: 0 observed calls · call coverage unknown/);
  assert.match(report, /MCP server observations unavailable/);
  const comparison = compareAuditRuns(run, structuredClone(run)).comparison;
  assert.equal(comparison.tools.status, 'partial-or-unknown');
  assert.equal(comparison.mcp.status, 'partial-or-unknown');
});

test('reports best-effort native skill invocations separately from catalog identity and avoids forced matches', () => {
  const left = structuredClone(complete), right = structuredClone(complete);
  for (const run of [left, right]) {
    run.coverage.skillInvocationTelemetry = 'observed';
    run.skillTelemetry = { status: 'observed', delivery: 'best-effort',
      boundary: 'native skill invocation events only; best-effort detection and delivery; not exhaustive', warnings: [] };
  }
  left.skillInvocations = [{ agentId: 'child', turnId: 't2', skillName: 'review', scope: 'project', pluginId: 'plugin.review',
    invocationType: 'explicit', resolution: 'catalogued', candidateSkillIds: ['skill-review'], timestampNs: '123456789',
    path: '/SECRET/PATH' }];
  right.skillInvocations = [
    { agentId: 'child', turnId: 't2', skillName: 'review', scope: 'project', pluginId: 'plugin.review',
      invocationType: 'implicit', resolution: 'catalogued', candidateSkillIds: ['skill-review'] },
    { agentId: null, unattributedActorId: 'thread-unknown', reason: 'unknown-thread', skillName: 'private-skill', scope: null,
      pluginId: null, invocationType: 'explicit', resolution: 'ambiguous', candidateSkillIds: ['candidate-a', 'candidate-b'] },
    { agentId: null, unattributedActorId: 'thread-unknown', reason: 'unknown-thread', skillName: 'uncatalogued', scope: 'user',
      pluginId: null, invocationType: null, resolution: 'not-in-catalog' },
  ];
  const comparison = compareAuditRuns(left, right).comparison.skillInvocations;
  assert.equal(comparison.status, 'recorded-observations-comparable');
  assert.deepEqual(comparison.counts.map(row => [row.identity.skillName, row.identity.invocationType, row.left, row.right, row.delta]), [
    ['review', 'explicit', 1, 0, -1], ['review', 'implicit', 0, 1, 1],
  ]);
  assert.equal(comparison.incomplete.right.length, 2);
  assert.equal(comparison.incomplete.right.some(item => item.scope == null), true);
  const runReport = renderAudit(right);
  assert.match(runReport, /Native skill invocation telemetry: observed · delivery best\-effort/);
  assert.match(runReport, /Per-agent recorded invocations \(explicit \/ implicit \/ unknown type\)/);
  assert.match(runReport, /unattributed actor thread-unknown/);
  assert.match(runReport, /ambiguous · unattributed/);
  assert.match(runReport, /not-in-catalog/);
  const comparisonReport = renderAudit(compareAuditRuns(left, right));
  assert.match(comparisonReport, /review · scope project · provider plugin\.review · explicit/);
  assert.match(comparisonReport, /observations with incomplete identity \(counts not aligned\)/);
  assert.match(comparisonReport, /do not establish exhaustive detection or delivery/);
  assert.doesNotMatch(`${runReport}\n${comparisonReport}`, /SECRET\/PATH/);
});

test('compares plugin-less skill events only when catalog evidence resolves the same-agent non-plugin origin', () => {
  const left = structuredClone(complete), right = structuredClone(complete);
  for (const run of [left, right]) {
    run.coverage.skillInvocationTelemetry = 'observed';
    run.skillTelemetry = { status: 'observed', delivery: 'best-effort' };
    run.skills = [{ id: 'skill-project-review', name: 'review', origin: 'project', scope: 'project', provider: null,
      observations: [{ kind: 'native-invocation-observed', agentId: 'child', turnId: 't2' }] }];
  }
  left.skillInvocations = [{ agentId: 'child', turnId: 't2', skillId: 'skill-project-review', skillName: 'review', scope: 'project',
    pluginId: null, invocationType: 'explicit', resolution: 'catalogued' }];
  right.skillInvocations = [{ agentId: 'child', turnId: 't2', skillId: 'skill-project-review', skillName: 'review', scope: 'project',
    pluginId: null, invocationType: 'explicit', resolution: 'catalogued' }];
  let summary = compareAuditRuns(left, right).comparison.skillInvocations;
  assert.equal(summary.counts.length, 1);
  assert.equal(summary.counts[0].identity.provider, 'project');
  assert.equal(summary.counts[0].delta, 0, 'zero is a recorded-event count, not proof of no use');
  assert.equal(summary.incomplete.left.length, 0);

  left.skills[0].observations = [];
  summary = compareAuditRuns(left, right).comparison.skillInvocations;
  assert.equal(summary.incomplete.left.length, 1, 'without same-agent catalog evidence, null provider stays unresolved');
  assert.equal(summary.incomplete.left[0].nonPluginOrigin, null);
  assert.equal(summary.counts[0].left, 0, 'unresolved observations are not inserted as a matched identity');
  assert.match(renderAudit(compareAuditRuns(left, right)), /left observations with incomplete identity/);
});

test('distinguishes complete empty timelines from unavailable event evidence', () => {
  const empty = structuredClone(complete);
  empty.coverage.timeline = 'ready'; empty.events = [];
  const unavailable = structuredClone(complete);
  unavailable.coverage.timeline = 'unavailable'; unavailable.events = [];
  const result = compareAuditRuns(empty, unavailable);
  assert.equal(result.comparison.behavior.left.status, 'none-recorded');
  assert.equal(result.comparison.behavior.right.status, 'unknown');
  assert.equal(result.comparison.behavior.countDelta, null);
});

test('counts paired native tool items once and renders their safe metadata', () => {
  const run = structuredClone(complete);
  run.events = [
    { kind: 'item/started', agentId: 'root', turnId: 't1', itemId: 'item-1', itemType: 'mcpToolCall', toolName: 'search', sourceLine: 20 },
    { kind: 'item/completed', agentId: 'root', turnId: 't1', itemId: 'item-1', itemType: 'mcpToolCall', toolName: 'search', exitCode: 0, sourceLine: 21 },
  ];
  const compared = compareAuditRuns(run, structuredClone(run));
  assert.equal(compared.comparison.behavior.left.byTool.search, 1);
  assert.equal(compared.comparison.behavior.tools.search.left, 1);
  const rendered = renderAudit(run);
  assert.match(rendered, /itemType=mcpToolCall/);
  assert.match(rendered, /toolName=search/);
  assert.match(rendered, /exitCode=0/);
});

test('compares workspace snapshot fingerprints only against the same verified baseline', () => {
  const left = structuredClone(complete), right = structuredClone(complete);
  for (const run of [left, right]) {
    run.coverage.workspaceDiff = 'ready';
    run.sourceWorkspace = { directory: '/tmp/work-a', sourceCommit: 'commit-1', sourceTree: 'tree-1' };
    run.workspace = { taskEnd: { fingerprint: 'same', fileCount: 4, captureComplete: true, timing: 'task-end' }, checkEnd: { fingerprint: 'check-a', fileCount: 5 } };
  }
  right.sourceWorkspace.directory = '/tmp/work-b';
  right.workspace.taskEnd.fingerprint = 'changed';
  right.workspace.checkEnd.fingerprint = 'check-b';
  const comparison = compareAuditRuns(left, right).comparison.artifacts;
  assert.equal(comparison.snapshots.taskEnd.status, 'different');
  assert.equal(comparison.snapshots.checkEnd.status, 'different');
  assert.match(renderAudit(compareAuditRuns(left, right)), /taskEnd: different/);
  assert.match(renderAudit(compareAuditRuns(left, right)), /checkEnd: different/);
  delete right.sourceWorkspace.sourceTree;
  assert.equal(compareAuditRuns(left, right).comparison.artifacts.snapshots.taskEnd.status, 'unknown');
});

test('compares captured raw taskEnd evidence when the later workspace summary is absent', () => {
  const left = structuredClone(complete), right = structuredClone(complete);
  for (const run of [left, right]) run.sourceWorkspace = { sourceCommit: 'commit-1', sourceTree: 'tree-1' };
  left.taskEnd = { fingerprint: 'raw-a', baselineFingerprint: 'base-a', files: 40603, changedFileCount: 2, changeCountStatus: 'known',
    changeCountBasis: 'post-setup-snapshot-delta-v1', captureComplete: true, timing: 'task-end' };
  right.taskEnd = { fingerprint: 'raw-b', files: 40603, changedFileCount: 3, changeCountStatus: 'known',
    changeCountBasis: 'post-setup-snapshot-delta-v1', captureComplete: true, timing: 'task-end' };
  let snapshot = compareAuditRuns(left, right).comparison.artifacts.snapshots.taskEnd;
  assert.equal(snapshot.left.fileCount, 40603, 'normalize raw files inventory for comparison');
  assert.equal(snapshot.left.baselineFingerprint, 'base-a');
  assert.equal(snapshot.left.changedFileCount, 2);
  assert.equal(snapshot.changes.status, 'known');
  assert.equal(snapshot.changes.delta, 1);

  right.taskEnd.captureComplete = false;
  right.taskEnd.timing = 'after-process-fallback';
  snapshot = compareAuditRuns(left, right).comparison.artifacts.snapshots.taskEnd;
  assert.equal(snapshot.left.fileCount, 40603);
  assert.equal(snapshot.right.fileCount, 40603);
  assert.equal(snapshot.changes.status, 'unknown');
  assert.equal(snapshot.changes.delta, null, 'fallback timing and completeness are never inferred');
  assert.equal(snapshot.changes.reason, 'task-end-boundary-unverified');
});

test('keeps raw snapshot inventory separate from measured task changes in comparison and Markdown', () => {
  const left = structuredClone(complete), right = structuredClone(complete);
  for (const run of [left, right]) {
    run.coverage.workspaceDiff = 'ready';
    run.sourceWorkspace = { directory: '/tmp/work-a', sourceCommit: 'commit-1', sourceTree: 'tree-1' };
  }
  left.workspace = { taskEnd: { fingerprint: 'left-tree', fileCount: 40603, changedFileCount: 2,
    changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1', captureComplete: true, timing: 'task-end' } };
  right.workspace = { taskEnd: { fingerprint: 'right-tree', fileCount: 40604, changedFileCount: 3,
    changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1', captureComplete: true, timing: 'task-end' } };
  const comparison = compareAuditRuns(left, right);
  const snapshot = comparison.comparison.artifacts.snapshots.taskEnd;
  assert.equal(snapshot.status, 'different', 'fingerprint and raw inventory comparison remains intact');
  assert.equal(snapshot.left.fileCount, 40603);
  assert.equal(snapshot.left.changedFileCount, 2);
  assert.deepEqual(snapshot.changes, { left: 2, right: 3, status: 'known', delta: 1,
    basis: 'post-setup-snapshot-delta-v1', reason: null });
  const markdown = renderAudit(comparison, { format: 'markdown' });
  assert.match(markdown, /snapshot files 40603/);
  assert.match(markdown, /task-changed files 2 \(known\)/);
  assert.match(markdown, /task-change delta known 1/);

  right.workspace.taskEnd.changedFileCount = null;
  right.workspace.taskEnd.changeCountStatus = 'unknown';
  right.workspace.taskEnd.changeCountBasis = 'post-setup-snapshot-delta-v1';
  right.workspace.taskEnd.changeCountReason = 'workspace-file-origin-changed';
  const diagnosed = compareAuditRuns(left, right).comparison.artifacts.snapshots.taskEnd.changes;
  assert.equal(diagnosed.status, 'unknown');
  assert.equal(diagnosed.delta, null);
  assert.equal(diagnosed.reason, 'workspace-file-origin-changed');

  delete right.workspace.taskEnd.changedFileCount;
  delete right.workspace.taskEnd.changeCountStatus;
  delete right.workspace.taskEnd.changeCountBasis;
  delete right.workspace.taskEnd.changeCountReason;
  const legacy = compareAuditRuns(left, right).comparison.artifacts.snapshots.taskEnd.changes;
  assert.equal(legacy.status, 'unknown');
  assert.equal(legacy.delta, null, 'legacy raw fileCount must not be treated as a task-change count');

  right.workspace.taskEnd = { fingerprint: 'fallback-tree', fileCount: 40603, changedFileCount: 2,
    changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1',
    captureComplete: false, timing: 'after-process-fallback' };
  const fallback = compareAuditRuns(left, right).comparison.artifacts.snapshots.taskEnd.changes;
  assert.equal(fallback.status, 'unknown');
  assert.equal(fallback.delta, null);
  assert.equal(fallback.reason, 'task-end-boundary-unverified');

  right.workspace.taskEnd = { fingerprint: 'same-timing-different-base', fileCount: 40603, changedFileCount: 4,
    changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1', captureComplete: true, timing: 'task-end' };
  right.sourceWorkspace.sourceTree = 'different-tree';
  const mismatchedBaseline = compareAuditRuns(left, right).comparison.artifacts.snapshots.taskEnd.changes;
  assert.equal(mismatchedBaseline.status, 'unknown');
  assert.equal(mismatchedBaseline.delta, null);
  assert.equal(mismatchedBaseline.reason, 'runs-do-not-share-verified-baseline');
});

test('retains distinct pathless workspace artifacts and their snapshot metadata', () => {
  const left = structuredClone(complete), right = structuredClone(complete);
  for (const run of [left, right]) run.coverage.workspaceDiff = 'ready';
  left.artifacts = [{ kind: 'workspace-snapshot', patchPath: '/tmp/a.patch', label: 'task-end', fingerprint: 'hash-a' }];
  right.artifacts = [{ kind: 'workspace-snapshot', patchPath: '/tmp/b.patch', label: 'task-end', fingerprint: 'hash-b' }];
  const result = compareAuditRuns(left, right);
  assert.equal(result.comparison.artifacts.added[0].patchPath, '/tmp/b.patch');
  assert.equal(result.comparison.artifacts.removed[0].fingerprint, 'hash-a');
  assert.match(renderAudit(result), /workspace-snapshot \/tmp\/b\.patch/);
});

test('aligns project skills by in-workspace logical path only on verified matching baseline', () => {
  const left = structuredClone(complete), right = structuredClone(complete);
  left.source = { workspace: '/tmp/a' }; right.source = { workspace: '/tmp/b' };
  for (const run of [left, right]) run.sourceWorkspace = { directory: run.source.workspace, sourceCommit: 'commit-1', sourceTree: 'tree-1' };
  left.skills = [
    { id: 'left-a', name: 'review', origin: 'repository', scope: 'project', provider: null, path: '/tmp/a/.codex/skills/review/SKILL.md', observations: [] },
    { id: 'left-nested', name: 'review', origin: 'repository', scope: 'project', path: '/tmp/a/agents/one/skills/review/SKILL.md', observations: [] },
    { id: 'left-outside', name: 'review', origin: 'user', scope: 'user', path: '/fixture/user/.codex/skills/review/SKILL.md', observations: [] },
  ];
  right.skills = [
    { id: 'right-a', name: 'review', origin: 'repository', scope: 'project', provider: null, path: '/tmp/b/.codex/skills/review/SKILL.md', observations: [] },
    { id: 'right-nested', name: 'review', origin: 'repository', scope: 'project', path: '/tmp/b/agents/two/skills/review/SKILL.md', observations: [] },
    { id: 'right-outside', name: 'review', origin: 'user', scope: 'user', path: '/fixture/user/.codex/skills/review/SKILL.md', observations: [] },
  ];
  const skills = compareAuditRuns(left, right).comparison.skills;
  assert.equal(skills.length, 5, 'logical project path matches once; different nested paths and user-origin skills remain distinct');
  const project = skills.find(skill => skill.left?.logicalPath === '.codex/skills/review/SKILL.md');
  assert.ok(project);
  assert.equal(project.left.path, '/tmp/a/.codex/skills/review/SKILL.md');
  assert.equal(project.right.path, '/tmp/b/.codex/skills/review/SKILL.md');
});

test('renders series quality, planned order, metric missingness, and evidence-linked comparisons safely', () => {
  const report = { schemaVersion: 1, kind: 'audit-series-report', id: 'series-1', status: 'partial', exitCode: 2,
    baseline: { commit: 'commit-1', tree: 'tree-1', repository: '/private/workspace' }, recipe: { fingerprint: 'recipe-fp' },
    plan: [{ index: 1, experimentId: 'exp-1', profileOrder: ['Alpha', 'Beta'], budgetMs: 1000 }],
    profiles: [{ profileId: 'a', profileName: 'Alpha', planned: 1, executed: 1,
      quality: { passed: 1, failed: 0, incomplete: 0, notRun: 0, passRate: 1, denominator: 1 }, execution: { counts: { partial: 1 } },
      metrics: { processElapsedMs: { unit: 'ms', scope: 'run', source: 'reported-run-metric', plannedN: 1, observedN: 0,
        missingN: 1, missingReasons: { 'field-unavailable-or-unproven': 1 }, median: null, iqr: null, min: null, max: null } } }],
    trials: [{ index: 1, experimentId: 'exp-1', status: 'partial', profileOrder: ['Alpha', 'Beta'], budgetMs: 1000,
      failures: [{ code: 'profile-reservation-failed' }], warnings: [{ code: 'final-report-write-failed' }],
      environment: { platform: 'darwin', cache: 'uncontrolled' }, profiles: [
        { profileName: 'Alpha', status: 'partial', run: { id: 'run-a' }, quality: { status: 'passed', definitionId: 'q', definitionVersion: '2', fingerprint: 'qfp',
          criteria: [{ kind: 'check', id: 'check:tests', required: true, status: 'passed', evidenceRefs: ['check:tests'] },
            { kind: 'check', id: 'check:lint', required: false, status: 'not-run', evidenceRefs: [], reason: 'Optional check was not requested.' }],
          rubric: { status: 'pending-review', rubricId: 'manual', rubricVersion: '1' } } },
        { profileName: 'Beta', status: 'not-started', run: null, quality: null },
      ] }],
    comparisons: [{ left: 'a', right: 'b', qualityDelta: null, metrics: { processElapsedMs: { leftMedian: null, rightMedian: 20, delta: null, reason: 'incomplete-series-capture' } },
      insights: [{ kind: 'observed-evidence', runIds: ['run-a'], observation: 'Recorded root model and tool counts.', limitation: 'No causal conclusion.' }] }],
    coverage: { plannedSlots: 1, capturedSlots: 1, missingSlots: 1 }, warnings: ['Partial capture; measurements omitted.'],
    task: 'PRIVATE_TASK_SENTINEL', argv: ['PRIVATE_ARGV_SENTINEL'], env: { SECRET: 'PRIVATE_ENV_SENTINEL' } };
  const rendered = renderAudit(report);
  for (const text of ['Alpha → Beta', 'budget 1000 ms', 'required · passed', 'optional · not-run', 'pending-review', 'N 0/1', 'missing 1', 'check:tests', 'run-a', 'Partial capture', 'Failure: profile-reservation-failed', 'Warning: final-report-write-failed']) assert.ok(rendered.includes(text), `missing ${text}`);
  assert.doesNotMatch(rendered, /PRIVATE_TASK_SENTINEL|PRIVATE_ARGV_SENTINEL|PRIVATE_ENV_SENTINEL|\/private\/workspace/);
  assert.equal(auditExitCode(report), 2);
  const markdown = renderAudit(report, { format: 'markdown' });
  assert.ok(markdown.includes('series\\-1'));
  const reviewed = structuredClone(report);
  reviewed.profiles[0].review = { rubricId: 'manual', rubricVersion: '1', median: 80, iqr: 0, scoredN: 1, reviewedN: 1, plannedN: 1, missingN: 0 };
  reviewed.trials[0].profiles[0].quality.rubric = { status: 'reviewed', result: 'passed', rubricId: 'manual', rubricVersion: '1', scorePercent: 80 };
  reviewed.trials[0].profiles[0].quality.review = { reviewer: 'fixture-reviewer', reviewedAt: '2026-10-16T12:00:00Z',
    ratings: [{ criterionId: 'correctness', score: 4, rationale: 'Result meets criteria.', evidenceRefs: ['run:run-a'] }] };
  reviewed.comparisons[0].metrics.processElapsedMs = { leftMedian: 10, rightMedian: 20, delta: 10, pairedN: 1, plannedN: 2, leftObservedN: 1, rightObservedN: 2, reason: 'incomplete-paired-measurements' };
  reviewed.comparisons[0].reviewDelta = { delta: null, pairedN: 0, plannedN: 2, reason: 'no-paired-scored-reviews' };
  assert.match(renderAudit(reviewed), /Human review: reviewed · result passed/);
  for (const text of ['median 80%', 'scored 1/1', 'Reviewer fixture-reviewer', 'Result meets criteria.', 'paired N 1/2', 'incomplete-paired-measurements', 'no-paired-scored-reviews']) assert.ok(renderAudit(reviewed).includes(text), `missing ${text}`);
});

test('renders series preview, evaluation report, and nested lifecycle actions', () => {
  const preview = { kind: 'audit-series-preview', status: 'ready', baseline: { commit: 'abc', tree: 'tree' },
    profiles: [{ profileName: 'Alpha', profileId: 'a', home: '/private/home', executable: '/usr/bin/codex', status: 'ready' }],
    limits: { timeoutMs: 1000 }, setup: [], checks: [{ name: 'tests', argv: ['PRIVATE_COMMAND'] }], warnings: [],
    plannedRuns: 4, budgetMs: 4000, schedule: { profileOrder: ['Alpha', 'Beta'], budgetMs: 1000, command: 'PRIVATE_SCHEDULE' },
    quality: { id: 'q', version: '2', checks: [{ name: 'tests', argv: ['PRIVATE_QUALITY'] }], rubric: { id: 'manual', version: '1' } } };
  assert.match(renderAudit(preview), /4 planned runs/);
  assert.doesNotMatch(renderAudit(preview), /PRIVATE_COMMAND|PRIVATE_SCHEDULE|PRIVATE_QUALITY/);
  assert.equal(auditExitCode(preview), 0);
  assert.equal(auditExitCode({ ...preview, status: 'blocked' }), 1);
  const evaluation = { kind: 'audit-evaluation-report', id: 'eval-1', source: { seriesId: 'series-1' }, reviewMethod: 'human-rubric-v1', status: 'complete', exitCode: 0,
    series: { kind: 'audit-series-report', id: 'series-1', status: 'complete', profiles: [], plan: [], trials: [], comparisons: [], warnings: [] } };
  assert.match(renderAudit(evaluation), /human-rubric-v1/);
  const lifecycle = { kind: 'audit-series-recovery', id: 'series-1', status: 'partial', exitCode: 2, warnings: ['retained'],
    actions: [{ experimentId: 'exp-1', status: 'recovered', actions: [{ kind: 'state-restored', reason: 'verified receipt' }] }] };
  assert.match(renderAudit(lifecycle), /state-restored/);
  assert.equal(auditExitCode(lifecycle), 2);
});

test('exports and reopens frozen series and evaluation reports with Markdown sidecars', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-audit-series-render-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = { schemaVersion: 1, kind: 'audit-series-report', id: 'series-frozen', status: 'complete', exitCode: 0,
    plan: [], trials: [], profiles: [], comparisons: [], warnings: [] };
  const output = join(directory, 'series.md');
  const receipt = await exportAuditReport(value, { output, format: 'markdown' });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened, value);
  assert.match(await readFile(output, 'utf8'), /Audit series/);
  const evaluation = { schemaVersion: 1, kind: 'audit-evaluation-report', id: 'evaluation-frozen', status: 'complete', exitCode: 0, source: {}, series: value };
  const evaluationPath = join(directory, 'evaluation.json');
  const evalReceipt = await exportAuditReport(evaluation, { output: evaluationPath });
  assert.deepEqual(await readAuditReport(evalReceipt.evidencePath), evaluation);
});

test('frozen series Markdown keeps bounded hooks and verified turn totals after detail compaction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-audit-frozen-hooks-turns-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contract = nativeUsageAccounting('0.163.0-alpha.10.2');
  const run = { id: 'frozen-run', source: { kind: 'native-app-server-v2', threadId: 'root', version: contract.version,
      historyMode: contract.historyMode, freshThread: contract.freshThread }, coverage: { hooks: 'partial' },
    hookInvocations: [{ agentId: 'root', turnId: null, hookRunId: 'hook-1', eventName: 'sessionStart', scope: 'thread',
      sourceKind: 'project', handlerType: 'command', executionMode: 'sync', status: 'completed', startedAtSeconds: 10,
      completedAtSeconds: 11, durationMs: 1000, source: 'hook/completed', sourceLine: null,
      output: 'PRIVATE_OUTPUT', sourcePath: '/PRIVATE/PATH' }],
    usage: { accounting: contract, turns: { status: 'complete', scope: 'captured-owned-thread-turns', contract,
      turns: [{ agentId: 'root', turnId: 'turn-1', status: 'complete', values: { inputTokens: 7, outputTokens: 2 },
        fields: { inputTokens: { status: 'observed' }, outputTokens: { status: 'observed' } },
        derivation: { method: 'difference-cumulative-thread-boundaries', initialBaseline: 'verified-fresh-thread-zero',
          sourceObservations: [{ source: 'thread/tokenUsage/updated', sourceLine: 5 }], sourceObservationsOmitted: 3 } }],
      turnsOmitted: 2, revalidation: 'detail-omitted-after-precomputation' } } };
  const value = { schemaVersion: 1, kind: 'audit-series-report', id: 'series-frozen-evidence', status: 'complete',
    trials: [{ index: 1, status: 'complete', profiles: [{ profileName: 'A', status: 'complete', run }] }], profiles: [], comparisons: [] };
  const output = join(directory, 'frozen.md');
  const receipt = await exportAuditReport(value, { output, format: 'markdown' });
  const markdown = await readFile(output, 'utf8');
  assert.match(markdown, /sessionStart · project · thread · command \/ sync/);
  assert.match(markdown, /Verified turn totals complete · 1 retained · 2 omitted · detail\\-omitted\\-after\\-precomputation/);
  assert.match(markdown, /\"inputTokens\":7/);
  assert.match(markdown, /sourceObservationsOmitted\":3/);
  assert.doesNotMatch(markdown, /PRIVATE/);
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.equal(Object.hasOwn(reopened.trials[0].profiles[0].run, 'resourceProvenance'), false);
  assert.match(markdown, /Resource provenance: unavailable/);
});

test('instruction source reporting is private, agent-scoped, and comparisons preserve unknowns', async t => {
  const id = n => `sha256:${String(n).repeat(64)}`;
  const make = (profile, instructionSources, coverage = 'observed') => ({ ...structuredClone(complete), profileName: profile,
    agents: [{ id: 'root', role: 'root', depth: 0 }, { id: 'child', role: 'review', parentId: 'root', depth: 1 }],
    coverage: { instructions: coverage }, instructionSources });
  const left = make('A', [
    { agentId: 'root', status: 'reported-empty', source: 'thread/start', phase: 'before-task', sourceLine: 2, reportedCount: 0, sources: [], omittedCount: 0, rejectedCount: 0, reason: null },
    { agentId: 'child', status: 'reported', source: 'thread/resume-loaded', phase: 'after-task', sourceLine: 7, reportedCount: 1,
      sources: [{ id: id('a'), origin: 'repository', name: 'AGENTS.md', path: '/SECRET/INSTRUCTION/PATH', body: 'SECRET_BODY' }], omittedCount: 0, rejectedCount: 0, reason: null }]);
  const right = make('B', [
    { agentId: 'root', status: 'reported-empty', source: 'thread/start', phase: 'before-task', sourceLine: 3, reportedCount: 0, sources: [], omittedCount: 0, rejectedCount: 0, reason: null },
    { agentId: 'child', status: 'reported', source: 'thread/resume-loaded', phase: 'after-task', sourceLine: 8, reportedCount: 1,
      sources: [{ id: id('b'), origin: 'profile', name: 'instruction-file' }], omittedCount: 0, rejectedCount: 0, reason: null }]);
  const markdown = renderAudit(left, { format: 'terminal' });
  assert.match(markdown, /reported-empty/);
  assert.match(markdown, /does not establish that their contents were followed/);
  assert.doesNotMatch(markdown, /SECRET|PRIVATE_TASK_SENTINEL/);
  const comparison = compareAuditRuns(left, right).comparison.instructionSources;
  assert.equal(comparison.roles.find(row => row.rolePath === 'root/review').status, 'different');
  assert.equal(comparison.roles.find(row => row.rolePath === 'root').status, 'match');
  const missing = make('B', [left.instructionSources[0]], 'partial');
  assert.equal(compareAuditRuns(left, missing).comparison.instructionSources.roles.find(row => row.rolePath === 'root/review').status, 'unknown');
  const directory = await mkdtemp(join(tmpdir(), 'xfx-audit-instructions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = await exportAuditReport(compareAuditRuns(left, right), { output: join(directory, 'comparison.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened.left.instructionSources[1].sources[0], { id: id('a'), origin: 'repository', name: 'AGENTS.md' });
  assert.doesNotMatch(JSON.stringify(reopened), /SECRET|SECRET_BODY/);
});

test('instruction comparisons align hierarchical role paths and surface ambiguous or unavailable actors', () => {
  const source = (agentId, char) => ({ agentId, status: 'reported-empty', source: agentId === 'root' ? 'thread/start' : 'thread/resume-loaded',
    phase: agentId === 'root' ? 'before-task' : 'after-task', sourceLine: 1, reportedCount: 0, sources: [], omittedCount: 0, rejectedCount: 0, reason: null });
  const makeTree = prefix => {
    const agents = [{ id: 'root', role: 'root', depth: 0 }, { id: `${prefix}-child`, role: 'review', parentId: 'root', depth: 1 },
      { id: `${prefix}-grand`, role: 'review', parentId: `${prefix}-child`, depth: 2 }];
    return { agents, coverage: { instructions: 'observed' }, instructionSources: agents.map((agent, index) => source(agent.id, String(index))) };
  };
  const hierarchicalReport = compareAuditRuns(makeTree('left'), makeTree('right'));
  const hierarchical = hierarchicalReport.comparison.instructionSources;
  assert.equal(hierarchical.status, 'comparable');
  assert.deepEqual(hierarchical.roles.map(row => row.rolePath), ['root', 'root/review', 'root/review/review']);
  assert.match(renderAudit(hierarchicalReport), /root\/review\/review: match/);

  const ambiguous = prefix => ({ agents: [{ id: 'root', depth: 0 }, { id: `${prefix}-one`, role: 'worker', parentId: 'root', depth: 1 },
    { id: `${prefix}-two`, role: 'worker', parentId: 'root', depth: 1 }], coverage: { instructions: 'observed' },
  instructionSources: ['root', `${prefix}-one`, `${prefix}-two`].map((agentId, index) => source(agentId, String(index))) });
  const ambiguousResult = compareAuditRuns(ambiguous('left'), ambiguous('right')).comparison.instructionSources;
  assert.equal(ambiguousResult.status, 'partial-or-unknown');
  assert.deepEqual(ambiguousResult.unalignedAgents, { left: 2, right: 2 });

  const legacy = { agents: [{ id: 'root', depth: 0 }] };
  const legacyComparison = compareAuditRuns(legacy, legacy).comparison.instructionSources;
  assert.equal(legacyComparison.left.status, 'unavailable');
  assert.equal(legacyComparison.status, 'partial-or-unknown');
  const unavailableRow = { ...legacy, coverage: { instructions: 'observed' }, instructionSources: [
    { agentId: 'root', status: 'unavailable', source: 'thread/start', phase: 'before-task', sourceLine: null, reportedCount: null, sources: [], omittedCount: 0, rejectedCount: 0, reason: 'field-unavailable' }] };
  assert.equal(compareAuditRuns(unavailableRow, unavailableRow).comparison.instructionSources.left.status, 'unavailable');
});

test('instruction comparison preserves reported order and duplicate-source counts', () => {
  const id = digit => `sha256:${digit.repeat(64)}`;
  const runWith = (sourceIds, reportedCount = sourceIds.length) => ({ agents: [{ id: 'root', depth: 0 }], coverage: { instructions: 'observed' },
    instructionSources: [{ agentId: 'root', status: 'reported', source: 'thread/start', phase: 'before-task', sourceLine: 1,
      reportedCount, sources: sourceIds.map(sourceId => ({ id: sourceId, origin: 'repository', name: 'AGENTS.md' })),
      omittedCount: 0, rejectedCount: 0, reason: null }] });
  const reordered = compareAuditRuns(runWith([id('1'), id('2')]), runWith([id('2'), id('1')])).comparison.instructionSources;
  assert.equal(reordered.roles[0].status, 'different');
  const repeated = compareAuditRuns(runWith([id('1'), id('1')], 2), runWith([id('1')], 1)).comparison.instructionSources;
  assert.equal(repeated.roles[0].status, 'different');
});
