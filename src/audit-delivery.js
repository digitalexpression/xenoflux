// Fixed, privacy-safe projections for receiver-scoped telemetry accounting.
// These values describe this observer's receipts and journal state only.
const COUNT_KEYS = ['received', 'admitted', 'rejected'];
const RECORD_KEYS = ['examined', 'relevant', 'accepted', 'durable', 'invalidRelevant', 'unclassified',
  'ignored', 'eventLimitDropped', 'persistenceRejected', 'unexamined'];
const SCOPES = new Set(['receiver-lifetime', 'committed-prefix']);
const CLASSIFICATIONS = new Set(['complete', 'bounded']);
const JOURNAL_STATUS = new Set(['available', 'partial', 'unavailable', 'disabled', 'unknown']);
const JOURNAL_MODE = new Set(['required', 'disabled', 'unknown']);
const JOURNAL_COMMIT = new Set(['committed-prefix', 'failed', 'unavailable', 'legacy-unverified', 'disabled', 'unknown']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Project receiver accounting without trusting arbitrary nested metadata. */
export function projectDeliveryAccounting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
    || !SCOPES.has(value.scope) || !CLASSIFICATIONS.has(value.classification)
    || !value.requests || typeof value.requests !== 'object' || Array.isArray(value.requests)
    || !value.records || typeof value.records !== 'object' || Array.isArray(value.records)) return null;
  const requests = Object.fromEntries(COUNT_KEYS.map(key => [key, count(value.requests[key])]));
  const records = Object.fromEntries(RECORD_KEYS.map(key => [key, count(value.records[key])]));
  if (records.unexamined !== 0 && records.unexamined !== null) records.unexamined = null;
  const classification = Object.values(requests).some(item => item === null)
    || Object.entries(records).some(([key, item]) => key !== 'durable' && item === null)
    ? 'bounded' : value.classification;
  return { schemaVersion: 1, scope: value.scope, classification, requests, records,
    upstreamLoss: 'unknown', acknowledgements: 'unknown' };
}

/** Project journal durability without retaining paths, messages, or free text. */
export function projectTelemetryJournal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    status: JOURNAL_STATUS.has(value.status) ? value.status : 'unknown',
    mode: JOURNAL_MODE.has(value.mode) ? value.mode : 'unknown',
    format: value.format === 1 || value.format === 2 ? value.format : null,
    commit: JOURNAL_COMMIT.has(value.commit) ? value.commit : 'unknown',
    bytes: count(value.bytes), eventCount: count(value.eventCount),
    committedBytes: count(value.committedBytes), committedEvents: count(value.committedEvents),
    uncertainBytes: count(value.uncertainBytes),
  };
}
