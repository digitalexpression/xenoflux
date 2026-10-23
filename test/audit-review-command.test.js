import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExperiment, finalizeAuditRecord, readAuditRecord } from '../src/audit-experiment-store.js';
import { evaluateAuditEvidence } from '../src/audit-review-command.js';
import { exportAuditReport } from '../src/audit-store.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-review-command-')));
  await chmod(root, 0o700);
  const store = { directory: join(root, '.xfx') };
  await mkdir(store.directory, { mode: 0o700 });
  await chmod(store.directory, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store };
}

async function finalizedSource(store) {
  const experiment = await createExperiment(store, { spec: {}, task: 'saved task', profiles: [] });
  const report = await finalizeAuditRecord(store, experiment.id, {
    status: 'complete', exitCode: 0, coverage: { execution: 'complete' }, runs: [], outcome: { status: 'passed' },
  });
  return { experiment, report };
}

test('creates an unreviewed immutable packet and reopens a revision from stored evaluation evidence alone', async t => {
  const { root, store } = await fixture(t), { experiment } = await finalizedSource(store);
  const first = await evaluateAuditEvidence(store, experiment.id);
  assert.equal(first.kind, 'audit-evaluation-report');
  assert.equal(first.reviewMethod, 'none');
  assert.equal(first.reviewState.status, 'not-reviewed');
  assert.equal(first.exitCode, 0);
  assert.equal(first.revision, 1);
  assert.ok(first.reviewPacket.evidenceFingerprint);
  assert.equal(first.reviewHistory, null);
  const firstRecord = await readAuditRecord(store, first.id);

  const exported = join(root, 'evaluation.json');
  await exportAuditReport(first, { output: exported });
  const secondFixture = await fixture(t);
  const reopened = await evaluateAuditEvidence(secondFixture.store, exported);
  assert.equal(reopened.revision, 2);
  assert.equal(reopened.parentEvaluationId, first.id);
  assert.equal(reopened.reviewPacket.evidenceFingerprint, first.reviewPacket.evidenceFingerprint);
  assert.deepEqual(reopened.subject, first.subject,
    'the next revision uses only the normalized subject embedded in the exported evaluation');
  assert.deepEqual((await readAuditRecord(store, first.id)).report, firstRecord.report,
    'creating a revision leaves the source evaluation immutable');
  assert.notEqual(reopened.id, first.id);
});

test('accepts frozen report files, retains original outcome status, and validates submissions before storing', async t => {
  const { root, store } = await fixture(t), { report } = await finalizedSource(store);
  const sourcePath = join(root, 'source.json');
  await writeFile(sourcePath, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
  const evalFromFile = await evaluateAuditEvidence(store, sourcePath);
  assert.equal(evalFromFile.source.kind, 'frozen-report');
  assert.equal(evalFromFile.exitCode, 0);

  const before = await readdir(join(store.directory, 'audits'));
  const badPath = join(root, 'bad-review.json');
  await writeFile(badPath, JSON.stringify({ schemaVersion: 1, kind: 'some-other-input' }), { flag: 'wx', mode: 0o600 });
  await assert.rejects(evaluateAuditEvidence(store, sourcePath, badPath), /submission|review/i);
  assert.deepEqual(await readdir(join(store.directory, 'audits')), before,
    'a rejected submission must not create a partial evaluation');
});

test('rejects supplemental checks for candidate fingerprints absent from the frozen run', async t => {
  const { root, store } = await fixture(t);
  const sourcePath = join(root, 'run.json'), runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await writeFile(sourcePath, JSON.stringify({ schemaVersion: 1, kind: 'audit-run', id: runId, status: 'complete',
    workspace: { taskEnd: { fingerprint: 'candidate-present' } },
    comparisonConditions: { checkRecipes: [{ name: 'smoke', fingerprint: 'recipe-present' }] } }), { flag: 'wx', mode: 0o600 });
  const packet = await evaluateAuditEvidence(store, sourcePath);
  const submissionPath = join(root, 'wrong-candidate.json');
  await writeFile(submissionPath, JSON.stringify({ schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.reviewPacket.evidenceFingerprint, reviews: [], supplementalChecks: [{
      id: 'check-one', runId, name: 'smoke', candidateFingerprint: 'candidate-not-captured', recipeFingerprint: 'recipe-present',
      checkedAt: '2026-10-22T10:00:00.000Z', method: 'recorded-check', status: 'passed', evidenceRefs: [],
    }] }), { flag: 'wx', mode: 0o600 });
  const before = await readdir(join(store.directory, 'audits'));
  await assert.rejects(evaluateAuditEvidence(store, sourcePath, submissionPath), /candidate is absent/);
  assert.deepEqual(await readdir(join(store.directory, 'audits')), before);
});

test('adds attributed human and AI reviews as separate immutable revisions', async t => {
  const { root, store } = await fixture(t), sourcePath = join(root, 'comparison.json');
  const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await writeFile(sourcePath, JSON.stringify({ schemaVersion: 1, kind: 'audit-comparison', id: 'comparison-1',
    status: 'complete', exitCode: 0, left: { kind: 'audit-run', id: runId, status: 'complete', source: {}, turns: [] },
    right: { kind: 'audit-run', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'complete', source: {}, turns: [] } }),
  { flag: 'wx', mode: 0o600 });
  const packet = await evaluateAuditEvidence(store, sourcePath);
  const humanPath = join(root, 'human.json');
  await writeFile(humanPath, JSON.stringify({ schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.reviewPacket.evidenceFingerprint, reviews: [{ id: 'human-1',
      reviewer: { type: 'human', name: 'reviewer@example.test' }, reviewedAt: '2026-10-22T10:00:00.000Z',
      method: 'manual', scope: packet.reviewPacket.claimScopes[0], conclusion: 'mixed',
      summary: 'The comparison has both useful and uncertain evidence.', evidenceRefs: [`run:${runId}`] }], supplementalChecks: [] }),
  { flag: 'wx', mode: 0o600 });
  const human = await evaluateAuditEvidence(store, sourcePath, humanPath);
  assert.equal(human.reviewMethod, 'human');
  assert.equal(human.reviewState.reviews.length, 1);

  const aiPath = join(root, 'ai.json');
  await writeFile(aiPath, JSON.stringify({ schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.reviewPacket.evidenceFingerprint, reviews: [{ id: 'ai-1',
      reviewer: { type: 'ai', name: 'independent-reviewer', model: 'review-model-v1' }, reviewedAt: '2026-10-22T10:05:00.000Z',
      method: 'evidence-review', scope: packet.reviewPacket.claimScopes[0], conclusion: 'positive',
      summary: 'The recorded evidence supports the stated outcome.', evidenceRefs: [`run:${runId}`] }], supplementalChecks: [] }),
  { flag: 'wx', mode: 0o600 });
  const combined = await evaluateAuditEvidence(store, human.id, aiPath);
  assert.equal(combined.reviewMethod, 'human-and-ai');
  assert.equal(combined.reviewHistory.entries.length, 2);
  assert.equal(combined.reviewState.disagreement, true);
  assert.equal(combined.parentEvaluationId, human.id);
  assert.equal(combined.exitCode, 0, 'review conclusions do not replace the original comparison outcome');
});

test('rejects unavailable, unfinished, and wrong-kind sources without creating evaluations', async t => {
  const { root, store } = await fixture(t);
  const unfinished = await createExperiment(store, { spec: {}, task: 'pending', profiles: [] });
  await assert.rejects(evaluateAuditEvidence(store, unfinished.id), /finalized/);
  const invalidPath = join(root, 'unsupported.json');
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, kind: 'audit-profile', status: 'complete' }), { flag: 'wx', mode: 0o600 });
  await assert.rejects(evaluateAuditEvidence(store, invalidPath), /Unsupported review source kind/);
  const unavailablePath = join(root, 'unavailable.json');
  await writeFile(unavailablePath, JSON.stringify({ schemaVersion: 1, kind: 'audit-run', id: 'run-x', status: 'unavailable' }), { flag: 'wx', mode: 0o600 });
  await assert.rejects(evaluateAuditEvidence(store, unavailablePath), /unfinished|unavailable/);
  assert.deepEqual(await readdir(join(store.directory, 'audits')), [unfinished.id]);
});
