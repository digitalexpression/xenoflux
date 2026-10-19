// Durable, private records for controlled audit experiments. Native transcripts
// remain in their owning Codex homes; this store contains only scoped evidence.
import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, rename, unlink, link } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { acquire, privateDirectory, readJSON, release } from './metadata.js';
import { projectReportResourceProvenance } from './audit-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 16 * 1024 * 1024;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const auditsPath = store => join(store.directory, 'audits');

function encode(value) {
  const text = `${JSON.stringify(projectReportResourceProvenance(value), null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Audit record exceeds the 16 MiB limit');
  return text;
}

function validateId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Audit record ID must be a UUID');
}

async function privateParent(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  await privateDirectory(path);
}

async function syncDirectory(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY); await handle.sync(); }
  finally { await handle?.close(); }
}

async function atomicWrite(directory, name, value, { exclusive = false } = {}) {
  const path = join(directory, name), temp = join(directory, `.${name}.${randomUUID()}.tmp`);
  const data = encode(value);
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
    if (exclusive) {
      try { await lstat(path); throw new Error('Audit final report is immutable and already exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      try {
        const old = await lstat(path);
        if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1 || old.uid !== process.getuid() || (old.mode & 0o077))
          throw new Error('Unsafe audit state file; preserving it');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // link() provides an atomic no-replace publish; remove the temporary link
    // immediately so the durable record has link count one.
    if (exclusive) {
      try { await link(temp, path); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Audit final report is immutable and already exists');
        throw error;
      }
      await unlink(temp);
    } else await rename(temp, path);
    await syncDirectory(directory);
    return path;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function readSafeJSON(path, { optional = false } = {}) {
  let before;
  try { before = await lstat(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid()
    || (before.mode & 0o077) || before.size > MAX_BYTES || await realpath(path) !== path)
    throw new Error('Unsafe or oversized audit record; preserving it');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const now = await handle.stat();
    if (now.dev !== before.dev || now.ino !== before.ino || now.size !== before.size) throw new Error('Audit record changed while reading');
    const bytes = Buffer.alloc(now.size); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== now.size || after.size !== now.size || after.mtimeMs !== now.mtimeMs) throw new Error('Audit record changed while reading');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}

async function recordDirectory(store, id) {
  validateId(id);
  await privateParent(store.directory);
  const root = await realpath(store.directory), base = await realpath(auditsPath(store));
  if (base !== join(root, 'audits')) throw new Error('Audit store path is unsafe');
  const directory = join(base, id);
  await privateDirectory(directory);
  if (await realpath(directory) !== directory || dirname(directory) !== base) throw new Error('Audit record path escaped its store');
  return directory;
}

function assertJsonRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  encode(value);
}

/** Create an experiment's durable manifest and initial mutable state. */
export async function createExperiment(store, { spec, task, profiles, baseline = null, id: requestedId, series = null } = {}) {
  if (!store || typeof store.directory !== 'string') throw new Error('Audit experiment store is unavailable');
  const id = requestedId ?? randomUUID();
  validateId(id);
  if (series !== null && (!series || typeof series !== 'object' || Array.isArray(series)
    || !UUID.test(series.id ?? '') || !Number.isSafeInteger(series.trialIndex) || series.trialIndex < 0))
    throw new Error('Experiment series reference needs a UUID and nonnegative trial index');
  const root = auditsPath(store);
  await privateParent(store.directory);
  await privateParent(root, true);
  const directory = join(await realpath(root), id);
  await mkdir(directory, { mode: 0o700 });
  await privateDirectory(directory);
  const record = { schemaVersion: 1, kind: 'audit-experiment', id, createdAt: new Date().toISOString(), spec, task, profiles, baseline,
    ...(series ? { series: { id: series.id, trialIndex: series.trialIndex } } : {}) };
  const state = { schemaVersion: 1, kind: 'audit-experiment-state', id, status: 'prepared', updatedAt: record.createdAt, coordinator: { pid: process.pid, host: hostname(), processIdentity: null }, runs: [] };
  try {
    assertJsonRecord(record, 'Experiment manifest'); assertJsonRecord(state, 'Experiment state');
    await atomicWrite(directory, 'experiment.json', record, { exclusive: true });
    await atomicWrite(directory, 'state.json', state, { exclusive: true });
    await syncDirectory(root);
  } catch (error) {
    // The UUID was created by this call. Remove only its known files and dir.
    for (const name of ['experiment.json', 'state.json']) await unlink(join(directory, name)).catch(() => {});
    const { rmdir } = await import('node:fs/promises'); await rmdir(directory).catch(() => {});
    throw error;
  }
  return { id, directory, record, state };
}

/** Create an immutable series plan with UUID slots assigned before execution. */
export async function createAuditSeries(store, { spec, baseline, profiles, plan, recipe } = {}) {
  if (!store || typeof store.directory !== 'string') throw new Error('Audit experiment store is unavailable');
  if (!Array.isArray(plan) || !plan.length || plan.some((slot, index) => !slot || typeof slot !== 'object'
    || slot.trialIndex !== index || !UUID.test(slot.experimentId ?? '')))
    throw new Error('Audit series plan must contain ordered trial slots with UUID experiment IDs');
  const id = randomUUID(), root = auditsPath(store);
  await privateParent(store.directory); await privateParent(root, true);
  const directory = join(await realpath(root), id); await mkdir(directory, { mode: 0o700 }); await privateDirectory(directory);
  const createdAt = new Date().toISOString();
  const record = { schemaVersion: 1, kind: 'audit-series', id, createdAt, spec, baseline, profiles, plan, recipe };
  const state = { schemaVersion: 1, kind: 'audit-series-state', id, status: 'prepared', updatedAt: createdAt,
    coordinator: { pid: process.pid, host: hostname(), processIdentity: null }, trials: plan.map(slot => ({
      experimentId: slot.experimentId, trialIndex: slot.trialIndex, status: 'not-started' })) };
  try {
    assertJsonRecord(record, 'Audit series manifest'); assertJsonRecord(state, 'Audit series state');
    await atomicWrite(directory, 'series.json', record, { exclusive: true });
    await atomicWrite(directory, 'state.json', state, { exclusive: true }); await syncDirectory(root);
  } catch (error) {
    for (const name of ['series.json', 'state.json']) await unlink(join(directory, name)).catch(() => {});
    const { rmdir } = await import('node:fs/promises'); await rmdir(directory).catch(() => {}); throw error;
  }
  return { id, directory, record, state };
}

/** Create an immutable derived evaluation and its final report in one operation. */
export async function createAuditEvaluation(store, { source, reviews, report } = {}) {
  if (!store || typeof store.directory !== 'string') throw new Error('Audit experiment store is unavailable');
  const id = randomUUID(), root = auditsPath(store);
  await privateParent(store.directory); await privateParent(root, true);
  const directory = join(await realpath(root), id); await mkdir(directory, { mode: 0o700 }); await privateDirectory(directory);
  const createdAt = new Date().toISOString();
  const record = { schemaVersion: 1, kind: 'audit-evaluation', id, createdAt, source, reviews };
  const state = { schemaVersion: 1, kind: 'audit-evaluation-state', id, status: 'complete', updatedAt: createdAt };
  try {
    assertJsonRecord(record, 'Audit evaluation manifest'); assertJsonRecord(state, 'Audit evaluation state');
    await atomicWrite(directory, 'evaluation.json', record, { exclusive: true });
    await atomicWrite(directory, 'state.json', state, { exclusive: true });
    const finalReport = { ...(report ?? {}), schemaVersion: 1, kind: 'audit-evaluation-report', id };
    assertJsonRecord(finalReport, 'Audit evaluation report');
    if (report?.kind && report.kind !== 'audit-evaluation-report') throw new Error('Expected final report kind audit-evaluation-report');
    await atomicWrite(directory, 'report.json', finalReport, { exclusive: true }); await syncDirectory(root);
  } catch (error) {
    for (const name of ['evaluation.json', 'state.json', 'report.json']) await unlink(join(directory, name)).catch(() => {});
    const { rmdir } = await import('node:fs/promises'); await rmdir(directory).catch(() => {}); throw error;
  }
  return await readAuditRecord(store, id);
}

/** Create a direct-ID run record linked to an experiment; safe to resume after restart. */
export async function createExperimentRun(store, { experimentId, profile, task = null, baseline = null } = {}) {
  const parent = await readAuditRecord(store, experimentId);
  if (parent.record.kind !== 'audit-experiment') throw new Error('Run parent is not an audit experiment');
  const id = randomUUID(), root = auditsPath(store), directory = join(await realpath(root), id);
  await mkdir(directory, { mode: 0o700 }); await privateDirectory(directory);
  const now = new Date().toISOString();
  const record = { schemaVersion: 1, kind: 'audit-experiment-run', id, experimentId, profile, task, baseline, createdAt: now };
  const state = { schemaVersion: 1, kind: 'audit-experiment-run-state', id, experimentId, status: 'prepared', updatedAt: now, coordinator: { pid: process.pid, host: hostname(), processIdentity: null } };
  try {
    assertJsonRecord(record, 'Run manifest'); assertJsonRecord(state, 'Run state');
    await atomicWrite(directory, 'run.json', record, { exclusive: true });
    await atomicWrite(directory, 'state.json', state, { exclusive: true }); await syncDirectory(root);
    await writeAuditState(store, experimentId, { runs: [...(parent.state.runs ?? []), { id, profileId: profile?.id ?? null, status: 'prepared' }] });
  } catch (error) {
    const { rmdir } = await import('node:fs/promises');
    for (const name of ['run.json', 'state.json']) await unlink(join(directory, name)).catch(() => {});
    await rmdir(directory).catch(() => {}); throw error;
  }
  return { id, directory, record, state };
}

/** Read one experiment or run by exact UUID, without scanning an index. */
export async function readAuditRecord(store, id) {
  const directory = await recordDirectory(store, id);
  const [experiment, run, series, evaluation, state, report, cleanup, recovery, captureCheckpoint] = await Promise.all([
    readSafeJSON(join(directory, 'experiment.json'), { optional: true }),
    readSafeJSON(join(directory, 'run.json'), { optional: true }),
    readSafeJSON(join(directory, 'series.json'), { optional: true }),
    readSafeJSON(join(directory, 'evaluation.json'), { optional: true }),
    readSafeJSON(join(directory, 'state.json')),
    readSafeJSON(join(directory, 'report.json'), { optional: true }),
    readSafeJSON(join(directory, 'cleanup.json'), { optional: true }),
    readSafeJSON(join(directory, 'recovery.json'), { optional: true }),
    readSafeJSON(join(directory, 'capture-checkpoint.json'), { optional: true }),
  ]);
  const manifests = [experiment, run, series, evaluation].filter(Boolean);
  const record = manifests[0];
  const kinds = { 'audit-experiment': 'audit-experiment-state', 'audit-experiment-run': 'audit-experiment-run-state',
    'audit-series': 'audit-series-state', 'audit-evaluation': 'audit-evaluation-state' };
  if (!record || manifests.length !== 1 || record.id !== id || record.schemaVersion !== 1
    || kinds[record.kind] !== state.kind || state.id !== id)
    throw new Error('Audit record is invalid; preserving its directory');
  const reportKinds = { 'audit-experiment': 'audit-experiment-report', 'audit-experiment-run': 'audit-run',
    'audit-series': 'audit-series-report', 'audit-evaluation': 'audit-evaluation-report' };
  const expectedReportKind = reportKinds[record.kind];
  if (report && (report.id !== id || report.kind !== expectedReportKind || report.schemaVersion !== 1))
    throw new Error('Final audit report is invalid; preserving it');
  if (cleanup && (cleanup.id !== id || cleanup.kind !== 'audit-cleanup' || cleanup.schemaVersion !== 1))
    throw new Error('Audit cleanup receipt is invalid; preserving it');
  if (recovery && (recovery.id !== id || recovery.kind !== 'audit-recovery' || recovery.schemaVersion !== 1))
    throw new Error('Audit recovery receipt is invalid; preserving it');
  if (captureCheckpoint && (record.kind !== 'audit-experiment-run' || captureCheckpoint.id !== id
    || captureCheckpoint.experimentId !== record.experimentId || captureCheckpoint.kind !== 'audit-capture-checkpoint'
    || captureCheckpoint.schemaVersion !== 1 || !UUID.test(captureCheckpoint.threadId ?? '')
    || typeof captureCheckpoint.profileHome !== 'string' || !captureCheckpoint.profileHome.startsWith('/')))
    throw new Error('Audit capture checkpoint identity is invalid; preserving it');
  if (record.kind === 'audit-evaluation' && !report) throw new Error('Audit evaluation report is missing; preserving its directory');
  if (record.kind === 'audit-series') {
    if (!Array.isArray(record.plan) || !Array.isArray(state.trials) || record.plan.length !== state.trials.length
      || record.plan.some((slot, index) => !UUID.test(slot?.experimentId ?? '') || slot.trialIndex !== index
        || state.trials[index]?.experimentId !== slot.experimentId || state.trials[index]?.trialIndex !== index))
      throw new Error('Audit series plan and state identities are inconsistent; preserving its directory');
  }
  const expectedCaptureHome = record.profile?.home ?? record.profile?.userHome;
  if (captureCheckpoint && expectedCaptureHome && captureCheckpoint.profileHome !== expectedCaptureHome)
    throw new Error('Audit capture checkpoint profile identity is invalid; preserving it');
  return projectReportResourceProvenance({ id, directory, record, state, report, cleanup, recovery, captureCheckpoint, finalized: report !== null });
}

/** Persist the latest normalized in-memory capture under the run's immutable identity. */
export async function writeAuditCaptureCheckpoint(store, id, { run, capture } = {}) {
  const current = await readAuditRecord(store, id);
  if (current.record.kind !== 'audit-experiment-run' || current.finalized)
    throw new Error('Capture checkpoints require an unfinished audit run');
  if (!run || typeof run !== 'object' || Array.isArray(run) || !capture || typeof capture !== 'object' || Array.isArray(capture))
    throw new Error('Audit capture checkpoint needs normalized run and capture objects');
  const threadId = run.source?.threadId;
  const profileHome = run.profile?.home ?? run.profile?.userHome;
  if (run.id && run.id !== id) throw new Error('Audit capture run ID does not match its record');
  if (!UUID.test(threadId ?? '') || typeof profileHome !== 'string' || !profileHome.startsWith('/'))
    throw new Error('Audit capture checkpoint is missing its native thread or profile-home identity');
  const expectedHome = current.record.profile?.home ?? current.record.profile?.userHome;
  if (expectedHome && expectedHome !== profileHome) throw new Error('Audit capture profile-home identity changed; preserving checkpoint');
  if (current.captureCheckpoint && (current.captureCheckpoint.threadId !== threadId || current.captureCheckpoint.profileHome !== profileHome))
    throw new Error('Audit capture checkpoint identity changed; preserving checkpoint');
  const value = projectReportResourceProvenance({ schemaVersion: 1, kind: 'audit-capture-checkpoint', id,
    experimentId: current.record.experimentId, threadId, profileHome,
    capturedAt: new Date().toISOString(), run, capture });
  assertJsonRecord(value, 'Audit capture checkpoint');
  await atomicWrite(current.directory, 'capture-checkpoint.json', value);
  return value;
}

/** Replace only mutable state, preserving the record identity and finalized report. */
export async function writeAuditState(store, id, patch) {
  const current = await readAuditRecord(store, id);
  if (current.finalized) throw new Error('Finalized audit state is immutable');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Audit state update must be an object');
  const state = { ...current.state, ...patch, schemaVersion: 1, id, updatedAt: new Date().toISOString() };
  assertJsonRecord(state, 'Audit state');
  await atomicWrite(current.directory, 'state.json', state);
  return state;
}

/** Write one final normalized report. Existing final reports are never replaced. */
export async function finalizeAuditRecord(store, id, report) {
  const current = await readAuditRecord(store, id);
  if (current.finalized) throw new Error('Final audit report is immutable and already exists');
  const kind = { 'audit-experiment': 'audit-experiment-report', 'audit-experiment-run': 'audit-run',
    'audit-series': 'audit-series-report', 'audit-evaluation': 'audit-evaluation-report' }[current.record.kind];
  if (!kind) throw new Error('Unsupported audit record kind');
  if (report?.kind && report.kind !== kind) throw new Error(`Expected final report kind ${kind}`);
  const value = projectReportResourceProvenance({ ...report, schemaVersion: 1, kind, id });
  assertJsonRecord(value, 'Final audit report');
  await atomicWrite(current.directory, 'report.json', value, { exclusive: true });
  return value;
}

/** Persist an immutable, bounded cleanup/recovery receipt without changing a final report. */
export async function recordAuditCleanup(store, id, receipt) {
  const current = await readAuditRecord(store, id);
  if (current.cleanup) throw new Error('Audit cleanup receipt is immutable and already exists');
  const value = { ...receipt, schemaVersion: 1, kind: 'audit-cleanup', id };
  assertJsonRecord(value, 'Audit cleanup receipt');
  await atomicWrite(current.directory, 'cleanup.json', value, { exclusive: true });
  return value;
}

/** Persist one immutable recovery receipt; retries return the saved decision. */
export async function recordAuditRecovery(store, id, receipt) {
  const current = await readAuditRecord(store, id);
  if (current.recovery) return { alreadyRecovered: true, receipt: current.recovery };
  const value = { ...receipt, schemaVersion: 1, kind: 'audit-recovery', id };
  assertJsonRecord(value, 'Audit recovery receipt');
  try {
    await atomicWrite(current.directory, 'recovery.json', value, { exclusive: true });
    return { alreadyRecovered: false, receipt: value };
  } catch (error) {
    // Another coordinator may have completed recovery after our snapshot.
    if (/immutable and already exists/.test(error.message)) {
      const latest = await readSafeJSON(join(current.directory, 'recovery.json'));
      if (latest?.id === id && latest.kind === 'audit-recovery' && latest.schemaVersion === 1)
        return { alreadyRecovered: true, receipt: latest };
    }
    throw error;
  }
}

function validateReservationOwner(owner) {
  if (!owner || owner.kind !== 'audit-experiment' || owner.host !== hostname() || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0 || !UUID.test(owner.runId ?? '') || !UUID.test(owner.experimentId ?? '')
    || typeof owner.storePath !== 'string' || !owner.storePath.startsWith('/') || typeof owner.profileId !== 'string' || !owner.profileId
    || typeof owner.home !== 'string' || !owner.home.startsWith('/'))
    throw new Error('Invalid audit profile reservation owner');
}

async function auditLeasePath(owner, { create = false } = {}) {
  validateReservationOwner(owner);
  await privateDirectory(owner.storePath);
  const store = await realpath(owner.storePath);
  if (store !== owner.storePath) throw new Error('Audit reservation store path must be canonical');
  const audits = join(store, 'audits'), leases = join(audits, 'leases');
  if (create) { await privateParent(audits, true); await privateParent(leases, true); }
  else {
    try { await privateDirectory(audits); await privateDirectory(leases); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const digest = createHash('sha256').update(owner.home).digest('hex');
  return join(leases, digest);
}

async function validateReservationRoot(root, owner) {
  if (typeof root !== 'string' || !root.startsWith('/')) throw new Error('Audit reservation requires an absolute profile home');
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || await realpath(root) !== root)
    throw new Error('Audit reservation root must be a canonical directory owned by this user');
  if (owner.home === root) {
    // The machine's default ~/.codex directory is commonly 0755. It is a
    // source home and must never be chmodded; only reject group/other writes.
    if (stat.mode & 0o022) throw new Error('Default Codex home must not be writable by group or others');
  } else {
    // A named isolated profile's native root remains strictly private.
    await privateDirectory(root);
  }
}

/** Return null when free, otherwise the exact durable lock owner. Never reclaim. */
export async function inspectAuditReservation({ root, owner } = {}) {
  validateReservationOwner(owner);
  const allowedHome = owner.home === root || owner.home === join(root, 'codex-home');
  await validateReservationRoot(root, owner);
  if (!allowedHome || await realpath(owner.home) !== owner.home)
    throw new Error('Audit reservation home does not match its native-root identity');
  const lock = await auditLeasePath(owner);
  if (!lock) return null;
  try { await lstat(lock); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  await privateDirectory(lock);
  const current = await readJSON(join(lock, 'owner.json'));
  return current;
}

/** Reserve an audit-only lease for a native home without touching Xenoflux's .run-lock. */
export async function reserveAuditProfile({ root, owner } = {}) {
  validateReservationOwner(owner);
  const allowedHome = owner.home === root || owner.home === join(root, 'codex-home');
  if (!allowedHome || await realpath(owner.home) !== owner.home)
    throw new Error('Audit reservation home does not match its native-root identity');
  await validateReservationRoot(root, owner);
  const lock = await auditLeasePath(owner, { create: true });
  await acquire(lock, owner, false);
  const observed = await inspectAuditReservation({ root, owner });
  if (!equal(observed, owner)) throw new Error('Audit profile reservation ownership changed; preserving it');
  return { root, lock, owner };
}

/** Release only the exact reservation acquired by this audit run. */
export async function releaseAuditProfileReservation({ root, owner } = {}) {
  validateReservationOwner(owner);
  const allowedHome = owner.home === root || owner.home === join(root, 'codex-home');
  if (!allowedHome || await realpath(owner.home) !== owner.home)
    throw new Error('Audit reservation home does not match its native-root identity');
  const observed = await inspectAuditReservation({ root, owner });
  if (!observed) return false;
  if (!equal(observed, owner)) throw new Error('Audit profile reservation belongs to another operation; preserving it');
  await release(await auditLeasePath(owner), owner);
  return true;
}
