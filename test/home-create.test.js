import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, create, remove, renameProfile } from '../src/profiles.js';
import { createHome, inspectHomeCreation, planHomeCreation, startHomeSignIn } from '../src/home-create.js';
import { resolveHome } from '../src/homes.js';
import { acquire, release } from '../src/metadata.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-home-create-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'homes'), store = new Store(join(root, 'controller')), executable = join(root, 'codex');
  await mkdir(base, { mode: 0o700 }); await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { root, base, store, executable };
}
const options = f => ({ store: f.store, name: 'new', base: f.base, executable: f.executable, version: '0.153.4' });
const loginOptions = f => ({ store: f.store, name: 'new', base: f.base, probe: async () => '0.153.4', ramLogs: { prepareHome: async () => {} } });

test('previews then prepares a private minimal stable-ID home, registered but pending native login', async t => {
  const f = await fixture(t), preview = await planHomeCreation(options(f));
  assert.equal(preview.profile.action, 'create'); assert.equal(preview.root, null);
  const made = await createHome(options(f));
  assert.equal(made.status, 'prepared'); assert.equal(made.login.state, 'pending');
  assert.match(made.root, new RegExp(`${f.base}/[0-9a-f-]+$`));
  assert.equal(await readFile(join(made.home, 'config.toml'), 'utf8'), 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\n');
  const desktopData = await lstat(join(made.root, 'desktop-data'));
  assert.equal(desktopData.isDirectory(), true); assert.equal(desktopData.mode & 0o077, 0);
  assert.equal((await resolveHome(f.store, 'new')).environment.home, made.home);
  const inspected = await inspectHomeCreation({ store: f.store, name: 'new', base: f.base });
  assert.equal(inspected.login.state, 'pending'); assert.equal(inspected.login.credentialsInspected, false);
});

test('retry preserves partial setup and never overwrites config, credentials, or history', async t => {
  const f = await fixture(t), made = await createHome(options(f));
  await writeFile(join(made.home, 'auth.json'), 'credential sentinel', { mode: 0o600 });
  await writeFile(join(made.home, 'history.jsonl'), 'history sentinel', { mode: 0o600 });
  await createHome(options(f));
  assert.equal(await readFile(join(made.home, 'auth.json'), 'utf8'), 'credential sentinel');
  assert.equal(await readFile(join(made.home, 'history.jsonl'), 'utf8'), 'history sentinel');
  assert.equal((await resolveHome(f.store, 'new')).environment.home, made.home);
});

test('deletion during preparation cannot bind its old root to a recreated profile name', async t => {
  const f = await fixture(t), update = f.store.update.bind(f.store);
  let updates = 0, originalId;
  f.store.update = async action => {
    if (++updates === 2) await update(data => {
      originalId = data.profiles[0].id;
      remove(data, originalId);
      create(data, 'new');
    });
    return update(action);
  };
  await assert.rejects(createHome(options(f)), /Profile not found/);
  const [replacement] = (await f.store.read()).profiles;
  assert.notEqual(replacement.id, originalId);
  assert.equal(replacement.native, undefined);
  const marker = JSON.parse(await readFile(join(f.base, originalId, '.xfx-home-setup.json'), 'utf8'));
  assert.equal(marker.profileId, originalId);
  assert.equal(marker.phase, 'prepared');
});

test('refuses collisions and existing directories without owner metadata', async t => {
  const f = await fixture(t);
  await f.store.update(data => create(data, 'new'));
  const profile = (await f.store.read()).profiles[0], collision = join(f.base, profile.id);
  await mkdir(collision, { mode: 0o700 });
  await assert.rejects(createHome(options(f)), /without Xenoflux setup metadata/);
  assert.equal((await f.store.read()).profiles[0].native, undefined);
});

test('native login is injected, uses the isolated registered environment, and records completion without inspecting auth', async t => {
  const f = await fixture(t), made = await createHome(options(f));
  let invocation;
  const completed = await startHomeSignIn({ ...loginOptions(f), run: async value => { invocation = value; return { exitCode: 0 }; } });
  assert.deepEqual(invocation.args, ['login']); assert.equal(invocation.env.CODEX_HOME, made.home);
  assert.equal(completed.login.state, 'completed');
  await writeFile(join(made.home, 'auth.json'), 'never read', { mode: 0o600 });
  assert.equal((await inspectHomeCreation({ store: f.store, name: 'new', base: f.base })).login.state, 'completed');
});

test('failed and cancelled login retain a retryable prepared home', async t => {
  const f = await fixture(t); await createHome(options(f));
  const failed = await startHomeSignIn({ ...loginOptions(f), run: async () => ({ exitCode: 4 }) });
  assert.equal(failed.login.state, 'failed');
  await assert.rejects(startHomeSignIn({ ...loginOptions(f), run: async () => { const error = new Error('cancel'); error.code = 'CANCELLED'; throw error; } }), { code: 'CANCELLED' });
  assert.equal((await inspectHomeCreation({ store: f.store, name: 'new', base: f.base })).login.state, 'cancelled');
});

test('a failed injected login releases its owned run lock for a retry', async t => {
  const f = await fixture(t); await createHome(options(f));
  await assert.rejects(startHomeSignIn({ ...loginOptions(f), run: async () => { throw new Error('spawn failed'); } }));
  const retried = await startHomeSignIn({ ...loginOptions(f), run: async () => ({ exitCode: 0 }) });
  assert.equal(retried.login.state, 'completed');
});

test('preflight failures do not create a profile or native directory', async t => {
  const f = await fixture(t);
  await assert.rejects(createHome({ ...options(f), executable: join(f.root, 'missing') }), /ENOENT|executable/);
  assert.deepEqual((await f.store.read()).profiles, []);
});

test('refuses the reserved Default profile name before creating a profile', async t => {
  const f = await fixture(t);
  await assert.rejects(createHome({ ...options(f), name: 'dEfAuLt' }), /reserved/);
  await assert.rejects(planHomeCreation({ ...options(f), name: 'Default' }), /reserved/);
  assert.deepEqual((await f.store.read()).profiles, []);
});

test('completed progress survives retry and profile rename without rewriting setup state', async t => {
  const f = await fixture(t), made = await createHome(options(f));
  await startHomeSignIn({ ...loginOptions(f), run: async () => ({ exitCode: 0 }) });
  const marker = join(made.root, '.xfx-home-setup.json'), before = await readFile(marker, 'utf8');
  await f.store.update(data => renameProfile(data, 'new', 'renamed'));
  const retried = await createHome({ ...options(f), name: 'renamed' });
  assert.equal(retried.login.state, 'completed');
  assert.equal(await readFile(marker, 'utf8'), before);
  assert.equal((await inspectHomeCreation({ store: f.store, name: 'renamed', base: f.base })).login.state, 'completed');
  assert.equal((await planHomeCreation({ store: f.store, name: 'renamed', base: f.base })).login.state, 'completed');
});

test('setup lock serializes a retry before it can touch the home', async t => {
  const f = await fixture(t), made = await createHome(options(f));
  const profile = (await f.store.read()).profiles[0], owner = { kind: 'test', pid: process.pid, host: hostname(), runId: randomUUID() };
  const lock = join(f.base, `.${profile.id}.setup-lock`);
  await acquire(lock, owner);
  try { await assert.rejects(createHome(options(f)), /locked/); }
  finally { await release(lock, owner); }
  assert.equal((await inspectHomeCreation({ store: f.store, name: 'new', base: f.base })).root, made.root);
});

test('a matching dead setup owner is reclaimed and resumes its empty intended root', async t => {
  const f = await fixture(t); await f.store.update(data => create(data, 'new'));
  const profile = (await f.store.read()).profiles[0], root = join(f.base, profile.id), lock = join(f.base, `.${profile.id}.setup-lock`);
  const owner = { kind: 'native-home-setup', pid: 999999, host: hostname(), runId: randomUUID(), storePath: f.store.directory, profileId: profile.id, root };
  await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  await mkdir(root, { mode: 0o700 });
  const made = await createHome({ ...options(f), isAlive: () => false });
  assert.equal(made.root, root); assert.equal(made.login.state, 'pending');
});

test('concurrent retries preserve stale setup intent and leave a resumable home', async t => {
  const f = await fixture(t); await f.store.update(data => create(data, 'new'));
  const profile = (await f.store.read()).profiles[0], root = join(f.base, profile.id), lock = join(f.base, `.${profile.id}.setup-lock`);
  const owner = { kind: 'native-home-setup', pid: 999999, host: hostname(), runId: randomUUID(), storePath: f.store.directory, profileId: profile.id, root };
  await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  await mkdir(root, { mode: 0o700 });
  const attempts = await Promise.allSettled([createHome({ ...options(f), isAlive: () => false }), createHome({ ...options(f), isAlive: () => false })]);
  if (!attempts.some(item => item.status === 'fulfilled')) await createHome({ ...options(f), isAlive: () => false });
  const setup = await inspectHomeCreation({ store: f.store, name: 'new', base: f.base });
  assert.equal(setup.root, root); assert.notEqual(setup.status, 'preparing');
});

test('a live or foreign setup lock is never reclaimed and its empty root is preserved', async t => {
  for (const type of ['live', 'foreign']) await t.test(type, async t => {
    const f = await fixture(t); await f.store.update(data => create(data, 'new'));
    const profile = (await f.store.read()).profiles[0], root = join(f.base, profile.id), lock = join(f.base, `.${profile.id}.setup-lock`);
    const owner = { kind: 'native-home-setup', pid: type === 'live' ? process.pid : 999999, host: hostname(), runId: randomUUID(), storePath: f.store.directory,
      profileId: profile.id, root: type === 'foreign' ? join(f.base, 'other-root') : root };
    await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    await mkdir(root, { mode: 0o700 });
    await assert.rejects(createHome({ ...options(f), isAlive: () => type === 'live' }), /locked/);
    assert.equal((await lstat(root)).isDirectory(), true);
  });
});

test('a registered home without its owned setup marker is not preview-resumable', async t => {
  const f = await fixture(t), made = await createHome(options(f));
  await rm(join(made.root, '.xfx-home-setup.json'));
  await assert.rejects(planHomeCreation({ store: f.store, name: 'new', base: f.base }), /cannot be resumed/);
});

test('cancelled returned login never reports completion and probe/RAM preparation use the bound home', async t => {
  const f = await fixture(t), made = await createHome(options(f));
  const controller = new AbortController();
  let prepared = false;
  const outcome = await startHomeSignIn({ store: f.store, name: 'new', base: f.base, signal: controller.signal,
    probe: async () => '0.153.4', ramLogs: { prepareHome: async ({ home, key }) => { prepared = home === made.home && Boolean(key); } },
    run: async () => { controller.abort(); return { exitCode: 0 }; } });
  assert.equal(outcome.login.state, 'cancelled');
  assert.equal(prepared, true);
});

test('an uncertain interactive shutdown preserves the run lock for recovery', async t => {
  const f = await fixture(t), made = await createHome(options(f));
  await assert.rejects(startHomeSignIn({ ...loginOptions(f), run: async () => { const error = new Error('uncertain'); error.code = 'SHUTDOWN_FAILED'; throw error; } }), { code: 'SHUTDOWN_FAILED' });
  await assert.rejects(startHomeSignIn({ ...loginOptions(f), run: async () => ({ exitCode: 0 }) }), /locked/);
  assert.equal((await inspectHomeCreation({ store: f.store, name: 'new', base: f.base })).login.state, 'running');
  assert.equal(made.root.endsWith((await f.store.read()).profiles[0].id), true);
});

test('a completed sign-in refusal preserves its completed marker', async t => {
  const f = await fixture(t), made = await createHome(options(f));
  await startHomeSignIn({ ...loginOptions(f), run: async () => ({ exitCode: 0 }) });
  const marker = join(made.root, '.xfx-home-setup.json'), before = await readFile(marker, 'utf8');
  await assert.rejects(startHomeSignIn({ ...loginOptions(f), run: async () => ({ exitCode: 0 }) }), /not prepared/);
  assert.equal(await readFile(marker, 'utf8'), before);
});

test('a cancelled version preflight records cancelled rather than a completed login', async t => {
  const f = await fixture(t); await createHome(options(f));
  await assert.rejects(startHomeSignIn({ ...loginOptions(f), probe: async () => { const error = new Error('cancel'); error.code = 'CANCELLED'; throw error; }, run: async () => ({ exitCode: 0 }) }), { code: 'CANCELLED' });
  assert.equal((await inspectHomeCreation({ store: f.store, name: 'new', base: f.base })).login.state, 'cancelled');
});

test('an executable replacement after the version probe prevents native login', async t => {
  const f = await fixture(t); await createHome(options(f));
  let ran = false;
  await assert.rejects(startHomeSignIn({ ...loginOptions(f), probe: async () => { await writeFile(f.executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); return '0.153.4'; }, run: async () => { ran = true; return { exitCode: 0 }; } }), { code: 'EXECUTABLE_CHANGED' });
  assert.equal(ran, false);
  assert.equal((await inspectHomeCreation({ store: f.store, name: 'new', base: f.base })).login.state, 'failed');
});
