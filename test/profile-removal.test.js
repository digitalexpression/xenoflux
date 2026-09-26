import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store, create } from '../src/profiles.js';
import { removeProfile, unbindNativeHome } from '../src/profile-removal.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profile-removal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'controller'));
  const profiles = await store.update(data => [create(data, 'selected'), create(data, 'inactive'), create(data, 'ordinary')]);
  for (const profile of profiles.slice(0, 2)) {
    const rootPath = join(root, profile.name); await mkdir(rootPath, { mode: 0o700 });
    profile.native = {
    environmentId: profile.id === profiles[0].id ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
    root: rootPath, executable: '/bin/codex', executableIdentity: '[1,2,3,4,5]', version: '1.2.3',
    };
  }
  await store.update(data => { data.profiles = profiles; });
  const activation = join(store.directory, 'activation'); await mkdir(activation, { mode: 0o700 });
  return { root, store, profiles, manifest: join(activation, 'manifest.json'), lockPath: join(root, 'operation-lock') };
}

test('malformed activation metadata fails closed, then safe unreferenced removal works after metadata retirement', async t => {
  const f = await fixture(t), [selected, inactive, ordinary] = f.profiles;
  await writeFile(f.manifest, JSON.stringify({ schemaVersion: 1, kind: 'paired-native-home-plan', profiles: [
    { profileId: selected.id }, { profileId: inactive.id },
  ] }), { mode: 0o600 });
  for (const profile of [selected, inactive])
    await assert.rejects(removeProfile(f.store, profile.id, { lockPath: f.lockPath }));
  assert.equal((await f.store.read()).profiles.length, 3);
  await rm(f.manifest);
  assert.deepEqual(await removeProfile(f.store, ordinary.id, { lockPath: f.lockPath }), { deleted: ordinary.id, name: 'ordinary' });
});

test('native unbind rejects a reserved selected home and rejects malformed reservation state', async t => {
  const f = await fixture(t), [selected] = f.profiles;
  const sessionDir = join(f.store.directory, 'desktop-selection'); await mkdir(sessionDir, { mode: 0o700 });
  const sessionPath = join(sessionDir, 'session.json');
  const owner = { kind: 'desktop-selection', host: hostname(), pid: process.pid, storePath: f.store.directory,
    journalPath: sessionPath, runId: randomUUID() };
  await writeFile(sessionPath, JSON.stringify({ schemaVersion: 1, kind: 'desktop-selection-session', id: owner.runId,
    owner, phase: 'restored', active: null, target: null, reservedRoots: [selected.native.root],
    reservedBindings: [selected.native], trackedProcesses: [] }), { mode: 0o600 });
  await assert.rejects(unbindNativeHome(f.store, selected.id, { lockPath: f.lockPath }), /referenced by a desktop selection/);
  assert.ok((await f.store.read()).profiles.find(p => p.id === selected.id).native);
  await writeFile(sessionPath, '{bad json', { mode: 0o600 });
  await assert.rejects(unbindNativeHome(f.store, selected.id, { lockPath: f.lockPath }));
  assert.ok((await f.store.read()).profiles.find(p => p.id === selected.id).native);
});

test('removal honors the existing selection operation exclusion and safe unreferenced native unbind works', async t => {
  const f = await fixture(t), [selected, inactive, ordinary] = f.profiles;
  await mkdir(`${f.lockPath}.selection`, { mode: 0o700 });
  await assert.rejects(removeProfile(f.store, ordinary.id, { lockPath: f.lockPath }), /locked/);
  await rm(`${f.lockPath}.selection`, { recursive: true });
  const result = await unbindNativeHome(f.store, inactive.id, { lockPath: f.lockPath });
  assert.equal(result.native, undefined);
  assert.equal((await f.store.read()).profiles.find(p => p.id === ordinary.id).name, 'ordinary');
});

test('pending copy references and malformed pending records preserve profile records', async t => {
  const f = await fixture(t), [selected, , ordinary] = f.profiles;
  const copyRoot = join(f.store.directory, 'native-copies'), copyId = '33333333-3333-4333-8333-333333333333';
  await mkdir(join(copyRoot, copyId), { recursive: true, mode: 0o700 });
  await writeFile(join(copyRoot, 'pending.json'), JSON.stringify({ id: copyId }), { mode: 0o600 });
  await writeFile(join(copyRoot, copyId, 'journal.json'), JSON.stringify({ schemaVersion: 1,
    kind: 'native-settings-copy', id: copyId, phase: 'applied', storePath: f.store.directory,
    source: { profileId: selected.id }, target: { profileId: ordinary.id } }), { mode: 0o600 });
  const before = await readFile(f.store.file, 'utf8');
  await assert.rejects(removeProfile(f.store, selected.id, { lockPath: f.lockPath }), /pending settings copy/);
  await assert.rejects(unbindNativeHome(f.store, ordinary.id, { lockPath: f.lockPath }), /pending settings copy/);
  assert.equal(await readFile(f.store.file, 'utf8'), before);
  await writeFile(join(copyRoot, 'pending.json'), '{malformed', { mode: 0o600 });
  await assert.rejects(removeProfile(f.store, ordinary.id, { lockPath: f.lockPath }));
  assert.equal(await readFile(f.store.file, 'utf8'), before);
});
