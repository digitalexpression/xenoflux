import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, chmod, realpath, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, create, renameProfile } from '../src/profiles.js';
import { listHomes, registerHome, resolveHome } from '../src/homes.js';

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'xfx-native-home-')); t.after(() => rm(temporary, { recursive: true, force: true }));
  const store = new Store(join(temporary, 'controller')); await store.update(data => create(data, 'work'));
  const root = join(temporary, 'profiles', 'work');
  for (const part of ['', 'codex-home', 'workspace', 'user-home', 'tmp', 'desktop-data']) await mkdir(join(root, part), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'codex-home', 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  const executable = join(temporary, 'codex'); await writeFile(executable, '#!/bin/sh\necho 0.153.4\n', { mode: 0o700 }); await chmod(executable, 0o700);
  return { store, root: await realpath(root), executable };
}

test('registers one normal native home with a stable environment id', async t => {
  const f = await fixture(t); const profile = await registerHome(f.store, 'work', f.root, { executable: f.executable, version: '0.153.4' });
  assert.deepEqual(Object.keys(profile.native).sort(), ['environmentId', 'executable', 'executableIdentity', 'root', 'version']);
  const resolved = await resolveHome(f.store, 'work'); assert.equal(resolved.native.root, f.root); assert.equal(resolved.environment.home, join(f.root, 'codex-home'));
  await f.store.update(data => renameProfile(data, 'work', 'renamed'));
  assert.equal((await resolveHome(f.store, 'renamed')).native.environmentId, profile.native.environmentId);
});

test('register creates a missing profile only after native validation', async t => {
  const f = await fixture(t);
  await f.store.update(data => { data.profiles.length = 0; });
  const profile = await registerHome(f.store, 'fresh', f.root, { executable: f.executable, version: '0.153.4' });
  assert.equal(profile.name, 'fresh');
  assert.ok(profile.native.environmentId);

  const invalid = await fixture(t);
  await invalid.store.update(data => { data.profiles.length = 0; });
  await writeFile(join(invalid.root, 'codex-home', 'config.toml'), 'sqlite_home = "/wrong"\n', { mode: 0o600 });
  await assert.rejects(registerHome(invalid.store, 'never-created', invalid.root, { executable: invalid.executable, version: '0.153.4' }), /Native configuration/);
  assert.deepEqual((await invalid.store.read()).profiles, []);
  await assert.rejects(registerHome(f.store, 'Default', f.root, { executable: f.executable, version: '0.153.4' }), /Default is reserved/);
});

test('rejects binding the same physical native root twice', async t => {
  const f = await fixture(t); await registerHome(f.store, 'work', f.root, { executable: f.executable, version: '0.153.4' });
  await f.store.update(data => create(data, 'other'));
  await assert.rejects(registerHome(f.store, 'other', f.root, { executable: f.executable, version: '0.153.4' }), /already bound/);
  const before = await readFile(f.store.file, 'utf8');
  await assert.rejects(registerHome(f.store, 'fresh', f.root, { executable: f.executable, version: '0.153.4' }), /already bound/);
  assert.equal(await readFile(f.store.file, 'utf8'), before);
  assert.equal((await listHomes(f.store))[0].state, 'ready');
});


test('rejects unsafe credential metadata without reading credentials', async t => {
  const f = await fixture(t), auth = join(f.root, 'codex-home', 'auth.json');
  const register = () => registerHome(f.store, 'work', f.root, { executable: f.executable, version: '0.153.4' });
  await writeFile(auth, 'synthetic metadata fixture', {mode:0o644});
  await assert.rejects(register(), /credential metadata/);
  await rm(auth);
  const outside = join(f.root, 'credentials');
  await writeFile(outside, 'synthetic metadata fixture', {mode:0o600});
  await symlink(outside, auth);
  await assert.rejects(register(), /credential metadata/);
  await rm(auth);
  await link(outside, auth);
  await assert.rejects(register(), /credential metadata/);
  await rm(auth);
  await writeFile(auth, 'synthetic metadata fixture', {mode:0o600});
  await register();
  assert.equal((await listHomes(f.store))[0].state, 'ready');
});

test('rejects malformed UTF-8 configuration rather than accepting replacement characters', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'codex-home', 'config.toml'), Buffer.concat([
    Buffer.from('cli_auth_credentials_store = "file"\n# '), Buffer.from([0xff]),
  ]));
  await assert.rejects(registerHome(f.store, 'work', f.root, {executable:f.executable,version:'0.153.4'}), /native configuration/);
});
