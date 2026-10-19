// Privacy-safe projection of observed tool call thread items and MCP startup
// notifications. Arguments, results, content, and free-form errors are ignored.
import { redactValue } from './redact.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const CALL_STATUS = new Set(['inProgress', 'completed', 'failed']);
const STARTUP_STATUS = new Set(['starting', 'ready', 'failed', 'cancelled']);
const FAILURE_REASON = new Set(['reauthenticationRequired']);
const TOOL_TYPES = new Map([
  ['mcpToolCall', 'mcp'], ['dynamicToolCall', 'dynamic'],
  ['commandExecution', 'command'], ['command_execution', 'command'],
  ['fileChange', 'file-change'], ['file_change', 'file-change'],
  ['webSearch', 'web-search'], ['web_search', 'web-search'],
  ['collabAgentToolCall', 'agent'], ['collab_agent_tool_call', 'agent'],
  ['imageView', 'image-view'], ['sleep', 'sleep'], ['imageGeneration', 'image-generation'],
]);

const safeId = value => typeof value === 'string' && SAFE_ID.test(value) ? value : null;
const safeName = value => {
  if (typeof value !== 'string' || value.length > 256) return null;
  const clean = String(redactValue(value, 'name')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/[^A-Za-z0-9._:/@+ -]/g, '_').trim().slice(0, 128);
  return clean && SAFE_NAME.test(clean.replaceAll(' ', '_')) ? clean : null;
};
const validTime = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Native scriptPath is already relative to an attributed plugin. Keep this
// identity, never an absolute path, command line, or inferred script operand.
export function safePluginScriptPath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u.test(value)) return null;
  if (value.split('/').some(part => !part || part === '.' || part === '..' || /^[A-Za-z]:/.test(part))) return null;
  return String(redactValue(value, 'scriptPath')) === value ? value : null;
}

function phaseStatus(item, phase) {
  if (CALL_STATUS.has(item.status)) return item.status;
  return phase === 'completed' ? 'completed' : 'inProgress';
}

function rank(status) { return status === 'completed' || status === 'failed' ? 2 : 1; }

export function createAuditToolCapture({ maxInvocations = 10000, maxServers = 1000 } = {}) {
  const invocationLimit = Number.isSafeInteger(maxInvocations) && maxInvocations >= 0 ? maxInvocations : 10000;
  const serverLimit = Number.isSafeInteger(maxServers) && maxServers >= 0 ? maxServers : 1000;
  const invocations = new Map();
  const byActorItem = new Map();
  const keyByRecord = new Map();
  const servers = new Map();
  const warnings = new Set();
  const attributionConflicts = new Set();
  let invocationCapped = false, serverCapped = false;

  const consumeItem = ({ item, agentId, turnId, phase, source, sourceLine, startedAtMs, completedAtMs, observedAtMs } = {}) => {
    const agent = safeId(agentId), turn = safeId(turnId);
    if (!item || typeof item !== 'object' || !agent || !safeId(item.id)) return false;
    const kind = TOOL_TYPES.get(item.type);
    if (!kind || (phase !== 'started' && phase !== 'completed')) return false;
    // Keep ordinary tool entries as metadata only; no command, path, prompt, or
    // patch fields are projected.
    const key = `${agent}\0${turn ?? ''}\0${item.id}`;
    const actorItemKey = `${agent}\0${item.id}`;
    let record = invocations.get(key);
    // Native notifications can omit turnId on one lifecycle phase. Reconcile
    // that phase only when there is exactly one possible item record for this
    // actor and item id. Otherwise keep the unattributed phase distinct.
    if (!record) {
      const candidates = [...(byActorItem.get(actorItemKey) ?? [])]
        .filter(candidate => turn === null || candidate.turnId === null);
      if (turn === null && candidates.length > 1) warnings.add('tool-turn-ownership-ambiguous');
      if (candidates.length === 1) {
        record = candidates[0];
        const previousKey = keyByRecord.get(record);
        if (previousKey !== key) {
          invocations.delete(previousKey);
          record.turnId ??= turn;
          keyByRecord.set(record, key);
          invocations.set(key, record);
        }
      }
    }
    if (!record && invocations.size >= invocationLimit) {
      invocationCapped = true; warnings.add('tool-invocation-limit'); return false;
    }
    const typedImageFailure = item.type === 'imageGeneration' && item.failure?.type === 'usageLimitExceeded';
    const status = typedImageFailure ? 'failed' : phaseStatus(item, phase);
    if (!record) {
      record = { agentId: agent, turnId: turn, itemId: item.id, kind,
        serverName: null, pluginId: null, namespace: null, toolName: null,
        status: 'inProgress', success: null, durationMs: null, startedAtMs: null,
        completedAtMs: null, source: safeName(source), sourceLine: validTime(sourceLine), failed: false };
      invocations.set(key, record);
      keyByRecord.set(record, key);
      const recordsForActorItem = byActorItem.get(actorItemKey) ?? new Set();
      recordsForActorItem.add(record);
      byActorItem.set(actorItemKey, recordsForActorItem);
    }
    const wasTerminal = record.status === 'completed' || record.status === 'failed';
    // Start notifications or hydration can arrive after completed items. They
    // must not rewrite terminal identity, status, or timing. A completed-phase
    // failed item can refine an earlier completed observation to failed.
    const mayUpdate = !wasTerminal || phase === 'completed';
    if (!wasTerminal && rank(status) >= rank(record.status)) record.status = status;
    else if (record.status === 'completed' && phase === 'completed' && status === 'failed') record.status = 'failed';
    if (wasTerminal && phase === 'started') return true;
    // Receipt times describe the observer's lifecycle span, never native tool
    // execution or active time. History hydration supplies no receipt timestamp.
    if (validTime(observedAtMs) !== null) {
      if (phase === 'started') record.observedStartedAtMs ??= observedAtMs;
      else record.observedCompletedAtMs ??= observedAtMs;
      if (record.observedStartedAtMs != null && record.observedCompletedAtMs != null)
        record.observedElapsedMs = record.observedCompletedAtMs >= record.observedStartedAtMs
          ? record.observedCompletedAtMs - record.observedStartedAtMs : null;
    }
    if (kind === 'mcp') {
      if (mayUpdate) {
        record.serverName ??= safeName(item.server);
        record.toolName ??= safeName(item.tool);
        record.pluginId ??= safeName(item.pluginId);
      }
      if (record.serverName) observeServer(record.serverName, { source: safeName(source), sourceLine: validTime(sourceLine), pluginId: record.pluginId });
    } else if (kind === 'dynamic') {
      if (mayUpdate) {
        record.namespace ??= safeName(item.namespace);
        record.toolName ??= safeName(item.tool);
        if (typeof item.success === 'boolean' && (!wasTerminal || phase === 'completed')) record.success = item.success;
      }
    } else if (kind !== 'image-view' && kind !== 'sleep' && kind !== 'image-generation') {
      if (mayUpdate) record.toolName ??= kind;
    }
    // Only explicit native plugin attribution permits a relative script identity.
    // Commands, arguments, absolute script paths and output remain excluded.
    if (kind === 'command' && mayUpdate) {
      const pluginId = safeName(item.pluginId);
      const scriptPath = pluginId && safePluginScriptPath(item.scriptPath);
      if (pluginId && record.pluginId && (record.pluginId !== pluginId
        || scriptPath && record.scriptPath && record.scriptPath !== scriptPath)) {
        attributionConflicts.add(record);
        warnings.add('plugin-command-attribution-conflict');
        record.pluginId = null;
        delete record.scriptPath;
      }
      if (!attributionConflicts.has(record)) {
        record.pluginId ??= pluginId;
        if (pluginId && scriptPath) record.scriptPath ??= scriptPath;
      }
    }
    if (kind === 'command' && mayUpdate && Number.isSafeInteger(item.exitCode)
      && item.exitCode >= -2147483648 && item.exitCode <= 2147483647) record.exitCode ??= item.exitCode;
    const duration = kind === 'sleep' || kind === 'mcp' || kind === 'dynamic' || kind === 'command'
      ? item.durationMs : undefined;
    if (record.durationMs == null && Number.isSafeInteger(duration) && duration >= 0 && duration <= 86_400_000) record.durationMs = duration;
    if (phase === 'completed') {
      record.completedAtMs ??= validTime(completedAtMs);
      if (record.startedAtMs == null && Number.isSafeInteger(record.completedAtMs) && Number.isSafeInteger(record.durationMs))
        record.startedAtMs = Math.max(0, record.completedAtMs - record.durationMs);
    } else if (record.startedAtMs == null) record.startedAtMs = validTime(startedAtMs);
    if (record.source == null) record.source = safeName(source);
    if (record.sourceLine == null) record.sourceLine = validTime(sourceLine);
    if (record.status === 'failed') record.success = kind === 'dynamic' || kind === 'command' ? false : record.success;
    else if (kind === 'command' && record.status === 'completed' && Number.isSafeInteger(record.exitCode))
      record.success = record.exitCode === 0;
    record.failed = record.status === 'failed' || record.success === false;
    return true;
  };

  function observeServer(name, fields) {
    const pluginId = safeName(fields.pluginId);
    const key = `${name}\0${pluginId ?? ''}`;
    let server = servers.get(key);
    if (!server && servers.size >= serverLimit) {
      serverCapped = true; warnings.add('mcp-server-limit'); return null;
    }
    if (!server) { server = { name, pluginId, status: null, source: null, sourceLine: null }; servers.set(key, server); }
    if (fields.status) server.status = fields.status;
    if (fields.source && server.source == null) server.source = fields.source;
    if (fields.sourceLine != null && server.sourceLine == null) server.sourceLine = fields.sourceLine;
    return server;
  }

  const consumeMcpStatus = ({ params, method = 'mcpServer/startupStatus/updated', source, sourceLine } = {}) => {
    if (method !== 'mcpServer/startupStatus/updated' || !params || typeof params !== 'object') return false;
    const name = safeName(params.name);
    if (!name || !STARTUP_STATUS.has(params.status)) return false;
    const server = observeServer(name, { status: params.status, source: safeName(source) ?? 'mcp-startup-status', sourceLine: validTime(sourceLine) });
    if (!server) return false;
    server.failureReason = FAILURE_REASON.has(params.failureReason) ? params.failureReason : null;
    // The protocol's error field is intentionally never retained.
    return true;
  };

  const result = () => {
    const toolsPartial = invocationCapped || warnings.has('tool-turn-ownership-ambiguous')
      || warnings.has('plugin-command-attribution-conflict');
    const mcpPartial = serverCapped || toolsPartial;
    const records = [...invocations.values()].map(record => ({ ...record }));
    const observedServers = [...servers.values()].map(server => ({ ...server }));
    return {
      toolInvocations: records,
      mcp: { servers: observedServers, inventory: 'not-requested' },
      coverage: {
        tools: toolsPartial ? 'partial' : records.length ? 'observed' : 'none-recorded',
        mcp: mcpPartial ? 'partial' : observedServers.length ? 'observed' : 'none-recorded',
        boundary: 'Observed thread-item lifecycle and startup notifications only; nested or opaque execution is not exhaustive.',
      },
      warnings: [...warnings].sort(),
    };
  };

  return { consumeItem, consumeMcpStatus, result };
}
