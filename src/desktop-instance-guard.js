// Bundle-wide legacy control must stay excluded while any controller owns a
// concurrent desktop, including one launched from a different profile store.
import { readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists, globalLock, privateDirectory, readJSON } from './metadata.js';

const directory = lockPath => `${lockPath}.instances`;
const marker = (owner, lockPath) => join(directory(lockPath), `${owner.runId}.json`);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function reserveInstanceControl(owner, { lockPath = globalLock() } = {}) {
  await privateDirectory(directory(lockPath), true);
  const path = marker(owner, lockPath);
  if (await exists(path)) {
    if (!equal(await readJSON(path), owner)) throw new Error('Concurrent desktop control owner changed; preserving it');
  } else await writeFile(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
}

export async function releaseInstanceControl(owner, { lockPath = globalLock() } = {}) {
  if (!await exists(directory(lockPath))) return;
  await privateDirectory(directory(lockPath));
  const path = marker(owner, lockPath);
  if (!await exists(path)) return;
  if (!equal(await readJSON(path), owner)) throw new Error('Concurrent desktop control owner changed; preserving it');
  await unlink(path);
}

export async function assertNoConcurrentDesktops({ lockPath = globalLock() } = {}) {
  if (!await exists(directory(lockPath))) return;
  await privateDirectory(directory(lockPath));
  if ((await readdir(directory(lockPath))).length)
    throw new Error('Concurrent desktop instances are reserved. Close or recover each named instance before using legacy client or alias operations.');
}
