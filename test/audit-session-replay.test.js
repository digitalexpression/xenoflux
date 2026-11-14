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

test('replay captures only the owned native session header workspace', () => {
  const childHeader = { id: sessionB, session_id: sessionA, parent_thread_id: sessionA,
    source: { subagent: { thread_spawn: { parent_thread_id: sessionA } } }, forked_from_id: sessionA,
    cwd: '/workspace/child' };
  const replay = projectSessionReplay([
    { id: sessionA, sourceFingerprint: fingerprint, records: [row(1, 'session_meta', { id: sessionA, cwd: '/workspace/root' })] },
    { id: sessionB, parentId: sessionA, depth: 1, sourceFingerprint: fingerprint,
      records: [row(1, 'session_meta', childHeader), row(2, 'session_meta', { id: sessionA, cwd: '/inherited/root' })] },
  ]);
  assert.deepEqual(replay.sessions.map(session => session.cwd), ['/workspace/root', '/workspace/child']);
  assert.deepEqual(normalizeSessionReplay(replay), replay);
  const rejectedHeaders = [
    { ...childHeader, id: sessionA },
    { ...childHeader, parent_thread_id: sessionB },
    { ...childHeader, source: { subagent: { thread_spawn: { parent_thread_id: sessionB } } } },
    { ...childHeader, forked_from_id: sessionB },
    { ...childHeader, session_id: 'invalid' },
    { ...childHeader, cwd: 'relative/workspace' },
    { ...childHeader, cwd: '/workspace/../other' },
    { ...childHeader, cwd: '/workspace\n/other' },
    { ...childHeader, cwd: '/workspace/' + 'x'.repeat(4096) },
    { ...childHeader, cwd: '/workspace/api_key=sk-abcdefghijklmnopqrstuv' },
    { ...childHeader, cwd: '/workspace/[REDACTED]' },
  ];
  for (const header of rejectedHeaders) {
    const candidate = projectSessionReplay([{ id: sessionB, parentId: sessionA, depth: 1,
      sourceFingerprint: fingerprint, records: [row(1, 'session_meta', header)] }]);
    assert.equal(Object.hasOwn(candidate.sessions[0], 'cwd'), false, JSON.stringify(header));
  }
  const lateHeader = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint,
    records: [row(1, 'response_item', msg('assistant', 'Recorded reply')),
      row(2, 'session_meta', { id: sessionA, cwd: '/forged/late-header' })] }]);
  assert.equal(Object.hasOwn(lateHeader.sessions[0], 'cwd'), false);
  const missing = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [] }]);
  assert.equal(Object.hasOwn(normalizeSessionReplay(missing).sessions[0], 'cwd'), false);
  for (const cwd of [null, '', 'relative', '/a/../b', '/a\0b', '/workspace/[REDACTED]', '/' + 'a'.repeat(4096)]) {
    const malformed = structuredClone(missing); malformed.sessions[0].cwd = cwd;
    assert.throws(() => normalizeSessionReplay(malformed), /invalid session/);
  }
});

test('replay retains offered tool names without treating a catalog as tool use', () => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(3, 'response_item', { type: 'additional_tools', role: 'developer', tools: [
      { type: 'namespace', name: 'functions', description: 'PRIVATE DESCRIPTION', tools: [
        { type: 'custom', name: 'exec', format: { definition: 'PRIVATE SCHEMA' } },
        { type: 'function', name: 'wait', parameters: { private_schema: 'PRIVATE SCHEMA' } },
      ] },
      { type: 'function', name: 'lookup', description: 'PRIVATE DESCRIPTION' },
    ] }),
    row(4, 'response_item', { type: 'function_call', name: 'lookup', arguments: '{}', call_id: call, turn_id: turnA }),
  ] }]);
  const [catalog] = replay.sessions[0].events;
  assert.equal(catalog.kind, 'session');
  assert.equal(catalog.label, 'Offered tool catalog');
  assert.equal(catalog.status, 'advertised');
  assert.equal(catalog.sourceLine, 3);
  assert.deepEqual(JSON.parse(catalog.body), { scope: 'offered-not-invoked', recordedToolCount: 3,
    tools: ['functions.exec', 'functions.wait', 'lookup'], omittedEntries: 0 });
  assert.equal(replay.sessions[0].events.filter(event => event.kind === 'tool-call').length, 1);
  assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE|developer/);
  assert.deepEqual(normalizeSessionReplay(replay), replay);
});

test('replay bounds offered tool identifiers and preserves terminal failure states', () => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(1, 'response_item', { type: 'additional_tools', tools: [
      ...Array.from({ length: 201 }, (_, index) => ({ name: `tool_${index}` })),
      { name: 'x'.repeat(501) }, { name: 'invalid\nname' },
    ] }),
    row(2, 'event_msg', { type: 'task_complete', turn_id: turnA, error: { message: 'failed' } }),
    row(3, 'event_msg', { type: 'turn_aborted', turn_id: turnB }),
    row(4, 'event_msg', { type: 'turn_complete', turn_id: turnB }),
  ] }]);
  const [catalog, failed, interrupted, completed] = replay.sessions[0].events;
  const body = JSON.parse(catalog.body);
  assert.equal(body.recordedToolCount, 200);
  assert.equal(body.tools.length, 200);
  assert.equal(body.omittedEntries, 3);
  assert.equal(failed.status, 'failed');
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(normalizeSessionReplay(replay), replay);
});

test('replay distinguishes intentionally unprojected records from visible unsupported items', () => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(1, 'event_msg', { type: 'token_count', input_tokens: 12 }),
    row(2, 'response_item', { type: 'reasoning', content: 'PRIVATE REASONING' }),
    row(3, 'response_item', { type: 'future_native_item', private_field: 'PRIVATE NATIVE FIELD' }),
  ] }]);
  const [session] = replay.sessions, limit = session.limits.find(row => row.kind === 'unprojected-records');
  assert.equal(limit.omitted, 2);
  assert.equal(limit.message, '2 native records were not projected into conversation replay. Stream metadata and private reasoning are excluded.');
  assert.deepEqual(limit.types, ['event_msg:token_count', 'response_item:reasoning']);
  assert.equal(session.events.length, 1);
  assert.equal(session.events[0].kind, 'unsupported');
  assert.equal(session.events[0].label, 'Unsupported native item: future_native_item');
  assert.doesNotMatch(JSON.stringify(replay), /PRIVATE REASONING|PRIVATE NATIVE FIELD/);
});

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

test('compaction markers and explicit summaries survive replay/export without replacement history', async t => {
  const replay = projectSessionReplay([{ id: sessionA, sourceFingerprint: fingerprint, records: [
    row(1, 'event_msg', { type: 'context_compacted', turn_id: turnA }),
    row(2, 'compacted', { message: 'Keep the original goal and pending checks.', replacement_history: [{ type: 'reasoning', text: 'PRIVATE_REPLACEMENT' }], turn_id: turnA }),
  ] }]);
  assert.deepEqual(replay.sessions[0].events.map(event => event.kind), ['compaction', 'compaction']);
  assert.equal(replay.sessions[0].events[0].bodyStatus, 'unavailable');
  assert.equal(replay.sessions[0].events[1].sourceLine, 2);
  assert.equal(replay.sessions[0].events[1].body, 'Keep the original goal and pending checks.');
  assert.equal(JSON.stringify(replay).includes('PRIVATE_REPLACEMENT'), false);
  const directory = await mkdtemp(join(tmpdir(), 'xfx-compaction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = { schemaVersion: 1, kind: 'audit-run', id: sessionA, sessionReplay: replay };
  for (const includeReplayContent of [false, true]) {
    const output = join(directory, `${includeReplayContent}.json`);
    await exportAuditReport(run, { output, includeReplayContent });
    const reopened = await readAuditReport(output);
    assert.equal(reopened.sessionReplay.sessions[0].events[1].kind, 'compaction');
    assert.equal(reopened.sessionReplay.sessions[0].events[1].bodyStatus, includeReplayContent ? 'included' : 'omitted');
  }
});
