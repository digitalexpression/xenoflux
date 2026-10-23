// Deterministic explanation of retained evidence. No transcript, filesystem or model reads.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isNamedAuditAction, AUDIT_ACTION_KINDS, AUDIT_ACTION_NAMES, AUDIT_ACTION_SUBJECTS, AUDIT_ACTION_RESULT_SCOPES } from './audit-actions.js';
import { projectAuditSessionEvidence } from './audit-session-evidence.js';

const list = value => Array.isArray(value) ? value : [];
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,199}$/.test(value) ? value : null;
const label = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._:+-]{0,199}$/u.test(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const line = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const relative = value => typeof value === 'string' && value.length <= 300 && !path.isAbsolute(value)
  && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..' && /^[\p{L}\p{N}_. -]+$/u.test(part)) ? value : null;
const states = new Set(['ready', 'complete', 'observed', 'none-recorded', 'partial', 'unknown', 'unavailable', 'not-found']);
const state = value => states.has(value) ? value : 'unknown';
const status = value => label(value) ?? 'unknown';
const unique = values => [...new Set(values)];
const MAX_ACTIONS = 256, MAX_ACTORS = 160, MAX_CHECKS = 40;
const fields = ['timeline', 'agents', 'skills', 'tools', 'outcome', 'workspaceDiff', 'instructions', 'skillInvocationTelemetry'];
// Comparison rendering represents an absent side with an empty safe projection.
// Count selected runs, not those placeholder objects, as observed samples.
const selectedRun = run => Boolean(id(run?.id)) && !['not-started', 'unavailable', 'not-found'].includes(run.status) && run.recoveredScaffold !== true;
const recordedTask = (run, core) => {
  if (!selectedRun(run) || core?.status !== 'recorded') return false;
  // Native session IDs and record counts can identify only a header or a
  // selected history row. Use the validated frozen core too: raw turns and
  // actions may have been removed after that core was sealed.
  const recordedTurn = list(run.turns).some(turn => id(turn?.turnId ?? turn?.id))
    || list(core.turns).some(turn => id(turn?.turnId));
  const recordedAction = list(run.actions).some(row => ['file-change', 'tool', 'read', 'resource-read', 'resource-invocation'].includes(row?.kind)
      && id(row?.turnId))
    || list(core.actions).some(row => ['file-change', 'tool', 'read', 'resource-read', 'resource-invocation'].includes(row?.kind)
      && id(row?.turnId))
    || list(run.namedActions).some(row => id(row?.turnId))
    || list(core.namedActions).some(row => id(row?.turnId))
    || list(run.artifacts).some(row => row?.kind === 'recorded-file-change')
    || list(run.events).some(row => id(row?.turnId ?? row?.metadata?.turnId))
    || list(run.toolInvocations).some(row => id(row?.turnId));
  const taskStatus = ['started', 'in-progress', 'completed', 'failed', 'interrupted', 'cancelled', 'aborted'].includes(
    run.task?.nativeTurnStatus ?? run.outcome?.task?.nativeTurnStatus ?? run.outcome?.nativeTurnStatus);
  return Boolean(recordedTurn || recordedAction || taskStatus);
};

/** Resolve both existing check locations before compaction or quality evaluation. */
export function canonicalAuditChecks(run) {
  const groups = new Map();
  for (const [location, rows] of [['checks', run?.checks], ['outcome.checks', run?.outcome?.checks]]) {
    for (const row of list(rows).slice(0, MAX_CHECKS)) {
      const name = label(row?.name ?? row?.id); if (!name) continue;
      const inconsistent = row.status === 'passed' && Number.isSafeInteger(row.exitCode) && row.exitCode !== 0;
      const item = inconsistent ? { name, status: 'unknown', exitCode: null, reason: 'inconsistent-check-result' }
        : { name, status: status(row.status), exitCode: Number.isSafeInteger(row.exitCode) ? row.exitCode : null,
          ...(row.reason === 'inconsistent-check-result' ? { reason: row.reason } : {}) };
      const key = JSON.stringify([item.status, item.exitCode]);
      const group = groups.get(name) ?? { results: new Map(), refs: [], origins: new Set() };
      group.origins.add(['runner-check', 'recorded-check'].includes(row.origin) ? row.origin : location === 'checks' ? 'runner-check' : 'recorded-check');
      group.results.set(key, item);
      group.refs.push(...list(row.evidenceRefs).filter(value => typeof value === 'string' && /^check:[\w .:+-]{1,200}$/.test(value)));
      group.refs.push(`check:${name}`);
      if (line(row.sourceLine)) group.refs.push(`check:${name}:line:${row.sourceLine}`);
      // Preserve an earlier conflict after the original locations have been compacted.
      if (row.reason === 'conflicting-check-evidence') group.conflict = true;
      groups.set(name, group);
    }
  }
  return [...groups].slice(0, MAX_CHECKS).map(([name, group]) => ({
    ...(group.results.size > 1 || group.conflict ? { name, status: 'unknown', exitCode: null, reason: 'conflicting-check-evidence' } : [...group.results.values()][0]),
    evidenceRefs: unique(group.refs).sort(), origin: group.origins.has('runner-check') ? 'runner-check' : 'recorded-check',
  }));
}

function conditions(value) {
  if (value?.schemaVersion !== 1) return { schemaVersion: 1, status: value == null ? 'unknown' : 'unsupported-version' };
  return { schemaVersion: 1, status: 'recorded', taskFingerprint: fingerprint(value.taskFingerprint), taskId: id(value.taskId),
    editableFiles: Array.isArray(value.editableFiles) ? unique(value.editableFiles.map(relative).filter(Boolean)).sort().slice(0, 64) : null,
    checkRecipes: list(value.checkRecipes).slice(0, 20).map(row => ({ name: label(row?.name), fingerprint: fingerprint(row?.fingerprint) })),
    qualityFingerprint: fingerprint(value.qualityFingerprint), setupFingerprint: fingerprint(value.setupFingerprint),
    variables: Array.isArray(value.variables) && value.variables.every(label) && value.variables.length <= 20 ? value.variables : null,
    selectedSkills: Array.isArray(value.selectedSkills) && value.selectedSkills.every(label) && value.selectedSkills.length <= 50 ? value.selectedSkills : null,
    profileOrder: list(value.profileOrder).map(label).filter(Boolean).slice(0, 8), trialIndex: Number.isSafeInteger(value.trialIndex) ? value.trialIndex : null,
    environment: Object.fromEntries(['platform', 'architecture', 'nodeVersion', 'settings', 'cache', 'integrations', 'epoch'].map(key => [key, label(value.environment?.[key])])),
    baseline: { commit: id(value.baseline?.commit), tree: id(value.baseline?.tree) } };
}
function baseline(run) {
  const raw = run?.sourceWorkspace ?? run?.source?.baseline ?? run?.baseline ?? run?.comparisonConditions?.baseline;
  return { commit: id(raw?.sourceCommit ?? raw?.commit), tree: id(raw?.sourceTree ?? raw?.tree) };
}
function binding(run) {
  const source = run?.source ?? {};
  return { runId: id(run?.id), profileId: id(run?.profileId ?? run?.profile?.profileId ?? run?.profile?.id),
    sourceIdentity: hash([id(source.kind), id(source.nativeSessionId ?? source.threadId), fingerprint(source.fingerprint)]), baseline: baseline(run) };
}
function nativeControls(run) {
  const value = run?.nativeControls;
  if (value?.schemaVersion !== 1) return null;
  const project = row => ({ model: label(row?.model), modelReasoningEffort: label(row?.modelReasoningEffort),
    planModeReasoningEffort: label(row?.planModeReasoningEffort), loginMethod: label(row?.loginMethod) });
  return { schemaVersion: 1, configured: project(value.configured),
    startup: { agentId: id(value.startup?.agentId), model: label(value.startup?.model), reasoningEffort: label(value.startup?.reasoningEffort),
      source: value.startup?.source === 'thread/start' ? 'thread/start' : null },
    turns: list(value.turns).slice(0, 1000).map(row => ({ agentId: id(row?.agentId), turnId: id(row?.turnId), model: label(row?.model),
      reasoningEffort: label(row?.reasoningEffort), sourceLine: line(row?.sourceLine), sourceFingerprint: fingerprint(row?.sourceFingerprint),
      workspaceMatched: typeof row?.workspaceMatched === 'boolean' ? row.workspaceMatched : null,
      source: row?.source === 'turn_context' ? 'turn_context' : null })).filter(row => row.agentId && row.turnId && row.source === 'turn_context') };
}
function sourceAttestation(run) {
  return run?.reportProjection === 'read-time-retained-snapshot'
    || run?.reportProjection?.sourceAttestation === 'read-time-retained-snapshot' ? 'read-time-retained-snapshot' : 'unknown';
}
function unavailable(run, reason) {
  return { schemaVersion: 1, status: 'unavailable', reason, binding: binding(run), conditions: conditions(null), sourceAttestation: 'unknown', actors: [], actions: [], coverage: {}, omissions: {},
    verification: { agentClaim: null, nativeCompletion: 'unknown', checks: [], human: { status: 'not-recorded' }, capture: { status: 'unknown' } }, changes: { status: 'unknown' }, measurements: {} };
}
function safePath(value, run) {
  if (relative(value)) return value;
  const root = run?.sourceWorkspace?.directory ?? run?.source?.workspace;
  return typeof root === 'string' && typeof value === 'string' && path.isAbsolute(root) && path.isAbsolute(value) ? relative(path.relative(root, value)) : null;
}
function nativeCompletion(run, actors) {
  const roots = actors.filter(actor => actor.parentId === null);
  const rootId = id(run?.source?.threadId ?? run?.source?.nativeSessionId ?? run?.task?.nativeThreadId) ?? (roots.length === 1 ? roots[0].id : null);
  const statuses = list(run?.turns).filter(turn => turn?.agentId === rootId).map(turn => turn.status);
  statuses.push(run?.task?.nativeTurnStatus, run?.outcome?.task?.nativeTurnStatus, run?.outcome?.nativeTurnStatus);
  if (statuses.some(value => ['failed', 'interrupted', 'cancelled', 'aborted'].includes(value))) return 'failed';
  return statuses.includes('completed') ? 'completed' : 'unknown';
}

function ownedActor(actorId, actors, rootId) {
  const seen = new Set(); let actor = actors.find(row => row.id === actorId);
  while (actor) {
    if (seen.has(actor.id)) return false;
    seen.add(actor.id);
    if (actor.parentId === null) return actor.id === rootId;
    actor = actors.find(row => row.id === actor.parentId);
  }
  return false;
}
function freezeNamedActions(run, actors, turns, rootId) {
  const rows = [], seen = new Set(), runId = binding(run).runId;
  const controls = nativeControls(run);
  for (const raw of list(run.namedActions ?? run.actions).slice(0, 10000)) {
    if (!isNamedAuditAction(raw)) continue;
    const actor = actors.find(row => row.id === raw.agentId);
    const sourceBound = actor?.sourceFingerprint === raw.sourceFingerprint || controls?.turns.some(turn => turn.agentId === raw.agentId
      && turn.turnId === raw.turnId && turn.source === 'turn_context' && turn.workspaceMatched === true && turn.sourceFingerprint === raw.sourceFingerprint);
    if (!actor || !ownedActor(raw.agentId, actors, rootId) || !sourceBound
      || !turns.some(turn => turn.agentId === raw.agentId && turn.turnId === raw.turnId)
      || !id(raw.callId) || !line(raw.sourceLine) || !line(raw.resultSourceLine)) continue;
    const record = { kind: raw.kind, name: raw.name, targets: unique(raw.targets.map(relative).filter(Boolean)).slice(0, 32),
      subjects: unique(raw.subjects.filter(value => AUDIT_ACTION_SUBJECTS.includes(value))).slice(0, 8),
      agentId: raw.agentId, turnId: raw.turnId, callId: raw.callId, sourceLine: raw.sourceLine,
      resultSourceLine: raw.resultSourceLine, resultIndex: Number.isSafeInteger(raw.resultIndex) ? raw.resultIndex : null,
      resultScope: raw.resultScope, invocationIndex: Number.isSafeInteger(raw.invocationIndex) ? raw.invocationIndex : null,
      exitCode: Number.isSafeInteger(raw.exitCode) ? raw.exitCode : null, sourceFingerprint: raw.sourceFingerprint };
    if (!isNamedAuditAction(record)) continue;
    const uniqueKey = JSON.stringify([record.callId, record.resultIndex, record.sourceLine]);
    if (seen.has(uniqueKey)) continue;
    const action = { ...record, id: `named-action-${hash([runId, record]).slice(0, 24)}` };
    seen.add(uniqueKey); rows.push(action);
    if (rows.length >= MAX_ACTIONS) break;
  }
  return rows;
}
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
function safeCore(core) {
  if (!keys(core, ['schemaVersion', 'status', 'binding', 'conditions', 'sourceAttestation', 'actors', 'turns', 'observedControls', 'nativeControls', 'actions', 'namedActions', 'coverage', 'omissions', 'verification', 'changes', 'measurements', 'fingerprint'])
    || !keys(core.binding, ['runId', 'profileId', 'sourceIdentity', 'baseline']) || !keys(core.binding.baseline, ['commit', 'tree'])
    || !Array.isArray(core.actors) || !Array.isArray(core.turns) || !Array.isArray(core.actions) || core.namedActions !== undefined && !Array.isArray(core.namedActions)
    || !keys(core.conditions, ['schemaVersion', 'status', 'taskFingerprint', 'taskId', 'editableFiles', 'checkRecipes', 'qualityFingerprint', 'setupFingerprint', 'variables', 'selectedSkills', 'profileOrder', 'trialIndex', 'environment', 'baseline'])
    || !keys(core.conditions.environment ?? {}, ['platform', 'architecture', 'nodeVersion', 'settings', 'cache', 'integrations', 'epoch'])
    || !keys(core.conditions.baseline ?? {}, ['commit', 'tree']) || list(core.conditions.checkRecipes).some(row => !keys(row, ['name', 'fingerprint']))
    || !keys(core.observedControls, ['nativeVersion', 'models', 'efforts', 'complete', 'rootId'])
    || !keys(core.coverage, fields) || !keys(core.omissions, ['actions', 'actors', 'turns', 'sourceDetails'])
    || !keys(core.verification, ['agentClaim', 'nativeCompletion', 'process', 'checks', 'human', 'capture'])
    || core.verification.agentClaim && !keys(core.verification.agentClaim, ['status', 'success', 'agentId', 'turnId', 'sourceLine'])
    || !keys(core.verification.process, ['status', 'exitCode'])
    || !keys(core.verification.human, ['status', 'fingerprint', 'rubricId', 'rubricVersion', 'scorePercent'])
    || !keys(core.verification.capture, ['status', 'checks']) || list(core.verification.capture.checks).some(row => !keys(row, ['id', 'status']))
    || list(core.verification.checks).some(row => !keys(row, ['name', 'status', 'exitCode', 'reason', 'evidenceRefs', 'origin']))
    || !keys(core.changes, ['status', 'fingerprint', 'captureComplete', 'timing', 'changedFileCount', 'changeCountBasis', 'inspection'])
    || !keys(core.measurements, ['elapsedMs', 'processElapsedMs', 'wallMs', 'setupMs', 'taskMs', 'captureMs', 'checksMs', 'totalMs'])) return false;
  if (core.actors.some(row => !keys(row, ['id', 'parentId', 'role', 'sourceFingerprint']) || !id(row.id) || row.parentId !== null && !id(row.parentId))
    || core.turns.some(row => !keys(row, ['agentId', 'turnId', 'model', 'reasoningEffort', 'status']) || !id(row.agentId) || !id(row.turnId))) return false;
  if (core.observedControls.complete) {
    const models = core.turns.map(turn => turn.model), efforts = core.turns.map(turn => turn.reasoningEffort);
    if (!models.length || !models.every(Boolean) || !efforts.every(Boolean) || core.omissions.actors || core.omissions.turns
      || JSON.stringify(core.observedControls.models) !== JSON.stringify(unique(models).sort())
      || JSON.stringify(core.observedControls.efforts) !== JSON.stringify(unique(efforts).sort())) return false;
  }
  for (const action of core.actions) {
    if (!keys(action, ['kind', 'agentId', 'turnId', 'itemId', 'observationId', 'sourceId', 'sourceLine', 'actorState', 'role', 'order', 'status', 'exitCode', 'path', 'target', 'resource', 'corroboration', 'tool', 'id'])
      || !keys(action.order, ['basis', 'sourceId', 'position'])
      || action.resource && !keys(action.resource, ['id', 'origin', 'name']) || action.tool && !keys(action.tool, ['kind', 'toolName', 'serverName', 'pluginId'])
      || action.path != null && !relative(action.path) || action.target != null) return false;
    const { id: actionId, ...content } = action;
    if (actionId !== `action-${hash([core.binding.runId, content]).slice(0, 24)}`) return false;
    const actor = core.actors.find(row => row.id === action.agentId);
    if (action.actorState === 'owned' && (!ownedActor(action.agentId, core.actors, core.observedControls.rootId)
      || action.turnId && !core.turns.some(turn => turn.agentId === action.agentId && turn.turnId === action.turnId))) return false;
    const expectedRole = action.actorState === 'owned' ? actor?.parentId ? 'owned-child' : 'root' : 'unknown';
    if (action.role !== expectedRole) return false;
    const expectedSource = actor ? `source-${hash([core.binding.sourceIdentity, actor.id, actor.sourceFingerprint]).slice(0, 16)}` : null;
    if (action.sourceId !== expectedSource || action.order.basis === 'source-line' && (action.order.sourceId !== action.sourceId || action.order.position !== action.sourceLine)) return false;
  }
  for (const action of list(core.namedActions)) {
    const { id: actionId, ...record } = action ?? {};
    if (!keys(action, ['id', 'kind', 'name', 'targets', 'subjects', 'agentId', 'turnId', 'callId', 'sourceLine', 'resultSourceLine', 'resultIndex', 'resultScope', 'invocationIndex', 'exitCode', 'sourceFingerprint'])
      || !isNamedAuditAction(record) || !/^[a-f0-9]{64}$/.test(action.sourceFingerprint ?? '')
      || !line(action.sourceLine) || !line(action.resultSourceLine) || !id(action.agentId) || !id(action.turnId) || !id(action.callId)
      || !action.targets.every(relative) || !action.subjects.every(subject => AUDIT_ACTION_SUBJECTS.includes(subject))
      || action.resultIndex !== null && !Number.isSafeInteger(action.resultIndex) || action.invocationIndex !== null && !Number.isSafeInteger(action.invocationIndex)
      || action.targets.length > 32 || action.subjects.length > 8
      || actionId !== `named-action-${hash([core.binding.runId, record]).slice(0, 24)}`) return false;
    const actor = core.actors.find(row => row.id === action.agentId);
    const sourceBound = actor?.sourceFingerprint === action.sourceFingerprint || list(core.nativeControls?.turns).some(turn => turn.agentId === action.agentId
      && turn.turnId === action.turnId && turn.source === 'turn_context' && turn.workspaceMatched === true && turn.sourceFingerprint === action.sourceFingerprint);
    if (!actor || !sourceBound || !ownedActor(action.agentId, core.actors, core.observedControls.rootId)
      || !core.turns.some(turn => turn.agentId === action.agentId && turn.turnId === action.turnId)) return false;
  }
  if (core.nativeControls !== undefined) {
    const controls = core.nativeControls;
    if (!keys(controls, ['schemaVersion', 'configured', 'startup', 'turns']) || controls.schemaVersion !== 1
      || !keys(controls.configured, ['model', 'modelReasoningEffort', 'planModeReasoningEffort', 'loginMethod'])
      || !keys(controls.startup, ['agentId', 'model', 'reasoningEffort', 'source']) || !Array.isArray(controls.turns)
      || controls.turns.length > 1000 || controls.turns.some(row => !keys(row, ['agentId', 'turnId', 'model', 'reasoningEffort', 'sourceLine', 'sourceFingerprint', 'workspaceMatched', 'source'])
        || row.source !== 'turn_context' || row.workspaceMatched !== null && typeof row.workspaceMatched !== 'boolean' || row.sourceLine !== null && !line(row.sourceLine) || !core.turns.some(turn => turn.agentId === row.agentId && turn.turnId === row.turnId
          && turn.model === row.model && turn.reasoningEffort === row.reasoningEffort))) return false;
  }
  // Every leaf has an explicit type. Printable nested objects are still payloads.
  const text = value => value === null || typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._:+/-]{0,399}$/u.test(value);
  const numeric = value => value === null || typeof value === 'number' && Number.isFinite(value);
  const boolean = value => typeof value === 'boolean';
  const optional = rule => value => value === undefined || rule(value);
  const shape = (value, schema) => typeof schema === 'function' ? schema(value)
    : Array.isArray(schema) ? Array.isArray(value) && value.every(item => shape(item, schema[0]))
      : keys(value, Object.keys(schema)) && Object.entries(schema).every(([key, rule]) => shape(value[key], rule));
  const maybeShape = schema => optional(value => value === null || shape(value, schema));
  const baselineShape = { commit: text, tree: text };
  const checkShape = { name: text, status: text, exitCode: numeric, reason: optional(text), evidenceRefs: [value => typeof value === 'string' && /^check:[\w .:+-]{1,220}$/.test(value)], origin: text };
  return shape(core, {
    schemaVersion: value => value === 1, status: value => value === 'recorded', fingerprint: value => Boolean(fingerprint(value)),
    binding: { runId: text, profileId: text, sourceIdentity: text, baseline: baselineShape },
    conditions: { schemaVersion: value => value === 1, status: text, taskFingerprint: optional(text), taskId: optional(text),
      editableFiles: optional(value => value === null || Array.isArray(value) && value.every(item => Boolean(relative(item)))),
      checkRecipes: optional(value => shape(value, [{ name: text, fingerprint: text }])), qualityFingerprint: optional(text), setupFingerprint: optional(text),
      variables: optional(value => value === null || shape(value, [text])), selectedSkills: optional(value => value === null || shape(value, [text])), profileOrder: optional(value => shape(value, [text])), trialIndex: optional(numeric),
      environment: optional(value => shape(value, Object.fromEntries(['platform', 'architecture', 'nodeVersion', 'settings', 'cache', 'integrations', 'epoch'].map(key => [key, text])))),
      baseline: optional(value => shape(value, baselineShape)) },
    actors: [{ id: text, parentId: text, role: text, sourceFingerprint: text }],
    turns: [{ agentId: text, turnId: text, model: text, reasoningEffort: text, status: text }],
    observedControls: { nativeVersion: text, models: [text], efforts: [text], complete: boolean, rootId: text },
    nativeControls: optional(value => shape(value, { schemaVersion: value => value === 1,
      configured: { model: text, modelReasoningEffort: text, planModeReasoningEffort: text, loginMethod: text },
      startup: { agentId: text, model: text, reasoningEffort: text, source: value => value === null || value === 'thread/start' },
      turns: [{ agentId: text, turnId: text, model: text, reasoningEffort: text, sourceLine: numeric, sourceFingerprint: text, workspaceMatched: value => value === null || typeof value === 'boolean',
        source: value => value === 'turn_context' }] })),
    sourceAttestation: optional(value => value === 'read-time-retained-snapshot' || value === 'unknown'),
    actions: [{ kind: value => ['file-change', 'read', 'resource-read', 'resource-invocation', 'tool'].includes(value), agentId: text, turnId: text,
      itemId: text, observationId: text, sourceId: text, sourceLine: numeric, actorState: value => ['owned', 'unknown'].includes(value), role: text,
      order: { basis: text, sourceId: optional(text), position: optional(numeric) }, status: text, exitCode: numeric,
      path: optional(text), target: optional(value => value === null), resource: maybeShape({ id: text, origin: text, name: text }),
      corroboration: optional(text), tool: maybeShape({ kind: text, toolName: text, serverName: text, pluginId: text }), id: text }],
    namedActions: optional(value => Array.isArray(value) && value.length <= MAX_ACTIONS && value.every(row => shape(row, {
      id: text, kind: value => AUDIT_ACTION_KINDS.includes(value), name: value => AUDIT_ACTION_NAMES.includes(value), targets: [text], subjects: [text],
      agentId: text, turnId: text, callId: text, sourceLine: numeric, resultSourceLine: numeric, resultIndex: numeric,
      resultScope: value => AUDIT_ACTION_RESULT_SCOPES.includes(value), invocationIndex: numeric, exitCode: numeric, sourceFingerprint: text,
    }))),
    coverage: Object.fromEntries(fields.map(key => [key, value => states.has(value)])),
    omissions: { actions: numeric, actors: numeric, turns: numeric, sourceDetails: numeric },
    verification: { agentClaim: value => value === null || shape(value, { status: text, success: value => value === null || boolean(value), agentId: text, turnId: text, sourceLine: numeric }),
      nativeCompletion: text, process: { status: text, exitCode: numeric }, checks: [checkShape],
      capture: { status: text, checks: [{ id: text, status: text }] }, human: { status: text, fingerprint: text, rubricId: text, rubricVersion: text, scorePercent: numeric } },
    changes: { status: text, fingerprint: text, captureComplete: boolean, timing: text, changedFileCount: numeric, changeCountBasis: text, inspection: text },
    measurements: Object.fromEntries(['elapsedMs', 'processElapsedMs', 'wallMs', 'setupMs', 'taskMs', 'captureMs', 'checksMs', 'totalMs'].map(key => [key, numeric])),
  });
}

/** Freeze only the safe support necessary for findings, before ordinary detail caps. */
export function freezeAuditComparisonEvidence(run) {
  if (!run || typeof run !== 'object') return unavailable(run, 'missing-run');
  if (Object.hasOwn(run, 'comparisonEvidence')) {
    const core = run.comparisonEvidence;
    if (core?.schemaVersion !== 1) return unavailable(run, 'unsupported-comparison-evidence-version');
    if (core.status === 'unavailable') return unavailable(run, id(core.reason) ?? 'invalid-comparison-evidence');
    const { fingerprint: recorded, ...payload } = core;
    if (!fingerprint(recorded) || hash(payload) !== recorded || JSON.stringify(core.binding) !== JSON.stringify(binding(run))) return unavailable(run, 'comparison-evidence-binding-mismatch');
    if (run.comparisonConditions && JSON.stringify(conditions(run.comparisonConditions)) !== JSON.stringify(core.conditions)) return unavailable(run, 'comparison-condition-binding-mismatch');
    if (!safeCore(core) || list(core.actions).length > MAX_ACTIONS || list(core.actors).length > MAX_ACTORS || list(core.turns).length > 1000 || Buffer.byteLength(JSON.stringify(core)) > 256 * 1024) return unavailable(run, 'comparison-evidence-limit');
    if (run.nativeControls && JSON.stringify(nativeControls(run)) !== JSON.stringify(core.nativeControls)) return unavailable(run, 'native-controls-binding-mismatch');
    if (run.reportProjection && core.sourceAttestation !== sourceAttestation(run)) return unavailable(run, 'source-attestation-binding-mismatch');
    if (Array.isArray(run.actions) || Array.isArray(run.namedActions)) {
      const actors = list(run.agents).slice(0, MAX_ACTORS).map(actor => ({ id: id(actor?.id), parentId: id(actor?.parentId),
        role: id(actor?.role), sourceFingerprint: fingerprint(actor?.source?.fingerprint) })).filter(actor => actor.id);
      const rootId = id(run.source?.nativeSessionId ?? run.source?.threadId ?? run.task?.nativeThreadId)
        ?? (actors.filter(actor => actor.parentId === null).length === 1 ? actors.find(actor => actor.parentId === null).id : null);
      const turns = list(run.turns).slice(0, 1000).map(turn => ({ agentId: id(turn?.agentId), turnId: id(turn?.turnId) })).filter(turn => turn.agentId && turn.turnId);
      if (JSON.stringify(freezeNamedActions(run, actors, turns, rootId)) !== JSON.stringify(core.namedActions ?? [])) return unavailable(run, 'named-action-binding-mismatch');
    }
    const actorIds = new Set(list(core.actors).map(actor => actor.id));
    if (actorIds.size !== core.actors.length || core.actions.some(action => action.agentId && !actorIds.has(action.agentId))
      || new Set(core.actions.map(action => action.id)).size !== core.actions.length) return unavailable(run, 'comparison-reference-invalid');
    if (id(run.source?.clientVersion ?? run.source?.version) !== core.observedControls.nativeVersion) return unavailable(run, 'observed-control-binding-mismatch');
    for (const turn of list(run.turns)) {
      const recorded = core.turns.find(row => row.agentId === turn?.agentId && row.turnId === turn?.turnId);
      if ((!recorded && !core.omissions.turns) || recorded && (recorded.model !== label(turn.model) || recorded.reasoningEffort !== label(turn.reasoningEffort) || recorded.status !== status(turn.status))) return unavailable(run, 'observed-control-binding-mismatch');
    }
    for (const actor of list(run.agents)) {
      const recorded = core.actors.find(row => row.id === actor?.id);
      if ((!recorded && !core.omissions.actors) || recorded && (recorded.parentId !== id(actor.parentId)
        || fingerprint(actor.source?.fingerprint) && recorded.sourceFingerprint !== fingerprint(actor.source.fingerprint))) return unavailable(run, 'actor-binding-mismatch');
    }
    if (run.execution && JSON.stringify({ status: status(run.execution.status), exitCode: Number.isSafeInteger(run.execution.exitCode) ? run.execution.exitCode : null }) !== JSON.stringify(core.verification.process)) return unavailable(run, 'process-binding-mismatch');
    const taskEnd = run.workspace?.taskEnd ?? run.outcome?.taskEndWorkspace ?? run.taskEnd;
    if (taskEnd) {
      const changes = { status: taskEnd.captureComplete === true && taskEnd.timing === 'task-end' ? 'recorded' : 'unknown',
        fingerprint: id(taskEnd.fingerprint), captureComplete: taskEnd.captureComplete === true, timing: id(taskEnd.timing),
        changedFileCount: taskEnd.changeCountStatus === 'known' ? number(taskEnd.changedFileCount) : null, changeCountBasis: id(taskEnd.changeCountBasis), inspection: 'not-recorded' };
      if (JSON.stringify(changes) !== JSON.stringify(core.changes)) return unavailable(run, 'task-end-binding-mismatch');
    }
    const rawClaim = run.outcome?.claim ?? run.outcomeClaim;
    if (rawClaim) {
      const claim = { status: status(rawClaim.status), success: typeof rawClaim.success === 'boolean' ? rawClaim.success : null,
        agentId: core.actors.some(actor => actor.id === rawClaim.agentId) ? rawClaim.agentId : null, turnId: id(rawClaim.turnId), sourceLine: line(rawClaim.sourceLine) };
      if (JSON.stringify(claim) !== JSON.stringify(core.verification.agentClaim)) return unavailable(run, 'claim-binding-mismatch');
    }
    if ((Array.isArray(run.checks) || Array.isArray(run.outcome?.checks)) && JSON.stringify(canonicalAuditChecks(run)) !== JSON.stringify(core.verification.checks)) return unavailable(run, 'check-binding-mismatch');
    for (const value of [run.task?.nativeTurnStatus, run.outcome?.task?.nativeTurnStatus, run.outcome?.nativeTurnStatus]) if (['failed', 'interrupted', 'cancelled', 'aborted'].includes(value) && core.verification.nativeCompletion !== 'failed') return unavailable(run, 'native-completion-binding-mismatch');
    return core;
  }
  const actors = list(run.agents).slice(0, MAX_ACTORS).map(actor => ({ id: id(actor?.id), parentId: id(actor?.parentId),
    role: id(actor?.role), sourceFingerprint: fingerprint(actor?.source?.fingerprint) })).filter(actor => actor.id);
  const known = new Set(actors.map(actor => actor.id)), actions = [], seen = new Set();
  const roots = actors.filter(actor => actor.parentId === null);
  const rootId = id(run.source?.nativeSessionId ?? run.source?.threadId ?? run.task?.nativeThreadId) ?? (roots.length === 1 ? roots[0].id : null);
  const turns = list(run.turns).slice(0, 1000).map(turn => ({ agentId: id(turn?.agentId), turnId: id(turn?.turnId), model: label(turn?.model),
    reasoningEffort: label(turn?.reasoningEffort), status: status(turn?.status) })).filter(turn => known.has(turn.agentId) && turn.turnId);
  const sourceIdentity = binding(run).sourceIdentity;
  const add = (kind, row, detail = {}) => {
    const agentId = id(row?.agentId), turnId = id(row?.turnId), sourceLine = line(row?.sourceLine);
    const actor = actors.find(value => value.id === agentId);
    const turnKnown = !turnId || list(run.turns).some(turn => turn?.agentId === agentId && turn.turnId === turnId);
    const owned = Boolean(agentId && ownedActor(agentId, actors, rootId) && turnKnown);
    const sourceId = owned && actor ? `source-${hash([sourceIdentity, agentId, actor.sourceFingerprint]).slice(0, 16)}` : null;
    const sourceOrder = owned && sourceLine && (actor?.sourceFingerprint || run.source?.kind === 'native-rollout' && actor?.parentId === null);
    const itemId = id(row?.itemId ?? row?.metadata?.itemId ?? row?.metadata?.id ?? row?.metadata?.callId);
    const receiptId = row?.observationId ?? row?.metadata?.observationId;
    const observationId = typeof receiptId === 'string' && /^[a-f0-9]{32}:[1-9][0-9]{0,4}$/.test(receiptId) ? receiptId : null;
    const action = { kind, agentId: owned ? agentId : null, turnId: owned ? turnId : null, itemId, observationId,
      sourceId, sourceLine, actorState: owned ? 'owned' : 'unknown',
      role: owned && actor?.parentId ? 'owned-child' : owned ? 'root' : 'unknown',
      order: sourceOrder ? { basis: 'source-line', sourceId, position: sourceLine } : { basis: 'unknown' },
      status: status(row?.status ?? row?.metadata?.status), exitCode: Number.isSafeInteger(row?.exitCode ?? row?.metadata?.exitCode) ? row.exitCode ?? row.metadata.exitCode : null,
      ...detail };
    action.id = `action-${hash([binding(run).runId, action]).slice(0, 24)}`;
    if (!seen.has(action.id)) { seen.add(action.id); actions.push(action); }
  };
  for (const row of list(run.artifacts)) if (row?.kind === 'recorded-file-change') add('file-change', row, { path: safePath(row.path, run) });
  for (const event of list(run.events)) if (event?.kind === 'command-execution' && String(event.metadata?.operation).toLowerCase() === 'read') add('read', event, { target: null });
  for (const skill of list(run.skills)) for (const observation of list(skill?.observations)) {
    if (['definition-read', 'resource-read', 'definition-read-observed', 'package-resource-read-observed', 'native-invocation-observed'].includes(observation?.kind)) {
      const proof = observation.readCorroboration ?? observation.evidence?.readCorroboration;
      if (observation.kind !== 'native-invocation-observed' && !['native-read-action', 'native-unknown-absolute-cat'].includes(proof)) continue;
      add(observation.kind === 'native-invocation-observed' ? 'resource-invocation' : 'resource-read', observation,
        { resource: { id: id(skill.id), origin: label(skill.origin ?? skill.scope), name: label(skill.name) }, corroboration: id(proof) });
    }
  }
  for (const row of list(run.toolInvocations)) add('tool', row, { tool: { kind: id(row.kind), toolName: label(row.toolName), serverName: label(row.serverName), pluginId: id(row.pluginId) } });
  const namedActions = freezeNamedActions(run, actors, turns, rootId);
  const omissions = { actions: Math.max(0, actions.length - MAX_ACTIONS), actors: Math.max(0, list(run.agents).length - actors.length),
    turns: Math.max(0, list(run.turns).length - turns.length),
    sourceDetails: Object.values(obj(run.evidenceBounds?.omitted)).reduce((sum, value) => sum + (number(value) ?? 0), 0) };
  const checks = canonicalAuditChecks(run);
  const claim = run.outcome?.claim ?? run.outcomeClaim;
  const taskEnd = run.workspace?.taskEnd ?? run.outcome?.taskEndWorkspace ?? run.taskEnd;
  const capture = run.captureAcceptance;
  const quality = run.quality;
  const models = list(run.turns).map(turn => label(turn?.model));
  const efforts = list(run.turns).map(turn => label(turn?.reasoningEffort));
  const controls = nativeControls(run);
  const core = { schemaVersion: 1, status: 'recorded', binding: binding(run), conditions: conditions(run.comparisonConditions),
    sourceAttestation: sourceAttestation(run), actors, turns,
    ...(controls ? { nativeControls: controls } : {}),
    observedControls: { nativeVersion: id(run.source?.clientVersion ?? run.source?.version),
      models: unique(models.filter(Boolean)).sort(), efforts: unique(efforts.filter(Boolean)).sort(),
      rootId, complete: models.length > 0 && models.every(Boolean) && efforts.every(Boolean) && omissions.actors === 0 && omissions.turns === 0 },
    actions: actions.slice(0, MAX_ACTIONS), namedActions, coverage: Object.fromEntries(fields.map(key => [key, state(run.coverage?.[key])])), omissions,
    verification: { agentClaim: claim ? { status: status(claim.status), success: typeof claim.success === 'boolean' ? claim.success : null,
      agentId: known.has(claim.agentId) ? claim.agentId : null, turnId: id(claim.turnId), sourceLine: line(claim.sourceLine) } : null,
      nativeCompletion: nativeCompletion(run, actors), process: { status: status(run.execution?.status), exitCode: Number.isSafeInteger(run.execution?.exitCode) ? run.execution.exitCode : null },
      checks, capture: { status: status(capture?.status), checks: list(capture?.checks).slice(0, 200).map(row => ({ id: id(row?.id), status: status(row?.status) })) },
      human: { status: quality?.rubric?.status === 'reviewed' && quality?.review?.runId === run.id
        && fingerprint(quality?.fingerprint) && quality.fingerprint === conditions(run.comparisonConditions).qualityFingerprint
        && quality?.review?.fingerprint === quality.fingerprint && number(quality.rubric.scorePercent) !== null && quality.rubric.scorePercent <= 100 ? 'reviewed'
        : quality?.rubric?.status === 'pending-review' && fingerprint(quality?.fingerprint)
          && quality.fingerprint === conditions(run.comparisonConditions).qualityFingerprint && id(quality.rubric.rubricId) && id(quality.rubric.rubricVersion)
          ? 'pending-review' : 'not-recorded',
        fingerprint: fingerprint(quality?.fingerprint), rubricId: id(quality?.rubric?.rubricId), rubricVersion: id(quality?.rubric?.rubricVersion),
        scorePercent: number(quality?.rubric?.scorePercent) } },
    changes: { status: taskEnd?.captureComplete === true && taskEnd?.timing === 'task-end' ? 'recorded' : 'unknown',
      fingerprint: id(taskEnd?.fingerprint), captureComplete: taskEnd?.captureComplete === true, timing: id(taskEnd?.timing),
      changedFileCount: taskEnd?.changeCountStatus === 'known' ? number(taskEnd?.changedFileCount) : null,
      changeCountBasis: id(taskEnd?.changeCountBasis), inspection: 'not-recorded' },
    measurements: Object.fromEntries(['elapsedMs', 'processElapsedMs', 'wallMs', 'setupMs', 'taskMs', 'captureMs', 'checksMs', 'totalMs'].map(key => [key, number(run.metrics?.[key] ?? (key === 'processElapsedMs' ? run.execution?.elapsedMs : null))])) };
  core.fingerprint = hash(core);
  if (Buffer.byteLength(JSON.stringify(core)) > 256 * 1024) throw new Error('audit-comparison-support-exceeds-byte-budget');
  return core;
}

/** Same-task eligibility is distinct from the ability to show positive observations. */
function comparisonTaskAssociation(a, b, requested) {
  const leftTask = a.conditions.taskFingerprint, rightTask = b.conditions.taskFingerprint;
  if (leftTask && rightTask && leftTask !== rightTask) return { status: 'contradictory', taskId: null,
    source: 'recorded-input-identity', reasons: ['recorded-task-fingerprints-differ'] };
  if (leftTask && rightTask) return { status: 'recorded', taskId: a.conditions.taskId && a.conditions.taskId === b.conditions.taskId ? a.conditions.taskId : null,
    source: 'recorded-input-identity', reasons: [] };
  if (requested?.status === 'user-declared' && label(requested.taskId)) return { status: 'user-declared', taskId: label(requested.taskId),
    source: 'user-declaration', reasons: ['task-identity-was-declared-not-independently-verified'] };
  return { status: 'unknown', taskId: null, source: 'unavailable', reasons: ['same-task-association-unknown'] };
}

export function compareAuditConditions(left, right, { taskAssociation, declaredVariables } = {}) {
  const a = freezeAuditComparisonEvidence(left), b = freezeAuditComparisonEvidence(right);
  const association = comparisonTaskAssociation(a, b, taskAssociation);
  const values = core => ({ task: core.conditions.taskFingerprint, commit: core.binding.baseline.commit, tree: core.binding.baseline.tree,
    nativeVersion: core.observedControls?.nativeVersion, models: core.observedControls?.complete ? core.observedControls.models : null,
    reasoningEffort: core.observedControls?.complete ? core.observedControls.efforts : null, setup: core.conditions.setupFingerprint,
    editableFiles: core.conditions.editableFiles });
  const av = values(a), bv = values(b);
  const rows = Object.keys(av).map(key => ({ key, left: av[key] ?? null, right: bv[key] ?? null,
    status: av[key] == null || bv[key] == null || Array.isArray(av[key]) && !av[key].length || Array.isArray(bv[key]) && !bv[key].length ? 'unknown'
      : JSON.stringify(av[key]) === JSON.stringify(bv[key]) ? 'match' : 'different' }));
  const observedPair = recordedTask(left, a) && recordedTask(right, b);
  const sameTaskEligible = observedPair && ['recorded', 'user-declared'].includes(association.status);
  const baselineComparable = Boolean(av.commit && av.tree && bv.commit && bv.tree && av.commit === bv.commit && av.tree === bv.tree);
  const reasons = [];
  if (!selectedRun(left)) reasons.push('left-run-not-observed');
  if (!selectedRun(right)) reasons.push('right-run-not-observed');
  if (selectedRun(left) && !recordedTask(left, a)) reasons.push('left-task-not-started');
  if (selectedRun(right) && !recordedTask(right, b)) reasons.push('right-task-not-started');
  if (a.status !== 'recorded') reasons.push(`left-${a.reason}`);
  if (b.status !== 'recorded') reasons.push(`right-${b.reason}`);
  if (association.status === 'contradictory') reasons.push(...association.reasons);
  const checkMatch = sameTaskEligible && a.conditions.checkRecipes?.length > 0 && JSON.stringify(a.conditions.checkRecipes) === JSON.stringify(b.conditions.checkRecipes)
    && a.conditions.checkRecipes.every(row => row.name && row.fingerprint);
  const qualityMatch = sameTaskEligible && a.conditions.qualityFingerprint && a.conditions.qualityFingerprint === b.conditions.qualityFingerprint;
  const behaviorEligible = observedPair;
  return { eligible: sameTaskEligible, behaviorEligible, sameTaskEligible, taskAssociation: association,
    checksEligible: Boolean(checkMatch), reviewEligible: Boolean(qualityMatch),
    metricEligibility: Object.fromEntries(['taskMs', 'elapsedMs', 'processElapsedMs', 'wallMs', 'totalMs', 'checksMs'].map(key => [key,
      { eligible: key === 'checksMs' ? Boolean(checkMatch) : Boolean(sameTaskEligible),
        reason: key === 'checksMs' ? checkMatch ? null : 'task-or-check-recipe-not-comparable'
          : sameTaskEligible ? null : association.status === 'contradictory' ? 'recorded-task-identity-conflict' : 'same-task-association-unverified' }])),
    codeComparable: sameTaskEligible && baselineComparable,
    status: behaviorEligible ? sameTaskEligible ? 'same-task-eligible'
      : association.status === 'contradictory' ? 'behavior-observed-task-conflict' : 'behavior-observed-task-unknown' : 'unknown',
    reasons: unique(reasons), fields: rows,
    checksReason: checkMatch ? null : 'check-recipe-unknown-or-different', reviewReason: qualityMatch ? null : 'quality-definition-unknown-or-different',
    mode: a.conditions.status === 'recorded' && b.conditions.status === 'recorded' ? 'frozen-task-comparison' : 'existing-session-comparison',
    declaredVariables: a.conditions.variables ?? [], userDeclaredVariables: Array.isArray(declaredVariables)
      ? unique(declaredVariables.map(label).filter(Boolean)).slice(0, 50) : [],
    environment: { left: a.conditions.environment ?? null, right: b.conditions.environment ?? null },
    schedule: { left: { profileOrder: a.conditions.profileOrder ?? [], trialIndex: a.conditions.trialIndex ?? null }, right: { profileOrder: b.conditions.profileOrder ?? [], trialIndex: b.conditions.trialIndex ?? null } },
    evidenceKinds: Object.fromEntries([['left', left], ['right', right]].map(([side, run]) => [side,
      !selectedRun(run) ? 'unavailable' : !recordedTask(run, run === left ? a : b) ? 'pre-task-failure'
        : run.source?.kind === 'synthetic-fixture' ? 'synthetic' : 'recorded'])) };
}

function sideFinding(core, kind) {
  const records = core.actions.filter(row => row.kind === kind && row.actorState === 'owned');
  return { coverage: state(core.coverage[kind === 'file-change' ? 'workspaceDiff' : 'timeline']), state: records.length ? 'observed' : core.status !== 'recorded' ? 'unavailable'
      : core.coverage[kind === 'file-change' ? 'workspaceDiff' : 'timeline'] === 'complete' && !core.omissions.actions && !core.omissions.actors && !core.omissions.sourceDetails
        ? 'none-recorded' : state(core.coverage[kind === 'file-change' ? 'workspaceDiff' : 'timeline']),
    evidenceRefs: records.map(row => row.id), omissions: core.omissions };
}
function joinedVerification(run, core) {
  const quality = run?.quality, review = quality?.review, rubric = quality?.rubric;
  const pending = core.status === 'recorded' && fingerprint(quality?.fingerprint) && quality.fingerprint === core.conditions.qualityFingerprint
    && rubric?.status === 'pending-review' && id(rubric.rubricId) && id(rubric.rubricVersion);
  const bound = core.status === 'recorded' && quality?.fingerprint === core.conditions.qualityFingerprint
    && review?.fingerprint === quality?.fingerprint && review?.runId === run.id
    && rubric?.status === 'reviewed' && id(rubric.rubricId) && id(rubric.rubricVersion)
    && number(rubric.scorePercent) !== null && rubric.scorePercent <= 100;
  return { ...core.verification, human: bound ? { status: 'reviewed', fingerprint: quality.fingerprint,
    rubricId: rubric.rubricId, rubricVersion: rubric.rubricVersion, scorePercent: rubric.scorePercent }
    : pending ? { status: 'pending-review', fingerprint: quality.fingerprint, rubricId: rubric.rubricId,
      rubricVersion: rubric.rubricVersion, scorePercent: null }
      : quality ? { status: 'not-recorded', reason: 'review-binding-unverified' } : core.verification.human };
}
/** Derive claims afresh from frozen support, not from supplied narrative. */
export function buildAuditExplanation(left, right, options = {}) {
  const a = freezeAuditComparisonEvidence(left), b = freezeAuditComparisonEvidence(right), eligibility = compareAuditConditions(left, right, options);
  const observedPair = recordedTask(left, a) && recordedTask(right, b);
  const findings = [];
  const add = (rule, title, x, y, category, reason) => findings.push({ id: `finding-${hash([a.binding.runId, b.binding.runId, rule]).slice(0, 20)}`,
    rule, ruleVersion: 1, title, classification: observedPair ? category : 'inconclusive', scope: 'this recorded pair', left: x, right: y,
    eligibility: { eligible: observedPair, sameTaskEligible: eligibility.sameTaskEligible, taskAssociation: eligibility.taskAssociation,
      reasons: observedPair ? [] : eligibility.reasons }, limitation: reason,
    pairs: { planned: 1, observed: observedPair ? 1 : 0, eligible: observedPair && category !== 'inconclusive' ? 1 : 0, missing: observedPair ? 0 : 1,
      unknown: category === 'inconclusive' || !observedPair ? 1 : 0 } });
  const scopeSide = (core, run) => {
    const supplied = projectAuditSessionEvidence(run)?.taskContract;
    const side = sideFinding(core, 'file-change'), allowed = core.conditions.editableFiles ?? supplied?.editableFiles;
    const edits = core.actions.filter(row => row.kind === 'file-change' && row.actorState === 'owned');
    const located = edits.filter(row => row.path);
    const outside = allowed?.length ? located.filter(row => !allowed.includes(row.path)) : [];
    return { ...side, assertion: !allowed?.length ? 'editable-boundary-unknown' : outside.length ? 'outside-boundary-edit-observed' : located.length ? 'in-boundary-edit-observed' : side.state === 'none-recorded' ? 'no-file-change-records' : 'edit-scope-unknown',
      outsideRefs: outside.map(row => row.id), boundary: allowed ?? null,
      ...(supplied && !core.conditions.editableFiles ? { boundaryOrigin: 'supplied-session-evidence',
        evidenceRefs: [...side.evidenceRefs, `session-evidence:${run.id}`] } : {}) };
  };
  const x = scopeSide(a, left), y = scopeSide(b, right);
  const known = [x, y].every(side => ['outside-boundary-edit-observed', 'in-boundary-edit-observed', 'no-file-change-records'].includes(side.assertion) && !side.omissions.actions && !side.omissions.actors);
  const sameBoundary = x.boundary?.length && JSON.stringify(x.boundary) === JSON.stringify(y.boundary);
  add('editable-file-boundary', 'Observed editing scope', x, y, known && sameBoundary ? x.assertion === y.assertion ? 'similar' : 'different' : 'inconclusive',
    'A recorded in-boundary edit does not prove all changes were in scope; missing or partial edits remain unknown.');
  const readSide = core => {
    const reads = core.actions.filter(row => ['read', 'resource-read'].includes(row.kind) && row.actorState === 'owned');
    const edits = core.actions.filter(row => row.kind === 'file-change' && row.actorState === 'owned');
    const pairs = reads.flatMap(read => edits.filter(edit => read.agentId === edit.agentId && read.order.basis === 'source-line' && edit.order.basis === 'source-line'
      && read.order.sourceId === edit.order.sourceId).map(edit => ({ read, edit })));
    const first = pairs.sort((l, r) => l.read.sourceLine - r.read.sourceLine || l.edit.sourceLine - r.edit.sourceLine)[0];
    return { ...sideFinding(core, 'read'), assertion: !first ? 'read-edit-order-unknown' : first.read.sourceLine < first.edit.sourceLine ? 'read-before-recorded-edit' : 'read-after-recorded-edit',
      evidenceRefs: first ? [first.read.id, first.edit.id] : reads.map(row => row.id), target: 'unknown' };
  };
  const rx = readSide(a), ry = readSide(b);
  add('read-edit-sequence', 'Observed reading and editing sequence', rx, ry,
    rx.assertion === 'read-edit-order-unknown' || ry.assertion === 'read-edit-order-unknown' ? 'inconclusive' : rx.assertion === ry.assertion ? 'similar' : 'different',
    'Source order is within one owned stream only. Generic read records do not identify contract/source/test targets or prove understanding.');
  const namedOutcome = action => action.exitCode === 0 ? action.resultScope === 'action' ? 'passed' : 'invocation-passed'
    : Number.isSafeInteger(action.exitCode) ? action.resultScope === 'action' ? 'failed' : 'invocation-failed' : 'unknown';
  const actionDetails = rows => rows.map(action => ({ id: action.id, kind: action.kind, name: action.name, targets: action.targets,
    subjects: action.subjects, status: namedOutcome(action), agentId: action.agentId, turnId: action.turnId, callId: action.callId,
    sourceLine: action.sourceLine, resultSourceLine: action.resultSourceLine, resultScope: action.resultScope,
    invocationIndex: action.invocationIndex, resultIndex: action.resultIndex }));
  const categoryFor = target => {
    const base = target.split('/').at(-1);
    if (['AGENTS.md', 'README.md', 'AUDIT-GOAL.md', 'AUDIT-ACCEPTANCE.md', 'PROFILE-COPY-POLICY.md'].includes(base)) return 'contract';
    if (/^(src|lib)\//.test(target)) return 'source';
    if (/^(test|tests)\//.test(target)) return 'test';
    return null;
  };
  const namedReadSide = (core, category) => {
    const actions = list(core.namedActions);
    const reads = actions.filter(action => action.kind === 'read' && action.targets.some(target => categoryFor(target) === category));
    const edits = actions.filter(action => action.kind === 'edit');
    const pairs = reads.flatMap(read => edits.filter(edit => read.agentId === edit.agentId && read.turnId === edit.turnId
      && read.sourceFingerprint === edit.sourceFingerprint).map(edit => ({ read, edit })));
    pairs.sort((left, right) => left.read.sourceLine - right.read.sourceLine || left.edit.sourceLine - right.edit.sourceLine);
    const pair = pairs[0];
    return { state: pair ? 'observed' : 'unknown', assertion: pair ? pair.read.sourceLine < pair.edit.sourceLine ? 'read-invocation-before-edit-invocation' : 'read-invocation-after-edit-invocation' : 'named-read-edit-order-unknown',
      evidenceRefs: pair ? [pair.read.id, pair.edit.id] : [], actions: pair ? actionDetails([pair.read, pair.edit]) : [] };
  };
  for (const category of ['contract', 'source', 'test']) {
    const lx = namedReadSide(a, category), ry = namedReadSide(b, category);
    const knownPair = lx.state === 'observed' && ry.state === 'observed';
    add(`named-${category}-read-before-edit`, `Named ${category} reads before edits`, lx, ry,
      knownPair ? lx.assertion === ry.assertion ? 'similar' : 'different' : 'inconclusive',
      `This orders a literal ${category} read invocation before a recorded edit invocation in one owned turn. It does not prove every named target was read successfully; invocation-scope outcomes remain unknown. Edit completion remains unknown unless its exact action result records exit code 0.`);
  }
  const visibleTestSide = core => {
    const actions = list(core.namedActions).filter(action => action.kind === 'visible-test');
    return { state: actions.length ? 'observed' : 'unknown', assertion: actions.length ? 'named-visible-test-recorded' : 'named-visible-test-unknown',
      evidenceRefs: actions.map(action => action.id), actions: actionDetails(actions) };
  };
  const visibleLeft = visibleTestSide(a), visibleRight = visibleTestSide(b);
  const oneMatchingTest = visibleLeft.actions.length === 1 && visibleRight.actions.length === 1
    && ['passed', 'failed'].includes(visibleLeft.actions[0].status) && ['passed', 'failed'].includes(visibleRight.actions[0].status)
    && JSON.stringify(visibleLeft.actions[0].targets) === JSON.stringify(visibleRight.actions[0].targets);
  const testClassification = oneMatchingTest ? visibleLeft.actions[0].status === visibleRight.actions[0].status ? 'similar' : 'different' : 'inconclusive';
  add('named-visible-test-execution', 'Named visible-test execution', visibleLeft, visibleRight,
    testClassification,
    'A named test is successful only when its exact correlated process result records exit code 0; results are compared only when one recorded test target matches on each side.');
  const inlineSide = core => {
    const actions = list(core.namedActions).filter(action => action.kind === 'inline-assertion');
    return { state: actions.length ? 'observed' : 'unknown', assertion: actions.length ? 'named-inline-assertion-recorded' : 'named-inline-assertion-unknown',
      evidenceRefs: actions.map(action => action.id), actions: actionDetails(actions),
      recordedScriptSubjects: unique(actions.flatMap(action => action.subjects)).sort(),
      exitZeroScriptSubjects: unique(actions.filter(action => ['passed', 'invocation-passed'].includes(namedOutcome(action))).flatMap(action => action.subjects)).sort() };
  };
  const inlineLeft = inlineSide(a), inlineRight = inlineSide(b);
  const inlineComparable = inlineLeft.state === 'observed' && inlineRight.state === 'observed';
  add('named-inline-edge-assertions', 'Named inline edge assertions', inlineLeft, inlineRight,
    inlineComparable ? JSON.stringify(inlineLeft.recordedScriptSubjects) === JSON.stringify(inlineRight.recordedScriptSubjects) ? 'similar' : 'different' : 'inconclusive',
    'Finite subject tags name literal constructs in the recorded assertion script. Process exit 0 applies to the invocation; individual assertions and branches remain unverified.');
  for (const [rule, title] of [['agent-verification', 'Agent boundary checks and visible verification'], ['diff-inspection', 'Agent final-diff inspection']]) {
    add(rule, title, { state: 'unknown', assertion: 'not-identifiable-from-retained-actions', evidenceRefs: [] },
      { state: 'unknown', assertion: 'not-identifiable-from-retained-actions', evidenceRefs: [] }, 'inconclusive',
      'Generic commands, independent checker results and artifact presence do not establish this agent behavior.');
  }
  const checkNames = unique([...a.verification.checks, ...b.verification.checks].map(row => row.name));
  const outcomes = checkNames.map(name => {
    const l = a.verification.checks.find(row => row.name === name), r = b.verification.checks.find(row => row.name === name);
    const declared = a.conditions.checkRecipes?.some(row => row.name === name && row.fingerprint)
      && b.conditions.checkRecipes?.some(row => row.name === name && row.fingerprint);
    const observed = declared && l?.origin === 'runner-check' && r?.origin === 'runner-check'
      && ['passed', 'failed'].includes(l?.status) && ['passed', 'failed'].includes(r?.status)
      && (l.status !== 'passed' || l.exitCode === 0) && (r.status !== 'passed' || r.exitCode === 0);
    return { criterion: name, left: l?.status ?? 'not-run', right: r?.status ?? 'not-run',
      status: eligibility.checksEligible && observed ? l.status === r.status ? 'same-recorded-result' : 'different-recorded-result' : 'inconclusive',
      advantage: eligibility.checksEligible && observed && l.status !== r.status ? l.status === 'passed' ? 'left' : 'right' : null,
      evidenceRefs: { left: l?.evidenceRefs ?? [], right: r?.evidenceRefs ?? [] }, association: 'Associated with the observed behavior in this pair; no causal effect or universal winner is established.' };
  });
  const verification = { left: joinedVerification(left, a), right: joinedVerification(right, b) };
  const lh = verification.left.human, rh = verification.right.human;
  const reviewed = eligibility.reviewEligible && lh.status === 'reviewed' && rh.status === 'reviewed' && lh.fingerprint === rh.fingerprint;
  const humanOutcome = { criterion: reviewed ? `human-rubric:${lh.rubricId}` : 'human-rubric',
    status: reviewed ? 'paired-reviewed-scores' : 'inconclusive', left: lh.scorePercent ?? null, right: rh.scorePercent ?? null,
    delta: reviewed ? rh.scorePercent - lh.scorePercent : null, advantage: reviewed && lh.scorePercent !== rh.scorePercent ? lh.scorePercent > rh.scorePercent ? 'left' : 'right' : null,
    limitation: 'Human scores apply to the recorded rubric and reviewed changes only; no universal quality or causal claim is established.' };
  return { schemaVersion: 1, conditions: eligibility, findings, evidence: { left: a.actions, right: b.actions,
    namedActions: { left: list(a.namedActions), right: list(b.namedActions) },
    nativeControls: { left: a.nativeControls ?? null, right: b.nativeControls ?? null },
    sourceAttestation: { left: a.sourceAttestation ?? 'unknown', right: b.sourceAttestation ?? 'unknown' } },
    verification, outcomes: { criteria: outcomes, human: humanOutcome, changes: { left: a.changes, right: b.changes },
      conclusion: 'Better or worse applies only to a named compatible criterion. Unreviewed code quality remains unknown.' },
    consistency: { status: 'unmeasured', plannedPairs: 1, observedPairs: observedPair ? 1 : 0, eligiblePairs: eligibility.sameTaskEligible ? 1 : 0,
      missingPairs: observedPair ? 0 : 1, reason: 'One pair cannot establish consistency; no repeated-run inference is performed.' } };
}

/** Gate only documented comparison layouts; never traverse arbitrary user fields. */
export function gateAuditComparisonDeltas(comparison, eligibility) {
  const out = structuredClone(comparison);
  for (const [name, metric] of Object.entries(out.metrics ?? {})) if (/tokens/i.test(name)) {
    const field = name.replace(/^root[.]/, '');
    const known = out.usage?.deltas?.[field];
    if (!known || known.status !== 'known' || known.left !== metric.left || known.right !== metric.right) {
      metric.delta = null; metric.percentDelta = null; metric.status = 'unknown'; metric.reason = 'token-accounting-domain-unverified';
    }
  }
  if (!eligibility.checksEligible && out.outcomes) { out.outcomes.claimStatus = 'unknown'; out.outcomes.status = 'ineligible'; if (out.outcomes.checks) out.outcomes.checks.status = 'unknown'; }
  if (!eligibility.checksEligible) for (const name of ['checksMs']) if (out.metrics?.[name]) {
    out.metrics[name].delta = null; out.metrics[name].percentDelta = null; out.metrics[name].status = 'ineligible'; out.metrics[name].reason = eligibility.checksReason;
  }
  const gate = (row, reason) => { if (!row || typeof row !== 'object') return; if (Object.hasOwn(row, 'delta')) row.delta = null;
    if (Object.hasOwn(row, 'percentDelta')) row.percentDelta = null; if (Object.hasOwn(row, 'status')) row.status = 'ineligible'; row.reason = reason; };
  for (const [name, row] of Object.entries(out.metrics ?? {})) {
    const metric = eligibility.metricEligibility?.[name];
    if (metric && !metric.eligible) gate(row, metric.reason);
    else if (!metric && !eligibility.sameTaskEligible && !/token/i.test(name)) gate(row, 'same-task-association-unverified');
  }
  if (!eligibility.sameTaskEligible) {
    const reason = eligibility.taskAssociation?.status === 'contradictory' ? 'recorded-task-identity-conflict' : 'same-task-association-unverified';
    for (const key of ['tools', 'mcp', 'hooks', 'skillInvocations']) if (out[key]) out[key].comparisonEligibility = 'descriptive-task-association-unknown';
    if (out.artifacts) { out.artifacts.comparisonEligibility = 'descriptive-task-association-unknown';
      for (const snapshot of Object.values(out.artifacts.snapshots ?? {})) if (snapshot?.changes) snapshot.changes.comparisonEligibility = 'descriptive-task-association-unknown'; }
    if (out.outcomes) { out.outcomes.claimStatus = 'unknown'; out.outcomes.status = 'ineligible'; out.outcomes.reason = reason; }
    for (const row of Object.values(out.usage?.deltas ?? {})) row.comparisonEligibility = 'descriptive-task-association-unknown';
  }
  return out;
}
