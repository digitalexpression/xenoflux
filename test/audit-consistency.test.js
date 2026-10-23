import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingLedgerPair } from '../test-support/audit-explanation/booking-ledger.js';
import { buildAuditExplanation } from '../src/audit-explanation.js';
import { buildAuditConsistency } from '../src/audit-consistency.js';
import { summarizeAuditSeries } from '../src/audit-statistics.js';
import { applyAuditReviewSubmission, buildAuditReviewPacket, projectAuditReviewState } from '../src/audit-review.js';
import { attachAuditSessionEvidence, projectAuditSessionEvidence } from '../src/audit-session-evidence.js';
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');

function series({ count = 3, missingLast = false, taskVariants = [], similarAt = [] } = {}) {
  const trials = [];
  for (let index = 1; index <= count; index++) {
    let [left, right] = bookingLedgerPair();
    left.id = `left-${index}`; right.id = `right-${index}`;
    for (const [run, arm] of [[left, 'A'], [right, 'B']]) {
      const agentId = `fixture-root-${arm}`, turnId = `fixture-turn-${arm}`;
      const nextAgent = `fixture-root-${arm}-${index}`, nextTurn = `fixture-turn-${arm}-${index}`;
      run.source.nativeSessionId = nextAgent;
      for (const actor of run.agents) if (actor.id === agentId) actor.id = nextAgent;
      for (const turn of run.turns) { if (turn.agentId === agentId) turn.agentId = nextAgent; if (turn.turnId === turnId) turn.turnId = nextTurn; }
      for (const artifact of run.artifacts) { if (artifact.agentId === agentId) artifact.agentId = nextAgent; if (artifact.turnId === turnId) artifact.turnId = nextTurn; }
      if (run.outcome?.claim) { if (run.outcome.claim.agentId === agentId) run.outcome.claim.agentId = nextAgent;
        if (run.outcome.claim.turnId === turnId) run.outcome.claim.turnId = nextTurn; }
    }
    const task = taskVariants[index - 1] ?? left.comparisonConditions.taskFingerprint;
    left.comparisonConditions.taskFingerprint = task;
    right.comparisonConditions.taskFingerprint = task;
    if (similarAt.includes(index)) right.artifacts[0].path = left.artifacts[0].path;
    const explanation = buildAuditExplanation(left, right);
    trials.push({ index, status: 'complete', profiles: [
      { profileId: 'fixture-profile-A', profileName: 'A', status: left.status, run: left },
      { profileId: 'fixture-profile-B', profileName: 'B', status: right.status, run: right },
    ], comparisons: [{ leftRunId: left.id, rightRunId: right.id, explanation }] });
  }
  if (missingLast) trials.at(-1).profiles[1].run = null;
  return { schemaVersion: 1, kind: 'audit-series-report', trials, comparisons: [
    { left: 'fixture-profile-A', right: 'fixture-profile-B' }], profiles: [
      { profileId: 'fixture-profile-A', profileName: 'A' }, { profileId: 'fixture-profile-B', profileName: 'B' }],
    coverage: { plannedSlots: count },
  };
}

test('repeated findings distinguish recurring from contradictory behavior and preserve missing slots', () => {
  const result = buildAuditConsistency(series({ count: 4, missingLast: true, similarAt: [2] })).comparisons[0];
  const scope = result.findings.find(row => row.rule === 'editable-file-boundary');
  assert.equal(result.coverage.plannedPairs, 4);
  assert.equal(result.coverage.observedPairs, 3);
  assert.equal(result.coverage.eligiblePairs, 3);
  assert.equal(result.coverage.missingPairs, 1);
  assert.equal(scope.differentN, 2);
  assert.equal(scope.similarN, 1);
  assert.equal(scope.consistency, 'contradictory');
  assert.ok(scope.evidenceRefs.length > 0);
  assert.match(scope.limitation, /Missing evidence is not a negative observation/);
});

test('single pair stays unmeasured and duplicate run evidence is counted once', () => {
  const one = buildAuditConsistency(series({ count: 1 })).comparisons[0];
  assert.equal(one.findings.find(row => row.rule === 'editable-file-boundary').consistency, 'unmeasured');
  const report = series({ count: 2 });
  report.trials[1].profiles = report.trials[0].profiles;
  report.trials[1].comparisons = report.trials[0].comparisons;
  const duplicate = buildAuditConsistency(report).comparisons[0];
  assert.equal(duplicate.coverage.duplicatePairs, 1);
  assert.equal(duplicate.coverage.eligiblePairs, 1);
  const reusedArm = series({ count: 2 });
  reusedArm.trials[1].profiles[0] = reusedArm.trials[0].profiles[0];
  const reused = buildAuditConsistency(reusedArm).comparisons[0];
  assert.equal(reused.coverage.duplicatePairs, 1, 'reusing one native session cannot count as another independent pair');
  assert.equal(reused.coverage.eligiblePairs, 1);
});

test('task changes cannot be combined into a repeated-task consistency cohort', () => {
  const report = series({ count: 2, taskVariants: ['a'.repeat(64), 'b'.repeat(64)] });
  const results = buildAuditConsistency(report).comparisons;
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(row => row.coverage.eligiblePairs), [1, 1]);
  assert.deepEqual(results.map(row => row.coverage.otherTaskGroupPairs), [1, 1]);
  assert.ok(results.every(row => row.status === 'unmeasured' && row.cohort.taskAssociation === 'recorded-input-identity'
    && row.findings.every(finding => finding.consistency === 'unmeasured')));
});

test('different target patterns with the same classification are variable, not contradictory', () => {
  const report = series({ count: 2 });
  for (const trial of report.trials) for (const profile of trial.profiles) {
    profile.run.comparisonConditions.editableFiles = [trial.index === 1 ? 'src/other-module.js' : 'src/another-module.js'];
  }
  const result = buildAuditConsistency(report).comparisons[0];
  const finding = result.findings.find(row => row.rule === 'editable-file-boundary');
  assert.equal(finding.similarN, 2);
  assert.equal(finding.consistency, 'variable');
});

test('opposing left/right behavior across repeated different findings is contradictory', () => {
  const report = series({ count: 2 });
  const left = report.trials[1].profiles[0].run.artifacts[0], right = report.trials[1].profiles[1].run.artifacts[0];
  right.path = 'test/other-visible.test.js';
  [left.path, right.path] = [right.path, left.path];
  const result = buildAuditConsistency(report).comparisons[0];
  assert.equal(result.findings.find(row => row.rule === 'editable-file-boundary').consistency, 'contradictory');
});

test('outcome summaries require the same named check recipe across repeated pairs', () => {
  const report = series({ count: 3 });
  const leftRun = report.trials[2].profiles[0].run, rightRun = report.trials[2].profiles[1].run;
  leftRun.comparisonConditions.checkRecipes[0].fingerprint = 'c'.repeat(64);
  rightRun.comparisonConditions.checkRecipes[0].fingerprint = 'c'.repeat(64);
  report.trials[2].comparisons[0].explanation = buildAuditExplanation(leftRun, rightRun);
  const result = buildAuditConsistency(report).comparisons[0];
  const check = result.outcomes.find(row => row.name === 'scope');
  assert.ok(check);
  assert.equal(check.excludedN, 1);
  assert.equal(check.pairedN, 2);
  assert.equal(check.comparison, 'recurring-outcome-difference');
  const mixed = series({ count: 2 });
  mixed.trials[1].profiles[1].run.checks = structuredClone(mixed.trials[1].profiles[0].run.checks);
  const variable = buildAuditConsistency(mixed).comparisons[0].outcomes.find(row => row.name === 'scope');
  assert.equal(variable.pairedN, 2);
  assert.equal(variable.comparison, 'variable-outcomes', 'one differing result and one tie cannot establish a recurring outcome difference');
  const incomplete = buildAuditConsistency(series({ count: 3, missingLast: true })).comparisons[0].outcomes.find(row => row.name === 'scope');
  assert.equal(incomplete.plannedN, 3);
  assert.equal(incomplete.missingN, 1);
  assert.equal(incomplete.selectedN, 3);
});

test('each repeated pair contributes to every named check outcome denominator', () => {
  const report = series({ count: 2 });
  for (const trial of report.trials) for (const [side, profile] of trial.profiles.entries()) {
    const run = profile.run;
    run.comparisonConditions.checkRecipes.push({ name: 'lint', fingerprint: 'c'.repeat(64) });
    run.checks.push({ name: 'lint', status: side === 0 ? 'passed' : 'failed', exitCode: side === 0 ? 0 : 1 });
  }
  const outcomes = buildAuditConsistency(report).comparisons[0].outcomes;
  assert.equal(outcomes.find(row => row.name === 'scope').pairedN, 2);
  assert.equal(outcomes.find(row => row.name === 'lint').pairedN, 2);
  assert.equal(outcomes.find(row => row.name === 'lint').comparison, 'recurring-outcome-difference');
});

test('named check outcome eligibility is independent of another check recipe mismatch', () => {
  const report = series({ count: 2 });
  for (const trial of report.trials) {
    const left = trial.profiles[0].run, right = trial.profiles[1].run;
    left.comparisonConditions.checkRecipes.push({ name: 'lint', fingerprint: 'd'.repeat(64) });
    right.comparisonConditions.checkRecipes.push({ name: 'lint', fingerprint: 'e'.repeat(64) });
    left.checks.push({ name: 'lint', status: 'passed', exitCode: 0 });
    right.checks.push({ name: 'lint', status: 'failed', exitCode: 1 });
  }
  const outcomes = buildAuditConsistency(report).comparisons[0].outcomes;
  assert.equal(outcomes.find(row => row.name === 'scope').pairedN, 2);
  assert.equal(outcomes.find(row => row.name === 'lint').pairedN, 0);
  assert.equal(outcomes.find(row => row.name === 'lint').excludedN, 2);
});

test('selected session corpus preserves unknown planning denominator and fixed profile orientation', () => {
  const report = series({ count: 2 });
  report.cohort = { source: 'selected-existing-sessions', selectedPairCount: 2, plannedPairCount: null,
    sameTask: { status: 'user-declared', taskId: 'booking-task' }, arms: [{ id: 'fixture-profile-A' }, { id: 'fixture-profile-B' }] };
  for (const trial of report.trials) {
    delete trial.profiles[0].run.comparisonConditions.taskFingerprint;
    delete trial.profiles[1].run.comparisonConditions.taskFingerprint;
    trial.selection = { declaration: report.cohort.sameTask, declaredVariables: [] };
    trial.comparisons[0].explanation = buildAuditExplanation(trial.profiles[0].run, trial.profiles[1].run,
      { taskAssociation: report.cohort.sameTask });
  }
  const result = buildAuditConsistency(report).comparisons[0];
  assert.equal(result.coverage.plannedPairs, null);
  assert.equal(result.cohort.taskAssociation, 'user-declared');
  assert.equal(result.coverage.eligiblePairs, 2);
  assert.deepEqual(result.cohort.arms, { left: 'fixture-profile-A', right: 'fixture-profile-B' });
  const partial = series({ count: 2, missingLast: true });
  partial.cohort = { source: 'selected-existing-sessions', selectedPairCount: 2, plannedPairCount: null,
    arms: [{ id: 'fixture-profile-A' }, { id: 'fixture-profile-B' }] };
  const partialGroup = buildAuditConsistency(partial).comparisons[0];
  assert.equal(partialGroup.coverage.missingPairs, 1);
  assert.equal(partialGroup.findings.find(row => row.rule === 'editable-file-boundary').missingN, 1);
});

test('human and AI rubric comparisons remain attributed separately', () => {
  const report = series({ count: 2 });
  const reviews = { reviews: [
    { id: 'human-a', reviewer: { type: 'human', name: 'Reviewer A' }, scope: 'subject:series:s', conclusion: 'positive', assessments: [
      { runId: 'left-1', rubricId: 'quality', rubricVersion: '1', rubricFingerprint: 'f'.repeat(64), scorePercent: 80 },
      { runId: 'right-1', rubricId: 'quality', rubricVersion: '1', rubricFingerprint: 'f'.repeat(64), scorePercent: 70 },
    ] },
    { id: 'ai-a', reviewer: { type: 'ai', name: 'Reviewer B', model: 'model-x' }, scope: 'subject:series:s', conclusion: 'negative', assessments: [
      { runId: 'left-1', rubricId: 'quality', rubricVersion: '1', rubricFingerprint: 'f'.repeat(64), scorePercent: 65 },
      { runId: 'right-1', rubricId: 'quality', rubricVersion: '1', rubricFingerprint: 'f'.repeat(64), scorePercent: 90 },
    ] },
  ] };
  const reviewers = buildAuditConsistency(report, { reviews }).comparisons[0].reviewers;
  assert.equal(reviewers.length, 2);
  assert.deepEqual(reviewers.map(row => row.reviewer.type).sort(), ['ai', 'human']);
  assert.deepEqual(reviewers.map(row => row.pairedAssessments[0].deltaRightMinusLeft).sort((a, b) => a - b), [-10, 25]);
});

test('series statistics expose derived consistency over the same compacted evidence', () => {
  const input = series({ count: 2 });
  const plan = input.trials.map(trial => ({ index: trial.index, experimentId: `experiment-${trial.index}`,
    profileOrder: ['A', 'B'] }));
  const report = summarizeAuditSeries({ profiles: input.profiles, plan, spec: {}, recipe: {},
    trials: input.trials.map((trial, index) => ({ index: index + 1, status: trial.status,
      runs: trial.profiles.map(profile => profile.run) })) });
  assert.equal(report.consistency.kind, 'audit-series-consistency');
  assert.equal(report.consistency.comparisons[0].coverage.eligiblePairs, 2);
  assert.equal(report.consistency.comparisons[0].findings.find(row => row.rule === 'editable-file-boundary').consistency, 'recurring');
});

test('linked review evaluations are revalidated before their reviewer judgments are aggregated', () => {
  const report = series({ count: 2 }), subject = structuredClone(report), packet = buildAuditReviewPacket(subject);
  const reviewState = applyAuditReviewSubmission(subject, null, { schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.evidenceFingerprint, supplementalChecks: [], reviews: [
      { id: 'human-review', reviewer: { type: 'human', name: 'Human reviewer' }, reviewedAt: '2026-10-22T12:00:00Z',
        method: 'manual', scope: packet.claimScopes[0], conclusion: 'inconclusive', summary: 'Evidence is insufficient.', evidenceRefs: [] },
      { id: 'ai-review', reviewer: { type: 'ai', name: 'AI reviewer', model: 'model-x' }, reviewedAt: '2026-10-22T12:01:00Z',
        method: 'independent-review', scope: packet.claimScopes[0], conclusion: 'inconclusive', summary: 'Evidence is insufficient.', evidenceRefs: [] },
    ] });
  report.trials[0].reviewEvaluations = [{ side: 'comparison', report: { subject, reviewHistory: reviewState } }];
  const reviewers = buildAuditConsistency(report).comparisons[0].reviewers;
  assert.deepEqual(reviewers.map(row => row.reviewer.type).sort(), ['ai', 'human']);
  const tampered = structuredClone(reviewState); tampered.evidenceFingerprint = '0'.repeat(64);
  report.trials[0].reviewEvaluations[0].report.reviewHistory = tampered;
  assert.throws(() => buildAuditConsistency(report), /different frozen evidence|Review state does not match/);
});

function supplementalEvaluation(subject, { idPrefix = 'supp', statusByProfile = () => 'passed', recipeArgvByRun = () => ['node', 'check-candidate'] } = {}) {
  for (const trial of subject.trials) for (const profile of trial.profiles) {
    const original = profile.run;
    const run = { ...original, kind: 'audit-run', profile: { profileId: profile.profileId, profileName: profile.profileName },
      source: { ...original.source, kind: 'native-rollout', nativeSessionId: original.source.nativeSessionId,
        fingerprint: sha(original.source.nativeSessionId) } };
    const attached = original.sessionEvidence ? original : attachAuditSessionEvidence(run, { schemaVersion: 1, kind: 'xfx-audit-session-evidence',
      evidenceFingerprint: buildAuditReviewPacket(run).evidenceFingerprint, attachments: [{ runId: run.id,
        profileId: profile.profileId, nativeSessionId: run.source.nativeSessionId, sourceFingerprint: run.source.fingerprint,
        attributed: { type: 'automation', name: 'fixture evidence importer' }, recordedAt: '2026-10-22T12:00:00Z',
        taskContract: { id: 'booking-ledger', editableFiles: ['src/booking-ledger.js'] },
        taskEnd: { capturedAt: '2026-10-22T11:59:00Z', files: [{ path: 'src/booking-ledger.js', sha256: sha(run.id) }] },
        checkRecipes: [{ name: 'scope', argv: recipeArgvByRun(run),
          inputs: [{ path: 'test/oracle.js', sha256: sha('oracle') }] }] }] });
    profile.run = attached;
  }
  const packet = buildAuditReviewPacket(subject), supplementalChecks = [];
  for (const trial of subject.trials) for (const profile of trial.profiles) {
    const run = profile.run, evidence = projectAuditSessionEvidence(run), recipe = evidence.checkRecipes.find(item => item.name === 'scope');
    supplementalChecks.push({ id: `${idPrefix}-${run.id}`, runId: run.id, name: 'scope',
      candidateFingerprint: evidence.taskEnd.fingerprint,
      recipeFingerprint: recipe.fingerprint, checkedAt: '2026-10-22T12:00:00Z',
      method: 'host-acceptance-check', status: statusByProfile(profile),
      exitCode: statusByProfile(profile) === 'passed' ? 0 : 1,
      evidenceRefs: [`workspace:${run.id}:supplied-task-end:${evidence.taskEnd.fingerprint}`],
      attribution: { type: 'automation', name: 'retained host checker' } });
  }
  const state = applyAuditReviewSubmission(subject, null, { schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.evidenceFingerprint, reviews: [], supplementalChecks });
  return { id: `${idPrefix}-evaluation`, subject, reviewHistory: state, reviewPacket: packet };
}

test('linked supplemental checks compare repeated outcomes separately from original runner checks', () => {
  const report = series({ count: 2 }), subject = structuredClone(report);
  const evaluation = supplementalEvaluation(subject);
  for (const trial of report.trials) trial.reviewEvaluations = [{ side: 'comparison', report: evaluation }];
  const outcomes = buildAuditConsistency(report).comparisons[0].outcomes;
  const runner = outcomes.find(row => row.name === 'scope' && row.origin !== 'supplemental-check');
  const supplemental = outcomes.find(row => row.name === 'scope' && row.origin === 'supplemental-check');
  assert.equal(runner.pairedN, 2);
  assert.equal(runner.comparison, 'recurring-outcome-difference');
  assert.equal(supplemental.pairedN, 2, JSON.stringify(supplemental));
  assert.equal(supplemental.leftPassedN, 2);
  assert.equal(supplemental.rightPassedN, 2);
  assert.equal(supplemental.comparison, 'same-recorded-outcome');
  assert.equal(supplemental.supplementalChecks[0].leftProvenance, 'supplied-session-evidence');
  assert.equal(supplemental.supplementalChecks[0].leftMethod, 'host-acceptance-check');
  assert.ok(supplemental.supplementalChecks[0].leftCandidateFingerprint);
  assert.ok(supplemental.supplementalChecks[0].recipeFingerprint);

  for (const trial of report.trials) {
    delete trial.reviewEvaluations;
    trial.profiles = structuredClone(subject.trials[trial.index - 1].profiles);
  }
  const projected = projectAuditReviewState(subject, evaluation.reviewHistory);
  const fromOptionState = buildAuditConsistency(report, { reviews: projected }).comparisons[0].outcomes
    .find(row => row.origin === 'supplemental-check');
  assert.equal(fromOptionState.pairedN, 2, 'projected store review state is revalidated against the aggregate subject');
});

test('conflicting supplemental results for the same run are retained as unknown', () => {
  const report = series({ count: 2 }), subject = structuredClone(report);
  const first = supplementalEvaluation(subject, { idPrefix: 'first' });
  const secondSubject = structuredClone(subject);
  const second = supplementalEvaluation(secondSubject, { idPrefix: 'second', statusByProfile: () => 'failed' });
  for (const trial of report.trials) trial.reviewEvaluations = [
    { side: 'comparison', report: first }, { side: 'comparison', report: second }];
  const supplemental = buildAuditConsistency(report).comparisons[0].outcomes
    .find(row => row.name === 'scope' && row.origin === 'supplemental-check');
  assert.equal(supplemental.pairedN, 0);
  assert.equal(supplemental.missingN, 2);
  assert.equal(supplemental.comparison, 'unmeasured');
});

test('supplemental recipes from different repeated runs remain separate and unmeasured', () => {
  const report = series({ count: 2 }), subject = structuredClone(report);
  const evaluation = supplementalEvaluation(subject, { recipeArgvByRun: run => ['node', run.id.endsWith('2') ? 'check-v2' : 'check-v1'] });
  for (const trial of report.trials) trial.reviewEvaluations = [{ side: 'comparison', report: evaluation }];
  const outcomes = buildAuditConsistency(report).comparisons[0].outcomes.filter(row => row.origin === 'supplemental-check');
  assert.equal(outcomes.length, 1);
  assert.deepEqual([outcomes[0].plannedN, outcomes[0].pairedN, outcomes[0].excludedN, outcomes[0].comparison],
    [2, 1, 1, 'unmeasured']);
});

test('supplemental checks with a recipe absent from frozen run evidence are rejected', () => {
  const subject = structuredClone(series({ count: 2 })), profile = subject.trials[0].profiles[0], original = profile.run;
  const run = { ...original, kind: 'audit-run', profile: { profileId: profile.profileId, profileName: profile.profileName },
    source: { ...original.source, kind: 'native-rollout', nativeSessionId: original.source.nativeSessionId,
      fingerprint: sha(original.source.nativeSessionId) } };
  profile.run = attachAuditSessionEvidence(run, { schemaVersion: 1, kind: 'xfx-audit-session-evidence',
    evidenceFingerprint: buildAuditReviewPacket(run).evidenceFingerprint, attachments: [{ runId: run.id,
      profileId: profile.profileId, nativeSessionId: run.source.nativeSessionId, sourceFingerprint: run.source.fingerprint,
      attributed: { type: 'automation', name: 'fixture evidence importer' }, recordedAt: '2026-10-22T12:00:00Z',
      taskContract: { id: 'booking-ledger', editableFiles: ['src/booking-ledger.js'] },
      taskEnd: { capturedAt: '2026-10-22T11:59:00Z', files: [{ path: 'src/booking-ledger.js', sha256: sha(run.id) }] },
      checkRecipes: [{ name: 'scope', argv: ['node', 'check-candidate.mjs'], inputs: [{ path: 'test/oracle.js', sha256: sha('oracle') }] }] }] });
  const packet = buildAuditReviewPacket(subject);
  const evidence = projectAuditSessionEvidence(profile.run);
  assert.throws(() => applyAuditReviewSubmission(subject, null, { schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.evidenceFingerprint, reviews: [], supplementalChecks: [{ id: 'wrong-recipe', runId: run.id,
      name: 'scope', candidateFingerprint: evidence.taskEnd.fingerprint, recipeFingerprint: 'f'.repeat(64),
      checkedAt: '2026-10-22T12:00:00Z', method: 'host-acceptance-check', status: 'passed', exitCode: 0,
      evidenceRefs: [`workspace:${run.id}:supplied-task-end:${evidence.taskEnd.fingerprint}`],
      attribution: { type: 'automation', name: 'retained host checker' } }] }), /recipe is absent/);
  const recipe = projectAuditSessionEvidence(profile.run).checkRecipes[0];
  assert.throws(() => applyAuditReviewSubmission(subject, null, { schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.evidenceFingerprint, reviews: [], supplementalChecks: [{ id: 'wrong-candidate', runId: run.id,
      name: 'scope', candidateFingerprint: 'f'.repeat(64), recipeFingerprint: recipe.fingerprint,
      checkedAt: '2026-10-22T12:00:00Z', method: 'host-acceptance-check', status: 'passed', exitCode: 0,
      evidenceRefs: [`workspace:${run.id}:supplied-task-end:${evidence.taskEnd.fingerprint}`],
      attribution: { type: 'automation', name: 'retained host checker' } }] }), /candidate is absent/);
});

test('linked review evidence resolves runs from a frozen comparison left/right pair', () => {
  const report = series({ count: 1 }), subject = structuredClone(report);
  supplementalEvaluation(subject);
  const sourceRuns = subject.trials[0].profiles.map(profile => profile.run);
  const comparison = { schemaVersion: 1, kind: 'audit-comparison', id: 'direct-native-pair', status: 'partial',
    left: sourceRuns[0], right: sourceRuns[1] };
  const packet = buildAuditReviewPacket(comparison), supplementalChecks = sourceRuns.map((run, index) => {
    const evidence = projectAuditSessionEvidence(run), recipe = evidence.checkRecipes.find(item => item.name === 'scope');
    return { id: `pair-${run.id}`, runId: run.id, name: 'scope', candidateFingerprint: evidence.taskEnd.fingerprint,
      recipeFingerprint: recipe.fingerprint, checkedAt: '2026-10-22T12:00:00Z', method: 'host-acceptance-check',
      status: 'passed', exitCode: 0, evidenceRefs: [`workspace:${run.id}:supplied-task-end:${evidence.taskEnd.fingerprint}`],
      attribution: { type: 'automation', name: `pair checker ${index}` } };
  });
  const reviewHistory = applyAuditReviewSubmission(comparison, null, { schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.evidenceFingerprint, reviews: [], supplementalChecks });
  report.trials[0].reviewEvaluations = [{ side: 'pair', report: { id: 'direct-comparison-review', subject: comparison, reviewHistory } }];
  const row = buildAuditConsistency(report).comparisons[0].outcomes.find(item => item.origin === 'supplemental-check');
  assert.equal(row.pairedN, 1);
  assert.equal(row.comparison, 'unmeasured');
  assert.deepEqual(row.supplementalChecks[0].leftAttribution.name, 'pair checker 0');
});
