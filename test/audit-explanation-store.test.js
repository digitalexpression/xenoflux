import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareAuditRuns } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport, projectReportResourceProvenance } from '../src/audit-store.js';
import { bookingLedgerPair } from '../test-support/audit-explanation/booking-ledger.js';

test('frozen comparison regenerates findings and gates tampered deltas on source-free reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-explanation-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [left, right] = bookingLedgerPair();
  const report = compareAuditRuns(left, right);
  report.comparison.explanation = { narrative: 'UNTRUSTED_SENTINEL', findings: [] };
  const metricName = Object.keys(report.comparison.metrics)[0];
  report.comparison.metrics[metricName].delta = 999999;
  const output = join(directory, 'comparison.json');
  const receipt = await exportAuditReport(report, { output });
  const exported = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(exported.comparison.explanation.narrative, undefined);
  assert.equal(exported.comparison.explanation.findings.length > 0, true);
  assert.notEqual(exported.comparison.metrics[metricName].delta, 999999);
  assert.equal(JSON.stringify(exported).includes('UNTRUSTED_SENTINEL'), false);
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened.comparison.explanation, exported.comparison.explanation);
  assert.deepEqual(reopened.comparison.metrics, exported.comparison.metrics);

  const markdownPath = join(directory, 'comparison.md');
  const markdownReceipt = await exportAuditReport(report, { output: markdownPath, format: 'markdown' });
  const sidecar = await readAuditReport(markdownReceipt.evidencePath);
  assert.deepEqual(sidecar.comparison.explanation, reopened.comparison.explanation);
});

test('unsupported or cross-run frozen core cannot upgrade evidence and conflicts survive check normalization', () => {
  const [runA, runB] = bookingLedgerPair();
  const normalized = projectReportResourceProvenance({ schemaVersion: 1, kind: 'audit-run', ...runA,
    comparisonEvidence: { schemaVersion: 99, status: 'recorded' } });
  assert.equal(normalized.comparisonEvidence.status, 'unavailable');
  assert.equal(normalized.comparisonEvidence.reason, 'unsupported-comparison-evidence-version');

  const comparison = compareAuditRuns(runA, runB);
  comparison.left.comparisonEvidence = { schemaVersion: 1, status: 'unavailable', reason: 'other-run' };
  const path = projectReportResourceProvenance(comparison);
  assert.equal(path.left.comparisonEvidence.status, 'unavailable');
  assert.equal(path.comparison.explanation.conditions.eligible, false);

  const conflicting = projectReportResourceProvenance({ schemaVersion: 1, kind: 'audit-run', ...runA,
    checks: [{ name: 'scope', status: 'passed', exitCode: 0 }],
    outcome: { checks: [{ name: 'scope', status: 'failed', exitCode: 1 }] } });
  assert.equal(conflicting.checks[0].status, 'unknown');
  assert.equal(conflicting.checks[0].reason, 'conflicting-check-evidence');
});

test('nested trial explanations are rebound to exact runs and ineligible series aggregates lose only deltas', () => {
  const [left, right] = bookingLedgerPair();
  right.comparisonConditions = { ...right.comparisonConditions, taskFingerprint: 'f'.repeat(64) };
  const report = { schemaVersion: 1, kind: 'audit-series-report', id: 'fixture-series', trials: [{ index: 0, runs: [left, right],
    comparisons: [{ leftRunId: left.id, rightRunId: right.id, explanation: { findings: [{ title: 'TAMPERED' }] } }] }],
  comparisons: [{ left: left.profile.profileId, right: right.profile.profileId, qualityDelta: 0.8,
    reviewDelta: { plannedN: 1, pairedN: 1, delta: 10 }, metrics: { taskMs: { leftMedian: 1, rightMedian: 2, delta: 1, pairedN: 1 } } }] };
  const normalized = projectReportResourceProvenance(report);
  const comparison = normalized.trials[0].comparisons[0];
  assert.notEqual(comparison.explanation.findings?.[0]?.title, 'TAMPERED');
  assert.equal(comparison.explanation.conditions.eligible, false);
  assert.equal(normalized.comparisons[0].qualityDelta, null);
  assert.equal(normalized.comparisons[0].reviewDelta.delta, null);
  assert.equal(normalized.comparisons[0].metrics.taskMs.delta, null);
  assert.equal(normalized.comparisons[0].metrics.taskMs.leftObservedN, 1);
  assert.equal(normalized.comparisons[0].metrics.taskMs.rightObservedN, 1);
  assert.equal(normalized.comparisons[0].metrics.taskMs.excludedN, 1);
});

test('nested human review is joined from exact profile quality and a missing arm remains unknown', () => {
  const [left, right] = bookingLedgerPair();
  const fingerprint = left.comparisonConditions.qualityFingerprint;
  const quality = { fingerprint, rubric: { status: 'reviewed', rubricId: 'fixture-rubric', rubricVersion: '1', scorePercent: 80 },
    review: { runId: left.id, fingerprint } };
  const report = { schemaVersion: 1, kind: 'audit-series-report', id: 'fixture-review-series', trials: [{ index: 0,
    profiles: [{ run: left, quality }, { run: right, quality: { fingerprint, rubric: { status: 'not-reviewed' } } }],
    comparisons: [
      { leftRunId: left.id, rightRunId: right.id, explanation: {} },
      { leftRunId: left.id, rightRunId: 'missing-run', explanation: {} },
    ] }] };
  const normalized = projectReportResourceProvenance(report);
  const [paired, missing] = normalized.trials[0].comparisons.map(row => row.explanation);
  assert.equal(paired.verification.left.human.status, 'reviewed');
  assert.equal(paired.verification.left.human.scorePercent, 80);
  assert.equal(paired.verification.right.human.status, 'not-recorded');
  assert.equal(missing.conditions.eligible, false);
  assert.equal(missing.consistency.missingPairs, 1);
  assert.equal(missing.verification.left.human.status, 'reviewed');
  assert.equal(normalized.trials[0].profiles[0].run.comparisonEvidence.verification.human.status, 'not-recorded',
    'quality projection must not rewrite the frozen comparison core');
});

test('eligible series metrics are recomputed and check deltas stay unknown when recipes differ', () => {
  const [left, right] = bookingLedgerPair();
  right.comparisonConditions = { ...right.comparisonConditions, checkRecipes: [{ name: 'scope', fingerprint: 'f'.repeat(64) }] };
  const report = { schemaVersion: 1, kind: 'audit-series-report', id: 'tampered-series', trials: [{ index: 0,
    profiles: [{ profileId: left.profile.profileId, profileName: 'A', run: left, quality: { fingerprint: left.comparisonConditions.qualityFingerprint, status: 'passed' } },
      { profileId: right.profile.profileId, profileName: 'B', run: right, quality: { fingerprint: right.comparisonConditions.qualityFingerprint, status: 'failed' } }],
    comparisons: [{ leftRunId: left.id, rightRunId: right.id, explanation: {} }] }],
  comparisons: [{ left: left.profile.profileId, right: right.profile.profileId, qualityDelta: 1,
    qualityDeltaEvidence: { plannedN: 1, pairedN: 1 },
    metrics: { taskMs: { leftMedian: 1, rightMedian: 999, delta: 998, plannedN: 1, pairedN: 1 } } }] };
  const normalized = projectReportResourceProvenance(report);
  const summary = normalized.comparisons[0];
  assert.equal(summary.qualityDelta, -1);
  assert.equal(summary.qualityDeltaEvidence.excludedN, 0);
  assert.equal(summary.qualityDeltaEvidence.reason, null);
  assert.equal(summary.metrics.taskMs.delta, 25);
  assert.equal(summary.metrics.taskMs.pairedN, 1);
});

test('series quality delta rejects profile results whose fingerprints do not match frozen definitions', () => {
  const [left, right] = bookingLedgerPair();
  const report = { schemaVersion: 1, kind: 'audit-series-report', id: 'wrong-quality-definition', trials: [{ index: 0,
    profiles: [{ profileId: left.profile.profileId, run: left, quality: { fingerprint: 'f'.repeat(64), status: 'passed' } },
      { profileId: right.profile.profileId, run: right, quality: { fingerprint: 'f'.repeat(64), status: 'failed' } }] }],
  comparisons: [{ left: left.profile.profileId, right: right.profile.profileId, qualityDelta: -1,
    qualityDeltaEvidence: { pairedN: 1, plannedN: 1 } }] };
  const comparison = projectReportResourceProvenance(report).comparisons[0];
  assert.equal(comparison.qualityDelta, null);
  assert.equal(comparison.qualityDeltaEvidence.pairedN, 0);
  assert.equal(comparison.qualityDeltaEvidence.excludedN, 1);
  assert.equal(comparison.qualityDeltaEvidence.eligibilityReasons['quality-definition-fingerprint-mismatch'], 1);
});

test('series review aggregate rejects out-of-range scores despite valid run and review bindings', () => {
  const [left, right] = bookingLedgerPair();
  const qualityFor = (run, scorePercent) => ({ fingerprint: run.comparisonConditions.qualityFingerprint,
    rubric: { status: 'reviewed', rubricId: 'fixture-rubric', rubricVersion: '1', scorePercent },
    review: { runId: run.id, fingerprint: run.comparisonConditions.qualityFingerprint } });
  const report = { schemaVersion: 1, kind: 'audit-series-report', id: 'invalid-review-score', trials: [{ index: 0,
    profiles: [{ profileId: left.profile.profileId, run: left, quality: qualityFor(left, 80) },
      { profileId: right.profile.profileId, run: right, quality: qualityFor(right, 500) }] }],
  comparisons: [{ left: left.profile.profileId, right: right.profile.profileId,
    reviewDelta: { rubricId: 'fixture-rubric', rubricVersion: '1', delta: 420, plannedN: 1, pairedN: 1 } }] };
  const reviewDelta = projectReportResourceProvenance(report).comparisons[0].reviewDelta;
  assert.equal(reviewDelta.delta, null);
  assert.equal(reviewDelta.pairedN, 0);
  assert.equal(reviewDelta.missingEligiblePairN, 1);
  assert.equal(reviewDelta.reason, 'incomplete-paired-reviews');
});

test('series aggregate recomputation retains an explicitly planned missing arm', () => {
  const [left, right] = bookingLedgerPair();
  const report = { schemaVersion: 1, kind: 'audit-series-report', id: 'missing-arm-series', trials: [{ index: 0,
    profileOrder: ['A', 'B'], profiles: [{ profileId: left.profile.profileId, profileName: 'A', run: left }],
  }], comparisons: [{ left: left.profile.profileId, right: right.profile.profileId,
    metrics: { taskMs: { leftMedian: 100, rightMedian: 100, delta: 0, plannedN: 1, pairedN: 1 } } }] };
  const comparison = projectReportResourceProvenance(report).comparisons[0];
  assert.equal(comparison.metrics.taskMs.plannedN, 1);
  assert.equal(comparison.metrics.taskMs.leftObservedN, 1);
  assert.equal(comparison.metrics.taskMs.rightObservedN, 0);
  assert.equal(comparison.metrics.taskMs.missingRightN, 1);
  assert.equal(comparison.metrics.taskMs.pairedN, 0);
  assert.equal(comparison.metrics.taskMs.delta, null);
});


test('frozen expectation status and source references are regenerated from the declared controls', () => {
  const [left, right] = bookingLedgerPair();
  const report = compareAuditRuns(left, right, { expectModel: 'other-model', expectEffort: 'high' });
  report.comparison.expectation.status = 'match'; report.comparison.expectation.mismatches = [];
  const normalized = projectReportResourceProvenance(report);
  assert.equal(normalized.comparison.expectation.status, 'different');
  assert.equal(normalized.comparison.expectation.mismatches.length, 2);
});
