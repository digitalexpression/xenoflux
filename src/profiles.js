import { mkdir, readFile, writeFile, rename, unlink, rmdir, lstat, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error(`${label} must be a nonempty string of at most 4096 characters`);
}
function namedProfileValue(value, label) {
  nonempty(value, label);
  if (value.trim().toLowerCase() === 'default') throw new Error('Default is reserved for the built-in profile');
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function nativePath(value) {
  return typeof value === 'string' && value.startsWith('/') && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value);
}
function executableIdentity(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) return false;
  try {
    const parts = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 5 && parts.every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0);
  } catch { return false; }
}
function recognizableVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}
export function validateProfile(p) {
  namedProfileValue(p.id, 'Profile ID'); namedProfileValue(p.name, 'Profile name');
  if (typeof p.description !== 'string' || !Number.isInteger(p.revision) || p.revision < 1) throw new Error('Invalid profile metadata');
  if (p.native !== undefined) {
    const h = p.native;
    if (!(h && Object.keys(h).sort().join(',') === 'environmentId,executable,executableIdentity,root,version'
      && uuid.test(h.environmentId ?? '') && nativePath(h.root) && nativePath(h.executable)
      && executableIdentity(h.executableIdentity) && recognizableVersion(h.version))) throw new Error('Invalid native home binding');
  }
  if (!Array.isArray(p.repositories) || (p.unboundRepository !== undefined && p.unboundRepository !== 'keep-existing')) throw new Error('Invalid repository policy');
  const paths = new Set();
  for (const repo of p.repositories) {
    if (typeof repo.path !== 'string' || !repo.path.startsWith('/') || paths.has(repo.path)) throw new Error('Invalid or duplicate repository binding');
    paths.add(repo.path);

  }
}
function validate(data) {
  if (data.schemaVersion !== 1 || !Array.isArray(data.profiles)) throw new Error('Unsupported or invalid Xenoflux store');
  const ids = new Set(), names = new Set(), homes = new Set();
  for (const p of data.profiles) {
    validateProfile(p);
    if (ids.has(p.id) || names.has(p.name)) throw new Error('Duplicate profile ID or name');
    ids.add(p.id); names.add(p.name);
    if (p.native) {
      const key = p.native.root;
      if (homes.has(key)) throw new Error('A native home is already bound to another profile');
      homes.add(key);
    }
  }
  return data;
}
async function rejectLink(path) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export class Store {
  constructor(directory) { nonempty(directory, 'Store directory'); this.directory = resolve(directory); this.file = join(this.directory, 'profiles.json'); }
  async read() {
    await rejectLink(this.directory); await rejectLink(this.file);
    try { return validate(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, profiles: [] }; throw error; }
  }
  async withLock(action) {
    await rejectLink(this.directory);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, '.write-lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error(`Store is locked: ${lock}. If a writer was interrupted, confirm it has stopped before removing this empty lock directory.`); throw error; }
    try { return await action(await this.read()); }
    finally { await rmdir(lock); }
  }
  async update(action) {
    return this.withLock(async data => {
      const temporary = join(this.directory, `.profiles-${randomUUID()}.tmp`);
      try {
        const result = await action(data);
        validate(data);
        await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.file);
        return result;
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
  }
}
export function find(data, name) {
  const matches = data.profiles.filter(p => p.id === name || p.name === name);
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous profile: ${name}` : `Profile not found: ${name}`);
  return matches[0];
}
function unique(data, name) {
  namedProfileValue(name, 'Profile name');
  if (data.profiles.some(p => p.name === name || p.id === name)) throw new Error(`Profile already exists: ${name}`);
}
function revised(profile) { profile.revision += 1; return profile; }
export function create(data, name, description = '') {
  unique(data, name);
  const profile = {
    id: randomUUID(), name, description, revision: 1,
    unboundRepository: 'keep-existing', repositories: [],
  };
  data.profiles.push(profile); return profile;
}
export function renameProfile(data, name, newName) {
  const profile = find(data, name);
  if (profile.name === newName) return profile;
  unique(data, newName); profile.name = newName; return revised(profile);
}
export function remove(data, name) {
  const profile = find(data, name);
  data.profiles.splice(data.profiles.indexOf(profile), 1);
  return { deleted: profile.id, name: profile.name };
}
export async function canonical(path) {
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) throw new Error('Repository path must be a directory');
  return resolved;
}
export async function bind(data, name, path) {
  const profile = find(data, name), resolved = await canonical(path);
  if (profile.repositories.some(r => r.path === resolved)) throw new Error(`Repository already bound: ${resolved}`);
  profile.repositories.push({ path: resolved });
  return revised(profile);
}
export function unbind(data, name, path) {
  const profile = find(data, name);
  // Use the stored canonical path so a removed checkout can still be unbound.
  const index = profile.repositories.findIndex(r => r.path === resolve(path));
  if (index < 0) throw new Error('Repository binding not found; use its stored canonical path');
  profile.repositories.splice(index, 1); return revised(profile);
}
