// Controller for immutable evaluations of already captured audit evidence.
// It never starts a task or rewrites the source report.
import { auditExitCode } from './audit-report.js';
import { projectReportResourceProvenance, readAuditReport } from './audit-store.js';
import { createAuditEvaluation, readAuditRecord } from './audit-experiment-store.js';
import { readAuditInput } from './audit-spec.js';
import { buildAuditReviewPacket, applyAuditReviewSubmission, projectAuditReviewState } from './audit-review.js';
import { attachAuditSessionEvidence } from './audit-session-evidence.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = new Set(['audit-run', 'audit-comparison', 'audit-experiment-report', 'audit-series-report']);
const isUUID = value => typeof value === 'string' && UUID.test(value);

async function showStored(store, id) {
  // Keep the command layer independent of audit-experiment.js's existing
  // command import graph.
  return (await import('./audit-experiment.js')).showAuditRecord(store, id);
}

function checkSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1)
    throw new Error('Review source must be a frozen schemaVersion 1 audit report');
  if (!SOURCE_KINDS.has(value.kind)) throw new Error(`Unsupported review source kind: ${value.kind ?? 'unknown'}`);
  if (['unavailable', 'not-found', 'pending'].includes(value.status))
    throw new Error('An unavailable or unfinished audit source cannot be evaluated as a completed result');
  if (value.kind === 'audit-run' && (!value.id || value.status === 'unavailable'))
    throw new Error('Review source run is unavailable');
  return value;
}

async function resolveSource(store, argument) {
  if (isUUID(argument)) {
    const current = await readAuditRecord(store, argument);
    if (!current.finalized) throw new Error('Review source must have a finalized saved report');
    if (current.record.kind === 'audit-evaluation') {
      return resolveEvaluation(current.report, { kind: 'stored-evaluation', id: current.id }, current.id, current.record.reviews);
    }
    if (!current.report) throw new Error('Review source has no finalized report');
    return { subject: checkSource(await showStored(store, argument)),
      sourceRef: { kind: 'stored-audit-record', id: current.id, reportKind: current.report.kind },
      previousState: null, legacyReviews: null, revision: 1, parentEvaluationId: null };
  }
  const frozen = await readAuditReport(argument);
  if (frozen.kind === 'audit-evaluation-report')
    return resolveEvaluation(frozen, { kind: 'frozen-evaluation', id: frozen.id ?? null }, frozen.id ?? null, null);
  const report = checkSource(frozen);
  return { subject: report, sourceRef: { kind: 'frozen-report', id: report.id ?? null, reportKind: report.kind },
    previousState: null, legacyReviews: null, revision: 1, parentEvaluationId: null };
}

function resolveEvaluation(report, sourceRef, parentEvaluationId, storedHistory) {
  const embedded = report?.subject ?? report?.series;
  if (!embedded) throw new Error('Saved evaluation does not contain its original reviewable evidence');
  const subject = checkSource(embedded);
  const isNative = Boolean(report.subject);
  return { subject, sourceRef, previousState: isNative ? report.reviewHistory ?? storedHistory ?? null : null,
    legacyReviews: isNative ? report.legacyReviews ?? null : storedHistory ?? null,
    revision: (report.revision ?? 0) + 1, parentEvaluationId,
    expectedFingerprint: isNative ? report.reviewPacket?.evidenceFingerprint : null };
}

function reviewMethod(state) {
  const modes = state?.reviewModes ?? {};
  if (modes.human && modes.ai) return 'human-and-ai';
  if (modes.human) return 'human';
  if (modes.ai) return 'ai';
  return 'none';
}

function sourceExitCode(subject) {
  if (Number.isInteger(subject?.exitCode) && [0, 1, 2, 3, 4, 124, 130].includes(subject.exitCode)) return subject.exitCode;
  return auditExitCode(subject);
}

/** Create an immutable evaluation packet, or a new revision with a typed review submission. */
export async function evaluateAuditEvidence(store, sourceArgument, reviewPath) {
  if (!store || typeof store.directory !== 'string') throw new Error('Audit experiment store is unavailable');
  if (typeof sourceArgument !== 'string' || !sourceArgument.trim()) throw new Error('Review requires a source report path or stored audit UUID');
  const resolved = await resolveSource(store, sourceArgument);
  let input;
  if (reviewPath !== undefined) input = await readAuditInput(reviewPath);
  // Bind all attachments to the same canonical resource projection used by
  // the first review packet, including packets saved with `audit evaluate`.
  resolved.subject = projectReportResourceProvenance(resolved.subject);
  if (input?.kind === 'xfx-audit-session-evidence') {
    if (resolved.previousState || resolved.parentEvaluationId || resolved.expectedFingerprint)
      throw new Error('Attach session evidence to the original audit source before creating any review evaluation');
    if (!['audit-run', 'audit-comparison'].includes(resolved.subject.kind))
      throw new Error('Session evidence can only be attached to an original audit-run or audit-comparison');
    resolved.subject = attachAuditSessionEvidence(resolved.subject, input);
  }
  // Hash and persist the exact safe projection that exports and future
  // revisions reopen, so a round trip cannot alter the review identity.
  resolved.subject = projectReportResourceProvenance(resolved.subject);
  const packet = buildAuditReviewPacket(resolved.subject);
  if (resolved.expectedFingerprint && resolved.expectedFingerprint !== packet.evidenceFingerprint)
    throw new Error('Saved review source fingerprint does not match its original evidence');
  let state = resolved.previousState;
  if (reviewPath !== undefined) {
    if (input?.kind !== 'xfx-audit-session-evidence') state = applyAuditReviewSubmission(resolved.subject, state, input);
  }
  const projectedState = projectAuditReviewState(resolved.subject, state);
  const report = {
    schemaVersion: 1, kind: 'audit-evaluation-report',
    subject: resolved.subject, reviewPacket: packet, reviewHistory: state ?? null, reviewState: projectedState,
    source: { ...resolved.sourceRef, evidenceFingerprint: packet.evidenceFingerprint },
    revision: resolved.revision, parentEvaluationId: resolved.parentEvaluationId,
    status: resolved.subject.status ?? 'complete',
    exitCode: sourceExitCode(resolved.subject), reviewMethod: reviewMethod(projectedState),
    ...(resolved.legacyReviews ? { legacyReviews: resolved.legacyReviews } : {}),
  };
  const created = await createAuditEvaluation(store, {
    source: { kind: 'xfx-audit-review-source', subject: resolved.subject,
      evidenceFingerprint: packet.evidenceFingerprint, origin: resolved.sourceRef,
      ...(resolved.legacyReviews ? { legacyReviews: resolved.legacyReviews } : {}) },
    reviews: state,
    report,
  });
  return created.report;
}
