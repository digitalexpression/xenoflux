import { mkdir, lstat, realpath, writeFile, rename, unlink, rmdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { find, strictDescendant } from './profiles.js';
import { resolveClaudeProfile } from './claude-profile.js';
import { resolveCopilotProfile } from './copilot-profile.js';
import { loadHomeBinding, resolveHome } from './homes.js';
import { probeVersion, probeNativeProfileVersion, probeCodexEmbeddedCli } from './version-probe.js';
import { runInteractive } from './interactive-process.js';
import { createLogStorage } from './log-storage.js';
import { nativePath } from './node-runtime.js';
import { getAuditProcessIdentity } from './audit-process.js';
import { acquireCopilotAccount } from './copilot-account-lock.js';
import { createDesktopInstanceRuntime, matchesProcessIdentity } from './desktop-instance-runtime.js';
import { observeCodexDesktopPeer, reconcileDesktopInstance, withProfileOperation } from './desktop-instances.js';
import { acquireNativeParticipant, assertNoLegacyAuditLease, readProfileOwners, releaseProfileParticipant } from './profile-reservations.js';
import { assertSavedCodexSignIn, cliReportPath, codexResourcePaths, nativeProcessRow,
  nativeRootIdentity as checkedNativeRoots } from './native-participants.js';
import { createManagedDesktop } from './managed-desktop.js';
import { exists } from './metadata.js';

const knownErrors = new Set(['CANCELLED', 'SPAWN_FAILED', 'SHUTDOWN_FAILED', 'VERSION_MISMATCH', 'EXECUTABLE_CHANGED', 'HOME_CHANGED', 'OUTPUT_LIMIT', 'RPC_TIMEOUT', 'RAM_LOGS_UNAVAILABLE', 'CLI_DESKTOP_UNSUPPORTED']);
async function privateDirectory(path) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(path) !== path || (s.mode & 0o077)
    || (process.getuid && s.uid !== process.getuid())) throw new Error('Expected a private launch directory');
}
async function record(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}

async function nativeRootIdentity(root, home) {
  return Promise.all([root, home].map(async path => {
    await privateDirectory(path);
    const info = await lstat(path);
    return [info.dev, info.ino];
  }));
}

async function nativeLaunchPlan(selected, terminalEnvironment, { repository, resumeId, defaultUserHome }) {
  if (resumeId !== undefined) throw new Error('Standalone resume is only supported for Codex profiles.');
  if (!selected.native) throw new Error('This profile has no native binding.');
  let cwd = selected.repositories[0]?.path ?? join(selected.native.root, 'workspace');
  if (repository !== undefined) {
    if (typeof repository !== 'string' || !repository.trim() || /[\x00-\x1f\x7f]/.test(repository)) throw new Error('Invalid repository path');
    cwd = await realpath(repository);
    if (!selected.repositories.some(row => row.path === cwd)) throw new Error('Bind this repository to the profile before launching it');
  }
  if (await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory()) throw new Error('The saved workspace is no longer available at its canonical path');
  const resolver = selected.client === 'claude-code' ? resolveClaudeProfile : resolveCopilotProfile;
  const profile = await resolver({ selected, defaultUserHome, terminalEnvironment, sessionOnly: true, workspace: cwd });
  const env = { ...profile.env, TERM: 'xterm-256color', ...(selected.client === 'copilot' ? { COPILOT_HOME: profile.home } : {}) };
  for (const key of ['TERM', 'COLORTERM']) {
    const value = terminalEnvironment[key];
    if (typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_.@:+-]+$/.test(value)) env[key] = value;
  }
  return { client: selected.client, profileId: selected.id, name: selected.name, nativeRoot: profile.reservationRoot,
    environmentId: profile.environmentId, home: profile.home, executable: profile.executable,
    executableIdentity: profile.executableIdentity, version: null, cwd, native: structuredClone(selected.native),
    rootIdentity: await nativeRootIdentity(profile.reservationRoot, profile.home),
    args: selected.client === 'copilot' ? ['--no-auto-update'] : [], env, operation: 'launch',
    configurationChangedSinceRegistration: false, configurationSource: join(profile.home, 'settings.json'), desktopChanged: false };
}

export async function launchPlan(store, name, terminalEnvironment = process.env, { repository, resumeId, defaultUserHome = homedir() } = {}) {
  const selected = /^default$/i.test(name) ? null : find(await store.read(), name);
  if (selected?.client && selected.client !== 'codex') return nativeLaunchPlan(selected, terminalEnvironment, { repository, resumeId, defaultUserHome });
  const { profile, native, environment } = await resolveHome(store, name);
  const binary = await discoverCodexExecutable(terminalEnvironment);
  let cwd = environment.cwd;
  if (repository !== undefined) {
    if (typeof repository !== 'string' || !repository.trim() || /[\x00-\x1f\x7f]/.test(repository)) throw new Error('Invalid repository path');
    cwd = await realpath(repository);
    if (!profile.repositories.some(r => r.path === cwd)) throw new Error('Bind this repository to the profile before launching it');
  }
  if (resumeId !== undefined) {
    const { findHistory } = await import('./history.js');
    const { entry } = await findHistory(store, profile.id, resumeId);
    if (!entry || entry.archived) throw new Error('Task is unavailable in this home or is archived');
    if (entry.home !== environment.home || entry.environmentId !== environment.id || !entry.rolloutPath)
      throw new Error('The saved task transcript is unavailable in its original home');
    if (entry.cwd !== environment.cwd && !profile.repositories.some(r => r.path === entry.cwd))
      throw new Error('Bind the task repository to this profile before resuming it');
    if (repository !== undefined && cwd !== entry.cwd) throw new Error('Selected repository differs from the saved task workspace');
    cwd = entry.cwd;
  }
  if (typeof cwd !== 'string' || /[\x00-\x1f\x7f]/.test(cwd) || await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory())
    throw new Error('The saved workspace is no longer available at its canonical path');
  const env = { ...environment.launch.env };
  // Native tools can use this Node installation; arbitrary parent credentials,
  // shell commands and Codex overrides are never inherited.
  env.PATH = nativePath(terminalEnvironment);
  env.TERM = 'xterm-256color';
  for (const key of ['TERM', 'COLORTERM', 'LANG', 'LC_CTYPE']) {
    const value = terminalEnvironment[key];
    if (typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_.@:+-]+$/.test(value)) env[key] = value;
  }
  return { client: 'codex', profileId: profile.id, name: profile.name, nativeRoot: native.root,
    environmentId: environment.id, home: environment.home, desktopData: environment.desktopData, executable: binary.executable,
    executableIdentity: binary.executableIdentity, version: null, cwd,
    native: structuredClone(profile.native),
    rootIdentity: await checkedNativeRoots(native.root, environment.home),
    args: [...(resumeId ? ['resume', resumeId] : []), '--no-alt-screen', '--cd', cwd, '-c', `sqlite_home=${JSON.stringify(environment.home)}`], env,
    operation: resumeId ? 'resume' : 'launch', ...(resumeId ? { resumeId } : {}),
    configurationChangedSinceRegistration: false,
    configurationSource: join(environment.home, 'config.toml'),
    desktopChanged: false };
}

/** Find the normal CLI command on PATH without running it. */
export async function discoverCodexExecutable(environment = process.env) {
  for (const directory of (typeof environment.PATH === 'string' ? environment.PATH : '').split(':').filter(path => path.startsWith('/'))) {
    const candidate = join(directory, 'codex');
    try {
      const target = await realpath(candidate), info = await lstat(target);
      if (info.isFile() && !info.isSymbolicLink()) {
        await access(target, constants.X_OK);
        return { executable: candidate, executableIdentity: JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]) };
      }
    } catch { /* continue through the existing PATH */ }
  }
  throw new Error('Codex executable is unavailable on PATH');
}

async function attestRunner(runtime, pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  let previous;
  const deadline = Date.now() + 750;
  do {
    const row = (await runtime.snapshot()).find(row => row.pid === pid && row.ppid === process.pid);
    if (!row) return;
    if (nativeProcessRow(row) && row.executable !== '/usr/bin/env' && matchesProcessIdentity(row, previous)) return row;
    previous = row;
    await new Promise(resolve => setTimeout(resolve, 35));
  } while (Date.now() <= deadline);
}

/** Launch only the explicitly bound native home. No profile materialization. */
export async function launchHome(store, name, { signal, terminalEnvironment, onStart = () => {},
  repository, resumeId, defaultUserHome, run = runInteractive, probe,
  probeEmbedded = probe ? async () => false : probeCodexEmbeddedCli,
  instanceRuntime = createDesktopInstanceRuntime(), lockOptions = {}, ramLogs = createLogStorage() } = {}) {
  let plan = await launchPlan(store, name, terminalEnvironment, { repository, resumeId, defaultUserHome });
  const codex = plan.client === 'codex', claude = plan.client === 'claude-code';
  const managedDesktop = claude && createManagedDesktop(store, { runtime: instanceRuntime, lockOptions });
  const desktopData = claude && join(plan.nativeRoot, 'desktop');
  if (claude && (plan.cwd === desktopData || strictDescendant(desktopData, plan.cwd)))
    throw new Error('Choose a CLI workspace outside Claude Desktop storage');
  const account = plan.client === 'copilot' ? await acquireCopilotAccount(plan.env.HOME) : null;
  const lock = join(plan.nativeRoot, '.run-lock'), runId = randomUUID();
  const owner = { pid: process.pid, host: hostname(), runId, kind: 'interactive-cli',
    ...(codex || claude ? { membershipVersion: 1, client: plan.client, storePath: store.directory, profileId: plan.profileId,
      home: plan.home, environmentId: plan.environmentId, reportPath: cliReportPath(plan.nativeRoot, runId) } : {}) };
  const guard = (action, waitMs = 5000) => withProfileOperation(store, plan.profileId, { waitMs, ...lockOptions }, action);
  async function assertSameNativeRoots() {
    if (JSON.stringify(await checkedNativeRoots(plan.nativeRoot, plan.home)) !== JSON.stringify(plan.rootIdentity))
      throw Object.assign(new Error(codex ? 'The selected Codex home changed.' : 'The selected Claude profile changed.'), { code: 'HOME_CHANGED' });
  }
  async function currentDesktopPeer() {
    const owners = await readProfileOwners(plan.nativeRoot);
    if (!owners.some(current => JSON.stringify(current) === JSON.stringify(owner)))
      throw new Error('Terminal ownership changed; preserving the current reservation.');
    return owners.find(current => current.kind === (claude ? 'claude-desktop' : 'desktop-instance'));
  }
  let reportPath, preserveLock = false;
  const report = { schemaVersion: 1, kind: 'interactive-cli', client: plan.client, runId, profileId: plan.profileId,
    environmentId: plan.environmentId, home: plan.home, cwd: plan.cwd, operation: plan.operation,
    rootIdentity: plan.rootIdentity, executable: plan.executable, ...(codex || claude ? { executableIdentity: plan.executableIdentity } : {}),
    ...(resumeId ? { resumeId } : {}), status: 'starting',
    startedAt: new Date().toISOString(), terminalOutputRetained: false };
  async function prepareReport() {
    const launches = join(plan.nativeRoot, 'launches');
    try { await mkdir(launches, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await privateDirectory(launches);
    const runRoot = join(launches, runId); await mkdir(runRoot, { mode: 0o700 });
    reportPath = join(runRoot, 'report.json'); await record(reportPath, report);
  }
  let desktopOwner;
  if (codex) await guard(async () => {
    await assertSameNativeRoots();
    await assertNoLegacyAuditLease(store.directory, plan.home);
    if (await exists(lock)) {
      let owners = await readProfileOwners(plan.nativeRoot);
      if (owners.length !== 1 || owners[0]?.kind !== 'desktop-instance')
        throw new Error('This native home is in use or an earlier run needs recovery');
      await reconcileDesktopInstance(store, plan.profileId, { ...lockOptions, runtime: instanceRuntime, guarded: true });
      owners = await exists(lock) ? await readProfileOwners(plan.nativeRoot) : [];
      if (owners.length) {
        desktopOwner = owners[0];
        await assertSavedCodexSignIn(plan.home);
        const desktop = await observeCodexDesktopPeer(store, plan, desktopOwner, instanceRuntime, { joining: true });
        await instanceRuntime.assertResourcesIdle(codexResourcePaths(plan), { allowedProcesses: desktop.processes, profileHome: plan.home });
      }
    }
    await prepareReport();
    await acquireNativeParticipant(plan.nativeRoot, owner, desktopOwner);
  });
  else if (claude) await guard(async () => {
    await assertSameNativeRoots();
    await assertNoLegacyAuditLease(store.directory, plan.home);
    if (await exists(lock)) {
      const owners = await readProfileOwners(plan.nativeRoot);
      if (owners.length !== 1 || owners[0]?.kind !== 'claude-desktop')
        throw new Error('This native home is in use or an earlier run needs recovery');
      desktopOwner = owners[0];
      await managedDesktop.observeClaudePeer(plan.profileId, desktopOwner, { joining: true });
    }
    await prepareReport();
    await acquireNativeParticipant(plan.nativeRoot, owner, desktopOwner);
  });
  else {
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { await account?.release(); throw new Error('This native home is in use or an earlier run needs recovery'); }
  }
  try {
    if (!codex && !claude) {
      await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      await prepareReport();
    }
    const options = { executable: plan.executable, cwd: plan.cwd, env: plan.env, signal };
    const version = await (probe ? probe(options) : codex ? probeVersion(options) : probeNativeProfileVersion(plan.client, options));
    if (codex) report.embedded = (await probeEmbedded({ ...options, resume: Boolean(resumeId) })) === true;
    const fresh = await launchPlan(store, plan.profileId, terminalEnvironment, { repository, resumeId, defaultUserHome });
    if (fresh.client !== plan.client || fresh.nativeRoot !== plan.nativeRoot || fresh.environmentId !== plan.environmentId || fresh.home !== plan.home || fresh.cwd !== plan.cwd
      || JSON.stringify(fresh.rootIdentity) !== JSON.stringify(plan.rootIdentity))
      throw Object.assign(new Error('Home binding changed'), { code: 'HOME_CHANGED' });
    if (fresh.executable !== plan.executable || fresh.executableIdentity !== plan.executableIdentity)
      throw Object.assign(new Error('Executable changed'), { code: 'EXECUTABLE_CHANGED' });
    plan = fresh;
    report.version = version; report.configurationChangedSinceRegistration = plan.configurationChangedSinceRegistration;
    if (codex) await guard(async () => {
      await assertSameNativeRoots();
      const logs = { home: plan.home, key: plan.environmentId, signal };
      const peer = await currentDesktopPeer();
      if (peer) {
        if (!report.embedded) throw Object.assign(new Error('This Codex CLI does not advertise an independent Terminal runtime.'), { code: 'CLI_DESKTOP_UNSUPPORTED' });
        await assertSavedCodexSignIn(plan.home);
        const desktop = await observeCodexDesktopPeer(store, plan, peer, instanceRuntime, { joining: true });
        await instanceRuntime.assertResourcesIdle(codexResourcePaths(plan), { allowedProcesses: desktop.processes, profileHome: plan.home });
        await ramLogs.joinHome(logs);
      } else {
        if (report.embedded) await instanceRuntime.assertResourcesIdle(codexResourcePaths(plan), { profileHome: plan.home });
        await ramLogs.prepareHome(logs);
      }
    });
    await onStart(plan);
    if (signal?.aborted) throw Object.assign(new Error('Launch cancelled'), { code: 'CANCELLED' });
    await account?.checkpoint({ spawnIntent: true });
    if (codex || claude) await guard(async () => {
      await assertSameNativeRoots();
      const peer = await currentDesktopPeer();
      if (claude && peer) await managedDesktop.observeClaudePeer(plan.profileId, peer, { joining: true });
      report.spawnIntent = true;
      await record(reportPath, report);
    });
    const result = await run({ executable: plan.executable, args: report.embedded ? [...plan.args, '--no-daemon'] : plan.args,
      cwd: plan.cwd, env: plan.env, signal,
      async onSpawn(pid) {
        if (account) await account.checkpoint({ processIdentity: await getAuditProcessIdentity(pid) });
        report.pid = pid;
        if (codex || claude) {
          await assertSameNativeRoots();
          await record(reportPath, report);
          report.processIdentity = await attestRunner(instanceRuntime, pid).catch(() => undefined);
          await assertSameNativeRoots();
        }
        report.status = 'running'; await record(reportPath, report);
      } });
    Object.assign(report, result);
    report.status = result.exitCode === 0 ? 'exited' : 'failed';
  } catch (error) {
    preserveLock = error.code === 'SHUTDOWN_FAILED';
    report.status = 'incomplete'; report.error = knownErrors.has(error.code) ? error.code : 'LAUNCH_FAILED';
  } finally {
    if (!preserveLock) {
      try {
        if (plan.client === 'codex') {
          const after = await loadHomeBinding(plan.native);
          if (after.native.environmentId !== plan.environmentId || after.environment.home !== plan.home) throw new Error('Home changed during launch');
          report.postflight = 'paths-and-auth-metadata-checked';
        } else {
          const after = find(await store.read(), plan.profileId);
          if (after.client !== plan.client || JSON.stringify(after.native) !== JSON.stringify(plan.native)
            || JSON.stringify(await nativeRootIdentity(plan.nativeRoot, plan.home)) !== JSON.stringify(plan.rootIdentity)) throw new Error('Home changed during launch');
          report.postflight = 'profile-paths-checked';
        }
      } catch {
        report.postflight = 'failed';
        report.status = 'incomplete';
        report.error ??= 'HOME_CHANGED';
        if (plan.client !== 'codex') preserveLock = true;
      }
    }
    report.finishedAt = new Date().toISOString();
    if (codex) await guard(async () => {
      try { await assertSameNativeRoots(); }
      catch { reportPath = null; preserveLock = true; }
      if (!preserveLock && report.embedded && report.spawnIntent) {
        try {
          const peer = await currentDesktopPeer();
          const allowedProcesses = peer ? (await observeCodexDesktopPeer(store, plan, peer, instanceRuntime)).processes : [];
          await instanceRuntime.assertResourcesIdle(codexResourcePaths(plan), { allowedProcesses, profileHome: plan.home });
        } catch {
          preserveLock = true; report.status = 'incomplete'; report.error = 'SHUTDOWN_FAILED';
        }
      }
      if (reportPath) await record(reportPath, report);
      if (!preserveLock) await releaseProfileParticipant(plan.nativeRoot, owner);
    }, 40000);
    else if (claude) await guard(async () => {
      try { await assertSameNativeRoots(); }
      catch { reportPath = null; preserveLock = true; }
      if (reportPath) await record(reportPath, report);
      if (!preserveLock) {
        try {
          const peer = await currentDesktopPeer();
          if (peer) await managedDesktop.observeClaudePeer(plan.profileId, peer);
        } catch {
          preserveLock = true; report.status = 'incomplete'; report.error = 'SHUTDOWN_FAILED';
          await record(reportPath, report);
        }
      }
      if (!preserveLock) await releaseProfileParticipant(plan.nativeRoot, owner);
    }, 40000);
    else {
      try {
        await privateDirectory(plan.nativeRoot);
        const current = await lstat(plan.nativeRoot);
        if (JSON.stringify([current.dev, current.ino]) !== JSON.stringify(plan.rootIdentity[0])) throw new Error('Root changed');
      } catch { reportPath = null; preserveLock = true; }
      if (reportPath) await record(reportPath, report);
      if (!preserveLock) {
        await unlink(join(lock, 'owner.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await rmdir(lock);
        await account?.release();
      }
    }
  }
  return { ...report, reportPath };
}
