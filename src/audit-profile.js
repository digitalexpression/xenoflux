// Read-only profile routing and preflight helpers for audit execution.
// Native credentials, saved profile bindings, and configuration are never changed.
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, lstat, open, readlink, realpath } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { launchPlan } from './launcher.js';
import { resolveHome } from './homes.js';
import { nativePath } from './node-runtime.js';
import { privateDirectory, readJSON } from './metadata.js';
import { createDesktopInstanceRuntime } from './desktop-instance-runtime.js';
import { hostname } from 'node:os';
import { probeAuditVersion } from './audit-native-version.js';
import { validateAuditNativeConfig } from './audit-spec.js';

const execFile = promisify(nodeExecFile);
const VERSION = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SETTINGS_FILES = 2048;
const MAX_SETTINGS_DEPTH = 12;
const settingsBySnapshot = new WeakMap();

function selectionOf(value) {
  const selection = typeof value === 'string' ? { name: value } : value;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || typeof selection.name !== 'string' || !selection.name.trim()
    || /[\x00-\x1f\x7f]/.test(selection.name)) throw new Error('Select a profile name');
  if (selection.executable !== undefined && (typeof selection.executable !== 'string' || !selection.executable.trim()
    || !selection.executable.startsWith('/') || /[\x00-\x1f\x7f]/.test(selection.executable)))
    throw new Error('Audit executable must be an absolute path');
  if (selection.version !== undefined && !VERSION(selection.version))
    throw new Error('Audit Codex version context must be short plain text');
  if (selection.skills !== undefined && (!Array.isArray(selection.skills)
    || selection.skills.some(skill => typeof skill !== 'string' || !skill.trim() || /[\x00-\x1f\x7f]/.test(skill))
    || new Set(selection.skills).size !== selection.skills.length)) throw new Error('Audit skills must be unique nonempty names');
  const nativeConfig = validateAuditNativeConfig(selection.nativeConfig);
  return nativeConfig === undefined ? selection : { ...selection, nativeConfig };
}

async function canonicalDirectory(path, label, { privateOnly = false } = {}) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path
    || info.uid !== process.getuid() || (info.mode & (privateOnly ? 0o077 : 0o022)))
    throw new Error(`${label} is not a safe canonical directory`);
  return info;
}

async function safeConfig(home) {
  const path = join(home, 'config.toml');
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error('Codex configuration is unavailable or unsafe'); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o022)
      || before.size > MAX_CONFIG_BYTES) throw new Error('Codex configuration is unavailable or unsafe');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('Codex configuration changed while it was being inspected');
    try { return parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Codex configuration is malformed'); }
  } finally { await handle.close(); }
}

async function executableInfo(path) {
  const invocation = resolve(path), target = await realpath(invocation), info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Audit Codex executable is not a regular file');
  await access(target, constants.X_OK);
  return { executable: invocation, executableIdentity: JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]) };
}

/** Recheck the selected executable's file identity before an audit task starts. */
export async function inspectAuditExecutable(path) { return executableInfo(path); }

async function defaultProfile(name, { repository, defaultUserHome }) {
  const userHome = resolve(defaultUserHome);
  await canonicalDirectory(userHome, 'Default user home');
  const home = join(userHome, '.codex');
  await canonicalDirectory(home, 'Default Codex home');
  if (typeof repository !== 'string' || !repository.trim()) throw new Error('Default profile audit requires a selected repository');
  const bindingRepository = await realpath(repository);
  await canonicalDirectory(bindingRepository, 'Audit repository');
  const config = await safeConfig(home);
  if (config.projects?.[bindingRepository]?.trust_level !== 'trusted')
    throw new Error('Default profile audit requires an existing trusted repository entry in config.toml');
  return { profileId: 'default', profileName: 'Default', home, userHome, nativeRoot: null,
    reservationRoot: home, environmentId: null, bindingRepository };
}

/** Resolve one explicit profile to a launch-ready, credential-minimal environment. */
export async function resolveAuditExecutionProfile(store, input, { repository, defaultUserHome = homedir(), probe = probeAuditVersion } = {}) {
  const selection = selectionOf(input);
  const isDefault = selection.name.trim().toLowerCase() === 'default';
  let profile;
  if (isDefault) profile = await defaultProfile(selection.name, { repository, defaultUserHome });
  else {
    let plan;
    try { plan = await launchPlan(store, selection.name, process.env, { repository }); }
    catch (error) {
      if (error.message === 'Bind this repository to the profile before launching it')
        throw Object.assign(new Error('The selected repository is not already bound to this profile'), { code: 'profile-repository-unbound' });
      throw error;
    }
    const resolved = await resolveHome(store, selection.name);
    profile = { profileId: plan.profileId, profileName: plan.name, home: plan.home,
      userHome: resolved.environment.launch.env.HOME, nativeRoot: plan.nativeRoot,
      reservationRoot: plan.nativeRoot, environmentId: plan.environmentId,
      bindingRepository: repository === undefined ? null : plan.cwd,
      _nativeExecutable: plan.executable, _nativeVersion: plan.version,
      _nativeIdentity: plan.executableIdentity, _nativeEnv: plan.env };
  }

  let binary;
  if (selection.executable !== undefined) binary = await executableInfo(selection.executable);
  else if (profile._nativeExecutable) binary = { executable: profile._nativeExecutable,
    executableIdentity: profile._nativeIdentity };
  else throw new Error('Default profile audit requires an explicit Codex executable');

  const env = profile._nativeEnv ? { ...profile._nativeEnv } : {
    PATH: nativePath(process.env), HOME: profile.userHome, CODEX_HOME: profile.home,
    CODEX_SQLITE_HOME: profile.home, TMPDIR: profile.home, TMP: profile.home, TEMP: profile.home,
  };
  // Do not carry arbitrary variables from the invoking process into Codex.
  const allowed = new Set(['PATH', 'HOME', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'TMPDIR', 'TMP', 'TEMP']);
  for (const key of Object.keys(env)) if (!allowed.has(key)) delete env[key];
  env.PATH = nativePath({ PATH: env.PATH });
  env.HOME = profile.userHome; env.CODEX_HOME = profile.home; env.CODEX_SQLITE_HOME = profile.home;
  let version = profile._nativeVersion ?? null;
  let versionSource = version ? 'registered' : 'unavailable';
  if (selection.executable !== undefined) {
    version = null;
    versionSource = 'unavailable';
    try {
      const observed = await probe({ executable: binary.executable, env,
        cwd: profile.bindingRepository ?? profile.userHome });
      if (VERSION(observed)) { version = observed; versionSource = 'observed'; }
    } catch (error) {
      // A version flag/output shape is descriptive, but an unconfirmed child
      // shutdown or cancellation must remain a hard safety boundary.
      if (['SHUTDOWN_FAILED', 'CANCELLED'].includes(error?.code)) throw error;
    }
  }
  const result = { profileId: profile.profileId, profileName: profile.profileName,
    home: profile.home, userHome: profile.userHome, nativeRoot: profile.nativeRoot,
    reservationRoot: profile.reservationRoot, environmentId: profile.environmentId,
    executable: binary.executable, executableIdentity: binary.executableIdentity, version,
    executableSource: selection.executable === undefined ? 'registered' : 'explicit-per-trial',
    versionSource, ...(selection.version !== undefined ? { requestedVersion: selection.version } : {}),
    env, bindingRepository: profile.bindingRepository,
    ...(selection.nativeConfig !== undefined ? { nativeConfig: { ...selection.nativeConfig } } : {}),
    ...(selection.skills ? { skills: [...selection.skills] } : {}) };
  return result;
}

function safeResourceEnvironment() { return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }; }

export async function inspectNativeResources(paths, { runExecFile = execFile } = {}) {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path))
    throw new Error('Native profile resource inspection failed');
  const pids = new Set(), clients = new Map(); let records = 0;
  for (const path of paths) {
    let result, exitCode = 0, stderr = '';
    try {
      result = await runExecFile('/usr/sbin/lsof', ['-nP', '-Fpcun', '-u', String(process.getuid()), '-a', '--', path], {
        cwd: '/', env: safeResourceEnvironment(), encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 3000,
      });
    } catch (error) {
      if (error.code !== 1 || (error.stdout !== undefined && typeof error.stdout !== 'string')
        || (error.stderr !== undefined && typeof error.stderr !== 'string')) throw new Error('Native profile resource inspection failed');
      exitCode = 1; stderr = error.stderr ?? ''; result = { stdout: error.stdout ?? '' };
    }
    let observation;
    try { observation = parseNativeResourceResult(result?.stdout, [path], { exitCode, stderr }); }
    catch { throw new Error('Native profile resource inspection failed'); }
    // A single exact existing path returning rows with exit 1 is still
    // ambiguous. Only an empty, warning-free exit-1 result proves no holder.
    if (observation.partial) throw new Error('Native profile resource inspection failed');
    records += observation.records;
    for (const client of observation.clients) {
      pids.add(client.pid);
      const previous = clients.get(client.pid);
      clients.set(client.pid, previous ? { ...previous, paths: [...new Set([...previous.paths, ...client.paths])] } : client);
    }
  }
  return { pids: [...pids], clients: [...clients.values()], records, partial: false };
}
const inspectNativeResourcesDefault = paths => inspectNativeResources(paths);

function parseLsof(text, paths) {
  if (typeof text !== 'string') throw new Error('Native profile resource inspection returned invalid output');
  const pids = new Set();
  let current = null, records = 0;
  const clients = [];
  const finish = () => {
    if (!current) return;
    if (!current.command || current.uid !== String(process.getuid()) || !current.names.length)
      throw new Error('Native profile resource inspection returned incomplete process metadata');
    records += 1;
    const matched = current.names.filter(name => paths.includes(name));
    if (matched.length) {
      pids.add(current.pid);
      clients.push({ pid: current.pid, command: current.command, uid: Number(current.uid), paths: [...new Set(matched)] });
    }
  };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const field = line[0], value = line.slice(1);
    if (field === 'p') {
      finish();
      if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) throw new Error('Invalid process ID from lsof');
      current = { pid: Number(value), command: null, uid: null, names: [] };
    } else if (!current) throw new Error('Invalid lsof record');
    else if (field === 'c') current.command = value;
    else if (field === 'u') current.uid = value;
    else if (field === 'n') current.names.push(value);
    else if (field === 'f') { if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid file descriptor from lsof'); }
    else throw new Error('Unsupported lsof record');
  }
  finish();
  return { pids: [...pids], records, clients };
}

/** Parse a complete lsof result; exit 1 with valid rows is partial evidence of activity. */
export function parseNativeResourceResult(stdout, paths, { exitCode = 0, stderr = '' } = {}) {
  if (exitCode === 0) return { ...parseLsof(stdout, paths), partial: false };
  if (exitCode === 1 && stdout === '' && stderr === '') return { pids: [], records: 0, clients: [], partial: false };
  if (exitCode === 1 && typeof stdout === 'string' && stdout.length > 0 && stderr === '')
    return { ...parseLsof(stdout, paths), partial: true };
  throw new Error('Native profile resource inspection failed');
}

/** Read-only targeted check. Any uncertainty returns unknown, never idle. */
export async function observeAuditProfileIdle(profile, { reservationOwner, inspectResources = inspectNativeResourcesDefault } = {}) {
  if (!profile || typeof profile.home !== 'string' || typeof profile.reservationRoot !== 'string'
    || typeof inspectResources !== 'function') return { status: 'unknown', reason: 'invalid-profile-selection' };
  const lockPath = join(profile.reservationRoot, '.run-lock');
  try {
    const lock = await lstat(lockPath);
    if (lock.isSymbolicLink() || !lock.isDirectory() || lock.uid !== process.getuid() || (lock.mode & 0o077))
      return { status: 'busy', reason: 'profile-reservation-present' };
    if (reservationOwner === undefined) return { status: 'busy', reason: 'profile-reservation-present' };
    try {
      await privateDirectory(lockPath);
      const ownerPath = join(lockPath, 'owner.json');
      if (await realpath(ownerPath) !== ownerPath || !isDeepStrictEqual(await readJSON(ownerPath), reservationOwner))
        return { status: 'busy', reason: 'profile-reservation-present' };
    } catch { return { status: 'busy', reason: 'profile-reservation-present' }; }
  } catch (error) { if (error.code !== 'ENOENT') return { status: 'unknown', reason: 'reservation-inspection-failed' }; }

  const targets = ['config.toml', 'auth.json', 'state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm'].map(name => join(profile.home, name));
  const present = [];
  try {
    for (const path of targets) {
      let info;
      try { info = await lstat(path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(path) !== path) throw new Error('Unsafe resource path');
      present.push(path);
    }
    const observation = await inspectResources(present);
    const pids = Array.isArray(observation) ? observation : observation?.pids;
    if (!Array.isArray(pids) || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)
      || (!Array.isArray(observation) && (typeof observation.partial !== 'boolean'
        || !Number.isSafeInteger(observation.records) || observation.records < 0))) throw new Error('Invalid observer result');
    if (pids.length || (!Array.isArray(observation) && observation.partial && observation.records > 0))
      return { status: 'busy', reason: 'profile-files-open' };
    return { status: 'idle' };
  } catch { return { status: 'unknown', reason: 'resource-inspection-failed' }; }
}

function validProcessIdentity(row) {
  return row && Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.ppid >= 0
    && row.uid === process.getuid() && typeof row.startedAt === 'string' && Number.isFinite(Date.parse(row.startedAt))
    && typeof row.executable === 'string' && row.executable.startsWith('/') && !/[\x00-\x1f\x7f]/.test(row.executable);
}

function sameJournalProcessIdentitySet(before, after) {
  const key = row => JSON.stringify([row.pid, row.startedAt, row.uid, row.executable]);
  const beforeProcesses = new Set(before.processes.map(key)), afterProcesses = new Set(after.processes.map(key));
  return key(before.main) === key(after.main) && beforeProcesses.size === afterProcesses.size
    && [...beforeProcesses].every(identity => afterProcesses.has(identity));
}

async function readDesktopJournal(store, profile, owner) {
  if (!store || typeof store.directory !== 'string' || !isAbsolute(store.directory) || resolve(store.directory) !== store.directory
    || owner?.kind !== 'desktop-instance' || owner.host !== hostname() || owner.profileId !== profile.profileId
    || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.runId !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(owner.runId) || owner.storePath !== store.directory) return null;
  const expectedRoot = join(store.directory, 'desktop-instances');
  const expectedPath = join(expectedRoot, `${profile.profileId}.json`);
  if (owner.journalPath !== expectedPath) return null;
  try {
    await privateDirectory(expectedRoot);
    if (await realpath(expectedPath) !== expectedPath) return null;
    const info = await lstat(expectedPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077)) return null;
    const state = await readJSON(expectedPath);
    if (state?.schemaVersion !== 1 || state.kind !== 'desktop-instance' || state.profileId !== profile.profileId
      || state.phase !== 'running' || state.owner?.kind !== 'desktop-instance'
      || !isDeepStrictEqual(state.owner, owner) || state.plan?.profileId !== profile.profileId
      || state.plan?.nativeRoot !== profile.nativeRoot || state.plan?.home !== profile.home
      || !validProcessIdentity(state.main) || !Array.isArray(state.processes)
      || !state.processes.every(validProcessIdentity)) return null;
    return { state, owner };
  } catch { return null; }
}

/** Read-only preflight for running Codex homes. It accepts ordinary open resources and
 * only trusts an existing reservation when the exact running desktop journal owns it. */
export async function observeAuditProfileAccess(profile, { store, expectedClients = [], inspectResources = inspectNativeResourcesDefault,
  processSnapshot = () => createDesktopInstanceRuntime().snapshot() } = {}) {
  if (!profile || typeof profile.home !== 'string' || typeof profile.reservationRoot !== 'string'
    || typeof inspectResources !== 'function' || typeof processSnapshot !== 'function')
    return { status: 'unavailable', reason: 'invalid-profile-selection', clients: [], sourceReservation: null };
  try {
    // The built-in ~/.codex directory is commonly mode 0755; the existing
    // safety contract only forbids group/world write access there. Named
    // profile native roots and homes remain strictly private.
    const homeInfo = await canonicalDirectory(profile.home, 'Selected Codex home', { privateOnly: Boolean(profile.nativeRoot) });
    if (profile.nativeRoot) {
      await canonicalDirectory(profile.nativeRoot, 'Selected native root', { privateOnly: true });
      if (profile.home !== join(profile.nativeRoot, 'codex-home') || profile.reservationRoot !== profile.nativeRoot)
        throw new Error('Selected native home identity is inconsistent');
    } else if (profile.reservationRoot !== profile.home) throw new Error('Selected default home identity is inconsistent');
    void homeInfo;
    const lockPath = join(profile.reservationRoot, '.run-lock');
    let sourceReservation = null, trustedOwner = null;
    try {
      const lock = await lstat(lockPath);
      if (lock.isSymbolicLink() || !lock.isDirectory() || lock.uid !== process.getuid() || (lock.mode & 0o077))
        return { status: 'blocked', reason: 'profile-reservation-untrusted', clients: [], sourceReservation: { status: 'untrusted' } };
      let owner;
      try {
        await privateDirectory(lockPath);
        const ownerPath = join(lockPath, 'owner.json');
        if (await realpath(ownerPath) !== ownerPath) throw new Error('unsafe');
        owner = await readJSON(ownerPath);
      } catch {
        return { status: 'blocked', reason: 'profile-reservation-untrusted', clients: [], sourceReservation: { status: 'untrusted' } };
      }
      const journal = await readDesktopJournal(store, profile, owner);
      if (!journal) return { status: 'blocked', reason: 'profile-reservation-foreign', clients: [], sourceReservation: { status: 'foreign' } };
      trustedOwner = owner;
      sourceReservation = { kind: 'desktop-instance', runId: owner.runId, profileId: owner.profileId,
        host: owner.host, journalPath: owner.journalPath, phase: 'running' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const targets = ['config.toml', 'auth.json', 'state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm']
      .map(name => join(profile.home, name));
    const present = [];
    for (const path of targets) {
      let info;
      try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(path) !== path)
        throw new Error('Unsafe resource path');
      present.push(path);
    }
    const observed = await inspectResources(present);
    const pids = Array.isArray(observed) ? observed : observed?.pids;
    if (!Array.isArray(pids) || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)
      || (!Array.isArray(observed) && (typeof observed.partial !== 'boolean'
        || !Number.isSafeInteger(observed.records) || observed.records < 0))) throw new Error('Invalid resource observation');
    if (!Array.isArray(observed) && observed.partial && observed.records > 0) throw new Error('Partial resource observation');
    if (!Array.isArray(expectedClients) || expectedClients.some(row => !validProcessIdentity(row)))
      throw new Error('Invalid expected client identities');
    const initialJournal = sourceReservation ? await readDesktopJournal(store, profile, trustedOwner) : null;
    if (sourceReservation && !initialJournal) throw new Error('Desktop journal changed during inspection');
    const trackedPids = new Set([...pids, ...expectedClients.map(row => row.pid),
      ...(initialJournal ? [initialJournal.state.main, ...initialJournal.state.processes].map(row => row.pid) : [])]);
    const rows = trackedPids.size ? await processSnapshot() : [];
    if (!Array.isArray(rows)) throw new Error('Invalid process snapshot');
    const byPid = new Map(rows.filter(validProcessIdentity).map(row => [row.pid, row]));
    const holders = pids.map(pid => byPid.get(pid));
    if (holders.some(client => !client)) throw new Error('Resource holder identity unavailable');
    const liveExpected = expectedClients.map(expected => byPid.get(expected.pid)).filter(Boolean);
    const liveJournal = initialJournal ? [initialJournal.state.main, ...initialJournal.state.processes]
      .map(expected => ({ expected, current: byPid.get(expected.pid) })).filter(({ expected, current }) => current && current
        .startedAt === expected.startedAt && current.uid === expected.uid && current.executable === expected.executable)
      .map(({ current }) => current) : [];
    const uniqueClients = [...new Map([...holders, ...liveExpected, ...liveJournal]
      .map(row => [`${row.pid}:${row.startedAt}:${row.uid}:${row.executable}`, row])).values()];
    if (sourceReservation) {
      const lock = await lstat(lockPath);
      if (lock.isSymbolicLink() || !lock.isDirectory() || lock.uid !== process.getuid() || (lock.mode & 0o077)
        || !isDeepStrictEqual(await readJSON(join(lockPath, 'owner.json')), trustedOwner))
        throw new Error('Desktop reservation changed during inspection');
      const journal = await readDesktopJournal(store, profile, trustedOwner);
      if (!journal) throw new Error('Desktop ownership journal changed during inspection');
      if (!sameJournalProcessIdentitySet(initialJournal.state, journal.state))
        throw new Error('Desktop process ownership changed during inspection');
      const state = journal.state;
      const liveMain = byPid.get(state.main.pid);
      const journalProcesses = [state.main, ...state.processes];
      const exactLiveOwned = journalProcesses.filter(expected => {
        const current = byPid.get(expected.pid);
        return current && current.startedAt === expected.startedAt && current.uid === expected.uid
          && current.executable === expected.executable;
      });
      const mainIsLive = liveMain && liveMain.startedAt === state.main.startedAt && liveMain.uid === state.main.uid
        && liveMain.executable === state.main.executable;
      if (!mainIsLive) {
        // A valid but stale desktop journal can be observed without taking its
        // reservation when every recorded process is absent/reused and no
        // process currently holds profile resources. The lock and journal are
        // preserved byte-for-byte; any live helper or resource holder blocks.
        if (exactLiveOwned.length || pids.length)
          return { status: 'blocked', reason: 'desktop-main-not-live', clients: uniqueClients, sourceReservation };
        return { status: 'ready', clients: [], sourceReservation: { ...sourceReservation, phase: 'stopped-owner-observed' } };
      }
      const owned = new Set(journalProcesses.map(row => `${row.pid}:${row.startedAt}:${row.uid}:${row.executable}`));
      if (holders.some(row => !owned.has(`${row.pid}:${row.startedAt}:${row.uid}:${row.executable}`)))
        return { status: 'blocked', reason: 'unattributed-native-client', clients: uniqueClients, sourceReservation };
    }
    return { status: 'ready', clients: uniqueClients, sourceReservation };
  } catch {
    return { status: 'unavailable', reason: 'profile-access-inspection-failed', clients: [], sourceReservation: null };
  }
}

function selectedSettingRoots(profile) {
  return [
    { root: profile.home, label: '$CODEX_HOME' },
    ...(profile.userHome !== profile.home ? [{ root: profile.userHome, label: '$HOME' }] : []),
  ];
}

function insideRoot(path, root) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function withinOrEqual(path, root) { return path === root || insideRoot(path, root); }

async function collectSettingMetadata(roots, profile) {
  const records = new Map();
  let files = 0;
  const authorizedRoots = [...new Set([...roots.map(item => item.root), profile.nativeRoot].filter(Boolean))];
  for (const root of authorizedRoots) await canonicalDirectory(root, 'Authorized settings root');
  const fail = (message, auditReason = 'settings-source-unavailable') => { throw Object.assign(new Error(message), { auditReason }); };
  const walk = async (root, absolute, logical, depth = 0, ancestors = new Set(),
    { observational = false, skillSource = false, packageBoundary = null } = {}) => {
    if (depth > MAX_SETTINGS_DEPTH) throw new Error('Settings source exceeds the directory depth limit');
    let info;
    try { info = await lstat(absolute); }
    catch (error) { if (error.code === 'ENOENT') { records.set(logical, 'missing'); return; } throw error; }
    if (info.isSymbolicLink()) {
      const linkTarget = await readlink(absolute), target = await realpath(absolute);
      const targetInfo = await lstat(target);
      if (!targetInfo.isDirectory() && !targetInfo.isFile()) fail('Settings symlink target is not a regular file or directory', 'settings-symlink-target-unsafe');
      if (targetInfo.mode & 0o022) fail('Settings symlink target is writable by other users', 'settings-symlink-target-unsafe');
      const authorized = authorizedRoots.some(candidate => insideRoot(target, candidate));
      const withinPackage = packageBoundary && insideRoot(target, packageBoundary);
      let nextPackageBoundary = packageBoundary;
      if (!authorized && !withinPackage) {
        if (!skillSource || target === sep || authorizedRoots.some(candidate => withinOrEqual(candidate, target)))
          fail('Settings symlink target is outside authorized roots', 'settings-symlink-outside-authorized-roots');
        if (targetInfo.isFile() && logical.split('/').at(-1) !== 'SKILL.md')
          fail('External skill file links must target SKILL.md', 'settings-symlink-outside-authorized-roots');
        if (targetInfo.isDirectory()) {
          const marker = join(target, 'SKILL.md');
          let markerInfo;
          try { markerInfo = await lstat(marker); } catch { fail('External skill package has no readable SKILL.md marker', 'settings-symlink-outside-authorized-roots'); }
          if (!markerInfo.isFile() || markerInfo.isSymbolicLink())
            fail('External skill package marker is not a regular file', 'settings-symlink-target-unsafe');
          nextPackageBoundary = target;
        }
      }
      if (skillSource && targetInfo.isDirectory() && !nextPackageBoundary) nextPackageBoundary = target;
      records.set(`${logical}/@symlink`, JSON.stringify([linkTarget, info.dev, info.ino, info.mtimeMs, info.ctimeMs,
        target, targetInfo.dev, targetInfo.ino, targetInfo.size, targetInfo.mtimeMs, targetInfo.ctimeMs]));
      if (targetInfo.isDirectory()) {
        if (ancestors.has(target)) fail('Settings symlink cycle', 'settings-symlink-cycle');
        await walk(root, target, logical, depth + 1, ancestors,
          { observational: true, skillSource, packageBoundary: nextPackageBoundary });
      } else {
        files += 1;
        if (files > MAX_SETTINGS_FILES) throw new Error('Settings source exceeds the file limit');
      }
      return;
    }
    if (info.isFile()) {
      if ((!observational && (info.nlink !== 1 || info.uid !== process.getuid())) || (info.mode & 0o022))
        throw new Error('Settings source file is unsafe');
      files += 1;
      if (files > MAX_SETTINGS_FILES) throw new Error('Settings source exceeds the file limit');
      records.set(logical, JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode & 0o777]));
      return;
    }
    if (!info.isDirectory() || await realpath(absolute) !== absolute
      || (!observational && info.uid !== process.getuid()) || (info.mode & 0o022))
      throw new Error('Settings source directory is unsafe');
    const canonical = await realpath(absolute);
    if (ancestors.has(canonical)) throw Object.assign(new Error('Settings directory cycle'), { auditReason: 'settings-symlink-cycle' });
    const nextAncestors = new Set(ancestors); nextAncestors.add(canonical);
    const { opendir } = await import('node:fs/promises');
    const dir = await opendir(absolute), entries = [];
    for await (const entry of dir) entries.push(entry.name);
    entries.sort();
    if (entries.length > MAX_SETTINGS_FILES) throw new Error('Settings source exceeds the directory limit');
    for (const name of entries) await walk(root, join(absolute, name), `${logical}/${name}`, depth + 1, nextAncestors,
      { observational, skillSource, packageBoundary });
  };
  for (const { root, label } of roots) {
    await canonicalDirectory(root, 'Settings root');
    for (const name of ['config.toml', 'AGENTS.md', 'AGENTS.override.md', ...(label === '$CODEX_HOME' ? ['auth.json'] : [])]) await walk(root, join(root, name), `${label}/${name}`);
    for (const name of ['agents', 'skills', 'rules']) await walk(root, join(root, name), `${label}/${name}`, 0, new Set(), { skillSource: name === 'skills' });
    if (label === '$HOME') await walk(root, join(root, '.agents', 'skills'), `${label}/.agents/skills`, 0, new Set(), { skillSource: true });
  }
  return records;
}

/** Capture private file-stat fingerprints only; no configuration or instruction bodies are read. */
export async function snapshotAuditProfileSettings(profile) {
  // Detailed records remain process-local. A series may persist the explicit
  // metadata-only continuity token below; ordinary run recovery has no such token.
  const snapshot = { status: 'ready', persistence: 'process-local', capturedAt: new Date().toISOString() };
  try { settingsBySnapshot.set(snapshot, { status: 'ready', records: await collectSettingMetadata(selectedSettingRoots(profile), profile) }); }
  catch (error) {
    snapshot.status = 'unavailable';
    snapshot.reason = error.auditReason ?? 'settings-source-unavailable';
    settingsBySnapshot.set(snapshot, { status: 'unavailable' });
  }
  return snapshot;
}

/** Compare two opaque settings snapshots without exposing fingerprints. */
export function compareAuditProfileSettings(before, after) {
  const left = before && typeof before === 'object' ? settingsBySnapshot.get(before) : null;
  const right = after && typeof after === 'object' ? settingsBySnapshot.get(after) : null;
  if (!left || !right || left.status !== 'ready' || right.status !== 'ready')
    return { status: 'unavailable', changedPaths: [] };
  const changedPaths = [...new Set([...left.records.keys(), ...right.records.keys()])]
    .filter(path => left.records.get(path) !== right.records.get(path)).sort();
  return { status: changedPaths.length ? 'changed' : 'unchanged', changedPaths };
}

/** Private continuity token over file-stat metadata only; never reads or hashes credential bodies. */
export function auditSettingsIdentity(snapshot) {
  const saved = snapshot && settingsBySnapshot.get(snapshot);
  if (saved?.status !== 'ready') return null;
  const entries = [...saved.records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { algorithm: 'sha256-file-stat-metadata-v1', digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
