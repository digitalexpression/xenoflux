// Descriptive repeated-run consistency and outcome aggregation over frozen series evidence.
// This module never executes a task, judges quality, or infers causality.
import { buildAuditExplanation, canonicalAuditChecks } from './audit-explanation.js';
import { retainedAuditSelectionOptions } from './audit-selection.js';
import { createHash } from 'node:crypto';
import { projectAuditReviewState } from './audit-review.js';

const list = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
const stable = value => JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex').slice(0, 20);

function runOf(row) { return row?.run && typeof row.run === 'object' ? row.run : null; }
function findArm(rows, key, displayName) {
  const exact = list(rows).find(row => (row.profileId ?? row.profileName) === key);
  if (exact) return exact;
  if (key !== displayName) return null;
  const byName = list(rows).filter(row => row.profileName === displayName);
  return byName.length === 1 ? byName[0] : null;
}
function selectionOptions(trial) {
  const selection = trial?.selection;
  return retainedAuditSelectionOptions(selection?.declaration || selection?.taskAssociation
    ? { declaration: selection.declaration ?? selection.taskAssociation, declaredVariables: selection.declaredVariables ?? [] } : selection);
}
function pairDeclaration(trial) {
  return trial?.selection?.declaration ?? trial?.selection?.taskAssociation ?? null;
}
function taskKey(explanation, leftRun, rightRun, declaration) {
  const left = leftRun?.comparisonEvidence?.conditions?.taskFingerprint ?? leftRun?.comparisonConditions?.taskFingerprint;
  const right = rightRun?.comparisonEvidence?.conditions?.taskFingerprint ?? rightRun?.comparisonConditions?.taskFingerprint;
  if (left && right) return left === right ? `recorded:${left}` : null;
  const association = explanation?.conditions?.taskAssociation;
  if (association?.status === 'user-declared' && association.taskId) return `declared:${association.taskId}`;
  if (declaration && typeof declaration === 'object' && declaration.status === 'user-declared' && declaration.taskId)
    return `declared:${declaration.taskId}`;
  if (typeof declaration === 'string' && declaration.trim()) return `declared:${declaration}`;
  return null;
}
function checkRecipeKey(leftRun, rightRun, checkName) {
  const recipes = run => list(run?.comparisonEvidence?.conditions?.checkRecipes ?? run?.comparisonConditions?.checkRecipes);
  const left = recipes(leftRun).find(row => row?.name === checkName)?.fingerprint;
  const right = recipes(rightRun).find(row => row?.name === checkName)?.fingerprint;
  return typeof left === 'string' && left && left === right ? left : null;
}
function sourceKey(run, profile) {
  if (!isCaptured(run)) return null;
  const source = object(run.source), session = source.nativeSessionId ?? source.threadId;
  return `${profile ?? run.profileId ?? run.profileName ?? 'unknown'}\0${source.provider ?? 'unknown'}\0${session ?? run.id}`;
}
function runIdentity(run) { const id = safeId(run?.id); return id ? `run:${id}` : null; }
function isCaptured(run) { return Boolean(safeId(run?.id)) && !['not-started', 'unavailable', 'not-found'].includes(run.status); }
function sidePattern(value) {
  const source = object(value);
  const actions = list(source.actions).map(action => ({ kind: action?.kind ?? null, name: action?.name ?? null,
    status: action?.status ?? null, targets: list(action?.targets).slice().sort(), subjects: list(action?.subjects).slice().sort() }));
  return { state: source.state ?? null, assertion: source.assertion ?? null, status: source.status ?? null,
    target: source.target ?? null, boundary: list(source.boundary).slice().sort(),
    recordedScriptSubjects: list(source.recordedScriptSubjects).slice().sort(),
    exitZeroScriptSubjects: list(source.exitZeroScriptSubjects).slice().sort(), actions };
}
function semanticSidePattern(value) {
  const side = sidePattern(value);
  return { state: side.state, assertion: side.assertion, status: side.status, target: side.target,
    boundary: side.boundary, recordedScriptSubjects: side.recordedScriptSubjects,
    exitZeroScriptSubjects: side.exitZeroScriptSubjects };
}
function findingPattern(finding) {
  return { rule: finding.rule, classification: finding.classification,
    left: sidePattern(finding.left), right: sidePattern(finding.right) };
}
function seriesBehaviorPattern(explanation) {
  return digest(list(explanation?.findings).map(findingPattern).sort((a, b) => a.rule.localeCompare(b.rule)));
}

function aggregateFindings(report, slots, pair, taskCohort) {
  const rules = new Map(), seenLeft = new Set(), seenRight = new Set(), seenLeftRuns = new Set(), seenRightRuns = new Set();
  let eligiblePairs = 0, excludedPairs = 0, missingPairs = 0, duplicatePairs = 0, observedPairs = 0;
  const excludedReasons = {};
  let plannedPairs = 0;
  for (const slot of slots) {
    const rows = list(slot.profiles), left = findArm(rows, pair.left, pair.leftName), right = findArm(rows, pair.right, pair.rightName);
    if (!left || !right) continue;
    plannedPairs++;
    const a = runOf(left), b = runOf(right);
    const explanation = buildAuditExplanation(a, b, selectionOptions(slot));
    for (const finding of list(explanation?.findings)) {
      if (!rules.has(finding.rule)) rules.set(finding.rule, { rule: finding.rule, title: finding.title,
        plannedN: 0, selectedN: 0, eligibleN: 0, excludedN: 0, missingN: 0, duplicateN: 0,
        observedN: 0, similarN: 0, differentN: 0, inconclusiveN: 0, patterns: [], evidenceRefs: [] });
      const entry = rules.get(finding.rule); entry.plannedN++; entry.selectedN++;
    }
    if (!isCaptured(a) || !isCaptured(b)) {
      missingPairs++;
      for (const finding of list(explanation?.findings)) rules.get(finding.rule).missingN++;
      continue;
    }
    observedPairs++;
    const leftSource = sourceKey(a, left.profileId ?? left.profileName), rightSource = sourceKey(b, right.profileId ?? right.profileName);
    const duplicate = seenLeft.has(leftSource) || seenRight.has(rightSource)
      || seenLeftRuns.has(runIdentity(a)) || seenRightRuns.has(runIdentity(b));
    seenLeft.add(leftSource); seenRight.add(rightSource);
    seenLeftRuns.add(runIdentity(a)); seenRightRuns.add(runIdentity(b));
    if (duplicate) {
      duplicatePairs++;
      for (const finding of list(explanation?.findings)) rules.get(finding.rule).duplicateN++;
      continue;
    }
    const sameTask = explanation?.conditions?.sameTaskEligible === true && taskKey(explanation, a, b, pairDeclaration(slot));
    const eligibleForCohort = sameTask && taskKey(explanation, a, b, pairDeclaration(slot)) === taskCohort && taskCohort !== null;
    if (!eligibleForCohort) {
      excludedPairs++;
      const reason = !sameTask ? explanation?.conditions?.taskAssociation?.status === 'contradictory'
        ? 'recorded-task-fingerprints-differ' : 'same-task-association-unavailable' : 'task-cohort-differs';
      excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1;
    } else eligiblePairs++;
    const trialPattern = seriesBehaviorPattern(explanation);
    for (const finding of list(explanation?.findings)) {
      const row = rules.get(finding.rule);
      const eligible = eligibleForCohort && finding?.eligibility?.eligible === true && finding?.eligibility?.sameTaskEligible === true;
      if (!eligible) { row.excludedN++; }
      else {
        row.eligibleN++; row.observedN++;
        const classification = ['similar', 'different'].includes(finding.classification) ? finding.classification : 'inconclusive';
        row[`${classification}N`]++;
        const signature = findingPattern(finding), key = stable(signature);
        let pattern = row.patterns.find(item => item.key === key);
        if (!pattern) { pattern = { id: `pattern-${digest(signature)}`, key, classification, left: signature.left,
          right: signature.right, count: 0, trials: [] }; row.patterns.push(pattern); }
        pattern.count++;
        pattern.trials.push({ index: slot.index ?? null, leftRunId: a.id, rightRunId: b.id,
          behaviorPattern: trialPattern,
          evidenceRefs: [...new Set([...list(finding.left?.evidenceRefs), ...list(finding.right?.evidenceRefs)])] });
        row.evidenceRefs.push(...list(finding.left?.evidenceRefs), ...list(finding.right?.evidenceRefs));
      }
    }
  }
  const findings = [...rules.values()].map(row => {
    const patternCounts = row.patterns.map(({ key, ...pattern }) => pattern);
    const repeatedPatterns = row.patterns.filter(pattern => pattern.count >= 2).length;
    const knownPatterns = row.patterns.filter(pattern => ['similar', 'different'].includes(pattern.classification));
    const conflictingClassifications = new Set(knownPatterns.map(pattern => pattern.classification)).size > 1;
    const opposingSides = knownPatterns.some((pattern, index) => knownPatterns.slice(index + 1).some(other => {
      if (pattern.classification !== 'different' || other.classification !== 'different') return false;
      const left = semanticSidePattern(pattern.left), right = semanticSidePattern(pattern.right);
      const otherLeft = semanticSidePattern(other.left), otherRight = semanticSidePattern(other.right);
      return stable(left) !== stable(right) && stable(left) === stable(otherRight) && stable(right) === stable(otherLeft);
    }));
    const measured = row.similarN + row.differentN;
    const consistency = measured < 2 ? 'unmeasured' : conflictingClassifications || opposingSides ? 'contradictory'
      : repeatedPatterns ? 'recurring' : 'variable';
    return { ...row, missingN: row.missingN + Math.max(0, plannedPairs - row.plannedN), patterns: patternCounts,
      evidenceRefs: [...new Set(row.evidenceRefs)].sort(), consistency,
      limitation: 'Consistency compares the ordered left and right recorded assertions. Missing evidence is not a negative observation; no cause or winner is inferred.' };
  });
  return { plannedPairs: report?.cohort && Object.hasOwn(report.cohort, 'plannedPairCount') ? report.cohort.plannedPairCount : plannedPairs,
    selectedPairs: report?.cohort?.selectedPairCount ?? plannedPairs,
    observedPairs, eligiblePairs, excludedPairs, missingPairs, duplicatePairs, excludedReasons, findings };
}

function checkOutcomes(report, slots, pair, taskCohort, { origin, nameProvider, checkProvider, recipeProvider } = {}) {
  const groups = new Map(), seenLeft = new Set(), seenRight = new Set(), seenLeftRuns = new Set(), seenRightRuns = new Set();
  const expectedRecipes = list(report?.recipe?.meta?.checkRecipes);
  const names = new Set(expectedRecipes.map(row => row?.name).filter(value => typeof value === 'string'));
  if (nameProvider) for (const name of nameProvider()) names.add(name);
  else for (const slot of slots) for (const profile of list(slot.profiles)) {
    const run = runOf(profile);
    for (const recipe of list(run?.comparisonEvidence?.conditions?.checkRecipes ?? run?.comparisonConditions?.checkRecipes))
      if (typeof recipe?.name === 'string') names.add(recipe.name);
  }
  for (const slot of slots) {
    const rows = list(slot.profiles), left = findArm(rows, pair.left, pair.leftName), right = findArm(rows, pair.right, pair.rightName);
    if (!left || !right) continue;
    const a = runOf(left), b = runOf(right);
    const explanation = buildAuditExplanation(a, b, selectionOptions(slot));
    const key = taskKey(explanation, a, b, pairDeclaration(slot));
    const checks = run => checkProvider ? checkProvider(run)
      : new Map(canonicalAuditChecks(run).filter(row => row.origin === 'runner-check').map(row => [row.name, row]));
    const leftChecks = checks(a), rightChecks = checks(b);
    let duplicatePair = false;
    if (isCaptured(a) && isCaptured(b)) {
      const leftSource = sourceKey(a, left.profileId ?? left.profileName), rightSource = sourceKey(b, right.profileId ?? right.profileName);
      duplicatePair = seenLeft.has(leftSource) || seenRight.has(rightSource)
        || seenLeftRuns.has(runIdentity(a)) || seenRightRuns.has(runIdentity(b));
      seenLeft.add(leftSource); seenRight.add(rightSource);
      seenLeftRuns.add(runIdentity(a)); seenRightRuns.add(runIdentity(b));
    }
    for (const name of names) {
      const recipeFingerprint = recipeProvider ? recipeProvider(a, b, name) : checkRecipeKey(a, b, name);
      const expectedRecipe = expectedRecipes.find(row => row?.name === name)?.fingerprint ?? null;
      const group = groups.get(name) ?? { name, ...(origin ? { origin } : {}), recipeFingerprint: expectedRecipe ?? recipeFingerprint,
        plannedN: 0, eligibleN: 0, excludedN: 0, missingN: 0, duplicateN: 0,
        leftPassedN: 0, rightPassedN: 0, leftFailedN: 0, rightFailedN: 0, pairedN: 0,
        differences: [], statusCounts: { same: 0, different: 0, inconclusive: 0 }, behaviorAssociations: [] };
      group.plannedN++;
      if (!isCaptured(a) || !isCaptured(b)) { group.missingN++; groups.set(name, group); continue; }
      if (duplicatePair) { group.duplicateN++; groups.set(name, group); continue; }
      if (key !== taskCohort || explanation?.conditions?.sameTaskEligible !== true) {
        group.excludedN++; groups.set(name, group); continue;
      }
      if (!recipeFingerprint || (expectedRecipe && recipeFingerprint !== expectedRecipe)
        || (group.recipeFingerprint && recipeFingerprint !== group.recipeFingerprint)) {
        group.excludedN++; groups.set(name, group); continue;
      }
      group.recipeFingerprint = recipeFingerprint;
      const l = leftChecks.get(name), r = rightChecks.get(name);
      const validResult = check => check && ['passed', 'failed'].includes(check.status)
        && (check.status !== 'passed' || check.exitCode === 0)
        && (check.status !== 'failed' || check.exitCode === null || check.exitCode !== 0);
      if (!validResult(l) || !validResult(r)) {
        group.missingN++; group.statusCounts.inconclusive++;
      } else {
        group.eligibleN++; group.pairedN++;
        const leftStatus = l.status, rightStatus = r.status;
        if (leftStatus === 'passed') group.leftPassedN++; if (rightStatus === 'passed') group.rightPassedN++;
        if (leftStatus === 'failed') group.leftFailedN++; if (rightStatus === 'failed') group.rightFailedN++;
        group.statusCounts[leftStatus === rightStatus ? 'same' : 'different']++;
        const difference = (rightStatus === 'passed' ? 1 : 0) - (leftStatus === 'passed' ? 1 : 0);
        group.differences.push(difference);
        const behaviorPattern = seriesBehaviorPattern(explanation);
        let association = group.behaviorAssociations.find(row => row.behaviorPattern === behaviorPattern);
        if (!association) { association = { behaviorPattern, count: 0, leftPassedN: 0, rightPassedN: 0,
          leftFailedN: 0, rightFailedN: 0, differingOutcomeN: 0, trialPairs: [] }; group.behaviorAssociations.push(association); }
        association.count++; if (leftStatus === 'passed') association.leftPassedN++; if (rightStatus === 'passed') association.rightPassedN++;
        if (leftStatus === 'failed') association.leftFailedN++; if (rightStatus === 'failed') association.rightFailedN++;
        if (difference) association.differingOutcomeN++;
        association.trialPairs.push({ index: slot.index ?? null, leftRunId: a.id, rightRunId: b.id,
          leftRefs: list(l.evidenceRefs), rightRefs: list(r.evidenceRefs),
          leftStatus, rightStatus, rightMinusLeft: difference });
      }
      groups.set(name, group);
    }
  }
  return [...groups.values()].map(row => {
    const differing = row.differences.filter(value => value !== 0).length;
    const sign = new Set(row.differences.filter(value => value !== 0));
    const values = row.differences.slice().sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2), median = values.length
      ? values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 : null;
      return { ...row, selectedN: row.plannedN,
      missingN: Math.max(row.missingN, Math.max(0, row.plannedN - row.eligibleN - row.excludedN - row.missingN - row.duplicateN)),
      comparison: row.pairedN < 2 ? 'unmeasured' : differing === 0 ? 'same-recorded-outcome'
        : sign.size > 1 ? 'contradictory-outcomes' : differing < row.pairedN ? 'variable-outcomes' : 'recurring-outcome-difference',
      medianPassDifferenceRightMinusLeft: median,
      limitation: 'Named command results are associated with observed behavior at this scope. Check execution does not establish causality or universal quality.' };
  });
}

function findRun(subject, runId) {
  const seen = new Set();
  const visit = value => {
    if (Array.isArray(value)) { for (const item of value) { const found = visit(item); if (found) return found; } return null; }
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (value.kind === 'audit-run' && value.id === runId) return value;
    for (const child of Object.values(value)) { const found = visit(child); if (found) return found; }
    return null;
  };
  return visit(subject);
}

function projectedReviewState(report, reviews) {
  if (reviews?.subject && reviews?.reviewHistory) return { subject: reviews.subject, state: reviews.reviewHistory, evaluationId: reviews.id ?? null };
  if (reviews?.kind === 'xfx-audit-review-state') return { subject: report, state: reviews, evaluationId: null };
  if (reviews?.evidenceFingerprint && Array.isArray(reviews?.reviews) && Array.isArray(reviews?.supplementalChecks))
    return { subject: report, state: { schemaVersion: 1, kind: 'xfx-audit-review-state', evidenceFingerprint: reviews.evidenceFingerprint,
      entries: reviews.reviews, supplementalChecks: reviews.supplementalChecks }, evaluationId: reviews.evaluationId ?? null };
  return null;
}

function supplementalCheckOutcomes(report, reviews, slots, pair, taskCohort) {
  const sources = [], optionSource = projectedReviewState(report, reviews);
  if (optionSource) sources.push(optionSource);
  for (const slot of slots) for (const linked of list(slot.reviewEvaluations)) {
    const source = projectedReviewState(report, linked?.report);
    if (source) sources.push(source);
  }
  const byRun = new Map(), seenChecks = new Set();
  for (const source of sources) {
    const projected = projectAuditReviewState(source.subject, source.state);
    for (const check of list(projected.supplementalChecks)) {
      const run = findRun(source.subject, check.runId);
      const evidence = run?.sessionEvidence;
      const candidateFingerprints = new Set([evidence?.taskEnd?.fingerprint, run?.workspace?.taskEnd?.fingerprint,
        run?.workspace?.taskEndSnapshot?.fingerprint, run?.outcome?.taskEndWorkspace?.fingerprint, run?.taskEnd?.fingerprint].filter(Boolean));
      const recipes = [...list(run?.comparisonConditions?.checkRecipes), ...list(run?.comparisonEvidence?.conditions?.checkRecipes),
        ...list(evidence?.checkRecipes)].filter(row => row?.name === check.name).map(row => row.fingerprint);
      if (!safeId(check.runId) || !candidateFingerprints.has(check.candidateFingerprint) || !recipes.includes(check.recipeFingerprint)) continue;
      const identity = stable([source.evaluationId, digest(source.state), check.runId, check.id]);
      if (seenChecks.has(identity)) continue;
      seenChecks.add(identity);
      const rows = byRun.get(check.runId) ?? [];
      rows.push({ ...check, evidenceOrigin: evidence?.origin ?? 'review-submission', evaluationId: source.evaluationId });
      byRun.set(check.runId, rows);
    }
  }

  if (!byRun.size) return [];
  const names = new Set([...byRun.values()].flatMap(rows => rows.map(row => row.name)));
  const checkProvider = run => {
    const grouped = new Map();
    for (const item of list(byRun.get(run?.id))) {
      const rows = grouped.get(item.name) ?? []; rows.push(item); grouped.set(item.name, rows);
    }
    return new Map([...grouped].map(([name, rows]) => {
      const recipes = new Set(rows.map(row => row.recipeFingerprint)), candidates = new Set(rows.map(row => row.candidateFingerprint));
      const statuses = new Set(rows.map(row => `${row.status}\0${row.exitCode ?? ''}`));
      const conflict = recipes.size !== 1 || candidates.size !== 1 || statuses.size !== 1;
      const first = rows[0];
      return [name, conflict ? { name, status: 'unknown', exitCode: null, reason: 'conflicting-check-evidence',
        evidenceRefs: [...new Set(rows.flatMap(row => list(row.evidenceRefs)))], origin: 'runner-check' }
        : { name: first.name, status: first.status, exitCode: first.exitCode ?? null,
          evidenceRefs: first.evidenceRefs, origin: 'runner-check' }];
    }));
  };
  const recipeProvider = (left, right, name) => {
    const l = new Set(list(byRun.get(left?.id)).filter(row => row.name === name).map(row => row.recipeFingerprint));
    const r = new Set(list(byRun.get(right?.id)).filter(row => row.name === name).map(row => row.recipeFingerprint));
    const shared = [...l].filter(value => r.has(value));
    return shared.length === 1 && l.size === 1 && r.size === 1 ? shared[0] : null;
  };
  const reportView = { ...report, recipe: { meta: { checkRecipes: [] } } };
  const outcomes = checkOutcomes(reportView, slots, pair, taskCohort,
    { origin: 'supplemental-check', nameProvider: () => names, checkProvider, recipeProvider });
  for (const outcome of outcomes) {
    outcome.supplementalChecks = list(outcome.behaviorAssociations).flatMap(association => list(association.trialPairs)).map(pairResult => {
      const left = list(byRun.get(pairResult.leftRunId)).find(item => item.name === outcome.name && item.recipeFingerprint === outcome.recipeFingerprint);
      const right = list(byRun.get(pairResult.rightRunId)).find(item => item.name === outcome.name && item.recipeFingerprint === outcome.recipeFingerprint);
      if (!left || !right) return { ...pairResult, recipeFingerprint: outcome.recipeFingerprint };
      return { ...pairResult, leftCandidateFingerprint: left.candidateFingerprint, rightCandidateFingerprint: right.candidateFingerprint,
        recipeFingerprint: outcome.recipeFingerprint, leftProvenance: left.evidenceOrigin, rightProvenance: right.evidenceOrigin,
        leftMethod: left.method, rightMethod: right.method, leftAttribution: left.attribution, rightAttribution: right.attribution,
        leftEvaluationId: left.evaluationId, rightEvaluationId: right.evaluationId,
        leftRefs: left.evidenceRefs, rightRefs: right.evidenceRefs };
    });
    outcome.limitation = 'Supplemental checks are attributed to supplied session evidence and compared separately from original runner checks. They do not establish causality or universal quality.';
  }
  return outcomes;
}

function reviewerOutcomes(reviews, slots, pair, taskCohort) {
  const sources = [];
  if (reviews?.subject && reviews?.reviewHistory) {
    sources.push({ state: projectAuditReviewState(reviews.subject, reviews.reviewHistory),
      evidenceFingerprint: reviews.reviewPacket?.evidenceFingerprint ?? reviews.evidenceFingerprint,
      evaluationId: reviews.id ?? null });
  } else if (reviews) sources.push({ state: reviews, evidenceFingerprint: reviews.evidenceFingerprint, evaluationId: reviews.id ?? null });
  for (const slot of slots) for (const linked of list(slot.reviewEvaluations)) {
    const evaluation = linked?.report;
    if (evaluation?.subject && evaluation?.reviewHistory)
      sources.push({ state: projectAuditReviewState(evaluation.subject, evaluation.reviewHistory),
        evidenceFingerprint: evaluation.reviewPacket?.evidenceFingerprint ?? evaluation.reviewHistory.evidenceFingerprint,
        evaluationId: evaluation.id ?? null });
  }
  const byReviewer = new Map();
  for (const [sourceIndex, sourceRecord] of sources.entries()) {
    const source = sourceRecord.state;
    const entries = list(source?.reviews ?? source?.entries);
    const currentIds = new Set(source?.currentReviewIds ?? entries.map(entry => entry.id));
    for (const entry of entries.filter(item => currentIds.has(item.id) && ['human', 'ai'].includes(item?.reviewer?.type))) {
      const reviewer = object(entry.reviewer), key = stable([reviewer.type, reviewer.name, reviewer.model ?? null]);
      const row = byReviewer.get(key) ?? { reviewer, reviews: [], assessments: [] };
      row.reviews.push({ id: entry.id, scope: entry.scope, conclusion: entry.conclusion,
        preferredRunId: entry.preferredRunId ?? null,
        ...(safeId(sourceRecord.evidenceFingerprint) ? { sourceEvidenceFingerprint: sourceRecord.evidenceFingerprint } : {}),
        ...(safeId(sourceRecord.evaluationId) ? { evaluationId: sourceRecord.evaluationId } : {}) });
      row.assessments.push(...list(entry.assessments).map(assessment => ({ ...assessment, packetIndex: sourceIndex,
        sourceEvidenceFingerprint: sourceRecord.evidenceFingerprint, evaluationId: sourceRecord.evaluationId })));
      byReviewer.set(key, row);
    }
  }
  let eligiblePairCount = 0;
  const seenPairLeft = new Set(), seenPairRight = new Set();
  for (const slot of slots) {
    const rows = list(slot.profiles), left = findArm(rows, pair.left, pair.leftName), right = findArm(rows, pair.right, pair.rightName);
    const a = runOf(left), b = runOf(right);
    if (!left || !right || !isCaptured(a) || !isCaptured(b)) continue;
    const lkey = sourceKey(a, left.profileId ?? left.profileName), rkey = sourceKey(b, right.profileId ?? right.profileName);
    if (seenPairLeft.has(lkey) || seenPairRight.has(rkey) || seenPairLeft.has(runIdentity(a)) || seenPairRight.has(runIdentity(b))) continue;
    const explanation = buildAuditExplanation(a, b, selectionOptions(slot));
    if (taskKey(explanation, a, b, pairDeclaration(slot)) !== taskCohort || explanation.conditions.sameTaskEligible !== true) continue;
    seenPairLeft.add(lkey); seenPairRight.add(rkey); seenPairLeft.add(runIdentity(a)); seenPairRight.add(runIdentity(b)); eligiblePairCount++;
  }
  return [...byReviewer.values()].map(row => {
    const scores = [], byRun = new Map();
    for (const assessment of row.assessments) {
      const observation = slots.flatMap(slot => list(slot.profiles)).find(profile => runOf(profile)?.id === assessment.runId);
      if (observation && Number.isFinite(assessment.scorePercent)) {
        const value = { profile: observation.profileId ?? observation.profileName, runId: assessment.runId,
          scorePercent: assessment.scorePercent, rubricId: assessment.rubricId ?? null,
          rubricVersion: assessment.rubricVersion ?? null, rubricFingerprint: assessment.rubricFingerprint ?? null,
          packetIndex: assessment.packetIndex, sourceEvidenceFingerprint: assessment.sourceEvidenceFingerprint,
          evaluationId: assessment.evaluationId };
        scores.push(value); byRun.set(`${assessment.packetIndex}\0${assessment.runId}`, value);
      }
    }
    const pairedAssessments = [], ambiguousAssessments = [];
    const pairedLeftSources = new Set(), pairedRightSources = new Set(), pairedLeftRuns = new Set(), pairedRightRuns = new Set();
    for (const slot of slots) {
      const rows = list(slot.profiles), leftRow = findArm(rows, pair.left, pair.leftName), rightRow = findArm(rows, pair.right, pair.rightName),
        a = runOf(leftRow), b = runOf(rightRow);
      if (!isCaptured(a) || !isCaptured(b)) continue;
      const explanation = buildAuditExplanation(a, b, selectionOptions(slot));
      if (taskKey(explanation, a, b, pairDeclaration(slot)) !== taskCohort || explanation?.conditions?.sameTaskEligible !== true) continue;
      const leftSource = sourceKey(a, leftRow.profileId ?? leftRow.profileName), rightSource = sourceKey(b, rightRow.profileId ?? rightRow.profileName);
      if (pairedLeftSources.has(leftSource) || pairedRightSources.has(rightSource)
        || pairedLeftRuns.has(runIdentity(a)) || pairedRightRuns.has(runIdentity(b))) continue;
      pairedLeftSources.add(leftSource); pairedRightSources.add(rightSource);
      pairedLeftRuns.add(runIdentity(a)); pairedRightRuns.add(runIdentity(b));
      const possibleLeft = [...byRun.values()].filter(value => value.runId === a.id),
        possibleRight = [...byRun.values()].filter(value => value.runId === b.id);
      const candidates = possibleLeft.flatMap(l => possibleRight.filter(r => l.rubricFingerprint
        && l.rubricFingerprint === r.rubricFingerprint).map(r => ({ l, r })));
      const uniqueCandidates = new Map(candidates.map(item => [stable([item.l.scorePercent, item.r.scorePercent, item.l.rubricFingerprint]), item]));
      const paired = uniqueCandidates.size === 1 ? [...uniqueCandidates.values()][0] : null;
      if (uniqueCandidates.size > 1) ambiguousAssessments.push({ trialIndex: slot.index ?? null, leftRunId: a.id,
        rightRunId: b.id, candidateCount: uniqueCandidates.size, reason: 'conflicting-assessments-for-reviewer-and-rubric' });
      if (paired) { const { l, r } = paired; pairedAssessments.push({
        trialIndex: slot.index, rubricId: l.rubricId, rubricVersion: l.rubricVersion,
        rubricFingerprint: l.rubricFingerprint,
        leftRunId: a.id, rightRunId: b.id, leftScorePercent: l.scorePercent, rightScorePercent: r.scorePercent,
        ...(safeId(l.sourceEvidenceFingerprint) ? { leftSourceEvidenceFingerprint: l.sourceEvidenceFingerprint } : {}),
        ...(safeId(r.sourceEvidenceFingerprint) ? { rightSourceEvidenceFingerprint: r.sourceEvidenceFingerprint } : {}),
        deltaRightMinusLeft: r.scorePercent - l.scorePercent }); }
    }
    const byScope = new Map();
    for (const item of row.reviews) { const values = byScope.get(item.scope) ?? new Set(); values.add(item.conclusion); byScope.set(item.scope, values); }
    const rubricGroups = new Map();
    for (const assessment of pairedAssessments) {
      const key = stable([assessment.rubricId, assessment.rubricVersion, assessment.rubricFingerprint]);
      const group = rubricGroups.get(key) ?? { rubricId: assessment.rubricId, rubricVersion: assessment.rubricVersion,
        rubricFingerprint: assessment.rubricFingerprint, pairedN: 0, deltas: [] };
      group.pairedN++; group.deltas.push(assessment.deltaRightMinusLeft); rubricGroups.set(key, group);
    }
    const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
      return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null; };
    return { reviewer: row.reviewer, currentReviewCount: row.reviews.length,
      reviews: row.reviews, disagreement: [...byScope.values()].some(values => values.size > 1),
      rubricAssessments: scores.map(({ packetIndex, ...assessment }) => assessment), pairedAssessments, ambiguousAssessments,
      rubricComparisons: [...rubricGroups.values()].map(group => ({ rubricId: group.rubricId, rubricVersion: group.rubricVersion,
        rubricFingerprint: group.rubricFingerprint, plannedN: eligiblePairCount,
        selectedN: eligiblePairCount, pairedN: group.pairedN,
        missingN: Math.max(0, eligiblePairCount - group.pairedN), medianDeltaRightMinusLeft: median(group.deltas),
        limitation: 'Only paired assessments from the same reviewer and exact rubric are compared.' })),
      limitation: 'Reviewer judgments remain attributed and separate by reviewer type and identity; scores are not pooled into an automatic winner.' };
  });
}

function pairTaskGroups(report, pair) {
  const groups = new Map();
  for (const slot of list(report?.trials).slice(0, 160)) {
    const rows = list(slot.profiles), a = runOf(findArm(rows, pair.left, pair.leftName)), b = runOf(findArm(rows, pair.right, pair.rightName));
    if (!isCaptured(a) || !isCaptured(b)) continue;
    const explanation = buildAuditExplanation(a, b, selectionOptions(slot));
    const key = taskKey(explanation, a, b, pairDeclaration(slot));
    if (key && explanation?.conditions?.sameTaskEligible === true) groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return groups;
}

/** Aggregate retained repeated-run findings and outcomes for one fixed profile pair. */
function buildPairConsistency(report, { reviews, requestedPair, taskGroupKey } = {}) {
  if (report?.kind !== 'audit-series-report' || !Array.isArray(report.trials))
    throw new Error('Repeated-run consistency requires an audit-series-report with trial slots');
  const slots = report.trials.slice(0, 160), first = slots.flatMap(slot => list(slot.profiles)).filter(row => row && (row.profileId || row.profileName));
  const identity = row => row.profileId ?? row.profileName;
  const arms = list(report?.cohort?.arms);
  let left = requestedPair?.left ?? arms[0]?.id ?? arms[0]?.profileId ?? (report.comparisons?.[0]?.left),
    right = requestedPair?.right ?? arms[1]?.id ?? arms[1]?.profileId ?? (report.comparisons?.[0]?.right);
  if (!left || !right) {
    const ordered = [];
    for (const slot of slots) for (const row of list(slot.profiles)) if (!ordered.includes(identity(row))) ordered.push(identity(row));
    [left, right] = ordered;
  }
  if (!left || !right) return { schemaVersion: 1, status: 'unmeasured', cohort: null, coverage: { plannedPairs: null,
    selectedPairs: 0, observedPairs: 0, eligiblePairs: 0, excludedPairs: 0, missingPairs: 0, duplicatePairs: 0 }, findings: [], outcomes: [], reviewers: [],
    limitations: ['No fixed two-profile pair is present in the retained trial slots.'] };
  const leftRow = first.find(row => identity(row) === left), rightRow = first.find(row => identity(row) === right);
  const pair = { left, right, leftName: leftRow?.profileName ?? left, rightName: rightRow?.profileName ?? right };
  const taskGroups = pairTaskGroups(report, pair), keys = [...taskGroups.keys()].sort();
  const taskCohort = taskGroupKey !== undefined ? taskGroupKey : keys.length === 1 ? keys[0] : null;
  const findingsResult = aggregateFindings(report, slots, pair, taskCohort);
  const plannedPairs = report?.cohort && Object.hasOwn(report.cohort, 'plannedPairCount')
    ? report.cohort.plannedPairCount : findingsResult.plannedPairs;
  const coverage = { plannedPairs,
    selectedPairs: report?.cohort?.selectedPairCount ?? findingsResult.selectedPairs,
    observedPairs: findingsResult.observedPairs, eligiblePairs: findingsResult.eligiblePairs,
    excludedPairs: findingsResult.excludedPairs, missingPairs: findingsResult.missingPairs,
    duplicatePairs: findingsResult.duplicatePairs,
    ...(taskCohort ? { taskGroupPairs: taskGroups.get(taskCohort) ?? 0,
      otherTaskGroupPairs: [...taskGroups.entries()].reduce((sum, [key, count]) => sum + (key === taskCohort ? 0 : count), 0) } : {}) };
  const findings = taskCohort ? findingsResult.findings : findingsResult.findings.map(row => ({ ...row, eligibleN: 0,
    missingN: row.missingN + (coverage.plannedPairs == null ? 0 : Math.max(0, coverage.plannedPairs - row.plannedN)),
    similarN: 0, differentN: 0, inconclusiveN: 0, consistency: 'unmeasured', evidenceRefs: [],
    cohortUnavailable: keys.length > 1 ? 'task-association-varies-across-selected-sessions' : 'same-task-association-unavailable' }));
  const outcomeRows = [...checkOutcomes(report, slots, pair, taskCohort),
    ...supplementalCheckOutcomes(report, reviews, slots, pair, taskCohort)];
  const reviewerRows = reviewerOutcomes(reviews, slots, pair, taskCohort);
  const measured = findings.some(row => ['recurring', 'contradictory', 'variable'].includes(row.consistency))
    || outcomeRows.some(row => row.pairedN >= 2)
    || reviewerRows.some(row => row.rubricComparisons.some(group => group.pairedN >= 2));
  const reason = slots.length < 2 ? 'single-pair-consistency-unmeasured' : !taskCohort ? 'same-task-cohort-unavailable'
    : findings.some(row => row.consistency === 'contradictory') ? 'some-behavior-varies-across-comparable-runs' : 'descriptive-repeated-evidence';
  return { schemaVersion: 1, status: measured ? 'measured' : 'unmeasured',
    cohort: { source: report?.cohort?.source ?? 'scheduled-series', arms: { left: pair.left, right: pair.right },
      ...(keys.length > 1 ? { taskGroupCount: keys.length } : {}),
      ...(taskCohort ? { taskGroupKey: taskCohort } : {}),
      ...(taskCohort?.startsWith('declared:') ? { taskId: taskCohort.slice('declared:'.length) } : {}),
      taskFingerprint: taskCohort?.startsWith('recorded:') ? taskCohort.slice('recorded:'.length) : null,
      taskAssociation: taskCohort?.startsWith('declared:') ? 'user-declared' : taskCohort ? 'recorded-input-identity' : 'unknown' },
    coverage, findings, outcomes: outcomeRows, reviewers: reviewerRows,
    statistics: list(report?.comparisons).flatMap((row, comparisonIndex) => row.left === pair.left && row.right === pair.right
      ? [{ source: 'audit-series-report.comparisons', comparisonIndex,
        ...(keys.length > 1 ? { scope: 'pooled-across-selected-task-groups', taskGroupAttribution: 'not-available' } : { scope: taskCohort ? 'selected-task-group' : 'task-group-unavailable' }),
        qualityDeltaEvidence: row.qualityDeltaEvidence ?? null, metricNames: Object.keys(object(row.metrics)) }] : []),
    limitations: [reason, 'Comparisons are descriptive and do not establish cause, statistical significance, or a universal winner.',
      'Missing or partial records remain explicit and are never interpreted as evidence that a behavior did not occur.'] };
}

/** Aggregate each fixed profile pair separately, preserving its left/right orientation. */
export function buildAuditConsistency(report, { reviews } = {}) {
  if (report?.kind !== 'audit-series-report' || !Array.isArray(report.trials))
    throw new Error('Repeated-run consistency requires an audit-series-report with trial slots');
  const pairs = list(report.comparisons).map(row => ({ left: row.left, right: row.right }));
  if (!pairs.length) {
    const names = [];
    for (const trial of report.trials) for (const row of list(trial.profiles)) {
      const value = row.profileId ?? row.profileName;
      if (value && !names.includes(value)) names.push(value);
    }
    if (names.length >= 2) pairs.push({ left: names[0], right: names[1] });
  }
  const comparisons = pairs.flatMap(requestedPair => {
    const rows = list(report.trials).flatMap(slot => list(slot.profiles));
    const left = rows.find(row => (row.profileId ?? row.profileName) === requestedPair.left);
    const right = rows.find(row => (row.profileId ?? row.profileName) === requestedPair.right);
    const pair = { ...requestedPair, leftName: left?.profileName ?? requestedPair.left, rightName: right?.profileName ?? requestedPair.right };
    const groups = [...pairTaskGroups(report, pair).keys()].sort();
    return groups.length ? groups.map(taskGroupKey => buildPairConsistency(report, { reviews, requestedPair, taskGroupKey }))
      : [buildPairConsistency(report, { reviews, requestedPair, taskGroupKey: null })];
  });
  return { schemaVersion: 1, kind: 'audit-series-consistency', status: comparisons.some(row => row.status === 'measured') ? 'measured' : 'unmeasured',
    cohort: report.cohort ?? null, comparisons,
    limitations: [...new Set(comparisons.flatMap(row => row.limitations ?? []))] };
}
