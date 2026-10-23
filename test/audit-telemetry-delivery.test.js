import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAuditSkillTelemetry, startAuditTelemetry } from '../src/audit-telemetry.js';

const record = (name = 'codex.skill_invocation', extras = []) => ({ attributes: [
  ['event.name', name], ['conversation.id', 'thread-delivery'], ['turn.id', 'turn-delivery'],
  ['skill.name', 'delivery-proof'], ['skill.invocation_type', 'implicit'], ...extras,
].map(([key, stringValue]) => ({ key, value: { stringValue } })) });
const payload = records => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });
const access = receiver => ({
  endpoint: receiver.args[1].match(/http:\/\/127\.0\.0\.1:\d+\/v1\/logs/)[0],
  token: receiver.args[1].match(/"x-xfx-telemetry-token"="([a-f0-9]+)"/)[1],
});
async function post(receiver, records) {
  const { endpoint, token } = access(receiver);
  const response = await fetch(endpoint, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-xfx-telemetry-token': token,
  }, body: JSON.stringify(payload(records)) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('classifies examined records and cap omissions separately, preserving committed-prefix counters', async t => {
  const journalPath = join(await directory(t), 'events.jsonl');
  const receiver = await startAuditTelemetry({ journalPath, maxEvents: 1 });
  t.after(() => receiver.close());
  const invalid = record(); invalid.attributes = invalid.attributes.filter(a => a.key !== 'turn.id');
  const unclassified = record('other', [['event.name', 'codex.skill_invocation']]);
  const response = await post(receiver, [record(), invalid, unclassified, record('other'), record()]);
  assert.equal(response.status, 200);
  assert.equal(response.body.partialSuccess.rejectedLogRecords, 3);
  const snapshot = receiver.snapshot();
  assert.equal(snapshot.metadata.status, 'partial');
  assert.deepEqual(snapshot.metadata.deliveryAccounting, {
    schemaVersion: 1, scope: 'receiver-lifetime', classification: 'complete',
    requests: { received: 1, admitted: 1, rejected: 0 },
    records: { examined: 5, relevant: 3, accepted: 1, durable: 1, invalidRelevant: 1,
      unclassified: 1, ignored: 1, eventLimitDropped: 1, persistenceRejected: 0, unexamined: 0 },
    upstreamLoss: 'unknown', acknowledgements: 'unknown',
  });
  const recovered = readAuditSkillTelemetry(journalPath);
  assert.deepEqual(recovered.events, snapshot.events);
  assert.deepEqual(recovered.metadata.deliveryAccounting, {
    ...snapshot.metadata.deliveryAccounting, scope: 'committed-prefix',
  });
  assert.equal(recovered.metadata.journal.commit, 'committed-prefix');
});

test('does not count unexamined or unclassified records as invalid skill records', async t => {
  const receiver = await startAuditTelemetry({ maxEvents: 1 });
  t.after(() => receiver.close());
  const response = await post(receiver, Array.from({ length: 5001 }, () => record('other')));
  assert.equal(response.status, 200);
  assert.equal(response.body.partialSuccess.rejectedLogRecords, 0);
  assert.match(response.body.partialSuccess.errorMessage, /unexamined count unknown/);
  const accounting = receiver.snapshot().metadata.deliveryAccounting;
  assert.equal(accounting.records.examined, 5000);
  assert.equal(accounting.records.ignored, 5000);
  assert.equal(accounting.records.relevant, 0);
  assert.equal(accounting.records.invalidRelevant, 0);
  assert.equal(accounting.records.unexamined, null);
  assert.equal(accounting.classification, 'bounded');
  assert.equal(accounting.records.durable, null, 'disabled persistence has no durable receipt count');
  assert.equal(receiver.snapshot().metadata.journal.mode, 'disabled');
});

test('a rejected byte-budget request leaves record omissions unknown rather than inventing counts', async t => {
  const receiver = await startAuditTelemetry({ maxBytes: 64 });
  t.after(() => receiver.close());
  assert.equal((await post(receiver, [record()])).status, 413);
  const accounting = receiver.snapshot().metadata.deliveryAccounting;
  assert.deepEqual(accounting.requests, { received: 1, admitted: 0, rejected: 1 });
  assert.equal(accounting.records.examined, 0);
  assert.equal(accounting.records.relevant, 0);
  assert.equal(accounting.records.invalidRelevant, 0);
  assert.equal(accounting.records.unexamined, null);
  assert.equal(accounting.classification, 'bounded');
});

test('a post-write fsync failure permanently rejects retries and empty requests without replaying uncertain rows', async t => {
  const journalPath = join(await directory(t), 'events.jsonl');
  // Fault injection is confined to an owned subprocess, not the test runner.
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    let failing = false; const sync = fs.fsyncSync;
    fs.fsyncSync = (...args) => { if (failing) throw new Error('private injected failure'); return sync(...args); };
    syncBuiltinESMExports();
    const { pathToFileURL } = await import('node:url');
    const { startAuditTelemetry, readAuditSkillTelemetry } = await import(pathToFileURL(process.argv[1] + '/src/audit-telemetry.js'));
    const receiver = await startAuditTelemetry({ journalPath: process.argv[2] });
    const { endpoint, token } = (${access.toString()})(receiver);
    const send = async records => (await fetch(endpoint, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-xfx-telemetry-token': token },
      body: JSON.stringify((${payload.toString()})(records)) })).status;
    const row = ${JSON.stringify(record())};
    const statuses = [await send([row])];
    failing = true; statuses.push(await send([row])); failing = false;
    statuses.push(await send([row]), await send([]));
    const snapshot = await receiver.close();
    const recovered = readAuditSkillTelemetry(process.argv[2]);
    console.log(JSON.stringify({ statuses, snapshot, recovered }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, process.cwd(), journalPath], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr);
  const { statuses, snapshot, recovered } = JSON.parse(child.stdout);
  assert.deepEqual(statuses, [200, 503, 503, 503]);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.metadata.journal.commit, 'failed');
  assert.ok(snapshot.metadata.journal.uncertainBytes > 0);
  assert.deepEqual(snapshot.metadata.deliveryAccounting.requests, { received: 4, admitted: 1, rejected: 3 });
  assert.equal(snapshot.metadata.deliveryAccounting.records.persistenceRejected, 2);
  assert.equal(snapshot.metadata.deliveryAccounting.records.durable, 1);
  assert.deepEqual(recovered.events, snapshot.events);
  assert.deepEqual(recovered.metadata.deliveryAccounting.requests, { received: 1, admitted: 1, rejected: 0 });
  assert.equal(recovered.metadata.deliveryAccounting.scope, 'committed-prefix');
  assert.ok(recovered.metadata.warnings.includes('telemetry-journal-uncommitted-tail'));
  assert.doesNotMatch(JSON.stringify({ snapshot, recovered }), /private injected failure/);
});
