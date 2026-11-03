const BASIS = 'post-setup-snapshot-delta-v1';
const REASONS = new Set(['workspace-snapshots-incomplete', 'workspace-file-records-ambiguous',
  'workspace-file-origin-changed', 'workspace-file-identity-missing', 'workspace-file-inventory-limit-exceeded']);
const IDENTITY = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HASH = /^[0-9a-f]{64}$/;
const inventoryLimit = 200;

function snapshotIdentity(record) {
  if (record?.ignored === true) {
    if (typeof record.sha256 !== 'string' || !HASH.test(record.sha256)) return null;
    return JSON.stringify(['ignored', record.sha256, record.size, record.newMode, record.symlink]);
  }
  if (typeof record?.oldOid !== 'string' || !IDENTITY.test(record.oldOid)
    || typeof record?.newOid !== 'string' || !IDENTITY.test(record.newOid)) return null;
  return JSON.stringify(['git', record.status, record.oldMode, record.newMode, record.oldOid, record.newOid]);
}

function gitSideIdentity(oid, mode) {
  if (typeof oid !== 'string' || !IDENTITY.test(oid) || typeof mode !== 'string' || !/^\d{6}$/.test(mode)) return undefined;
  const absentByOid = /^0+$/.test(oid), absentByMode = mode === '000000';
  if (absentByOid !== absentByMode) return undefined;
  return absentByOid ? null : JSON.stringify([oid, mode]);
}

function trackedSnapshotStates(before, taskEnd) {
  const baseline = record => gitSideIdentity(record.oldOid, record.oldMode);
  const current = record => gitSideIdentity(record.newOid, record.newMode);
  if (before && taskEnd) {
    const beforeBaseline = baseline(before), taskEndBaseline = baseline(taskEnd);
    if (beforeBaseline === undefined || taskEndBaseline === undefined || beforeBaseline !== taskEndBaseline) return null;
  }
  const beforeState = before ? current(before) : baseline(taskEnd);
  const taskEndState = taskEnd ? current(taskEnd) : baseline(before);
  if (beforeState === undefined || taskEndState === undefined) return null;
  return [beforeState, taskEndState];
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096
    && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..')
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Derive file counts and paths together from one complete snapshot delta. */
export function deriveAuditFileInventory(before, taskEnd) {
  const fingerprints = { postSetup: before?.fingerprint ?? null, taskEnd: taskEnd?.fingerprint ?? null };
  const unknown = reason => ({ schemaVersion: 1, status: 'unknown', basis: BASIS, fingerprints,
    entries: [], counts: null, reason });
  if (!before || !taskEnd || !Array.isArray(before.files) || !Array.isArray(taskEnd.files)
    || typeof before.fingerprint !== 'string' || typeof taskEnd.fingerprint !== 'string') return unknown('workspace-snapshots-incomplete');
  const index = snapshot => {
    const records = new Map();
    for (const record of snapshot.files) {
      if (!record || !validPath(record.path) || records.has(record.path)) return null;
      records.set(record.path, record);
    }
    return records;
  };
  const left = index(before), right = index(taskEnd);
  if (!left || !right) return unknown('workspace-file-records-ambiguous');
  const entries = [], counts = { tracked: 0, ignored: 0 };
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(path), b = right.get(path);
    if (a && b && (a.ignored === true) !== (b.ignored === true)) return unknown('workspace-file-origin-changed');
    const origin = (b ?? a).ignored === true ? 'ignored' : 'tracked';
    let change;
    if (origin === 'ignored') {
      if ((a && snapshotIdentity(a) === null) || (b && snapshotIdentity(b) === null))
        return unknown('workspace-file-identity-missing');
      if (!a) change = 'added';
      else if (!b) change = 'deleted';
      else {
        const oldIdentity = snapshotIdentity(a), newIdentity = snapshotIdentity(b);
        if (oldIdentity === null || newIdentity === null) return unknown('workspace-file-identity-missing');
        if (oldIdentity === newIdentity) continue;
        change = 'modified';
      }
    } else {
      const states = trackedSnapshotStates(a, b);
      if (!states) return unknown('workspace-file-identity-missing');
      const [beforeState, taskEndState] = states;
      if (beforeState === taskEndState) continue;
      change = beforeState === null ? 'added' : taskEndState === null ? 'deleted' : 'modified';
    }
    if (entries.length >= inventoryLimit) return unknown('workspace-file-inventory-limit-exceeded');
    counts[origin]++;
    entries.push({ path, change, origin });
  }
  if (before.fingerprint === taskEnd.fingerprint && entries.length)
    return unknown('workspace-file-records-ambiguous');
  const inventory = { schemaVersion: 1, status: 'recorded', basis: BASIS, fingerprints,
    entries, counts: { ...counts, total: entries.length }, reason: null };
  return projectAuditFileInventory(inventory, { postSetupFingerprint: before.fingerprint, taskEndFingerprint: taskEnd.fingerprint });
}

/** Validate and project only self-contained inventories bound to their snapshots. */
export function projectAuditFileInventory(value, { postSetupFingerprint, taskEndFingerprint, changedFileCount } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || value.basis !== BASIS
    || !value.fingerprints || typeof value.fingerprints !== 'object' || Array.isArray(value.fingerprints)
    || !Array.isArray(value.entries)) return null;
  const fingerprints = { postSetup: value.fingerprints.postSetup, taskEnd: value.fingerprints.taskEnd };
  for (const fingerprint of Object.values(fingerprints))
    if (fingerprint !== null && (typeof fingerprint !== 'string' || !HASH.test(fingerprint))) return null;
  if (value.status === 'recorded' && (!HASH.test(fingerprints.postSetup ?? '') || !HASH.test(fingerprints.taskEnd ?? ''))) return null;
  if ((postSetupFingerprint !== undefined && fingerprints.postSetup !== postSetupFingerprint)
    || (taskEndFingerprint !== undefined && fingerprints.taskEnd !== taskEndFingerprint)) return null;
  if (value.status === 'unknown') {
    if (value.counts !== null || value.entries.length || !REASONS.has(value.reason)) return null;
    return { schemaVersion: 1, status: 'unknown', basis: BASIS, fingerprints, entries: [], counts: null, reason: value.reason };
  }
  if (value.status !== 'recorded' || value.reason !== null || value.entries.length > inventoryLimit
    || !value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts)) return null;
  const entries = [];
  const seen = new Set();
  const counts = { tracked: 0, ignored: 0 };
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !validPath(entry.path)
      || !['added', 'modified', 'deleted'].includes(entry.change) || !['tracked', 'ignored'].includes(entry.origin)
      || seen.has(entry.path)) return null;
    seen.add(entry.path);
    counts[entry.origin]++;
    entries.push({ path: entry.path, change: entry.change, origin: entry.origin });
  }
  const derived = { ...counts, total: entries.length };
  const countKeys = Object.keys(value.counts).sort();
  if (countKeys.length !== 3 || countKeys.join(',') !== 'ignored,total,tracked'
    || value.counts.tracked !== derived.tracked || value.counts.ignored !== derived.ignored || value.counts.total !== derived.total
    || changedFileCount !== undefined && changedFileCount !== entries.length) return null;
  return { schemaVersion: 1, status: 'recorded', basis: BASIS, fingerprints, entries, counts: derived, reason: null };
}
