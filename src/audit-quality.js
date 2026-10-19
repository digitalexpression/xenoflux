import { createHash } from 'node:crypto';

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const plain = (value, max = 500) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !CONTROL.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowed = (value, keys, label) => {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label} fields`);
};
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const list = value => Array.isArray(value) ? value : [];

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) throw new Error('Check recipes must be an array');
  const names = new Set();
  for (const check of checks) {
    if (!object(check) || !plain(check.name, 100) || names.has(check.name)) throw new Error('Check recipes need unique names');
    names.add(check.name);
  }
  return checks;
}

/** Validate and normalize the frozen, human-readable task-quality definition. */
export function validateAuditQuality(value, checks = []) {
  if (value === undefined) return undefined;
  allowed(value, ['schemaVersion', 'id', 'version', 'checks', 'workspace', 'rubric'], 'audit quality definition');
  if ((value.schemaVersion ?? 1) !== 1 || !plain(value.id, 120) || !plain(value.version, 80))
    throw new Error('Quality definition requires schemaVersion 1, id, and version');
  const recipes = normalizeChecks(checks);
  const names = new Set(recipes.map(item => item.name));
  if (!Array.isArray(value.checks ?? []) || (value.checks ?? []).length > 20) throw new Error('Quality checks must be an array of at most 20 criteria');
  const seenChecks = new Set();
  const qualityChecks = (value.checks ?? []).map(item => {
    allowed(item, ['name', 'required'], 'quality check criterion');
    if (!plain(item.name, 100) || !names.has(item.name) || seenChecks.has(item.name)
      || (item.required !== undefined && typeof item.required !== 'boolean'))
      throw new Error('Quality check criteria must uniquely reference declared checks');
    seenChecks.add(item.name);
    return { name: item.name, required: item.required ?? true };
  });
  let workspace;
  if (value.workspace !== undefined) {
    allowed(value.workspace, ['maxChangedFiles'], 'workspace criterion');
    if (!Number.isSafeInteger(value.workspace.maxChangedFiles) || value.workspace.maxChangedFiles < 0)
      throw new Error('Workspace maxChangedFiles must be a nonnegative integer');
    workspace = { maxChangedFiles: value.workspace.maxChangedFiles };
  }
  let rubric;
  if (value.rubric !== undefined) {
    allowed(value.rubric, ['id', 'version', 'required', 'minimumPercent', 'criteria'], 'human rubric');
    if (!plain(value.rubric.id, 120) || !plain(value.rubric.version, 80)
      || (value.rubric.required !== undefined && typeof value.rubric.required !== 'boolean')
      || (value.rubric.minimumPercent !== undefined && !finite(value.rubric.minimumPercent, 0, 100))
      || !Array.isArray(value.rubric.criteria) || value.rubric.criteria.length < 1 || value.rubric.criteria.length > 50)
      throw new Error('Human rubric requires id, version, criteria, and valid optional score bounds');
    const ids = new Set();
    const criteria = value.rubric.criteria.map(item => {
      allowed(item, ['id', 'label', 'maxScore', 'weight', 'description'], 'rubric criterion');
      if (!plain(item.id, 120) || ids.has(item.id) || !plain(item.label, 240)
        || !finite(item.maxScore, Number.EPSILON, 1000000)
        || (item.weight !== undefined && !finite(item.weight, Number.EPSILON, 1000000))
        || (item.description !== undefined && !plain(item.description, 1000)))
        throw new Error('Rubric criteria need unique IDs, labels, and positive score bounds');
      ids.add(item.id);
      return { id: item.id, label: item.label, maxScore: item.maxScore,
        weight: item.weight ?? 1, ...(item.description === undefined ? {} : { description: item.description }) };
    });
    rubric = { id: value.rubric.id, version: value.rubric.version, required: value.rubric.required ?? true,
      ...(value.rubric.minimumPercent === undefined ? {} : { minimumPercent: value.rubric.minimumPercent }), criteria };
  }
  // Every command check is required unless its criterion explicitly opts out.
  // Keep evaluation aligned with runner stop/failure semantics when a caller
  // declares workspace/rubric criteria and omits a check reference.
  for (const recipe of recipes) if (!seenChecks.has(recipe.name)) qualityChecks.push({ name: recipe.name, required: true });
  if (!qualityChecks.length && !workspace && !rubric) throw new Error('Quality definition must declare at least one check, workspace, or rubric criterion');
  return { schemaVersion: 1, id: value.id, version: value.version, checks: qualityChecks,
    ...(workspace ? { workspace } : {}), ...(rubric ? { rubric } : {}) };
}

/** Stable fingerprint binds the definition to the exact referenced check recipes. */
export function auditQualityFingerprint(quality, checks = []) {
  const normalized = validateAuditQuality(quality, checks);
  if (!normalized) return undefined;
  const recipes = normalizeChecks(checks);
  const selected = normalized.checks.map(item => recipes.find(recipe => recipe.name === item.name));
  return createHash('sha256').update(JSON.stringify({ quality: normalized, checks: selected })).digest('hex');
}

function checkEvidence(checks, name) {
  const found = list(checks).find(item => item?.name === name);
  if (!found) return { status: 'not-run', refs: [], reason: 'Declared check has no recorded result.' };
  if (found.status === 'passed' && found.exitCode === 0) return { status: 'passed', refs: [`check:${name}`] };
  if (['failed', 'output-limit'].includes(found.status) || (Number.isInteger(found.exitCode) && found.exitCode !== 0))
    return { status: 'failed', refs: [`check:${name}`], reason: `Recorded check status: ${found.status ?? 'unknown'}.` };
  return { status: 'unknown', refs: [`check:${name}`], reason: `Recorded check status: ${found.status ?? 'unknown'}.` };
}

function knownEvidence(run) {
  const refs = new Set();
  if (typeof run?.id === 'string' && run.id) refs.add(`run:${run.id}`);
  for (const check of list(run?.checks ?? run?.outcome?.checks)) if (typeof check?.name === 'string') refs.add(`check:${check.name}`);
  const task = run?.workspace?.taskEnd;
  if (task?.fingerprint != null) refs.add(`workspace:task-end:${task.fingerprint}`);
  const final = run?.workspace?.checkEnd ?? run?.finalWorkspace;
  if (final?.fingerprint != null) refs.add(`workspace:final:${final.fingerprint}`);
  for (const agent of list(run?.agents)) {
    if (typeof agent?.id !== 'string') continue;
    const corroborated = Number.isFinite(agent.sourceLine)
      || list(run?.turns).some(turn => turn?.agentId === agent.id && Number.isFinite(turn.sourceLine))
      || list(run?.events).some(event => event?.agentId === agent.id && Number.isFinite(event.sourceLine));
    if (corroborated) refs.add(`agent:${agent.id}`);
  }
  return refs;
}

const FAILED_TERMINAL_TURNS = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled', 'interrupted', 'aborted', 'timeout', 'timed_out']);
function nativeCompletion(run) {
  const statuses = [run?.outcome?.nativeTurnStatus, run?.outcome?.task?.nativeTurnStatus, run?.task?.nativeTurnStatus];
  const threadId = run?.source?.threadId;
  if (typeof threadId === 'string' && threadId) {
    for (const turn of list(run?.turns)) if (turn?.agentId === threadId && typeof turn.status === 'string') statuses.push(turn.status);
  }
  const normalized = statuses.filter(status => typeof status === 'string').map(status => status.toLowerCase());
  if (normalized.some(status => FAILED_TERMINAL_TURNS.has(status))) return 'failed';
  if (normalized.includes('completed')) return 'completed';
  return 'unknown';
}

function validateReview(value, { run, quality, checks = [] } = {}) {
  allowed(value, ['schemaVersion', 'runId', 'fingerprint', 'reviewer', 'reviewedAt', 'ratings', 'rubricId', 'rubricVersion'], 'audit review');
  const fingerprint = auditQualityFingerprint(quality, checks);
  if (value.schemaVersion !== 1 || value.runId !== run?.id || value.fingerprint !== fingerprint)
    throw new Error('Review does not match this run and frozen quality definition');
  if (!plain(value.reviewer, 200) || !plain(value.reviewedAt, 80) || !Number.isFinite(Date.parse(value.reviewedAt))
    || !Array.isArray(value.ratings)) throw new Error('Review requires reviewer, timestamp, and ratings');
  const rubric = quality.rubric;
  if (!rubric) throw new Error('A review requires a declared human rubric');
  if ((value.rubricId !== undefined && value.rubricId !== rubric.id)
    || (value.rubricVersion !== undefined && value.rubricVersion !== rubric.version))
    throw new Error('Review does not match this frozen rubric');
  const expected = new Map(rubric.criteria.map(item => [item.id, item]));
  if (value.ratings.length !== expected.size) throw new Error('Review must rate every rubric criterion exactly once');
  const seen = new Set(), refsAllowed = knownEvidence(run);
  const ratings = value.ratings.map(item => {
    allowed(item, ['criterionId', 'score', 'rationale', 'evidenceRefs'], 'review rating');
    const criterion = expected.get(item.criterionId);
    if (!criterion || seen.has(item.criterionId) || (item.score !== null && !finite(item.score, 0, criterion.maxScore))
      || !plain(item.rationale, 2000) || !Array.isArray(item.evidenceRefs)
      || item.evidenceRefs.some(ref => typeof ref !== 'string' || !refsAllowed.has(ref))
      || (item.score !== null && item.evidenceRefs.length === 0))
      throw new Error('Review rating has an invalid criterion, score, rationale, or evidence reference');
    seen.add(item.criterionId);
    return { criterionId: item.criterionId, score: item.score, rationale: item.rationale, evidenceRefs: [...new Set(item.evidenceRefs)] };
  });
  return { schemaVersion: 1, runId: value.runId, fingerprint, reviewer: value.reviewer, reviewedAt: value.reviewedAt,
    rubricId: rubric.id, rubricVersion: rubric.version, ratings };
}

/** Validate a human review against a specific run, rubric fingerprint, and known evidence references. */
export function validateAuditReview(value, options = {}) {
  const { run, checks = [] } = options;
  const quality = validateAuditQuality(options.quality, checks);
  if (!quality) throw new Error('A quality definition is required to validate a review');
  return validateReview(value, { run, quality, checks });
}

/** Evaluate declared checks, task-end workspace evidence, and an optional human rubric review. */
export function evaluateAuditQuality(run, qualityValue, { checks = [], review = null } = {}) {
  const quality = validateAuditQuality(qualityValue, checks);
  if (!quality) return undefined;
  const fingerprint = auditQualityFingerprint(quality, checks), criteria = [];
  const gate = (id, passed, evidenceRef, reason) => criteria.push({ id, kind: 'gate', required: true,
    status: passed === true ? 'passed' : passed === false ? 'failed' : 'unknown',
    evidenceRefs: evidenceRef ? [evidenceRef] : [], ...(reason ? { reason } : {}) });
  const execution = run?.execution;
  const nativeStatus = nativeCompletion(run);
  const executionFailed = ['failed', 'timeout', 'cancelled', 'output-limit', 'shutdown-failed'].includes(execution?.status)
    || (execution?.status === 'exited' && execution?.exitCode !== 0);
  const nativeGateStatus = nativeStatus === 'failed' || executionFailed ? false
    : nativeStatus === 'completed' && execution?.status === 'exited' && execution?.exitCode === 0 ? true : null;
  gate('native-task-completed', nativeGateStatus, run?.id ? `run:${run.id}` : null,
    nativeStatus === 'unknown' ? 'Explicit root native completion evidence is missing.'
      : nativeStatus === 'failed' ? 'The recorded root native turn ended unsuccessfully.'
        : executionFailed ? 'The task process ended unsuccessfully.'
          : nativeGateStatus === null ? 'Native task completion and successful process exit are both required.' : undefined);
  if (run?.profileSettings) gate('profile-settings-preserved', run.profileSettings.status === 'unchanged' ? true : run.profileSettings.status === 'changed' ? false : null, run.id ? `run:${run.id}` : null,
    run.profileSettings.status === 'unchanged' ? null : `Recorded settings status: ${run.profileSettings.status ?? 'unknown'}.`);
  if (run?.runningClients) gate('running-clients-preserved', run.runningClients.status === 'unchanged' ? true : run.runningClients.status === 'changed' ? false : null, run.id ? `run:${run.id}` : null,
    run.runningClients.status === 'unchanged' ? null : `Recorded client status: ${run.runningClients.status ?? 'unknown'}.`);
  for (const item of quality.checks) {
    const result = checkEvidence(run?.checks ?? run?.outcome?.checks, item.name);
    criteria.push({ id: `check:${item.name}`, kind: 'check', required: item.required, status: result.status,
      evidenceRefs: result.refs, ...(result.reason ? { reason: result.reason } : {}) });
  }
  if (quality.workspace) {
    const snapshot = run?.workspace?.taskEnd;
    const verified = snapshot?.captureComplete === true && snapshot?.timing === 'task-end'
      && snapshot.changeCountStatus === 'known' && Number.isSafeInteger(snapshot.changedFileCount)
      && snapshot.changedFileCount >= 0 && snapshot.changeCountBasis === 'post-setup-snapshot-delta-v1'
      && typeof snapshot.fingerprint === 'string' && snapshot.fingerprint.length > 0;
    const status = !verified ? 'unknown' : snapshot.changedFileCount <= quality.workspace.maxChangedFiles ? 'passed' : 'failed';
    criteria.push({ id: 'workspace:max-changed-files', kind: 'workspace', required: true, status,
      evidenceRefs: verified ? [`workspace:task-end:${snapshot.fingerprint}`] : [],
      ...(!verified ? { reason: snapshot?.changeCountReason ?? 'A complete exact task-end workspace snapshot and verified post-setup change count are required; later snapshots cannot substitute.' }
        : { observed: snapshot.changedFileCount, maximum: quality.workspace.maxChangedFiles,
          countBasis: snapshot.changeCountBasis }) });
  }
  let normalizedReview;
  let rubric;
  if (quality.rubric) {
    rubric = { status: 'pending-review', rubricId: quality.rubric.id, rubricVersion: quality.rubric.version };
    if (review) {
      normalizedReview = validateReview(review, { run, quality, checks });
      const ratings = new Map(normalizedReview.ratings.map(item => [item.criterionId, item]));
      const totalWeight = quality.rubric.criteria.reduce((sum, item) => sum + item.weight, 0);
      const scored = quality.rubric.criteria.every(item => ratings.get(item.id)?.score !== null);
      const percent = scored ? 100 * quality.rubric.criteria.reduce((sum, item) => sum
        + (ratings.get(item.id).score / item.maxScore) * item.weight, 0) / totalWeight : null;
      const minimum = quality.rubric.minimumPercent;
      const rubricStatus = !scored ? 'unknown' : minimum === undefined ? 'passed' : percent >= minimum ? 'passed' : 'failed';
      rubric = { status: 'reviewed', result: rubricStatus, scorePercent: percent,
        ...(minimum === undefined ? {} : { minimumPercent: minimum }), rubricId: quality.rubric.id, rubricVersion: quality.rubric.version };
      criteria.push({ id: `rubric:${quality.rubric.id}`, kind: 'human-rubric', required: quality.rubric.required,
        status: rubricStatus, evidenceRefs: normalizedReview.ratings.flatMap(item => item.evidenceRefs),
        ...(!scored ? { reason: 'One or more rubric scores are unscored; no values were imputed.' } : {}) });
    } else criteria.push({ id: `rubric:${quality.rubric.id}`, kind: 'human-rubric', required: quality.rubric.required,
      status: 'not-run', evidenceRefs: [], reason: quality.rubric.required
        ? 'A required human review has not been recorded.' : 'No optional human review has been recorded.' });
  }
  const required = criteria.filter(item => item.required);
  const status = required.some(item => item.status === 'failed') ? 'failed'
    : required.some(item => ['unknown', 'not-run'].includes(item.status)) ? 'incomplete' : 'passed';
  return { definition: quality, fingerprint, status, criteria, rubric: rubric ?? { status: 'not-declared' },
    ...(normalizedReview ? { review: normalizedReview } : {}) };
}
