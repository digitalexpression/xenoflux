// Read-only projection of retained observations. Final execution records are
// never rewritten, and a missing native source never turns into an absence.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { readAuditRecord } from './audit-experiment-store.js';
import { auditRetainedNativeSession } from './audit-session.js';
import { buildAuditComparisonConditions } from './audit-conditions.js';
import { evaluateAuditQuality } from './audit-quality.js';
import { retainedNativeReference } from './capture-projection.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const list = value => Array.isArray(value) ? value : [];

function unavailableReplay(id, reason) {
  return { schemaVersion: 1, kind: 'session-replay', sessions: [{ id, parentId: null, depth: 0,
    status: 'unavailable', reason, source: { fingerprint: null }, events: [], limits: [{ kind: 'source-unavailable', message: reason }] }] };
}

function withCheckpointArtifacts(run, original, current, saved, rootId) {
  const checkpoint = current.captureCheckpoint;
  if (checkpoint?.threadId === rootId && checkpoint.profileHome === saved.home
    && checkpoint.run?.source?.threadId === rootId) {
    const additions = list(checkpoint.run.artifacts).filter(row => row.kind === 'recorded-file-change'
      && original.agents.some(agent => agent.id === row.agentId)
      && original.turns.some(turn => turn.agentId === row.agentId && turn.turnId === row.turnId));
    run.artifacts = [...list(original.artifacts), ...additions];
  }
  return run;
}

export function joinRetainedNativeTurnEvidence(run, native, saved, { expectedSourceFingerprint } = {}) {
  const rootId = retainedNativeReference(run, saved, run.id, run.source?.threadId)?.sessionId;
  const fingerprint = native?.source?.fingerprint;
  if (!rootId || native?.source?.nativeSessionId !== rootId || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')
    || expectedSourceFingerprint !== undefined && fingerprint !== expectedSourceFingerprint
    || !['ready', 'partial'].includes(native?.status)) return { status: 'source-binding-mismatch', fields: {}, contexts: [] };
  const actors = new Map(list(run.agents).map(actor => [actor.id, actor]));
  const nativeActors = new Map(list(native.agents).map(actor => [actor.id, actor]));
  const actorCount = (rows, id) => rows.filter(actor => actor.id === id).length;
  const replaySources = native.sessionReplay ? new Map(list(native.sessionReplay.sessions)
    .map(session => [session.id, session.source?.fingerprint])) : null;
  const sourceFor = agentId => {
    const seen = new Set();
    let id = agentId;
    while (id !== rootId) {
      const actor = actors.get(id), proof = nativeActors.get(id);
      if (!actor || !proof || seen.has(id) || actor.parentId !== proof.parentId
        || actorCount(run.agents, id) !== 1 || actorCount(native.agents, id) !== 1
        || !['ready', 'partial'].includes(proof.status) || !/^[a-f0-9]{64}$/.test(proof.source?.fingerprint ?? '')) return null;
      if (replaySources && replaySources.get(id) !== proof.source.fingerprint) return null;
      seen.add(id); id = actor.parentId;
    }
    if (!actors.has(rootId) || actors.get(rootId).parentId != null || actorCount(run.agents, rootId) !== 1
      || actorCount(list(native.agents), rootId) > 1) return null;
    return agentId === rootId ? fingerprint : nativeActors.get(agentId).source.fingerprint;
  };
  const key = turn => `${turn.agentId}:${turn.turnId}`;
  const originalTurns = list(run.turns), counts = new Map(), originalCounts = new Map();
  for (const row of list(native.turns)) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  for (const row of originalTurns) originalCounts.set(key(row), (originalCounts.get(key(row)) ?? 0) + 1);
  let status = [...counts.values()].some(count => count > 1) ? 'partial' : native.status;
  const contexts = list(native.turns).filter(row => counts.get(key(row)) === 1 && originalCounts.get(key(row)) === 1
    && row.workspaceMatched === true && sourceFor(row.agentId));
  const conflicts = new Set();
  const turns = originalTurns.map(turn => {
    const proof = contexts.find(row => key(row) === key(turn));
    if (!proof) return turn;
    if (turn.model != null && proof.model != null && turn.model !== proof.model
      || turn.reasoningEffort != null && proof.reasoningEffort != null && turn.reasoningEffort !== proof.reasoningEffort) {
      status = 'conflicting-turn-controls'; conflicts.add(key(turn));
      return { ...turn, model: null, reasoningEffort: null };
    }
    return { ...turn, ...(proof.model != null ? { model: proof.model } : {}),
      ...(proof.reasoningEffort != null ? { reasoningEffort: proof.reasoningEffort } : {}),
      ...(proof.sourceLine != null ? { sourceLine: proof.sourceLine } : {}),
      ...(proof.recordedAt != null ? { recordedAt: proof.recordedAt } : {}),
      ...(turn.status == null && proof.status != null ? { status: proof.status } : {}) };
  });
  const qualified = contexts.filter(row => !conflicts.has(key(row))).map(row => ({ ...row,
    sourceFingerprint: sourceFor(row.agentId) }));
  const configured = saved?.nativeConfig ?? {};
  const nativeControls = { schemaVersion: 1,
    configured: run.nativeControls?.configured ?? { model: configured.model ?? null,
      modelReasoningEffort: configured.model_reasoning_effort ?? null,
      planModeReasoningEffort: configured.plan_mode_reasoning_effort ?? null, loginMethod: configured.forced_login_method ?? null },
    startup: run.nativeControls?.startup ?? { agentId: rootId, model: run.source?.model ?? null,
      reasoningEffort: run.source?.reasoningEffort ?? null, source: 'thread/start' },
    turns: qualified.filter(row => {
      const turn = turns.find(turn => key(row) === key(turn));
      return (turn.model ?? null) === (row.model ?? null) && (turn.reasoningEffort ?? null) === (row.reasoningEffort ?? null);
    }).map(row => ({ agentId: row.agentId, turnId: row.turnId, model: row.model ?? null,
      reasoningEffort: row.reasoningEffort ?? null, source: 'turn_context', sourceLine: row.sourceLine,
      sourceFingerprint: row.sourceFingerprint, workspaceMatched: true })) };
  return { status, sourceFingerprint: fingerprint, fields: { turns, nativeControls }, contexts: qualified };
}

async function retainedContext(store, current, read) {
  const parent = await read(store, current.record.experimentId);
  const saved = current.record.profile;
  const baseline = parent.record.baseline?.repository;
  if (parent.record.kind !== 'audit-experiment'
    || !parent.state.runs?.some(row => row.id === current.id && row.profileId === saved.profileId)
    || !baseline || ['repository', 'commit', 'tree'].some(key => baseline[key] !== current.record.baseline?.[key])) throw Error('parent-binding');
  let spec = { ...parent.record.spec, task: parent.record.task }, order = spec.profiles.map(row => row.sideId ?? row.name), recipe;
  let trialIndex = null, environment = current.report.comparisonConditions?.environment;
  if (parent.record.series) {
    const series = await read(store, parent.record.series.id);
    const slot = series.record.plan?.find(row => row.experimentId === parent.id
      && row.trialIndex === parent.record.series.trialIndex);
    if (series.record.kind !== 'audit-series' || !slot
      || ['repository', 'commit', 'tree'].some(key => series.record.baseline[key] !== baseline[key])) throw Error('series-binding');
    const { quality, variables, trials, ...trial } = series.record.spec;
    const expected = { ...trial, revision: series.record.baseline.commit,
      profiles: slot.profileOrder.map(name => trial.profiles.find(row => (row.sideId ?? row.name) === name)),
      limits: { ...trial.limits, runMs: trial.limits.runMs === null ? null : Math.min(trial.limits.runMs, slot.budgetMs), experimentMs: slot.budgetMs } };
    if (!isDeepStrictEqual(expected, { ...parent.record.spec, task: parent.record.task })) throw Error('recipe-binding');
    spec = series.record.spec; order = slot.profileOrder; recipe = series.record.recipe;
    trialIndex = slot.trialIndex;
    environment = series.state.trials?.find(row => row.experimentId === parent.id)?.environment;
  }
  const selection = spec.profiles.find(row => saved.sideId ? row.sideId === saved.sideId : row.name === saved.profileName);
  if (!selection || (selection.executable !== undefined && selection.executable !== saved.executable)
    || (selection.executable === undefined && (!saved.executable || current.report.profile?.executable !== saved.executable))
    || !isDeepStrictEqual(selection.execution, saved.execution)
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
  readNative = auditRetainedNativeSession, includeReplay = false } = {}) {
  const original = current.report;
  const reference = retainedNativeReference(original, current.record.profile, current.id ?? original?.id, original?.source?.threadId);
  if (current.record.kind !== 'audit-experiment-run' || !original
    || reference?.client !== 'codex' || !UUID.test(reference.sessionId ?? '')
    || original.source?.kind !== 'native-app-server-v2') return original;
  const projection = { schemaVersion: 1, mode: 'retained-evidence-read-only',
    originalReportFingerprint: digest(original), native: 'unavailable', context: 'unavailable',
    sourceAttestation: 'read-time-retained-snapshot' };
  const withoutRead = context => ({ ...original, reportProjection: { ...projection, context,
    sourceAttestation: original.reportProjection?.sourceAttestation ?? 'unknown' } });
  let context;
  try { context = await retainedContext(store, current, read); projection.context = 'verified'; }
  catch { return withoutRead('unavailable'); }
  const saved = current.record.profile, rootId = reference.sessionId;
  if (saved.profileId !== original.profile?.profileId || saved.profileName !== original.profile?.profileName
    || saved.home !== original.profile?.home
    || !original.agents?.some(row => row.id === rootId && row.parentId == null))
    return withoutRead('binding-mismatch');
  // Finalized captures define one immutable evidence boundary. Once recipe and
  // profile bindings are verified, reopening must not refresh any part of that
  // report from a native source that may have grown, changed, or disappeared.
  if (original.sessionReplay && original.replayCapture?.boundary === 'finalized-native-history-snapshot') {
    const { comparisonEvidence, ...captured } = original;
    let frozen = { ...captured, reportProjection: { ...projection, native: 'frozen',
      sourceAttestation: 'finalized-native-history-snapshot' },
    comparisonConditions: buildAuditComparisonConditions(context) };
    if (!includeReplay) delete frozen.sessionReplay;
    frozen = withCheckpointArtifacts(frozen, original, current, saved, rootId);
    if (!Object.hasOwn(original, 'quality') && context.spec.quality) frozen.quality = evaluateAuditQuality(frozen, context.spec.quality,
      { checks: context.spec.checks, review: null });
    return frozen;
  }
  // A new projection has a new support fingerprint. The frozen original's core
  // remains in its original file; it is never relabeled in place.
  const { comparisonEvidence, ...base } = original;
  let run = { ...base, reportProjection: projection,
    comparisonConditions: buildAuditComparisonConditions(context) };
  // A completed run's saved replay is the capture boundary. Other retained
  // evidence may still be enriched from native history, but replay never grows
  // when the report is reopened after that snapshot.
  if (includeReplay && original.sessionReplay) run.sessionReplay = structuredClone(original.sessionReplay);
  const configured = saved.nativeConfig ?? {};
  run.nativeControls = { schemaVersion: 1,
    configured: { model: configured.model ?? null, modelReasoningEffort: configured.model_reasoning_effort ?? null,
      planModeReasoningEffort: configured.plan_mode_reasoning_effort ?? null, loginMethod: configured.forced_login_method ?? null },
    startup: { agentId: rootId, model: original.source.model ?? null,
      reasoningEffort: original.source.reasoningEffort ?? null, source: 'thread/start' }, turns: [] };
  let native;
  try { native = await readNative(saved, rootId, { actionRepoRoot: original.source.workspace ?? join(current.directory, 'workspace'), includeReplay,
    ...(includeReplay && Array.isArray(original.agents) ? { recordedAgents: original.agents } : {}),
    ...(includeReplay ? { childIndexHome: join(current.directory, 'runtime', 'sqlite') } : {}) }); }
  catch { /* Missing/unsafe retained sources remain explicitly unavailable. */ }
  const sameSource = native?.source?.nativeSessionId === rootId
    && /^[a-f0-9]{64}$/.test(native.source.fingerprint ?? '')
    && (original.source.fingerprint == null || original.source.fingerprint === native.source.fingerprint)
    && ['ready', 'partial'].includes(native.status);
  if (sameSource) {
    const joined = joinRetainedNativeTurnEvidence(run, native, saved,
      { expectedSourceFingerprint: original.source.fingerprint ?? undefined });
    projection.native = joined.status;
    projection.nativeSourceFingerprint = native.source.fingerprint;
    Object.assign(run, joined.fields);
    run.actions = list(native.actions).filter(row => joined.contexts.some(turn => turn.agentId === row.agentId
      && turn.turnId === row.turnId && row.sourceFingerprint === turn.sourceFingerprint));
    run.actionCoverage = native.actionCoverage ?? 'partial';
  } else {
    projection.native = native?.status ?? 'unavailable';
  }
  if (includeReplay && !original.sessionReplay)
    run.sessionReplay = unavailableReplay(rootId, 'This report has no frozen replay capture boundary. Current native history is not substituted for historical replay evidence.');
  // Capture retained file actions before the runner replaced its artifact list
  // with workspace snapshots. These keep their original RPC source references.
  run = withCheckpointArtifacts(run, original, current, saved, rootId);
  if (context.spec.quality) run.quality = evaluateAuditQuality(run, context.spec.quality,
    { checks: context.spec.checks, review: original.quality?.review ?? null });
  return run;
}

export async function deriveRetainedAuditRun(store, current, { native, originalReportFingerprint,
  read = readAuditRecord, includeReplay = true } = {}) {
  const original = current.report;
  if (!/^[a-f0-9]{64}$/.test(originalReportFingerprint ?? '') || digest(original) !== originalReportFingerprint)
    throw new Error('The original report fingerprint does not match; preserving the frozen report.');
  const frozen = await projectRetainedAuditRun(store, current, { read, includeReplay });
  if (frozen.reportProjection?.context !== 'verified' || frozen.reportProjection.native !== 'frozen'
    || original.replayCapture?.boundary !== 'finalized-native-history-snapshot'
    || !/^[a-f0-9]{64}$/.test(original.replayCapture.sourceFingerprint ?? ''))
    throw new Error('The owned frozen capture cannot be verified for derived evidence.');
  const joined = joinRetainedNativeTurnEvidence(frozen, native, current.record.profile,
    { expectedSourceFingerprint: original.replayCapture.sourceFingerprint });
  if (joined.status === 'source-binding-mismatch')
    throw new Error('The native source fingerprint does not match the frozen capture.');
  const sessions = list(original.sessionReplay?.sessions), replacements = list(native.sessionReplay?.sessions);
  const bindings = rows => rows.map(session => [session.id, session.parentId ?? null, session.source?.fingerprint])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const actorEdges = rows => rows.map(actor => [actor.id, actor.parentId ?? null]).sort((a, b) => a[0].localeCompare(b[0]));
  if (!sessions.length || sessions.some(session => !/^[a-f0-9]{64}$/.test(session.source?.fingerprint ?? ''))
    || !isDeepStrictEqual(bindings(sessions), bindings(replacements))
    || !isDeepStrictEqual(actorEdges(original.agents), actorEdges(sessions)))
    throw new Error('The native replay actors or source fingerprints do not match the frozen capture.');
  const { comparisonEvidence, ...run } = frozen;
  Object.assign(run, joined.fields);
  if (includeReplay) {
    run.sessionReplay = structuredClone(native.sessionReplay);
    for (const session of run.sessionReplay.sessions) {
      const before = sessions.find(previous => previous.id === session.id);
      session.limits = [...new Map([...list(before.limits).filter(limit => limit.kind !== 'unprojected-records'), ...list(session.limits)]
        .map(limit => [JSON.stringify(limit), limit])).values()];
      for (const event of session.events) {
        const previous = before.events.find(row => row.id === event.id);
        if (previous?.bodyStatus === 'omitted' || /redact/.test(previous?.bodyReason ?? '')) {
          event.body = previous.body; event.bodyStatus = previous.bodyStatus;
          event.bodyReason = previous.bodyReason; event.bodyBytes = previous.bodyBytes;
        }
      }
    }
  }
  run.reportProjection = { ...frozen.reportProjection, native: joined.status,
    sourceAttestation: 'read-time-retained-snapshot', nativeSourceFingerprint: joined.sourceFingerprint };
  return run;
}
