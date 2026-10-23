// Read-only cohort assembly for user-selected, already captured Codex sessions.
// Every pair is retained, including selections whose evidence is unavailable.
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readAuditReport } from './audit-store.js';
import { readAuditInput } from './audit-spec.js';
import { auditNativeSession } from './audit-session.js';
import { readAuditRecord, createAuditSeries, writeAuditState, finalizeAuditRecord } from './audit-experiment-store.js';
import { summarizeAuditSeries } from './audit-statistics.js';
import { auditSelectionOptions, buildAuditSelection } from './audit-selection.js';
import { buildAuditExplanation } from './audit-explanation.js';
import { buildAuditConsistency } from './audit-consistency.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = (value, max = 240) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const own = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new Error(`Invalid or unsupported ${label} field`);
};
const profileOf = run => run?.profile?.profileName ?? run?.profile?.name ?? run?.profileName ?? null;
const profileIdOf = run => run?.profile?.profileId ?? run?.profile?.id ?? run?.profileId ?? null;
const sourceIdOf = run => run?.source?.nativeSessionId ?? run?.source?.threadId ?? null;
function selectionIdentity(selection) {
  if (selection?.id) return { kind: 'native-session', profile: selection.profile, id: selection.id };
  if (selection?.runId) return { kind: 'stored-run', id: selection.runId };
  return { kind: 'frozen-report', id: selection?.reportId ?? null };
}

/** Validate the complete selection declaration before reading any selected evidence. */
export function validateAuditCohortSpec(value) {
  own(value, ['schemaVersion', 'kind', 'name', 'sameTask', 'variables', 'pairs'], 'cohort specification');
  if (value.schemaVersion !== 1 || value.kind !== 'audit-cohort') throw new Error('Cohort specification needs schemaVersion 1 and kind audit-cohort');
  if (value.name !== undefined && !plain(value.name, 200)) throw new Error('Cohort name must be plain text');
  const declarations = auditSelectionOptions({
    ...(value.sameTask !== undefined ? { taskAssociation: { status: 'user-declared', taskId: value.sameTask } } : {}),
    declaredVariables: value.variables ?? [],
  });
  if (!Array.isArray(value.pairs) || value.pairs.length < 1 || value.pairs.length > 80)
    throw new Error('A selected cohort must contain between one and eighty pairs');
  const selectedNative = new Set();
  const pairs = value.pairs.map((pair, index) => {
    own(pair, ['left', 'right', 'comparison'], `pair ${index + 1}`);
    const comparison = pair.comparison;
    const hasSides = pair.left !== undefined || pair.right !== undefined;
    if ((comparison !== undefined) === hasSides) throw new Error(`Pair ${index + 1} must select two sides or one comparison report`);
    if (comparison !== undefined) {
      if (!plain(comparison, 4096)) throw new Error(`Pair ${index + 1} comparison must be a report path`);
      return { comparison };
    }
    for (const side of ['left', 'right']) {
      const selected = pair[side];
      own(selected, ['profile', 'id', 'runId', 'report'], `pair ${index + 1} ${side}`);
      const mode = ['id', 'runId', 'report'].filter(key => selected[key] !== undefined);
      if (mode.length !== 1 || (mode[0] === 'id' && (!plain(selected.profile, 200) || !UUID.test(selected.id ?? '')))
        || (mode[0] !== 'id' && selected.profile !== undefined)
        || (mode[0] === 'runId' && !UUID.test(selected.runId ?? ''))
        || (mode[0] === 'report' && !plain(selected.report, 4096)))
        throw new Error(`Pair ${index + 1} ${side} must select profile+session id, stored runId, or frozen report path`);
      if (mode[0] === 'id') {
        const key = `${selected.profile}\0${selected.id.toLowerCase()}`;
        if (selectedNative.has(key)) throw new Error('A native profile/session selection may appear only once in a cohort');
        selectedNative.add(key);
      }
    }
    return { left: { ...pair.left }, right: { ...pair.right } };
  });
  return { schemaVersion: 1, kind: 'audit-cohort', ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.sameTask !== undefined ? { sameTask: declarations.taskAssociation.taskId } : {}), variables: declarations.declaredVariables, pairs };
}

function emptyRun(selection, profileName, status, reason) {
  const id = selection.id ?? selection.runId ?? null;
  return { schemaVersion: 1, kind: 'audit-run', id: null, status, reason,
    profile: { profileName: profileName ?? selection.profile ?? null },
    source: selection.id ? { kind: 'native-rollout', nativeSessionId: selection.id } : {},
    agents: [], turns: [], events: [], actions: [], skills: [], artifacts: [], checks: [],
    usage: { totals: null }, metrics: {}, outcome: { status: 'unverified' },
    coverage: { source: status }, warnings: [], requestedIdentity: selectionIdentity(selection) };
}

function isRun(report) { return report?.kind === 'audit-run'; }
function isComparison(report) { return report?.kind === 'audit-comparison'; }
function unwrapEvaluation(report) {
  if (report?.kind !== 'audit-evaluation-report') return { report, review: null };
  return { report: report.subject ?? report.series ?? null,
    review: report.reviewState ?? report.reviewHistory ?? report.legacyReviews ?? null };
}

async function loadSelection(store, selected, context, specDirectory) {
  if (selected.id) {
    try {
      const report = await (context.readNative ?? auditNativeSession)(store, selected.profile, selected.id, context);
      // auditNativeSession resolves the requested profile exactly. Its unavailable
      // result retains that requested profile/session identity and is not retried.
      return { report, selection: { kind: 'native-session', profile: selected.profile, id: selected.id } };
    } catch {
      return { report: emptyRun(selected, selected.profile, 'unavailable', 'The selected native session could not be read safely.'),
        selection: { kind: 'native-session', profile: selected.profile, id: selected.id } };
    }
  }
  if (selected.runId) {
    try {
      const current = await readAuditRecord(store, selected.runId);
      if (!current.finalized) return { report: emptyRun(selected, current.record.profile?.profileName, 'unavailable', 'The selected stored run is not finalized.'), selection: { kind: 'stored-run', id: selected.runId } };
      const reviewEvaluation = current.record.kind === 'audit-evaluation' ? current.report : null;
      let report = await (await import('./audit-experiment.js')).showAuditRecord(store, selected.runId);
      if (report?.kind === 'audit-evaluation-report') report = unwrapEvaluation(report).report;
      return { report: isRun(report) ? report : emptyRun(selected, current.record.profile?.profileName, 'unavailable', 'The selected record does not contain one finalized run.'),
        ...(reviewEvaluation ? { reviewEvaluation } : {}),
        selection: { kind: 'stored-run', id: selected.runId } };
    } catch {
      return { report: emptyRun(selected, null, 'not-found', 'The selected stored run was not found.'), selection: { kind: 'stored-run', id: selected.runId } };
    }
  }
  const path = isAbsolute(selected.report) ? selected.report : resolve(specDirectory, selected.report);
  try {
    const frozen = await readAuditReport(path), unwrapped = unwrapEvaluation(frozen);
    const report = unwrapped.report;
    if (isRun(report)) return { report, reviewEvaluation: frozen.kind === 'audit-evaluation-report' ? frozen : null,
      selection: { kind: 'frozen-run', path, id: report.id ?? null } };
    return { report: emptyRun(selected, profileOf(report?.left) ?? null, 'unavailable', 'The frozen report does not contain a single run.'),
      selection: { kind: 'frozen-run', path, id: report?.id ?? null } };
  } catch {
    return { report: emptyRun(selected, null, 'unavailable', 'The selected frozen report could not be read safely.'),
      selection: { kind: 'frozen-run', reportId: null } };
  }
}

function comparisonSides(report) {
  const unwrapped = unwrapEvaluation(report).report;
  if (!isComparison(unwrapped)) return null;
  return { left: unwrapped.left, right: unwrapped.right, comparison: unwrapped };
}

function evidenceSlot(pair, index, reports, declared, armNames) {
  let left, right, sourceComparison = null;
  if (pair.comparison !== undefined) {
    const sides = comparisonSides(reports[0]?.report);
    if (sides) { ({ left, right, comparison: sourceComparison } = sides); }
    else {
      left = emptyRun({ report: pair.comparison }, null, 'unavailable', 'The selected report is not a comparison.');
      right = emptyRun({ report: pair.comparison }, null, 'unavailable', 'The selected report is not a comparison.');
    }
  } else { left = reports[0]?.report; right = reports[1]?.report; }
  const leftName = profileOf(left), rightName = profileOf(right);
  const runs = [left, right];
  const reviewEvaluations = pair.comparison !== undefined
    ? (reports[0]?.reviewEvaluation ? [{ side: 'comparison', report: reports[0].reviewEvaluation }] : [])
    : [reports[0]?.reviewEvaluation ? { side: 'left', report: reports[0].reviewEvaluation } : null,
      reports[1]?.reviewEvaluation ? { side: 'right', report: reports[1].reviewEvaluation } : null].filter(Boolean);
  const priorDeclaration = sourceComparison?.selection?.declaration;
  const priorVariables = sourceComparison?.selection?.declaredVariables;
  const taskAssociation = declared.sameTask ? { status: 'user-declared', taskId: declared.sameTask } : priorDeclaration;
  const declaredVariables = declared.variables.length ? declared.variables : priorVariables ?? [];
  const association = buildAuditExplanation(left, right, {
    ...(taskAssociation ? { taskAssociation } : {}), declaredVariables,
  }).conditions.taskAssociation;
  const selection = buildAuditSelection(left, right, {
    ...(taskAssociation ? { taskAssociation } : {}), declaredVariables,
  }, association);
  selection.requested = pair.comparison !== undefined
    ? { comparison: { id: reports[0]?.report?.id ?? null, kind: reports[0]?.report?.kind ?? 'unavailable' } }
    : { left: selectionIdentity(pair.left), right: selectionIdentity(pair.right) };
  const unavailable = [left, right].some(run => !run || ['unavailable', 'not-found', 'unknown'].includes(run.status));
  const failed = [left, right].some(run => run && (run.status === 'failed'
    || ['failed', 'error', 'aborted', 'timeout', 'cancelled', 'output-limit'].includes(run.execution?.status)));
  return { index: index + 1, trialIndex: index, status: unavailable ? 'partial' : failed ? 'failed' : 'complete',
    profileOrder: [leftName ?? armNames.left, rightName ?? armNames.right], runs: runs.filter(Boolean), failures: [], warnings: [],
    selection,
    ...(reviewEvaluations.length ? { reviewEvaluations } : {}),
  };
}

function retainMissingProfiles(trial, slot, arms) {
  const profiles = [...(trial.profiles ?? [])];
  for (const side of ['left', 'right']) {
    const run = slot.runs[side === 'left' ? 0 : 1];
    if (!run || !['unavailable', 'not-found', 'unknown', 'partial', 'failed'].includes(run.status)) continue;
    const arm = arms[side];
    const row = profiles.find(candidate => candidate.profileId && arm.profileId
      ? candidate.profileId === arm.profileId
      : candidate.profileName === arm.profileName && candidate.run == null);
    if (row?.run) continue;
    const status = ['unavailable', 'not-found', 'failed', 'partial'].includes(run.status) ? run.status : 'partial';
    const reason = typeof run.reason === 'string' && run.reason.trim()
      ? run.reason.trim().slice(0, 300) : 'Selected evidence is unavailable.';
    if (row) Object.assign(row, { status, reason, run: null });
    else profiles.push({ profileName: arm.profileName, profileId: arm.profileId ?? null, status, reason, run: null });
  }
  return profiles;
}

/** Assemble selected existing sessions into the immutable shared series report shape. */
export async function createAuditCohort(store, specPath, context = {}) {
  if (typeof specPath !== 'string' || !specPath.trim()) throw new Error('audit cohort requires --spec FILE');
  const input = await (context.readInput ?? readAuditInput)(specPath);
  const spec = validateAuditCohortSpec(input);
  const specDirectory = dirname(resolve(specPath));
  // All schema, cardinality and direct-session duplicate checks complete before reads.
  const loaded = [];
  for (let start = 0; start < spec.pairs.length; start += 4) {
    const group = await Promise.all(spec.pairs.slice(start, start + 4).map(async pair => {
      if (pair.comparison !== undefined) {
        const path = isAbsolute(pair.comparison) ? pair.comparison : resolve(specDirectory, pair.comparison);
        try {
          const report = await readAuditReport(path);
          return [{ report, reviewEvaluation: report.kind === 'audit-evaluation-report' ? report : null,
            selection: { kind: 'comparison-report', reportId: report.id ?? null } }];
        } catch { return [{ report: null, selection: { kind: 'comparison-report', reportId: null } }]; }
      }
      return Promise.all([loadSelection(store, pair.left, context, specDirectory), loadSelection(store, pair.right, context, specDirectory)]);
    }));
    loaded.push(...group);
  }
  // A comparison/evaluation can bind to a session already selected in another
  // pair. Reject duplicate underlying profile+session identities after exact reads.
  const identities = new Set();
  for (let i = 0; i < loaded.length; i++) {
    const pair = spec.pairs[i];
    const sides = pair.comparison !== undefined ? comparisonSides(loaded[i][0]?.report) : loaded[i];
    for (let side = 0; side < 2; side++) {
      const run = sides?.[side === 0 ? 'left' : 'right'] ?? sides?.[side]?.report;
      const session = sourceIdOf(run);
      const keys = [];
      if (session) {
        const owner = profileIdOf(run) ?? profileOf(run);
        if (owner) keys.push(`session\0${owner}\0${session}`);
      }
      if (run?.id) keys.push(`run\0${run.id}`);
      if (!keys.length) continue;
      if (keys.some(key => identities.has(key))) throw new Error('The same underlying profile/session may not be selected more than once');
      for (const key of keys) identities.add(key);
    }
  }
  const selectedSides = (pair, i) => pair.comparison !== undefined ? comparisonSides(loaded[i][0]?.report)
    : { left: loaded[i][0]?.report, right: loaded[i][1]?.report };
  const firstIdentityRun = side => {
    const candidates = spec.pairs.map((pair, i) => selectedSides(pair, i)?.[side]).filter(Boolean);
    return candidates.find(run => profileIdOf(run)) ?? candidates.find(run => profileOf(run));
  };
  const firstLeftRun = firstIdentityRun('left');
  const firstRightRun = firstIdentityRun('right');
  const armIdentities = { left: { profileId: profileIdOf(firstLeftRun), profileName: profileOf(firstLeftRun) },
    right: { profileId: profileIdOf(firstRightRun), profileName: profileOf(firstRightRun) } };
  const armIds = { left: armIdentities.left.profileId ?? armIdentities.left.profileName ?? 'unknown-left',
    right: armIdentities.right.profileId ?? armIdentities.right.profileName ?? 'unknown-right' };
  if (armIds.left === armIds.right) throw new Error('A cohort needs two distinct stable profile arm identities');
  const armNames = { left: armIdentities.left.profileName ?? 'left', right: armIdentities.right.profileName ?? 'right' };
  const slots = spec.pairs.map((pair, i) => {
    const reports = loaded[i];
    const sides = selectedSides(pair, i);
    const slot = evidenceSlot(pair, i, reports, spec, armNames);
    const matches = (run, side) => {
      if (!run) return true;
      const expected = armIdentities[side];
      const id = profileIdOf(run), name = profileOf(run);
      if (expected.profileId && id) return id === expected.profileId;
      if (expected.profileId && ['unavailable', 'not-found', 'unknown', 'partial'].includes(run.status)) return true;
      return expected.profileName && name ? name === expected.profileName : true;
    };
    if (!matches(sides?.left, 'left') || !matches(sides?.right, 'right'))
      throw new Error(`Pair ${i + 1} does not match the cohort's stable left/right arm identities`);
    return slot;
  });
  const profiles = [{ profileName: armNames.left, profileId: armIdentities.left.profileId },
    { profileName: armNames.right, profileId: armIdentities.right.profileId }];
  const plan = slots.map(slot => ({ index: slot.index, trialIndex: slot.trialIndex, experimentId: randomUUID(),
    // Preserve identity here: profile names are user-facing labels and need not
    // be unique (for example, two independent homes can both be named Default).
    profileOrder: [
      { profileId: armIdentities.left.profileId, profileName: armNames.left },
      { profileId: armIdentities.right.profileId, profileName: armNames.right },
    ], budgetMs: null }));
  const trials = slots.map((slot, index) => ({ ...slot, index: index + 1, experimentId: plan[index].experimentId }));
  const report = summarizeAuditSeries({ id: null, baseline: null, profiles, plan, spec: {}, recipe: {}, trials });
  const selectedReport = { ...report, cohort: { schemaVersion: 1, source: 'selected-existing-sessions',
    selectedPairCount: slots.length, plannedPairCount: null,
    sameTask: spec.sameTask ? { status: 'user-declared', taskId: spec.sameTask } : { status: 'unknown' },
    variables: spec.variables, arms: [
      { id: armIds.left, profileId: armIdentities.left.profileId, profileName: armNames.left },
      { id: armIds.right, profileId: armIdentities.right.profileId, profileName: armNames.right },
    ] },
    trials: report.trials.map((trial, i) => ({ ...trial,
      profiles: retainMissingProfiles(trial, slots[i], armIdentities), selection: slots[i].selection,
      ...(slots[i].reviewEvaluations ? { reviewEvaluations: slots[i].reviewEvaluations } : {}) })),
    plan: plan.map((slot, i) => ({ ...slot, selection: slots[i].selection })),
    warnings: [...report.warnings, 'Selected-session corpus; the total number of possible or planned pairs is unknown.'],
    status: slots.some(slot => slot.status === 'failed') ? 'failed'
      : slots.some(slot => slot.status === 'partial') ? 'partial' : report.status,
    exitCode: slots.some(slot => slot.status === 'failed') ? 4
      : slots.some(slot => slot.status === 'partial') ? 2 : report.exitCode };
  selectedReport.consistency = buildAuditConsistency(selectedReport);
  const storedSpec = { schemaVersion: 1, kind: 'audit-cohort', ...(spec.name ? { name: spec.name } : {}),
    ...(spec.sameTask ? { sameTask: spec.sameTask } : {}), variables: spec.variables,
    pairs: slots.map(slot => slot.selection.requested) };
  const persisted = await createAuditSeries(store, { spec: storedSpec, baseline: null, profiles, plan, recipe: { meta: { source: 'selected-existing-sessions' } } });
  await writeAuditState(store, persisted.id, { status: 'complete', trials: trials.map((trial, index) => ({
    experimentId: plan[index].experimentId, trialIndex: index, status: trial.status })) });
  return await finalizeAuditRecord(store, persisted.id, selectedReport);
}
