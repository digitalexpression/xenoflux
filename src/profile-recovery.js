import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolveHome } from './homes.js';
import { reconcileInterruptedSignIn } from './home-create.js';
import { createDesktopRuntime } from './desktop-runtime.js';
import { createDesktopInstanceRuntime } from './desktop-instance-runtime.js';
import { observeCodexDesktopPeer, withProfileOperation } from './desktop-instances.js';
import { codexResourcePaths, observeCodexCli } from './codex-native-participants.js';
import { isCodexCliParticipant, profileOwners, releaseProfileParticipant } from './profile-reservations.js';
import { acquire, exists, globalLock, privateDirectory, readJSON, release } from './metadata.js';
import { find, strictDescendant } from './profiles.js';
import { createManagedDesktop } from './managed-desktop.js';
import { observeAuditProcess } from './audit-process.js';
import { recoverCopilotAccountClaim } from './copilot-account-lock.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
};

async function candidate(store, name, { isAlive, observeProcess, instanceRuntime }) {
  const profile = find(await store.read(), name);
  if (!profile.native) throw new Error('Profile has no registered native home');
  const codex = !profile.client || profile.client === 'codex';
  let native, environment, rootIdentity;
  if (codex) ({ native, environment } = await resolveHome(store, profile.id));
  else {
    native = profile.native;
    if (native.rootMode !== 'explicit' || !strictDescendant(native.root, native.configRoot)) throw new Error('Invalid managed profile roots');
    rootIdentity = await Promise.all([native.root, native.configRoot].map(async path => {
      await privateDirectory(path);
      const info = await lstat(path);
      return [info.dev, info.ino];
    }));
    environment = { id: native.environmentId, home: native.configRoot, cwd: join(native.root, 'workspace'), desktopData: null };
  }
  const lock = join(native.root, '.run-lock');
  if (!await exists(lock)) throw new Error('No interrupted profile run is locked');
  await privateDirectory(lock);
  const saved = await readJSON(join(lock, 'owner.json'));
  const owners = codex ? profileOwners(saved) : [saved];
  const cli = codex && owners.find(isCodexCliParticipant);
  const owner = cli || saved;
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !uuid.test(owner.runId ?? ''))
    throw new Error('Native run lock owner is invalid or foreign; preserving it');
  if (isAlive(owner.pid)) throw new Error('Native run owner may still be live; preserving its lock');

  if (cli) {
    const plan = { profileId: profile.id, nativeRoot: native.root, environmentId: environment.id,
      home: environment.home, desktopData: environment.desktopData };
    if ((await observeCodexCli(store, plan, cli, instanceRuntime)).status !== 'stopped')
      throw new Error('Codex CLI may still be live; preserving its reservation');
    return { profile, native, environment, lock, owner, kind: 'interactive-cli', plan,
      desktopPeer: owners.find(participant => participant.kind === 'desktop-instance') };
  }

  let kind;
  let signInMarker;
  if (codex && owner.kind === 'native-home-login' && owner.root === native.root) {
    if (!equal(Object.keys(owner).sort(), ['host', 'kind', 'pid', 'root', 'runId']))
      throw new Error('Native login lock owner fields are invalid; preserving it');
    kind = 'native-home-login';
    signInMarker = await reconcileInterruptedSignIn({ root: native.root, profileId: profile.id });
  } else if (!codex && owner.kind === 'native-signin') {
    if (owner.storePath !== store.directory || owner.profileId !== profile.id
      || owner.configRoot !== environment.home || !equal(owner.roots, [rootIdentity[1], rootIdentity[0]])
      || typeof owner.executable !== 'string' || !isAbsolute(owner.executable)
      || resolve(owner.executable) !== owner.executable || /[\x00-\x1f\x7f]/.test(owner.executable)
      || typeof owner.executableIdentity !== 'string' || !owner.executableIdentity
      || typeof owner.userHome !== 'string' || !isAbsolute(owner.userHome) || await realpath(owner.userHome) !== owner.userHome
      || profile.client === 'copilot' && !owner.accountClaim
      || !owner.processIdentity || (await observeProcess(owner.processIdentity)).status !== 'stopped')
      throw new Error('Sign-in ownership or stopped process could not be verified; preserving its reservation');
    kind = 'native-signin';
    environment.executable = owner.executable;
  } else if (owner.kind === 'interactive-cli') {
    if (!equal(Object.keys(owner).sort(), ['host', 'kind', 'pid', 'runId']))
      throw new Error('CLI lock owner fields are invalid; preserving it');
    kind = 'interactive-cli';
    const launches = join(native.root, 'launches'), runDirectory = join(launches, owner.runId);
    await privateDirectory(launches);
    await privateDirectory(runDirectory);
    const reportPath = join(native.root, 'launches', owner.runId, 'report.json');
    const report = await readJSON(reportPath);
    if (report.schemaVersion !== 1 || report.kind !== 'interactive-cli' || report.runId !== owner.runId
      || report.profileId !== profile.id || report.environmentId !== environment.id || report.home !== environment.home
      || (!codex && (report.client !== profile.client || !equal(report.rootIdentity, rootIdentity)
        || ![environment.cwd, ...profile.repositories.map(row => row.path)].includes(report.cwd)
        || typeof report.executable !== 'string' || !isAbsolute(report.executable) || resolve(report.executable) !== report.executable
        || /[\x00-\x1f\x7f]/.test(report.executable)))
      || !['starting', 'running', 'incomplete', 'exited', 'failed'].includes(report.status))
      throw new Error('CLI lock has no matching interrupted run report; preserving it');
    if (!codex) {
      if (Number.isSafeInteger(report.pid) && report.pid > 0 && isAlive(report.pid)) throw new Error('Native CLI may still be live; preserving its lock');
      if (await realpath(report.cwd) !== report.cwd) throw new Error('CLI workspace changed; preserving the run lock');
      environment.cwd = report.cwd;
      environment.executable = report.executable;
    }
  } else throw new Error('Native run lock owner kind or root is invalid; preserving it');

  return { profile, native, environment, lock, owner, kind, signInMarker };
}

/** Preview a stale native-home lock, or recover it only with explicit apply. */
export async function recoverProfileRun(store, name, {
  apply = false, runtime = createDesktopRuntime(), lockPath = globalLock(),
  isAlive: isAliveProcess = alive,
  observeProcess = observeAuditProcess,
  managedDesktop,
  instanceRuntime = createDesktopInstanceRuntime(),
} = {}) {
  if (typeof apply !== 'boolean' || typeof isAliveProcess !== 'function' || typeof observeProcess !== 'function') throw new Error('Invalid profile recovery options');
  const selected = find(await store.read(), name);
  if (['copilot', 'claude-code'].includes(selected.client) && selected.native) {
    const lock = join(selected.native.root, '.run-lock');
    await privateDirectory(selected.native.root);
    if (await exists(lock)) {
      await privateDirectory(lock);
      if ((await readJSON(join(lock, 'owner.json')))?.kind === (selected.client === 'copilot' ? 'copilot-desktop' : 'claude-desktop'))
        return (managedDesktop ?? createManagedDesktop(store, { lockOptions: { lockPath } })).recover(name, { apply });
    }
  }
  const checks = { isAlive: isAliveProcess, observeProcess, instanceRuntime };
  const preview = await candidate(store, name, checks);
  const result = { status: 'preview', applyChecks: 'pending', profile: { id: preview.profile.id, name: preview.profile.name },
    root: preview.native.root, runId: preview.owner.runId, kind: preview.kind,
    marker: preview.kind === 'native-home-login' && preview.signInMarker.phase === 'login-running'
      ? 'login-running -> login-cancelled' : 'unchanged' };
  if (!apply) return result;
  if (!runtime || typeof runtime.assertExternal !== 'function' || typeof runtime.assertIdle !== 'function')
    throw new Error('Profile recovery requires external-terminal and writer-quiescence checks');
  await runtime.assertExternal();

  const recover = () => store.withLock(async data => {
    const current = find(data, preview.profile.id);
    if (!equal(current.native, preview.profile.native)) throw new Error('Profile native-home binding changed; preserving the run lock');
    const fresh = await candidate(store, current.id, checks);
    if (!equal(fresh.owner, preview.owner) || fresh.kind !== preview.kind)
      throw new Error('Native run lock owner changed; preserving it');
    if (fresh.plan) {
      if (!equal(fresh.desktopPeer, preview.desktopPeer)) throw new Error('Desktop peer changed; preserving the CLI reservation');
      const allowedProcesses = fresh.desktopPeer
        ? (await observeCodexDesktopPeer(store, fresh.plan, fresh.desktopPeer, instanceRuntime)).processes : [];
      await instanceRuntime.assertResourcesIdle(codexResourcePaths(fresh.plan), { allowedProcesses, profileHome: fresh.plan.home });
      const checked = await candidate(store, current.id, checks);
      if (!equal(checked.owner, fresh.owner) || !equal(checked.desktopPeer, fresh.desktopPeer))
        throw new Error('Native participants changed; preserving the CLI reservation');
      await releaseProfileParticipant(fresh.native.root, fresh.owner);
      return { ...result, status: 'recovered', applyChecks: 'passed' };
    }
    const home = fresh.environment.home;
    await runtime.assertIdle({ cliExecutables: [...new Set([fresh.native.executable, fresh.environment.executable].filter(Boolean))], resourcePaths: [
      fresh.native.root, home, fresh.environment.cwd, fresh.environment.desktopData,
      ...(!current.client || current.client === 'codex' ? [join(home, 'config.toml'), join(home, 'auth.json'), join(home, 'state_5.sqlite'),
        join(home, 'state_5.sqlite-wal'), join(home, 'state_5.sqlite-shm')] : [join(home, 'settings.json')]),
    ].filter(Boolean) });
    if (current.client && current.client !== 'codex') {
      const checked = await candidate(store, current.id, checks);
      if (!equal(checked.owner, fresh.owner) || !equal(checked.environment, fresh.environment)) throw new Error('Native run changed; preserving its lock');
    }
    const ownerBeforeMutation = await readJSON(join(fresh.lock, 'owner.json'));
    if (!equal(ownerBeforeMutation, fresh.owner) || isAliveProcess(fresh.owner.pid))
      throw new Error('Native run owner changed or may be live; preserving it');
    const reconciled = fresh.kind === 'native-home-login'
      ? await reconcileInterruptedSignIn({ root: fresh.native.root, profileId: current.id, apply: true }) : null;
    const latestOwner = await readJSON(join(fresh.lock, 'owner.json'));
    if (!equal(latestOwner, fresh.owner)) throw new Error('Native run lock owner changed; preserving it');
    if (fresh.kind === 'native-signin' && current.client === 'copilot')
      await recoverCopilotAccountClaim(fresh.owner.accountClaim, { userHome: fresh.owner.userHome });
    await release(fresh.lock, fresh.owner);
    return { ...result, status: 'recovered', applyChecks: 'passed',
      marker: reconciled?.changed ? 'login-running -> login-cancelled' : 'unchanged',
      ...(reconciled ? { setupPhase: reconciled.phase } : {}) };
  });
  if (preview.plan) {
    return withProfileOperation(store, preview.profile.id, { lockPath, recovery: true, isAlive: isAliveProcess }, recover);
  }
  const guardPath = `${lockPath}.operation`;
  const guard = { kind: 'profile-run-recovery', host: hostname(), pid: process.pid,
    runId: randomUUID(), storePath: store.directory };
  await acquire(guardPath, guard, true);
  try { return await recover(); }
  finally { await release(guardPath, guard); }
}
