import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire, readJSON } from '../src/metadata.js';
import { acquireProfileParticipant, profileOwners, readProfileOwners, releaseProfileParticipant } from '../src/profile-reservations.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profile-reservation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeRoot = join(root, 'native');
  await mkdir(nativeRoot, { mode: 0o700 });
  return { root: nativeRoot, lock: join(nativeRoot, '.run-lock') };
}

const desktopOwner = (storePath = '/tmp/store', profileId = 'profile-1') => ({
  kind: 'desktop-instance', runId: randomUUID(), storePath, profileId,
});
const reviewOwner = (storePath = '/tmp/store', profileId = 'profile-1', runId = randomUUID()) => ({
  kind: 'review-task', membershipVersion: 1, home: '/fixture/home', runId, storePath, profileId,
});

for (const first of ['desktop', 'review']) {
  test(`shared reservation preserves the ${first === 'desktop' ? 'review' : 'desktop'} owner when ${first} leaves first`, async t => {
    const f = await fixture(t), desktop = desktopOwner(), review = reviewOwner();
    await acquire(f.lock, desktop);
    await acquireProfileParticipant(f.root, review, desktop);

    await releaseProfileParticipant(f.root, first === 'desktop' ? desktop : review);

    assert.deepEqual(await readProfileOwners(f.root), [first === 'desktop' ? review : desktop]);
    assert.deepEqual(await readJSON(join(f.lock, 'owner.json')), first === 'desktop' ? review : desktop);
    assert.equal((await lstat(f.lock)).isDirectory(), true);
    await releaseProfileParticipant(f.root, first === 'desktop' ? review : desktop);
    await assert.rejects(readJSON(join(f.lock, 'owner.json')), { code: 'ENOENT' });
  });
}

test('exact Desktop owner and multiple task participants coexist and release independently', async t => {
  const f = await fixture(t), desktop = desktopOwner(), review = reviewOwner();
  const other = reviewOwner('/tmp/other-store');
  const audit = { ...reviewOwner(), kind: 'audit-experiment' };
  await acquire(f.lock, desktop);
  await assert.rejects(acquireProfileParticipant(f.root, review, desktopOwner('/tmp/other-store')));
  await acquireProfileParticipant(f.root, review, desktop);
  await acquireProfileParticipant(f.root, other, desktop);
  await acquireProfileParticipant(f.root, audit, desktop);
  await assert.rejects(releaseProfileParticipant(f.root, { ...review, pid: 1 }), /participant changed/);
  assert.deepEqual(await readProfileOwners(f.root), [desktop, review, other, audit]);
  await releaseProfileParticipant(f.root, review);
  assert.deepEqual(await readProfileOwners(f.root), [desktop, other, audit]);
});

test('legacy Desktop and review membership can be read and expanded', async t => {
  const f = await fixture(t), desktop = desktopOwner(), review = reviewOwner();
  await acquire(f.lock, { schemaVersion: 1, kind: 'desktop-review', desktop, review });
  assert.deepEqual(await readProfileOwners(f.root), [desktop, review]);
  const other = reviewOwner('/tmp/other-store');
  await acquireProfileParticipant(f.root, other, desktop);
  assert.deepEqual(await readProfileOwners(f.root), [desktop, review, other]);
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
  await acquireProfileParticipant(f.root, review, desktop);

  await assert.rejects(acquire(f.lock, { kind: 'interactive-cli', runId: 'cli-run' }));
  assert.deepEqual(await readProfileOwners(f.root), [desktop, review]);
});

test('two controller processes admit to one canonical root and recover only the dead owner', async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { hostname } = await import('node:os');
  const { reserveAuditProfile, inspectAuditReservation, releaseAuditProfileReservation } = await import('../src/audit-experiment-store.js');
  const { observeAuditProcess } = await import('../src/audit-process.js');
  const f = await fixture(t);
  const home = join(f.root, 'codex-home'), storeA = join(f.root, 'controller-a'), storeB = join(f.root, 'controller-b');
  await Promise.all([home, storeA, storeB].map(path => mkdir(path, { mode: 0o700 })));
  const makeOwner = storePath => ({ kind: 'audit-experiment', membershipVersion: 1, host: hostname(), pid: process.pid,
    runId: randomUUID(), experimentId: randomUUID(), storePath, profileId: randomUUID(), home });
  const first = makeOwner(storeA), second = makeOwner(storeB);
  const storeUrl = new URL('../src/audit-experiment-store.js', import.meta.url).href;
  const processUrl = new URL('../src/audit-process.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { reserveAuditProfile } from ${JSON.stringify(storeUrl)};
    import { getAuditProcessIdentity } from ${JSON.stringify(processUrl)};
    const owner = { ...JSON.parse(process.argv[1]), pid: process.pid };
    await reserveAuditProfile({ root: process.argv[2], owner });
    process.send({ owner, identity: await getAuditProcessIdentity() });
    setInterval(() => {}, 1000);
  `, JSON.stringify(first), f.root], { detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill());
  const exited = once(child, 'exit');
  const [[message]] = await Promise.all([
    Promise.race([once(child, 'message'), exited.then(() => { throw new Error('fixture coordinator exited before admission'); })]),
    reserveAuditProfile({ root: f.root, owner: second }),
  ]);
  assert.equal((await readProfileOwners(f.root)).length, 2);
  await assert.rejects(acquire(f.lock, { kind: 'mutation', runId: randomUUID() }));
  child.kill('SIGKILL');
  await exited;
  assert.equal((await observeAuditProcess(message.identity)).status, 'stopped');
  assert.deepEqual(await inspectAuditReservation({ root: f.root, owner: message.owner }), message.owner);
  await releaseAuditProfileReservation({ root: f.root, owner: message.owner });
  assert.deepEqual(await readProfileOwners(f.root), [second]);
  await releaseAuditProfileReservation({ root: f.root, owner: second });
});
