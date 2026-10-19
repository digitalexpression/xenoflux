import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { auditNativeSession } from '../src/audit-session.js';
import { resolveAuditProfile } from '../src/audit-discovery.js';
import { auditExitCode, compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

const exec = promisify(execFile), id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rec = (timestamp, type, payload) => ({ timestamp, type, payload });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-audit-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-codex'); await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const native = await prepareNativeHome({ directory: join(root, 'native'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store')); await store.update(data => create(data, 'A'));
  await registerHome(store, 'A', native.root, { executable, version: '0.153.4' });
  return { root, store, home: native.home };
}
async function seedIndex(home, threads) {
  const db = join(home, 'state_5.sqlite');
  await exec('/usr/bin/sqlite3', [db, 'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER DEFAULT 0, rollout_path TEXT, source TEXT);']);
  for (const row of threads) {
    const esc = value => String(value).replaceAll("'", "''");
    const source = typeof row.source === 'string' ? row.source : JSON.stringify(row.source ?? {});
    await exec('/usr/bin/sqlite3', [db, `INSERT INTO threads VALUES ('${esc(row.id)}','/repo','ignored',1,1,${row.archived ? 1 : 0},'${esc(row.path)}','${esc(source)}');`]);
  }
}
async function writeRollout(path, rows) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, rows.map(x => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 });
}
const meta = idValue => rec('2026-10-15T10:00:00.000Z', 'session_meta', { id: idValue, session_id: idValue, cli_version: '0.153.4', originator: 'codex_cli_rs' });
const context = (turn, extras = {}) => rec('2026-10-15T10:00:01.000Z', 'turn_context', { turn_id: turn, cwd: '/repo', model: 'gpt-test', effort: 'medium', ...extras });

test('ingests a selected archived CLI session with whitelisted timeline, tool evidence, catalogs, and no content leakage', async t => {
  const f = await fixture(t), task = id(1), turn = id(2), rollout = join(f.home, 'sessions', 'rollout.jsonl');
  const profile = await resolveAuditProfile(f.store, 'A');
  const skills = `<skills_instructions>\n### Skill roots\n- \`r0\` = \`${profile.userHome}/.codex/skills\`\n- \`r1\` = \`${profile.userHome}/.codex/skills/.system\`\n- \`r2\` = \`${profile.userHome}/.agents/skills\`\n- \`r3\` = \`/repo/.agents/skills\`\n- \`r4\` = \`${f.home}/skills\`\n- \`r5\` = \`/opt/codex/skills\`\n- \`r6\` = \`${profile.userHome}/.codex/plugins/cache/product-design/skills\`\n- \`r7\` = \`/plugins/cache/example/skills\`\n### Available skills\n- planner: planning aid (file: r2/planner/SKILL.md)\n- same: user copy (file: r2/same/SKILL.md)\n- same: project copy (file: r3/same/SKILL.md)\n- profile-skill: profile skill (file: r4/profile-skill/SKILL.md)\n- project-check: project checks (file: r3/project-check/SKILL.md)\n- system-check: system checks (file: r5/system-check/SKILL.md)\n- plugin-check: plugin checks (file: r7/plugin-check/SKILL.md)\n- aliased: aliased root (file: r0/aliased/SKILL.md)\n- product-design:image-to-code: frontend work (file: r6/image-to-code/SKILL.md)\n</skills_instructions>`;
  const nativeSkillPath = `${profile.userHome}/.agents/skills/planner/SKILL.md`;
  const nativeReads = Array.from({ length: 42 }, (_, index) => rec('2026-10-15T10:00:03.600Z', 'event_msg', {
    type: 'item_completed', turn_id: turn, item: { type: 'CommandExecution', id: `native-read-${index}`, process_id: `proc-${index}`,
      command: ['/bin/cat', nativeSkillPath], parsed_cmd: [{ type: 'read', cmd: 'cat', name: 'SKILL.md', path: nativeSkillPath }],
      status: 'completed', exit_code: 0, duration: { secs: 0, nanos: 1000 }, aggregated_output: 'PRIVATE NATIVE OUTPUT' },
  }));
  const maskedRead = rec('2026-10-15T10:00:03.625Z', 'event_msg', { type: 'item_completed', turn_id: turn,
    item: { type: 'CommandExecution', id: 'masked-read', process_id: 'proc-masked', command: ['/bin/zsh', '-lc', 'cat /missing/SKILL.md; true'],
      parsed_cmd: [{ type: 'read', cmd: 'cat', name: 'SKILL.md', path: nativeSkillPath }], status: 'completed', exit_code: 0, duration: { secs: 0, nanos: 2000 } } });
  const nativeChanges = Object.fromEntries([...Array.from({ length: 9 }, (_, index) => [`/repo/native-${index}.txt`, { type: 'update', diff: 'PRIVATE DIFF' }]),
    ['/repo/sk-123456789012345678901234.txt', { type: 'update', diff: 'PRIVATE DIFF' }]]);
  await seedIndex(f.home, [{ id: task, path: rollout, archived: true, source: 'cli' }]);
  await writeRollout(rollout, [meta(task), context(turn, { skills: [{ name: 'malformed-alias', path: '/repo/.agents/skills/malformed-alias/SKILL.md', rootAlias: '../../outside' }] }),
    rec('2026-10-15T10:00:00.500Z', 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: skills }] }),
    rec('2026-10-15T10:00:00.550Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Please use $planner; maybe $same. Ignore $HOME. Do not use $planner; quoted "$planner"; hypothetically $planner.' }] }),
    rec('2026-10-15T10:00:00.600Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<skills_instructions>\n- user-quoted: quoted catalog (file: /repo/.agents/skills/user-quoted/SKILL.md)\n</skills_instructions>' }] }),
    rec('2026-10-15T10:00:00.700Z', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: '<skills_instructions>\n- assistant-quoted: quoted catalog (file: /repo/.agents/skills/assistant-quoted/SKILL.md)\n</skills_instructions>' }] }),
    rec('2026-10-15T10:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: turn, private_text: 'PRIVATE USER TEXT' }),
    rec('2026-10-15T10:00:02.500Z', 'event_msg', { type: 'skill_invoked', turn_id: turn, skill_name: 'same' }),
    rec('2026-10-15T10:00:03.000Z', 'response_item', { type: 'function_call', name: 'functions.exec', call_id: 'call-one', arguments: JSON.stringify({ cmd: 'cat /home/user/.agents/skills/planner/SKILL.md && echo PRIVATE_TOOL_OUTPUT' }) }),
    rec('2026-10-15T10:00:03.500Z', 'response_item', { type: 'message', content: [{ text: '<skills_instructions>\n- skill: message-skill: from rendered catalog (file: /repo/.codex/skills/message-skill/SKILL.md)\n</skills_instructions>' }] }),
    ...nativeReads,
    maskedRead,
    rec('2026-10-15T10:00:03.650Z', 'event_msg', { type: 'item_completed', turn_id: turn, item: { type: 'FileChange', id: 'native-changes', changes: nativeChanges, status: 'completed', stdout: 'PRIVATE OUTPUT', stderr: 'PRIVATE ERROR' } }),
    rec('2026-10-15T10:00:03.750Z', 'response_item', { type: 'function_call', name: 'functions.exec', call_id: 'call-two', arguments: JSON.stringify({ code: `await tools.exec_command({cmd:"cat ${profile.userHome}/.agents/skills/planner/SKILL.md"})` }) }),
    rec('2026-10-15T10:00:03.775Z', 'response_item', { type: 'function_call', name: 'functions.exec', call_id: 'redacted-path', arguments: JSON.stringify({ code: 'cat /repo/sk-123456789012345678901234/skills/private/SKILL.md' }) }),
    rec('2026-10-15T10:00:03.800Z', 'response_item', { type: 'function_call_output', call_id: 'call-two', output: 'PRIVATE TOOL OUTPUT' }),
    rec('2026-10-15T10:00:03.900Z', 'response_item', { type: 'function_call', name: 'functions.exec', call_id: 'call-three', arguments: JSON.stringify({ code: `if (false) { await tools.exec_command({cmd:"cat ${profile.userHome}/.agents/skills/planner/SKILL.md"}); } else { await tools.exec_command({cmd:"echo ${profile.userHome}/.agents/skills/planner/SKILL.md"}); }` }) }),
    rec('2026-10-15T10:00:03.950Z', 'response_item', { type: 'function_call_output', call_id: 'call-three', output: 'PRIVATE TOOL OUTPUT' }),
    rec('2026-10-15T10:00:04.000Z', 'event_msg', { type: 'task_complete', turn_id: turn, success: true, status: 'completed', api_key: 'sk-123456789012345' }),
    rec('2026-10-15T10:00:04.100Z', 'event_msg', { type: 'skill_invoked', skill_name: 'planner' }),
    rec('2026-10-15T10:00:04.200Z', 'event_msg', { type: 'item_completed', item: { type: 'function_call', call_id: 'failed-call', name: 'functions.exec', status: 'failed', error: 'PRIVATE ERROR' } }),
    rec('2026-10-15T10:00:05.000Z', 'token_count', { turn_id: turn, info: { last_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 20, reasoning_output_tokens: 10 }, total_token_usage: { input_tokens: 100, output_tokens: 50 } } }),
    rec('2026-10-15T10:00:05.500Z', 'event_msg', { type: 'token_count', turn_id: turn, thread_id: id(99), info: { total_token_usage: { input_tokens: 999, output_tokens: 999 } } }),
    rec('2026-10-15T10:00:05.750Z', 'event_msg', { type: 'token_count', turn_id: turn, info: { total_token_usage: { input_tokens: 777, output_tokens: 777 } } }),
    rec('2026-10-15T10:00:06.000Z', 'token_count', { turn_id: turn, info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } } }),
    rec('2026-10-15T10:00:06.000Z', 'token_count', { turn_id: turn, info: { total_token_usage: { input_tokens: -1 } } })]);
  const before = await readFile(rollout), report = await auditNativeSession(f.store, 'A', task);
  assert.equal(report.status, 'ready'); assert.equal(report.source.nativeSessionId, task); assert.equal(report.source.clientVersion, '0.153.4');
  assert.deepEqual(report.turns.map(x => x.turnId), [turn]);
  assert.equal(report.metrics.recordedSpanMs, 5500);
  assert.equal(report.events.find(x => x.kind === 'tool-call').metadata.tool, 'functions.exec');
  assert.deepEqual(report.events.find(x => x.kind === 'tool-call' && x.metadata.callId === 'call-two')?.metadata.operations, ['tools.exec_command']);
  assert.equal(report.events.find(x => x.kind === 'tool-call' && x.metadata.callId === 'call-two')?.metadata.result, 'returned', JSON.stringify(report.events));
  assert.ok(!report.events.find(x => x.kind === 'tool-call' && x.metadata.callId === 'redacted-path')?.metadata.resourcePaths?.length);
  assert.equal(report.events.filter(x => x.kind === 'command-execution').length, 43);
  assert.equal(report.events.find(x => x.kind === 'command-execution')?.metadata.operation, 'Read');
  assert.equal(report.events.find(x => x.kind === 'command-execution')?.metadata.result, 'returned');
  assert.equal(report.events.find(x => x.kind === 'file-change')?.metadata.changeCount, 10);
  assert.equal(report.artifacts.length, 10);
  assert.ok(report.artifacts.some(x => x.path === null));
  assert.equal(report.skills.find(x => x.name === 'planner').observations.filter(x => x.kind === 'definition-read-observed').length, 42);
  const maskedEvent = report.events.find(x => x.kind === 'command-execution' && x.metadata.id === 'masked-read');
  assert.ok(report.skills.find(x => x.name === 'planner').observations.some(x => x.kind === 'resource-read-intent' && x.sourceLine === maskedEvent.sourceLine));
  assert.ok(report.skills.find(x => x.name === 'planner').observations.every(x => x.kind !== 'definition-read-observed' || x.sourceLine !== maskedEvent.sourceLine));
  assert.equal(report.events.find(x => x.kind === 'task-complete').metadata.success, true);
  assert.equal(report.events.find(x => x.kind === 'skill-invoked' && x.sourceLine > 10).turnId, null);
  assert.equal(report.events.find(x => x.kind === 'tool-call' && x.metadata.callId === 'failed-call')?.metadata.result, 'error', JSON.stringify(report.events));
  assert.ok(report.events.some(x => x.kind === 'tool-error' && x.metadata.callId === 'failed-call'));
  assert.deepEqual(report.usage.totals.values, { input_tokens: 100, output_tokens: 50 }); assert.equal(report.usage.observations.length, 4);
  assert.ok(report.usage.observations.some(x => x.scope === 'reported-scope-unknown' && x.total.inputTokens === 777));
  assert.ok(report.usage.observations.every(x => x.mode === 'snapshot'));
  assert.ok(report.usage.observations.every(x => ['event_msg.token_count', 'token_count'].includes(x.source)));
  assert.ok(report.usage.observations.some(x => x.disposition === 'invalid' && x.malformedFields.total.includes('inputTokens')));
  assert.deepEqual(new Set(report.skills.map(x => x.name)), new Set(['planner', 'same', 'profile-skill', 'project-check', 'system-check', 'plugin-check', 'aliased', 'product-design:image-to-code', 'malformed-alias']));
  assert.equal(report.skills.find(x => x.name === 'aliased').rootAlias, 'r0');
  assert.equal(report.skills.find(x => x.name === 'aliased').path, `${profile.userHome}/.codex/skills/aliased/SKILL.md`);
  assert.equal(report.skills.find(x => x.name === 'product-design:image-to-code').rootAlias, 'r6');
  assert.equal(report.skills.find(x => x.name === 'system-check').scope, 'system');
  assert.equal(report.skills.filter(x => x.name === 'same').length, 2);
  assert.equal(report.skills.find(x => x.name === 'planner').scope, 'user');
  assert.ok(report.events.some(x => x.kind === 'skill-invoked' && x.metadata.reason === 'ambiguous-skill-name'
    && x.metadata.candidateSkillIds.length === 2));
  assert.ok(report.events.some(x => x.kind === 'skill-selection-mention' && x.metadata.attribution === 'unresolved'
    && x.metadata.skillName === 'same' && x.metadata.candidateSkillIds.length === 2));
  assert.ok(report.events.some(x => x.kind === 'skill-selection-mention' && x.metadata.skillName === 'planner'));
  assert.ok(report.skills.find(x => x.name === 'planner').observations.some(x => x.kind === 'selection-mentioned'));
  assert.ok(report.skills.every(skill => !skill.observations.some(x => x.kind === 'requested')));
  assert.equal(report.skills.find(x => x.name === 'malformed-alias').rootAlias, undefined);
  assert.ok(report.skills.filter(x => x.name === 'same').every(skill => !skill.observations.some(x => x.kind === 'explicit-invocation')));
  assert.ok(report.skills.find(x => x.name === 'planner').observations.some(x => x.kind === 'resource-read-intent'));
  assert.ok(report.skills.find(x => x.name === 'planner').observations.some(x => x.kind === 'paired-call-returned'
    && x.evidence.confidence === 'outer-tool-result'));
  assert.ok(report.skills.find(x => x.name === 'planner').observations.every(x => x.kind !== 'resource-returned'));
  assert.equal(report.coverage.skills, 'partial'); assert.equal(report.coverage.outcome, 'partial');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|sk-123|aggregated_output|parsed_cmd|"cmd"/);
  assert.deepEqual(await readFile(rollout), before);
});

test('projects typed historical tool lifecycles with native ownership, outcomes, plugin identity, and privacy bounds', async t => {
  const f = await fixture(t), task = id(180), turn = id(181), path = join(f.home, 'sessions', 'typed-tools.jsonl');
  await seedIndex(f.home, [{ id: task, path, source: 'cli' }]);
  await writeRollout(path, [meta(task), context(turn),
    rec('2026-10-15T10:00:02.000Z', 'event_msg', { type: 'item_started', turn_id: turn,
      item: { type: 'mcp_tool_call', id: 'mcp-ok', server: 'docs', tool: 'search', plugin_id: 'vendor.docs' } }),
    rec('2026-10-15T10:00:02.100Z', 'event_msg', { type: 'item_completed', turn_id: turn, started_at_ms: 10, completed_at_ms: 22,
      item: { type: 'mcpToolCall', id: 'mcp-ok', server: 'docs', tool: 'search', pluginId: 'vendor.docs', status: 'completed', duration_ms: 12,
        result: { is_error: false, content: [{ text: 'PRIVATE RESULT' }] } } }),
    rec('2026-10-15T10:00:03.000Z', 'event_msg', { type: 'item_completed', turn_id: turn,
      item: { type: 'dynamic_tool_call', id: 'dynamic-failed', namespace: 'apps', tool: 'lookup', status: 'failed', success: false,
        content_items: [{ text: 'PRIVATE DYNAMIC RESULT' }] } }),
    rec('2026-10-15T10:00:04.000Z', 'event_msg', { type: 'item_completed', turn_id: turn,
      item: { type: 'command_execution', id: 'plugin-command', plugin_id: 'vendor.plugin', script_path: 'scripts/run.py',
        command: 'PRIVATE COMMAND', status: 'completed', exit_code: 0, duration_ms: 7 } }),
    rec('2026-10-15T10:00:05.000Z', 'event_msg', { type: 'item_completed', turn_id: turn,
      item: { type: 'command_execution', id: 'unsafe-plugin-command', plugin_id: 'vendor.plugin', script_path: '../secrets/run.py',
        command: 'PRIVATE COMMAND', status: 'failed', exit_code: 1 } }),
    rec('2026-10-15T10:00:06.000Z', 'event_msg', { type: 'mcp_tool_call_begin', turn_id: turn, call_id: 'legacy-call',
      invocation: { server: 'legacy-server', tool: 'list' }, plugin_id: 'vendor.legacy' }),
    rec('2026-10-15T10:00:06.250Z', 'event_msg', { type: 'mcp_tool_call_end', turn_id: turn, call_id: 'legacy-call',
      invocation: { server: 'legacy-server', tool: 'list' }, plugin_id: 'vendor.legacy', duration: { secs: 0, nanos: 250000000 }, result: { Err: 'PRIVATE ERROR' } }),
    rec('2026-10-15T10:00:06.500Z', 'event_msg', { type: 'exec_command_begin', turn_id: turn, call_id: 'legacy-plugin',
      plugin_id: 'vendor.plugin', script_path: 'scripts/legacy.py', started_at_ms: 500, command: ['PRIVATE COMMAND'], cwd: 'file:///private/path' }),
    rec('2026-10-15T10:00:06.750Z', 'event_msg', { type: 'exec_command_end', turn_id: turn, call_id: 'legacy-plugin',
      plugin_id: 'vendor.plugin', script_path: 'scripts/legacy.py', completed_at_ms: 750, status: 'completed', exit_code: 0,
      duration: { secs: 0, nanos: 125000000 }, aggregated_output: 'PRIVATE OUTPUT' }),
    rec('2026-10-15T10:00:07.000Z', 'response_item', { type: 'dynamicToolCall', turn_id: turn, id: 'response-item', namespace: 'native',
      tool: 'resolve', status: 'completed', success: true, durationMs: 4, arguments: { private: 'PRIVATE ARGUMENT' } }),
    rec('2026-10-15T10:00:08.000Z', 'event_msg', { type: 'hook_started', turn_id: turn,
      run: { id: 'hook-1', event_name: 'pre_tool_use', handler_type: 'mcp_tool', execution_mode: 'async', scope: 'turn',
        source_path: '/private/path/to/hook', source: 'session_flags', display_order: 1, status: 'running', started_at: 1792051200,
        status_message: 'PRIVATE STATUS', entries: [{ kind: 'context', text: 'PRIVATE HOOK OUTPUT' }] } }),
    rec('2026-10-15T10:00:08.250Z', 'event_msg', { type: 'hook_completed', turn_id: turn,
      run: { id: 'hook-1', event_name: 'pre_tool_use', handler_type: 'mcp_tool', execution_mode: 'async', scope: 'turn',
        source_path: '/private/path/to/hook', source: 'session_flags', display_order: 1, status: 'completed', started_at: 1792051200,
        completed_at: 1792051201, duration_ms: 250, status_message: 'PRIVATE STATUS', entries: [{ kind: 'context', text: 'PRIVATE HOOK OUTPUT' }] } }),
  ]);
  const report = await auditNativeSession(f.store, 'A', task);
  assert.equal(report.coverage.tools, 'observed');
  const byId = new Map(report.toolInvocations.map(row => [row.itemId, row]));
  assert.equal(byId.get('mcp-ok')?.status, 'completed');
  assert.equal(byId.get('mcp-ok')?.serverName, 'docs');
  assert.equal(byId.get('mcp-ok')?.pluginId, 'vendor.docs');
  assert.equal(byId.get('mcp-ok')?.durationMs, 12);
  assert.equal(byId.get('dynamic-failed')?.success, false);
  assert.equal(byId.get('dynamic-failed')?.failed, true);
  assert.equal(byId.get('plugin-command')?.exitCode, 0);
  assert.equal(byId.get('plugin-command')?.scriptPath, 'scripts/run.py');
  assert.equal(byId.get('unsafe-plugin-command')?.scriptPath, undefined);
  assert.equal(byId.get('legacy-call')?.status, 'failed');
  assert.equal(byId.get('legacy-call')?.durationMs, 250);
  assert.equal(byId.get('legacy-plugin')?.pluginId, 'vendor.plugin');
  assert.equal(byId.get('legacy-plugin')?.scriptPath, 'scripts/legacy.py');
  assert.equal(byId.get('legacy-plugin')?.durationMs, 125);
  assert.equal(byId.get('response-item')?.success, true);
  assert.equal(report.coverage.hooks, 'observed');
  assert.equal(report.hookInvocations.length, 1);
  assert.equal(report.hookInvocations[0].eventName, 'preToolUse');
  assert.equal(report.hookInvocations[0].sourceKind, 'sessionFlags');
  assert.equal(report.hookInvocations[0].status, 'completed');
  assert.equal(report.hookInvocations[0].durationMs, 250);
  assert.equal(report.hookCaptureBoundary, null);
  assert.equal(report.toolInvocations.filter(row => row.itemId === 'mcp-ok').length, 1);
  assert.doesNotMatch(JSON.stringify({ tools: report.toolInvocations, hooks: report.hookInvocations }), /PRIVATE|arguments|content_items|aggregated_output|parsed_cmd|source_path|status_message|entries/);
});

test('recursively corroborates agent identity and ownership, excludes inherited context, and preserves unavailable child nodes', async t => {
  const f = await fixture(t), parent = id(11), rootSession = id(10), child = id(12), grandchild = id(15), missingChild = id(16),
    wrongRootChild = id(18), wrongTokenChild = id(21), wrongParentChild = id(22), parentTurn = id(13), childTurn = id(14),
    grandchildTurn = id(17), wrongRootTurn = id(19), wrongTokenTurn = id(23), wrongParentTurn = id(24);
  const parentPath = join(f.home, 'sessions', 'parent.jsonl'), childPath = join(f.home, 'sessions', 'child.jsonl'), grandchildPath = join(f.home, 'sessions', 'grandchild.jsonl');
  await seedIndex(f.home, [
    { id: parent, path: parentPath },
    { id: child, path: childPath, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } },
    { id: grandchild, path: grandchildPath, source: { subagent: { thread_spawn: { parent_thread_id: child } } } },
    { id: missingChild, path: join(f.home, 'sessions', 'missing.jsonl'), source: { subagent: { thread_spawn: { parent_thread_id: parent } } } },
    { id: wrongRootChild, path: join(f.home, 'sessions', 'wrong-root.jsonl'), source: { subagent: { thread_spawn: { parent_thread_id: child } } } },
    { id: wrongTokenChild, path: join(f.home, 'sessions', 'wrong-token-root.jsonl'), source: { subagent: { thread_spawn: { parent_thread_id: child } } } },
    { id: wrongParentChild, path: join(f.home, 'sessions', 'wrong-parent.jsonl'), source: { subagent: { thread_spawn: { parent_thread_id: child } } } },
  ]);
  await writeRollout(parentPath, [rec('2026-10-15T10:00:00.000Z', 'session_meta', { id: parent, session_id: rootSession,
    cli_version: '0.153.4', originator: 'codex_cli_rs' }), context(parentTurn),
    rec('2026-10-15T10:00:03Z', 'event_msg', { type: 'item_completed', turn_id: parentTurn,
      item: { type: 'mcpToolCall', id: 'same-native-item', server: 'root-server', tool: 'lookup', status: 'completed' } })]);
  await writeRollout(childPath, [rec('2026-10-15T10:00:02Z', 'session_meta', { id: child, session_id: rootSession, parent_thread_id: parent,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } }, forked_from_id: parent }),
    rec('2026-10-15T10:00:02.500Z', 'event_msg', { type: 'hook_completed', run: { id: 'child-thread-hook', event_name: 'session_start',
      handler_type: 'command', execution_mode: 'sync', scope: 'thread', source: 'unknown', status: 'completed',
      started_at: 1792051200, completed_at: 1792051201, duration_ms: 3 } }),
    context(parentTurn), context(childTurn),
    rec('2026-10-15T10:00:03.100Z', 'event_msg', { type: 'item_completed', turn_id: parentTurn,
      item: { type: 'mcpToolCall', id: 'inherited-turn-item', server: 'must-not-attribute', tool: 'lookup', status: 'completed' } }),
    rec('2026-10-15T10:00:03.200Z', 'event_msg', { type: 'item_completed', turn_id: childTurn,
      item: { type: 'mcpToolCall', id: 'same-native-item', server: 'child-server', tool: 'lookup', status: 'completed' } }),
    rec('2026-10-15T10:00:04Z', 'token_usage_record', { thread_id: child, session_id: rootSession, turn_id: childTurn, root_turn_id: parentTurn, total_token_usage: { input_tokens: 3 } }),
    rec('2026-10-15T10:00:04.500Z', 'token_usage_record', { thread_id: child, session_id: rootSession, turn_id: childTurn, root_turn_id: parentTurn, total_token_usage: { input_tokens: -3, output_tokens: 'bad' } }),
    rec('2026-10-15T10:00:05Z', 'token_usage_record', { thread_id: parent, session_id: rootSession, turn_id: parentTurn, root_turn_id: parentTurn, total_token_usage: { input_tokens: 4 } }),
  ]);
  await writeRollout(grandchildPath, [rec('2026-10-15T10:00:06Z', 'session_meta', { id: grandchild, session_id: rootSession, parent_thread_id: child,
      source: { subagent: { thread_spawn: { parent_thread_id: child } } }, forked_from_id: child }),
    context(grandchildTurn),
    rec('2026-10-15T10:00:07Z', 'token_usage_record', { thread_id: grandchild, session_id: rootSession, turn_id: grandchildTurn, root_turn_id: childTurn, total_token_usage: { input_tokens: 2 } }),
  ]);
  const wrongRootPath = join(f.home, 'sessions', 'wrong-root.jsonl');
  await writeRollout(wrongRootPath, [rec('2026-10-15T10:00:08Z', 'session_meta', { id: wrongRootChild, session_id: id(20), parent_thread_id: child,
      source: { subagent: { thread_spawn: { parent_thread_id: child } } }, forked_from_id: child }),
    context(wrongRootTurn),
    rec('2026-10-15T10:00:09Z', 'token_usage_record', { thread_id: wrongRootChild, session_id: rootSession,
      turn_id: wrongRootTurn, root_turn_id: childTurn, total_token_usage: { input_tokens: 1 } }),
  ]);
  await writeRollout(join(f.home, 'sessions', 'wrong-token-root.jsonl'), [rec('2026-10-15T10:00:10Z', 'session_meta', { id: wrongTokenChild,
      session_id: rootSession, parent_thread_id: child, source: { subagent: { thread_spawn: { parent_thread_id: child } } }, forked_from_id: child }),
    context(wrongTokenTurn), rec('2026-10-15T10:00:11Z', 'token_usage_record', { thread_id: wrongTokenChild, session_id: id(20),
      turn_id: wrongTokenTurn, root_turn_id: childTurn, total_token_usage: { input_tokens: 1 } })]);
  await writeRollout(join(f.home, 'sessions', 'wrong-parent.jsonl'), [rec('2026-10-15T10:00:12Z', 'session_meta', { id: wrongParentChild,
      session_id: rootSession, parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: child } } }, forked_from_id: child }),
    context(wrongParentTurn), rec('2026-10-15T10:00:13Z', 'token_usage_record', { thread_id: wrongParentChild, session_id: rootSession,
      turn_id: wrongParentTurn, root_turn_id: childTurn, total_token_usage: { input_tokens: 1 } })]);
  const report = await auditNativeSession(f.store, 'A', parent);
  assert.ok(report.agents.some(x => x.id === child && x.parentId === parent && x.depth === 1));
  assert.ok(report.agents.some(x => x.id === grandchild && x.parentId === child && x.depth === 2));
  assert.equal(report.agents.find(x => x.id === missingChild).status, 'unavailable');
  assert.equal(report.agents.find(x => x.id === wrongRootChild).status, 'unavailable');
  assert.equal(report.agents.find(x => x.id === wrongTokenChild).status, 'unavailable');
  assert.equal(report.agents.find(x => x.id === wrongParentChild).status, 'unavailable');
  assert.deepEqual(report.turns.map(x => [x.agentId, x.turnId]), [[parent, parentTurn], [child, childTurn], [grandchild, grandchildTurn]]);
  assert.equal(report.usage.observations.filter(x => x.agentId === parent).length, 0);
  assert.equal(report.usage.observations.filter(x => x.agentId === child).length, 2);
  assert.equal(report.coverage.tools, 'partial');
  assert.equal(report.coverage.mcp, 'partial');
  assert.equal(report.coverage.hooks, 'partial');
  assert.equal(report.hookCaptureBoundary, 'rollout-hook-lifecycle-not-observed');
  assert.deepEqual(report.toolInvocations.map(row => [row.agentId, row.itemId, row.serverName]), [
    [parent, 'same-native-item', 'root-server'], [child, 'same-native-item', 'child-server'],
  ]);
  assert.ok(report.hookInvocations.some(row => row.agentId === child && /^sha256:[a-f0-9]{64}$/.test(row.hookRunId)
    && row.turnId === null && row.scope === 'thread'));
  assert.ok(report.usage.observations.some(x => x.agentId === child && x.disposition === 'invalid'
    && x.malformedFields.total.includes('inputTokens') && x.malformedFields.total.includes('outputTokens')));
  assert.equal(report.usage.totals, null);
});

test('uses the root thread as the grouping fallback only when root session_id is omitted', async t => {
  const f = await fixture(t), root = id(31), child = id(32), grandchild = id(33), wrongRoot = id(34),
    rootTurn = id(35), childTurn = id(36), grandchildTurn = id(37), wrongTurn = id(38), otherRoot = id(39);
  const rootPath = join(f.home, 'sessions', 'fallback-root.jsonl'), childPath = join(f.home, 'sessions', 'fallback-child.jsonl'),
    grandchildPath = join(f.home, 'sessions', 'fallback-grandchild.jsonl'), wrongPath = join(f.home, 'sessions', 'wrong-group.jsonl');
  await seedIndex(f.home, [
    { id: root, path: rootPath },
    { id: child, path: childPath, source: { subagent: { thread_spawn: { parent_thread_id: root } } } },
    { id: grandchild, path: grandchildPath, source: { subagent: { thread_spawn: { parent_thread_id: child } } } },
    { id: wrongRoot, path: wrongPath, source: { subagent: { thread_spawn: { parent_thread_id: root } } } },
  ]);
  await writeRollout(rootPath, [rec('2026-10-15T10:00:00Z', 'session_meta', { id: root }), context(rootTurn)]);
  await writeRollout(childPath, [rec('2026-10-15T10:00:01Z', 'session_meta', { id: child, session_id: root, parent_thread_id: root,
    source: { subagent: { thread_spawn: { parent_thread_id: root } } }, forked_from_id: root }), context(childTurn),
    rec('2026-10-15T10:00:02Z', 'token_usage_record', { thread_id: child, session_id: root, turn_id: childTurn,
      root_turn_id: rootTurn, total_token_usage: { input_tokens: 1 } })]);
  await writeRollout(grandchildPath, [rec('2026-10-15T10:00:03Z', 'session_meta', { id: grandchild, session_id: root, parent_thread_id: child,
    source: { subagent: { thread_spawn: { parent_thread_id: child } } }, forked_from_id: child }), context(grandchildTurn),
    rec('2026-10-15T10:00:04Z', 'token_usage_record', { thread_id: grandchild, session_id: root, turn_id: grandchildTurn,
      root_turn_id: childTurn, total_token_usage: { input_tokens: 1 } })]);
  await writeRollout(wrongPath, [rec('2026-10-15T10:00:05Z', 'session_meta', { id: wrongRoot, session_id: otherRoot, parent_thread_id: root,
    source: { subagent: { thread_spawn: { parent_thread_id: root } } }, forked_from_id: root }), context(wrongTurn),
    rec('2026-10-15T10:00:06Z', 'token_usage_record', { thread_id: wrongRoot, session_id: otherRoot, turn_id: wrongTurn,
      root_turn_id: rootTurn, total_token_usage: { input_tokens: 1 } })]);
  const report = await auditNativeSession(f.store, 'A', root);
  assert.ok(report.agents.some(x => x.id === child && x.depth === 1 && x.status === 'ready'));
  assert.ok(report.agents.some(x => x.id === grandchild && x.parentId === child && x.depth === 2 && x.status === 'ready'));
  assert.equal(report.agents.find(x => x.id === wrongRoot).status, 'unavailable');
  assert.deepEqual(report.turns.map(x => x.agentId), [root, child, grandchild]);
});

test('reports missing and unsafe selected rollouts without cross-home fallback or writes', async t => {
  const f = await fixture(t), missing = id(21);
  await seedIndex(f.home, [{ id: missing, path: join(f.home, 'sessions', '..', 'outside.jsonl') }]);
  const report = await auditNativeSession(f.store, 'A', missing);
  assert.equal(report.status, 'unavailable'); assert.match(report.reason, /unsafe|unavailable/i);
  const absent = await auditNativeSession(f.store, 'A', id(22)); assert.equal(absent.status, 'not-found');
});

test('marks typed histories partial when a known hook row has an unsupported source enum or malformed turn', async t => {
  const f = await fixture(t), task = id(25), turn = id(26), path = join(f.home, 'sessions', 'partial-typed-history.jsonl');
  await seedIndex(f.home, [{ id: task, path, source: 'cli' }]);
  const hook = { id: 'future-hook', event_name: 'pre_tool_use', handler_type: 'command', execution_mode: 'sync', scope: 'turn',
    status: 'completed', source_path: '/private/hook', started_at: 1792051200, completed_at: 1792051201, duration_ms: 1 };
  await writeRollout(path, [meta(task), context(turn),
    rec('2026-10-15T10:00:02Z', 'event_msg', { type: 'item_completed', turn_id: turn,
      item: { type: 'mcpToolCall', id: 'positive-call', server: 'docs', tool: 'search', status: 'completed' } }),
    rec('2026-10-15T10:00:03Z', 'event_msg', { type: 'hook_completed', turn_id: turn, run: { ...hook, source: 'future_source' } }),
    rec('2026-10-15T10:00:04Z', 'event_msg', { type: 'hook_completed', turn_id: 'malformed-turn', run: { ...hook, id: 'bad-turn', source: 'unknown' } }),
    rec('2026-10-15T10:00:05Z', 'event_msg', { type: 'hook_completed', turn_id: turn, run: { id: 'missing-source', event_name: 'pre_tool_use',
      handler_type: 'command', execution_mode: 'sync', scope: 'turn', status: 'completed', started_at: 1792051200, completed_at: 1792051201 } }),
  ]);
  const report = await auditNativeSession(f.store, 'A', task);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.toolInvocations.map(row => row.itemId), ['positive-call']);
  assert.equal(report.hookInvocations.length, 0);
  assert.equal(report.coverage.tools, 'partial');
  assert.equal(report.coverage.mcp, 'partial');
  assert.equal(report.coverage.hooks, 'partial');
  assert.ok(report.warnings.some(warning => /Malformed native hook/.test(warning)));
});

test('marks absent historical hook rows unavailable without treating them as measured zero', async t => {
  const f = await fixture(t), task = id(27), turn = id(28), path = join(f.home, 'sessions', 'no-hooks-recorded.jsonl');
  await seedIndex(f.home, [{ id: task, path, source: 'cli' }]);
  await writeRollout(path, [meta(task), context(turn), rec('2026-10-15T10:00:02Z', 'event_msg', {
    type: 'item_completed', turn_id: turn, item: { type: 'mcpToolCall', id: 'known-tool', server: 'docs', tool: 'search', status: 'completed' },
  })]);
  const report = await auditNativeSession(f.store, 'A', task);
  assert.equal(report.status, 'ready');
  assert.deepEqual(report.hookInvocations, []);
  assert.equal(report.coverage.hooks, 'unavailable');
  assert.equal(report.hookCaptureBoundary, 'rollout-hook-lifecycle-not-observed');
  assert.equal(report.coverage.tools, 'observed');
});

test('retains partial evidence when one native line exceeds the parser bound', async t => {
  const f = await fixture(t), task = id(31), turn = id(32), path = join(f.home, 'sessions', 'large.jsonl');
  await seedIndex(f.home, [{ id: task, path, source: 'vscode' }]);
  await writeRollout(path, [meta(task), rec('2026-10-15T10:00:01Z', 'event_msg', { type: 'diagnostic', ignored: 'x'.repeat(1024 * 1024 + 16) }), context(turn)]);
  const report = await auditNativeSession(f.store, 'A', task);
  assert.equal(report.status, 'partial'); assert.equal(report.turns.length, 1);
  assert.ok(report.warnings.some(warning => warning.includes('Oversized rollout line')));
});

test('propagates partial evidence and bounded warnings from a verified child rollout', async t => {
  const f = await fixture(t), parent = id(33), child = id(34), parentTurn = id(35), childTurn = id(36);
  const parentPath = join(f.home, 'sessions', 'parent-partial.jsonl'), childPath = join(f.home, 'sessions', 'child-partial.jsonl');
  await seedIndex(f.home, [
    { id: parent, path: parentPath },
    { id: child, path: childPath, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } },
  ]);
  await writeRollout(parentPath, [meta(parent), context(parentTurn)]);
  await writeRollout(childPath, [rec('2026-10-15T10:00:00Z', 'session_meta', { id: child, session_id: parent, parent_thread_id: parent,
    source: { subagent: { thread_spawn: { parent_thread_id: parent } } }, forked_from_id: parent }), context(childTurn),
    rec('2026-10-15T10:00:02Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: childTurn,
      root_turn_id: parentTurn, total_token_usage: { input_tokens: 3 } }),
    rec('2026-10-15T10:00:03Z', 'event_msg', { type: 'diagnostic', ignored: 'x'.repeat(1024 * 1024 + 16) })]);
  const report = await auditNativeSession(f.store, 'A', parent);
  assert.equal(report.status, 'partial');
  assert.equal(report.agents.find(agent => agent.id === child)?.status, 'partial');
  assert.equal(report.coverage.timeline, 'partial');
  assert.ok(report.warnings.some(warning => warning.startsWith(`Child ${child}:`) && warning.includes('Oversized rollout line')));
});

test('bounds physical line parsing even when records are irrelevant', async t => {
  const f = await fixture(t), task = id(61), turn = id(62), path = join(f.home, 'sessions', 'many-lines.jsonl');
  await seedIndex(f.home, [{ id: task, path, source: 'cli' }]);
  await writeRollout(path, [meta(task), context(turn), ...Array.from({ length: 20 }, (_, i) => rec('2026-10-15T10:00:02Z', 'unknown_record', { i }))]);
  const report = await auditNativeSession(f.store, 'A', task, { maxPhysicalLines: 8 });
  assert.equal(report.status, 'partial');
  assert.ok(report.warnings.some(warning => warning.includes('Physical rollout line limit')));
  assert.deepEqual(report.turns.map(x => x.turnId), [turn]);
});

test('reports native FileChange truncation without overstating retained artifacts', async t => {
  const f = await fixture(t), task = id(71), turn = id(72), path = join(f.home, 'sessions', 'many-changes.jsonl');
  const changes = Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`/repo/file-${i}.txt`, { type: 'update', diff: 'PRIVATE DIFF' }]));
  await seedIndex(f.home, [{ id: task, path, source: 'cli' }]);
  await writeRollout(path, [meta(task), context(turn), rec('2026-10-15T10:00:02Z', 'event_msg', {
    type: 'item_completed', turn_id: turn, item: { type: 'FileChange', id: 'many', changes, status: 'completed', stdout: 'PRIVATE' },
  })]);
  const report = await auditNativeSession(f.store, 'A', task);
  const event = report.events.find(x => x.kind === 'file-change');
  assert.equal(report.status, 'partial');
  assert.equal(event.metadata.sourceChangeCount, 105);
  assert.equal(event.metadata.retainedChangeCount, 100);
  assert.equal(event.metadata.truncated, true);
  assert.equal(report.artifacts.length, 100);
  assert.ok(report.warnings.some(warning => warning.includes('file-change artifact limit')));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

test('classifies machine user, recorded project, and unrelated skill roots without scanning current files', async t => {
  const f = await fixture(t), task = id(81), turn = id(82), path = join(f.home, 'sessions', 'origins.jsonl');
  const text = `<skills_instructions>\n- machine-user: from machine user root (file: /machine-user/.agents/skills/machine-user/SKILL.md)\n- project: from recorded cwd ancestor (file: /workspace/.agents/skills/project/SKILL.md)\n- unrelated: unrelated root (file: /other/.agents/skills/unrelated/SKILL.md)\n- unrelated-codex: unrelated Codex root (file: /other/.codex/skills/unrelated-codex/SKILL.md)\n</skills_instructions>`;
  await seedIndex(f.home, [{ id: task, path, source: 'cli' }]);
  await writeRollout(path, [meta(task), context(turn, { cwd: '/workspace/project/subdir' }),
    rec('2026-10-15T10:00:02Z', 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] })]);
  const report = await auditNativeSession(f.store, 'A', task, { defaultUserHome: '/machine-user' });
  assert.equal(report.skills.find(x => x.name === 'machine-user').scope, 'user');
  assert.equal(report.skills.find(x => x.name === 'project').scope, 'project');
  assert.equal(report.skills.find(x => x.name === 'unrelated').scope, 'unknown');
  assert.equal(report.skills.find(x => x.name === 'unrelated-codex').scope, 'unknown');
});

test('uses corroborated cwd and native action evidence for bounded historical shell skill reads', async t => {
  const f = await fixture(t), task = id(91), turn = id(92), path = join(f.home, 'sessions', 'shell-reads.jsonl');
  const skillPath = '/repo/.agents/skills/xfx-audit-acceptance/SKILL.md';
  const session = meta(task); session.payload.cwd = '/repo';
  const catalog = `<skills_instructions>\n- xfx-audit-acceptance: fixture skill (file: ${skillPath})\n</skills_instructions>`;
  const command = (key, cmd, cwd = 'file:///repo') => rec('2026-10-15T10:00:03Z', 'event_msg', { type: 'item_completed', turn_id: turn,
    item: { type: 'CommandExecution', id: key, command: ['/bin/zsh', '-lc', cmd], cwd,
      parsed_cmd: [{ type: 'unknown', cmd: 'redacted' }], status: 'completed', exit_code: 0 } });
  await seedIndex(f.home, [{ id: task, path, source: 'cli' }]);
  await writeRollout(path, [session,
    rec('2026-10-15T10:00:00.500Z', 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: catalog }] }),
    context(turn, { cwd: '/repo' }),
    command('single-cat', 'cat .agents/skills/xfx-audit-acceptance/SKILL.md fixture.json'),
    command('compound', 'cat .agents/skills/xfx-audit-acceptance/SKILL.md; true'),
    command('substitution', 'cat "$(echo .agents/skills/xfx-audit-acceptance/SKILL.md)"'),
    command('comment', 'cat fixture.json # .agents/skills/xfx-audit-acceptance/SKILL.md'),
    command('glob', 'cat .agents/skills/*/SKILL.md'),
    command('embedded-quote', `cat .agents/skills/xfx-audit-acceptance/SKILL.md'quoted`),
    command('unknown-cwd', 'cat .agents/skills/xfx-audit-acceptance/SKILL.md', 'file:///other'),
    command('cwd-query', 'cat .agents/skills/xfx-audit-acceptance/SKILL.md', 'file:///repo?ignored=1'),
    rec('2026-10-15T10:00:04Z', 'event_msg', { type: 'item_completed', turn_id: turn,
      item: { type: 'CommandExecution', id: 'native-shell-read', command: ['/bin/zsh', '-lc', 'cat .agents/skills/xfx-audit-acceptance/SKILL.md'],
        cwd: 'file:///repo', parsed_cmd: [{ type: 'read', path: skillPath }], status: 'completed', exit_code: 0 } }),
    rec('2026-10-15T10:00:05Z', 'event_msg', { type: 'item_completed', turn_id: turn,
      item: { type: 'CommandExecution', id: 'multiple-native-reads', command: ['/bin/zsh', '-lc', 'cat .agents/skills/xfx-audit-acceptance/SKILL.md'],
        cwd: 'file:///repo', parsed_cmd: [{ type: 'read', path: skillPath }, { type: 'read', path: skillPath }], status: 'completed', exit_code: 0 } })]);
  const report = await auditNativeSession(f.store, 'A', task);
  const skill = report.skills.find(x => x.name === 'xfx-audit-acceptance');
  assert.equal(skill.scope, 'project');
  assert.equal(skill.observations.filter(x => x.kind === 'resource-read-intent').length, 2, JSON.stringify({ skill, events: report.events }));
  assert.equal(skill.observations.filter(x => x.kind === 'definition-read-observed').length, 1);
  assert.equal(skill.observations.filter(x => x.kind === 'definition-read-observed' && x.sourceLine === report.events.find(event => event.metadata.id === 'native-shell-read')?.sourceLine).length, 1);
  assert.equal(skill.observations.filter(x => x.kind === 'definition-read-observed' && x.sourceLine === report.events.find(event => event.metadata.id === 'multiple-native-reads')?.sourceLine).length, 0);
  assert.equal(skill.observations.find(x => x.kind === 'resource-read-intent').evidence.confidence, 'parsed-read-intent');
  assert.doesNotMatch(JSON.stringify(report), /cat \.agents|fixture\.json|redacted/);
});

test('historical absolute cat reads require one matching unknown action, recorded cwd and actor catalog', async t => {
  const f = await fixture(t), task = id(93), turn = id(94), path = join(f.home, 'sessions', 'absolute-reads.jsonl');
  // Reconstructed scaffolding with the native .163 retained item_completed
  // shape (audit-absolute-reads-receipts-acceptance.json). These paths never
  // existed: neither attribution nor alias resolution may use the filesystem.
  const skillPath = '/recorded/.agents/skills/example/SKILL.md';
  const inner = `/bin/cat '${skillPath}'`;
  const nativeItem = { type: 'CommandExecution', command: ['/bin/zsh', '-lc', inner], cwd: 'file:///repo',
    parsed_cmd: [{ type: 'unknown', cmd: inner }], status: 'completed', exit_code: 0, aggregated_output: 'PRIVATE OUTPUT' };
  const cases = [
    ['valid', {}, true],
    ['usr-bin', { command: ['/bin/sh', '-c', `/usr/bin/cat '${skillPath}'`], parsed_cmd: [{ type: 'unknown', cmd: `/usr/bin/cat '${skillPath}'` }] }, true],
    ['relative', { command: ['/bin/zsh', '-lc', '/bin/cat ../recorded/.agents/skills/example/SKILL.md'],
      parsed_cmd: [{ type: 'unknown', cmd: '/bin/cat ../recorded/.agents/skills/example/SKILL.md' }] }, false],
    ['relative-valid', { cwd: 'file:///recorded', command: ['/bin/zsh', '-lc', '/bin/cat .agents/skills/example/SKILL.md'],
      parsed_cmd: [{ type: 'unknown', cmd: `/bin/cat '${skillPath}'` }] }, true],
    ['direct', { command: ['/bin/cat', skillPath] }, true],
    ['package', { command: ['/bin/zsh', '-lc', `/bin/cat '${skillPath.replace('SKILL.md', 'guide.md')}'`],
      parsed_cmd: [{ type: 'unknown', cmd: `/bin/cat '${skillPath.replace('SKILL.md', 'guide.md')}'` }] }, true],
    ['failed', { exit_code: 1 }, false],
    ['missing-exit', { exit_code: null }, false],
    ['pending', { status: 'inProgress' }, false],
    ['compound', { command: ['/bin/zsh', '-lc', `${inner}; true`] }, false],
    ['expansion', { command: ['/bin/zsh', '-lc', '/bin/cat "$PRIVATE/SKILL.md"'] }, false],
    ['missing', { parsed_cmd: [] }, false],
    ['multiple', { parsed_cmd: [nativeItem.parsed_cmd[0], nativeItem.parsed_cmd[0]] }, false],
    ['mixed', { parsed_cmd: [nativeItem.parsed_cmd[0], { type: 'unknown', cmd: 'true' }] }, false],
    ['mismatch', { parsed_cmd: [{ type: 'unknown', cmd: '/bin/cat /different/SKILL.md' }] }, false],
    ['non-absolute', { command: ['/bin/zsh', '-lc', `cat '${skillPath}'`], parsed_cmd: [{ type: 'unknown', cmd: `cat '${skillPath}'` }] }, false],
    ['non-absolute-action', { parsed_cmd: [{ type: 'unknown', cmd: `cat '${skillPath}'` }] }, false],
    ['wrapped-action', { parsed_cmd: [{ type: 'unknown', cmd: `/bin/zsh -c "${inner}"` }] }, false],
    ['wrapped-inner', { command: ['/bin/zsh', '-lc', `/bin/zsh -c "${inner}"`] }, false],
    ['unknown-cwd', { cwd: 'file:///elsewhere' }, false],
    ['missing-cwd', { cwd: null }, false],
    ['cwd-query', { cwd: 'file:///repo?private=1' }, false],
    ['uncatalogued', { command: ['/bin/zsh', '-lc', '/bin/cat /uncatalogued/SKILL.md'], parsed_cmd: [{ type: 'unknown', cmd: '/bin/cat /uncatalogued/SKILL.md' }] }, false],
    ['no-invented-alias', { command: ['/bin/zsh', '-lc', '/bin/cat /alias/SKILL.md'], parsed_cmd: [{ type: 'unknown', cmd: '/bin/cat /alias/SKILL.md' }] }, false],
    ['uri-operand', { command: ['/bin/zsh', '-lc', `/bin/cat 'file://${skillPath}'`], parsed_cmd: [{ type: 'unknown', cmd: `/bin/cat 'file://${skillPath}'` }] }, false],
    ['ambiguous', { command: ['/bin/zsh', '-lc', '/bin/cat /ambiguous/SKILL.md'], parsed_cmd: [{ type: 'unknown', cmd: '/bin/cat /ambiguous/SKILL.md' }] }, false],
  ];
  await seedIndex(f.home, [{ id: task, path, source: 'cli' }]);
  const session = meta(task); session.payload.cwd = '/recorded';
  await writeRollout(path, [session, context(turn, { skills: [{ name: 'example', path: skillPath },
    ...['one', 'two'].map(provider => ({ name: 'same', path: '/ambiguous/SKILL.md', provider }))] }),
    ...cases.map(([key, changes]) => rec('2026-10-19T07:00:00Z', 'event_msg', { type: 'item_completed', turn_id: turn,
      item: { ...nativeItem, id: key, ...changes } })),
    context(id(95), { skills: [{ name: 'late-catalog', path: '/uncatalogued/SKILL.md' }] })]);
  const report = await auditNativeSession(f.store, 'A', task);
  const reads = report.skills.flatMap(skill => skill.observations).filter(o => /^(definition|package-resource)-read-observed$/.test(o.kind));
  for (const [key, , expected] of cases) {
    const line = report.events.find(event => event.metadata?.id === key)?.sourceLine;
    assert.ok(line, key);
    assert.equal(reads.filter(o => o.sourceLine === line).length, expected ? 1 : 0, key);
  }
  for (const read of reads) {
    assert.equal(read.agentId, task);
    assert.equal(read.turnId, turn);
    assert.equal(read.evidence.readCorroboration, 'native-unknown-absolute-cat');
  }
  assert.equal(report.coverage.skills, 'partial');
  assert.equal(auditExitCode(report), 2);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE OUTPUT|aggregated_output|parsed_cmd|\/bin\/cat/);

  const compact = compactAuditTrial({ runs: [report] }).runs[0];
  assert.equal(compact.skills.flatMap(s => s.observations).filter(o => o.readCorroboration === 'native-unknown-absolute-cat').length, reads.length);
  for (const value of [report, { ...compact, kind: 'audit-run', schemaVersion: 1 }, compareAuditRuns(report, report), compareAuditRuns(compact, compact)]) {
    assert.match(renderAudit(value), /read corroboration native-unknown-absolute-cat/);
    assert.equal(auditExitCode(value), 2);
    for (const format of ['json', 'markdown']) {
      const exported = await exportAuditReport(value, { output: join(f.root, `${randomUUID()}.${format}`), format });
      const reopened = await readAuditReport(exported.evidencePath);
      assert.deepEqual(reopened, JSON.parse(JSON.stringify(value)));
      assert.equal(auditExitCode(reopened), 2);
    }
  }
});

test('historical absolute cat reads do not inherit a parent catalog', async t => {
  const f = await fixture(t), parent = id(96), child = id(97), parentTurn = id(98), childTurn = id(99);
  const skillPath = '/recorded/skills/parent-only/SKILL.md', cmd = `/bin/cat '${skillPath}'`;
  const paths = [parent, child].map(agent => join(f.home, 'sessions', `${agent}.jsonl`));
  await seedIndex(f.home, [{ id: parent, path: paths[0], source: 'cli' },
    { id: child, path: paths[1], source: { subagent: { thread_spawn: { parent_thread_id: parent } } } }]);
  const item = { type: 'CommandExecution', id: 'read', command: ['/bin/zsh', '-lc', cmd], cwd: 'file:///repo',
    parsed_cmd: [{ type: 'unknown', cmd }], status: 'completed', exit_code: 0 };
  await writeRollout(paths[0], [meta(parent), context(parentTurn, { skills: [{ name: 'parent-only', path: skillPath }] }),
    rec('2026-10-19T07:00:00Z', 'event_msg', { type: 'item_completed', turn_id: parentTurn, item })]);
  const childMeta = meta(child); Object.assign(childMeta.payload, { session_id: parent, parent_thread_id: parent,
    source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });
  await writeRollout(paths[1], [childMeta, context(childTurn),
    rec('2026-10-19T07:00:00Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: childTurn, root_turn_id: parentTurn }),
    rec('2026-10-19T07:00:00Z', 'event_msg', { type: 'item_completed', turn_id: childTurn, item })]);
  const report = await auditNativeSession(f.store, 'A', parent);
  assert.ok(report.agents.some(agent => agent.id === child && agent.status !== 'unavailable'));
  assert.deepEqual(report.skills.flatMap(skill => skill.observations).filter(o => o.kind === 'definition-read-observed').map(o => o.agentId), [parent]);
});

test('historical child reads require catalogs and cwd evidence that survive turn ownership filtering', async t => {
  const f = await fixture(t), parent = id(101), child = id(102), inherited = id(103), own = id(104);
  const paths = [parent, child].map(agent => join(f.home, 'sessions', `${agent}.jsonl`));
  await seedIndex(f.home, [{ id: parent, path: paths[0], source: 'cli' },
    { id: child, path: paths[1], source: { subagent: { thread_spawn: { parent_thread_id: parent } } } }]);
  await writeRollout(paths[0], [meta(parent), context(inherited)]);
  const childMeta = meta(child); Object.assign(childMeta.payload, { session_id: parent, parent_thread_id: parent,
    source: { subagent: { thread_spawn: { parent_thread_id: parent } } } });
  const unownedPath = '/recorded/skills/unowned-catalog/SKILL.md', ownedPath = '/recorded/skills/owned-catalog/SKILL.md';
  const command = (key, path, cwd, nativeRead = false) => rec('2026-10-19T07:00:00Z', 'event_msg', { type: 'item_completed', turn_id: own,
    item: { type: 'CommandExecution', id: key, command: ['/bin/zsh', '-lc', `/bin/cat '${path}'`], cwd,
      parsed_cmd: [nativeRead ? { type: 'read', path } : { type: 'unknown', cmd: `/bin/cat '${path}'` }], status: 'completed', exit_code: 0 } });
  await writeRollout(paths[1], [childMeta,
    context(undefined, { cwd: '/no-turn', skills: [{ name: 'unattributable', path: '/recorded/skills/no-turn/SKILL.md' }] }),
    context(inherited, { cwd: '/inherited', skills: [{ name: 'unowned', path: unownedPath },
      { name: 'unowned-provider', path: ownedPath, provider: 'unowned-provider' }] }),
    context(own, { cwd: '/child', skills: [{ name: 'owned', path: ownedPath, provider: 'owned-provider' }] }),
    command('unowned-catalog', unownedPath, '/child'),
    command('unowned-native-read-catalog', unownedPath, '/child', true),
    command('unowned-cwd', ownedPath, '/inherited'),
    command('parent-cwd', ownedPath, '/repo'),
    command('unattributable-cwd', ownedPath, '/no-turn'),
    command('unattributable-catalog', '/recorded/skills/no-turn/SKILL.md', '/child'),
    command('owned', ownedPath, '/child'),
    rec('2026-10-19T07:00:01Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: own, root_turn_id: inherited })]);
  const report = await auditNativeSession(f.store, 'A', parent);
  assert.ok(report.agents.some(agent => agent.id === child && agent.status !== 'unavailable'));
  const reads = report.skills.flatMap(skill => skill.observations).filter(o => o.kind === 'definition-read-observed');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].agentId, child);
  assert.equal(reads[0].sourceLine, report.events.find(event => event.metadata?.id === 'owned').sourceLine);
  assert.equal(report.coverage.skills, 'partial');
  assert.equal(auditExitCode(report), 2);
});

test('marks same-home agent discovery partial when the candidate scan is capped', async t => {
  const f = await fixture(t), task = id(41), child = id(42), turn = id(43);
  const path = join(f.home, 'sessions', 'root.jsonl');
  await seedIndex(f.home, [
    { id: task, path, source: 'exec' },
    { id: child, path: join(f.home, 'sessions', 'child-missing.jsonl'), source: { subagent: { thread_spawn: { parent_thread_id: task } } } },
  ]);
  await writeRollout(path, [meta(task), context(turn)]);
  const report = await auditNativeSession(f.store, 'A', task, { maxChildCandidates: 1 });
  assert.equal(report.status, 'partial');
  assert.ok(report.warnings.some(warning => warning.includes('candidate scan limit')));
});

test('auditing a selected child verifies its indexed parent and excludes inherited turns', async t => {
  const f = await fixture(t), parent = id(51), child = id(52), inherited = id(53), own = id(54);
  const parentPath = join(f.home, 'sessions', 'selected-parent.jsonl'), childPath = join(f.home, 'sessions', 'selected-child.jsonl');
  await seedIndex(f.home, [
    { id: parent, path: parentPath, source: 'cli' },
    { id: child, path: childPath, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } },
  ]);
  await writeRollout(parentPath, [meta(parent), context(inherited)]);
  await writeRollout(childPath, [rec('2026-10-15T10:00:00Z', 'session_meta', { id: child, session_id: parent, parent_thread_id: parent,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } }, forked_from_id: parent }), context(inherited), context(own),
    rec('2026-10-15T10:00:03Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: own, root_turn_id: inherited }),
    rec('2026-10-15T10:00:04Z', 'event_msg', { type: 'task_started', turn_id: own })]);
  const report = await auditNativeSession(f.store, 'A', child);
  assert.equal(report.status, 'ready');
  assert.equal(report.agents[0].parentId, parent); assert.equal(report.agents[0].depth, 1);
  assert.deepEqual(report.turns.map(x => x.turnId), [own]);
  assert.equal(report.metrics.recordedSpanMs, 3000);
  assert.equal(report.metrics.recordedSpanKind, 'owned-turn-evidence');
});
