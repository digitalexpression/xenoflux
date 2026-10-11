import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { launchHome } from '../src/launcher.js';
import { removeProfile, unbindNativeHome } from '../src/profile-removal.js';
import { createDesktopRuntime } from '../src/desktop-runtime.js';
import { assertNoConcurrentDesktops } from '../src/desktop-instance-guard.js';
import { installationCommand, restoreHomeLogs } from '../src/installation-command.js';
import { desktopInstancePlan, openDesktopInstance, prepareDesktopInstance, focusDesktopInstance, closeDesktopInstance,
  recoverDesktopInstance, listDesktopInstances } from '../src/desktop-instances.js';

const app = { appPath: '/fixture/Codex.app', bundleId: 'com.openai.codex', executable: '/fixture/Codex.app/Contents/MacOS/Codex' };
const startedAt = 'Fri Oct 09 12:00:00 2026';
const row = (pid, executable = app.executable, ppid = 1) => ({ pid, ppid, uid: process.getuid(), startedAt, executable });
const cli = new URL('../bin/xfx.js', import.meta.url).pathname;
const loader = new URL('../test-support/desktop-instance-cli-loader.mjs', import.meta.url).pathname;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-instances-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'store'));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const names = ['A', 'B', 'C', 'D'], homes = {};
  await store.update(data => names.forEach(name => create(data, name)));
  for (const name of names) {
    homes[name] = await prepareNativeHome({ directory: join(root, name), executable, codexVersion: '0.153.4' });
    await registerHome(store, name, homes[name].root, { executable, version: '0.153.4' });
  }
  const defaultUserHome = join(root, 'user');
  const aliases = [join(defaultUserHome, '.codex'), join(defaultUserHome, 'Library', 'Application Support', 'Codex')];
  for (const path of aliases) { await mkdir(path, { recursive: true, mode: 0o700 }); await writeFile(join(path, 'preserved.txt'), 'existing-session', { mode: 0o600 }); }
  const original = row(10), calls = [], rows = [original]; let nextPid = 20;
  const runtime = {
    inspectApp: async () => app,
    snapshot: async () => structuredClone(rows),
    assertResourcesIdle: async paths => { calls.push({ operation: 'idle', paths }); },
    open: async (plan, { application, bootstrap, onBootstrapReady }) => {
      if (bootstrap) {
        const main = rows.find(entry => entry.pid === bootstrap.pid);
        if (!main) throw new Error('bootstrap disappeared');
        await onBootstrapReady({ kind: 'xfx-profile-bootstrap', pid: bootstrap.pid });
        main.executable = application.executable;
        calls.push({ operation: 'open', plan, application, bootstrap });
        return { main, processes: [main] };
      }
      const main = row(nextPid++, application.executable), helper = row(nextPid++, '/fixture/codex-app-server', main.pid);
      rows.push(main, helper); calls.push({ operation: 'open', plan, application });
      return { main, processes: [main, helper] };
    },
    observe: async (main, { trackedProcesses = [] } = {}) => {
      const current = rows.find(entry => entry.pid === main.pid);
      if (current && current.startedAt !== main.startedAt) return { status: 'identity-changed', processes: [current] };
      if (!current) {
        const children = trackedProcesses.filter(entry => entry.pid !== main.pid && rows.some(candidate => candidate.pid === entry.pid));
        return children.length ? { status: 'running', orphaned: true, processes: children } : { status: 'stopped', processes: [] };
      }
      return { status: 'running', processes: rows.filter(entry => entry.pid === current.pid || entry.ppid === current.pid) };
    },
    focus: async main => { calls.push({ operation: 'focus', main }); },
    close: async main => {
      calls.push({ operation: 'close', main });
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].pid === main.pid || rows[i].ppid === main.pid) rows.splice(i, 1);
    },
  };
  const preparedLaunchers = new Map();
  const prepareLauncher = async (store, plan) => {
    calls.push({ operation: 'prepare', profileId: plan.profileId });
    const appPath = join(store.directory, 'desktop-instances', 'apps', plan.profileId, `Codex · ${plan.name}.app`);
    const executable = join(appPath, 'Contents', 'MacOS', 'Codex');
    const bootstrapExecutable = join(appPath, 'Contents', 'MacOS', 'XfxProfileLauncher');
    const helperSha256 = createHash('sha256').update('desktop-instance-test-helper').digest('hex');
    const helperExecutable = join(store.directory, 'desktop-instances', 'native', helperSha256, 'XfxProfileLauncher');
    for (const directory of [join(store.directory, 'desktop-instances'), join(store.directory, 'desktop-instances', 'apps'),
      join(store.directory, 'desktop-instances', 'apps', plan.profileId), join(appPath, 'Contents', 'MacOS'),
      join(store.directory, 'desktop-instances', 'native', helperSha256)]) await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    await writeFile(bootstrapExecutable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    await writeFile(helperExecutable, 'desktop-instance-test-helper', { mode: 0o700 });
    const prepared = { application: { appPath, bundleId: `com.xenoflux.profile.${plan.profileId.toLowerCase()}`, executable },
      bootstrapExecutable, helperExecutable, helperSha256 };
    preparedLaunchers.set(plan.profileId, prepared);
    return prepared;
  };
  const loadLauncher = async (_store, plan) => {
    const prepared = preparedLaunchers.get(plan.profileId);
    if (!prepared) {
      const error = new Error('Profile app is not prepared; run xfx desktop prepare PROFILE.');
      error.code = 'PROFILE_APP_PREPARE_REQUIRED';
      throw error;
    }
    return prepared;
  };
  const ramLogs = { prepareHome: async args => { calls.push({ operation: 'logs', ...args }); } };
  const options = { runtime, prepareLauncher, loadLauncher, validateApp: async () => {}, ramLogs, defaultUserHome,
    lockPath: join(root, 'desktop.lock'), launcherEnvironment: {} };
  for (const name of names) {
    const plan = await desktopInstancePlan(store, name, { runtime });
    await prepareLauncher(store, plan);
  }
  return { root, store, homes, original, rows, calls, runtime, options, aliases, ramLogs };
}
const statePath = (f, id) => join(f.store.directory, 'desktop-instances', `${id}.json`);
const lockPath = (f, name) => join(f.homes[name].root, '.run-lock');

test('two fixed-home desktops coexist with the original and two simultaneously running CLI profiles', async t => {
  const f = await fixture(t), originalStore = await readFile(f.store.file);
  const a = await openDesktopInstance(f.store, 'A', f.options), b = await openDesktopInstance(f.store, 'B', f.options);
  let releaseCli; const hold = new Promise(resolve => { releaseCli = resolve; });
  let bothStarted; const ready = new Promise(resolve => { bothStarted = resolve; }); let count = 0;
  const launches = ['C', 'D'].map(name => launchHome(f.store, name, { ramLogs: f.ramLogs, probe: async () => '0.153.4', run: async args => {
    assert.equal(args.env.CODEX_HOME, f.homes[name].home);
    assert.equal(args.env.CODEX_SQLITE_HOME, f.homes[name].home);
    await args.onSpawn(name === 'C' ? 100 : 101);
    if (++count === 2) bothStarted();
    await hold;
    return { exitCode: 0, signal: null, shutdown: { groupTerminated: true, escapedDescendantsUnverified: true } };
  } }));
  try {
    await ready;
    for (const name of ['A', 'B', 'C', 'D']) await access(lockPath(f, name));
    assert.deepEqual(f.rows.find(row => row.pid === f.original.pid), f.original);
    const listed = await listDesktopInstances(f.store, { runtime: f.runtime, observe: true });
    assert.deepEqual(listed.instances.map(instance => instance.observed.status), ['running', 'running']);
    assert.notEqual(a.home, b.home); assert.notEqual(a.desktopData, b.desktopData);
    for (const path of f.aliases) assert.equal(await readFile(join(path, 'preserved.txt'), 'utf8'), 'existing-session');
    assert.deepEqual(await readFile(f.store.file), originalStore);
    assert.equal(f.calls.filter(call => call.operation === 'close').length, 0);
  } finally { releaseCli(); await Promise.all(launches); }
});

test('reopening focuses one owned instance; same-profile CLI and registry removal remain locked', async t => {
  const f = await fixture(t), a = await openDesktopInstance(f.store, 'A', f.options);
  const again = await openDesktopInstance(f.store, 'A', f.options);
  assert.equal(again.status, 'focused'); assert.equal(again.main.pid, a.main.pid);
  assert.equal(f.calls.filter(call => call.operation === 'open').length, 1);
  await focusDesktopInstance(f.store, 'A', f.options);
  await assert.rejects(launchHome(f.store, 'A', { ramLogs: f.ramLogs, run: async () => { throw new Error('must not launch'); } }), /in use/);
  await assert.rejects(removeProfile(f.store, 'A', f.options), /unfinished desktop instance/);
  await assert.rejects(unbindNativeHome(f.store, 'A', f.options), /unfinished desktop instance/);
});

test('explicit desktop preparation refreshes a closed profile and refuses a running target without touching it', async t => {
  const f = await fixture(t);
  const profile = (await f.store.read()).profiles.find(item => item.name === 'A');
  f.calls.length = 0;
  const prepared = await prepareDesktopInstance(f.store, 'A', f.options);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.main, null);
  assert.equal(f.calls.filter(call => call.operation === 'prepare').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'open' || call.operation === 'focus').length, 0);
  assert.equal((await listDesktopInstances(f.store, { runtime: f.runtime })).instances.length, 0);

  const opened = await openDesktopInstance(f.store, 'A', f.options);
  const journalBefore = await readFile(statePath(f, profile.id));
  const rowsBefore = structuredClone(f.rows);
  f.calls.length = 0;
  await assert.rejects(prepareDesktopInstance(f.store, 'A', f.options), /running|open|close/i);
  assert.equal(f.calls.filter(call => call.operation === 'prepare' || call.operation === 'open' || call.operation === 'focus' || call.operation === 'close').length, 0);
  assert.deepEqual(await readFile(statePath(f, profile.id)), journalBefore);
  assert.deepEqual(f.rows, rowsBefore);
  assert.ok(f.rows.some(item => item.pid === opened.main.pid));
});

for (const code of ['PROFILE_APP_PREPARE_REQUIRED', 'PROFILE_APP_REFRESH_REQUIRED'])
test(`desktop open handles ${code} once, then reuses and focuses the running app`, async t => {
  const f = await fixture(t);
  f.calls.length = 0;
  const load = f.options.loadLauncher;
  let stale = true;
  f.options.loadLauncher = async (...args) => {
    if (stale) { stale = false; throw Object.assign(new Error(code), { code }); }
    return load(...args);
  };
  const first = await openDesktopInstance(f.store, 'A', f.options);
  assert.equal(first.status, 'opened');
  assert.equal(f.calls.filter(call => call.operation === 'prepare').length, 1);
  // A vendor update while this profile is live must not replace its bundle.
  f.options.loadLauncher = async () => { throw new Error('running open must not load or refresh the cache'); };
  f.options.prepareLauncher = async () => { throw new Error('running open must not prepare'); };
  const again = await openDesktopInstance(f.store, 'A', f.options);
  assert.equal(again.status, 'focused');
  assert.deepEqual(again.main, first.main);
  assert.equal(f.calls.filter(call => call.operation === 'open').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'close').length, 0);
});

test('automatic preparation preserves invalid caches and executing raw apps or Finder bootstraps', async t => {
  const f = await fixture(t), profile = (await f.store.read()).profiles.find(item => item.name === 'A');
  f.calls.length = 0;
  f.options.loadLauncher = async () => { throw new Error('cache integrity failed'); };
  await assert.rejects(openDesktopInstance(f.store, 'A', f.options), /cache integrity failed/);
  f.options.loadLauncher = async () => {
    throw Object.assign(new Error('stale cache'), { code: 'PROFILE_APP_REFRESH_REQUIRED' });
  };
  const plan = await desktopInstancePlan(f.store, 'A', f.options);
  const prepared = await f.options.prepareLauncher(f.store, plan);
  f.calls.length = 0;
  f.rows.push(row(500, prepared.bootstrapExecutable));
  await assert.rejects(openDesktopInstance(f.store, 'A', f.options), /still executing/);
  f.rows.pop();
  await assert.rejects(openDesktopInstance(f.store, 'A', { ...f.options,
    launcherEnvironment: { XFX_DESKTOP_LAUNCHER_PID: '500', XFX_DESKTOP_LAUNCHER_EXECUTABLE: prepared.bootstrapExecutable } }), /from a terminal/);
  assert.equal(f.calls.filter(call => call.operation === 'prepare' || call.operation === 'open').length, 0);
  assert.equal(JSON.parse(await readFile(statePath(f, profile.id))).phase, 'closed');
});

test('open reconciles stopped opening and running journals without manual recovery', async t => {
  const f = await fixture(t);
  for (const phase of ['opening', 'running']) {
    const first = await openDesktopInstance(f.store, 'A', f.options);
    f.rows.splice(1);
    const path = statePath(f, first.profileId), state = JSON.parse(await readFile(path));
    state.phase = phase;
    if (phase === 'opening') { state.main = null; state.processes = []; }
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    // A stopped, validated journal may also survive a crash after lock release.
    await rm(lockPath(f, 'A'), { recursive: true });
    const again = await openDesktopInstance(f.store, 'A', f.options);
    assert.equal(again.status, 'opened');
    assert.notEqual(again.main.pid, first.main.pid);
  }
  assert.equal(f.calls.filter(call => call.operation === 'prepare').length, 4, 'initial fixture caches only');
  assert.equal(f.calls.filter(call => call.operation === 'close').length, 0);
  assert.deepEqual(f.rows.find(row => row.pid === f.original.pid), f.original);
});

test('open releases only a dead operation guard belonging to this store and profile', async t => {
  const f = await fixture(t), profile = (await f.store.read()).profiles.find(item => item.name === 'A');
  const guard = `${f.options.lockPath}.operation`;
  const owner = { kind: 'desktop-instance-operation', host: hostname(), pid: 900,
    runId: randomUUID(), storePath: f.store.directory, profileId: profile.id, journalPath: statePath(f, profile.id) };
  const writeOwner = async value => {
    await mkdir(guard, { mode: 0o700 });
    await writeFile(join(guard, 'owner.json'), JSON.stringify(value), { mode: 0o600 });
  };
  await writeOwner(owner);
  await assert.rejects(openDesktopInstance(f.store, 'A', { ...f.options, isAlive: () => true }), /Another desktop operation/);
  assert.deepEqual(JSON.parse(await readFile(join(guard, 'owner.json'))), owner);
  await rm(guard, { recursive: true });
  const foreign = { ...owner, profileId: randomUUID() };
  await writeOwner(foreign);
  await assert.rejects(openDesktopInstance(f.store, 'A', { ...f.options, isAlive: () => false }), /Another desktop operation/);
  assert.deepEqual(JSON.parse(await readFile(join(guard, 'owner.json'))), foreign);
  await rm(guard, { recursive: true });
  await writeOwner(owner);
  assert.equal((await openDesktopInstance(f.store, 'A', { ...f.options, isAlive: () => false })).status, 'opened');
  await assert.rejects(access(guard), { code: 'ENOENT' });
});

test('desktop preparation respects CLI reservations and unfinished journals without replacing either', async t => {
  const f = await fixture(t);
  const profile = (await f.store.read()).profiles.find(item => item.name === 'A');
  const journal = statePath(f, profile.id);
  const reservation = lockPath(f, 'A');
  const foreignOwner = { kind: 'cli-profile', runId: 'held-by-cli' };
  await mkdir(reservation, { mode: 0o700 });
  await writeFile(join(reservation, 'owner.json'), JSON.stringify(foreignOwner), { mode: 0o600 });
  f.calls.length = 0;
  await assert.rejects(prepareDesktopInstance(f.store, 'A', f.options), /in use|unfinished/i);
  assert.deepEqual(JSON.parse(await readFile(join(reservation, 'owner.json'))), foreignOwner);
  assert.equal(f.calls.filter(call => call.operation === 'prepare').length, 0);
  await rm(reservation, { recursive: true });

  const opened = await openDesktopInstance(f.store, 'A', f.options);
  const journalBefore = await readFile(journal);
  await rm(reservation, { recursive: true });
  f.calls.length = 0;
  await assert.rejects(prepareDesktopInstance(f.store, 'A', f.options), /running or unfinished/i);
  assert.deepEqual(await readFile(journal), journalBefore);
  assert.equal(f.calls.filter(call => call.operation === 'prepare').length, 0);
  assert.ok(f.rows.some(item => item.pid === opened.main.pid));
});

test('profile deletion and unbinding preserve an interrupted instance even without its run lock', async t => {
  const f = await fixture(t), opened = await openDesktopInstance(f.store, 'A', f.options);
  await rm(lockPath(f, 'A'), { recursive: true });
  const registry = await readFile(f.store.file), journal = await readFile(statePath(f, opened.profileId));
  await assert.rejects(removeProfile(f.store, 'A', f.options), /unfinished desktop instance/);
  await assert.rejects(unbindNativeHome(f.store, 'A', f.options), /unfinished desktop instance/);
  assert.deepEqual(await readFile(f.store.file), registry);
  assert.deepEqual(await readFile(statePath(f, opened.profileId)), journal);
  await f.runtime.close(opened.main);
  await recoverDesktopInstance(f.store, 'A', f.options);
  // Simulate interruption after saving closed state but before marker cleanup.
  const closed = JSON.parse(await readFile(statePath(f, opened.profileId)));
  await writeFile(join(f.options.lockPath + '.instances', closed.runId + '.json'), JSON.stringify(closed.owner), { mode: 0o600 });
  await removeProfile(f.store, 'A', f.options);
  await assertNoConcurrentDesktops({ lockPath: f.options.lockPath });
  assert.deepEqual((await listDesktopInstances(f.store)).instances, []);
});

test('a stopped prototype closing record recovers only its own reservation before a fresh app opens', async t => {
  const f = await fixture(t), opened = await openDesktopInstance(f.store, 'A', f.options);
  const journalPath = statePath(f, opened.profileId), state = JSON.parse(await readFile(journalPath));
  const legacyApp = join(f.store.directory, 'desktop-instances', 'apps', `${opened.profileId}.app`);
  const legacyMain = { ...opened.main, executable: state.plan.app.executable };
  const legacyLauncher = join(legacyApp, 'Contents', 'MacOS', 'XfxProfileLauncher');
  const legacyLauncherProcess = row(30, legacyLauncher);
  state.phase = 'running';
  state.launcherPaths = { launcherApp: legacyApp, launcherExecutable: legacyLauncher,
    helperExecutable: state.launcherPaths.helperExecutable, helperSha256: state.launcherPaths.helperSha256 };
  state.launcher = legacyLauncherProcess;
  state.main = legacyMain;
  state.processes = state.processes.map(process => process.pid === legacyMain.pid
    ? legacyMain : process);
  await writeFile(journalPath, JSON.stringify(state), { mode: 0o600 });
  const receiptPath = join(f.store.directory, 'desktop-instances', `${state.profileId}.${state.runId}.launch`);
  await writeFile(receiptPath, JSON.stringify({ schemaVersion: 1, kind: 'desktop-instance-launch',
    runId: state.runId, profileId: state.profileId, home: state.plan.home, desktopData: state.plan.desktopData,
    userHome: state.plan.userHome, temporary: state.plan.temporary,
    app: { appPath: state.plan.app.appPath, bundleId: state.plan.app.bundleId, executable: state.plan.app.executable },
    main: legacyMain }), { mode: 0o600 });
  const opensBefore = f.calls.filter(call => call.operation === 'open').length;

  await assert.rejects(openDesktopInstance(f.store, 'A', f.options), /Close or recover the previous desktop test/);
  assert.equal(f.calls.filter(call => call.operation === 'open').length, opensBefore);
  await access(lockPath(f, 'A'));

  state.phase = 'closing';
  state.launcher = null;
  await writeFile(journalPath, JSON.stringify(state), { mode: 0o600 });
  await f.runtime.close(legacyMain);
  const recovered = await recoverDesktopInstance(f.store, 'A', f.options);
  assert.equal(recovered.status, 'recovered');
  await assert.rejects(access(lockPath(f, 'A')), { code: 'ENOENT' });
  await assert.rejects(access(receiptPath), { code: 'ENOENT' });
  await assertNoConcurrentDesktops({ lockPath: f.options.lockPath });

  const fresh = await openDesktopInstance(f.store, 'A', f.options);
  assert.equal(fresh.status, 'opened');
  assert.equal(fresh.application.appPath, join(f.store.directory, 'desktop-instances', 'apps', fresh.profileId,
    `Codex · ${fresh.name}.app`));
  assert.equal(f.calls.filter(call => call.operation === 'open').length, opensBefore + 1);
});

test('an unreadable desktop journal prevents deleting or unbinding its profile', async t => {
  const f = await fixture(t), opened = await openDesktopInstance(f.store, 'A', f.options);
  await rm(lockPath(f, 'A'), { recursive: true });
  await writeFile(statePath(f, opened.profileId), '{interrupted', { mode: 0o600 });
  const registry = await readFile(f.store.file);
  await assert.rejects(removeProfile(f.store, 'A', f.options));
  await assert.rejects(unbindNativeHome(f.store, 'A', f.options));
  assert.deepEqual(await readFile(f.store.file), registry);
});

test('closing and recovering one desktop preserves its sibling and the long-running original', async t => {
  const f = await fixture(t), a = await openDesktopInstance(f.store, 'A', f.options), b = await openDesktopInstance(f.store, 'B', f.options);
  await closeDesktopInstance(f.store, 'A', f.options);
  await assert.rejects(access(lockPath(f, 'A')), { code: 'ENOENT' });
  await access(lockPath(f, 'B'));
  assert.ok(f.rows.some(row => row.pid === b.main.pid)); assert.ok(f.rows.some(row => row.pid === f.original.pid));
  assert.deepEqual(f.calls.filter(call => call.operation === 'close').map(call => call.main.pid), [a.main.pid]);
  await assert.rejects(recoverDesktopInstance(f.store, 'B', f.options), /still runs/);
  await f.runtime.close(b.main);
  await recoverDesktopInstance(f.store, 'B', f.options);
  await assert.rejects(access(lockPath(f, 'B')), { code: 'ENOENT' });
});

test('maintenance quit and client preparation cannot target the sole remaining concurrent desktop', async t => {
  const f = await fixture(t);
  await openDesktopInstance(f.store, 'A', f.options);
  f.rows.splice(f.rows.findIndex(row => row.pid === f.original.pid), 1);
  let nativeCalls = 0;
  const maintenance = createDesktopRuntime({ concurrentLockPath: f.options.lockPath,
    processSnapshot: async () => structuredClone(f.rows),
    execFile: async () => { nativeCalls++; throw new Error('native control forbidden'); } });
  await assert.rejects(maintenance.stop(), /Concurrent desktop instances are reserved/);
  await assert.rejects(maintenance.prepareClients({ includeDesktop: true }), /Concurrent desktop instances are reserved/);
  assert.equal(nativeCalls, 0);
  await closeDesktopInstance(f.store, 'A', f.options);
  await assertNoConcurrentDesktops({ lockPath: f.options.lockPath });
});

for (const operation of ['installation', 'log cleanup']) test(`${operation} excludes a concurrent launch throughout client preparation`, async t => {
  const f = await fixture(t);
  let prepared = false;
  const runtime = { assertExternal: async () => {}, assertIdle: async () => {},
    prepareClients: async () => {
      await assert.rejects(openDesktopInstance(f.store, 'A', f.options), /Another desktop operation/);
      assert.equal(f.calls.filter(call => call.operation === 'open').length, 0);
      prepared = true;
    } };
  if (operation === 'installation') await installationCommand(f.store, 'install', {
    runtime, lockPath: f.options.lockPath, userHome: f.options.defaultUserHome, nodeCheck: async () => {},
    installation: () => ({ install: async () => ({ installed: true }) }),
  });
  else await restoreHomeLogs(f.homes.A.home, 'fixture', {
    runtime, lockPath: f.options.lockPath, logs: { restoreHome: async () => ({ restored: true }) },
  });
  assert.equal(prepared, true);
  assert.equal((await openDesktopInstance(f.store, 'A', f.options)).status, 'opened');
});

test('a launch receipt collision preserves ownership and a retry uses a fresh receipt', async t => {
  const f = await fixture(t), open = f.runtime.open;
  let collisionPath, launchedMain;
  f.runtime.open = async (...args) => {
    const id = (await f.store.read()).profiles.find(profile => profile.name === 'A').id;
    const state = JSON.parse(await readFile(statePath(f, id)));
    collisionPath = join(f.store.directory, 'desktop-instances', `${state.profileId}.${state.runId}.launch`);
    await writeFile(collisionPath, '{"fixture":"preexisting receipt"}\\n', { flag: 'wx', mode: 0o600 });
    const opened = await open(...args);
    launchedMain = opened.main;
    return opened;
  };
  await assert.rejects(openDesktopInstance(f.store, 'A', f.options), /reservation preserved/);
  await access(lockPath(f, 'A'));
  const id = (await f.store.read()).profiles.find(profile => profile.name === 'A').id;
  const interrupted = JSON.parse(await readFile(statePath(f, id)));
  assert.equal(interrupted.phase, 'opening'); assert.equal(interrupted.main, null);
  await assert.rejects(recoverDesktopInstance(f.store, 'A', f.options), /ownership is uncertain/);
  await access(lockPath(f, 'A'));
  assert.equal(await readFile(collisionPath, 'utf8'), '{"fixture":"preexisting receipt"}\\n');
  await f.runtime.close(launchedMain);
  f.runtime.open = open;
  await recoverDesktopInstance(f.store, 'A', f.options);
  assert.equal(await readFile(collisionPath, 'utf8'), '{"fixture":"preexisting receipt"}\\n');
  const retry = await openDesktopInstance(f.store, 'A', f.options);
  assert.notEqual(retry.main.pid, launchedMain.pid); assert.equal(retry.status, 'opened');
  assert.equal(f.calls.filter(call => call.operation === 'open').length, 2);
  assert.equal(await readFile(collisionPath, 'utf8'), '{"fixture":"preexisting receipt"}\\n');
});

test('ambiguous launch and orphan writers preserve the reservation until stopped and idle', async t => {
  const f = await fixture(t);
  f.runtime.open = async (plan, { application }) => {
    f.rows.push(row(200, application.executable), row(201, '/fixture/codex-app-server', 200));
    throw new Error('ambiguous');
  };
  await assert.rejects(openDesktopInstance(f.store, 'A', f.options), /reservation preserved/);
  await assert.rejects(recoverDesktopInstance(f.store, 'A', f.options), /ownership is uncertain/);
  f.rows.splice(1);
  f.runtime.assertResourcesIdle = async () => { throw new Error('unmanaged writer'); };
  await assert.rejects(recoverDesktopInstance(f.store, 'A', f.options), /unmanaged writer/);
  await access(lockPath(f, 'A'));
  f.runtime.assertResourcesIdle = async () => ({ idle: true });
  await recoverDesktopInstance(f.store, 'A', f.options);
  await assert.rejects(access(lockPath(f, 'A')), { code: 'ENOENT' });
});

test('recovery refuses orphaned recorded helpers and corrupted helper bindings without invoking control', async t => {
  const f = await fixture(t), a = await openDesktopInstance(f.store, 'A', f.options);
  f.rows.splice(f.rows.findIndex(row => row.pid === a.main.pid), 1);
  await assert.rejects(recoverDesktopInstance(f.store, 'A', f.options), /still runs/);
  await access(lockPath(f, 'A'));
  const state = JSON.parse(await readFile(statePath(f, a.profileId)));
  state.launcherPaths.helperExecutable = '/unrelated/executable';
  await writeFile(statePath(f, a.profileId), JSON.stringify(state), { mode: 0o600 });
  await assert.rejects(closeDesktopInstance(f.store, 'A', f.options), /Invalid profile launcher binding/);
  assert.equal(f.calls.filter(call => call.operation === 'close').length, 0);
});

test('changed journal identity or routing cannot authorize control of another desktop', async t => {
  const f = await fixture(t), a = await openDesktopInstance(f.store, 'A', f.options);
  const path = statePath(f, a.profileId), saved = JSON.parse(await readFile(path));
  const saveChanged = async change => {
    const state = structuredClone(saved); change(state);
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  };
  await saveChanged(state => { state.main = f.original; });
  await assert.rejects(closeDesktopInstance(f.store, 'A', f.options), /Invalid desktop instance record|preexisting process/);
  const unrelated = row(500); f.rows.push(unrelated);
  await saveChanged(state => { state.main = unrelated; state.processes = [unrelated]; });
  await assert.rejects(closeDesktopInstance(f.store, 'A', f.options), /Invalid desktop instance record|receipt is missing or changed/);
  await assert.rejects(focusDesktopInstance(f.store, 'A', f.options), /Invalid desktop instance record|receipt is missing or changed/);
  await saveChanged(state => { state.plan.userHome = f.options.defaultUserHome; });
  await assert.rejects(openDesktopInstance(f.store, 'A', f.options), /Invalid desktop instance record/);
  await saveChanged(state => { state.plan.app.bundleId = 'unrelated.app'; });
  await assert.rejects(closeDesktopInstance(f.store, 'A', f.options), /Invalid desktop instance record/);
  assert.equal(f.calls.filter(call => ['close', 'focus'].includes(call.operation)).length, 0);
  assert.ok(f.rows.some(row => row.pid === f.original.pid));
  await access(lockPath(f, 'A'));
});

test('resource/preparation failure before launch releases only its own reservation', async t => {
  const f = await fixture(t);
  f.runtime.assertResourcesIdle = async () => { throw new Error('busy'); };
  await assert.rejects(openDesktopInstance(f.store, 'A', f.options), /busy/);
  await assert.rejects(access(lockPath(f, 'A')), { code: 'ENOENT' });
  assert.equal(f.calls.filter(call => call.operation === 'open').length, 0);
  const foreign = { kind: 'foreign' }; await mkdir(lockPath(f, 'A'), { mode: 0o700 });
  await writeFile(join(lockPath(f, 'A'), 'owner.json'), JSON.stringify(foreign), { mode: 0o600 });
  await assert.rejects(openDesktopInstance(f.store, 'A', f.options), /locked/);
  assert.deepEqual(JSON.parse(await readFile(join(lockPath(f, 'A'), 'owner.json'))), foreign);
});

test('planning and public CLI dry-run/list are read-only; new controls reject blanket shutdown flags', async t => {
  const f = await fixture(t);
  const before = await readdir(join(f.store.directory, 'desktop-instances'));
  const plan = await desktopInstancePlan(f.store, 'A', f.options);
  assert.equal(plan.home, f.homes.A.home); assert.equal(plan.userHome, join(f.homes.A.root, 'user-home'));
  assert.deepEqual(await readdir(join(f.store.directory, 'desktop-instances')), before);
  const run = args => promisify(execFile)(process.execPath, ['--loader', loader, cli, '--store', f.store.directory, '--json', ...args]);
  const dryRun = JSON.parse((await run(['desktop', 'open', 'A', '--dry-run'])).stdout);
  assert.equal(dryRun.profileId, plan.profileId); assert.equal(dryRun.liveHomeChanged, false);
  assert.deepEqual(JSON.parse((await run(['desktop', 'list', '--observe'])).stdout).instances, []);
  for (const args of [['desktop', 'close', 'A', '--close-clients'], ['desktop', 'recover', 'A', '--close-clients']])
    await assert.rejects(run(args), /not supported/);
  assert.deepEqual(await readdir(join(f.store.directory, 'desktop-instances')), before);
});
