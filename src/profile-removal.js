// Guard profile removal against active native work and pending copy recovery.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { exists, globalLock, acquire, release, readJSON, privateDirectory } from './metadata.js';
import { find, remove } from './profiles.js';
import { prepareDesktopInstanceRemoval } from './desktop-instances.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const pendingCopyPath = store => join(store.directory, 'native-copies', 'pending.json');

async function withProfileOperation(store, lockPath, action) {
  const guardPath = `${lockPath}.operation`;
  const owner = { kind: 'profile-removal-operation', host: hostname(), pid: process.pid,
    storePath: store.directory, runId: randomUUID() };
  await acquire(guardPath, owner);
  try { return await action(); }
  finally { await release(guardPath, owner); }
}

async function referenced(store, profile) {
  if (profile.native && await exists(join(profile.native.root, '..', `.${profile.id}.setup-lock`)))
    throw new Error('Profile native home is locked by setup; finish it before deleting or unbinding the profile');
  const pending = pendingCopyPath(store);
  if (await exists(pending)) {
    const pointer = await readJSON(pending);
    if (!uuid.test(pointer?.id ?? '')) throw new Error('Invalid pending settings copy; preserving profile registry');
    const journalPath = join(store.directory, 'native-copies', pointer.id, 'journal.json');
    const journal = await readJSON(journalPath);
    if (journal.schemaVersion !== 3 || journal.kind !== 'native-settings-copy' || journal.id !== pointer.id
      || !['prepared', 'applied'].includes(journal.phase) || journal.storePath !== store.directory
      || ![journal.source, journal.target].every(endpoint => endpoint && (endpoint.profileId === null || uuid.test(endpoint.profileId ?? ''))))
      throw new Error('Invalid pending settings copy journal; preserving profile registry');
    if ([journal.source, journal.target].some(endpoint => endpoint.profileId === profile.id))
      throw new Error('Profile participates in a pending settings copy; finish copy recovery before deleting or unbinding it');
  }
}

async function mutateProfile(store, name, action, { lockPath = globalLock() } = {}) {
  const profile = find(await store.read(), name);
  return withProfileOperation(store, lockPath, async () => {
    let runLock, owner, runLockAcquired = false;
    try {
      return await store.update(async data => {
        const current = find(data, profile.id);
        if (current.native?.root !== profile.native?.root)
          throw new Error('Profile native binding changed during removal; retry');
        await prepareDesktopInstanceRemoval(store, current.id, { lockPath });
        await referenced(store, current);
        if (current.native) {
          await privateDirectory(current.native.root);
          runLock = join(current.native.root, '.run-lock');
          owner = { kind: 'profile-removal', host: hostname(), pid: process.pid,
            storePath: store.directory, profileId: current.id, runId: randomUUID() };
          try { await acquire(runLock, owner); }
          catch { throw new Error('Profile native home is locked by a run or concurrent instance; finish it before deleting or unbinding the profile'); }
          runLockAcquired = true;
        }
        return action(data, current);
      });
    } finally { if (runLockAcquired) await release(runLock, owner); }
  });
}

export async function removeProfile(store, name, options = {}) {
  return mutateProfile(store, name, (data, profile) => remove(data, profile.id), options);
}

export async function unbindNativeHome(store, name, options = {}) {
  return mutateProfile(store, name, (_data, profile) => {
    if (!profile.native) throw new Error('Native home binding not found');
    delete profile.native; profile.revision += 1;
    return profile;
  }, options);
}
