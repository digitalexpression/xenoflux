import test from 'node:test';
import assert from 'node:assert/strict';
import { presentReportedUsage } from '../src/audit-usage-presentation.js';

const claude = (...values) => ({ source: { kind: 'claude-agent-sdk' }, usage: { observations: values.map(values => ({
  source: 'claude-sdk-result', scope: 'single-submission', values,
})) } });

test('Claude submission totals include each disjoint input category and output', () => {
  const usage = presentReportedUsage(claude({ input_tokens: 4, cache_read_input_tokens: 31_966,
    cache_creation_input_tokens: 15_879, output_tokens: 130 }));
  assert.equal(usage.scope, 'Claude task submission');
  assert.deepEqual(usage.counters, { input: 47_849, uncachedInput: 4, cacheRead: 31_966, cacheWrite: 15_879,
    output: 130, reasoning: null, total: 47_979 });
});

test('Claude submission preserves zero and withholds totals when a counter is missing or out of range', () => {
  const usage = presentReportedUsage(claude({ input_tokens: 0, cache_read_input_tokens: 30, output_tokens: 12 }));
  assert.equal(usage.counters.uncachedInput, 0);
  assert.equal(usage.counters.cacheWrite, null);
  assert.equal(usage.counters.input, null);
  assert.equal(usage.counters.total, null);
  const overflow = presentReportedUsage(claude({ input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1,
    cache_creation_input_tokens: 0, output_tokens: 3 }));
  assert.equal(overflow.counters.input, null);
  assert.equal(overflow.counters.total, null);
  assert.equal(presentReportedUsage(claude({ input_tokens: -1, output_tokens: '5' })), null);
  assert.equal(presentReportedUsage(claude({ output_tokens: 2 }, { output_tokens: 3 })), null);
});

test('Codex displays root counters and only adds cache-write detail from the same snapshot', () => {
  const root = { id: 'root', parentId: null, counters: { input: 34_063, cachedInput: 16_768, output: 47, reasoning: 0, total: 34_110 } };
  const run = { source: { kind: 'native-app-server-v2', threadId: 'root' }, usage: { root: { total: { inputTokens: 34_063,
    cachedInputTokens: 16_768, outputTokens: 47, reasoningOutputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 34_110 } } } };
  const usage = presentReportedUsage(run, [root]);
  assert.equal(usage.scope, 'Codex main session');
  assert.deepEqual(usage.counters, { input: 34_063, uncachedInput: 17_295, cacheRead: 16_768, cacheWrite: 0,
    output: 47, reasoning: 0, total: 34_110 });
  run.usage.root.total.inputTokens++;
  assert.equal(presentReportedUsage(run, [root]).counters.cacheWrite, null);
  assert.equal(presentReportedUsage(run, [{ ...root, id: 'other' }]), null);
});

test('Copilot presents the last bound usage receipt without promoting it to a task total', () => {
  const use = (nativeEventId, agentId, turnId, inputTokens, outputTokens) =>
    ({ source: 'assistant.usage', nativeEventId, agentId, turnId, inputTokens, outputTokens });
  const run = { source: { kind: 'copilot-sdk-stdio', threadId: 'root' },
    turns: [{ agentId: 'root', turnId: 'turn-a' }, { agentId: 'root', turnId: 'turn-b' }], usage: { observations: [
      use('response-a', 'root', 'turn-a', 120, 12), use('response-b', 'root', 'turn-b', 103, 0),
      use('different-session', 'other', 'turn-b', 100, 1), use('unbound-turn', 'root', 'turn-z', 300, 1),
    ] } };
  const usage = presentReportedUsage(run);
  assert.equal(usage.scope, 'Copilot usage event');
  assert.deepEqual(usage.counters, { input: 103, uncachedInput: null, cacheRead: null, cacheWrite: null, output: 0,
    reasoning: null, total: null });
  run.usage.observations.push(use('response-b', 'root', 'turn-b', 502, 5));
  assert.equal(presentReportedUsage(run), null);
  run.usage.observations.pop();
  run.usage.observationsOmitted = 1;
  assert.equal(presentReportedUsage(run), null);
});
