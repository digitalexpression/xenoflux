// Participant changes run under the existing profile lifecycle operation guard.
// Keep .run-lock present so legacy/exclusive callers continue to refuse access.
import { join } from 'node:path';
import { acquire, exists, privateDirectory, readJSON, record, release } from './metadata.js';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function profileOwners(value) {
  if (value?.kind !== 'desktop-review') return [value];
  if (value.schemaVersion !== 1 || value.desktop?.kind !== 'desktop-instance' || value.review?.kind !== 'review-task'
    || typeof value.desktop.profileId !== 'string' || typeof value.desktop.storePath !== 'string'
    || value.desktop.profileId !== value.review.profileId || value.desktop.storePath !== value.review.storePath)
    throw new Error('Invalid shared profile reservation; preserving it');
  return [value.desktop, value.review];
}

export async function readProfileOwners(root) {
  await privateDirectory(join(root, '.run-lock'));
  return profileOwners(await readJSON(join(root, '.run-lock', 'owner.json')));
}

export async function acquireReviewReservation(root, owner, desktopOwner) {
  const path = join(root, '.run-lock');
  if (!desktopOwner) return acquire(path, owner, true);
  const owners = await readProfileOwners(root);
  if (owners.length !== 1 || !equal(owners[0], desktopOwner))
    throw new Error('Profile reservation changed or another review owns it');
  const shared = { schemaVersion: 1, kind: 'desktop-review', desktop: desktopOwner, review: owner };
  profileOwners(shared);
  await record(join(path, 'owner.json'), shared);
}

export async function releaseProfileParticipant(root, owner) {
  const path = join(root, '.run-lock');
  if (!await exists(path)) return;
  const owners = await readProfileOwners(root);
  // Recovery can follow a crash after participant release but before task save.
  if (owners.length === 1 && owner.kind === 'review-task' && owners[0]?.kind === 'desktop-instance'
    && owner.profileId === owners[0].profileId && owner.storePath === owners[0].storePath) return;
  if (!owners.some(value => equal(value, owner))) throw new Error('Profile participant changed; preserving reservation');
  const remaining = owners.filter(value => !equal(value, owner));
  if (remaining.length) await record(join(path, 'owner.json'), remaining[0]);
  else await release(path, owner);
}
