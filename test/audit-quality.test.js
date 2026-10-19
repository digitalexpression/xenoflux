import test from 'node:test';
import assert from 'node:assert/strict';
import { auditQualityFingerprint, evaluateAuditQuality, validateAuditQuality, validateAuditReview } from '../src/audit-quality.js';

const recipes = [
  { name: 'unit', argv: ['npm', 'test'], timeoutMs: 60000 },
  { name: 'lint', argv: ['npm', 'run', 'lint'], timeoutMs: 30000 },
];
const quality = {
  id: 'release-quality', version: '2',
  checks: [{ name: 'unit' }, { name: 'lint', required: false }],
  workspace: { maxChangedFiles: 4 },
  rubric: { id: 'human-review', version: '1', minimumPercent: 70,
    criteria: [{ id: 'correctness', label: 'Correctness', maxScore: 5, weight: 2 },
      { id: 'clarity', label: 'Clarity', maxScore: 5 }] },
};
const passingRun = () => ({ id: 'run-1', status: 'complete',
  execution: { status: 'exited', exitCode: 0 }, outcome: { nativeTurnStatus: 'completed' },
  checks: [{ name: 'unit', status: 'passed', exitCode: 0 }, { name: 'lint', status: 'failed', exitCode: 1 }],
  workspace: { taskEnd: { fingerprint: 'task-hash', fileCount: 40603, changedFileCount: 3,
    changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1', captureComplete: true, timing: 'task-end' },
    checkEnd: { fingerprint: 'final-hash', fileCount: 7 } },
  profileSettings: { status: 'unchanged' }, runningClients: { status: 'unchanged' },
  agents: [{ id: 'agent-root' }] });
const reviewFor = (run, q = quality, ratings = [
  { criterionId: 'correctness', score: 4, rationale: 'Meets the expected behavior.', evidenceRefs: ['workspace:task-end:task-hash'] },
  { criterionId: 'clarity', score: 4, rationale: 'The change is understandable.', evidenceRefs: ['check:unit'] },
]) => ({ schemaVersion: 1, runId: run.id, fingerprint: auditQualityFingerprint(q, recipes),
  reviewer: 'reviewer@example.test', reviewedAt: '2026-10-16T12:00:00.000Z', ratings });

test('validates check references, bounds and requires at least one quality criterion', () => {
  assert.equal(validateAuditQuality(undefined, recipes), undefined);
  assert.throws(() => validateAuditQuality({ id: 'q', version: '1' }, []), /at least one/);
  assert.deepEqual(validateAuditQuality({ id: 'q', version: '1' }, recipes).checks,
    recipes.map(recipe => ({ name: recipe.name, required: true })));
  assert.throws(() => validateAuditQuality({ id: 'q', version: '1', checks: [{ name: 'missing' }] }, recipes), /reference declared checks/);
  assert.throws(() => validateAuditQuality({ id: 'q', version: '1', workspace: { maxChangedFiles: -1 } }, recipes), /nonnegative integer/);
  assert.equal(validateAuditQuality(quality, recipes).schemaVersion, 1);
  assert.notEqual(auditQualityFingerprint(quality, recipes), auditQualityFingerprint(quality,
    recipes.map(recipe => recipe.name === 'unit' ? { ...recipe, argv: ['npm', 'test', '--runInBand'] } : recipe)));
});

test('requires every required check while keeping optional check failures visible', () => {
  const run = passingRun();
  const result = evaluateAuditQuality(run, quality, { checks: recipes });
  assert.equal(result.status, 'incomplete', 'required rubric review is outstanding');
  assert.equal(result.criteria.find(item => item.id === 'check:unit').status, 'passed');
  assert.equal(result.criteria.find(item => item.id === 'check:lint').status, 'failed');
  assert.equal(result.criteria.find(item => item.id === 'check:lint').required, false);
  const reviewed = evaluateAuditQuality(run, quality, { checks: recipes, review: reviewFor(run) });
  assert.equal(reviewed.rubric.status, 'reviewed');
  assert.equal(reviewed.rubric.result, 'passed');
  assert.equal(reviewed.status, 'passed');
});

test('failed required checks fail acceptance; missing checks remain not-run rather than zero or pass', () => {
  const run = passingRun();
  run.checks[0] = { name: 'unit', status: 'failed', exitCode: 2 };
  const failed = evaluateAuditQuality(run, quality, { checks: recipes, review: reviewFor(run) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.criteria.find(item => item.id === 'check:unit').status, 'failed');
  run.checks = [];
  const missing = evaluateAuditQuality(run, quality, { checks: recipes });
  assert.equal(missing.criteria.find(item => item.id === 'check:unit').status, 'not-run');
  assert.equal(missing.status, 'incomplete');
});

test('uses only complete exact task-end workspace evidence, never the later check snapshot', () => {
  const run = passingRun();
  const result = evaluateAuditQuality(run, quality, { checks: recipes });
  assert.equal(result.criteria.find(item => item.kind === 'workspace').status, 'passed');
  run.workspace.taskEnd.captureComplete = false;
  const incomplete = evaluateAuditQuality(run, quality, { checks: recipes });
  const criterion = incomplete.criteria.find(item => item.kind === 'workspace');
  assert.equal(criterion.status, 'unknown');
  assert.deepEqual(criterion.evidenceRefs, []);
  run.workspace.taskEnd.captureComplete = true;
  run.workspace.taskEnd.timing = 'after-process-fallback';
  assert.equal(evaluateAuditQuality(run, quality, { checks: recipes }).criteria.find(item => item.kind === 'workspace').status, 'unknown');
});

test('quality uses a verified post-setup delta count and leaves legacy or unknown counts unscored', () => {
  const run = passingRun();
  const passed = evaluateAuditQuality(run, { id: 'delta', version: '1', workspace: { maxChangedFiles: 4 } }, { checks: recipes });
  const criterion = passed.criteria.find(item => item.kind === 'workspace');
  assert.equal(criterion.status, 'passed');
  assert.equal(criterion.observed, 3);
  assert.equal(criterion.countBasis, 'post-setup-snapshot-delta-v1');
  assert.equal(run.workspace.taskEnd.fileCount, 40603, 'raw snapshot file count retains fingerprint/cleanup meaning');
  delete run.workspace.taskEnd.changedFileCount;
  assert.equal(evaluateAuditQuality(run, { id: 'delta', version: '1', workspace: { maxChangedFiles: 4 } }, { checks: recipes })
    .criteria.find(item => item.kind === 'workspace').status, 'unknown');
  run.workspace.taskEnd.changedFileCount = 3;
  run.workspace.taskEnd.changeCountBasis = 'future-unverified-basis';
  assert.equal(evaluateAuditQuality(run, { id: 'delta', version: '1', workspace: { maxChangedFiles: 4 } }, { checks: recipes })
    .criteria.find(item => item.kind === 'workspace').status, 'unknown');
});

test('native task completion and any recorded preservation change are required gates', () => {
  const run = passingRun();
  run.outcome.nativeTurnStatus = 'failed';
  run.profileSettings.status = 'changed';
  const result = evaluateAuditQuality(run, quality, { checks: recipes });
  assert.equal(result.criteria.find(item => item.id === 'native-task-completed').status, 'failed');
  assert.equal(result.criteria.find(item => item.id === 'profile-settings-preserved').status, 'failed');
  assert.equal(result.status, 'failed');
});

test('accepts a completed exact root turn when a historical outcome claim was overwritten', () => {
  const run = passingRun();
  run.source = { threadId: 'thread-root' };
  run.turns = [{ agentId: 'child', turnId: 'child-turn', status: 'completed' },
    { agentId: 'thread-root', turnId: 'root-turn', status: 'completed' }];
  delete run.outcome.nativeTurnStatus;
  const result = evaluateAuditQuality(run, quality, { checks: recipes });
  assert.equal(result.criteria.find(item => item.id === 'native-task-completed').status, 'passed');
  run.turns[1].status = 'failed';
  assert.equal(evaluateAuditQuality(run, quality, { checks: recipes }).criteria.find(item => item.id === 'native-task-completed').status, 'failed');
});

test('does not guess the root turn from agent order when native completion evidence is absent', () => {
  const run = passingRun();
  run.turns = [{ agentId: 'first-agent', turnId: 't1', status: 'completed' }];
  delete run.source;
  delete run.outcome.nativeTurnStatus;
  const result = evaluateAuditQuality(run, quality, { checks: recipes });
  assert.equal(result.criteria.find(item => item.id === 'native-task-completed').status, 'unknown');
});

test('required human rubric without review is not-run; nullable ratings do not get imputed', () => {
  const run = passingRun();
  const pending = evaluateAuditQuality(run, quality, { checks: recipes });
  assert.equal(pending.rubric.status, 'pending-review');
  assert.equal(pending.criteria.find(item => item.kind === 'human-rubric').status, 'not-run');
  const ratings = reviewFor(run).ratings;
  ratings[0] = { criterionId: 'correctness', score: null, rationale: 'Could not judge.', evidenceRefs: [] };
  const result = evaluateAuditQuality(run, quality, { checks: recipes, review: reviewFor(run, quality, ratings) });
  assert.equal(result.rubric.scorePercent, null);
  assert.equal(result.rubric.result, 'unknown');
  assert.equal(result.status, 'incomplete');
});

test('rejects cross-run, changed-definition, unknown-evidence and out-of-range reviews', () => {
  const run = passingRun();
  const valid = reviewFor(run);
  assert.equal(validateAuditReview(valid, { run, quality, checks: recipes }).rubricId, 'human-review');
  assert.throws(() => validateAuditReview({ ...valid, runId: 'run-elsewhere' }, { run, quality, checks: recipes }), /does not match/);
  assert.throws(() => validateAuditReview({ ...valid, fingerprint: 'different' }, { run, quality, checks: recipes }), /does not match/);
  const badRef = structuredClone(valid); badRef.ratings[0].evidenceRefs = ['workspace:task-end:invented'];
  assert.throws(() => validateAuditReview(badRef, { run, quality, checks: recipes }), /evidence reference/);
  const tooHigh = structuredClone(valid); tooHigh.ratings[0].score = 6;
  assert.throws(() => validateAuditReview(tooHigh, { run, quality, checks: recipes }), /score/);
  const wrongRecipe = recipes.map(item => ({ ...item })); wrongRecipe[0].argv.push('--changed');
  assert.throws(() => validateAuditReview(valid, { run, quality, checks: wrongRecipe }), /does not match/);
});

test('saved normalized reviews remain valid for deterministic regeneration', () => {
  const run = passingRun(), saved = validateAuditReview(reviewFor(run), { run, quality, checks: recipes });
  const result = evaluateAuditQuality(run, quality, { checks: recipes, review: saved });
  assert.equal(result.status, 'passed');
  assert.ok(Math.abs(result.rubric.scorePercent - 80) < 1e-10);
  assert.equal(result.review.reviewer, saved.reviewer);
  assert.deepEqual(result.review, saved);
  assert.throws(() => validateAuditReview({ ...saved, rubricVersion: 'changed' }, { run, quality, checks: recipes }), /frozen rubric/);
});

test('known process limits fail the completion gate while unproven preservation remains unknown', () => {
  for (const status of ['timeout', 'cancelled', 'output-limit', 'shutdown-failed']) {
    const run = passingRun(); run.execution = { status }; run.profileSettings.status = 'unavailable';
    const result = evaluateAuditQuality(run, quality, { checks: recipes });
    assert.equal(result.criteria.find(item => item.id === 'native-task-completed').status, 'failed');
    assert.equal(result.criteria.find(item => item.id === 'profile-settings-preserved').status, 'unknown');
  }
});

test('unlisted command checks remain required so failed execution cannot become passing quality', () => {
  const run = passingRun(), definition = { id: 'workspace-contract', version: '1', workspace: { maxChangedFiles: 4 } };
  run.status = 'failed'; run.outcome.status = 'failed';
  const result = evaluateAuditQuality(run, definition, { checks: recipes });
  assert.equal(result.criteria.find(item => item.id === 'check:lint').required, true);
  assert.equal(result.criteria.find(item => item.id === 'check:lint').status, 'failed');
  assert.equal(result.status, 'failed');
  const optional = evaluateAuditQuality(run, { ...definition, checks: [{ name: 'lint', required: false }] }, { checks: recipes });
  assert.equal(optional.status, 'passed', 'only an explicit optional criterion opts out of quality failure');
});
