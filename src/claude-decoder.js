import { isDeepStrictEqual } from 'node:util';

export const nativeText = value => typeof value === 'string' && value.trim() && value.length <= 1024
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ? value : null;
const body = value => typeof value === 'string' && Buffer.byteLength(value) <= 1024 * 1024 ? value : null;
export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan'];
export const CLAUDE_REQUEST = 'claude/tool/requestApproval';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function claudeModels(value) {
  if (!Array.isArray(value) || !value.length || value.length > 5000) throw new Error('Claude did not advertise a usable model catalog');
  const seen = new Set();
  return value.map(row => {
    const model = nativeText(row?.value);
    if (!model || seen.has(model)) throw new Error('Invalid or duplicate Claude model');
    seen.add(model);
    const levels = row.supportedEffortLevels;
    if (levels != null && (!Array.isArray(levels) || levels.length > 128 || !levels.every(nativeText)
      || new Set(levels).size !== levels.length || row.supportsEffort === false && levels.length))
      throw new Error('Invalid Claude model effort metadata');
    return { id: model, model, resolvedModel: nativeText(row.resolvedModel), displayName: nativeText(row.displayName),
      hidden: null, isDefault: null, defaultReasoningEffort: null, supportsEffort: typeof row.supportsEffort === 'boolean' ? row.supportsEffort : null,
      supportedReasoningEfforts: levels == null ? row.supportsEffort === false ? [] : null
        : levels.filter(level => EFFORTS.includes(level)).map(reasoningEffort => ({ reasoningEffort, description: null })),
      effortCapability: row.supportsEffort === false ? 'unsupported' : levels?.some(level => EFFORTS.includes(level)) ? 'supported' : 'unknown' };
  });
}

export function validateClaudeDecision(request, value) {
  if (request?.method !== CLAUDE_REQUEST || !object(value) || Object.keys(value).length !== 1
    || !['accept', 'decline'].includes(value.decision) || !request.params?.availableDecisions?.includes(value.decision))
    throw new Error('Choose approve once or decline for this Claude tool request');
  return value;
}

function usage(value) {
  if (!object(value)) return null;
  const keys = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  const out = Object.fromEntries(keys.filter(key => Number.isSafeInteger(value[key]) && value[key] >= 0).map(key => [key, value[key]]));
  return Object.keys(out).length ? out : null;
}

export function createClaudeDecoder({ sessionId, promptId, workspace }) {
  const tools = new Map(), requests = new Set(), events = [], assistant = [], seenItems = new Set();
  let init = null, result = null, turnId = null, sourceLine = 0, observedModel = null;
  function event(kind, values = {}) {
    if (events.length >= 10000) throw new Error('Claude event limit exceeded');
    events.push({ kind, agentId: sessionId, turnId, source: 'claude-agent-sdk', sourceLine, ...values });
  }
  function consume(frame) {
    sourceLine++;
    if (!object(frame) || !nativeText(frame.type)) throw new Error('Invalid Claude event');
    if (frame.type === 'tool_progress' && (frame.session_id !== sessionId || !tools.has(frame.tool_use_id)
      || frame.parent_tool_use_id != null)) {
      event('claude-advisory-tool-progress', { itemId: nativeText(frame.tool_use_id),
        reportedSessionId: nativeText(frame.session_id), parentToolUseId: nativeText(frame.parent_tool_use_id),
        advisory: true, executionProven: false });
      return;
    }
    if (frame.session_id !== sessionId) throw new Error('Claude event does not match the owned session');
    if (result) throw new Error('Claude event arrived after the terminal result');
    if (frame.user_message_uuid != null && frame.user_message_uuid !== promptId) throw new Error('Claude event belongs to another user message');
    const nativeTurn = nativeText(frame.turn_id);
    if (nativeTurn && turnId && nativeTurn !== turnId) throw new Error('Claude turn identity changed');
    turnId ??= nativeTurn;
    if (frame.type === 'system' && frame.subtype === 'init') {
      if (init || frame.cwd !== workspace || frame.apiKeySource != null && frame.apiKeySource !== 'none')
        throw new Error('Claude did not confirm the selected workspace and native account route');
      init = { source: 'claude-system-init', model: nativeText(frame.model), permissionMode: nativeText(frame.permissionMode),
        reasoningEffort: nativeText(frame.effort), version: nativeText(frame.claude_code_version), cwd: frame.cwd };
      event('claude-system-init', { itemId: nativeText(frame.uuid) });
      return;
    }
    if (frame.type === 'assistant') {
      const itemId = nativeText(frame.uuid);
      if (frame.parent_tool_use_id != null) {
        event('claude-advisory-child-message', { itemId, parentToolUseId: nativeText(frame.parent_tool_use_id), advisory: true });
        return;
      }
      if (!Array.isArray(frame.message?.content)) throw new Error('Invalid Claude assistant message');
      if (itemId && seenItems.has(itemId)) return;
      if (itemId) seenItems.add(itemId);
      observedModel = nativeText(frame.message.model) ?? observedModel;
      for (const block of frame.message.content) {
        if (block?.type === 'text' && body(block.text) !== null) {
          assistant.push({ itemId, text: block.text });
          event('assistant-message', { itemId });
        }
        if (block?.type === 'tool_use') {
          const id = nativeText(block.id), name = nativeText(block.name);
          if (!id || !name || !object(block.input)) throw new Error('Invalid Claude tool action');
          if (tools.has(id)) {
            if (tools.get(id).name !== name || !isDeepStrictEqual(tools.get(id).input, block.input))
              throw new Error('Conflicting Claude tool action');
            continue;
          }
          tools.set(id, { id, name, input: structuredClone(block.input), status: 'proposed', started: false });
          event('claude-tool-proposed', { itemId: id, name });
        }
      }
    } else if (frame.type === 'tool_progress') {
      const tool = tools.get(frame.tool_use_id);
      if (frame.tool_name !== tool.name) throw new Error('Claude tool progress identity changed');
      if (!tool.started) event('claude-tool-running', { itemId: tool.id, name: tool.name });
      tool.started = true;
    } else if (frame.type === 'user' && Array.isArray(frame.message?.content)) {
      for (const block of frame.message.content) {
        if (block?.type !== 'tool_result') continue;
        const tool = tools.get(block.tool_use_id);
        if (!tool || frame.parent_tool_use_id != null) { event('claude-advisory-tool-result', { itemId: nativeText(block.tool_use_id), advisory: true }); continue; }
        const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
          ? block.content.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n') : '';
        tool.status = block.is_error === true
          ? /(?:stopped|interrupted|aborted) while (?:running|executing)/i.test(content) ? 'stopped-while-running' : 'failed'
          : block.is_error === false ? 'completed' : 'result-observed';
        event('claude-tool-result', { itemId: tool.id, status: tool.status, name: tool.name });
      }
    } else if (frame.type === 'result') {
      if (!init) throw new Error('Claude result arrived without matching native initialization');
      result = { id: nativeText(frame.uuid), complete: frame.subtype === 'success' && frame.is_error === false,
        subtype: nativeText(frame.subtype), text: body(frame.result), usage: usage(frame.usage),
        durationMs: Number.isFinite(frame.duration_ms) && frame.duration_ms >= 0 ? frame.duration_ms : null,
        reasoningEffort: nativeText(frame.effort) };
      event('claude-result', { itemId: result.id, status: result.complete ? 'completed' : 'failed' });
    }
  }
  function request(name, input, meta) {
    const id = nativeText(meta.requestId), itemId = nativeText(meta.toolUseID);
    const tool = tools.get(itemId);
    if (!init || result || !id || !tool || requests.has(id) || tool.name !== name
      || tool.requestId || !isDeepStrictEqual(tool.input, input))
      throw new Error('Claude permission request does not match the current exact tool action');
    requests.add(id); tool.requestId = id;
    const params = { threadId: sessionId, turnId, itemId, toolName: name, input: structuredClone(tool.input),
      availableDecisions: ['accept', 'decline'], title: nativeText(meta.title), blockedPath: nativeText(meta.blockedPath) };
    return { request: { id, method: CLAUDE_REQUEST, params }, item: { id: itemId, name, input: structuredClone(tool.input) } };
  }
  return { consume, request, events, tools, assistant,
    get init() { return init; }, get result() { return result; }, get turnId() { return turnId; },
    get observedModel() { return observedModel; } };
}
