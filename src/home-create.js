// Guided preparation of one ordinary registered native home.  Settings copy
// and native sign-in remain separate explicit operations.
import { access, lstat, mkdir, open, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { create, find } from './profiles.js';
import { registerHome, resolveHome } from './homes.js';
import { runInteractive } from './interactive-process.js';
import { acquire, exists, readJSON, release } from './metadata.js';
import { probeVersion } from './version-probe.js';
import { createLogStorage } from './log-storage.js';

const MARKER = '.xfx-home-setup.json';
const own = process.getuid?.();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; } };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function fail(message) { throw new Error(message); }
function inside(parent, path) {
  const value = relative(parent, path);
  return !value || (!value.startsWith('../') && value !== '..');
}
function validName(value) { return typeof value === 'string' && value.trim() && value.length <= 4096; }
function homeName(value) {
  if (!validName(value)) fail('Choose a profile name');
  if (value.trim().toLowerCase() === 'default') fail('Default is reserved for the native default home');
}
function validBase(value) { return typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value); }
async function privateDirectory(path, name) {
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink() || await realpath(path) !== path || (item.mode & 0o077)
    || (own !== undefined && item.uid !== own)) fail(`Invalid ${name}`);
}
async function marker(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Invalid setup metadata'); }
  try {
    const item = await handle.stat();
    if (!item.isFile() || item.nlink !== 1 || item.size > 4096 || (item.mode & 0o077) || (own !== undefined && item.uid !== own))
      fail('Invalid setup metadata');
    const text = await handle.readFile({ encoding: 'utf8' });
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || typeof value.profileId !== 'string'
      || !['preparing', 'prepared', 'registered', 'login-running', 'login-completed', 'login-failed', 'login-cancelled'].includes(value.phase))
      fail('Invalid setup metadata');
    return value;
  } catch (error) { if (error.message === 'Invalid setup metadata') throw error; throw new Error('Invalid setup metadata'); }
  finally { await handle.close(); }
}
async function writeMarker(root, value) {
  const path = join(root, MARKER), temporary = join(root, `.${MARKER}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
/** Reconcile only a login marker already proven safe by profile recovery. */
export async function reconcileInterruptedSignIn({ root, profileId, apply = false } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
    || typeof profileId !== 'string' || !uuid.test(profileId) || typeof apply !== 'boolean')
    fail('Invalid interrupted sign-in recovery target');
  const setup = await marker(join(root, MARKER));
  if (!setup || setup.profileId !== profileId
    || !['registered', 'login-running', 'login-completed', 'login-failed', 'login-cancelled'].includes(setup.phase))
    fail('Native sign-in marker does not match the recovery target');
  if (apply && setup.phase === 'login-running') {
    await privateDirectory(root, 'native home root');
    await writeMarker(root, { ...setup, phase: 'login-cancelled' });
    return { phase: 'login-cancelled', changed: true };
  }
  return { phase: setup.phase, changed: false };
}
async function createMarker(root, value) {
  await writeFile(join(root, MARKER), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
function setupRoot(store, base, profile) {
  if (!validBase(base)) fail('Native home base must be an absolute canonical path');
  if (inside(store.directory, base) || inside(base, store.directory)) fail('Native home base must be outside the controller');
  return join(base, profile.id);
}
async function validateInputs(store, base, executable, version) {
  if (!validBase(base)) fail('Native home base must be an absolute canonical path');
  if (inside(store.directory, base) || inside(base, store.directory)) fail('Native home base must be outside the controller');
  await privateDirectory(base, 'native home base');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
    fail('Native home registration requires a recognizable Codex CLI version');
  if (typeof executable !== 'string' || !isAbsolute(executable) || resolve(executable) !== executable) fail('Codex executable must be an absolute path');
  const target = await realpath(executable), item = await lstat(target);
  if (!item.isFile() || item.isSymbolicLink()) fail('Invalid Codex executable');
  await access(target, constants.X_OK);
}
function assertRegistered(profile, root) {
  if (profile.native?.root !== root)
    fail('Profile already has a different native home binding');
}
async function profileFor(store, name, description) {
  const data = await store.read();
  try { return find(data, name); }
  catch (error) {
    if (error.message !== 'Profile not found: ' + name) throw error;
    return store.update(value => create(value, name, description));
  }
}
function sameSetupOwner(value, owner) {
  return value?.kind === 'native-home-setup' && value.host === owner.host && value.storePath === owner.storePath
    && value.profileId === owner.profileId && value.root === owner.root && Number.isSafeInteger(value.pid) && value.pid > 0
    && uuid.test(value.runId ?? '');
}
async function acquireSetupLock(lock, owner, isAlive) {
  try { await acquire(lock, owner, true); return false; }
  catch (original) {
    let prior;
    try { prior = await readJSON(join(lock, 'owner.json')); }
    catch { throw original; }
    if (!sameSetupOwner(prior, owner) || isAlive(prior.pid)) throw original;
    // A crash can leave the intended root created but not yet marked. Make
    // that association durable while the matching stale owner still holds the
    // canonical lock. A competing retry may then safely finish if it wins the
    // brief recovery handoff below.
    try {
      await privateDirectory(owner.root, 'native home root');
      const setup = await marker(join(owner.root, MARKER));
      if (setup) {
        if (setup.profileId !== owner.profileId) throw new Error('Setup metadata belongs to a different profile');
      } else {
        if ((await readdir(owner.root)).length) throw new Error('Refusing an existing native home without Xenoflux setup metadata');
        await createMarker(owner.root, { version: 1, profileId: owner.profileId, phase: 'preparing' });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const guard = `${lock}.recover-${owner.runId}`;
    try { await rename(lock, guard); }
    catch { throw original; }
    let guarded;
    try { guarded = await readJSON(join(guard, 'owner.json')); }
    catch (error) { throw error; }
    if (JSON.stringify(guarded) !== JSON.stringify(prior)) {
      if (!await exists(lock)) await rename(guard, lock);
      throw original;
    }
    await release(guard, prior);
    await acquire(lock, owner, true);
    return true;
  }
}
function report(profile, root, setup) {
  const login = setup?.phase === 'login-completed' ? 'completed'
    : setup?.phase === 'login-running' ? 'running'
      : setup?.phase === 'login-failed' ? 'failed'
        : setup?.phase === 'login-cancelled' ? 'cancelled' : 'pending';
  return { status: setup?.phase === 'registered' || login !== 'pending' ? 'prepared' : 'preparing',
    profile: { id: profile.id, name: profile.name }, root, home: join(root, 'codex-home'),
    login: { state: login, credentialsInspected: false } };
}
async function previewSetup(root, profile) {
  try { await privateDirectory(root, 'native home root'); }
  catch (error) { if (error.code === 'ENOENT') fail('Registered native home has no Xenoflux setup metadata; it cannot be resumed'); throw error; }
  const setup = await marker(join(root, MARKER));
  if (!setup || setup.profileId !== profile.id) fail('Registered native home has no Xenoflux setup metadata; it cannot be resumed');
  return setup;
}

/** Read-only preview of the stable ID path that `createHome` will use. */
export async function planHomeCreation({ store, name, base, description = '' } = {}) {
  if (!store?.directory) fail('Invalid profile store');
  homeName(name);
  if (typeof description !== 'string') fail('Invalid profile description');
  if (!validBase(base)) fail('Native home base must be an absolute canonical path');
  if (inside(store.directory, base) || inside(base, store.directory)) fail('Native home base must be outside the controller');
  const data = await store.read();
  let profile;
  try { profile = find(data, name); }
  catch (error) {
    if (error.message !== 'Profile not found: ' + name) throw error;
    return { status: 'preview', profile: { name, id: null, action: 'create' }, base, root: null,
      note: 'Applying creates a profile ID, then uses it as the native-home directory name.', login: { state: 'pending', credentialsInspected: false } };
  }
  const root = setupRoot(store, base, profile);
  if (profile.native) assertRegistered(profile, root);
  if (profile.native) {
    const setup = await previewSetup(root, profile);
    return { ...report(profile, root, setup), status: 'preview', profile: { id: profile.id, name: profile.name, action: 'resume' }, base };
  }
  return { status: 'preview', profile: { id: profile.id, name: profile.name, action: profile.native ? 'resume' : 'prepare' }, base, root,
    home: join(root, 'codex-home'), login: { state: 'pending', credentialsInspected: false } };
}

/** Create or safely resume a minimal registered home.  It never removes bytes. */
export async function createHome({ store, name, base, description = '', executable, version, isAlive = alive } = {}) {
  if (!store?.directory) fail('Invalid profile store');
  homeName(name);
  if (typeof description !== 'string') fail('Invalid profile description');
  await validateInputs(store, base, executable, version);
  if (typeof isAlive !== 'function') fail('Invalid setup owner inspection');
  const profile = await profileFor(store, name, description);
  const root = setupRoot(store, base, profile);
  if (profile.native) assertRegistered(profile, root);
  const owner = { kind: 'native-home-setup', pid: process.pid, host: hostname(), runId: randomUUID(), storePath: store.directory, profileId: profile.id, root };
  const lock = join(base, `.${profile.id}.setup-lock`);
  const recovered = await acquireSetupLock(lock, owner, isAlive);
  try {
    const fresh = find(await store.read(), profile.id);
    if (fresh.native) assertRegistered(fresh, root);
    let setup;
    try {
      await mkdir(root, { mode: 0o700 });
      setup = { version: 1, profileId: fresh.id, phase: 'preparing' };
      await createMarker(root, setup);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await privateDirectory(root, 'native home root');
      setup = await marker(join(root, MARKER));
      if (!setup) {
        if (!recovered || (await readdir(root)).length) fail('Refusing an existing native home without Xenoflux setup metadata');
        setup = { version: 1, profileId: fresh.id, phase: 'preparing' };
        await createMarker(root, setup);
      }
      if (setup.profileId !== fresh.id) fail('Setup metadata belongs to a different profile');
    }
    if (['login-running', 'login-completed', 'login-failed', 'login-cancelled', 'registered'].includes(setup.phase)) {
      if (setup.phase === 'login-running') fail('Native sign-in is still running or needs recovery');
      assertRegistered(fresh, root); await resolveHome(store, fresh.id);
      return { ...report(fresh, root, setup), binding: fresh.native };
    }
    for (const part of ['codex-home', 'workspace', 'user-home', 'tmp', 'desktop-data']) await mkdir(join(root, part), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    for (const part of ['codex-home', 'workspace', 'user-home', 'tmp', 'desktop-data']) await privateDirectory(join(root, part), part);
    const config = join(root, 'codex-home', 'config.toml');
    try { await writeFile(config, 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    setup = { ...setup, phase: 'prepared' }; await writeMarker(root, setup);
    const registered = await registerHome(store, fresh.name, root, { executable, version, expectedProfileId: fresh.id });
    setup = { ...setup, phase: 'registered' }; await writeMarker(root, setup);
    return { ...report(registered, root, setup), binding: registered.native };
  } finally { await release(lock, owner); }
}

/** Inspect setup progress only; credentials and native history are never read. */
export async function inspectHomeCreation({ store, name, base } = {}) {
  homeName(name);
  const profile = find(await store.read(), name), root = setupRoot(store, base, profile);
  await privateDirectory(root, 'native home root');
  const setup = await marker(join(root, MARKER));
  if (!setup || setup.profileId !== profile.id) fail('Setup metadata does not match this profile');
  return report(profile, root, setup);
}

/** Run the native Codex login command in the registered home's isolated environment. */
export async function startHomeSignIn({ store, name, base, signal, run = runInteractive, probe = probeVersion, ramLogs = createLogStorage() } = {}) {
  homeName(name);
  if (typeof run !== 'function') fail('Invalid native login runner');
  if (typeof probe !== 'function' || !ramLogs || typeof ramLogs.prepareHome !== 'function') fail('Invalid native login preparation');
  const profile = find(await store.read(), name), root = setupRoot(store, base, profile);
  await privateDirectory(root, 'native home root');
  const owner = { kind: 'native-home-login', pid: process.pid, host: hostname(), runId: randomUUID(), root };
  const lock = join(root, '.run-lock');
  await acquire(lock, owner);
  let preserveLock = false;
  let enteredLogin = false;
  try {
    const fresh = find(await store.read(), profile.id);
    assertRegistered(fresh, root);
    await privateDirectory(root, 'native home root');
    let setup = await marker(join(root, MARKER));
    if (!setup || setup.profileId !== fresh.id || !['registered', 'login-failed', 'login-cancelled'].includes(setup.phase))
      fail('Native home is not prepared for sign-in');
    const { environment, native } = await resolveHome(store, fresh.id);
    if (native.root !== root || environment.home !== join(root, 'codex-home')) fail('Native home binding changed');
    setup = { ...setup, phase: 'login-running' }; await writeMarker(root, setup);
    enteredLogin = true;
    const launchEnv = environment.launch.env;
    const observedVersion = await probe({ executable: environment.launch.executable, cwd: environment.launch.cwd, env: launchEnv, signal });
    const afterProbe = await resolveHome(store, fresh.id);
    if (afterProbe.native.environmentId !== native.environmentId || afterProbe.environment.id !== environment.id || afterProbe.environment.home !== environment.home)
      throw Object.assign(new Error('Native home binding changed'), { code: 'HOME_CHANGED' });
    if (afterProbe.native.executableIdentity !== native.executableIdentity)
      throw Object.assign(new Error('Codex executable changed'), { code: 'EXECUTABLE_CHANGED' });
    const currentEnv = afterProbe.environment.launch.env;
    await ramLogs.prepareHome({ home: afterProbe.environment.home, key: afterProbe.environment.id, signal });
    const result = await run({ executable: afterProbe.environment.launch.executable, args: ['login'], cwd: afterProbe.environment.launch.cwd,
      env: currentEnv, signal });
    const phase = signal?.aborted || result?.signal ? 'login-cancelled' : result?.exitCode === 0 ? 'login-completed' : 'login-failed';
    setup = { ...setup, phase }; await writeMarker(root, setup);
    return { ...report(fresh, root, setup), native: { exitCode: result?.exitCode ?? null, version: observedVersion } };
  } catch (error) {
    preserveLock = error?.code === 'SHUTDOWN_FAILED';
    if (enteredLogin && !preserveLock) {
      const setup = await marker(join(root, MARKER));
      if (setup?.profileId === profile.id && setup.phase === 'login-running')
        await writeMarker(root, { ...setup, phase: error?.code === 'CANCELLED' ? 'login-cancelled' : 'login-failed' });
    }
    throw error;
  } finally {
    if (!preserveLock) await release(lock, owner);
  }
}
