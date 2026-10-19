import path from 'node:path';
import { nativeUsageAccounting, USAGE_FIELDS } from './audit-usage.js';
import { safePluginScriptPath } from './audit-tools.js';
import { compactInstructionSources } from './audit-instructions.js';

const EVENT_LIMIT = 50;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

let markdownRendering = false;
function clean(value, { markdown = markdownRendering } = {}) {
  let text = String(value ?? 'unknown').replace(CONTROL, ' ');
  if (markdown) text = text.replace(/[\\`*_{}[\]()#+.!|>~-]/g, '\\$&');
  return text;
}
const shown = value => clean(value);
const list = value => Array.isArray(value) ? value : [];
const coverageStatus = value => value ?? 'unknown';
const TASK_CHANGE_BASIS = 'post-setup-snapshot-delta-v1';
const TASK_CHANGE_REASONS = new Set(['workspace-snapshots-incomplete', 'workspace-file-records-ambiguous', 'tracked-blob-identity-missing', 'workspace-file-origin-changed', 'task-end-boundary-unverified']);
function workspaceRoot(run) {
  const root = run?.source?.workspace ?? run?.sourceWorkspace?.directory ?? run?.sourceWorkspace?.path;
  return typeof root === 'string' && path.isAbsolute(root) ? path.resolve(root) : null;
}
function sameVerifiedBaseline(left, right) {
  const a = left?.sourceWorkspace ?? left?.source?.baseline ?? left?.baseline ?? {};
  const b = right?.sourceWorkspace ?? right?.source?.baseline ?? right?.baseline ?? {};
  const aCommit = a.sourceCommit ?? a.commit, bCommit = b.sourceCommit ?? b.commit;
  const aTree = a.sourceTree ?? a.tree, bTree = b.sourceTree ?? b.tree;
  return Boolean(aCommit && aTree && bCommit && bTree && aCommit === bCommit && aTree === bTree);
}
function projectSkillIdentity(skill, run, alignProject = false) {
  const origin = String(skill?.origin ?? '').toLowerCase();
  const scope = String(skill?.scope ?? '').toLowerCase();
  const isProject = ['project', 'repository', 'repo'].includes(origin) && ['project', 'repository', 'repo'].includes(scope);
  const root = alignProject ? workspaceRoot(run) : null;
  if (isProject && root && typeof skill?.path === 'string' && path.isAbsolute(skill.path)) {
    const relative = path.relative(root, path.resolve(skill.path));
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      const logicalPath = relative.split(path.sep).join('/');
      return `project:${skill.origin ?? skill.scope ?? 'unknown'}:${skill.scope ?? 'unknown'}:${skill.provider ?? ''}:${logicalPath}`;
    }
  }
  return skill?.id ?? ([skill?.provider, skill?.name, skill?.origin, skill?.path].filter(Boolean).join('|') || skill?.name || 'unknown');
}
const sorted = values => [...new Set(values.filter(value => value != null).map(String))].sort();

function metricValue(run, key) {
  const value = run?.metrics?.[key] ?? run?.usage?.totals?.values?.[key] ?? run?.usage?.totals?.[key] ?? run?.usage?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value.value === 'number' && Number.isFinite(value.value)) return value.value;
  return null;
}

function compareSet(left, right) {
  const leftComplete = left.every(value => value != null && value !== '');
  const rightComplete = right.every(value => value != null && value !== '');
  const a = sorted(left), b = sorted(right);
  const unknown = !leftComplete || !rightComplete || !a.length || !b.length;
  return {
    status: unknown ? 'unknown' : (JSON.stringify(a) === JSON.stringify(b) ? 'match' : 'different'),
    left: a, right: b,
    added: b.filter(value => !a.includes(value)),
    removed: a.filter(value => !b.includes(value)),
    unknown,
  };
}

function completeCoverage(run, key) {
  return !['partial', 'unavailable', 'unknown', 'not-found'].includes(run?.coverage?.[key] ?? 'unknown');
}

function eventBehavior(run) {
  const events = list(run?.events);
  const byKind = new Map(), byTool = new Map();
  const nativeCalls = new Map();
  for (const event of events) {
    const kind = event.kind ?? 'unknown';
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const metadata = event.metadata ?? {};
    const itemType = event.itemType ?? metadata.itemType;
    const tool = metadata.tool ?? metadata.toolName ?? event.tool ?? event.toolName;
    if (event.kind === 'tool-call' && tool != null) byTool.set(String(tool), (byTool.get(String(tool)) ?? 0) + 1);
    else if (['item/started', 'item/completed'].includes(kind) &&
      /function.?call|tool.?call|mcp|command.?execution|computer.?call|web.?search.?call/i.test(String(itemType ?? ''))) {
      const itemId = event.itemId ?? metadata.itemId ?? metadata.callId;
      const agentId = event.agentId ?? event.threadId ?? metadata.agentId ?? '';
      const key = itemId == null ? `${agentId}\0${event.turnId ?? ''}\0${itemType}\0${tool ?? ''}\0${event.sourceLine ?? ''}`
        : `${agentId}\0${event.turnId ?? ''}\0${itemId}`;
      nativeCalls.set(key, tool ?? itemType);
    }
  }
  for (const tool of nativeCalls.values()) byTool.set(String(tool), (byTool.get(String(tool)) ?? 0) + 1);
  const coverage = run?.coverage?.timeline ?? 'unknown';
  const status = ['unavailable', 'unknown', 'not-found'].includes(coverage) ? 'unknown'
    : coverage === 'partial' ? 'partial'
      : events.length ? 'observed' : 'none-recorded';
  return { status, observedEventCount: events.length, eventCount: status === 'observed' || status === 'none-recorded' ? events.length : null,
    byKind: Object.fromEntries([...byKind].sort(([a], [b]) => a.localeCompare(b))),
    byTool: Object.fromEntries([...byTool].sort(([a], [b]) => a.localeCompare(b))), events };
}

function compareBehavior(left, right) {
  const a = eventBehavior(left), b = eventBehavior(right);
  const kinds = sorted([...Object.keys(a.byKind), ...Object.keys(b.byKind)]);
  const tools = sorted([...Object.keys(a.byTool), ...Object.keys(b.byTool)]);
  const compareCounts = (keys, leftMap, rightMap, known) => Object.fromEntries(keys.map(key => [key, {
    left: leftMap[key] ?? 0, right: rightMap[key] ?? 0,
    delta: known ? (rightMap[key] ?? 0) - (leftMap[key] ?? 0) : null,
    status: known ? 'known' : 'partial-or-unknown',
  }]));
  const bothComplete = completeCoverage(left, 'timeline') && completeCoverage(right, 'timeline');
  return { left: a, right: b, eventKinds: compareCounts(kinds, a.byKind, b.byKind, bothComplete),
    tools: compareCounts(tools, a.byTool, b.byTool, bothComplete),
    countDelta: a.eventCount == null || b.eventCount == null ? null : b.eventCount - a.eventCount,
    countStatus: bothComplete ? 'known' : 'partial-or-unknown' };
}

function cataloguedNonPluginOrigin(run, item) {
  if (item?.pluginId || item?.resolution !== 'catalogued' || !item?.skillId || !item?.agentId) return null;
  const skill = list(run?.skills).find(candidate => candidate?.id === item.skillId);
  if (!skill || !list(skill.observations).some(observation => observation?.kind === 'native-invocation-observed' && observation.agentId === item.agentId)) return null;
  const origin = String(skill.origin ?? skill.scope ?? '').toLowerCase();
  const scope = String(skill.scope ?? '').toLowerCase();
  const canonicalScope = value => ['project', 'repository', 'repo'].includes(value) ? 'project' : value;
  const reportedScope = String(item.scope ?? '').toLowerCase();
  if (!['project', 'repository', 'repo', 'user', 'system', 'admin', 'personal'].includes(origin) ||
      ['plugin', 'extension'].includes(scope) || !reportedScope ||
      ![origin, scope].filter(Boolean).some(value => canonicalScope(value) === canonicalScope(reportedScope))) return null;
  return origin;
}

function skillInvocationSummary(run) {
  const present = Array.isArray(run?.skillInvocations);
  const reportedStatus = run?.coverage?.skillInvocationTelemetry ?? run?.skillTelemetry?.status ?? 'unknown';
  const status = ['observed', 'partial', 'unavailable'].includes(reportedStatus) ? reportedStatus : 'unknown';
  const invocations = present ? run.skillInvocations.map(item => ({
    agentId: item.agentId ?? null, turnId: item.turnId ?? null, unattributedActorId: item.unattributedActorId ?? null,
    skillName: item.skillName ?? null, scope: item.scope ?? null, pluginId: item.pluginId ?? null,
    skillId: item.skillId ?? null, nonPluginOrigin: cataloguedNonPluginOrigin(run, item),
    invocationType: ['explicit', 'implicit'].includes(item.invocationType) ? item.invocationType : null,
    resolution: item.resolution ?? item.attribution ?? 'unknown',
    candidateSkillIds: list(item.candidateSkillIds).slice(0, 20), reason: item.reason ?? null,
    timestampNs: typeof item.timestampNs === 'string' && /^\d{1,30}$/.test(item.timestampNs) ? item.timestampNs : null,
    observationId: typeof item.observationId === 'string' && /^[a-f0-9]{32}:[1-9][0-9]{0,4}$/.test(item.observationId) ? item.observationId : null,
  })) : [];
  const byAgent = new Map();
  for (const item of invocations) {
    const key = item.agentId ?? (item.unattributedActorId ? `unattributed:${item.unattributedActorId}` : 'unattributed:unknown');
    const row = byAgent.get(key) ?? { agentId: item.agentId, unattributedActorId: item.unattributedActorId, count: 0,
      explicit: 0, implicit: 0, unknownType: 0, resolutions: {} };
    row.count++;
    if (item.invocationType === 'explicit') row.explicit++;
    else if (item.invocationType === 'implicit') row.implicit++;
    else row.unknownType++;
    row.resolutions[item.resolution] = (row.resolutions[item.resolution] ?? 0) + 1;
    byAgent.set(key, row);
  }
  const telemetry = run?.skillTelemetry ?? {};
  return { status, delivery: telemetry.delivery ?? 'unknown', boundary: telemetry.boundary ?? null,
    warnings: list(telemetry.warnings).slice(0, 30), observedCount: invocations.length,
    invocations, byAgent: [...byAgent.values()].sort((a, b) => String(a.agentId ?? a.unattributedActorId ?? '').localeCompare(String(b.agentId ?? b.unattributedActorId ?? ''))) };
}

function compareSkillInvocations(left, right) {
  const a = skillInvocationSummary(left), b = skillInvocationSummary(right);
  const identityComplete = item => Boolean(item.skillName && item.scope && item.invocationType && (item.pluginId || item.nonPluginOrigin));
  const providerFor = item => item.pluginId ?? item.nonPluginOrigin;
  const keyFor = item => JSON.stringify([item.skillName, item.scope, providerFor(item), item.invocationType]);
  const rows = new Map();
  const incomplete = { left: [], right: [] };
  for (const [side, summary] of [['left', a], ['right', b]]) for (const item of summary.invocations) {
    if (!identityComplete(item)) { incomplete[side].push(item); continue; }
    const key = keyFor(item);
    const row = rows.get(key) ?? { identity: { skillName: item.skillName, scope: item.scope, pluginId: item.pluginId,
      provider: providerFor(item), invocationType: item.invocationType }, left: 0, right: 0 };
    row[side]++;
    rows.set(key, row);
  }
  const bothObserved = a.status === 'observed' && b.status === 'observed';
  const counts = [...rows.values()].sort((x, y) => keyFor(x.identity).localeCompare(keyFor(y.identity))).map(row => ({ ...row,
    delta: bothObserved ? row.right - row.left : null,
    status: bothObserved ? 'recorded-counts-comparable' : 'partial-or-unknown' }));
  return { left: a, right: b, counts, incomplete,
    status: bothObserved ? 'recorded-observations-comparable' : 'partial-or-unknown',
    note: 'Native skill telemetry is best-effort event evidence; recorded counts do not establish exhaustive detection or delivery.' };
}

function instructionSummary(run) {
  const known = new Set(list(run?.agents).map(agent => agent?.id).filter(value => typeof value === 'string'));
  const rawRows = list(run?.instructionSources), ownedRows = rawRows.filter(row => known.has(row?.agentId));
  const sources = compactInstructionSources(ownedRows, { maxAgents: 160, maxSources: 64 });
  const missingOwned = list(run?.agents).some(agent => !ownedRows.some(row => row.agentId === agent?.id));
  const rowByAgent = new Map(sources.rows.map(row => [row.agentId, row]));
  const roles = stableAgentRoles(run), roleMembers = new Map();
  for (const [agentId, role] of roles) roleMembers.set(role, [...(roleMembers.get(role) ?? []), agentId]);
  const roleRows = new Map([...roleMembers].filter(([, ids]) => ids.length === 1).map(([role, ids]) => [role, rowByAgent.get(ids[0]) ?? null]));
  const hasUsableSnapshot = sources.rows.some(row => row.status !== 'unavailable');
  const explicitCoverage = run?.coverage?.instructions;
  let status;
  if (explicitCoverage === 'unavailable' || !hasUsableSnapshot) status = 'unavailable';
  else if (explicitCoverage === 'partial') status = 'partial';
  else if (rawRows.length !== ownedRows.length || missingOwned || sources.status === 'partial') status = 'partial';
  else if (explicitCoverage === 'observed') status = hasUsableSnapshot ? 'observed' : 'unavailable';
  else status = sources.status;
  const alignedAgentIds = new Set([...roleMembers.values()].filter(ids => ids.length === 1).flat());
  return { status, rows: sources.rows, roleRows, roleMembers, alignedAgentIds, agentCount: known.size,
    ambiguousAgents: Math.max(0, known.size - alignedAgentIds.size) };
}
function compareInstructionSources(left, right) {
  const a = instructionSummary(left), b = instructionSummary(right);
  const roles = sorted([...a.roleRows.keys()].filter(role => b.roleRows.has(role)));
  const comparisons = roles.map(role => {
    const x = a.roleRows.get(role), y = b.roleRows.get(role);
    const emptyKnown = x && y && ['reported-empty', 'reported'].includes(x.status) && ['reported-empty', 'reported'].includes(y.status);
    const signature = row => row ? JSON.stringify([row.reportedCount, row.sources.map(item => [item.id, item.origin, item.name])]) : null;
    return { rolePath: role, left: x, right: y, status: !emptyKnown ? 'unknown' : signature(x) === signature(y) ? 'match' : 'different',
      note: 'Loaded metadata does not prove that instructions were followed or that the captured list is exhaustive.' };
  });
  const sharedAgentIds = { left: new Set(), right: new Set() };
  for (const role of roles) {
    sharedAgentIds.left.add(a.roleMembers.get(role)[0]);
    sharedAgentIds.right.add(b.roleMembers.get(role)[0]);
  }
  const unalignedAgents = { left: Math.max(a.ambiguousAgents, a.agentCount - sharedAgentIds.left.size),
    right: Math.max(b.ambiguousAgents, b.agentCount - sharedAgentIds.right.size) };
  const status = a.status === 'observed' && b.status === 'observed' && !unalignedAgents.left && !unalignedAgents.right
    && comparisons.length > 0 && comparisons.every(row => row.status !== 'unknown') ? 'comparable' : 'partial-or-unknown';
  return { status,
    left: { status: a.status, rows: a.rows, omittedAgents: Math.max(0, list(left?.instructionSources).length - a.rows.length) },
    right: { status: b.status, rows: b.rows, omittedAgents: Math.max(0, list(right?.instructionSources).length - b.rows.length) },
    unalignedAgents, roles: comparisons,
    note: 'Only uniquely aligned hierarchical agent roles are compared; missing rows remain unknown, and root source evidence is never substituted for a child snapshot.' };
}

const toolIdentity = item => JSON.stringify([item.kind ?? 'unknown', item.serverName ?? '', item.pluginId ?? '',
  item.namespace ?? '', item.toolName ?? '', item.scriptPath ?? '']);
const scriptLabel = item => item?.kind === 'command' && item.pluginId && safePluginScriptPath(item.scriptPath)
  ? ` · script ${shown(item.scriptPath)}` : '';
function toolCoverage(run, key) {
  return run?.coverage?.[key] ?? 'unknown';
}
function toolInvocationSummary(run) {
  const hasRecords = Array.isArray(run?.toolInvocations);
  const coverage = toolCoverage(run, 'tools');
  const invocations = hasRecords ? run.toolInvocations.map(item => ({
    agentId: item.agentId ?? null, turnId: item.turnId ?? null, itemId: item.itemId ?? null,
    kind: item.kind ?? 'unknown', serverName: item.serverName ?? item.server ?? null, pluginId: item.pluginId ?? null,
    ...(item.kind === 'command' && item.pluginId && safePluginScriptPath(item.scriptPath) ? { scriptPath: item.scriptPath } : {}),
    namespace: item.namespace ?? null, toolName: item.toolName ?? item.tool ?? null, status: item.status ?? 'unknown',
    success: typeof item.success === 'boolean' ? item.success : null,
    durationMs: Number.isFinite(item.durationMs) && item.durationMs >= 0 ? item.durationMs : null,
    startedAtMs: Number.isFinite(item.startedAtMs) ? item.startedAtMs : null,
    completedAtMs: Number.isFinite(item.completedAtMs) ? item.completedAtMs : null,
    observedStartedAtMs: Number.isFinite(item.observedStartedAtMs) ? item.observedStartedAtMs : null,
    observedCompletedAtMs: Number.isFinite(item.observedCompletedAtMs) ? item.observedCompletedAtMs : null,
    observedElapsedMs: Number.isFinite(item.observedElapsedMs) ? item.observedElapsedMs : null,
    source: item.source ?? null, sourceLine: Number.isFinite(item.sourceLine) ? item.sourceLine : null,
    failed: typeof item.failed === 'boolean' ? item.failed : typeof item.error === 'boolean' ? item.error : null,
    exitCode: Number.isSafeInteger(item.exitCode) && item.exitCode >= -2147483648 && item.exitCode <= 2147483647 ? item.exitCode : null,
    failureReason: item.failureReason ?? null,
  })) : [];
  const complete = !['partial', 'unavailable', 'unknown', 'not-found'].includes(coverage);
  const status = !hasRecords || ['unavailable', 'unknown', 'not-found'].includes(coverage) ? 'unknown'
    : coverage === 'partial' ? 'partial' : invocations.length ? 'observed' : 'none-recorded';
  const byAgent = new Map();
  for (const item of invocations) {
    const key = item.agentId ?? 'unknown';
    const row = byAgent.get(key) ?? { agentId: item.agentId, count: 0, statuses: {}, durationMs: 0, durationCount: 0 };
    row.count++;
    row.statuses[item.status] = (row.statuses[item.status] ?? 0) + 1;
    if (item.durationMs != null) { row.durationMs += item.durationMs; row.durationCount++; }
    byAgent.set(key, row);
  }
  const counts = new Map();
  for (const item of invocations) {
    const key = toolIdentity(item), row = counts.get(key) ?? { kind: item.kind, serverName: item.serverName,
      pluginId: item.pluginId, namespace: item.namespace, toolName: item.toolName,
      ...(item.scriptPath ? { scriptPath: item.scriptPath } : {}), count: 0 };
    row.count++;
    counts.set(key, row);
  }
  const legacy = !hasRecords && Array.isArray(run?.events) ? eventBehavior(run).byTool : null;
  return { status, coverage, observedCount: invocations.length, count: complete && hasRecords ? invocations.length : null,
    invocations, byAgent: [...byAgent.values()].sort((a, b) => String(a.agentId).localeCompare(String(b.agentId))),
    byIdentity: [...counts.values()].sort((a, b) => toolIdentity(a).localeCompare(toolIdentity(b))),
    legacyEventTools: legacy, legacyCoverage: legacy ? toolCoverage(run, 'timeline') : null };
}
function observedPluginUsage(run) {
  const seen = new Set(), rows = new Map(), unknown = [], ownershipUnknown = [];
  let unknownTotal = 0, ownershipUnknownTotal = 0;
  const MAX_UNKNOWN_EVIDENCE = 100;
  const add = (pluginId, agentId, turnId, evidenceType, key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const evidence = { agentId: agentId ?? null, turnId: turnId ?? null, type: evidenceType };
    if (!pluginId || !agentId) { unknownTotal++; if (unknown.length < MAX_UNKNOWN_EVIDENCE) unknown.push(evidence); return; }
    const row = rows.get(pluginId) ?? { pluginId, count: 0, evidence: [] };
    row.count++;
    if (row.evidence.length < 100) row.evidence.push(evidence);
    rows.set(pluginId, row);
  };
  for (const item of list(run?.skillInvocations)) {
    const resolution = String(item?.resolution ?? item?.attribution ?? '').toLowerCase();
    const catalogSkill = item.skillId ? list(run?.skills).find(skill => skill?.id === item.skillId) : null;
    const origin = String(catalogSkill?.origin ?? catalogSkill?.scope ?? '').toLowerCase();
    const scope = String(catalogSkill?.scope ?? '').toLowerCase();
    const nonPluginOrigins = ['profile', 'project', 'repository', 'repo', 'user', 'system', 'admin', 'personal', 'built-in', 'builtin'];
    const knownNonPlugin = Boolean(catalogSkill && !item.pluginId &&
      (nonPluginOrigins.includes(origin) || ((!origin || origin === 'unknown') && nonPluginOrigins.includes(scope))));
    if (knownNonPlugin) continue;
    if (!item.pluginId && !['resolved', 'ambiguous', 'catalogued'].includes(resolution)) continue;
    const key = JSON.stringify(['skill', item.agentId ?? null, item.turnId ?? null, item.skillName ?? null,
      item.scope ?? null, item.pluginId ?? null, item.invocationType ?? null, item.timestampNs ?? null, item.source ?? null,
      typeof item.observationId === 'string' && /^[a-f0-9]{32}:[1-9][0-9]{0,4}$/.test(item.observationId) ? item.observationId : null]);
    add(item.pluginId, item.agentId, item.turnId, 'native-skill-invocation', key);
  }
  for (const item of list(run?.toolInvocations)) {
    const kind = String(item?.kind ?? '').toLowerCase();
    if (kind === 'command' && item.pluginId) {
      const key = JSON.stringify(['plugin-command', item.agentId ?? null, item.turnId ?? null, item.itemId ?? null,
        item.pluginId, item.toolName ?? item.tool ?? null, item.startedAtMs ?? null]);
      add(item.pluginId, item.agentId, item.turnId, 'plugin-command-call', key);
      continue;
    }
    if (kind !== 'mcp') continue;
    const key = JSON.stringify(['mcp', item.agentId ?? null, item.turnId ?? null, item.itemId ?? null,
      item.serverName ?? item.server ?? null, item.toolName ?? item.tool ?? null, item.pluginId ?? null]);
    if (!item.pluginId) {
      if (!seen.has(key)) { seen.add(key); ownershipUnknownTotal++; if (ownershipUnknown.length < MAX_UNKNOWN_EVIDENCE) ownershipUnknown.push({ agentId: item.agentId ?? null, turnId: item.turnId ?? null, type: 'mcp-call-plugin-ownership-unknown' }); }
      continue;
    }
    add(item.pluginId, item.agentId, item.turnId, 'mcp-call', key);
  }
  const coverage = run?.coverage?.skillInvocationTelemetry ?? run?.skillTelemetry?.status ?? 'unknown';
  const toolCoverageStatus = run?.coverage?.tools ?? 'unknown';
  const complete = !['partial', 'unavailable', 'unknown', 'not-found'].includes(coverage) &&
    !['partial', 'unavailable', 'unknown', 'not-found'].includes(toolCoverageStatus);
  const byPlugin = [...rows.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  for (const row of byPlugin) row.evidenceOmitted = Math.max(0, row.count - row.evidence.length);
  return { status: complete ? 'observed' : 'partial-or-unknown', byPlugin, unknown,
    unknownCount: unknownTotal, unknownOmitted: Math.max(0, unknownTotal - unknown.length), ownershipUnknown,
    ownershipUnknownCount: ownershipUnknownTotal, ownershipUnknownOmitted: Math.max(0, ownershipUnknownTotal - ownershipUnknown.length),
    note: 'Observed plugin use comes only from attributed native skill invocations, plugin command calls and MCP calls with known plugin ownership and actor identity. Catalog and ready-state records are not use evidence. Coverage is best-effort.' };
}
function mcpRuntimeSummary(run) {
  const hasRecords = Array.isArray(run?.mcp?.servers);
  const records = hasRecords ? run.mcp.servers.map(item => ({ name: item.name ?? item.serverName ?? item.server ?? null,
    pluginId: item.pluginId ?? null, status: item.status ?? 'unknown', failureReason: item.failureReason ?? null, source: item.source ?? null,
    sourceLine: Number.isFinite(item.sourceLine) ? item.sourceLine : null })) : [];
  const coverage = toolCoverage(run, 'mcp');
  const complete = !['partial', 'unavailable', 'unknown', 'not-found'].includes(coverage);
  const status = !hasRecords || ['unavailable', 'unknown', 'not-found'].includes(coverage) ? 'unknown'
    : coverage === 'partial' ? 'partial' : records.length ? 'observed' : 'none-recorded';
  const counts = new Map();
  for (const item of records) {
    const key = JSON.stringify([item.name ?? '', item.pluginId ?? '']);
    const row = counts.get(key) ?? { name: item.name, pluginId: item.pluginId, count: 0, statuses: {} };
    row.count++;
    row.statuses[item.status] = (row.statuses[item.status] ?? 0) + 1;
    counts.set(key, row);
  }
  return { status, coverage, inventory: run?.mcp?.inventory ?? 'unknown', observedCount: records.length, count: complete && hasRecords ? records.length : null,
    servers: records, byIdentity: [...counts.values()].sort((a, b) => JSON.stringify([a.name, a.pluginId]).localeCompare(JSON.stringify([b.name, b.pluginId]))) };
}
function compareObservedCounts(leftRows, rightRows, identity, leftComplete, rightComplete) {
  const keyed = new Map();
  for (const [side, rows] of [['left', leftRows], ['right', rightRows]]) for (const item of rows) {
    const key = identity(item), row = keyed.get(key) ?? { identity: {
      kind: item.kind ?? null, serverName: item.serverName ?? null, pluginId: item.pluginId ?? null,
      namespace: item.namespace ?? null, toolName: item.toolName ?? null, name: item.name ?? null,
      ...(item.scriptPath ? { scriptPath: item.scriptPath } : {}),
    }, left: 0, right: 0 };
    row[side]++;
    keyed.set(key, row);
  }
  return [...keyed.values()].sort((a, b) => identity(a.identity).localeCompare(identity(b.identity))).map(row => {
    const known = leftComplete && rightComplete;
    return { ...row, delta: known ? row.right - row.left : null, status: known ? 'known' : 'partial-or-unknown' };
  });
}
function compareToolEvidence(left, right) {
  const a = toolInvocationSummary(left), b = toolInvocationSummary(right);
  const toolsComplete = completeCoverage(left, 'tools') && completeCoverage(right, 'tools') &&
    Array.isArray(left?.toolInvocations) && Array.isArray(right?.toolInvocations);
  const mcpComplete = completeCoverage(left, 'mcp') && completeCoverage(right, 'mcp') &&
    Array.isArray(left?.mcp?.servers) && Array.isArray(right?.mcp?.servers);
  const toolCounts = compareObservedCounts(a.invocations, b.invocations, toolIdentity, toolsComplete, toolsComplete);
  const mcpIdentity = item => JSON.stringify([item.name ?? '', item.pluginId ?? '']);
  const leftMcp = mcpRuntimeSummary(left), rightMcp = mcpRuntimeSummary(right);
  const mcpCounts = compareObservedCounts(leftMcp.servers, rightMcp.servers, mcpIdentity, mcpComplete, mcpComplete);
  return { tools: { left: a, right: b, counts: toolCounts, status: toolsComplete ? 'known' : 'partial-or-unknown' },
    mcp: { left: leftMcp, right: rightMcp, counts: mcpCounts,
      status: mcpComplete ? 'known' : 'partial-or-unknown' } };
}

const HOOK_FIELDS = ['agentId', 'turnId', 'hookRunId', 'occurrenceIndex', 'eventName', 'scope', 'sourceKind', 'handlerType',
  'executionMode', 'status', 'startedAtSeconds', 'completedAtSeconds', 'durationMs', 'source', 'sourceLine'];
const HOOK_ENUMS = {
  eventName: new Set(['preToolUse', 'permissionRequest', 'postToolUse', 'preCompact', 'postCompact', 'sessionStart', 'sessionEnd', 'userPromptSubmit', 'subagentStart', 'subagentStop', 'stop', 'interrupt']),
  scope: new Set(['thread', 'turn']), sourceKind: new Set(['system', 'user', 'project', 'mdm', 'sessionFlags', 'plugin', 'cloudRequirements', 'cloudManagedConfig', 'legacyManagedConfigFile', 'legacyManagedConfigMdm', 'unknown']),
  handlerType: new Set(['command', 'mcpTool', 'prompt', 'agent']), executionMode: new Set(['sync', 'async']),
  status: new Set(['running', 'completed', 'failed', 'blocked', 'stopped']),
};
function hookSummary(run) {
  const coverage = run?.coverage?.hooks ?? 'unknown';
  const rawRows = list(run?.hookInvocations);
  const rows = rawRows.filter(item => item &&
    HOOK_ENUMS.eventName.has(item.eventName) && HOOK_ENUMS.scope.has(item.scope) &&
    HOOK_ENUMS.sourceKind.has(item.sourceKind) && HOOK_ENUMS.handlerType.has(item.handlerType) &&
    HOOK_ENUMS.executionMode.has(item.executionMode))
    .slice(0, 1000).map(item => Object.fromEntries(HOOK_FIELDS.map(key => [key,
      key === 'durationMs' || key === 'startedAtSeconds' || key === 'completedAtSeconds' || key === 'sourceLine' || key === 'occurrenceIndex'
        ? (Number.isFinite(item[key]) && item[key] >= 0 ? item[key] : null)
        : key === 'status' ? (HOOK_ENUMS.status.has(item.status) ? item.status : 'unknown')
          : (typeof item[key] === 'string' && item[key].length <= 256 ? item[key] : null)])));
  const invalidCount = rawRows.length - rows.length;
  const status = ['unavailable', 'unknown', 'not-found'].includes(coverage) ? 'unknown'
    : coverage === 'partial' || invalidCount ? 'partial' : rows.length ? 'observed' : 'none-recorded';
  return { status, coverage, observedCount: rows.length, invalidCount, invocations: rows };
}

// Role paths are used only when each sibling role is unique; ambiguous agent
// identities are intentionally excluded from cross-run alignment.
function stableAgentRoles(run) {
  const agents = list(run?.agents), byId = new Map(agents.map(agent => [agent.id, agent]));
  const paths = new Map();
  const visit = (agent, visiting = new Set()) => {
    if (paths.has(agent.id)) return paths.get(agent.id);
    if (visiting.has(agent.id)) return null;
    visiting.add(agent.id);
    const siblings = agents.filter(candidate => (candidate.parentId ?? null) === (agent.parentId ?? null));
    const role = agent.parentId == null ? 'root' : agent.role;
    if (typeof role !== 'string' || !role || (agent.parentId != null && siblings.filter(item => item.role === role).length !== 1)) return null;
    const parent = agent.parentId == null ? '' : visit(byId.get(agent.parentId) ?? {}, visiting);
    if (agent.parentId != null && !parent) return null;
    const pathValue = agent.parentId == null ? 'root' : `${parent}/${role}`;
    paths.set(agent.id, pathValue);
    return pathValue;
  };
  for (const agent of agents) if (agent?.id) visit(agent);
  return paths;
}
function turnOrdinals(run) {
  const ordinals = new Map(), counts = new Map();
  const rows = turns(run);
  for (const turn of rows) {
    const key = `${turn.agentId}\0${turn.turnId}`;
    if (ordinals.has(key)) continue;
    const ordinal = counts.get(turn.agentId) ?? 0;
    counts.set(turn.agentId, ordinal + 1);
    ordinals.set(key, ordinal);
  }
  return ordinals;
}
function hookIdentity(item, role, ordinal) {
  return JSON.stringify([role ?? null, ordinal ?? null, item.eventName, item.sourceKind, item.scope, item.handlerType, item.executionMode, item.status]);
}
function compareHooks(left, right) {
  const a = hookSummary(left), b = hookSummary(right), rows = new Map();
  const alignmentOmitted = { left: 0, right: 0 };
  for (const [side, run, summary] of [['left', left, a], ['right', right, b]]) {
    const roles = stableAgentRoles(run), ordinals = turnOrdinals(run);
    for (const item of summary.invocations) {
      const role = roles.get(item.agentId);
      const ordinal = item.turnId == null ? null : ordinals.get(`${item.agentId}\0${item.turnId}`);
      // Cannot compare events whose actor or turn cannot be aligned uniquely.
      if (!role || !HOOK_ENUMS.status.has(item.status) || (item.scope === 'turn' && ordinal == null)) {
        alignmentOmitted[side]++;
        continue;
      }
      const key = hookIdentity(item, role, ordinal);
      const row = rows.get(key) ?? { identity: { agentRole: role, turnOrdinal: ordinal, eventName: item.eventName,
        sourceKind: item.sourceKind, scope: item.scope, handlerType: item.handlerType, executionMode: item.executionMode, status: item.status }, left: 0, right: 0 };
      row[side]++;
      rows.set(key, row);
    }
  }
  const known = ['observed', 'none-recorded'].includes(a.status) && ['observed', 'none-recorded'].includes(b.status)
    && alignmentOmitted.left === 0 && alignmentOmitted.right === 0;
  return { left: a, right: b, counts: [...rows.values()].sort((x, y) => JSON.stringify(x.identity).localeCompare(JSON.stringify(y.identity))
  ).map(row => ({ ...row, delta: known ? row.right - row.left : null, status: known ? 'recorded-counts-comparable' : 'partial-or-unknown' })),
  status: known && alignmentOmitted.left === 0 && alignmentOmitted.right === 0 ? 'recorded-observations-comparable' : 'partial-or-unknown',
  unaligned: { left: a.invalidCount + alignmentOmitted.left, right: b.invalidCount + alignmentOmitted.right },
  note: 'Hook comparisons align only recorded events with uniquely matched agent roles and turn ordinals; missing events remain unknown unless both hook captures are complete.' };
}

function validatedTurnUsage(run) {
  const summary = run?.usage?.turns, contract = summary?.contract;
  const expected = nativeUsageAccounting(contract?.version);
  if (!summary || !expected || !Object.entries(expected).every(([key, value]) => contract?.[key] === value) ||
    summary.scope !== 'captured-owned-thread-turns' || !['complete', 'partial'].includes(summary.status) ||
    run?.source?.kind !== 'native-app-server-v2' || run?.source?.version !== expected.version ||
    run?.source?.historyMode !== expected.historyMode || run?.source?.freshThread !== expected.freshThread ||
    !run?.usage?.accounting || !Object.entries(expected).every(([key, value]) => run.usage.accounting[key] === value)) return null;
  const turnRows = list(summary.turns).slice(0, 1000).map(row => ({
    agentId: typeof row.agentId === 'string' && row.agentId.length <= 256 ? row.agentId : null,
    turnId: typeof row.turnId === 'string' && row.turnId.length <= 256 ? row.turnId : null,
    status: ['complete', 'partial'].includes(row.status) ? row.status : 'unknown',
    values: Object.fromEntries(USAGE_FIELDS.map(field => [field, Number.isSafeInteger(row.values?.[field]) && row.values[field] >= 0 ? row.values[field] : null])),
    baseline: Object.fromEntries(USAGE_FIELDS.map(field => [field, Number.isSafeInteger(row.baseline?.[field]) && row.baseline[field] >= 0 ? row.baseline[field] : null])),
    fields: Object.fromEntries(USAGE_FIELDS.map(field => [field, ['observed', 'partial', 'unavailable', 'invalid'].includes(row.fields?.[field]?.status) ? row.fields[field].status : 'unknown'])),
    derivation: { method: typeof row.derivation?.method === 'string' ? row.derivation.method.slice(0, 80) : null,
      initialBaseline: ['verified-fresh-thread-zero', 'prior-terminal-boundary'].includes(row.derivation?.initialBaseline) ? row.derivation.initialBaseline : null,
      sourceObservations: list(row.derivation?.sourceObservations).slice(0, 20).map(item => ({
        source: item?.source === 'thread/tokenUsage/updated' ? item.source : 'unknown',
        sourceLine: Number.isSafeInteger(item?.sourceLine) && item.sourceLine >= 1 ? item.sourceLine : null,
      })), sourceObservationsOmitted: Number.isSafeInteger(row.derivation?.sourceObservationsOmitted) ? row.derivation.sourceObservationsOmitted : 0 },
  }));
  return { status: summary.status, scope: summary.scope, reason: summary.reason ?? null, contract: expected,
    turns: turnRows, turnsOmitted: Number.isSafeInteger(summary.turnsOmitted) ? summary.turnsOmitted : 0,
    revalidation: summary.revalidation ?? null,
    derivation: summary.derivation && typeof summary.derivation === 'object' ? {
      method: typeof summary.derivation.method === 'string' ? summary.derivation.method.slice(0, 80) : null,
      basis: typeof summary.derivation.basis === 'string' ? summary.derivation.basis.slice(0, 80) : null,
      agents: Number.isSafeInteger(summary.derivation.agents) ? summary.derivation.agents : null,
      turns: Number.isSafeInteger(summary.derivation.turns) ? summary.derivation.turns : null,
      observations: Number.isSafeInteger(summary.derivation.observations) ? summary.derivation.observations : null,
    } : null };
}
function compareTurnUsage(left, right) {
  const a = validatedTurnUsage(left), b = validatedTurnUsage(right), paired = new Map();
  if (a && b) {
    const align = (run, usage) => {
      const roles = stableAgentRoles(run), ordinals = turnOrdinals(run), result = new Map();
      const duplicateKeys = new Set();
      for (const turn of usage.turns) {
        const role = roles.get(turn.agentId), ordinal = ordinals.get(`${turn.agentId}\0${turn.turnId}`);
        if (!role || ordinal == null) continue;
        const key = `${role}\0${ordinal}`;
        if (result.has(key)) { duplicateKeys.add(key); result.delete(key); continue; }
        if (!duplicateKeys.has(key)) result.set(key, turn);
      }
      return result;
    };
    const la = align(left, a), rb = align(right, b);
    for (const key of new Set([...la.keys(), ...rb.keys()])) paired.set(key, { left: la.get(key) ?? null, right: rb.get(key) ?? null });
  }
  const fields = Object.fromEntries(USAGE_FIELDS.map(field => [field, []]));
  for (const [key, pair] of paired) for (const field of USAGE_FIELDS) {
    const lv = pair.left?.values[field] ?? null, rv = pair.right?.values[field] ?? null;
    const leftFieldKnown = pair.left?.fields[field] === 'observed', rightFieldKnown = pair.right?.fields[field] === 'observed';
    fields[field].push({ roleAndOrdinal: key.replace('\0', ' · turn '), left: lv, right: rv,
      leftCoverage: pair.left?.fields[field] ?? 'unknown', rightCoverage: pair.right?.fields[field] ?? 'unknown',
      delta: !leftFieldKnown || !rightFieldKnown || lv == null || rv == null ? null : rv - lv,
      status: leftFieldKnown && rightFieldKnown && lv != null && rv != null ? 'known' : 'unknown' });
  }
  const sourceDetailOmitted = (run, usage) => Number(run?.evidenceBounds?.omitted?.agents ?? 0) > 0 ||
    Number(run?.evidenceBounds?.omitted?.turns ?? 0) > 0 || Number(usage?.turnsOmitted ?? 0) > 0;
  const alignmentComplete = Boolean(a && b && paired.size > 0 && !sourceDetailOmitted(left, a) && !sourceDetailOmitted(right, b) &&
    [...paired.values()].every(pair => pair.left && pair.right) && paired.size === a.turns.length && paired.size === b.turns.length);
  return { status: a && b ? (a.status === 'complete' && b.status === 'complete' && alignmentComplete ? 'complete' : 'partial') : 'unknown',
    left: a, right: b, fields, note: a && b ? 'Turn deltas use verified cumulative-boundary summaries paired by unique agent role and turn ordinal.' : 'Verified whole-turn usage requires a matching native source and accounting contract on both runs.' };
}

function agentSummary(run) {
  const agents = list(run?.agents);
  const coverage = run?.coverage?.agents ?? 'unknown';
  const status = ['unavailable', 'unknown', 'not-found'].includes(coverage) ? 'unknown'
    : coverage === 'partial' ? 'partial'
      : agents.length ? 'observed' : 'none-recorded';
  return { status, observedAgentCount: agents.length, agentCount: status === 'observed' || status === 'none-recorded' ? agents.length : null,
    childCount: agents.filter(agent => agent.parentId != null).length,
    maxDepth: agents.length ? Math.max(...agents.map(agent => Number(agent.depth) || 0)) : status === 'none-recorded' ? 0 : null,
    agents: agents.map(agent => ({ id: agent.id, parentId: agent.parentId ?? null, depth: agent.depth ?? null, role: agent.role ?? null, status: agent.status ?? null, source: agent.source ?? null })) };
}

function artifactSummary(run) {
  const artifacts = list(run?.artifacts).map(item => ({ kind: item.kind ?? 'unknown', path: item.path ?? null,
    patchPath: item.patchPath ?? null, label: item.label ?? null, fingerprint: item.fingerprint ?? null,
    fileCount: item.fileCount ?? null, status: item.status ?? 'unknown', agentId: item.agentId ?? null,
    turnId: item.turnId ?? null, sourceLine: item.sourceLine ?? null }));
  const coverage = run?.coverage?.workspaceDiff ?? 'unknown';
  const complete = !['partial', 'unavailable', 'unknown', 'not-found'].includes(coverage);
  return { status: complete ? artifacts.length ? 'observed' : 'none-recorded' : coverage === 'partial' ? 'partial' : 'unknown',
    observedCount: artifacts.length, count: complete ? artifacts.length : null, artifacts };
}

function workspaceSnapshot(run, stage) {
  const value = stage === 'taskEnd'
    ? run?.workspace?.taskEnd ?? run?.outcome?.taskEndWorkspace ?? run?.taskEnd
    : run?.workspace?.checkEnd ?? run?.finalWorkspace ?? run?.outcome?.finalWorkspace;
  if (!value || typeof value !== 'object') return null;
  return stage === 'taskEnd' && !Number.isSafeInteger(value.fileCount) && Number.isSafeInteger(value.files)
    ? { ...value, fileCount: value.files } : value;
}

function compareArtifacts(left, right) {
  const a = artifactSummary(left), b = artifactSummary(right);
  const key = item => `${item.kind}\0${item.path ?? item.patchPath ?? item.label ?? item.fingerprint ?? `unidentified:${item.agentId ?? ''}:${item.turnId ?? ''}:${item.sourceLine ?? ''}`}\0${item.status}\0${item.fingerprint ?? ''}`;
  const aSet = new Set(a.artifacts.map(key)), bSet = new Set(b.artifacts.map(key));
  const known = a.count != null && b.count != null;
  const sameBaseline = sameVerifiedBaseline(left, right);
  const snapshots = Object.fromEntries(['taskEnd', 'checkEnd'].map(stage => {
    const l = workspaceSnapshot(left, stage), r = workspaceSnapshot(right, stage);
    const exactTaskEnd = stage !== 'taskEnd' || (l?.captureComplete === true && r?.captureComplete === true &&
      l?.timing === 'task-end' && r?.timing === 'task-end');
    const comparable = sameBaseline && l?.fingerprint != null && r?.fingerprint != null &&
      Number.isFinite(l?.fileCount) && Number.isFinite(r?.fileCount) && exactTaskEnd &&
      l?.captureComplete !== false && r?.captureComplete !== false;
    const side = value => value ? { fingerprint: value.fingerprint ?? null, fileCount: value.fileCount ?? null,
      baselineFingerprint: stage === 'taskEnd' ? value.baselineFingerprint ?? null : null,
      changedFileCount: stage === 'taskEnd' ? value.changedFileCount ?? null : null,
      changeCountStatus: stage === 'taskEnd' ? value.changeCountStatus ?? 'unknown' : null,
      changeCountBasis: stage === 'taskEnd' && value.changeCountBasis === TASK_CHANGE_BASIS ? value.changeCountBasis : null,
      changeCountReason: stage === 'taskEnd' && TASK_CHANGE_REASONS.has(value.changeCountReason) ? value.changeCountReason : null,
      captureComplete: value.captureComplete ?? null, timing: value.timing ?? null, status: value.status ?? null } : null;
    const changeCountKnown = stage === 'taskEnd' && sameBaseline && exactTaskEnd && l?.changeCountStatus === 'known' && r?.changeCountStatus === 'known' &&
      Number.isSafeInteger(l.changedFileCount) && l.changedFileCount >= 0 && Number.isSafeInteger(r.changedFileCount) && r.changedFileCount >= 0 &&
      l.changeCountBasis === TASK_CHANGE_BASIS && r.changeCountBasis === TASK_CHANGE_BASIS;
    const changes = stage === 'taskEnd' ? { left: l?.changedFileCount ?? null, right: r?.changedFileCount ?? null,
      status: changeCountKnown ? 'known' : 'unknown', delta: changeCountKnown ? r.changedFileCount - l.changedFileCount : null,
      basis: changeCountKnown ? l.changeCountBasis : null,
      reason: changeCountKnown ? null : (!exactTaskEnd && (l || r) ? 'task-end-boundary-unverified' :
        !sameBaseline ? 'runs-do-not-share-verified-baseline' : l?.changeCountReason ?? r?.changeCountReason ?? 'task-change-count-unavailable') } : null;
    return [stage, { left: side(l), right: side(r), ...(changes ? { changes } : {}),
      status: comparable ? (l.fingerprint === r.fingerprint && l.fileCount === r.fileCount ? 'equal' : 'different') : 'unknown',
      reason: comparable ? null : !sameBaseline ? 'Runs do not share a verified commit and tree.' : !exactTaskEnd ? 'Task-end capture timing or completeness is unverified.' : 'Snapshot fingerprints, file counts, or capture completeness are unavailable.' }];
  }));
  return { left: a, right: b, status: known ? 'known' : 'partial-or-unknown', snapshots,
    added: known ? b.artifacts.filter(item => !aSet.has(key(item))) : [],
    removed: known ? a.artifacts.filter(item => !bSet.has(key(item))) : [],
    delta: known ? b.count - a.count : null };
}

function outcomeSummary(run) {
  const outcome = run?.outcome ?? {};
  const claim = outcome.claim ?? run?.outcomeClaim ?? null;
  const checks = list(outcome.checks).map(check => ({ name: check.name ?? check.id ?? 'unknown', status: check.status ?? 'unknown', sourceLine: check.sourceLine ?? null }));
  const coverage = run?.coverage?.outcome ?? 'unknown';
  const status = ['unavailable', 'unknown', 'not-found'].includes(coverage) ? 'unknown'
    : coverage === 'partial' ? 'partial'
      : claim || checks.length ? 'observed' : 'none-recorded';
  return { status, claim: claim ? { success: claim.success ?? null, status: claim.status ?? 'unknown',
    agentId: claim.agentId ?? null, turnId: claim.turnId ?? null, sourceLine: claim.sourceLine ?? null, evidence: claim.evidence ?? null } : null,
    checks, recordedOutcomeStatus: outcome.status ?? 'unknown' };
}

function compareOutcomes(left, right) {
  const a = outcomeSummary(left), b = outcomeSummary(right);
  const complete = completeCoverage(left, 'outcome') && completeCoverage(right, 'outcome');
  return { left: a, right: b, status: complete ? 'recorded-evidence-comparable' : 'partial-or-unknown',
    claimStatus: a.claim && b.claim ? (a.claim.success === b.claim.success && a.claim.status === b.claim.status ? 'match' : 'different') : 'unknown',
    checks: compareSet(a.checks.map(check => `${check.name}:${check.status}`), b.checks.map(check => `${check.name}:${check.status}`)),
    conclusion: 'Recorded completion claims and check statuses describe available evidence; they do not establish task quality or a winner.' };
}

const TOKEN_FIELDS = ['inputTokens', 'input_tokens', 'outputTokens', 'output_tokens', 'cachedInputTokens', 'cached_input_tokens',
  'reasoningOutputTokens', 'reasoning_output_tokens', 'cacheWriteInputTokens', 'cache_write_input_tokens', 'totalTokens', 'total_tokens'];
function tokenValues(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(TOKEN_FIELDS.filter(key => Number.isFinite(value[key]) && value[key] >= 0).map(key => [key, value[key]]));
}
function usageEntries(run) {
  const usage = run?.usage ?? {};
  const explicit = run?.captureUsage ?? run?.capture?.usage;
  const source = explicit && typeof explicit === 'object' ? explicit : usage;
  const entries = [];
  if (Array.isArray(source.byAgent)) {
    for (const item of source.byAgent) if (item && typeof item.agentId === 'string') entries.push({ agentId: item.agentId,
      scope: item.scope ?? item.totals?.scope ?? 'unknown', mode: item.mode ?? 'source-reported',
      total: tokenValues(item.total ?? item.totals?.values), last: tokenValues(item.last), snapshots: item.snapshots ?? null });
  } else {
    for (const [agentId, item] of Object.entries(source)) {
      if (!item || typeof item !== 'object' || !(Object.hasOwn(item, 'total') || Object.hasOwn(item, 'last') || Object.hasOwn(item, 'snapshots'))) continue;
      entries.push({ agentId, scope: item.scope ?? 'per-agent-source-reported', mode: item.mode ?? 'source-reported',
        total: tokenValues(item.total), last: tokenValues(item.last), snapshots: Number.isSafeInteger(item.snapshots) ? item.snapshots : null });
    }
  }
  return entries.sort((a, b) => a.agentId.localeCompare(b.agentId));
}
function rootUsage(run) {
  const usage = run?.usage ?? {};
  const aggregate = usage?.totals;
  if (aggregate?.values && typeof aggregate.values === 'object') return {
    scope: aggregate.scope ?? 'unknown', status: 'source-reported', values: tokenValues(aggregate.values),
  };
  const entries = usageEntries(run);
  const rootAgent = list(run?.agents).find(agent => agent.parentId == null && Number(agent.depth ?? 0) === 0);
  const rootId = run?.source?.threadId ?? rootAgent?.id;
  const root = entries.find(item => item.agentId === rootId);
  return root && Object.keys(root.total).length ? { scope: 'root-agent-source-reported', status: 'source-reported', values: root.total } :
    { scope: 'root-agent-source-reported', status: 'unknown', values: {} };
}
function validatedWorkflowUsage(run) {
  const usage = run?.usage ?? {}, accounting = usage.accounting, workflow = usage.workflow;
  const expected = nativeUsageAccounting(accounting?.version);
  if (!workflow || !expected || !Object.entries(expected).every(([key, value]) => accounting?.[key] === value) ||
      workflow.scope !== 'captured-workflow-agents' || run?.source?.kind !== 'native-app-server-v2' ||
      run?.source?.version !== accounting.version || run?.source?.historyMode !== 'paginated' || run?.source?.freshThread !== true ||
      !['complete', 'partial', 'unavailable'].includes(workflow.status)) return null;
  const values = Object.fromEntries(USAGE_FIELDS.map(field => [field,
    Number.isSafeInteger(workflow.values?.[field]) && workflow.values[field] >= 0 ? workflow.values[field] : null]));
  const fields = Object.fromEntries(USAGE_FIELDS.map(field => [field, workflow.fields?.[field] ?? null]));
  const rawDerivation = workflow.derivation && typeof workflow.derivation === 'object' ? workflow.derivation : {};
  const derivation = Object.keys(rawDerivation).length ? { method: typeof rawDerivation.method === 'string' ? rawDerivation.method.slice(0, 100) : null,
    basis: typeof rawDerivation.basis === 'string' ? rawDerivation.basis.slice(0, 100) : null,
    agents: Number.isSafeInteger(rawDerivation.agents) && rawDerivation.agents >= 0 ? rawDerivation.agents : null,
    turns: Number.isSafeInteger(rawDerivation.turns) && rawDerivation.turns >= 0 ? rawDerivation.turns : null,
    observations: Number.isSafeInteger(rawDerivation.observations) && rawDerivation.observations >= 0 ? rawDerivation.observations : null } : null;
  return { status: workflow.status, scope: workflow.scope, reason: workflow.reason ?? null, derivation,
    revalidation: workflow.revalidation ?? null, values, fields, accounting: expected };
}
function compareWorkflowUsage(left, right) {
  const a = validatedWorkflowUsage(left), b = validatedWorkflowUsage(right);
  const accountingMatches = Boolean(a && b && a.scope === b.scope && ['complete', 'partial'].includes(a.status) && ['complete', 'partial'].includes(b.status));
  const fields = Object.fromEntries(USAGE_FIELDS.map(field => {
    const lv = a?.values[field] ?? null, rv = b?.values[field] ?? null;
    const known = Boolean(accountingMatches && lv !== null && rv !== null);
    return [field, { left: lv, right: rv, delta: known ? rv - lv : null, status: known ? 'known' : 'unknown',
      leftCoverage: a?.fields[field]?.status ?? 'unknown', rightCoverage: b?.fields[field]?.status ?? 'unknown' }];
  }));
  return { status: accountingMatches ? (a.status === 'complete' && b.status === 'complete' ? 'complete' : 'partial') : 'unknown',
    scope: accountingMatches ? a.scope : 'unknown', left: a, right: b, fields,
    note: accountingMatches ? 'Source-reported cumulative counters were summed once across owned workflow agents.' : 'A validated common workflow accounting contract is unavailable; workflow deltas are unknown.' };
}
function compareUsage(left, right) {
  const a = rootUsage(left), b = rootUsage(right);
  const aFields = a.values, bFields = b.values;
  const comparableScope = a.scope === b.scope && a.status === 'source-reported' && b.status === 'source-reported';
  const fields = sorted([...Object.keys(aFields), ...Object.keys(bFields)]);
  const deltas = Object.fromEntries(fields.map(field => [field, {
    left: aFields[field] ?? null, right: bFields[field] ?? null,
    delta: comparableScope && aFields[field] != null && bFields[field] != null ? bFields[field] - aFields[field] : null,
    status: comparableScope && aFields[field] != null && bFields[field] != null ? 'known' : 'unknown',
  }]));
  return { scope: comparableScope ? a.scope : 'root-session-only-scope-unverified', status: comparableScope ? 'source-reported' : 'unknown',
    left: a, right: b, deltas, byAgent: { left: usageEntries(left), right: usageEntries(right) },
    workflowTotal: null, workflowTotalStatus: 'unknown', workflow: compareWorkflowUsage(left, right),
    turns: compareTurnUsage(left, right),
    note: 'Root-session counters remain separate from validated workflow counters.' };
}

function turns(run) {
  if (Array.isArray(run?.turns) && run.turns.length) return run.turns;
  return list(run?.agents).flatMap(agent => list(agent.turns).map(turn => ({ ...turn, agentId: turn.agentId ?? agent.id })));
}

function expectedControls({ expectModel, expectEffort } = {}) {
  if (expectModel === undefined && expectEffort === undefined) return null;
  if ((expectModel === undefined) !== (expectEffort === undefined)) throw new Error('expectModel and expectEffort must be supplied together');
  for (const [key, value, limit] of [['expectModel', expectModel, 256], ['expectEffort', expectEffort, 64]]) {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
      throw new Error(`${key} must be nonempty plain text of at most ${limit} characters`);
  }
  return { expectModel, expectEffort };
}
function compareExpected(left, right, expectedControlsValue) {
  const controls = expectedControlsValue;
  if (!controls) return null;
  const { expectModel, expectEffort } = controls;
  const mismatches = [], unknowns = [];
  for (const [side, run] of [['left', left], ['right', right]]) {
    const observations = turns(run);
    if (!observations.length) unknowns.push({ side, field: 'turns', reason: 'No recorded turns are available.' });
    for (const turn of observations) for (const [field, expected, key] of [
      ['model', expectModel, 'model'], ['reasoningEffort', expectEffort, 'reasoningEffort'],
    ]) {
      const observed = turn[key] ?? turn[field];
      const context = { side, agentId: turn.agentId ?? null, turnId: turn.turnId ?? null, sourceLine: turn.sourceLine ?? null, field };
      if (observed == null || observed === '') unknowns.push({ ...context, reason: `No recorded ${field} for this turn.` });
      else if (observed !== expected) mismatches.push({ ...context, expected, observed });
    }
  }
  return { model: expectModel, reasoningEffort: expectEffort,
    status: mismatches.length ? 'different' : unknowns.length ? 'unknown' : 'match', mismatches, unknowns };
}

/** Compare recorded run evidence while preserving unknowns and provenance. */
export function compareAuditRuns(left, right, options = {}) {
  const leftInstructions = instructionSummary(left), rightInstructions = instructionSummary(right);
  const safeLeftCoverage = { ...(left?.coverage ?? {}) }, safeRightCoverage = { ...(right?.coverage ?? {}) };
  if (Object.hasOwn(left?.coverage ?? {}, 'instructions')) safeLeftCoverage.instructions = leftInstructions.status;
  if (Object.hasOwn(right?.coverage ?? {}, 'instructions')) safeRightCoverage.instructions = rightInstructions.status;
  const safeLeft = { ...left, instructionSources: leftInstructions.rows, coverage: safeLeftCoverage };
  const safeRight = { ...right, instructionSources: rightInstructions.rows, coverage: safeRightCoverage };
  const controls = expectedControls(options);
  const leftTurns = turns(left), rightTurns = turns(right);
  const expected = compareExpected(left, right, controls);
  const modelSets = compareSet(leftTurns.map(turn => turn.model), rightTurns.map(turn => turn.model));
  const effortSets = compareSet(leftTurns.map(turn => turn.reasoningEffort), rightTurns.map(turn => turn.reasoningEffort));
  const metricNames = sorted([
    ...Object.keys(left?.metrics ?? {}), ...Object.keys(right?.metrics ?? {}),
    ...Object.keys(left?.usage?.totals?.values ?? left?.usage?.totals ?? {}),
    ...Object.keys(right?.usage?.totals?.values ?? right?.usage?.totals ?? {}),
  ].filter(name => !name.startsWith('workflow.')));
  const metrics = Object.fromEntries(metricNames.map(name => {
    const a = metricValue(left, name), b = metricValue(right, name);
    return [name, { left: a, right: b, delta: a == null || b == null ? null : b - a,
      percentDelta: a == null || b == null || a === 0 ? null : ((b - a) / Math.abs(a)) * 100,
      status: a == null || b == null ? 'unknown' : 'known' }];
  }));

  const skills = new Map();
  const alignProjectSkills = sameVerifiedBaseline(left, right);
  for (const [side, run] of [['left', left], ['right', right]]) for (const skill of list(run?.skills)) {
    const key = projectSkillIdentity(skill, run, alignProjectSkills);
    if (!skills.has(key)) skills.set(key, { id: key, name: skill.name ?? key, left: null, right: null });
    const observations = list(skill.observations).map(observation => ({
      kind: observation.kind ?? observation.evidence ?? 'unknown', agentId: observation.agentId ?? null,
      turnId: observation.turnId ?? null, sourceLine: observation.sourceLine ?? null,
      ...(observation.itemId ? { itemId: observation.itemId } : {}),
      ...(observation.source ? { source: observation.source } : {}),
      ...(observation.confidence ? { confidence: observation.confidence } : {}),
      ...(['native-read-action', 'native-unknown-absolute-cat'].includes(observation.readCorroboration) ? { readCorroboration: observation.readCorroboration } : {}),
      ...(observation.pathAuthority === 'literal-command-target' ? { pathAuthority: 'literal-command-target' } : {}),
      ...(['direct', 'shell-command', 'login-shell-command'].includes(observation.commandWrapper) ? { commandWrapper: observation.commandWrapper } : {}),
      ...(observation.evidence && typeof observation.evidence === 'object' ? { evidence: {
        ...(observation.evidence.source ? { source: observation.evidence.source } : {}),
        ...(observation.evidence.confidence ? { confidence: observation.evidence.confidence } : {}),
        ...(['native-read-action', 'native-unknown-absolute-cat'].includes(observation.evidence.readCorroboration) ? { readCorroboration: observation.evidence.readCorroboration } : {}),
        ...(observation.evidence.pathAuthority === 'literal-command-target' ? { pathAuthority: 'literal-command-target' } : {}),
        ...(['direct', 'shell-command', 'login-shell-command'].includes(observation.evidence.commandWrapper) ? { commandWrapper: observation.evidence.commandWrapper } : {}),
      } } : {}),
    }));
    skills.get(key)[side] = { origin: skill.origin ?? skill.scope ?? 'unknown', scope: skill.scope ?? 'unknown',
      provider: skill.provider ?? null, path: skill.path ?? null, logicalPath: key.startsWith('project:') ? key.split(':').at(-1) : null,
      status: skill.status ?? 'observed', observations,
      availability: skill.availability ?? skill.status ?? 'unknown' };
  }
  return {
    schemaVersion: 1, kind: 'audit-comparison', left: safeLeft, right: safeRight,
    comparison: {
      models: modelSets, reasoningEfforts: effortSets,
      metrics,
      behavior: compareBehavior(left, right),
      ...compareToolEvidence(left, right),
      hooks: compareHooks(left, right),
      usage: compareUsage(left, right),
      agents: { left: agentSummary(left), right: agentSummary(right) },
      artifacts: compareArtifacts(left, right),
      outcomes: compareOutcomes(left, right),
      skills: [...skills.values()].sort((a, b) => a.id.localeCompare(b.id)),
      skillInvocations: compareSkillInvocations(left, right),
      instructionSources: compareInstructionSources(left, right),
      plugins: { left: observedPluginUsage(left), right: observedPluginUsage(right), status: 'partial-or-unknown' },
      coverage: {
        left: { ...(left?.coverage ?? {}) }, right: { ...(right?.coverage ?? {}) },
      },
      expectation: expected,
      conclusion: 'Observed differences describe these runs. They do not establish that a profile setup caused an outcome or is a winner.',
    },
  };
}

function agentLabel(agent) {
  return `${'  '.repeat(Math.max(0, Math.min(10, Number(agent.depth) || 0)))}- ${shown(agent.name ?? agent.id ?? 'unknown agent')} (id ${shown(agent.id)}, parent ${shown(agent.parentId)})`;
}
function renderCoverage(coverage) {
  const entries = Object.entries(coverage ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([name, status]) => `  ${shown(name)}: ${shown(coverageStatus(status))}`).join('\n') : '  unknown';
}
function skillProofLabel(observation) {
  const evidence = observation?.evidence ?? {};
  const fields = [['source', observation?.source ?? evidence.source],
    ['confidence', observation?.confidence ?? evidence.confidence],
    ['read corroboration', observation?.readCorroboration ?? evidence.readCorroboration],
    ['path authority', observation?.pathAuthority ?? evidence.pathAuthority],
    ['wrapper', observation?.commandWrapper ?? evidence.commandWrapper]];
  const values = fields.filter(([, value]) => value).map(([label, value]) => `${label} ${shown(value)}`);
  return values.length ? ` [${values.join(', ')}]` : '';
}
function renderSkills(skills) {
  if (!skills.length) return '  No skill records; skill-use coverage is unknown.';
  return skills.map(skill => {
    const observations = list(skill.observations);
    const byAgent = observations.length ? observations.map(item => `${shown(item.kind ?? item.evidence)} by ${shown(item.agentId)} turn ${shown(item.turnId)}${item.sourceLine == null ? '' : ` line ${item.sourceLine}`}${skillProofLabel(item)}`).join('; ') : 'no observed invocation/load/activity';
    return `  ${shown(skill.name)} [${shown(skill.id)}] · origin ${shown(skill.origin ?? skill.scope)} · provider ${shown(skill.provider)} · availability ${shown(skill.availability ?? skill.status)}\n    Evidence: ${byAgent}`;
  }).join('\n');
}
function renderInstructionSources(run) {
  const summary = instructionSummary(run);
  const lines = [`Instruction source snapshots: ${shown(summary.status)} · ${summary.rows.length} recorded agents`];
  for (const row of summary.rows.slice(0, 50)) {
    const labels = row.sources.map(source => `${source.name} [${source.origin}; ${source.id}]`).join(', ') || 'none listed';
    lines.push(`  Agent ${shown(row.agentId)} · ${shown(row.status)} · ${shown(row.source)} · ${shown(row.phase)} · line ${shown(row.sourceLine)} · reported ${shown(row.reportedCount)} · omitted ${shown(row.omittedCount)} · rejected ${shown(row.rejectedCount)} · ${labels}${row.reason ? ` · reason ${shown(row.reason)}` : ''}`);
  }
  if (summary.rows.length > 50) lines.push(`  … ${summary.rows.length - 50} agents omitted from display.`);
  lines.push('  Reported loaded metadata records instruction sources; it does not establish that their contents were followed or that the list is exhaustive. An empty reported list does not prove no instructions were used.');
  return lines.join('\n');
}
function renderCaptureAcceptance(acceptance) {
  if (!acceptance) return [];
  const lines = [`Capture acceptance: ${shown(acceptance.status)} · mode ${shown(acceptance.mode)} · exhaustive consumption ${shown(acceptance.exhaustiveConsumption)}`];
  if (acceptance.boundary) lines.push(`  Boundary: ${shown(acceptance.boundary)}`);
  if (acceptance.requirements) lines.push(`  Requirements: ${safeJson(acceptance.requirements)}`);
  for (const item of list(acceptance.checks).slice(0, 50)) lines.push(`  ${shown(item.id)} · ${shown(item.status)}${item.required == null ? '' : ` · required ${shown(item.required)}`}${item.observed == null ? '' : ` · observed ${shown(item.observed)}`}${item.observations == null ? '' : ` · observations ${shown(item.observations)}`}${item.reason ? ` · ${shown(item.reason)}` : ''}${item.agentId ? ` · agent ${shown(item.agentId)}` : ''}${item.turnId ? ` · turn ${shown(item.turnId)}` : ''}${item.missingFields?.length ? ` · missing fields ${item.missingFields.map(shown).join(', ')}` : ''}${item.selector ? ` · selector ${safeJson(item.selector)}` : ''}`);
  if (list(acceptance.checks).length > 50) lines.push(`  … ${acceptance.checks.length - 50} additional acceptance checks omitted.`);
  return lines;
}
function renderSkillTelemetryDiagnostics(telemetry) {
  const diagnostics = telemetry?.diagnostics ?? {}, lines = [];
  if (telemetry?.capability) lines.push(`Skill-use capability: ${shown(telemetry.capability)} · delivery ${shown(telemetry.delivery)}`);
  const transport = diagnostics.transport;
  if (transport) lines.push(`Skill telemetry transport: ${shown(transport.status)} · received ${shown(transport.receivedBytes)} bytes · rejected ${shown(transport.rejectedRequests)}${list(transport.warnings).length ? ` · warnings ${list(transport.warnings).slice(0, 10).map(shown).join(', ')}` : ''}`);
  const journal = diagnostics.journal;
  if (journal) lines.push(`Skill telemetry journal: ${shown(journal.status)} · ${shown(journal.bytes)} bytes · ${shown(journal.eventCount)} events`);
  const byAgent = diagnostics.missingness?.byAgent;
  const agents = Array.isArray(byAgent) ? byAgent.slice(0, 50).map(row => [row.agentId, row.origins ?? {}])
    : Object.entries(byAgent ?? {}).slice(0, 50);
  for (const [agentId, origins] of agents) for (const [origin, item] of Object.entries(origins ?? {}).slice(0, 20))
    lines.push(`Skill telemetry ${shown(agentId)} · ${shown(origin)} · catalog ${shown(item.catalogCount)} · invocations ${shown(item.invocationCount)} · ${shown(item.status)}${item.reason ? ` · ${shown(item.reason)}` : ''}`);
  if (diagnostics.missingness?.byAgentOmitted) lines.push(`Skill telemetry missingness omitted ${shown(diagnostics.missingness.byAgentOmitted)} agents.`);
  return lines;
}
function renderSkillTelemetry(run) {
  const summary = skillInvocationSummary(run);
  const telemetry = run?.skillTelemetry ?? {};
  const lines = [`Native skill invocation telemetry: ${shown(summary.status)} · delivery ${shown(summary.delivery)} · ${shown(summary.observedCount)} observed events`,
    '  Native events are best-effort detected-use evidence; they do not establish all skill use.'];
  if (summary.boundary) lines.push(`  Boundary: ${shown(summary.boundary)}`);
  if (summary.byAgent.length) {
    lines.push('  Per-agent recorded invocations (explicit / implicit / unknown type):');
    for (const row of summary.byAgent) lines.push(`    ${shown(row.agentId ?? (row.unattributedActorId ? `unattributed actor ${row.unattributedActorId}` : 'unattributed'))} · ${shown(row.count)} total · ${shown(row.explicit)} / ${shown(row.implicit)} / ${shown(row.unknownType)} · resolutions ${safeJson(row.resolutions)}`);
  }
  if (summary.invocations.length) {
    lines.push('  Invocation observations:');
    for (const item of summary.invocations.slice(0, 50)) {
      const who = item.agentId ? `agent ${shown(item.agentId)}` : `unattributed${item.unattributedActorId ? ` actor ${shown(item.unattributedActorId)}` : ''}`;
      const candidates = item.candidateSkillIds.length ? ` · candidates ${item.candidateSkillIds.map(shown).join(', ')}` : '';
      lines.push(`    ${shown(item.skillName)} · scope ${shown(item.scope)} · plugin ${shown(item.pluginId)} · ${shown(item.invocationType)} · ${shown(item.resolution)} · ${who}${item.skillId ? ` · catalog skill ${shown(item.skillId)}` : ''}${item.turnId ? ` · turn ${shown(item.turnId)}` : ''}${item.reason ? ` · reason ${shown(item.reason)}` : ''}${candidates}${item.timestampNs ? ` · timestamp ${shown(item.timestampNs)} ns` : ''}`);
    }
    if (summary.invocations.length > 50) lines.push(`    … ${summary.invocations.length - 50} additional skill invocation observations omitted.`);
  } else if (summary.status === 'observed') lines.push('  No native skill invocation events observed. Best-effort coverage does not establish no skill use.');
  else lines.push('  Native skill invocation observations unavailable.');
  if (summary.warnings.length) lines.push(`  Telemetry warnings: ${summary.warnings.map(shown).join(', ')}`);
  lines.push(...renderSkillTelemetryDiagnostics(telemetry));
  return lines.join('\n');
}
function renderSkillInvocationComparison(comparison) {
  if (!comparison) return '';
  const lines = [`Native skill invocation comparison: ${shown(comparison.status)}`,
    ...comparison.counts.map(row => `  ${shown(row.identity.skillName)} · scope ${shown(row.identity.scope)} · provider ${shown(row.identity.provider)} · ${shown(row.identity.invocationType)}: ${shown(row.left)} → ${shown(row.right)} · recorded-event delta ${shown(row.delta)} (${shown(row.status)})`)];
  for (const side of ['left', 'right']) {
    const entries = list(comparison.incomplete?.[side]);
    if (!entries.length) continue;
    lines.push(`  ${side} observations with incomplete identity (counts not aligned):`);
    for (const item of entries.slice(0, 50)) lines.push(`    ${shown(item.skillName)} · scope ${shown(item.scope)} · plugin ${shown(item.pluginId)} · ${shown(item.invocationType)} · ${shown(item.resolution)}${item.agentId ? ` · agent ${shown(item.agentId)}` : ' · unattributed'}${item.candidateSkillIds.length ? ` · candidates ${item.candidateSkillIds.map(shown).join(', ')}` : ''}`);
  }
  lines.push(`  ${shown(comparison.note)}`);
  return lines.join('\n');
}
function renderPluginUsage(summary, label = 'Observed plugin use') {
  const lines = [`${label}: ${shown(summary.status)} · observed counts from native skill invocations, MCP calls and plugin script commands`];
  for (const row of summary.byPlugin) lines.push(`  ${shown(row.pluginId)} · ${shown(row.count)} observed uses${row.evidenceOmitted ? ` · ${shown(row.evidenceOmitted)} evidence rows omitted` : ''} · ${row.evidence.map(item => `${shown(item.type)} agent ${shown(item.agentId)} turn ${shown(item.turnId)}`).join('; ')}`);
  if (summary.unknownCount) lines.push(`  Plugin identity or actor unknown: ${shown(summary.unknownCount)} observed skill events${summary.unknownOmitted ? ` · ${shown(summary.unknownOmitted)} evidence rows omitted` : ''} · ${summary.unknown.slice(0, 50).map(item => `${shown(item.type)} agent ${shown(item.agentId)} turn ${shown(item.turnId)}`).join('; ')}`);
  if (summary.ownershipUnknownCount) lines.push(`  MCP plugin ownership unknown: ${shown(summary.ownershipUnknownCount)} observed calls${summary.ownershipUnknownOmitted ? ` · ${shown(summary.ownershipUnknownOmitted)} evidence rows omitted` : ''} · ${summary.ownershipUnknown.slice(0, 50).map(item => `agent ${shown(item.agentId)} turn ${shown(item.turnId)}`).join('; ')}`);
  if (!summary.byPlugin.length && !summary.unknownCount && !summary.ownershipUnknownCount) lines.push('  No plugin use evidence recorded; this does not establish zero use.');
  lines.push(`  ${shown(summary.note)}`);
  return lines.join('\n');
}
function renderEvents(events) {
  const sortedEvents = [...events].sort((a, b) => String(a.recordedAt ?? '').localeCompare(String(b.recordedAt ?? '')) || (a.sourceLine ?? 0) - (b.sourceLine ?? 0));
  const shownEvents = sortedEvents.slice(0, EVENT_LIMIT).map(event => {
    const detail = [event.tool, event.name, event.status].filter(value => value != null).map(shown).join(' · ');
    const metadata = event.metadata ?? {};
    const safeMetadata = ['tool', 'toolName', 'callId', 'itemType', 'itemId', 'status', 'result', 'resultSourceLine', 'error', 'success', 'errorCode', 'exitCode', 'durationMs', 'retryCount', 'operation', 'changeCount']
      .filter(key => (metadata[key] ?? event[key]) != null).map(key => `${key}=${shown(metadata[key] ?? event[key])}`);
    for (const key of ['operations', 'types', 'resourcePaths']) if (Array.isArray(metadata[key]) && metadata[key].length)
      safeMetadata.push(`${key}=[${metadata[key].slice(0, 10).map(shown).join(', ')}${metadata[key].length > 10 ? ', …' : ''}]`);
    return `  ${shown(event.recordedAt)} · ${shown(event.kind)} · agent ${shown(event.agentId)} · turn ${shown(event.turnId)}${event.sourceLine == null ? '' : ` · line ${event.sourceLine}`}${detail ? ` · ${detail}` : ''}${safeMetadata.length ? ` · ${safeMetadata.join(', ')}` : ''}`;
  });
  if (sortedEvents.length > EVENT_LIMIT) shownEvents.push(`  … ${sortedEvents.length - EVENT_LIMIT} additional events omitted (of ${sortedEvents.length} total).`);
  return shownEvents.length ? shownEvents.join('\n') : '  No recorded events.';
}
function safeJson(value) {
  const visit = (item, depth = 0) => {
    if (depth > 8) return '[nested data omitted]';
    if (typeof item === 'string') return clean(item).slice(0, 200);
    if (typeof item === 'number' || typeof item === 'boolean' || item == null) return item;
    if (Array.isArray(item)) return item.slice(0, 30).map(value => visit(value, depth + 1));
    if (typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 40).map(([key, value]) => [clean(key).slice(0, 80), visit(value, depth + 1)]));
    return '[unsupported value]';
  };
  return JSON.stringify(visit(value));
}
function renderChecks(checks) {
  if (!checks.length) return '  No verification checks recorded.';
  return checks.slice(0, 50).map(check => {
    const name = check.name ?? check.id ?? 'unknown';
    const status = check.status ?? check.result?.status ?? 'unknown';
    const exitCode = check.exitCode ?? check.result?.exitCode;
    const durationMs = check.durationMs ?? check.result?.durationMs;
    return `  ${shown(name)}: ${shown(status)}${exitCode == null ? '' : ` · exit ${shown(exitCode)}`}${durationMs == null ? '' : ` · ${shown(durationMs)} ms`}`;
  }).join('\n');
}
function renderCapture(capture) {
  if (!capture || typeof capture !== 'object') return 'Capture evidence: unavailable';
  const lines = [`Capture evidence: ${shown(capture.status)}`];
  if (capture.observer && typeof capture.observer === 'object') lines.push(...renderNativeStorage({}, capture));
  if (capture.capabilities) lines.push(`  Capabilities: ${safeJson(capture.capabilities)}`);
  for (const key of ['byAgent', 'byOrigin']) if (capture[key]) lines.push(`  ${key}: ${safeJson(capture[key])}`);
  const errors = list(capture.errors);
  if (errors.length) lines.push(`  Capture gaps/errors:\n${errors.slice(0, 30).map(error => `    ${shown(typeof error === 'string' ? error : error.code ?? error.kind ?? error.status ?? 'unknown')}${error.agentId ? ` · agent ${shown(error.agentId)}` : ''}${error.origin ? ` · origin ${shown(error.origin)}` : ''}${error.reason ? ` · ${shown(error.reason)}` : ''}`).join('\n')}`);
  return lines.join('\n');
}
function renderNativeStorage(source = {}, capture = {}) {
  const observer = capture?.observer ?? {};
  if (source.persistence !== 'native-owned-session' && observer.nativeSessionStorage !== 'profile-owned-new-rollouts'
    && !observer.runtime) return [];
  const runtime = observer.runtime ?? {};
  return [`Native storage: session ${shown(source.persistence ?? runtime.threadPersistence)} · rollouts ${shown(observer.nativeSessionStorage)} · SQLite ${shown(runtime.sqlite)} · logs ${shown(runtime.logs)} · temporary files ${shown(runtime.temporaryFiles)} · workspace ${shown(runtime.workspace)} · saved settings changed ${shown(observer.savedSettingsChanged)}`];
}
function renderWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object') return 'Workspace snapshots: unavailable';
  const project = snapshot => {
    if (!snapshot || typeof snapshot !== 'object') return shown(snapshot);
    return ['status', 'path', 'commit', 'tree', 'fingerprint', 'fileCount', 'changedFileCount', 'changeCountStatus', 'changeCountBasis', 'changeCountReason', 'dirty', 'captureComplete', 'timing', 'recordedAt']
      .filter(key => snapshot[key] !== undefined).map(key => `${key}=${shown(snapshot[key])}`).join(', ') || safeJson(snapshot);
  };
  return [`Workspace snapshots:`, `  Task end: ${project(workspace.taskEnd)}`, `  Check end: ${project(workspace.checkEnd)}`].join('\n');
}
function renderWorkspaceComparison(comparison) {
  if (!comparison?.snapshots) return 'Workspace snapshot comparison: unknown';
  return ['Workspace snapshot comparison (same verified source commit and tree required):',
    ...['taskEnd', 'checkEnd'].map(stage => {
      const row = comparison.snapshots[stage];
      const describe = side => {
        const value = row?.[side];
        return value ? `fingerprint ${shown(value.fingerprint)} · snapshot files ${shown(value.fileCount)}${stage === 'taskEnd' ? ` · task-changed files ${shown(value.changedFileCount)} (${shown(value.changeCountStatus)})` : ''}${value.captureComplete != null ? ` · captureComplete ${shown(value.captureComplete)}` : ''}${value.timing ? ` · timing ${shown(value.timing)}` : ''}` : 'unavailable';
      };
      const changes = row?.changes ? ` · task-change delta ${shown(row.changes.status)} ${shown(row.changes.delta)}${row.changes.basis ? ` · basis ${shown(row.changes.basis)}` : ''}${row.changes.reason ? ` · ${shown(row.changes.reason)}` : ''}` : '';
      return `  ${stage}: ${shown(row?.status)} · left ${describe('left')} · right ${describe('right')}${changes}${row?.reason ? ` · ${shown(row.reason)}` : ''}`;
    })].join('\n');
}
function renderSetupSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'unknown';
  const summary = {};
  for (const key of ['status', 'capturedAt', 'fingerprint', 'version', 'profileName', 'resourceCount', 'counts'])
    if (snapshot[key] !== undefined) summary[key] = snapshot[key];
  if (snapshot.coverage && typeof snapshot.coverage === 'object') summary.coverage = snapshot.coverage;
  return safeJson(summary);
}
function renderUsage(run) {
  const root = rootUsage(run);
  const lines = [`Usage: root scope ${shown(root.scope)} · ${shown(root.status)} · ${safeJson(root.values)}`];
  const entries = usageEntries(run);
  if (entries.length) {
    lines.push('  Per-agent source counters:');
    lines.push(...entries.slice(0, 50).map(entry => `    ${shown(entry.agentId)} · ${shown(entry.scope)} · ${shown(entry.mode)} · snapshots ${shown(entry.snapshots)} · total ${safeJson(entry.total)} · last ${safeJson(entry.last)}`));
    if (entries.length > 50) lines.push(`    … ${entries.length - 50} more agents omitted.`);
  }
  const observations = list(run?.usage?.observations);
  if (observations.length) lines.push(`  Recorded per-turn usage observations: ${observations.length} · ${safeJson(observations.slice(0, 20))}${observations.length > 20 ? ' … additional observations omitted' : ''}`);
  const workflow = validatedWorkflowUsage(run);
  if (workflow) {
    lines.push(`  Workflow-wide total: ${shown(workflow.status)} · scope ${shown(workflow.scope)} · ${safeJson(workflow.values)} · accounting ${safeJson(workflow.accounting)}${workflow.derivation ? ` · derivation ${safeJson(workflow.derivation)}` : ''}${workflow.revalidation ? ` · revalidation ${shown(workflow.revalidation)}` : ''}${workflow.reason ? ` · ${shown(workflow.reason)}` : ''}`);
    lines.push(`  Workflow field coverage: ${safeJson(Object.fromEntries(USAGE_FIELDS.map(field => [field, workflow.fields[field]?.status ?? 'unknown'])))}`);
  } else lines.push('  Workflow-wide total: unknown; legacy or unvalidated per-agent counters are not added together.');
  const turnUsage = validatedTurnUsage(run);
  if (turnUsage) {
    lines.push(`  Verified whole-turn totals: ${shown(turnUsage.status)} · scope ${shown(turnUsage.scope)} · ${turnUsage.turns.length} retained turns${turnUsage.turnsOmitted ? ` · ${turnUsage.turnsOmitted} omitted` : ''}${turnUsage.revalidation ? ` · revalidation ${shown(turnUsage.revalidation)}` : ''}${turnUsage.reason ? ` · ${shown(turnUsage.reason)}` : ''}${turnUsage.derivation ? ` · derivation ${safeJson(turnUsage.derivation)}` : ''}`);
    for (const turn of turnUsage.turns.slice(0, 100)) lines.push(`    ${shown(turn.agentId)} · turn ${shown(turn.turnId)} · ${shown(turn.status)} · values ${safeJson(turn.values)} · baseline ${safeJson(turn.baseline)} · fields ${safeJson(turn.fields)} · derivation ${safeJson(turn.derivation)}`);
    if (turnUsage.turns.length > 100) lines.push(`    … ${turnUsage.turns.length - 100} verified turns omitted from text output.`);
  } else lines.push('  Verified whole-turn totals: unknown; no matching native source and whole-turn accounting contract.');
  return lines.join('\n');
}
function renderHooks(run) {
  const hooks = hookSummary(run), lines = [`Hook invocations: ${shown(hooks.status)} · coverage ${shown(hooks.coverage)} · ${hooks.observedCount} safe observations`];
  for (const item of hooks.invocations.slice(0, 100)) lines.push(`  ${shown(item.eventName)} · ${shown(item.sourceKind)} · ${shown(item.scope)} · ${shown(item.handlerType)} / ${shown(item.executionMode)} · ${shown(item.status)} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)} · run ${shown(item.hookRunId)}${item.startedAtSeconds == null ? '' : ` · started ${shown(item.startedAtSeconds)} s`}${item.completedAtSeconds == null ? '' : ` · completed ${shown(item.completedAtSeconds)} s`}${item.durationMs == null ? '' : ` · ${shown(item.durationMs)} ms`}${item.sourceLine == null ? '' : ` · line ${shown(item.sourceLine)}`}`);
  if (hooks.invocations.length > 100) lines.push(`  … ${hooks.invocations.length - 100} additional hook observations omitted.`);
  if (!hooks.invocations.length) lines.push(hooks.status === 'none-recorded' ? '  No hook invocation events recorded under complete hook coverage.' : '  Hook invocation details unavailable; no recorded event does not establish no hook use.');
  return lines.join('\n');
}
function renderToolEvidence(run) {
  const tools = toolInvocationSummary(run), mcp = mcpRuntimeSummary(run);
  const lines = [`Tool/MCP runtime evidence: tools ${shown(tools.status)} · coverage ${shown(tools.coverage)} · ${tools.count == null ? `${tools.observedCount} observed; complete count unknown` : `${tools.count} recorded calls`}`];
  if (run?.toolCaptureBoundary) lines.push(`  Boundary: ${shown(run.toolCaptureBoundary)}`);
  if (tools.byAgent.length) {
    lines.push('  Calls by agent:');
    for (const row of tools.byAgent) lines.push(`    ${shown(row.agentId)} · ${shown(row.count)} calls · statuses ${safeJson(row.statuses)} · duration ${row.durationCount ? `${shown(row.durationMs)} ms across ${shown(row.durationCount)} timed calls` : 'unknown'}`);
  } else if (tools.status === 'none-recorded') lines.push('  No calls recorded in the captured thread-item stream.');
  else lines.push('  Per-agent call counts unavailable.');
  if (tools.byIdentity.length) {
    lines.push('  Calls by kind/server/plugin/namespace/tool/script:');
    for (const row of tools.byIdentity) lines.push(`    ${shown(row.kind)} · server ${shown(row.serverName)} · plugin ${shown(row.pluginId)} · namespace ${shown(row.namespace)} · tool ${shown(row.toolName)}${scriptLabel(row)} · ${shown(row.count)}`);
  }
  for (const item of tools.invocations.slice(0, 100)) lines.push(`  Call ${shown(item.kind)} · ${shown(item.toolName)}${scriptLabel(item)} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)} · ${shown(item.status)}${item.success == null ? '' : ` · success ${shown(item.success)}`}${item.exitCode == null ? '' : ` · exit ${shown(item.exitCode)}`}${item.durationMs == null ? '' : ` · native duration ${shown(item.durationMs)} ms`}${item.observedElapsedMs == null ? '' : ` · observer elapsed ${shown(item.observedElapsedMs)} ms`}${item.failureReason ? ` · failure ${shown(item.failureReason)}` : ''}${item.startedAtMs == null ? '' : ` · started ${shown(item.startedAtMs)}`}${item.completedAtMs == null ? '' : ` · completed ${shown(item.completedAtMs)}`}${item.observedStartedAtMs == null ? '' : ` · observer started ${shown(item.observedStartedAtMs)}`}${item.observedCompletedAtMs == null ? '' : ` · observer completed ${shown(item.observedCompletedAtMs)}`}`);
  if (tools.legacyEventTools) {
    const timelineComplete = completeCoverage(run, 'timeline');
    lines.push(`  Legacy event fallback: ${timelineComplete ? 'complete' : `coverage ${shown(tools.legacyCoverage)}; counts are observed only`} · ${Object.entries(tools.legacyEventTools).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${shown(name)}=${shown(count)}`).join(', ') || 'no tool events observed'}`);
  }
  const mcpCalls = tools.invocations.filter(item => item.kind === 'mcp').length;
  lines.push(`  MCP runtime usage: ${shown(mcpCalls)} observed calls · call coverage ${shown(tools.status)} · server identity observations ${shown(mcp.status)} · inventory ${shown(mcp.inventory)}`);
  lines.push(`  MCP server observations: ${mcp.count == null ? `${mcp.observedCount} observed; complete count unknown` : `${mcp.count} observed`} · coverage ${shown(mcp.coverage)}`);
  if (mcp.byIdentity.length) for (const row of mcp.byIdentity)
    lines.push(`    server ${shown(row.name)} · plugin ${shown(row.pluginId)} · observations ${shown(row.count)} · statuses ${safeJson(row.statuses)}${mcp.servers.find(item => item.name === row.name && item.pluginId === row.pluginId)?.failureReason ? ` · failure ${shown(mcp.servers.find(item => item.name === row.name && item.pluginId === row.pluginId).failureReason)}` : ''}`);
  else lines.push(mcp.status === 'none-recorded' ? '    No MCP server observations; complete coverage establishes none observed.' : '    MCP server observations unavailable.');
  lines.push(renderPluginUsage(observedPluginUsage(run)));
  return lines.join('\n');
}
function renderToolComparison(comparison) {
  if (!comparison?.tools || !comparison?.mcp) return '';
  const lines = [`Tool invocation comparison: ${shown(comparison.tools.status)}`,
    ...comparison.tools.counts.map(row => `  ${shown(row.identity.kind)} · server ${shown(row.identity.serverName)} · plugin ${shown(row.identity.pluginId)} · namespace ${shown(row.identity.namespace)} · tool ${shown(row.identity.toolName)}${scriptLabel(row.identity)}: ${shown(row.left)} → ${shown(row.right)} · delta ${shown(row.delta)} (${shown(row.status)})`),
    ...(comparison.tools.counts.length ? [] : ['  No normalized tool invocations recorded; absence is unknown unless both tool captures are complete.']),
    `MCP runtime comparison: ${shown(comparison.mcp.status)}`,
    ...comparison.mcp.counts.map(row => `  server ${shown(row.identity.name)} · plugin ${shown(row.identity.pluginId)}: ${shown(row.left)} → ${shown(row.right)} · delta ${shown(row.delta)} (${shown(row.status)})`),
    ...(comparison.mcp.counts.length ? [] : ['  No MCP server observations recorded; absence is unknown unless both MCP captures are complete.'])];
  return lines.join('\n');
}
function captureGaps(capture) {
  if (!capture || typeof capture !== 'object') return ['capture unavailable'];
  const gaps = [];
  if (capture.status && !['ready', 'complete'].includes(capture.status)) gaps.push(`capture ${capture.status}`);
  gaps.push(...list(capture.errors).map(error => typeof error === 'string' ? error : error.code ?? error.reason ?? error.kind ?? 'capture error'));
  return gaps;
}
function flattenCoverage(coverage, prefix = '') {
  if (typeof coverage === 'string') return [{ key: prefix, status: coverage }];
  if (!coverage || typeof coverage !== 'object') return [];
  return Object.entries(coverage).flatMap(([key, value]) => flattenCoverage(value, prefix ? `${prefix}.${key}` : key));
}
function fullyCovered(coverage) {
  const values = flattenCoverage(coverage);
  return values.length > 0 && values.every(({ status }) => ['ready', 'complete'].includes(status));
}
function renderExperimentPreview(preview) {
  const baseline = preview.baseline ?? {};
  const lines = ['Audit experiment preview', `Status: ${shown(preview.status)}${preview.reason ? ` · ${shown(preview.reason)}` : ''}`,
    `Baseline: ${shown(baseline.repository)} · commit ${shown(baseline.commit)} · tree ${shown(baseline.tree)}`,
    'Profiles:'];
  for (const profile of list(preview.profiles)) lines.push(`  ${shown(profile.profileName)} · ID ${shown(profile.profileId)} · ${shown(profile.status)}${profile.busy ? ' · busy' : ''}${profile.version ? ` · version ${shown(profile.version)}` : ''}${profile.reason ? ` · ${shown(profile.reason)}` : ''}`, `    Home: ${shown(profile.home)} · executable ${shown(profile.executable)}`);
  lines.push('Limits:', preview.limits ? `  ${safeJson(preview.limits)}` : '  none recorded', 'Setup steps:');
  // Setup and check definitions expose labels only; commands and arguments stay private.
  lines.push(...(list(preview.setup).length ? list(preview.setup).map(item => `  ${shown(item.name ?? item.id ?? 'setup step')}`) : ['  none']));
  lines.push('Verification checks:', ...(list(preview.checks).length ? list(preview.checks).map(item => `  ${shown(item.name ?? item.id ?? 'check')}`) : ['  none']));
  if (list(preview.warnings).length) lines.push(`Warnings:\n${list(preview.warnings).slice(0, 30).map(item => `  ${shown(typeof item === 'string' ? item : item.code ?? item.reason ?? item.message)}`).join('\n')}`);
  if (list(preview.failures).length) lines.push(`Blocking failures:\n${list(preview.failures).slice(0, 30).map(failure =>
    `  ${shown(failure.code ?? 'unknown-failure')}${failure.scope ? ` · ${shown(failure.scope)}` : ''}${failure.profile ? ` · profile ${shown(failure.profile)}` : ''}${failure.message ? ` · ${shown(String(failure.message).slice(0, 240))}` : ''}`).join('\n')}`);
  lines.push(renderCapture(preview.capture));
  return lines.join('\n');
}
function renderExperimentReport(report, { markdown = false } = {}) {
  const baseline = report.baseline ?? {};
  const execution = report.execution ?? {};
  const lines = [markdown ? '# Audit experiment' : 'Audit experiment', `Experiment: ${shown(report.id)} · status ${shown(report.status)}`,
    `Baseline: ${shown(baseline.repository)} · commit ${shown(baseline.commit)} · tree ${shown(baseline.tree)}`,
    `Execution: ${shown(execution.status)} · elapsed ${shown(execution.elapsedMs)} ms · exit ${shown(execution.exitCode)}`,
    `Coverage:\n${renderCoverage(report.coverage)}`];
  for (const [index, run] of list(report.runs).entries()) {
    lines.push(`\nRun ${index + 1}: ${shown(run.profile?.profileName)} · ${shown(run.id)} · ${shown(run.status)}`,
      `Process: ${shown(run.execution?.status)} · exit ${shown(run.execution?.exitCode)} · elapsed ${shown(run.execution?.elapsedMs)} ms`,
      `Verification checks:\n${renderChecks(list(run.outcome?.checks ?? run.checks))}`,
      renderCapture(run.capture), renderWorkspace(run.workspace), renderRun(run));
  }
  for (const [index, comparison] of list(report.comparisons).entries()) lines.push(`\nComparison ${index + 1}:`, renderComparison(comparison));
  if (list(report.warnings).length) lines.push(`Warnings:\n${list(report.warnings).slice(0, 50).map(item => `  ${shown(typeof item === 'string' ? item : item.code ?? item.reason ?? item.message)}`).join('\n')}`);
  lines.push('Experiment differences describe these executions and do not establish causality or a winning profile.');
  return lines.join('\n');
}
function renderExperimentLifecycle(record) {
  const lines = [`Audit experiment ${record.kind === 'audit-experiment-cleanup' ? 'cleanup' : 'recovery'}`,
    `Experiment: ${shown(record.id)} · status ${shown(record.status)}`];
  if (record.reason) lines.push(`Reason: ${shown(record.reason)}`);
  lines.push('Actions:', ...(list(record.actions).length ? list(record.actions).slice(0, 50).map(action => `  ${shown(action.kind ?? action.name ?? action.status)}${action.reason ? ` · ${shown(action.reason)}` : ''}${action.path ? ` · ${shown(action.path)}` : ''}`) : ['  none recorded']));
  lines.push('Runs:', ...(list(record.runs).length ? list(record.runs).map(run => `  ${shown(run.profile?.profileName)} · ${shown(run.id)} · ${shown(run.status)} · process ${shown(run.execution?.status)}`) : ['  none recorded']));
  if (list(record.warnings).length) lines.push(`Warnings:\n${list(record.warnings).slice(0, 30).map(item => `  ${shown(typeof item === 'string' ? item : item.code ?? item.reason ?? item.message)}`).join('\n')}`);
  return lines.join('\n');
}
function renderSeriesPreview(preview) {
  const quality = preview.quality ?? {};
  const lines = [renderExperimentPreview(preview), '', `Series plan: ${shown(preview.plannedRuns)} planned runs · execution budget ${shown(preview.budget?.totalTaskBudgetMs)} ms`,
    `Quality criteria: ${shown(quality.id)} v${shown(quality.version)} · fingerprint ${shown(preview.qualityFingerprint)}`];
  if (preview.budget?.allocation) lines.push(`  ${shown(preview.budget.allocation)}`);
  for (const slot of list(preview.schedule)) lines.push(`  Trial ${shown(slot.index)} · ${list(slot.profileOrder).map(shown).join(' → ')} · cap ${shown(slot.budgetMs)} ms`);
  return lines.join('\n');
}
function renderFrozenRunEvidence(run) {
  if (!run) return [];
  const lines = [];
  lines.push(...renderNativeStorage(run.source, run.capture).map(item => `    ${item}`));
  if (run.source?.observationMode) lines.push(`    Observation: ${shown(run.source.observationMode)}${run.source.rawNativeWireSha256 ? ` · source SHA-256 ${shown(run.source.rawNativeWireSha256)}` : ''}`);
  const observations = list(run.usage?.observations);
  lines.push(`    Frozen detail: usage observations ${observations.length}${run.usage?.observationsOmitted ? ` · ${run.usage.observationsOmitted} omitted` : ''} · usage scope ${shown(run.usage?.scope)}`);
  for (const item of observations.slice(0, 100)) lines.push(`      Usage ${shown(item.agentId)} · turn ${shown(item.turnId)} · ${shown(item.disposition)} · ${shown(item.source)}${item.sourceLine == null ? '' : ` line ${shown(item.sourceLine)}`} · last ${safeJson(item.last)} · total ${safeJson(item.total)} · context ${shown(item.modelContextWindow)} · present ${safeJson(item.present)}`);
  for (const agent of list(run.usage?.byAgent).slice(0, 50)) lines.push(`      Agent counters ${shown(agent.agentId)} · ${shown(agent.scope)} · snapshots ${shown(agent.snapshots)} · total ${safeJson(agent.total)} · last ${safeJson(agent.last)} · context ${shown(agent.contextWindow)}`);
  for (const agent of list(run.agents).slice(0, 100)) lines.push(`      Agent ${shown(agent.id)} · parent ${shown(agent.parentId)} · depth ${shown(agent.depth)}${agent.sourceLine == null ? '' : ` · line ${shown(agent.sourceLine)}`}`);
  for (const turn of list(run.turns).slice(0, 200)) lines.push(`      Turn ${shown(turn.turnId)} · agent ${shown(turn.agentId)} · ${shown(turn.status)} · model ${shown(turn.model)} · effort ${shown(turn.reasoningEffort)}${turn.observedStartedAt ? ` · observed start ${shown(turn.observedStartedAt)}` : ''}${turn.observedCompletedAt ? ` · observed end ${shown(turn.observedCompletedAt)}` : ''}${turn.source ? ` · source ${shown(turn.source)}` : ''}${turn.sourceLine == null ? '' : ` · line ${shown(turn.sourceLine)}`}`);
  if (run.usageCoverage) lines.push(`    Usage field coverage ${shown(run.usageCoverage.continuity)} · observations ${shown(run.usageCoverage.observations)} · attributed ${shown(run.usageCoverage.attributed)}`,
    ...Object.entries(run.usageCoverage.byAgent ?? {}).slice(0, 50).map(([agentId, detail]) => `      Usage coverage ${shown(agentId)} · accepted ${shown(detail.accepted)} · duplicate ${shown(detail.duplicates)} · regressed ${shown(detail.regressed)} · resets ${shown(detail.resets)} · inconsistent ${shown(detail.inconsistent)} · invalid ${shown(detail.invalid)} · fields ${safeJson(detail.fields)}`));
  if (observations.length > 100) lines.push(`      … ${observations.length - 100} further usage observations omitted from text output.`);
  const workflow = validatedWorkflowUsage(run);
  if (workflow) lines.push(`    Workflow total ${shown(workflow.status)} · scope ${shown(workflow.scope)} · values ${safeJson(workflow.values)} · fields ${safeJson(Object.fromEntries(USAGE_FIELDS.map(field => [field, workflow.fields[field]?.status ?? 'unknown'])))} · accounting ${safeJson(workflow.accounting)}${workflow.derivation ? ` · derivation ${safeJson(workflow.derivation)}` : ''}${workflow.revalidation ? ` · revalidation ${shown(workflow.revalidation)}` : ''}${workflow.reason ? ` · ${shown(workflow.reason)}` : ''}`);
  const skills = list(run.skills);
  lines.push(`    Skills ${skills.length} · invocation observations ${list(run.skillInvocations).length} · telemetry ${shown(run.skillTelemetry?.status)} / ${shown(run.skillTelemetry?.capability)} / delivery ${shown(run.skillTelemetry?.delivery)}`);
  for (const skill of skills.slice(0, 50)) {
    lines.push(`      ${shown(skill.name)} [${shown(skill.id)}] · origin ${shown(skill.origin)} · scope ${shown(skill.scope)} · provider ${shown(skill.provider)} · ${shown(skill.availability)}`);
    for (const item of list(skill.observations).slice(0, 20)) lines.push(`        ${shown(item.kind)} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)}${item.itemId ? ` · item ${shown(item.itemId)}` : ''}${item.sourceLine == null ? '' : ` · line ${shown(item.sourceLine)}`}${item.source ? ` · source ${shown(item.source)}` : ''}${item.confidence ? ` · confidence ${shown(item.confidence)}` : ''}${item.readCorroboration ? ` · read corroboration ${shown(item.readCorroboration)}` : ''}${item.pathAuthority ? ` · path authority ${shown(item.pathAuthority)}` : ''}${item.commandWrapper ? ` · wrapper ${shown(item.commandWrapper)}` : ''}`);
  }
  for (const item of list(run.skillInvocations).slice(0, 100)) lines.push(`      Skill use ${shown(item.skillName)} [${shown(item.skillId)}] · plugin ${shown(item.pluginId)} · ${shown(item.invocationType)} · ${shown(item.resolution)} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)}${item.timestampNs ? ` · timestamp ${shown(item.timestampNs)} ns` : ''}${item.sourceLine == null ? '' : ` · line ${shown(item.sourceLine)}`}${item.source ? ` · source ${shown(item.source)}` : ''}${item.reason ? ` · ${shown(item.reason)}` : ''}`);
  const tools = list(run.toolInvocations), servers = list(run.mcpServers);
  lines.push(`    Tools ${tools.length} · MCP servers ${servers.length}`);
  for (const item of tools.slice(0, 100)) lines.push(`      Tool ${shown(item.kind)} · ${shown(item.serverName)} · ${shown(item.pluginId)} · ${shown(item.namespace)} · ${shown(item.toolName)}${scriptLabel(item)} · ${shown(item.status)} · success ${shown(item.success)} · exit ${shown(item.exitCode)} · native duration ${shown(item.durationMs)} ms · observer elapsed ${shown(item.observedElapsedMs)} ms · failure ${shown(item.failureReason)} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)}${item.startedAtMs == null ? '' : ` · started ${shown(item.startedAtMs)}`}${item.completedAtMs == null ? '' : ` · completed ${shown(item.completedAtMs)}`}${item.observedStartedAtMs == null ? '' : ` · observer started ${shown(item.observedStartedAtMs)}`}${item.observedCompletedAtMs == null ? '' : ` · observer completed ${shown(item.observedCompletedAtMs)}`}${item.sourceLine == null ? '' : ` · line ${shown(item.sourceLine)}`}${item.source ? ` · source ${shown(item.source)}` : ''}`);
  for (const item of servers.slice(0, 50)) lines.push(`      MCP ${shown(item.name)} · plugin ${shown(item.pluginId)} · ${shown(item.status)} · failure ${shown(item.failureReason)}${item.sourceLine == null ? '' : ` · line ${shown(item.sourceLine)}`}${item.source ? ` · source ${shown(item.source)}` : ''}`);
  lines.push(...renderHooks(run).split('\n').map(line => `    ${line}`));
  const turnUsage = validatedTurnUsage(run);
  if (turnUsage) {
    lines.push(`    Verified turn totals ${shown(turnUsage.status)} · ${turnUsage.turns.length} retained${turnUsage.turnsOmitted ? ` · ${turnUsage.turnsOmitted} omitted` : ''}${turnUsage.revalidation ? ` · ${shown(turnUsage.revalidation)}` : ''} · derivation ${safeJson(turnUsage.derivation)}`);
    for (const turn of turnUsage.turns.slice(0, 100)) lines.push(`      Turn usage ${shown(turn.agentId)} · ${shown(turn.turnId)} · ${shown(turn.status)} · ${safeJson(turn.values)} · baseline ${safeJson(turn.baseline)} · fields ${safeJson(turn.fields)} · derivation ${safeJson(turn.derivation)}`);
  } else lines.push('    Verified turn totals unknown; source/accounting contract unavailable.');
  lines.push(...renderPluginUsage(observedPluginUsage(run), 'Frozen observed plugin use').split('\n').map(line => `    ${line}`));
  const diagnostics = run.skillTelemetry?.diagnostics ?? {};
  lines.push(...renderSkillTelemetryDiagnostics(run.skillTelemetry).map(item => `    ${item}`));
  lines.push(...renderCaptureAcceptance(run.captureAcceptance).map(item => `    ${item}`));
  const omitted = run.evidenceBounds?.omitted;
  if (omitted && Object.values(omitted).some(Number)) lines.push(`    Evidence omitted counts ${safeJson(omitted)} · caps ${safeJson(Object.fromEntries(Object.entries(run.evidenceBounds).filter(([key]) => key !== 'omitted')))}`);
  if (run.usage?.byAgentOmitted) lines.push(`    Usage agent rows omitted ${shown(run.usage.byAgentOmitted)}.`);
  if (diagnostics.missingness?.byAgentOmitted) lines.push(`    Skill missingness agent rows omitted ${shown(diagnostics.missingness.byAgentOmitted)}.`);
  return lines;
}
function renderSeriesReport(report, { markdown = false } = {}) {
  const baseline = report.baseline ?? {}, recipe = report.recipe ?? {};
  const lines = [markdown ? '# Audit series' : 'Audit series', `Series: ${shown(report.id)} · status ${shown(report.status)} · exit ${shown(report.exitCode)}`,
    `Baseline: ${safeJson({ commit: baseline.commit, tree: baseline.tree, selectedRevision: baseline.selectedRevision, sourceHead: baseline.sourceHead, sourceDirty: baseline.sourceDirty, taskOrder: baseline.taskOrder, source: baseline.source })}`,
    `Recipe: ${safeJson({ fingerprint: recipe.fingerprint, qualityFingerprint: recipe.qualityFingerprint, criteria: recipe.criteria, meta: recipe.meta })}`,
    `Coverage: ${safeJson(report.coverage ?? {})}`, 'Planned trial order:'];
  for (const slot of list(report.plan).slice(0, 160)) lines.push(`  ${shown(slot.index)} · ${shown(slot.experimentId)} · ${list(slot.profileOrder).map(shown).join(' → ')} · budget ${shown(slot.budgetMs)} ms`);
  for (const profile of list(report.profiles).slice(0, 160)) {
    const q = profile.quality ?? {}, metrics = profile.metrics ?? {};
    lines.push(`\nProfile ${shown(profile.profileName)} · ID ${shown(profile.profileId)} · planned ${shown(profile.planned)} · executed ${shown(profile.executed)}`,
      `  Quality: passed ${shown(q.passed)} · failed ${shown(q.failed)} · incomplete ${shown(q.incomplete)} · not run ${shown(q.notRun)} · pass rate ${shown(q.passRate)} · denominator ${shown(q.denominator)}`,
      `  Execution statuses: ${safeJson(profile.execution?.counts ?? {})}`, '  Metrics:');
    for (const [name, metric] of Object.entries(metrics)) lines.push(`    ${shown(name)}: median ${shown(metric.median)} ${shown(metric.unit)} · IQR ${shown(metric.iqr)} · min ${shown(metric.min)} · max ${shown(metric.max)} · N ${shown(metric.observedN)}/${shown(metric.plannedN)} · missing ${shown(metric.missingN)} (${shown(metric.scope)}; ${shown(metric.source)})${Object.keys(metric.missingReasons ?? {}).length ? ` · reasons ${safeJson(metric.missingReasons)}` : ''}`);
    if (profile.review) {
      const review = profile.review;
      lines.push(`  Human scores: ${shown(review.rubricId)} v${shown(review.rubricVersion)} · median ${shown(review.median)}% · IQR ${shown(review.iqr)} · scored ${shown(review.scoredN)}/${shown(review.plannedN)} · reviewed ${shown(review.reviewedN)} · missing ${shown(review.missingN)}`);
    }
  }
  for (const trial of list(report.trials).slice(0, 160)) {
    lines.push(`\nTrial ${shown(trial.index)} · ${shown(trial.experimentId)} · ${shown(trial.status)} · order ${list(trial.profileOrder).map(shown).join(' → ')} · budget ${shown(trial.budgetMs)} ms`);
    if (trial.runsOmitted) lines.push(`  Frozen run export omitted ${shown(trial.runsOmitted)} run records at the evidence size limit.`);
    if (trial.environment) lines.push(`  Environment: ${safeJson(trial.environment)}`);
    for (const failure of list(trial.failures)) lines.push(`  Failure: ${shown(failure.code)}`);
    for (const warning of list(trial.warnings)) lines.push(`  Warning: ${shown(warning.code)}`);
    for (const item of list(trial.profiles)) {
      lines.push(`  ${shown(item.profileName)} · ${shown(item.status)} · run ${shown(item.run?.id)}`);
      lines.push(...renderFrozenRunEvidence(item.run));
      const quality = item.quality;
      if (quality) {
        lines.push(`    Quality ${shown(quality.status)} · definition ${shown(quality.definitionId)} v${shown(quality.definitionVersion)} · fingerprint ${shown(quality.fingerprint)}`);
        for (const criterion of list(quality.criteria)) lines.push(`      ${shown(criterion.kind)} ${shown(criterion.id)} · ${criterion.required ? 'required' : 'optional'} · ${shown(criterion.status)} · evidence ${list(criterion.evidenceRefs).map(shown).join(', ') || 'none'}${criterion.reason ? ` · ${shown(criterion.reason)}` : ''}`);
        if (quality.rubric) lines.push(`      Human review: ${shown(quality.rubric.status)}${quality.rubric.result ? ` · result ${shown(quality.rubric.result)}` : ''} · score ${shown(quality.rubric.scorePercent)}% · ${shown(quality.rubric.rubricId)} v${shown(quality.rubric.rubricVersion)}`);
        if (quality.review) {
          lines.push(`        Reviewer ${shown(quality.review.reviewer)} · ${shown(quality.review.reviewedAt)}`);
          for (const rating of list(quality.review.ratings)) lines.push(`        ${shown(rating.criterionId)}: ${shown(rating.score)} · ${shown(rating.rationale)} · evidence ${list(rating.evidenceRefs).map(shown).join(', ') || 'none'}`);
        }
      } else lines.push('    Quality: incomplete or not evaluated');
    }
  }
  lines.push('\nComparisons:');
  for (const comparison of list(report.comparisons)) {
    lines.push(`  ${shown(comparison.left)} → ${shown(comparison.right)} · quality delta ${shown(comparison.qualityDelta)}`);
    for (const [name, metric] of Object.entries(comparison.metrics ?? {})) lines.push(`    ${shown(name)}: ${shown(metric.leftMedian)} → ${shown(metric.rightMedian)} · paired median delta ${shown(metric.delta)} · paired N ${shown(metric.pairedN)}/${shown(metric.plannedN)} · observed ${shown(metric.leftObservedN)}/${shown(metric.rightObservedN)}${metric.reason ? ` · ${shown(metric.reason)}` : ''}`);
    if (comparison.reviewDelta) lines.push(`    Human scores: paired median delta ${shown(comparison.reviewDelta.delta)} · paired N ${shown(comparison.reviewDelta.pairedN)}/${shown(comparison.reviewDelta.plannedN)}${comparison.reviewDelta.reason ? ` · ${shown(comparison.reviewDelta.reason)}` : ''}`);
    for (const insight of list(comparison.insights)) {
      lines.push(`    ${shown(insight.kind)} · runs ${list(insight.runIds).map(shown).join(', ')} · ${shown(insight.observation)} · limitation ${shown(insight.limitation)}`);
      if (insight.models) lines.push(`      Models: ${safeJson(insight.models)} · agents: ${safeJson(insight.agentCounts)}`);
      for (const side of ['left', 'right']) for (const [category, observations] of Object.entries(insight.counts?.[side] ?? {}))
        for (const observation of list(observations)) lines.push(`      ${side} ${shown(category)} · run ${shown(observation.runId)} · observed count ${shown(observation.count)} · coverage ${shown(observation.coverage)}`);
    }
  }
  if (list(report.warnings).length) lines.push('Warnings:', ...list(report.warnings).slice(0, 50).map(item => `  ${shown(typeof item === 'string' ? item : item.code ?? item.reason ?? item.message)}`));
  lines.push('These observations describe recorded runs; they do not establish causality or a winning profile.');
  return lines.join('\n');
}
function renderEvaluationReport(report, { markdown = false } = {}) {
  const lines = [markdown ? '# Audit evaluation' : 'Audit evaluation', `Evaluation: ${shown(report.id)} · status ${shown(report.status)} · exit ${shown(report.exitCode)}`,
    `Source: ${safeJson(report.source ?? {})}`, `Review method: ${shown(report.reviewMethod)}`];
  if (report.series) lines.push(renderSeriesReport(report.series, { markdown }));
  if (list(report.warnings).length) lines.push(`Warnings:\n${list(report.warnings).slice(0, 50).map(x => `  ${shown(typeof x === 'string' ? x : x.code ?? x.reason ?? x.message)}`).join('\n')}`);
  return lines.join('\n');
}
function renderSeriesLifecycle(record) {
  const lines = [`Audit series ${record.kind === 'audit-series-cleanup' ? 'cleanup' : 'recovery'}`, `Series: ${shown(record.id)} · status ${shown(record.status)}`, 'Actions:'];
  const rows = list(record.actions);
  if (!rows.length) lines.push('  none recorded');
  for (const row of rows.slice(0, 160)) {
    lines.push(`  Experiment ${shown(row.experimentId)} · ${shown(row.status)}`);
    for (const action of list(row.actions)) lines.push(`    ${shown(action.kind ?? action.name ?? action.status)}${action.reason ? ` · ${shown(action.reason)}` : ''}`);
  }
  if (list(record.warnings).length) lines.push('Warnings:', ...list(record.warnings).slice(0, 50).map(x => `  ${shown(typeof x === 'string' ? x : x.code ?? x.reason ?? x.message)}`));
  lines.push(`Exit: ${shown(record.exitCode)}`);
  return lines.join('\n');
}
function renderRun(run, { markdown = false } = {}) {
  const p = run.profile ?? {};
  const agents = list(run.agents);
  const observedTurns = turns(run);
  const events = list(run.events);
  const heading = markdown ? '## Audit run' : 'Audit run';
  const source = run.source ?? {};
  return [heading,
    `Profile: ${shown(p.profileName ?? p.name)} · ID ${shown(p.profileId)} · status ${shown(run.status)}${run.reason ? ` · ${shown(run.reason)}` : ''}`,
    `Run: ${shown(run.id)} · source ${shown(source.kind ?? source)}${source.observationMode ? ` · observation ${shown(source.observationMode)}` : ''}`,
    `Native session: ${shown(source.nativeSessionId ?? source.threadId)} · client ${shown(source.clientVersion ?? source.version)} · origin ${shown(source.originator)}`,
    `Source file: ${shown(source.path)} · fingerprint ${shown(source.fingerprint)}`,
    ...renderNativeStorage(source, run.capture),
    ...(run.execution ? [`Process: ${shown(run.execution.status)} · exit ${shown(run.execution.exitCode)} · elapsed ${shown(run.execution.elapsedMs)} ms`] : []),
    'Evidence coverage:', renderCoverage(run.coverage),
    'Agents:', agents.length ? agents.map(agent => `${agentLabel(agent)}${agent.source ? ` · source ${shown(agent.source.path)} · fingerprint ${shown(agent.source.fingerprint)}` : ''}`).join('\n') : '  Agent tree unavailable.',
    'Recorded turn controls:', observedTurns.length ? observedTurns.map(turn => `  agent ${shown(turn.agentId)} · turn ${shown(turn.turnId)} · model ${shown(turn.model)} · effort ${shown(turn.reasoningEffort)} · line ${shown(turn.sourceLine)}`).join('\n') : '  No recorded turn metadata.',
    'Skills:', renderSkills(list(run.skills)), renderSkillTelemetry(run),
    renderInstructionSources(run),
    ...(run.captureAcceptance ? [renderCaptureAcceptance(run.captureAcceptance).join('\n')] : []),
    `Recorded events (${events.length} total; limit ${EVENT_LIMIT} shown):`, renderEvents(events),
    renderToolEvidence(run),
    renderHooks(run),
    renderUsage(run),
    `Metrics: ${safeJson(run.metrics ?? {})}`,
    ...(run.outcome?.checks || run.checks ? [`Verification checks:\n${renderChecks(list(run.outcome?.checks ?? run.checks))}`] : []),
    ...(run.capture ? [renderCapture(run.capture)] : []),
    ...(run.workspace ? [renderWorkspace(run.workspace)] : []),
    `Outcome: ${shown(run.outcome?.status ?? 'unknown')}${run.outcome?.reason ? ` · ${shown(run.outcome.reason)}` : ''}${run.outcome?.claim ? ` · recorded claim success=${shown(run.outcome.claim.success)} status=${shown(run.outcome.claim.status)} agent=${shown(run.outcome.claim.agentId)} turn=${shown(run.outcome.claim.turnId)} line=${shown(run.outcome.claim.sourceLine)}` : ''}`,
    `Artifacts: ${list(run.artifacts).length ? `${list(run.artifacts).slice(0, 50).map(item => shown(item.path ?? item.kind ?? item)).join(', ')}${run.artifacts.length > 50 ? `, … ${run.artifacts.length - 50} omitted` : ''}` : 'none recorded'}`,
    ...(run.setupSnapshot ? [`Setup snapshot metadata: ${renderSetupSnapshot(run.setupSnapshot)}`] : []),
    list(run.warnings).length ? `Warnings:\n${list(run.warnings).map(warning => `  ${shown(typeof warning === 'string' ? warning : warning.message ?? warning.reason)}`).join('\n')}` : 'Warnings: none recorded',
    'A missing observation means unknown unless the report explicitly says otherwise. Resource availability does not establish runtime use.',
  ].join('\n');
}
function renderSkillDiff(skills, { markdown = false } = {}) {
  if (!skills.length) return 'Skills: no comparable skill records.';
  return ['Skills by profile and evidence:', ...skills.map(skill => {
    const side = value => value ? `${shown(value.origin)} (${shown(value.availability)})${value.logicalPath ? ` · workspace path ${shown(value.logicalPath)}` : ''}${value.path ? ` · source path ${shown(value.path)}` : ''}; ${value.observations.length ? value.observations.map(obs => `${shown(obs.kind)} by agent ${shown(obs.agentId)}, turn ${shown(obs.turnId)}${obs.sourceLine == null ? '' : ` line ${shown(obs.sourceLine)}`}${skillProofLabel(obs)}`).join('; ') : 'no observed use'}` : 'unknown/unavailable';
    return `  ${shown(skill.name)} [${shown(skill.id)}]\n    Left: ${side(skill.left)}\n    Right: ${side(skill.right)}`;
  })].join('\n');
}
function renderComparison(value, { markdown = false } = {}) {
  const c = value.comparison ?? {};
  const lines = [markdown ? '# Audit comparison' : 'Audit comparison'];
  for (const side of ['left', 'right']) {
    const run = value[side] ?? {};
    lines.push(`${side === 'left' ? 'Left' : 'Right'}: ${shown(run.profile?.profileName ?? run.profile?.name ?? run.profileName)} · ${shown(run.id)} · ${shown(run.status)}`);
    if (run.source?.observationMode) lines.push(`  Observation: ${shown(run.source.observationMode)}`);
    lines.push(`  Coverage: ${Object.entries(run.coverage ?? {}).map(([key, status]) => `${shown(key)}=${shown(status)}`).join(', ') || 'unknown'}`);
    lines.push(...renderUsage(run).split('\n').map(line => `  ${line}`));
    lines.push(...renderInstructionSources(run).split('\n').map(line => `  ${line}`));
    lines.push(...renderHooks(run).split('\n').map(line => `  ${line}`));
    const agents = agentSummary(run);
    lines.push(`  Agents: ${shown(agents.status)} · observed ${agents.observedAgentCount} · children ${agents.childCount} · max depth ${shown(agents.maxDepth)}`);
    lines.push(...(agents.agents.length ? agents.agents.map(agent => `    ${'  '.repeat(Math.max(0, Math.min(8, Number(agent.depth) || 0)))}${shown(agent.role ?? 'agent')} ${shown(agent.id)} · parent ${shown(agent.parentId)} · ${shown(agent.status)}${agent.source ? ` · source ${shown(agent.source.path)} · fingerprint ${shown(agent.source.fingerprint)}` : ''}`) : ['    No recorded agent tree.']));
    const behavior = eventBehavior(run);
    lines.push(`  Timeline: ${shown(behavior.status)} · ${behavior.eventCount == null ? `${behavior.observedEventCount} observed events; total unknown` : `${behavior.eventCount} recorded events`}`);
    lines.push(...(behavior.events.length ? renderEvents(behavior.events).split('\n').map(line => `  ${line}`) : [`    ${behavior.status === 'none-recorded' ? 'No events recorded.' : 'No event details available.'}`]));
    const artifacts = artifactSummary(run);
    lines.push(`  Recorded artifacts: ${shown(artifacts.status)} · ${artifacts.count == null ? `${artifacts.observedCount} observed; complete count unknown` : artifacts.count}`);
    if (artifacts.artifacts.length) lines.push(...artifacts.artifacts.slice(0, 30).map(item => `    ${shown(item.kind)} ${shown(item.path ?? item.patchPath ?? item.label ?? item.fingerprint)} · ${shown(item.status)}${item.label ? ` · label ${shown(item.label)}` : ''}${item.fingerprint ? ` · fingerprint ${shown(item.fingerprint)}` : ''} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)} · line ${shown(item.sourceLine)}`));
    else lines.push('    No file-change artifacts recorded.');
  }
  lines.push('Recorded controls:', `  Models: ${shown(c.models?.status)} · left ${list(c.models?.left).map(shown).join(', ') || 'unknown'} · right ${list(c.models?.right).map(shown).join(', ') || 'unknown'}`,
    `  Reasoning effort: ${shown(c.reasoningEfforts?.status)} · left ${list(c.reasoningEfforts?.left).map(shown).join(', ') || 'unknown'} · right ${list(c.reasoningEfforts?.right).map(shown).join(', ') || 'unknown'}`,
    'Metric deltas (right minus left):');
  const metrics = Object.entries(c.metrics ?? {}).sort(([a], [b]) => a.localeCompare(b));
  lines.push(...(metrics.length ? metrics.map(([key, metric]) => `  ${shown(key)}: ${shown(metric.left)} → ${shown(metric.right)} · delta ${shown(metric.delta)}${metric.percentDelta == null ? '' : ` (${Number(metric.percentDelta).toFixed(1)}%)`}`) : ['  No comparable metrics.']));
  if (c.usage) {
    lines.push(`Root-session token comparison: ${shown(c.usage.status)} · scope ${shown(c.usage.scope)}`);
    for (const [field, values] of Object.entries(c.usage.deltas ?? {}).sort(([a], [b]) => a.localeCompare(b)))
      lines.push(`  ${shown(field)}: ${shown(values.left)} → ${shown(values.right)} · delta ${shown(values.delta)} (${shown(values.status)})`);
    if (!Object.keys(c.usage.deltas ?? {}).length) lines.push('  Root-session token values are unavailable on at least one side.');
    const workflow = c.usage.workflow;
    if (workflow) {
      lines.push(`  Workflow totals: ${shown(workflow.status)} · scope ${shown(workflow.scope)} · ${shown(workflow.note)}`);
      for (const [field, values] of Object.entries(workflow.fields ?? {}))
        lines.push(`    ${shown(field)}: ${shown(values.left)} → ${shown(values.right)} · delta ${shown(values.delta)} (${shown(values.status)}) · field coverage ${shown(values.leftCoverage)} / ${shown(values.rightCoverage)}`);
    }
    if (!workflow || workflow.status === 'unknown') lines.push(`  Workflow-wide total: unknown. ${shown(c.usage.note)}`);
    const turnUsage = c.usage.turns;
    if (turnUsage) {
      lines.push(`  Verified whole-turn comparison: ${shown(turnUsage.status)} · ${shown(turnUsage.note)}`);
      for (const [field, rows] of Object.entries(turnUsage.fields ?? {})) for (const row of rows.slice(0, 100))
        lines.push(`    ${shown(field)} · ${shown(row.roleAndOrdinal)}: ${shown(row.left)} → ${shown(row.right)} · delta ${shown(row.delta)} (${shown(row.status)})`);
    }
  }
  const behavior = c.behavior;
  if (behavior) {
    lines.push(`Behavioral event totals: left ${shown(behavior.left.status)} (${shown(behavior.left.observedEventCount)} observed) · right ${shown(behavior.right.status)} (${shown(behavior.right.observedEventCount)} observed) · delta ${shown(behavior.countDelta)} (${shown(behavior.countStatus)})`);
    lines.push('Event kind counts (right minus left):');
    lines.push(...(Object.entries(behavior.eventKinds).length ? Object.entries(behavior.eventKinds).map(([kind, row]) => `  ${shown(kind)}: ${shown(row.left)} → ${shown(row.right)} · delta ${shown(row.delta)} (${shown(row.status)})`) : ['  No event kinds recorded.']));
    lines.push('Tool counts (right minus left):');
    lines.push(...(Object.entries(behavior.tools).length ? Object.entries(behavior.tools).map(([tool, row]) => `  ${shown(tool)}: ${shown(row.left)} → ${shown(row.right)} · delta ${shown(row.delta)} (${shown(row.status)})`) : ['  No tool calls recorded; this does not imply zero unless timeline coverage is complete.']));
  }
  if (c.tools || c.mcp) lines.push(renderToolComparison(c));
  if (c.hooks) {
    lines.push(`Hook comparison: ${shown(c.hooks.status)} · ${shown(c.hooks.note)}`);
    for (const row of list(c.hooks.counts).slice(0, 100)) lines.push(`  ${shown(row.identity.agentRole)} · turn ${shown(row.identity.turnOrdinal)} · ${shown(row.identity.eventName)} · ${shown(row.identity.sourceKind)} · ${shown(row.identity.scope)} · ${shown(row.identity.handlerType)}/${shown(row.identity.executionMode)} · ${shown(row.identity.status)}: ${shown(row.left)} → ${shown(row.right)} · delta ${shown(row.delta)} (${shown(row.status)})`);
    if (!list(c.hooks.counts).length) lines.push('  No aligned hook observations. Missing events remain unknown unless both captures are complete.');
  }
  if (c.plugins) for (const side of ['left', 'right']) lines.push(renderPluginUsage(c.plugins[side], `${side === 'left' ? 'Left' : 'Right'} observed plugin use`));
  if (c.artifacts) {
    lines.push(`Artifact comparison: ${shown(c.artifacts.status)} · delta ${shown(c.artifacts.delta)}`);
    for (const item of list(c.artifacts.added)) lines.push(`  Added: ${shown(item.kind)} ${shown(item.path ?? item.patchPath ?? item.label ?? item.fingerprint)} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)} · line ${shown(item.sourceLine)}`);
    for (const item of list(c.artifacts.removed)) lines.push(`  Removed: ${shown(item.kind)} ${shown(item.path ?? item.patchPath ?? item.label ?? item.fingerprint)} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)} · line ${shown(item.sourceLine)}`);
    lines.push(renderWorkspaceComparison(c.artifacts));
  }
  if (c.outcomes) {
    lines.push(`Recorded outcome evidence: ${shown(c.outcomes.status)} · claim comparison ${shown(c.outcomes.claimStatus)} · checks ${shown(c.outcomes.checks?.status)}`);
    for (const side of ['left', 'right']) {
      const outcome = c.outcomes[side];
      if (outcome?.claim) lines.push(`  ${side} claim: success ${shown(outcome.claim.success)} · status ${shown(outcome.claim.status)} · agent ${shown(outcome.claim.agentId)} · turn ${shown(outcome.claim.turnId)} · line ${shown(outcome.claim.sourceLine)}`);
      else lines.push(`  ${side} claim: ${shown(outcome?.status ?? 'unknown')}`);
      for (const check of list(outcome?.checks)) lines.push(`  ${side} check ${shown(check.name)}: ${shown(check.status)} · line ${shown(check.sourceLine)}`);
    }
    lines.push(c.outcomes.conclusion);
  }
  lines.push(renderSkillDiff(list(c.skills), { markdown }));
  if (c.skillInvocations) lines.push(renderSkillInvocationComparison(c.skillInvocations));
  if (c.instructionSources) {
    lines.push(`Instruction source comparison: ${shown(c.instructionSources.status)} · ${shown(c.instructionSources.note)}`);
    lines.push(`  Snapshot rows omitted: left ${shown(c.instructionSources.left?.omittedAgents ?? 0)} · right ${shown(c.instructionSources.right?.omittedAgents ?? 0)}`);
    for (const row of list(c.instructionSources.roles).slice(0, 50)) lines.push(`  ${shown(row.rolePath)}: ${shown(row.status)} · left ${shown(row.left?.status ?? 'unknown')} / right ${shown(row.right?.status ?? 'unknown')}${row.left && row.right ? ` · ${row.left.sources.length} / ${row.right.sources.length} sources` : ''}`);
  }
  if (c.expectation) {
    lines.push(`Expectations: ${shown(c.expectation.status)}`);
    for (const item of list(c.expectation.mismatches)) lines.push(`  Mismatch: ${item.side} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)} · line ${shown(item.sourceLine)} · ${shown(item.field)} expected ${shown(item.expected)}, observed ${shown(item.observed)}`);
    for (const item of list(c.expectation.unknowns)) lines.push(`  Unknown: ${item.side} · agent ${shown(item.agentId)} · turn ${shown(item.turnId)} · line ${shown(item.sourceLine)} · ${shown(item.field)}: ${shown(item.reason)}`);
  }
  lines.push(c.conclusion ?? 'Observed differences do not establish causality or a winner.');
  return lines.join('\n');
}

/** Render a run, comparison, or setup inventory comparison without raw private text. */
export function renderAudit(value, { format = 'terminal' } = {}) {
  if (!['terminal', 'markdown'].includes(format)) throw new Error(`Unsupported audit report format: ${format}`);
  const markdown = format === 'markdown';
  const previousMarkdownMode = markdownRendering;
  markdownRendering = markdown;
  let result;
  try {
  if (value?.kind === 'audit-comparison') result = renderComparison(value, { markdown });
  else if (value?.kind === 'audit-experiment-preview') result = renderExperimentPreview(value);
  else if (value?.kind === 'audit-series-preview') result = renderSeriesPreview(value);
  else if (value?.kind === 'audit-experiment-report') result = renderExperimentReport(value, { markdown });
  else if (value?.kind === 'audit-series-report') result = renderSeriesReport(value, { markdown });
  else if (value?.kind === 'audit-evaluation-report') result = renderEvaluationReport(value, { markdown });
  else if (value?.kind === 'audit-experiment-recovery' || value?.kind === 'audit-experiment-cleanup') result = renderExperimentLifecycle(value);
  else if (value?.kind === 'audit-series-recovery' || value?.kind === 'audit-series-cleanup') result = renderSeriesLifecycle(value);
  else if (value?.kind === 'audit-profile-comparison') {
    const comparison = value.comparison?.resources ?? value.comparison ?? {};
    result = [markdown ? '# Audit profile comparison' : 'Audit profile comparison',
      `Left: ${shown(value.left?.profile?.profileName ?? value.left?.profileName)} · Right: ${shown(value.right?.profile?.profileName ?? value.right?.profileName)}`,
      ...['added', 'removed', 'changed', 'unchanged', 'unavailable'].map(category => {
        const records = list(comparison[category]);
        const detail = resource => {
          const location = resource.path ?? resource.canonicalPath ?? resource.id;
          const relation = resource.comparison ? ` · ${shown(resource.comparison)}` : '';
          const reason = resource.reason ? ` · reason ${shown(resource.reason)}` : '';
          const changed = resource.before !== undefined || resource.after !== undefined || resource.left !== undefined || resource.right !== undefined;
          const before = resource.before ?? resource.left;
          const after = resource.after ?? resource.right;
          const signature = item => {
            if (item == null) return 'unknown';
            if (typeof item !== 'object') return shown(item);
            const metadata = ['status', 'version', 'fingerprint', 'sha256', 'contentHash', 'path', 'canonicalPath']
              .filter(key => item[key] != null).map(key => `${key}=${shown(item[key])}`);
            if (item.value !== undefined) metadata.push(`value=${safeJson(item.value)}`);
            return metadata.join(', ') || safeJson(item);
          };
          const publicValue = resource.value !== undefined ? ` · value ${safeJson(resource.value)}` : '';
          return `  ${shown(resource.name ?? location ?? 'unknown')} · ${shown(resource.category)} · ${shown(resource.origin)} · ${shown(resource.status ?? 'recorded')}${location ? ` · path ${shown(location)}` : ''}${relation}${reason}${changed ? `\n    Before: ${signature(before)}\n    After: ${signature(after)}` : resource.fingerprint ? ` · fingerprint ${shown(resource.fingerprint)}` : ''}${publicValue}`;
        };
        return `${category[0].toUpperCase()}${category.slice(1)} (${records.length}):${records.length ? `\n${records.map(detail).join('\n')}` : ' none'}`;
      }),
      `Left coverage:\n${renderCoverage(value.left?.coverage)}`, `Right coverage:\n${renderCoverage(value.right?.coverage)}`,
      'Discovered or available resources do not establish that a run loaded or used them.',
    ].join('\n');
  } else result = renderRun(value ?? {} , { markdown });
  return markdown ? markdownEscapeReport(result) + '\n' : result + '\n';
  } finally {
    markdownRendering = previousMarkdownMode;
  }
}

function markdownEscapeReport(text) {
  // Escape untrusted fields at interpolation sites above; preserve report structure.
  return text;
}

/** 0 adequate, 1 operational/not-found, 2 incomplete, 3 expected controls differ. */
export function auditExitCode(value) {
  if (!value || typeof value !== 'object') return 1;
  if (value.kind === 'audit-experiment-preview') {
    if (value.status === 'ready') return 0;
    if (value.status === 'blocked') {
      const reason = value.reason && typeof value.reason === 'object' ? value.reason : {};
      if ([1, 2].includes(reason.exitCode)) return reason.exitCode;
      return ['partial', 'unavailable', 'unknown', 'incomplete', 'coverage'].includes(reason.kind ?? reason.status ?? reason.code) ? 2 : 1;
    }
    return 1;
  }
  if (value.kind === 'audit-series-preview') return value.status === 'ready' ? 0 : 1;
  if (['audit-series-report', 'audit-evaluation-report'].includes(value.kind)) {
    if (Number.isInteger(value.exitCode) && [0, 1, 2, 4, 124, 130].includes(value.exitCode)) return value.exitCode;
    return ['partial', 'interrupted', 'unknown', 'pending'].includes(value.status) ? 2 : value.status === 'complete' ? 0 : 1;
  }
  if (value.kind === 'audit-series-recovery' || value.kind === 'audit-series-cleanup') {
    if (Number.isInteger(value.exitCode) && [0, 1, 2, 4, 124, 130].includes(value.exitCode)) return value.exitCode;
    return value.status === 'complete' || value.status === 'recovered' || value.status === 'cleaned' ? 0
      : ['partial', 'interrupted', 'unknown', 'pending'].includes(value.status) ? 2 : 1;
  }
  if (value.kind === 'audit-experiment-report') {
    const runs = list(value.runs);
    const strictFailure = value.strictFailure === true || value.execution?.strictFailure === true
      || value.capture?.strictFailure === true || value.capture?.status === 'failed'
      || runs.some(run => run.execution?.strictFailure === true || run.capture?.strictFailure === true || run.capture?.status === 'failed'
        || list(run.outcome?.checks ?? run.checks).some(check => check.status === 'failed' && check.required !== false));
    if (value.status === 'timeout' || runs.some(run => run.status === 'timeout' || run.execution?.status === 'timeout')) return 124;
    if (value.status === 'cancelled' || runs.some(run => run.status === 'cancelled' || run.execution?.status === 'cancelled')) return 130;
    if (strictFailure || value.status === 'failed' || runs.some(run => run.execution?.status === 'failed')) return 4;
    if (value.status === 'partial' || value.status === 'interrupted') return 2;
    if (value.status === 'blocked') {
      if ([1, 2].includes(value.exitCode)) return value.exitCode;
      return value.reason?.kind === 'incomplete-evidence' || value.reason?.kind === 'coverage' ? 2 : 1;
    }
    if (value.status === 'complete') {
      if (!fullyCovered(value.coverage)) return 2;
      if (Number.isInteger(value.exitCode) && [0, 1, 2, 3, 4, 124, 130].includes(value.exitCode)) return value.exitCode;
      return 0;
    }
    if (Number.isInteger(value.exitCode) && [0, 1, 2, 3, 4, 124, 130].includes(value.exitCode)) return value.exitCode;
    return 1;
  }
  if (value.kind === 'audit-experiment-recovery' || value.kind === 'audit-experiment-cleanup') {
    if (Number.isInteger(value.exitCode) && [0, 1, 2, 3, 4, 124, 130].includes(value.exitCode)) return value.exitCode;
    if (value.status === 'blocked') return ['incomplete-evidence', 'coverage', 'partial', 'unknown'].includes(value.reason?.kind ?? value.reason?.status) ? 2 : 1;
    if (['preview', 'recovered', 'cleaned'].includes(value.status)) return 0;
    if (value.status === 'partial' || value.status === 'interrupted') return 2;
    if (value.status === 'failed') return 4;
    return 1;
  }
  if (value.kind === 'audit-comparison') {
    if ([value.left, value.right].some(side => ['partial', 'unavailable'].includes(side?.status))) return 2;
    if ([value.left, value.right].some(side => ['not-found', 'invalid', 'error'].includes(side?.status))) return 1;
    if ([value.left, value.right].some(side => side?.status !== 'ready')) return 2;
    const coverage = [value.left?.coverage, value.right?.coverage].flatMap(item => Object.values(item ?? {}));
    if (coverage.some(status => ['partial', 'unavailable', 'unknown', 'not-found'].includes(status))) return 2;
    if (value.comparison?.expectation?.status === 'different') return 3;
    if (value.comparison?.expectation?.status === 'unknown') return 2;
    return 0;
  }
  if (value.status === 'not-found' || value.status === 'invalid' || value.status === 'error' || value.status === 'failed') return 1;
  if (value.kind === 'audit-profile-comparison') {
    const coverage = [...Object.values(value.left?.coverage ?? {}), ...Object.values(value.right?.coverage ?? {})];
    return coverage.some(status => ['partial', 'unavailable', 'unknown', 'not-found'].includes(status)) ? 2 : 0;
  }
  if (value.status !== 'ready' && value.status !== 'complete') return 2;
  const coverage = Object.values(value.coverage ?? {});
  return coverage.some(status => ['partial', 'unavailable', 'unknown', 'not-found'].includes(status)) ? 2 : 0;
}
