// Guard registry removals against paired activation, desktop selection, and
// copy recovery records that still resolve profiles by stable ID or home root.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { exists, globalLock, acquire, release, readJSON, privateDirectory } from './metadata.js';
import { find, remove } from './profiles.js';
import { readPairedPlan, validatePairedPlan } from './desktop-paired.js';
import { currentDesktop } from './desktop-selection.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const paths = store => ({ manifest: join(store.directory, 'activation', 'manifest.json'),
  session: join(store.directory, 'desktop-selection', 'session.json') });

async function withSelectionOperation(store, lockPath, action) {
  const guardPath = `${lockPath}.selection`;
  const owner = { kind: 'desktop-selection-operation', host: hostname(), pid: process.pid,
    storePath: store.directory, journalPath: paths(store).session, runId: randomUUID() };
  await acquire(guardPath, owner);
  try { return await action(); }
  finally { await release(guardPath, owner); }
}

async function referenced(store, profile, defaultUserHome) {
  const p = paths(store);
  // These existing readers perform the complete schema, identity, and path
  // checks. A malformed record is an authority failure, not an empty plan.
  const current = await currentDesktop(store, { defaultUserHome });
  const session = await exists(p.session) ? await readJSON(p.session) : null;
  if (session?.pairedActivationIntent)
    validatePairedPlan(session.pairedActivationIntent, store, defaultUserHome);
  let activation = null;
  if (await exists(p.manifest)) {
    activation = await readPairedPlan(p.manifest, store, { defaultUserHome });
    if (session?.pairedActivationIntent && !session.pairedActivationId
      && (session.pairedActivationIntent.id !== activation.id
        || session.pairedActivationIntent.approvalId !== activation.approvalId))
      throw new Error('Paired activation intent and manifest disagree; preserving profile registry');
    if (activation.profiles.some(item => item.profileId === profile.id))
      throw new Error('Profile is an activation target; it cannot be deleted or unbound while the activation plan references it');
  } else if (session?.pairedActivationIntent) {
    if (session.pairedActivationIntent.profiles.some(item => item.profileId === profile.id))
      throw new Error('Profile is referenced by a pending paired activation; preserve the desktop recovery state');
  }
  if (session?.pairedActivationId && session.pairedActivationId !== activation?.id)
    throw new Error('Paired activation state is inconsistent; preserving profile registry');
  const plans = [session?.active, session?.target, ...(session?.pairedActivationIntent?.profiles ?? [])].filter(Boolean);
  if (plans.some(plan => plan.profileId === profile.id)
    || (profile.native && session?.reservedRoots?.includes(profile.native.root)))
    throw new Error('Profile is referenced by a desktop selection; restore it before unbinding or deleting the profile');
  if (profile.native && await exists(join(profile.native.root, '..', `.${profile.id}.setup-lock`)))
    throw new Error('Profile native home is locked by setup; finish it before deleting or unbinding the profile');
  if (current.pairedActivation?.activationId !== undefined && current.pairedActivation.activationId !== activation?.id)
    throw new Error('Paired activation state is inconsistent; preserving profile registry');

  const copyRoot = join(store.directory, 'native-copies'), pending = join(copyRoot, 'pending.json');
  if (await exists(pending)) {
    const pointer = await readJSON(pending);
    if (!uuid.test(pointer?.id ?? '')) throw new Error('Invalid pending settings copy; preserving profile registry');
    const journalPath = join(copyRoot, pointer.id, 'journal.json');
    const journal = await readJSON(journalPath);
    if (journal.schemaVersion !== 1 || journal.kind !== 'native-settings-copy' || journal.id !== pointer.id
      || !['prepared', 'applied'].includes(journal.phase) || journal.storePath !== store.directory
      || ![journal.source, journal.target].every(endpoint => endpoint && (endpoint.profileId === null || uuid.test(endpoint.profileId ?? ''))))
      throw new Error('Invalid pending settings copy journal; preserving profile registry');
    if ([journal.source, journal.target].some(endpoint => endpoint.profileId === profile.id))
      throw new Error('Profile participates in a pending settings copy; finish copy recovery before deleting or unbinding it');
  }
}

async function mutateProfile(store, name, action, { lockPath = globalLock(), defaultUserHome = userInfo().homedir } = {}) {
  const profile = find(await store.read(), name);
  return withSelectionOperation(store, lockPath, async () => {
    let runLock, owner, runLockAcquired = false;
    try {
      return await store.update(async data => {
        const current = find(data, profile.id);
        if (current.native?.root !== profile.native?.root)
          throw new Error('Profile native binding changed during removal; retry');
        await referenced(store, current, defaultUserHome);
        if (current.native) {
          await privateDirectory(current.native.root);
          runLock = join(current.native.root, '.run-lock');
          owner = { kind: 'profile-removal', host: hostname(), pid: process.pid,
            storePath: store.directory, profileId: current.id, runId: randomUUID() };
          try { await acquire(runLock, owner); }
          catch { throw new Error('Profile native home is locked by a run or desktop selection; finish or restore it before deleting or unbinding the profile'); }
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
