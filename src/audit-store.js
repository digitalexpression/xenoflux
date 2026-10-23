// Explicit immutable report export. Native transcripts remain in their owning homes.
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { compareAuditRuns, renderAudit, auditExitCode } from './audit-report.js';
import { projectResourceProvenance, compareResourceProvenance } from './audit-provenance.js';
import { recordedUsageAccounting, projectRunRecordedUsage, deriveRecordedUsage } from './audit-recorded-usage.js';
import { projectDeliveryAccounting, projectTelemetryJournal } from './audit-delivery.js';
import { projectSourceTimeRow as normalizeSourceTimeRow, projectRunSkillSourceTimes } from './audit-source-time.js';
import { canonicalAuditChecks, freezeAuditComparisonEvidence, compareAuditConditions, buildAuditExplanation, gateAuditComparisonDeltas } from './audit-explanation.js';
import { auditMetricSamples } from './audit-statistics.js';
import { retainedAuditSelectionOptions } from './audit-selection.js';
import { buildAuditReviewPacket, projectAuditReviewState } from './audit-review.js';
import { buildAuditConsistency } from './audit-consistency.js';
import { projectAuditSessionEvidence } from './audit-session-evidence.js';

const KINDS = new Set(['audit-run', 'audit-comparison', 'audit-profile', 'audit-profile-comparison', 'audit-experiment-report', 'audit-series-report', 'audit-evaluation-report']);
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

function validate(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !KINDS.has(value.kind))
    throw new Error('Unsupported frozen audit report; use an exported schemaVersion 1 JSON report');
  return value;
}

function normalizeTelemetrySummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return summary;
  const out = { ...summary };
  if (Object.hasOwn(summary, 'deliveryAccounting')) out.deliveryAccounting = projectDeliveryAccounting(summary.deliveryAccounting);
  if (Object.hasOwn(summary, 'journal')) out.journal = projectTelemetryJournal(summary.journal);
  return out;
}

function normalizeInvocationSummary(summary) {
  const out = normalizeTelemetrySummary(summary);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  return { ...out,
    ...(Array.isArray(out.invocations) ? { invocations: out.invocations.map(item => normalizeSourceTimeRow(item)) } : {}),
    ...(Array.isArray(out.incomplete) ? { incomplete: out.incomplete.map(item => normalizeSourceTimeRow(item)) } : {}) };
}

// Normalize only documented report locations; arbitrary nested user data is never traversed.
function normalizeRun(run, { comparison = false } = {}) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return run;
  let out = projectRunSkillSourceTimes(run);
  if (Object.hasOwn(run, 'sessionEvidence')) out = { ...out, sessionEvidence: projectAuditSessionEvidence(run) };
  if (comparison) {
    const comparisonEvidence = freezeAuditComparisonEvidence(out);
    if (comparisonEvidence) out = { ...out, comparisonEvidence };
    else if (Object.hasOwn(out, 'comparisonEvidence')) { out = { ...out }; delete out.comparisonEvidence; }
    const checks = canonicalAuditChecks(out);
    if (checks) out = { ...out, checks };
  }
  if (Object.hasOwn(run, 'resourceProvenance')) out = { ...out, resourceProvenance: projectResourceProvenance(run.resourceProvenance) };
  if (run.skillTelemetry && typeof run.skillTelemetry === 'object' && !Array.isArray(run.skillTelemetry)) {
    const telemetry = run.skillTelemetry, diagnostics = telemetry.diagnostics;
    if (diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics)) {
      const projected = { ...diagnostics };
      if (Object.hasOwn(diagnostics, 'deliveryAccounting')) projected.deliveryAccounting = projectDeliveryAccounting(diagnostics.deliveryAccounting);
      if (Object.hasOwn(diagnostics, 'journal')) projected.journal = projectTelemetryJournal(diagnostics.journal);
      out = { ...out, skillTelemetry: { ...telemetry, diagnostics: projected } };
    }
  }
  // Older live captures exposed journal health on `capture` as a second,
  // unversioned path. Keep the normalized diagnostics location canonical.
  if (run.capture && typeof run.capture === 'object' && !Array.isArray(run.capture)
    && (Object.hasOwn(run.capture, 'skillTelemetryJournal') || Object.hasOwn(run.capture, 'skillTelemetry'))) {
    const capture = { ...run.capture }; delete capture.skillTelemetryJournal; delete capture.skillTelemetry;
    out = { ...out, capture };
  }
  if (Object.hasOwn(run.usage ?? {}, 'recorded')) {
    const expected = run.source?.kind === 'native-rollout' ? recordedUsageAccounting(run.source.clientVersion) : null;
    if (!expected) {
      const usage = { ...(run.usage ?? {}) }; delete usage.recorded;
      out = { ...out, usage };
    } else {
      out = { ...out, usage: { ...(run.usage ?? {}), recorded: projectRunRecordedUsage(run)
        ?? deriveRecordedUsage({ rootAgentId: run.source.nativeSessionId, threads: [], source: run.source }) } };
    }
  }
  return out;
}
function normalizeTrial(trial, depth = 0) {
  if (!trial || typeof trial !== 'object' || Array.isArray(trial)) return trial;
  const normalized = { ...trial,
    ...(Array.isArray(trial.reviewEvaluations) ? { reviewEvaluations: trial.reviewEvaluations.map(entry => ({ ...entry,
      report: projectReportResourceProvenance(entry.report, depth + 1) })) } : {}),
    ...(Array.isArray(trial.runs) ? { runs: trial.runs.map(run => normalizeRun(run, { comparison: true })) } : {}),
    ...(Array.isArray(trial.profiles) ? { profiles: trial.profiles.map(profile => ({ ...profile,
      ...(profile?.run ? { run: normalizeRun(profile.run, { comparison: true }) } : {}) })) } : {}) };
  const explanationRuns = normalized.runs ?? normalized.profiles?.map(profile => profile?.run
    ? { ...profile.run, quality: profile.quality } : null).filter(Boolean) ?? [];
  if (Array.isArray(trial.comparisons)) normalized.comparisons = trial.comparisons.map(comparison => {
    if (!comparison || typeof comparison !== 'object') return comparison;
    const left = explanationRuns.find(run => run?.id === comparison.leftRunId);
    const right = explanationRuns.find(run => run?.id === comparison.rightRunId);
    return { ...comparison, explanation: buildAuditExplanation(left ?? null, right ?? null,
      retainedAuditSelectionOptions(trial.selection)) };
  });
  return normalized;
}

function normalizeComparison(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const left = value.left ? normalizeRun(value.left, { comparison: true }) : value.left;
  const right = value.right ? normalizeRun(value.right, { comparison: true }) : value.right;
  let comparison = value.comparison;
  if (comparison && typeof comparison === 'object' && left && right) {
    const selectionOptions = retainedAuditSelectionOptions(value.selection);
    const eligibility = compareAuditConditions(left, right, selectionOptions);
    // Recompute grouped measurements from the validated frozen sides. Preserve explicit expectation controls.
    const expectation = comparison.expectation;
    const controls = expectation?.model && expectation?.reasoningEffort
      ? { expectModel: expectation.model, expectEffort: expectation.reasoningEffort } : {};
    const regeneratedReport = compareAuditRuns(left, right, { ...controls, ...selectionOptions });
    const regenerated = regeneratedReport.comparison;
    comparison = gateAuditComparisonDeltas({ ...comparison, ...regenerated,
      expectation: regenerated.expectation }, eligibility);
    comparison.explanation = regenerated.explanation;
    value = { ...value, selection: regeneratedReport.selection };
  }
  return { ...value, ...(left ? { left } : {}), ...(right ? { right } : {}), ...(comparison ? { comparison } : {}) };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function plannedTrialProfiles(trial) {
  if (Array.isArray(trial?.profiles)) return trial.profiles;
  return (trial?.runs ?? []).map(run => ({ profileId: run?.profileId ?? run?.profile?.profileId ?? run?.profile?.id,
    profileName: run?.profileName ?? run?.profile?.profileName ?? run?.profile?.name, run, quality: run?.quality }));
}
function matchTrialProfile(trial, selector) {
  const profiles = plannedTrialProfiles(trial);
  return profiles.find(profile => profile?.profileId === selector || profile?.id === selector
    || profile?.run?.profileId === selector || profile?.run?.profile?.profileId === selector)
    ?? profiles.find(profile => profile?.profileName === selector || profile?.name === selector
      || profile?.run?.profile?.profileName === selector);
}
function seriesReview(profile, run) {
  const quality = profile?.quality, review = quality?.review, rubric = quality?.rubric;
  const fingerprint = quality?.fingerprint;
  if (!run || rubric?.status !== 'reviewed' || review?.runId !== run.id || !fingerprint
    || review.fingerprint !== fingerprint || fingerprint !== run.comparisonConditions?.qualityFingerprint) return null;
  const rubricId = rubric.rubricId, rubricVersion = rubric.rubricVersion;
  const score = quality.scorePercent ?? rubric.scorePercent;
  if (typeof rubricId !== 'string' || typeof rubricVersion !== 'string' || typeof score !== 'number'
    || !Number.isFinite(score) || score < 0 || score > 100) return null;
  return { rubricId, rubricVersion, score };
}
function rebuildSeriesComparison(row, trials) {
  if (!row || typeof row !== 'object') return row;
  const pairs = trials.map((trial, index) => ({ index, left: matchTrialProfile(trial, row.left), right: matchTrialProfile(trial, row.right),
    selection: retainedAuditSelectionOptions(trial.selection),
    planned: [row.left, row.right].every(id => (trial?.profileOrder ?? []).some(profile =>
      (typeof profile === 'string' ? profile : profile?.profileId ?? profile?.profileName) === id)) }))
    .filter(pair => pair.left || pair.right || pair.planned);
  const metrics = {};
  const names = new Set(Object.keys(row.metrics ?? {}));
  for (const pair of pairs) {
    for (const name of Object.keys(auditMetricSamples(pair.left?.run))) names.add(name);
    for (const name of Object.keys(auditMetricSamples(pair.right?.run))) names.add(name);
  }
  for (const name of names) {
    let leftObservedN = 0, rightObservedN = 0, pairedN = 0, eligibleN = 0, excludedN = 0, scopeMismatchN = 0;
    const eligibilityReasons = {}, differences = [], leftValues = [], rightValues = [];
    for (const pair of pairs) {
      const leftRun = pair.left?.run, rightRun = pair.right?.run;
      const leftSample = auditMetricSamples(leftRun)[name], rightSample = auditMetricSamples(rightRun)[name];
      if (leftSample) leftObservedN++;
      if (rightSample) rightObservedN++;
      const eligibility = compareAuditConditions(leftRun, rightRun, pair.selection);
      if (!eligibility.eligible) {
        excludedN++;
        for (const reason of eligibility.reasons.length ? eligibility.reasons : [eligibility.status])
          eligibilityReasons[reason] = (eligibilityReasons[reason] ?? 0) + 1;
        continue;
      }
      eligibleN++;
      if (!leftSample || !rightSample) continue;
      if (leftSample.scope !== rightSample.scope || leftSample.source !== rightSample.source
        || name === 'workspace.changedFileCount' && !verifiedSameBaseline(leftRun, rightRun)) { scopeMismatchN++; continue; }
      pairedN++; leftValues.push(leftSample.value); rightValues.push(rightSample.value);
      differences.push(rightSample.value - leftSample.value);
    }
    const reason = excludedN ? 'ineligible-comparison-conditions' : scopeMismatchN ? 'metric-evidence-scope-mismatch'
      : pairedN === 0 ? 'no-paired-metric-samples' : pairedN < pairs.length ? 'incomplete-paired-measurements' : null;
    metrics[name] = { leftMedian: median(leftValues), rightMedian: median(rightValues), delta: pairedN ? median(differences) : null,
      plannedN: pairs.length, leftObservedN, rightObservedN, pairedN, missingLeftN: pairs.length - leftObservedN,
      missingRightN: pairs.length - rightObservedN, missingPairN: pairs.length - pairedN, eligibleN, excludedN,
      eligibilityReasons, scopeMismatchN, reason };
  }

  let qualityEligibleN = 0, qualityExcludedN = 0, qualityMissingN = 0, qualityPairedN = 0, qualityLeftPassed = 0, qualityRightPassed = 0;
  const qualityEligibilityReasons = {};
  for (const pair of pairs) {
    const eligibility = compareAuditConditions(pair.left?.run, pair.right?.run, pair.selection);
    const qualityFingerprint = pair.left?.quality?.fingerprint;
    const leftDefinitionBound = typeof qualityFingerprint === 'string'
      && qualityFingerprint === pair.left?.run?.comparisonEvidence?.conditions?.qualityFingerprint;
    const rightDefinitionBound = typeof pair.right?.quality?.fingerprint === 'string'
      && pair.right.quality.fingerprint === pair.right?.run?.comparisonEvidence?.conditions?.qualityFingerprint;
    if (!eligibility.reviewEligible || !leftDefinitionBound || !rightDefinitionBound) {
      qualityExcludedN++;
      const reasons = eligibility.reasons.length ? eligibility.reasons
        : !leftDefinitionBound || !rightDefinitionBound ? ['quality-definition-fingerprint-mismatch']
          : [eligibility.reviewReason ?? 'quality-definition-unknown'];
      for (const reason of reasons)
        qualityEligibilityReasons[reason] = (qualityEligibilityReasons[reason] ?? 0) + 1;
      continue;
    }
    qualityEligibleN++;
    const l = pair.left?.quality?.status, r = pair.right?.quality?.status;
    if (!['passed', 'failed'].includes(l) || !['passed', 'failed'].includes(r)) { qualityMissingN++; continue; }
    qualityPairedN++;
    if (l === 'passed') qualityLeftPassed++;
    if (r === 'passed') qualityRightPassed++;
  }
  const qualityDelta = qualityEligibleN && !qualityMissingN && !qualityExcludedN
    ? qualityRightPassed / qualityPairedN - qualityLeftPassed / qualityPairedN : null;

  let reviewDelta;
  const reviewDifferences = [], reviewEligibilityReasons = {};
  let reviewEligibleN = 0, reviewExcludedN = 0, missingEligiblePairN = 0;
  let reviewRubric = null;
  const hasReviewEvidence = pairs.some(pair => pair.left?.quality?.rubric?.status === 'reviewed'
    || pair.right?.quality?.rubric?.status === 'reviewed' || pair.left?.quality?.review || pair.right?.quality?.review);
  for (const pair of pairs) {
    const eligibility = compareAuditConditions(pair.left?.run, pair.right?.run, pair.selection);
    if (!eligibility.reviewEligible) {
      reviewExcludedN++;
      for (const reason of eligibility.reasons.length ? eligibility.reasons : [eligibility.reviewReason ?? 'review-definition-unknown'])
        reviewEligibilityReasons[reason] = (reviewEligibilityReasons[reason] ?? 0) + 1;
      continue;
    }
    reviewEligibleN++;
    const leftReview = seriesReview(pair.left, pair.left?.run), rightReview = seriesReview(pair.right, pair.right?.run);
    if (!leftReview || !rightReview || leftReview.rubricId !== rightReview.rubricId || leftReview.rubricVersion !== rightReview.rubricVersion
      || reviewRubric && (leftReview.rubricId !== reviewRubric.rubricId || leftReview.rubricVersion !== reviewRubric.rubricVersion)) {
      missingEligiblePairN++; continue;
    }
    reviewRubric ??= leftReview;
    reviewDifferences.push(rightReview.score - leftReview.score);
  }
  if (row.reviewDelta || hasReviewEvidence) reviewDelta = { rubricId: reviewRubric?.rubricId ?? null, rubricVersion: reviewRubric?.rubricVersion ?? null,
    plannedN: pairs.length, pairedN: reviewDifferences.length, eligibleN: reviewEligibleN, excludedN: reviewExcludedN,
    missingEligiblePairN, missingPairN: Math.max(0, reviewEligibleN - reviewDifferences.length), eligibilityReasons: reviewEligibilityReasons,
    delta: reviewDifferences.length && reviewDifferences.length === reviewEligibleN && !reviewExcludedN ? median(reviewDifferences) : null,
    reason: reviewExcludedN ? 'ineligible-comparison-conditions' : missingEligiblePairN ? 'incomplete-paired-reviews'
      : reviewDifferences.length ? null : 'no-paired-scored-reviews' };
  return { ...row, qualityDelta, qualityDeltaEvidence: { plannedN: pairs.length, eligibleN: qualityEligibleN, excludedN: qualityExcludedN,
    missingN: qualityMissingN, pairedN: qualityPairedN, eligibilityReasons: qualityEligibilityReasons,
    reason: qualityExcludedN ? 'ineligible-comparison-conditions' : qualityMissingN ? 'incomplete-paired-quality-outcomes'
      : qualityEligibleN ? null : 'no-eligible-paired-quality-outcomes' },
    ...(reviewDelta ? { reviewDelta } : {}), metrics };
}
function verifiedSameBaseline(left, right) {
  const a = left?.sourceWorkspace ?? left?.source?.baseline ?? left?.baseline ?? {};
  const b = right?.sourceWorkspace ?? right?.source?.baseline ?? right?.baseline ?? {};
  const aCommit = a.sourceCommit ?? a.commit, bCommit = b.sourceCommit ?? b.commit;
  const aTree = a.sourceTree ?? a.tree, bTree = b.sourceTree ?? b.tree;
  return Boolean(aCommit && aTree && bCommit && bTree && aCommit === bCommit && aTree === bTree);
}
/** Normalize provenance only at the fixed report and checkpoint layouts. */
export function projectReportResourceProvenance(value, depth = 0) {
  if (depth > 6) {
    const hasKnownLayout = value && typeof value === 'object' && (Array.isArray(value) || Object.hasOwn(value, 'resourceProvenance')
      || ['captureCheckpoint', 'state', 'record', 'report', 'run', 'series', 'trials', 'runs'].some(key => Object.hasOwn(value, key)));
    if (hasKnownLayout) throw new Error('Frozen report provenance layout exceeds the supported nesting depth');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => projectReportResourceProvenance(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  if (value.kind === 'audit-run') return normalizeRun(value, { comparison: true });
  if (value.kind === 'audit-comparison') {
    const normalized = normalizeComparison(value);
    const left = normalized.left, right = normalized.right;
    let comparison = normalized.comparison;
    if (comparison?.skillInvocations && typeof comparison.skillInvocations === 'object')
      comparison = { ...comparison, skillInvocations: { ...comparison.skillInvocations,
        ...(Object.hasOwn(comparison.skillInvocations, 'left') ? { left: normalizeInvocationSummary(comparison.skillInvocations.left) } : {}),
        ...(Object.hasOwn(comparison.skillInvocations, 'right') ? { right: normalizeInvocationSummary(comparison.skillInvocations.right) } : {}),
        ...(comparison.skillInvocations.incomplete && typeof comparison.skillInvocations.incomplete === 'object' ? {
          incomplete: { ...comparison.skillInvocations.incomplete,
            ...(Array.isArray(comparison.skillInvocations.incomplete.left) ? { left: comparison.skillInvocations.incomplete.left.map(item => normalizeSourceTimeRow(item)) } : {}),
            ...(Array.isArray(comparison.skillInvocations.incomplete.right) ? { right: comparison.skillInvocations.incomplete.right.map(item => normalizeSourceTimeRow(item)) } : {}) },
        } : {}) } };
    if (Array.isArray(comparison?.skills)) comparison = { ...comparison, skills: comparison.skills.map(skill => {
      const normalizeSide = side => side && typeof side === 'object' && Array.isArray(side.observations)
        ? { ...side, observations: side.observations.map(item => normalizeSourceTimeRow(item)) } : side;
      return { ...skill, left: normalizeSide(skill.left), right: normalizeSide(skill.right) };
    }) };
    if (left && right && (left.source?.kind === 'native-rollout'
      && recordedUsageAccounting(left.source?.clientVersion) && left.usage?.recorded && typeof left.usage.recorded === 'object'
      || right.source?.kind === 'native-rollout' && recordedUsageAccounting(right.source?.clientVersion)
      && right.usage?.recorded && typeof right.usage.recorded === 'object')) {
      comparison = { ...comparison, usage: { ...(comparison?.usage ?? {}),
        recordedResponseUsage: compareAuditRuns(left, right).comparison.usage.recordedResponseUsage } };
    } else if (comparison?.usage && Object.hasOwn(comparison.usage, 'recordedResponseUsage')) {
      const usage = { ...comparison.usage }; delete usage.recordedResponseUsage;
      comparison = { ...comparison, usage };
    }
    if (comparison?.resourceProvenance || left?.resourceProvenance || right?.resourceProvenance)
      comparison = { ...comparison, resourceProvenance: compareResourceProvenance(left?.resourceProvenance, right?.resourceProvenance,
        { sameBaseline: verifiedSameBaseline(left, right) }) };
    return { ...normalized, ...(left ? { left } : {}), ...(right ? { right } : {}), ...(comparison ? { comparison } : {}) };
  }
  if (value.kind === 'audit-experiment-report') {
    const runs = Array.isArray(value.runs) ? value.runs.map(run => normalizeRun(run, { comparison: true })) : value.runs;
    const comparisons = Array.isArray(value.comparisons) ? value.comparisons.map(normalizeComparison) : value.comparisons;
    return { ...value, ...(runs ? { runs } : {}), ...(comparisons ? { comparisons } : {}) };
  }
  if (value.kind === 'audit-series-report') {
    const trials = Array.isArray(value.trials) ? value.trials.map(trial => normalizeTrial(trial, depth + 1)) : value.trials;
    const comparisons = Array.isArray(value.comparisons) ? value.comparisons.map(row => rebuildSeriesComparison(row, trials ?? [])) : value.comparisons;
    const report = { ...value, ...(trials ? { trials } : {}), ...(comparisons ? { comparisons } : {}) };
    // Older reviewed packets bind their exact source bytes. Do not inject a new
    // field into an old sealed subject; rendering can derive consistency from it.
    return Object.hasOwn(value, 'consistency') ? { ...report, consistency: buildAuditConsistency(report) } : report;
  }
  if (value.kind === 'audit-evaluation-report' && value.subject) {
    const subject = projectReportResourceProvenance(value.subject, depth + 1);
    const packet = buildAuditReviewPacket(subject);
    if (value.reviewPacket?.evidenceFingerprint !== packet.evidenceFingerprint
      || value.source?.evidenceFingerprint !== packet.evidenceFingerprint)
      throw new Error('Evaluation source does not match its frozen review packet');
    const reviewState = projectAuditReviewState(subject, value.reviewHistory);
    const modes = reviewState.reviewModes;
    return { ...value, subject, reviewPacket: packet, reviewState,
      ...(subject.kind === 'audit-series-report' ? { consistency: buildAuditConsistency(subject, { reviews: reviewState }) } : {}),
      reviewMethod: modes.human && modes.ai ? 'human-and-ai' : modes.human ? 'human' : modes.ai ? 'ai' : 'none',
      status: subject.status ?? 'complete', exitCode: Number.isInteger(subject.exitCode) ? subject.exitCode : auditExitCode(subject) };
  }
  if (value.kind === 'audit-evaluation-report' && value.series?.kind === 'audit-series-report')
    return { ...value, series: projectReportResourceProvenance(value.series, depth + 1) };
  let out = value, changed = false;
  const set = (key, next) => { if (!changed) out = { ...value }; out[key] = next; changed = true; };
  if (Array.isArray(value.runs)) set('runs', value.runs.map(normalizeRun));
  if (Array.isArray(value.trials)) set('trials', value.trials.map(trial => normalizeTrial(trial, depth + 1)));
  if (value.kind === 'audit-capture-checkpoint' && value.run) set('run', normalizeRun(value.run, { comparison: false }));
  if (value.captureCheckpoint && typeof value.captureCheckpoint === 'object') set('captureCheckpoint', projectReportResourceProvenance(value.captureCheckpoint, depth + 1));
  if (Array.isArray(value.state?.trials)) set('state', { ...value.state, trials: value.state.trials.map(trial => ({ ...trial,
    ...(trial?.summary ? { summary: projectReportResourceProvenance(trial.summary, depth + 1) } : {}) })) });
  if (value.record && typeof value.record === 'object') set('record', projectReportResourceProvenance(value.record, depth + 1));
  if (value.report && typeof value.report === 'object') set('report', projectReportResourceProvenance(value.report, depth + 1));
  if (value.run && typeof value.run === 'object') set('run', normalizeRun(value.run, { comparison: value.kind !== 'audit-capture-checkpoint' }));
  if (value.series && typeof value.series === 'object') set('series', projectReportResourceProvenance(value.series, depth + 1));
  if (value.resourceProvenance !== undefined) set('resourceProvenance', projectResourceProvenance(value.resourceProvenance));
  return changed ? out : value;
}

export async function readAuditReport(path) {
  let handle;
  try {
    const requested = resolve(path);
    const selected = join(await realpath(dirname(requested)), basename(requested)), before = await lstat(selected);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_REPORT_BYTES
      || await realpath(selected) !== selected) throw new Error('unsafe');
    handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('changed');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, Math.min(65536, buffer.length - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    const after = await handle.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('changed');
    return projectReportResourceProvenance(validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))));
  } catch (error) {
    if (error.message.startsWith('Unsupported frozen audit')) throw error;
    throw new Error('The frozen audit report is missing, unsafe, changed, or invalid');
  } finally { await handle?.close(); }
}

async function removeOwned(path, identity) {
  try {
    const now = await lstat(path);
    if (now.dev === identity.dev && now.ino === identity.ino) await unlink(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Create all output files exclusively; roll back only files created by this call. */
export async function exportAuditReport(value, { output, format = 'json', includeContent = false } = {}) {
  validate(value);
  value = projectReportResourceProvenance(value);
  const setup = ['audit-profile', 'audit-profile-comparison'].includes(value.kind);
  if (includeContent && !setup) throw new Error('--include-content is supported only for profile setup exports');
  if (setup) {
    value = structuredClone(value);
    const resource = row => {
      if (!row || typeof row !== 'object') return;
      if (row.detail) {
        delete row.detail.text;
        for (const file of row.detail.files ?? []) delete file.content;
        row.detail.content = 'omitted-from-export';
      }
      if (row.detailDiff) for (const hunk of row.detailDiff.hunks ?? []) {
        if (hunk.kind !== 'metadata-changed' && (hunk.path === 'content' || !String(hunk.path).startsWith('value'))) {
          delete hunk.left; delete hunk.right;
          hunk.content = 'omitted-from-export';
        }
      }
      // Only documented comparison layouts, never arbitrary configuration values.
      if (row.left) resource(row.left);
      if (row.right) resource(row.right);
    };
    if (!includeContent) {
      for (const snapshot of value.kind === 'audit-profile' ? [value] : [value.left, value.right])
        for (const row of snapshot?.resources ?? []) resource(row);
      for (const rows of Object.values(value.comparison?.resources ?? {}))
        if (Array.isArray(rows)) for (const row of rows) resource(row);
    }
    value.contentBoundary = includeContent ? 'selected-redacted-setup-content' : 'setup-source-text-omitted';
  }
  if (!['json', 'markdown'].includes(format)) throw new Error('Choose export --format json or markdown');
  if (typeof output !== 'string' || !output.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(output))
    throw new Error('Export requires a plain --output file path');
  const requested = resolve(output);
  const path = join(await realpath(dirname(requested)), basename(requested));
  const json = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(json) > MAX_REPORT_BYTES) throw new Error('Frozen audit report exceeds the export size limit');
  const evidencePath = format === 'json' ? path : `${path}.audit.json`;
  const writes = format === 'json' ? [[path, json]] : [[evidencePath, json], [path, renderAudit(value, { format: 'markdown' })]];
  // Refuse collisions before creating anything; exclusive open also handles races.
  for (const [target] of writes) {
    try { await lstat(target); throw new Error('Audit export refuses to overwrite an existing file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const created = [];
  try {
    for (const [target, content] of writes) {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        created.push([target, await handle.stat()]);
        await handle.writeFile(content); await handle.sync();
      } finally { await handle.close(); }
    }
  } catch {
    for (const [target, identity] of created.reverse()) await removeOwned(target, identity);
    throw new Error('Audit export could not create its files; existing files were preserved');
  }
  return { schemaVersion: 1, kind: 'audit-export', output: path, format, evidencePath,
    sha256: createHash('sha256').update(json).digest('hex'), sourceKind: value.kind,
    sourceStatus: value.status ?? null, retention: 'Frozen normalized evidence; native transcripts were not copied.' };
}
