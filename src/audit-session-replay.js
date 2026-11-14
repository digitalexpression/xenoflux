import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { redactText } from './redact.js';

export const REPLAY_LIMITS = Object.freeze({ sourceBytes: 32 * 1024 * 1024,
  bodyBytes: 1024 * 1024, totalBodyBytes: 16 * 1024 * 1024, records: 10000 });

const boundedText = (value, max = 500) => typeof value === 'string' && value.length <= max
  && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const replayCwd = value => boundedText(value, 4096) && value.startsWith('/')
  && posix.normalize(value) === value && !value.includes('[REDACTED]')
  && redactText(value, 'metadata.txt') === value;
const isoTimestamp = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};

function eventTimestamp(row, payload) {
  const direct = isoTimestamp(row.timestamp);
  if (direct) return direct;
  const ms = Number.isFinite(payload?.completed_at_ms) && payload.completed_at_ms >= 100_000_000_000 ? payload.completed_at_ms
    : Number.isFinite(payload?.started_at_ms) && payload.started_at_ms >= 100_000_000_000 ? payload.started_at_ms : null;
  return ms !== null && Math.abs(ms) < 8640000000000000 ? new Date(ms).toISOString() : null;
}

function textBody(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

const PRIVATE_CONTENT_TYPES = new Set(['analysis', 'reasoning', 'private_reasoning', 'chain_of_thought',
  'encrypted_content', 'redacted_reasoning']);
const PRIVATE_CONTENT_KEYS = new Set(['private_reasoning', 'chain_of_thought',
  'encrypted_content', 'encryptedcontent', 'redacted_reasoning']);
const EXPLICIT_PRIVATE_KEY = /["']?(?:private_reasoning|privateReasoning|chain_of_thought|chainOfThought|encrypted_content|encryptedContent|redacted_reasoning)["']?\s*:/i;

function sanitizeNativeBody(value, state = { omitted: false, nodes: 0 }, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') {
    // Native tool arguments sometimes wrap JSON as a string. Scrub explicit
    // opaque/private blocks inside that serialization while preserving ordinary
    // argument strings byte for byte.
    if (/^[\[{]/.test(value.trim())) {
      if (value.length > REPLAY_LIMITS.bodyBytes) {
        if (EXPLICIT_PRIVATE_KEY.test(value)) {
          state.omitted = true;
          return { value: null, omitted: true };
        }
        return { value, omitted: false };
      }
      let parsed;
      try { parsed = JSON.parse(value); }
      catch {
        // A malformed JSON-shaped native argument could contain an opaque
        // block. Omit it when an explicit private field is present; otherwise
        // retain ordinary source text such as a JavaScript object expression.
        if (EXPLICIT_PRIVATE_KEY.test(value)) {
          state.omitted = true;
          return { value: null, omitted: true };
        }
        return { value, omitted: false };
      }
      const previouslyOmitted = state.omitted;
      const clean = sanitizeNativeBody(parsed, state, depth + 1, seen);
      if (state.omitted !== previouslyOmitted) {
        try { return { value: clean.value === undefined ? null : JSON.stringify(clean.value), omitted: true }; }
        catch {
          state.omitted = true;
          return { value: null, omitted: true };
        }
      }
    }
    return { value, omitted: false };
  }
  if (value === null || typeof value !== 'object') return { value, omitted: false };
  state.nodes++;
  if (state.nodes > 10_000 || depth > 32) { state.omitted = true; return { value: undefined, omitted: true }; }
  if (seen.has(value)) { state.omitted = true; return { value: undefined, omitted: true }; }
  seen.add(value);
  const type = typeof value.type === 'string' ? value.type.toLowerCase().replaceAll('-', '_') : null;
  if (type && (PRIVATE_CONTENT_TYPES.has(type) || /^(?:reasoning|analysis)_/.test(type))) {
    state.omitted = true; seen.delete(value); return { value: undefined, omitted: true };
  }
  if (Array.isArray(value)) {
    const output = [];
    for (const item of value) {
      const clean = sanitizeNativeBody(item, state, depth + 1, seen);
      if (clean.value !== undefined) output.push(clean.value);
    }
    seen.delete(value);
    return { value: output, omitted: state.omitted };
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_CONTENT_KEYS.has(key.toLowerCase().replaceAll('-', '_'))) { state.omitted = true; continue; }
    const clean = sanitizeNativeBody(item, state, depth + 1, seen);
    if (clean.value !== undefined) output[key] = clean.value;
  }
  seen.delete(value);
  return { value: output, omitted: state.omitted };
}

function bodyProjection(value, budget) {
  const text = textBody(value);
  if (text === null) return { body: null, bodyStatus: 'unavailable', bodyReason: 'not-recorded' };
  const bytes = Buffer.byteLength(text, 'utf8');
  const cap = Math.min(REPLAY_LIMITS.bodyBytes, budget.remaining);
  if (cap <= 0) return { body: null, bodyStatus: 'omitted', bodyReason: 'total-body-limit', bodyBytes: bytes };
  if (bytes <= cap) {
    budget.remaining -= bytes;
    return { body: text, bodyStatus: 'included', bodyBytes: bytes };
  }
  let end = 0, used = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > cap) break;
    used += bytes; end += character.length;
  }
  const body = text.slice(0, end);
  budget.remaining -= used;
  return { body, bodyStatus: 'truncated', bodyReason: bytes > REPLAY_LIMITS.bodyBytes ? 'event-body-limit' : 'total-body-limit', bodyBytes: bytes };
}

function blockText(blocks) {
  if (!Array.isArray(blocks)) return null;
  const values = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (['input_text', 'output_text', 'text'].includes(block.type) && typeof block.text === 'string') values.push(block.text);
    else if (block.type === 'refusal' && typeof block.refusal === 'string') values.push(block.refusal);
  }
  return values.length ? values.join('\n') : null;
}

function replayEvent(row, line, sessionId, fingerprint, budget) {
  if (!row || typeof row !== 'object' || !row.record || typeof row.record !== 'object') return null;
  const record = row.record;
  if (!record.payload || typeof record.payload !== 'object') return null;
  const envelope = record.payload, type = envelope.type;
  let payload = envelope, kind, label, bodyValue, itemId, callId, relatedKey, role, status, phase, selfContained = false;

  if (record.type === 'response_item') {
    const item = envelope.item && typeof envelope.item === 'object' ? envelope.item : envelope;
    const itemType = item.type ?? envelope.type;
    itemId = typeof item.id === 'string' ? item.id : null;
    if (itemType === 'message') {
      role = item.role ?? envelope.role;
      const phase = item.phase ?? envelope.phase;
      // Native private reasoning blocks are not session replay content.
      if (role !== 'user' && role !== 'assistant') return null;
      if (phase === 'analysis' || phase === 'reasoning') return null;
      kind = 'message'; label = role === 'user' ? 'User message' : 'Assistant message';
      bodyValue = blockText(item.content ?? envelope.content);
      if (bodyValue === null) return { id: `${sessionId}:${fingerprint}:${line}`, sessionId, sourceLine: line,
        turnId: boundedText(envelope.turn_id, 128) ? envelope.turn_id : null, kind, label,
        timestamp: isoTimestamp(record.timestamp), body: null, bodyStatus: 'unavailable', bodyReason: 'missing-body',
        ...(boundedText(itemId, 256) ? { itemId } : {}) };
    } else if (itemType === 'agent_message') {
      // Native inter-agent updates can include encrypted_content blocks. Keep
      // only text blocks the source explicitly exposes; never decode or persist
      // the opaque encrypted payload.
      kind = 'message'; role = 'assistant'; label = 'Agent update';
      bodyValue = blockText(item.content ?? envelope.content);
      if (bodyValue === null) return { id: `${sessionId}:${fingerprint}:${line}`, sessionId, sourceLine: line,
        turnId: boundedText(envelope.turn_id, 128) ? envelope.turn_id : null, kind, role, label,
        timestamp: isoTimestamp(record.timestamp), body: null, bodyStatus: 'unavailable', bodyReason: 'opaque-or-missing-content',
        ...(boundedText(itemId, 256) ? { itemId } : {}) };
    } else if (itemType === 'custom_tool_call' || itemType === 'function_call' || itemType === 'tool_call') {
      kind = 'tool-call'; label = boundedText(item.name ?? item.tool_name, 200) ? (item.name ?? item.tool_name) : 'Tool call';
      bodyValue = item.input ?? item.arguments ?? null;
      callId = boundedText(item.call_id, 256) ? item.call_id : null;
      relatedKey = callId ? `${boundedText(envelope.turn_id, 128) ? envelope.turn_id : ''}\0${callId}` : null;
    } else if (itemType === 'custom_tool_call_output' || itemType === 'function_call_output' || itemType === 'tool_call_output') {
      kind = 'tool-result'; label = 'Tool result'; bodyValue = item.output ?? item.result ?? null;
      callId = boundedText(item.call_id, 256) ? item.call_id : null;
      relatedKey = callId ? `${boundedText(envelope.turn_id, 128) ? envelope.turn_id : ''}\0${callId}` : null;
      status = item.is_error === true ? 'error' : (boundedText(item.status, 80) ? item.status : 'returned');
    } else if (itemType === 'dynamicToolCall' || itemType === 'dynamic_tool_call'
      || itemType === 'mcpToolCall' || itemType === 'mcp_tool_call') {
      kind = 'tool-call';
      const server = boundedText(item.server, 120) ? item.server : null;
      const namespace = boundedText(item.namespace, 120) ? item.namespace : server;
      const tool = boundedText(item.tool, 120) ? item.tool : null;
      label = namespace && tool ? `${namespace}.${tool}` : tool ?? 'Dynamic tool call';
      bodyValue = { ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
        ...(item.result !== undefined ? { result: item.result } : {}),
        ...(Array.isArray(item.content_items) ? { content: item.content_items } : {}),
        ...(typeof item.success === 'boolean' ? { success: item.success } : {}) };
      status = boundedText(item.status, 80) ? item.status : null;
      selfContained = true;
      callId = boundedText(item.call_id ?? item.id, 256) ? (item.call_id ?? item.id) : null;
      relatedKey = callId ? `${boundedText(envelope.turn_id, 128) ? envelope.turn_id : ''}\0${callId}` : null;
    } else if (itemType === 'file_change') {
      kind = 'file-change'; label = 'File change'; bodyValue = item.changes ?? item.content ?? null;
    } else if (itemType === 'additional_tools') {
      kind = 'session'; label = 'Offered tool catalog'; status = 'advertised';
      const names = []; let omittedEntries = 0;
      const add = name => {
        if (typeof name === 'string' && name.length > 0 && boundedText(name, 500) && names.length < 200) names.push(name);
        else omittedEntries++;
      };
      if (!Array.isArray(item.tools)) omittedEntries++;
      for (const tool of Array.isArray(item.tools) ? item.tools : []) {
        if (tool?.type === 'namespace') {
          if (!boundedText(tool.name, 200) || !tool.name || !Array.isArray(tool.tools)) { omittedEntries++; continue; }
          for (const child of tool.tools) {
            if (child?.type === 'namespace' || typeof child?.name !== 'string' || !child.name) { omittedEntries++; continue; }
            add(`${tool.name}.${child.name}`);
          }
        } else add(tool?.name);
      }
      bodyValue = { scope: 'offered-not-invoked', recordedToolCount: names.length, tools: names, omittedEntries };
    } else if (itemType === 'reasoning') return null;
    else {
      kind = 'unsupported';
      label = `Unsupported native item: ${boundedText(itemType, 80) ? itemType : 'unknown'}`;
      bodyValue = null;
    }
    payload = item;
  } else if (record.type === 'event_msg') {
    const item = envelope.item && typeof envelope.item === 'object' ? envelope.item : null;
    itemId = item && typeof item.id === 'string' ? item.id : null;
    switch (type) {
      case 'item_started': case 'item_completed': {
        if (!item) return null;
        const itemType = item.type;
        const normalizedItemType = typeof itemType === 'string' ? itemType.replaceAll('_', '').toLowerCase() : '';
        if (itemType === 'Reasoning' || itemType === 'AgentMessage' || itemType === 'UserMessage') return null;
        if (normalizedItemType === 'commandexecution') {
          kind = 'command'; phase = type === 'item_started' ? 'started' : 'completed';
          label = 'Command execution';
          bodyValue = type === 'item_started' ? item.command ?? null : {
            ...(item.command !== undefined ? { command: item.command } : {}),
            ...(item.aggregated_output !== undefined ? { output: item.aggregated_output } : {}),
            ...(item.stdout !== undefined ? { stdout: item.stdout } : {}),
            ...(item.stderr !== undefined ? { stderr: item.stderr } : {}),
            ...(Number.isSafeInteger(item.exit_code) ? { exitCode: item.exit_code } : {}),
          };
          status = boundedText(item.status, 80) ? item.status : null;
          payload = item;
        } else if (normalizedItemType === 'filechange') {
          kind = 'file-change'; phase = type === 'item_started' ? 'started' : 'completed'; label = 'File change'; bodyValue = {
            ...(item.changes !== undefined ? { changes: item.changes } : {}),
            ...(item.stdout !== undefined ? { stdout: item.stdout } : {}),
            ...(item.stderr !== undefined ? { stderr: item.stderr } : {}),
          };
          status = boundedText(item.status, 80) ? item.status : null;
          payload = item;
        } else if (['mcptoolcall','dynamictoolcall'].includes(normalizedItemType)) {
          const completed = type === 'item_completed';
          kind = completed ? 'tool-result' : 'tool-call';
          phase = completed ? 'completed' : 'started';
          const server = boundedText(item.server, 120) ? item.server : null;
          const namespace = boundedText(item.namespace, 120) ? item.namespace : server;
          const tool = boundedText(item.tool, 120) ? item.tool : null;
          label = namespace && tool ? `${namespace}.${tool}` : tool ?? (normalizedItemType === 'mcptoolcall' ? 'MCP tool call' : 'Dynamic tool call');
          callId = boundedText(item.id, 256) ? item.id : null;
          relatedKey = callId ? `${boundedText(envelope.turn_id, 128) ? envelope.turn_id : ''}\0${callId}` : null;
          status = boundedText(item.status, 80) ? item.status : null;
          const identity = { ...(server ? { server } : {}), ...(namespace && namespace !== server ? { namespace } : {}), ...(tool ? { tool } : {}),
            ...(boundedText(item.pluginId ?? item.plugin_id, 160) ? { pluginId: item.pluginId ?? item.plugin_id } : {}) };
          const result = item.result ?? item;
          const content = Array.isArray(result.content) && Array.isArray(item.content_items)
            ? [...result.content, ...item.content_items]
            : Array.isArray(item.content_items) ? item.content_items : result.content;
          bodyValue = completed ? { ...identity,
            ...(content ? { content } : {}),
            ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
            ...(result.structured_content !== undefined ? { structuredContent: result.structured_content } : {}),
            ...(typeof result.is_error === 'boolean' ? { isError: result.is_error } : {}),
            ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
            ...(item.error !== undefined ? { error: item.error } : {}),
            ...(typeof item.success === 'boolean' ? { success: item.success } : {}) }
            : { ...identity, ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
              ...(item.input !== undefined ? { input: item.input } : {}) };
          if (completed && (result.isError === true || result.is_error === true || item.success === false || item.error != null)) status = 'error';
        } else if (typeof itemType === 'string' && /collab.*agent.*tool.*call/i.test(itemType)) {
          kind = 'delegation'; label = 'Delegated session';
          const call = item.collabAgentToolCall ?? item;
          const receivers = Array.isArray(call.receiverThreadIds) ? call.receiverThreadIds.filter(uuid)
            : Array.isArray(call.receiver_thread_ids) ? call.receiver_thread_ids.filter(uuid) : [];
          payload = { receiverThreadIds: receivers,
            ...(uuid(call.parentThreadId ?? call.threadId ?? call.senderThreadId ?? envelope.thread_id)
              ? { parentThreadId: call.parentThreadId ?? call.threadId ?? call.senderThreadId ?? envelope.thread_id } : {}) };
        } else if (itemType === 'SubAgentActivity') {
          const childId = uuid(item.agent_thread_id) ? item.agent_thread_id : null;
          const activity = ['started', 'interacted', 'completed'].includes(item.kind) ? item.kind : null;
          if (!childId || !activity) return null;
          kind = 'delegation'; label = activity === 'interacted' ? 'Delegated agent activity' : 'Delegated agent';
          status = activity;
          phase = activity === 'started' || activity === 'completed' ? activity : undefined;
          callId = boundedText(item.id, 256) ? item.id : null;
          payload = { receiverThreadIds: [childId],
            ...(uuid(envelope.thread_id) ? { parentThreadId: envelope.thread_id } : {}),
            ...(boundedText(item.model, 120) ? { model: item.model } : {}),
            ...(boundedText(item.reasoning_effort, 40) ? { reasoningEffort: item.reasoning_effort } : {}) };
          const settings = { ...(payload.model ? { model: payload.model } : {}),
            ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}) };
          if (Object.keys(settings).length) bodyValue = settings;
        } else return null;
        if (phase) { label += ` ${phase}`; status ??= phase; }
        break;
      }
      case 'turn_started': kind = 'turn'; label = 'Turn started'; status = 'started'; break;
      case 'turn_complete': case 'turn_completed':
        kind = 'turn'; status = envelope.error ? 'failed' : 'completed'; label = status === 'failed' ? 'Turn failed' : 'Turn completed'; break;
      case 'turn_aborted': kind = 'turn'; label = 'Turn interrupted'; status = 'interrupted'; break;
      case 'error': kind = 'error'; label = 'Session error'; bodyValue = envelope.error?.message ?? null; status = 'error'; break;
      case 'task_started': kind = 'session'; label = 'Session started'; status = 'started'; break;
      case 'task_complete':
        kind = 'session'; status = envelope.error ? 'failed' : 'completed'; label = status === 'failed' ? 'Session failed' : 'Session completed'; break;
      case 'context_compacted': kind = 'compaction'; label = 'Context compacted'; break;
      case 'mcp_tool_call_begin': case 'mcp_tool_call_end': {
        phase = type.endsWith('_begin') ? 'started' : 'completed';
        kind = phase === 'started' ? 'tool-call' : 'tool-result';
        const invocation = envelope.invocation && typeof envelope.invocation === 'object' ? envelope.invocation : {};
        const server = boundedText(invocation.server ?? envelope.server, 120) ? (invocation.server ?? envelope.server) : null;
        const tool = boundedText(invocation.tool ?? envelope.tool, 120) ? (invocation.tool ?? envelope.tool) : null;
        label = server && tool ? `${server}.${tool}` : tool ?? 'MCP tool call';
        callId = boundedText(envelope.call_id ?? envelope.callId, 256) ? (envelope.call_id ?? envelope.callId) : null;
        relatedKey = callId ? `${boundedText(envelope.turn_id, 128) ? envelope.turn_id : ''}\0${callId}` : null;
        bodyValue = phase === 'started' ? { ...(server ? { server } : {}), ...(tool ? { tool } : {}),
          ...(invocation.arguments !== undefined ? { arguments: invocation.arguments } : {}),
          ...(envelope.arguments !== undefined ? { arguments: envelope.arguments } : {}) }
          : { ...(server ? { server } : {}), ...(tool ? { tool } : {}), ...(envelope.result !== undefined ? { result: envelope.result } : {}) };
        const legacyResult = envelope.result;
        const isToolError = legacyResult?.Err !== undefined || legacyResult?.Ok?.isError === true
          || legacyResult?.ok?.is_error === true || legacyResult?.ok?.isError === true
          || legacyResult?.Ok?.is_error === true;
        status = phase === 'started' ? 'started' : isToolError ? 'error' : 'returned';
        break;
      }
      case 'exec_command_begin': case 'exec_command_end': {
        phase = type.endsWith('_begin') ? 'started' : 'completed';
        kind = phase === 'started' ? 'tool-call' : 'tool-result'; label = 'Command execution';
        callId = boundedText(envelope.call_id ?? envelope.callId, 256) ? (envelope.call_id ?? envelope.callId) : null;
        relatedKey = callId ? `${boundedText(envelope.turn_id, 128) ? envelope.turn_id : ''}\0${callId}` : null;
        bodyValue = phase === 'started' ? envelope.command ?? null : {
          ...(envelope.command !== undefined ? { command: envelope.command } : {}),
          ...(envelope.aggregated_output !== undefined ? { output: envelope.aggregated_output } : {}),
          ...(Number.isSafeInteger(envelope.exit_code) ? { exitCode: envelope.exit_code } : {}),
          ...(boundedText(envelope.status, 80) ? { status: envelope.status } : {}),
        };
        status = phase === 'started' ? 'started' : envelope.status ?? 'completed';
        break;
      }
      case 'hook_started': case 'hook_completed': {
        const run = envelope.run && typeof envelope.run === 'object' ? envelope.run : {};
        phase = type === 'hook_started' ? 'started' : 'completed'; kind = 'hook';
        const eventName = boundedText(run.event_name ?? run.eventName, 100) ? (run.event_name ?? run.eventName) : 'Hook';
        label = `${eventName} hook ${phase}`;
        itemId = boundedText(run.id, 256) ? run.id : null;
        status = boundedText(run.status, 80) ? run.status : phase;
        bodyValue = { eventName,
          ...(boundedText(run.handler_type ?? run.handlerType, 80) ? { handlerType: run.handler_type ?? run.handlerType } : {}),
          ...(boundedText(run.execution_mode ?? run.executionMode, 40) ? { executionMode: run.execution_mode ?? run.executionMode } : {}),
          ...(boundedText(run.scope, 40) ? { scope: run.scope } : {}),
          ...(Array.isArray(run.entries) ? { entries: run.entries.map(entry => ({
            ...(boundedText(entry?.kind, 80) ? { kind: entry.kind } : {}),
            ...(boundedText(entry?.text, 100000) ? { text: entry.text } : {}),
          })) } : {}) };
        break;
      }
      default: return null;
    }
  } else if (record.type === 'compacted') {
    kind = 'compaction'; label = 'Recorded compaction summary';
    bodyValue = typeof envelope.message === 'string' ? envelope.message : null;
  } else return null;

  const turnId = boundedText(envelope.turn_id, 128) ? envelope.turn_id : null;
  const event = { id: `${sessionId}:${fingerprint}:${line}`, sessionId, turnId, kind, label,
    timestamp: eventTimestamp(record, envelope), sourceLine: line, body: null, bodyStatus: 'unavailable', bodyReason: 'not-recorded' };
  if (itemId && boundedText(itemId, 256)) event.itemId = itemId;
  if (payload && Array.isArray(payload.receiverThreadIds)) event.childSessionIds = payload.receiverThreadIds;
  if (payload && uuid(payload.parentThreadId)) event.parentSessionId = payload.parentThreadId;
  if (callId) event.callId = callId;
  if (role) event.role = role;
  if (status) event.status = status;
  if (phase) event.phase = phase;
  if (bodyValue !== undefined) {
    const sanitized = sanitizeNativeBody(bodyValue);
    Object.assign(event, bodyProjection(sanitized.value, budget));
    if (sanitized.omitted) event.contentOmitted = true;
  } else if (kind === 'message') event.bodyReason = 'missing-body';
  return { event, relatedKey, nativeRecordType: record.type, selfContained };
}

/** Parse one bounded native JSONL session without persisting or mutating its source. */
export function projectNativeReplaySession({ id, parentId = null, depth = 0, status = 'ready', reason = null,
  sourceFingerprint = null, records, budget = null }) {
  const bodyBudget = budget ?? { remaining: REPLAY_LIMITS.totalBodyBytes, remainingRecords: REPLAY_LIMITS.records };
  if (!uuid(id) || (parentId !== null && !uuid(parentId)) || !Number.isSafeInteger(depth) || depth < 0
    || (sourceFingerprint !== null && !/^[a-f0-9]{64}$/i.test(sourceFingerprint))
    || (!sourceFingerprint && records?.length) || !Array.isArray(records))
    throw new Error('Replay session identity, fingerprint, depth, or records are invalid');
  const session = { id, parentId, depth, status: boundedText(status, 80) ? status : 'unavailable',
    source: { fingerprint: sourceFingerprint?.toLowerCase() ?? null }, events: [], limits: [] };
  const header = records[0]?.record;
  const metadata = header?.type === 'session_meta' ? header.payload : null;
  const ownedHeader = metadata?.id === id
    && (metadata.session_id === undefined || uuid(metadata.session_id))
    && (parentId ? uuid(metadata.session_id) && metadata.parent_thread_id === parentId
      && metadata.source?.subagent?.thread_spawn?.parent_thread_id === parentId
      && (metadata.forked_from_id === undefined || metadata.forked_from_id === parentId)
      : metadata.source?.subagent === undefined);
  if (boundedText(reason, 500)) session.reason = reason;
  const callEvents = new Map(), resultEvents = new Map(); let unprojectedRecords = 0;
  const unprojectedTypes = new Set();
  const count = Math.min(records.length, REPLAY_LIMITS.records, Number.isSafeInteger(bodyBudget.remainingRecords)
    ? Math.max(0, bodyBudget.remainingRecords) : REPLAY_LIMITS.records);
  if (count > 0 && ownedHeader && replayCwd(metadata.cwd)) session.cwd = metadata.cwd;
  if (Number.isSafeInteger(bodyBudget.remainingRecords)) bodyBudget.remainingRecords -= count;
  const projectedItems = new Map();
  for (let index = 0; index < count; index++) {
    const row = records[index];
    if (index === 0 && header?.type === 'session_meta') continue;
    const line = Number.isSafeInteger(row?.sourceLine) && row.sourceLine > 0 ? row.sourceLine : index + 1;
    const parsed = replayEvent(row, line, id, sourceFingerprint?.toLowerCase() ?? 'unavailable', bodyBudget);
    if (!parsed) {
      unprojectedRecords++;
      const record = row?.record, payload = record?.payload;
      const nativeKind = payload?.item?.type ?? payload?.type;
      if (boundedText(record?.type, 40) && boundedText(nativeKind, 60)) unprojectedTypes.add(`${record.type}:${nativeKind}`);
      continue;
    }
    const event = parsed.event ?? parsed;
    const duplicateKey = event.itemId ? `${event.kind}\0${event.turnId ?? ''}\0${event.itemId}` : null;
    const previous = duplicateKey ? projectedItems.get(duplicateKey) : null;
    const duplicateLifecycleEcho = previous && previous.nativeRecordType !== parsed.nativeRecordType
      && previous.event.phase === event.phase && previous.event.kind === event.kind
      && previous.event.body === event.body && previous.event.status === event.status;
    if (duplicateLifecycleEcho) {
      previous.event.sourceLines ??= [previous.event.sourceLine];
      previous.event.sourceLines.push(event.sourceLine);
      continue;
    }
    if (duplicateKey && !previous) projectedItems.set(duplicateKey, { event, nativeRecordType: parsed.nativeRecordType });
    if (event.kind === 'tool-call' && parsed.relatedKey && !parsed.selfContained) {
      const calls = callEvents.get(parsed.relatedKey) ?? [];
      calls.push(event); callEvents.set(parsed.relatedKey, calls);
    }
    if (event.kind === 'tool-result' && parsed.relatedKey) {
      const results = resultEvents.get(parsed.relatedKey) ?? [];
      results.push(event); resultEvents.set(parsed.relatedKey, results);
    }
    session.events.push(event);
  }
  let ambiguousLinks = 0;
  for (const [key, results] of resultEvents) {
    const calls = callEvents.get(key) ?? [];
    if (calls.length === 1 && results.length === 1) {
      calls[0].relatedEventId = results[0].id;
      results[0].relatedEventId = calls[0].id;
    } else {
      for (const call of calls) call.linkStatus = calls.length > 1 || results.length > 1 ? 'ambiguous' : 'result-not-found';
      for (const result of results) result.linkStatus = calls.length > 1 || results.length > 1 ? 'ambiguous' : 'call-not-found';
      if (calls.length > 1 || results.length > 1) ambiguousLinks++;
      else if (calls.length === 0) for (const result of results) result.linkStatus = 'call-not-found';
    }
  }
  for (const [key, calls] of callEvents) {
    if (resultEvents.has(key)) continue;
    for (const call of calls) call.linkStatus = calls.length > 1 ? 'ambiguous' : 'result-not-found';
    if (calls.length > 1) ambiguousLinks++;
  }
  const lifecycle = new Map();
  for (const event of session.events) {
    if (!event.itemId || !event.phase || !['command','file-change','hook'].includes(event.kind)) continue;
    const key = `${event.kind}\0${event.turnId ?? ''}\0${event.itemId}`;
    const pair = lifecycle.get(key) ?? { started: [], completed: [] };
    pair[event.phase].push(event); lifecycle.set(key, pair);
  }
  for (const pair of lifecycle.values()) {
    if (pair.started.length === 1 && pair.completed.length === 1) {
      pair.started[0].relatedEventId = pair.completed[0].id;
      pair.completed[0].relatedEventId = pair.started[0].id;
    } else if (pair.started.length || pair.completed.length) {
      for (const event of [...pair.started, ...pair.completed]) event.linkStatus = 'lifecycle-incomplete-or-ambiguous';
    }
  }
  if (records.length > REPLAY_LIMITS.records) session.limits.push({ kind: 'record-limit', omitted: records.length - REPLAY_LIMITS.records });
  if (count < records.length) session.limits.push({ kind: 'replay-total-record-limit', omitted: records.length - count,
    message: 'Additional records exceeded the shared replay record budget.' });
  if (unprojectedRecords) session.limits.push({ kind: 'unprojected-records', omitted: unprojectedRecords,
    message: `${unprojectedRecords} native records were not projected into conversation replay. Stream metadata and private reasoning are excluded.`,
    ...(unprojectedTypes.size ? { types: [...unprojectedTypes].sort().slice(0, 40) } : {}) });
  if (ambiguousLinks) session.limits.push({ kind: 'ambiguous-call-links', omitted: ambiguousLinks,
    message: 'Repeated native call identifiers prevented safe call/result matching.' });
  if (session.events.some(event => event.timestamp === null)) session.limits.push({ kind: 'missing-timestamps', message: 'Some native records have no usable timestamp.' });
  if (session.events.some(event => event.bodyStatus === 'truncated' || event.bodyStatus === 'omitted'))
    session.limits.push({ kind: 'body-size-limit', message: 'Some event bodies were truncated or omitted at the replay size limit.' });
  return session;
}

/** Parse native session trees while preserving missing branches as explicit unavailable sessions. */
export function projectSessionReplay(sessions) {
  if (!Array.isArray(sessions) || !sessions.length || sessions.length > 101) throw new Error('Replay requires a bounded nonempty session list');
  const ids = new Set();
  const budget = { remaining: REPLAY_LIMITS.totalBodyBytes, remainingRecords: REPLAY_LIMITS.records };
  const projected = sessions.map(session => {
    const row = projectNativeReplaySession({ ...session, budget });
    if (ids.has(row.id)) throw new Error('Replay session IDs must be unique');
    ids.add(row.id);
    return row;
  });
  for (const session of projected) {
    if (session.parentId && !ids.has(session.parentId)) {
      session.limits.push({ kind: 'missing-parent', message: 'The parent session is not included in this replay.' });
    }
  }
  const byId = new Map(projected.map(session => [session.id, session]));
  for (const session of projected) for (const event of session.events) {
    if (!event.childSessionIds) continue;
    const corroborated = event.childSessionIds.filter(id => byId.get(id)?.parentId === session.id);
    if (corroborated.length) event.childSessionIds = [...new Set(corroborated)];
    else {
      delete event.childSessionIds;
      event.linkStatus = 'child-session-unavailable';
    }
  }
  return { schemaVersion: 1, kind: 'session-replay', sessions: projected };
}

/** Validate a stored replay projection and optionally remove local message bodies. */
export function normalizeSessionReplay(replay, { includeBodies = true } = {}) {
  if (!replay || replay.schemaVersion !== 1 || replay.kind !== 'session-replay'
    || !Array.isArray(replay.sessions) || replay.sessions.length < 1 || replay.sessions.length > 101)
    throw new Error('Stored session replay is invalid');
  const onlyKeys = (value, allowed, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key)))
      throw new Error(`Stored replay ${label} contains unsupported fields`);
  };
  const safeString = (value, max) => boundedText(value, max);
  const ids = new Set(), eventIds = new Map(); let bodyBytes = 0, eventCount = 0;
  const sessions = replay.sessions.map(session => {
    onlyKeys(session, new Set(['id','parentId','depth','status','reason','cwd','source','events','limits']), 'session');
    onlyKeys(session.source, new Set(['fingerprint']), 'source');
    if (!uuid(session.id) || ids.has(session.id) || !Array.isArray(session.events) || session.events.length > REPLAY_LIMITS.records
      || !Array.isArray(session.limits) || session.limits.length > 1000
      || !session.source || (session.source.fingerprint !== null && !/^[a-f0-9]{64}$/.test(session.source.fingerprint))
      || !Number.isSafeInteger(session.depth) || session.depth < 0 || session.depth > 5
      || (session.parentId !== null && !uuid(session.parentId))
      || !['ready','partial','unavailable','not-found'].includes(session.status)
      || (session.cwd !== undefined && (!replayCwd(session.cwd) || !session.source.fingerprint))
      || (session.reason !== undefined && !safeString(session.reason, 500)))
      throw new Error('Stored session replay contains an invalid session');
    ids.add(session.id);
    const safeSession = { id: session.id, parentId: session.parentId, depth: session.depth, status: session.status,
      source: { fingerprint: session.source.fingerprint }, events: [], limits: [] };
    if (session.reason !== undefined) safeSession.reason = session.reason;
    if (session.cwd !== undefined) safeSession.cwd = session.cwd;
    for (const event of session.events) {
      onlyKeys(event, new Set(['id','sessionId','turnId','kind','label','timestamp','sourceLine','body','bodyStatus',
        'bodyReason','bodyBytes','callId','relatedEventId','itemId','role','status','phase','linkStatus',
        'childSessionIds','parentSessionId','sourceLines','contentOmitted']), 'event');
      if (event.sessionId !== session.id || typeof event.id !== 'string' || !Number.isSafeInteger(event.sourceLine)
        || event.sourceLine < 1 || event.id !== `${session.id}:${session.source.fingerprint}:${event.sourceLine}`
        || (event.turnId !== null && !uuid(event.turnId))
        || !['message','tool-call','tool-result','command','file-change','delegation','hook','turn','error','session','compaction','unsupported'].includes(event.kind)
        || !safeString(event.label, 200) || (event.timestamp !== null && isoTimestamp(event.timestamp) !== event.timestamp)
        || !['included','omitted','truncated','unavailable'].includes(event.bodyStatus)
        || (event.body !== null && typeof event.body !== 'string')
        || (event.bodyReason !== undefined && !safeString(event.bodyReason, 120))
        || (event.bodyBytes !== undefined && (!Number.isSafeInteger(event.bodyBytes) || event.bodyBytes < 0 || event.bodyBytes > REPLAY_LIMITS.sourceBytes))
        || (event.callId !== undefined && !safeString(event.callId, 256))
        || (event.relatedEventId !== undefined && typeof event.relatedEventId !== 'string')
        || (event.itemId !== undefined && !safeString(event.itemId, 256))
        || (event.role !== undefined && !['user','assistant'].includes(event.role))
        || (event.status !== undefined && !safeString(event.status, 80))
        || (event.phase !== undefined && !['started','completed'].includes(event.phase))
        || (event.linkStatus !== undefined && !['ambiguous','result-not-found','call-not-found','lifecycle-incomplete-or-ambiguous','child-session-unavailable'].includes(event.linkStatus))
        || (event.contentOmitted !== undefined && typeof event.contentOmitted !== 'boolean')
        || (event.parentSessionId !== undefined && !uuid(event.parentSessionId))
        || (event.childSessionIds !== undefined && (!Array.isArray(event.childSessionIds) || event.childSessionIds.length > 100
          || event.childSessionIds.some(childId => !uuid(childId))))
        || (event.sourceLines !== undefined && (!Array.isArray(event.sourceLines) || event.sourceLines.length > 100
          || event.sourceLines.some(line => !Number.isSafeInteger(line) || line < 1))))
        throw new Error('Stored session replay contains an invalid event');
      if (eventIds.has(event.id)) throw new Error('Stored session replay contains duplicate event IDs');
      eventIds.set(event.id, session.id);
      if (event.bodyStatus === 'included' && typeof event.body !== 'string') throw new Error('Included replay body is missing');
      if (['omitted','unavailable'].includes(event.bodyStatus) && event.body !== null) throw new Error('Unavailable replay body must be null');
      if (event.body !== null) {
        const size = Buffer.byteLength(event.body, 'utf8');
        if (size > REPLAY_LIMITS.bodyBytes || (event.bodyBytes !== undefined && event.bodyBytes < size))
          throw new Error('Replay event body size is invalid');
        bodyBytes += size;
      }
      safeSession.events.push(Object.fromEntries(Object.entries(event).filter(([key]) => includeBodies || key !== 'body')));
      eventCount++;
    }
    for (const limit of session.limits) {
      onlyKeys(limit, new Set(['kind','message','omitted','types']), 'limit');
      if (!safeString(limit.kind, 100) || (limit.message !== undefined && !safeString(limit.message, 300))
        || (limit.omitted !== undefined && (!Number.isSafeInteger(limit.omitted) || limit.omitted < 0))
        || (limit.types !== undefined && (!Array.isArray(limit.types) || limit.types.length > 40 || limit.types.some(type => !safeString(type, 100)))) )
        throw new Error('Stored session replay contains an invalid limit');
      safeSession.limits.push({ kind: limit.kind, ...(limit.message !== undefined ? { message: limit.message } : {}),
        ...(limit.omitted !== undefined ? { omitted: limit.omitted } : {}),
        ...(limit.types !== undefined ? { types: [...new Set(limit.types)] } : {}) });
    }
    return safeSession;
  });
  if (eventCount > REPLAY_LIMITS.records || bodyBytes > REPLAY_LIMITS.totalBodyBytes)
    throw new Error('Stored replay exceeds its aggregate event or body limit');
  for (const session of sessions) {
    if (session.parentId && ids.has(session.parentId)) {
      const parent = sessions.find(candidate => candidate.id === session.parentId);
      if (session.depth !== parent.depth + 1) throw new Error('Stored replay session depth does not match its parent');
    }
    const seenParents = new Set([session.id]); let parentId = session.parentId;
    while (parentId) {
      if (seenParents.has(parentId)) throw new Error('Stored replay contains a session parent cycle');
      seenParents.add(parentId);
      parentId = sessions.find(candidate => candidate.id === parentId)?.parentId ?? null;
    }
  }
  for (const session of sessions) for (const event of session.events) {
    if (event.relatedEventId !== undefined && eventIds.get(event.relatedEventId) !== event.sessionId)
      throw new Error('Stored replay event link is missing or crosses session boundaries');
    if (event.parentSessionId !== undefined && event.parentSessionId !== event.sessionId)
      throw new Error('Stored replay event parent does not match its session');
    if (event.childSessionIds !== undefined) {
      const corroborated = event.childSessionIds.filter(id => sessions.some(child => child.id === id && child.parentId === session.id));
      if (corroborated.length) event.childSessionIds = [...new Set(corroborated)];
      else {
        delete event.childSessionIds;
        event.linkStatus = 'child-session-unavailable';
      }
    }
  }
  return { schemaVersion: 1, kind: 'session-replay', sessions };
}

