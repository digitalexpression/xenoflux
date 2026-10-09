import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareProfileLauncher } from '../src/profile-launcher.js';

const profileA = 'd083b722-5744-4d5d-9fa2-81ffb8e85a14';
const profileB = '9d73a112-a533-41c2-b316-10fd2530ac73';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = join(root, 'store');
  await mkdir(storeDirectory);
  return { store: { directory: await realpath(storeDirectory) }, root };
}
function compiler(counter) {
  return async ({ output }) => {
    counter.count += 1;
    await writeFile(output, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  };
}
const options = build => ({ build, nodeExecutable: '/usr/bin/true', entryPoint: '/usr/bin/true' });

test('prepares a stable profile-labelled app with escaped plist and owned helper cache', async t => {
  const { store, root } = await fixture(t);
  const builds = { count: 0 };
  const plan = { profileId: profileA, name: 'Dev & <QA> "Blue"' };
  const first = await prepareProfileLauncher(store, plan, options(compiler(builds)));
  const second = await prepareProfileLauncher(store, plan, options(compiler(builds)));
  assert.deepEqual(second, first);
  assert.equal(builds.count, 1);
  assert.equal(first.launcherApp, join(store.directory, 'desktop-instances', 'apps', `${profileA}.app`));
  assert.match(first.helperSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.launcherExecutable, join(first.launcherApp, 'Contents', 'MacOS', 'XfxProfileLauncher'));
  assert.equal(first.helperExecutable, join(store.directory, 'desktop-instances', 'native', (await readdir(join(store.directory, 'desktop-instances', 'native'))).find(x => !x.startsWith('.')), 'XfxProfileLauncher'));
  const plist = await readFile(join(first.launcherApp, 'Contents', 'Info.plist'), 'utf8');
  assert.match(plist, /Codex · Dev &amp; &lt;QA&gt; &quot;Blue&quot;/);
  assert.match(plist, new RegExp(`com\\.xenoflux\\.profile\\.${profileA}`));
  assert.match(plist, new RegExp(`<key>XfxProfileId<\/key><string>${profileA}<\/string>`));
  assert.match(plist, /<key>XfxStore<\/key><string>[^<]*<\/string>/);
  assert.equal((await readFile(first.launcherExecutable)).toString(), '#!/bin/sh\nexit 0\n');
  assert.ok((await realpath(root)).includes('xfx-launcher-'));
});

test('separate profile bundles share the source-hash helper cache', async t => {
  const { store } = await fixture(t);
  const builds = { count: 0 };
  const a = await prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(compiler(builds)));
  const b = await prepareProfileLauncher(store, { profileId: profileB, name: 'Beta' }, options(compiler(builds)));
  assert.notEqual(a.launcherApp, b.launcherApp);
  assert.equal(a.helperExecutable, b.helperExecutable);
  assert.equal(builds.count, 1);
});

test('refuses an unmarked existing app bundle', async t => {
  const { store } = await fixture(t);
  const apps = join(store.directory, 'desktop-instances', 'apps');
  await mkdir(apps, { recursive: true, mode: 0o700 });
  await chmod(apps, 0o700);
  await writeFile(join(apps, '.xfx-owned.json'), JSON.stringify({ kind: 'xenoflux-profile-launcher-apps', store: store.directory }), { mode: 0o600 });
  const foreign = join(apps, `${profileA}.app`);
  await mkdir(foreign, { mode: 0o700 });
  await writeFile(join(foreign, 'foreign.txt'), 'leave me');
  const builds = { count: 0 };
  await assert.rejects(prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(compiler(builds))), { code: 'LAUNCHER_OWNERSHIP_MISMATCH' });
  assert.equal(await readFile(join(foreign, 'foreign.txt'), 'utf8'), 'leave me');
});

test('refuses a symlink at the per-profile bundle path', async t => {
  const { store, root } = await fixture(t);
  const apps = join(store.directory, 'desktop-instances', 'apps');
  await mkdir(apps, { recursive: true, mode: 0o700 });
  await chmod(apps, 0o700);
  await writeFile(join(apps, '.xfx-owned.json'), JSON.stringify({ kind: 'xenoflux-profile-launcher-apps', store: store.directory }), { mode: 0o600 });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(apps, `${profileA}.app`));
  await assert.rejects(prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(compiler({ count: 0 }))), { code: 'LAUNCHER_DIRECTORY_UNSAFE' });
});

test('rejects invalid profile identifiers before creating launcher content', async t => {
  const { store } = await fixture(t);
  await assert.rejects(prepareProfileLauncher(store, { profileId: '../escape', name: 'Bad' }, options(async () => {})), { code: 'INVALID_LAUNCHER_PLAN' });
  assert.deepEqual(await readdir(store.directory), []);
});


test('canonicalizes a symlinked Node executable into the bundle metadata', async t => {
  const { store, root } = await fixture(t);
  const nodeAlias = join(root, 'node-alias');
  await symlink('/usr/bin/true', nodeAlias);
  const build = compiler({ count: 0 });
  const prepared = await prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, {
    ...options(build), nodeExecutable: nodeAlias,
  });
  const plist = await readFile(join(prepared.launcherApp, 'Contents', 'Info.plist'), 'utf8');
  assert.ok(plist.includes(`<key>XfxNode</key><string>${await realpath(nodeAlias)}</string>`));
});

test('refuses a symlink substituted for the cached native helper', async t => {
  const { store } = await fixture(t);
  const build = compiler({ count: 0 });
  const prepared = await prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(build));
  await unlink(prepared.helperExecutable);
  await symlink('/usr/bin/true', prepared.helperExecutable);
  await assert.rejects(prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(build)), { code: 'LAUNCHER_CACHE_UNSAFE' });
});

test('refuses a cached helper whose bytes differ from the recorded digest', async t => {
  const { store } = await fixture(t);
  const build = compiler({ count: 0 });
  const prepared = await prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(build));
  await writeFile(prepared.helperExecutable, '#!/bin/sh\nexit 7\n', { mode: 0o700 });
  await assert.rejects(prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(build)), { code: 'LAUNCHER_CACHE_UNSAFE' });
});

test('refuses a cache directory with group or world permissions', async t => {
  const { store } = await fixture(t);
  const build = compiler({ count: 0 });
  await prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(build));
  const cacheDirectory = join(store.directory, 'desktop-instances', 'native', (await readdir(join(store.directory, 'desktop-instances', 'native'))).find(name => /^[a-f0-9]{64}$/.test(name)));
  await chmod(cacheDirectory, 0o755);
  try {
    await assert.rejects(prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(build)), { code: 'LAUNCHER_CACHE_UNSAFE' });
  } finally { await chmod(cacheDirectory, 0o700); }
});

test('refuses a hard-linked cache ownership marker', async t => {
  const { store, root } = await fixture(t);
  const build = compiler({ count: 0 });
  await prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(build));
  const marker = join(join(store.directory, 'desktop-instances', 'native', (await readdir(join(store.directory, 'desktop-instances', 'native'))).find(name => /^[a-f0-9]{64}$/.test(name))), '.xfx-owned.json');
  await link(marker, join(root, 'linked-marker'));
  await assert.rejects(prepareProfileLauncher(store, { profileId: profileA, name: 'Alpha' }, options(build)), { code: 'LAUNCHER_CACHE_UNSAFE' });
});
