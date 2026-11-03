import test from 'node:test';
import assert from 'node:assert/strict';
import { presentAgentMeasurements } from '../src/audit-agent-measurements.js';
import { deriveRecordedThreadUsage, deriveRecordedUsage, recordedUsageAccounting } from '../src/audit-recorded-usage.js';

function fixture() {
  const agents = [
    { id: 'root', parentId: null, depth: 0, role: 'root' },
    { id: 'child-a', parentId: 'root', depth: 1, role: 'child' },
    { id: 'child-b', parentId: 'root', depth: 1, role: 'child' },
    { id: 'nested', parentId: 'child-b', depth: 2, role: 'child' },
  ];
  const sessionReplay = { sessions: agents.map((agent, index) => ({ id: agent.id, parentId: agent.parentId,
    events: [{ timestamp: `2026-10-29T00:00:0${index}Z` }, { timestamp: `2026-10-29T00:01:0${index}Z` }] })) };
  const usage = Object.fromEntries(agents.map((agent, index) => [agent.id, { scope: 'per-agent-source-reported', snapshots: 2,
    total: { inputTokens: index === 0 ? 0 : 100 + index, outputTokens: 20, cachedInputTokens: 50,
      reasoningOutputTokens: 5, totalTokens: index === 0 ? 20 : 120 + index } }]));
  usage.root.total.cachedInputTokens = 0;
  return { agents, sessionReplay, usage };
}

test('projects each reported actor counter and observed time span without summing overlapping work', () => {
  const report = presentAgentMeasurements(fixture());
  assert.deepEqual(report.map(agent => [agent.id, agent.parentId, agent.role, agent.name]), [
    ['root', null, 'root', 'Main session'],
    ['child-a', 'root', 'child', 'Child session 1'],
    ['child-b', 'root', 'child', 'Child session 2'],
    ['nested', 'child-b', 'child', 'Nested child 1'],
  ]);
  assert.equal(report[0].durationMs, 60_000);
  assert.equal(report[1].durationMs, 60_000);
  assert.match(report[0].timingNote, /not active working time/i);
  assert.match(report[0].usageNote, /not a validated workflow contribution/i);
  assert.equal(report[0].counters.input, 0, 'recorded zero is distinct from missing usage');
  assert.equal(report[1].counters.total, 121);
  assert.equal(Object.hasOwn(report[0], 'workflowTotal'), false);
});

test('keeps missing session, partial timestamps and absent usage explicit', () => {
  const run = fixture();
  run.sessionReplay.sessions[1].events = [{ timestamp: '2026-10-29T00:00:00Z' }, { timestamp: '2026-10-29T00:00:00Z' }];
  run.sessionReplay.sessions.splice(2, 1);
  delete run.usage.nested;
  const report = presentAgentMeasurements(run);
  assert.equal(report[1].durationMs, 0, 'two timestamped events at the same instant form a measured zero span');
  assert.equal(report[1].timingNote.match(/usable timestamps/), null);
  assert.equal(report[2].durationMs, null);
  assert.match(report[2].timingNote, /No recorded replay events/);
  assert.equal(report[3].counters.total, null);
  assert.match(report[3].usageNote, /not recorded/);
});

test('does not invent elapsed time from one timestamp or timestamp-less events', () => {
  const run = fixture();
  run.sessionReplay.sessions[0].events = [{ timestamp: '2026-10-29T00:00:00Z' }, { timestamp: 'bad' }];
  run.sessionReplay.sessions[1].events = [{ timestamp: null }, {}];
  const report = presentAgentMeasurements(run);
  assert.equal(report[0].durationMs, null);
  assert.match(report[0].timingNote, /at least two timestamped/);
  assert.equal(report[1].durationMs, null);
  assert.match(report[1].timingNote, /no usable timestamps/);
});

test('hides malformed and internally inconsistent source counters while preserving other fields', () => {
  const run = fixture();
  run.usage.root.total = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 8,
    reasoningOutputTokens: 4, totalTokens: 14 };
  const [root] = presentAgentMeasurements(run);
  assert.deepEqual(root.counters, { input: null, cachedInput: 8, output: null, reasoning: 4, total: null });
  assert.match(root.usageNote, /invalid or inconsistent/);
  run.usage['child-a'].total.inputTokens = Number.MAX_SAFE_INTEGER + 1;
  const child = presentAgentMeasurements(run)[1];
  assert.equal(child.counters.input, null);
  assert.equal(child.counters.total, 121);
});

test('fails closed for duplicate agent IDs and ambiguous replay session identities', () => {
  const run = fixture();
  run.agents.push({ ...run.agents[1] });
  assert.deepEqual(presentAgentMeasurements(run), []);

  const other = fixture();
  other.sessionReplay.sessions.push({ ...other.sessionReplay.sessions[1] });
  assert.equal(presentAgentMeasurements(other)[1].durationMs, null);
  assert.match(presentAgentMeasurements(other)[1].timingNote, /identity is ambiguous/);
});

test('returns no actor measurement rows when actor coverage is absent', () => {
  assert.deepEqual(presentAgentMeasurements(null), []);
  assert.deepEqual(presentAgentMeasurements({ agents: [] }), []);
});

test('uses owned recorded turn boundaries when a native session replay lacks event timestamps', () => {
  const run = fixture();
  run.sessionReplay.sessions[0].events = [];
  run.turns = [{ agentId: 'root', turnId: 'turn-root', observedStartedAt: '2026-10-29T00:00:00Z',
    observedCompletedAt: '2026-10-29T00:00:03Z' }];
  const [root] = presentAgentMeasurements(run);
  assert.equal(root.durationMs, 3_000);
  assert.match(root.timingNote, /Recorded turn start to completion/);
});

test('projects source-filtered native root and child usage and falls back to raw child counters when its fork baseline fails validation', () => {
  const run = fixture();
  const version = '0.163.0-alpha.10.2';
  const rootId = '11111111-1111-4111-8111-111111111111';
  const childId = '55555555-5555-4555-8555-555555555555';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const turn1 = '33333333-3333-4333-8333-333333333333';
  const turn2 = '44444444-4444-4444-8444-444444444444';
  const rootSource = { kind: 'native-rollout', nativeSessionId: rootId, clientVersion: version,
    fingerprintScope: 'source-snapshot', fingerprint: 'a'.repeat(64), bytes: 2048, fileBytes: 2048 };
  const childSource = { ...rootSource, nativeSessionId: childId, fingerprint: 'c'.repeat(64) };
  const rawCounters = (input, output, cached = 0, reasoning = 0) => ({ input_tokens: input, output_tokens: output,
    cached_input_tokens: cached, reasoning_output_tokens: reasoning, cache_write_input_tokens: 0, total_tokens: input + output });
  const owned = ({ agentId, source, parentId = null, childMode = false, baseline = [10, 2, 1, 1] }) => {
    const contexts = [turn1, turn2];
    const turns = contexts.map((turnId, index) => ({ turnId, contextLine: index * 6 + 1,
      terminalLine: index * 6 + 6, status: 'completed' }));
    let thread = rawCounters(...baseline), turn = rawCounters(0, 0), active = turn1;
    const records = [rawCounters(3, 2, 1, 1), rawCounters(4, 1), rawCounters(2, 3, 1, 1)].map((usage, index) => {
      const turnId = index === 2 ? turn2 : turn1;
      if (turnId !== active) { active = turnId; turn = rawCounters(0, 0); }
      const add = (left, right) => Object.fromEntries(Object.keys(left).map(key => [key, left[key] + right[key]]));
      turn = add(turn, usage); thread = add(thread, usage);
      return { thread_id: agentId, session_id: sessionId, turn_id: turnId,
        root_turn_id: childMode ? turn1 : turnId, response_id: `response-${index}`, usage,
        turn_token_usage: turn, thread_token_usage: thread, sourceLine: [2, 4, 9][index] };
    });
    return { agentId, sessionId, parentId, rootTurnIds: childMode ? [turn1] : [], version,
      sourceComplete: true, source, turns, records };
  };
  const rootBlock = deriveRecordedThreadUsage(owned({ agentId: rootId, source: rootSource }));
  const childBlock = deriveRecordedThreadUsage(owned({ agentId: childId, source: childSource, parentId: rootId, childMode: true }));
  const recorded = deriveRecordedUsage({ rootAgentId: rootId, threads: [rootBlock, childBlock], source: rootSource });
  const contract = recordedUsageAccounting(version);
  run.usage = {
    byAgent: [
      { agentId: rootId, totals: { scope: 'selected-session-only', values: { input_tokens: 10, output_tokens: 5,
        cached_input_tokens: 8, reasoning_output_tokens: 4, total_tokens: 15 } } },
      { agentId: childId, scope: 'reported-scope-unknown', total: { input_tokens: 700, output_tokens: 50,
        cached_input_tokens: 600, reasoning_output_tokens: 20, total_tokens: 750 } },
    ],
    recorded,
  };
  run.agents = [{ id: rootId, parentId: null, sessionId: rootId, source: rootSource },
    { id: childId, parentId: rootId, sessionId: childId, source: childSource }];
  run.source = rootSource;
  run.turns = [rootBlock, childBlock].flatMap(block => block.turns.map(turn => ({ agentId: block.agentId,
    turnId: turn.turnId, sourceLine: turn.contextLine })));
  const report = presentAgentMeasurements(run);
  assert.equal(recorded.contract.contract, contract.contract);
  assert.deepEqual(report[0].counters, { input: rootBlock.values.inputTokens, cachedInput: rootBlock.values.cachedInputTokens,
    output: rootBlock.values.outputTokens, reasoning: rootBlock.values.reasoningOutputTokens, total: rootBlock.values.totalTokens });
  assert.match(report[0].usageNote, /recorded responses belonging to this session/);
  assert.deepEqual(report[1].counters, { input: childBlock.values.inputTokens, cachedInput: childBlock.values.cachedInputTokens,
    output: childBlock.values.outputTokens, reasoning: childBlock.values.reasoningOutputTokens, total: childBlock.values.totalTokens });
  assert.match(report[1].usageNote, /recorded responses belonging to this session/);

  run.agents[1].source = { ...childSource, fingerprint: 'd'.repeat(64) };
  const rejectedBinding = presentAgentMeasurements(run);
  assert.deepEqual(rejectedBinding[0].counters, { input: 10, cachedInput: 8, output: 5, reasoning: 4, total: 15 });
  assert.match(rejectedBinding[0].usageNote, /scope: selected-session-only/);
  assert.doesNotMatch(rejectedBinding[0].usageNote, /recorded responses belonging to this session/);
  assert.deepEqual(rejectedBinding[1].counters, { input: 700, cachedInput: 600, output: 50, reasoning: 20, total: 750 });
  assert.match(rejectedBinding[1].usageNote, /scope: reported-scope-unknown/);
  assert.doesNotMatch(rejectedBinding[1].usageNote, /recorded responses belonging to this session/);
  run.agents[1].source = childSource;

  run.usage.recorded = { ...recorded, threads: [rootBlock, { ...childBlock,
    baseline: { ...childBlock.baseline, inputTokens: childBlock.baseline.inputTokens + 1 } }] };
  const fallback = presentAgentMeasurements(run);
  assert.deepEqual(fallback[1].counters, { input: 700, cachedInput: 600, output: 50, reasoning: 20, total: 750 });
  assert.match(fallback[1].usageNote, /scope: reported-scope-unknown/);
  assert.match(fallback[1].usageNote, /starting baseline is not independently verified/);
});
