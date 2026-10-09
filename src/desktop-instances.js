// Concurrent desktops keep fixed native paths. This never switches the default
// aliases or controls a desktop through its shared bundle identifier.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { resolveHome } from './homes.js';
import { find } from './profiles.js';
import { DESKTOP_APP } from './desktop-runtime.js';
import { createDesktopInstanceRuntime, processIdentity, targetStartSeconds } from './desktop-instance-runtime.js';
import { prepareProfileLauncher } from './profile-launcher.js';
import { reserveInstanceControl, releaseInstanceControl } from './desktop-instance-guard.js';
import { createLogStorage } from './log-storage.js';
import { ramLogTarget } from './ram-logs.js';
import { acquire, exists, globalLock, privateDirectory, readJSON, record, release } from './metadata.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const absolute = path => typeof path === 'string' && path.startsWith('/') && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const paths = (store, id) => ({ root: join(store.directory, 'desktop-instances'), journal: join(store.directory, 'desktop-instances', `${id}.json`) });
const receiptPath = (store, state) => join(paths(store, state.profileId).root, `${state.profileId}.${state.runId}.launch`);
const rowValid = row => row && Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.ppid >= 0
  && row.uid === process.getuid() && typeof row.startedAt === 'string' && Number.isFinite(Date.parse(row.startedAt)) && absolute(row.executable);

function validateState(state, store, id) {
  const p = state?.plan;
  if (!state || state.schemaVersion !== 1 || state.kind !== 'desktop-instance' || state.profileId !== id || !uuid.test(id)
    || !uuid.test(state.runId ?? '') || !['preparing', 'opening', 'running', 'closing', 'closed'].includes(state.phase)
    || state.owner?.kind !== 'desktop-instance' || state.owner.runId !== state.runId || state.owner.profileId !== id
    || state.owner.storePath !== store.directory || state.owner.journalPath !== paths(store, id).journal || state.owner.host !== hostname()
    || !Number.isSafeInteger(state.owner.pid) || state.owner.pid < 1 || p?.profileId !== id || !uuid.test(p.environmentId ?? '')
    || ![p.nativeRoot, p.home, p.desktopData, p.temporary, p.userHome].every(absolute)
    || p.home !== join(p.nativeRoot, 'codex-home') || p.desktopData !== join(p.nativeRoot, 'desktop-data') || p.temporary !== join(p.nativeRoot, 'tmp')
    || p.userHome !== join(p.nativeRoot, 'user-home') || !absolute(p.app?.appPath) || p.app?.bundleId !== DESKTOP_APP.bundleId
    || !absolute(p.app.executable) || relative(join(p.app.appPath, 'Contents', 'MacOS'), p.app.executable).includes('/')
    || !p.app.executable.startsWith(`${p.app.appPath}/Contents/MacOS/`)
    || (state.main !== null && (!rowValid(state.main) || state.main.executable !== p.app.executable))
    || !Array.isArray(state.processes) || !state.processes.every(rowValid) || !Array.isArray(state.baselineMains) || !state.baselineMains.every(rowValid)
    || (state.launcher !== null && !rowValid(state.launcher))) throw new Error('Invalid desktop instance record; preserving its reservation');
  if (state.main && state.baselineMains.some(row => processIdentity(row) === processIdentity(state.main)))
    throw new Error('Desktop instance refers to a preexisting process; preserving its reservation');
  if (state.launcherPaths) validateLauncherPaths(state.launcherPaths, store, id);
  if (state.phase === 'running' && (!state.main || !state.launcherPaths || !state.launcher))
    throw new Error('Desktop instance has incomplete running identity; preserve its record');
  return state;
}
function validateLauncherPaths(launcher, store, id) {
  const expectedApp = join(paths(store, id).root, 'apps', `${id}.app`);
  const helperRelative = relative(join(paths(store, id).root, 'native'), launcher.helperExecutable ?? '');
  if (launcher.launcherApp !== expectedApp || launcher.launcherExecutable !== join(expectedApp, 'Contents', 'MacOS', 'XfxProfileLauncher')
    || !/^[a-f0-9]{64}\/XfxProfileLauncher$/.test(helperRelative) || !/^[a-f0-9]{64}$/.test(launcher.helperSha256 ?? ''))
    throw new Error('Invalid profile launcher binding; preserving the desktop instance');
}
async function pinnedHelper(state) {
  const path = state.launcherPaths.helperExecutable;
  await privateDirectory(join(path, '..'));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)
    || !(stat.mode & 0o100) || await realpath(path) !== path
    || createHash('sha256').update(await readFile(path)).digest('hex') !== state.launcherPaths.helperSha256)
    throw new Error('Profile launcher helper changed; preserving the desktop instance');
  return path;
}
async function readState(store, id) {
  const root = paths(store, id).root;
  if (!await exists(root)) return null;
  await privateDirectory(root);
  const file = paths(store, id).journal;
  return await exists(file) ? validateState(await readJSON(file), store, id) : null;
}
/** Called under the shared operation guard before removing a profile binding. */
export async function prepareDesktopInstanceRemoval(store, id, options = {}) {
  const state = await readState(store, id);
  if (!state) return;
  if (state.phase !== 'closed')
    throw new Error('Profile has an unfinished desktop instance; close or recover it before deleting or unbinding the profile');
  // A crash can leave the control marker after the closed journal is saved.
  await releaseInstanceControl(state.owner, options);
}
async function save(store, state, phase = state.phase) {
  state.phase = phase; state.updatedAt = new Date().toISOString();
  validateState(state, store, state.profileId);
  await record(paths(store, state.profileId).journal, state);
}
async function assertBinding(store, state) {
  const { profile, native, environment } = await resolveHome(store, state.profileId), plan = state.plan;
  if (native.root !== plan.nativeRoot || environment.id !== plan.environmentId || environment.home !== plan.home || environment.desktopData !== plan.desktopData
    || environment.launch.env.HOME !== plan.userHome || environment.launch.env.TMPDIR !== plan.temporary)
    throw new Error('Desktop profile binding changed; preserving its record and reservation');
  return profile;
}
async function ownedReservation(state) {
  const lock = join(state.plan.nativeRoot, '.run-lock');
  if (!await exists(lock)) return false;
  await privateDirectory(lock);
  if (!equal(await readJSON(join(lock, 'owner.json')), state.owner))
    throw new Error('Desktop profile reservation belongs to another operation; preserving it');
  return true;
}
function launchReceipt(state, main = state.main) {
  const p = state.plan;
  return { schemaVersion: 1, kind: 'desktop-instance-launch', runId: state.runId, profileId: state.profileId,
    home: p.home, desktopData: p.desktopData, userHome: p.userHome, temporary: p.temporary,
    app: { appPath: p.app.appPath, bundleId: p.app.bundleId, executable: p.app.executable }, main };
}
async function assertLaunchReceipt(store, state) {
  if (!state.main || !equal(await readJSON(receiptPath(store, state)), launchReceipt(state)))
    throw new Error('Desktop launch receipt is missing or changed; preserving the instance');
}
const resources = plan => [plan.home, plan.desktopData, ...['', '-wal', '-shm'].map(s => ramLogTarget(plan.environmentId) + s)];
async function observation(state, runtime) {
  if (state.main) return runtime.observe(state.main, { trackedProcesses: state.processes });
  if (state.phase === 'opening') {
    const baseline = new Set(state.baselineMains.map(processIdentity));
    const unknown = (await runtime.snapshot()).filter(row => row.executable === state.plan.app.executable && !baseline.has(processIdentity(row)));
    if (unknown.length) return { status: 'unknown-launch', processes: unknown };
  }
  return { status: 'stopped', processes: [] };
}
async function finishStopped(store, state, runtime, options) {
  const observed = await observation(state, runtime);
  if (observed.status !== 'stopped') throw new Error('Desktop instance still runs or its ownership is uncertain; preserving its reservation');
  await runtime.assertResourcesIdle(resources(state.plan));
  if (await ownedReservation(state)) await release(join(state.plan.nativeRoot, '.run-lock'), state.owner);
  await save(store, state, 'closed');
  await releaseInstanceControl(state.owner, options);
  // A separate write-once receipt survives interruption without extending the
  // shared lock format. Once the instance is stopped it no longer authorizes control.
  await unlink(receiptPath(store, state)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

// Serialize profile lifecycle and maintenance operations across controller stores.
// The guard is released while an instance is running.
async function withOperation(store, id, options, action) {
  const guardPath = `${options.lockPath ?? globalLock()}.operation`;
  const owner = { kind: 'desktop-instance-operation', host: hostname(), pid: process.pid, runId: randomUUID(),
    storePath: store.directory, profileId: id, journalPath: paths(store, id).journal };
  if (await exists(guardPath)) {
    await privateDirectory(guardPath);
    const old = await readJSON(join(guardPath, 'owner.json'));
    if (!options.recovery || old.kind !== owner.kind || old.host !== owner.host || old.storePath !== owner.storePath || old.profileId !== id
      || old.journalPath !== owner.journalPath || !uuid.test(old.runId ?? '') || !Number.isSafeInteger(old.pid) || old.pid < 1
      || (options.isAlive ?? alive)(old.pid)) throw new Error('Another desktop operation is running or interrupted; preserve it and recover that profile');
    await release(guardPath, old);
  }
  await acquire(guardPath, owner, true);
  try { return await action(); } finally { await release(guardPath, owner); }
}

export async function desktopInstancePlan(store, name, { runtime = createDesktopInstanceRuntime() } = {}) {
  const { profile, native, environment } = await resolveHome(store, name);
  return { profileId: profile.id, name: profile.name, environmentId: environment.id, nativeRoot: native.root,
    home: environment.home, desktopData: environment.desktopData, temporary: environment.launch.env.TMPDIR, userHome: environment.launch.env.HOME,
    app: await runtime.inspectApp(), displayName: `Codex · ${profile.name}`, liveHomeChanged: false,
    sameProfileConcurrency: 'exclusive', nativeAcceptance: 'pending' };
}
function result(state, status) {
  return { status, profileId: state.profileId, name: state.plan.name, main: state.main,
    mainStartSeconds: state.main ? targetStartSeconds(state.main.startedAt) : null, launcher: state.launcher,
    launcherApp: state.launcherPaths?.launcherApp ?? null, home: state.plan.home, desktopData: state.plan.desktopData,
    liveHomeChanged: false, nativeAcceptance: 'pending' };
}
async function launcherCaller(runtime, launcherPaths, env) {
  const pid = env.XFX_DESKTOP_LAUNCHER_PID, executable = env.XFX_DESKTOP_LAUNCHER_EXECUTABLE;
  if (pid === undefined && executable === undefined) return null;
  if (!/^[1-9]\d*$/.test(pid ?? '') || executable !== launcherPaths.launcherExecutable)
    throw new Error('Invalid profile launcher caller');
  const row = (await runtime.snapshot()).find(row => row.pid === Number(pid));
  if (!rowValid(row) || row.executable !== executable) throw new Error('Profile launcher caller is unavailable or changed');
  return row;
}

export async function openDesktopInstance(store, name, {
  runtime = createDesktopInstanceRuntime(), prepareLauncher = prepareProfileLauncher, ramLogs,
  launcherEnvironment = process.env, ...options
} = {}) {
  const id = find(await store.read(), name).id;
  return withOperation(store, id, options, async () => {
    let state = await readState(store, id);
    if (state?.phase === 'closed') await releaseInstanceControl(state.owner, options);
    if (state && state.phase !== 'closed') {
      await assertBinding(store, state);
      if (!await ownedReservation(state)) throw new Error('Desktop instance lost its reservation; preserve it for recovery');
      await reserveInstanceControl(state.owner, options);
      const observed = await observation(state, runtime);
      if (['opening', 'running'].includes(state.phase) && state.main && state.launcherPaths && observed.status === 'running' && !observed.orphaned) {
        await assertLaunchReceipt(store, state);
        state.processes = observed.processes;
        const helperExecutable = await pinnedHelper(state);
        const caller = await launcherCaller(runtime, state.launcherPaths, launcherEnvironment);
        if (caller) state.launcher = caller;
        else if (!state.launcher || (await runtime.observe(state.launcher)).status === 'stopped')
          state.launcher = await runtime.openLauncher(state.launcherPaths, state.main);
        else if ((await runtime.observe(state.launcher)).status !== 'running') throw new Error('Profile launcher identity changed; preserve the desktop instance');
        await runtime.focus(state.main, { helperExecutable });
        await save(store, state, 'running');
        return result(state, 'focused');
      }
      if (observed.status !== 'stopped') throw new Error('Desktop launch is incomplete or still running; use desktop recover PROFILE after it stops');
      await finishStopped(store, state, runtime, options);
    }
    const plan = await desktopInstancePlan(store, id, { runtime });
    await privateDirectory(store.directory); await privateDirectory(paths(store, id).root, true);
    const runId = randomUUID();
    const owner = { kind: 'desktop-instance', host: hostname(), pid: process.pid, runId, storePath: store.directory,
      profileId: id, journalPath: paths(store, id).journal };
    state = { schemaVersion: 1, kind: 'desktop-instance', profileId: id, runId, owner, plan, phase: 'preparing',
      main: null, processes: [], baselineMains: [], launcher: null, launcherPaths: null };
    // Record the intended owner before reserving; recovery can reconcile a crash
    // between lock acquisition and the next journal write without inventing ownership.
    await save(store, state);
    let reserved = false, launchAttempted = false;
    try {
      await acquire(join(plan.nativeRoot, '.run-lock'), owner, true); reserved = true;
      await reserveInstanceControl(owner, options);
      await assertBinding(store, state);
      await runtime.assertResourcesIdle(resources(plan));
      await privateDirectory(plan.desktopData, true);
      state.launcherPaths = await prepareLauncher(store, plan);
      validateLauncherPaths(state.launcherPaths, store, id);
      state.launcher = await launcherCaller(runtime, state.launcherPaths, launcherEnvironment);
      const helperExecutable = await pinnedHelper(state);
      await (ramLogs ?? createLogStorage()).prepareHome({ home: plan.home, key: plan.environmentId });
      state.baselineMains = (await runtime.snapshot()).filter(row => row.executable === plan.app.executable);
      await save(store, state, 'opening'); launchAttempted = true;
      const opened = await runtime.open(plan, { helperExecutable });
      if (!rowValid(opened.main) || opened.main.executable !== plan.app.executable || !opened.processes?.every(rowValid))
        throw new Error('Desktop returned incomplete process ownership; preserving its reservation');
      if (state.baselineMains.some(row => processIdentity(row) === processIdentity(opened.main)))
        throw new Error('Desktop returned a preexisting process; preserving its reservation');
      await writeFile(receiptPath(store, state), JSON.stringify(launchReceipt(state, opened.main)), { flag: 'wx', mode: 0o600 });
      state.main = opened.main; state.processes = opened.processes;
      await save(store, state);
      if (!state.launcher) state.launcher = await runtime.openLauncher(state.launcherPaths, state.main);
      await save(store, state, 'running');
      return result(state, 'opened');
    } catch (error) {
      state.error = error.code ?? 'DESKTOP_INSTANCE_FAILED';
      if (!launchAttempted) {
        if (reserved && await ownedReservation(state)) await release(join(plan.nativeRoot, '.run-lock'), owner);
        await save(store, state, 'closed');
        await releaseInstanceControl(owner, options);
      } else await save(store, state);
      throw new Error(`${error.message}${launchAttempted ? '\nInstance reservation preserved. Use desktop recover PROFILE after that instance stops.' : ''}`, { cause: error });
    }
  });
}

export async function focusDesktopInstance(store, name, { runtime = createDesktopInstanceRuntime(), ...options } = {}) {
  const id = find(await store.read(), name).id;
  return withOperation(store, id, options, async () => {
    const state = await readState(store, id);
    if (!state || state.phase !== 'running') throw new Error('No running desktop instance is recorded for this profile');
    await assertBinding(store, state);
    if (!await ownedReservation(state)) throw new Error('Desktop instance reservation is missing; preserving state');
    await reserveInstanceControl(state.owner, options);
    const observed = await observation(state, runtime);
    if (observed.status !== 'running' || observed.orphaned) throw new Error('Desktop instance is unavailable or its process identity changed');
    await assertLaunchReceipt(store, state);
    await runtime.focus(state.main, { helperExecutable: await pinnedHelper(state) });
    state.processes = observed.processes; await save(store, state);
    return result(state, 'focused');
  });
}

export async function closeDesktopInstance(store, name, { runtime = createDesktopInstanceRuntime(), ...options } = {}) {
  const id = find(await store.read(), name).id;
  return withOperation(store, id, options, async () => {
    const state = await readState(store, id);
    if (!state) return { status: 'closed', profileId: id, liveHomeChanged: false };
    if (state.phase === 'closed') {
      await releaseInstanceControl(state.owner, options);
      return result(state, 'closed');
    }
    await assertBinding(store, state);
    if (!await ownedReservation(state)) throw new Error('Desktop instance reservation is missing; preserving state');
    await reserveInstanceControl(state.owner, options);
    const observed = await observation(state, runtime);
    if (observed.status !== 'stopped') {
      if (observed.status !== 'running' || observed.orphaned || !state.main) throw new Error('Desktop ownership is uncertain; it was not closed');
      await assertLaunchReceipt(store, state);
      state.processes = observed.processes; await save(store, state, 'closing');
      await runtime.close(state.main, { helperExecutable: await pinnedHelper(state) });
    }
    await finishStopped(store, state, runtime, options);
    return result(state, 'closed');
  });
}

export async function recoverDesktopInstance(store, name, { runtime = createDesktopInstanceRuntime(), ...options } = {}) {
  const id = find(await store.read(), name).id;
  return withOperation(store, id, { ...options, recovery: true }, async () => {
    const state = await readState(store, id);
    if (!state) return { status: 'unmanaged', profileId: id, liveHomeChanged: false };
    await assertBinding(store, state);
    await finishStopped(store, state, runtime, options);
    return result(state, 'recovered');
  });
}

export async function listDesktopInstances(store, { observe = false, runtime = createDesktopInstanceRuntime() } = {}) {
  const root = paths(store, '').root;
  if (!await exists(root)) return { instances: [], observation: observe ? 'processes' : 'last-recorded', liveHomeChanged: false };
  await privateDirectory(root);
  const profiles = (await store.read()).profiles;
  const instances = [];
  for (const entry of (await readdir(root)).filter(name => name.endsWith('.json')).sort()) {
    const id = entry.slice(0, -5);
    if (!uuid.test(id)) throw new Error('Unrecognized desktop instance journal; preserving it');
    const state = await readState(store, id), profile = profiles.find(profile => profile.id === id);
    if (!profile && state.phase !== 'closed') throw new Error('Desktop instance references a missing profile; preserve its recovery record');
    if (state.phase === 'closed') continue;
    const item = { ...result(state, state.phase), name: profile?.name ?? state.plan.name, journalPath: paths(store, id).journal };
    if (observe) {
      try { item.observed = await observation(state, runtime); }
      catch (error) { item.observed = { status: 'unavailable', code: error.code ?? 'OBSERVATION_FAILED' }; }
    }
    instances.push(item);
  }
  return { instances, observation: observe ? 'processes' : 'last-recorded', liveHomeChanged: false };
}
