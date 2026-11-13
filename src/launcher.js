import { mkdir, lstat, realpath, writeFile, rename, unlink, rmdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { find } from './profiles.js';
import { resolveClaudeProfile } from './claude-profile.js';
import { resolveCopilotProfile } from './copilot-profile.js';
import { loadHomeBinding, resolveHome } from './homes.js';
import { probeVersion, probeNativeProfileVersion } from './version-probe.js';
import { runInteractive } from './interactive-process.js';
import { createLogStorage } from './log-storage.js';
import { nativePath } from './node-runtime.js';

const knownErrors = new Set(['CANCELLED', 'SPAWN_FAILED', 'SHUTDOWN_FAILED', 'VERSION_MISMATCH', 'EXECUTABLE_CHANGED', 'HOME_CHANGED', 'OUTPUT_LIMIT', 'RPC_TIMEOUT', 'RAM_LOGS_UNAVAILABLE']);
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
    environmentId: environment.id, home: environment.home, executable: binary.executable,
    executableIdentity: binary.executableIdentity, version: null, cwd,
    native: structuredClone(profile.native),
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

/** Launch only the explicitly bound native home. No profile materialization. */
export async function launchHome(store, name, { signal, terminalEnvironment, onStart = () => {},
  repository, resumeId, defaultUserHome, run = runInteractive, probe, ramLogs = createLogStorage() } = {}) {
  let plan = await launchPlan(store, name, terminalEnvironment, { repository, resumeId, defaultUserHome });
  const lock = join(plan.nativeRoot, '.run-lock'), runId = randomUUID();
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error('This native home is in use or an earlier run needs recovery'); }
  let reportPath, preserveLock = false;
  const report = { schemaVersion: 1, kind: 'interactive-cli', client: plan.client, runId, profileId: plan.profileId,
    environmentId: plan.environmentId, home: plan.home, cwd: plan.cwd, operation: plan.operation,
    ...(resumeId ? { resumeId } : {}), status: 'starting',
    startedAt: new Date().toISOString(), terminalOutputRetained: false };
  if (plan.client !== 'codex') Object.assign(report, { rootIdentity: plan.rootIdentity, executable: plan.executable });
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), runId, kind: report.kind }), { flag: 'wx', mode: 0o600 });
    const launches = join(plan.nativeRoot, 'launches');
    try { await mkdir(launches, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await privateDirectory(launches);
    const runRoot = join(launches, runId); await mkdir(runRoot, { mode: 0o700 });
    reportPath = join(runRoot, 'report.json'); await record(reportPath, report);
    const options = { executable: plan.executable, cwd: plan.cwd, env: plan.env, signal };
    const version = await (probe ? probe(options) : plan.client === 'codex' ? probeVersion(options) : probeNativeProfileVersion(plan.client, options));
    const fresh = await launchPlan(store, plan.profileId, terminalEnvironment, { repository, resumeId, defaultUserHome });
    if (fresh.client !== plan.client || fresh.nativeRoot !== plan.nativeRoot || fresh.environmentId !== plan.environmentId || fresh.home !== plan.home || fresh.cwd !== plan.cwd
      || JSON.stringify(fresh.rootIdentity) !== JSON.stringify(plan.rootIdentity))
      throw Object.assign(new Error('Home binding changed'), { code: 'HOME_CHANGED' });
    if (fresh.executable !== plan.executable || fresh.executableIdentity !== plan.executableIdentity)
      throw Object.assign(new Error('Executable changed'), { code: 'EXECUTABLE_CHANGED' });
    plan = fresh;
    report.version = version; report.configurationChangedSinceRegistration = plan.configurationChangedSinceRegistration;
    if (plan.client === 'codex') await ramLogs.prepareHome({ home: plan.home, key: plan.environmentId, signal });
    await onStart(plan);
    if (signal?.aborted) throw Object.assign(new Error('Launch cancelled'), { code: 'CANCELLED' });
    const result = await run({ executable: plan.executable, args: plan.args, cwd: plan.cwd, env: plan.env, signal,
      async onSpawn(pid) { report.pid = pid; report.status = 'running'; await record(reportPath, report); } });
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
    if (plan.client !== 'codex') {
      try {
        await privateDirectory(plan.nativeRoot);
        const current = await lstat(plan.nativeRoot);
        if (JSON.stringify([current.dev, current.ino]) !== JSON.stringify(plan.rootIdentity[0])) throw new Error('Root changed');
      } catch { reportPath = null; preserveLock = true; }
    }
    if (reportPath) await record(reportPath, report);
    if (!preserveLock) {
      await unlink(join(lock, 'owner.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await rmdir(lock);
    }
  }
  return { ...report, reportPath };
}
