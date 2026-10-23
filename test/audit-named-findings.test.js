import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bookingLedgerPair } from '../test-support/audit-explanation/booking-ledger.js';
import { buildAuditExplanation, freezeAuditComparisonEvidence } from '../src/audit-explanation.js';
import { compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

function action(run, kind, targets, sourceLine, { subjects = [], exitCode = 0, callId = `${kind}-${sourceLine}` } = {}) {
  return { kind, name: ({ read: 'read-files', edit: 'edit-files', 'visible-test': 'run-test-file', 'inline-assertion': 'inline-assertion' })[kind],
    targets, subjects, agentId: run.agents[0].id, turnId: run.turns[0].turnId, callId, sourceLine, resultSourceLine: sourceLine + 1, resultIndex: null,
    resultScope: 'action', invocationIndex: 0, exitCode, sourceFingerprint: run.agents[0].source.fingerprint };
}

test('named action findings are turn-scoped, line-backed, status-bound, and survive compaction/export', async () => {
  const pair = bookingLedgerPair();
  pair[0].actions = [action(pair[0], 'read', ['AGENTS.md'], 2), action(pair[0], 'read', ['src/math.js'], 4),
    action(pair[0], 'read', ['test/math.test.js'], 6), action(pair[0], 'edit', ['src/math.js'], 10),
    action(pair[0], 'visible-test', ['test/math.test.js'], 12),
    action(pair[0], 'inline-assertion', [], 14, { subjects: ['maximum-safe-integer'] })];
  pair[1].actions = [action(pair[1], 'read', ['AGENTS.md'], 2), action(pair[1], 'read', ['src/math.js'], 12),
    action(pair[1], 'read', ['test/math.test.js'], 6), action(pair[1], 'edit', ['src/math.js'], 10),
    action(pair[1], 'visible-test', ['test/math.test.js'], 12),
    action(pair[1], 'inline-assertion', [], 14, { subjects: ['null-input'] })];
  pair[0].nativeControls = { schemaVersion: 1,
    configured: { model: 'configured-model', modelReasoningEffort: 'medium', planModeReasoningEffort: null, loginMethod: 'chatgpt' },
    startup: { agentId: pair[0].agents[0].id, model: 'startup-model', reasoningEffort: 'low', source: 'thread/start' },
    turns: [{ agentId: pair[0].turns[0].agentId, turnId: pair[0].turns[0].turnId, model: pair[0].turns[0].model,
      reasoningEffort: pair[0].turns[0].reasoningEffort, sourceLine: 3, sourceFingerprint: pair[0].agents[0].source.fingerprint, workspaceMatched: true, source: 'turn_context' }] };
  // Native action provenance can bind through exact turn_context when an RPC actor lacks a source fingerprint.
  pair[0].agents[0].source.fingerprint = null;

  const explanation = buildAuditExplanation(...pair);
  const find = rule => explanation.findings.find(row => row.rule === rule);
  assert.equal(find('named-contract-read-before-edit').left.assertion, 'read-invocation-before-edit-invocation');
  assert.equal(find('named-source-read-before-edit').classification, 'different');
  assert.equal(find('named-test-read-before-edit').left.assertion, 'read-invocation-before-edit-invocation');
  assert.equal(find('named-visible-test-execution').left.actions[0].status, 'passed');
  assert.equal(find('named-inline-edge-assertions').classification, 'different');
  assert.deepEqual(find('named-inline-edge-assertions').left.recordedScriptSubjects, ['maximum-safe-integer']);
  assert.ok(find('named-contract-read-before-edit').left.evidenceRefs.every(ref => explanation.evidence.namedActions.left.some(row => row.id === ref)));

  const core = freezeAuditComparisonEvidence(pair[0]);
  assert.equal(core.namedActions.length, 6);
  assert.equal(core.nativeControls.startup.model, 'startup-model');
  assert.equal(core.nativeControls.turns[0].model, 'fixture-model');
  assert.equal(core.nativeControls.configured.model, 'configured-model');
  assert.equal(core.nativeControls.startup.model, 'startup-model');
  assert.equal(core.nativeControls.turns[0].model, 'fixture-model');
  const compact = compactAuditTrial({ runs: pair });
  assert.deepEqual(buildAuditExplanation(...compact.runs), explanation);
  const report = compareAuditRuns(...pair);
  for (const format of ['terminal', 'markdown']) {
    const text = renderAudit(report, { format }).replaceAll('\\-', '-');
    assert.match(text, /configured nativeConfig/);
    assert.match(text, /native startup/);
    assert.match(text, /observed per-turn controls/);
    assert.match(text, /maximum-safe-integer/);
    assert.match(text, /result line/);
    assert.match(text, /Named visible-test execution/);
  }
  const directory = await mkdtemp(join(tmpdir(), 'xfx-named-actions-'));
  try {
    const receipt = await exportAuditReport(report, { output: join(directory, 'comparison.json') });
    const reopened = await readAuditReport(receipt.evidencePath);
    assert.deepEqual(reopened.comparison.explanation, report.comparison.explanation);
    assert.match(renderAudit(reopened, { format: 'markdown' }).replaceAll('\\-', '-'), /maximum-safe-integer/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('renderer identifies retained read projections without claiming original capture bytes', () => {
  const pair = bookingLedgerPair();
  pair[0].reportProjection = 'read-time-retained-snapshot';
  const report = compareAuditRuns(...pair);
  const text = renderAudit(report, { format: 'markdown' }).replaceAll('\\-', '-');
  assert.match(text, /read-time retained snapshot; this projection does not prove original capture bytes/);
});

test('missing named actions and unproven exit codes stay unknown; generic command counts do not fill them', () => {
  const pair = bookingLedgerPair();
  pair[0].actions = [action(pair[0], 'visible-test', ['test/math.test.js'], 10, { exitCode: null })];
  pair[0].events = [{ kind: 'tool-call', tool: 'exec_command', count: 99 }];
  const finding = buildAuditExplanation(...pair).findings.find(row => row.rule === 'named-visible-test-execution');
  assert.equal(finding.left.actions[0].status, 'unknown');
  assert.equal(finding.right.state, 'unknown');
  assert.equal(finding.classification, 'inconclusive');
  assert.deepEqual(finding.right.evidenceRefs, []);
});

test('a matching named visible test can report different exact process exit outcomes', () => {
  const pair = bookingLedgerPair();
  pair[0].actions = [action(pair[0], 'visible-test', ['test/math.test.js'], 10, { exitCode: 0 })];
  pair[1].actions = [action(pair[1], 'visible-test', ['test/math.test.js'], 10, { exitCode: 1 })];
  const finding = buildAuditExplanation(...pair).findings.find(row => row.rule === 'named-visible-test-execution');
  assert.equal(finding.classification, 'different');
  assert.equal(finding.left.actions[0].status, 'passed');
  assert.equal(finding.right.actions[0].status, 'failed');
});

test('invocation-scoped results do not claim each operation or assertion succeeded', () => {
  const pair = bookingLedgerPair();
  pair[0].actions = [action(pair[0], 'visible-test', ['test/math.test.js'], 10, { exitCode: 0 })];
  pair[1].actions = [action(pair[1], 'visible-test', ['test/math.test.js'], 10, { exitCode: 0 })];
  pair[0].actions[0].resultScope = 'invocation';
  pair[1].actions[0].resultScope = 'invocation';
  pair[0].actions.push(action(pair[0], 'inline-assertion', [], 12, { subjects: ['null-input'] }));
  pair[0].actions.at(-1).resultScope = 'invocation';
  const explanation = buildAuditExplanation(...pair);
  const testFinding = explanation.findings.find(row => row.rule === 'named-visible-test-execution');
  const assertionFinding = explanation.findings.find(row => row.rule === 'named-inline-edge-assertions');
  assert.equal(testFinding.left.actions[0].status, 'invocation-passed');
  assert.equal(testFinding.classification, 'inconclusive');
  assert.deepEqual(assertionFinding.left.recordedScriptSubjects, ['null-input']);
  assert.deepEqual(assertionFinding.left.exitZeroScriptSubjects, ['null-input']);
  assert.match(assertionFinding.limitation, /individual assertions and branches remain unverified/);
});

test('a bound pending rubric remains pending and is never rendered as a review score', () => {
  const pair = bookingLedgerPair(), fingerprint = 'a'.repeat(64);
  for (const run of pair) {
    run.comparisonConditions.qualityFingerprint = fingerprint;
    run.quality = { fingerprint, rubric: { status: 'pending-review', rubricId: 'quality', rubricVersion: '1', scorePercent: null } };
  }
  const explanation = buildAuditExplanation(...pair);
  assert.equal(explanation.verification.left.human.status, 'pending-review');
  assert.equal(explanation.verification.left.human.scorePercent, null);
  assert.equal(explanation.outcomes.human.status, 'inconclusive');
  assert.match(renderAudit(compareAuditRuns(...pair)), /pending-review/);
});
