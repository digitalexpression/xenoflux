import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditToolCapture } from '../src/audit-tools.js';

test('projects MCP and dynamic tool metadata without arguments, results, content, or error strings', () => {
  const capture = createAuditToolCapture();
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'started', source: 'native-rollout', sourceLine: 4,
    startedAtMs: 100, item: { id: 'm1', type: 'mcpToolCall', server: 'docs-server', pluginId: 'vendor.docs',
      tool: 'search', status: 'inProgress', arguments: { apiKey: 'SECRET' } } });
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed', source: 'native-rollout', sourceLine: 9,
    completedAtMs: 160, item: { id: 'm1', type: 'mcpToolCall', server: 'docs-server', pluginId: 'vendor.docs', tool: 'search',
      status: 'failed', durationMs: 60, error: { message: 'SECRET error text' }, result: { text: 'SECRET result' } } });
  capture.consumeItem({ agentId: 'child', turnId: 't2', phase: 'completed', sourceLine: 11, completedAtMs: 220,
    item: { id: 'd1', type: 'dynamicToolCall', namespace: 'browser', tool: 'open', status: 'completed', success: true,
      arguments: 'SECRET args', contentItems: [{ text: 'SECRET content' }] } });
  const result = capture.result();
  assert.equal(result.toolInvocations.length, 2);
  assert.deepEqual(result.toolInvocations[0], {
    agentId: 'root', turnId: 't1', itemId: 'm1', kind: 'mcp', serverName: 'docs-server', pluginId: 'vendor.docs',
    namespace: null, toolName: 'search', status: 'failed', success: null, durationMs: 60,
    startedAtMs: 100, completedAtMs: 160, source: 'native-rollout', sourceLine: 4, failed: true,
  });
  assert.equal(result.toolInvocations[1].success, true);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(result.mcp.servers, [{ name: 'docs-server', pluginId: 'vendor.docs', status: null, source: 'native-rollout', sourceLine: 4 }]);
  assert.equal(result.mcp.inventory, 'not-requested');
  assert.equal(result.coverage.tools, 'observed');
  assert.match(result.coverage.boundary, /not exhaustive/);
});

test('captures image-view, sleep, and image-generation display items as metadata only', () => {
  const capture = createAuditToolCapture();
  const base = { agentId: 'root', turnId: 't1', phase: 'completed', source: 'native-rollout' };
  capture.consumeItem({ ...base, item: { id: 'view', type: 'imageView', path: '/private/SECRET.png' } });
  capture.consumeItem({ ...base, item: { id: 'sleep', type: 'sleep', durationMs: 250, description: 'SECRET description' } });
  capture.consumeItem({ ...base, item: { id: 'image', type: 'imageGeneration', status: 'completed', result: 'SECRET image payload',
    revisedPrompt: 'SECRET prompt', savedPath: '/private/SECRET.png', durationMs: 999,
    failure: { type: 'usageLimitExceeded', limitId: 'SECRET limit' } } });
  assert.equal(capture.consumeItem({ ...base, item: { id: 'activity', type: 'subAgentActivity', description: 'SECRET activity' } }), false);
  const result = capture.result();
  assert.deepEqual(result.toolInvocations.map(({ kind, status, durationMs, failed }) => ({ kind, status, durationMs, failed })), [
    { kind: 'image-view', status: 'completed', durationMs: null, failed: false },
    { kind: 'sleep', status: 'completed', durationMs: 250, failed: false },
    { kind: 'image-generation', status: 'failed', durationMs: null, failed: true },
  ]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(result.toolInvocations.length, 3);
});

test('deduplicates lifecycle and hydration by agent, turn, and item while preserving terminal identity and timing', () => {
  const capture = createAuditToolCapture();
  const item = { id: 'same', type: 'dynamicToolCall', namespace: 'n', tool: 'x', status: 'completed', success: true };
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed', item, completedAtMs: 80 });
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'started', item: { ...item, namespace: 'stale', tool: 'stale', status: 'failed',
    success: false, durationMs: 10 }, startedAtMs: 5, completedAtMs: 55, source: 'stale' });
  capture.consumeItem({ agentId: 'child', turnId: 't1', phase: 'completed', item, completedAtMs: 90 });
  capture.consumeItem({ agentId: 'root', turnId: 't2', phase: 'completed', item, completedAtMs: 100 });
  const calls = capture.result().toolInvocations;
  assert.equal(calls.length, 3);
  assert.equal(calls[0].status, 'completed');
  assert.equal(calls[0].namespace, 'n');
  assert.equal(calls[0].toolName, 'x');
  assert.equal(calls[0].success, true);
  assert.equal(calls[0].startedAtMs, null);
  assert.equal(calls[0].completedAtMs, 80);
  assert.equal(calls[0].durationMs, null);
  assert.equal(calls[0].source, null);
});

test('a completed failed observation refines completed status without replacing first identity or timing', () => {
  const capture = createAuditToolCapture();
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed', completedAtMs: 80,
    item: { id: 'm1', type: 'mcpToolCall', server: 'server-a', tool: 'tool-a', status: 'completed', durationMs: 20 } });
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed', completedAtMs: 100,
    item: { id: 'm1', type: 'mcpToolCall', server: 'server-b', tool: 'tool-b', status: 'failed', durationMs: 50 } });
  const [call] = capture.result().toolInvocations;
  assert.equal(call.status, 'failed');
  assert.equal(call.failed, true);
  assert.equal(call.serverName, 'server-a');
  assert.equal(call.toolName, 'tool-a');
  assert.equal(call.completedAtMs, 80);
  assert.equal(call.durationMs, 20);
});

test('captures native command duration and exit code while keeping lifecycle timestamps separate', () => {
  const capture = createAuditToolCapture();
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'started', startedAtMs: 100,
    item: { id: 'cmd-ok', type: 'commandExecution', status: 'inProgress' } });
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed', completedAtMs: 175,
    item: { id: 'cmd-ok', type: 'commandExecution', status: 'completed', durationMs: 70, exitCode: 0,
      command: 'SECRET command text' } });
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed', completedAtMs: 210,
    item: { id: 'cmd-failed', type: 'commandExecution', status: 'completed', durationMs: 30, exitCode: 2 } });
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed', completedAtMs: 220,
    item: { id: 'cmd-unknown', type: 'commandExecution', status: 'completed', durationMs: 10, exitCode: 2 ** 40 } });
  const [ok, failed, unknown] = capture.result().toolInvocations;
  assert.equal(ok.durationMs, 70);
  assert.equal(ok.startedAtMs, 100);
  assert.equal(ok.completedAtMs, 175);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.success, true);
  assert.equal(failed.durationMs, 30);
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.success, false);
  assert.equal(failed.failed, true);
  assert.equal(unknown.durationMs, 10);
  assert.equal(Object.hasOwn(unknown, 'exitCode'), false);
  assert.equal(unknown.success, null);
  assert.equal(JSON.stringify(capture.result()).includes('SECRET'), false);
});

test('merges a missing-turn lifecycle phase only when the actor and item identify one record', () => {
  const capture = createAuditToolCapture();
  const item = { id: 'one-item', type: 'commandExecution', status: 'completed', durationMs: 12, exitCode: 0 };
  capture.consumeItem({ agentId: 'root', phase: 'started', startedAtMs: 100,
    item: { ...item, status: 'inProgress', durationMs: undefined, exitCode: undefined } });
  capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed', completedAtMs: 112, item });
  const merged = capture.result().toolInvocations;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].turnId, 't1');
  assert.equal(merged[0].startedAtMs, 100);
  assert.equal(merged[0].completedAtMs, 112);
  assert.equal(merged[0].durationMs, 12);

  const ambiguous = createAuditToolCapture();
  for (const turnId of ['t1', 't2']) ambiguous.consumeItem({ agentId: 'root', turnId,
    phase: 'completed', item: { id: 'reused', type: 'commandExecution', status: 'completed' } });
  ambiguous.consumeItem({ agentId: 'root', phase: 'started', startedAtMs: 200,
    item: { id: 'reused', type: 'commandExecution', status: 'inProgress' } });
  const retained = ambiguous.result().toolInvocations;
  assert.equal(retained.length, 3);
  assert.deepEqual(retained.map(call => call.turnId), ['t1', 't2', null]);
  assert.equal(ambiguous.result().coverage.tools, 'partial');
  assert.ok(ambiguous.result().warnings.includes('tool-turn-ownership-ambiguous'));
});

test('retains only typed MCP startup status fields and derives server names from observed runtime evidence', () => {
  const capture = createAuditToolCapture();
  assert.equal(capture.consumeMcpStatus({ method: 'mcpServer/startupStatus/updated', sourceLine: 7,
    params: { threadId: 'root', name: 'calendar', status: 'failed', failureReason: 'reauthenticationRequired', error: 'secret' } }), true);
  assert.equal(capture.consumeMcpStatus({ method: 'mcpServer/startupStatus/updated', params: { name: 'unused', status: 'ready' } }), true);
  assert.equal(capture.consumeMcpStatus({ method: 'mcpServer/status', params: { name: 'not-recorded', status: 'ready' } }), false);
  const result = capture.result();
  assert.deepEqual(result.mcp.servers, [
    { name: 'calendar', pluginId: null, status: 'failed', source: 'mcp-startup-status', sourceLine: 7, failureReason: 'reauthenticationRequired' },
    { name: 'unused', pluginId: null, status: 'ready', source: 'mcp-startup-status', sourceLine: null, failureReason: null },
  ]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(result.mcp.inventory, 'not-requested');
});

test('keeps same-named MCP servers distinct by plugin identity and startup without plugin remains ambiguous', () => {
  const capture = createAuditToolCapture();
  for (const pluginId of ['plugin.one', 'plugin.two']) capture.consumeItem({ agentId: 'root', turnId: 't1',
    phase: 'completed', item: { id: pluginId, type: 'mcpToolCall', server: 'shared-name', pluginId,
      tool: 'lookup', status: 'completed' } });
  capture.consumeMcpStatus({ params: { name: 'shared-name', status: 'ready' } });
  const servers = capture.result().mcp.servers;
  assert.deepEqual(servers, [
    { name: 'shared-name', pluginId: 'plugin.one', status: null, source: null, sourceLine: null },
    { name: 'shared-name', pluginId: 'plugin.two', status: null, source: null, sourceLine: null },
    { name: 'shared-name', pluginId: null, status: 'ready', source: 'mcp-startup-status', sourceLine: null, failureReason: null },
  ]);
});

test('caps invocations and servers with explicit partial coverage', () => {
  const capture = createAuditToolCapture({ maxInvocations: 1, maxServers: 1 });
  for (const id of ['one', 'two']) capture.consumeItem({ agentId: 'root', phase: 'completed', item: {
    id, type: 'mcpToolCall', server: id, tool: 'call', status: 'completed', durationMs: 1,
  } });
  capture.consumeMcpStatus({ params: { name: 'extra', status: 'ready' } });
  const result = capture.result();
  assert.equal(result.toolInvocations.length, 1);
  assert.equal(result.mcp.servers.length, 1);
  assert.equal(result.coverage.tools, 'partial');
  assert.equal(result.coverage.mcp, 'partial');
  assert.deepEqual(result.warnings, ['mcp-server-limit', 'tool-invocation-limit']);
});

test('rejects unsafe actor ids and sanitizes bounded tool identities', () => {
  const capture = createAuditToolCapture();
  assert.equal(capture.consumeItem({ agentId: 'root\nsecret', turnId: 't', phase: 'completed', item: {
    id: 'call', type: 'mcpToolCall', server: 's', tool: 't', status: 'completed', arguments: 'secret',
  } }), false);
  assert.equal(capture.consumeItem({ agentId: 'root', phase: 'completed', item: {
    id: 'call', type: 'mcpToolCall', server: 'server;secret', tool: 'tool', status: 'completed',
  } }), true);
  const result = capture.result();
  assert.equal(result.toolInvocations.length, 1);
  assert.equal(result.toolInvocations[0].serverName, 'server_secret');
});

test('keeps observer lifecycle spans distinct from native execution duration and history hydration', () => {
  const capture = createAuditToolCapture();
  const item = { id: 'observed', type: 'commandExecution', status: 'inProgress' };
  capture.consumeItem({ agentId: 'root', turnId: 'turn', phase: 'started', item, observedAtMs: 100 });
  capture.consumeItem({ agentId: 'root', turnId: 'turn', phase: 'completed', observedAtMs: 145,
    item: { ...item, status: 'completed', exitCode: 0, durationMs: 12 } });
  capture.consumeItem({ agentId: 'root', turnId: 'turn', phase: 'completed', source: 'history',
    item: { ...item, status: 'completed', exitCode: 0, durationMs: 12 } });
  capture.consumeItem({ agentId: 'child', turnId: 'child-turn', phase: 'completed', source: 'history',
    item: { id: 'hydrated', type: 'mcpToolCall', status: 'completed', server: 'local', tool: 'read' } });
  const [live, history] = capture.result().toolInvocations;
  assert.equal(live.durationMs, 12);
  assert.equal(live.observedElapsedMs, 45);
  assert.equal(live.observedStartedAtMs, 100);
  assert.equal(live.observedCompletedAtMs, 145);
  assert.equal(live.startedAtMs, null);
  assert.equal(history.observedElapsedMs, undefined);
  assert.equal(history.observedCompletedAtMs, undefined);
});

test('retains native plugin-relative script identity without command arguments or output', () => {
  const capture = createAuditToolCapture();
  const item = { id: 'plugin-script', type: 'commandExecution', status: 'completed', pluginId: 'trusted.plugin',
    scriptPath: 'skills/documents/scripts/a11y_audit.py', command: 'PRIVATE_COMMAND', aggregatedOutput: 'PRIVATE_OUTPUT', exitCode: 0 };
  capture.consumeItem({ item, agentId: 'child', turnId: 'child-turn', phase: 'completed' });
  capture.consumeItem({ item, agentId: 'child', turnId: 'child-turn', phase: 'completed', source: 'history' });
  const result = capture.result();
  assert.equal(result.toolInvocations.length, 1);
  assert.equal(result.toolInvocations[0].pluginId, 'trusted.plugin');
  assert.equal(result.toolInvocations[0].scriptPath, item.scriptPath);
  assert.equal(result.toolInvocations[0].success, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_COMMAND|PRIVATE_OUTPUT/);
});

test('excludes unsafe or unowned script paths without dropping command evidence', () => {
  const capture = createAuditToolCapture();
  const invalid = ['/private/scripts/run.py', '../scripts/run.py', 'scripts/../run.py', 'scripts//run.py',
    'scripts/./run.py', 'file:///private/run.py', 'C:\\scripts\\run.py', 'scripts/run.py\nSECRET', 'scripts/' + 'a'.repeat(512)];
  for (const [index, scriptPath] of invalid.entries()) capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed',
    item: { id: `invalid-${index}`, type: 'commandExecution', pluginId: 'trusted.plugin', scriptPath, exitCode: 0 } });
  capture.consumeItem({ agentId: 'child', turnId: 't2', phase: 'completed',
    item: { id: 'unowned', type: 'commandExecution', scriptPath: 'scripts/run.py', exitCode: 2 } });
  const records = capture.result().toolInvocations;
  assert.equal(records.length, invalid.length + 1);
  assert.equal(records.every(item => !Object.hasOwn(item, 'scriptPath')), true);
  assert.equal(records.at(-1).failed, true);
});

test('retains safe native relative script identities with Unicode and punctuation', () => {
  const capture = createAuditToolCapture();
  const scriptPath = 'skills/română/scripts/a11y-audit #1.py';
  capture.consumeItem({ agentId: 'child', turnId: 't2', phase: 'completed',
    item: { id: 'unicode-script', type: 'commandExecution', pluginId: 'trusted.plugin', scriptPath, exitCode: 0 } });
  assert.equal(capture.result().toolInvocations[0].scriptPath, scriptPath);
});

test('does not combine plugin and script attribution from inconsistent lifecycle items', () => {
  const capture = createAuditToolCapture();
  for (const id of ['omitted', 'conflicting', 'changed-script']) capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'started',
    item: { id, type: 'commandExecution', pluginId: 'plugin.a', ...(id === 'changed-script' ? { scriptPath: 'scripts/a.py' } : {}) } });
  for (const [id, pluginId, scriptPath] of [['omitted', null, 'scripts/foreign.py'], ['conflicting', 'plugin.b', 'scripts/b.py'], ['changed-script', 'plugin.a', 'scripts/b.py']])
    capture.consumeItem({ agentId: 'root', turnId: 't1', phase: 'completed',
      item: { id, type: 'commandExecution', pluginId, scriptPath, exitCode: 0 } });
  const result = capture.result();
  assert.equal(result.toolInvocations.every(item => !Object.hasOwn(item, 'scriptPath')), true);
  assert.deepEqual(result.toolInvocations.map(item => item.pluginId), ['plugin.a', null, null]);
  assert.equal(result.coverage.tools, 'partial');
  assert.ok(result.warnings.includes('plugin-command-attribution-conflict'));
});
