import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync,
  renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { redactValue } from './redact.js';
import { validSkillSourceTime } from './audit-source-time.js';
import { projectDeliveryAccounting } from './audit-delivery.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const HEADER_KIND = 'skill-telemetry-journal';
const HEADER_VERSION = 2;
const UID = typeof process.getuid === 'function' ? process.getuid() : null;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

const HEALTH_FIELDS = Object.freeze({
  status: 'unknown', mode: 'unknown', format: 2, commit: 'unavailable',
  bytes: 0, eventCount: 0, committedBytes: 0, committedEvents: 0, uncertainBytes: 0,
});

function health(overrides = {}) { return { ...HEALTH_FIELDS, ...overrides }; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function genericWarning(value) { return typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value) ? value : 'telemetry-journal-failed'; }
function validPath(path) { return typeof path === 'string' && isAbsolute(path) && !path.includes('\0'); }
function validStreamId(value) { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value); }
function privateStat(stat, { regular = true } = {}) {
  const one = typeof stat.nlink === 'bigint' ? 1n : 1;
  const mask = typeof stat.mode === 'bigint' ? 0o077n : 0o077;
  const zero = typeof stat.mode === 'bigint' ? 0n : 0;
  const uid = typeof stat.uid === 'bigint' ? BigInt(UID ?? 0) : UID;
  return (!regular || stat.isFile()) && stat.nlink === one && (stat.mode & mask) === zero
    && (UID === null || stat.uid === uid);
}
function sameIdentity(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino;
}
function stableStat(a, b) {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
}
function pathIdentity(path, expected) {
  try {
    const current = lstatSync(path, { bigint: true });
    return current.isFile() && current.nlink === 1n && (current.mode & 0o077n) === 0n
      && (UID === null || current.uid === BigInt(UID))
      && current.dev === expected.dev && current.ino === expected.ino;
  } catch { return false; }
}
function writeAll(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = writeSync(fd, buffer, offset, buffer.length - offset);
    if (count <= 0) throw new Error('write-failed');
    offset += count;
  }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function ensurePrivateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (UID !== null && stat.uid !== UID)) throw new Error('directory-not-private');
}
function jsonLine(value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || text.includes('\n') || text.includes('\r')) throw new Error('invalid-json-line');
  return Buffer.from(`${text}\n`, 'utf8');
}

function projectedEvent(line) {
  const value = JSON.parse(line);
  const allowed = new Set(['source', 'threadId', 'turnId', 'skillName', 'scope', 'pluginId', 'invocationType', 'timestampNs', 'observationId', 'sourceTime']);
  const id = item => typeof item === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(item) && redactValue(item) === item;
  const safeName = item => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._:@+-]{0,119}$/.test(item)
    && !item.includes('/') && !item.includes('\\') && redactValue(item) === item;
  const safePlugin = item => typeof item === 'string' && item.length <= 120
    && !item.includes('://') && !item.includes('\\')
    && /^[A-Za-z0-9][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._@+-]*)*$/.test(item)
    && redactValue(item) === item;
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.has(key))
    && value.source === 'native-otel-skill-invocation' && id(value.threadId) && id(value.turnId)
    && safeName(value.skillName) && ['explicit', 'implicit'].includes(value.invocationType)
    && (value.scope === undefined || ['user', 'repo', 'project', 'system', 'admin', 'profile'].includes(value.scope))
    && (value.pluginId === undefined || safePlugin(value.pluginId))
    && (value.timestampNs === undefined || (typeof value.timestampNs === 'string' && /^\d{1,24}$/.test(value.timestampNs) && BigInt(value.timestampNs) > 0n))
    && (value.sourceTime === undefined || validSkillSourceTime(value.sourceTime))
    && (value.observationId === undefined || (typeof value.observationId === 'string' && /^[a-f0-9]{32}:[1-9][0-9]{0,4}$/.test(value.observationId)));
}

// Accounting contains only reducer output. Validate its shape and string values
// before placing it in a portable sidecar; never accept paths, prose, or secrets.
function safeAccounting(value, expectedScope = 'receiver-lifetime') {
  const projected = projectDeliveryAccounting(value);
  if (!projected || projected.scope !== expectedScope) throw new Error('invalid-accounting');
  return projected;
}

function readPrivateFile(path, maxBytes) {
  if (!validPath(path)) throw new Error('invalid-path');
  const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!privateStat(before) || before.size > BigInt(maxBytes)) throw new Error('invalid-file');
    const size = Number(before.size), data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, data, offset, size - offset, offset);
      if (count <= 0) throw new Error('short-read');
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const pathStat = lstatSync(path, { bigint: true });
    if (!stableStat(before, after) || !sameIdentity(after, pathStat) || !privateStat(pathStat)) throw new Error('unstable-file');
    return { data, stat: after };
  } finally { closeSync(fd); }
}

function parseCompleteLines(bytes) {
  const text = bytes.toString('utf8');
  const length = text.lastIndexOf('\n') + 1;
  if (length !== text.length) throw new Error('partial-record');
  return { lines: text.slice(0, -1).split('\n'), completeBytes: bytes.length };
}

function firstLine(bytes) {
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) throw new Error('missing-header-line');
  return { line: bytes.subarray(0, newline).toString('utf8'), end: newline + 1 };
}

function readLegacy(data, bytes) {
  const text = data.toString('utf8');
  const end = text.lastIndexOf('\n') + 1;
  const complete = text.slice(0, end).split('\n').filter(Boolean);
  const lines = [], warnings = ['telemetry-journal-legacy-unverified'];
  if (end !== text.length) warnings.push('telemetry-journal-truncated-tail');
  for (const line of complete) {
    try { if (projectedEvent(line)) lines.push(line); else warnings.push('telemetry-journal-invalid-record'); }
    catch { warnings.push('telemetry-journal-malformed-record'); }
  }
  return { lines, legacy: true, journal: health({ status: warnings.length === 1 ? 'unknown' : 'partial', mode: 'unknown', format: 1,
    commit: 'legacy-unverified', bytes, eventCount: lines.length, committedBytes: 0, committedEvents: 0, uncertainBytes: bytes }), warnings, bytes };
}

function parseHeader(line) {
  let value;
  try { value = JSON.parse(line); } catch { throw new Error('invalid-header'); }
  if (!value || value.kind !== HEADER_KIND || value.schemaVersion !== HEADER_VERSION || !validStreamId(value.streamId)
    || Object.keys(value).length !== 3) throw new Error('invalid-header');
  return value.streamId;
}

function parseCheckpoint(line) {
  let value;
  try { value = JSON.parse(line); } catch { throw new Error('invalid-checkpoint'); }
  const keys = ['version', 'streamId', 'prefixBytes', 'eventCount', 'prefixSha256', 'accounting'];
  if (!value || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.version !== 2 || !validStreamId(value.streamId)
    || !Number.isSafeInteger(value.prefixBytes) || value.prefixBytes < 1 || value.prefixBytes > MAX_BYTES
    || !Number.isSafeInteger(value.eventCount) || value.eventCount < 0
    || typeof value.prefixSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.prefixSha256)) throw new Error('invalid-checkpoint');
  return { ...value, accounting: safeAccounting(value.accounting) };
}

function unreadable(warning = 'telemetry-journal-unavailable', bytes = 0) {
  return { lines: [], journal: health({ status: 'unavailable', mode: 'required', format: 2, commit: 'unavailable', bytes, uncertainBytes: bytes }), warnings: [genericWarning(warning)], bytes };
}

/** Read only the hash-bound committed prefix from a private v2 journal/checkpoint pair. */
export function readTelemetryJournal(path, { maxBytes = MAX_BYTES } = {}) {
  maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, MAX_BYTES) : MAX_BYTES;
  try {
    if (!validPath(path)) return unreadable('telemetry-journal-invalid-path');
    const dataFile = readPrivateFile(path, maxBytes);
    const bytes = dataFile.data.length;
    const first = firstLine(dataFile.data);
    let checkpointFile;
    try { checkpointFile = readPrivateFile(`${path}.commit.json`, MAX_CHECKPOINT_BYTES); }
    catch (error) {
      // The only legacy format is a valid event-only file with no sidecar at
      // all. A present but invalid sidecar is always treated as a broken v2 pair.
      let sidecarExists = true;
      try { lstatSync(`${path}.commit.json`); } catch (cause) { if (cause?.code === 'ENOENT') sidecarExists = false; }
      if (!sidecarExists && projectedEvent(first.line)) return readLegacy(dataFile.data, bytes);
      throw error;
    }
    const checkpoint = parseCheckpoint(checkpointFile.data.toString('utf8').trimEnd());
    if (!checkpointFile.data.toString('utf8').endsWith('\n')) throw new Error('invalid-checkpoint');
    const streamId = parseHeader(first.line);
    if (streamId !== checkpoint.streamId || checkpoint.prefixBytes > bytes) throw new Error('mismatched-checkpoint');
    const prefix = dataFile.data.subarray(0, checkpoint.prefixBytes);
    if (prefix.length !== checkpoint.prefixBytes || prefix[prefix.length - 1] !== 0x0a || sha256(prefix) !== checkpoint.prefixSha256)
      throw new Error('unverified-prefix');
    const prefixLines = parseCompleteLines(prefix).lines;
    if (prefixLines.length - 1 !== checkpoint.eventCount) throw new Error('event-count-mismatch');
    const eventLines = prefixLines.slice(1);
    for (const line of eventLines) if (!projectedEvent(line)) throw new Error('invalid-event');
    const uncertainBytes = bytes - checkpoint.prefixBytes;
    const warnings = uncertainBytes ? ['telemetry-journal-uncommitted-tail'] : [];
    return {
      lines: eventLines, streamId, legacy: false,
      accounting: projectDeliveryAccounting({ ...checkpoint.accounting, scope: 'committed-prefix' }),
      journal: health({ status: uncertainBytes ? 'partial' : 'available', mode: 'required', format: 2,
        commit: 'committed-prefix', bytes, eventCount: eventLines.length,
        committedBytes: checkpoint.prefixBytes, committedEvents: eventLines.length, uncertainBytes }),
      warnings, bytes,
    };
  } catch {
    // Never reinterpret a broken v2 stream as a legacy event-only journal.
    return unreadable('telemetry-journal-unavailable');
  }
}

/** Create an exclusive private journal and durable hash-bound commit sidecar. */
export function createTelemetryJournal(journalPath, initialAccounting) {
  if (!validPath(journalPath)) throw new TypeError('Invalid telemetry journal path');
  const directory = dirname(journalPath), checkpointPath = `${journalPath}.commit.json`;
  ensurePrivateDirectory(directory);
  try { lstatSync(checkpointPath); throw new Error('checkpoint-exists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw new Error('Unable to initialize required telemetry journal'); }
  const streamId = randomBytes(16).toString('hex');
  let journalFd, failed = false, closed = false, checkpointIdentity = null;
  let bytes = 0, eventCount = 0, committedBytes = 0, committedEvents = 0;
  let accounting;
  const warnings = new Set();
  const markFailed = warning => { failed = true; warnings.add(genericWarning(warning)); };
  let currentDigest;
  const makeCheckpoint = nextAccounting => jsonLine({ version: 2, streamId, prefixBytes: bytes,
    eventCount, prefixSha256: currentDigest.copy().digest('hex'), accounting: nextAccounting });

  try {
    accounting = safeAccounting(initialAccounting);
    journalFd = openSync(journalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    const fileStat = fstatSync(journalFd, { bigint: true });
    if (!privateStat(fileStat)) throw new Error('invalid-journal');
    const header = jsonLine({ kind: HEADER_KIND, schemaVersion: HEADER_VERSION, streamId });
    writeAll(journalFd, header);
    fsyncSync(journalFd);
    bytes = header.length;
    currentDigest = createHash('sha256').update(header);
    syncDirectory(directory);
    publishCheckpoint(accounting, true);
  } catch {
    if (journalFd !== undefined) { try { closeSync(journalFd); } catch {} journalFd = undefined; }
    throw new Error('Unable to initialize required telemetry journal');
  }

  function publishCheckpoint(nextAccounting, initial = false) {
    const safe = safeAccounting(nextAccounting);
    const content = makeCheckpoint(safe);
    const tempPath = join(directory, `.${randomBytes(12).toString('hex')}.commit.tmp`);
    let tempFd;
    try {
      tempFd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
      if (!privateStat(fstatSync(tempFd, { bigint: true }))) throw new Error('invalid-checkpoint-temp');
      writeAll(tempFd, content);
      fsyncSync(tempFd);
      closeSync(tempFd); tempFd = undefined;
      if (initial) {
        linkSync(tempPath, checkpointPath);
        unlinkSync(tempPath);
      } else renameSync(tempPath, checkpointPath);
      syncDirectory(directory);
      const stat = lstatSync(checkpointPath, { bigint: true });
      if (!privateStat(stat)) throw new Error('invalid-checkpoint');
      checkpointIdentity = stat;
      committedBytes = bytes; committedEvents = eventCount; accounting = safe;
    } catch (error) {
      if (tempFd !== undefined) { try { closeSync(tempFd); } catch {} }
      // A failed rename/sync is evidence of uncertain commit state. Keep any
      // created temp/checkpoint bytes for recovery instead of deleting them.
      throw error;
    }
  }

  function currentJournalMatches() {
    if (!pathIdentity(journalPath, fstatSync(journalFd, { bigint: true }))) return false;
    if (!pathIdentity(checkpointPath, checkpointIdentity)) return false;
    const stat = fstatSync(journalFd, { bigint: true });
    return stat.size === BigInt(bytes);
  }

  return {
    get streamId() { return streamId; },
    append(events, nextAccounting = accounting) {
      if (failed || closed || journalFd === undefined) return false;
      try {
        if (!Array.isArray(events) || !currentJournalMatches()) throw new Error('journal-replaced');
        const nextSafe = safeAccounting(nextAccounting);
        const rows = events.map(event => {
          const line = jsonLine(event);
          if (!projectedEvent(line.toString('utf8').slice(0, -1))) throw new Error('invalid-event');
          return line;
        });
        const data = Buffer.concat(rows);
        if (bytes + data.length > MAX_BYTES) throw new Error('journal-byte-limit');
        if (data.length) writeAll(journalFd, data);
        fsyncSync(journalFd);
        currentDigest.update(data);
        bytes += data.length;
        eventCount += events.length;
        publishCheckpoint(nextSafe);
        return true;
      } catch (error) {
        try {
          const actual = Number(fstatSync(journalFd, { bigint: true }).size);
          if (Number.isSafeInteger(actual) && actual >= bytes && actual <= MAX_BYTES) bytes = actual;
        } catch {}
        markFailed(error?.message === 'journal-byte-limit' ? 'telemetry-journal-byte-limit' : 'telemetry-journal-commit-failed');
        return false;
      }
    },
    snapshot() {
      const status = failed ? 'partial' : 'available';
      return { ...health({ status, mode: 'required', format: 2, commit: failed ? 'failed' : 'committed-prefix',
        bytes, eventCount, committedBytes, committedEvents, uncertainBytes: Math.max(0, bytes - committedBytes) }),
        warnings: [...warnings] };
    },
    close() {
      if (closed) return this.snapshot();
      closed = true;
      if (journalFd !== undefined) {
        try { fsyncSync(journalFd); } catch { markFailed('telemetry-journal-close-failed'); }
        try { closeSync(journalFd); } catch { markFailed('telemetry-journal-close-failed'); }
        journalFd = undefined;
      }
      return this.snapshot();
    },
  };
}
