import test from 'node:test';
import assert from 'node:assert/strict';
import { presentWorkflowMeasurements } from '../src/audit-workflow-measurements.js';
import { nativeUsageAccounting } from '../src/audit-usage.js';

function fixture() {
  const values = { inputTokens: 100, cachedInputTokens: 70, outputTokens: 20,
    reasoningOutputTokens: 5, cacheWriteInputTokens: 0, totalTokens: 120 };
  const agents = [{ id: 'root', parentId: null, role: 'root', depth: 0 },
    { id: 'child', parentId: 'root', role: 'child', depth: 1 }];
  return { agents, source: { threadId: 'root', kind: 'native-app-server-v2',
    version: '0.163.0-alpha.10.2', historyMode: 'paginated', freshThread: true },
    coverage: { agents: 'complete', timeline: 'complete', usage: 'complete' },
    usage: { accounting: nativeUsageAccounting('0.163.0-alpha.10.2'),
      root: { total: values }, child: { total: values }, observations: agents.map(a => ({
        agentId: a.id, turnId: a.id, total: values, last: values, disposition: 'accepted',
        source: 'thread/tokenUsage/updated', mode: 'snapshot' })) },
    turns: agents.map(a => ({ agentId: a.id, turnId: a.id, status: 'completed' })),
    sessionReplay: { sessions: agents.map((a, i) => ({ id: a.id, parentId: a.parentId,
      events: [{ timestamp: `2026-10-29T00:00:0${i}Z` }, { timestamp: `2026-10-29T00:01:0${i}Z` }] })) },
    metrics: { taskMs: 70_000 } };
}

test('workflow elapsed span covers overlapping sessions without adding their durations', () => {
  const result = presentWorkflowMeasurements(fixture());
  assert.equal(result.durationMs, 61_000);
  assert.equal(result.runnerDurationMs, 70_000);
  assert.match(result.timingNote, /Concurrent agent spans are not added/);
  assert.equal(result.usageStatus, 'validated');
  assert.deepEqual(result.counters, { input: 200, cachedInput: 140, output: 40, reasoning: 10, total: 240 });
});

test('unsupported versions and forged stored totals cannot promote a workflow sum', () => {
  const run = fixture(); run.source.version = 'unsupported'; run.usage.accounting = null;
  run.usage.workflow = { status: 'complete', values: { totalTokens: 240 } };
  const result = presentWorkflowMeasurements(run);
  assert.equal(result.usageStatus, 'unvalidated');
  assert.equal(result.counters.total, null);
  assert.match(result.usageNote, /ownership and starting baselines/);
});

test('missing usage, contradictory summaries and incomplete children stay unavailable', () => {
  for (const change of [run => { run.usage.observations.pop(); },
    run => { run.usage.child = { total: { ...run.usage.child.total, totalTokens: 999 } }; },
    run => { run.coverage.agents = 'partial'; }]) {
    const run = fixture(); change(run);
    const result = presentWorkflowMeasurements(run);
    assert.equal(result.usageStatus, 'unavailable');
    assert.equal(result.counters.total, null);
  }
});

test('orphan, duplicate and missing timestamp evidence cannot imply a complete duration', () => {
  const run = fixture(); run.agents[1].parentId = 'missing';
  assert.equal(presentWorkflowMeasurements(run).durationMs, null);
  const duplicate = fixture(); duplicate.sessionReplay.sessions.push(duplicate.sessionReplay.sessions[0]);
  assert.equal(presentWorkflowMeasurements(duplicate).durationMs, null);
  const partial = fixture(); partial.sessionReplay.sessions.pop();
  assert.equal(presentWorkflowMeasurements(partial).durationMs, 60_000);
  assert.match(presentWorkflowMeasurements(partial).timingNote, /full workflow duration is unknown/);
});

test('zero usage remains recorded zero and replay discovery limitations remain visible', () => {
  const run = fixture();
  for (const row of run.usage.observations) {
    row.total = Object.fromEntries(Object.keys(row.total).map(key => [key, 0]));
    row.last = row.total;
  }
  run.usage.root.total = run.usage.child.total = run.usage.observations[0].total;
  run.sessionReplay.sessions[0].limits = [{ kind: 'child-discovery-partial' }];
  const result = presentWorkflowMeasurements(run);
  assert.equal(result.counters.total, 0);
  assert.equal(result.usageStatus, 'partial');
  assert.match(result.usageNote, /not a validated whole-workflow total/);
  assert.match(result.coverageNote, /replay alone does not prove/);
});

test('missing replay or incomplete discovery cannot promote captured counters to a whole workflow', () => {
  for (const change of [run => { delete run.sessionReplay; },
    run => { run.sessionReplay.sessions = []; },
    run => { run.sessionReplay.sessions.pop(); },
    run => { run.sessionReplay.sessions[1] = run.sessionReplay.sessions[0]; },
    ...['child-discovery-unavailable', 'child-count-limit', 'child-depth-limit'].map(kind =>
      run => { run.sessionReplay.sessions[0].limits = [{ kind }]; })]) {
    const run = fixture(); change(run);
    const result = presentWorkflowMeasurements(run);
    assert.equal(result.usageStatus, 'partial');
    assert.equal(result.counters.total, 240);
    assert.match(result.usageNote, /not a validated whole-workflow total/);
  }
});
