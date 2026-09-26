// Everyday desktop selection. The operation exits after launch; a durable
// reservation protects the selected home until a later switch or restoration.
import { join, resolve } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveHome, loadHomeBinding } from './homes.js';
import { createDesktopRuntime, DESKTOP_APP, sameDesktopApp } from './desktop-runtime.js';
import { globalLock, exists, privateDirectory, readJSON, record, acquire, release } from './metadata.js';
import { attachPairedRuntime, pairedStatus } from './desktop-paired.js';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const absolute = p => typeof p === 'string' && p.startsWith('/') && resolve(p) === p && !/[\x00-\x1f\x7f]/.test(p);
const paths = store => ({ directory: join(store.directory, 'desktop-selection'), journal: join(store.directory, 'desktop-selection', 'session.json') });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const retained = runtime => runtime.retainedCrashpad?.() ?? [];

const validRequestedTransition = transition => transition && typeof transition === 'object'
  && Object.keys(transition).length === 2 && Object.hasOwn(transition, 'from') && Object.hasOwn(transition, 'to')
  && sameDesktopApp(transition.from, transition.to);
const validPersistedTransition = transition => transition && typeof transition === 'object'
  && sameDesktopApp(transition.from, transition.to)
  && transition.activePlan && typeof transition.activePlan === 'object' && equal(transition.activePlan.app, transition.from)
  && typeof transition.reviewedAt === 'string' && transition.reviewedAt;

function validOwner(owner, store, kind = 'desktop-selection') {
  return owner?.kind === kind && owner.host === hostname() && owner.storePath === store.directory
    && owner.journalPath === paths(store).journal && uuid.test(owner.runId ?? '')
    && Number.isSafeInteger(owner.pid) && owner.pid > 0;
}
async function readSession(store) {
  const { directory, journal } = paths(store);
  if (!await exists(directory)) return null;
  await privateDirectory(directory);
  if (!await exists(journal)) return null;
  const session = await readJSON(journal);
  if (session.schemaVersion !== 1 || session.kind !== 'desktop-selection-session'
    || (session.pairedActivationId !== undefined && !uuid.test(session.pairedActivationId))
    || (session.pairedActivationIntent !== undefined && (!uuid.test(session.pairedActivationIntent?.id ?? '')
      || typeof session.pairedActivationIntent?.approvalId !== 'string'))
    || !validOwner(session.owner, store) || session.id !== session.owner.runId
    || !['prepared', 'active', 'stopping', 'opening', 'restoring', 'restored', 'incomplete'].includes(session.phase)
    || !Array.isArray(session.reservedRoots) || !session.reservedRoots.every(absolute)
    || new Set(session.reservedRoots).size !== session.reservedRoots.length
    || !Array.isArray(session.reservedBindings) || session.reservedBindings.length !== session.reservedRoots.length
    || session.reservedBindings.some((binding, index) => binding?.root !== session.reservedRoots[index])
    || (session.appPinTransition !== undefined && !validPersistedTransition(session.appPinTransition))
    || (session.phase === 'active' && !session.active)
    || (session.phase === 'prepared' && session.active)
    || (session.phase === 'restored' && (session.active || session.target))) throw new Error('Invalid desktop selection journal');
  return session;
}
async function save(store, session, phase, extra = {}) {
  Object.assign(session, extra, { phase, updatedAt: new Date().toISOString() });
  await record(paths(store).journal, session);
}
async function validatePlan(plan, runtime, { createData = false, inspectApp = true } = {}) {
  if (!plan || !uuid.test(plan.profileId ?? '')) throw new Error('Invalid desktop profile plan');
  const { native, environment } = await loadHomeBinding(plan.native);
  const { PATH: currentPath, ...currentEnvironment } = environment.launch.env;
  if (plan.nativeRoot !== native.root || plan.environmentId !== environment.id
    || plan.home !== environment.home || plan.cwd !== environment.cwd || !equal(plan.env, currentEnvironment)
    || plan.desktopData !== environment.desktopData || (inspectApp && !sameDesktopApp(await runtime.inspectApp(), plan.app)))
    throw new Error('Desktop profile paths or app changed; preserving the current selection');
  if (createData || await exists(plan.desktopData)) await privateDirectory(plan.desktopData, createData);
}

async function reviewedTransition(session, runtime, requested, operation) {
  if (requested !== undefined && operation !== 'restore') throw new Error('A reviewed app transition is allowed only while restoring the recorded desktop');
  if (requested !== undefined && !validRequestedTransition(requested)) throw new Error('Invalid reviewed app transition');
  // A completed transition is historical evidence only. It must not prevent a
  // later ordinary switch from closing the restored journal and beginning a
  // fresh session under the current app pin.
  if (session.phase === 'restored' && !session.active && !session.target)
    return null;
  if (requested && session.appPinTransition && (!sameDesktopApp(requested.from, session.appPinTransition.from)
    || !sameDesktopApp(requested.to, session.appPinTransition.to))) throw new Error('The pending reviewed app transition changed; preserve its recovery record');
  const persisted = operation === 'recover' ? session.appPinTransition : undefined;
  if (session.appPinTransition && !persisted && requested === undefined)
    throw new Error('The reviewed app transition needs desktop recover');
  const transition = requested ?? persisted;
  if (!transition) return null;
  if (session.pairedActivationId || session.pairedActivationIntent || session.target || !session.active
    || !sameDesktopApp(session.active.app, transition.from)) throw new Error('Reviewed app transition does not match an unpaired active desktop selection');
  const installed = await runtime.inspectApp();
  if (!sameDesktopApp(installed, transition.to)) throw new Error('Reviewed app transition no longer matches the installed app');
  // The old launch is historical evidence. Validate every stable plan field
  // against the reviewed current pin, without ever replacing its saved app.
  await validatePlan({ ...session.active, app: transition.to }, runtime);
  if (!session.appPinTransition) {
    session.appPinTransition = { from: transition.from, to: transition.to,
      activePlan: JSON.parse(JSON.stringify(session.active)), reviewedAt: new Date().toISOString() };
  }
  return transition;
}

async function persistReviewedTransition(store, session, transition) {
  if (!transition || !session.appPinTransition) return;
  const path = join(paths(store).directory, `app-pin-transition-${session.id}.json`);
  const existing = await exists(path);
  if (existing) {
    const prior = await readJSON(path), expected = session.appPinTransition;
    if (!validPersistedTransition(prior) || !equal(prior.from, expected.from) || !equal(prior.to, expected.to)
      || !equal(prior.activePlan, expected.activePlan)) throw new Error('Reviewed app transition evidence changed; preserving the desktop selection');
    session.appPinTransition = prior;
  }
  // The journal contains the complete recovery authority. Persist it before
  // its historical copy, so recovery can recreate a missing copy after a crash.
  await save(store, session, session.phase);
  if (!existing) await record(path, session.appPinTransition);
}

export async function selectionPlan(store, name, { runtime = createDesktopRuntime(), inspectApp = true } = {}) {
  const { profile, native, environment } = await resolveHome(store, name);
  const { PATH: runtimePath, ...environmentWithoutPath } = environment.launch.env;
  const plan = { profileId: profile.id, name: profile.name, native: profile.native,
    nativeRoot: native.root, environmentId: environment.id,
    home: environment.home, cwd: environment.cwd, env: environmentWithoutPath,
    desktopData: environment.desktopData, ...(inspectApp ? { app: await runtime.inspectApp() } : {}),
    leavesDesktopRunning: true, liveHomeChanged: false };
  if (await exists(plan.desktopData)) await privateDirectory(plan.desktopData);
  return plan;
}

const safeProcess = process => process && Number.isSafeInteger(process.pid) && process.pid > 0
  && Number.isSafeInteger(process.ppid) && process.ppid >= 0
  && Number.isSafeInteger(process.uid) && process.uid >= 0 && typeof process.startedAt === 'string' && process.startedAt
  && typeof process.executable === 'string' && process.executable.startsWith('/') && !/[\x00-\x1f\x7f]/.test(process.executable);
const processIdentity = process => ({ pid: process.pid, uid: process.uid, startedAt: process.startedAt, executable: process.executable });
const sameProcess = (left, right) => safeProcess(left) && safeProcess(right)
  && left.pid === right.pid && left.uid === right.uid && left.startedAt === right.startedAt && left.executable === right.executable;
const safeObservationError = error => ({
  code: typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'PROCESS_INSPECTION_UNAVAILABLE',
  message: 'Unable to inspect Codex desktop processes',
});

const activationTarget = plan => `profile:${plan?.profileId}`;

function selectionAgrees(session, activation) {
  if (!activation) return true;
  if (activation.recoveryRequired) return false;
  const expected = session?.phase === 'active' && !session.target ? activationTarget(session.active)
    : !session || ['prepared', 'restored'].includes(session.phase) ? 'Default' : undefined;
  return expected !== undefined && activation.selected === expected;
}

async function assertPairedSelection(runtime, selected) {
  const activation = await runtime.pairedStatus?.();
  if (activation && (activation.recoveryRequired || activation.selected !== selected))
    throw new Error('Controller and paired activation disagree; preserve reservations and run desktop recover');
}

/** Observe the pinned desktop process set without changing its lifecycle. */
async function newObservation(session, runtime) {
  let snapshot;
  try { snapshot = await runtime.snapshot(); }
  catch (error) { return { status: 'unavailable', error: safeObservationError(error) }; }
  if (!Array.isArray(snapshot)) return { status: 'unavailable', error: safeObservationError() };

  // A restored desktop is always the pinned ordinary launch. Do not let a
  // saved helper process define its executable identity.
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) return { status: 'unavailable', error: safeObservationError() };
  const savedExecutable = session?.active?.app?.executable;
  const executable = typeof savedExecutable === 'string' && savedExecutable.startsWith('/') ? savedExecutable : DESKTOP_APP.executable;
  const candidateRows = snapshot.filter(process => process?.executable === executable);
  if (candidateRows.some(process => !safeProcess(process)))
    return { status: 'unavailable', error: safeObservationError() };
  const mains = candidateRows.filter(process => process.uid === uid);
  if (mains.length > 1) return { status: 'multiple', home: 'unknown', mains: mains.map(processIdentity) };
  if (!mains.length) return { status: 'none' };

  const main = mains[0];
  if (!session) return { status: 'unmanaged-unknown', home: 'unknown', main: processIdentity(main) };
  const recorded = session.active ? session.trackedProcesses : session.restoredProcesses;
  const recordedMain = Array.isArray(recorded) && recorded.find(process => safeProcess(process) && process.executable === executable);
  if (!recordedMain) return { status: 'unmanaged-unknown', home: 'unknown', main: processIdentity(main) };
  if (!sameProcess(main, recordedMain)) return { status: 'different-main', home: 'unknown', main: processIdentity(main) };
  if (session.active) return { status: 'matching-active-profile', profileId: session.active.profileId, main: processIdentity(main) };
  return { status: 'matching-default-desktop', main: processIdentity(main) };
}

/** Read the recorded selection, without claiming the app is still running. */
export async function currentDesktop(store, { observe = false, runtime, defaultUserHome } = {}) {
  const session = await readSession(store);
  const activation = await pairedStatus(store, { defaultUserHome });
  if (session?.pairedActivationId && session.pairedActivationId !== activation?.activationId)
    throw new Error('Paired activation metadata is missing or changed');
  if (!session) {
    const result = { status: 'unmanaged', activeProfile: null };
    if (activation) Object.assign(result, { pairedActivation: activation, liveHomeChanged: activation.liveHomeChanged,
      recoveryRequired: !selectionAgrees(null, activation) });
    return observe ? { ...result, observedDesktop: await newObservation(null, runtime ?? createDesktopRuntime()) } : result;
  }
  const plan = session.active;
  const profile = plan && (await store.read()).profiles.find(p => p.id === plan.profileId);
  const result = { status: session.phase, activeProfile: plan ? { id: plan.profileId, name: profile?.name ?? plan.name,
    home: plan.home, desktopData: plan.desktopData } : null,
    observation: 'last-recorded-selection', updatedAt: session.updatedAt,
    recoveryRequired: Boolean(session.cleanupRequired || session.target) || !['active', 'restored'].includes(session.phase), journalPath: paths(store).journal,
    liveHomeChanged: false };
  if (activation) Object.assign(result, { pairedActivation: activation, liveHomeChanged: activation.liveHomeChanged,
    recoveryRequired: result.recoveryRequired || !selectionAgrees(session, activation) });
  return observe ? { ...result, observedDesktop: await newObservation(session, runtime ?? createDesktopRuntime()) } : result;
}

async function ownedReservation(path, owner) {
  if (!await exists(path)) return false;
  await privateDirectory(path);
  try { return equal(await readJSON(join(path, 'owner.json')), owner); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Native home reservation has no owner record; preserving it for manual inspection');
    throw error;
  }
}
async function reserve(store, session, root) {
  const path = join(root, '.run-lock');
  // Journal intent before acquiring so a later recovery can release this
  // exact owner's lock. A crash before owner.json exists remains ambiguous
  // with a concurrent CLI acquisition and must be preserved for inspection.
  if (!session.reservedRoots.includes(root)) {
    session.reservedRoots.push(root);
    session.reservedBindings.push(session.target.native);
    await save(store, session, session.phase);
  }
  if (await exists(path)) {
    if (!await ownedReservation(path, session.owner)) throw new Error('The selected native home is in use; its lock was preserved');
  } else await acquire(path, session.owner);
}
async function releaseUnused(store, session, keepRoot = null) {
  for (const root of session.reservedRoots) {
    if (root === keepRoot) continue;
    const path = join(root, '.run-lock');
    // An inactive root can already have a new CLI owner after an interrupted
    // cleanup. Release only this selection's own reservation.
    if (await ownedReservation(path, session.owner)) await release(path, session.owner);
  }
  session.reservedBindings = session.reservedBindings.filter(binding => binding.root === keepRoot);
  session.reservedRoots = keepRoot ? [keepRoot] : [];
  await save(store, session, session.phase);
}
async function validateReservations(session) {
  for (const binding of session.reservedBindings) await loadHomeBinding(binding);
  if (session.active && !session.reservedRoots.includes(session.active.nativeRoot))
    throw new Error('Active desktop reservation is absent from its journal');
}
async function checkActiveReservation(session) {
  if (session.active && !await ownedReservation(join(session.active.nativeRoot, '.run-lock'), session.owner))
    throw new Error('Active desktop home ownership changed; preserving state');
}
async function snapshot(store, session, runtime, phase) {
  await save(store, session, phase, { trackedProcesses: await runtime.snapshot(), retainedCrashpad: retained(runtime) });
}
async function stop(store, session, runtime) {
  await snapshot(store, session, runtime, 'stopping');
  await runtime.stop();
}
async function openSelection(store, session, runtime, plan) {
  await validatePlan(plan, runtime, { createData: true });
  await save(store, session, 'opening', { target: plan });
  if (!runtime.pairedActivationIntent) await runtime.ensureHomeLogs?.({ home: plan.home, key: plan.environmentId });
  const processes = await runtime.open(plan);
  await assertPairedSelection(runtime, activationTarget(plan));
  await save(store, session, 'active', { active: plan, target: null, trackedProcesses: processes,
    retainedCrashpad: retained(runtime), errorCode: null, remainingProcesses: [], cleanupRequired: true,
    ...(runtime.pairedActivationId ? { pairedActivationId: runtime.pairedActivationId } : {}) });
  await releaseUnused(store, session, plan.nativeRoot);
  await save(store, session, 'active', { cleanupRequired: false });
}
async function restoreDefault(store, session, runtime) {
  await save(store, session, 'restoring');
  if (!runtime.pairedActivationIntent) await runtime.ensureHomeLogs?.({ home: join(userInfo().homedir, '.codex'), key: 'default' });
  const processes = await runtime.restore();
  await assertPairedSelection(runtime, 'Default');
  if (!runtime.pairedActivationId) delete session.pairedActivationIntent;
  await save(store, session, 'restored', { active: null, target: null, trackedProcesses: [],
    restoredProcesses: processes, retainedCrashpad: retained(runtime), errorCode: null, remainingProcesses: [], cleanupRequired: true });
  await releaseUnused(store, session);
}

/** One operation at a time across stores; active desktop reservations outlive
 * the controlling terminal. Recovery reclaims only a verified dead guard. */
async function operate(store, operation, name, { runtime = createDesktopRuntime(), ready = async () => true,
  signal, lockPath = globalLock(), isAlive = alive, onProgress = () => {}, requestedActivationPlan, reviewedAppTransition, defaultUserHome, noOpen = false } = {}) {
  if (typeof noOpen !== 'boolean' || (noOpen && (operation !== 'recover' || requestedActivationPlan || reviewedAppTransition)))
    throw new Error('noOpen is available only for recovery of the recorded selection');
  if (noOpen) {
    if (typeof runtime.assertIdle !== 'function') throw new Error('No-open recovery requires writer-quiescence inspection');
    // No process control or log preparation. Path ownership and writer checks
    // still run; callers must close native clients themselves first.
    runtime = { ...runtime, ensureLogStorage: undefined, ensureHomeLogs: undefined, restore: async () => [] };
  }
  await runtime.assertExternal();
  const target = operation === 'switch' ? await selectionPlan(store, name, { runtime }) : null;
  if (!await ready({ signal }) || signal?.aborted) return { status: 'cancelled' };
  await privateDirectory(store.directory);
  await privateDirectory(paths(store).directory, true);
  const guardPath = `${lockPath}.selection`;
  const guard = { kind: 'desktop-selection-operation', host: hostname(), pid: process.pid,
    runId: randomUUID(), storePath: store.directory, journalPath: paths(store).journal };
  if (await exists(guardPath)) {
    await privateDirectory(guardPath);
    const prior = await readJSON(join(guardPath, 'owner.json'));
    if (operation !== 'recover' || !validOwner(prior, store, guard.kind) || isAlive(prior.pid))
      throw new Error('Another desktop operation is running or needs desktop recover');
    await release(guardPath, prior);
  }
  await acquire(guardPath, guard, true);
  let session;
  const begin = async () => {
    const owner = { ...guard, kind: 'desktop-selection' };
    await acquire(lockPath, owner, true);
    const created = { schemaVersion: 1, kind: 'desktop-selection-session', id: owner.runId, owner,
      startedAt: new Date().toISOString(), active: null, target: null, reservedRoots: [], reservedBindings: [], trackedProcesses: [],
      liveHomeChanged: false };
    if (runtime.pairedActivationId) created.pairedActivationId = runtime.pairedActivationId;
    if (runtime.pairedActivationIntent) created.pairedActivationIntent = runtime.pairedActivationIntent;
    await save(store, created, 'prepared');
    return created;
  };
  try {
    session = await readSession(store);
    if (session) await validateReservations(session);
    // A desktop auto-update changes the on-disk pin while an old launch-only
    // selection is still reserved. Only the explicit restore transition below
    // may cross that boundary; ordinary validation remains strict.
    const transition = session && !noOpen ? await reviewedTransition(session, runtime, reviewedAppTransition, operation) : null;
    runtime = await attachPairedRuntime(store, runtime, { requestedPlan: requestedActivationPlan, session, defaultUserHome, operation, noOpen });
    const pairedAtEntry = await runtime.pairedStatus?.();
    const agreesAtEntry = selectionAgrees(session, pairedAtEntry);
    if ((!session || ['prepared', 'restored'].includes(session.phase)) && !agreesAtEntry)
      throw new Error('Controller and paired activation disagree without an unfinished selection; preserve state for manual inspection');
    const unfinishedAtEntry = session && (session.cleanupRequired || session.target
      || !['active', 'prepared', 'restored'].includes(session.phase) || !agreesAtEntry);
    if (!await exists(lockPath) && session && session.phase !== 'restored') {
      // The global reservation lives in /private/tmp and can disappear across
      // a reboot. Rebuild only from this journal's exact persistent home locks,
      // under the operation guard; never invent or replace a home reservation.
      if (session.phase !== 'active' && operation !== 'recover')
        throw new Error('An interrupted desktop operation needs desktop recover');
      if (session.phase !== 'active' && isAlive(session.owner.pid))
        throw new Error('The recorded desktop controller is still running; preserving its journal');
      if (!session.reservedRoots.length)
        throw new Error('Desktop reservation is missing without a persistent home reservation; preserving its unfinished journal');
      for (const root of session.reservedRoots) {
        if (!await ownedReservation(join(root, '.run-lock'), session.owner))
          throw new Error('Desktop reservation is missing and persistent home ownership changed; preserving state');
      }
      if (session.active && !transition) await validatePlan(session.active, runtime, { inspectApp: !noOpen });
      if (session.target) await validatePlan(session.target, runtime, { inspectApp: !noOpen });
      await acquire(lockPath, session.owner, true);
      onProgress('Rebuilt the missing desktop reservation; continuing.');
    }
    if (await exists(lockPath)) {
      await privateDirectory(lockPath);
      const owner = await readJSON(join(lockPath, 'owner.json'));
      if (!validOwner(owner, store)) throw new Error('Desktop belongs to another controller or store; preserve its lock and use its recovery command');
      if (!session || !equal(owner, session.owner)) {
        if (operation !== 'recover' || isAlive(owner.pid) || (session && session.phase !== 'restored'))
          throw new Error('Desktop reservation has no matching journal; use desktop recover after its controller exits');
        // No journal means this owner could not have touched a native app.
        await release(lockPath, owner);
        return { status: 'unmanaged', recoveredBeforeLaunch: true };
      }
    } else {
      if (session && session.phase !== 'restored') throw new Error('Desktop reservation disappeared during validation; preserving its unfinished journal');
      if (session) {
        await releaseUnused(store, session);
        await save(store, session, 'restored', { cleanupRequired: false });
      }
      if (operation !== 'switch') {
        await runtime.recoverPendingPairedRegistration?.();
        return { status: session ? 'restored' : 'unmanaged', desktopChanged: false };
      }
      session = await begin();
    }
    if (operation === 'recover') await runtime.recoverPendingPairedRegistration?.();
    if (session.phase === 'restored') {
      await releaseUnused(store, session);
      await release(lockPath, session.owner);
      await save(store, session, 'restored', { cleanupRequired: false });
      if (operation === 'switch') session = await begin();
      else return { status: 'restored', desktopChanged: false };
    }
    if (operation !== 'switch' && session.phase === 'prepared') {
      // No stop can occur before the stopping phase is durable. This crash
      // window requires metadata cleanup only; the ordinary app is untouched.
      await save(store, session, 'restored', { target: null, cleanupRequired: true });
      await releaseUnused(store, session);
      await release(lockPath, session.owner);
      await save(store, session, 'restored', { cleanupRequired: false });
      return { status: 'restored', desktopChanged: false, recoveredBeforeLaunch: true };
    }
    if (operation === 'recover' && !noOpen && agreesAtEntry && session.phase === 'active' && session.cleanupRequired) {
      await checkActiveReservation(session);
      await releaseUnused(store, session, session.active.nativeRoot);
      await save(store, session, 'active', { cleanupRequired: false });
      return { status: 'active', desktopLeftRunning: true, recoveredCleanup: true };
    }
    if (operation !== 'recover' && !['active', 'prepared'].includes(session.phase))
      throw new Error('An interrupted desktop operation needs desktop recover');
    runtime.seedTracked(session.trackedProcesses ?? []);
    await checkActiveReservation(session);
    // No-open recovery does not execute an app transition, but its already
    // validated historical evidence must survive the next journal replacement.
    await persistReviewedTransition(store, session, transition ?? (noOpen ? session.appPinTransition : null));
    if (session.active && !transition) await validatePlan(session.active, runtime, { inspectApp: !noOpen });
    if (session.target) await validatePlan(session.target, runtime, { inspectApp: !noOpen });
    if (!noOpen && !session.active && !target) {
      // Recovery still pins the app before controlling the ordinary desktop.
      await runtime.inspectApp();
    }
    // Do not reopen a historical launch after its app pin changed. Any rollback
    // from this one-way reconciliation restores only the current normal app.
    const previous = session.active, rollbackProfile = transition || noOpen ? null : previous;
    let touched = false, stopping = false;
    try {
      if (signal?.aborted) throw Object.assign(new Error('Desktop selection cancelled'), { code: 'CANCELLED' });
      await runtime.ensureLogStorage?.({ signal });
      if (target) {
        await validatePlan(target, runtime, { createData: true });
        await save(store, session, session.phase, { target });
        await reserve(store, session, target.nativeRoot);
      }
      if (signal?.aborted) throw Object.assign(new Error('Desktop selection cancelled'), { code: 'CANCELLED' });
      await checkActiveReservation(session);
      // Paired activation owns its target validation and client preparation so
      // a selected profile is checked before any editor is asked to quit.
      if (runtime.beforeStop) await runtime.beforeStop(target);
      else {
        const activePlan = target ?? session.active;
        const cliExecutables = activePlan ? [(await loadHomeBinding(activePlan.native)).native.executable] : [];
        if (noOpen) await runtime.assertIdle({ cliExecutables });
        else {
          await runtime.prepareClients?.({ cliExecutables });
          if (signal?.aborted) throw Object.assign(new Error('Desktop selection cancelled'), { code: 'CANCELLED' });
          await runtime.assertNoOtherClients?.({ cliExecutables });
        }
      }
      if (signal?.aborted) throw Object.assign(new Error('Desktop selection cancelled'), { code: 'CANCELLED' });
      onProgress(noOpen ? 'Restoring owned paths without launching Codex.'
        : target ? `Switching to ${target.name}. Confirm Quit in Codex if prompted.` : 'Restoring the default desktop. Confirm Quit in Codex if prompted.');
      touched = true; stopping = !noOpen;
      if (noOpen) await save(store, session, 'restoring');
      else await stop(store, session, runtime);
      stopping = false;
      if (target && !signal?.aborted) await openSelection(store, session, runtime, target);
      else if (signal?.aborted && rollbackProfile) await openSelection(store, session, runtime, rollbackProfile);
      else {
        await restoreDefault(store, session, runtime);
        await release(lockPath, session.owner);
        await save(store, session, 'restored', { cleanupRequired: false });
      }
      return { status: signal?.aborted ? 'cancelled' : session.phase,
        activeProfile: session.active ? { id: session.active.profileId, name: session.active.name, home: session.active.home } : null,
        desktopLeftRunning: session.phase === 'active', journalPath: paths(store).journal,
        liveHomeChanged: runtime.pairedStatus ? (await runtime.pairedStatus()).liveHomeChanged : false };
    } catch (error) {
      if (!touched && (unfinishedAtEntry || noOpen)) {
        // This attempt has changed no aliases, but the previous attempt may
        // have. Its journal and reservations remain the recovery authority.
        const failure = new Error(`Desktop recovery remains required; unfinished state and reservations were preserved. ${error.message}`);
        if (error.code === 'CANCELLED' || error.name === 'AbortError') failure.code = 'CANCELLED';
        throw failure;
      }
      if (touched && ['active', 'restored'].includes(session.phase)) {
        // The new desktop (or default desktop) is already committed. A lock
        // cleanup failure must not stop it again during automatic rollback.
        await save(store, session, session.phase, { cleanupRequired: true }).catch(() => {});
        throw new Error(`Desktop is ${session.phase}, but reservation cleanup needs desktop recover. ${error.message}`);
      }
      // A failed quit never prompts a second quit. Other failures restore the
      // previous selection, or the ordinary desktop for the first selection.
      try {
        if (stopping || noOpen) throw error;
        if (touched) {
          await stop(store, session, runtime);
          if (rollbackProfile) await openSelection(store, session, runtime, rollbackProfile);
          else await restoreDefault(store, session, runtime);
        } else {
          await save(store, session, previous ? 'active' : 'restored', { active: previous, target: null, cleanupRequired: true });
          await releaseUnused(store, session, previous?.nativeRoot);
        }
        if (session.phase === 'restored') await release(lockPath, session.owner);
        await save(store, session, session.phase, { cleanupRequired: false });
      } catch (recoveryError) {
        if (!touched && ['active', 'restored'].includes(session.phase)) {
          await save(store, session, session.phase, { cleanupRequired: true }).catch(() => {});
          throw new Error(`Desktop was not changed; reservation cleanup needs desktop recover. ${recoveryError.message}`);
        }
        await save(store, session, 'incomplete', { failurePhase: session.phase,
          errorCode: /^[A-Z_]+$/.test(recoveryError.code ?? '') ? recoveryError.code : 'DESKTOP_SELECTION_FAILED',
          remainingProcesses: recoveryError.remainingProcesses ?? [], retainedCrashpad: retained(runtime) }).catch(() => {});
        throw new Error(`Desktop recovery is required; reservations were preserved. Run desktop recover with this store. ${recoveryError.message}`);
      }
      if (error.code === 'CANCELLED') return { status: 'cancelled', desktopLeftRunning: session.phase === 'active' };
      throw new Error(`Desktop selection did not complete; the previous desktop was retained or restored. ${error.message}`);
    }
  } finally { await release(guardPath, guard); }
}

export const switchDesktop = (store, name, options) => operate(store, 'switch', name, options);
export const restoreDesktop = (store, options) => operate(store, 'restore', null, options);
export const recoverSelection = (store, options) => operate(store, 'recover', null, options);
