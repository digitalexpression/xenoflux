import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, bind, create, remove, renameProfile, unbind } from '../src/profiles.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profiles-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new Store(join(root, 'controller')) };
}

test('registry creates, renames, binds, unbinds, and removes native-home records', async t => {
  const f = await fixture(t), repository = join(f.root, 'repository');
  await mkdir(repository, { mode: 0o700 });
  const created = await f.store.update(data => create(data, 'daily', 'native only'));
  const renamed = await f.store.update(data => renameProfile(data, created.id, 'research'));
  assert.equal(renamed.id, created.id); assert.equal(renamed.revision, 2);
  await f.store.update(data => bind(data, 'research', repository));
  assert.equal((await f.store.read()).profiles[0].repositories[0].path, repository);
  await f.store.update(data => unbind(data, 'research', repository));
  assert.deepEqual((await f.store.read()).profiles[0].repositories, []);
  assert.deepEqual(await f.store.update(data => remove(data, 'research')), { deleted: created.id, name: 'research' });
  assert.deepEqual((await f.store.read()).profiles, []);
});

test('opaque fields round-trip through ordinary registry edits', async t => {
  const f = await fixture(t), id = '11111111-1111-4111-8111-111111111111';
  await mkdir(f.store.directory, { mode: 0o700 });
  const original = { schemaVersion: 1, profiles: [{ id, name: 'existing', description: '', revision: 4,
    unboundRepository: 'keep-existing', repositories: [], global: { instructions: { mode: 'shared', reference: 'old' } },
    selections: { assets: ['opaque'] }, extension: { retained: true } }] };
  await writeFile(f.store.file, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
  await f.store.update(data => renameProfile(data, 'existing', 'renamed'));
  const stored = JSON.parse(await readFile(f.store.file, 'utf8')).profiles[0];
  assert.equal(stored.id, id); assert.equal(stored.name, 'renamed'); assert.equal(stored.revision, 5);
  assert.deepEqual(stored.global, original.profiles[0].global);
  assert.deepEqual(stored.selections, original.profiles[0].selections);
  assert.deepEqual(stored.extension, original.profiles[0].extension);
});

test('duplicate native-home bindings fail without rewriting the store', async t => {
  const f = await fixture(t);
  const base = { schemaVersion: 1, profiles: [
    { id: '11111111-1111-4111-8111-111111111111', name: 'one', description: '', revision: 1, unboundRepository: 'keep-existing', repositories: [],
      native: { root: '/native/one', environmentId: '33333333-3333-4333-8333-333333333333', executable: '/bin/codex', executableIdentity: JSON.stringify([1, 2, 3, 4, 5]), version: '0.153.4' } },
    { id: '44444444-4444-4444-8444-444444444444', name: 'two', description: '', revision: 1, unboundRepository: 'keep-existing', repositories: [],
      native: { root: '/native/one', environmentId: '66666666-6666-4666-8666-666666666666', executable: '/bin/codex', executableIdentity: JSON.stringify([1, 2, 3, 4, 5]), version: '0.153.4' } },
  ] };
  await mkdir(f.store.directory, { mode: 0o700 });
  await writeFile(f.store.file, `${JSON.stringify(base)}\n`, { mode: 0o600 });
  const before = await readFile(f.store.file, 'utf8');
  await assert.rejects(f.store.update(data => create(data, 'three')), /already bound/);
  assert.equal(await readFile(f.store.file, 'utf8'), before);
});

test('Default stays reserved while records remain readable by stable ID', () => {
  const data = { schemaVersion: 1, profiles: [] };
  assert.throws(() => create(data, 'dEfAuLt'), /reserved/);
  const profile = create(data, 'research');
  assert.throws(() => renameProfile(data, profile.id, 'Default'), /reserved/);
  assert.equal(profile.name, 'research');
});

test('stored reserved names and IDs fail without rewriting the store', async t => {
  const f = await fixture(t);
  await mkdir(f.store.directory, { mode: 0o700 });
  for (const field of ['id', 'name']) {
    const data = { schemaVersion: 1, profiles: [] };
    create(data, 'research')[field] = ' dEfAuLt ';
    const bytes = `${JSON.stringify(data)}\n`;
    await writeFile(f.store.file, bytes, { mode: 0o600 });
    await assert.rejects(f.store.read(), /Default is reserved/);
    await assert.rejects(f.store.update(records => remove(records, 'research')), /Default is reserved/);
    assert.equal(await readFile(f.store.file, 'utf8'), bytes);
  }
});
