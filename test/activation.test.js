import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { activationPlan } from '../src/activation.js';

const app = { appPath: '/fixture/Codex.app', executable: '/fixture/Codex.app/Contents/MacOS/Codex', version: 'fixture' };

async function fixture(t, config = 'cli_auth_credentials_store = "file"\n') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-activation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const native = await prepareNativeHome({ directory: join(root, 'profile'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store'));
  await store.update(data => create(data, 'work'));
  await registerHome(store, 'work', native.root, { executable, version: '0.153.4' });
  await rm(native.desktopData, { recursive: true });
  const defaultUserHome = join(root, 'default-home');
  const desktopData = join(defaultUserHome, 'Library', 'Application Support', 'Codex');
  await mkdir(join(defaultUserHome, '.codex'), { recursive: true, mode: 0o700 });
  await mkdir(desktopData, { recursive: true, mode: 0o700 });
  await writeFile(join(defaultUserHome, '.codex', 'config.toml'), config, { mode: 0o600 });
  let inspections = 0;
  return { root, native, store, defaultUserHome, desktopData, runtime: { inspectApp: async () => { inspections += 1; return app; } }, inspections: () => inspections };
}

async function directEntries(path) {
  return (await readdir(path)).sort();
}
const blocker = (plan, code) => plan.blockers.find(item => item.code === code);

async function storeAt(f, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'profiles.json'), await readFile(f.store.file), { mode: 0o600 });
  return new Store(directory);
}

test('activation preview preserves both original paths, proposes paired aliases and never writes state', async t => {
  const f = await fixture(t, 'unrelated_secret = "CREDENTIAL-SENTINEL"\n');
  const beforeStore = await f.store.read();
  const beforeRoot = await directEntries(f.root);
  const plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: f.desktopData, platform: 'darwin' });
  assert.equal(plan.status, 'ready-preview');
  assert.deepEqual(plan.blockers, []);
  assert.equal(f.inspections(), 1);
  assert.deepEqual(plan.changes.map(change => change.alias), [join(f.defaultUserHome, '.codex'), f.desktopData]);
  assert.deepEqual(plan.changes.map(change => change.originalPath), [join(f.defaultUserHome, '.codex.xenoflux-original'), join(dirname(f.desktopData), 'Codex.xenoflux-original')]);
  for (const [index, change] of plan.changes.entries()) {
    assert.deepEqual(change.proposedSteps.map(step => step.action), index === 0
      ? ['preserve-original-by-rename', 'install-directory-symlink']
      : ['create-private-directory', 'preserve-original-by-rename', 'install-directory-symlink']);
    assert.deepEqual(change.rollback, [
      { action: 'remove-only-matching-managed-alias', path: change.alias, expectedTarget: change.target },
      { action: 'restore-preserved-directory', from: change.originalPath, to: change.alias, requireDestinationAbsent: true },
    ]);
  }
  assert.equal(plan.journalPath, join(f.store.directory, 'activation', 'session.json'));
  assert.equal(plan.launchDifferences.profileUserHome, f.native.userHome);
  assert.equal(plan.launchDifferences.defaultUserHome, f.defaultUserHome);
  assert.notEqual(plan.launchDifferences.profileUserHome, f.defaultUserHome);
  assert.equal(plan.credentialFilesRead, false);
  assert.equal(plan.databaseContentsRead, false);
  assert.equal(plan.lifecycleActionsPerformed, false);
  assert.doesNotMatch(JSON.stringify(plan), /CREDENTIAL-SENTINEL/);
  assert.deepEqual(await f.store.read(), beforeStore);
  assert.deepEqual(await directEntries(f.root), beforeRoot);
  await assert.rejects(access(plan.journalPath), { code: 'ENOENT' });
  assert.equal((await lstat(join(f.defaultUserHome, '.codex'))).isDirectory(), true);
  assert.equal((await lstat(f.desktopData)).isDirectory(), true);
});

test('routing preview reports default and unsupported credential stores without exposing configuration contents', async t => {
  const f = await fixture(t, 'api_key = "SECRET-SENTINEL"\n');
  let plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: f.desktopData });
  assert.equal(plan.originalRouting.credentialStore, 'native-default-unresolved');
  assert.deepEqual(Object.keys(plan.originalRouting).sort(), ['credentialStore', 'path', 'scope', 'sqliteHome', 'status']);
  assert.doesNotMatch(JSON.stringify(plan), /SECRET-SENTINEL|api_key/);
  await writeFile(join(f.defaultUserHome, '.codex', 'config.toml'), 'cli_auth_credentials_store = "unknown-backend"\n', { mode: 0o600 });
  plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: f.desktopData });
  assert.equal(plan.originalRouting.credentialStore, 'unsupported');
});

test('an explicit SQLite route is a blocker and only routing metadata is inspected', async t => {
  const f = await fixture(t, 'cli_auth_credentials_store = "file"\nsqlite_home = "/fixture/sqlite"\nsecret = "SQLITE-SECRET"\n');
  const plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: f.desktopData });
  assert.equal(plan.originalRouting.sqliteHome, '/fixture/sqlite');
  assert.ok(blocker(plan, 'EXPLICIT_SQLITE_ROUTE'));
  assert.doesNotMatch(JSON.stringify(plan), /SQLITE-SECRET|secret/);
});

test('unmanaged and dangling original aliases are blocked without following their targets', async t => {
  const f = await fixture(t);
  const original = join(f.defaultUserHome, '.codex');
  await rm(original, { recursive: true });
  await symlink(join(f.root, 'does-not-exist'), original);
  const plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: f.desktopData });
  const change = plan.changes[0];
  assert.equal(change.source.kind, 'symlink');
  assert.equal(change.source.target, join(f.root, 'does-not-exist'));
  assert.deepEqual(change.proposedSteps, []);
  assert.deepEqual(change.rollback, []);
  assert.match(change.conflicts.join('; '), /unmanaged/);
  assert.equal(plan.originalRouting.status, 'not-inspected');
  assert.equal(plan.immediateHomeLinks.status, 'not-inspected');
  assert.equal((await lstat(original)).isSymbolicLink(), true);
});

test('a pre-existing preservation path blocks activation and is never overwritten', async t => {
  const f = await fixture(t);
  const preserved = join(f.defaultUserHome, '.codex.xenoflux-original');
  await mkdir(preserved, { mode: 0o700 });
  await writeFile(join(preserved, 'keep'), 'preserve me', { mode: 0o600 });
  const plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: f.desktopData });
  assert.match(plan.changes[0].conflicts.join('; '), /Original-preservation path already exists/);
  assert.deepEqual(plan.changes[0].proposedSteps, []);
  assert.deepEqual(plan.changes[0].rollback, []);
  assert.equal(await readFile(join(preserved, 'keep'), 'utf8'), 'preserve me');
});

test('rejects unsafe paths and blocks target overlaps instead of proposing cyclic aliases', async t => {
  const f = await fixture(t);
  await assert.rejects(activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: 'relative-home', desktopData: f.desktopData }), /Default user home/);
  await assert.rejects(activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: 'relative-data' }), /Desktop data/);
  const selectedData = f.native.desktopData;
  const plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: selectedData });
  assert.match(plan.changes[1].conflicts.join('; '), /overlaps an alias/);
  assert.deepEqual(plan.changes[1].proposedSteps, []);
});

test('blocks a desktop alias that collides with the Codex original-preservation path for both components', async t => {
  const f = await fixture(t);
  const codexOriginal = join(f.defaultUserHome, '.codex.xenoflux-original');
  const plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: codexOriginal });
  assert.equal(plan.changes[0].originalPath, codexOriginal);
  assert.equal(plan.changes[1].alias, codexOriginal);
  assert.ok(blocker(plan, 'PATH_CONFLICT'));
  assert.deepEqual(plan.changes[0].proposedSteps, []);
  assert.deepEqual(plan.changes[1].proposedSteps, []);
  assert.deepEqual(plan.changes[0].rollback, []);
  assert.deepEqual(plan.changes[1].rollback, []);
});

test('blocks desktop aliases and preservation paths nested across the Codex boundary', async t => {
  const f = await fixture(t);
  const desktopData = join(f.defaultUserHome, '.codex', 'desktop-data');
  const plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData });
  assert.equal(plan.changes[1].alias, desktopData);
  assert.equal(plan.changes[1].originalPath, join(f.defaultUserHome, '.codex', 'desktop-data.xenoflux-original'));
  assert.ok(blocker(plan, 'OVERLAPPING_ALIASES'));
  assert.deepEqual(plan.changes[0].proposedSteps, []);
  assert.deepEqual(plan.changes[1].proposedSteps, []);
  assert.deepEqual(plan.changes[0].rollback, []);
  assert.deepEqual(plan.changes[1].rollback, []);
});

test('blocks stores that overlap selected targets, aliases, or original-preservation paths', async t => {
  const f = await fixture(t);
  const candidates = [
    f.native.home,
    join(f.defaultUserHome, '.codex'),
    join(f.defaultUserHome, '.codex.xenoflux-original'),
  ];
  for (const directory of candidates) {
    const overlappingStore = await storeAt(f, directory);
    const plan = await activationPlan(overlappingStore, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: f.desktopData });
    assert.ok(blocker(plan, 'PATH_CONFLICT'), directory);
    assert.deepEqual(plan.changes[0].proposedSteps, [], directory);
    assert.deepEqual(plan.changes[0].rollback, [], directory);
  }
});

test('reports only immediate link text, leaves shared targets unread, and does not traverse nested links', async t => {
  const f = await fixture(t);
  const home = join(f.defaultUserHome, '.codex'), shared = join(f.root, 'shared');
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, 'credential'), 'SHARED-CREDENTIAL-SENTINEL', { mode: 0o600 });
  await symlink(shared, join(home, 'shared-link'));
  await mkdir(join(home, 'nested'), { mode: 0o700 });
  await symlink(shared, join(home, 'nested', 'hidden-link'));
  const plan = await activationPlan(f.store, 'work', { runtime: f.runtime, defaultUserHome: f.defaultUserHome, desktopData: f.desktopData });
  assert.deepEqual(plan.immediateHomeLinks, { status: 'inspected', depth: 1, links: [{
    path: join(home, 'shared-link'), target: shared, external: true, inspected: 'link text only; target not followed',
  }] });
  assert.doesNotMatch(JSON.stringify(plan), /SHARED-CREDENTIAL-SENTINEL|hidden-link/);
  assert.ok(blocker(plan, 'LINKED_RESOURCES_REVIEW'));
  assert.equal(await readFile(join(shared, 'credential'), 'utf8'), 'SHARED-CREDENTIAL-SENTINEL');
});
