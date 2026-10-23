import { createHash } from 'node:crypto';
import { auditQualityFingerprint, validateAuditQuality, validateAuditReview } from './audit-quality.js';
import { projectAuditSessionEvidence } from './audit-session-evidence.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const text = (value, max = 2000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const onlyKeys = (value, keys, label) => {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label} fields`);
};
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sourceDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function runsOf(subject) {
  const out = [], seen = new Set();
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!object(value) || seen.has(value)) return;
    seen.add(value);
    const nativeRun = value.kind === 'audit-run' && typeof value.id === 'string';
    const projectedRun = typeof value.id === 'string' && object(value.source)
      && (object(value.comparisonConditions) || object(value.comparisonEvidence))
      && (Array.isArray(value.turns) || Array.isArray(value.checks) || object(value.workspace));
    if (nativeRun || projectedRun) out.push(value);
    for (const child of Object.values(value)) if (object(child) || Array.isArray(child)) visit(child);
  };
  visit(subject);
  return out;
}

function evidenceFor(subject) {
  const refs = new Set(), runIds = new Set(), candidates = new Map(), recipes = new Map();
  const refOwners = new Map(), runObjects = new WeakMap();
  const add = (value, runId = null) => {
    if (typeof value !== 'string' || value.length > 300) return;
    refs.add(value);
    if (runId) { const owners = refOwners.get(value) ?? new Set(); owners.add(runId); refOwners.set(value, owners); }
  };
  const addRunRef = (value, runId) => {
    const qualified = typeof value === 'string' && value.startsWith('check:') && !value.startsWith(`check:${runId}:`)
      ? `check:${runId}:${value.slice('check:'.length)}` : value;
    add(qualified, runId);
  };
  const runs = runsOf(subject);
  for (const run of runs) {
    if (typeof run.id !== 'string' || !run.id) continue;
    const attached = projectAuditSessionEvidence(run);
    runObjects.set(run, run.id); runIds.add(run.id); add(`run:${run.id}`, run.id);
    if (attached) add(`session-evidence:${run.id}`, run.id);
    for (const action of [...list(run.actions), ...list(run.namedActions), ...list(run.artifacts)]) {
      const id = action?.id ?? action?.callId;
      if (typeof id === 'string') add(`action:${run.id}:${id}`, run.id);
      for (const ref of list(action?.evidenceRefs)) addRunRef(ref, run.id);
    }
    for (const check of [...list(run.checks), ...list(run.outcome?.checks)]) {
      if (typeof check?.name === 'string') add(`check:${run.id}:${check.name}`, run.id);
      for (const ref of list(check?.evidenceRefs)) {
        if (typeof ref === 'string' && ref.startsWith('check:')) {
          addRunRef(ref, run.id);
        } else addRunRef(ref, run.id);
      }
    }
    for (const [stage, snapshot] of [['task-end', run.workspace?.taskEnd], ['task-end', run.workspace?.taskEndSnapshot],
      ['check-end', run.workspace?.checkEnd], ['final', run.workspace?.final], ['task-end', run.outcome?.taskEndWorkspace],
      ['task-end', run.taskEnd], ['final', run.finalWorkspace], ['supplied-task-end', attached?.taskEnd]]) {
      if (typeof snapshot?.fingerprint === 'string' && snapshot.fingerprint) {
        const rows = candidates.get(run.id) ?? new Map();
        rows.set(snapshot.fingerprint, stage); candidates.set(run.id, rows);
        add(`workspace:${run.id}:${stage}:${snapshot.fingerprint}`, run.id);
      }
    }
    for (const recipe of [...list(run.comparisonConditions?.checkRecipes), ...list(run.auditConditions?.checkRecipes), ...list(attached?.checkRecipes),
      ...list(subject.recipe?.meta?.checkRecipes), ...list(subject.spec?.checks).map(check => ({
        name: check?.name, fingerprint: sourceDigest(check),
      }))]) {
      if (text(recipe?.name, 100) && text(recipe?.fingerprint, 200)) {
        const key = `${run.id}\0${recipe.name}\0${recipe.fingerprint}`;
        recipes.set(key, { runId: run.id, name: recipe.name, fingerprint: recipe.fingerprint });
      }
    }
  }
  // Retain only references actually present in the frozen subject.
  const scan = (value, inheritedRunId = null) => {
    if (Array.isArray(value)) return value.forEach(item => scan(item, inheritedRunId));
    if (!object(value)) return;
    const runId = runObjects.get(value) ?? inheritedRunId;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'evidenceRefs') list(child).forEach(ref => {
        if (typeof ref !== 'string') return;
        if (/^check:[^:]+$/.test(ref)) return; // Bare legacy check refs are ambiguous across runs.
        if (runId) addRunRef(ref, runId); else add(ref);
      });
      if (key === 'fingerprint' && typeof child === 'string' && child) add(child, runId);
      scan(child, runId);
    }
  };
  scan(subject);
  return { runs, runIds, refs, refOwners, candidates, recipes };
}

function subjectInfo(subject) {
  if (!object(subject)) throw new Error('A frozen audit subject is required');
  const ev = evidenceFor(subject);
  const kind = subject.kind ?? subject.type ?? (ev.runIds.size > 1 ? 'comparison' : 'run');
  const id = subject.id ?? subject.comparisonId ?? subject.seriesId ?? subject.runId ?? [...ev.runIds].join(',');
  const claimScopes = [`subject:${kind}:${id}`];
  for (const runId of [...ev.runIds].sort()) claimScopes.push(`run:${runId}`);
  return { ev, kind: String(kind), id: String(id ?? ''), claimScopes };
}

function subjectQuality(subject) {
  return subject?.spec?.quality ?? subject?.recipe?.criteria ?? subject?.source?.spec?.quality;
}
/** Build a portable packet whose digest binds the whole frozen source and its evidence references. */
export function buildAuditReviewPacket(subject) {
  const { ev, kind, id, claimScopes } = subjectInfo(subject);
  const evidenceFingerprint = hash(subject);
  return {
    schemaVersion: 1, kind: 'xfx-audit-review-packet', evidenceFingerprint,
    subject: { kind, id, runIds: [...ev.runIds].sort() }, claimScopes,
    summary: { claimScope: ev.runIds.size > 1 ? 'comparison' : ev.runIds.size === 1 ? 'single-run' : 'subject',
      runCount: ev.runIds.size, evidenceRefCount: ev.refs.size },
    evidenceRefs: [...ev.refs].sort(),
    candidates: [...ev.candidates].flatMap(([runId, rows]) => [...rows].map(([fingerprint, stage]) => ({ runId, fingerprint, stage })))
      .sort((a, b) => a.runId.localeCompare(b.runId) || a.stage.localeCompare(b.stage) || a.fingerprint.localeCompare(b.fingerprint)),
    checkRecipes: [...ev.recipes.values()].sort((a, b) => a.runId.localeCompare(b.runId) || a.name.localeCompare(b.name)
      || a.fingerprint.localeCompare(b.fingerprint)),
  };
}

function validateSubmissionHeader(subject, submission) {
  const packet = buildAuditReviewPacket(subject);
  onlyKeys(submission, ['schemaVersion', 'kind', 'evidenceFingerprint', 'reviews', 'supplementalChecks'], 'review submission');
  if (submission.schemaVersion !== 1 || submission.kind !== 'xfx-audit-review-submission')
    throw new Error('Invalid audit review submission');
  if (submission.evidenceFingerprint !== packet.evidenceFingerprint)
    throw new Error('Review submission is bound to different frozen evidence');
  return packet;
}

function validateReviewer(value) {
  onlyKeys(value, ['type', 'name', 'model'], 'reviewer');
  if (!['human', 'ai'].includes(value.type) || !text(value.name, 200)
    || (value.model !== undefined && !text(value.model, 200))) throw new Error('Review requires an attributed human or AI reviewer');
  return { type: value.type, name: value.name, ...(value.model ? { model: value.model } : {}) };
}

function validateReviewEntry(raw, packet, ev, prior, subject) {
  onlyKeys(raw, ['id', 'reviewer', 'reviewedAt', 'method', 'scope', 'conclusion', 'preferredRunId', 'summary', 'evidenceRefs', 'supersedes', 'assessments'], 'review entry');
  if (!text(raw.id, 120) || !object(raw.reviewer) || !text(raw.reviewedAt, 80)
    || !Number.isFinite(Date.parse(raw.reviewedAt)) || !text(raw.method, 120) || !text(raw.scope, 240)
    || !['positive', 'negative', 'mixed', 'inconclusive'].includes(raw.conclusion)
    || !text(raw.summary, 4000) || !Array.isArray(raw.evidenceRefs)) throw new Error('Invalid review entry');
  if (prior.entries.some(row => row.id === raw.id)) throw new Error('Review entry ID already exists');
  if (!packet.claimScopes.includes(raw.scope)) throw new Error('Review scope must identify the packet or an included run');
  const reviewer = validateReviewer(raw.reviewer);
  if (raw.preferredRunId !== undefined && !ev.runIds.has(raw.preferredRunId)) throw new Error('Preferred run must be included in the frozen subject');
  if (raw.scope.startsWith('run:') && raw.preferredRunId && raw.scope !== `run:${raw.preferredRunId}`)
    throw new Error('Preferred run must match the review run scope');
  const evidenceRefs = [...new Set(raw.evidenceRefs)];
  if (evidenceRefs.some(ref => typeof ref !== 'string' || !ev.refs.has(ref))) throw new Error('Review contains an unknown evidence reference');
  if (raw.scope.startsWith('run:')) {
    const selectedRun = raw.scope.slice('run:'.length);
    if (evidenceRefs.some(ref => [...(ev.refOwners.get(ref) ?? [])].some(owner => owner !== selectedRun)))
      throw new Error('Run-scoped review cannot cite another run\'s evidence');
  }
  if (raw.conclusion !== 'inconclusive' && evidenceRefs.length === 0) throw new Error('A substantive review needs at least one evidence reference');
  let supersedes;
  if (raw.supersedes !== undefined) {
    const target = prior.entries.find(row => row.id === raw.supersedes);
    if (!target || target.reviewer.type !== reviewer.type || target.reviewer.name !== reviewer.name || target.scope !== raw.scope)
      throw new Error('A revision must supersede an existing review by the same reviewer for the same scope');
    supersedes = raw.supersedes;
  }
  const entry = { id: raw.id, reviewer, reviewedAt: raw.reviewedAt, method: raw.method, scope: raw.scope,
    conclusion: raw.conclusion, ...(raw.preferredRunId ? { preferredRunId: raw.preferredRunId } : {}),
    summary: raw.summary, evidenceRefs, ...(supersedes ? { supersedes } : {}) };
  if (raw.assessments !== undefined) {
    if (!Array.isArray(raw.assessments)) throw new Error('Review assessments must be an array');
    entry.assessments = raw.assessments.map(item => {
      const run = ev.runs.find(candidate => candidate.id === item?.runId);
      if (!run || !Array.isArray(item.ratings)) throw new Error('Assessment must reference a run in the frozen subject');
      onlyKeys(item, ['runId', 'ratings', 'rubricId', 'rubricVersion', 'rubricFingerprint', 'scorePercent'], 'assessment');
      const quality = subjectQuality(subject);
      if (!object(quality?.rubric)) throw new Error('A frozen rubric definition is required for rubric assessments');
      // Only rubric fields are assessed here. The packet fingerprint separately
      // binds the entire source, including frozen command checks and conditions.
      const rubricQuality = validateAuditQuality({ schemaVersion: 1, id: quality.id, version: quality.version,
        checks: [], rubric: quality.rubric }, []);
      const rubricFingerprint = auditQualityFingerprint(rubricQuality, []);
      const checked = validateAuditReview({ schemaVersion: 1, runId: run.id, fingerprint: rubricFingerprint,
        reviewer: reviewer.name, reviewedAt: raw.reviewedAt, ratings: item.ratings.map(rating => ({
          ...rating, evidenceRefs: list(rating.evidenceRefs).map(ref => ref.startsWith(`check:${run.id}:`)
            ? `check:${ref.slice(`check:${run.id}:`.length)}` : ref),
        })),
        rubricId: quality.rubric.id, rubricVersion: quality.rubric.version },
      { run, quality: rubricQuality, checks: [] });
      const byCriterion = new Map(checked.ratings.map(rating => [rating.criterionId, rating]));
      const allScored = rubricQuality.rubric.criteria.every(criterion => byCriterion.get(criterion.id)?.score !== null);
      const totalWeight = rubricQuality.rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
      const scorePercent = allScored ? 100 * rubricQuality.rubric.criteria.reduce((sum, criterion) => sum
        + (byCriterion.get(criterion.id).score / criterion.maxScore) * criterion.weight, 0) / totalWeight : null;
      const assessment = { runId: run.id, rubricId: quality.rubric.id, rubricVersion: quality.rubric.version,
        rubricFingerprint,
        scorePercent, ratings: checked.ratings };
      if ((item.rubricId !== undefined && item.rubricId !== assessment.rubricId)
        || (item.rubricVersion !== undefined && item.rubricVersion !== assessment.rubricVersion)
        || (item.rubricFingerprint !== undefined && item.rubricFingerprint !== assessment.rubricFingerprint)
        || (item.scorePercent !== undefined && item.scorePercent !== assessment.scorePercent))
        throw new Error('Assessment rubric projection does not match the frozen rubric ratings');
      return assessment;
    });
  }
  return entry;
}

function validateSupplementalCheck(raw, packet, ev, previous) {
  onlyKeys(raw, ['id', 'runId', 'name', 'candidateFingerprint', 'recipeFingerprint', 'checkedAt', 'method', 'status', 'exitCode', 'evidenceRefs', 'attribution'], 'supplemental check');
  if (!text(raw.id, 120) || !text(raw.runId, 200) || !text(raw.name, 200)
    || !text(raw.candidateFingerprint, 200) || !text(raw.recipeFingerprint, 200)
    || !text(raw.checkedAt, 80) || !Number.isFinite(Date.parse(raw.checkedAt)) || !text(raw.method, 120)
    || !['passed', 'failed', 'unknown', 'unavailable'].includes(raw.status)
    || !Array.isArray(raw.evidenceRefs)) throw new Error('Invalid supplemental check');
  if (!ev.runIds.has(raw.runId) || !ev.candidates.get(raw.runId)?.has(raw.candidateFingerprint))
    throw new Error('Supplemental check candidate is absent from the frozen run evidence');
  const recipe = [...ev.recipes.values()].some(item => item.runId === raw.runId && item.name === raw.name && item.fingerprint === raw.recipeFingerprint);
  if (!recipe) throw new Error('Supplemental check recipe is absent from the frozen run evidence');
  if ((raw.status === 'passed' && raw.exitCode !== 0) || (raw.status === 'failed' && raw.exitCode === 0))
    throw new Error('Supplemental check status conflicts with its exit code');
  if (previous.supplementalChecks.some(item => item.id === raw.id)) throw new Error('Supplemental check ID already exists');
  onlyKeys(raw.attribution, ['type', 'name', 'model'], 'supplemental check attribution');
  if (!['human', 'agent', 'automation'].includes(raw.attribution.type) || !text(raw.attribution.name, 200)
    || (raw.attribution.model !== undefined && !text(raw.attribution.model, 200)))
    throw new Error('Supplemental check requires an attributed human, agent, or automation');
  const evidenceRefs = [...new Set(raw.evidenceRefs)];
  if (evidenceRefs.some(ref => typeof ref !== 'string' || !ev.refs.has(ref))) throw new Error('Supplemental check contains an unknown evidence reference');
  if (!evidenceRefs.length) throw new Error('Supplemental check requires evidence references');
  if (evidenceRefs.some(ref => [...(ev.refOwners.get(ref) ?? [])].some(owner => owner !== raw.runId)))
    throw new Error('Supplemental check cannot cite another run\'s evidence');
  if (raw.exitCode !== undefined && !Number.isSafeInteger(raw.exitCode)) throw new Error('Supplemental check exitCode must be an integer');
  return { id: raw.id, runId: raw.runId, name: raw.name, candidateFingerprint: raw.candidateFingerprint,
    recipeFingerprint: raw.recipeFingerprint, checkedAt: raw.checkedAt, method: raw.method, status: raw.status,
    ...(raw.exitCode === undefined ? {} : { exitCode: raw.exitCode }), evidenceRefs,
    attribution: { type: raw.attribution.type, name: raw.attribution.name,
      ...(raw.attribution.model ? { model: raw.attribution.model } : {}) } };
}

function emptyState(packet) {
  return { schemaVersion: 1, kind: 'xfx-audit-review-state', evidenceFingerprint: packet.evidenceFingerprint,
    entries: [], supplementalChecks: [] };
}

function validateReviewState(subject, state, packet, ev) {
  onlyKeys(state, ['schemaVersion', 'kind', 'evidenceFingerprint', 'entries', 'supplementalChecks'], 'review state');
  if (state.schemaVersion !== 1 || state.kind !== 'xfx-audit-review-state'
    || state.evidenceFingerprint !== packet.evidenceFingerprint || !Array.isArray(state.entries)
    || !Array.isArray(state.supplementalChecks) || state.entries.length > 160 || state.supplementalChecks.length > 640)
    throw new Error('Review state does not match frozen evidence or exceeds supported bounds');
  const validated = { entries: [], supplementalChecks: [] };
  for (const raw of state.entries) {
    const next = validateReviewEntry(raw, packet, ev, validated, subject);
    if (raw.supersedes !== undefined && validated.entries.some(item => item.supersedes === raw.supersedes))
      throw new Error('Review revision history cannot branch');
    if (raw.supersedes === undefined && validated.entries.some(item => item.reviewer.type === next.reviewer.type
      && item.reviewer.name === next.reviewer.name && item.scope === next.scope && !validated.entries.some(child => child.supersedes === item.id)))
      throw new Error('A reviewer must revise their existing review instead of creating a duplicate');
    validated.entries.push(next);
  }
  for (const raw of state.supplementalChecks) validated.supplementalChecks.push(
    validateSupplementalCheck(raw, packet, ev, validated));
  return validated;
}

/** Validate and append attributable reviews and separately recorded supplemental checks. */
export function applyAuditReviewSubmission(subject, previousState, submission) {
  const packet = validateSubmissionHeader(subject, submission);
  const { ev } = subjectInfo(subject);
  const previous = validateReviewState(subject, previousState ?? emptyState(packet), packet, ev);
  if (!Array.isArray(submission.reviews) || submission.reviews.length > 160
    || !Array.isArray(submission.supplementalChecks) || submission.supplementalChecks.length > 640)
    throw new Error('Submission review and supplemental check lists exceed supported bounds');
  const added = [];
  const staged = { entries: [...previous.entries], supplementalChecks: [...previous.supplementalChecks] };
  for (const raw of submission.reviews) {
    const entry = validateReviewEntry(raw, packet, ev, staged, subject);
    if (raw.supersedes !== undefined && staged.entries.some(item => item.supersedes === raw.supersedes))
      throw new Error('Review revision history cannot branch');
    if (raw.supersedes === undefined && staged.entries.some(item => item.reviewer.type === entry.reviewer.type
      && item.reviewer.name === entry.reviewer.name && item.scope === entry.scope
      && !staged.entries.some(child => child.supersedes === item.id)))
      throw new Error('A reviewer must revise their existing review instead of creating a duplicate');
    added.push(entry); staged.entries.push(entry);
  }
  const checks = [];
  const stagedChecks = { entries: [...staged.entries], supplementalChecks: [...previous.supplementalChecks] };
  for (const raw of submission.supplementalChecks) {
    const check = validateSupplementalCheck(raw, packet, ev, stagedChecks);
    checks.push(check); stagedChecks.supplementalChecks.push(check);
  }
  const ids = new Set(previous.entries.map(item => item.id));
  for (const entry of added) { if (ids.has(entry.id)) throw new Error('Duplicate review entry ID'); ids.add(entry.id); }
  if (previous.entries.length + added.length > 160 || previous.supplementalChecks.length + checks.length > 640)
    throw new Error('Review state exceeds supported entry bounds');
  return { schemaVersion: 1, kind: 'xfx-audit-review-state', evidenceFingerprint: packet.evidenceFingerprint,
    entries: [...previous.entries, ...added], supplementalChecks: [...previous.supplementalChecks, ...checks] };
}

/** Current projection retains every revision and reports reviewer disagreement without choosing a winner. */
export function projectAuditReviewState(subject, state) {
  const packet = buildAuditReviewPacket(subject);
  if (state == null) return { status: 'not-reviewed', evidenceFingerprint: packet.evidenceFingerprint,
    reviewModes: { human: false, ai: false }, reviews: [], supplementalChecks: [], disagreement: false };
  const { ev } = subjectInfo(subject);
  const validated = validateReviewState(subject, state, packet, ev);
  const superseded = new Set(validated.entries.map(item => item.supersedes).filter(Boolean));
  const current = validated.entries.filter(item => !superseded.has(item.id));
  const conclusions = new Map(current.map(item => [JSON.stringify([item.scope, item.conclusion, item.preferredRunId ?? null]),
    { scope: item.scope, conclusion: item.conclusion, ...(item.preferredRunId ? { preferredRunId: item.preferredRunId } : {}) }]));
  const scopes = new Map();
  for (const item of current) {
    const values = scopes.get(item.scope) ?? new Set();
    values.add(JSON.stringify([item.conclusion, item.preferredRunId ?? null])); scopes.set(item.scope, values);
  }
  const disagreement = [...scopes.values()].some(values => values.size > 1);
  const reviewModes = { human: current.some(item => item.reviewer.type === 'human'), ai: current.some(item => item.reviewer.type === 'ai') };
  return { status: current.length === 0 ? 'not-reviewed' : disagreement ? 'mixed' : 'reviewed',
    evidenceFingerprint: packet.evidenceFingerprint, reviewModes,
    reviews: validated.entries, currentReviewIds: current.map(item => item.id),
    supplementalChecks: validated.supplementalChecks, disagreement,
    ...(conclusions.size ? { conclusions: [...conclusions.values()] } : {}) };
}
