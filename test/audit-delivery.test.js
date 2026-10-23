import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDeliveryAccounting, projectTelemetryJournal } from '../src/audit-delivery.js';

const accounting = {
  schemaVersion: 1, scope: 'receiver-lifetime', classification: 'complete',
  requests: { received: 2, admitted: 1, rejected: 1 },
  records: { examined: 3, relevant: 2, accepted: 1, durable: 1, invalidRelevant: 0, unclassified: 0,
    ignored: 1, eventLimitDropped: 0, persistenceRejected: 0, unexamined: 0 },
  upstreamLoss: 'unknown', acknowledgements: 'unknown',
};

test('delivery accounting accepts only v1 receiver scopes and projects malformed counts to unknown', () => {
  assert.deepEqual(projectDeliveryAccounting(accounting), accounting);
  assert.equal(projectDeliveryAccounting(null), null);
  assert.equal(projectDeliveryAccounting({ ...accounting, schemaVersion: 2 }), null);
  const projected = projectDeliveryAccounting({ ...accounting,
    requests: { received: -1, admitted: Number.MAX_SAFE_INTEGER + 1, rejected: 'PRIVATE_REQUESTS' },
    records: { ...accounting.records, durable: '/private/path', unexamined: 3, raw: 'PRIVATE_RAW' },
    upstreamLoss: 'none', acknowledgements: 'all' });
  assert.deepEqual(projected.requests, { received: null, admitted: null, rejected: null });
  assert.deepEqual(projected.records, { ...accounting.records, durable: null, unexamined: null });
  assert.equal(projected.upstreamLoss, 'unknown');
  assert.equal(projected.acknowledgements, 'unknown');
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|private|raw/);
  const noJournal = projectDeliveryAccounting({ ...accounting, records: { ...accounting.records, durable: null } });
  assert.equal(noJournal.classification, 'complete', 'persistence availability is separate from JSON classification completeness');
  assert.equal(noJournal.records.durable, null);
});

test('journal projection keeps only bounded health enums and counters', () => {
  const value = { status: 'partial', mode: 'required', format: 2, commit: 'committed-prefix', bytes: 100,
    eventCount: 4, committedBytes: 80, committedEvents: 3, uncertainBytes: 20,
    path: '/private/journal', warning: 'PRIVATE_WARNING' };
  assert.deepEqual(projectTelemetryJournal(value), { status: 'partial', mode: 'required', format: 2,
    commit: 'committed-prefix', bytes: 100, eventCount: 4, committedBytes: 80, committedEvents: 3, uncertainBytes: 20 });
  assert.equal(projectTelemetryJournal(undefined), null);
  const malformed = projectTelemetryJournal({ status: 'private-status', mode: 'credential', format: 99,
    commit: 'private-commit', bytes: -5, eventCount: 'secret' });
  assert.deepEqual(malformed, { status: 'unknown', mode: 'unknown', format: null, commit: 'unknown',
    bytes: null, eventCount: null, committedBytes: null, committedEvents: null, uncertainBytes: null });
});
