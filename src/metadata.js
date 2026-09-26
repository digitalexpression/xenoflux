// Private controller metadata primitives. Values are JSON-only and bounded.
import { lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const globalLock = () => `/private/tmp/xenoflux-desktop-${process.getuid()}.lock`;

export async function exists(path) {
  try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function privateDirectory(path, create = false) {
  if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(path) !== path || (s.mode & 0o077)
    || s.uid !== process.getuid()) throw new Error(`Expected a private directory: ${path}`);
}

export async function readJSON(path) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o077) || s.size > 1024 * 1024)
    throw new Error('Unsafe desktop metadata file');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function record(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export async function acquire(path, owner, atomic = false) {
  const target = atomic ? `${path}.acquire-${owner.runId}` : path;
  if (atomic && await exists(path)) throw new Error(`Desktop or CLI run is locked: ${path}`);
  try {
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    if (atomic) await rename(target, path);
  } catch (e) {
    if (atomic) {
      await unlink(join(target, 'owner.json')).catch(() => {});
      await rmdir(target).catch(() => {});
    }
    throw new Error(`Desktop or CLI run is locked: ${path}`);
  }
}

export async function release(path, owner) {
  await privateDirectory(path);
  if (!equal(await readJSON(join(path, 'owner.json')), owner)) throw new Error('Desktop lock owner changed; preserving lock');
  const released = `${path}.released-${randomUUID()}`;
  await rename(path, released);
  await unlink(join(released, 'owner.json')); await rmdir(released);
}
