import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAuditSkillTelemetry, startAuditTelemetry } from '../src/audit-telemetry.js';

const event = (name = 'codex.skill_invocation', extra = [], pluginId = 'product-design') => ({
  timeUnixNano: '1780000000123456789',
  attributes: [
    ['event.name', name], ['conversation.id', 'thread-123'], ['turn.id', 'turn-456'],
    ['skill.name', 'product-design:image-to-code'], ['skill.scope', 'user'],
    ['skill.plugin_id', pluginId], ['skill.invocation_type', 'explicit'], ...extra,
  ].map(([key, value]) => ({ key, value: { stringValue: value } })),
});
const payload = (records = [event()]) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });

async function post(receiver, body, { token, headers = {}, raw } = {}) {
  const port = Number(receiver.args[1].match(/127\.0\.0\.1:(\d+)/)[1]);
  return fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-xfx-telemetry-token': token } : {}), ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

test('projects only allow-listed native skill event metadata and encodes a run-only JSON exporter override', async t => {
  const receiver = await startAuditTelemetry(); t.after(() => receiver.close());
  assert.equal(receiver.args[0], '-c');
  assert.match(receiver.args[1], /^otel\.exporter=\{otlp-http=\{/);
  assert.match(receiver.args[1], /protocol="json"/);
  assert.deepEqual(receiver.args.slice(-2), ['-c', 'otel.log_user_prompt=false']);
  const token = receiver.args[1].match(/\"x-xfx-telemetry-token\"=\"([a-f0-9]+)\"/)[1];
  const zeroTimestamp = event('codex.skill_invocation', [['event.timestamp', '0']]);
  zeroTimestamp.timeUnixNano = '0';
  const response = await post(receiver, { resourceLogs: [{ scopeLogs: [{ logRecords: [
    event('codex.skill_invocation', [], 'sites@openai-curated-remote'), event('codex.user_prompt', [['prompt', 'private prompt']]),
    event('codex.skill_invocation', [['skill.name', '/private/path/SKILL.md']]),
    event('codex.skill_invocation', [], 'market/shared'),
    zeroTimestamp,
  ] }] }] }, { token });
  assert.equal(response.status, 200);
  const snapshot = receiver.snapshot();
  assert.ok(snapshot.events.every(e => /^[a-f0-9]{32}:[1-9][0-9]*$/.test(e.observationId)));
  assert.equal(new Set(snapshot.events.map(e => e.observationId)).size, 3);
  assert.deepEqual(snapshot.events.map(({ observationId, sourceTime, ...event }) => event), [
    { source: 'native-otel-skill-invocation', threadId: 'thread-123', turnId: 'turn-456',
      skillName: 'product-design:image-to-code', invocationType: 'explicit', scope: 'user', pluginId: 'sites@openai-curated-remote', timestampNs: '1780000000123456789' },
    { source: 'native-otel-skill-invocation', threadId: 'thread-123', turnId: 'turn-456',
      skillName: 'product-design:image-to-code', invocationType: 'explicit', scope: 'user', pluginId: 'market/shared', timestampNs: '1780000000123456789' },
    { source: 'native-otel-skill-invocation', threadId: 'thread-123', turnId: 'turn-456',
      skillName: 'product-design:image-to-code', invocationType: 'explicit', scope: 'user', pluginId: 'product-design' },
  ]);
  assert.equal(JSON.stringify(snapshot).includes('private prompt'), false);
  assert.equal(JSON.stringify(snapshot).includes('/private/path'), false);
  assert.equal(snapshot.metadata.promptLogging, false);
  assert.equal(snapshot.metadata.delivery, 'best-effort');
});

test('preserves distinct timestamp-free receipts across batches and durable journal replay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-receipt-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalPath = join(dir, 'journal.jsonl');
  const receiver = await startAuditTelemetry({ journalPath }); t.after(() => receiver.close());
  const token = receiver.args[1].match(/\"x-xfx-telemetry-token\"=\"([a-f0-9]+)\"/)[1];
  const row = event(); delete row.timeUnixNano;
  row.observationId = '/private/forged-identity';
  for (const records of [[row, row], [row]]) assert.equal((await post(receiver, payload(records), { token })).status, 200);
  const first = receiver.snapshot();
  assert.equal(first.events.length, 3);
  assert.ok(first.events.every(e => !e.timestampNs && /^[a-f0-9]{32}:[1-9][0-9]*$/.test(e.observationId)));
  assert.equal(new Set(first.events.map(e => e.observationId)).size, 3);
  assert.deepEqual(receiver.snapshot().events, first.events);
  assert.deepEqual(readAuditSkillTelemetry(journalPath).events, first.events);
  assert.deepEqual((await receiver.close()).events, first.events);
  assert.doesNotMatch(JSON.stringify(first), /private|forged/);
});

test('rejects unauthorized, compressed, malformed, and non-JSON requests without retaining payloads', async t => {
  const receiver = await startAuditTelemetry(); t.after(() => receiver.close());
  assert.equal((await post(receiver, payload())).status, 401);
  const token = receiver.args[1].match(/\"x-xfx-telemetry-token\"=\"([a-f0-9]+)\"/)[1];
  assert.equal((await post(receiver, payload(), { token, headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await post(receiver, null, { token, raw: '{broken' })).status, 400);
  assert.equal((await post(receiver, { unrelated: [] }, { token })).status, 200);
  assert.equal((await post(receiver, payload(), { token, headers: { 'content-type': 'application/x-protobuf' } })).status, 415);
  assert.deepEqual(receiver.snapshot().events, []);
  assert.ok(receiver.snapshot().metadata.receivedBytes > 0);
  assert.ok(receiver.snapshot().metadata.rejectedRequests >= 3);
  assert.equal(receiver.snapshot().metadata.journal.status, 'disabled');
  assert.equal(JSON.stringify(receiver.snapshot()).includes('broken'), false);
  assert.ok(receiver.snapshot().metadata.warnings.length);
});

test('rejects credential-shaped actor IDs and invalid plugin identity without silently claiming full receipt', async t => {
  const receiver = await startAuditTelemetry(); t.after(() => receiver.close());
  const token = receiver.args[1].match(/\"x-xfx-telemetry-token\"=\"([a-f0-9]+)\"/)[1];
  const actor = `sk-${'a'.repeat(48)}`;
  const credentialRecord = event();
  credentialRecord.attributes.find(a => a.key === 'conversation.id').value.stringValue = actor;
  const invalidPlugin = event();
  invalidPlugin.attributes.find(a => a.key === 'skill.plugin_id').value.stringValue = '/private/plugin';
  assert.equal((await post(receiver, payload([event(), credentialRecord, invalidPlugin]), { token })).status, 200);
  const snapshot = receiver.snapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.metadata.status, 'partial');
  assert.ok(snapshot.metadata.warnings.includes('telemetry-invalid-record'));
  assert.equal(JSON.stringify(snapshot).includes(actor), false);
  assert.equal(JSON.stringify(snapshot).includes('/private/plugin'), false);
});

test('caps the total byte budget and event count and closes the listener', async t => {
  const batch = payload([event(), event()]);
  const budget = Buffer.byteLength(JSON.stringify(batch)) + 50;
  const receiver = await startAuditTelemetry({ maxBytes: budget, maxEvents: 1 });
  t.after(() => receiver.close());
  const token = receiver.args[1].match(/\"x-xfx-telemetry-token\"=\"([a-f0-9]+)\"/)[1];
  assert.equal((await post(receiver, batch, { token })).status, 200);
  assert.equal(receiver.snapshot().events.length, 1);
  assert.ok(receiver.snapshot().metadata.warnings.includes('telemetry-event-limit'));
  const response = await post(receiver, batch, { token });
  assert.equal(response.status, 413);
  const final = await receiver.close();
  assert.equal(final.metadata.status, 'partial');
  await assert.rejects(() => post(receiver, payload(), { token }));
});

test('journals only projected events with private exclusive creation and reads them back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-audit-telemetry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalPath = join(dir, 'skills.jsonl');
  const receiver = await startAuditTelemetry({ journalPath });
  t.after(() => receiver.close());
  const mode = (await stat(journalPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const token = receiver.args[1].match(/\"x-xfx-telemetry-token\"=\"([a-f0-9]+)\"/)[1];
  assert.equal((await post(receiver, { resourceLogs: [{ scopeLogs: [{ logRecords: [event(), event('codex.user_prompt', [['prompt', 'private text']])] }] }] }, { token })).status, 200);
  const loaded = readAuditSkillTelemetry(journalPath);
  assert.equal(loaded.metadata.status, 'available');
  assert.equal(loaded.events.length, 1);
  assert.equal(JSON.stringify(loaded).includes('private text'), false);
  assert.equal(JSON.stringify(loaded).includes('x-xfx-telemetry-token'), false);
  const final = await receiver.close();
  assert.deepEqual(final.events, loaded.events);
  assert.equal(final.metadata.journal.eventCount, 1);
  await assert.rejects(() => startAuditTelemetry({ journalPath }));
});

test('journal reader reports a truncated tail without exposing malformed bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-audit-telemetry-read-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalPath = join(dir, 'skills.jsonl');
  const row = { source: 'native-otel-skill-invocation', threadId: 'thread-123', turnId: 'turn-456', skillName: 'safe-skill', invocationType: 'implicit' };
  await writeFile(journalPath, `${JSON.stringify(row)}\nmalformed private content\n{private truncated data`, { mode: 0o600 });
  const loaded = readAuditSkillTelemetry(journalPath);
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.metadata.status, 'partial');
  assert.ok(loaded.metadata.warnings.includes('telemetry-journal-truncated-tail'));
  assert.ok(loaded.metadata.warnings.includes('telemetry-journal-malformed-record'));
  assert.equal(JSON.stringify(loaded).includes('private truncated data'), false);
});

test('journal reader rejects a symlink without returning target contents', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-audit-telemetry-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'target.jsonl'), link = join(dir, 'journal.jsonl');
  await writeFile(target, '{"private":"must not be read"}\n');
  await symlink(target, link);
  const loaded = readAuditSkillTelemetry(link);
  assert.equal(loaded.metadata.status, 'unavailable');
  assert.equal(JSON.stringify(loaded).includes('must not be read'), false);
});

test('journal reader rejects group-readable files and files with multiple hard links', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-audit-telemetry-perms-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const row = JSON.stringify({ source: 'native-otel-skill-invocation', threadId: 'thread-123', turnId: 'turn-456', skillName: 'safe-skill', invocationType: 'explicit' }) + '\n';
  const publicPath = join(dir, 'public.jsonl');
  await writeFile(publicPath, row, { mode: 0o600 });
  await chmod(publicPath, 0o640);
  assert.equal(readAuditSkillTelemetry(publicPath).metadata.status, 'unavailable');
  const linkedPath = join(dir, 'linked.jsonl');
  await writeFile(linkedPath, row, { mode: 0o600 });
  await link(linkedPath, join(dir, 'second-link.jsonl'));
  const linked = readAuditSkillTelemetry(linkedPath);
  assert.equal(linked.metadata.status, 'unavailable');
  assert.equal(linked.events.length, 0);
});
