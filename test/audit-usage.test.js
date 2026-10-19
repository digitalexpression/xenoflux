import test from 'node:test';
import assert from 'node:assert/strict';
import { assessUsageSequence, nativeUsageAccounting, normalizeUsageSnapshot, summarizeTurnUsage, summarizeWorkflowUsage, USAGE_FIELDS } from '../src/audit-usage.js';

test('normalizes source-reported snapshots with explicit field missingness', () => {
  const row = normalizeUsageSnapshot({ agentId: 'agent-a', turnId: 'turn-a', source: 'fixture', sourceLine: 7,
    last: { input_tokens: 3, cache_write_input_tokens: 1 }, total: { input_tokens: 5 }, modelContextWindow: 100 });
  assert.equal(row.mode, 'snapshot');
  assert.equal(row.last.inputTokens, 3);
  assert.equal(row.last.cacheWriteInputTokens, 1);
  assert.equal(row.total.outputTokens, null);
  assert.deepEqual(row.present, { last: true, total: true, modelContextWindow: true });
});

test('assesses duplicates, same-turn regressions, cross-turn resets, and per-field coverage by agent', () => {
  const snap = (turnId, inputTokens, outputTokens = null) => normalizeUsageSnapshot({ agentId: 'agent-a', turnId,
    source: 'fixture', total: { inputTokens, ...(outputTokens === null ? {} : { outputTokens }) } });
  const assessed = assessUsageSequence([snap('turn-a', 5, 2), snap('turn-a', 5, 2), snap('turn-a', 4, 1), snap('turn-b', 1)]);
  assert.deepEqual(assessed.observations.map(row => row.disposition), ['accepted', 'duplicate', 'regressed', 'reset']);
  assert.equal(assessed.byAgent['agent-a'].fields.total.inputTokens.invalid, 2);
  assert.equal(assessed.byAgent['agent-a'].fields.total.outputTokens.missing, 1);
});

test('keeps per-field baselines across missing data and flags malformed or inconsistent counters', () => {
  const snapshot = (turnId, values) => normalizeUsageSnapshot({ agentId: 'agent-b', turnId,
    source: 'fixture', ...values });
  const assessed = assessUsageSequence([
    snapshot('turn-a', { total: { inputTokens: 10, outputTokens: 2 } }),
    snapshot('turn-a', { total: { outputTokens: 2 } }),
    snapshot('turn-a', { total: { inputTokens: 5, outputTokens: 2 } }),
    snapshot('turn-b', { last: { outputTokens: 8 }, total: { outputTokens: 7 } }),
    snapshot('turn-b', { total: { inputTokens: -1 } }),
  ]);
  assert.deepEqual(assessed.observations.map(row => row.disposition), ['accepted', 'accepted', 'regressed', 'inconsistent', 'invalid']);
  assert.ok(assessed.observations[4].malformedFields.total.includes('inputTokens'));
  assert.equal(assessed.byAgent['agent-b'].fields.total.inputTokens.invalid, 2);
  assert.equal(assessed.byAgent['agent-b'].fields.total.outputTokens.invalid, 1);
});

const contract = nativeUsageAccounting('0.163.0-alpha.10.2');
const counters = (inputTokens, outputTokens, cachedInputTokens = 0, reasoningOutputTokens = 0,
  cacheWriteInputTokens = 0) => ({ inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens,
  cacheWriteInputTokens, totalTokens: inputTokens + outputTokens });
function workflowRun({ root = counters(100, 20, 40, 5, 2), child = counters(50, 10, 15, 3, 1),
  rootRows, childRows, accounting = contract } = {}) {
  const rows = (agentId, turnId, samples) => samples.map((total, index) => ({ agentId, turnId, source: 'native',
    mode: 'snapshot', total: { ...total }, last: {}, disposition: index === 1 && samples[0] === total ? 'duplicate' : 'accepted',
    invalidFields: { total: [], last: [] }, malformedFields: { total: [], last: [] } }));
  return { source: { threadId: 'root', kind: 'native-app-server-v2', version: '0.163.0-alpha.10.2',
    historyMode: 'paginated', freshThread: true }, coverage: { agents: 'complete', usage: 'complete', timeline: 'complete' },
    usage: { accounting, observations: [
      ...rows('root', 'r1', rootRows ?? [root, root]),
      ...rows('child', 'c1', childRows ?? [child]),
    ], root: { total: root, snapshots: rootRows?.length ?? 2 }, child: { total: child, snapshots: childRows?.length ?? 1 } },
    agents: [{ id: 'root', parentId: null, depth: 0, role: 'root', terminal: true },
      { id: 'child', parentId: 'root', depth: 1, role: 'child', terminal: true }],
    turns: [{ agentId: 'root', turnId: 'r1', status: 'completed' }, { agentId: 'child', turnId: 'c1', status: 'completed' }],
    events: [], warnings: [] };
}

test('sums fresh owned-agent cumulative counters once, preserving independent fields', () => {
  const summary = summarizeWorkflowUsage(workflowRun());
  assert.equal(summary.status, 'complete');
  assert.equal(summary.scope, 'captured-workflow-agents');
  assert.equal(summary.values.inputTokens, 150);
  assert.equal(summary.values.outputTokens, 30);
  assert.equal(summary.values.cachedInputTokens, 55);
  assert.equal(summary.values.reasoningOutputTokens, 8);
  assert.equal(summary.values.cacheWriteInputTokens, 3);
  assert.equal(summary.values.totalTokens, 180);
  assert.equal(summary.values.cachedInputTokens + summary.values.reasoningOutputTokens, 63);
  assert.equal(summary.fields.inputTokens.contributingAgents, 2);
  assert.equal(summary.contract.sourceRevision, contract.sourceRevision);
  assert.deepEqual(summary.derivation, { method: 'sum-final-owned-thread-counters-once',
    basis: 'full-capture-before-export-bounds', agents: 2, turns: 2, observations: 3 });
});

test('returns independent validated fields with null for a missing field on one agent', () => {
  const child = counters(50, 10, 15, 3, 1);
  delete child.cachedInputTokens;
  const summary = summarizeWorkflowUsage(workflowRun({ child, childRows: [child] }));
  assert.equal(summary.status, 'partial');
  assert.equal(summary.values.inputTokens, 150);
  assert.equal(summary.values.cachedInputTokens, null);
  assert.deepEqual(summary.fields.cachedInputTokens, { status: 'partial', contributingAgents: 1, agentCount: 2 });
});

test('supports untruncated frozen per-agent rows and rejects truncated summaries', () => {
  const run = workflowRun();
  run.usage.byAgent = [
    { agentId: 'root', total: run.usage.root.total },
    { agentId: 'child', total: run.usage.child.total },
  ];
  delete run.usage.root;
  delete run.usage.child;
  assert.equal(summarizeWorkflowUsage(run).status, 'complete');
  run.usage.byAgentOmitted = 1;
  const omitted = summarizeWorkflowUsage(run);
  assert.equal(omitted.status, 'unavailable');
  assert.equal(omitted.reason, 'usage-sequence-incomplete');
});

test('rejects unsupported contracts, incomplete trees, turns, invalid sequences, and context-budget exits', () => {
  const unsupported = summarizeWorkflowUsage(workflowRun({ accounting: { ...contract, historyMode: 'latest-only' } }));
  assert.equal(unsupported.reason, 'accounting-contract-unverified');
  assert.deepEqual(Object.values(unsupported.values), Array(USAGE_FIELDS.length).fill(null));
  for (const mutate of [
    run => { run.coverage.agents = 'partial'; },
    run => { run.agents[1].parentId = 'missing'; },
    run => { run.turns[1].status = 'in-progress'; },
    run => { run.usage.observations[0].disposition = 'reset'; },
    run => {
      const later = run.usage.observations[1];
      later.disposition = 'accepted';
      later.total.inputTokens = 99;
      later.total.totalTokens = 119;
      run.usage.root.total.inputTokens = 99;
      run.usage.root.total.totalTokens = 119;
    },
    run => { run.events.push({ errorCode: 'contextWindowExceeded' }); },
  ]) {
    const run = workflowRun(); mutate(run);
    assert.equal(summarizeWorkflowUsage(run).status, 'unavailable');
  }
});

test('rejects inconsistent native counters and aggregate overflow', () => {
  const inconsistent = workflowRun();
  inconsistent.usage.observations[0].total.totalTokens++;
  inconsistent.usage.observations[1].total.totalTokens++;
  inconsistent.usage.root.total.totalTokens++;
  assert.equal(summarizeWorkflowUsage(inconsistent).reason, 'source-counter-inconsistent');
  const big = counters(4_000_000_000_000_000, 0, 4_000_000_000_000_000);
  const run = workflowRun({ root: big, child: big, rootRows: [big], childRows: [big] });
  run.agents.push({ id: 'child2', parentId: 'root', depth: 1, role: 'child', terminal: true });
  run.turns.push({ agentId: 'child2', turnId: 'c2', status: 'completed' });
  run.usage.observations.push({ ...run.usage.observations.at(-1), agentId: 'child2', turnId: 'c2' });
  run.usage.child2 = { total: big, snapshots: 1 };
  const summary = summarizeWorkflowUsage(run);
  assert.equal(summary.status, 'partial');
  assert.equal(summary.values.inputTokens, null);
  assert.equal(summary.fields.inputTokens.status, 'invalid');
});

test('pins the source accounting contract to one exact native version', () => {
  const first = nativeUsageAccounting('0.163.0-alpha.10.2');
  assert.deepEqual(first, contract);
  assert.notEqual(first, contract);
  assert.equal(nativeUsageAccounting('0.163.0-alpha.10.3'), null);
});

test('rejects source metadata that does not match the verified accounting contract', () => {
  const run = workflowRun();
  run.source.historyMode = 'latest-only';
  assert.equal(summarizeWorkflowUsage(run).reason, 'accounting-contract-unverified');
});

test('requires complete timeline and rejects event, item, agent, and capture truncation evidence', () => {
  for (const mutate of [
    run => { run.coverage.timeline = 'partial'; },
    run => { run.warnings.push('event-limit'); },
    run => { run.warnings.push('item-limit'); },
    run => { run.warnings.push('linked-agent-limit'); },
    run => { run.warnings.push('Child child: linked-child-page-limit'); },
    run => { run.capture = { capped: true }; },
  ]) {
    const run = workflowRun(); mutate(run);
    assert.equal(summarizeWorkflowUsage(run).status, 'unavailable');
  }
});

test('rejects an inconsistent earlier source snapshot even when the final counters are coherent', () => {
  const run = workflowRun();
  run.usage.observations[0].total.inputTokens = 90;
  run.usage.observations[0].total.totalTokens = 111;
  assert.equal(summarizeWorkflowUsage(run).reason, 'source-counter-inconsistent');
});

function multiTurnRun() {
  const run = workflowRun();
  const samples = [
    ['root', 'r1', [counters(5, 2, 1, 0, 0), counters(10, 4, 2, 1, 0)]],
    ['root', 'r2', [counters(15, 6, 3, 1, 1), counters(20, 8, 4, 2, 1)]],
    ['child', 'c1', [counters(3, 1, 0, 0, 0)]],
    ['child', 'c2', [counters(7, 2, 1, 0, 0)]],
  ];
  let sourceLine = 1;
  run.usage.observations = samples.flatMap(([agentId, turnId, values]) => values.map(total => ({
    agentId, turnId, source: 'thread/tokenUsage/updated', sourceLine: sourceLine++, mode: 'snapshot',
    total: { ...total }, last: {}, disposition: 'accepted',
    invalidFields: { total: [], last: [] }, malformedFields: { total: [], last: [] },
  })));
  run.usage.root.total = samples[1][2].at(-1);
  run.usage.child.total = samples[3][2].at(-1);
  run.usage.root.snapshots = 4;
  run.usage.child.snapshots = 2;
  run.turns = [
    { agentId: 'root', turnId: 'r1', status: 'completed' },
    { agentId: 'root', turnId: 'r2', status: 'completed' },
    { agentId: 'child', turnId: 'c1', status: 'completed' },
    { agentId: 'child', turnId: 'c2', status: 'completed' },
  ];
  return run;
}

test('derives each complete turn from cumulative boundaries, not last-response snapshots', () => {
  const summary = summarizeTurnUsage(multiTurnRun());
  assert.equal(summary.status, 'complete');
  assert.equal(summary.scope, 'captured-owned-thread-turns');
  assert.deepEqual(summary.turns.map(turn => [turn.agentId, turn.turnId, turn.values.inputTokens]), [
    ['root', 'r1', 10], ['root', 'r2', 10], ['child', 'c1', 3], ['child', 'c2', 4],
  ]);
  assert.equal(summary.turns[0].baseline.inputTokens, 0);
  assert.equal(summary.turns[1].baseline.inputTokens, 10);
  assert.equal(summary.turns[0].derivation.sourceObservations.length, 2);
});

test('does not invent turn totals when a terminal field or its baseline is missing', () => {
  const missingBaseline = multiTurnRun();
  delete missingBaseline.usage.observations[1].total.outputTokens;
  delete missingBaseline.usage.observations[1].total.totalTokens;
  const first = summarizeTurnUsage(missingBaseline);
  assert.equal(first.turns[0].values.outputTokens, null);
  assert.equal(first.turns[0].fields.outputTokens.reason, 'terminal-counter-missing');
  assert.equal(first.turns[1].values.outputTokens, null);
  assert.equal(first.turns[1].fields.outputTokens.reason, 'prior-turn-boundary-missing');

  const unsupported = multiTurnRun();
  unsupported.source.version = '0.163.0-alpha.10.3';
  assert.equal(summarizeTurnUsage(unsupported).status, 'unavailable');
});

test('rejects turn boundary resets, non-monotonic source order, and overflowed counters', () => {
  const reset = multiTurnRun();
  reset.usage.observations[2].total.inputTokens = 2;
  reset.usage.observations[2].total.totalTokens = 8;
  assert.equal(summarizeTurnUsage(reset).status, 'unavailable');

  const reordered = multiTurnRun();
  reordered.usage.observations[2].sourceLine = reordered.usage.observations[1].sourceLine;
  assert.equal(summarizeTurnUsage(reordered).reason, 'turn-boundary-order-unverified');

  const overflow = multiTurnRun();
  overflow.usage.observations[3].total.inputTokens = Number.MAX_SAFE_INTEGER + 1;
  overflow.usage.observations[3].total.totalTokens = Number.MAX_SAFE_INTEGER + 9;
  overflow.usage.root.total = overflow.usage.observations[3].total;
  assert.equal(summarizeTurnUsage(overflow).status, 'unavailable');
});

test('invalidates turn deltas that violate cumulative subset relations', () => {
  const run = multiTurnRun();
  const setRootTurn = (firstIndex, values) => {
    run.usage.observations[firstIndex].total = values[0];
    run.usage.observations[firstIndex + 1].total = values[1];
  };
  setRootTurn(0, [counters(90, 18, 5, 4, 0), counters(100, 20, 10, 5, 0)]);
  setRootTurn(2, [counters(100, 20, 20, 10, 0), counters(101, 21, 50, 15, 0)]);
  run.usage.root.total = run.usage.observations[3].total;
  const summary = summarizeTurnUsage(run);
  const laterTurn = summary.turns.find(turn => turn.turnId === 'r2');
  assert.equal(summary.status, 'partial');
  assert.equal(laterTurn.values.inputTokens, 1);
  assert.equal(laterTurn.values.cachedInputTokens, null);
  assert.equal(laterTurn.fields.cachedInputTokens.reason, 'turn-counter-inconsistent');
  assert.equal(laterTurn.values.reasoningOutputTokens, null);
  assert.equal(laterTurn.fields.reasoningOutputTokens.reason, 'turn-counter-inconsistent');
  assert.equal(laterTurn.values.cacheWriteInputTokens, 0);
});

test('allows interleaved agents but rejects a same-agent turn that reappears later', () => {
  const interleaved = multiTurnRun();
  const rows = interleaved.usage.observations;
  interleaved.usage.observations = [rows[0], rows[4], rows[1], rows[5], rows[2], rows[3]];
  interleaved.usage.observations.forEach((row, index) => { row.sourceLine = index + 1; });
  assert.equal(summarizeTurnUsage(interleaved).status, 'complete');

  const noncontiguous = multiTurnRun();
  const reordered = noncontiguous.usage.observations;
  reordered[1].total = { ...reordered[1].total, inputTokens: 10, totalTokens: 14 };
  const lateR1 = { ...reordered[1], total: counters(25, 10, 5, 2, 1), sourceLine: 5 };
  noncontiguous.usage.observations = [reordered[0], reordered[2], reordered[3], reordered[4], reordered[5], lateR1];
  noncontiguous.usage.observations.forEach((row, index) => { row.sourceLine = index + 1; });
  noncontiguous.usage.root.total = lateR1.total;
  assert.equal(summarizeTurnUsage(noncontiguous).reason, 'turn-boundary-order-unverified');
});
