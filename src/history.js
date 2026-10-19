// History discovery is read-only. Actual resume may normalize one validated
// alias-recorded path in the source index. Only explicit turn inspection scans a
// selected rollout; it returns whitelisted metadata, never conversation content.
import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep, resolve } from 'node:path';
import { find } from './profiles.js';
import { resolveHome } from './homes.js';
import { redactText } from './redact.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validUUID = value => typeof value === 'string' && uuid.test(value);
const databaseName = 'state_5.sqlite';
const requiredColumns = new Set(['id', 'cwd', 'title', 'created_at', 'updated_at', 'archived']);
const MAX_LIMIT = 100;
const MAX_QUERY = 256;
const MAX_TITLE = 500;
const MAX_ROLLOUT_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_TURN_RECORDS = 10000;

function boundedLimit(value = 50) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw new Error(`History limit must be an integer from 1 to ${MAX_LIMIT}`);
  return value;
}

function boundedQuery(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_QUERY || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('History query must be plain text of at most 256 characters');
  return value;
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cleanTitle(value) {
  const plain = text(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, MAX_TITLE);
  if (!plain) return { title: 'Untitled task', titleFallback: true };
  try {
    const redacted = redactText(plain, 'title.txt').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, MAX_TITLE);
    return redacted ? { title: redacted, titleFallback: false } : { title: 'Untitled task', titleFallback: true };
  } catch { return { title: 'Untitled task', titleFallback: true }; }
}

async function regularUnlinked(path, optional = false) {
  try {
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1) throw new Error('not a regular unlinked file');
    return true;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return false;
    if (error.code === 'ENOENT') throw error;
    throw new Error(`Unsafe history database path: ${path}`);
  }
}

async function checkedDatabase(home) {
  const directory = await lstat(home);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe native home path');
  const database = join(home, databaseName);
  if (!await regularUnlinked(database, true)) return null;
  // SQLite reads these files when present. Refuse links rather than allowing a
  // bound home to redirect this metadata reader outside its native state.
  await regularUnlinked(`${database}-wal`, true);
  await regularUnlinked(`${database}-shm`, true);
  await regularUnlinked(`${database}-journal`, true);
  return database;
}

async function rows(database, { limit, archived, query, threadId, turns = false }) {
  // One connection/transaction sees a consistent WAL snapshot. SQLite may
  // create its coordination sidecars, but readOnly forbids database writes.
  // Load lazily so non-history commands do not initialize SQLite.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    const object = db.prepare("SELECT type FROM sqlite_master WHERE name = 'threads' LIMIT 1").get();
    if (object?.type !== 'table') throw new Error('Native history database has an unsupported thread schema');
    const columns = db.prepare('PRAGMA table_info(threads)').all();
    if (!requiredColumns.isSubsetOf(new Set(columns.map(item => item.name))))
      throw new Error('Native history database has an unsupported thread schema');
    const rollout = columns.some(item => item.name === 'rollout_path') ? ', substr(rollout_path, 1, 4097) AS rollout_path' : '';
    const lineage = turns && threadId && columns.some(item => item.name === 'source')
      ? ', substr(source, 1, 8193) AS native_source' : '';
    const clauses = threadId ? ['id = ?'] : archived ? [] : ['archived = 0'];
    const params = threadId ? [threadId] : [];
    if (query) {
      // SQLite's built-in lower() handles ASCII only. Use Unicode lowercasing
      // and canonical normalization so titles such as ȘEDINȚĂ remain searchable.
      const fold = value => typeof value === 'string' ? value.normalize('NFC').toLowerCase() : '';
      db.function('xfx_fold', { deterministic: true, directOnly: true }, fold);
      clauses.push('instr(xfx_fold(title), ?) > 0');
      params.push(fold(query));
    }
    const result = db.prepare(`SELECT substr(id, 1, 37) AS id, substr(cwd, 1, 4097) AS cwd, substr(title, 1, 501) AS title, created_at, updated_at, archived${rollout}${lineage} FROM threads${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC, created_at DESC, id ASC LIMIT ?`).all(...params, threadId ? 1 : limit + 1);
    if (lineage) for (const row of result) {
      const parent = nativeChildParent(row.native_source, row.id);
      if (parent && !parent.error && !db.prepare('SELECT id FROM threads WHERE id = ? LIMIT 1').get(parent.id))
        parent.error = 'The native child parent is absent from the selected index.';
      row.childLineage = parent;
    }
    return result;
  } finally { db.close(); }
}

function nativeChildParent(source, childId) {
  if (typeof source !== 'string' || source.length > 8192) return null;
  let value;
  try { value = JSON.parse(source); } catch { return null; }
  if (!value || !Object.hasOwn(value, 'subagent')) return null;
  const id = value.subagent?.thread_spawn?.parent_thread_id;
  return validUUID(id) && id !== childId ? { id } : { error: 'The native child lineage could not be verified.' };
}

async function oneHome(store, profile, options, defaultUserHome) {
  const origin = { profileId: profile.id, profileName: profile.name };
  if (!profile.native && profile.id !== 'default') return { ...origin, status: 'unbound', count: 0, reason: 'No native home is bound to this profile.' };
  try {
    let environment;
    if (profile.id === 'default') {
      const { resolveNativeSettingsHome } = await import('./native-copy.js');
      const source = await resolveNativeSettingsHome(store, 'Default', { defaultUserHome });
      environment = { id: null, home: source.home };
    } else ({ environment } = await resolveHome(store, profile.id));
    const database = await checkedDatabase(environment.home);
    if (!database) return { ...origin, environmentId: environment.id, home: environment.home, status: 'empty', count: 0, reason: 'The native home has no thread index.' };
    const result = await rows(database, options);
    if (!Array.isArray(result)) throw new Error('Native history database returned invalid metadata');
    return { ...origin, environmentId: environment.id, home: environment.home,
      status: 'ready', count: result.length, reason: null, rows: result };
  } catch (error) {
    return { ...origin, status: 'unavailable', count: 0, reason: error.message === 'Native history database has an unsupported thread schema' ? error.message : 'The native history metadata is unavailable.' };
  }
}

function within(root, path) {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`);
}

async function canonicalRegularPath(home, path) {
  const lexicalHome = resolve(home), lexicalPath = resolve(path);
  if (!within(lexicalHome, lexicalPath)) return undefined;
  try {
    await regularUnlinked(path);
    const [canonicalHome, canonicalPath] = await Promise.all([realpath(home), realpath(path)]);
    if (canonicalPath !== path || !within(canonicalHome, canonicalPath)) return undefined;
    return canonicalPath;
  } catch { return undefined; }
}

async function safeRolloutPath(home, value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(value) || !value.startsWith('/')) return undefined;
  if (resolve(value) !== value) return undefined;
  return canonicalRegularPath(home, value);
}

async function entry(row, source) {
  if (!uuid.test(row?.id ?? '') || typeof row.cwd !== 'string' || row.cwd.length > 4096 || !row.cwd.startsWith('/') || /[\x00-\x1f\x7f-\x9f]/.test(row.cwd)
    || !Number.isSafeInteger(row.created_at) || row.created_at < 0 || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0 || ![0,1].includes(row.archived)) return null;
  const title = cleanTitle(row.title);
  const rolloutPath = await safeRolloutPath(source.home, row.rollout_path);
  return { id: row.id, profileId: source.profileId, profileName: source.profileName, environmentId: source.environmentId,
    home: source.home, cwd: row.cwd, ...title, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    archived: row.archived === 1, ...(rolloutPath ? { rolloutPath } : {}), source: 'native-codex-state_5' };
}

function report(home) {
  const { rows, ...value } = home;
  return value;
}

/** List thread metadata from explicitly bound homes only. */
export async function listHistory(store, { profile, query, limit = 50, archived = false } = {}) {
  const maximum = boundedLimit(limit), needle = boundedQuery(query);
  if (typeof archived !== 'boolean') throw new Error('History archived must be true or false');
  const data = await store.read();
  const profiles = profile === undefined ? data.profiles : [find(data, profile)];
  const homes = await Promise.all(profiles.map(item => oneHome(store, item, { limit: maximum, archived, query: needle })));
  const grouped = await Promise.all(homes.map(async home => ({ home, entries: home.status === 'ready' ? await Promise.all(home.rows.map(row => entry(row, home))) : [] })));
  for (const group of grouped) {
    if (group.home.status === 'ready' && group.entries.some(item => item === null)) {
      group.home.status = 'partial'; group.home.reason = 'Some native history metadata rows are malformed.';
    }
  }
  let entries = grouped.flatMap(group => group.entries.filter(Boolean));
  entries.sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.profileId.localeCompare(right.profileId) || left.id.localeCompare(right.id));
  return { entries: entries.slice(0, maximum), homes: homes.map(report), truncated: entries.length > maximum };
}

/** Resolve an exact thread ID in one named source; IDs are never deduplicated across homes. */
export async function findHistory(store, profileNameOrId, threadId, { turns = false, defaultUserHome = homedir() } = {}) {
  if (!uuid.test(threadId ?? '')) throw new Error('Invalid native thread ID');
  const data = await store.read();
  const profile = typeof profileNameOrId === 'string' && profileNameOrId.toLowerCase() === 'default'
    ? { id: 'default', name: 'Default' } : find(data, profileNameOrId);
  const home = await oneHome(store, profile, { limit: 1, archived: true, query: null, threadId, turns }, defaultUserHome);
  const found = home.status === 'ready' ? home.rows.find(row => row.id === threadId) : undefined;
  const result = found ? await entry(found, home) : null;
  if (found && !result) { home.status = 'partial'; home.reason = 'Some native history metadata rows are malformed.'; }
  return { entry: result, home: report(home), ...(turns ? await readTurnMetadata(result, found?.childLineage) : {}) };
}

function recordedPath(value) {
  return typeof value === 'string' && value.length <= 4096 && value.startsWith('/') && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function recordedText(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f-\x9f]/.test(value)
    && redactText(value, 'metadata.txt') === value;
}

/** A bounded snapshot of native-reported turn contexts, not effective backend configuration. */
async function readTurnMetadata(task, lineage) {
  const metadata = { status: 'unavailable', reason: null, source: 'native-codex-rollout', rolloutPath: task?.rolloutPath ?? null,
    clientVersion: null, originator: null };
  const unavailable = reason => ({ turnMetadata: { ...metadata, status: 'unavailable', reason }, turns: [] });
  if (lineage?.error) return unavailable(lineage.error);
  if (!task?.rolloutPath) return unavailable('No safe native rollout is available for this task.');
  let handle;
  try {
    if (!await safeRolloutPath(task.home, task.rolloutPath)) return unavailable('The native rollout path is unsafe or unavailable.');
    const expected = await lstat(task.rolloutPath);
    handle = await open(task.rolloutPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const snapshot = await handle.stat();
    if (!snapshot.isFile() || snapshot.nlink !== 1 || snapshot.uid !== process.getuid()
      || snapshot.dev !== expected.dev || snapshot.ino !== expected.ino
      || !await safeRolloutPath(task.home, task.rolloutPath)) return unavailable('The native rollout path is unsafe or unavailable.');

    let turns = [];
    const starts = new Map(), contexts = new Map(), issues = new Set();
    const parentId = lineage?.id, owners = new Map(), roots = new Map();
    let header = false, identityError = false, sourceLine = 0, records = 0, stop = false;
    const time = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
    const childHeader = payload => payload?.id === task.id && payload.session_id === parentId
      && payload.parent_thread_id === parentId && payload.source?.subagent?.thread_spawn?.parent_thread_id === parentId
      && (payload.forked_from_id === undefined || payload.forked_from_id === parentId);
    function parseRecord(bytes) {
      sourceLine++;
      if (!bytes.length) return;
      let record;
      try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { issues.add('Some native rollout records are malformed.'); return; }
      if (!header) {
        if (record?.type !== 'session_meta' || (parentId ? !childHeader(record.payload)
          : record.payload?.source?.subagent !== undefined || record.payload?.id !== task.id
            || (record.payload.session_id !== undefined && record.payload.session_id !== task.id))) {
          identityError = true; stop = true; return;
        }
        header = true;
        metadata.clientVersion = recordedText(record.payload.cli_version, 128) ? record.payload.cli_version : null;
        metadata.originator = recordedText(record.payload.originator, 128) ? record.payload.originator : null;
        return;
      }
      if (record?.type === 'session_meta') {
        if (parentId ? !childHeader(record.payload) && !(record.payload?.id === parentId && record.payload.session_id === parentId)
          : record.payload?.id !== task.id || (record.payload.session_id !== undefined && record.payload.session_id !== task.id)) {
          identityError = true; stop = true;
        }
        return;
      }
      const start = record?.type === 'event_msg' && record.payload?.type === 'task_started';
      const ownership = parentId && record?.type === 'token_usage_record';
      if (record?.type !== 'turn_context' && !start && !ownership) return;
      if (++records > MAX_TURN_RECORDS) { issues.add('The native turn metadata record limit was reached.'); stop = true; return; }
      const payload = record.payload;
      if (ownership) {
        if (!['thread_id', 'session_id', 'turn_id', 'root_turn_id'].every(field => validUUID(payload?.[field]))) {
          issues.add('Some native turn ownership fields are missing or invalid.'); return;
        }
        const identity = [payload.thread_id, payload.session_id, payload.root_turn_id].join(':');
        const previous = owners.get(payload.turn_id);
        if ((previous && previous.identity !== identity) || (payload.thread_id === task.id && payload.session_id !== parentId)) {
          identityError = true; stop = true; return;
        }
        owners.set(payload.turn_id, { identity, child: payload.thread_id === task.id && payload.session_id === parentId, root: payload.root_turn_id });
        return;
      }
      if ((parentId && !validUUID(payload?.turn_id)) || !uuid.test(payload?.turn_id ?? '')) { issues.add('Some native turn IDs are missing or invalid.'); return; }
      if (parentId && payload.root_turn_id !== undefined) {
        const previous = roots.get(payload.turn_id);
        if (!validUUID(payload.root_turn_id) || (previous && previous !== payload.root_turn_id)) {
          identityError = true; stop = true; return;
        }
        roots.set(payload.turn_id, payload.root_turn_id);
      }
      if (start) { if (!starts.has(payload.turn_id)) starts.set(payload.turn_id, { recordedAt: time(record.timestamp), sourceLine }); return; }
      const row = { turnId: payload.turn_id, recordedAt: time(record.timestamp),
        cwd: recordedPath(payload.cwd) ? payload.cwd : null,
        workspaceRoots: Array.isArray(payload.workspace_roots)
          && payload.workspace_roots.length <= 64 && payload.workspace_roots.every(recordedPath) ? payload.workspace_roots : null,
        model: recordedText(payload.model, 256) ? payload.model : null,
        reasoningEffort: recordedText(payload.effort, 64) ? payload.effort : null, sourceLine, issues: [] };
      for (const field of ['recordedAt', 'cwd', 'workspaceRoots', 'model', 'reasoningEffort'])
        if (row[field] === null) row.issues.push(`Missing or invalid ${field}.`);
      if (row.issues.length && !parentId) issues.add('Some native turn context fields are missing or invalid.');
      const previous = contexts.get(row.turnId);
      if (previous && ['cwd', 'workspaceRoots', 'model', 'reasoningEffort'].some(field => JSON.stringify(previous[field]) !== JSON.stringify(row[field]))) {
        const reason = 'Conflicting native contexts were recorded for this turn.';
        previous.issues.push(reason); row.issues.push(reason); if (!parentId) issues.add(reason);
      }
      contexts.set(row.turnId, row); turns.push(row);
    }

    const length = Math.min(snapshot.size, MAX_ROLLOUT_BYTES), buffer = Buffer.alloc(65536);
    let position = 0, pending = Buffer.alloc(0), discarding = false;
    while (position < length && !stop) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position);
      if (!bytesRead) { issues.add('The native rollout was truncated while reading.'); break; }
      position += bytesRead;
      const chunk = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let offset = 0, end;
      while (!stop && (end = chunk.indexOf(10, offset)) !== -1) {
        if (discarding || end - offset > MAX_RECORD_BYTES) {
          sourceLine++; issues.add('Some native rollout lines exceeded the line limit.'); discarding = false;
        } else parseRecord(chunk.subarray(offset, end));
        offset = end + 1;
      }
      pending = discarding ? Buffer.alloc(0) : Buffer.from(chunk.subarray(offset));
      if (pending.length > MAX_RECORD_BYTES) {
        issues.add('Some native rollout lines exceeded the line limit.'); discarding = true; pending = Buffer.alloc(0);
      }
    }
    if (pending.length && !stop) {
      parseRecord(pending);
      issues.add('The native rollout has an unterminated final record.');
    }
    if (identityError || !header) return unavailable(parentId
      ? 'The native child identity or turn ownership could not be verified.' : 'The native rollout session ID could not be verified.');
    if (parentId) {
      for (const [turnId, root] of roots) if (owners.has(turnId) && owners.get(turnId).root !== root)
        return unavailable('The native child turn ownership could not be verified.');
      const candidates = new Set([...starts.keys(), ...contexts.keys()]);
      const unattributed = [...candidates].filter(id => !owners.get(id)?.child);
      turns = turns.filter(turn => owners.get(turn.turnId)?.child);
      for (const id of unattributed) { starts.delete(id); contexts.delete(id); }
      metadata.parentTaskId = parentId; metadata.unattributedTurnCount = unattributed.length;
      if (!turns.length && !starts.size) return unavailable('No positively attributed child turn metadata is available.');
      if (unattributed.length) issues.add('Some native turns have no verified child ownership and were excluded.');
      for (const turn of turns) {
        if (turn.issues.some(issue => issue.startsWith('Missing or invalid'))) issues.add('Some native turn context fields are missing or invalid.');
        if (turn.issues.includes('Conflicting native contexts were recorded for this turn.')) issues.add('Conflicting native contexts were recorded for this turn.');
      }
    }
    if (snapshot.size > MAX_ROLLOUT_BYTES) issues.add('The native rollout byte limit was reached.');
    const after = await handle.stat();
    if (after.size !== snapshot.size || after.mtimeMs !== snapshot.mtimeMs) issues.add('The native rollout changed while reading; this is a partial snapshot.');
    for (const [turnId, start] of starts) if (!contexts.has(turnId)) {
      turns.push({ turnId, ...start, cwd: null, workspaceRoots: null, model: null, reasoningEffort: null,
        issues: ['No native turn context was recorded for this turn.'] });
      issues.add('Some native turns have no recorded context.');
    }
    turns.sort((a, b) => a.sourceLine - b.sourceLine);
    if (!turns.length && !issues.size) return unavailable('No native turn metadata is available for this task.');
    return { turnMetadata: { ...metadata, status: issues.size ? 'partial' : 'ready', reason: issues.size ? [...issues].join(' ') : null }, turns };
  } catch { return unavailable('The native rollout could not be read safely.'); }
  finally { await handle?.close(); }
}
