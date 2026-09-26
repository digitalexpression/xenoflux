import { mkdir, lstat, realpath, writeFile, rename, unlink, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { loadHomeBinding, resolveHome } from './homes.js';
import { probeVersion } from './version-probe.js';
import { runInteractive } from './interactive-process.js';
import { createLogStorage } from './log-storage.js';
import { nativePath } from './node-runtime.js';

const knownErrors = new Set(['CANCELLED', 'SPAWN_FAILED', 'SHUTDOWN_FAILED', 'VERSION_MISMATCH', 'EXECUTABLE_CHANGED', 'HOME_CHANGED', 'OUTPUT_LIMIT', 'RPC_TIMEOUT', 'RAM_LOGS_UNAVAILABLE', 'RESUME_INDEX_CHANGED']);
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

export async function launchPlan(store, name, terminalEnvironment = process.env, { repository, resumeId } = {}) {
  const { profile, native, environment } = await resolveHome(store, name);
  let cwd = environment.cwd, resumeIndexRepair;
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
    if (entry.recordedRolloutPath) resumeIndexRepair = { from: entry.recordedRolloutPath, to: entry.rolloutPath,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt };
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
  return { profileId: profile.id, name: profile.name, nativeRoot: native.root,
    environmentId: environment.id, home: environment.home, executable: native.executable,
    executableIdentity: native.executableIdentity, version: native.version, cwd,
    native: structuredClone(profile.native),
    args: [...(resumeId ? ['resume', resumeId] : []), '--no-alt-screen', '--cd', cwd, '-c', `sqlite_home=${JSON.stringify(environment.home)}`], env,
    operation: resumeId ? 'resume' : 'launch', ...(resumeId ? { resumeId } : {}),
    ...(resumeIndexRepair ? { resumeIndexRepair } : {}),
    configurationChangedSinceRegistration: false,
    configurationSource: join(environment.home, 'config.toml'),
    desktopChanged: false };
}

/** Launch only the explicitly bound native home. No profile materialization. */
export async function launchHome(store, name, { signal, terminalEnvironment, onStart = () => {},
  repository, resumeId, run = runInteractive, probe = probeVersion, ramLogs = createLogStorage() } = {}) {
  let plan = await launchPlan(store, name, terminalEnvironment, { repository, resumeId });
  const lock = join(plan.nativeRoot, '.run-lock'), runId = randomUUID();
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error('This native home is in use or an earlier run needs recovery'); }
  let reportPath, preserveLock = false;
  const report = { schemaVersion: 1, kind: 'interactive-cli', runId, profileId: plan.profileId,
    environmentId: plan.environmentId, home: plan.home, cwd: plan.cwd, operation: plan.operation,
    ...(resumeId ? { resumeId } : {}), status: 'starting',
    startedAt: new Date().toISOString(), terminalOutputRetained: false };
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), runId, kind: report.kind }), { flag: 'wx', mode: 0o600 });
    const launches = join(plan.nativeRoot, 'launches');
    try { await mkdir(launches, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await privateDirectory(launches);
    const runRoot = join(launches, runId); await mkdir(runRoot, { mode: 0o700 });
    reportPath = join(runRoot, 'report.json'); await record(reportPath, report);
    const version = await probe({ executable: plan.executable, cwd: plan.cwd, env: plan.env, signal });
    const fresh = await launchPlan(store, plan.profileId, terminalEnvironment, { repository, resumeId });
    if (fresh.nativeRoot !== plan.nativeRoot || fresh.environmentId !== plan.environmentId || fresh.home !== plan.home || fresh.cwd !== plan.cwd)
      throw Object.assign(new Error('Home binding changed'), { code: 'HOME_CHANGED' });
    if (fresh.executableIdentity !== plan.executableIdentity) throw Object.assign(new Error('Executable changed'), { code: 'EXECUTABLE_CHANGED' });
    plan = fresh;
    report.version = version; report.configurationChangedSinceRegistration = plan.configurationChangedSinceRegistration;
    await ramLogs.prepareHome({ home: plan.home, key: plan.environmentId, signal });
    await onStart(plan);
    if (signal?.aborted) throw Object.assign(new Error('Launch cancelled'), { code: 'CANCELLED' });
    if (plan.resumeIndexRepair) {
      const { repairResumePath } = await import('./history.js');
      report.resumeIndexRepair = { ...plan.resumeIndexRepair, status: 'pending' };
      await record(reportPath, report);
      report.resumeIndexRepair = await repairResumePath(store, plan);
      await record(reportPath, report);
    }
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
        const after = await loadHomeBinding(plan.native);
        if (after.native.environmentId !== plan.environmentId || after.environment.home !== plan.home)
          throw new Error('Home changed during launch');
        report.postflight = 'paths-and-auth-metadata-checked';
      } catch {
        report.postflight = 'failed';
        report.status = 'incomplete';
        report.error ??= 'HOME_CHANGED';
      }
    }
    report.finishedAt = new Date().toISOString();
    if (reportPath) await record(reportPath, report);
    if (!preserveLock) {
      await unlink(join(lock, 'owner.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await rmdir(lock);
    }
  }
  return { ...report, reportPath };
}
