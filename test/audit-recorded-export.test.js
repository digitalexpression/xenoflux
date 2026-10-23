import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deriveRecordedThreadUsage, deriveRecordedUsage } from '../src/audit-recorded-usage.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
import { bookingLedgerPair } from '../test-support/audit-explanation/booking-ledger.js';

const [eligibleFixture] = bookingLedgerPair();

const version = '0.163.0-alpha.10.2';
const ids = {
  root: '11111111-1111-4111-8111-111111111111',
  session: '22222222-2222-4222-8222-222222222222',
  turn: '33333333-3333-4333-8333-333333333333',
};
const counters = (input, output, cached = 0, reasoning = 0) => ({ input_tokens: input, output_tokens: output,
  cached_input_tokens: cached, reasoning_output_tokens: reasoning, cache_write_input_tokens: 0,
  total_tokens: input + output });
function selectedWrapper(rootAgentId, threads, source) {
  return deriveRecordedUsage({ rootAgentId, threads, source });
}

function run(id = 'recorded') {
  const usage = counters(10, 5, 2, 1), cumulative = counters(30, 15, 5, 2);
  const source = { kind: 'native-rollout', clientVersion: version, nativeSessionId: ids.root,
    fingerprintScope: 'source-snapshot', fingerprint: createHash('sha256').update(id).digest('hex'), bytes: 200, fileBytes: 200 };
  const thread = deriveRecordedThreadUsage({ version, sourceComplete: true, source, agentId: ids.root, sessionId: ids.root,
    parentId: null, rootTurnIds: [ids.turn], turns: [{ turnId: ids.turn, contextLine: 2, terminalLine: 5, status: 'completed' }],
    records: [{ response_id: 'resp-record-1', thread_id: ids.root, session_id: ids.root, turn_id: ids.turn,
      root_turn_id: ids.turn, sourceLine: 3, usage, turn_token_usage: usage, thread_token_usage: cumulative }] });
  assert.equal(thread.status, 'complete');
  const recorded = selectedWrapper(ids.root, [thread], source);
  return { id, status: 'completed', source: { ...source, clientVersion: version },
    comparisonConditions: structuredClone(eligibleFixture.comparisonConditions),
    sourceWorkspace: { sourceCommit: eligibleFixture.comparisonConditions.baseline.commit,
      sourceTree: eligibleFixture.comparisonConditions.baseline.tree },
    agents: [{ id: ids.root, parentId: null, sessionId: ids.root, depth: 0, source }],
    turns: [{ agentId: ids.root, turnId: ids.turn, sourceLine: 2, status: 'completed', model: 'fixture-model', reasoningEffort: 'high' }],
    usage: { recorded } };
}
function denseRun(id) {
  const records = [], turn = ids.turn;
  const source = { kind: 'native-rollout', clientVersion: version, nativeSessionId: ids.root,
    fingerprintScope: 'source-snapshot', fingerprint: createHash('sha256').update(id).digest('hex'), bytes: 10000, fileBytes: 10000 };
  for (let index = 0; index < 512; index++) {
    const running = counters(index + 1, index + 1);
    records.push({ response_id: `response-${id}-${index}`, thread_id: ids.root, session_id: ids.root,
      turn_id: turn, root_turn_id: turn, sourceLine: index + 3, usage: counters(1, 1),
      turn_token_usage: running, thread_token_usage: running });
  }
  const thread = deriveRecordedThreadUsage({ version, sourceComplete: true, source, agentId: ids.root, sessionId: ids.root,
    parentId: null, rootTurnIds: [turn], turns: [{ turnId: turn, contextLine: 2, terminalLine: 516, status: 'completed' }], records });
  assert.equal(thread.status, 'complete');
  return { id, status: 'completed', source,
    agents: [{ id: ids.root, parentId: null, sessionId: ids.root, depth: 0, source }],
    turns: [{ agentId: ids.root, turnId: turn, sourceLine: 2, status: 'completed' }],
    usage: { recorded: selectedWrapper(ids.root, [thread], source) } };
}

test('recorded native response usage survives compact export and reopen, and tampering invalidates it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-recorded-export-'));
  try {
    const compact = compactAuditTrial({ runs: [run()] }).runs[0];
    assert.equal(compact.usage.recorded.status, 'complete');
    assert.equal(compact.usage.recorded.values.totalTokens, 15);
    const receipt = await exportAuditReport({ ...compact, schemaVersion: 1, kind: 'audit-run' }, { output: join(directory, 'run.json') });
    const reopened = await readAuditReport(receipt.evidencePath);
    assert.equal(reopened.usage.recorded.status, 'complete');
    assert.match(renderAudit(reopened), /Recorded response usage: complete/);
    assert.match(renderAudit(reopened), /prior lifetime baseline/);

    const tampered = JSON.parse(await readFile(receipt.evidencePath, 'utf8'));
    tampered.usage.recorded.threads[0].records[0].usage.totalTokens = 999;
    await writeFile(receipt.evidencePath, JSON.stringify(tampered));
    const rejected = await readAuditReport(receipt.evidencePath);
    assert.notEqual(rejected.usage.recorded.status, 'complete');
    assert.equal(rejected.usage.recorded.values.totalTokens, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('byte compaction and omitted response records cannot retain precomputed totals', () => {
  const runValue = run();
  // A legacy/fresh source cannot smuggle a historical projection into the report.
  const rejectedSource = compactAuditTrial({ runs: [{ ...runValue,
    source: { kind: 'native-app-server-v2', version, freshThread: true } }] }).runs[0];
  assert.equal(Object.hasOwn(rejectedSource.usage, 'recorded'), false);

  const budgeted = compactAuditTrial({ runs: [denseRun('a'), denseRun('b'), denseRun('c')] }, { maxBytes: 300 * 1024 });
  assert.ok(budgeted.runs.some(item => item.usage.recorded.status !== 'complete'
    && item.usage.recorded.values.totalTokens === null
    && item.evidenceBounds.omitted.recordedResponseRecords >= 512));

  // Precomputed wrapper totals are never accepted when records have been omitted.
  const missing = structuredClone(runValue);
  missing.usage.recorded.threads[0].records = [];
  const compact = compactAuditTrial({ runs: [missing] }).runs[0];
  assert.notEqual(compact.usage.recorded.status, 'complete');
  assert.equal(compact.usage.recorded.values.totalTokens, null);
});

test('recorded response comparison requires compatible complete contracts and unique role/turn alignment', () => {
  const left = compactAuditTrial({ runs: [run('left')] }).runs[0];
  const right = compactAuditTrial({ runs: [run('right')] }).runs[0];
  const comparisonReport = compareAuditRuns(left, right);
  const comparison = comparisonReport.comparison.usage.recordedResponseUsage;
  assert.equal(comparison.status, 'complete');
  assert.equal(comparison.scope, 'uniquely-aligned-recorded-response-turns');
  assert.equal(comparison.fields.totalTokens[0].delta, 0);
  assert.match(renderAudit(comparisonReport), /Recorded response usage comparison: complete/);

  const unknown = compareAuditRuns(left, { ...right, source: { kind: 'native-rollout', clientVersion: 'other' } })
    .comparison.usage.recordedResponseUsage;
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.fields.totalTokens.length, 0);
});

test('fresh and legacy comparisons do not gain a historical usage field', () => {
  const left = { id: 'fresh-left', source: { kind: 'native-app-server-v2', version, historyMode: 'paginated', freshThread: true },
    agents: [], turns: [], usage: {} };
  const right = { ...left, id: 'fresh-right' };
  const comparison = compareAuditRuns(left, right).comparison.usage;
  assert.equal(Object.hasOwn(comparison, 'recordedResponseUsage'), false);
});

test('a self-consistent recorded block pasted under a different native rollout stays unavailable', () => {
  const foreign = run('foreign-source');
  const victim = run('victim-source');
  victim.usage.recorded = structuredClone(foreign.usage.recorded);
  const compact = compactAuditTrial({ runs: [victim] }).runs[0];
  assert.equal(compact.usage.recorded.status, 'unavailable');
  assert.equal(compact.usage.recorded.reason, 'source-binding-unverified');
  assert.equal(compact.usage.recorded.values.totalTokens, null);
});

test('recorded usage is unavailable when a selected agent source no longer matches its binding', () => {
  const changed = run('agent-source');
  changed.agents[0].source = { ...changed.agents[0].source,
    fingerprint: createHash('sha256').update('changed-agent-source').digest('hex') };
  const compact = compactAuditTrial({ runs: [changed] }).runs[0];
  assert.equal(compact.usage.recorded.status, 'unavailable');
  assert.equal(compact.usage.recorded.reason, 'source-binding-unverified');
  assert.equal(compact.usage.recorded.values.totalTokens, null);
});

test('reopening a tampered comparison recomputes recorded deltas from its validated sides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-recorded-comparison-'));
  try {
    const left = compactAuditTrial({ runs: [run('left')] }).runs[0];
    const right = compactAuditTrial({ runs: [run('right')] }).runs[0];
    const comparison = compareAuditRuns(left, right);
    const receipt = await exportAuditReport(comparison, { output: join(directory, 'comparison.json') });
    const tampered = JSON.parse(await readFile(receipt.evidencePath, 'utf8'));
    tampered.left.usage.recorded.threads[0].records[0].usage.totalTokens = 999;
    await writeFile(receipt.evidencePath, JSON.stringify(tampered));
    const reopened = await readAuditReport(receipt.evidencePath);
    assert.equal(reopened.comparison.usage.recordedResponseUsage.status, 'unknown');
    assert.equal(reopened.comparison.usage.recordedResponseUsage.fields.totalTokens.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
