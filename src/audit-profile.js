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
import { find } from './profiles.js';
import { copilotSettingMetadata, qualifiedCopilotRoute, resolveCopilotProfile } from './copilot-profile.js';
import { CLAUDE_CLIENT, resolveClaudeProfile } from './claude-profile.js';
import { launchPlan, discoverCodexExecutable } from './launcher.js';
import { resolveHome } from './homes.js';
import { nativePath } from './node-runtime.js';
import { privateDirectory, readJSON } from './metadata.js';
import { createDesktopInstanceRuntime, matchesProcessIdentity, processIdentity } from './desktop-instance-runtime.js';
import { hostname } from 'node:os';
import { observeAuditProcess } from './audit-process.js';
import { isNativeCliParticipant, profileOwners } from './profile-reservations.js';
import { observeCodexCli, observeManagedCli, readCliReport } from './native-participants.js';
import { probeAuditVersion } from './audit-native-version.js';
import { validateAuditNativeConfig } from './audit-spec.js';
import { createEnvironmentBinding, assertEnvironmentBinding } from './client-contracts.js';

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

async function safeConfig(home, { allowMissing = false } = {}) {
  const path = join(home, 'config.toml');
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') return {};
    throw new Error('Codex configuration is unavailable or unsafe');
  }
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

async function defaultProfile(name, { repository, defaultUserHome, allowUntrustedRepository }) {
  const userHome = resolve(defaultUserHome);
  await canonicalDirectory(userHome, 'Default user home');
  const home = join(userHome, '.codex');
  await canonicalDirectory(home, 'Default Codex home');
  if (typeof repository !== 'string' || !repository.trim()) throw new Error('Default profile audit requires a selected repository');
  const bindingRepository = await realpath(repository);
  await canonicalDirectory(bindingRepository, 'Audit repository');
  const config = await safeConfig(home, { allowMissing: allowUntrustedRepository });
  if (!allowUntrustedRepository && config.projects?.[bindingRepository]?.trust_level !== 'trusted')
    throw new Error('Default profile audit requires an existing trusted repository entry in config.toml');
  return { profileId: 'default', profileName: 'Default', home, userHome, nativeRoot: null,
    reservationRoot: home, environmentId: null, bindingRepository };
}

async function selectedClient(store, selection) {
  const selected = selection.name.trim().toLowerCase() === 'default' ? null : find(await store.read(), selection.name);
  const client = selected ? selected.client ?? 'codex' : selection.client ?? 'codex';
  if (!['codex', 'claude-code', 'copilot'].includes(client)) throw new Error('Unknown native profile client');
  if (selection.client !== undefined && selection.client !== client)
    throw new Error('Selected client does not match the persisted profile');
  return { client, selected };
}

async function resolveNonCodexProfile(selection, { client, selected }, options) {
  if (['executable', 'version', 'nativeConfig'].some(key => selection[key] !== undefined) || selection.skills?.length)
    throw new Error('Use the bound native executable and settings for this client');
  const resolveClient = { [CLAUDE_CLIENT]: resolveClaudeProfile, copilot: resolveCopilotProfile, ...options.profileResolvers }[client];
  if (typeof resolveClient !== 'function') throw new Error(`No CLI profile resolver is available for ${client}`);
  const profile = { ...await resolveClient({ selected, ...options }), executionMode: 'profile' };
  if (profile.client !== client || profile.profileId !== (selected?.id ?? `default-${client}`))
    throw new Error('Native profile resolution changed its selected identity');
  if (client === 'copilot' && profile.rootMode === 'explicit'
    && !qualifiedCopilotRoute(profile.environmentBinding, profile.accountQualification))
    throw Object.assign(new Error('The selected Copilot root has no verified account scope.'), { code: 'copilot-account-unverified' });
  profile.settingsSnapshot = await snapshotAuditProfileSettings(profile);
  profile.settingsIdentity = auditSettingsIdentity(profile.settingsSnapshot);
  if (!profile.settingsIdentity) throw settingsInspectionError(profile.settingsSnapshot.reason);
  profile.environmentBinding = createEnvironmentBinding({
    client, surface: profile.surface, executionLocation: profile.executionLocation, profileId: profile.profileId, rootMode: profile.rootMode,
    roots: { config: profile.home, runtime: profile.nativeRoot ? profile.home : null,
      user: profile.userHome, reservation: profile.reservationRoot },
    workspace: profile.cwd, executable: { path: profile.executable, identity: profile.executableIdentity,
      version: profile.version }, settingsIdentity: profile.settingsIdentity,
  });
  return profile;
}

/** Resolve one explicit profile to a launch-ready, credential-minimal environment. */
export async function resolveAuditExecutionProfile(store, input, { repository, defaultUserHome = homedir(), probe = probeAuditVersion,
  terminalEnvironment = process.env, profileResolvers, allowUntrustedRepository = false } = {}) {
  const selection = selectionOf(input);
  const route = await selectedClient(store, selection);
  if (route.client !== 'codex') return resolveNonCodexProfile(selection, route,
    { repository, defaultUserHome, terminalEnvironment, profileResolvers, sessionOnly: false });
  const isDefault = selection.name.trim().toLowerCase() === 'default';
  let profile;
  if (isDefault) profile = await defaultProfile(selection.name, { repository, defaultUserHome, allowUntrustedRepository });
  else {
    const plan = await launchPlan(store, selection.name, terminalEnvironment, { repository });
    const resolved = await resolveHome(store, selection.name);
    profile = { profileId: plan.profileId, profileName: plan.name, home: plan.home,
      userHome: resolved.environment.launch.env.HOME, nativeRoot: plan.nativeRoot,
      reservationRoot: plan.nativeRoot, environmentId: plan.environmentId,
      bindingRepository: repository === undefined ? null : plan.cwd,
      _nativeExecutable: plan.executable,
      _nativeIdentity: plan.executableIdentity, _nativeEnv: plan.env };
  }

  let binary;
  if (selection.executable !== undefined) binary = await executableInfo(selection.executable);
  else if (profile._nativeExecutable) binary = { executable: profile._nativeExecutable,
    executableIdentity: profile._nativeIdentity };
  else binary = await discoverCodexExecutable(terminalEnvironment);

  const env = profile._nativeEnv ? { ...profile._nativeEnv } : {
    PATH: nativePath(terminalEnvironment), HOME: profile.userHome, CODEX_HOME: profile.home,
    CODEX_SQLITE_HOME: profile.home, TMPDIR: profile.home, TMP: profile.home, TEMP: profile.home,
  };
  // Do not carry arbitrary variables from the invoking process into Codex.
  const allowed = new Set(['PATH', 'HOME', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'TMPDIR', 'TMP', 'TEMP']);
  for (const key of Object.keys(env)) if (!allowed.has(key)) delete env[key];
  env.PATH = nativePath({ PATH: env.PATH });
  env.HOME = profile.userHome; env.CODEX_HOME = profile.home; env.CODEX_SQLITE_HOME = profile.home;
  let version = null;
  let versionSource = 'unavailable';
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
    client: 'codex', surface: 'cli', executionLocation: 'local', rootMode: 'explicit',
    home: profile.home, userHome: profile.userHome, nativeRoot: profile.nativeRoot,
    reservationRoot: profile.reservationRoot, environmentId: profile.environmentId,
    executable: binary.executable, executableIdentity: binary.executableIdentity, version,
    executableSource: selection.executable === undefined ? 'path' : 'explicit-per-trial',
    versionSource, ...(selection.version !== undefined ? { requestedVersion: selection.version } : {}),
    env, bindingRepository: profile.bindingRepository,
    ...(selection.nativeConfig !== undefined ? { nativeConfig: { ...selection.nativeConfig } } : {}),
    ...(selection.skills ? { skills: [...selection.skills] } : {}) };
  return result;
}

/** Resolve ordinary native execution without probing the executable or changing profile settings. */
export async function resolveProfileExecutionProfile(store, input, {
  repository, defaultUserHome = homedir(), terminalEnvironment = process.env, profileResolvers, sessionOnly = false, allowUntrustedRepository = false,
} = {}) {
  const selection = typeof input === 'string' ? { name: input } : input;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || typeof selection.name !== 'string' || !selection.name.trim()
    || Object.keys(selection).some(key => !['name', 'client'].includes(key)))
    throw new Error('Select a profile without execution overrides');
  const route = await selectedClient(store, selection);
  if (route.client !== 'codex') return resolveNonCodexProfile(selection, route,
    { repository, defaultUserHome, terminalEnvironment, profileResolvers, sessionOnly });
  const isDefault = selection.name.trim().toLowerCase() === 'default';
  let profile;
  if (isDefault) {
    profile = await defaultProfile(selection.name, { repository, defaultUserHome, allowUntrustedRepository });
    const binary = await discoverCodexExecutable(terminalEnvironment);
    profile.executable = binary.executable;
    profile.executableIdentity = binary.executableIdentity;
    profile.version = null;
    profile.executableSource = 'path';
    profile.versionSource = 'unavailable';
    profile.cwd = profile.bindingRepository;
    profile.env = { PATH: nativePath(terminalEnvironment), HOME: profile.userHome, CODEX_HOME: profile.home };
  } else {
    const plan = await launchPlan(store, selection.name, terminalEnvironment, { repository });
    profile = { profileId: plan.profileId, profileName: plan.name, home: plan.home,
      userHome: plan.env.HOME, nativeRoot: plan.nativeRoot, reservationRoot: plan.nativeRoot,
      environmentId: plan.environmentId, executable: plan.executable,
      executableIdentity: plan.executableIdentity, version: plan.version,
      executableSource: 'path', versionSource: 'unavailable',
      env: plan.env, cwd: plan.cwd, bindingRepository: repository === undefined ? null : plan.cwd };
  }
  profile.executionMode = 'profile';
  if (!isDefault) profile.launchArgs = ['-c', `sqlite_home=${JSON.stringify(profile.home)}`];
  profile.settingsSnapshot = await snapshotAuditProfileSettings(profile);
  if (profile.settingsSnapshot.status !== 'ready') throw settingsInspectionError(profile.settingsSnapshot.reason);
  profile.settingsIdentity = auditSettingsIdentity(profile.settingsSnapshot);
  profile.client = 'codex';
  profile.surface = 'cli';
  profile.executionLocation = 'local';
  // Default also sends CODEX_HOME explicitly; identical paths do not imply implicit routing.
  profile.rootMode = 'explicit';
  profile.environmentBinding = createEnvironmentBinding({
    client: profile.client, surface: profile.surface, executionLocation: profile.executionLocation,
    profileId: profile.profileId, rootMode: profile.rootMode,
    roots: { config: profile.home, runtime: isDefault ? null : profile.home,
      user: profile.userHome, reservation: profile.reservationRoot },
    workspace: profile.cwd, executable: { path: profile.executable,
      identity: profile.executableIdentity, version: profile.version }, settingsIdentity: profile.settingsIdentity,
  });
  return profile;
}

/** Recheck the preview immediately before Start; no task or version probe is run. */
export async function recheckProfileExecutionProfile(store, preview, options = {}) {
  const fresh = await resolveProfileExecutionProfile(store, { name: preview?.profileName, ...(preview?.client ? { client: preview.client } : {}) }, options);
  const fields = ['profileId', 'home', 'userHome', 'nativeRoot', 'reservationRoot', 'environmentId',
    'executable', 'executableIdentity', 'cwd', 'bindingRepository', 'client', 'surface', 'executionLocation', 'rootMode'];
  if (!preview || fields.some(key => preview[key] !== fresh[key])
    || !isDeepStrictEqual(preview.accountQualification, fresh.accountQualification)
    || !isDeepStrictEqual(preview.env, fresh.env) || !isDeepStrictEqual(preview.launchArgs, fresh.launchArgs))
    throw Object.assign(new Error('Selected profile or launch environment changed after preview'), { code: 'profile-preview-changed' });
  let settings = compareAuditProfileSettings(preview.settingsSnapshot, fresh.settingsSnapshot);
  if (settings.status === 'unavailable' && preview?.settingsIdentity && fresh.settingsIdentity) {
    settings = { status: isDeepStrictEqual(preview.settingsIdentity, fresh.settingsIdentity) ? 'unchanged' : 'changed' };
  }
  if (settings.status !== 'unchanged')
    throw Object.assign(new Error(settings.status === 'changed'
      ? 'Selected profile settings changed after preview' : 'Selected profile settings could not be rechecked'),
    { code: settings.status === 'changed' ? 'profile-settings-changed' : 'profile-settings-unavailable' });
  try { assertEnvironmentBinding(preview.environmentBinding, fresh.environmentBinding); }
  catch (cause) {
    throw Object.assign(new Error('Selected environment binding changed after preview', { cause }),
      { code: 'profile-preview-changed' });
  }
  const access = await observeAuditProfileAccess(fresh, { store, ...(options.accessOptions ?? {}) });
  if (access.status !== 'ready') {
    const unavailable = access.status === 'unavailable';
    throw Object.assign(new Error(unavailable
      ? 'Selected profile access could not be verified; review the profile and try again'
      : `Selected profile access is blocked (${access.reason}). Observed client PIDs: ${access.clients.map(row => row.pid).join(', ') || 'none'}`),
    { code: unavailable ? 'profile-access-unavailable' : 'profile-access-blocked', accessReason: access.reason });
  }
  fresh.desktopOwner = access.desktopOwner ?? null;
  return fresh;
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

async function readDesktopJournal(profile, owner) {
  const store = { directory: owner?.storePath };
  if (typeof store.directory !== 'string' || !isAbsolute(store.directory) || resolve(store.directory) !== store.directory
    || owner?.kind !== 'desktop-instance' || owner.host !== hostname() || !/^[a-f0-9-]{36}$/i.test(owner.profileId ?? '')
    || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.runId !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(owner.runId) || owner.storePath !== store.directory) return null;
  const expectedRoot = join(store.directory, 'desktop-instances');
  const expectedPath = join(expectedRoot, `${owner.profileId}.json`);
  if (owner.journalPath !== expectedPath) return null;
  try {
    await privateDirectory(store.directory);
    await privateDirectory(expectedRoot);
    if (await realpath(expectedPath) !== expectedPath) return null;
    const info = await lstat(expectedPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077)) return null;
    const state = await readJSON(expectedPath);
    if (state?.schemaVersion !== 1 || state.kind !== 'desktop-instance' || state.profileId !== owner.profileId
      || state.phase !== 'running' || state.owner?.kind !== 'desktop-instance'
      || !isDeepStrictEqual(state.owner, owner) || state.plan?.profileId !== owner.profileId
      || state.plan?.nativeRoot !== profile.nativeRoot || state.plan?.home !== profile.home
      || !validProcessIdentity(state.main) || !Array.isArray(state.processes)
      || !state.processes.every(validProcessIdentity)) return null;
    return { state, owner };
  } catch { return null; }
}

async function readAuditParticipantJournal(profile, owner) {
  const catalog = owner.kind === 'catalog-probe', review = owner.kind === 'review-task';
  if (typeof owner.storePath !== 'string' || !isAbsolute(owner.storePath) || resolve(owner.storePath) !== owner.storePath)
    return null;
  const parent = join(owner.storePath, catalog ? 'catalog-probes' : review ? 'review-tasks' : 'audits');
  const directory = join(parent, owner.runId);
  try {
    await privateDirectory(owner.storePath);
    await privateDirectory(parent);
    await privateDirectory(directory);
    const journal = await readJSON(join(directory, catalog ? 'probe.json' : review ? 'task.json' : 'state.json'));
    const reservation = catalog ? journal : journal.reservation;
    if (journal.id !== owner.runId || reservation?.root !== profile.reservationRoot
      || !isDeepStrictEqual(reservation.owner, owner)
      || catalog && (journal.kind !== 'xfx-catalog-probe' || journal.schemaVersion !== 1 || journal.released
        || journal.environmentBinding?.roots?.reservation !== reservation.root)) return null;
    return journal;
  } catch { return null; }
}

/** Read-only preflight for native homes, including verified shared execution reservations. */
export async function observeAuditProfileAccess(profile, options = {}) {
  // SQLite sidecars and short-lived native helpers can change during inspection.
  // Admit only after a complete fresh observation succeeds.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { retryable, ...result } = await inspectAuditProfileAccess(profile, options);
    const transient = retryable || result.reason === 'unattributed-native-client';
    if (!transient || attempt === 2) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function inspectAuditProfileAccess(profile, { allowInteractivePeers = false, expectedClients = [], inspectResources = inspectNativeResourcesDefault,
  processSnapshot = () => createDesktopInstanceRuntime().snapshot(), observeParticipantProcess = observeAuditProcess } = {}) {
  if (!profile || typeof profile.home !== 'string' || typeof profile.reservationRoot !== 'string'
    || typeof inspectResources !== 'function' || typeof processSnapshot !== 'function' || typeof observeParticipantProcess !== 'function')
    return { status: 'unavailable', reason: 'invalid-profile-selection', clients: [], sourceReservation: null };
  try {
    // The built-in ~/.codex directory is commonly mode 0755; the existing
    // safety contract only forbids group/world write access there. Named
    // profile native roots and homes remain strictly private.
    const codex = !profile.client || profile.client === 'codex';
    const homeInfo = await canonicalDirectory(profile.home, 'Selected configuration root', { privateOnly: Boolean(profile.nativeRoot) });
    if (profile.nativeRoot) {
      await canonicalDirectory(profile.nativeRoot, 'Selected native root', { privateOnly: true });
      if ((codex ? profile.home !== join(profile.nativeRoot, 'codex-home') : !insideRoot(profile.home, profile.nativeRoot))
        || profile.reservationRoot !== profile.nativeRoot)
        throw new Error('Selected native home identity is inconsistent');
    } else if (profile.reservationRoot !== profile.home) throw new Error('Selected default home identity is inconsistent');
    void homeInfo;
    const lockPath = join(profile.reservationRoot, '.run-lock');
    const client = profile.client ?? 'codex';
    let sourceReservation = null, desktopOwner = null, cliOwner = null, cliReport = null, participants = [];
    const foreign = { status: 'blocked', reason: 'profile-reservation-foreign', clients: [], sourceReservation: { status: 'foreign' } };
    try {
      const lock = await lstat(lockPath);
      if (lock.isSymbolicLink() || !lock.isDirectory() || lock.uid !== process.getuid() || (lock.mode & 0o077))
        return { status: 'blocked', reason: 'profile-reservation-untrusted', clients: [], sourceReservation: { status: 'untrusted' } };
      try {
        await privateDirectory(lockPath);
        const ownerPath = join(lockPath, 'owner.json');
        if (await realpath(ownerPath) !== ownerPath) throw new Error('unsafe');
        const owners = profileOwners(await readJSON(ownerPath));
        desktopOwner = owners.find(value => value?.kind === 'desktop-instance');
        cliOwner = allowInteractivePeers ? owners.find(value => isNativeCliParticipant(value, client)) : undefined;
        participants = owners.filter(value => value !== desktopOwner && value !== cliOwner);
        if (participants.some(value => !['audit-experiment', 'review-task', 'catalog-probe'].includes(value?.kind)
          || value.home !== profile.home || value.host !== hostname() || !/^[a-f0-9-]{36}$/i.test(value.runId ?? '')
          || value.kind === 'catalog-probe' && value.membershipVersion !== 1)) return foreign;
      } catch {
        return { status: 'blocked', reason: 'profile-reservation-untrusted', clients: [], sourceReservation: { status: 'untrusted' } };
      }
      if (desktopOwner) {
        if (!codex || !await readDesktopJournal(profile, desktopOwner)) return foreign;
        const { kind, runId, profileId, host, journalPath } = desktopOwner;
        sourceReservation = { kind, runId, profileId, host, journalPath, phase: 'running' };
      }
      if (cliOwner) {
        if (!profile.nativeRoot) return foreign;
        try {
          await privateDirectory(cliOwner.storePath);
          cliReport = await readCliReport({ directory: cliOwner.storePath }, profile, cliOwner, client);
        } catch { return foreign; }
        const { kind, runId, profileId, host, reportPath } = cliOwner;
        sourceReservation ??= { kind, runId, profileId, host, reportPath, phase: 'running' };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const targets = codex ? ['config.toml', 'auth.json', 'state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm']
      .map(name => join(profile.home, name))
      : profile.client === 'copilot' ? ['config.json', 'settings.json', 'mcp-config.json'].map(name => join(profile.home, name))
        : [join(profile.home, 'settings.json'), join(profile.rootMode === 'implicit' ? profile.userHome : profile.home, '.claude.json')];
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
    const initialJournal = desktopOwner ? await readDesktopJournal(profile, desktopOwner) : null;
    if (desktopOwner && !initialJournal) throw new Error('Desktop journal changed during inspection');
    const trackedPids = new Set([...pids, ...expectedClients.map(row => row.pid),
      ...(initialJournal ? [initialJournal.state.main, ...initialJournal.state.processes].map(row => row.pid) : [])]);
    const rows = trackedPids.size || cliOwner ? await processSnapshot() : [];
    if (!Array.isArray(rows)) throw new Error('Invalid process snapshot');
    const runtime = createDesktopInstanceRuntime({ processSnapshot: async () => rows });
    const observe = (main, options) => runtime.observe(main, { ...options, allowAncestor: allowInteractivePeers });
    const byPid = new Map(rows.filter(validProcessIdentity).map(row => [row.pid, row]));
    let cliProcesses = [];
    if (cliOwner) {
      const controller = { directory: cliOwner.storePath }, observeCli = codex ? observeCodexCli : observeManagedCli;
      try {
        cliProcesses = (await observeCli(controller, profile, cliOwner, { observe }, { joining: true, resolveExecutable: true })).processes;
        if (!isDeepStrictEqual(cliReport, await readCliReport(controller, profile, cliOwner, client)))
          throw new Error('Terminal journal changed during inspection');
      } catch {
        return { status: 'blocked', reason: 'cli-process-identity-unverified', clients: [], sourceReservation };
      }
      for (const row of cliProcesses) byPid.set(row.pid, row);
    }
    const holders = pids.map(pid => byPid.get(pid));
    if (holders.some(client => !client)) throw new Error('Resource holder identity unavailable');
    const ownedPids = new Set();
    for (const member of participants) {
      const catalog = member.kind === 'catalog-probe';
      if (!holders.length && !catalog) continue;
      const journal = await readAuditParticipantJournal(profile, member);
      if (!journal && catalog) return foreign;
      const expected = journal?.process?.processIdentity, current = byPid.get(expected?.pid);
      const running = expected && (current || catalog) && (await observeParticipantProcess(expected)).status === 'running';
      if (catalog && journal.shutdown?.groupTerminated !== true) {
        if (!['prepared', 'starting', 'running'].includes(journal.status) || journal.status === 'running' && !running
          || member.coordinatorIdentity?.pid !== member.pid || (await observeParticipantProcess(member.coordinatorIdentity)).status !== 'running')
          return foreign;
      }
      if (!current || !running || Date.parse(current.startedAt) !== Date.parse(expected.started)) continue;
      ownedPids.add(current.pid);
      // Only current descendants of the verified process can be attributed.
      let previous;
      do {
        previous = ownedPids.size;
        for (const row of byPid.values()) if (ownedPids.has(row.ppid)) ownedPids.add(row.pid);
      } while (ownedPids.size !== previous);
    }
    const externalHolders = holders.filter(row => !ownedPids.has(row.pid));
    const liveExpected = expectedClients.map(expected => byPid.get(expected.pid)).filter(Boolean);
    const liveJournal = initialJournal ? [initialJournal.state.main, ...initialJournal.state.processes]
      .map(expected => ({ expected, current: byPid.get(expected.pid) })).filter(({ expected, current }) => matchesProcessIdentity(current, expected))
      .map(({ current }) => current) : [];
    const cliMain = cliReport ? [byPid.get(cliReport.processIdentity.pid)] : [];
    const uniqueClients = [...new Map([...externalHolders, ...liveExpected, ...liveJournal, ...cliMain]
      .map(row => [processIdentity(row), row])).values()];
    const nativeOwners = [desktopOwner, cliOwner].filter(Boolean);
    if (nativeOwners.length) {
      await privateDirectory(lockPath);
      const current = profileOwners(await readJSON(join(lockPath, 'owner.json')))
        .filter(owner => !['audit-experiment', 'review-task', 'catalog-probe'].includes(owner?.kind));
      if (current.length !== nativeOwners.length || nativeOwners.some(expected => !current.some(owner => isDeepStrictEqual(owner, expected))))
        throw new Error('Native reservation changed during inspection');
    }
    let desktopProcesses = [];
    if (desktopOwner) {
      const journal = await readDesktopJournal(profile, desktopOwner);
      if (!journal) throw new Error('Desktop ownership journal changed during inspection');
      if (!sameJournalProcessIdentitySet(initialJournal.state, journal.state))
        throw new Error('Desktop process ownership changed during inspection');
      const state = journal.state;
      const liveMain = byPid.get(state.main.pid);
      const journalProcesses = [state.main, ...state.processes];
      if (!matchesProcessIdentity(liveMain, state.main)) {
        // A valid but stale desktop journal can be observed without taking its
        // reservation when every recorded process is absent/reused and no
        // process currently holds profile resources. The lock and journal are
        // preserved byte-for-byte; any live helper or resource holder blocks.
        if (journalProcesses.some(expected => matchesProcessIdentity(byPid.get(expected.pid), expected)) || externalHolders.length || cliOwner)
          return { status: 'blocked', reason: 'desktop-main-not-live', clients: uniqueClients, sourceReservation };
        return { status: 'ready', clients: [], sourceReservation: { ...sourceReservation, phase: 'stopped-owner-observed' }, nativeOwners: [] };
      }
      const current = await observe(state.main, { trackedProcesses: state.processes });
      if (current.status !== 'running' || current.orphaned)
        return { status: 'blocked', reason: 'desktop-process-identity-changed', clients: uniqueClients, sourceReservation };
      desktopProcesses = current.processes;
    }
    if (nativeOwners.length) {
      const owned = new Set([...desktopProcesses, ...cliProcesses].map(processIdentity));
      if (externalHolders.some(row => !owned.has(processIdentity(row))))
        return { status: 'blocked', reason: 'unattributed-native-client', clients: uniqueClients, sourceReservation };
    }
    const overlap = participants.map(({ kind, runId, experimentId }) => ({ kind, runId, experimentId }));
    return { status: 'ready', clients: uniqueClients, overlap, sourceReservation, nativeOwners, ...(desktopOwner ? { desktopOwner } : {}) };
  } catch (error) {
    return { status: 'unavailable', reason: 'profile-access-inspection-failed', clients: [], sourceReservation: null,
      retryable: error.code === 'ENOENT' || ['Partial resource observation', 'Resource holder identity unavailable'].includes(error.message) };
  }
}

async function selectedSettingRoots(profile) {
  const claude = profile.client === CLAUDE_CLIENT;
  const roots = [
    { root: profile.home, label: claude ? '$CLAUDE_CONFIG' : '$CODEX_HOME', ...(profile.executionMode === 'profile' ? { identity: true } : {}) },
    ...(profile.userHome !== profile.home ? [{ root: profile.userHome, label: '$HOME',
      ...(profile.executionMode === 'profile' ? { identity: true } : {}) }] : []),
  ];
  if (profile.executionMode !== 'profile' || typeof profile.cwd !== 'string') return roots;
  let current = profile.cwd, depth = 0;
  while (true) {
    let info;
    try {
      info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current
        || info.uid !== process.getuid() || (info.mode & 0o022)) {
        if (depth === 0) throw Object.assign(new Error('Selected workspace is unavailable or unsafe'), { auditReason: 'workspace-unavailable' });
        break;
      }
    } catch (error) {
      if (depth === 0) throw Object.assign(new Error('Selected workspace is unavailable or unsafe'),
        { cause: error, auditReason: 'workspace-unavailable' });
      break;
    }
    roots.push({ root: current, label: depth === 0 ? '$WORKSPACE' : `$WORKSPACE_PARENT_${depth}`,
      identity: true, workspace: depth === 0, workspaceAncestor: depth > 0 });
    if (current === sep) break;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
    depth += 1;
  }
  return roots;
}

function insideRoot(path, root) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function withinOrEqual(path, root) { return path === root || insideRoot(path, root); }

const NATIVE_SYNC_BUCKET = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}_(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|unbound)$/i;
const SYNC_MANIFEST_RECORD = 'native-sync-manifest-content-v1';
const metadataFileIdentity = info => JSON.stringify([info.dev, info.ino, info.uid, info.nlink,
  info.mode, info.size, info.mtimeMs, info.ctimeMs]);
async function safeMetadataFile(path, maxBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.nlink !== 1
    || info.mode & 0o022 || info.size > maxBytes || await realpath(path) !== path)
    throw new Error('Native settings metadata is unsafe');
  return info;
}

async function nativeSyncContainer(profile, absolute, info) {
  if (profile.client !== CLAUDE_CLIENT) return false;
  const parts = relative(profile.home, absolute).split(sep);
  if (parts.length !== 3 || parts[0] !== 'skills' || parts[1] !== 'synced' || !NATIVE_SYNC_BUCKET.test(parts[2]))
    return false;
  if (!info.isDirectory() || await realpath(absolute) !== absolute)
    throw new Error('Native sync container is unsafe');
  const marker = join(resolve(absolute, '..'), `.bucket-${parts[2]}`);
  try { await safeMetadataFile(marker, 0); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try {
    await lstat(join(absolute, 'SKILL.md'));
    throw new Error('Native sync container is also a skill package');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return true;
}

async function readSettingsMetadata(path) {
  const before = await safeMetadataFile(path, MAX_CONFIG_BYTES);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const identity = metadataFileIdentity(before);
    if (metadataFileIdentity(await handle.stat()) !== identity)
      throw new Error('Native settings metadata changed while reading');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Native settings metadata changed while reading');
      offset += bytesRead;
    }
    if (metadataFileIdentity(await handle.stat()) !== identity
      || metadataFileIdentity(await safeMetadataFile(path, MAX_CONFIG_BYTES)) !== identity)
      throw new Error('Native settings metadata changed while reading');
    return { bytes, mode: before.mode & 0o777, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } finally { await handle.close(); }
}

async function syncManifestFingerprint(path) {
  const { bytes, mode, value: manifest } = await readSettingsMetadata(path);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.skills !== undefined && !Array.isArray(manifest.skills)
    || manifest.lastUpdated !== undefined && !Number.isFinite(manifest.lastUpdated)
    || ['staleDirs', 'pendingClaims'].some(key => manifest[key] !== undefined
      && (!Array.isArray(manifest[key]) || manifest[key].some(value => typeof value !== 'string'))))
    throw new Error('Native sync manifest is malformed');
  // Preserve every byte, including unknown activation/attribution fields.
  return JSON.stringify([SYNC_MANIFEST_RECORD, mode, createHash('sha256').update(bytes).digest('hex')]);
}

async function marketplaceFingerprint(path) {
  const { mode, value } = await readSettingsMetadata(path);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude marketplace metadata is malformed');
  for (const marketplace of Object.values(value)) {
    if (!marketplace || typeof marketplace !== 'object' || Array.isArray(marketplace))
      throw new Error('Claude marketplace record is malformed');
    // A native refresh rewrites lastUpdated without changing the marketplace source.
    if (typeof marketplace.lastUpdated === 'string' && Number.isFinite(Date.parse(marketplace.lastUpdated))) delete marketplace.lastUpdated;
  }
  const canonical = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return JSON.stringify(['claude-marketplace-content-v1', mode, createHash('sha256').update(canonical).digest('hex')]);
}

async function collectSettingMetadata(roots, profile) {
  const records = new Map();
  let files = 0;
  const authorizedRoots = [...new Set([...roots.map(item => item.root), profile.nativeRoot].filter(Boolean))];
  for (const root of authorizedRoots) await canonicalDirectory(root, 'Authorized settings root');
  const fail = (message, auditReason = 'settings-source-unavailable') => { throw Object.assign(new Error(message), { auditReason }); };
  const walk = async (root, absolute, logical, depth = 0, ancestors = new Set(),
    { observational = false, skillSource = false, packageBoundary = null } = {}) => {
    if (depth > MAX_SETTINGS_DEPTH) fail('Settings source exceeds the directory depth limit', 'settings-inspection-limit');
    let info;
    try { info = await lstat(absolute); }
    catch (error) { if (error.code === 'ENOENT') { records.set(logical, 'missing'); return; } throw error; }
    const syncContainer = await nativeSyncContainer(profile, absolute, info);
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
        if (files > MAX_SETTINGS_FILES) fail('Settings source exceeds the file limit', 'settings-inspection-limit');
      }
      return;
    }
    if (info.isFile()) {
      if (profile.client === CLAUDE_CLIENT && !observational && await realpath(absolute) !== absolute)
        fail('Claude settings source is not canonical');
      if ((!observational && (info.nlink !== 1 || info.uid !== process.getuid())) || (info.mode & 0o022))
        throw new Error('Settings source file is unsafe');
      files += 1;
      if (files > MAX_SETTINGS_FILES) fail('Settings source exceeds the file limit', 'settings-inspection-limit');
      records.set(logical, profile.client === CLAUDE_CLIENT && logical === '$CLAUDE_CONFIG/plugins/known_marketplaces.json'
        ? await marketplaceFingerprint(absolute)
        : JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode & 0o777]));
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
    if (entries.length > MAX_SETTINGS_FILES) fail('Settings source exceeds the directory limit', 'settings-inspection-limit');
    for (const name of entries) {
      if (syncContainer && name === '.last-complete-round') {
        await safeMetadataFile(join(absolute, name), 1024);
        continue; // Native sync reuse stamp, not a selected skill input.
      }
      if (syncContainer && name === 'manifest.json') {
        if (++files > MAX_SETTINGS_FILES) fail('Settings source exceeds the file limit', 'settings-inspection-limit');
        records.set(`${logical}/${name}`, await syncManifestFingerprint(join(absolute, name)));
        continue;
      }
      await walk(root, join(absolute, name), `${logical}/${name}`, depth + 1, nextAncestors,
        { observational, skillSource, packageBoundary });
    }
  };
  for (const descriptor of roots) {
    const { root, label } = descriptor;
    const rootInfo = await canonicalDirectory(root, 'Settings root');
    if (descriptor.identity)
      records.set(`${label}/@directory`, JSON.stringify([rootInfo.dev, rootInfo.ino, rootInfo.mode & 0o777]));
    if (profile.client === CLAUDE_CLIENT) {
      if (descriptor.workspace || descriptor.workspaceAncestor) {
        for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json']) await walk(root, join(root, name), `${label}/${name}`);
        // HOME can be a workspace ancestor, but ~/.claude is the stock personal
        // configuration root. The selected personal root is captured separately.
        if (descriptor.workspace || root !== profile.userHome) {
          for (const name of ['settings.json', 'settings.local.json', 'CLAUDE.md', 'rules', 'agents', 'skills', 'commands'])
            await walk(root, join(root, '.claude', name), `${label}/.claude/${name}`, 0, new Set(), { skillSource: name === 'skills' });
        }
      } else if (label === '$CLAUDE_CONFIG') {
        for (const name of ['settings.json', 'CLAUDE.md', 'rules', 'agents', 'skills', 'commands', 'plugins/installed_plugins.json', 'plugins/known_marketplaces.json'])
          await walk(root, join(root, name), `${label}/${name}`, 0, new Set(), { skillSource: name === 'skills' });
      }
      // `.claude.json` is native state rewritten on every start, so it is not a
      // settings source here. User-scope MCP entries inside it are outside this
      // identity; the runtime checks its workspace trust flag separately.
      continue;
    }
    if (descriptor?.workspace || descriptor?.workspaceAncestor) {
      for (const name of ['AGENTS.md', 'AGENTS.override.md']) await walk(root, join(root, name), `${label}/${name}`);
      const codex = join(root, '.codex');
      for (const name of ['config.toml', 'AGENTS.md', 'AGENTS.override.md'])
        await walk(root, join(codex, name), `${label}/.codex/${name}`);
      for (const name of ['agents', 'skills', 'rules'])
        await walk(root, join(codex, name), `${label}/.codex/${name}`, 0, new Set(), { skillSource: name === 'skills' });
      await walk(root, join(root, '.agents', 'skills'), `${label}/.agents/skills`, 0, new Set(), { skillSource: true });
      continue;
    }
    for (const name of ['config.toml', 'AGENTS.md', 'AGENTS.override.md', ...(label === '$CODEX_HOME' ? ['auth.json'] : [])]) await walk(root, join(root, name), `${label}/${name}`);
    for (const name of ['agents', 'skills', 'rules']) await walk(root, join(root, name), `${label}/${name}`, 0, new Set(), { skillSource: name === 'skills' });
    if (label === '$HOME') await walk(root, join(root, '.agents', 'skills'), `${label}/.agents/skills`, 0, new Set(), { skillSource: true });
  }
  return records;
}

function settingsInspectionError(reason) {
  if (reason === 'workspace-unavailable') return Object.assign(new Error('Selected workspace is unavailable or unsafe'),
    { code: 'profile-workspace-unavailable' });
  const guidance = {
    'settings-inspection-limit': 'The selected settings exceed the inspection limit. Reduce the number or depth of profile and project settings files, then try again.',
    'settings-symlink-cycle': 'The selected settings contain a link cycle. Fix links in the profile or project settings, then try again.',
    'settings-symlink-outside-authorized-roots': 'The selected settings link to an unsupported location. Use links within the selected profile or workspace, or link to a skill package.',
    'settings-symlink-target-unsafe': 'A selected settings link does not point to a safe file or directory. Check its target and permissions, then try again.',
  };
  return Object.assign(new Error(guidance[reason]
    ?? 'Selected profile settings could not be safely inspected. Check that the profile and project settings are readable and cannot be written by other users.'),
  { code: 'profile-settings-unavailable' });
}

/** Capture private settings identities; bounded native metadata may use content hashes.
 * Credential/account stores and ordinary configuration/instruction bodies are never opened here.
 */
export async function snapshotAuditProfileSettings(profile) {
  // Detailed records remain process-local. A series may persist the explicit
  // settings continuity token below; ordinary run recovery has no such token.
  const snapshot = { status: 'ready', persistence: 'process-local', capturedAt: new Date().toISOString() };
  try { settingsBySnapshot.set(snapshot, { status: 'ready', records: profile.client === 'copilot'
    ? await copilotSettingMetadata({ ...profile.environmentBinding, workspace: profile.cwd })
    : await collectSettingMetadata(await selectedSettingRoots(profile), profile) }); }
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

/** Private continuity token; v2 adds complete native sync-manifest content protection, never credentials. */
export function auditSettingsIdentity(snapshot) {
  const saved = snapshot && settingsBySnapshot.get(snapshot);
  if (saved?.status !== 'ready') return null;
  const entries = [...saved.records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const hasContent = entries.some(([, value]) => value.startsWith(`["${SYNC_MANIFEST_RECORD}",`));
  return { algorithm: hasContent ? 'sha256-settings-metadata-v2' : 'sha256-file-stat-metadata-v1',
    digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
