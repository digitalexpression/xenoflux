import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHome } from './homes.js';
import { reconcileInterruptedSignIn } from './home-create.js';
import { currentDesktop } from './desktop-selection.js';
import { createDesktopRuntime } from './desktop-runtime.js';
import { acquire, exists, globalLock, privateDirectory, readJSON, release } from './metadata.js';
import { find } from './profiles.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const selectionJournal = store => join(store.directory, 'desktop-selection', 'session.json');
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
};

async function candidate(store, name, { isAlive }) {
  const profile = find(await store.read(), name);
  if (!profile.native) throw new Error('Profile has no registered native home');
  const { native, environment } = await resolveHome(store, profile.id);
  const lock = join(native.root, '.run-lock');
  if (!await exists(lock)) throw new Error('No interrupted profile run is locked');
  await privateDirectory(lock);
  const owner = await readJSON(join(lock, 'owner.json'));
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !uuid.test(owner.runId ?? ''))
    throw new Error('Native run lock owner is invalid or foreign; preserving it');
  if (isAlive(owner.pid)) throw new Error('Native run owner may still be live; preserving its lock');

  let kind;
  let signInMarker;
  if (owner.kind === 'native-home-login' && owner.root === native.root) {
    if (!equal(Object.keys(owner).sort(), ['host', 'kind', 'pid', 'root', 'runId']))
      throw new Error('Native login lock owner fields are invalid; preserving it');
    kind = 'native-home-login';
    signInMarker = await reconcileInterruptedSignIn({ root: native.root, profileId: profile.id });
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
      || !['starting', 'running', 'incomplete', 'exited', 'failed'].includes(report.status))
      throw new Error('CLI lock has no matching interrupted run report; preserving it');
  } else throw new Error('Native run lock owner kind or root is invalid; preserving it');

  return { profile, native, environment, lock, owner, kind, signInMarker };
}

async function assertNoDesktopAuthority(store, lockPath, defaultUserHome) {
  if (await exists(lockPath)) throw new Error('Desktop selection is reserved; preserve its lock and recover the desktop first');
  const state = await currentDesktop(store, { defaultUserHome });
  if (!['unmanaged', 'restored'].includes(state.status) || state.activeProfile || state.recoveryRequired)
    throw new Error('Desktop selection is active or unfinished; preserve its journal and reservations');
  if (state.pairedActivation?.selected !== undefined
    && (state.pairedActivation.selected !== 'Default' || state.pairedActivation.recoveryRequired))
    throw new Error('Paired activation is pending or selected; preserve its recovery authority');
  const pairedJournal = join(store.directory, 'activation', 'paired-switch.json');
  if (await exists(pairedJournal)) {
    const journal = await readJSON(pairedJournal);
    if (!['committed', 'recovered'].includes(journal.phase)
      || !await exists(join(store.directory, 'activation', 'manifest.json')))
      throw new Error('Paired activation recovery is pending or orphaned; preserve its journal');
  }
  const sessionPath = selectionJournal(store);
  if (await exists(sessionPath)) {
    const session = await readJSON(sessionPath);
    if (session.pairedActivationIntent && !await exists(join(store.directory, 'activation', 'manifest.json')))
      throw new Error('Paired activation intent is pending; preserve its journal');
  }
}

/** Preview a stale native-home lock, or recover it only with explicit apply. */
export async function recoverProfileRun(store, name, {
  apply = false, runtime = createDesktopRuntime(), lockPath = globalLock(),
  defaultUserHome = userInfo().homedir, isAlive: isAliveProcess = alive,
} = {}) {
  if (typeof apply !== 'boolean' || typeof isAliveProcess !== 'function') throw new Error('Invalid profile recovery options');
  const preview = await candidate(store, name, { isAlive: isAliveProcess });
  const result = { status: 'preview', applyChecks: 'pending', profile: { id: preview.profile.id, name: preview.profile.name },
    root: preview.native.root, runId: preview.owner.runId, kind: preview.kind,
    marker: preview.kind === 'native-home-login' && preview.signInMarker.phase === 'login-running'
      ? 'login-running -> login-cancelled' : 'unchanged' };
  if (!apply) return result;
  if (!runtime || typeof runtime.assertExternal !== 'function' || typeof runtime.assertIdle !== 'function')
    throw new Error('Profile recovery requires external-terminal and writer-quiescence checks');
  await runtime.assertExternal();

  const guardPath = `${lockPath}.selection`;
  const guard = { kind: 'desktop-selection-operation', host: hostname(), pid: process.pid,
    runId: randomUUID(), storePath: store.directory, journalPath: selectionJournal(store) };
  await acquire(guardPath, guard, true);
  try {
    await assertNoDesktopAuthority(store, lockPath, defaultUserHome);
    return await store.withLock(async data => {
      const current = find(data, preview.profile.id);
      if (!equal(current.native, preview.profile.native)) throw new Error('Profile native-home binding changed; preserving the run lock');
      const fresh = await candidate(store, current.id, { isAlive: isAliveProcess });
      if (!equal(fresh.owner, preview.owner) || fresh.kind !== preview.kind)
        throw new Error('Native run lock owner changed; preserving it');
      await assertNoDesktopAuthority(store, lockPath, defaultUserHome);
      const home = fresh.environment.home;
      await runtime.assertIdle({ cliExecutables: [fresh.native.executable], resourcePaths: [
        fresh.native.root, home, fresh.environment.cwd, fresh.environment.desktopData,
        join(home, 'config.toml'), join(home, 'auth.json'), join(home, 'state_5.sqlite'),
        join(home, 'state_5.sqlite-wal'), join(home, 'state_5.sqlite-shm'),
      ] });
      const ownerBeforeMutation = await readJSON(join(fresh.lock, 'owner.json'));
      if (!equal(ownerBeforeMutation, fresh.owner) || isAliveProcess(fresh.owner.pid))
        throw new Error('Native run owner changed or may be live; preserving it');
      const reconciled = fresh.kind === 'native-home-login'
        ? await reconcileInterruptedSignIn({ root: fresh.native.root, profileId: current.id, apply: true }) : null;
      const latestOwner = await readJSON(join(fresh.lock, 'owner.json'));
      if (!equal(latestOwner, fresh.owner)) throw new Error('Native run lock owner changed; preserving it');
      await release(fresh.lock, fresh.owner);
      return { ...result, status: 'recovered', applyChecks: 'passed',
        marker: reconciled?.changed ? 'login-running -> login-cancelled' : 'unchanged',
        ...(reconciled ? { setupPhase: reconciled.phase } : {}) };
    });
  } finally { await release(guardPath, guard); }
}
