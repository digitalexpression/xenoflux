import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeSourceTimeNs, sourceTimeNs, skillSourceTimeFromRecord, projectSkillSourceTime,
  validSkillSourceTime, nsToSourceIso } from '../src/audit-source-time.js';
import { readAuditSkillTelemetry, startAuditTelemetry } from '../src/audit-telemetry.js';

const empty = () => skillSourceTimeFromRecord({}, undefined);

test('UTC source time keeps nanosecond fractions and validates real calendar dates without normalization', () => {
  const examples = [
    ['2023-11-14T22:13:20Z', '1700000000000000000'],
    ['2023-11-14T22:13:20.123Z', '1700000000123000000'],
    ['2023-11-14T22:13:20.000000001Z', '1700000000000000001'],
    ['2024-02-29T00:00:00.123456789Z', '1709164800123456789'],
    ['2554-07-21T23:34:33.709551615Z', '18446744073709551615'],
  ];
  for (const [value, expected] of examples) {
    assert.equal(nativeSourceTimeNs(value), expected, value);
    assert.equal(nativeSourceTimeNs(nsToSourceIso(expected)), expected);
  }
  for (const value of ['2023-02-29T00:00:00Z', '2024-02-30T00:00:00Z', '2024-13-01T00:00:00Z',
    '2024-00-01T00:00:00Z', '2024-01-00T00:00:00Z', '2024-01-01T24:00:00Z',
    '2024-01-01T00:60:00Z', '2024-01-01T00:00:60Z', '2024-01-01T00:00:00.1234567890Z',
    '2024-01-01T00:00:00+00:00', '2024-01-01', '1969-12-31T23:59:59Z',
    '2554-07-21T23:34:33.709551616Z', '/private/date', '1700000000000000000', null, 1700000000]) {
    assert.equal(nativeSourceTimeNs(value), null, String(value));
  }
});

test('wire nanoseconds are bounded decimal strings, with unset and unsafe numeric inputs unknown', () => {
  assert.equal(sourceTimeNs('000001'), '1');
  assert.equal(sourceTimeNs('0'.repeat(30) + '1'), '1');
  assert.equal(sourceTimeNs('18446744073709551615'), '18446744073709551615');
  for (const value of ['0', '000', '', '-1', '+1', '1.5', ' 1', '1e9', '18446744073709551616',
    '9'.repeat(21), 1700000000123456789, null, undefined, {}, []]) {
    assert.equal(sourceTimeNs(value), null);
    assert.equal(nsToSourceIso(value), null);
  }
});

test('each reported clock remains separate and malformed or forged frozen fields cannot establish time', () => {
  const projected = skillSourceTimeFromRecord({ timeUnixNano: '1700000001000000000',
    observedTimeUnixNano: '1700000002000000000' }, '2023-11-14T22:13:20.123456789Z');
  assert.equal(projected.nativeEvent.unixNano, '1700000000123456789');
  assert.equal(projected.otlpEvent.unixNano, '1700000001000000000');
  assert.equal(projected.otlpObserved.unixNano, '1700000002000000000');
  assert.equal(projected.clockRelationship, 'unknown');
  assert.equal(validSkillSourceTime(projected), true);
  const forged = structuredClone(projected);
  forged.nativeEvent.source = '/private/clock';
  forged.otlpEvent.clock = 'synchronized';
  forged.otlpObserved.payload = 'PRIVATE_CLOCK_PAYLOAD';
  forged.clockRelationship = 'synchronized';
  const safe = projectSkillSourceTime(forged);
  assert.equal(safe.nativeEvent.unixNano, null);
  assert.equal(safe.otlpEvent.unixNano, null);
  assert.equal(safe.otlpObserved.unixNano, projected.otlpObserved.unixNano);
  assert.equal(safe.clockRelationship, 'unknown');
  assert.equal(validSkillSourceTime(forged), false);
  assert.doesNotMatch(JSON.stringify(safe), /private|PRIVATE|synchronized/);
  assert.equal(projectSkillSourceTime({ ...projected, schemaVersion: 2 }), null);
  assert.deepEqual(projectSkillSourceTime({ schemaVersion: 1 }), empty());
  const missing = skillSourceTimeFromRecord({ timeUnixNano: '0', observedTimeUnixNano: '1700000002000000000' }, 'invalid');
  assert.equal(missing.nativeEvent.unixNano, null);
  assert.equal(missing.otlpEvent.unixNano, null);
  assert.equal(missing.otlpObserved.unixNano, '1700000002000000000', 'observation time never backfills missing event time');
});

test('native UTC attribute and OTLP clocks survive durable replay with distinct same-time receipts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-source-time-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalPath = join(dir, 'events.jsonl');
  const receiver = await startAuditTelemetry({ journalPath }); t.after(() => receiver.close());
  const endpoint = receiver.args[1].match(/http:\/\/127\.0\.0\.1:\d+\/v1\/logs/)[0];
  const token = receiver.args[1].match(/"x-xfx-telemetry-token"="([a-f0-9]+)"/)[1];
  const row = (nativeTime, eventTime, observedTime) => ({
    timeUnixNano: eventTime, observedTimeUnixNano: observedTime,
    sourceTime: { private: 'PRIVATE_FORGED_TIME' },
    attributes: [ ['event.name', 'codex.skill_invocation'], ['conversation.id', 'thread-time'],
      ['turn.id', 'turn-time'], ['skill.name', 'time-proof'], ['skill.invocation_type', 'implicit'],
      ['event.timestamp', nativeTime],
    ].map(([key, stringValue]) => ({ key, value: { stringValue } })),
  });
  const record = row('2023-11-14T22:13:20.123456789Z', '0', '1700000002000000000');
  const records = [record, record, row('/private/invalid-time', '0', '1700000003000000000')];
  const response = await fetch(endpoint, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-xfx-telemetry-token': token,
  }, body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] }) });
  assert.equal(response.status, 200);
  const snapshot = await receiver.close();
  assert.equal(snapshot.events.length, 3);
  assert.equal(new Set(snapshot.events.map(event => event.observationId)).size, 3);
  const first = snapshot.events[0];
  assert.equal(first.timestampNs, undefined, 'ISO native time must not alter the legacy numeric field or dedup key');
  assert.equal(first.sourceTime.nativeEvent.unixNano, '1700000000123456789');
  assert.equal(first.sourceTime.otlpEvent.unixNano, null);
  assert.equal(first.sourceTime.otlpObserved.unixNano, '1700000002000000000');
  assert.equal(snapshot.events[2].sourceTime.nativeEvent.unixNano, null);
  assert.deepEqual(readAuditSkillTelemetry(journalPath).events, snapshot.events);
  assert.equal(snapshot.metadata.deliveryAccounting.records.durable, 3);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_FORGED_TIME|private\/invalid-time/);
  // Old event-only journals remain readable and do not gain invented source time.
  const legacy = join(dir, 'legacy.jsonl');
  const { sourceTime, ...old } = first;
  await writeFile(legacy, `${JSON.stringify(old)}\n`, { mode: 0o600 });
  const loaded = readAuditSkillTelemetry(legacy);
  assert.equal(loaded.metadata.journal.commit, 'legacy-unverified');
  assert.equal(Object.hasOwn(loaded.events[0], 'sourceTime'), false);
  assert.equal((await readFile(journalPath, 'utf8')).includes('PRIVATE_FORGED_TIME'), false);
});
