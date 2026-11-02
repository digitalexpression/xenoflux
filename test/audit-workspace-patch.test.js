import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportAuditReport, projectReportResourceProvenance, readAuditReport } from '../src/audit-store.js';
import { applyAuditReviewSubmission, buildAuditReviewPacket } from '../src/audit-review.js';
import { compareAuditRuns } from '../src/audit-report.js';
import { captureAuditWorkspacePatch, projectAuditWorkspacePatch } from '../src/audit-workspace-patch.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const taskEndFingerprint = 'a'.repeat(64), baselineFingerprint = 'b'.repeat(64);
const sourceBaseline = { commit: '1'.repeat(40), tree: '2'.repeat(40) };
const patchBytes = Buffer.from('diff --git a/app.env b/app.env\n--- a/app.env\n+++ b/app.env\n+OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv\n');
const multilineSecretPatch = Buffer.from('diff --git a/key.txt b/key.txt\n--- a/key.txt\n+++ b/key.txt\n@@ -0,0 +1,5 @@\n+API_KEY=plain-secret-value\n+Authorization: Bearer header-secret-value\n+-----BEGIN PRIVATE KEY-----\n+private-key-material-line\n+-----END PRIVATE KEY-----\n');
function capturedPatch(bytes = patchBytes, options = {}) {
  const metadata = { fingerprint: taskEndFingerprint, patchSha256: hash(bytes) };
  return { metadata, patchContent: captureAuditWorkspacePatch(bytes, metadata, {
    sourceBaselineCommit: sourceBaseline.commit, sourceBaselineTree: sourceBaseline.tree,
    baselineFingerprint, ...options,
  }) };
}
function subject(patchContent, sourceBytes = patchBytes) {
  return { schemaVersion: 1, kind: 'audit-run', id: 'patch-run', status: 'complete',
    profile: { profileName: 'Fixture' }, source: { kind: 'fixture' },
    sourceWorkspace: { sourceCommit: sourceBaseline.commit, sourceTree: sourceBaseline.tree },
    workspace: { taskEnd: { status: 'changed', fingerprint: taskEndFingerprint, baselineFingerprint,
      patchSha256: hash(sourceBytes), patchContent, fileCount: 1, changedFileCount: 1,
      changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1', captureComplete: true, timing: 'task-end' } } };
}

test('captures a bounded redacted patch with source, post-setup and task-end bindings', () => {
  const { metadata, patchContent } = capturedPatch();
  assert.equal(patchContent.status, 'available');
  assert.equal(patchContent.basis, 'source-baseline-to-task-end');
  assert.deepEqual(patchContent.sourceBaseline, sourceBaseline);
  assert.equal(patchContent.taskEndFingerprint, taskEndFingerprint);
  assert.equal(patchContent.baselineFingerprint, baselineFingerprint);
  assert.equal(patchContent.sourcePatchSha256, metadata.patchSha256);
  assert.equal(patchContent.redacted, true);
  assert.match(patchContent.text, /\[REDACTED\]/);
  assert.doesNotMatch(patchContent.text, /sk-abcdefghijklmnopqrstuv/);
  assert.equal(patchContent.textSha256, hash(Buffer.from(patchContent.text)));
  assert.deepEqual(projectAuditWorkspacePatch(patchContent, { taskEndFingerprint, baselineFingerprint, sourcePatchSha256: metadata.patchSha256 }), patchContent);
  assert.throws(() => projectAuditWorkspacePatch(patchContent, { taskEndFingerprint: 'c'.repeat(64), baselineFingerprint, sourcePatchSha256: metadata.patchSha256 }), /unbound/);
  assert.throws(() => projectAuditWorkspacePatch(patchContent, { taskEndFingerprint, baselineFingerprint, sourcePatchSha256: metadata.patchSha256,
    sourceBaselineCommit: '3'.repeat(40) }), /unbound/);
  assert.throws(() => projectAuditWorkspacePatch({ ...patchContent, text: `${patchContent.text}tampered` }, { taskEndFingerprint, baselineFingerprint, sourcePatchSha256: metadata.patchSha256 }), /unsafe|invalid/i);
});

test('redacts diff-prefixed assignments, authorization headers and multiline private keys without changing hunk line count', () => {
  const { patchContent } = capturedPatch(multilineSecretPatch);
  assert.equal(patchContent.status, 'available');
  for (const secret of ['plain-secret-value', 'header-secret-value', 'private-key-material-line'])
    assert.doesNotMatch(patchContent.text, new RegExp(secret));
  assert.match(patchContent.text, /API_KEY=\[REDACTED\]/);
  assert.match(patchContent.text, /Authorization: \[REDACTED\]/);
  assert.match(patchContent.text, /\[REDACTED PRIVATE KEY\]/);
  assert.equal(patchContent.text.split('\n').length, multilineSecretPatch.toString('utf8').split('\n').length);
  assert.deepEqual(projectAuditWorkspacePatch(patchContent, { taskEndFingerprint, baselineFingerprint, sourcePatchSha256: hash(multilineSecretPatch) }), patchContent);
});

test('omits binary, invalid UTF-8, empty and over-limit task-end patches explicitly', () => {
  assert.equal(capturedPatch(patchBytes, { hasBinary: true }).patchContent.reason, 'binary-content');
  assert.equal(capturedPatch(Buffer.from([0xff])).patchContent.reason, 'invalid-utf8');
  assert.equal(capturedPatch(Buffer.alloc(0)).patchContent.reason, 'no-changes');
  assert.equal(capturedPatch(Buffer.alloc(256 * 1024 + 1, 0x61)).patchContent.reason, 'size-limit');
  const missingSource = captureAuditWorkspacePatch(patchBytes, { fingerprint: taskEndFingerprint, patchSha256: hash(patchBytes) }, { baselineFingerprint });
  assert.equal(missingSource.status, 'omitted');
  assert.equal(missingSource.reason, 'source-baseline-unavailable');
  assert.deepEqual(projectAuditWorkspacePatch(missingSource, { taskEndFingerprint, baselineFingerprint, sourcePatchSha256: hash(patchBytes) }).sourceBaseline,
    { commit: null, tree: null });
  const partialSource = captureAuditWorkspacePatch(patchBytes, { fingerprint: taskEndFingerprint, patchSha256: hash(patchBytes) }, {
    sourceBaselineCommit: sourceBaseline.commit, baselineFingerprint,
  });
  assert.equal(partialSource.reason, 'source-baseline-unavailable');
  const partialBinding = { taskEndFingerprint, baselineFingerprint, sourcePatchSha256: hash(patchBytes), sourceBaselineCommit: sourceBaseline.commit };
  const projectedPartial = projectAuditWorkspacePatch(partialSource, partialBinding);
  assert.deepEqual(projectedPartial.sourceBaseline, { commit: sourceBaseline.commit, tree: null });
  assert.deepEqual(projectAuditWorkspacePatch(projectedPartial, partialBinding), projectedPartial);
});

test('recorded-content export omits by default, preserves on opt-in, reopens source-free and refuses to strip reviewed patches', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-workspace-patch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePatch = multilineSecretPatch;
  const { patchContent } = capturedPatch(sourcePatch);
  const base = projectReportResourceProvenance(subject(patchContent, sourcePatch));
  const comparison = compareAuditRuns({ ...base, id: 'left-run' }, { ...base, id: 'right-run' });
  assert.equal(comparison.comparison.artifacts.snapshots.taskEnd.left.patchContent.textSha256, patchContent.textSha256);
  assert.equal(comparison.comparison.artifacts.snapshots.taskEnd.right.patchContent.sourcePatchSha256, hash(sourcePatch));

  const omittedReceipt = await exportAuditReport(base, { output: join(directory, 'omitted.json') });
  const omitted = await readAuditReport(omittedReceipt.evidencePath);
  assert.equal(omitted.workspace.taskEnd.patchContent.status, 'omitted');
  assert.equal(omitted.workspace.taskEnd.patchContent.reason, 'recorded-content-not-included');
  assert.equal(omitted.workspace.taskEnd.patchContent.taskEndFingerprint, taskEndFingerprint);
  assert.equal(omitted.workspace.taskEnd.patchContent.textSha256, patchContent.textSha256);
  assert.equal(Object.hasOwn(omitted.workspace.taskEnd.patchContent, 'text'), false);

  const comparisonOmittedReceipt = await exportAuditReport(comparison, { output: join(directory, 'comparison-omitted.json') });
  const comparisonOmitted = await readAuditReport(comparisonOmittedReceipt.evidencePath);
  assert.equal(comparisonOmitted.comparison.artifacts.snapshots.taskEnd.left.patchContent.status, 'omitted');
  assert.equal(Object.hasOwn(comparisonOmitted.comparison.artifacts.snapshots.taskEnd.left.patchContent, 'text'), false);
  const comparisonJson = await readFile(comparisonOmittedReceipt.evidencePath, 'utf8');
  assert.doesNotMatch(comparisonJson, /OPENAI_API_KEY|diff --git/);
  const comparisonDefaultMarkdownReceipt = await exportAuditReport(comparison, { format: 'markdown', output: join(directory, 'comparison-default.md') });
  const comparisonDefaultMarkdown = await readFile(comparisonDefaultMarkdownReceipt.output, 'utf8');
  assert.doesNotMatch(comparisonDefaultMarkdown, /OPENAI_API_KEY|diff --git/);

  const includedReceipt = await exportAuditReport(base, { output: join(directory, 'included.json'), includeReplayContent: true });
  const included = await readAuditReport(includedReceipt.evidencePath);
  assert.equal(included.workspace.taskEnd.patchContent.status, 'available');
  assert.equal(included.workspace.taskEnd.patchContent.textSha256, patchContent.textSha256);
  assert.match(included.workspace.taskEnd.patchContent.text, /\[REDACTED\]/);
  const includedJson = await readFile(includedReceipt.evidencePath, 'utf8');
  for (const secret of ['plain-secret-value', 'header-secret-value', 'private-key-material-line']) assert.doesNotMatch(includedJson, new RegExp(secret));
  const markdownReceipt = await exportAuditReport(base, { format: 'markdown', output: join(directory, 'included.md'), includeReplayContent: true });
  const markdown = await readFile(markdownReceipt.output, 'utf8');
  assert.match(markdown, /source\\-baseline\\-to\\-task\\-end/);
  assert.match(markdown, /REDACTED/);
  for (const secret of ['plain-secret-value', 'header-secret-value', 'private-key-material-line']) assert.doesNotMatch(markdown, new RegExp(secret));
  const comparisonMarkdownReceipt = await exportAuditReport(comparison, { format: 'markdown', output: join(directory, 'comparison.md'), includeReplayContent: true });
  const comparisonMarkdown = await readFile(comparisonMarkdownReceipt.output, 'utf8');
  assert.match(comparisonMarkdown, /Task-end patch content: available/);
  assert.match(comparisonMarkdown, /REDACTED/);

  const packet = buildAuditReviewPacket(base);
  assert(packet.evidenceRefs.includes(`workspace:patch-run:task-end:${taskEndFingerprint}`));
  const history = applyAuditReviewSubmission(base, null, { schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.evidenceFingerprint, reviews: [], supplementalChecks: [] });
  const evaluation = { schemaVersion: 1, kind: 'audit-evaluation-report', id: 'patch-review', status: 'complete', exitCode: 0,
    source: { evidenceFingerprint: packet.evidenceFingerprint }, subject: base, reviewPacket: packet, reviewHistory: history };
  await assert.rejects(exportAuditReport(evaluation, { output: join(directory, 'review-omitted.json') }), /change reviewed evidence/i);
  const reviewedReceipt = await exportAuditReport(evaluation, { output: join(directory, 'review-included.json'), includeReplayContent: true });
  const reviewed = await readAuditReport(reviewedReceipt.evidencePath);
  assert.equal(reviewed.subject.workspace.taskEnd.patchContent.status, 'available');
});
