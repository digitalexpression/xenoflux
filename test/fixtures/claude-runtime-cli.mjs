// Synthetic CLI for the pinned SDK stdio contract. No network or other clients.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
let promptId, mode, tools = [], decisions = new Set();
const result = (error = false) => frame({ ...retained[error ? 'interrupt' : 'companion'].at(-1),
  user_message_uuid: promptId, duration_ms: 100,
  ...(mode === 'closing-response' ? { result: 'Claude fixture final response.' } : {}),
  ...(mode === 'late-turn' ? { turn_id: 'opaque-turn-fixture' } : {}),
  ...(mode?.includes('usage') ? { usage: { input_tokens: 11, output_tokens: 3 } } : {}) });
const toolResult = (tool, error, content) => frame({ type: 'user', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, is_error: error, content }] } });
for await (const line of io) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const kind = message.request.subtype;
    if (kind === 'initialize') response(message.request_id, { commands: [], agents: [], models, account,
      output_style: 'default', available_output_styles: ['default'], claude_code_version: '2.1.319' });
    else if (kind === 'interrupt') {
      response(message.request_id, {});
      if (mode === 'running-cancel') toolResult(tools[0], retained.interrupt[1].is_error, retained.interrupt[1].content);
      result(true);
    } else throw new Error('Unexpected control request ' + kind);
  } else if (message.type === 'user') {
    if (promptId || !session_id) throw new Error('Duplicate or unbound prompt');
    promptId = message.uuid; mode = message.message.content;
    if (mode.includes('Frozen report: ')) {
      for (const kind of ['report', 'evidence']) {
        const path = mode.match(new RegExp('^Frozen ' + kind + ': (.+)$', 'm'))?.[1];
        if (!path || !readFileSync(path, 'utf8').trim()) throw new Error('Frozen review input missing');
      }
    }
    if (mode.startsWith('captured-')) {
      frame({ type: 'system', subtype: 'session_state_changed', state: 'running', sdk_host_only: true });
      for (const state of ['queued', 'started']) frame({ type: 'command_lifecycle', command_uuid: promptId, state });
    }
    frame({ ...retained.companion[0], cwd: process.cwd(), apiKeySource: 'none', model, permissionMode: arg('--permission-mode') ?? 'default' });
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
    if (!['queue', 'pending-cancel', 'running-cancel', 'mismatch'].includes(mode)) {
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
        tool_use_id: tool.id } });
  } else if (message.type === 'control_response') {
    const reply = message.response;
    const index = Number(reply.request_id.split('-').at(-1));
    const tool = tools[index];
    if (!tool || decisions.has(index) || reply.subtype !== 'success' || reply.response.toolUseID !== tool.id)
      throw new Error('Invalid exact response');
    decisions.add(index);
    if (reply.response.behavior === 'allow') {
      if (mode === 'running-cancel') {
        const helper = spawn('/bin/sleep', ['10'], { detached: true, stdio: 'ignore' });
        helper.unref();
      }
      if (reply.response.updatedInput?.command !== tool.input.command || reply.response.updatedPermissions) throw new Error('Widened approval');
      frame({ ...retained.companion[1], elapsed_time_seconds: 1 });
      frame({ type: 'tool_progress', parent_tool_use_id: null, tool_use_id: tool.id, tool_name: tool.name, elapsed_time_seconds: 1 });
      if (mode !== 'running-cancel') toolResult(tool, false, 'fixture output');
    } else toolResult(tool, true, 'Declined by user.');
    if (mode !== 'running-cancel' && decisions.size === tools.length) result();
  } else if (message.type !== 'keep_alive') throw new Error('Unexpected frame ' + message.type);
}
