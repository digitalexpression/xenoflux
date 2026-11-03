import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire, readJSON } from '../src/metadata.js';
import { acquireReviewReservation, profileOwners, readProfileOwners, releaseProfileParticipant } from '../src/profile-reservations.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profile-reservation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeRoot = join(root, 'native');
  await mkdir(nativeRoot, { mode: 0o700 });
  return { root: nativeRoot, lock: join(nativeRoot, '.run-lock') };
}

const desktopOwner = (storePath = '/tmp/store', profileId = 'profile-1') => ({
  kind: 'desktop-instance', runId: 'desktop-run', storePath, profileId,
});
const reviewOwner = (storePath = '/tmp/store', profileId = 'profile-1', runId = 'review-run') => ({
  kind: 'review-task', runId, storePath, profileId,
});

for (const first of ['desktop', 'review']) {
  test(`shared reservation preserves the ${first === 'desktop' ? 'review' : 'desktop'} owner when ${first} leaves first`, async t => {
    const f = await fixture(t), desktop = desktopOwner(), review = reviewOwner();
    await acquire(f.lock, desktop);
    await acquireReviewReservation(f.root, review, desktop);

    await releaseProfileParticipant(f.root, first === 'desktop' ? desktop : review);

    assert.deepEqual(await readProfileOwners(f.root), [first === 'desktop' ? review : desktop]);
    assert.deepEqual(await readJSON(join(f.lock, 'owner.json')), first === 'desktop' ? review : desktop);
    assert.equal((await lstat(f.lock)).isDirectory(), true);
    await releaseProfileParticipant(f.root, first === 'desktop' ? review : desktop);
    await assert.rejects(readJSON(join(f.lock, 'owner.json')), { code: 'ENOENT' });
  });
}

test('review join rejects a foreign desktop owner and a second review participant', async t => {
  const f = await fixture(t), desktop = desktopOwner(), review = reviewOwner();
  await acquire(f.lock, desktop);
  await assert.rejects(acquireReviewReservation(f.root, review, desktopOwner('/tmp/other-store')));
  await acquireReviewReservation(f.root, review, desktop);
  await assert.rejects(acquireReviewReservation(f.root, reviewOwner('/tmp/store', 'profile-1', 'review-2'), desktop));
  assert.deepEqual(await readProfileOwners(f.root), [desktop, review]);
});

test('malformed shared reservation fails closed without changing owner bytes', async t => {
  const f = await fixture(t), lock = f.lock;
  await mkdir(lock, { mode: 0o700 });
  const bytes = '{"schemaVersion":1,"kind":"desktop-review","desktop":{"kind":"desktop-instance"},"review":{"kind":"foreign"}}\n';
  await writeFile(join(lock, 'owner.json'), bytes, { mode: 0o600 });

  assert.throws(() => profileOwners(JSON.parse(bytes)), /Invalid shared profile reservation/);
  await assert.rejects(readProfileOwners(f.root), /Invalid shared profile reservation/);
  await assert.rejects(releaseProfileParticipant(f.root, desktopOwner()), /Invalid shared profile reservation/);
  assert.equal(await readFile(join(lock, 'owner.json'), 'utf8'), bytes);
});

test('exclusive metadata acquisition refuses an existing shared reservation', async t => {
  const f = await fixture(t), desktop = desktopOwner(), review = reviewOwner();
  await acquire(f.lock, desktop);
  await acquireReviewReservation(f.root, review, desktop);

  await assert.rejects(acquire(f.lock, { kind: 'interactive-cli', runId: 'cli-run' }));
  assert.deepEqual(await readProfileOwners(f.root), [desktop, review]);
});
