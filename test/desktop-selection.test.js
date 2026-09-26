import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Store, create } from '../src/profiles.js';
import { removeProfile, unbindNativeHome } from '../src/profile-removal.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { currentDesktop, recoverSelection, restoreDesktop, selectionPlan, switchDesktop } from '../src/desktop-selection.js';
import { DESKTOP_APP } from '../src/desktop-runtime.js';
import { preparePairedActivation, pairedStatus, planActivationTarget, registerActivationTarget } from '../src/desktop-paired.js';

async function registeredRoot(root) {
  const directory = join(root, 'registered');
  await mkdir(directory, { mode: 0o700 });
  for (const name of ['codex-home', 'workspace', 'user-home', 'tmp', 'desktop-data']) await mkdir(join(directory, name), { mode: 0o700 });
  await writeFile(join(directory, 'codex-home', 'config.toml'), 'cli_auth_credentials_store = "file"\nallow_symlinked_codex_home = true\n', { mode: 0o600 });
  return directory;
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-selection-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'alpha'); create(data, 'bravo'); create(data, 'charlie'); });
  const alphaHome = await prepareNativeHome({ directory: join(root, 'alpha'), executable, codexVersion: '0.153.4' });
  const bravoHome = await prepareNativeHome({ directory: join(root, 'bravo'), executable, codexVersion: '0.153.4' });
  await registerHome(store, 'alpha', alphaHome.root, { executable, version: '0.153.4' });
  await registerHome(store, 'bravo', bravoHome.root, { executable, version: '0.153.4' });
  const thirdRoot = await registeredRoot(root);
  await registerHome(store, 'charlie', thirdRoot, { executable, version: '0.153.4' });
  const defaultUserHome = join(root, 'default-home'), defaultCodex = join(defaultUserHome, '.codex');
  const defaultData = join(defaultUserHome, 'Library', 'Application Support', 'Codex');
  await mkdir(defaultCodex, { recursive: true, mode: 0o755 });
  await mkdir(defaultData, { recursive: true, mode: 0o755 });
  await writeFile(join(defaultCodex, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  const calls = []; let app = { appPath: '/fixture/Codex.app', bundleId: 'com.fixture.codex', executable: '/fixture/Codex.app/Contents/MacOS/Codex', version: 'fixture' };
  let running = 'default';
  const runtime = {
    inspectApp: async () => app,
    assertExternal: async () => { calls.push('external'); },
    assertIdle: async () => { calls.push('idle'); },
    seedTracked: processes => calls.push(`seed:${processes.length}`),
    snapshot: async () => [{ pid: 17, label: running }],
    stop: async () => { calls.push(`stop:${running}`); running = null; },
    open: async plan => { assert.equal(running, null); running = plan.name; calls.push(`open:${plan.name}`); return [{ pid: 18, label: plan.name }]; },
    restore: async () => { assert.equal(running, null); running = 'default'; calls.push('restore'); return [{ pid: 19, label: 'default' }]; },
  };
  return { root, homes: { alpha: alphaHome, bravo: bravoHome }, store, runtime, calls, defaultUserHome, get app() { return app; }, setApp(value) { app = value; }, get running() { return running; }, lockPath: join(root, 'desktop.lock') };
}

const options = f => ({ runtime: f.runtime, lockPath: f.lockPath, isAlive: () => false, defaultUserHome: f.defaultUserHome });
const homeLock = plan => join(plan.nativeRoot, '.run-lock');
const ownerPath = path => join(path, 'owner.json');
const selectionJournal = store => join(store.directory, 'desktop-selection', 'session.json');
const appPin = version => ({ appPath: '/fixture/Codex.app', bundleId: 'com.fixture.codex', executable: '/fixture/Codex.app/Contents/MacOS/Codex', version, build: version, asarSha256: `${version}-sha` });

test('profile removal preserves selected and inactive paired targets and restoration remains available', async t => {
  const f = await fixture(t), plan = await preparePairedActivation(f.store, ['alpha', 'bravo'],
    { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', { ...options(f), requestedActivationPlan: plan });
  const manifestPath = join(f.store.directory, 'activation', 'manifest.json');
  const sessionPath = selectionJournal(f.store);
  const beforeStore = await readFile(f.store.file, 'utf8');
  const beforeManifest = await readFile(manifestPath, 'utf8');
  const beforeSession = await readFile(sessionPath, 'utf8');
  for (const name of ['alpha', 'bravo']) {
    await assert.rejects(removeProfile(f.store, name, { ...options(f), defaultUserHome: f.defaultUserHome }), /activation target/);
    await assert.rejects(unbindNativeHome(f.store, name, { ...options(f), defaultUserHome: f.defaultUserHome }), /activation target/);
  }
  assert.equal(await readFile(f.store.file, 'utf8'), beforeStore);
  assert.equal(await readFile(manifestPath, 'utf8'), beforeManifest);
  assert.equal(await readFile(sessionPath, 'utf8'), beforeSession);
  await removeProfile(f.store, 'charlie', { ...options(f), defaultUserHome: f.defaultUserHome });
  assert.equal((await f.store.read()).profiles.length, 2);
  await restoreDesktop(f.store, options(f));
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
  const altered = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bravoId = (await f.store.read()).profiles.find(p => p.name === 'bravo').id;
  altered.profiles = altered.profiles.filter(profile => profile.profileId !== bravoId);
  const { approvalId, ...body } = altered;
  altered.approvalId = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  await writeFile(manifestPath, JSON.stringify(altered), { mode: 0o600 });
  const afterRestore = await readFile(f.store.file, 'utf8');
  for (const operation of [
    () => removeProfile(f.store, 'bravo', { ...options(f), defaultUserHome: f.defaultUserHome }),
    () => unbindNativeHome(f.store, 'bravo', { ...options(f), defaultUserHome: f.defaultUserHome }),
  ]) await assert.rejects(operation());
  assert.equal(await readFile(f.store.file, 'utf8'), afterRestore);
});

async function seedPreparedReservation(f, plan) {
  const owner = { kind: 'desktop-selection', host: hostname(), pid: process.pid, runId: randomUUID(),
    storePath: f.store.directory, journalPath: selectionJournal(f.store) };
  const session = { schemaVersion: 1, kind: 'desktop-selection-session', id: owner.runId, owner,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: 'prepared', active: null, target: plan,
    reservedRoots: [plan.nativeRoot], reservedBindings: [plan.native], trackedProcesses: [], liveHomeChanged: false };
  await mkdir(join(f.store.directory, 'desktop-selection'), { mode: 0o700 });
  await writeFile(selectionJournal(f.store), JSON.stringify(session), { mode: 0o600 });
  for (const path of [f.lockPath, homeLock(plan)]) {
    await mkdir(path, { mode: 0o700 });
    await writeFile(ownerPath(path), JSON.stringify(owner), { mode: 0o600 });
  }
  return session;
}

const observedMain = (f, overrides = {}) => ({ pid: 701, ppid: 1, uid: process.getuid(),
  startedAt: 'Mon Sep 15 10:00:00 2026', executable: f.app.executable, ...overrides });
async function setRecordedProcesses(f, key, processes) {
  const journal = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
  journal[key] = processes;
  await writeFile(selectionJournal(f.store), JSON.stringify(journal), { mode: 0o600 });
}

test('plans three independently named homes read-only and preserves selection metadata', async t => {
  const f = await fixture(t);
  const before = await f.store.read();
  const plans = await Promise.all(['alpha', 'bravo', 'charlie'].map(name => selectionPlan(f.store, name, { runtime: f.runtime })));
  assert.deepEqual(plans.map(plan => plan.name), ['alpha', 'bravo', 'charlie']);
  assert.equal(new Set(plans.map(plan => plan.home)).size, 3);
  assert.ok(plans.every(plan => plan.leavesDesktopRunning && !plan.liveHomeChanged));
  assert.deepEqual(await f.store.read(), before);
  for (const plan of plans) assert.equal((await lstat(plan.desktopData)).isDirectory(), true);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await currentDesktop(f.store), { status: 'unmanaged', activeProfile: null });
});

test('a registered third target uses its stable activation key through desktop selection and restoration', async t => {
  const f = await fixture(t);
  const initial = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', { ...options(f), requestedActivationPlan: initial });
  await restoreDesktop(f.store, options(f));
  const proposal = await planActivationTarget(f.store, 'charlie', { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await registerActivationTarget(f.store, proposal, { defaultUserHome: f.defaultUserHome, lockPath: f.lockPath });
  await switchDesktop(f.store, 'charlie', options(f));
  const expected = proposal.profiles.at(-1).activationTarget;
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, expected);
  assert.equal((await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome })).activeProfile.name, 'charlie');
  await restoreDesktop(f.store, options(f));
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
});

test('desktop current observes only on request and identifies an unchanged active main without lifecycle work', async t => {
  const f = await fixture(t), main = observedMain(f);
  await switchDesktop(f.store, 'alpha', options(f));
  await setRecordedProcesses(f, 'trackedProcesses', [main]);
  const before = await readFile(selectionJournal(f.store), 'utf8'); const callsBefore = f.calls.length; let snapshots = 0;
  f.runtime.snapshot = async () => { snapshots += 1; return [main]; };
  f.runtime.assertExternal = async () => { throw new Error('must not control desktop'); };
  f.runtime.stop = async () => { throw new Error('must not stop desktop'); };
  assert.equal((await currentDesktop(f.store)).observedDesktop, undefined);
  assert.equal(snapshots, 0);
  const current = await currentDesktop(f.store, { observe: true, runtime: f.runtime });
  assert.equal(current.observedDesktop.status, 'matching-active-profile');
  assert.equal(current.observedDesktop.profileId, current.activeProfile.id);
  assert.deepEqual(current.observedDesktop.main, { pid: main.pid, uid: main.uid, startedAt: main.startedAt, executable: main.executable });
  assert.equal(snapshots, 1); assert.equal(await readFile(selectionJournal(f.store), 'utf8'), before);
  assert.deepEqual(f.calls.slice(callsBefore), []);
});

test('desktop current observation distinguishes quit, replacement, PID reuse, and multiple main processes', async t => {
  const f = await fixture(t), main = observedMain(f);
  await switchDesktop(f.store, 'alpha', options(f));
  await setRecordedProcesses(f, 'trackedProcesses', [main]);
  f.runtime.snapshot = async () => [];
  assert.equal((await currentDesktop(f.store, { observe: true, runtime: f.runtime })).observedDesktop.status, 'none');
  f.runtime.snapshot = async () => [{ ...main, pid: 702 }];
  let observation = (await currentDesktop(f.store, { observe: true, runtime: f.runtime })).observedDesktop;
  assert.equal(observation.status, 'different-main'); assert.equal(observation.home, 'unknown');
  f.runtime.snapshot = async () => [{ ...main, startedAt: 'Mon Sep 15 11:00:00 2026' }];
  observation = (await currentDesktop(f.store, { observe: true, runtime: f.runtime })).observedDesktop;
  assert.equal(observation.status, 'different-main'); // PID alone cannot identify a profile desktop.
  f.runtime.snapshot = async () => [main, { ...main, pid: 703, startedAt: 'Mon Sep 15 12:00:00 2026' }];
  observation = (await currentDesktop(f.store, { observe: true, runtime: f.runtime })).observedDesktop;
  assert.equal(observation.status, 'multiple'); assert.equal(observation.mains.length, 2);
  f.runtime.snapshot = async () => [main, { ...main, pid: 704, uid: main.uid + 1, startedAt: 'Mon Sep 15 13:00:00 2026' }];
  observation = (await currentDesktop(f.store, { observe: true, runtime: f.runtime })).observedDesktop;
  assert.equal(observation.status, 'matching-active-profile');
  assert.deepEqual(observation.main, { pid: main.pid, uid: main.uid, startedAt: main.startedAt, executable: main.executable });
  f.runtime.snapshot = async () => [{ ...main, startedAt: undefined }];
  observation = (await currentDesktop(f.store, { observe: true, runtime: f.runtime })).observedDesktop;
  assert.deepEqual(observation, { status: 'unavailable', error: { code: 'PROCESS_INSPECTION_UNAVAILABLE', message: 'Unable to inspect Codex desktop processes' } });
});

test('desktop current recognizes a recorded default desktop, leaves an unjournaled desktop unknown, and sanitizes inspection errors', async t => {
  const f = await fixture(t), defaultProfile = observedMain(f, { pid: 704, executable: DESKTOP_APP.executable });
  await switchDesktop(f.store, 'alpha', options(f)); await restoreDesktop(f.store, options(f));
  await setRecordedProcesses(f, 'restoredProcesses', [{ ...defaultProfile, pid: 705, executable: '/fixture/Codex.app/Contents/Frameworks/helper' }, defaultProfile]);
  f.runtime.snapshot = async () => [defaultProfile];
  assert.equal((await currentDesktop(f.store, { observe: true, runtime: f.runtime })).observedDesktop.status, 'matching-default-desktop');
  const fresh = await fixture(t), unjournaled = { ...defaultProfile, executable: DESKTOP_APP.executable };
  fresh.runtime.snapshot = async () => [unjournaled];
  assert.equal((await currentDesktop(fresh.store, { observe: true, runtime: fresh.runtime })).observedDesktop.status, 'unmanaged-unknown');
  f.runtime.snapshot = async () => { throw Object.assign(new Error('token=private-value'), { code: 'PROCESS_INSPECTION_FAILED' }); };
  const unavailable = (await currentDesktop(f.store, { observe: true, runtime: f.runtime })).observedDesktop;
  assert.deepEqual(unavailable, { status: 'unavailable', error: { code: 'PROCESS_INSPECTION_FAILED', message: 'Unable to inspect Codex desktop processes' } });
});

test('one-shot switches leave a named desktop alive with durable global and home reservations', async t => {
  const f = await fixture(t), plan = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  const result = await switchDesktop(f.store, 'alpha', options(f));
  assert.equal(result.status, 'active'); assert.equal(result.desktopLeftRunning, true); assert.equal(f.running, 'alpha');
  assert.ok(await lstat(f.lockPath)); assert.ok(await lstat(homeLock(plan)));
  const status = await currentDesktop(f.store);
  assert.equal(status.status, 'active'); assert.deepEqual(status.activeProfile, { id: plan.profileId, name: 'alpha', home: plan.home, desktopData: plan.desktopData });
  await assert.rejects(access(`${f.lockPath}.selection`), { code: 'ENOENT' });
});

test('selection prepares RAM logs before quitting and the selected native home only after the desktop stops', async t => {
  const f = await fixture(t), plan = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  f.runtime.ensureLogStorage = async () => { f.calls.push('logs:storage'); };
  f.runtime.ensureHomeLogs = async ({ home, key }) => { f.calls.push(`logs:${key}:${home}`); };
  await switchDesktop(f.store, 'alpha', options(f));
  const storage = f.calls.indexOf('logs:storage');
  const stop = f.calls.indexOf('stop:default');
  const home = f.calls.indexOf(`logs:${plan.environmentId}:${plan.home}`);
  const open = f.calls.indexOf('open:alpha');
  assert.ok(storage >= 0 && storage < stop);
  assert.ok(home > stop && home < open);
});

test('a RAM storage preparation failure leaves the desktop and selection reservations untouched', async t => {
  const f = await fixture(t);
  f.runtime.ensureLogStorage = async () => { f.calls.push('logs:storage'); throw new Error('RAM logs unavailable'); };
  await assert.rejects(switchDesktop(f.store, 'alpha', options(f)), /RAM logs unavailable/);
  assert.equal(f.running, 'default');
  assert.ok(f.calls.includes('logs:storage'));
  assert.ok(!f.calls.some(call => call.startsWith('stop:') || call.startsWith('open:') || call === 'restore'));
  await assert.rejects(access(f.lockPath), { code: 'ENOENT' });
  assert.equal((await currentDesktop(f.store)).status, 'restored');
});

test('repeated named switches release inactive homes and survive a new controller invocation', async t => {
  const f = await fixture(t);
  const [alpha, bravo, charlie] = await Promise.all(['alpha', 'bravo', 'charlie'].map(name => selectionPlan(f.store, name, { runtime: f.runtime })));
  await switchDesktop(f.store, 'alpha', options(f));
  await switchDesktop(f.store, 'bravo', options(f));
  await switchDesktop(f.store, 'charlie', options(f));
  assert.equal((await currentDesktop(f.store)).activeProfile.name, 'charlie');
  for (const path of [homeLock(alpha), homeLock(bravo)]) await assert.rejects(access(path), { code: 'ENOENT' });
  assert.ok(await lstat(homeLock(charlie)));
  assert.deepEqual(f.calls.filter(call => call.startsWith('open:')), ['open:alpha', 'open:bravo', 'open:charlie']);
});

test('restore stops the named desktop, restores default launch, and clears every reservation', async t => {
  const f = await fixture(t), plan = await selectionPlan(f.store, 'charlie', { runtime: f.runtime });
  await switchDesktop(f.store, 'charlie', options(f));
  const result = await restoreDesktop(f.store, options(f));
  assert.equal(result.status, 'restored'); assert.equal(f.running, 'default');
  assert.equal((await currentDesktop(f.store)).status, 'restored');
  for (const path of [f.lockPath, homeLock(plan)]) await assert.rejects(access(path), { code: 'ENOENT' });
  assert.ok(f.calls.includes('restore'));
});

test('switch and restore rebuild a cleared temporary reservation from the persistent home lock', async t => {
  for (const operation of ['switch', 'restore']) await t.test(operation, async t => {
    const f = await fixture(t), plan = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
    await switchDesktop(f.store, 'alpha', options(f));
    const owner = JSON.parse(await readFile(ownerPath(f.lockPath), 'utf8'));
    await rm(f.lockPath, { recursive: true });
    const stop = f.runtime.stop;
    f.runtime.stop = async () => {
      assert.deepEqual(JSON.parse(await readFile(ownerPath(f.lockPath), 'utf8')), owner);
      assert.deepEqual(JSON.parse(await readFile(ownerPath(homeLock(plan)), 'utf8')), owner);
      await stop();
    };
    if (operation === 'switch') {
      const result = await switchDesktop(f.store, 'bravo', options(f));
      assert.equal(result.status, 'active');
      assert.equal(f.running, 'bravo');
    } else {
      const result = await restoreDesktop(f.store, options(f));
      assert.equal(result.status, 'restored');
      assert.equal(f.running, 'default');
      for (const path of [f.lockPath, homeLock(plan)]) await assert.rejects(access(path), { code: 'ENOENT' });
    }
  });
});

test('a missing temporary reservation never permits missing, ownerless or foreign home locks', async t => {
  for (const change of ['missing', 'ownerless', 'foreign', 'changed-plan']) await t.test(change, async t => {
    const f = await fixture(t), plan = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
    await switchDesktop(f.store, 'alpha', options(f));
    await rm(f.lockPath, { recursive: true });
    if (change === 'missing') await rm(homeLock(plan), { recursive: true });
    else if (change === 'ownerless') await rm(ownerPath(homeLock(plan)));
    else if (change === 'foreign') await writeFile(ownerPath(homeLock(plan)), JSON.stringify({ kind: 'foreign' }));
    else f.setApp({ ...f.app, appPath: '/fixture/Other.app' });
    const journal = await readFile(selectionJournal(f.store), 'utf8');
    f.calls.length = 0;
    await assert.rejects(restoreDesktop(f.store, options(f)), /ownership changed|no owner record|paths or app changed/);
    await assert.rejects(access(f.lockPath), { code: 'ENOENT' });
    assert.equal(await readFile(selectionJournal(f.store), 'utf8'), journal);
    assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore' || call.startsWith('open:')));
  });
});

test('rebuilding a reservation preserves a competing global owner acquired during validation', async t => {
  const f = await fixture(t);
  await switchDesktop(f.store, 'alpha', options(f));
  await rm(f.lockPath, { recursive: true });
  const inspect = f.runtime.inspectApp;
  f.runtime.inspectApp = async () => {
    await mkdir(f.lockPath, { mode: 0o700 });
    await writeFile(ownerPath(f.lockPath), JSON.stringify({ kind: 'foreign' }), { mode: 0o600 });
    return inspect();
  };
  f.calls.length = 0;
  await assert.rejects(restoreDesktop(f.store, options(f)), /locked/);
  assert.deepEqual(JSON.parse(await readFile(ownerPath(f.lockPath), 'utf8')), { kind: 'foreign' });
  assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore'));
});

test('recovery after a lost global reservation checks both interrupted-switch home locks', async t => {
  for (const state of ['matching', 'foreign-target', 'live-controller']) await t.test(state, async t => {
    const f = await fixture(t), target = await selectionPlan(f.store, 'charlie', { runtime: f.runtime });
    await switchDesktop(f.store, 'alpha', options(f));
    const session = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
    Object.assign(session, { phase: 'opening', target, reservedRoots: [...session.reservedRoots, target.nativeRoot],
      reservedBindings: [...session.reservedBindings, target.native] });
    await writeFile(selectionJournal(f.store), JSON.stringify(session), { mode: 0o600 });
    await mkdir(homeLock(target), { mode: 0o700 });
    await writeFile(ownerPath(homeLock(target)), JSON.stringify(state === 'foreign-target' ? { kind: 'foreign' } : session.owner), { mode: 0o600 });
    await rm(f.lockPath, { recursive: true });
    f.calls.length = 0;
    await assert.rejects(restoreDesktop(f.store, options(f)), /needs desktop recover/);
    if (state === 'matching') {
      assert.equal((await recoverSelection(f.store, options(f))).status, 'restored');
      assert.equal(f.running, 'default');
      for (const path of [f.lockPath, ...session.reservedRoots.map(root => join(root, '.run-lock'))])
        await assert.rejects(access(path), { code: 'ENOENT' });
    } else {
      await assert.rejects(recoverSelection(f.store, { ...options(f), isAlive: () => state === 'live-controller' }), /ownership changed|controller is still running/);
      await assert.rejects(access(f.lockPath), { code: 'ENOENT' });
      assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore'));
    }
  });
});

test('ordinary restore accepts an installed app metadata update at the reviewed location', async t => {
  const f = await fixture(t);
  await switchDesktop(f.store, 'alpha', options(f));
  f.setApp({ ...f.app, version: 'changed' });
  const restored = await restoreDesktop(f.store, options(f));
  assert.equal(restored.status, 'restored');
  assert.equal(f.running, 'default');
});

test('ordinary restore rejects a changed desktop app location', async t => {
  const f = await fixture(t);
  await switchDesktop(f.store, 'alpha', options(f));
  f.setApp({ ...f.app, appPath: '/fixture/Other.app', executable: '/fixture/Other.app/Contents/MacOS/Codex' });
  await assert.rejects(restoreDesktop(f.store, options(f)), /Desktop profile paths or app changed/);
  assert.equal(f.running, 'alpha');
});

test('reviewed app transition restores through the current pin while retaining the old active plan', async t => {
  const f = await fixture(t), oldApp = appPin('old'), newApp = appPin('new');
  f.setApp(oldApp); await switchDesktop(f.store, 'alpha', options(f));
  f.setApp(newApp);
  const before = f.calls.length;
  await restoreDesktop(f.store, { ...options(f), reviewedAppTransition: { from: oldApp, to: newApp } });
  const session = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
  const oldSessionId = session.id;
  assert.equal(session.phase, 'restored'); assert.deepEqual(session.appPinTransition.from, oldApp);
  assert.deepEqual(session.appPinTransition.to, newApp);
  assert.deepEqual(session.appPinTransition.activePlan.app, oldApp);
  assert.equal(session.active, null); assert.ok(f.calls.includes('restore'));
  assert.ok(!f.calls.slice(before).includes('open:alpha'));
  const evidencePath = join(f.store.directory, 'desktop-selection', `app-pin-transition-${oldSessionId}.json`);
  assert.deepEqual(JSON.parse(await readFile(evidencePath, 'utf8')).activePlan.app, oldApp);
  const beforeRetry = f.calls.length;
  const retry = await restoreDesktop(f.store, { ...options(f), reviewedAppTransition: { from: oldApp, to: newApp } });
  assert.equal(retry.desktopChanged, false);
  assert.ok(!f.calls.slice(beforeRetry).some(call => call.startsWith('stop:') || call === 'restore'));
  const next = await switchDesktop(f.store, 'bravo', options(f));
  assert.equal(next.status, 'active');
  const fresh = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
  assert.notEqual(fresh.id, oldSessionId); assert.equal(fresh.appPinTransition, undefined);
});

test('reviewed transition recovery never reopens the historical selection after a failed quit', async t => {
  const f = await fixture(t), oldApp = appPin('old'), newApp = appPin('new'), stop = f.runtime.stop;
  f.setApp(oldApp); await switchDesktop(f.store, 'alpha', options(f)); f.setApp(newApp);
  const before = f.calls.length;
  let first = true;
  f.runtime.stop = async () => {
    if (first) { first = false; f.calls.push('quit-failed'); throw Object.assign(new Error('confirmation pending'), { code: 'DESKTOP_QUIT_TIMEOUT' }); }
    return stop();
  };
  await assert.rejects(restoreDesktop(f.store, { ...options(f), reviewedAppTransition: { from: oldApp, to: newApp } }), /recovery is required/);
  let session = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
  assert.equal(session.phase, 'incomplete'); assert.deepEqual(session.appPinTransition.activePlan.app, oldApp);
  await recoverSelection(f.store, options(f));
  session = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
  assert.equal(session.phase, 'restored'); assert.deepEqual(session.appPinTransition.from, oldApp);
  assert.ok(!f.calls.slice(before).includes('open:alpha')); assert.equal(f.running, 'default');
});

test('reviewed transition retries adopt matching historical evidence and recovery recreates a missing copy', async t => {
  for (const existingCopy of [true, false]) await t.test(existingCopy ? 'orphaned copy' : 'journal only', async t => {
    const f = await fixture(t), oldApp = appPin('old'), newApp = appPin('new');
    f.setApp(oldApp); await switchDesktop(f.store, 'alpha', options(f)); f.setApp(newApp);
    const session = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
    const transition = { from: oldApp, to: newApp, activePlan: session.active, reviewedAt: '2026-09-16T00:00:00.000Z' };
    const evidencePath = join(f.store.directory, 'desktop-selection', `app-pin-transition-${session.id}.json`);
    if (existingCopy) await writeFile(evidencePath, JSON.stringify(transition), { mode: 0o600 });
    else {
      session.appPinTransition = transition;
      await writeFile(selectionJournal(f.store), JSON.stringify(session), { mode: 0o600 });
    }
    const before = f.calls.length;
    if (existingCopy) await restoreDesktop(f.store, { ...options(f), reviewedAppTransition: { from: oldApp, to: newApp } });
    else await recoverSelection(f.store, options(f));
    assert.equal((await currentDesktop(f.store)).status, 'restored');
    assert.deepEqual(JSON.parse(await readFile(evidencePath, 'utf8')), transition);
    assert.ok(!f.calls.slice(before).includes('open:alpha'));
  });
});

test('cancelled reviewed restoration retains the untouched historical selection', async t => {
  const f = await fixture(t), oldApp = appPin('old'), newApp = appPin('new');
  f.setApp(oldApp); await switchDesktop(f.store, 'alpha', options(f)); f.setApp(newApp);
  const controller = new AbortController(), snapshot = f.runtime.seedTracked;
  f.runtime.seedTracked = processes => { snapshot(processes); controller.abort(); };
  const before = f.calls.length;
  const result = await restoreDesktop(f.store, { ...options(f), signal: controller.signal, reviewedAppTransition: { from: oldApp, to: newApp } });
  assert.equal(result.status, 'cancelled');
  assert.equal((await currentDesktop(f.store)).activeProfile.name, 'alpha');
  assert.equal(f.running, 'alpha');
  assert.ok(!f.calls.slice(before).some(call => call.startsWith('stop:') || call === 'restore' || call.startsWith('open:')));
});

test('no-open recovery preserves a journal-only reviewed transition across the next selection', async t => {
  const f = await fixture(t), oldApp = appPin('old'), newApp = appPin('new');
  f.setApp(oldApp); await switchDesktop(f.store, 'alpha', options(f)); f.setApp(newApp);
  const session = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
  const transition = { from: oldApp, to: newApp, activePlan: session.active, reviewedAt: '2026-09-16T00:00:00.000Z' };
  session.appPinTransition = transition;
  await writeFile(selectionJournal(f.store), JSON.stringify(session), { mode: 0o600 });
  const evidencePath = join(f.store.directory, 'desktop-selection', `app-pin-transition-${session.id}.json`);
  await f.runtime.stop();
  f.runtime.assertIdle = async () => assert.equal(f.running, null);
  const inspect = f.runtime.inspectApp;
  f.runtime.inspectApp = async () => { throw new Error('app unavailable'); };
  assert.equal((await recoverSelection(f.store, { ...options(f), noOpen: true })).status, 'restored');
  assert.deepEqual(JSON.parse(await readFile(evidencePath, 'utf8')), transition);
  f.runtime.inspectApp = inspect;
  await switchDesktop(f.store, 'bravo', options(f));
  assert.notEqual(JSON.parse(await readFile(selectionJournal(f.store), 'utf8')).id, session.id);
  assert.deepEqual(JSON.parse(await readFile(evidencePath, 'utf8')), transition);
});

test('reviewed transitions reject mismatches and paired sessions before lifecycle work', async t => {
  const f = await fixture(t), oldApp = appPin('old'), newApp = appPin('new');
  f.setApp(oldApp); await switchDesktop(f.store, 'alpha', options(f)); f.setApp(newApp);
  const before = f.calls.length;
  const wrongLocation = { ...appPin('wrong'), appPath: '/fixture/Other.app', executable: '/fixture/Other.app/Contents/MacOS/Codex' };
  const wrongTarget = { ...newApp, appPath: '/fixture/Other.app', executable: '/fixture/Other.app/Contents/MacOS/Codex' };
  await assert.rejects(restoreDesktop(f.store, { ...options(f), reviewedAppTransition: { from: wrongLocation, to: wrongTarget } }), /does not match/);
  let journal = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
  journal.pairedActivationId = randomUUID(); await writeFile(selectionJournal(f.store), JSON.stringify(journal), { mode: 0o600 });
  await assert.rejects(restoreDesktop(f.store, { ...options(f), reviewedAppTransition: { from: oldApp, to: newApp } }), /unpaired active/);
  assert.ok(!f.calls.slice(before).some(call => call.startsWith('stop:') || call === 'restore'));
});

test('a failed first quit is recorded for recovery and never triggers an automatic second quit', async t => {
  const f = await fixture(t); let stops = 0;
  f.runtime.stop = async () => { stops += 1; f.calls.push('quit-failed'); throw Object.assign(new Error('confirmation pending'), { code: 'DESKTOP_QUIT_TIMEOUT' }); };
  await assert.rejects(switchDesktop(f.store, 'alpha', options(f)), /recovery is required/);
  assert.equal(stops, 1); assert.equal((await currentDesktop(f.store)).status, 'incomplete');
  assert.ok(await lstat(f.lockPath));
});

test('unpaired selection prepares clients once after validation and before quitting the desktop', async t => {
  const f = await fixture(t);
  f.runtime.prepareClients = async () => { f.calls.push('prepare'); };
  f.runtime.assertNoOtherClients = async () => { f.calls.push('other-clients'); };
  await switchDesktop(f.store, 'alpha', options(f));
  assert.ok(f.calls.indexOf('prepare') < f.calls.indexOf('other-clients'));
  assert.ok(f.calls.indexOf('other-clients') < f.calls.indexOf('stop:default'));
  assert.equal(f.calls.filter(call => call === 'prepare').length, 1);
  await restoreDesktop(f.store, options(f));
  assert.equal(f.calls.filter(call => call === 'prepare').length, 2);
});

test('unpaired preparation cancellation and later client blockers leave the desktop unchanged', async t => {
  const cancelled = await fixture(t);
  cancelled.runtime.prepareClients = async () => { throw Object.assign(new Error('declined'), { code: 'CANCELLED' }); };
  const result = await switchDesktop(cancelled.store, 'alpha', options(cancelled));
  assert.equal(result.status, 'cancelled');
  assert.equal(cancelled.running, 'default');
  assert.ok(!cancelled.calls.some(call => call.startsWith('stop:')));

  const blocked = await fixture(t);
  blocked.runtime.prepareClients = async () => { blocked.calls.push('prepare'); };
  blocked.runtime.assertNoOtherClients = async () => { throw new Error('VS Code started after confirmation'); };
  await assert.rejects(switchDesktop(blocked.store, 'alpha', options(blocked)), /previous desktop was retained.*VS Code/);
  assert.equal(blocked.running, 'default');
  assert.equal(blocked.calls.filter(call => call === 'prepare').length, 1);
  assert.ok(!blocked.calls.some(call => call.startsWith('stop:')));
});

test('opening failure rolls back to the default desktop and relinquishes reservations', async t => {
  const f = await fixture(t), plan = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  f.runtime.open = async () => { f.calls.push('open-failed'); throw new Error('launch failed'); };
  await assert.rejects(switchDesktop(f.store, 'alpha', options(f)), /previous desktop was retained or restored.*launch failed/);
  assert.equal(f.running, 'default');
  assert.deepEqual(f.calls.filter(call => call === 'open-failed' || call.startsWith('stop:') || call === 'restore'), ['stop:default', 'open-failed', 'stop:null', 'restore']);
  for (const path of [f.lockPath, homeLock(plan)]) await assert.rejects(access(path), { code: 'ENOENT' });
});

test('cancelled readiness and cancellation signals do not strand an unmanaged desktop', async t => {
  const f = await fixture(t), readiness = await switchDesktop(f.store, 'alpha', { ...options(f), ready: async () => false });
  assert.equal(readiness.status, 'cancelled'); assert.deepEqual(f.calls, ['external']);
  const controller = new AbortController(), stop = f.runtime.stop;
  f.runtime.stop = async () => { await stop(); controller.abort(); };
  const cancelled = await switchDesktop(f.store, 'alpha', { ...options(f), signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(f.running, 'default');
  assert.ok(f.calls.includes('restore'));
  await assert.rejects(access(f.lockPath), { code: 'ENOENT' });
});

test('recovery completes an interrupted selection and reclaims only a dead stale operation guard', async t => {
  const f = await fixture(t), stop = f.runtime.stop; let fail = true;
  f.runtime.stop = async () => { if (fail) { f.calls.push('stop-failed'); throw new Error('quit uncertain'); } return stop(); };
  await assert.rejects(switchDesktop(f.store, 'alpha', options(f)), /recovery is required/);
  const stale = `${f.lockPath}.selection`;
  const status = await currentDesktop(f.store);
  const staleOwner = { kind: 'desktop-selection-operation', host: hostname(), pid: 424242, runId: randomUUID(), storePath: f.store.directory, journalPath: status.journalPath };
  await mkdir(stale, { mode: 0o700 }); await writeFile(ownerPath(stale), JSON.stringify(staleOwner), { mode: 0o600 });
  fail = false;
  const recovered = await recoverSelection(f.store, options(f));
  assert.equal(recovered.status, 'restored'); assert.equal(f.running, 'default');
  for (const path of [f.lockPath, stale]) await assert.rejects(access(path), { code: 'ENOENT' });
});

test('foreign global locks are preserved and prevent desktop lifecycle work', async t => {
  const f = await fixture(t);
  await mkdir(f.lockPath, { mode: 0o700 });
  await writeFile(ownerPath(f.lockPath), JSON.stringify({ kind: 'foreign', pid: 1 }), { mode: 0o600 });
  await assert.rejects(switchDesktop(f.store, 'alpha', options(f)), /belongs to another controller or store/);
  assert.ok(await lstat(f.lockPath));
  assert.ok(!f.calls.some(call => call.startsWith('stop:') || call.startsWith('open:')));
  assert.equal(JSON.parse(await readFile(ownerPath(f.lockPath), 'utf8')).kind, 'foreign');
});

test('recovery cleans a prepared reservation crash window without stopping or restoring a desktop', async t => {
  const f = await fixture(t), plan = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  await seedPreparedReservation(f, plan);
  const result = await recoverSelection(f.store, options(f));
  assert.deepEqual(result, { status: 'restored', desktopChanged: false, recoveredBeforeLaunch: true });
  assert.equal(f.running, 'default');
  assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore' || call.startsWith('open:')));
  for (const path of [f.lockPath, homeLock(plan)]) await assert.rejects(access(path), { code: 'ENOENT' });
  assert.equal((await currentDesktop(f.store)).status, 'restored');
});

test('tampered reservation roots and bindings are rejected before any desktop lifecycle action', async t => {
  const f = await fixture(t);
  await switchDesktop(f.store, 'alpha', options(f));
  const journal = JSON.parse(await readFile(selectionJournal(f.store), 'utf8'));
  journal.reservedBindings[0] = { ...journal.reservedBindings[0], root: join(f.root, 'wrong-root') };
  await writeFile(selectionJournal(f.store), JSON.stringify(journal), { mode: 0o600 });
  const before = f.calls.length;
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f)), /Invalid desktop selection journal/);
  assert.equal(f.running, 'alpha');
  assert.ok(!f.calls.slice(before).some(call => call.startsWith('stop:') || call === 'restore' || call.startsWith('open:')));
  assert.ok(await lstat(f.lockPath));
});

test('recovery clears committed active cleanup state without stopping the replacement desktop', async t => {
  const f = await fixture(t);
  const alpha = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  const charlie = await selectionPlan(f.store, 'charlie', { runtime: f.runtime });
  await switchDesktop(f.store, 'alpha', options(f));
  await writeFile(join(homeLock(alpha), 'unexpected'), 'prevents lock-directory removal', { mode: 0o600 });
  await assert.rejects(switchDesktop(f.store, 'charlie', options(f)), /Desktop is active, but reservation cleanup needs desktop recover/);
  assert.equal(f.running, 'charlie');
  assert.equal((await currentDesktop(f.store)).recoveryRequired, true);
  const before = f.calls.length;
  const result = await recoverSelection(f.store, options(f));
  assert.deepEqual(result, { status: 'active', desktopLeftRunning: true, recoveredCleanup: true });
  assert.equal(f.running, 'charlie');
  assert.ok(!f.calls.slice(before).some(call => call.startsWith('stop:') || call === 'restore' || call.startsWith('open:')));
  assert.equal((await currentDesktop(f.store)).recoveryRequired, false);
  assert.ok(await lstat(f.lockPath)); assert.ok(await lstat(homeLock(charlie)));
});

test('a restored cleanup retry starts the next requested selection in the same call', async t => {
  const f = await fixture(t), alpha = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  await switchDesktop(f.store, 'alpha', options(f));
  await writeFile(join(homeLock(alpha), 'unexpected'), 'prevents lock-directory removal', { mode: 0o600 });
  await assert.rejects(restoreDesktop(f.store, options(f)), /Desktop is restored, but reservation cleanup needs desktop recover/);
  assert.equal(f.running, 'default'); assert.equal((await currentDesktop(f.store)).status, 'restored');
  const result = await switchDesktop(f.store, 'bravo', options(f));
  assert.equal(result.status, 'active'); assert.equal(result.activeProfile.name, 'bravo'); assert.equal(f.running, 'bravo');
});

test('recovery clears restored cleanup state without another desktop runtime action', async t => {
  const f = await fixture(t), alpha = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  await switchDesktop(f.store, 'alpha', options(f));
  await writeFile(join(homeLock(alpha), 'unexpected'), 'prevents lock-directory removal', { mode: 0o600 });
  await assert.rejects(restoreDesktop(f.store, options(f)), /Desktop is restored, but reservation cleanup needs desktop recover/);
  assert.equal((await currentDesktop(f.store)).recoveryRequired, true);
  const before = f.calls.length;
  assert.deepEqual(await recoverSelection(f.store, options(f)), { status: 'restored', desktopChanged: false });
  assert.equal((await currentDesktop(f.store)).recoveryRequired, false);
  assert.deepEqual(f.calls.slice(before), ['external']);
});

test('restore and recovery report an unmanaged fresh store without desktop lifecycle work', async t => {
  const f = await fixture(t);
  assert.deepEqual(await restoreDesktop(f.store, options(f)), { status: 'unmanaged', desktopChanged: false });
  assert.deepEqual(await recoverSelection(f.store, options(f)), { status: 'unmanaged', desktopChanged: false });
  assert.deepEqual(f.calls, ['external', 'external']);
  await assert.rejects(access(f.lockPath), { code: 'ENOENT' });
});

test('an ownerless native-home lock fails closed for manual inspection without lifecycle work', async t => {
  const f = await fixture(t), alpha = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  await mkdir(homeLock(alpha), { mode: 0o700 });
  const before = f.calls.length;
  await assert.rejects(switchDesktop(f.store, 'alpha', options(f)), /no owner record; preserving it for manual inspection/);
  assert.ok(await lstat(homeLock(alpha)));
  assert.ok(!f.calls.slice(before).some(call => call.startsWith('stop:') || call === 'restore' || call.startsWith('open:')));
  const status = await currentDesktop(f.store);
  assert.equal(status.status, 'restored'); assert.equal(status.recoveryRequired, true);
});

test('first-selection revalidation failure clears prepared reservations before any desktop lifecycle action', async t => {
  const f = await fixture(t), inspect = f.runtime.inspectApp; let inspections = 0;
  f.runtime.inspectApp = async () => {
    inspections += 1;
    if (inspections === 2) throw new Error('app identity changed during selection');
    return inspect();
  };
  await assert.rejects(switchDesktop(f.store, 'alpha', options(f)), /previous desktop was retained or restored.*app identity changed during selection/);
  assert.equal(inspections, 2); assert.equal(f.running, 'default');
  assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore' || call.startsWith('open:')));
  await assert.rejects(access(f.lockPath), { code: 'ENOENT' });
  const status = await currentDesktop(f.store);
  assert.equal(status.status, 'restored'); assert.equal(status.recoveryRequired, false);
});

test('prepared cleanup keeps its recovery flag if lock metadata cleanup is interrupted', async t => {
  const f = await fixture(t), alpha = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  await seedPreparedReservation(f, alpha);
  await writeFile(join(homeLock(alpha), 'unexpected'), 'prevents lock-directory removal', { mode: 0o600 });
  await assert.rejects(recoverSelection(f.store, options(f)), /Desktop or CLI run is locked|ENOTEMPTY/);
  const interrupted = await currentDesktop(f.store);
  assert.equal(interrupted.status, 'restored'); assert.equal(interrupted.recoveryRequired, true);
  const before = f.calls.length;
  assert.deepEqual(await recoverSelection(f.store, options(f)), { status: 'restored', desktopChanged: false });
  assert.equal((await currentDesktop(f.store)).recoveryRequired, false);
  assert.deepEqual(f.calls.slice(before), ['external']);
});
