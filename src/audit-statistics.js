import { evaluateAuditQuality, auditQualityFingerprint } from './audit-quality.js';
import { projectAuditSessionEvidence } from './audit-session-evidence.js';
import { nativeUsageAccounting, USAGE_FIELDS } from './audit-usage.js';
import { safePluginScriptPath } from './audit-tools.js';
import { compactInstructionSources } from './audit-instructions.js';
import { projectResourceProvenance } from './audit-provenance.js';
import { compactRequiredContext } from './audit-context.js';
import { recordedUsageAccounting, deriveRecordedUsage, projectRunRecordedUsage } from './audit-recorded-usage.js';
import { projectDeliveryAccounting, projectTelemetryJournal } from './audit-delivery.js';
import { projectSkillSourceTime } from './audit-source-time.js';
import { canonicalAuditChecks, freezeAuditComparisonEvidence, compareAuditConditions, buildAuditExplanation } from './audit-explanation.js';
import { buildAuditConsistency } from './audit-consistency.js';
import { retainedAuditSelectionOptions } from './audit-selection.js';
import { validateAuditNativeConfig } from './audit-spec.js';

function nativeConfigOf(value) {
  try { return validateAuditNativeConfig(value); } catch { return undefined; }
}

const list = value => Array.isArray(value) ? value : [];
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const bounded = (value, limit = 160) => list(value).slice(0, limit);
const text = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : value == null ? null : null;
const sourceLine = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const observationId = value => typeof value === 'string' && /^[a-f0-9]{32}:[1-9][0-9]{0,4}$/.test(value) ? value : null;
const usageAgentEntry = value => Boolean(value && typeof value === 'object' &&
  (value.last && typeof value.last === 'object' || value.total && typeof value.total === 'object'
    || value.totals?.values && typeof value.totals.values === 'object' || Number.isSafeInteger(value.snapshots)));

function compactCounters(value) {
  const source = obj(value), result = {};
  for (const key of USAGE_FIELDS) {
    const raw = source[key] ?? source[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];
    result[key] = finite(raw);
  }
  return result;
}
function compactTokenCounters(value) {
  const source = obj(value), result = {};
  for (const key of USAGE_FIELDS) {
    const raw = source[key] ?? source[key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)];
    result[key] = Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  }
  return result;
}
function compactUsageObservation(item) {
  return { agentId: text(item?.agentId ?? item?.agent_id, 160), turnId: text(item?.turnId ?? item?.turn_id, 160),
    source: text(item?.source, 120), sourceLine: sourceLine(item?.sourceLine ?? item?.source_line),
    recordedAt: text(item?.recordedAt ?? item?.recorded_at, 80), mode: text(item?.mode, 40),
    last: compactCounters(item?.last), total: compactCounters(item?.total),
    modelContextWindow: finite(item?.modelContextWindow ?? item?.model_context_window),
    present: { last: item?.present?.last === true, total: item?.present?.total === true,
      modelContextWindow: item?.present?.modelContextWindow === true || item?.present?.model_context_window === true },
    disposition: text(item?.disposition, 40) ?? 'unknown' };
}
function compactSkill(skill) {
  return { id: text(skill?.id, 240), name: text(skill?.name, 200), origin: text(skill?.origin, 80),
    scope: text(skill?.scope, 80), provider: text(skill?.provider, 200), pluginId: text(skill?.pluginId ?? skill?.plugin_id, 200),
    path: text(skill?.path, 500), availability: text(skill?.availability ?? skill?.status, 80),
    observations: bounded(skill?.observations, 100).map(item => ({ kind: text(item?.kind ?? item?.evidence, 80),
      agentId: text(item?.agentId ?? item?.agent_id, 160), turnId: text(item?.turnId ?? item?.turn_id, 160),
      itemId: text(item?.itemId, 160),
      observationId: observationId(item?.metadata?.observationId ?? item?.observationId),
      source: text(item?.source ?? item?.evidence?.source, 120), sourceLine: sourceLine(item?.sourceLine ?? item?.source_line),
      confidence: text(item?.confidence ?? item?.evidence?.confidence, 80),
      pathAuthority: (item?.pathAuthority ?? item?.evidence?.pathAuthority) === 'literal-command-target' ? 'literal-command-target' : null,
      readCorroboration: ['native-read-action', 'native-unknown-absolute-cat'].includes(item?.readCorroboration ?? item?.evidence?.readCorroboration)
        ? item.readCorroboration ?? item.evidence.readCorroboration : null,
      commandWrapper: ['direct', 'shell-command', 'login-shell-command'].includes(item?.commandWrapper ?? item?.evidence?.commandWrapper)
        ? item.commandWrapper ?? item.evidence.commandWrapper : null,
      ...(projectSkillSourceTime(item?.metadata?.sourceTime) ? { metadata: { sourceTime: projectSkillSourceTime(item.metadata.sourceTime) } } : {}) })) };
}
function compactSkillInvocation(item) {
  return { agentId: text(item?.agentId ?? item?.agent_id, 160), turnId: text(item?.turnId ?? item?.turn_id, 160),
    observationId: observationId(item?.observationId),
    source: text(item?.source, 120), sourceLine: sourceLine(item?.sourceLine ?? item?.source_line),
    skillName: text(item?.skillName ?? item?.skill_name, 200), skillId: text(item?.skillId ?? item?.skill_id, 240),
    scope: text(item?.scope, 80), origin: text(item?.origin, 80), pluginId: text(item?.pluginId ?? item?.plugin_id, 200),
    provider: text(item?.provider, 200), invocationType: text(item?.invocationType ?? item?.invocation_type, 40),
    resolution: text(item?.resolution ?? item?.attribution, 80), reason: text(item?.reason, 160),
    timestampNs: text(item?.timestampNs ?? item?.timestamp_ns, 40),
    ...(projectSkillSourceTime(item?.sourceTime) ? { sourceTime: projectSkillSourceTime(item.sourceTime) } : {}),
    candidateSkillIds: bounded(item?.candidateSkillIds ?? item?.candidate_skill_ids, 20).map(value => text(value, 240)) };
}
function compactToolInvocation(item) {
  return { agentId: text(item?.agentId ?? item?.agent_id, 160), turnId: text(item?.turnId ?? item?.turn_id, 160),
    itemId: text(item?.itemId ?? item?.item_id, 160), kind: text(item?.kind, 80),
    serverName: text(item?.serverName ?? item?.server_name ?? item?.server, 200), pluginId: text(item?.pluginId ?? item?.plugin_id, 200),
    ...(item?.kind === 'command' && (item?.pluginId ?? item?.plugin_id) && safePluginScriptPath(item?.scriptPath)
      ? { scriptPath: item.scriptPath } : {}),
    namespace: text(item?.namespace, 200), toolName: text(item?.toolName ?? item?.tool_name ?? item?.tool, 200),
    status: text(item?.status, 80), success: typeof item?.success === 'boolean' ? item.success : null,
    durationMs: finite(item?.durationMs ?? item?.duration_ms), startedAtMs: finite(item?.startedAtMs ?? item?.started_at_ms),
    completedAtMs: finite(item?.completedAtMs ?? item?.completed_at_ms),
    observedStartedAtMs: finite(item?.observedStartedAtMs ?? item?.observed_started_at_ms),
    observedCompletedAtMs: finite(item?.observedCompletedAtMs ?? item?.observed_completed_at_ms),
    observedElapsedMs: finite(item?.observedElapsedMs ?? item?.observed_elapsed_ms),
    exitCode: Number.isSafeInteger(item?.exitCode ?? item?.exit_code) && (item?.exitCode ?? item?.exit_code) >= -2147483648 && (item?.exitCode ?? item?.exit_code) <= 2147483647 ? item?.exitCode ?? item?.exit_code : null,
    failed: typeof item?.failed === 'boolean' ? item.failed : typeof item?.error === 'boolean' ? item.error : null,
    failureReason: text(item?.failureReason ?? item?.failure_reason, 160), source: text(item?.source, 120),
    sourceLine: sourceLine(item?.sourceLine ?? item?.source_line) };
}
function compactSkillDiagnostics(value) {
  const diagnostics = obj(value), transport = obj(diagnostics.transport), journal = obj(diagnostics.journal), missingness = obj(diagnostics.missingness);
  const agentRows = Array.isArray(missingness.byAgent) ? missingness.byAgent.slice(0, 160).map(agent => [agent?.agentId, agent])
    : Object.entries(obj(missingness.byAgent)).slice(0, 160);
  const result = { transport: { status: text(transport.status, 80), receivedBytes: finite(transport.receivedBytes), rejectedRequests: finite(transport.rejectedRequests),
      warnings: bounded(transport.warnings, 30).map(item => text(typeof item === 'string' ? item : item?.code ?? item?.kind, 120)) },
    journal: projectTelemetryJournal(journal) ?? { status: text(journal.status, 80), mode: 'unknown', format: null,
      commit: 'unknown', bytes: finite(journal.bytes), eventCount: finite(journal.eventCount), committedBytes: null, committedEvents: null, uncertainBytes: null },
    missingness: { byAgent: agentRows.map(([agentId, agent]) => ({ agentId: text(agent?.agentId ?? agentId, 160),
      origins: Object.fromEntries(Object.entries(obj(agent?.origins ?? agent)).slice(0, 30).map(([origin, item]) => [text(origin, 120), {
        catalogCount: finite(item?.catalogCount), invocationCount: finite(item?.invocationCount),
        status: text(item?.status, 80), reason: text(item?.reason, 160) }])) })),
      byAgentOmitted: Math.max(0, (Array.isArray(missingness.byAgent) ? missingness.byAgent.length : Object.keys(obj(missingness.byAgent)).length) - 160) + (finite(missingness.byAgentOmitted) ?? 0) } };
  if (Object.hasOwn(diagnostics, 'deliveryAccounting')) result.deliveryAccounting = projectDeliveryAccounting(diagnostics.deliveryAccounting);
  return result;
}
function compactUsageCoverage(value) {
  const usage = obj(value), byAgent = obj(usage.byAgent ?? value), fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens'];
  const safeCount = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const compactFieldGroup = group => Object.fromEntries(fields.map(field => {
    const row = obj(group?.[field]); return [field, { present: safeCount(row.present), missing: safeCount(row.missing), invalid: safeCount(row.invalid) }];
  }));
  return { observations: safeCount(usage.observations), attributed: safeCount(usage.attributed), continuity: text(usage.continuity, 80),
    byAgent: Object.fromEntries(Object.entries(byAgent).slice(0, 160).map(([agentId, row]) => [text(agentId, 160), {
      observations: safeCount(row?.observations), accepted: safeCount(row?.accepted), duplicates: safeCount(row?.duplicates),
      regressed: safeCount(row?.regressed), resets: safeCount(row?.resets), inconsistent: safeCount(row?.inconsistent), invalid: safeCount(row?.invalid),
      fields: { last: compactFieldGroup(row?.fields?.last), total: compactFieldGroup(row?.fields?.total),
        modelContextWindow: { present: safeCount(row?.fields?.modelContextWindow?.present), missing: safeCount(row?.fields?.modelContextWindow?.missing), invalid: safeCount(row?.fields?.modelContextWindow?.invalid) } } }])),
    byAgentOmitted: Math.max(0, Object.keys(byAgent).length - 160) + (Number.isSafeInteger(usage.byAgentOmitted) ? usage.byAgentOmitted : 0) };
}
function validWorkflowAccounting(accounting) {
  const expected = nativeUsageAccounting(accounting?.version);
  return Boolean(expected && Object.entries(expected).every(([key, value]) => accounting?.[key] === value));
}
function compactWorkflowUsage(workflow) {
  if (!workflow || typeof workflow !== 'object') return null;
  const derivation = obj(workflow.derivation);
  const values = Object.fromEntries(USAGE_FIELDS.map(field => [field,
    Number.isSafeInteger(workflow.values?.[field]) && workflow.values[field] >= 0 ? workflow.values[field] : null]));
  const fields = Object.fromEntries(USAGE_FIELDS.map(field => {
    const row = obj(workflow.fields?.[field]);
    return [field, { status: text(row.status, 40), contributingAgents: Number.isSafeInteger(row.contributingAgents) ? row.contributingAgents : null,
      agentCount: Number.isSafeInteger(row.agentCount) ? row.agentCount : null }];
  }));
  return { status: text(workflow.status, 40), scope: text(workflow.scope, 80), reason: text(workflow.reason, 120),
    derivation: Object.keys(derivation).length ? { method: text(derivation.method, 100), basis: text(derivation.basis, 100),
      agents: Number.isSafeInteger(derivation.agents) && derivation.agents >= 0 ? derivation.agents : null,
      turns: Number.isSafeInteger(derivation.turns) && derivation.turns >= 0 ? derivation.turns : null,
      observations: Number.isSafeInteger(derivation.observations) && derivation.observations >= 0 ? derivation.observations : null } : null,
    revalidation: text(workflow.revalidation, 80), values, fields };
}
function compactWorkflowAccounting(accounting) {
  if (!accounting || typeof accounting !== 'object') return null;
  const verified = nativeUsageAccounting(accounting.version);
  if (verified && Object.entries(verified).every(([key, value]) => accounting[key] === value)) return verified;
  return { contract: text(accounting.contract, 100), version: text(accounting.version, 100), historyMode: text(accounting.historyMode, 40),
    freshThread: typeof accounting.freshThread === 'boolean' ? accounting.freshThread : null,
    childCountersStartAtZero: typeof accounting.childCountersStartAtZero === 'boolean' ? accounting.childCountersStartAtZero : null,
    sourceRevision: text(accounting.sourceRevision, 80) };
}
const HOOK_ENUMS = Object.freeze({
  eventName: new Set(['preToolUse', 'permissionRequest', 'postToolUse', 'preCompact', 'postCompact', 'sessionStart', 'sessionEnd', 'userPromptSubmit', 'subagentStart', 'subagentStop', 'stop', 'interrupt']),
  scope: new Set(['thread', 'turn']), sourceKind: new Set(['system', 'user', 'project', 'mdm', 'sessionFlags', 'plugin', 'cloudRequirements', 'cloudManagedConfig', 'legacyManagedConfigFile', 'legacyManagedConfigMdm', 'unknown']),
  handlerType: new Set(['command', 'mcpTool', 'prompt', 'agent']), executionMode: new Set(['sync', 'async']),
  status: new Set(['running', 'completed', 'failed', 'blocked', 'stopped']),
});
const safeHookId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : null;
function compactHookInvocation(item) {
  const source = text(item?.source, 96);
  const row = { agentId: safeHookId(item?.agentId ?? item?.agent_id), turnId: item?.turnId == null && item?.turn_id == null ? null : safeHookId(item?.turnId ?? item?.turn_id),
    hookRunId: safeHookId(item?.hookRunId ?? item?.hook_run_id),
    ...(Number.isSafeInteger(item?.occurrenceIndex) && item.occurrenceIndex >= 0 ? { occurrenceIndex: item.occurrenceIndex } : {}),
    eventName: HOOK_ENUMS.eventName.has(item?.eventName ?? item?.event_name) ? item.eventName ?? item.event_name : null,
    scope: HOOK_ENUMS.scope.has(item?.scope) ? item.scope : null,
    sourceKind: HOOK_ENUMS.sourceKind.has(item?.sourceKind ?? item?.source_kind) ? item.sourceKind ?? item.source_kind : 'unknown',
    handlerType: HOOK_ENUMS.handlerType.has(item?.handlerType ?? item?.handler_type) ? item.handlerType ?? item.handler_type : null,
    executionMode: HOOK_ENUMS.executionMode.has(item?.executionMode ?? item?.execution_mode) ? item.executionMode ?? item.execution_mode : null,
    status: HOOK_ENUMS.status.has(item?.status) ? item.status : null,
    startedAtSeconds: Number.isSafeInteger(item?.startedAtSeconds ?? item?.started_at_seconds) && (item?.startedAtSeconds ?? item?.started_at_seconds) >= 0 ? item.startedAtSeconds ?? item.started_at_seconds : null,
    completedAtSeconds: Number.isSafeInteger(item?.completedAtSeconds ?? item?.completed_at_seconds) && (item?.completedAtSeconds ?? item?.completed_at_seconds) >= 0 ? item.completedAtSeconds ?? item.completed_at_seconds : null,
    durationMs: Number.isSafeInteger(item?.durationMs ?? item?.duration_ms) && (item?.durationMs ?? item?.duration_ms) >= 0 ? item.durationMs ?? item.duration_ms : null,
    source: source && (/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(source) || ['hook/started', 'hook/completed', 'native-rollout'].includes(source)) ? source : null,
    sourceLine: sourceLine(item?.sourceLine ?? item?.source_line) };
  // Keep only rows whose identity and lifecycle dimensions are safe to compare.
  return row.agentId && row.hookRunId && row.eventName && row.scope && row.handlerType && row.executionMode ? row : null;
}
function compactTurnUsage(run) {
  const summary = run?.usage?.turns;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const accounting = nativeUsageAccounting(run?.usage?.accounting?.version);
  const summaryContract = summary.contract;
  const source = run?.source;
  if (!accounting || !Object.entries(accounting).every(([key, value]) => run.usage.accounting?.[key] === value)
    || !Object.entries(accounting).every(([key, value]) => summaryContract?.[key] === value)
    || source?.kind !== 'native-app-server-v2' || source?.version !== accounting.version
    || source?.historyMode !== 'paginated' || source?.freshThread !== true
    || summary.scope !== 'captured-owned-thread-turns' || !['complete', 'partial', 'unavailable'].includes(summary.status)) return null;
  const rows = bounded(summary.turns, 1000).map(turn => ({ agentId: safeHookId(turn?.agentId), turnId: safeHookId(turn?.turnId),
    status: ['complete', 'partial'].includes(turn?.status) ? turn.status : 'unavailable',
    values: compactTokenCounters(turn?.values),
    fields: Object.fromEntries(USAGE_FIELDS.map(field => { const item = obj(turn?.fields?.[field]);
      return [field, { status: ['observed', 'partial', 'unavailable', 'invalid'].includes(item.status) ? item.status : 'unavailable', reason: text(item.reason, 100) }]; })),
    baseline: compactTokenCounters(turn?.baseline),
    derivation: { method: text(turn?.derivation?.method, 100), initialBaseline: ['verified-fresh-thread-zero', 'prior-terminal-boundary'].includes(turn?.derivation?.initialBaseline) ? turn.derivation.initialBaseline : null,
      sourceObservations: bounded(turn?.derivation?.sourceObservations, 8).map(row => ({ source: text(row?.source, 120), sourceLine: sourceLine(row?.sourceLine) })),
      sourceObservationsOmitted: Math.max(0, list(turn?.derivation?.sourceObservations).length - 8)
        + (Number.isSafeInteger(turn?.derivation?.sourceObservationsOmitted) && turn.derivation.sourceObservationsOmitted > 0 ? turn.derivation.sourceObservationsOmitted : 0) } }))
    .filter(turn => turn.agentId && turn.turnId);
  const removed = Math.max(0, list(summary.turns).length - rows.length) + (Number.isSafeInteger(summary.turnsOmitted) && summary.turnsOmitted > 0 ? summary.turnsOmitted : 0);
  const sourceObservationsOmitted = rows.reduce((sum, row) => sum + row.derivation.sourceObservationsOmitted, 0);
  const derivation = obj(summary.derivation);
  return { status: summary.status, scope: summary.scope, reason: text(summary.reason, 120), contract: accounting,
    turns: rows, turnsOmitted: removed, revalidation: removed || sourceObservationsOmitted > 0
      ? 'detail-omitted-after-precomputation' : text(summary.revalidation, 80),
    derivation: { method: text(derivation.method, 100), basis: text(derivation.basis, 100),
      agents: Number.isSafeInteger(derivation.agents) && derivation.agents >= 0 ? derivation.agents : null,
      turns: Number.isSafeInteger(derivation.turns) && derivation.turns >= 0 ? derivation.turns : null,
      observations: Number.isSafeInteger(derivation.observations) && derivation.observations >= 0 ? derivation.observations : null } };
}
function eligibleWorkflowUsage(run) {
  const workflow = compactWorkflowUsage(run?.usage?.workflow);
  if (!workflow || !validWorkflowAccounting(run?.usage?.accounting) || workflow.scope !== 'captured-workflow-agents' ||
      run?.source?.kind !== 'native-app-server-v2' || run?.source?.version !== run?.usage?.accounting?.version ||
      run?.source?.historyMode !== 'paginated' || run?.source?.freshThread !== true ||
      !['complete', 'partial'].includes(workflow.status)) return null;
  return workflow;
}
function compactRecordedUsage(run, source) {
  const accounting = recordedUsageAccounting(source?.clientVersion);
  if (source?.kind !== 'native-rollout' || !accounting) return null;
  const raw = run?.usage?.recorded;
  if (!raw || typeof raw !== 'object') return deriveRecordedUsage({ rootAgentId: source.nativeSessionId, threads: [], source });
  return projectRunRecordedUsage(run);
}
function compactRecordedAgentSource(source) {
  if (!source || typeof source !== 'object' || source.kind !== 'native-rollout') return null;
  const result = { kind: source.kind };
  if (typeof source.nativeSessionId === 'string' && source.nativeSessionId.length <= 128) result.nativeSessionId = source.nativeSessionId;
  if (typeof source.clientVersion === 'string' && source.clientVersion.length <= 128) result.clientVersion = source.clientVersion;
  if (source.fingerprintScope === 'source-snapshot') result.fingerprintScope = source.fingerprintScope;
  if (typeof source.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(source.fingerprint)) result.fingerprint = source.fingerprint;
  for (const key of ['bytes', 'fileBytes']) if (Number.isSafeInteger(source[key]) && source[key] >= 0) result[key] = source[key];
  return result;
}
function compactAcceptance(value) {
  if (!value || typeof value !== 'object') return null;
  const numeric = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const requirements = obj(value.requirements), usage = obj(requirements.usage);
  const skills = rows => bounded(rows, 50).map(item => ({ agent: text(item?.agent, 40), name: text(item?.name, 160), origin: text(item?.origin, 40),
    invocationType: text(item?.invocationType, 40), min: numeric(item?.min) }));
  const tools = rows => bounded(rows, 50).map(item => ({ agent: text(item?.agent, 40), kind: text(item?.kind, 40), server: text(item?.server, 160),
    ...(item?.pluginId ? { pluginId: text(item.pluginId, 160) } : {}),
    ...(safePluginScriptPath(item?.scriptPath) ? { scriptPath: item.scriptPath } : {}),
    tool: text(item?.tool, 160), min: numeric(item?.min) }));
  const hooks = rows => bounded(rows, 50).map(item => ({ agent: text(item?.agent, 40),
    ...(HOOK_ENUMS.eventName.has(item?.eventName) ? { eventName: item.eventName } : {}),
    ...(HOOK_ENUMS.sourceKind.has(item?.sourceKind) ? { sourceKind: item.sourceKind } : {}),
    ...(HOOK_ENUMS.scope.has(item?.scope) ? { scope: item.scope } : {}),
    ...(HOOK_ENUMS.status.has(item?.status) ? { status: item.status } : {}), min: numeric(item?.min) }));
  const rawContextChecks = list(value.checks).filter(item => typeof item?.id === 'string' && item.id.startsWith('context:'));
  const contextIdsValid = Array.isArray(requirements.context) && rawContextChecks.length === requirements.context.length
    && rawContextChecks.every((item, index) => item.id === `context:${index}`);
  const contextSubsetStatus = rawContextChecks.length && rawContextChecks.every(item => item.status === 'passed'
    && list(item.checks).every(actor => actor?.reason === null)) ? 'passed' : 'failed';
  const context = requirements.context === undefined ? null : compactRequiredContext({
    requirements: requirements.context,
    checks: rawContextChecks.map(item => ({ ...item,
      selector: item.selector ?? requirements.context[Number(item.id.slice('context:'.length))] })),
    status: contextSubsetStatus,
  });
  if (context) {
    let actorChecksOmitted = 0;
    for (const item of context.checks) {
      const source = list(value.checks).find(check => check?.id === item.id);
      const omitted = item.omittedActorChecks ?? Math.max(0, list(source?.checks).length - item.checks.length);
      if (omitted) {
        item.checksOmitted = omitted;
        actorChecksOmitted += omitted;
      }
    }
    if (actorChecksOmitted) {
      context.status = 'failed';
      context.malformed = true;
    }
    if (context.malformed) for (const item of context.checks) {
      item.status = 'failed';
      item.reason = 'malformed-context-check';
    }
    context.omittedChecks += actorChecksOmitted;
  }
  const checks = bounded(value.checks, 200).map(item => {
    const selector = obj(item?.selector);
    const id = text(item?.id, 160);
    const contextCheck = typeof id === 'string' && (id.startsWith('context:') || selector.context === true);
    const safeContextCheck = contextCheck && contextIdsValid ? context?.checks.find(check => check.id === id) : null;
    const safeContextSelector = context?.malformed === true ? undefined : safeContextCheck?.selector;
    return { id, status: contextCheck ? (safeContextCheck?.selector ? safeContextCheck.status : 'failed') : text(item?.status, 80), reason: text(item?.reason, 160),
      required: numeric(item?.required), observed: numeric(item?.observed), observations: numeric(item?.observations),
      agentId: text(item?.agentId, 160), turnId: text(item?.turnId, 160),
      missingFields: bounded(item?.missingFields, 6).map(field => text(field, 60)),
      selector: contextCheck ? safeContextSelector
        : Object.keys(selector).length ? { agent: text(selector.agent, 40), name: text(selector.name, 160), origin: text(selector.origin, 40),
        ...(selector.pluginId ? { pluginId: text(selector.pluginId, 160) } : {}),
        ...(safePluginScriptPath(selector.scriptPath) ? { scriptPath: selector.scriptPath } : {}),
        invocationType: text(selector.invocationType, 40), kind: text(selector.kind, 40), server: text(selector.server, 160), tool: text(selector.tool, 160),
        ...(HOOK_ENUMS.eventName.has(selector.eventName) ? { eventName: selector.eventName } : {}),
        ...(HOOK_ENUMS.sourceKind.has(selector.sourceKind) ? { sourceKind: selector.sourceKind } : {}),
        ...(HOOK_ENUMS.scope.has(selector.scope) ? { scope: selector.scope } : {}),
        ...(HOOK_ENUMS.status.has(selector.status) ? { status: selector.status } : {}), min: numeric(selector.min) } : null,
      ...(contextCheck ? { status: context?.malformed !== true && safeContextCheck?.selector ? safeContextCheck.status : 'failed', reason: context?.malformed !== true && safeContextCheck?.selector ? safeContextCheck.reason : 'malformed-context-check',
        checks: safeContextCheck?.checks ?? [], ...(safeContextCheck?.checksOmitted ? { checksOmitted: safeContextCheck.checksOmitted } : {}) } : {}) };
  });
  const row = { schemaVersion: numeric(value.schemaVersion), mode: text(value.mode, 80), status: context?.status === 'failed' ? 'failed' : text(value.status, 80),
    requirements: { minAgents: numeric(requirements.minAgents), usage: Object.keys(usage).length ? { agents: text(usage.agents, 40),
      fields: bounded(usage.fields, 6).map(field => text(field, 60)), minTurns: numeric(usage.minTurns), wholeTurns: usage.wholeTurns === true } : null,
      skills: skills(requirements.skills), tools: tools(requirements.tools), hooks: hooks(requirements.hooks),
      ...(context ? { context: context.requirements } : {}) }, checks,
    ...(context ? { contextStatus: context.status, contextOmittedRequirements: context.omittedRequirements,
      contextOmittedChecks: context.omittedChecks } : {}),
    checksOmitted: Math.max(0, list(value.checks).length - checks.length) + (numeric(value.checksOmitted) ?? 0),
    exhaustiveConsumption: typeof value.exhaustiveConsumption === 'boolean' ? value.exhaustiveConsumption : text(value.exhaustiveConsumption, 100),
    boundary: text(value.boundary, 500) };
  return row;
}

function pick(value, keys) {
  const source = obj(value), result = {};
  for (const key of keys) if (source[key] !== undefined) result[key] = source[key];
  return result;
}

function compactComparisonConditions(value) {
  const source = obj(value);
  const fingerprint = item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item) ? item : null;
  const safeLabels = (rows, limit = 50) => bounded(rows, limit).filter(item => typeof item === 'string'
    && item.length <= 160 && /^[\p{L}\p{N}][\p{L}\p{N} ._:+-]*$/u.test(item));
  const environment = obj(source.environment);
  const baseline = obj(source.baseline);
  const taskId = typeof source.taskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(source.taskId) ? source.taskId : null;
  const editableFiles = bounded(source.editableFiles, 64).filter(path => typeof path === 'string'
    && path.length <= 240 && !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every(part => part && part !== '.' && part !== '..'));
  const checkRecipes = bounded(source.checkRecipes, 20).map(row => ({
    name: typeof row?.name === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._:+-]{0,199}$/u.test(row.name) ? row.name : null,
    fingerprint: fingerprint(row?.fingerprint),
  }));
  return { schemaVersion: source.schemaVersion === 1 ? 1 : null,
    taskFingerprint: fingerprint(source.taskFingerprint), ...(taskId ? { taskId } : {}),
    ...(Array.isArray(source.editableFiles) ? { editableFiles } : {}), checkRecipes,
    qualityFingerprint: fingerprint(source.qualityFingerprint),
    setupFingerprint: fingerprint(source.setupFingerprint), selectedSkills: source.selectedSkills === null ? null : safeLabels(source.selectedSkills),
    variables: source.variables === null ? null : safeLabels(source.variables, 20), profileOrder: safeLabels(source.profileOrder, 8),
    trialIndex: Number.isSafeInteger(source.trialIndex) && source.trialIndex >= 0 && source.trialIndex <= 19 ? source.trialIndex : null,
    environment: Object.fromEntries(['platform', 'architecture', 'nodeVersion', 'settings', 'cache', 'integrations', 'epoch']
      .filter(key => environment[key] !== undefined).map(key => [key, typeof environment[key] === 'string'
        && environment[key].length <= 120 && /^[\w .:+-]+$/.test(environment[key]) ? environment[key] : null])),
    baseline: { commit: typeof baseline.commit === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,199}$/.test(baseline.commit) ? baseline.commit : null,
      tree: typeof baseline.tree === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,199}$/.test(baseline.tree) ? baseline.tree : null },
    ...(fingerprint(source.recipeFingerprint) ? { recipeFingerprint: source.recipeFingerprint } : {}) };
}

function compactRun(run) {
  // Freeze the small comparison support graph while all source bindings are still present.
  // It is deliberately independent from the larger, lossy detail projection below.
  const comparisonEvidence = freezeAuditComparisonEvidence(run);
  const usage = obj(run.usage), source = obj(run.source);
  const rootId = source.threadId ?? list(run.agents).find(agent => agent.parentId == null && Number(agent.depth ?? 0) === 0)?.id;
  const byAgentRows = list(usage.byAgent), rootAgentUsage = obj(byAgentRows.find(item => item.agentId === rootId));
  const agentUsage = obj(usage[rootId]);
  const rootTotalsEnvelope = obj(rootAgentUsage.totals);
  const rootUsage = obj(agentUsage.total ?? (agentUsage.totals?.values ?? null)
    ?? rootAgentUsage.total ?? rootTotalsEnvelope.values ?? (usage.rootAgentId === rootId ? usage.counters : null));
  const rootUsageScope = agentUsage.scope ?? agentUsage.totals?.scope ?? rootAgentUsage.scope ?? rootTotalsEnvelope.scope ?? null;
  const rootCounters = compactCounters(rootUsage);
  const metrics = {};
  for (const key of ['processElapsedMs', 'wallMs', 'setupMs', 'taskMs', 'captureMs', 'checksMs', 'totalMs', 'recordedSpanMs']) {
    const n = finite(run.metrics?.[key]); if (n !== null) metrics[key] = n;
  }
  if (['source-recorded-span', 'owned-turn-evidence'].includes(run.metrics?.recordedSpanKind))
    metrics.recordedSpanKind = run.metrics.recordedSpanKind;
  for (const [key, value] of Object.entries(rootCounters)) if (finite(value) !== null) metrics[`root.${key}`] = value;
  const workflow = compactWorkflowUsage(usage.workflow);
  const turnsUsage = compactTurnUsage(run);
  const recordedUsage = compactRecordedUsage(run, source);
  const eligibleWorkflow = eligibleWorkflowUsage(run);
  if (eligibleWorkflow) for (const [field, value] of Object.entries(eligibleWorkflow.values)) if (value !== null) metrics[`workflow.${field}`] = value;
  const execution = pick(run.execution, ['status', 'exitCode', 'signal', 'elapsedMs']);
  const usageScope = Object.keys(rootUsage).length ? 'root-agent-source-reported' : null;
  const priorOmitted = key => finite(run.evidenceBounds?.omitted?.[key]) ?? 0;
  const profile = obj(run.profile), outcome = obj(run.outcome), task = obj(run.task ?? outcome.task);
  const turns = bounded(run.turns, 1000).map(turn => ({ ...pick(turn, ['agentId', 'turnId', 'status', 'model', 'reasoningEffort']),
    ...(text(turn?.observedStartedAt ?? turn?.observed_started_at, 80) ? { observedStartedAt: text(turn?.observedStartedAt ?? turn?.observed_started_at, 80) } : {}),
    ...(text(turn?.observedCompletedAt ?? turn?.observed_completed_at, 80) ? { observedCompletedAt: text(turn?.observedCompletedAt ?? turn?.observed_completed_at, 80) } : {}),
    ...(text(turn?.source, 120) ? { source: text(turn?.source, 120) } : {}), sourceLine: sourceLine(turn?.sourceLine ?? turn?.source_line) }));
  const allAgentRows = Array.isArray(usage.byAgent) ? usage.byAgent.map(value => [value.agentId, value]).filter(([, value]) => usageAgentEntry(value))
    : Object.entries(usage).filter(([key, value]) => !['observations', 'rootAgentId', 'counters', 'totals', 'status', 'byAgent', 'scope', 'observationsOmitted', 'byAgentOmitted', 'coverage', 'assessment'].includes(key) && usageAgentEntry(value));
  const rawAgentRows = allAgentRows.slice(0, 160);
  const agentRows = rawAgentRows.filter(([, value]) => usageAgentEntry(value));
  const usageAgents = agentRows.map(([agentId, value]) => ({ agentId: text(agentId ?? value.agentId, 160), mode: text(value.mode, 60),
    snapshots: Number.isSafeInteger(value.snapshots) ? value.snapshots : null,
    scope: text(value.scope ?? value.totals?.scope, 100),
    last: compactCounters(value.last), total: compactCounters(value.total ?? value.totals?.values ?? (agentId === rootId ? value : null)),
    contextWindow: finite(value.modelContextWindow ?? value.contextWindow ?? value.model_context_window) }));
  const usageObservations = bounded(usage.observations, 500).map(compactUsageObservation);
  const skills = bounded(run.skills ?? run.catalog, 160).map(compactSkill);
  const skillInvocations = bounded(run.skillInvocations ?? run.skill_invocations, 500).map(compactSkillInvocation);
  const toolInvocations = bounded(run.toolInvocations ?? run.tool_invocations, 500).map(compactToolInvocation);
  const mcpServers = bounded(run.mcp?.servers ?? run.mcpServers, 160).map(item => ({ name: text(item?.name ?? item?.serverName ?? item?.server, 200),
    pluginId: text(item?.pluginId ?? item?.plugin_id, 200), status: text(item?.status, 80), failureReason: text(item?.failureReason ?? item?.failure_reason, 160),
    source: text(item?.source, 120), sourceLine: sourceLine(item?.sourceLine ?? item?.source_line) }));
  const skillTelemetry = obj(run.skillTelemetry);
  const knownAgentIds = new Set(list(run.agents).map(agent => agent?.id).filter(value => typeof value === 'string'));
  const ownedInstructionRows = list(run.instructionSources).filter(row => knownAgentIds.has(row?.agentId));
  const unownedInstructionRows = Math.max(0, list(run.instructionSources).length - ownedInstructionRows.length);
  const instructionSources = compactInstructionSources(ownedInstructionRows, { maxAgents: 160, maxSources: 64 });
  const hasMissingInstructionAgent = list(run.agents).some(agent => !ownedInstructionRows.some(row => row.agentId === agent?.id));
  const hasKnownInstructionEvidence = instructionSources.rows.some(row => row.status !== 'unavailable');
  const instructionCoverage = run.coverage?.instructions === 'unavailable' || !hasKnownInstructionEvidence ? 'unavailable'
    : run.coverage?.instructions === 'partial' || instructionSources.status === 'partial' || hasMissingInstructionAgent || unownedInstructionRows ? 'partial'
      : run.coverage?.instructions === 'observed' || instructionSources.status === 'observed' ? 'observed' : 'unavailable';
  const resourceProvenance = projectResourceProvenance(run.resourceProvenance);
  const coverage = { ...obj(run.coverage), instructions: instructionCoverage,
    ...(Object.hasOwn(run.coverage ?? {}, 'resourceProvenance') || (Object.hasOwn(run, 'resourceProvenance') && resourceProvenance.status !== 'unavailable')
      ? { resourceProvenance: resourceProvenance.status } : {}) };
  if (instructionSources.omittedAgents || instructionSources.omittedSources || unownedInstructionRows) coverage.instructions = 'partial';
  if (list(run.toolInvocations ?? run.tool_invocations).length > toolInvocations.length || priorOmitted('toolInvocations')) {
    coverage.tools = 'partial'; coverage.mcp = 'partial';
  }
  if (list(run.mcp?.servers ?? run.mcpServers).length > mcpServers.length || priorOmitted('mcpServers')) coverage.mcp = 'partial';
  const rawHooks = list(run.hookInvocations ?? run.hook_invocations);
  const hookInvocations = bounded(rawHooks, 500).map(compactHookInvocation).filter(Boolean);
  const hookInvalidOrOmitted = Math.max(0, rawHooks.length - hookInvocations.length) + priorOmitted('hookInvocations');
  const usageSourceDetailsOmitted = list(usage.observations).length > usageObservations.length || priorOmitted('usageObservations') > 0
    || allAgentRows.length > usageAgents.length || priorOmitted('usageAgents') > 0
    || list(run.turns).length > turns.length || priorOmitted('turns') > 0
    || list(run.agents).length > bounded(run.agents, 160).length || priorOmitted('agents') > 0;
  if (usageSourceDetailsOmitted) {
    if (workflow) workflow.revalidation = 'detail-omitted-after-precomputation';
    if (turnsUsage) turnsUsage.revalidation = 'source-detail-omitted-after-precomputation';
  }
  if (hookInvalidOrOmitted > 0) coverage.hooks = 'partial';
  if (rawHooks.length > hookInvocations.length && rawHooks.length > 0) coverage.hooks = 'partial';
  const projectedRun = {
    id: run.id ?? null, profileId: run.profileId ?? profile.profileId ?? profile.id ?? null,
    profileName: run.profileName ?? profile.profileName ?? profile.name ?? null,
    ...(nativeConfigOf(run.nativeConfig ?? profile.nativeConfig) !== undefined
      ? { nativeConfig: nativeConfigOf(run.nativeConfig ?? profile.nativeConfig) } : {}),
    source: { ...pick(source, ['kind', 'threadId', 'version', 'clientVersion', 'nativeSessionId', 'bytes', 'fileBytes', 'fingerprintScope', 'historyMode', 'freshThread', 'model', 'reasoningEffort', 'persistence']),
      ...(text(source.provider, 80) ? { provider: text(source.provider, 80) } : {}),
      ...(text(source.client, 40) ? { client: text(source.client, 40) } : {}),
      ...(text(source.clientEvidence, 80) ? { clientEvidence: text(source.clientEvidence, 80) } : {}),
      ...(text(source.originator, 128) ? { originator: text(source.originator, 128) } : {}),
      ...(source.recordedSetup && typeof source.recordedSetup === 'object' ? { recordedSetup: {
        status: ['observed', 'partial', 'unavailable'].includes(source.recordedSetup.status) ? source.recordedSetup.status : 'unavailable',
        source: text(source.recordedSetup.source, 80),
        model: bounded(source.recordedSetup.model, 20).map(value => text(value, 160)).filter(Boolean),
        effort: bounded(source.recordedSetup.effort, 20).map(value => text(value, 160)).filter(Boolean),
        fullHistoricalSetup: ['observed', 'partial', 'unavailable'].includes(source.recordedSetup.fullHistoricalSetup)
          ? source.recordedSetup.fullHistoricalSetup : 'unavailable' } } : {}),
      ...(typeof source.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(source.fingerprint) ? { fingerprint: source.fingerprint } : {}),
      ...(source.observationMode === 'saved-native-wire-replay' ? { observationMode: source.observationMode,
        rawNativeWireSha256: typeof source.rawNativeWireSha256 === 'string' && /^[a-f0-9]{64}$/.test(source.rawNativeWireSha256) ? source.rawNativeWireSha256 : null,
        sourceReceipt: text(source.sourceReceipt, 200) } : {}) },
    sourceWorkspace: { ...pick(run.sourceWorkspace, ['sourceCommit', 'sourceTree']) },
    model: run.model ?? source.model ?? run.configuration?.model ?? null,
    status: run.status ?? run.outcome?.nativeTurnStatus ?? execution.status ?? 'unknown', execution,
    metrics, usage: { scope: usageScope, sourceScope: text(rootUsageScope, 120), status: run.coverage?.usage ?? usage.status ?? null, rootAgentId: rootId ?? null,
      accounting: compactWorkflowAccounting(usage.accounting), workflow, turns: turnsUsage, ...(recordedUsage ? { recorded: recordedUsage } : {}),
      counters: Object.fromEntries(Object.entries(rootCounters).filter(([, v]) => finite(v) !== null)),
      observations: usageObservations, observationsOmitted: Math.max(0, list(usage.observations).length - usageObservations.length) + (finite(usage.observationsOmitted) ?? priorOmitted('usageObservations')),
      byAgent: usageAgents, byAgentOmitted: Math.max(0, allAgentRows.length - usageAgents.length) + (finite(usage.byAgentOmitted) ?? 0) },
    outcome: { ...pick(outcome, ['status', 'nativeTurnStatus']), task: pick(task, ['nativeTurnStatus', 'status', 'processStatus', 'exitCode', 'nativeThreadId']) },
    task: pick(task, ['nativeTurnStatus', 'status', 'processStatus', 'exitCode', 'nativeThreadId']),
    turns,
    checks: canonicalAuditChecks(run),
    ...(run.sessionEvidence ? { sessionEvidence: projectAuditSessionEvidence(run) } : {}),
    ...(run.comparisonConditions && typeof run.comparisonConditions === 'object'
      ? { comparisonConditions: compactComparisonConditions(run.comparisonConditions) } : {}),
    ...(comparisonEvidence ? { comparisonEvidence } : {}),
    ...(comparisonEvidence?.nativeControls ? { nativeControls: comparisonEvidence.nativeControls } : {}),
    ...(run.reportProjection ? { reportProjection: pick(run.reportProjection,
      ['schemaVersion', 'mode', 'originalReportFingerprint', 'native', 'context', 'sourceAttestation', 'nativeSourceFingerprint']) } : {}),
    workspace: { taskEnd: compactWorkspace(run.workspace?.taskEnd ?? outcome.taskEndWorkspace ?? run.taskEnd),
      checkEnd: compactWorkspace(run.workspace?.checkEnd ?? run.finalWorkspace ?? outcome.finalWorkspace) },
    profileSettings: pick(run.profileSettings, ['status', 'beforeFingerprint', 'afterFingerprint', 'changedPaths']),
    runningClients: { status: run.runningClients?.status ?? null, beforeCount: count(run.runningClients?.before) ?? run.runningClients?.beforeCount ?? null, afterCount: count(run.runningClients?.after) ?? run.runningClients?.afterCount ?? null },
    coverage, instructionSources: instructionSources.rows, warnings: bounded(run.warnings, 40).map(x => typeof x === 'string' ? 'warning-recorded' : x?.code ?? 'unknown'),
    artifacts: bounded(run.artifacts, 40).map(item => pick(item, ['kind', 'status', 'id', 'fingerprint', 'files', 'captureComplete', 'timing'])),
    agents: bounded(run.agents, 160).map(agent => {
      const agentSource = compactRecordedAgentSource(agent?.source);
      return { ...pick(agent, ['id', 'parentId', 'sessionId', 'model', 'depth', 'reasoningEffort']),
        ...(typeof agent?.role === 'string' && agent.role.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(agent.role) ? { role: agent.role } : {}),
        ...(agentSource ? { source: agentSource } : {}),
        sourceLine: sourceLine(agent?.sourceLine ?? agent?.source_line) };
    }),
    skills, skillInvocations, toolInvocations, mcpServers,
    mcpInventory: ['not-requested', 'unavailable', 'unknown'].includes(run.mcp?.inventory ?? run.mcpInventory)
      ? run.mcp?.inventory ?? run.mcpInventory : 'unknown', hookInvocations,
    skillTelemetry: { status: text(skillTelemetry.status, 80), delivery: text(skillTelemetry.delivery, 80),
      capability: text(skillTelemetry.capability, 100), boundary: text(skillTelemetry.boundary, 200),
      enabled: typeof skillTelemetry.enabled === 'boolean' ? skillTelemetry.enabled : null,
      warnings: bounded(skillTelemetry.warnings, 30).map(item => text(typeof item === 'string' ? item : item?.code ?? item?.kind, 120)),
      diagnostics: compactSkillDiagnostics(skillTelemetry.diagnostics),
      diagnosticsLegacy: bounded(skillTelemetry.errors, 30).map(item => text(typeof item === 'string' ? item : item?.code ?? item?.kind, 120)) },
    captureAcceptance: compactAcceptance(run.captureAcceptance),
    capture: run.capture && typeof run.capture === 'object' ? { status: text(run.capture.status, 80), observer: run.capture.observer && typeof run.capture.observer === 'object' ? {
      savedSettingsChanged: typeof run.capture.observer.savedSettingsChanged === 'boolean' ? run.capture.observer.savedSettingsChanged : null,
      nativeSessionStorage: text(run.capture.observer.nativeSessionStorage, 100),
      transport: text(run.capture.observer.transport, 100),
      profileHomeUsedForReadOnlySettingsAndSkills: typeof run.capture.observer.profileHomeUsedForReadOnlySettingsAndSkills === 'boolean' ? run.capture.observer.profileHomeUsedForReadOnlySettingsAndSkills : null,
      runtime: Object.fromEntries(['sqlite', 'logs', 'temporaryFiles', 'threadPersistence', 'workspace'].filter(key => run.capture.observer.runtime?.[key] !== undefined)
        .map(key => [key, text(run.capture.observer.runtime[key], 100)])),
    } : null } : null,
    usageCoverage: compactUsageCoverage(run.capture?.coverageDetails?.usage ?? run.usageCoverage ?? usage.coverageByAgent),
    evidenceBounds: { usageObservations: 500, usageAgents: 160, turns: 1000, turnUsageRows: 1000, recordedThreads: 160, recordedResponseRecords: 2048, agents: 160, skills: 160, skillObservations: 100, skillInvocations: 500, toolInvocations: 500, mcpServers: 160, hookInvocations: 500, instructionAgents: 160, instructionSourcesPerAgent: 64, skillDiagnostics: 160, usageCoverageAgents: 160, captureAcceptanceChecks: 200,
      omitted: { usageObservations: Math.max(0, list(usage.observations).length - usageObservations.length) + (finite(usage.observationsOmitted) ?? priorOmitted('usageObservations')),
        usageAgents: Math.max(Math.max(0, allAgentRows.length - usageAgents.length) + (finite(usage.byAgentOmitted) ?? 0), priorOmitted('usageAgents')),
        turns: Math.max(0, list(run.turns).length - turns.length) + priorOmitted('turns'),
        agents: Math.max(0, list(run.agents).length - bounded(run.agents, 160).length) + priorOmitted('agents'),
        skills: Math.max(0, list(run.skills ?? run.catalog).length - skills.length) + priorOmitted('skills'),
        skillInvocations: Math.max(0, list(run.skillInvocations ?? run.skill_invocations).length - skillInvocations.length) + priorOmitted('skillInvocations'),
        toolInvocations: Math.max(0, list(run.toolInvocations ?? run.tool_invocations).length - toolInvocations.length) + priorOmitted('toolInvocations'),
        mcpServers: Math.max(0, list(run.mcp?.servers ?? run.mcpServers).length - mcpServers.length) + priorOmitted('mcpServers'),
        hookInvocations: hookInvalidOrOmitted,
        instructionAgents: Math.max(priorOmitted('instructionAgents'), unownedInstructionRows + instructionSources.omittedAgents),
        instructionSources: Math.max(priorOmitted('instructionSources'), instructionSources.omittedSources),
        turnUsageRows: turnsUsage ? turnsUsage.turnsOmitted : Math.max(0, list(usage.turns?.turns).length) + priorOmitted('turnUsageRows'),
        recordedThreads: Math.max(0, list(recordedUsage?.threads).length - 160) + priorOmitted('recordedThreads'),
        recordedResponseRecords: Math.max(0, list(recordedUsage?.threads).reduce((sum, thread) => sum + list(thread.records).length, 0) - 2048) + priorOmitted('recordedResponseRecords'),
        skillObservations: skills.reduce((sum, skill, i) => sum + Math.max(0, list((run.skills ?? run.catalog)?.[i]?.observations).length - list(skill.observations).length), 0) + priorOmitted('skillObservations'),
        skillDiagnostics: Math.max(0, compactSkillDiagnostics(skillTelemetry.diagnostics).missingness.byAgentOmitted, priorOmitted('skillDiagnostics')),
        usageCoverageAgents: Math.max(0, compactUsageCoverage(run.capture?.coverageDetails?.usage ?? run.usageCoverage ?? usage.coverageByAgent).byAgentOmitted, priorOmitted('usageCoverageAgents')),
        captureAcceptanceChecks: Math.max(0, compactAcceptance(run.captureAcceptance)?.checksOmitted ?? 0, priorOmitted('captureAcceptanceChecks')) } },
    counts: { catalog: count(run.catalog ?? (list(run.skills).length ? run.skills : null)) ?? run.counts?.catalog ?? null, invocations: count(run.skillInvocations) ?? run.counts?.invocations ?? null, tools: count(run.toolInvocations) ?? run.counts?.tools ?? null, mcp: count(run.mcp?.servers) ?? run.counts?.mcp ?? null,
      hooks: Number.isSafeInteger(run.counts?.hooks) && run.counts.hooks >= 0 ? run.counts.hooks : rawHooks.length },
    captureStatus: run.capture?.status ?? run.captureStatus ?? null,
    resourceProvenance,
  };
  if (recordedUsage) projectedRun.usage.recorded = projectRunRecordedUsage(projectedRun)
    ?? deriveRecordedUsage({ rootAgentId: projectedRun.source.nativeSessionId, threads: [], source: projectedRun.source });
  return projectedRun;
}
function boundFrozenTrialBytes(trial, maxBytes = 15 * 1024 * 1024) {
  maxBytes = Math.max(300 * 1024, Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 15 * 1024 * 1024);
  const bytes = () => new TextEncoder().encode(JSON.stringify(trial)).byteLength;
  const addOmitted = (run, key, amount) => {
    run.evidenceBounds.omitted[key] = (run.evidenceBounds.omitted[key] ?? 0) + amount;
    if (key === 'toolInvocations') { run.coverage.tools = 'partial'; run.coverage.mcp = 'partial'; }
    if (key === 'mcpServers') run.coverage.mcp = 'partial';
  };
  while (bytes() > maxBytes) {
    const slots = [];
    for (const run of trial.runs) {
      slots.push([run, 'usageObservations', run.usage.observations]);
      slots.push([run, 'usageAgents', run.usage.byAgent]);
      slots.push([run, 'hookInvocations', run.hookInvocations]);
      if (run.resourceProvenance?.resources?.length) slots.push([run, 'resourceProvenance', run.resourceProvenance.resources, 'provenance']);
      slots.push([run, 'instructionAgents', run.instructionSources]);
      for (const row of run.instructionSources) slots.push([run, 'instructionSources', row.sources, 'instruction-sources', row]);
      if (run.usage.turns) slots.push([run, 'turnUsageRows', run.usage.turns.turns, 'turn-usage']);
      for (const thread of list(run.usage.recorded?.threads)) slots.push([run, 'recordedResponseRecords', thread.records, 'recorded-responses', thread]);
      slots.push([run, 'turns', run.turns], [run, 'agents', run.agents], [run, 'skills', run.skills],
        [run, 'skillInvocations', run.skillInvocations], [run, 'toolInvocations', run.toolInvocations], [run, 'mcpServers', run.mcpServers]);
      for (const skill of run.skills) slots.push([run, 'skillObservations', skill.observations]);
      slots.push([run, 'skillDiagnostics', run.skillTelemetry.diagnostics.missingness.byAgent]);
      slots.push([run, 'usageCoverageAgents', run.usageCoverage.byAgent, 'object']);
      if (run.captureAcceptance) slots.push([run, 'captureAcceptanceChecks', run.captureAcceptance.checks]);
    }
    const largest = slots.map(([run, key, rows, kind]) => ({ run, key, rows, kind,
      entries: kind === 'object' ? Object.entries(rows ?? {}) : rows,
      size: JSON.stringify(rows).length }))
      .filter(slot => slot.entries?.length > 0)
      .sort((a, b) => b.size - a.size)[0];
    if (largest) {
      const keep = Math.floor(largest.entries.length / 2);
      const removed = largest.entries.length - keep;
      let omittedCount = removed;
      if (largest.kind === 'object') {
        for (const [key] of largest.entries.slice(keep)) delete largest.rows[key];
        largest.run.usageCoverage.byAgentOmitted += removed;
      } else if (largest.kind === 'provenance') {
        largest.rows.splice(keep);
        const provenance = largest.run.resourceProvenance;
        provenance.counts.omitted += removed;
        provenance.omissionReasons ??= {};
        provenance.omissionReasons['projection-limit'] = (provenance.omissionReasons['projection-limit'] ?? 0) + removed;
        provenance.status = 'partial';
        largest.run.coverage.resourceProvenance = 'partial';
      } else if (largest.kind === 'turn-usage') {
        largest.rows.splice(keep);
        largest.run.usage.turns.turnsOmitted += removed;
        largest.run.usage.turns.revalidation = 'detail-omitted-after-precomputation';
      } else if (largest.kind === 'recorded-responses') {
        omittedCount = largest.rows.length;
        largest.rows.splice(keep);
        largest.run.usage.recorded = projectRunRecordedUsage(largest.run);
      } else largest.rows.splice(keep);
      if (largest.kind === 'instruction-sources') {
        largest.owner.omittedCount += removed;
        largest.owner.status = 'partial';
        largest.owner.reason = 'instruction-evidence-limit';
        largest.run.coverage.instructions = 'partial';
      }
      if (largest.kind !== 'provenance') addOmitted(largest.run, largest.key, omittedCount);
      if (largest.key === 'usageObservations') largest.run.usage.observationsOmitted += removed;
      if (largest.key === 'usageAgents') largest.run.usage.byAgentOmitted += removed;
      if (largest.key === 'skillDiagnostics') largest.run.skillTelemetry.diagnostics.missingness.byAgentOmitted += removed;
      if (largest.key === 'captureAcceptanceChecks') largest.run.captureAcceptance.checksOmitted += removed;
      if (largest.key === 'instructionAgents') largest.run.coverage.instructions = 'partial';
      if (largest.run.usage.turns && ['usageObservations', 'usageAgents', 'turns', 'agents'].includes(largest.key))
        largest.run.usage.turns.revalidation = 'source-detail-omitted-after-precomputation';
      if (largest.run.usage.workflow && ['usageObservations', 'usageAgents', 'turns', 'agents'].includes(largest.key))
        largest.run.usage.workflow.revalidation = 'detail-omitted-after-precomputation';
      continue;
    }
    break;
  }
  if (bytes() > maxBytes) {
    const error = new Error('audit-trial-evidence-exceeds-byte-budget');
    error.code = 'AUDIT_TRIAL_EVIDENCE_EXCEEDS_BYTE_BUDGET';
    throw error;
  }
  return trial;
}
function compactWorkspace(value) {
  if (!value) return null;
  const validChangeCount = Number.isSafeInteger(value.changedFileCount) && value.changedFileCount >= 0;
  const validChangeBasis = value.changeCountBasis === 'post-setup-snapshot-delta-v1';
  const exactTaskEnd = value.captureComplete === true && value.timing === 'task-end';
  const reason = ['workspace-snapshots-incomplete', 'workspace-file-records-ambiguous', 'tracked-blob-identity-missing', 'workspace-file-origin-changed', 'task-end-boundary-unverified']
    .includes(value.changeCountReason) ? value.changeCountReason : undefined;
  const delta = { ...pick(value, ['status', 'captureComplete', 'timing', 'fileCount', 'fingerprint', 'baselineFingerprint',
    'changedFileCount', 'changeCountStatus', 'changeCountBasis']),
    ...(value.changeCountStatus !== undefined || value.changedFileCount !== undefined || value.changeCountBasis !== undefined ? {
      changedFileCount: validChangeCount ? value.changedFileCount : null,
      changeCountStatus: value.changeCountStatus === 'known' && validChangeCount && validChangeBasis && exactTaskEnd ? 'known' : 'unknown',
      changeCountBasis: validChangeBasis ? value.changeCountBasis : null,
      ...(!exactTaskEnd && value.changeCountStatus === 'known' ? { changeCountReason: 'task-end-boundary-unverified' } : reason ? { changeCountReason: reason } : {}),
    } : {}),
    ...(Number.isSafeInteger(value.files) ? { fileCount: value.files } : {}) };
  return delta;
}
function count(value) { return Array.isArray(value) ? value.length : null; }
function compactBaseline(value) {
  return pick(value, ['commit', 'tree', 'selectedRevision', 'sourceHead', 'sourceDirty', 'taskOrder', 'source']);
}

/** Keep bounded, reviewable run evidence while excluding task text, argv, env and payloads. */
export function compactAuditTrial(report, { index, experimentId, status, environment, maxBytes } = {}) {
  const rawRuns = list(report?.runs ?? (report ? [report] : []));
  const runs = bounded(rawRuns, 160);
  const compact = { index: index ?? report?.index ?? null, experimentId: experimentId ?? report?.experimentId ?? null,
    status: status ?? report?.status ?? 'unknown', ...(environment ? { environment: pick(environment, ['settings', 'platform', 'architecture', 'nodeVersion', 'cache', 'integrations', 'epoch']) } : {}),
    failures: bounded(report?.failures, 40).map(item => ({ code: typeof item?.code === 'string' ? item.code : 'trial-failure-recorded' })),
    warnings: bounded(report?.warnings, 40).map(item => ({ code: typeof item?.code === 'string' ? item.code : 'trial-warning-recorded' })),
    profileOrder: bounded(report?.profileOrder, 160), budgetMs: finite(report?.budgetMs),
    runs: runs.map(compactRun), runsOmitted: Math.max(0, rawRuns.length - runs.length) + (finite(report?.runsOmitted) ?? 0) };
  return boundFrozenTrialBytes(compact, maxBytes);
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * p, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}
function metricStats(samples, plannedN, reasons, name) {
  const values = samples.map(s => s.value).sort((a, b) => a - b), q1 = quantile(values, .25), q3 = quantile(values, .75);
  const first = samples[0] ?? {};
  const defaultUnit = /Ms$|ElapsedMs$/.test(name) ? 'ms' : 'count';
  return { unit: first.unit ?? defaultUnit, scope: first.scope ?? 'run', source: first.source ?? 'reported-run-metric', plannedN,
    observedN: values.length, missingN: Math.max(0, plannedN - values.length), missingReasons: reasons,
    median: quantile(values, .5), min: values.length ? values[0] : null, max: values.length ? values.at(-1) : null,
    q1, q3, iqr: q1 === null ? null : q3 - q1 };
}
function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b), q1 = quantile(sorted, .25), q3 = quantile(sorted, .75);
  return { median: quantile(sorted, .5), q1, q3, iqr: q1 === null ? null : q3 - q1 };
}
export function auditMetricSamples(run) {
  if (!run || run.status === 'not-started' || run.recoveredScaffold === true) return {};
  const nativeRollout = run.source?.kind === 'native-rollout';
  const nativeUsageSupported = nativeRollout && recordedUsageAccounting(run.source.clientVersion) !== null;
  const hasExecution = ['exited', 'completed', 'failed', 'timeout', 'cancelled', 'output-limit', 'shutdown-failed'].includes(run.execution?.status);
  if (!nativeRollout && !hasExecution) return {};
  const metrics = obj(run.metrics), out = {};
  if (nativeRollout && finite(metrics.recordedSpanMs) !== null
    && ['source-recorded-span', 'owned-turn-evidence'].includes(metrics.recordedSpanKind)) {
    out.recordedSpanMs = { value: finite(metrics.recordedSpanMs), unit: 'ms',
      scope: metrics.recordedSpanKind, source: 'native-rollout-recorded-timestamps' };
  }
  const recorded = run.usage?.recorded;
  if (nativeUsageSupported && recorded?.status === 'complete' && recorded.scope === 'recorded-selected-thread-responses'
    && recorded.contract?.contract === 'codex-rollout-own-response-usage-v1') {
    for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens']) {
      if (recorded.fields?.[field]?.status === 'observed' && Number.isSafeInteger(recorded.values?.[field]) && recorded.values[field] >= 0)
        out[`recorded.${field}`] = { value: recorded.values[field], unit: 'tokens',
          scope: `${recorded.scope}:${recorded.contract.counterScope}`, source: 'native-rollout-recorded-response-sequence' };
    }
  }
  const taskEnd = run.workspace?.taskEnd;
  const workspaceBaseline = run.sourceWorkspace;
  if (taskEnd?.changeCountStatus === 'known' && taskEnd.captureComplete === true && taskEnd.timing === 'task-end'
    && Number.isSafeInteger(taskEnd.changedFileCount) && taskEnd.changedFileCount >= 0
    && taskEnd.changeCountBasis === 'post-setup-snapshot-delta-v1'
    && typeof workspaceBaseline?.sourceCommit === 'string' && workspaceBaseline.sourceCommit.length > 0
    && typeof workspaceBaseline?.sourceTree === 'string' && workspaceBaseline.sourceTree.length > 0) {
    out['workspace.changedFileCount'] = { value: taskEnd.changedFileCount, unit: 'files',
      scope: taskEnd.changeCountBasis, source: 'post-setup-task-workspace-delta' };
  }
  const workflow = eligibleWorkflowUsage(run);
  for (const [name, raw] of Object.entries(metrics)) {
    const workflowField = name.startsWith('workflow.') ? name.slice('workflow.'.length) : null;
    if (!['processElapsedMs', 'wallMs', 'setupMs', 'taskMs', 'captureMs', 'checksMs', 'totalMs'].includes(name)
      && !name.startsWith('root.') && !(workflowField && USAGE_FIELDS.includes(workflowField) && workflow)) continue;
    const value = finite(raw);
    if (value === null || (name.startsWith('root.') && !run.usage?.rootAgentId)) continue;
    if (workflowField && (!workflow || workflow.values[workflowField] !== value)) continue;
    out[name] = workflowField ? { value, unit: 'count', scope: workflow.scope, source: 'source-reported-thread-counters-summed-once' }
      : { value, unit: /Ms$|ElapsedMs$/.test(name) ? 'ms' : 'count',
        scope: name.startsWith('root.') ? 'root-agent-only' : 'run', source: name.startsWith('root.') ? 'source-reported-root-agent-counter' : 'reported-run-metric' };
  }
  return out;
}

export function summarizeAuditSeries({ id, baseline, profiles = [], plan = [], spec = {}, recipe = {}, trials = [], reviews = [], cohort = null } = {}) {
  const bySlot = new Map(list(trials).map(trial => [trial.index ?? (Number.isInteger(trial.trialIndex) ? trial.trialIndex + 1 : null), trial]));
  const checks = list(spec.checks), quality = spec.quality;
  const slots = list(plan).slice(0, 160).map((slot, i) => {
    const index = slot.index ?? (Number.isInteger(slot.trialIndex) ? slot.trialIndex + 1 : i + 1);
    const incoming = bySlot.get(index);
    const rawRuns = list(incoming?.runs ?? incoming?.report?.runs);
    const profileOrder = list(slot.profileOrder ?? slot.profiles);
    const rows = profileOrder.map(profile => {
      const profileName = typeof profile === 'string' ? profile : profile.profileName ?? profile.name;
      const requestedId = typeof profile === 'string' ? null : profile.profileId ?? profile.id ?? null;
      const declaredProfile = requestedId
        ? list(profiles).find(item => (item.profileId ?? item.id) === requestedId)
        : list(profiles).find(item => (item.profileName ?? item.name) === profileName);
      const profileId = requestedId ?? declaredProfile?.profileId ?? declaredProfile?.id ?? null;
      const run = profileId
        ? rawRuns.find(r => (r.profileId ?? r.profile?.profileId ?? r.profile?.id) === profileId)
        : rawRuns.find(r => profileName && (r.profileName ?? r.profile?.profileName ?? r.profile?.name) === profileName);
      const status = run ? run.status ?? run.execution?.status ?? 'captured' : incoming?.status ?? 'not-started';
      let evaluation;
      if (run && quality) {
        const review = list(reviews).find(x => x.runId === run.id && x.fingerprint === auditQualityFingerprint(quality, checks));
        // Series collection compacts runs before this point. Canonicalize both layouts
        // (run.checks and outcome.checks) before evaluating the frozen recipe.
        const canonicalRun = { ...run, checks: canonicalAuditChecks(run) };
        evaluation = evaluateAuditQuality(canonicalRun, quality, { checks, review: review ?? null });
      }
      return { index, experimentId: slot.experimentId ?? null, profileId: profileId ?? run?.profileId ?? run?.profile?.profileId ?? run?.profile?.id ?? null, profileName, status,
        run: run ? compactRun(run) : null, quality: evaluation ? { status: evaluation.status, fingerprint: evaluation.fingerprint,
          definitionId: evaluation.definition.id, definitionVersion: evaluation.definition.version,
          criteria: evaluation.criteria, rubric: evaluation.rubric, review: evaluation.review ?? null,
          scorePercent: evaluation.rubric?.status === 'reviewed' ? finite(evaluation.rubric.scorePercent) : null } : null };
    });
    const trialComparisons = [];
    for (let leftIndex = 0; leftIndex < rows.length; leftIndex++) for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex++) {
      const leftRun = rows[leftIndex].run ? { ...rows[leftIndex].run, quality: rows[leftIndex].quality } : null;
      const rightRun = rows[rightIndex].run ? { ...rows[rightIndex].run, quality: rows[rightIndex].quality } : null;
      trialComparisons.push({ leftRunId: leftRun?.id ?? null, rightRunId: rightRun?.id ?? null,
        explanation: buildAuditExplanation(leftRun, rightRun, retainedAuditSelectionOptions(incoming?.selection)) });
    }
    const retainedSelection = incoming?.selection ? retainedAuditSelectionOptions(incoming.selection) : null;
    const selection = retainedSelection ? { declaration: retainedSelection.taskAssociation ?? null,
      declaredVariables: retainedSelection.declaredVariables } : null;
    return { index, experimentId: slot.experimentId ?? null, status: incoming?.status ?? 'not-started', ...(selection ? { selection } : {}), profiles: rows,
      comparisons: trialComparisons,
      failures: bounded(incoming?.failures, 40).map(item => ({ code: item?.code ?? 'trial-failure-recorded' })),
      warnings: bounded(incoming?.warnings, 40).map(item => ({ code: item?.code ?? 'trial-warning-recorded' })),
      profileOrder: profileOrder.map(p => typeof p === 'string' ? p : ({
        ...(typeof (p.profileId ?? p.id) === 'string' ? { profileId: p.profileId ?? p.id } : {}),
        ...(typeof (p.profileName ?? p.name) === 'string' ? { profileName: p.profileName ?? p.name } : {}),
      })),
      budgetMs: finite(slot.budgetMs), environment: incoming?.environment ?? null };
  });
  const slotsByIndex = new Map(slots.map(slot => [slot.index, slot]));
  const profileRows = list(profiles).slice(0, 160).map(profile => {
    const profileName = profile.profileName ?? profile.name ?? profile.id;
    const profileId = profile.profileId ?? profile.id;
    const observations = slots.flatMap(slot => slot.profiles.filter(row => profileId
      ? row.profileId === profileId : row.profileName === profileName));
    const qs = observations.map(row => row.quality?.status ?? 'incomplete');
    const plannedN = observations.length, passed = qs.filter(s => s === 'passed').length, failed = qs.filter(s => s === 'failed').length;
    const execution = {};
    for (const row of observations) execution[row.status] = (execution[row.status] ?? 0) + 1;
    const names = new Set(['processElapsedMs', ...observations.flatMap(row => Object.keys(auditMetricSamples(row.run))),
      ...(observations.some(row => row.run?.workspace?.taskEnd) ? ['workspace.changedFileCount'] : [])]);
    const metrics = Object.fromEntries([...names].sort().map(name => {
      const samples = [], reasons = {};
      for (const row of observations) {
        const sample = auditMetricSamples(row.run)[name];
        if (sample) samples.push(sample);
        else {
          const taskEnd = row.run?.workspace?.taskEnd;
          const reason = row.status === 'not-started' ? 'not-started' : !row.run ? 'missing-run-capture'
            : name === 'workspace.changedFileCount' && taskEnd && (taskEnd.captureComplete !== true || taskEnd.timing !== 'task-end') ? 'task-end-boundary-unverified'
              : name === 'workspace.changedFileCount' && !sameWorkspaceBaseline(row.run, row.run) ? 'source-baseline-unverified'
                : 'field-unavailable-or-unproven';
          reasons[reason] = (reasons[reason] ?? 0) + 1;
        }
      }
      return [name, metricStats(samples, plannedN, reasons, name)];
    }));
    const byIndex = new Map(observations.map(row => [row.index, row]));
    let review;
    if (quality?.rubric) {
      const scored = observations.map(row => row.quality?.scorePercent).filter(value => finite(value) !== null);
      const reviewedN = observations.filter(row => row.quality?.rubric?.status === 'reviewed').length;
      review = { rubricId: quality.rubric.id, rubricVersion: quality.rubric.version, plannedN,
        reviewedN, scoredN: scored.length, missingN: plannedN - scored.length, unreviewedN: plannedN - reviewedN,
        ...distribution(scored) };
    }
    return { profileId: profile.profileId ?? profile.id ?? null, profileName, planned: plannedN,
      ...(nativeConfigOf(profile.nativeConfig) !== undefined ? { nativeConfig: nativeConfigOf(profile.nativeConfig) } : {}),
      executed: observations.filter(row => row.run).length,
      quality: { passed, failed, incomplete: plannedN - passed - failed, notRun: observations.filter(row => !row.run).length,
        passRate: plannedN ? passed / plannedN : null, denominator: plannedN },
      execution: { counts: execution }, metrics, ...(review ? { review } : {}), _runs: byIndex };
  });
  const comparisonSelection = index => retainedAuditSelectionOptions(slotsByIndex.get(index)?.selection);
  const comparisons = [];
  for (let i = 0; i < profileRows.length; i++) for (let j = i + 1; j < profileRows.length; j++) {
    const left = profileRows[i], right = profileRows[j];
    // A pair is planned only in slots that explicitly included both profiles.
    const pairIndexes = [...left._runs.keys()].filter(index => right._runs.has(index));
    const metrics = {};
    for (const name of new Set([...Object.keys(left.metrics), ...Object.keys(right.metrics)])) {
      const leftByIndex = left._runs, rightByIndex = right._runs;
      const indexes = pairIndexes;
      let leftObservedN = 0, rightObservedN = 0, pairedN = 0, scopeMismatchN = 0, eligibleN = 0, excludedN = 0;
      const eligibilityReasons = {};
      const differences = [], pairedLeft = [], pairedRight = [];
      for (const index of indexes) {
        const leftRun = leftByIndex.get(index)?.run, rightRun = rightByIndex.get(index)?.run;
        const leftSample = auditMetricSamples(leftRun)[name];
        const rightSample = auditMetricSamples(rightRun)[name];
        if (leftSample) leftObservedN++;
        if (rightSample) rightObservedN++;
        const eligibility = compareAuditConditions(leftRun, rightRun, comparisonSelection(index));
        if (eligibility.eligible) eligibleN++;
        else {
          excludedN++;
          for (const reason of eligibility.reasons?.length ? eligibility.reasons : [eligibility.status ?? 'conditions-unknown'])
            eligibilityReasons[reason] = (eligibilityReasons[reason] ?? 0) + 1;
        }
        if (!eligibility.eligible) continue;
        if (!leftSample || !rightSample) continue;
        if (name === 'workspace.changedFileCount' && !sameWorkspaceBaseline(leftRun, rightRun)) { scopeMismatchN++; continue; }
        if (leftSample.scope !== rightSample.scope || leftSample.source !== rightSample.source) { scopeMismatchN++; continue; }
        pairedN++; pairedLeft.push(leftSample.value); pairedRight.push(rightSample.value);
        differences.push(rightSample.value - leftSample.value);
      }
      const plannedN = indexes.length;
      const reason = excludedN ? 'ineligible-comparison-conditions'
        : scopeMismatchN ? 'metric-evidence-scope-mismatch'
        : pairedN === 0 ? 'no-paired-metric-samples'
          : pairedN < plannedN ? 'incomplete-paired-measurements' : null;
      metrics[name] = { leftMedian: distribution(pairedLeft).median, rightMedian: distribution(pairedRight).median,
        delta: pairedN ? distribution(differences).median : null, plannedN, leftObservedN, rightObservedN, pairedN,
        missingLeftN: plannedN - leftObservedN, missingRightN: plannedN - rightObservedN,
        missingPairN: plannedN - pairedN, eligibleN, excludedN, eligibilityReasons,
        scopeMismatchN, reason };
    }
    let reviewDelta = null;
    if (left.review && right.review && left.review.rubricId === right.review.rubricId && left.review.rubricVersion === right.review.rubricVersion) {
      const differences = [];
      let eligibleN = 0, excludedN = 0, missingEligiblePairN = 0;
      const eligibilityReasons = {};
      for (const index of pairIndexes) {
        const leftRun = left._runs.get(index)?.run, rightRun = right._runs.get(index)?.run;
        const eligibility = compareAuditConditions(leftRun, rightRun, comparisonSelection(index));
        if (!eligibility.reviewEligible) {
          excludedN++;
          const reasons = eligibility.eligible ? [eligibility.reviewReason ?? 'review-definition-unknown-or-different']
            : eligibility.reasons?.length ? eligibility.reasons : [eligibility.status ?? 'conditions-unknown'];
          for (const reason of reasons)
            eligibilityReasons[reason] = (eligibilityReasons[reason] ?? 0) + 1;
          continue;
        }
        eligibleN++;
        const l = left._runs.get(index)?.quality?.scorePercent, r = right._runs.get(index)?.quality?.scorePercent;
        if (finite(l) !== null && finite(r) !== null) differences.push(r - l);
        else missingEligiblePairN++;
      }
      const paired = differences.length;
      reviewDelta = { rubricId: left.review.rubricId, rubricVersion: left.review.rubricVersion,
        plannedN: pairIndexes.length, pairedN: paired,
        eligibleN, excludedN, missingEligiblePairN,
        missingPairN: Math.max(0, eligibleN - paired), eligibilityReasons,
        delta: paired && paired === eligibleN && excludedN === 0 ? distribution(differences).median : null,
        reason: excludedN ? 'ineligible-comparison-conditions'
          : missingEligiblePairN ? 'incomplete-paired-reviews' : paired ? null : 'no-paired-scored-reviews' };
    }
    const insights = [];
    const leftRuns = [...left._runs.values()].map(row => row?.run).filter(Boolean);
    const rightRuns = [...right._runs.values()].map(row => row?.run).filter(Boolean);
    if (leftRuns.length && rightRuns.length) {
      const models = runs => [...new Set(runs.map(r => r.model).filter(Boolean))].sort();
      const agentCounts = runs => runs.map(r => r.agents?.length ?? null);
      const observedCounts = runs => Object.fromEntries(['catalog', 'invocations', 'tools', 'mcp'].map(key => [key,
        runs.map(run => ({ runId: run.id ?? null, count: finite(run.counts?.[key]), coverage: run.coverage?.[key === 'invocations' ? 'skillInvocationTelemetry' : key] ?? 'unknown' }))]));
      insights.push({ kind: 'observed-evidence', runIds: [...leftRuns, ...rightRuns].map(r => r.id).filter(Boolean).slice(0, 160),
      models: { left: models(leftRuns), right: models(rightRuns) },
      agentCounts: { left: agentCounts(leftRuns), right: agentCounts(rightRuns) },
      counts: { left: observedCounts(leftRuns), right: observedCounts(rightRuns) },
      observation: 'Recorded model, corroborated agent, catalog, skill invocation, tool, and MCP observations are shown per run.',
      limitation: 'These observations do not identify a cause or a winner; missing and partial telemetry remain material.' });
    }
    let qualityEligibleN = 0, qualityPairedN = 0, qualityExcludedN = 0, qualityMissingN = 0, qualityLeftPassed = 0, qualityRightPassed = 0;
    const qualityEligibilityReasons = {};
    for (const index of pairIndexes) {
      const leftObservation = left._runs.get(index), rightObservation = right._runs.get(index);
      const eligibility = compareAuditConditions(leftObservation?.run, rightObservation?.run, comparisonSelection(index));
      if (!eligibility.reviewEligible) {
        qualityExcludedN++;
        const reasons = eligibility.eligible ? [eligibility.reviewReason ?? 'quality-definition-unknown-or-different']
          : eligibility.reasons?.length ? eligibility.reasons : [eligibility.status ?? 'conditions-unknown'];
        for (const reason of reasons)
          qualityEligibilityReasons[reason] = (qualityEligibilityReasons[reason] ?? 0) + 1;
        continue;
      }
      const exactDefinition = observation => {
        const frozenFingerprint = observation?.run?.comparisonEvidence?.conditions?.qualityFingerprint;
        return typeof frozenFingerprint === 'string' && observation?.quality?.fingerprint === frozenFingerprint;
      };
      if (!exactDefinition(leftObservation) || !exactDefinition(rightObservation)) {
        qualityExcludedN++;
        qualityEligibilityReasons['quality-definition-fingerprint-mismatch'] =
          (qualityEligibilityReasons['quality-definition-fingerprint-mismatch'] ?? 0) + 1;
        continue;
      }
      qualityEligibleN++;
      const leftStatus = leftObservation?.quality?.status, rightStatus = rightObservation?.quality?.status;
      if (!['passed', 'failed'].includes(leftStatus) || !['passed', 'failed'].includes(rightStatus)) {
        qualityMissingN++;
        continue;
      }
      qualityPairedN++;
      if (leftStatus === 'passed') qualityLeftPassed++;
      if (rightStatus === 'passed') qualityRightPassed++;
    }
    const qualityDelta = qualityEligibleN > 0 && qualityMissingN === 0 && qualityExcludedN === 0
      ? qualityRightPassed / qualityPairedN - qualityLeftPassed / qualityPairedN : null;
    comparisons.push({ left: left.profileId ?? left.profileName, right: right.profileId ?? right.profileName,
      qualityDelta,
      qualityDeltaEvidence: { plannedN: pairIndexes.length,
        eligibleN: qualityEligibleN, excludedN: qualityExcludedN, missingN: qualityMissingN,
        pairedN: qualityPairedN, eligibilityReasons: qualityEligibilityReasons,
        reason: qualityExcludedN ? 'ineligible-comparison-conditions'
          : qualityMissingN ? 'incomplete-paired-quality-outcomes'
            : qualityEligibleN ? null : 'no-eligible-paired-quality-outcomes' },
      ...(reviewDelta ? { reviewDelta } : {}), metrics, insights });
  }
  for (const row of profileRows) delete row._runs;
  const coverage = { plannedSlots: slots.length, capturedSlots: slots.filter(s => s.profiles.some(p => p.run)).length,
    missingSlots: slots.filter(s => s.profiles.some(p => !p.run)).length };
  const knownFailed = profileRows.some(p => p.quality.failed > 0 || Object.entries(p.execution.counts).some(([k, n]) => n && ['failed', 'error', 'aborted', 'timeout', 'cancelled', 'output-limit'].includes(k)));
  const partial = profileRows.some(p => p.quality.incomplete > 0 || p.executed < p.planned)
    || slots.some(slot => slot.status === 'partial' || slot.profiles.some(p => p.run &&
      (p.run.status === 'partial' || p.run.captureStatus === 'partial'
        || Object.values(p.run.coverage ?? {}).some(value => ['partial', 'unavailable', 'unknown', 'not-found'].includes(value)))));
  const status = knownFailed ? 'failed' : partial ? 'partial' : 'complete';
  const warnings = [];
  if (partial) warnings.push('One or more planned runs or capture dimensions are incomplete; missing measurements were not imputed.');
  if (knownFailed) warnings.push('At least one run has known failed quality or execution evidence.');
  const report = { schemaVersion: 1, kind: 'audit-series-report', id: id ?? null, status, baseline: compactBaseline(baseline),
    ...(cohort ? { cohort } : {}),
    recipe: pick(recipe, ['fingerprint', 'qualityFingerprint', 'criteria', 'meta']),
    plan: slots.map(slot => ({ ...pick(slot, ['index', 'experimentId', 'status']),
      profileOrder: list(list(plan).find(item => item.experimentId === slot.experimentId)?.profileOrder).map(p => typeof p === 'string' ? p : ({
        ...(typeof (p.profileId ?? p.id) === 'string' ? { profileId: p.profileId ?? p.id } : {}),
        ...(typeof (p.profileName ?? p.name) === 'string' ? { profileName: p.profileName ?? p.name } : {}),
      })),
      budgetMs: finite(list(plan).find(item => item.experimentId === slot.experimentId)?.budgetMs) })), trials: slots, profiles: profileRows, comparisons,
    coverage, warnings, exitCode: knownFailed ? 4 : partial ? 2 : 0 };
  report.consistency = buildAuditConsistency(report, { reviews });
  return report;
}

function sameWorkspaceBaseline(left, right) {
  const a = left?.sourceWorkspace, b = right?.sourceWorkspace;
  return Boolean(a?.sourceCommit && a?.sourceTree && b?.sourceCommit && b?.sourceTree
    && a.sourceCommit === b.sourceCommit && a.sourceTree === b.sourceTree);
}
