import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSessionReplay, projectSessionReplay } from '../src/audit-session-replay.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

const sessionA = '00000000-0000-4000-8000-000000000001';
const sessionB = '00000000-0000-4000-8000-000000000002';
const turnA = '10000000-0000-4000-8000-000000000001';
const turnB = '10000000-0000-4000-8000-000000000002';
const call = 'call-1';
const fingerprint = 'a'.repeat(64);
const row = (sourceLine, type, payload, timestamp = '2026-10-28T12:00:00.000Z') => ({ sourceLine,
  record: { type, timestamp, payload } });
const msg = (role, text, turnId = turnA) => ({ type: 'message', role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], turn_id: turnId });

test('replay pairs tool results with their exact call and keeps source lines', () => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(4, 'response_item', { type: 'custom_tool_call', name: 'exec_command', input: 'npm test', call_id: call, turn_id: turnA }),
    row(9, 'response_item', { type: 'custom_tool_call_output', output: 'passed', call_id: call, turn_id: turnA }),
  ] }]);
  const [toolCall, result] = replay.sessions[0].events;
  assert.equal(replay.kind, 'session-replay');
  assert.equal(toolCall.id, `${sessionA}:${fingerprint}:4`);
  assert.equal(toolCall.relatedEventId, result.id);
  assert.equal(result.relatedEventId, toolCall.id);
  assert.equal(result.body, 'passed');
});

test('typed and legacy MCP calls retain arguments and structured results', () => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(1, 'event_msg', { type: 'item_started', turn_id: turnA, item: { id: 'typed', type: 'mcpToolCall', server: 'docs', tool: 'read', arguments: { page: 'example' } } }),
    row(2, 'event_msg', { type: 'item_completed', turn_id: turnA, item: { id: 'typed', type: 'mcpToolCall', server: 'docs', tool: 'read', result: { structuredContent: { answer: 42 }, isError: true } } }),
    row(3, 'event_msg', { type: 'mcp_tool_call_begin', turn_id: turnA, call_id: 'legacy', invocation: { server: 'docs', tool: 'read', arguments: { page: 'legacy' } } }),
  ] }]);
  const [call, result, legacy] = normalizeSessionReplay(replay).sessions[0].events;
  assert.deepEqual(JSON.parse(call.body).arguments, { page: 'example' });
  assert.deepEqual(JSON.parse(result.body).structuredContent, { answer: 42 });
  assert.equal(result.status, 'error');
  assert.equal(call.relatedEventId, result.id);
  assert.deepEqual(JSON.parse(legacy.body).arguments, { page: 'legacy' });
});

test('replay preserves nested parallel session ownership and unavailable branches', () => {
  const replay = projectSessionReplay([
    { id: sessionA, sourceFingerprint: fingerprint, records: [row(1, 'response_item', msg('user', 'Do the task'))] },
    { id: sessionB, parentId: sessionA, depth: 1, sourceFingerprint: 'b'.repeat(64), records: [row(3, 'response_item', msg('assistant', 'Child result', turnB))] },
    { id: '00000000-0000-4000-8000-000000000003', parentId: sessionA, depth: 1,
      status: 'unavailable', reason: 'History is unavailable.', records: [] },
  ]);
  assert.equal(replay.sessions[1].parentId, sessionA);
  assert.equal(replay.sessions[1].events[0].sessionId, sessionB);
  assert.equal(replay.sessions[2].status, 'unavailable');
  assert.equal(replay.sessions[2].events.length, 0);
});

test('replay marks missing timestamps and bounds retained bodies', () => {
  const records = [row(1, 'response_item', msg('user', 'x'.repeat(1024 * 1024 + 30)), null)];
  for (let line = 2; line <= 17; line++) records.push(row(line, 'response_item', msg('assistant', 'y'.repeat(1024 * 1024), turnA)));
  records.push(row(18, 'response_item', msg('assistant', 'last', turnA)));
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records }]);
  const [large, ...rest] = replay.sessions[0].events;
  assert.equal(large.bodyStatus, 'truncated');
  assert.equal(large.bodyReason, 'event-body-limit');
  assert.equal(Buffer.byteLength(large.body), 1024 * 1024);
  assert.equal(large.timestamp, null);
  assert.equal(rest.at(-1).bodyStatus, 'omitted');
  assert.equal(rest.at(-1).bodyReason, 'total-body-limit');
  assert.ok(replay.sessions[0].limits.some(limit => limit.kind === 'missing-timestamps'));
  assert.ok(replay.sessions[0].limits.some(limit => limit.kind === 'body-size-limit'));
});

test('replay omits private reasoning and validates links before source-free reopen', () => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(1, 'response_item', { type: 'message', role: 'assistant', phase: 'analysis',
      content: [{ type: 'output_text', text: 'private reasoning' }], turn_id: turnA }),
  ] }]);
  assert.equal(replay.sessions[0].events.length, 0);
  assert.deepEqual(normalizeSessionReplay(replay), replay);
  const broken = structuredClone(replay);
  broken.sessions[0].events.push({ id: `${sessionA}:${fingerprint}:2`, sessionId: sessionA, turnId: turnA,
    kind: 'tool-result', label: 'Tool result', timestamp: null, sourceLine: 2,
    body: null, bodyStatus: 'unavailable', relatedEventId: 'missing' });
  assert.throws(() => normalizeSessionReplay(broken), /link is missing/);
  const leaked = structuredClone(replay);
  leaked.sessions[0].privateSourceBody = 'secret';
  assert.throws(() => normalizeSessionReplay(leaked), /unsupported fields/);
});

test('replay keeps lifecycle phases distinct and refuses ambiguous call links', () => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(1, 'event_msg', { type: 'item_started', turn_id: turnA, started_at_ms: 22,
      item: { type: 'CommandExecution', id: 'cmd-1', command: 'run' } }, null),
    row(2, 'event_msg', { type: 'item_completed', turn_id: turnA, completed_at_ms: 33,
      item: { type: 'CommandExecution', id: 'cmd-1', command: 'run', aggregated_output: 'done', exit_code: 0, status: 'completed' } }, null),
    row(3, 'response_item', { type: 'custom_tool_call', name: 'first', input: '{}', call_id: 'repeat', turn_id: turnA }),
    row(4, 'response_item', { type: 'custom_tool_call', name: 'second', input: '{}', call_id: 'repeat', turn_id: turnA }),
    row(5, 'response_item', { type: 'custom_tool_call_output', output: 'result', call_id: 'repeat', turn_id: turnA }),
    row(6, 'event_msg', { type: 'item_started', turn_id: turnB, item: { type: 'CommandExecution', id: 'cmd-1', command: 'other run' } }),
    row(7, 'event_msg', { type: 'item_completed', turn_id: turnB, item: { type: 'CommandExecution', id: 'cmd-1', command: 'other run' } }),
  ] }]);
  const events = replay.sessions[0].events;
  const command = events.filter(event => event.itemId === 'cmd-1' && event.turnId === turnA);
  assert.equal(command.length, 2);
  assert.equal(command[0].phase, 'started');
  assert.equal(command[1].phase, 'completed');
  assert.equal(command[0].timestamp, null);
  assert.equal(command[0].relatedEventId, command[1].id);
  const otherTurnCommand = events.filter(event => event.itemId === 'cmd-1' && event.turnId === turnB);
  assert.equal(otherTurnCommand.length, 2);
  assert.equal(otherTurnCommand[0].relatedEventId, otherTurnCommand[1].id);
  assert.equal(events.filter(event => event.callId === 'repeat').every(event => event.relatedEventId === undefined), true);
  assert.equal(events.filter(event => event.callId === 'repeat').every(event => event.linkStatus === 'ambiguous'), true);
});

test('replay records delegation identity without inventing children', () => {
  const replay = projectSessionReplay([
    { id: sessionA, sourceFingerprint: fingerprint, records: [row(1, 'event_msg', { type: 'item_completed', turn_id: turnA,
      thread_id: sessionA, item: { type: 'CollabAgentToolCall', id: 'delegate', receiverThreadIds: [sessionB], threadId: sessionA } })] },
    { id: sessionB, parentId: sessionA, depth: 1, sourceFingerprint: 'b'.repeat(64), records: [] },
  ]);
  const event = replay.sessions[0].events[0];
  assert.equal(event.kind, 'delegation');
  assert.deepEqual(event.childSessionIds, [sessionB]);
  assert.equal(event.parentSessionId, sessionA);
});

test('native SubAgentActivity links only to corroborated children and retains activity phases', () => {
  const child1 = sessionB, child2 = '00000000-0000-4000-8000-000000000003';
  const replay = projectSessionReplay([
    { id: sessionA, sourceFingerprint: fingerprint, records: [
      row(1, 'event_msg', { type: 'item_completed', thread_id: sessionA,
        item: { type: 'SubAgentActivity', id: 'call-start', kind: 'started', agent_thread_id: child1,
          agent_path: '/root/worker', model: 'gpt-test', reasoning_effort: 'medium' } }),
      row(2, 'event_msg', { type: 'item_completed', thread_id: sessionA,
        item: { type: 'SubAgentActivity', id: 'call-return', kind: 'completed', agent_thread_id: child1 } }),
      row(3, 'event_msg', { type: 'item_completed', thread_id: sessionA,
        item: { type: 'SubAgentActivity', id: 'missing-child', kind: 'started', agent_thread_id: child2 } }),
      row(4, 'event_msg', { type: 'item_completed', thread_id: sessionA,
        item: { type: 'SubAgentActivity', id: 'invalid-child', kind: 'started', agent_thread_id: '/tmp/not-a-uuid' } }),
    ] },
    { id: child1, parentId: sessionA, depth: 1, sourceFingerprint: 'b'.repeat(64), records: [
      row(1, 'response_item', msg('assistant', 'Worker result', turnB)),
    ] },
  ]);
  const events = replay.sessions[0].events;
  assert.deepEqual(events[0].childSessionIds, [child1]);
  assert.equal(events[0].parentSessionId, sessionA);
  assert.equal(events[0].phase, 'started');
  assert.equal(events[0].label, 'Delegated agent started');
  assert.equal(events[1].phase, 'completed');
  assert.equal(events[0].kind, 'delegation');
  assert.deepEqual(JSON.parse(events[0].body), { model: 'gpt-test', reasoningEffort: 'medium' });
  assert.equal(events[2].childSessionIds, undefined);
  assert.equal(events[2].linkStatus, 'child-session-unavailable');
  assert.equal(events.length, 3);
});

test('native agent updates keep exposed text while excluding opaque encrypted blocks', () => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(1, 'response_item', { type: 'agent_message', id: 'agent-message', author: '/root/worker', recipient: '/root',
      content: [{ type: 'input_text', text: 'Worker report is available.' },
        { type: 'encrypted_content', encrypted_content: 'opaque-sensitive-payload' }] }),
    row(2, 'inter_agent_communication_metadata', { trigger_turn: true, content: 'private internal metadata' }),
    row(3, 'response_item', { type: 'reasoning', content: [{ type: 'output_text', text: 'private reasoning' }] }),
  ] }]);
  const events = replay.sessions[0].events;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'message');
  assert.equal(events[0].label, 'Agent update');
  assert.equal(events[0].body, 'Worker report is available.');
  assert.equal(JSON.stringify(replay).includes('opaque-sensitive-payload'), false);
  assert.equal(JSON.stringify(replay).includes('private internal metadata'), false);
  assert.equal(events.some(event => event.body?.includes('private reasoning')), false);
});

test('tool content filters opaque and private blocks while preserving visible results and arguments through export', async t => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(1, 'event_msg', { type: 'item_completed', turn_id: turnA, item: {
      type: 'mcpToolCall', id: 'call-result', server: 'docs', tool: 'read',
      result: { structuredContent: { answer: 42, analysis: 'Public analysis result.', reasoning: 'Public tool result.',
        private_reasoning: 'private result reasoning' },
        content: [{ type: 'text', text: 'Visible tool result.' },
          { type: 'encrypted_content', encrypted_content: 'encrypted-result-blob' },
          { type: 'analysis', text: 'private analysis block' }] },
      content_items: [{ type: 'text', text: 'Visible content item.' },
        { type: 'encrypted_content', encrypted_content: 'encrypted-content-item' },
        { type: 'reasoning', text: 'private tool reasoning' }],
    } }),
    row(2, 'response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'call-args', turn_id: turnA,
      arguments: JSON.stringify({ task: 'Keep the authored task text.', analysis: 'Public analysis argument.',
        reasoning: 'Public reasoning field.', reasoning_effort: 'high', encrypted_content: 'encrypted-argument',
        private_reasoning: 'private argument reasoning' }) }),
    row(3, 'response_item', { type: 'function_call', name: 'tool', call_id: 'call-malformed', turn_id: turnA,
      arguments: '{"encrypted_content":"malformed-opaque-secret"' }),
    row(4, 'response_item', { type: 'function_call', name: 'tool', call_id: 'call-oversized', turn_id: turnA,
      arguments: `{"encrypted_content":"oversized-opaque-secret","padding":"${'x'.repeat(1024 * 1024)}"}` }),
  ] }]);
  const events = replay.sessions[0].events;
  assert.equal(events.length, 4);
  assert.equal(events[0].contentOmitted, true);
  assert.match(events[0].body, /Visible tool result/);
  assert.match(events[0].body, /Visible content item/);
  assert.match(events[0].body, /"answer":42/);
  assert.match(events[0].body, /Public analysis result/);
  assert.match(events[0].body, /Public tool result/);
  assert.equal(events[1].contentOmitted, true);
  assert.deepEqual(JSON.parse(events[1].body), { task: 'Keep the authored task text.', analysis: 'Public analysis argument.',
    reasoning: 'Public reasoning field.', reasoning_effort: 'high' });
  for (const hidden of ['encrypted-result-blob', 'encrypted-content-item', 'encrypted-argument',
    'private result reasoning', 'private analysis block', 'private tool reasoning', 'private argument reasoning',
    'malformed-opaque-secret', 'oversized-opaque-secret'])
    assert.equal(JSON.stringify(replay).includes(hidden), false, `${hidden} must be removed before persistence`);
  assert.equal(events[2].contentOmitted, true);
  assert.equal(events[2].body, null);
  assert.equal(events[3].contentOmitted, true);
  assert.equal(events[3].body, null);

  const directory = await mkdtemp(join(tmpdir(), 'xfx-native-content-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = { schemaVersion: 1, kind: 'audit-run', id: 'native-content-replay-fixture', status: 'complete', sessionReplay: replay };
  const receipt = await exportAuditReport(evidence, { output: join(directory, 'replay.json'), includeReplayContent: true });
  const reopened = await readAuditReport(receipt.evidencePath);
  const serialized = JSON.stringify(reopened);
  assert.match(serialized, /Visible tool result/);
  assert.match(serialized, /Keep the authored task text/);
  for (const hidden of ['encrypted-result-blob', 'encrypted-content-item', 'encrypted-argument',
    'private result reasoning', 'private analysis block', 'private tool reasoning', 'private argument reasoning',
    'malformed-opaque-secret', 'oversized-opaque-secret'])
    assert.equal(serialized.includes(hidden), false, `${hidden} must not survive export`);
  const markdown = await readFile(receipt.output, 'utf8');
  assert.match(markdown, /Visible content item/);
  assert.doesNotMatch(markdown, /encrypted-content-item|private tool reasoning/);
});

test('normalizing native child links does not merge ownership or invent missing children', () => {
  const projected = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(1, 'event_msg', { type: 'item_completed', thread_id: sessionA,
      item: { type: 'SubAgentActivity', id: 'call', kind: 'interacted', agent_thread_id: sessionB } }),
  ] }]);
  const [event] = normalizeSessionReplay(projected).sessions[0].events;
  assert.equal(event.childSessionIds, undefined);
  assert.equal(event.linkStatus, 'child-session-unavailable');
});

test('shared record budget omissions are explicit across nested sessions', () => {
  const root = Array.from({ length: 9000 }, (_, index) => row(index + 1, 'event_msg', { type: 'turn_started', turn_id: turnA }));
  const child = Array.from({ length: 5000 }, (_, index) => row(index + 1, 'event_msg', { type: 'turn_completed', turn_id: turnB }));
  const replay = projectSessionReplay([
    { id: sessionA, sourceFingerprint: fingerprint, records: root },
    { id: sessionB, parentId: sessionA, depth: 1, sourceFingerprint: 'b'.repeat(64), records: child },
  ]);
  assert.equal(replay.sessions[0].events.length, 9000);
  assert.equal(replay.sessions[1].events.length, 1000);
  assert.deepEqual(replay.sessions[1].limits.find(limit => limit.kind === 'replay-total-record-limit').omitted, 4000);
});

test('legacy MCP result error envelopes keep their failure status', () => {
  const results = [
    { Err: 'failed' },
    { Ok: { isError: true } },
    { ok: { is_error: true } },
    { ok: { isError: true } },
    { Ok: { is_error: true } },
  ];
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: results.map((result, index) =>
    row(index + 1, 'event_msg', { type: 'mcp_tool_call_end', turn_id: turnA, call_id: `legacy-${index}`, result })) }]);
  assert.deepEqual(replay.sessions[0].events.map(event => event.status), results.map(() => 'error'));
});
