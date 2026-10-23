import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAuditReviewSubmission, buildAuditReviewPacket, projectAuditReviewState } from '../src/audit-review.js';
import { summarizeAuditSeries } from '../src/audit-statistics.js';

const run = (id, extra = {}) => ({ kind: 'audit-run', id, source: { kind: 'codex-cli', threadId: `thread-${id}` },
  comparisonConditions: { checkRecipes: [{ name: 'test', fingerprint: `recipe-${id}` }] },
  status: 'recorded', actions: [{ id: `a-${id}`, evidenceRefs: [`action:${id}:a-${id}`] }],
  checks: [{ name: 'test', status: 'failed', exitCode: 1, evidenceRefs: ['check:test'] }],
  workspace: { taskEnd: { fingerprint: `candidate-${id}`, timing: 'task-end' } },
  ...extra });
const subject = () => ({ kind: 'comparison', id: 'pair-1', left: run('left'), right: run('right') });
const human = (packet, id = 'human-1', extra = {}) => ({ id, reviewer: { type: 'human', name: 'Human Reviewer' },
  reviewedAt: '2026-10-22T10:00:00.000Z', method: 'manual', scope: 'subject:comparison:pair-1', conclusion: 'positive',
  summary: 'The left result is better on the declared outcome.', evidenceRefs: ['run:left', 'check:left:test'], ...extra });
const submission = (packet, reviews = [], supplementalChecks = []) => ({ schemaVersion: 1,
  kind: 'xfx-audit-review-submission', evidenceFingerprint: packet.evidenceFingerprint, reviews, supplementalChecks });

test('review packet binds the frozen subject and exposes only refs present in it', () => {
  const subjectValue = subject(), packet = buildAuditReviewPacket(subjectValue);
  assert.equal(packet.evidenceFingerprint.length, 64);
  assert.deepEqual(packet.subject.runIds, ['left', 'right']);
  assert(packet.evidenceRefs.includes('run:left'));
  assert(packet.evidenceRefs.includes('check:left:test'));
  assert(!packet.evidenceRefs.includes('check:test'));
  assert(packet.evidenceRefs.includes('action:left:a-left'));
  assert(packet.candidates.some(item => item.runId === 'left' && item.fingerprint === 'candidate-left' && item.stage === 'task-end'));
  assert(packet.checkRecipes.some(item => item.runId === 'left' && item.name === 'test' && item.fingerprint === 'recipe-left'));
  assert(!packet.evidenceRefs.includes('run:missing'));
});

test('optional state supports human-only, AI-only, and combined reviews without merging identities', () => {
  const source = subject(), packet = buildAuditReviewPacket(source);
  const ai = { ...human(packet, 'ai-1'), reviewer: { type: 'ai', name: 'review-agent', model: 'model-x' },
    conclusion: 'negative', summary: 'The available evidence does not support the positive conclusion.' };
  const humanOnly = applyAuditReviewSubmission(source, null, submission(packet, [human(packet)]));
  assert.deepEqual(projectAuditReviewState(source, humanOnly).reviewModes, { human: true, ai: false });
  const aiOnly = applyAuditReviewSubmission(source, null, submission(packet, [ai]));
  assert.deepEqual(projectAuditReviewState(source, aiOnly).reviewModes, { human: false, ai: true });
  const combined = applyAuditReviewSubmission(source, null, submission(packet, [human(packet), ai]));
  const projection = projectAuditReviewState(source, combined);
  assert.deepEqual(projection.reviewModes, { human: true, ai: true });
  assert.equal(projection.disagreement, true);
  assert.equal(projection.reviews.length, 2);
});

test('opposite preferred runs count as disagreement even when both reviews say positive', () => {
  const source = subject(), packet = buildAuditReviewPacket(source);
  const left = human(packet, 'human-left', { preferredRunId: 'left' });
  const right = { ...human(packet, 'ai-right', { preferredRunId: 'right' }),
    reviewer: { type: 'ai', name: 'agent', model: 'm1' } };
  const state = applyAuditReviewSubmission(source, null, submission(packet, [left, right]));
  const projected = projectAuditReviewState(source, state);
  assert.equal(projected.disagreement, true);
  assert.equal(projected.reviews[0].preferredRunId, 'left');
  assert.equal(projected.reviews[1].preferredRunId, 'right');
});

test('same check names are run-qualified and run-scoped reviews cannot cite the other run only', () => {
  const source = subject();
  source.right.checks[0] = { name: 'test', status: 'passed', exitCode: 0, evidenceRefs: ['check:test'] };
  const packet = buildAuditReviewPacket(source);
  assert(packet.evidenceRefs.includes('check:left:test'));
  assert(packet.evidenceRefs.includes('check:right:test'));
  assert(!packet.evidenceRefs.includes('check:test'));
  assert.throws(() => applyAuditReviewSubmission(source, null, submission(packet, [human(packet, 'wrong-run', {
    scope: 'run:right', evidenceRefs: ['check:left:test'],
  })])), /cannot cite another run/);
  const check = { id: 'bad-supplement', runId: 'left', name: 'test', candidateFingerprint: 'candidate-left',
    recipeFingerprint: 'recipe-left', checkedAt: '2026-10-22T11:00:00.000Z', method: 'manual-command',
    status: 'passed', exitCode: 0, evidenceRefs: ['check:right:test'], attribution: { type: 'human', name: 'Human Reviewer' } };
  assert.throws(() => applyAuditReviewSubmission(source, null, submission(packet, [], [check])), /cannot cite another run/);
});

test('a revision supersedes the current review while preserving its original', () => {
  const source = subject(), packet = buildAuditReviewPacket(source);
  let state = applyAuditReviewSubmission(source, null, submission(packet, [human(packet)]));
  state = applyAuditReviewSubmission(source, state, submission(packet, [human(packet, 'human-2', {
    supersedes: 'human-1', conclusion: 'inconclusive', summary: 'Revision after checking the retained evidence.'
  })]));
  const projected = projectAuditReviewState(source, state);
  assert.equal(state.entries.length, 2);
  assert.deepEqual(projected.currentReviewIds, ['human-2']);
  assert.equal(projected.reviews[0].conclusion, 'positive');
  assert.equal(projected.disagreement, false);
});

test('rejects a review bound to other evidence, unknown references, and invalid revisions', () => {
  const source = subject(), packet = buildAuditReviewPacket(source);
  assert.throws(() => applyAuditReviewSubmission(source, null, { ...submission(packet, [human(packet)]), evidenceFingerprint: 'wrong' }), /different frozen evidence/);
  assert.throws(() => applyAuditReviewSubmission(source, null, submission(packet, [human(packet, 'bad', { evidenceRefs: ['run:invented'] })])), /unknown evidence reference/);
  assert.throws(() => applyAuditReviewSubmission(source, null, submission(packet, [human(packet, 'bad', { supersedes: 'missing' })])), /must supersede/);
  const other = { ...source, right: run('right', { note: 'changed' }) };
  assert.throws(() => projectAuditReviewState(other, { schemaVersion: 1, kind: 'xfx-audit-review-state',
    evidenceFingerprint: packet.evidenceFingerprint, entries: [], supplementalChecks: [] }), /does not match frozen evidence/);
});

test('supplemental checks stay separate from original failed outcomes and require exact candidate and recipe', () => {
  const source = subject(), packet = buildAuditReviewPacket(source);
  const check = { id: 'rerun-1', runId: 'left', name: 'test', candidateFingerprint: 'candidate-left',
    recipeFingerprint: 'recipe-left', checkedAt: '2026-10-22T11:00:00.000Z', method: 'manual-command',
    status: 'passed', exitCode: 0, evidenceRefs: ['run:left', 'check:left:test'], attribution: { type: 'human', name: 'Human Reviewer' } };
  const state = applyAuditReviewSubmission(source, null, submission(packet, [], [check]));
  const projection = projectAuditReviewState(source, state);
  assert.equal(source.left.checks[0].status, 'failed');
  assert.equal(projection.supplementalChecks[0].status, 'passed');
  assert.equal(projection.status, 'not-reviewed');
  assert.throws(() => applyAuditReviewSubmission(source, null, submission(packet, [], [{ ...check, id: 'no-candidate', candidateFingerprint: 'invented' }])), /candidate is absent/);
  assert.throws(() => applyAuditReviewSubmission(source, null, submission(packet, [], [{ ...check, id: 'no-recipe', recipeFingerprint: 'invented' }])), /recipe is absent/);
  assert.throws(() => applyAuditReviewSubmission(source, null, submission(packet, [], [{ ...check, id: 'bad-exit', exitCode: 1 }])), /conflicts/);
  assert.throws(() => applyAuditReviewSubmission(source, null, submission(packet, [], [check, check])), /already exists/);
});

test('rubric assessments retain their frozen rubric identity and derived score', () => {
  const source = subject();
  source.spec = { checks: [{ name: 'test', command: 'npm test' }], quality: {
    schemaVersion: 1, id: 'q1', version: '1', checks: [{ name: 'test' }],
    rubric: { id: 'r1', version: 'v1', criteria: [{ id: 'correctness', label: 'Correctness', maxScore: 5, weight: 2 }] },
  } };
  const packet = buildAuditReviewPacket(source);
  const state = applyAuditReviewSubmission(source, null, submission(packet, [human(packet, 'rubric', {
    scope: 'run:left', conclusion: 'positive', evidenceRefs: ['check:left:test'], assessments: [{ runId: 'left', ratings: [
      { criterionId: 'correctness', score: 4, rationale: 'The required test passed.', evidenceRefs: ['check:test'] },
    ] }],
  })]));
  const projected = projectAuditReviewState(source, state);
  assert.deepEqual(projected.reviews[0].assessments[0], { runId: 'left', rubricId: 'r1', rubricVersion: 'v1',
    rubricFingerprint: projected.reviews[0].assessments[0].rubricFingerprint,
    scorePercent: 80, ratings: [{ criterionId: 'correctness', score: 4, rationale: 'The required test passed.', evidenceRefs: ['check:test'] }] });
});

test('generated compact series reports expose retained candidates, recipes and rubric inputs', () => {
  const quality = { schemaVersion: 1, id: 'q1', version: '1', checks: [{ name: 'test' }], rubric: {
    id: 'r1', version: 'v1', criteria: [{ id: 'correctness', label: 'Correctness', maxScore: 5 }],
  } };
  const checks = [{ name: 'test', command: 'node --test' }];
  const report = summarizeAuditSeries({ id: 'series-generated', spec: { checks, quality },
    recipe: { fingerprint: 'series-recipe', criteria: quality, meta: { checkRecipes: [{ name: 'test', fingerprint: 'check-recipe' }] } },
    profiles: [{ profileId: 'p1', profileName: 'Default' }],
    plan: [{ index: 1, experimentId: 'trial-1', profileOrder: ['Default'] }],
    trials: [{ index: 1, experimentId: 'trial-1', status: 'complete', runs: [{ kind: 'audit-run', id: 'run-1',
      profileId: 'p1', profileName: 'Default', source: { kind: 'codex-cli', threadId: 'thread-1' },
      status: 'complete', checks: [{ name: 'test', status: 'passed', exitCode: 0 }],
      turns: [{ agentId: 'thread-1', turnId: 'turn-1', status: 'completed' }],
      workspace: { taskEnd: { fingerprint: 'task-end-1', timing: 'task-end', captureComplete: true,
        changedFileCount: 0, changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1' } },
      comparisonConditions: { schemaVersion: 1, checkRecipes: [{ name: 'test', fingerprint: 'check-recipe' }] },
    }] }],
  });
  const packet = buildAuditReviewPacket(report);
  assert.deepEqual(packet.subject.runIds, ['run-1']);
  assert(packet.candidates.some(item => item.runId === 'run-1' && item.fingerprint === 'task-end-1'));
  assert(packet.checkRecipes.some(item => item.runId === 'run-1' && item.fingerprint === 'check-recipe'));
  const entry = human(packet, 'generated-review', { scope: 'run:run-1', conclusion: 'positive',
    evidenceRefs: ['run:run-1', 'check:run-1:test'], assessments: [{ runId: 'run-1', ratings: [
      { criterionId: 'correctness', score: 5, rationale: 'Recorded check passed.', evidenceRefs: ['check:test'] },
    ] }] });
  const state = applyAuditReviewSubmission(report, null, submission(packet, [entry]));
  assert.equal(projectAuditReviewState(report, state).reviews[0].assessments[0].scorePercent, 100);
});

test('empty review state is explicit and a series may be reviewed as mixed or inconclusive', () => {
  const source = subject(), packet = buildAuditReviewPacket(source);
  assert.equal(projectAuditReviewState(source, null).status, 'not-reviewed');
  const next = applyAuditReviewSubmission(source, null, submission(packet, [human(packet, 'mixed', {
    conclusion: 'mixed', scope: 'subject:comparison:pair-1', summary: 'The observations are mixed.'
  })]));
  assert.equal(projectAuditReviewState(source, next).reviews[0].scope, 'subject:comparison:pair-1');
});

test('discovers actual frozen series and experiment report run shapes', () => {
  const left = run('left'), right = run('right');
  left.kind = 'audit-run'; right.kind = 'audit-run';
  const series = { schemaVersion: 1, kind: 'audit-series-report', id: 'series-1', recipe: { meta: { checkRecipes: [
    { name: 'test', fingerprint: 'recipe-left' }, { name: 'test', fingerprint: 'recipe-right' },
  ] } }, trials: [{ index: 1, runs: [left, right] }] };
  const packet = buildAuditReviewPacket(series);
  assert.deepEqual(packet.subject.runIds, ['left', 'right']);
  assert(packet.claimScopes.includes('subject:audit-series-report:series-1'));
  assert(packet.claimScopes.includes('run:left'));
  const reviewer = human(packet, 'series-review', { scope: 'subject:audit-series-report:series-1', conclusion: 'inconclusive', evidenceRefs: [] });
  const state = applyAuditReviewSubmission(series, null, submission(packet, [reviewer]));
  assert.equal(projectAuditReviewState(series, state).reviews[0].scope, 'subject:audit-series-report:series-1');
  const experiment = { schemaVersion: 1, kind: 'audit-experiment-report', id: 'experiment-1', runs: [left, right] };
  assert.deepEqual(buildAuditReviewPacket(experiment).subject.runIds, ['left', 'right']);
});

test('replay rejects tampered history, branched revisions, and unknown persisted fields', () => {
  const source = subject(), packet = buildAuditReviewPacket(source);
  const first = human(packet);
  const second = human(packet, 'human-2', { supersedes: 'human-1', conclusion: 'inconclusive', evidenceRefs: [] });
  const state = applyAuditReviewSubmission(source, null, submission(packet, [first, second]));
  assert.throws(() => projectAuditReviewState(source, { ...state, entries: [...state.entries,
    { ...state.entries[1], supersedes: 'human-1', id: 'human-3' },
  ] }), /branch/);
  assert.throws(() => applyAuditReviewSubmission(source, { ...state, entries: [state.entries[0],
    { ...state.entries[1], extra: true },
  ] }, submission(packet)), /fields/);
  assert.throws(() => applyAuditReviewSubmission(source, null, { ...submission(packet), typo: true }), /fields/);
});
