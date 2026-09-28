// Explicit paired-path native-home integration. Preparation reads metadata only;
// installation is called inside the desktop controller's operation lock.
import { lstat, readlink, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { PairedPathTransaction } from './paired-path-transaction.js';
import { activationPlan } from './activation.js';
import { currentDesktop, selectionPlan } from './desktop-selection.js';
import { assertSymlinkedHome, loadHomeBinding } from './homes.js';
import { exists, privateDirectory, readJSON, record, globalLock, acquire, release } from './metadata.js';
import { sameDesktopApp } from './desktop-runtime.js';
import { ramLogTarget } from './ram-logs.js';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function sameProfileBinding(left, right) {
  // Renames and installed-app metadata change presentation only; retain the
  // reviewed home and launch binding.
  const { name: leftName, app: leftApp, activationTarget: leftTarget, ...leftBinding } = left;
  const { name: rightName, app: rightApp, activationTarget: rightTarget, ...rightBinding } = right;
  return equal(leftBinding, rightBinding);
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const paths = store => ({ root: join(store.directory, 'activation'), manifest: join(store.directory, 'activation', 'manifest.json') });
const inside = (root, path) => path === root || (!relative(root, path).startsWith('../') && relative(root, path) !== '..' && !relative(root, path).startsWith('/'));
const overlaps = (a, b) => inside(a, b) || inside(b, a);
const absolute = path => typeof path === 'string' && path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(path);
const targetFor = profile => profile.activationTarget;
const validTarget = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && value !== 'Default' && !/[\x00-\x1f\x7f]/.test(value);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

async function fact(path, privatePath = false) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(path) !== path || s.uid !== process.getuid()
    || (s.mode & (privatePath ? 0o077 : 0o022))) throw new Error('Activation needs canonical, owned directories without other-user write access');
  return { path, device: s.dev, inode: s.ino, mode: s.mode & 0o777, private: privatePath };
}
async function matchFact(f) {
  if (!f || !absolute(f.path)) throw new Error('Invalid activation directory metadata');
  if (!equal(await fact(f.path, f.private), f)) throw new Error(`Activation directory identity or permissions changed: ${f.path}`);
}

/** Validate a readPairedPlan/preparePairedActivation document against the whole
 * directory set. Device numbers can change between boots; retain the recorded
 * inodes and permissions and require a consistent one-to-one device mapping.
 * The reviewed document stays unchanged. These are filesystem consistency
 * checks, not attestation against a cloned volume or a hostile filesystem. */
export async function pairedDirectoryFacts(plan) {
  const devices = new Map(), previousDevices = new Map(), originals = new Map();
  const match = async (saved, path = saved?.path) => {
    if (!saved || !absolute(saved.path) || !Number.isSafeInteger(saved.device))
      throw new Error('Invalid activation directory metadata');
    const current = await fact(path, saved.private);
    if (!equal({ ...current, path: saved.path, device: saved.device }, saved))
      throw new Error(`Activation directory identity or permissions changed: ${path}`);
    if ((devices.has(saved.device) && devices.get(saved.device) !== current.device)
      || (previousDevices.has(current.device) && previousDevices.get(current.device) !== saved.device))
      throw new Error(`Activation filesystem layout changed: ${path}`);
    devices.set(saved.device, current.device);
    previousDevices.set(current.device, saved.device);
    return { ...saved, device: current.device };
  };
  for (const f of plan.facts) await match(f);
  for (const c of plan.components) {
    // The original moves between these two paths; the alias can be a symlink.
    const path = await exists(c.original) ? c.original : c.alias;
    originals.set(c.alias, await match(c.originalFact, path));
  }
  return originals;
}

/** Build a reviewable native-home plan from inspected paths and runtime identity. */
export async function preparePairedActivation(store, names, { runtime, defaultUserHome = userInfo().homedir } = {}) {
  if (!Array.isArray(names) || !names.length) throw new Error('Choose one or more bound native profiles');
  const profiles = [];
  for (const name of names) profiles.push(await selectionPlan(store, name, { runtime }));
  if (new Set(profiles.map(p => p.profileId)).size !== profiles.length) throw new Error('Choose each activation profile once');
  for (const profile of profiles) profile.activationTarget = `profile:${profile.profileId}`;
  if (new Set(profiles.map(targetFor)).size !== profiles.length) throw new Error('Activation targets must be distinct');
  const preview = await activationPlan(store, names.at(-1), { runtime, defaultUserHome });
  if (preview.changes.some(c => c.conflicts.length || c.source.kind !== 'directory')) throw new Error('Resolve the activation preview path conflicts first');
  if (preview.originalRouting.status !== 'inspected' || !['file', 'native-default-unresolved'].includes(preview.originalRouting.credentialStore)
    || preview.originalRouting.sqliteHome !== null) throw new Error('Original credential or SQLite routing needs a separate proposal');
  if (preview.immediateHomeLinks.status !== 'inspected' || preview.immediateHomeLinks.links.some(link =>
    link.path !== join(defaultUserHome, '.codex', 'logs_2.sqlite') || link.target !== ramLogTarget('default')))
    throw new Error('Original home links need a separate ownership proposal');
  for (const profile of profiles) {
    const log = await exists(join(profile.home, 'logs_2.sqlite'));
    if (log?.isSymbolicLink() && await readlink(join(profile.home, 'logs_2.sqlite')) !== ramLogTarget(profile.environmentId))
      throw new Error('Native home log storage points outside this profile’s RAM directory');
  }
  const components = preview.changes.map((c, index) => ({ name: c.component, alias: c.alias, original: c.originalPath,
    originalFact: null, targets: Object.fromEntries(profiles.map(p => [targetFor(p), index === 0 ? p.home : p.desktopData])) }));
  const facts = [];
  for (const c of components) {
    c.originalFact = await fact(c.alias);
    for (const path of [dirname(c.alias), ...Object.values(c.targets), ...Object.values(c.targets).map(dirname)])
      if (!facts.some(f => f.path === path)) facts.push(await fact(path, Object.values(c.targets).includes(path)));
  }
  const loadedProfiles = await Promise.all(profiles.map(profile => loadHomeBinding(profile.native)));
  const cliByProfile = Object.fromEntries(profiles.map((profile, index) => [profile.profileId, {
    executable: loadedProfiles[index].native.executable, identity: loadedProfiles[index].native.executableIdentity,
    version: loadedProfiles[index].native.version,
  }]));
  const body = { schemaVersion: 1, kind: 'paired-native-home-plan', id: randomUUID(), storePath: store.directory, defaultUserHome,
    app: preview.app, cliByProfile,
    profiles, components, facts, originalRouting: preview.originalRouting,
    resourcePaths: preview.immediateHomeLinks.links.map(link => link.target),
    resourcePolicy: 'Disposable, separate RAM log databases per native home. Prepare storage before launch; require idle log handles before relinking.',
    steps: ['Restore any earlier launch-only desktop reservation through its controller.',
      'Stop Codex gracefully and verify desktop, standalone CLI and explicit RAM-log writers are idle.',
      'Preserve both default directories by sibling rename and install both selected profile aliases.',
      'Launch the pinned app with normal HOME and without per-profile environment overrides.',
      'Check the profile after Dock reopen; use Default to restore both original directories.'],
    liveHomeChanged: false };
  return { ...body, approvalId: digest(body) };
}

function validateDocument(plan, store, defaultUserHome) {
  const { approvalId, ...body } = plan ?? {};
  const normalAliases = [join(defaultUserHome, '.codex'), join(defaultUserHome, 'Library', 'Application Support', 'Codex')];
  if (plan?.schemaVersion !== 1 || plan.kind !== 'paired-native-home-plan' || !uuid.test(plan.id ?? '')
    || approvalId !== digest(body) || plan.storePath !== store.directory || plan.defaultUserHome !== defaultUserHome
    || !Array.isArray(plan.profiles) || !plan.profiles.length || !Array.isArray(plan.components) || plan.components.length !== 2
    || !Array.isArray(plan.facts) || !Array.isArray(plan.resourcePaths)
    || plan.resourcePaths.length > 1
    || plan.resourcePaths.some(path => path !== ramLogTarget('default'))) throw new Error('Invalid or changed paired activation plan');
  const targetsByProfile = plan.profiles.map(targetFor);
  if (plan.profiles.some(p => !uuid.test(p.profileId ?? '') || !p.native || !validTarget(targetFor(p)))
    || new Set(plan.profiles.map(p => p.profileId)).size !== plan.profiles.length
    || new Set(targetsByProfile).size !== targetsByProfile.length) throw new Error('Invalid paired profile binding');
  if (plan.profiles.some(p => p.activationTarget === undefined)) throw new Error('Activation profiles need stable target identifiers');
  if (!plan.cliByProfile || plan.profiles.some(p => !equal(plan.cliByProfile[p.profileId], {
    executable: p.native.executable, identity: p.native.executableIdentity, version: p.native.version,
  }))) throw new Error('Activation profiles need their registered CLI identity');
  for (const [i, c] of plan.components.entries()) {
    const targets = Object.fromEntries(plan.profiles.map(p => [targetFor(p), i === 0 ? p.home : p.desktopData]));
    if (c.name !== ['codex-home', 'desktop-data'][i] || c.alias !== normalAliases[i] || c.original !== `${c.alias}.xenoflux-original`
      || !equal(c.targets, targets) || c.originalFact?.path !== c.alias) throw new Error('Invalid paired activation paths');
  }
  const boundaries = plan.components.flatMap(c => [c.alias, c.original]);
  const targets = plan.components.flatMap(c => Object.values(c.targets));
  if ([...boundaries, ...targets].some(path => !absolute(path) || overlaps(store.directory, path))
    || boundaries.some((a, i) => boundaries.slice(i + 1).some(b => overlaps(a, b)))
    || targets.some((a, i) => [...boundaries, ...targets.slice(i + 1)].some(b => overlaps(a, b)))) throw new Error('Activation paths overlap');
  const required = [...new Set(plan.components.flatMap(c => [dirname(c.alias), ...Object.values(c.targets), ...Object.values(c.targets).map(dirname)]))].sort();
  if (!equal(plan.facts.map(f => f.path).sort(), required)) throw new Error('Activation directory facts are incomplete');
}

// Reuse the same complete validator for a pending intent stored in a session
// journal when registration has not yet written the manifest.
export function validatePairedPlan(plan, store, defaultUserHome = userInfo().homedir) {
  validateDocument(plan, store, defaultUserHome);
  return plan;
}

export async function readPairedPlan(path, store, { defaultUserHome = userInfo().homedir } = {}) {
  const plan = await readJSON(path);
  validateDocument(plan, store, defaultUserHome);
  return plan;
}

/** Propose one additional target without touching the current manifest.  The
 * base approval is part of the candidate hash, so a dry-run cannot later be
 * applied after an unrelated target change. */
export async function planActivationTarget(store, name, { runtime, defaultUserHome = userInfo().homedir } = {}) {
  const p = paths(store), base = await readPairedPlan(p.manifest, store, { defaultUserHome });
  const status = await pairedStatus(store, { defaultUserHome });
  if (!status || status.selected !== 'Default' || status.recoveryRequired)
    throw new Error('Restore the paired aliases before proposing another activation target');
  const selected = await selectionPlan(store, name, { runtime });
  if (base.profiles.some(profile => profile.profileId === selected.profileId))
    throw new Error('This profile is already an activation target');
  const fresh = await preparePairedActivation(store, [...base.profiles.map(profile => profile.profileId), name], { runtime, defaultUserHome });
  const added = fresh.profiles.at(-1), addedTarget = targetFor(added);
  // Retain every reviewed base field byte-for-byte.  Names and installed-app
  // presentation can change after review without changing a native binding;
  // rebuilding them would make an otherwise valid extension look unrelated.
  const components = base.components.map((component, index) => ({ ...component, targets: {
    ...component.targets, [addedTarget]: fresh.components[index].targets[addedTarget],
  } }));
  const knownFacts = new Set(base.facts.map(fact => fact.path));
  // Extensions retain the base document's device-number namespace. A reboot
  // may renumber devices; mixing freshly observed numbers with saved ones
  // would make one physical volume appear to be two different volumes.
  const savedDevices = new Map(), usedDevices = new Set(base.facts.map(f => f.device));
  for (const saved of base.facts) {
    const current = fresh.facts.find(f => f.path === saved.path);
    if (!current) throw new Error('Activation target proposal lost a base directory');
    savedDevices.set(current.device, saved.device);
  }
  const addedFacts = fresh.facts.filter(f => !knownFacts.has(f.path)).map(f => {
    if (!savedDevices.has(f.device)) {
      let device = f.device;
      while (usedDevices.has(device)) device++;
      savedDevices.set(f.device, device); usedDevices.add(device);
    }
    return { ...f, device: savedDevices.get(f.device) };
  });
  const facts = [...base.facts, ...addedFacts];
  const body = { ...fresh, id: base.id, profiles: [...base.profiles, added], components, facts,
    cliByProfile: { ...base.cliByProfile, [added.profileId]: fresh.cliByProfile[added.profileId] },
    extensionOf: { activationId: base.id, approvalId: base.approvalId,
    targetProfileId: selected.profileId } };
  delete body.approvalId;
  const proposal = { ...body, approvalId: digest(body) };
  await pairedDirectoryFacts(proposal);
  return proposal;
}

function matchingExtension(base, candidate) {
  const extension = candidate?.extensionOf;
  if (!extension || extension.activationId !== base.id || extension.approvalId !== base.approvalId
    || !uuid.test(extension.targetProfileId ?? '') || candidate.id !== base.id
    || candidate.profiles.length !== base.profiles.length + 1
    || !candidate.profiles.slice(0, -1).every((profile, index) => equal(profile, base.profiles[index]))
    || candidate.profiles.at(-1).profileId !== extension.targetProfileId
    || base.components.some((component, index) => component.alias !== candidate.components[index]?.alias
      || component.original !== candidate.components[index]?.original
      || !equal(component.originalFact, candidate.components[index]?.originalFact)
      || !Object.entries(component.targets).every(([target, path]) => candidate.components[index].targets[target] === path)))
    throw new Error('Activation target proposal does not extend the current reviewed manifest');
}

async function assertRestoredUnreserved(store, defaultUserHome) {
  const status = await currentDesktop(store, { defaultUserHome });
  if (status.recoveryRequired || !['unmanaged', 'restored'].includes(status.status)
    || status.pairedActivation?.selected !== 'Default' || status.pairedActivation?.recoveryRequired)
    throw new Error('Restore the desktop and paired aliases before registering another target');
  const sessionPath = join(store.directory, 'desktop-selection', 'session.json');
  if (!await exists(sessionPath)) return;
  const session = await readJSON(sessionPath);
  if (session.phase !== 'restored' || session.active !== null || session.target !== null || session.cleanupRequired
    || !Array.isArray(session.reservedRoots) || session.reservedRoots.length
    || !Array.isArray(session.reservedBindings) || session.reservedBindings.length)
    throw new Error('Desktop selection remains reserved or unfinished; preserve its recovery record');
}

function validRegistrationOwner(owner, store) {
  return owner?.kind === 'activation-target-registration' && owner.host === hostname() && owner.storePath === store.directory
    && Number.isSafeInteger(owner.pid) && owner.pid > 0 && uuid.test(owner.runId ?? '');
}

async function reclaimRegistrationLocks(store, lockPath, isAlive) {
  const guardPath = `${lockPath}.selection`, guard = await exists(guardPath), lock = await exists(lockPath);
  if (!guard && !lock) return;
  const readOwner = async path => { await privateDirectory(path); return readJSON(join(path, 'owner.json')); };
  const guardOwner = guard ? await readOwner(guardPath) : null;
  const lockOwner = lock ? await readOwner(lockPath) : null;
  const owner = guardOwner ?? lockOwner;
  if (!validRegistrationOwner(owner, store) || (guardOwner && lockOwner && !equal(guardOwner, lockOwner)))
    throw new Error('Another desktop operation is running or needs desktop recover');
  if (isAlive(owner.pid)) throw new Error('Another desktop operation is running or needs desktop recover');
  // The guard is acquired first, so guard-only is the expected crash window.
  // A pair shares one exact owner and can be released in reverse acquisition
  // order.  Never reclaim a lone main lock: it is not a normal registration
  // state and may belong to a different controller sequence.
  if (!guard) throw new Error('Registration lock state is incomplete; preserving lock');
  if (lock) await release(lockPath, owner);
  await release(guardPath, owner);
}

/** Install an approved extension while excluding desktop and CLI operations.
 * The aliases remain in Default throughout; only the reviewed target list is
 * replaced atomically after all current transaction authorities agree. */
export async function registerActivationTarget(store, approved, { runtime, defaultUserHome = userInfo().homedir, lockPath = globalLock(), isAlive = alive } = {}) {
  const guardPath = `${lockPath}.selection`;
  const owner = { kind: 'activation-target-registration', host: hostname(), pid: process.pid, runId: randomUUID(), storePath: store.directory };
  await privateDirectory(store.directory);
  await reclaimRegistrationLocks(store, lockPath, isAlive);
  await acquire(guardPath, owner, true);
  let held = false;
  try {
    await acquire(lockPath, owner, true); held = true;
    const base = await readPairedPlan(paths(store).manifest, store, { defaultUserHome });
    validateDocument(approved, store, defaultUserHome);
    matchingExtension(base, approved);
    await assertRestoredUnreserved(store, defaultUserHome);
    await pairedDirectoryFacts(approved);
    for (const profile of approved.profiles) {
      const current = await selectionPlan(store, profile.profileId, { runtime, inspectApp: false });
      if (!sameProfileBinding(current, profile)) throw new Error('Activation target profile paths or binding changed');
    }
    await record(paths(store).manifest, approved);
    return { activationId: approved.id, approvalId: approved.approvalId, target: approved.profiles.at(-1).name, registered: true };
  } finally {
    if (held) await release(lockPath, owner);
    await release(guardPath, owner);
  }
}

/** Load the reviewed native paths and their identities for each operation.
 * It cannot initialize a live home or choose paths supplied at switch time. */
class NativePairedPaths extends PairedPathTransaction {
  constructor(store, defaultUserHome, document) { super(); this.store = store; this.defaultUserHome = defaultUserHome; this.document = document; }
  async context() {
    const p = paths(this.store);
    await privateDirectory(this.store.directory);
    if (this.document) {
      if (await exists(p.root)) await privateDirectory(p.root);
    } else await privateDirectory(p.root);
    const plan = this.document ?? await readPairedPlan(p.manifest, this.store, { defaultUserHome: this.defaultUserHome });
    if (this.document) validateDocument(plan, this.store, this.defaultUserHome);
    const originals = await pairedDirectoryFacts(plan);
    return { root: p.root, components: plan.components, meta: { id: plan.id }, plan,
      journal: join(p.root, 'paired-switch.json'), lock: join(p.root, '.paired-lock'), originalModeMask: 0o022,
      expected: alias => originals.get(alias) };
  }
  async inspect() {
    const p = await this.context(), j = await this.journal(p), states = await this.states(p, j);
    const isDefault = states.every(v => v === 'Default');
    return { state: 'native-home', activationId: p.meta.id, selected: states.every(v => v === states[0]) && states[0] !== 'parked' ? states[0] : 'incomplete',
      recoveryRequired: (!this.document && !j) || j?.phase === 'prepared' || false, liveHomeChanged: !isDefault };
  }
}

export async function pairedStatus(store, { defaultUserHome = userInfo().homedir } = {}) {
  if (!await exists(paths(store).manifest)) return null;
  return new NativePairedPaths(store, defaultUserHome).inspect();
}

/** Called with the existing desktop operation lock held. The supplied plan is
 * an explicit execution request; merely generating/saving it does not call here. */
export async function attachPairedRuntime(store, runtime, { requestedPlan, session, defaultUserHome = userInfo().homedir, operation, noOpen = false } = {}) {
  if (noOpen && operation !== 'recover') throw new Error('No-open mode is restricted to recovery');
  const p = paths(store), present = await exists(p.manifest);
  const fallback = operation === 'recover' && !session?.pairedActivationId && session?.phase !== 'restored'
    ? session?.pairedActivationIntent : undefined;
  if (!present && !requestedPlan && !fallback) {
    if (session?.pairedActivationId) throw new Error('Paired activation metadata is missing; preserve the desktop and both paths');
    return runtime;
  }
  if (typeof runtime.assertIdle !== 'function') throw new Error('Paired activation requires writer-quiescence inspection');
  const plan = present ? await readPairedPlan(p.manifest, store, { defaultUserHome }) : requestedPlan ?? fallback;
  validateDocument(plan, store, defaultUserHome);
  if (requestedPlan && requestedPlan.approvalId !== plan.approvalId) throw new Error('A different paired activation is already registered');
  if (session?.pairedActivationId && session.pairedActivationId !== plan.id) throw new Error('Paired activation identity changed');
  if (fallback && (fallback.id !== plan.id || fallback.approvalId !== plan.approvalId)) throw new Error('Paired activation intent changed');
  if (!session?.pairedActivationId && !fallback && session && session.phase !== 'restored') throw new Error('Restore the earlier launch-only desktop selection before paired activation');
  if (!noOpen && !sameDesktopApp(await runtime.inspectApp(), plan.app)) throw new Error('Paired activation app location changed');
  for (const profile of plan.profiles) {
    const current = await selectionPlan(store, profile.profileId, { runtime, inspectApp: !noOpen });
    if (!sameProfileBinding(current, profile)) throw new Error('Paired activation profile paths or binding changed');
    const { native } = await loadHomeBinding(profile.native);
    if (plan.cliByProfile[profile.profileId].executable !== native.executable)
      throw new Error('Paired activation CLI executable changed');
  }
  const unstarted = present && !await exists(join(p.root, 'paired-switch.json'));
  let registered = present, pair = new NativePairedPaths(store, defaultUserHome, registered ? undefined : plan);
  const recoveryIntentOnly = Boolean(fallback && !present);
  // Validate aliases and preserved-original identities before requesting Quit,
  // including partially applied transactions that later recovery can handle.
  const state = await pair.inspect();
  if (recoveryIntentOnly && (state.selected !== 'Default' || state.recoveryRequired || await exists(join(p.root, 'paired-switch.json'))))
    throw new Error('Paired activation metadata is missing after an alias transaction; preserve both paths');
  if (unstarted) {
    if (session?.pairedActivationId) throw new Error('Paired transaction journal is missing from an established activation; preserve its metadata');
    if (!requestedPlan) {
      if (operation === 'recover') return { ...runtime, recoverPendingPairedRegistration: async () => unlink(p.manifest) };
      throw new Error('Paired activation registration was interrupted before alias changes; run desktop recover before another switch');
    }
  }
  const cliExecutables = [];
  for (const profile of plan.profiles) {
    const { native } = await loadHomeBinding(profile.native);
    if (!cliExecutables.includes(native.executable)) cliExecutables.push(native.executable);
  }
  const resourcePaths = [...new Set([...plan.resourcePaths, ramLogTarget('default'), ...plan.profiles.map(p => ramLogTarget(p.environmentId))])]
    .flatMap(path => [path, `${path}-wal`, `${path}-shm`]);
  const idle = async () => runtime.assertIdle({ cliExecutables, resourcePaths });
  const register = async () => {
    if (registered) return;
    const context = await pair.context();
    for (const c of plan.components) {
      await matchFact(context.expected(c.alias));
      if (await exists(c.original)) throw new Error('Original-preservation path already exists');
    }
    await privateDirectory(p.root, true);
    await record(p.manifest, plan);
    registered = true;
    pair = new NativePairedPaths(store, defaultUserHome);
  };
  const select = async label => {
    const current = await pair.inspect();
    if (noOpen) await idle();
    if (recoveryIntentOnly) {
      if (label !== 'Default') throw new Error('Interrupted paired activation intent may only recover the default aliases');
      if (current.selected !== 'Default' || current.recoveryRequired || await exists(join(p.root, 'paired-switch.json')))
        throw new Error('Paired activation metadata is missing after an alias transaction; preserve both paths');
      return;
    }
    if (runtime.ensureHomeLogs) {
      await idle();
      const original = plan.components[0];
      const selected = plan.profiles.find(p => targetFor(p) === label);
      const home = label === 'Default' ? await exists(original.original) ? original.original : original.alias : selected.home;
      const key = label === 'Default' ? 'default' : selected.environmentId;
      await runtime.ensureHomeLogs({ home, key });
    }
    if (current.selected === label && !current.recoveryRequired) {
      // No alias changes: a failed preflight can reopen the unchanged previous
      // desktop without requiring unrelated CLI writers to stop first.
      if (registered) await pair.recover();
      return;
    }
    await idle();
    await register();
    await pair.recover({ checkpoint: idle });
    await pair.switchTo(label, { checkpoint: idle });
    await idle();
    const state = await pair.inspect();
    if (state.selected !== label || state.recoveryRequired) throw new Error('Both activation paths must agree before opening Codex');
  };
  return { ...runtime, pairedActivationIntent: plan, get pairedActivationId() { return registered ? plan.id : undefined; }, pairedStatus: () => pair.inspect(),
    async beforeStop(target) {
      if (noOpen) return idle();
      if (target) {
        const bound = plan.profiles.find(p => p.profileId === target.profileId);
        if (!bound || !sameProfileBinding(bound, target)) throw new Error('This profile is outside the reviewed paired native-home plan');
        await assertSymlinkedHome(bound.home);
      }
      await runtime.prepareClients?.({ cliExecutables });
      await runtime.assertNoOtherClients?.({ cliExecutables });
    },
    async open(profile) {
      const bound = plan.profiles.find(p => p.profileId === profile.profileId);
      if (!bound || !sameProfileBinding(bound, profile)) throw new Error('This profile is outside the reviewed paired native-home plan');
      await assertSymlinkedHome(bound.home);
      await select(targetFor(bound));
      return runtime.restore();
    },
    async restore() { await select('Default'); return runtime.restore(); },
  };
}
