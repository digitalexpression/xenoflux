import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { prepareProfileApp, validateProfileApp } from '../src/profile-launcher.js';

const profileA = 'd083b722-5744-4d5d-9fa2-81ffb8e85a14';
const profileB = '9d73a112-a533-41c2-b316-10fd2530ac73';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, profileId = profileA, name = 'Blue & <QA>') {
  const root = await mkdtemp(join(tmpdir(), 'xfx-profile-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = join(root, 'store');
  await mkdir(storeDirectory, { mode: 0o700 });
  const sourceApp = join(root, 'vendor', 'Codex.app');
  const contents = join(sourceApp, 'Contents');
  await mkdir(join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
  await mkdir(join(contents, 'Resources'), { recursive: true, mode: 0o700 });
  const executable = join(contents, 'MacOS', 'Codex');
  const executableBytes = Buffer.from('#!/bin/sh\nexit 0\n');
  const asarBytes = Buffer.from('mock vendor archive');
  await writeFile(executable, executableBytes, { mode: 0o700 });
  await writeFile(join(contents, 'Resources', 'app.asar'), asarBytes, { mode: 0o600 });
  await writeFile(join(contents, 'Info.plist'), JSON.stringify({
    CFBundleName: 'Codex', CFBundleDisplayName: 'Codex', CFBundleIdentifier: 'com.openai.codex',
    CFBundleExecutable: 'Codex', CFBundlePackageType: 'APPL', CFBundleURLTypes: [{ CFBundleURLSchemes: ['codex'] }],
    CFBundleDocumentTypes: [{ CFBundleTypeName: 'Codex document' }], SUFeedURL: 'https://vendor.invalid/feed.xml',
  }), { mode: 0o600 });
  const appPath = await realpath(sourceApp);
  const app = { appPath, bundleId: 'com.openai.codex', executable, asarSha256: digest(asarBytes) };
  const plan = { profileId, name, nativeRoot: join(storeDirectory, 'profiles', profileId, 'native'), app };
  const options = {
    build: async ({ output }) => writeFile(output, '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
    nodeExecutable: '/usr/bin/true', entryPoint: '/usr/bin/true',
    verifyOriginal: async sourcePath => ({ ...app, appPath: sourcePath }),
    copyApp: (sourcePath, destination) => cp(sourcePath, destination, { recursive: true, verbatimSymlinks: true }),
    updatePlist: async (path, { set, remove }) => {
      const plist = JSON.parse(await readFile(path, 'utf8'));
      for (const key of remove) delete plist[key];
      Object.assign(plist, set);
      await writeFile(path, JSON.stringify(plist), { mode: 0o600 });
    },
    signApp: async () => {},
    execFile: async (command, args) => {
      if (command === '/usr/bin/plutil') return { stdout: await readFile(args.at(-1), 'utf8') };
      if (command === '/usr/bin/codesign') return { stdout: '' };
      throw new Error(`unexpected command ${command}`);
    },
  };
  return { root, store: { directory: await realpath(storeDirectory) }, plan, sourceApp: appPath, options };
}

test('clones a verified vendor bundle into a labelled private app while preserving resources and icon files', async t => {
  const { store, plan, options, sourceApp } = await fixture(t);
  const icon = join(sourceApp, 'Contents', 'Resources', 'AppIcon.icns');
  await writeFile(icon, 'icon fixture', { mode: 0o600 });
  plan.app.asarSha256 = digest(await readFile(join(sourceApp, 'Contents', 'Resources', 'app.asar')));
  const prepared = await prepareProfileApp(store, plan, options);
  const expectedBundleId = `com.xenoflux.profile.${profileA}`;
  assert.equal(prepared.application.bundleId, expectedBundleId);
  assert.equal(basename(prepared.application.appPath), 'Codex · Blue & <QA>.app');
  assert.equal(prepared.application.executable, join(prepared.application.appPath, 'Contents', 'MacOS', 'Codex'));
  assert.equal(prepared.bootstrapExecutable, join(prepared.application.appPath, 'Contents', 'MacOS', 'XfxProfileLauncher'));
  assert.equal(await readFile(prepared.application.executable, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(await readFile(icon, 'utf8'), 'icon fixture');
  assert.equal(await readFile(join(prepared.application.appPath, 'Contents', 'Resources', 'AppIcon.icns'), 'utf8'), 'icon fixture');
  const info = JSON.parse(await readFile(join(prepared.application.appPath, 'Contents', 'Info.plist'), 'utf8'));
  assert.equal(info.CFBundleIdentifier, expectedBundleId);
  assert.equal(info.CFBundleExecutable, 'XfxProfileLauncher');
  assert.equal(info.CFBundleName, 'Codex · Blue & <QA>');
  assert.equal(info.CFBundleDisplayName, info.CFBundleName);
  assert.equal(info.XfxStore, store.directory);
  assert.equal(info.XfxProfileId, profileA);
  assert.equal(info.XfxNativeRoot, plan.nativeRoot);
  assert.equal(info.XfxVendorExecutable, 'Codex');
  assert.equal(info.CFBundleURLTypes, undefined);
  assert.equal(info.CFBundleDocumentTypes, undefined);
  assert.equal(info.SUFeedURL, undefined);
  const validated = await validateProfileApp(store, plan, prepared.application, options);
  assert.deepEqual(validated.application, prepared.application);
  assert.equal(validated.bootstrapExecutable, prepared.bootstrapExecutable);
  assert.equal(validated.helperSha256, prepared.helperSha256);
});

test('default bundle copy creates independent files rather than links into the source app', async t => {
  const { store, plan, options, sourceApp } = await fixture(t);
  const prepared = await prepareProfileApp(store, plan, { ...options, copyApp: undefined });
  const copiedExecutable = await lstat(prepared.application.executable);
  assert.equal(copiedExecutable.nlink, 1);
  assert.notEqual(await realpath(prepared.application.executable), await realpath(join(sourceApp, 'Contents', 'MacOS', 'Codex')));
  assert.equal(await readFile(prepared.application.executable, 'utf8'), await readFile(join(sourceApp, 'Contents', 'MacOS', 'Codex'), 'utf8'));
});

test('reuses a validated private bundle and native helper for the same profile', async t => {
  const { store, plan, options } = await fixture(t);
  let builds = 0, copies = 0;
  const tracked = { ...options, build: async args => { builds += 1; return options.build(args); }, copyApp: async (...args) => { copies += 1; return options.copyApp(...args); } };
  const first = await prepareProfileApp(store, plan, tracked);
  const second = await prepareProfileApp(store, plan, tracked);
  assert.deepEqual(second, first);
  assert.equal(builds, 1);
  assert.equal(copies, 1);
});

test('refreshes an owned bundle when vendor or helper sources change and refuses in-place refresh on Finder launch', async t => {
  const { root, store, plan, options } = await fixture(t);
  const helperSource = join(root, 'profile-launcher.swift');
  await writeFile(helperSource, 'fixture helper source v1');
  let copies = 0, signs = 0;
  const tracked = { ...options, source: helperSource,
    copyApp: async (...args) => { copies += 1; return options.copyApp(...args); },
    signApp: async (...args) => { signs += 1; return options.signApp(...args); } };
  const initial = await prepareProfileApp(store, plan, tracked);
  const oldAsarPath = join(initial.application.appPath, 'Contents', 'Resources', 'app.asar');
  assert.equal(await readFile(oldAsarPath, 'utf8'), 'mock vendor archive');

  const newAsar = Buffer.from('updated verified vendor archive');
  const newExecutable = Buffer.from('#!/bin/sh\nexit 42\n');
  await writeFile(join(plan.app.appPath, 'Contents', 'Resources', 'app.asar'), newAsar);
  await writeFile(plan.app.executable, newExecutable);
  plan.app.asarSha256 = digest(newAsar);
  await writeFile(helperSource, 'fixture helper source v2');

  await assert.rejects(prepareProfileApp(store, plan, { ...tracked, allowRebuild: false }), error => {
    assert.equal(error.code, 'PROFILE_APP_REFRESH_REQUIRED');
    assert.match(error.message, /xfx desktop open/);
    return true;
  });
  assert.equal(await readFile(oldAsarPath, 'utf8'), 'mock vendor archive', 'refused refresh must preserve the running bundle');
  assert.equal(copies, 1);
  assert.equal(signs, 1);

  const refreshed = await prepareProfileApp(store, plan, tracked);
  assert.equal(refreshed.application.appPath, initial.application.appPath);
  assert.equal(copies, 2);
  assert.equal(signs, 2);
  assert.equal(await readFile(join(refreshed.application.appPath, 'Contents', 'Resources', 'app.asar'), 'utf8'), 'updated verified vendor archive');
  assert.deepEqual(await readFile(refreshed.application.executable), newExecutable);
  await validateProfileApp(store, plan, refreshed.application, options);
});

test('renames only a validated owned bundle when a closed profile changes its display name', async t => {
  const { store, plan, options } = await fixture(t);
  const first = await prepareProfileApp(store, plan, options);
  const renamedPlan = { ...plan, name: 'Renamed' };
  const renamed = await prepareProfileApp(store, renamedPlan, options);
  assert.notEqual(renamed.application.appPath, first.application.appPath);
  await assert.rejects(lstat(first.application.appPath), { code: 'ENOENT' });
  assert.deepEqual((await validateProfileApp(store, renamedPlan, renamed.application, options)).application, renamed.application);
  const info = JSON.parse(await readFile(join(renamed.application.appPath, 'Contents', 'Info.plist'), 'utf8'));
  assert.equal(info.CFBundleDisplayName, 'Codex · Renamed');
});

test('keeps cloned profiles separate while sharing the source-hash helper', async t => {
  const { store, plan, options } = await fixture(t);
  const other = { ...plan, profileId: profileB, name: 'Green' };
  const a = await prepareProfileApp(store, plan, options);
  const b = await prepareProfileApp(store, other, options);
  assert.notEqual(a.application.appPath, b.application.appPath);
  assert.notEqual(a.application.bundleId, b.application.bundleId);
  assert.equal(a.helperExecutable, b.helperExecutable);
  assert.equal(a.helperSha256, b.helperSha256);
});

test('refuses a profile directory containing an unknown app or marker', async t => {
  const { store, plan, options } = await fixture(t);
  const profileDir = join(store.directory, 'desktop-instances', 'apps', profileA);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profileDir, 'foreign.data'), 'keep');
  await assert.rejects(prepareProfileApp(store, plan, options), { code: 'PROFILE_APP_OWNERSHIP_MISMATCH' });
  assert.equal(await readFile(join(profileDir, 'foreign.data'), 'utf8'), 'keep');
});

test('rejects symlinked app directories and external links in source bundle', async t => {
  const fixtureA = await fixture(t);
  const profileDir = join(fixtureA.store.directory, 'desktop-instances', 'apps', profileA);
  await mkdir(join(fixtureA.store.directory, 'desktop-instances', 'apps'), { recursive: true, mode: 0o700 });
  await symlink(fixtureA.root, profileDir);
  await assert.rejects(prepareProfileApp(fixtureA.store, fixtureA.plan, fixtureA.options), { code: 'LAUNCHER_DIRECTORY_UNSAFE' });

  const fixtureB = await fixture(t);
  const external = join(fixtureB.root, 'outside');
  await writeFile(external, 'outside');
  await symlink(external, join(fixtureB.sourceApp, 'Contents', 'Resources', 'external-link'));
  await assert.rejects(prepareProfileApp(fixtureB.store, fixtureB.plan, fixtureB.options), { code: 'PROFILE_APP_EXTERNAL_LINK' });
});

test('refuses cached helper symlinks, changed bytes, and permissive cache directories', async t => {
  const { store, plan, options } = await fixture(t);
  const prepared = await prepareProfileApp(store, plan, options);
  await unlink(prepared.helperExecutable);
  await symlink('/usr/bin/true', prepared.helperExecutable);
  await assert.rejects(prepareProfileApp(store, plan, options), { code: 'LAUNCHER_CACHE_UNSAFE' });
  await unlink(prepared.helperExecutable);
  await writeFile(prepared.helperExecutable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await assert.rejects(prepareProfileApp(store, plan, options), { code: 'LAUNCHER_CACHE_UNSAFE' });
  const nativeRoot = join(store.directory, 'desktop-instances', 'native');
  const cacheDir = join(nativeRoot, (await readdir(nativeRoot)).find(name => /^[a-f0-9]{64}$/.test(name)));
  await chmod(cacheDir, 0o755);
  try { await assert.rejects(prepareProfileApp(store, plan, options), { code: 'LAUNCHER_CACHE_UNSAFE' }); }
  finally { await chmod(cacheDir, 0o700); }
});

test('validation refuses modified copied vendor resources even if the bundle still exists', async t => {
  const { store, plan, options } = await fixture(t);
  const prepared = await prepareProfileApp(store, plan, options);
  await writeFile(join(prepared.application.appPath, 'Contents', 'Resources', 'app.asar'), 'changed');
  await assert.rejects(validateProfileApp(store, plan, prepared.application, options), { code: 'PROFILE_APP_CONTENT_CHANGED' });
});

test('rejects invalid UUID and non-canonical native root before creating app storage', async t => {
  const { store, plan, options } = await fixture(t);
  await assert.rejects(prepareProfileApp(store, { ...plan, profileId: '../escape' }, options), { code: 'INVALID_LAUNCHER_PLAN' });
  await assert.rejects(prepareProfileApp(store, { ...plan, nativeRoot: '/tmp/../var/tmp' }, options), { code: 'INVALID_LAUNCHER_PLAN' });
  assert.deepEqual(await readdir(store.directory), []);
});

test('refuses a source app that no longer matches its inspection identity', async t => {
  const { store, plan, options } = await fixture(t);
  await assert.rejects(prepareProfileApp(store, plan, { ...options, verifyOriginal: async () => ({ ...plan.app, asarSha256: '0'.repeat(64) }) }), { code: 'PROFILE_APP_SOURCE_CHANGED' });
});

test('real Swift bootstrap routes the disposable signed app and execs it in the same pid', {
  skip: process.platform !== 'darwin' && 'requires macOS AppKit and codesign',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-native-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeDirectory = join(root, 'controller');
  const sourceApp = join(root, 'fixture-vendor', 'FakeCodex.app');
  const contents = join(sourceApp, 'Contents');
  await mkdir(storeDirectory, { mode: 0o700 });
  await mkdir(join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
  await mkdir(join(contents, 'Resources'), { recursive: true, mode: 0o700 });
  const source = join(root, 'fake-vendor.c');
  await writeFile(source, `#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\nstatic const char *v(const char *k){const char *x=getenv(k);return x?x:"";}\nint main(int argc,char **argv){printf("{\\\"pid\\\":%d,\\\"codex\\\":\\\"%s\\\",\\\"sqlite\\\":\\\"%s\\\",\\\"data\\\":\\\"%s\\\",\\\"home\\\":\\\"%s\\\",\\\"tmp\\\":\\\"%s\\\",\\\"arg\\\":\\\"%s\\\",\\\"launcherPid\\\":\\\"%s\\\"}\\n",getpid(),v("CODEX_HOME"),v("CODEX_SQLITE_HOME"),v("CODEX_ELECTRON_USER_DATA_PATH"),v("HOME"),v("TMPDIR"),argc>1?argv[1]:"",v("XFX_DESKTOP_LAUNCHER_PID"));return 0;}\n`);
  const vendorExecutable = join(contents, 'MacOS', 'Codex');
  execFileSync('/usr/bin/clang', ['-O2', source, '-o', vendorExecutable]);
  const asar = Buffer.from('disposable native bootstrap fixture');
  await writeFile(join(contents, 'Resources', 'app.asar'), asar, { mode: 0o600 });
  const plistJson = join(root, 'Info.json');
  await writeFile(plistJson, JSON.stringify({ CFBundleName: 'FakeCodex', CFBundleDisplayName: 'FakeCodex',
    CFBundleIdentifier: 'com.openai.codex', CFBundleExecutable: 'Codex', CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: '1.0', CFBundleVersion: '1' }));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', join(contents, 'Info.plist'), plistJson]);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--timestamp=none', sourceApp]);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', sourceApp]);

  const appPath = await realpath(sourceApp), executable = await realpath(vendorExecutable);
  const app = { appPath, bundleId: 'com.openai.codex', executable, asarSha256: digest(asar) };
  const plan = { profileId: profileA, name: 'Native Probe', nativeRoot: join(root, 'native', profileA), app };
  const store = { directory: await realpath(storeDirectory) };
  const options = {
    nodeExecutable: await realpath(process.execPath),
    entryPoint: await realpath(new URL('../bin/xfx.js', import.meta.url).pathname),
    verifyOriginal: async sourcePath => ({ ...app, appPath: sourcePath }),
  };
  const prepared = await prepareProfileApp(store, plan, options);
  await validateProfileApp(store, plan, prepared.application);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', prepared.application.appPath]);

  const child = spawnSync(prepared.bootstrapExecutable, ['--profile-run'], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: '/usr/bin:/bin', CODEX_HOME: '/private/tmp/foreign-home', CODEX_SQLITE_HOME: '/private/tmp/foreign-home',
      CODEX_ELECTRON_USER_DATA_PATH: '/private/tmp/foreign-data', HOME: '/private/tmp/foreign-user', TMPDIR: '/private/tmp/foreign-tmp',
      XFX_DESKTOP_LAUNCHER_PID: '999999', XFX_DESKTOP_LAUNCHER_EXECUTABLE: '/private/tmp/foreign-launcher' },
  });
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout.trim());
  assert.equal(observed.pid, child.pid, 'bootstrap must exec the vendor binary without changing pid');
  assert.equal(observed.codex, `${plan.nativeRoot}/codex-home`);
  assert.equal(observed.sqlite, `${plan.nativeRoot}/codex-home`);
  assert.equal(observed.data, `${plan.nativeRoot}/desktop-data`);
  assert.equal(observed.home, `${plan.nativeRoot}/user-home`);
  assert.equal(observed.tmp, `${plan.nativeRoot}/tmp`);
  assert.equal(observed.arg, `--user-data-dir=${plan.nativeRoot}/desktop-data`);
  assert.equal(observed.launcherPid, '', 'bootstrap must remove the launcher-attribution environment');

  const reused = await prepareProfileApp(store, plan, options);
  assert.deepEqual(reused, prepared, 'a validated bundle must be reused without another copy or signature replacement');
  await validateProfileApp(store, plan, reused.application);
});
