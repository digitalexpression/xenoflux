import { evaluateAuditQuality, auditQualityFingerprint } from './audit-quality.js';
import { nativeUsageAccounting, USAGE_FIELDS } from './audit-usage.js';
import { safePluginScriptPath } from './audit-tools.js';
import { compactInstructionSources } from './audit-instructions.js';

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
        ? item.commandWrapper ?? item.evidence.commandWrapper : null })) };
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
  return { transport: { status: text(transport.status, 80), receivedBytes: finite(transport.receivedBytes), rejectedRequests: finite(transport.rejectedRequests),
      warnings: bounded(transport.warnings, 30).map(item => text(typeof item === 'string' ? item : item?.code ?? item?.kind, 120)) },
    journal: { status: text(journal.status, 80), bytes: finite(journal.bytes), eventCount: finite(journal.eventCount) },
    missingness: { byAgent: agentRows.map(([agentId, agent]) => ({ agentId: text(agent?.agentId ?? agentId, 160),
      origins: Object.fromEntries(Object.entries(obj(agent?.origins ?? agent)).slice(0, 30).map(([origin, item]) => [text(origin, 120), {
        catalogCount: finite(item?.catalogCount), invocationCount: finite(item?.invocationCount),
        status: text(item?.status, 80), reason: text(item?.reason, 160) }])) })),
      byAgentOmitted: Math.max(0, (Array.isArray(missingness.byAgent) ? missingness.byAgent.length : Object.keys(obj(missingness.byAgent)).length) - 160) + (finite(missingness.byAgentOmitted) ?? 0) } };
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
  const checks = bounded(value.checks, 200).map(item => {
    const selector = obj(item?.selector);
    return { id: text(item?.id, 160), status: text(item?.status, 80), reason: text(item?.reason, 160),
      required: numeric(item?.required), observed: numeric(item?.observed), observations: numeric(item?.observations),
      agentId: text(item?.agentId, 160), turnId: text(item?.turnId, 160),
      missingFields: bounded(item?.missingFields, 6).map(field => text(field, 60)),
      selector: Object.keys(selector).length ? { agent: text(selector.agent, 40), name: text(selector.name, 160), origin: text(selector.origin, 40),
        ...(selector.pluginId ? { pluginId: text(selector.pluginId, 160) } : {}),
        ...(safePluginScriptPath(selector.scriptPath) ? { scriptPath: selector.scriptPath } : {}),
        invocationType: text(selector.invocationType, 40), kind: text(selector.kind, 40), server: text(selector.server, 160), tool: text(selector.tool, 160),
        ...(HOOK_ENUMS.eventName.has(selector.eventName) ? { eventName: selector.eventName } : {}),
        ...(HOOK_ENUMS.sourceKind.has(selector.sourceKind) ? { sourceKind: selector.sourceKind } : {}),
        ...(HOOK_ENUMS.scope.has(selector.scope) ? { scope: selector.scope } : {}),
        ...(HOOK_ENUMS.status.has(selector.status) ? { status: selector.status } : {}), min: numeric(selector.min) } : null };
  });
  const row = { schemaVersion: numeric(value.schemaVersion), mode: text(value.mode, 80), status: text(value.status, 80),
    requirements: { minAgents: numeric(requirements.minAgents), usage: Object.keys(usage).length ? { agents: text(usage.agents, 40),
      fields: bounded(usage.fields, 6).map(field => text(field, 60)), minTurns: numeric(usage.minTurns), wholeTurns: usage.wholeTurns === true } : null,
      skills: skills(requirements.skills), tools: tools(requirements.tools), hooks: hooks(requirements.hooks) }, checks,
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

function compactRun(run) {
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
  for (const key of ['processElapsedMs', 'wallMs', 'setupMs', 'taskMs', 'captureMs', 'checksMs', 'totalMs']) {
    const n = finite(run.metrics?.[key]); if (n !== null) metrics[key] = n;
  }
  for (const [key, value] of Object.entries(rootCounters)) if (finite(value) !== null) metrics[`root.${key}`] = value;
  const workflow = compactWorkflowUsage(usage.workflow);
  const turnsUsage = compactTurnUsage(run);
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
  const coverage = { ...obj(run.coverage), instructions: instructionCoverage };
  if (instructionSources.omittedAgents || instructionSources.omittedSources || unownedInstructionRows) coverage.instructions = 'partial';
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
  return {
    id: run.id ?? null, profileId: run.profileId ?? profile.profileId ?? profile.id ?? null,
    profileName: run.profileName ?? profile.profileName ?? profile.name ?? null,
    source: { ...pick(source, ['kind', 'threadId', 'version', 'historyMode', 'freshThread', 'model', 'reasoningEffort', 'persistence']),
      ...(source.observationMode === 'saved-native-wire-replay' ? { observationMode: source.observationMode,
        rawNativeWireSha256: typeof source.rawNativeWireSha256 === 'string' && /^[a-f0-9]{64}$/.test(source.rawNativeWireSha256) ? source.rawNativeWireSha256 : null,
        sourceReceipt: text(source.sourceReceipt, 200) } : {}) },
    sourceWorkspace: { ...pick(run.sourceWorkspace, ['sourceCommit', 'sourceTree']) },
    model: run.model ?? source.model ?? run.configuration?.model ?? null,
    status: run.status ?? run.outcome?.nativeTurnStatus ?? execution.status ?? 'unknown', execution,
    metrics, usage: { scope: usageScope, sourceScope: text(rootUsageScope, 120), status: run.coverage?.usage ?? usage.status ?? null, rootAgentId: rootId ?? null,
      accounting: compactWorkflowAccounting(usage.accounting), workflow, turns: turnsUsage,
      counters: Object.fromEntries(Object.entries(rootCounters).filter(([, v]) => finite(v) !== null)),
      observations: usageObservations, observationsOmitted: Math.max(0, list(usage.observations).length - usageObservations.length) + (finite(usage.observationsOmitted) ?? priorOmitted('usageObservations')),
      byAgent: usageAgents, byAgentOmitted: Math.max(0, allAgentRows.length - usageAgents.length) + (finite(usage.byAgentOmitted) ?? 0) },
    outcome: { ...pick(outcome, ['status', 'nativeTurnStatus']), task: pick(task, ['nativeTurnStatus', 'status', 'processStatus', 'exitCode', 'nativeThreadId']) },
    task: pick(task, ['nativeTurnStatus', 'status', 'processStatus', 'exitCode', 'nativeThreadId']),
    turns,
    checks: bounded(run.checks).map(check => pick(check, ['name', 'status', 'exitCode'])),
    workspace: { taskEnd: compactWorkspace(run.workspace?.taskEnd ?? outcome.taskEndWorkspace ?? run.taskEnd),
      checkEnd: compactWorkspace(run.workspace?.checkEnd ?? run.finalWorkspace ?? outcome.finalWorkspace) },
    profileSettings: pick(run.profileSettings, ['status', 'beforeFingerprint', 'afterFingerprint', 'changedPaths']),
    runningClients: { status: run.runningClients?.status ?? null, beforeCount: count(run.runningClients?.before) ?? run.runningClients?.beforeCount ?? null, afterCount: count(run.runningClients?.after) ?? run.runningClients?.afterCount ?? null },
    coverage, instructionSources: instructionSources.rows, warnings: bounded(run.warnings, 40).map(x => typeof x === 'string' ? 'warning-recorded' : x?.code ?? 'unknown'),
    artifacts: bounded(run.artifacts, 40).map(item => pick(item, ['kind', 'status', 'id', 'fingerprint', 'files', 'captureComplete', 'timing'])),
    agents: bounded(run.agents, 160).map(agent => ({ ...pick(agent, ['id', 'parentId', 'model', 'depth', 'reasoningEffort']),
      ...(typeof agent?.role === 'string' && agent.role.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(agent.role) ? { role: agent.role } : {}),
      sourceLine: sourceLine(agent?.sourceLine ?? agent?.source_line) })),
    skills, skillInvocations, toolInvocations, mcpServers, hookInvocations,
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
    evidenceBounds: { usageObservations: 500, usageAgents: 160, turns: 1000, turnUsageRows: 1000, agents: 160, skills: 160, skillObservations: 100, skillInvocations: 500, toolInvocations: 500, mcpServers: 160, hookInvocations: 500, instructionAgents: 160, instructionSourcesPerAgent: 64, skillDiagnostics: 160, usageCoverageAgents: 160, captureAcceptanceChecks: 200,
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
        skillObservations: skills.reduce((sum, skill, i) => sum + Math.max(0, list((run.skills ?? run.catalog)?.[i]?.observations).length - list(skill.observations).length), 0) + priorOmitted('skillObservations'),
        skillDiagnostics: Math.max(0, compactSkillDiagnostics(skillTelemetry.diagnostics).missingness.byAgentOmitted, priorOmitted('skillDiagnostics')),
        usageCoverageAgents: Math.max(0, compactUsageCoverage(run.capture?.coverageDetails?.usage ?? run.usageCoverage ?? usage.coverageByAgent).byAgentOmitted, priorOmitted('usageCoverageAgents')),
        captureAcceptanceChecks: Math.max(0, compactAcceptance(run.captureAcceptance)?.checksOmitted ?? 0, priorOmitted('captureAcceptanceChecks')) } },
    counts: { catalog: count(run.catalog ?? (list(run.skills).length ? run.skills : null)) ?? run.counts?.catalog ?? null, invocations: count(run.skillInvocations) ?? run.counts?.invocations ?? null, tools: count(run.toolInvocations) ?? run.counts?.tools ?? null, mcp: count(run.mcp?.servers) ?? run.counts?.mcp ?? null,
      hooks: Number.isSafeInteger(run.counts?.hooks) && run.counts.hooks >= 0 ? run.counts.hooks : rawHooks.length },
    captureStatus: run.capture?.status ?? run.captureStatus ?? null,
  };
}
function boundFrozenTrialBytes(trial, maxBytes = 15 * 1024 * 1024) {
  maxBytes = Math.max(300 * 1024, Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 15 * 1024 * 1024);
  const bytes = () => new TextEncoder().encode(JSON.stringify(trial)).byteLength;
  const addOmitted = (run, key, amount) => { run.evidenceBounds.omitted[key] = (run.evidenceBounds.omitted[key] ?? 0) + amount; };
  while (bytes() > maxBytes) {
    const slots = [];
    for (const run of trial.runs) {
      slots.push([run, 'usageObservations', run.usage.observations]);
      slots.push([run, 'usageAgents', run.usage.byAgent]);
      slots.push([run, 'hookInvocations', run.hookInvocations]);
      slots.push([run, 'instructionAgents', run.instructionSources]);
      for (const row of run.instructionSources) slots.push([run, 'instructionSources', row.sources, 'instruction-sources', row]);
      if (run.usage.turns) slots.push([run, 'turnUsageRows', run.usage.turns.turns, 'turn-usage']);
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
      if (largest.kind === 'object') {
        for (const [key] of largest.entries.slice(keep)) delete largest.rows[key];
        largest.run.usageCoverage.byAgentOmitted += removed;
      } else if (largest.kind === 'turn-usage') {
        largest.rows.splice(keep);
        largest.run.usage.turns.turnsOmitted += removed;
        largest.run.usage.turns.revalidation = 'detail-omitted-after-precomputation';
      } else largest.rows.splice(keep);
      if (largest.kind === 'instruction-sources') {
        largest.owner.omittedCount += removed;
        largest.owner.status = 'partial';
        largest.owner.reason = 'instruction-evidence-limit';
        largest.run.coverage.instructions = 'partial';
      }
      addOmitted(largest.run, largest.key, removed);
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
function metricSamples(run) {
  if (!run || run.status === 'not-started' || run.recoveredScaffold === true
    || !['exited', 'completed', 'failed', 'timeout', 'cancelled', 'output-limit', 'shutdown-failed'].includes(run.execution?.status)) return {};
  const metrics = obj(run.metrics), out = {};
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

export function summarizeAuditSeries({ id, baseline, profiles = [], plan = [], spec = {}, recipe = {}, trials = [], reviews = [] } = {}) {
  const bySlot = new Map(list(trials).map(trial => [trial.index ?? (Number.isInteger(trial.trialIndex) ? trial.trialIndex + 1 : null), trial]));
  const checks = list(spec.checks), quality = spec.quality;
  const slots = list(plan).slice(0, 160).map((slot, i) => {
    const index = slot.index ?? (Number.isInteger(slot.trialIndex) ? slot.trialIndex + 1 : i + 1);
    const incoming = bySlot.get(index);
    const rawRuns = list(incoming?.runs ?? incoming?.report?.runs);
    const profileNames = list(slot.profileOrder ?? slot.profiles);
    const rows = profileNames.map(profile => {
      const profileName = typeof profile === 'string' ? profile : profile.profileName ?? profile.name;
      const declaredProfile = list(profiles).find(item => (item.profileName ?? item.name) === profileName);
      const profileId = (typeof profile === 'string' ? null : profile.profileId ?? profile.id) ?? declaredProfile?.profileId ?? declaredProfile?.id ?? null;
      const run = rawRuns.find(r => (profileId && (r.profileId ?? r.profile?.profileId ?? r.profile?.id) === profileId)
        || (profileName && (r.profileName ?? r.profile?.profileName ?? r.profile?.name) === profileName));
      const status = run ? run.status ?? run.execution?.status ?? 'captured' : incoming?.status ?? 'not-started';
      let evaluation;
      if (run && quality) {
        const review = list(reviews).find(x => x.runId === run.id && x.fingerprint === auditQualityFingerprint(quality, checks));
        evaluation = evaluateAuditQuality(run, quality, { checks, review: review ?? null });
      }
      return { index, experimentId: slot.experimentId ?? null, profileId: profileId ?? run?.profileId ?? run?.profile?.profileId ?? run?.profile?.id ?? null, profileName, status,
        run: run ? compactRun(run) : null, quality: evaluation ? { status: evaluation.status, fingerprint: evaluation.fingerprint,
          definitionId: evaluation.definition.id, definitionVersion: evaluation.definition.version,
          criteria: evaluation.criteria, rubric: evaluation.rubric, review: evaluation.review ?? null,
          scorePercent: evaluation.rubric?.status === 'reviewed' ? finite(evaluation.rubric.scorePercent) : null } : null };
    });
    return { index, experimentId: slot.experimentId ?? null, status: incoming?.status ?? 'not-started', profiles: rows,
      failures: bounded(incoming?.failures, 40).map(item => ({ code: item?.code ?? 'trial-failure-recorded' })),
      warnings: bounded(incoming?.warnings, 40).map(item => ({ code: item?.code ?? 'trial-warning-recorded' })),
      profileOrder: profileNames.map(p => typeof p === 'string' ? p : p.profileName ?? p.name),
      budgetMs: finite(slot.budgetMs), environment: incoming?.environment ?? null };
  });
  const profileRows = list(profiles).slice(0, 160).map(profile => {
    const profileName = profile.profileName ?? profile.name ?? profile.id;
    const profileId = profile.profileId ?? profile.id;
    const observations = slots.flatMap(slot => slot.profiles.filter(row => profileId
      ? row.profileId === profileId : row.profileName === profileName));
    const qs = observations.map(row => row.quality?.status ?? 'incomplete');
    const plannedN = observations.length, passed = qs.filter(s => s === 'passed').length, failed = qs.filter(s => s === 'failed').length;
    const execution = {};
    for (const row of observations) execution[row.status] = (execution[row.status] ?? 0) + 1;
    const names = new Set(['processElapsedMs', ...observations.flatMap(row => Object.keys(metricSamples(row.run))),
      ...(observations.some(row => row.run?.workspace?.taskEnd) ? ['workspace.changedFileCount'] : [])]);
    const metrics = Object.fromEntries([...names].sort().map(name => {
      const samples = [], reasons = {};
      for (const row of observations) {
        const sample = metricSamples(row.run)[name];
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
      executed: observations.filter(row => row.run).length,
      quality: { passed, failed, incomplete: plannedN - passed - failed, notRun: observations.filter(row => !row.run).length,
        passRate: plannedN ? passed / plannedN : null, denominator: plannedN },
      execution: { counts: execution }, metrics, ...(review ? { review } : {}), _runs: byIndex };
  });
  const comparisons = [];
  for (let i = 0; i < profileRows.length; i++) for (let j = i + 1; j < profileRows.length; j++) {
    const left = profileRows[i], right = profileRows[j];
    const metrics = {};
    for (const name of new Set([...Object.keys(left.metrics), ...Object.keys(right.metrics)])) {
      const leftByIndex = left._runs, rightByIndex = right._runs;
      const indexes = [...new Set([...leftByIndex.keys(), ...rightByIndex.keys()])];
      let leftObservedN = 0, rightObservedN = 0, pairedN = 0, scopeMismatchN = 0;
      const differences = [], pairedLeft = [], pairedRight = [];
      for (const index of indexes) {
        const leftRun = leftByIndex.get(index)?.run, rightRun = rightByIndex.get(index)?.run;
        const leftSample = metricSamples(leftRun)[name];
        const rightSample = metricSamples(rightRun)[name];
        if (leftSample) leftObservedN++;
        if (rightSample) rightObservedN++;
        if (!leftSample || !rightSample) continue;
        if (name === 'workspace.changedFileCount' && !sameWorkspaceBaseline(leftRun, rightRun)) { scopeMismatchN++; continue; }
        if (leftSample.scope !== rightSample.scope || leftSample.source !== rightSample.source) { scopeMismatchN++; continue; }
        pairedN++; pairedLeft.push(leftSample.value); pairedRight.push(rightSample.value);
        differences.push(rightSample.value - leftSample.value);
      }
      const plannedN = indexes.length;
      const reason = scopeMismatchN ? 'metric-evidence-scope-mismatch'
        : pairedN === 0 ? 'no-paired-metric-samples'
          : pairedN < plannedN ? 'incomplete-paired-measurements' : null;
      metrics[name] = { leftMedian: distribution(pairedLeft).median, rightMedian: distribution(pairedRight).median,
        delta: pairedN ? distribution(differences).median : null, plannedN, leftObservedN, rightObservedN, pairedN,
        missingLeftN: plannedN - leftObservedN, missingRightN: plannedN - rightObservedN,
        missingPairN: plannedN - pairedN, scopeMismatchN, reason };
    }
    let reviewDelta = null;
    if (left.review && right.review && left.review.rubricId === right.review.rubricId && left.review.rubricVersion === right.review.rubricVersion) {
      const differences = [];
      for (const index of new Set([...left._runs.keys(), ...right._runs.keys()])) {
        const l = left._runs.get(index)?.quality?.scorePercent, r = right._runs.get(index)?.quality?.scorePercent;
        if (finite(l) !== null && finite(r) !== null) differences.push(r - l);
      }
      reviewDelta = { rubricId: left.review.rubricId, rubricVersion: left.review.rubricVersion,
        plannedN: Math.min(left.review.plannedN, right.review.plannedN), pairedN: differences.length,
        missingPairN: Math.max(0, Math.min(left.review.plannedN, right.review.plannedN) - differences.length),
        delta: differences.length ? distribution(differences).median : null,
        reason: differences.length ? (differences.length < Math.min(left.review.plannedN, right.review.plannedN) ? 'incomplete-paired-reviews' : null) : 'no-paired-scored-reviews' };
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
    comparisons.push({ left: left.profileId ?? left.profileName, right: right.profileId ?? right.profileName,
      qualityDelta: left.quality.passRate === null || right.quality.passRate === null ? null : right.quality.passRate - left.quality.passRate,
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
  return { schemaVersion: 1, kind: 'audit-series-report', id: id ?? null, status, baseline: compactBaseline(baseline),
    recipe: pick(recipe, ['fingerprint', 'qualityFingerprint', 'criteria', 'meta']),
    plan: slots.map(slot => ({ ...pick(slot, ['index', 'experimentId', 'status']),
      profileOrder: list(list(plan).find(item => item.experimentId === slot.experimentId)?.profileOrder).map(p => typeof p === 'string' ? p : p.profileName ?? p.name),
      budgetMs: finite(list(plan).find(item => item.experimentId === slot.experimentId)?.budgetMs) })), trials: slots, profiles: profileRows, comparisons,
    coverage, warnings, exitCode: knownFailed ? 4 : partial ? 2 : 0 };
}

function sameWorkspaceBaseline(left, right) {
  const a = left?.sourceWorkspace, b = right?.sourceWorkspace;
  return Boolean(a?.sourceCommit && a?.sourceTree && b?.sourceCommit && b?.sourceTree
    && a.sourceCommit === b.sourceCommit && a.sourceTree === b.sourceTree);
}
