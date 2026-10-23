import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { redactValue } from './redact.js';
import { skillSourceTimeFromRecord, validSkillSourceTime } from './audit-source-time.js';
import { createTelemetryJournal, readTelemetryJournal } from './audit-telemetry-journal.js';
import { projectDeliveryAccounting, projectTelemetryJournal } from './audit-delivery.js';

const DEFAULT_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVENTS = 20000;
const MAX_CONNECTIONS = 8;
const MAX_RECORDS_PER_REQUEST = 5000;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_SCOPE = new Set(['user', 'repo', 'project', 'system', 'admin', 'profile']);
const SAFE_INVOCATION = new Set(['explicit', 'implicit']);
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const OBSERVATION_ID = /^[a-f0-9]{32}:[1-9][0-9]{0,4}$/;

function boundedString(value, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  // Metadata fields are identifiers, not prose. Keep printable ASCII only and
  // reject path-like values so telemetry cannot smuggle filesystem locations.
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._:@+-]*$/.test(value) || value.includes('/') || value.includes('\\')
    || redactValue(value) !== value) return null;
  return value;
}

function boundedPluginId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120
    || value.includes('://') || value.includes('\\')
    || !/^[A-Za-z0-9][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._@+-]*)*$/.test(value)
    || redactValue(value) !== value) return null;
  return value;
}

function positiveTimestampNs(value) {
  return typeof value === 'string' && /^\d{1,24}$/.test(value) && BigInt(value) > 0n ? value : null;
}

function validProjectedEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || event.source !== 'native-otel-skill-invocation'
    || !ID.test(event.threadId ?? '') || !ID.test(event.turnId ?? '')
    || redactValue(event.threadId) !== event.threadId || redactValue(event.turnId) !== event.turnId
    || !boundedString(event.skillName, 120) || !SAFE_INVOCATION.has(event.invocationType)) return false;
  const allowed = new Set(['source', 'threadId', 'turnId', 'skillName', 'scope', 'pluginId', 'invocationType', 'timestampNs', 'observationId', 'sourceTime']);
  if (Object.keys(event).some(key => !allowed.has(key))) return false;
  if (event.scope !== undefined && !SAFE_SCOPE.has(event.scope)) return false;
  if (event.pluginId !== undefined && !boundedPluginId(event.pluginId)) return false;
  if (event.timestampNs !== undefined && positiveTimestampNs(event.timestampNs) === null) return false;
  if (event.sourceTime !== undefined && !validSkillSourceTime(event.sourceTime)) return false;
  if (event.observationId !== undefined && (typeof event.observationId !== 'string' || !OBSERVATION_ID.test(event.observationId))) return false;
  return true;
}

/** Recover verified committed rows, or explicitly unverified legacy rows. */
export function readAuditSkillTelemetry(journalPath, { maxBytes = MAX_JOURNAL_BYTES, maxEvents = DEFAULT_EVENTS } = {}) {
  maxEvents = limit(maxEvents, DEFAULT_EVENTS, DEFAULT_EVENTS);
  const recovered = readTelemetryJournal(journalPath, { maxBytes });
  const events = [], warnings = [...recovered.warnings];
  const accounting = projectDeliveryAccounting(recovered.accounting);
  if (accounting?.records.invalidRelevant) warnings.push('telemetry-invalid-record');
  if (accounting?.records.unclassified) warnings.push('telemetry-unclassified-record');
  if (accounting?.records.eventLimitDropped) warnings.push('telemetry-event-limit');
  if (accounting?.classification === 'bounded') warnings.push('telemetry-record-classification-incomplete');
  if (accounting?.requests.rejected) warnings.push('telemetry-requests-rejected');
  for (const line of recovered.lines) {
    if (events.length >= maxEvents) { warnings.push('telemetry-journal-event-limit'); break; }
    let value;
    try { value = JSON.parse(line); } catch { warnings.push('telemetry-journal-malformed-record'); continue; }
    if (!validProjectedEvent(value)) { warnings.push('telemetry-journal-invalid-record'); continue; }
    events.push(value);
  }
  return { events, metadata: {
    status: recovered.journal.status === 'unavailable' ? 'unavailable' : warnings.length ? 'partial' : events.length ? 'available' : 'unknown',
    delivery: 'best-effort', bytes: recovered.bytes, eventCount: events.length,
    journal: projectTelemetryJournal(recovered.journal),
    deliveryAccounting: accounting,
    warnings: [...new Set(warnings)],
  } };
}

function attrMap(raw) {
  const result = Object.create(null);
  if (!Array.isArray(raw)) return result;
  for (const item of raw) {
    if (typeof item?.key !== 'string' || typeof item?.value?.stringValue !== 'string') continue;
    if (Object.hasOwn(result, item.key)) return null;
    result[item.key] = item.value.stringValue;
  }
  return result;
}

function project(body, capacity) {
  const events = [];
  const counts = { examined: 0, relevant: 0, invalidRelevant: 0, unclassified: 0,
    ignored: 0, eventLimitDropped: 0, unexamined: 0 };
  let invalid = false;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.resourceLogs))
    return { events, counts: { ...counts, unexamined: null }, invalid: true };
  outer: for (const resource of body.resourceLogs) {
    if (!Array.isArray(resource?.scopeLogs)) { invalid = true; counts.unexamined = null; continue; }
    for (const scope of resource.scopeLogs) {
      if (!Array.isArray(scope?.logRecords)) { invalid = true; counts.unexamined = null; continue; }
      for (const record of scope.logRecords) {
        if (counts.examined >= MAX_RECORDS_PER_REQUEST) { counts.unexamined = null; break outer; }
        counts.examined++;
        const attrs = attrMap(record?.attributes);
        // A missing/ambiguous event name is not proof of an invalid skill row.
        if (!attrs || !attrs['event.name']) { counts.unclassified++; continue; }
        if (attrs['event.name'] !== 'codex.skill_invocation') { counts.ignored++; continue; }
        counts.relevant++;
        const conversationId = attrs['conversation.id'];
        const turnId = attrs['turn.id'];
        const name = boundedString(attrs['skill.name'], 120);
        const skillScope = boundedString(attrs['skill.scope'], 40);
        const pluginId = boundedPluginId(attrs['skill.plugin_id']);
        const invocationType = boundedString(attrs['skill.invocation_type'], 20);
        if (!ID.test(conversationId ?? '') || !ID.test(turnId ?? '')
          || redactValue(conversationId) !== conversationId || redactValue(turnId) !== turnId
          || !name || !SAFE_INVOCATION.has(invocationType)
          || (attrs['skill.plugin_id'] !== undefined && !pluginId)) { counts.invalidRelevant++; continue; }
        if (events.length >= capacity) { counts.eventLimitDropped++; continue; }
        const event = { source: 'native-otel-skill-invocation', threadId: conversationId, turnId,
          skillName: name, invocationType, sourceTime: skillSourceTimeFromRecord(record, attrs['event.timestamp']) };
        if (SAFE_SCOPE.has(skillScope)) event.scope = skillScope;
        if (pluginId) event.pluginId = pluginId;
        const timestamp = positiveTimestampNs(record.timeUnixNano) ?? positiveTimestampNs(attrs['event.timestamp']);
        if (timestamp) event.timestampNs = timestamp;
        events.push(event);
      }
    }
  }
  return { events, counts, invalid };
}

function initialAccounting(required) {
  return { schemaVersion: 1, scope: 'receiver-lifetime', classification: 'complete',
    requests: { received: 0, admitted: 0, rejected: 0 },
    records: { examined: 0, relevant: 0, accepted: 0, durable: required ? 0 : null,
      invalidRelevant: 0, unclassified: 0, ignored: 0, eventLimitDropped: 0,
      persistenceRejected: 0, unexamined: 0 }, upstreamLoss: 'unknown', acknowledgements: 'unknown' };
}

// Saturation becomes unknown; never silently round a counter into a false total.
function increment(object, key, amount = 1) {
  const next = object[key] === null || amount === null ? null : object[key] + amount;
  object[key] = Number.isSafeInteger(next) && next >= 0 ? next : null;
}

function limit(value, fallback, hard) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, hard) : fallback;
}

/** Start a private, local OTLP/HTTP JSON receiver for native skill events. */
export async function startAuditTelemetry({ maxBytes = DEFAULT_BYTES, maxEvents = DEFAULT_EVENTS,
  maxConnections = MAX_CONNECTIONS, host = '127.0.0.1', journalPath } = {}) {
  if (host !== '127.0.0.1') throw new TypeError('Telemetry receiver must bind to 127.0.0.1');
  maxBytes = limit(maxBytes, DEFAULT_BYTES, DEFAULT_BYTES);
  maxEvents = limit(maxEvents, DEFAULT_EVENTS, DEFAULT_EVENTS);
  maxConnections = limit(maxConnections, MAX_CONNECTIONS, MAX_CONNECTIONS);
  const token = randomBytes(32).toString('hex');
  // Receipt identity belongs to this observer, not the native event. Preserve
  // each received row even without a timestamp, while replaying a snapshot or
  // its journal stays idempotent. Never accept a caller-supplied identity.
  let accounting = initialAccounting(journalPath !== undefined);
  if (journalPath !== undefined && (typeof journalPath !== 'string' || !isAbsolute(journalPath)))
    throw new TypeError('Invalid telemetry journal path');
  const journal = journalPath === undefined ? null : createTelemetryJournal(journalPath, accounting);
  const streamId = journal?.streamId ?? randomBytes(16).toString('hex');
  let observationIndex = 0;
  const events = [];
  const warnings = new Set();
  const flushJournal = () => journal?.close();
  const markUnexamined = () => { accounting.records.unexamined = null; accounting.classification = 'bounded'; };
  let receivedBytes = 0, inFlightBytes = 0, active = 0, closed = false, rejected = 0;
  const server = createServer((req, res) => {
    increment(accounting.requests, 'received');
    if (closed) { increment(accounting.requests, 'rejected'); markUnexamined(); res.writeHead(503).end(); return; }
    if (active >= maxConnections) { rejected++; increment(accounting.requests, 'rejected'); markUnexamined(); warnings.add('telemetry-connection-limit'); res.writeHead(503).end(); req.resume(); return; }
    active++;
    let done = false, settled = false;
    const rejectedRequest = () => {
      if (settled) return;
      settled = true; rejected++; increment(accounting.requests, 'rejected');
    };
    const finish = () => { if (!done) { done = true; active--; } };
    req.on('close', () => {
      if (!settled) { rejectedRequest(); markUnexamined(); warnings.add('telemetry-request-incomplete'); }
      finish();
    });
    const reject = (status, warning) => {
      rejectedRequest(); if (warning) warnings.add(warning);
      if (status !== 503) markUnexamined();
      if (!res.headersSent) res.writeHead(status);
      res.end();
      let drained = 0;
      req.on('data', chunk => { drained += chunk.length; if (drained > maxBytes) req.destroy(); });
      req.resume();
    };
    if (req.method !== 'POST' || req.url !== '/v1/logs') return reject(404, 'telemetry-unexpected-request');
    if (req.headers['x-xfx-telemetry-token'] !== token) return reject(401, 'telemetry-unauthorized-request');
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return reject(415, 'telemetry-unsupported-encoding');
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) return reject(415, 'telemetry-non-json-request');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes - receivedBytes) return reject(413, 'telemetry-byte-limit');
    const chunks = [];
    let requestBytes = 0, tooLarge = false, bytesReleased = false;
    const releaseBytes = () => {
      if (bytesReleased) return;
      bytesReleased = true;
      inFlightBytes = Math.max(0, inFlightBytes - requestBytes);
    };
    req.on('close', releaseBytes);
    req.on('data', chunk => {
      requestBytes += chunk.length;
      inFlightBytes += chunk.length;
      if (requestBytes > maxBytes || receivedBytes + inFlightBytes > maxBytes) { tooLarge = true; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { releaseBytes(); warnings.add(tooLarge ? 'telemetry-byte-limit' : 'telemetry-request-incomplete'); rejectedRequest(); markUnexamined(); finish(); });
    req.on('end', () => {
      releaseBytes();
      if (tooLarge) { warnings.add('telemetry-byte-limit'); rejectedRequest(); markUnexamined(); finish(); return; }
      receivedBytes += requestBytes;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks, requestBytes).toString('utf8')); }
      catch { return reject(400, 'telemetry-malformed-json'); }
      const projection = project(payload, maxEvents - events.length);
      for (const [key, count] of Object.entries(projection.counts)) increment(accounting.records, key, count);
      if (projection.counts.unexamined === null) markUnexamined();
      if (projection.invalid) warnings.add('telemetry-invalid-otlp-payload');
      if (projection.counts.invalidRelevant) warnings.add('telemetry-invalid-record');
      if (projection.counts.unclassified) warnings.add('telemetry-unclassified-record');
      if (projection.counts.unexamined === null) warnings.add('telemetry-record-classification-incomplete');
      if (projection.counts.eventLimitDropped) warnings.add('telemetry-event-limit');
      const projected = projection.events;
      for (const event of projected) event.observationId = `${streamId}:${++observationIndex}`;
      const next = structuredClone(accounting);
      increment(next.requests, 'admitted');
      increment(next.records, 'accepted', projected.length);
      if (journal) increment(next.records, 'durable', projected.length);
      if (journal && !journal.append(projected, next)) {
        increment(accounting.records, 'persistenceRejected', projected.length);
        return reject(503, 'telemetry-journal-unavailable');
      }
      accounting = next;
      events.push(...projected);
      settled = true;
      const rejectedLogRecords = projection.counts.invalidRelevant + projection.counts.unclassified + projection.counts.eventLimitDropped;
      const incomplete = projection.counts.unexamined === null;
      const partialSuccess = rejectedLogRecords || incomplete ? {
        rejectedLogRecords,
        errorMessage: incomplete ? 'Record classification incomplete; unexamined count unknown.' : 'Some examined records were invalid, unclassified or over the event limit.',
      } : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ partialSuccess }));
      finish();
    });
  });
  server.maxConnections = maxConnections;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch {
    flushJournal();
    throw new Error('Unable to bind local telemetry receiver');
  }
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/v1/logs`;
  const exporter = `{otlp-http={endpoint=${JSON.stringify(endpoint)},protocol="json",headers={"x-xfx-telemetry-token"=${JSON.stringify(token)}}}}`;
  let closePromise;
  return {
    args: ['-c', `otel.exporter=${exporter}`, '-c', 'otel.log_user_prompt=false'],
    snapshot() {
      const snapshotWarnings = [...new Set([...warnings, ...(journal?.snapshot().warnings ?? [])])];
      const status = snapshotWarnings.length ? 'partial' : events.length ? 'observed' : 'unknown';
      return {
        events: structuredClone(events),
        metadata: {
          source: 'native-otel-skill-invocation', transport: 'otlp-http-json', endpoint: 'loopback-random-port',
          status, delivery: 'best-effort', capability: events.length ? 'observed' : 'unknown',
          observerEffects: ['enables native OTLP log export for this process', 'other native log events are discarded'],
          promptLogging: false, receivedBytes, rejectedRequests: rejected,
          warnings: snapshotWarnings,
          journal: projectTelemetryJournal(journal?.snapshot() ?? { status: 'disabled', mode: 'disabled', format: null, commit: 'disabled',
            bytes: 0, eventCount: 0, committedBytes: 0, committedEvents: 0, uncertainBytes: 0 }),
          deliveryAccounting: projectDeliveryAccounting(accounting),
        },
      };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = new Promise(resolve => {
        let finished = false;
        const complete = () => { if (finished) return; finished = true; clearTimeout(deadline); flushJournal(); resolve(this.snapshot()); };
        const deadline = setTimeout(() => {
          warnings.add('telemetry-close-timeout');
          server.closeAllConnections();
        }, 1000);
        deadline.unref?.();
        server.close(complete);
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
