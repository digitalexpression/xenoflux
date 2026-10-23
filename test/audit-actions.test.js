import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditRetainedNativeSession } from '../src/audit-session.js';
import { extractNamedActions, isNamedAuditAction, unambiguousExitCode } from '../src/audit-actions.js';

const root = '/workspace/xenoflux';
const completed = (item, sourceLine = 7) => [{ type: 'event_msg', sourceLine,
  payload: { type: 'item_completed', turn_id: 'turn-1', item } }];
const custom = input => ({ type: 'custom_tool_call', name: 'exec', call_id: 'call-1', input, status: 'completed' });

test('extracts literal repo reads and exact visible test invocations', () => {
  const read = extractNamedActions(completed({ type: 'CommandExecution', id: 'c1', cwd: root,
    command: ['/bin/cat', 'src/audit-session.js'], exit_code: 0 }), { repoRoot: root })[0];
  assert.deepEqual(read && { kind: read.kind, targets: read.targets, exitCode: read.exitCode },
    { kind: 'read', targets: ['src/audit-session.js'], exitCode: 0 });

  const testCall = custom('text(await tools.exec_command({"cmd": "node --test test/audit-actions.test.js", "workdir": "/workspace/xenoflux", "max_output_tokens": 1000}));');
  const action = extractNamedActions(completed(testCall), { repoRoot: root })[0];
  assert.equal(action?.kind, 'visible-test');
  assert.deepEqual(action?.targets, ['test/audit-actions.test.js']);
});

test('keeps newline-only multi-file cat reads scoped to the whole invocation', () => {
  const command = 'cat src/booking-ledger.js\ncat test/visible.test.js\ncat package.json';
  const input = `text(await tools.exec_command({"cmd": ${JSON.stringify(command)}, "workdir": ${JSON.stringify(root)}}));`;
  const action = extractNamedActions(completed(custom(input)), { repoRoot: root })[0];
  assert.equal(action?.kind, 'read');
  assert.deepEqual(action?.targets, ['src/booking-ledger.js', 'test/visible.test.js', 'package.json']);
  assert.equal(action?.resultScope, 'invocation');
  assert.deepEqual(extractNamedActions(completed(custom(input.replace('\\ncat test/visible.test.js', '\\nrg --files'))), { repoRoot: root }), []);
});

test('extracts patch file headers without retaining patch content', () => {
  const patchText = '*** Begin Patch\n*** Update File: src/audit-session.js\n@@\n-secret phrase in body\n*** End Patch';
  const input = `text(await tools.apply_patch(${JSON.stringify(patchText)}));`;
  const action = extractNamedActions(completed(custom(input)), { repoRoot: root })[0];
  assert.equal(action?.kind, 'edit');
  assert.deepEqual(action?.targets, ['src/audit-session.js']);
  assert.equal(JSON.stringify(action).includes('secret phrase'), false);
});

test('parses exact sequential patch and test calls with output-position indexes', () => {
  const patchText = '*** Begin Patch\n*** Update File: /workspace/xenoflux/src/audit-session.js\n@@\nprivate patch body\n*** End Patch';
  const input = `text(await tools.apply_patch(${JSON.stringify(patchText)}));\ntext(await tools.exec_command({"cmd": "node --test test/audit-actions.test.js", "max_output_tokens": 1000}));`;
  const actions = extractNamedActions(completed(custom(input)), { repoRoot: root });
  assert.deepEqual(actions.map(action => [action.kind, action.targets, action.invocationIndex]), [
    ['edit', ['src/audit-session.js'], 0], ['visible-test', ['test/audit-actions.test.js'], 1],
  ]);
});

test('extracts finite input subjects from literal inline assertions only', () => {
  const command = `node --input-type=module <<'ASSERT'
import assert from 'node:assert/strict';
assert.equal(Number.MAX_SAFE_INTEGER, 1);
assert.throws(() => decodeEvent(null, [], Symbol()));
ASSERT`;
  const input = `text(await tools.exec_command({cmd: ${JSON.stringify(command)}, workdir: "/workspace/xenoflux"}));`;
  const action = extractNamedActions(completed(custom(input)), { repoRoot: root })[0];
  assert.equal(action?.kind, 'inline-assertion');
  assert.deepEqual(action?.subjects, ['maximum-safe-integer', 'null-input', 'array-input', 'symbol-input']);
  assert.equal(JSON.stringify(action).includes('assert.equal'), false);
});

test('does not grant inline assertion evidence from comments or string text', () => {
  const script = `// assert.equal(Number.MAX_SAFE_INTEGER, null, [], Symbol());
const note = "assert.throws(() => parseEvent(null))";
console.log(note);`;
  const command = `node --input-type=module <<'SPOOF'\n${script}\nSPOOF`;
  const input = `text(await tools.exec_command({"cmd": ${JSON.stringify(command)}}));`;
  assert.deepEqual(extractNamedActions(completed(custom(input)), { repoRoot: root }), []);
});

test('rejects spoofed labels, comments, strings, dynamic wrappers, and unsupported commands', () => {
  const cases = [
    'ordinary prose: cat src/audit-session.js',
    '/* text(await tools.exec_command({cmd: "cat src/audit-session.js"})); */',
    'text(await tools.exec_command({cmd: makeCommand()}));',
    'text(await tools.exec_command({cmd: "cat ../outside.txt", workdir: "/workspace/xenoflux"}));',
    'text(await tools.exec_command({cmd: "cat /private/secret", workdir: "/workspace/xenoflux"}));',
    'text(await tools.exec_command({cmd: "node --test test/audit-actions.test.js; echo done", workdir: "/workspace/xenoflux"}));',
  ];
  for (const input of cases) assert.deepEqual(extractNamedActions(completed(custom(input)), { repoRoot: root }), []);
  assert.deepEqual(extractNamedActions(completed({ type: 'CommandExecution', cwd: '/other/repo',
    command: ['/bin/cat', 'src/file.js'], exit_code: 0 }), { repoRoot: root }), []);
});

test('keeps missing exit and source references explicit without copying payloads', () => {
  const action = extractNamedActions(completed({ type: 'CommandExecution', id: 'call-safe', cwd: root,
    command: ['/bin/cat', 'src/audit-session.js'] }), { repoRoot: root, sourceFingerprint: 'a'.repeat(64) })[0];
  assert.equal(action.exitCode, null);
  assert.equal(action.sourceLine, 7);
  assert.equal(action.resultSourceLine, 7);
  assert.equal(action.sourceFingerprint, 'a'.repeat(64));
  assert.equal(JSON.stringify(action).includes('/workspace'), false);
  assert.equal(isNamedAuditAction(action), true);
});

test('recognizes only exact response-item wrappers and unambiguous structured exit codes', () => {
  const input = 'text(await tools.exec_command({cmd: "cat src/audit-session.js", workdir: "/workspace/xenoflux"}));';
  const action = extractNamedActions([{ type: 'response_item', sourceLine: 12,
    payload: { turn_id: 'turn-1', item: { type: 'custom_tool_call', name: 'exec', call_id: 'call-1', input } } }], { repoRoot: root })[0];
  assert.equal(action?.kind, 'read');
  assert.equal(action?.callId, 'call-1');
  assert.equal(action?.sourceLine, 12);
  assert.deepEqual(extractNamedActions([{ type: 'response_item', sourceLine: 12,
    payload: { turn_id: 'turn-1', item: { type: 'custom_tool_call', name: 'other-tool', call_id: 'call-1', input } } }], { repoRoot: root }), []);
  assert.equal(unambiguousExitCode(JSON.parse(JSON.stringify({ exit_code: 0 }))), 0);
  assert.equal(unambiguousExitCode([{ exit_code: 0 }, { exit_code: 1 }]), null);
  assert.equal(unambiguousExitCode({ text: 'exit_code: 0' }), null);
});

test('replays one exact retained rollout without an index and removes native private paths', async t => {
  const tempHome = await mkdtemp(join(tmpdir(), 'xfx-retained-actions-'));
  t.after(() => rm(tempHome, { recursive: true, force: true }));
  const home = await realpath(tempHome);
  const id = '00000000-0000-4000-8000-000000000001', turnId = '00000000-0000-4000-8000-000000000002';
  const directory = join(home, 'sessions', '2026', '10', '22');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records = [
    { type: 'session_meta', payload: { id, session_id: id, cwd: root, cli_version: '0.153.4' } },
    { type: 'turn_context', payload: { turn_id: turnId, cwd: root, model: 'gpt-test', effort: 'medium' } },
    { type: 'response_item', payload: { turn_id: turnId, item: { type: 'custom_tool_call', call_id: 'call-safe', name: 'exec',
      input: `text(await tools.exec_command({"cmd": "node --test test/visible.test.js", "workdir": ${JSON.stringify(root)}}));` } } },
    { type: 'response_item', payload: { turn_id: turnId, item: { type: 'custom_tool_call_output', call_id: 'call-safe',
      output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: JSON.stringify({ exit_code: 0 }) }] } } },
  ];
  await writeFile(join(directory, `rollout-test-${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
  const run = await auditRetainedNativeSession({ profileId: 'profile-id', profileName: 'Saved', home,
    userHome: join(home, 'user-home'), environmentId: 'env-id' }, id, { actionRepoRoot: root });
  assert.equal(run.status, 'ready');
  assert.equal(run.source.fingerprint.length, 64);
  assert.deepEqual(run.turns, [{ agentId: id, turnId, model: 'gpt-test', reasoningEffort: 'medium', sourceLine: 2, workspaceMatched: true }]);
  assert.deepEqual(run.actions.map(action => ({ kind: action.kind, targets: action.targets, turnId: action.turnId,
    sourceLine: action.sourceLine, resultSourceLine: action.resultSourceLine, resultIndex: action.resultIndex, exitCode: action.exitCode })), [
    { kind: 'visible-test', targets: ['test/visible.test.js'], turnId, sourceLine: 3, resultSourceLine: 4, resultIndex: 1, exitCode: 0 },
  ]);
  assert.equal(JSON.stringify(run).includes(home), false);
  assert.equal(JSON.stringify(run).includes('/workspace'), false);
});

test('pairs outputs by both turn and call ID, and drops duplicated output outcomes', async t => {
  const tempHome = await mkdtemp(join(tmpdir(), 'xfx-action-pairing-'));
  t.after(() => rm(tempHome, { recursive: true, force: true }));
  const home = await realpath(tempHome);
  const id = '00000000-0000-4000-8000-000000000011';
  const turns = ['00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000014'];
  const directory = join(home, 'sessions', '2026', '10', '22');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const input = 'text(await tools.exec_command({"cmd": "node --test test/visible.test.js", "workdir": "/workspace/xenoflux"}));';
  const output = (turnId, exit_code) => ({ type: 'response_item', payload: { turn_id: turnId,
    item: { type: 'custom_tool_call_output', call_id: 'same-call', output: [{ type: 'input_text', text: JSON.stringify({ exit_code }) }] } } });
  const records = [
    { type: 'session_meta', payload: { id, session_id: id, cwd: root, cli_version: '0.153.4' } },
    { type: 'turn_context', payload: { turn_id: turns[0], cwd: root, model: 'gpt-test', effort: 'medium' } },
    { type: 'response_item', payload: { turn_id: turns[0], item: { type: 'custom_tool_call', name: 'exec', call_id: 'same-call', input } } },
    { type: 'turn_context', payload: { turn_id: turns[1], cwd: root, model: 'gpt-test', effort: 'medium' } },
    { type: 'response_item', payload: { turn_id: turns[1], item: { type: 'custom_tool_call', name: 'exec', call_id: 'same-call', input } } },
    { type: 'turn_context', payload: { turn_id: turns[2], cwd: '/workspace/other', model: 'gpt-test', effort: 'medium' } },
    { type: 'response_item', payload: { turn_id: turns[2], item: { type: 'custom_tool_call', name: 'exec', call_id: 'foreign-call', input } } },
    output(turns[0], 0), output(turns[1], 1), output(turns[0], 2), output(turns[2], 0),
    { type: 'turn_context', payload: { turn_id: turns[2], cwd: root, model: 'gpt-test', effort: 'medium' } },
  ];
  await writeFile(join(directory, `rollout-test-${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
  const run = await auditRetainedNativeSession({ profileId: 'profile-id', profileName: 'Saved', home,
    userHome: join(home, 'user-home'), environmentId: 'env-id' }, id, { actionRepoRoot: root });
  assert.equal(run.status, 'ready');
  assert.equal(run.actionCoverage, 'partial');
  assert.deepEqual(run.actions.map(action => [action.turnId, action.exitCode, action.resultSourceLine]), [
    [turns[0], null, null], [turns[1], 1, 9],
  ]);
  assert.deepEqual(run.turns.filter(turn => turn.turnId === turns[2]).map(turn => turn.workspaceMatched), [false, false]);
  assert.equal(JSON.stringify(run).includes('/workspace/other'), false);
});
