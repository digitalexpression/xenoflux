import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { redactValue } from './redact.js';

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
  const allowed = new Set(['source', 'threadId', 'turnId', 'skillName', 'scope', 'pluginId', 'invocationType', 'timestampNs', 'observationId']);
  if (Object.keys(event).some(key => !allowed.has(key))) return false;
  if (event.scope !== undefined && !SAFE_SCOPE.has(event.scope)) return false;
  if (event.pluginId !== undefined && !boundedPluginId(event.pluginId)) return false;
  if (event.timestampNs !== undefined && positiveTimestampNs(event.timestampNs) === null) return false;
  if (event.observationId !== undefined && (typeof event.observationId !== 'string' || !OBSERVATION_ID.test(event.observationId))) return false;
  return true;
}

/** Read a bounded JSONL journal containing projected events only. */
export function readAuditSkillTelemetry(journalPath, { maxBytes = MAX_JOURNAL_BYTES, maxEvents = DEFAULT_EVENTS } = {}) {
  const events = [], warnings = [];
  maxBytes = limit(maxBytes, MAX_JOURNAL_BYTES, MAX_JOURNAL_BYTES);
  maxEvents = limit(maxEvents, DEFAULT_EVENTS, DEFAULT_EVENTS);
  let fd;
  try {
    if (typeof journalPath !== 'string' || !isAbsolute(journalPath)) throw new Error();
    fd = openSync(journalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd, { bigint: true });
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
    const privateFile = stat.isFile() && stat.nlink === 1n && (stat.mode & 0o077n) === 0n && (uid === null || stat.uid === uid);
    if (!privateFile || stat.size > BigInt(maxBytes)) {
      warnings.push(!privateFile ? 'telemetry-journal-not-private' : 'telemetry-journal-byte-limit');
      return { events, metadata: { status: 'partial', delivery: 'best-effort', bytes: 0, eventCount: 0, warnings } };
    }
    const size = Number(stat.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, offset, size - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size
      || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs || stat.mode !== after.mode
      || stat.uid !== after.uid || stat.nlink !== after.nlink)
      warnings.push('telemetry-journal-changed-during-read');
    const text = buffer.subarray(0, offset).toString('utf8');
    const completeLength = text.lastIndexOf('\n') + 1;
    if (completeLength !== text.length) warnings.push('telemetry-journal-truncated-tail');
    for (const line of text.slice(0, completeLength).split('\n')) {
      if (!line) continue;
      if (events.length >= maxEvents) { warnings.push('telemetry-journal-event-limit'); break; }
      let value;
      try { value = JSON.parse(line); } catch { warnings.push('telemetry-journal-malformed-record'); continue; }
      if (!validProjectedEvent(value)) { warnings.push('telemetry-journal-invalid-record'); continue; }
      events.push(value);
    }
    return { events, metadata: { status: warnings.length ? 'partial' : events.length ? 'available' : 'unknown', delivery: 'best-effort', bytes: offset, eventCount: events.length, warnings } };
  } catch {
    return { events, metadata: { status: 'unavailable', delivery: 'best-effort', bytes: 0, eventCount: 0, warnings: ['telemetry-journal-unavailable'] } };
  } finally { if (fd !== undefined) closeSync(fd); }
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

function project(body, events, maxEvents) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.resourceLogs))
    return { accepted: 0, invalid: true, invalidRecords: 0, truncated: false };
  let accepted = 0, processed = 0, invalidRecords = 0, truncated = false;
  for (const resource of body.resourceLogs) {
    if (!Array.isArray(resource?.scopeLogs)) continue;
    for (const scope of resource.scopeLogs) {
      if (!Array.isArray(scope?.logRecords)) continue;
      for (const record of scope.logRecords) {
        if (processed >= MAX_RECORDS_PER_REQUEST) { truncated = true; break; }
        processed++;
        const attrs = attrMap(record?.attributes);
        if (!attrs) { invalidRecords++; continue; }
        if (attrs['event.name'] !== 'codex.skill_invocation' || events.length >= maxEvents) continue;
        const conversationId = attrs['conversation.id'];
        const turnId = attrs['turn.id'];
        const name = boundedString(attrs['skill.name'], 120);
        const skillScope = boundedString(attrs['skill.scope'], 40);
        const pluginId = boundedPluginId(attrs['skill.plugin_id']);
        const invocationType = boundedString(attrs['skill.invocation_type'], 20);
        // IDs and skill name/type are required for attribution. Optional fields
        // remain omitted when absent; invalid values never enter the snapshot.
        if (!ID.test(conversationId ?? '') || !ID.test(turnId ?? '')
          || redactValue(conversationId) !== conversationId || redactValue(turnId) !== turnId
          || !name || !SAFE_INVOCATION.has(invocationType)
          || (attrs['skill.plugin_id'] !== undefined && !pluginId)) { invalidRecords++; continue; }
        const event = {
          source: 'native-otel-skill-invocation', threadId: conversationId, turnId,
          skillName: name, invocationType,
        };
        if (SAFE_SCOPE.has(skillScope)) event.scope = skillScope;
        if (pluginId) event.pluginId = pluginId;
        const timestamp = positiveTimestampNs(record.timeUnixNano) ?? positiveTimestampNs(attrs['event.timestamp']);
        if (timestamp) event.timestampNs = timestamp;
        events.push(event);
        accepted++;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { accepted, invalid: false, invalidRecords, truncated };
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
  const streamId = randomBytes(16).toString('hex');
  let observationIndex = 0;
  const events = [];
  const warnings = new Set();
  let journalFd = null, journalBytes = 0, journalEventCount = 0, journalStatus = journalPath ? 'available' : 'disabled';
  if (journalPath !== undefined) {
    if (typeof journalPath !== 'string' || !isAbsolute(journalPath)) throw new TypeError('Invalid telemetry journal path');
    try {
      journalFd = openSync(journalPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      const stat = fstatSync(journalFd);
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid)) throw new Error('invalid journal file');
    } catch { if (journalFd !== null) closeSync(journalFd); throw new Error('Unable to create private telemetry journal'); }
  }
  const persistEvents = projected => {
    if (journalFd === null || projected.length === 0) return true;
    const data = Buffer.from(projected.map(event => `${JSON.stringify(event)}\n`).join(''), 'utf8');
    if (journalBytes + data.length > MAX_JOURNAL_BYTES) { warnings.add('telemetry-journal-byte-limit'); journalStatus = 'partial'; return false; }
    try {
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(journalFd, data, offset, data.length - offset);
        if (written <= 0) throw new Error('journal write made no progress');
        offset += written;
      }
      fsyncSync(journalFd);
      journalBytes += data.length;
      journalEventCount += projected.length;
      return true;
    } catch {
      warnings.add('telemetry-journal-write-failed'); journalStatus = 'partial';
      try { closeSync(journalFd); } catch {}
      journalFd = null;
      return false;
    }
  };
  const flushJournal = () => {
    if (journalFd === null) return;
    try { fsyncSync(journalFd); } catch { warnings.add('telemetry-journal-flush-failed'); journalStatus = 'partial'; }
    try { closeSync(journalFd); } catch { warnings.add('telemetry-journal-close-failed'); journalStatus = 'partial'; }
    journalFd = null;
  };
  let receivedBytes = 0, inFlightBytes = 0, active = 0, closed = false, rejected = 0;
  const server = createServer((req, res) => {
    if (closed) { res.writeHead(503).end(); return; }
    if (active >= maxConnections) { rejected++; warnings.add('telemetry-connection-limit'); res.writeHead(503).end(); req.resume(); return; }
    active++;
    let done = false;
    const finish = () => { if (!done) { done = true; active--; } };
    req.on('close', finish);
    const reject = (status, warning) => {
      rejected++; if (warning) warnings.add(warning);
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
    req.on('error', () => { releaseBytes(); warnings.add('telemetry-byte-limit'); rejected++; finish(); });
    req.on('end', () => {
      releaseBytes();
      if (tooLarge) { warnings.add('telemetry-byte-limit'); rejected++; finish(); return; }
      receivedBytes += requestBytes;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks, requestBytes).toString('utf8')); }
      catch { return reject(400, 'telemetry-malformed-json'); }
      const projection = project(payload, events, maxEvents);
      if (projection.accepted) warnings.add('telemetry-events-observed');
      if (projection.invalid) warnings.add('telemetry-invalid-otlp-payload');
      if (projection.invalidRecords) warnings.add('telemetry-invalid-record');
      if (projection.truncated) warnings.add('telemetry-record-limit');
      if (events.length >= maxEvents) warnings.add('telemetry-event-limit');
      const projected = events.slice(events.length - projection.accepted);
      for (const event of projected) event.observationId = `${streamId}:${++observationIndex}`;
      if (!persistEvents(projected)) {
        events.splice(events.length - projection.accepted, projection.accepted);
        return reject(503, 'telemetry-journal-unavailable');
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ partialSuccess: {} }));
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
      const snapshotWarnings = [...warnings].filter(value => value !== 'telemetry-events-observed');
      const status = snapshotWarnings.length ? 'partial' : events.length ? 'observed' : 'unknown';
      return {
        events: structuredClone(events),
        metadata: {
          source: 'native-otel-skill-invocation', transport: 'otlp-http-json', endpoint: 'loopback-random-port',
          status, delivery: 'best-effort', capability: events.length ? 'observed' : 'unknown',
          observerEffects: ['enables native OTLP log export for this process', 'other native log events are discarded'],
          promptLogging: false, receivedBytes, rejectedRequests: rejected,
          warnings: snapshotWarnings,
          journal: { status: journalStatus, bytes: journalBytes, eventCount: journalEventCount },
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
