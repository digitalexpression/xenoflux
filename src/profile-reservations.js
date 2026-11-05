// Membership changes run under the profile lifecycle operation guard.
// The canonical .run-lock also excludes native launch and profile mutation.
import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { acquire, exists, globalLock, privateDirectory, readJSON, record, release } from './metadata.js';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const taskKinds = new Set(['audit-experiment', 'review-task']);
const memberKinds = new Set([...taskKinds, 'desktop-instance']);
const validMember = owner => memberKinds.has(owner?.kind) && typeof owner.profileId === 'string'
  && typeof owner.storePath === 'string' && owner.storePath.startsWith('/')
  && /^[\da-f-]{36}$/i.test(owner.runId ?? '');

export function profileOwners(value) {
  if (value?.kind === 'execution-participants') {
    const owners = value.participants;
    if (value.schemaVersion !== 1 || !Array.isArray(owners) || owners.length < 2
      || owners.some(owner => !validMember(owner)) || new Set(owners.map(owner => owner.runId)).size !== owners.length
      || owners.filter(owner => owner.kind === 'desktop-instance').length > 1)
      throw new Error('Invalid execution participant set; preserving it');
    return owners;
  }
  if (value?.kind !== 'desktop-review') return [value];
  if (value.schemaVersion !== 1 || value.desktop?.kind !== 'desktop-instance' || value.review?.kind !== 'review-task'
    || typeof value.desktop.profileId !== 'string' || typeof value.desktop.storePath !== 'string'
    || value.desktop.profileId !== value.review.profileId || value.desktop.storePath !== value.review.storePath)
    throw new Error('Invalid shared profile reservation; preserving it');
  return [value.desktop, value.review];
}

export async function assertNoLegacyAuditLease(storePath, home) {
  const key = createHash('sha256').update(home).digest('hex');
  if (await exists(join(storePath, 'audits', 'leases', key)))
    throw new Error('An earlier audit lease still needs recovery before changing or reusing this profile');
}

export async function readProfileOwners(root) {
  const path = join(root, '.run-lock');
  await privateDirectory(path);
  return profileOwners(await readJSON(join(path, 'owner.json')));
}

const writeOwners = (path, owners) => record(join(path, 'owner.json'), owners.length === 1 ? owners[0]
  : { schemaVersion: 1, kind: 'execution-participants', participants: owners });

export async function acquireProfileParticipant(root, owner, desktopOwner) {
  const path = join(root, '.run-lock');
  if (!validMember(owner) || !taskKinds.has(owner.kind)) throw new Error('Invalid execution participant');
  if (!await exists(path)) return acquire(path, owner, true);
  const owners = await readProfileOwners(root);
  if (owners.some(current => !validMember(current)
    || (current.kind === 'desktop-instance' ? !equal(current, desktopOwner)
      : current.home !== owner.home || current.membershipVersion !== 1 && current.kind !== 'review-task')))
    throw new Error('Profile has an exclusive or unverified reservation');
  if (owners.some(current => current.runId === owner.runId)) throw new Error('Execution participant already exists');
  await writeOwners(path, [...owners, owner]);
}

export async function releaseProfileParticipant(root, owner) {
  const path = join(root, '.run-lock');
  if (!await exists(path)) return false;
  await privateDirectory(path);
  const saved = await readJSON(join(path, 'owner.json')), owners = profileOwners(saved);
  if (!owners.some(value => equal(value, owner))) {
    if (owners.some(value => value?.runId === owner.runId))
      throw new Error('Profile participant changed; preserving reservation');
    if (owner.membershipVersion === 1 || owners.length === 1 && owner.kind === 'review-task'
      && owners[0]?.kind === 'desktop-instance' && owner.profileId === owners[0].profileId
      && owner.storePath === owners[0].storePath) return false;
    throw new Error('Profile participant changed; preserving reservation');
  }
  const remaining = owners.filter(value => !equal(value, owner));
  if (remaining.length) await writeOwners(path, remaining);
  else await release(path, saved);
  return true;
}

const workspaceClaims = `${globalLock()}.workspaces`;
const workspaceLock = cwd => join(workspaceClaims, createHash('sha256').update(cwd).digest('hex'));
const contains = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const workspaceBusy = () => Object.assign(new Error('This workspace overlaps an active or unresolved review. Choose a separate workspace.'),
  { code: 'review-workspace-busy' });

export async function acquireReviewReservation(root, owner, desktopOwner) {
  await assertNoLegacyAuditLease(owner.storePath, owner.home);
  if (await realpath(owner.cwd) !== owner.cwd) throw new Error('Review workspace is no longer canonical');
  await privateDirectory(workspaceClaims, true);
  for (const entry of await readdir(workspaceClaims)) {
    if (!/^[a-f0-9]{64}$/.test(entry)) continue;
    const path = join(workspaceClaims, entry);
    let held;
    try {
      await privateDirectory(path);
      held = await readJSON(join(path, 'owner.json'));
    } catch (error) {
      if (error.code === 'ENOENT' && !await exists(path)) continue;
      throw error;
    }
    if (held?.kind !== 'review-task' || !isAbsolute(held.cwd ?? '') || workspaceLock(held.cwd) !== path)
      throw new Error('An existing review workspace claim is invalid');
    if (contains(held.cwd, owner.cwd) || contains(owner.cwd, held.cwd)) throw workspaceBusy();
  }
  const claim = workspaceLock(owner.cwd);
  try { await acquire(claim, owner, true); }
  catch { throw workspaceBusy(); }
  try { await acquireProfileParticipant(root, owner, desktopOwner); }
  catch (error) { await release(claim, owner); throw error; }
}

export async function releaseReviewReservation(root, owner) {
  await releaseProfileParticipant(root, owner);
  if (owner.membershipVersion === 1 && owner.cwd) {
    if (!await exists(workspaceClaims)) return;
    await privateDirectory(workspaceClaims);
    const claim = workspaceLock(owner.cwd);
    if (await exists(claim) && equal(await readJSON(join(claim, 'owner.json')), owner)) await release(claim, owner);
  }
}
