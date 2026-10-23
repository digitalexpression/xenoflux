// Read-only projection of retained observations. Final execution records are
// never rewritten, and a missing native source never turns into an absence.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { readAuditRecord } from './audit-experiment-store.js';
import { auditRetainedNativeSession } from './audit-session.js';
import { buildAuditComparisonConditions } from './audit-conditions.js';
import { evaluateAuditQuality } from './audit-quality.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const list = value => Array.isArray(value) ? value : [];

async function retainedContext(store, current, read) {
  const parent = await read(store, current.record.experimentId);
  const saved = current.record.profile;
  const baseline = parent.record.baseline?.repository;
  if (parent.record.kind !== 'audit-experiment'
    || !parent.state.runs?.some(row => row.id === current.id && row.profileId === saved.profileId)
    || !baseline || ['repository', 'commit', 'tree'].some(key => baseline[key] !== current.record.baseline?.[key])) throw Error('parent-binding');
  let spec = { ...parent.record.spec, task: parent.record.task }, order = spec.profiles.map(row => row.name), recipe;
  let trialIndex = null, environment = current.report.comparisonConditions?.environment;
  if (parent.record.series) {
    const series = await read(store, parent.record.series.id);
    const slot = series.record.plan?.find(row => row.experimentId === parent.id
      && row.trialIndex === parent.record.series.trialIndex);
    if (series.record.kind !== 'audit-series' || !slot
      || ['repository', 'commit', 'tree'].some(key => series.record.baseline[key] !== baseline[key])) throw Error('series-binding');
    const { quality, variables, trials, ...trial } = series.record.spec;
    const expected = { ...trial, revision: series.record.baseline.commit,
      profiles: slot.profileOrder.map(name => trial.profiles.find(row => row.name === name)),
      limits: { ...trial.limits, runMs: Math.min(trial.limits.runMs, slot.budgetMs), experimentMs: slot.budgetMs } };
    if (!isDeepStrictEqual(expected, { ...parent.record.spec, task: parent.record.task })) throw Error('recipe-binding');
    spec = series.record.spec; order = slot.profileOrder; recipe = series.record.recipe;
    trialIndex = slot.trialIndex;
    environment = series.state.trials?.find(row => row.experimentId === parent.id)?.environment;
  }
  const selection = spec.profiles.find(row => row.name === saved.profileName);
  if (!selection || selection.executable !== saved.executable
    || !isDeepStrictEqual(selection.nativeConfig, saved.nativeConfig)) throw Error('profile-binding');
  const joined = buildAuditComparisonConditions({ spec: { ...spec, task: parent.record.task }, recipe,
    baseline, profile: selection, profileOrder: order, trialIndex, environment });
  const previous = current.report.comparisonConditions;
  if (previous) {
    // These fields describe the actual run, not optional series-level context.
    for (const key of ['taskFingerprint', 'taskId', 'editableFiles', 'checkRecipes', 'setupFingerprint',
      'selectedSkills', 'profileOrder', 'trialIndex', 'environment', 'baseline']) {
      if (previous[key] !== undefined && !isDeepStrictEqual(previous[key], joined[key])) throw Error('condition-binding');
    }
    for (const key of ['qualityFingerprint', 'recipeFingerprint']) if (previous[key] != null
      && previous[key] !== joined[key]) throw Error('condition-binding');
    if (previous.variables?.length && !isDeepStrictEqual(previous.variables, joined.variables)) throw Error('condition-binding');
  }
  return { spec, recipe, baseline, profile: selection,
    profileOrder: order, trialIndex, environment };
}

/** Re-read only the exact saved profile/session and join positively owned turns.
 * Tests may supply read/source adapters; the production path is filesystem-only.
 */
export async function projectRetainedAuditRun(store, current, { read = readAuditRecord,
  readNative = auditRetainedNativeSession } = {}) {
  const original = current.report;
  if (current.record.kind !== 'audit-experiment-run' || !original
    || original.source?.kind !== 'native-app-server-v2' || !UUID.test(original.source.threadId ?? '')) return original;
  const projection = { schemaVersion: 1, mode: 'retained-evidence-read-only',
    originalReportFingerprint: digest(original), native: 'unavailable', context: 'unavailable',
    sourceAttestation: 'read-time-retained-snapshot' };
  let context;
  try { context = await retainedContext(store, current, read); projection.context = 'verified'; }
  catch { return { ...original, reportProjection: projection }; }
  const saved = current.record.profile, rootId = original.source.threadId;
  if (saved.profileId !== original.profile?.profileId || saved.profileName !== original.profile?.profileName
    || saved.home !== original.profile?.home
    || !original.agents?.some(row => row.id === rootId && row.parentId == null))
    return { ...original, reportProjection: { ...projection, context: 'binding-mismatch' } };
  // A new projection has a new support fingerprint. The frozen original's core
  // remains in its original file; it is never relabeled in place.
  const { comparisonEvidence, ...base } = original;
  let run = { ...base, reportProjection: projection,
    comparisonConditions: buildAuditComparisonConditions(context) };
  const configured = saved.nativeConfig ?? {};
  run.nativeControls = { schemaVersion: 1,
    configured: { model: configured.model ?? null, modelReasoningEffort: configured.model_reasoning_effort ?? null,
      planModeReasoningEffort: configured.plan_mode_reasoning_effort ?? null, loginMethod: configured.forced_login_method ?? null },
    startup: { agentId: rootId, model: original.source.model ?? null,
      reasoningEffort: original.source.reasoningEffort ?? null, source: 'thread/start' }, turns: [] };
  let native;
  try { native = await readNative(saved, rootId, { actionRepoRoot: original.source.workspace ?? join(current.directory, 'workspace') }); }
  catch { /* Missing/unsafe retained sources remain explicitly unavailable. */ }
  const sameSource = native?.source?.nativeSessionId === rootId
    && native.source.clientVersion === original.source.version
    && /^[a-f0-9]{64}$/.test(native.source.fingerprint ?? '')
    && ['ready', 'partial'].includes(native.status);
  if (sameSource) {
    projection.native = native.status;
    projection.nativeSourceFingerprint = native.source.fingerprint;
    const originalTurns = list(original.turns), seen = new Set(), duplicateTurns = new Set();
    for (const row of list(native.turns)) {
      const key = `${row.agentId}:${row.turnId}`;
      if (seen.has(key)) duplicateTurns.add(key);
      seen.add(key);
    }
    if (duplicateTurns.size) projection.native = 'partial';
    const contexts = list(native.turns).filter(row => {
      const key = `${row.agentId}:${row.turnId}`;
      if (duplicateTurns.has(key) || row.workspaceMatched !== true || row.agentId !== rootId || !originalTurns.some(turn => turn.agentId === row.agentId
        && turn.turnId === row.turnId)) return false;
      return true;
    });
    const conflicts = new Set();
    run.turns = originalTurns.map(turn => {
      const proof = contexts.find(row => row.agentId === turn.agentId && row.turnId === turn.turnId);
      // An observed mismatch is retained, never masked by startup/configuration.
      const conflict = proof && ((turn.model != null && turn.model !== proof.model)
        || (turn.reasoningEffort != null && turn.reasoningEffort !== proof.reasoningEffort));
      if (conflict) {
        projection.native = 'conflicting-turn-controls';
        conflicts.add(`${turn.agentId}:${turn.turnId}`);
        return { ...turn, model: null, reasoningEffort: null };
      }
      return proof ? { ...turn, model: proof.model, reasoningEffort: proof.reasoningEffort } : turn;
    });
    run.nativeControls.turns = contexts.filter(row => !conflicts.has(`${row.agentId}:${row.turnId}`)).map(row => ({ agentId: row.agentId, turnId: row.turnId,
      model: row.model, reasoningEffort: row.reasoningEffort, source: 'turn_context',
      sourceLine: row.sourceLine, sourceFingerprint: native.source.fingerprint, workspaceMatched: true }));
    run.actions = list(native.actions).filter(row => row.agentId === rootId
      && contexts.some(turn => turn.turnId === row.turnId)
      && !conflicts.has(`${row.agentId}:${row.turnId}`)
      && row.sourceFingerprint === native.source.fingerprint);
    run.actionCoverage = native.actionCoverage ?? 'partial';
  } else projection.native = native?.status ?? 'unavailable';
  // Capture retained file actions before the runner replaced its artifact list
  // with workspace snapshots. These keep their original RPC source references.
  const checkpoint = current.captureCheckpoint;
  if (checkpoint?.threadId === rootId && checkpoint.profileHome === saved.home
    && checkpoint.run?.source?.threadId === rootId) {
    const additions = list(checkpoint.run.artifacts).filter(row => row.kind === 'recorded-file-change'
      && original.agents.some(agent => agent.id === row.agentId)
      && original.turns.some(turn => turn.agentId === row.agentId && turn.turnId === row.turnId));
    run.artifacts = [...list(original.artifacts), ...additions];
  }
  if (context.spec.quality) run.quality = evaluateAuditQuality(run, context.spec.quality,
    { checks: context.spec.checks, review: original.quality?.review ?? null });
  return run;
}
