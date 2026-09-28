import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ramLogTarget } from '../src/ram-logs.js';
import { Store, create, renameProfile } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { preparePairedActivation, pairedStatus, readPairedPlan, attachPairedRuntime, planActivationTarget, registerActivationTarget } from '../src/desktop-paired.js';
import { currentDesktop, recoverSelection, restoreDesktop, selectionPlan, switchDesktop } from '../src/desktop-selection.js';
import { planCopy } from '../src/native-copy.js';
import { createDesktopRuntime, DESKTOP_APP } from '../src/desktop-runtime.js';

const app = { appPath: '/fixture/Codex.app', bundleId: 'com.fixture.codex', executable: '/fixture/Codex.app/Contents/MacOS/Codex', version: 'fixture' };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-desktop-paired-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'alpha'); create(data, 'bravo'); });
  const alpha = await prepareNativeHome({ directory: join(root, 'alpha'), executable, codexVersion: '0.153.4' });
  const bravo = await prepareNativeHome({ directory: join(root, 'bravo'), executable, codexVersion: '0.153.4' });
  await registerHome(store, 'alpha', alpha.root, { executable, version: '0.153.4' });
  await registerHome(store, 'bravo', bravo.root, { executable, version: '0.153.4' });
  const defaultUserHome = join(root, 'default-home');
  const codex = join(defaultUserHome, '.codex'), data = join(defaultUserHome, 'Library', 'Application Support', 'Codex');
  await mkdir(codex, { recursive: true, mode: 0o755 }); await chmod(codex, 0o755);
  await mkdir(data, { recursive: true, mode: 0o755 }); await chmod(data, 0o755);
  await writeFile(join(codex, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  const calls = []; let installedApp = app, running = 'default', busy = false, failStop = false, restoreFailures = 0;
  const runtime = {
    inspectApp: async () => installedApp,
    assertExternal: async () => calls.push('external'),
    assertIdle: async () => { calls.push('idle'); if (busy) throw new Error('writers are busy'); },
    seedTracked: processes => calls.push(`seed:${processes.length}`),
    snapshot: async () => [{ pid: 71, label: running }],
    stop: async () => { calls.push(`stop:${running}`); if (failStop) throw new Error('quit failed'); running = null; },
    open: async () => { throw new Error('paired activation must use the normal alias launch'); },
    restore: async () => { calls.push('restore'); if (restoreFailures > 0) { restoreFailures -= 1; throw new Error('normal launch failed'); } running = 'default'; return [{ pid: 72, label: 'default' }]; },
  };
  return { root, alpha, bravo, executable, store, defaultUserHome, codex, data, runtime, calls, lockPath: join(root, 'desktop.lock'),
    setApp(value) { installedApp = value; },
    setBusy(value) { busy = value; }, setFailStop(value) { failStop = value; }, setFailRestore(value) { restoreFailures = value ? 1 : 0; },
    setRestoreFailures(value) { restoreFailures = value; } };
}

const options = (f, extra = {}) => ({ runtime: f.runtime, defaultUserHome: f.defaultUserHome, lockPath: f.lockPath, isAlive: () => false, ...extra });
const aliases = f => [f.codex, f.data];
const selectionJournal = f => join(f.store.directory, 'desktop-selection', 'session.json');
const reservations = f => [f.lockPath, join(f.bravo.root, '.run-lock')];
const activationTarget = plan => `profile:${plan.profileId}`;
const planProfile = (plan, name) => plan.profiles.find(profile => profile.name === name);

async function registeredTarget(f, name = 'charlie') {
  const native = await prepareNativeHome({ directory: join(f.root, name), executable: f.executable, codexVersion: '0.153.4' });
  await writeFile(join(native.home, 'config.toml'), `cli_auth_credentials_store = "file"\nsqlite_home = ${JSON.stringify(native.home)}\nallow_symlinked_codex_home = true\n`, { mode: 0o600 });
  await f.store.update(data => create(data, name));
  await registerHome(f.store, name, native.root, { executable: f.executable, version: '0.153.4' });
  return selectionPlan(f.store, name, { runtime: f.runtime });
}

async function interruptedInitialSelection(t) {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  await restoreDesktop(f.store, options(f));
  const originals = await identity(aliases(f));
  const target = await selectionPlan(f.store, 'bravo', { runtime: f.runtime });
  const runId = randomUUID(), journalPath = selectionJournal(f);
  const owner = { kind: 'desktop-selection', host: hostname(), pid: process.pid, runId,
    storePath: f.store.directory, journalPath };
  await rename(f.codex, `${f.codex}.xenoflux-original`);
  await symlink(target.home, f.codex);
  await writeFile(join(f.store.directory, 'activation', 'paired-switch.json'), JSON.stringify({
    schemaVersion: 1, activationId: plan.id, id: randomUUID(), from: 'Default', to: activationTarget(target), phase: 'prepared',
  }), { mode: 0o600 });
  await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, kind: 'desktop-selection-session', id: runId, owner,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: 'opening', active: null, target,
    reservedRoots: [target.nativeRoot], reservedBindings: [target.native], trackedProcesses: [],
    liveHomeChanged: false, pairedActivationId: plan.id }), { mode: 0o600 });
  for (const path of reservations(f)) {
    await mkdir(path, { mode: 0o700 }); await writeFile(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  }
  f.runtime.snapshot = async () => [];
  f.calls.length = 0;
  return { ...f, originals };
}

test('a registered third home is previewed and registered only while the paired aliases and desktop are restored', async t => {
  const f = await fixture(t), initial = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: initial }));
  await restoreDesktop(f.store, options(f));
  const third = await registeredTarget(f);
  await f.store.update(data => renameProfile(data, 'alpha', 'renamed-alpha'));
  const proposal = await planActivationTarget(f.store, 'charlie', { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  assert.equal(proposal.id, initial.id);
  assert.equal(proposal.extensionOf.activationId, initial.id);
  assert.equal(proposal.profiles.at(-1).profileId, third.profileId);
  assert.match(proposal.profiles.at(-1).activationTarget, /^profile:/);
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
  assert.equal((await readPairedPlan(join(f.store.directory, 'activation', 'manifest.json'), f.store, { defaultUserHome: f.defaultUserHome })).profiles.length, 2);
  await registerActivationTarget(f.store, proposal, { runtime: f.runtime, defaultUserHome: f.defaultUserHome, lockPath: f.lockPath });
  const registered = await readPairedPlan(join(f.store.directory, 'activation', 'manifest.json'), f.store, { defaultUserHome: f.defaultUserHome });
  assert.equal(registered.profiles.length, 3);
  const runtime = await attachPairedRuntime(f.store, f.runtime, { defaultUserHome: f.defaultUserHome, operation: 'switch' });
  await runtime.open(third);
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, proposal.profiles.at(-1).activationTarget);
  await runtime.restore();
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
});

test('a target proposal is rejected while the paired selection is active or its base manifest changed', async t => {
  const f = await fixture(t), initial = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: initial }));
  await registeredTarget(f);
  await assert.rejects(planActivationTarget(f.store, 'charlie', { runtime: f.runtime, defaultUserHome: f.defaultUserHome }), /Restore the paired aliases/);
  await restoreDesktop(f.store, options(f));
  const proposal = await planActivationTarget(f.store, 'charlie', { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  const changed = { ...proposal, extensionOf: { ...proposal.extensionOf, approvalId: 'changed' } };
  const { approvalId, ...changedBody } = changed;
  changed.approvalId = createHash('sha256').update(JSON.stringify(changedBody)).digest('hex');
  await assert.rejects(registerActivationTarget(f.store, changed, { defaultUserHome: f.defaultUserHome, lockPath: f.lockPath }), /does not extend/);
  assert.equal((await readPairedPlan(join(f.store.directory, 'activation', 'manifest.json'), f.store, { defaultUserHome: f.defaultUserHome })).profiles.length, 2);
});

test('registration revalidates a reviewed target directory and binding before replacing the manifest', async t => {
  const f = await fixture(t), initial = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: initial }));
  await restoreDesktop(f.store, options(f));
  const third = await registeredTarget(f), manifest = join(f.store.directory, 'activation', 'manifest.json');
  const before = await readFile(manifest, 'utf8');
  const staleDirectory = await planActivationTarget(f.store, 'charlie', { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await chmod(third.desktopData, 0o755);
  await assert.rejects(registerActivationTarget(f.store, staleDirectory, { runtime: f.runtime, defaultUserHome: f.defaultUserHome, lockPath: f.lockPath }), /permissions changed|canonical, owned directories/);
  assert.equal(await readFile(manifest, 'utf8'), before);
  await chmod(third.desktopData, 0o700);
  const staleBinding = await planActivationTarget(f.store, 'charlie', { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await f.store.update(data => {
    const profile = data.profiles.find(profile => profile.name === 'charlie');
    profile.native = { ...profile.native, root: join(f.root, 'rebound-native-home') };
    profile.revision += 1;
  });
  await assert.rejects(registerActivationTarget(f.store, staleBinding, { runtime: f.runtime, defaultUserHome: f.defaultUserHome, lockPath: f.lockPath }), /ENOENT|binding changed|native home/);
  assert.equal(await readFile(manifest, 'utf8'), before);
});

test('registration reclaims only a dead matching registration guard left before the main lock', async t => {
  const f = await fixture(t), initial = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: initial }));
  await restoreDesktop(f.store, options(f));
  await registeredTarget(f);
  const proposal = await planActivationTarget(f.store, 'charlie', { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  const owner = { kind: 'activation-target-registration', host: hostname(), pid: process.pid, runId: randomUUID(), storePath: f.store.directory };
  const guard = `${f.lockPath}.selection`;
  await mkdir(guard, { mode: 0o700 });
  await writeFile(join(guard, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  await registerActivationTarget(f.store, proposal, { runtime: f.runtime, defaultUserHome: f.defaultUserHome, lockPath: f.lockPath, isAlive: () => false });
  await assert.rejects(access(guard), { code: 'ENOENT' });
  await assert.rejects(access(f.lockPath), { code: 'ENOENT' });
});

test('failed recovery preflight preserves split aliases and unfinished authority until a successful retry', async t => {
  for (const failure of ['ensureLogStorage', 'assertNoOtherClients']) await t.test(failure, async t => {
    const f = await interruptedInitialSelection(t);
    const before = await readFile(selectionJournal(f), 'utf8');
    const pairedPath = join(f.store.directory, 'activation', 'paired-switch.json');
    const pairedBefore = await readFile(pairedPath, 'utf8');
    f.runtime[failure] = async () => { throw new Error('preflight unavailable'); };
    await assert.rejects(recoverSelection(f.store, options(f)), /preflight unavailable/);
    assert.equal(await readFile(selectionJournal(f), 'utf8'), before);
    assert.equal(await readFile(pairedPath, 'utf8'), pairedBefore);
    for (const path of reservations(f)) await access(join(path, 'owner.json'));
    assert.equal((await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome })).recoveryRequired, true);
    assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore'));
    delete f.runtime[failure];
    assert.equal((await recoverSelection(f.store, options(f))).status, 'restored');
    assert.deepEqual(await identity(aliases(f)), f.originals);
    assert.equal((await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome })).recoveryRequired, false);
    for (const path of reservations(f)) await assert.rejects(access(path), { code: 'ENOENT' });
    assert.deepEqual(await recoverSelection(f.store, options(f)), { status: 'restored', desktopChanged: false });
  });
});

test('failed recovery after a committed named alias change preserves the outer pending selection', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan }));
  const session = JSON.parse(await readFile(selectionJournal(f), 'utf8'));
  const target = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  Object.assign(session, { phase: 'opening', target });
  await writeFile(selectionJournal(f), JSON.stringify(session), { mode: 0o600 });
  const paired = await attachPairedRuntime(f.store, f.runtime, { session, defaultUserHome: f.defaultUserHome, operation: 'switch' });
  await paired.open(target);
  const before = await readFile(selectionJournal(f), 'utf8');
  f.runtime.ensureLogStorage = async () => { throw new Error('RAM unavailable'); };
  await assert.rejects(recoverSelection(f.store, options(f)), /RAM unavailable/);
  assert.equal(await readFile(selectionJournal(f), 'utf8'), before);
  const status = await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome });
  assert.equal(status.status, 'opening'); assert.equal(status.activeProfile.name, 'bravo');
  assert.equal(status.pairedActivation.selected, activationTarget(target)); assert.equal(status.recoveryRequired, true);
  for (const path of reservations(f)) await access(join(path, 'owner.json'));
  delete f.runtime.ensureLogStorage;
  await recoverSelection(f.store, options(f));
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
});

test('cancelled interrupted recovery retains cancellation identity and unfinished authority', async t => {
  for (const cancellation of ['declined', 'signal']) await t.test(cancellation, async t => {
    const f = await interruptedInitialSelection(t), controller = new AbortController();
    const before = await readFile(selectionJournal(f), 'utf8');
    f.runtime.prepareClients = async () => {
      if (cancellation === 'declined') throw Object.assign(new Error('declined'), { code: 'CANCELLED' });
      controller.abort();
    };
    await assert.rejects(recoverSelection(f.store, options(f, { signal: controller.signal })), { code: 'CANCELLED' });
    assert.equal(await readFile(selectionJournal(f), 'utf8'), before);
    for (const path of reservations(f)) await access(join(path, 'owner.json'));
    assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore'));
  });
});

test('a conflicting completed selection requires real recovery instead of metadata-only cleanup', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan }));
  const session = JSON.parse(await readFile(selectionJournal(f), 'utf8'));
  session.active = await selectionPlan(f.store, 'alpha', { runtime: f.runtime });
  await rm(join(f.bravo.root, '.run-lock'), { recursive: true });
  await mkdir(join(f.alpha.root, '.run-lock'), { mode: 0o700 });
  await writeFile(join(f.alpha.root, '.run-lock', 'owner.json'), JSON.stringify(session.owner), { mode: 0o600 });
  session.reservedRoots = [f.alpha.root];
  session.reservedBindings = [session.active.native];
  session.cleanupRequired = true;
  await writeFile(selectionJournal(f), JSON.stringify(session), { mode: 0o600 });
  const status = await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome });
  assert.equal(status.recoveryRequired, true);
  assert.equal((await recoverSelection(f.store, options(f))).status, 'restored');
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
});

test('an already inconsistent restored journal cannot report success with split aliases and no reservations', async t => {
  const f = await interruptedInitialSelection(t);
  const session = JSON.parse(await readFile(selectionJournal(f), 'utf8'));
  Object.assign(session, { phase: 'restored', active: null, target: null, reservedRoots: [], reservedBindings: [] });
  await writeFile(selectionJournal(f), JSON.stringify(session), { mode: 0o600 });
  for (const path of reservations(f)) await rm(path, { recursive: true });
  const before = await readFile(selectionJournal(f), 'utf8');
  await assert.rejects(recoverSelection(f.store, options(f)), /disagree|inconsistent/);
  assert.equal(await readFile(selectionJournal(f), 'utf8'), before);
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'incomplete');
});

test('no-open recovery restores owned paths without app or RAM preparation and keeps writer checks', async t => {
  const f = await interruptedInitialSelection(t);
  for (const name of ['inspectApp', 'ensureLogStorage', 'ensureHomeLogs', 'stop', 'restore'])
    f.runtime[name] = async () => { throw new Error(`${name} must not run`); };
  f.setBusy(true);
  const before = await readFile(selectionJournal(f), 'utf8');
  await assert.rejects(recoverSelection(f.store, options(f, { noOpen: true })), /writers are busy/);
  assert.equal(await readFile(selectionJournal(f), 'utf8'), before);
  for (const path of reservations(f)) await access(join(path, 'owner.json'));
  f.setBusy(false);
  const result = await recoverSelection(f.store, options(f, { noOpen: true }));
  assert.equal(result.status, 'restored'); assert.equal(result.desktopLeftRunning, false);
  assert.deepEqual(await identity(aliases(f)), f.originals);
  assert.equal((await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome })).recoveryRequired, false);
  for (const path of reservations(f)) await assert.rejects(access(path), { code: 'ENOENT' });
});

test('no-open recovery uses real runtime writer inspection even when the app is unavailable', async t => {
  const f = await interruptedInitialSelection(t);
  const self = { pid: 990001, ppid: 1, uid: process.getuid(), startedAt: 'Mon Sep 21 10:00:00 2026', executable: '/fixture/node' };
  let rows = [self], unavailable = false;
  const runtime = createDesktopRuntime({ currentPid: self.pid, userInfo: () => ({ uid: self.uid, homedir: f.defaultUserHome }),
    processSnapshot: async () => { if (unavailable) throw new Error('cannot inspect processes'); return rows; },
    lstat: async () => { throw Object.assign(new Error('missing RAM fixture'), { code: 'ENOENT' }); },
    execFile: async () => assert.fail('no application or handle command is needed with missing RAM files'),
    readFile: async () => assert.fail('must not inspect the absent app'),
    ramLogs: { ensureMounted: async () => assert.fail('no RAM mount'), prepareHome: async () => assert.fail('no log mutation') },
  });
  const before = await readFile(selectionJournal(f), 'utf8');
  for (const executable of [DESKTOP_APP.executable, f.executable]) {
    rows = [self, { ...self, pid: self.pid + 1, executable }];
    await assert.rejects(recoverSelection(f.store, options(f, { runtime, noOpen: true })));
    assert.equal(await readFile(selectionJournal(f), 'utf8'), before);
    for (const path of reservations(f)) await access(join(path, 'owner.json'));
  }
  unavailable = true;
  await assert.rejects(recoverSelection(f.store, options(f, { runtime, noOpen: true })), { code: 'PROCESS_INSPECTION_FAILED' });
  assert.equal(await readFile(selectionJournal(f), 'utf8'), before);
  unavailable = false; rows = [self];
  assert.equal((await recoverSelection(f.store, options(f, { runtime, noOpen: true }))).status, 'restored');
  assert.deepEqual(await identity(aliases(f)), f.originals);
});

test('no-open recovery preserves foreign reservations and replaced original directories', async t => {
  for (const conflict of ['reservation', 'original']) await t.test(conflict, async t => {
    const f = await interruptedInitialSelection(t);
    if (conflict === 'reservation') await writeFile(join(f.lockPath, 'owner.json'), JSON.stringify({ kind: 'foreign' }));
    else {
      await rename(`${f.codex}.xenoflux-original`, join(f.root, 'preserved-original'));
      await mkdir(`${f.codex}.xenoflux-original`, { mode: 0o755 });
    }
    const before = await readFile(selectionJournal(f), 'utf8');
    await assert.rejects(recoverSelection(f.store, options(f, { noOpen: true })), /belongs to another|identity or permissions changed/);
    assert.equal(await readFile(selectionJournal(f), 'utf8'), before);
    assert.equal(await readlink(f.codex), f.bravo.home);
    for (const path of reservations(f)) await access(join(path, 'owner.json'));
  });
});
function signPlan(plan) {
  const { approvalId, ...body } = plan;
  return { ...body, approvalId: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

test('paired plans require the registered CLI identity for each profile before starting desktop control', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  for (const missing of [true, false]) {
    const changed = structuredClone(plan), profile = changed.profiles[0];
    if (missing) {
      changed.cli = changed.cliByProfile[profile.profileId];
      delete changed.cliByProfile;
    } else changed.cliByProfile[profile.profileId].identity += '-changed';
    f.calls.length = 0;
    await assert.rejects(switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: signPlan(changed) })),
      /registered CLI identity/);
    assert.equal(f.calls.some(call => call.startsWith('stop') || call === 'restore'), false);
    await assert.rejects(access(join(f.store.directory, 'activation', 'manifest.json')), { code: 'ENOENT' });
  }
});
function renumberDevices(plan) {
  const body = structuredClone(plan);
  for (const fact of [...body.facts, ...body.components.map(c => c.originalFact)]) fact.device += 100;
  return signPlan(body);
}
async function identity(paths) { return Promise.all(paths.map(async path => { const s = await lstat(path); return [s.dev, s.ino]; })); }
async function writeActive(f, label) {
  for (const [index, path] of aliases(f).entries()) {
    await writeFile(join(path, 'settings.fixture'), `${label}:settings:${index}`, { mode: 0o600 });
    await writeFile(join(path, 'history.fixture'), `${label}:history:${index}`, { mode: 0o600 });
  }
}
async function assertActive(f, label) {
  for (const [index, path] of aliases(f).entries()) {
    assert.equal(await readFile(join(path, 'settings.fixture'), 'utf8'), `${label}:settings:${index}`);
    assert.equal(await readFile(join(path, 'history.fixture'), 'utf8'), `${label}:history:${index}`);
  }
}

test('paired desktop switches use normal aliases, preserve exact Default directories, and retain A/B data', async t => {
  const f = await fixture(t), originals = await identity(aliases(f));
  await writeFile(join(f.codex, 'default'), 'default codex', { mode: 0o600 });
  await writeFile(join(f.data, 'default'), 'default desktop', { mode: 0o600 });
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan }));
  await writeActive(f, 'B');
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, activationTarget(planProfile(plan, 'bravo')));
  const active = await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome });
  assert.equal(active.pairedActivation.selected, activationTarget(planProfile(plan, 'bravo')));
  assert.equal(active.liveHomeChanged, true);
  await switchDesktop(f.store, 'alpha', options(f));
  await writeActive(f, 'A');
  await restoreDesktop(f.store, options(f));
  const defaultProfile = await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome });
  assert.equal(defaultProfile.pairedActivation.selected, 'Default');
  assert.equal(defaultProfile.liveHomeChanged, false);
  assert.deepEqual(await identity(aliases(f)), originals);
  assert.equal(await readFile(join(f.codex, 'default'), 'utf8'), 'default codex');
  assert.equal(await readFile(join(f.data, 'default'), 'utf8'), 'default desktop');
  await switchDesktop(f.store, 'bravo', options(f)); await assertActive(f, 'B');
  await switchDesktop(f.store, 'alpha', options(f)); await assertActive(f, 'A');
  assert.equal(f.calls.filter(call => call.startsWith('open')).length, 0);
  assert.ok(f.calls.filter(call => call === 'restore').length >= 5);
});

test('paired switches prepare RAM logs after Quit with the physical target and original Default home', async t => {
  const f = await fixture(t);
  const prepared = [];
  f.runtime.ensureLogStorage = async () => { f.calls.push('logs:storage'); };
  f.runtime.ensureHomeLogs = async ({ home, key }) => {
    prepared.push({ home, key });
    f.calls.push(`logs:${key}`);
  };
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  const bravo = planProfile(plan, 'bravo');
  await switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan }));
  const targetLog = f.calls.indexOf(`logs:${bravo.environmentId}`);
  assert.ok(f.calls.indexOf('logs:storage') < f.calls.indexOf('stop:default'));
  assert.ok(targetLog > f.calls.indexOf('stop:default') && targetLog < f.calls.indexOf('restore'));
  assert.deepEqual(prepared.find(item => item.key === bravo.environmentId), { home: bravo.home, key: bravo.environmentId });

  const beforeRestore = f.calls.length;
  await restoreDesktop(f.store, options(f));
  const restoreCalls = f.calls.slice(beforeRestore);
  assert.ok(restoreCalls.indexOf('logs:default') > restoreCalls.findIndex(call => call.startsWith('stop:')));
  assert.ok(restoreCalls.indexOf('logs:default') < restoreCalls.indexOf('restore'));
  assert.deepEqual(prepared.find(item => item.key === 'default'), { home: `${f.codex}.xenoflux-original`, key: 'default' });
});

test('a paired RAM storage preparation failure neither quits the desktop nor changes aliases', async t => {
  const f = await fixture(t), originals = await identity(aliases(f));
  f.runtime.ensureLogStorage = async () => { f.calls.push('logs:storage'); throw new Error('RAM logs unavailable'); };
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan })), /RAM logs unavailable/);
  assert.ok(f.calls.includes('logs:storage'));
  assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore'));
  assert.deepEqual(await identity(aliases(f)), originals);
  assert.equal(await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome }), null);
});

test('a persisted paired activation survives desktop and CLI updates, including recovery', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  f.setApp({ ...app, version: 'updated', build: 'updated', asarSha256: 'updated-sha' });
  await writeFile(f.executable, '#!/bin/sh\n# updated CLI\nexit 99\n', { mode: 0o700 });
  await switchDesktop(f.store, 'bravo', options(f));
  f.setFailStop(true);
  await assert.rejects(restoreDesktop(f.store, options(f)), /recovery is required/);
  f.setFailStop(false);
  await recoverSelection(f.store, options(f));
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
});

test('a persisted paired activation rejects a changed desktop app location', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  f.setApp({ ...app, appPath: '/fixture/Other.app', executable: '/fixture/Other.app/Contents/MacOS/Codex' });
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f)), /Paired activation app location changed/);
});

test('paired activation survives device renumbering for status, copy preview, switching and recovery', async t => {
  const f = await fixture(t), originals = await identity(aliases(f));
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan }));
  const manifest = join(f.store.directory, 'activation', 'manifest.json');
  const saved = JSON.stringify(renumberDevices(plan));
  await writeFile(manifest, saved, { mode: 0o600 });
  // A reboot can also clear the global reservation kept in /private/tmp.
  await rm(f.lockPath, { recursive: true });
  assert.equal((await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome })).pairedActivation.selected, activationTarget(planProfile(plan, 'bravo')));
  await planCopy(f.store, 'Default', 'alpha', { defaultUserHome: f.defaultUserHome, include: ['config'] });
  await switchDesktop(f.store, 'alpha', options(f));
  f.setFailStop(true);
  await assert.rejects(restoreDesktop(f.store, options(f)), /recovery is required/);
  f.setFailStop(false);
  await rm(f.lockPath, { recursive: true });
  await recoverSelection(f.store, options(f));
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
  await planCopy(f.store, 'Default', 'alpha', { defaultUserHome: f.defaultUserHome, include: ['config'] });
  assert.deepEqual(await identity(aliases(f)), originals);
  assert.equal(await readFile(manifest, 'utf8'), saved);
});

test('a prepared activation can register after device renumbering', async t => {
  const f = await fixture(t), originals = await identity(aliases(f));
  const plan = renumberDevices(await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome }));
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  await restoreDesktop(f.store, options(f));
  assert.deepEqual(await identity(aliases(f)), originals);
});

test('restoration after reboot tolerates device renumbering, a missing reservation and an absent RAM log', async t => {
  const f = await fixture(t), originals = await identity(aliases(f));
  const resource = ramLogTarget('default');
  await symlink(resource, join(f.codex, 'logs_2.sqlite'));
  let resourceChecks = 0;
  f.runtime.assertIdle = createDesktopRuntime({ processSnapshot: async () => [],
    lstat: async path => {
      assert.ok(path.startsWith('/Volumes/CodexRAM/')); resourceChecks++;
      throw Object.assign(new Error('RAM disk is absent'), { code: 'ENOENT' });
    }, execFile: async () => assert.fail('a missing RAM log needs no lsof query') }).assertIdle;
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  assert.deepEqual(plan.resourcePaths, [resource]);
  await switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan }));
  await writeFile(join(f.store.directory, 'activation', 'manifest.json'), JSON.stringify(renumberDevices(plan)), { mode: 0o600 });
  await rm(f.lockPath, { recursive: true });
  resourceChecks = 0;
  assert.equal((await restoreDesktop(f.store, options(f))).status, 'restored');
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
  assert.deepEqual(await identity(aliases(f)), originals);
  assert.equal(await readlink(join(f.codex, 'logs_2.sqlite')), resource);
  assert.ok(resourceChecks > 2, 'resource absence is checked again during the alias transaction');
});

test('device renumbering still rejects replaced paths, changed permissions and inconsistent volumes before Quit', async t => {
  for (const change of ['target', 'original', 'permissions', 'symlink', 'fact-device', 'original-device']) await t.test(change, async t => {
    const f = await fixture(t);
    const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
    await switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan }));
    const saved = renumberDevices(plan), target = f.alpha.desktopData;
    if (change === 'fact-device') saved.facts[0].device += 1;
    else if (change === 'original-device') saved.components[0].originalFact.device += 1;
    else if (change === 'permissions') await chmod(target, 0o755);
    else {
      const path = change === 'original' ? `${f.codex}.xenoflux-original` : target;
      await rename(path, `${path}.kept`);
      if (change === 'symlink') await symlink(`${path}.kept`, path);
      else await mkdir(path, { mode: change === 'original' ? 0o755 : 0o700 });
    }
    await writeFile(join(f.store.directory, 'activation', 'manifest.json'), JSON.stringify(signPlan(saved)), { mode: 0o600 });
    f.calls.length = 0;
    const error = /identity or permissions changed|filesystem layout changed|Activation needs canonical|Expected a private directory|Invalid desktop data/;
    await assert.rejects(pairedStatus(f.store, { defaultUserHome: f.defaultUserHome }), error);
    await assert.rejects(switchDesktop(f.store, 'alpha', options(f)), error);
    await assert.rejects(restoreDesktop(f.store, options(f)), error);
    assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore'));
  });
});

test('paired selection requires the target symlink-home setting before Quit, while Default restoration remains available', async t => {
  for (const setting of ['missing', 'false']) await t.test(setting, async t => {
    const f = await fixture(t);
    const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
    await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
    const config = join(f.bravo.home, 'config.toml');
    await writeFile(config, setting === 'false'
      ? 'cli_auth_credentials_store = "file"\nallow_symlinked_codex_home = false\n'
      : 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    const before = f.calls.length;
    await assert.rejects(switchDesktop(f.store, 'bravo', options(f)), /allow_symlinked_codex_home = true/);
    assert.ok(!f.calls.slice(before).some(call => call.startsWith('stop:')));
    await restoreDesktop(f.store, options(f));
    assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
  });
});

test('writer quiescence blocks paired alias installation and preserves the default paths', async t => {
  const f = await fixture(t), originals = await identity(aliases(f));
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  f.setBusy(true);
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan })), /writers are busy/);
  assert.deepEqual(await identity(aliases(f)), originals);
  assert.equal(await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome }), null);
  assert.equal((await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome })).pairedActivation, undefined);
  await assert.rejects(switchDesktop(f.store, 'alpha', options(f)), /paired activation must use the normal alias launch/);
  assert.equal(await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome }), null);
});

test('renaming inactive and active profiles preserves paired switching, restart and restoration', async t => {
  const f = await fixture(t), originals = await identity(aliases(f));
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  const manifest = join(f.store.directory, 'activation', 'manifest.json');
  const originalPlan = await readFile(manifest, 'utf8');
  await f.store.update(data => renameProfile(data, 'bravo', 'Research'));
  await switchDesktop(f.store, 'Research', options(f));
  await writeActive(f, 'B');
  await f.store.update(data => renameProfile(data, 'Research', 'Client Work'));
  await switchDesktop(f.store, 'Client Work', options(f));
  await assertActive(f, 'B');
  assert.equal((await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome })).activeProfile.name, 'Client Work');
  await switchDesktop(f.store, 'alpha', options(f));
  await switchDesktop(f.store, 'Client Work', options(f));
  await assertActive(f, 'B');
  await restoreDesktop(f.store, options(f));
  assert.deepEqual(await identity(aliases(f)), originals);
  assert.equal(await readFile(manifest, 'utf8'), originalPlan);

  // Ignoring the display name must not accept changed launch paths.
  const runtime = await attachPairedRuntime(f.store, f.runtime, { defaultUserHome: f.defaultUserHome });
  const target = await selectionPlan(f.store, 'Client Work', { runtime: f.runtime });
  const calls = f.calls.length;
  await assert.rejects(runtime.open({ ...target, home: f.codex }), /outside the reviewed paired native-home plan/);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(await identity(aliases(f)), originals);
});

test('paired selection catches IDE clients before stopping the desktop or installing aliases', async t => {
  const f = await fixture(t), originals = await identity(aliases(f));
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  f.runtime.prepareClients = async options => { f.calls.push(`prepare:${options.cliExecutables.length}`); };
  f.runtime.assertNoOtherClients = async () => { throw new Error('VS Code is still running Codex'); };
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan })), /VS Code/);
  assert.ok(f.calls.some(call => call.startsWith('prepare:')));
  assert.ok(f.calls.indexOf('prepare:1') < f.calls.indexOf('stop:default') || !f.calls.some(call => call.startsWith('stop:default')));
  assert.ok(!f.calls.some(call => call.startsWith('stop:') || call === 'restore'));
  assert.deepEqual(await identity(aliases(f)), originals);
  assert.equal(await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome }), null);
  assert.equal((await currentDesktop(f.store, { defaultUserHome: f.defaultUserHome })).status, 'restored');
});

test('a failed quit does not issue a second quit or move either alias', async t => {
  const f = await fixture(t), originals = await identity(aliases(f));
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  f.setFailStop(true);
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan })), /quit failed/);
  assert.deepEqual(await identity(aliases(f)), originals);
  assert.equal(f.calls.filter(call => call.startsWith('stop:')).length, 1);
  assert.equal(await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome }), null);
});

test('failed first activation and pre-mutation registration crash cannot silently enable a later ordinary switch', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  f.setFailStop(true);
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan })), /quit failed/);
  assert.equal(await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome }), null);

  const g = await fixture(t);
  const crashPlan = await preparePairedActivation(g.store, ['alpha', 'bravo'], { runtime: g.runtime, defaultUserHome: g.defaultUserHome });
  const activation = join(g.store.directory, 'activation'), manifest = join(activation, 'manifest.json');
  await mkdir(activation, { mode: 0o700 });
  await writeFile(manifest, JSON.stringify(crashPlan), { mode: 0o600 });
  await assert.rejects(switchDesktop(g.store, 'alpha', options(g)), /registration was interrupted before alias changes/);
  const pending = await pairedStatus(g.store, { defaultUserHome: g.defaultUserHome });
  assert.equal(pending.selected, 'Default');
  assert.equal(pending.recoveryRequired, true);
  await recoverSelection(g.store, options(g));
  await assert.rejects(access(manifest), { code: 'ENOENT' });
  assert.equal(await pairedStatus(g.store, { defaultUserHome: g.defaultUserHome }), null);
});

test('a failed normal launch restores the prior paired selection through the aliases', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  await writeActive(f, 'A');
  f.setFailRestore(true);
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f)), /normal launch failed/);
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, activationTarget(planProfile(plan, 'alpha')));
  await assertActive(f, 'A');
});

test('first launch and rollback failure leaves an uncommitted intent that desktop recover can restore', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  f.setRestoreFailures(2);
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan })), /desktop recover/);
  await recoverSelection(f.store, options(f));
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
});

test('saved plan rejects stale original and target directory identities before the desktop is stopped', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  await restoreDesktop(f.store, options(f));
  f.calls.length = 0;
  await rm(f.codex, { recursive: true }); await mkdir(f.codex, { mode: 0o755 }); await chmod(f.codex, 0o755);
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f)), /Unexpected preserved original|identity or permissions changed/);
  assert.equal(f.calls.filter(call => call.startsWith('stop:')).length, 0);

  const g = await fixture(t);
  const targetPlan = await preparePairedActivation(g.store, ['alpha', 'bravo'], { runtime: g.runtime, defaultUserHome: g.defaultUserHome });
  await switchDesktop(g.store, 'alpha', options(g, { requestedActivationPlan: targetPlan }));
  await restoreDesktop(g.store, options(g));
  g.calls.length = 0;
  const target = g.alpha.desktopData;
  await rm(target, { recursive: true }); await mkdir(target, { mode: 0o700 });
  await assert.rejects(switchDesktop(g.store, 'bravo', options(g)), /identity or permissions changed/);
  assert.equal(g.calls.filter(call => call.startsWith('stop:')).length, 0);
});

test('saved plan metadata tampering and removal fail closed for status and controller operations', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  const manifest = join(f.store.directory, 'activation', 'manifest.json');
  const tampered = JSON.parse(await readFile(manifest, 'utf8')); tampered.defaultUserHome = join(f.root, 'other-home');
  await writeFile(manifest, JSON.stringify(tampered), { mode: 0o600 });
  await assert.rejects(readPairedPlan(manifest, f.store, { defaultUserHome: f.defaultUserHome }), /Invalid or changed/);
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f)), /Invalid or changed/);
  await writeFile(manifest, JSON.stringify(plan), { mode: 0o600 });
  await unlink(manifest);
  await assert.rejects(currentDesktop(f.store, { defaultUserHome: f.defaultUserHome }), /metadata is missing or changed/);
  await assert.rejects(recoverSelection(f.store, options(f)), /metadata is missing|Activation needs canonical/);
});

test('uncommitted intent cannot restore through a missing manifest after aliases changed', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan }));
  const journalPath = join(f.store.directory, 'desktop-selection', 'session.json');
  const session = JSON.parse(await readFile(journalPath, 'utf8'));
  session.phase = 'opening'; session.target = session.active; session.active = null;
  delete session.pairedActivationId;
  await writeFile(journalPath, JSON.stringify(session), { mode: 0o600 });
  await unlink(join(f.store.directory, 'activation', 'manifest.json'));
  f.calls.length = 0;
  await assert.rejects(recoverSelection(f.store, options(f)), /metadata is missing after an alias transaction/);
  assert.equal(f.calls.filter(call => call.startsWith('stop:') || call === 'restore').length, 0);
  assert.equal(await realpath(f.codex), f.bravo.home);
});

test('an established Default activation with a missing paired journal preserves its manifest', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan }));
  await restoreDesktop(f.store, options(f));
  const activation = join(f.store.directory, 'activation');
  await unlink(join(activation, 'paired-switch.json'));
  f.calls.length = 0;
  await assert.rejects(recoverSelection(f.store, options(f)), /journal is missing from an established activation/);
  await assert.rejects(switchDesktop(f.store, 'bravo', options(f, { requestedActivationPlan: plan })), /journal is missing from an established activation/);
  await access(join(activation, 'manifest.json'));
  assert.equal(f.calls.filter(call => call.startsWith('stop:') || call === 'restore').length, 0);
});

test('the next controller switch recovers a prepared paired transaction and removes its staged link', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  const id = randomUUID(), activation = join(f.store.directory, 'activation');
  const staged = join(f.defaultUserHome, `.xfx-next-${id}-codex-home`);
  await symlink(f.bravo.home, staged);
  await writeFile(join(activation, 'paired-switch.json'), JSON.stringify({ schemaVersion: 1, activationId: plan.id, id,
    from: activationTarget(planProfile(plan, 'alpha')), to: activationTarget(planProfile(plan, 'bravo')), phase: 'prepared' }), { mode: 0o600 });
  await switchDesktop(f.store, 'bravo', options(f));
  await assert.rejects(access(staged), { code: 'ENOENT' });
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, activationTarget(planProfile(plan, 'bravo')));
});

test('controller recovery tolerates a prepared pre-quit window and refuses activation metadata mismatch', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  const manifest = join(f.store.directory, 'activation', 'manifest.json');
  const document = JSON.parse(await readFile(manifest, 'utf8'));
  document.id = '11111111-1111-4111-8111-111111111111';
  await writeFile(manifest, JSON.stringify(document), { mode: 0o600 });
  await assert.rejects(recoverSelection(f.store, options(f)), /Invalid or changed paired activation plan/);
});

test('controller recovery restores Default after an opening journal and a partially switched paired alias', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  await switchDesktop(f.store, 'alpha', options(f, { requestedActivationPlan: plan }));
  await restoreDesktop(f.store, options(f));
  const target = await selectionPlan(f.store, 'bravo', { runtime: f.runtime });
  const runId = randomUUID(), journalPath = join(f.store.directory, 'desktop-selection', 'session.json');
  const owner = { kind: 'desktop-selection', host: hostname(), pid: process.pid, runId,
    storePath: f.store.directory, journalPath };
  await rename(f.codex, `${f.codex}.xenoflux-original`);
  await symlink(f.bravo.home, f.codex);
  await writeFile(join(f.store.directory, 'activation', 'paired-switch.json'), JSON.stringify({
    schemaVersion: 1, activationId: plan.id, id: randomUUID(), from: 'Default', to: activationTarget(target), phase: 'prepared',
  }), { mode: 0o600 });
  const session = { schemaVersion: 1, kind: 'desktop-selection-session', id: runId, owner,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: 'opening', active: null, target,
    reservedRoots: [target.nativeRoot], reservedBindings: [target.native], trackedProcesses: [],
    liveHomeChanged: false, pairedActivationId: plan.id };
  await writeFile(journalPath, JSON.stringify(session), { mode: 0o600 });
  for (const path of [f.lockPath, join(target.nativeRoot, '.run-lock')]) {
    await mkdir(path, { mode: 0o700 }); await writeFile(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  }
  await recoverSelection(f.store, options(f));
  assert.equal((await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome })).selected, 'Default');
  assert.equal((await lstat(f.codex)).isDirectory(), true);
});

test('opening paired intent without a manifest recovers only after verifying the saved plan still has Default aliases', async t => {
  const f = await fixture(t);
  const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
  const target = await selectionPlan(f.store, 'bravo', { runtime: f.runtime });
  const runId = randomUUID(), directory = join(f.store.directory, 'desktop-selection'), journalPath = join(directory, 'session.json');
  const owner = { kind: 'desktop-selection', host: hostname(), pid: process.pid, runId, storePath: f.store.directory, journalPath };
  await mkdir(directory, { mode: 0o700 });
  await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, kind: 'desktop-selection-session', id: runId, owner,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: 'opening', active: null, target,
    reservedRoots: [target.nativeRoot], reservedBindings: [target.native], trackedProcesses: [], liveHomeChanged: false,
    pairedActivationIntent: plan }), { mode: 0o600 });
  for (const path of [f.lockPath, join(target.nativeRoot, '.run-lock')]) {
    await mkdir(path, { mode: 0o700 }); await writeFile(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  }
  await recoverSelection(f.store, options(f));
  assert.equal(await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome }), null);
  assert.equal((await lstat(f.codex)).isDirectory(), true);
});

test('stopping and restoring uncommitted intents recover through the signed plan fallback', async t => {
  for (const phase of ['stopping', 'restoring']) await t.test(phase, async t => {
    const f = await fixture(t);
    const plan = await preparePairedActivation(f.store, ['alpha', 'bravo'], { runtime: f.runtime, defaultUserHome: f.defaultUserHome });
    const target = await selectionPlan(f.store, 'bravo', { runtime: f.runtime });
    const runId = randomUUID(), directory = join(f.store.directory, 'desktop-selection'), journalPath = join(directory, 'session.json');
    const owner = { kind: 'desktop-selection', host: hostname(), pid: process.pid, runId, storePath: f.store.directory, journalPath };
    await mkdir(directory, { mode: 0o700 });
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, kind: 'desktop-selection-session', id: runId, owner,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase, active: null, target,
      reservedRoots: [target.nativeRoot], reservedBindings: [target.native], trackedProcesses: [], liveHomeChanged: false,
      pairedActivationIntent: plan }), { mode: 0o600 });
    for (const path of [f.lockPath, join(target.nativeRoot, '.run-lock')]) {
      await mkdir(path, { mode: 0o700 }); await writeFile(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    }
    await recoverSelection(f.store, options(f));
    assert.equal(await pairedStatus(f.store, { defaultUserHome: f.defaultUserHome }), null);
  });
});

 test('adding a target after device renumbering preserves the reviewed device mapping', async t => {
  const f=await fixture(t);
  const initial=renumberDevices(await preparePairedActivation(f.store,['alpha','bravo'],{runtime:f.runtime,defaultUserHome:f.defaultUserHome}));
  await switchDesktop(f.store,'alpha',options(f,{requestedActivationPlan:initial}));
  await restoreDesktop(f.store,options(f));
  await registeredTarget(f);
  const proposal=await planActivationTarget(f.store,'charlie',{runtime:f.runtime,defaultUserHome:f.defaultUserHome});
  assert.deepEqual(proposal.facts.slice(0,initial.facts.length),initial.facts);
  assert.equal(new Set(proposal.facts.map(f=>f.device)).size,1);
  await registerActivationTarget(f.store,proposal,{runtime:f.runtime,defaultUserHome:f.defaultUserHome,lockPath:f.lockPath});
  await switchDesktop(f.store,'charlie',options(f));
  assert.equal((await currentDesktop(f.store,{defaultUserHome:f.defaultUserHome})).activeProfile.name,'charlie');
  await restoreDesktop(f.store,options(f));
});
