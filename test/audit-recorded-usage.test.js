import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveRecordedThreadUsage, deriveRecordedUsage, projectRecordedThreadUsage,
  projectRecordedUsage, projectRunRecordedUsage, recordedUsageAccounting } from '../src/audit-recorded-usage.js';

const version = '0.163.0-alpha.10.2';
const thread = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const turn1 = '33333333-3333-4333-8333-333333333333';
const turn2 = '44444444-4444-4444-8444-444444444444';
const child = '55555555-5555-4555-8555-555555555555';

const counters = (input, output, cached = 0, reasoning = 0, cacheWrite = 0) => ({
  input_tokens: input, output_tokens: output, cached_input_tokens: cached,
  reasoning_output_tokens: reasoning, cache_write_input_tokens: cacheWrite, total_tokens: input + output,
});
const add = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, a[key] + b[key]]));
function wrapperCandidate(rootAgentId, threads) {
  const values = Object.fromEntries(Object.keys(threads[0].values).map(key => [key,
    threads.reduce((sum, thread) => sum + thread.values[key], 0)]));
  const responses = threads.reduce((sum, thread) => sum + thread.records.length, 0);
  return { schemaVersion: 1, scope: 'recorded-selected-thread-responses',
    contract: recordedUsageAccounting(version), rootAgentId, sourceBinding: null,
    status: 'complete', reason: null, values,
    fields: Object.fromEntries(Object.keys(values).map(key => [key, { status: 'observed',
      contributingResponses: responses, responseCount: responses }])), threads };
}
function fixture({ parentId = null, childMode = false, agentId = thread,
  baseline = [10, 2, 1, 1, 0], secret = false, source = null } = {}) {
  const ids = childMode ? [turn1, turn2] : [turn1, turn2];
  const responseUsage = [counters(3, 2, 1, 1), counters(4, 1, 0, 0), counters(2, 3, 1, 1)];
  const turnIds = [ids[0], ids[0], ids[1]];
  const roots = childMode ? [turn1, turn1, turn1] : turnIds;
  const turns = [
    { turnId: turn1, contextLine: 1, terminalLine: 6, status: 'completed' },
    { turnId: turn2, contextLine: 7, terminalLine: 11, status: 'completed' },
  ];
  let threadRunning = counters(...baseline), turnRunning = counters(0, 0), active = turn1;
  const records = responseUsage.map((usage, index) => {
    const turnId = turnIds[index];
    if (turnId !== active) { active = turnId; turnRunning = counters(0, 0); }
    turnRunning = add(turnRunning, usage); threadRunning = add(threadRunning, usage);
    return { thread_id: agentId, session_id: session, turn_id: turnId, root_turn_id: roots[index],
      response_id: `resp-${index}${secret ? '-SECRET-BODY-DO-NOT-LEAK' : ''}`, usage,
      turn_token_usage: turnRunning, thread_token_usage: threadRunning, sourceLine: [2, 4, 9][index],
      ...(secret ? { input_text: 'PRIVATE PROMPT MUST NOT LEAK', raw_response: 'PRIVATE OUTPUT MUST NOT LEAK' } : {}) };
  });
  return { agentId, sessionId: session, parentId: childMode ? thread : parentId,
    rootTurnIds: childMode ? [turn1] : [], version, sourceComplete: true, source, turns, records };
}

test('returns only the exact recorded response accounting contract', () => {
  assert.deepEqual(recordedUsageAccounting(version), {
    contract: 'codex-rollout-own-response-usage-v1', version,
    sourceRevision: 'd9151c94a70013f176ff370fa93da02734662e41',
    historyMode: 'recorded-response-sequence', counterScope: 'thread-owned-responses',
  });
  assert.equal(recordedUsageAccounting('0.163.0-alpha.10.1'), null);
});

test('constructs the canonical wrapper and binds it to its exact complete native run', () => {
  const source = { kind: 'native-rollout', nativeSessionId: thread, clientVersion: version,
    fingerprintScope: 'source-snapshot', fingerprint: 'a'.repeat(64), bytes: 2048, fileBytes: 2048 };
  const childSource = { ...source, nativeSessionId: child, fingerprint: 'c'.repeat(64) };
  const root = deriveRecordedThreadUsage(fixture({ source }));
  const childBlock = deriveRecordedThreadUsage(fixture({ childMode: true, agentId: child, source: childSource }));
  const usage = deriveRecordedUsage({ rootAgentId: thread, threads: [root, childBlock], source });
  assert.equal(usage.status, 'complete');
  const agents = [
    { id: thread, parentId: null, sessionId: thread, source },
    { id: child, parentId: thread, sessionId: child, source: childSource },
  ];
  const turns = [root, childBlock].flatMap(block => block.turns.map(turn => ({
    agentId: block.agentId, turnId: turn.turnId, sourceLine: turn.contextLine,
  })));
  const run = { source, agents, turns, usage: { recorded: usage } };
  assert.deepEqual(projectRunRecordedUsage(run), usage);
  run.agents[1].source = { ...childSource, fingerprint: 'd'.repeat(64) };
  assert.equal(projectRunRecordedUsage(run).reason, 'source-binding-unverified');
  run.agents[1].source = childSource;
  run.source = { ...source, fingerprint: 'b'.repeat(64) };
  const rejected = projectRunRecordedUsage(run);
  assert.equal(rejected.reason, 'source-binding-unverified');
  assert.deepEqual(projectRecordedUsage(rejected), rejected);
  run.source = { ...source, bytes: 2047 };
  assert.equal(projectRunRecordedUsage(run).reason, 'source-binding-unverified');
  run.source = source;
  run.turns[0].sourceLine++;
  assert.equal(projectRunRecordedUsage(run).reason, 'source-binding-unverified');
  assert.equal(projectRunRecordedUsage({ ...run, usage: {} }), null);
  assert.equal(projectRunRecordedUsage({ ...run, source: { ...source, clientVersion: 'unknown' } }), null);
});

test('derives summed response usage and nonzero resumed baseline, then revalidates the frozen projection', () => {
  const result = deriveRecordedThreadUsage(fixture({ secret: true }));
  assert.equal(result.status, 'complete');
  assert.equal(result.baseline.inputTokens, 10);
  assert.equal(result.baseline.totalTokens, 12);
  assert.equal(result.values.inputTokens, 9);
  assert.equal(result.values.outputTokens, 6);
  assert.equal(result.values.totalTokens, 15);
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].values.inputTokens, 7);
  assert.equal(result.records[0].responseRef,
    `sha256:${createHash('sha256').update('resp-0-SECRET-BODY-DO-NOT-LEAK').digest('hex')}`);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-BODY|response_id|thread_token_usage|PRIVATE/);
  assert.deepEqual(projectRecordedThreadUsage(structuredClone(result)), result);
  const tampered = structuredClone(result);
  tampered.values.inputTokens++;
  assert.equal(projectRecordedThreadUsage(tampered).status, 'unavailable');
});

test('supports a verified fresh-thread zero baseline without fabricating response counters', () => {
  const fresh = deriveRecordedThreadUsage(fixture({ baseline: [0, 0, 0, 0, 0] }));
  assert.equal(fresh.status, 'complete');
  assert.deepEqual(fresh.baseline, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    reasoningOutputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 0 });
  assert.equal(fresh.values.totalTokens, 15);
});

test('accepts child records only under a listed ancestor root turn', () => {
  const input = fixture({ childMode: true });
  assert.equal(deriveRecordedThreadUsage(input).status, 'complete');
  input.rootTurnIds = [turn2];
  assert.equal(deriveRecordedThreadUsage(input).reason, 'root-turn-ownership-invalid');
});

test('rejects incomplete, malformed, duplicate, reordered, orphaned, and inconsistent records', () => {
  const cases = [
    [input => { input.sourceComplete = false; }, 'source-incomplete'],
    [input => { input.version = 'unknown'; }, 'source-version-unsupported'],
    [input => { input.records[0].thread_id = session; }, 'response-record-invalid'],
    [input => { input.records[1].response_id = input.records[0].response_id; }, 'duplicate-response-id'],
    [input => { input.records[1].sourceLine = input.records[0].sourceLine; }, 'response-record-invalid'],
    [input => { input.records[0].sourceLine = 6; }, 'response-order-invalid'],
    [input => { input.turns.pop(); }, 'response-record-invalid'],
    [input => { input.records[0].usage.cached_input_tokens = 100; }, 'response-counter-invalid'],
    [input => { input.records[1].thread_token_usage.input_tokens++;
      input.records[1].thread_token_usage.total_tokens++; }, 'thread-counter-inconsistent'],
    [input => { input.records[0].turn_token_usage.input_tokens++;
      input.records[0].turn_token_usage.total_tokens++; }, 'turn-counter-inconsistent'],
    [input => { input.records[0].usage.total_tokens = Number.MAX_SAFE_INTEGER; }, 'response-counter-invalid'],
  ];
  for (const [mutate, expected] of cases) {
    const input = fixture(); mutate(input);
    assert.equal(deriveRecordedThreadUsage(input).reason, expected);
  }
});

test('revalidates an explicitly selected root and child set before aggregation', () => {
  const root = deriveRecordedThreadUsage(fixture());
  const childBlock = deriveRecordedThreadUsage(fixture({ childMode: true, agentId: child }));
  const selected = projectRecordedUsage(wrapperCandidate(thread, [root, childBlock]));
  assert.equal(selected.status, 'complete');
  assert.equal(selected.values.inputTokens, root.values.inputTokens + childBlock.values.inputTokens);
  const tampered = structuredClone(childBlock);
  tampered.parentId = null;
  const rejected = projectRecordedUsage(wrapperCandidate(thread, [root, tampered]));
  assert.equal(rejected.status, 'unavailable');
  assert.equal(rejected.values.inputTokens, null);
  assert.deepEqual(projectRecordedUsage(selected), selected);
  assert.equal(projectRecordedUsage({ ...selected, schemaVersion: 2 }).reason, 'projection-invalid');
});

test('bounds selected wrapper output before projecting oversized record collections', () => {
  const block = deriveRecordedThreadUsage(fixture());
  const threads = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(block),
    agentId: `66666666-6666-4666-8666-${String(index).padStart(12, '0')}`,
    records: Array(410).fill(block.records[0]) }));
  const oversized = wrapperCandidate(thread, threads);
  const result = projectRecordedUsage(oversized);
  assert.equal(result.reason, 'selected-response-bound-exceeded');
  assert.equal(result.threads.length, 5);
  assert.equal(result.threads.reduce((sum, item) => sum + item.records.length, 0), 0);
});

test('revalidates unavailable blocks idempotently and safely handles missing counter summaries', () => {
  const input = fixture(); input.sourceComplete = false;
  const unavailable = deriveRecordedThreadUsage(input);
  const reopened = projectRecordedThreadUsage(unavailable);
  assert.deepEqual(reopened, unavailable);
  const tampered = deriveRecordedThreadUsage(fixture());
  delete tampered.baseline;
  assert.equal(projectRecordedThreadUsage(tampered).status, 'unavailable');
  const tamperedValues = deriveRecordedThreadUsage(fixture());
  tamperedValues.values = null;
  assert.equal(projectRecordedThreadUsage(tamperedValues).status, 'unavailable');
});

test('rejects bound overflow and does not infer zero counters from missing fields', () => {
  const input = fixture();
  input.records = Array(513).fill(input.records[0]);
  assert.equal(deriveRecordedThreadUsage(input).reason, 'record-bound-exceeded');
  const missing = fixture();
  delete missing.records[0].usage.cached_input_tokens;
  assert.equal(deriveRecordedThreadUsage(missing).reason, 'response-counter-invalid');
});
