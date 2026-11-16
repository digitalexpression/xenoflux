import { lstat, realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { matchesProcessIdentity } from './desktop-instance-runtime.js';
import { privateDirectory, readJSON } from './metadata.js';
import { isNativeCliParticipant } from './profile-reservations.js';
import { ramLogTarget } from './ram-logs.js';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const absolute = path => typeof path === 'string' && path.startsWith('/') && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path);
export const nativeProcessRow = row => row && Number.isSafeInteger(row.pid) && row.pid > 0
  && Number.isSafeInteger(row.ppid) && row.ppid >= 0 && row.uid === process.getuid()
  && typeof row.startedAt === 'string' && Number.isFinite(Date.parse(row.startedAt)) && absolute(row.executable);

export const cliReportPath = (root, id) => join(root, 'launches', id, 'report.json');
export const codexResourcePaths = plan => [plan.home, plan.desktopData, ...['', '-wal', '-shm'].map(s => ramLogTarget(plan.environmentId) + s)];

export async function nativeRootIdentity(...paths) {
  return Promise.all(paths.map(async path => {
    await privateDirectory(path);
    const info = await lstat(path);
    return [info.dev, info.ino];
  }));
}

export async function assertSavedCodexSignIn(home) {
  const info = await lstat(join(home, 'auth.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()
    || (info.mode & 0o077) || !info.size)
    throw new Error('Save your Codex sign-in before opening this profile in both Terminal and Desktop.');
}

async function readCliReport(store, plan, owner, client) {
  const reportPath = cliReportPath(plan.nativeRoot, owner.runId);
  if (!isNativeCliParticipant(owner, client) || owner.host !== hostname() || owner.storePath !== store.directory
    || owner.profileId !== plan.profileId || owner.home !== plan.home || owner.environmentId !== plan.environmentId
    || owner.reportPath !== reportPath) throw new Error('Terminal reservation belongs to another profile or controller; preserving it');
  await privateDirectory(join(plan.nativeRoot, 'launches'));
  await privateDirectory(dirname(reportPath));
  const report = await readJSON(reportPath);
  if (report.schemaVersion !== 1 || report.kind !== 'interactive-cli' || report.client !== client
    || report.runId !== owner.runId || report.profileId !== owner.profileId || report.environmentId !== owner.environmentId
    || report.home !== owner.home || !equal(report.rootIdentity, await nativeRootIdentity(plan.nativeRoot, plan.home))
    || !absolute(report.executable) || typeof report.executableIdentity !== 'string'
    || !['starting', 'running', 'incomplete', 'exited', 'failed'].includes(report.status)
    || (report.processIdentity !== undefined && (!nativeProcessRow(report.processIdentity)
      || report.processIdentity.pid !== report.pid || report.processIdentity.ppid !== owner.pid
      || client === 'claude-code' && report.processIdentity.executable !== report.executable)))
    throw new Error('Terminal run has no matching native ownership record; preserving its reservation');
  return report;
}

async function observeCli(store, plan, owner, runtime, { joining = false, client }) {
  const report = await readCliReport(store, plan, owner, client);
  const runner = report.processIdentity;
  if (!runner) {
    if (!joining && (!report.spawnIntent || report.shutdown?.groupTerminated === true)) return { status: 'stopped', processes: [] };
    throw new Error('Terminal process identity is unavailable; preserving its reservation');
  }
  const observation = { trackedProcesses: [runner], ...(client === 'copilot' ? { resolveExecutable: true } : {}) };
  let observed = await runtime.observe(runner, observation);
  if (client !== 'codex') {
    for (let attempt = 0; attempt < 3 && observed.status === 'running' && observed.processes.some(row => !nativeProcessRow(row)); attempt++) {
      await delay(35);
      observed = await runtime.observe(runner, observation);
    }
  }
  if (observed.status === 'stopped' && !joining) return observed;
  if (observed.status !== 'running' || observed.orphaned
    || !observed.processes.every(nativeProcessRow)
    || !observed.processes.some(row => matchesProcessIdentity(row, runner) && row.ppid === owner.pid))
    throw new Error('Terminal process ownership is uncertain; preserving its reservation');
  if (joining) {
    if (report.status !== 'running' || report.spawnIntent !== true || client === 'codex' && report.embedded !== true)
      throw new Error('This Terminal launch cannot share its profile; close it before opening Desktop.');
    const stat = await lstat(await realpath(report.executable));
    if (!stat.isFile() || JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]) !== report.executableIdentity)
      throw new Error('Selected Terminal executable changed; close Terminal before opening Desktop.');
  }
  return observed;
}

export const observeCodexCli = (store, plan, owner, runtime, options) =>
  observeCli(store, plan, owner, runtime, { ...options, client: 'codex' });
export const observeManagedCli = (store, plan, owner, runtime, options) =>
  observeCli(store, plan, owner, runtime, { ...options, client: plan.client });

export async function assertCodexHolder(runtime, paths, allowedProcesses, profileHome) {
  const observed = await runtime.assertResourcesIdle(paths, { allowedProcesses, ...(profileHome ? { profileHome } : {}) });
  if (!observed?.processes?.some(holder => allowedProcesses.some(row => matchesProcessIdentity(row, holder))))
    throw Object.assign(new Error('The selected Codex storage holder is not verified.'), { code: 'CODEX_HOLDER_UNVERIFIED' });
}
