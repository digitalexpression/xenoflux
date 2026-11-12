import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importClaudeTranscript } from '../src/claude-transcript.js';
import { compareAuditRuns } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
import { buildAuditReviewPacket } from '../src/audit-review.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const assistantId = '33333333-3333-4333-8333-333333333333';
const fileName = `${sessionId}.jsonl`;
const sha = text => createHash('sha256').update(text).digest('hex');
function rows(content = [{ type: 'text', text: 'PUBLIC ANSWER' }]) {
  return [
    { type: 'user', uuid: userId, sessionId, parentUuid: null, timestamp: '2026-11-10T00:00:00Z',
      cwd: '/nonexistent/original-project', message: { role: 'user', content: 'PUBLIC QUESTION' } },
    { type: 'assistant', uuid: assistantId, sessionId, parentUuid: userId, timestamp: '2026-11-10T00:00:01Z',
      message: { role: 'assistant', model: 'UNVERIFIED MODEL', usage: { input_tokens: 10 }, content } },
  ];
}
const encode = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-claude-transcript-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, 'import') };
}

test('official SDK reads a bounded private snapshot and preserves actual IDs with explicit projection provenance', async t => {
  const f = await fixture(t), text = encode(rows());
  const run = await importClaudeTranscript({ fileName, text }, f);
  assert.equal(run.kind, 'audit-run'); assert.equal(run.status, 'partial');
  assert.notEqual(run.id, sessionId); assert.equal(run.profile.profileName, 'Imported Claude Code');
  assert.deepEqual(run.clientIdentity, { client: 'claude-code' });
  for (const key of ['environmentBinding', 'nativeReference', 'usage', 'checks', 'model', 'account']) assert.equal(Object.hasOwn(run, key), false);
  assert.equal(run.source.nativeSessionId, sessionId); assert.equal(run.source.rawSourceSha256, sha(text));
  assert.equal(run.source.decoder, '@anthropic-ai/claude-agent-sdk@0.3.322');
  assert.equal(run.source.sourceLineBasis, 'sanitized-sdk-message-snapshot-ordinal');
  assert.equal(Object.hasOwn(run.source, 'lastModified'), false, 'snapshot mtime must not become original session time');
  const sanitized = await readFile(join(f.directory, 'sdk-messages.jsonl'), 'utf8');
  const fingerprint = sha(sanitized), session = run.sessionReplay.sessions[0];
  assert.equal(session.source.fingerprint, fingerprint); assert.equal(run.source.projectionSha256, fingerprint);
  assert.equal(session.id, sessionId); assert.equal(session.status, 'partial');
  assert.deepEqual(session.events.map(event => event.itemId), [userId, assistantId]);
  assert.deepEqual(session.events.map(event => event.role), ['user', 'assistant']);
  assert.deepEqual(session.events.map(event => event.turnId), [null, null]);
  assert.deepEqual(session.events.map(event => event.sourceLine), [1, 2]);
  assert.equal(session.events[1].id, `${sessionId}:${fingerprint}:2`);
  assert.equal(session.events[1].timestamp, '2026-11-10T00:00:01.000Z');
  assert.equal(await readFile(join(f.directory, 'source.jsonl'), 'utf8'), text);
  assert.equal((await stat(f.directory)).mode & 0o077, 0);
  assert.equal((await stat(join(f.directory, 'source.jsonl'))).mode & 0o077, 0);
});

test('thinking, signatures, opaque/system/tool content never reaches retained public projection, reports or review context', async t => {
  const f = await fixture(t), privateCanary = 'THINKING_SECRET_DO_NOT_EXPORT';
  const records = rows([{ type: 'text', text: 'PUBLIC ANSWER' },
    { type: 'thinking', thinking: privateCanary, signature: 'SIGNATURE_SECRET' },
    { type: 'redacted_thinking', data: 'OPAQUE_SECRET' }, { type: 'tool_use', id: 'tool', input: { command: 'TOOL_SECRET' } }]);
  records[1].message.signature = 'TOPLEVEL_SIGNATURE_SECRET';
  records.push({ type: 'user', uuid: '44444444-4444-4444-8444-444444444444', sessionId, parentUuid: assistantId, timestamp: '2026-11-10T00:00:02Z', message: { role: 'user', content: [{ type: 'text', text: 'PUBLIC FOLLOWUP' }, { type: 'tool_result', content: 'TOOL_RESULT_SECRET' }] } });
  records.push({ type: 'system', uuid: '55555555-5555-4555-8555-555555555555', sessionId, parentUuid: '44444444-4444-4444-8444-444444444444', timestamp: '2026-11-10T00:00:03Z', message: { role: 'system', content: 'SYSTEM_SECRET' } });
  const text = encode(records), run = await importClaudeTranscript({ fileName, text }, f);
  const serialized = JSON.stringify(run), sanitized = await readFile(join(f.directory, 'sdk-messages.jsonl'), 'utf8');
  for (const secret of [privateCanary, 'SIGNATURE_SECRET', 'OPAQUE_SECRET', 'TOOL_SECRET', 'TOOL_RESULT_SECRET', 'SYSTEM_SECRET', 'TOPLEVEL_SIGNATURE_SECRET']) {
    assert.equal(serialized.includes(secret), false); assert.equal(sanitized.includes(secret), false);
  }
  assert.equal(run.sessionReplay.sessions[0].events[1].body, 'PUBLIC ANSWER');
  assert.equal(run.sessionReplay.sessions[0].events[1].contentOmitted, true);
  assert.ok(run.sessionReplay.sessions[0].limits.some(limit => limit.kind === 'nonTextBlocks' && limit.omitted === 4));
  assert.match(await readFile(join(f.directory, 'source.jsonl'), 'utf8'), /THINKING_SECRET_DO_NOT_EXPORT/, 'original evidence stays private');
  const second = structuredClone(run); second.id = randomUUID();
  const comparison = compareAuditRuns(run, second);
  const packet = buildAuditReviewPacket(comparison, { includeRecordedContent: true });
  assert.equal(JSON.stringify(packet).includes(privateCanary), false);
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = () => assert.fail('Export/reopen must never spawn the SDK or native client');
  try {
    const receipt = await exportAuditReport(comparison, { output: join(f.root, 'comparison.json'), includeReplayContent: true });
    const defaultReceipt = await exportAuditReport(comparison, { output: join(f.root, 'default.json') });
    await rm(f.directory, { recursive: true });
    const reopened = await readAuditReport(receipt.evidencePath);
    assert.equal(JSON.stringify(reopened).includes(privateCanary), false);
    assert.match(JSON.stringify(reopened), /PUBLIC ANSWER/);
    assert.match(JSON.stringify(reopened), /claude-code-sdk-file-import/);
    assert.match(JSON.stringify(reopened), new RegExp(assistantId));
    const defaults = await readAuditReport(defaultReceipt.evidencePath);
    assert.equal(defaults.left.sessionReplay.sessions[0].events[0].bodyStatus, 'omitted');
    assert.equal(JSON.stringify(defaults).includes('PUBLIC ANSWER'), false);
  } finally { childProcess.ChildProcess.prototype.spawn = originalSpawn; }
});

test('missing summary metadata does not block SDK-confirmed public messages or invent original metadata', async t => {
  const f = await fixture(t), records = rows();
  records[0].message.content = [{ type: 'text', text: 'PUBLIC QUESTION' }, { type: 'tool_result', content: 'TOOL_RESULT_SECRET' }];
  const run = await importClaudeTranscript({ fileName, text: encode(records) }, f);
  assert.deepEqual(run.sessionReplay.sessions[0].events.map(event => event.itemId), [userId, assistantId]);
  assert.equal(run.sessionReplay.sessions[0].events[0].body, 'PUBLIC QUESTION');
  assert.equal(JSON.stringify(run).includes('TOOL_RESULT_SECRET'), false);
  for (const key of ['lastModified', 'fileSize', 'createdAt', 'originalVersion']) assert.equal(Object.hasOwn(run.source, key), false);
});

test('oversized public bodies are omitted with limits, never silently presented as complete', async t => {
  const f = await fixture(t), text = encode(rows([{ type: 'text', text: 'a'.repeat(1024 * 1024 + 1) }]));
  const run = await importClaudeTranscript({ fileName, text }, f), session = run.sessionReplay.sessions[0];
  assert.equal(session.events[1].body, null); assert.equal(session.events[1].bodyStatus, 'omitted');
  assert.equal(session.events[1].bodyReason, 'body-size-limit');
  assert.equal(session.events[1].bodyBytes, 1024 * 1024 + 1);
  assert.ok(session.limits.some(limit => limit.kind === 'omittedBodies' && limit.omitted === 1));
});

test('invalid filename, UTF-8, controls, JSONL, identities and input limits fail before creating an artifact', async t => {
  const f = await fixture(t), valid = encode(rows());
  const missingId = rows(); delete missingId[1].uuid;
  const wrongId = rows(); wrongId[1].sessionId = randomUUID();
  const cases = [
    { fileName: `../${fileName}`, text: valid }, { fileName: 'named-session.jsonl', text: valid },
    { fileName, text: '' }, { fileName, text: '\ufeff' + valid }, { fileName, text: valid + '\u0000' },
    { fileName, text: valid.replace('PUBLIC QUESTION', '\ud800') },
    { fileName, text: '{not-json}\n' }, { fileName, text: '[]\n' },
    { fileName, text: encode(missingId) }, { fileName, text: encode(wrongId) },
    { fileName, text: 'a'.repeat(8 * 1024 * 1024 + 1) },
    { fileName, text: '{"type":"metadata"}\n'.repeat(10001) },
  ];
  for (const input of cases) {
    await assert.rejects(importClaudeTranscript(input, f), /invalid|limit/);
    await assert.rejects(access(f.directory), { code: 'ENOENT' });
  }
});

test('helper refusal removes only the new artifact and preserves caller data', async t => {
  const f = await fixture(t);
  await assert.rejects(importClaudeTranscript({ fileName, text: '{"type":"metadata"}\n' }, f), /reader could not import/);
  await assert.rejects(access(f.directory), { code: 'ENOENT' });
  const invalidRole = rows(); invalidRole[1].message.role = 'user';
  await assert.rejects(importClaudeTranscript({ fileName, text: encode(invalidRole) }, f), /reader could not import/);
  await assert.rejects(access(f.directory), { code: 'ENOENT' });
  const escapedControl = rows(); escapedControl[1].message.content = [{ type: 'text', text: '\u0000' }];
  await assert.rejects(importClaudeTranscript({ fileName, text: encode(escapedControl) }, f), /reader could not import/);
  await assert.rejects(access(f.directory), { code: 'ENOENT' });
  await mkdir(f.directory, { mode: 0o700 }); await writeFile(join(f.directory, 'keep'), 'KEEP');
  await assert.rejects(importClaudeTranscript({ fileName, text: encode(rows()) }, f), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.directory, 'keep'), 'utf8'), 'KEEP');
});

test('noncanonical or public artifact parents are refused without following links', async t => {
  const f = await fixture(t), alias = join(f.root, 'alias');
  await symlink(f.root, alias);
  await assert.rejects(importClaudeTranscript({ fileName, text: encode(rows()) }, { directory: join(alias, 'import') }), /private directory/);
  const publicParent = join(f.root, 'public'); await mkdir(publicParent, { mode: 0o755 });
  await assert.rejects(importClaudeTranscript({ fileName, text: encode(rows()) }, { directory: join(publicParent, 'import') }), /private directory/);
});
