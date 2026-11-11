import { isDeepStrictEqual } from 'node:util';
import { copilotId } from './copilot-profile.js';

export const COPILOT_REQUEST = 'copilot/permission';

const pathText = value => typeof value === 'string' && value.startsWith('/') && value.length <= 16384 && !/[\p{Cc}\p{Cf}]/u.test(value);
const strings = value => Array.isArray(value) && value.length <= 128 && value.every(copilotId);
const record = value => value && typeof value === 'object' && !Array.isArray(value);

export function copilotPermission(event, sessionId, turnId, cwd) {
  const { requestId, ownerSessionId, permissionRequest: action, promptRequest: prompt } = event.data ?? {};
  if (ownerSessionId !== sessionId || !copilotId(requestId) || !copilotId(turnId)
    || !record(action) || !record(prompt) || !copilotId(action.toolCallId)
    || prompt.toolCallId !== action.toolCallId || action.requestSandboxBypass === true || prompt.requestSandboxBypass === true)
    throw new Error('Unbound Copilot permission request.');
  if (action.kind === 'shell') {
    if (action.shellType !== 'bash' || typeof action.fullCommandText !== 'string' || !action.fullCommandText.trim()
      || action.hasParseErrors !== false || action.resolvedWorkingDirectory != null && action.resolvedWorkingDirectory !== cwd
      || !Array.isArray(action.commandSegments) || !action.commandSegments.length
      || action.commandSegments.some(segment => !record(segment) || segment.workingDirectory !== cwd
        || segment.hasUnboundExecutableContent !== false || !copilotId(segment.identifier)
        || !(segment.staticTokens === null || strings(segment.staticTokens))))
      throw new Error('Unsupported Copilot shell permission context.');
    if (prompt.kind === 'commands' && (prompt.fullCommandText !== action.fullCommandText
      || !strings(prompt.commandIdentifiers)
      || !isDeepStrictEqual(new Set(prompt.commandIdentifiers), new Set(action.commandSegments.map(segment => segment.identifier)))))
      throw new Error('Copilot commands approval does not match the shell action.');
    if (prompt.kind === 'path' && (prompt.accessKind !== 'shell' || !strings(prompt.paths)
      || !prompt.paths.length || !prompt.paths.every(path => pathText(path) && action.possiblePaths?.includes(path))))
      throw new Error('Copilot path approval does not match the shell action.');
    if (!['commands', 'path'].includes(prompt.kind)) throw new Error('Unsupported Copilot shell approval category.');
  } else {
    const fields = { read: ['path', 'resolvedPath'], write: ['fileName', 'resolvedPath', 'diff', 'fileEdits', 'newFileContents'],
      url: ['url', 'redirectedFrom'], mcp: ['serverName', 'toolName', 'args'], 'custom-tool': ['toolName', 'args'] }[action.kind];
    if (prompt.kind !== action.kind || !Array.isArray(fields) || !copilotId(action[fields[0]])
      || fields.some(key => !isDeepStrictEqual(action[key], prompt[key])))
      throw new Error('Unsupported or mismatched Copilot permission category.');
  }
  return { id: requestId, method: COPILOT_REQUEST, params: {
    threadId: sessionId, turnId, itemId: action.toolCallId, cwd, category: prompt.kind,
    action: structuredClone(action), prompt: structuredClone(prompt), availableDecisions: ['approve-once', 'reject'],
  } };
}

export function copilotDecision(answer) {
  if (!record(answer) || Object.keys(answer).length !== 1 || !['approve-once', 'reject'].includes(answer.kind))
    throw new Error('Choose Approve once or Reject for this Copilot request.');
  return { kind: answer.kind };
}

export function createCopilotDecoder({ sessionId, cwd }) {
  const events = [], turns = [], messages = [], replayEvents = [], tools = new Map(), shells = new Map(), ids = new Set(), usage = [];
  let current = null, idle = null, error = null, lastUsage = null, finalTurn = null;
  function consume(event) {
    if (event?.agentId || event?.data?.agentId || event?.checkpoint === true || event?.data?.checkpoint === true) return;
    const data = event?.data;
    if (!copilotId(event?.id) || ids.has(event.id) || !record(data) || typeof event.type !== 'string'
      || event.sessionId != null && event.sessionId !== sessionId || data.sessionId != null && data.sessionId !== sessionId)
      throw new Error('Unexpected Copilot event identity.');
    if (ids.size >= 20000) throw new Error('Copilot event limit.');
    ids.add(event.id);
    const at = Number.isFinite(Date.parse(event.timestamp)) ? new Date(event.timestamp).toISOString() : null;
    const base = { kind: event.type, itemId: event.id, agentId: sessionId, turnId: copilotId(data.turnId) ? data.turnId : null, recordedAt: at };
    const replay = (kind, label, fields = {}) => replayEvents.push({
      id: event.id, turnId: base.turnId, at, kind, label, ...fields,
    });
    switch (event.type) {
      case 'assistant.turn_start':
        if (idle || current || !copilotId(data.turnId) || turns.some(turn => turn.turnId === data.turnId)) throw new Error('Unexpected Copilot turn start.');
        current = { agentId: sessionId, turnId: data.turnId, status: 'in-progress', observedStartedAt: at };
        turns.push(current);
        events.push(base);
        replay('turn', 'Copilot turn started', { status: 'started', text: JSON.stringify({ nativeTurnId: data.turnId }) });
        lastUsage = null;
        return { turnId: current.turnId };
      case 'assistant.turn_end':
        if (!current || current.turnId !== data.turnId) throw new Error('Unmatched Copilot turn end.');
        Object.assign(current, { status: 'completed', observedCompletedAt: at });
        finalTurn = current.turnId;
        events.push(base);
        replay('turn', 'Copilot turn completed', { status: 'completed', text: JSON.stringify({ nativeTurnId: data.turnId }) });
        current = null;
        break;
      case 'user.message':
        if (typeof data.content === 'string') replay('message', 'User message', { text: data.content, role: 'user' });
        break;
      case 'assistant.message':
        if (!current || data.turnId !== current.turnId) throw new Error('Unmatched Copilot assistant message.');
        events.push(base);
        if (typeof data.content === 'string') replay('message', data.phase === 'final_answer' ? 'Assistant final answer' : 'Assistant message',
          { text: data.content, role: 'assistant' });
        if (!current.model && copilotId(data.model) && data.model !== 'auto') current.model = data.model;
        if (typeof data.content === 'string' && (data.phase === 'final_answer'
          || data.phase == null && Array.isArray(data.toolRequests) && data.toolRequests.length === 0))
          messages.push({ id: event.id, turnId: current.turnId, text: data.content, phase: data.phase ?? null, model: copilotId(data.model) ? data.model : null });
        break;
      case 'assistant.usage':
        if (!current) break;
        lastUsage = { model: [data.responseModel, data.model].find(value => copilotId(value) && value !== 'auto') ?? null,
          reasoningEffort: copilotId(data.reasoningEffort) ? data.reasoningEffort : null, auto: typeof data.isAuto === 'boolean' ? data.isAuto : null };
        if (lastUsage.model !== null) current.model = lastUsage.model;
        if (lastUsage.reasoningEffort !== null) current.reasoningEffort = lastUsage.reasoningEffort;
        usage.push({ source: event.type, nativeEventId: event.id, agentId: sessionId, turnId: current.turnId, ...lastUsage,
          inputTokens: Number.isSafeInteger(data.inputTokens) && data.inputTokens >= 0 ? data.inputTokens : null,
          outputTokens: Number.isSafeInteger(data.outputTokens) && data.outputTokens >= 0 ? data.outputTokens : null });
        break;
      case 'tool.execution_start': {
        if (!current || data.turnId !== current.turnId || !copilotId(data.toolCallId) || tools.has(data.toolCallId)
          || !copilotId(data.toolName)) throw new Error('Unmatched Copilot tool start.');
        const tool = { name: data.toolName, turnId: data.turnId, startedAt: at, endedAt: null, completed: false, success: null, shell: null };
        if (tool.name === 'read_bash') {
          tool.shell = shells.get(data.arguments?.shellId) ?? null;
          if (!tool.shell || tool.shell.exitCode !== null || tool.shell.readPending)
            throw new Error('Unowned or overlapping Copilot shell read.');
          tool.shell.readPending = true;
        }
        tools.set(data.toolCallId, tool);
        events.push({ ...base, toolName: tool.name, nativeToolCallId: data.toolCallId });
        replay('tool-call', tool.name, { callId: data.toolCallId, status: 'started', phase: 'started',
          ...(tool.name === 'bash' && typeof data.arguments?.command === 'string'
            ? { text: JSON.stringify({ command: data.arguments.command }) } : {}) });
        break;
      }
      case 'tool.execution_complete': {
        const tool = tools.get(data.toolCallId);
        if (!tool || tool.completed || data.turnId !== tool.turnId) throw new Error('Unmatched Copilot tool result.');
        tool.completed = true;
        tool.endedAt = at;
        tool.success = typeof data.success === 'boolean' ? data.success : null;
        if (tool.shell) tool.shell.readPending = false;
        const shellId = data.result?.structuredContent?.shellId;
        if (tool.name === 'bash' && data.success === true && copilotId(shellId)) {
          if (shells.has(shellId)) throw new Error('Duplicate Copilot shell identity.');
          tool.shell = { id: shellId, exitCode: null, readPending: false };
          shells.set(shellId, tool.shell);
        }
        const exits = Array.isArray(data.result?.contents) ? data.result.contents.filter(value => value?.type === 'shell_exit') : [];
        if (exits.length) {
          const [exit] = exits;
          if (exits.length !== 1 || !tool.shell || shellId !== tool.shell.id || exit.shellId !== tool.shell.id
            || exit.cwd !== cwd || !Number.isSafeInteger(exit.exitCode) || data.success !== true)
            throw new Error('Unverified Copilot shell exit.');
          tool.shell.exitCode = exit.exitCode;
          tool.shell.endedAt = at;
        }
        replay('tool-result', tool.name, { callId: data.toolCallId, status: data.success === true ? 'completed' : data.success === false ? 'failed' : 'unknown', phase: 'completed',
          text: JSON.stringify({ functionSucceeded: typeof data.success === 'boolean' ? data.success : null,
            ...(tool.shell ? { shellId: tool.shell.id, exitCode: tool.shell.exitCode } : {}) }) });
        events.push({ ...base, toolName: tool.name, nativeToolCallId: data.toolCallId, functionSucceeded: typeof data.success === 'boolean' ? data.success : null,
          shell: tool.shell ? { id: tool.shell.id, exitCode: tool.shell.exitCode, state: tool.shell.exitCode === null ? 'yielded' : 'exited' } : null });
        break;
      }
      case 'permission.requested':
        if (!data.resolvedByHook) return { request: copilotPermission(event, sessionId, current?.turnId, cwd) };
        break;
      case 'user_input.requested':
      case 'elicitation.requested':
      case 'exit_plan_mode.requested':
      case 'auto_mode_switch.requested':
        throw new Error(`Unsupported Copilot interaction: ${event.type}.`);
      case 'session.error':
        error = copilotId(data.errorType) ? data.errorType : 'native-error';
        return { failed: error };
      case 'session.idle':
        if (idle) throw new Error('Duplicate Copilot idle event.');
        idle = { id: event.id, at, aborted: Object.hasOwn(data, 'aborted') ? data.aborted : null,
          normal: !Object.hasOwn(data, 'aborted') || data.aborted === false };
        events.push(base);
        replay('session', 'Copilot root idle', { status: 'unknown', text: JSON.stringify({ aborted: idle.aborted,
          abortedFieldPresent: Object.hasOwn(data, 'aborted') }) });
        return { idle };
    }
  }

  function snapshot() {
    const last = messages.filter(message => message.turnId === finalTurn);
    const complete = !!(idle?.normal && !error && finalTurn && !current && last.some(item => item.text.trim()));
    const invocations = [...tools].map(([itemId, tool]) => {
      const command = tool.name === 'bash', exitCode = command ? tool.shell?.exitCode ?? null : null;
      const status = tool.success === false || exitCode !== null && exitCode !== 0 ? 'failed'
        : tool.completed && (!command || exitCode !== null) ? 'completed' : command && tool.shell ? 'yielded' : 'unknown';
      return { agentId: sessionId, itemId, turnId: tool.turnId, toolName: tool.name, kind: command ? 'command' : 'tool',
        status, exitCode, success: command ? exitCode !== null ? exitCode === 0 : tool.success === false ? false : null : tool.success,
        observedStartedAtMs: tool.startedAt ? Date.parse(tool.startedAt) : null,
        observedCompletedAtMs: tool.endedAt && (!command || exitCode !== null) ? Date.parse(tool.shell?.endedAt ?? tool.endedAt) : null,
        source: 'copilot-sdk:tool.execution_start/tool.execution_complete' };
    });
    return { events, turns, usage, invocations,
      replayEvents: replayEvents.map(row => row.id === idle?.id ? { ...row, status: complete ? 'completed' : idle.aborted === true ? 'cancelled' : 'unknown' } : row),
      idle, complete, turnId: current?.turnId ?? finalTurn,
      observed: last.length ? { source: 'assistant.message/assistant.usage', model: [lastUsage?.model, last.at(-1).model].find(value => value && value !== 'auto') ?? null,
        reasoningEffort: lastUsage?.reasoningEffort ?? null, route: lastUsage?.auto === true ? 'auto' : null } : null,
      response: { status: complete ? 'complete' : 'partial', threadId: sessionId, turnId: finalTurn, source: 'copilot-sdk:assistant.message',
        items: last, text: last.length ? last.map(item => item.text).join('\n\n') : null },
      toolsComplete: [...tools.values()].every(tool => tool.completed) && [...shells.values()].every(shell => shell.exitCode !== null),
    };
  }
  return { consume, snapshot };
}
