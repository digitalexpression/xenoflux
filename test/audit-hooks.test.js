import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAuditHookCapture } from '../src/audit-hooks.js';

function envelope(overrides = {}) {
  return {
    phase: 'started', agentId: 'root', turnId: null, source: 'native-rollout', sourceLine: 4,
    run: { id: 'run-1', eventName: 'preToolUse', handlerType: 'command', executionMode: 'sync', scope: 'thread',
      source: 'plugin', status: 'running', startedAt: 1_797_000_000, completedAt: null, durationMs: null,
      sourcePath: '/sensitive/plugin/path', statusMessage: 'secret', entries: [{ kind: 'context', text: 'secret output' }] },
    ...overrides,
  };
}

test('merges root and child lifecycles without duplicating actor-scoped counts', () => {
  const capture = createAuditHookCapture();
  assert.equal(capture.consume(envelope()), true);
  assert.equal(capture.consume(envelope({ phase: 'completed', sourceLine: 5, run: { ...envelope().run, status: 'completed', completedAt: 1_797_000_001, durationMs: 1000 } })), true);
  assert.equal(capture.consume(envelope({ agentId: 'child' })), true);
  const result = capture.result();
  assert.equal(result.hookInvocations.length, 2);
  assert.equal(result.hookInvocations[0].turnId, null);
  assert.equal(result.hookInvocations[0].status, 'completed');
  assert.equal(result.hookInvocations[1].agentId, 'child');
  assert.equal(result.coverage.hooks, 'observed');
});

test('preserves null turn ids and thread or turn scope without inference', () => {
  const capture = createAuditHookCapture();
  capture.consume(envelope());
  capture.consume(envelope({ run: { ...envelope().run, id: 'turn-scoped', scope: 'turn' } }));
  const [thread, turn] = capture.result().hookInvocations;
  assert.equal(thread.turnId, null);
  assert.equal(thread.scope, 'thread');
  assert.equal(turn.turnId, null);
  assert.equal(turn.scope, 'turn');
});

test('contradictory terminal states clear uncertain results and stale starts do not overwrite completion', () => {
  const capture = createAuditHookCapture();
  capture.consume(envelope());
  capture.consume(envelope({ phase: 'completed', sourceLine: 5, run: { ...envelope().run, status: 'completed', completedAt: 1_797_000_001 } }));
  const steady = capture.result().hookInvocations[0];
  assert.equal(steady.status, 'completed');
  assert.equal(steady.startedAtSeconds, 1_797_000_000);
  capture.consume(envelope({ phase: 'completed', sourceLine: 6, run: { ...envelope().run, status: 'failed', completedAt: 1_797_000_001 } }));
  const result = capture.result();
  assert.equal(result.hookInvocations.length, 1);
  assert.equal(result.hookInvocations[0].status, null);
  assert.equal(result.hookInvocations[0].startedAtSeconds, null);
  assert.equal(result.coverage.hooks, 'partial');
  assert.ok(result.warnings.some((warning) => warning.includes('contradictory')));
});

test('rejects malformed identities, caps records, and excludes sensitive run fields', () => {
  const capture = createAuditHookCapture({ maxInvocations: 1 });
  assert.equal(capture.consume(envelope({ turnId: undefined })), false);
  assert.equal(capture.consume(envelope()), true);
  assert.equal(capture.consume(envelope({ agentId: 'child' })), false);
  const serialized = JSON.stringify(capture.result());
  for (const secret of ['/sensitive/plugin/path', 'secret output', 'secret"']) assert.equal(serialized.includes(secret), false);
  assert.equal(capture.result().coverage.hooks, 'partial');
});

test('rejects unsafe actor ids and raw source labels with partial coverage even when every event is dropped', () => {
  const capture = createAuditHookCapture();
  assert.equal(capture.consume(envelope({ agentId: 'root\nsecret' })), false);
  assert.equal(capture.consume(envelope({ source: '/private/path with prose' })), false);
  assert.deepEqual(capture.result().hookInvocations, []);
  assert.equal(capture.result().coverage.hooks, 'partial');
});

test('requires an explicit recognized native hook source kind', () => {
  const capture = createAuditHookCapture();
  const run = { ...envelope().run };
  delete run.source;
  assert.equal(capture.consume(envelope({ run })), false);
  assert.equal(capture.result().coverage.hooks, 'partial');
  assert.equal(capture.consume(envelope({ run: { ...run, source: 'unknown' } })), true);
  assert.equal(capture.result().hookInvocations[0].sourceKind, 'unknown');
});

test('hashes every native hook id and accepts path-bearing native IDs without retaining paths', () => {
  const capture = createAuditHookCapture();
  const rawId = 'session-start:0:/private/profile/config.toml';
  assert.equal(capture.consume(envelope({ run: { ...envelope().run, id: rawId } })), true);
  const output = capture.result();
  const expected = `sha256:${createHash('sha256').update(rawId, 'utf8').digest('hex')}`;
  assert.equal(output.hookInvocations[0].hookRunId, expected);
  assert.equal(JSON.stringify(output).includes('/private/profile/config.toml'), false);
  assert.equal(JSON.stringify(output).includes('session-start:0:'), false);
});

test('rejects oversized or control-bearing native run ids', () => {
  const capture = createAuditHookCapture();
  assert.equal(capture.consume(envelope({ run: { ...envelope().run, id: 'bad\nrun' } })), false);
  assert.equal(capture.consume(envelope({ run: { ...envelope().run, id: 'x'.repeat(8193) } })), false);
  assert.equal(capture.result().coverage.hooks, 'partial');
});

test('accepts an unknown source line as null and clears impossible completion timing', () => {
  const capture = createAuditHookCapture();
  capture.consume(envelope({ phase: 'completed', sourceLine: null,
    run: { ...envelope().run, status: 'completed', completedAt: 1_796_999_999, durationMs: 1000 } }));
  const result = capture.result();
  assert.equal(result.hookInvocations[0].sourceLine, null);
  assert.equal(result.hookInvocations[0].startedAtSeconds, null);
  assert.equal(result.hookInvocations[0].completedAtSeconds, null);
  assert.equal(result.hookInvocations[0].durationMs, null);
  assert.equal(result.coverage.hooks, 'partial');
});

test('marks conflicting completion-only completedAt evidence uncertain without counting another invocation', () => {
  const capture = createAuditHookCapture();
  const completion = (sourceLine, completedAt) => envelope({ phase: 'completed', sourceLine,
    run: { ...envelope().run, status: 'completed', completedAt, durationMs: 1000 } });
  assert.equal(capture.consume(completion(40, 1_797_000_001)), true);
  assert.equal(capture.consume(completion(41, 1_797_000_002)), true);
  assert.equal(capture.consume(completion(42, 1_797_000_001)), true);
  const result = capture.result();
  assert.equal(result.hookInvocations.length, 1);
  assert.equal(result.hookInvocations[0].status, null);
  assert.equal(result.hookInvocations[0].startedAtSeconds, null);
  assert.equal(result.hookInvocations[0].completedAtSeconds, null);
  assert.equal(result.hookInvocations[0].durationMs, null);
  assert.equal(result.coverage.hooks, 'partial');
  assert.ok(result.warnings.some((warning) => warning.includes('completion-only')));
});

test('marks conflicting completion-only duration evidence uncertain', () => {
  const capture = createAuditHookCapture();
  const completion = (sourceLine, durationMs) => envelope({ phase: 'completed', sourceLine,
    run: { ...envelope().run, status: 'completed', completedAt: 1_797_000_001, durationMs } });
  capture.consume(completion(43, 1000));
  capture.consume(completion(44, 1100));
  const result = capture.result();
  assert.equal(result.hookInvocations.length, 1);
  assert.equal(result.hookInvocations[0].status, null);
  assert.equal(result.hookInvocations[0].durationMs, null);
  assert.equal(result.coverage.hooks, 'partial');
});

test('allows completion-only missing timing enrichment and exact replay deduplication', () => {
  const capture = createAuditHookCapture();
  const sparse = envelope({ phase: 'completed', sourceLine: 45,
    run: { ...envelope().run, status: 'completed', completedAt: null, durationMs: null } });
  const enriched = envelope({ phase: 'completed', sourceLine: 46,
    run: { ...envelope().run, status: 'completed', completedAt: 1_797_000_001, durationMs: 1000 } });
  assert.equal(capture.consume(sparse), true);
  assert.equal(capture.consume(sparse), true);
  assert.equal(capture.consume(enriched), true);
  const result = capture.result();
  assert.equal(result.hookInvocations.length, 1);
  assert.equal(result.hookInvocations[0].status, 'completed');
  assert.equal(result.hookInvocations[0].startedAtSeconds, 1_797_000_000);
  assert.equal(result.hookInvocations[0].completedAtSeconds, 1_797_000_001);
  assert.equal(result.hookInvocations[0].durationMs, 1000);
  assert.equal(result.coverage.hooks, 'observed');
});

test('a new full lifecycle after a completion-only conflict is counted independently', () => {
  const capture = createAuditHookCapture();
  const run = envelope().run;
  const completed = (sourceLine, completedAt) => envelope({ phase: 'completed', sourceLine,
    run: { ...run, status: 'completed', completedAt, durationMs: 1000 } });
  capture.consume(completed(47, 1_797_000_001));
  capture.consume(completed(48, 1_797_000_002));
  capture.consume(envelope({ sourceLine: 49 }));
  capture.consume(envelope({ phase: 'completed', sourceLine: 50,
    run: { ...run, status: 'completed', completedAt: 1_797_000_001, durationMs: 1000 } }));
  const rows = capture.result().hookInvocations;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, null);
  assert.equal(rows[1].status, 'completed');
  assert.deepEqual(rows.map((row) => row.occurrenceIndex), [0, 1]);
  assert.equal(capture.result().coverage.hooks, 'partial');
});

test('accepts exact native event labels and invalidates conflicting lifecycle rows', () => {
  const capture = createAuditHookCapture();
  capture.consume(envelope({ source: 'hook/started' }));
  capture.consume(envelope({ phase: 'completed', source: 'hook/completed', sourceLine: 5,
    run: { ...envelope().run, status: 'completed', eventName: 'stop', completedAt: 1_797_000_001 } }));
  const result = capture.result();
  assert.equal(result.hookInvocations.length, 1);
  assert.equal(result.hookInvocations[0].status, null);
  assert.equal(result.hookInvocations[0].startedAtSeconds, null);
  assert.equal(result.hookInvocations[0].turnId, null);
  assert.equal(result.coverage.hooks, 'partial');
});

test('separates handler lifecycles across turns and repeated same-turn occurrences', () => {
  const capture = createAuditHookCapture();
  const rawRun = envelope().run;
  const lifecycle = (phase, turnId, sourceLine, status = phase === 'started' ? 'running' : 'completed') => capture.consume(envelope({ phase, turnId, sourceLine,
    run: { ...rawRun, status, completedAt: phase === 'completed' ? rawRun.startedAt + 1 : null, durationMs: phase === 'completed' ? 100 : null } }));
  lifecycle('started', 'turn-a', 10);
  lifecycle('completed', 'turn-a', 11);
  lifecycle('started', 'turn-b', 12);
  lifecycle('completed', 'turn-b', 13);
  lifecycle('started', 'turn-c', 14);
  lifecycle('completed', 'turn-c', 15);
  lifecycle('started', 'turn-c', 16);
  lifecycle('completed', 'turn-c', 17);
  const rows = capture.result().hookInvocations;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => [row.turnId, row.occurrenceIndex, row.status]), [
    ['turn-a', 0, 'completed'], ['turn-b', 0, 'completed'], ['turn-c', 0, 'completed'], ['turn-c', 1, 'completed'],
  ]);
  assert.equal(new Set(rows.map((row) => row.hookRunId)).size, 1);
  assert.equal(capture.result().coverage.hooks, 'observed');
});

test('deduplicates exact repeated event lines and marks overlapping indistinguishable runs partial', () => {
  const capture = createAuditHookCapture();
  capture.consume(envelope({ turnId: 'turn-x', sourceLine: 20 }));
  capture.consume(envelope({ turnId: 'turn-x', sourceLine: 20 }));
  capture.consume(envelope({ turnId: 'turn-x', sourceLine: 21 }));
  capture.consume(envelope({ turnId: 'turn-x', sourceLine: 22, phase: 'completed', run: { ...envelope().run, status: 'completed', completedAt: 1_797_000_001 } }));
  const result = capture.result();
  assert.equal(result.hookInvocations.length, 2);
  assert.ok(result.hookInvocations.every((row) => row.status === null));
  assert.equal(result.coverage.hooks, 'partial');
});
