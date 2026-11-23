// Synthetic CLI for the pinned SDK stdio contract. No network or other clients.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const retained = /* CLAUDE_SANITIZED_NATIVE_FRAMES */ null;
const argv = process.argv.slice(2);
const arg = name => argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const session_id = arg('--session-id');
const model = arg('--model') ?? 'sonnet';
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
const frame = message => emit({ session_id, uuid: randomUUID(), ...message });
const account = existsSync(join(process.env.HOME, 'fixture-signed-out')) ? {} :
  { apiProvider: 'firstParty', subscriptionType: 'Claude Pro', tokenSource: 'claude.ai', email: 'private-fixture@example.test' };
const models = [{ value: 'sonnet', resolvedModel: 'claude-fixture-sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low'] },
  { value: 'haiku', displayName: 'Haiku' }, { value: 'unsupported', displayName: 'Unsupported', supportsEffort: false }];
const response = (id, value) => emit({ type: 'control_response', response: { subtype: 'success', request_id: id, response: value } });
const io = createInterface({ input: process.stdin });
if (['fixture-native-bookkeeping', 'fixture-native-trust-change'].some(name => existsSync(join(process.env.HOME, name)))) {
  const accepted = existsSync(join(process.env.HOME, 'fixture-native-trust-change'));
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME, '.claude.json'),
    JSON.stringify({ numStartups: 2, projects: { [process.cwd()]: { hasTrustDialogAccepted: accepted } } }), { mode: 0o600 });
}

if (existsSync(join(process.env.HOME, 'fixture-session-hook'))) {
  const hook = { hook_id: randomUUID(), hook_name: 'SessionStart:startup', hook_event: 'SessionStart' };
  frame({ type: 'system', subtype: 'hook_started', ...hook });
  frame({ type: 'system', subtype: 'hook_response', ...hook, stdout: '', stderr: '', output: 'fixture hook output', exit_code: 0, outcome: 'success' });
  frame({ type: 'system', subtype: 'commands_changed', commands: [] });
  frame({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
  frame({ type: 'system', subtype: 'plugin_install', status: 'completed' });
}
if (existsSync(join(process.env.HOME, 'fixture-early-assistant')))
  frame({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'early' }] } });
if (existsSync(join(process.env.HOME, 'fixture-foreign-hook')))
  emit({ type: 'system', subtype: 'hook_started', hook_id: randomUUID(), hook_name: 'SessionStart:startup',
    hook_event: 'SessionStart', uuid: randomUUID(), session_id: randomUUID() });
for (const [marker, value] of [
  ['fixture-unknown-startup', { subtype: 'future_task_activity' }],
  ['fixture-startup-invalid-mode', { subtype: 'status', status: null, permissionMode: 'not-a-mode' }],
  ['fixture-startup-requesting', { subtype: 'status', status: 'requesting' }],
  ['fixture-malformed-commands', { subtype: 'commands_changed', commands: 'not-an-array' }],
  ['fixture-startup-init', { subtype: 'init', cwd: process.cwd(), apiKeySource: 'none' }],
  ['fixture-startup-task', { subtype: 'task_started', task_id: 'unexpected-task' }],
  ['fixture-malformed-hook', { subtype: 'hook_started' }],
]) if (existsSync(join(process.env.HOME, marker))) frame({ type: 'system', ...value });
let promptId, mode, tools = [], decisions = new Set(), checkedPermissionMode;
const comparisonPermission = () => ['fixture-comparison-approval', 'fixture-reject-approval-mode']
  .some(marker => existsSync(join(process.env.HOME, marker)));
const result = (error = false) => frame({ ...retained[error ? 'interrupt' : 'companion'].at(-1),
  user_message_uuid: promptId, duration_ms: 100,
  ...(mode === 'closing-response' ? { result: 'Claude fixture final response.' } : {}),
  ...(mode === 'late-turn' ? { turn_id: 'opaque-turn-fixture' } : {}),
  ...(mode?.includes('usage') ? { usage: { input_tokens: 11, output_tokens: 3 } } : {}) });
const toolResult = (tool, error, content) => frame({ type: 'user', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, is_error: error, content }] } });
const finishClosure = () => {
  if (mode.endsWith('-after-progress')) frame({ type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'known-closure-tool', name: 'Bash', input: { command: '/bin/sleep 60' } }] } });
  frame({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fixture-sonnet',
    content: [{ type: 'text', text: 'Claude closure fixture completed.' }] } });
  const terminal = { type: 'result', subtype: 'success', is_error: mode.endsWith('-error'),
    result: 'Claude closure fixture completed.',
    ...(!mode.includes('no-echo') && mode !== 'closure-no-result-echo' ? { user_message_uuid: promptId } : {}) };
  frame(terminal);
  if (mode === 'closure-no-receipt-no-echo') return;
  const receipt = { type: 'command_lifecycle', command_uuid: mode === 'closure-wrong-command' ? randomUUID() : promptId,
    state: mode === 'closure-wrong-state' ? 'cancelled' : 'completed',
    ...(mode === 'closure-wrong-session' ? { session_id: randomUUID() } : {}),
    ...(mode === 'closure-extra' ? { payload: {} } : {}), ...(mode === 'closure-bad-uuid' ? { uuid: 'not-a-uuid' } : {}),
    ...(mode === 'closure-missing-uuid' ? { uuid: undefined } : {}) };
  const idle = mode.startsWith('closure-idle') || mode === 'closure-controller-idle' ? {
    type: 'system', subtype: 'session_state_changed', state: mode === 'closure-idle-running' ? 'running'
      : mode === 'closure-idle-requires-action' ? 'requires_action' : 'idle', sdk_host_only: true,
    ...(mode === 'closure-idle-foreign' ? { session_id: randomUUID() } : {}),
    ...(mode === 'closure-idle-extra' ? { payload: {} } : {}),
    ...(mode === 'closure-idle-not-host' ? { sdk_host_only: false } : {}),
    ...(mode === 'closure-idle-missing-host' ? { sdk_host_only: undefined } : {}),
    ...(mode === 'closure-idle-bad-uuid' ? { uuid: 'not-a-uuid' } : {}),
    ...(mode === 'closure-idle-missing-uuid' ? { uuid: undefined } : {}) } : null;
  if (mode === 'closure-idle-before-closure') frame(idle);
  if (mode !== 'closure-idle-no-closure') frame(receipt);
  if (idle && mode !== 'closure-idle-before-closure') frame(idle);
  if (mode === 'closure-idle-duplicate') frame(idle);
  if (mode === 'closure-duplicate') frame(receipt);
  if (mode.endsWith('-after-assistant')) frame({ type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: 'Unexpected later work.' }] } });
  if (mode.endsWith('-after-tool')) frame({ type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'later-tool', name: 'Bash', input: { command: '/bin/sleep 60' } }] } });
  if (mode.endsWith('-after-progress')) frame({ type: 'tool_progress', tool_use_id: 'known-closure-tool',
    tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 1 });
  if (mode.endsWith('-after-result')) frame(terminal);
  if (mode.endsWith('-after-unknown')) frame({ type: 'system', subtype: 'future_task_activity' });
};
for await (const line of io) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const kind = message.request.subtype;
    if (kind === 'initialize') response(message.request_id, { commands: [], agents: [], models, account,
      output_style: 'default', available_output_styles: ['default'], claude_code_version: '2.1.319' });
    else if (kind === 'set_permission_mode') {
      if (promptId || checkedPermissionMode || message.request.mode !== arg('--permission-mode')) throw new Error('Unexpected permission mode control');
      if (existsSync(join(process.env.HOME, 'fixture-reject-approval-mode'))) {
        emit({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Native policy refused the mode' } });
        continue;
      }
      checkedPermissionMode = message.request.mode;
      response(message.request_id, {});
    }
    else if (kind === 'interrupt') {
      response(message.request_id, {});
      if (mode === 'running-cancel') toolResult(tools[0], retained.interrupt[1].is_error, retained.interrupt[1].content);
      result(true);
    } else throw new Error('Unexpected control request ' + kind);
  } else if (message.type === 'user') {
    if (promptId || !session_id) throw new Error('Duplicate or unbound prompt');
    promptId = message.uuid; mode = message.message.content;
    if ((comparisonPermission() || checkedPermissionMode) && (!checkedPermissionMode
      || (checkedPermissionMode === 'dontAsk') !== (arg('--permission-prompts') === 'none')))
      throw new Error('Prompt arrived without the reviewed approval behavior');
    if (mode.includes('Frozen report: ')) {
      for (const kind of ['report', 'evidence']) {
        const path = mode.match(new RegExp('^Frozen ' + kind + ': (.+)$', 'm'))?.[1];
        if (!path || !readFileSync(path, 'utf8').trim()) throw new Error('Frozen review input missing');
      }
    }
    if (mode.startsWith('closure-')) {
      const states = mode === 'closure-reversed' ? ['started', 'queued']
        : mode === 'closure-duplicate-queued' ? ['queued', 'queued', 'started'] : ['queued', 'started'];
      for (const state of states) {
        if (mode === 'closure-missing-' + state) continue;
        frame({ type: 'command_lifecycle', command_uuid: promptId, state,
          ...(mode === 'closure-sequence-extra' && state === 'queued' ? { extra: true } : {}) });
      }
    }
    if (mode.startsWith('captured-')) {
      frame({ type: 'system', subtype: 'session_state_changed', state: 'running', sdk_host_only: true });
      for (const state of ['queued', 'started']) frame({ type: 'command_lifecycle', command_uuid: promptId, state });
    }
    frame({ ...retained.companion[0], cwd: process.cwd(), apiKeySource: 'none', model, permissionMode: arg('--permission-mode') ?? 'default' });
    if (mode.startsWith('native-replay')) {
      const cwd = process.cwd(), nativeHome = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, '.claude');
      const project = join(nativeHome, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
      const nativeRow = (role, content, second, uuid = randomUUID()) => ({
        type: role, cwd, sessionId: session_id, uuid, timestamp: `2026-11-21T11:00:0${second}.000Z`,
        message: { role, content },
      });
      const tool = { type: 'tool_use', id: 'tool-fixture-native', name: 'Read', input: { file_path: 'fixture.txt',
        private_reasoning: 'opaque nested value' } };
      const toolOutput = { type: 'tool_result', tool_use_id: tool.id, is_error: false, content: [
        { type: 'text', text: 'fixture output' }, { type: 'image', source: 'opaque image value' },
      ] };
      const final = { type: 'text', text: 'Claude fixture completed.' };
      const rows = [
        nativeRow('user', mode.endsWith('-unbound') ? 'foreign prompt' : mode, 0, promptId),
        nativeRow('assistant', [{ type: 'thinking', thinking: 'opaque private value' }], 1),
        nativeRow('assistant', [tool], 2),
        nativeRow('user', [toolOutput], 3),
        nativeRow('assistant', [final], 4),
      ];
      if (mode.endsWith('-open-call')) rows.splice(3, 1);
      if (mode.endsWith('-no-time')) delete rows.at(-1).timestamp;
      mkdirSync(project, { recursive: true, mode: 0o700 });
      writeFileSync(join(project, session_id + '.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      for (const row of rows.slice(2)) frame({ type: row.type, uuid: row.uuid, parent_tool_use_id: null,
        message: { ...row.message, ...(row.type === 'assistant' ? { model: 'claude-fixture-sonnet' } : {}) } });
      result();
      continue;
    }
    if (mode.startsWith('closure-')) {
      if (['closure-controller', 'closure-controller-idle'].includes(mode)) {
        tools = [{ type: 'tool_use', id: 'tool-fixture-0', name: 'Bash', input: { command: '/usr/bin/touch xfx-local-marker.txt' } }];
        frame({ type: 'assistant', parent_tool_use_id: null, message: { content: tools } });
        emit({ type: 'control_request', request_id: 'request-fixture-0', request: { subtype: 'can_use_tool',
          tool_name: 'Bash', tool_use_id: tools[0].id, input: tools[0].input } });
      } else finishClosure();
      continue;
    }
    if (mode.startsWith('captured-')) {
      const failed = mode !== 'captured-success-work';
      if (failed) frame({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: false } });
      frame({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: promptId,
        ...(failed ? { error: 'rate_limit', is_api_error_message: true, api_error_status: 429, api_error_origin: 'first_party', api_error: 'Fixture rate limit.' } : {}),
        message: { role: 'assistant', model: failed ? '<synthetic>' : 'claude-fixture-sonnet', stop_reason: 'stop_sequence',
          content: [{ type: 'text', text: failed ? 'Fixture rate limit.' : 'Fixture completion.' }] } });
      const terminal = { type: 'result', subtype: 'success', is_error: failed, user_message_uuid: promptId,
        result: failed ? 'Fixture rate limit.' : 'Fixture completion.', stop_reason: 'stop_sequence',
        terminal_reason: failed ? 'api_error' : 'end_turn', queued_turn_count: 0, result_index: 0,
        ...(failed ? { api_error_status: 429, api_error_origin: 'first_party', api_error: 'Fixture rate limit.' } : {}) };
      frame(terminal);
      if (mode.endsWith('-work')) frame({ type: 'assistant', parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Unexpected later work.' }] } });
      else if (mode.endsWith('-repeat-result')) frame(terminal);
      else if (!mode.endsWith('-no-trailing')) frame({ type: 'command_lifecycle', command_uuid: promptId, state: 'cancelled',
        ...(mode.endsWith('-foreign') ? { session_id: randomUUID() } : {}) });
      continue;
    }
    if (!['queue', 'pending-cancel', 'running-cancel', 'mismatch', 'session-allow', 'session-suppressed', 'session-wide'].includes(mode)) {
      frame({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fixture-sonnet',
        content: [{ type: 'text', text: mode === 'closing-response' ? 'Claude fixture progress.' : 'Claude fixture completed.' }] } });
      result();
      continue;
    }
    tools = Array.from({ length: mode === 'queue' ? 2 : 1 }, (_, i) =>
      ({ type: 'tool_use', id: 'tool-fixture-' + i, name: 'Bash', input: { command: 'printf fixture-' + i } }));
    frame({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fixture-sonnet', content: tools } });
    for (const [index, tool] of tools.entries()) emit({ type: 'control_request', request_id: 'request-fixture-' + index,
      request: { subtype: 'can_use_tool', tool_name: tool.name, input: mode === 'mismatch' ? { command: 'printf changed' } : tool.input,
        ...(mode.startsWith('session-') ? { permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings',
          rules: [{ toolName: tool.name, ruleContent: mode === 'session-wide' ? '*' : tool.input.command }] }],
        ...(mode === 'session-suppressed' ? { suppress_always_allow_rule: true } : {}) } : {}),
        tool_use_id: tool.id } });
  } else if (message.type === 'control_response') {
    const reply = message.response;
    const index = Number(reply.request_id.split('-').at(-1));
    const tool = tools[index];
    if (!tool || decisions.has(index) || reply.subtype !== 'success' || reply.response.toolUseID !== tool.id)
      throw new Error('Invalid exact response');
    decisions.add(index);
    if (['closure-controller', 'closure-controller-idle'].includes(mode)) {
      if (reply.response.behavior !== 'allow' || reply.response.updatedInput?.command !== tool.input.command || reply.response.updatedPermissions)
        throw new Error('Unexpected closure fixture approval');
      writeFileSync(join(process.cwd(), 'xfx-local-marker.txt'), 'fixture marker\n');
      toolResult(tool, false, '');
      finishClosure();
      continue;
    }
    if (reply.response.behavior === 'allow') {
      if (mode === 'running-cancel') {
        const helper = spawn('/bin/sleep', ['10'], { detached: true, stdio: 'ignore' });
        helper.unref();
      }
      const expected = mode === 'session-allow' ? [{ type: 'addRules', behavior: 'allow', destination: 'session',
        rules: [{ toolName: tool.name, ruleContent: tool.input.command }] }] : undefined;
      if (reply.response.updatedInput?.command !== tool.input.command
        || JSON.stringify(reply.response.updatedPermissions) !== JSON.stringify(expected)) throw new Error('Widened approval');
      frame({ ...retained.companion[1], elapsed_time_seconds: 1 });
      frame({ type: 'tool_progress', parent_tool_use_id: null, tool_use_id: tool.id, tool_name: tool.name, elapsed_time_seconds: 1 });
      if (mode !== 'running-cancel') toolResult(tool, false, 'fixture output');
    } else toolResult(tool, true, 'Declined by user.');
    if (mode !== 'running-cancel' && decisions.size === tools.length) result();
  } else if (message.type !== 'keep_alive') throw new Error('Unexpected frame ' + message.type);
}
