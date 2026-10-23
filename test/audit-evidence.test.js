import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCaptureRequirements, evaluateCaptureRequirements } from '../src/audit-evidence.js';
import { validateAuditSpec } from '../src/audit-spec.js';
import { nativeUsageAccounting, summarizeTurnUsage } from '../src/audit-usage.js';

function fixture() {
  const counters = { inputTokens: 10, outputTokens: 3, totalTokens: 13 };
  return { source: { threadId: 'root' }, coverage: { agents: 'complete', skillUsage: 'partial' },
    agents: [{ id: 'root', parentId: null }, { id: 'child', parentId: 'root' }, { id: 'foreign', parentId: 'other' }],
    turns: [{ agentId: 'root', turnId: 'root-turn' }, { agentId: 'child', turnId: 'child-turn' }],
    usage: { root: { total: counters }, child: { total: counters }, observations: [
      { agentId: 'root', turnId: 'root-turn', total: counters, disposition: 'accepted' },
      { agentId: 'child', turnId: 'child-turn', total: counters, disposition: 'accepted' },
    ] },
    skills: [{ id: 'system', name: 'same', origin: 'system' }, { id: 'plugin', name: 'same', origin: 'plugin' }],
    skillInvocations: [
      { agentId: 'root', turnId: 'root-turn', skillId: 'system', invocationType: 'explicit', resolution: 'catalogued' },
      { agentId: 'child', turnId: 'child-turn', skillId: 'plugin', invocationType: 'implicit', resolution: 'catalogued' },
    ], toolInvocations: [{ agentId: 'child', turnId: 'child-turn', kind: 'mcp', serverName: 'local-fixture', toolName: 'lookup', status: 'completed' }],
  };
}
const requirements = { minAgents: 2, usage: { agents: 'all', fields: ['inputTokens', 'outputTokens', 'totalTokens'] },
  skills: [{ agent: 'root', origin: 'system', name: 'same', invocationType: 'explicit' },
    { agent: 'descendant', origin: 'plugin', name: 'same', invocationType: 'implicit' }],
  tools: [{ agent: 'descendant', kind: 'mcp', server: 'local-fixture', tool: 'lookup' }] };

test('validates observed delegated evidence separately from exhaustive skill consumption', () => {
  const result = evaluateCaptureRequirements(fixture(), requirements);
  assert.equal(result.status, 'passed');
  assert.equal(result.exhaustiveConsumption, false);
  assert.ok(result.checks.every(check => check.status === 'passed'));
  const spec = validateAuditSpec({ schemaVersion: 1, repository: '/tmp/repo', revision: 'HEAD', task: 'Inspect only.',
    profiles: ['Alpha', 'Beta'], captureRequirements: requirements });
  assert.deepEqual(spec.captureRequirements, result.requirements);
  assert.equal(spec.allowIncompleteCapture, false);
});

test('validates loaded context declarations and integrates checks into capture acceptance', () => {
  const requirements = { minAgents: 1, context: [{ origin: 'repository', path: 'AGENTS.md' }] };
  const normalized = validateCaptureRequirements(requirements);
  assert.deepEqual(normalized.context, [{ agents: 'root', origin: 'repository', path: 'AGENTS.md' }]);
  assert.throws(() => validateCaptureRequirements({ context: [{ origin: 'user', path: '../AGENTS.md' }] }));
  const result = evaluateCaptureRequirements({ ...fixture(), source: { kind: 'native-app-server-v2', version: '0.163.0-alpha.10.2', threadId: 'root' },
    coverage: { agents: 'complete' }, instructionSources: [] }, requirements);
  assert.equal(result.status, 'failed');
  assert.ok(result.checks.some(check => check.id === 'context:0' && check.status === 'failed'));
  assert.deepEqual(result.requirements.context, normalized.context);
});

test('absent, ambiguous and foreign skill events and server availability do not satisfy invocation requirements', () => {
  const run = fixture();
  run.skillInvocations[0].resolution = 'ambiguous';
  run.skillInvocations[1].agentId = 'foreign';
  run.toolInvocations = [];
  run.mcp = { servers: [{ name: 'local-fixture', status: 'ready' }] };
  const result = evaluateCaptureRequirements(run, requirements);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.filter(check => /^(skills|tools):/.test(check.id) && check.status === 'failed').length, 3);
  assert.ok(result.checks.some(check => check.reason === 'required-invocation-not-observed'));
});

test('requires exact plugin and script ownership rather than unrelated tool use', () => {
  const run = fixture();
  const contract = { tools: [
    { agent: 'descendant', kind: 'mcp', pluginId: 'local.plugin', tool: 'lookup' },
    { agent: 'root', kind: 'command', pluginId: 'official.plugin', scriptPath: 'skills/review/scripts/check.py' },
  ] };
  run.toolInvocations.push({ agentId: 'root', turnId: 'root-turn', kind: 'command', pluginId: 'official.plugin',
    scriptPath: 'skills/review/scripts/other.py', status: 'completed' });
  assert.equal(evaluateCaptureRequirements(run, contract).status, 'failed');
  run.toolInvocations[0].pluginId = 'local.plugin';
  run.toolInvocations[1].scriptPath = 'skills/review/scripts/check.py';
  const result = evaluateCaptureRequirements(run, contract);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks.find(item => item.id === 'tools:1').selector.scriptPath, contract.tools[1].scriptPath);
  run.toolInvocations[1].pluginId = 'other.plugin';
  assert.equal(evaluateCaptureRequirements(run, contract).status, 'failed');
  run.toolInvocations[1].pluginId = null;
  assert.equal(evaluateCaptureRequirements(run, contract).status, 'failed');
});

test('missing turn snapshots, invalidated cumulative fields and unavailable lineage fail required usage', () => {
  for (const mutate of [
    run => { run.usage.observations[1].total = { inputTokens: 10 }; },
    run => { run.usage.observations[1].disposition = 'regressed'; },
    run => { run.usage.child.total = { inputTokens: null, outputTokens: 3, totalTokens: null }; },
    run => { run.usage.observations[1].turnId = 'unrelated-turn'; },
    run => { run.coverage.agents = 'partial'; },
  ]) {
    const run = fixture(); mutate(run);
    assert.equal(evaluateCaptureRequirements(run, requirements).status, 'failed');
  }
  assert.equal(evaluateCaptureRequirements(fixture(), requirements, { protocolReady: false }).status, 'failed');
});

test('requirements reject misspellings, empty contracts, invalid selectors and unbounded counts', () => {
  for (const bad of [{}, { hidden: true }, { minAgents: 0 }, { skills: [] }, { tools: [{ kind: 'mcpToolCall' }] },
    { usage: { fields: ['totalTokens', 'totalTokens'] } }, { usage: { fields: ['reasoning'] } },
    { skills: [{ origin: 'copyable' }] }, { skills: [{ agent: 'all' }] }, { tools: [{ min: 1001 }] },
    { tools: [{ pluginId: '' }] }, { tools: [{ scriptPath: '/private/run.py' }] },
    { tools: [{ scriptPath: 'scripts/run.py' }] },
    { tools: [{ kind: 'mcp', scriptPath: 'scripts/run.py' }] }, { usage: { wholeTurns: 'true' } },
    { hooks: [] }, { hooks: [{ status: 'running' }] }, { hooks: [{ eventName: 'Stop' }] },
    { hooks: [{ sourceKind: '/private/config' }] }])
    assert.throws(() => validateCaptureRequirements(bad), /captureRequirements/);
  assert.equal(evaluateCaptureRequirements(fixture(), undefined), null);
});

test('requires terminal owned hook execution and preserves native thread-scoped null turns', () => {
  const run = fixture();
  const hook = { hookRunId: 'hook-1', agentId: 'root', turnId: null, eventName: 'sessionStart',
    scope: 'thread', sourceKind: 'user', status: 'completed' };
  run.hookInvocations = [hook, { ...hook, hookRunId: 'hook-2', agentId: 'child', turnId: 'child-turn', eventName: 'subagentStop', scope: 'turn' }];
  const rules = { hooks: [{ agent: 'root', eventName: 'sessionStart', scope: 'thread', sourceKind: 'user', status: 'completed' },
    { agent: 'descendant', eventName: 'subagentStop', scope: 'turn' }] };
  assert.equal(evaluateCaptureRequirements(run, rules).status, 'passed');
  for (const mutate of [
    row => { row.agentId = 'foreign'; }, row => { row.turnId = 'other-turn'; },
    row => { row.turnId = null; }, row => { row.status = null; }, row => { row.status = 'running'; },
  ]) {
    const changed = structuredClone(run); mutate(changed.hookInvocations[1]);
    assert.equal(evaluateCaptureRequirements(changed, rules).status, 'failed');
  }
});

test('whole-turn acceptance recomputes verified boundaries and ignores fabricated summaries', () => {
  const run = fixture(), accounting = nativeUsageAccounting('0.163.0-alpha.10.2');
  run.agents.pop();
  run.agents.forEach((agent, index) => { agent.depth = index; });
  run.source = { kind: 'native-app-server-v2', threadId: 'root', version: accounting.version, historyMode: 'paginated', freshThread: true };
  Object.assign(run.coverage, { timeline: 'complete', usage: 'complete' });
  run.turns.forEach(turn => { turn.status = 'completed'; });
  run.usage.accounting = accounting;
  run.usage.observations.forEach((row, index) => {
    row.sourceLine = index + 1; row.source = 'thread/tokenUsage/updated';
    Object.assign(row.total, { cachedInputTokens: 1, reasoningOutputTokens: 1, cacheWriteInputTokens: 2 });
  });
  const rules = { usage: { agents: 'all', wholeTurns: true, fields: ['inputTokens', 'cacheWriteInputTokens', 'totalTokens'] } };
  assert.equal(evaluateCaptureRequirements(run, rules).status, 'passed');
  run.usage.turns = summarizeTurnUsage(run);
  run.usage.observations[1].source = 'token_usage_record';
  const rejected = evaluateCaptureRequirements(run, rules);
  assert.equal(rejected.status, 'failed');
  assert.ok(rejected.checks.some(check => check.reason === 'native-turn-source-unverified'));
  assert.equal(evaluateCaptureRequirements(run, { usage: { fields: ['inputTokens'] } }).status, 'passed', 'snapshot requirement remains explicitly separate');
});
