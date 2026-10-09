// History discovery is read-only. Actual resume may normalize one validated
// alias-recorded path in the source index; no credentials or turn bodies are parsed.
import { lstat, realpath } from 'node:fs/promises';
import { join, relative, sep, resolve } from 'node:path';
import { find } from './profiles.js';
import { resolveHome } from './homes.js';
import { redactText } from './redact.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const databaseName = 'state_5.sqlite';
const requiredColumns = new Set(['id', 'cwd', 'title', 'created_at', 'updated_at', 'archived']);
const MAX_LIMIT = 100;
const MAX_QUERY = 256;
const MAX_TITLE = 500;

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

async function rows(database, { limit, archived, query, threadId }) {
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
    return db.prepare(`SELECT substr(id, 1, 37) AS id, substr(cwd, 1, 4097) AS cwd, substr(title, 1, 501) AS title, created_at, updated_at, archived${rollout} FROM threads${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC, created_at DESC, id ASC LIMIT ?`).all(...params, threadId ? 1 : limit + 1);
  } finally { db.close(); }
}

async function oneHome(store, profile, options) {
  if (!profile.native) return { profileId: profile.id, profileName: profile.name, status: 'unbound', count: 0, reason: 'No native home is bound to this profile.' };
  try {
    const { environment } = await resolveHome(store, profile.id);
    const database = await checkedDatabase(environment.home);
    if (!database) return { profileId: profile.id, profileName: profile.name, environmentId: environment.id, home: environment.home, status: 'empty', count: 0, reason: 'The bound native home has no thread index.' };
    const result = await rows(database, options);
    if (!Array.isArray(result)) throw new Error('Native history database returned invalid metadata');
    return { profileId: profile.id, profileName: profile.name, environmentId: environment.id, home: environment.home,
      status: 'ready', count: result.length, reason: null, rows: result };
  } catch (error) {
    return { profileId: profile.id, profileName: profile.name, status: 'unavailable', count: 0, reason: error.message === 'Native history database has an unsupported thread schema' ? error.message : 'The bound native history metadata is unavailable.' };
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
export async function findHistory(store, profileNameOrId, threadId) {
  if (!uuid.test(threadId ?? '')) throw new Error('Invalid native thread ID');
  const data = await store.read();
  const profile = find(data, profileNameOrId);
  const home = await oneHome(store, profile, { limit: 1, archived: true, query: null, threadId });
  const found = home.status === 'ready' ? home.rows.find(row => row.id === threadId) : undefined;
  const result = found ? await entry(found, home) : null;
  if (found && !result) { home.status = 'partial'; home.reason = 'Some native history metadata rows are malformed.'; }
  return { entry: result, home: report(home) };
}
