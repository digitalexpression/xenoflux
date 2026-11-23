// Explicit discovery owns a bounded native probe; ordinary reads use only metadata/cache.
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createClientCatalog, discoverCodexModels, validateCatalogSelection } from './client-catalog.js';
import { discoverCopilotModels } from './copilot-runtime.js';
import { discoverClaudeModels } from './claude-runtime.js';
import { CODEX_PERMISSION_MODES } from './audit-spec.js';
import { observeAuditProfileAccess, resolveProfileExecutionProfile } from './audit-profile.js';
import { withProfileOperation } from './desktop-instances.js';
import { exists, privateDirectory, readJSON, record, release } from './metadata.js';
import { acquireProfileParticipant, releaseProfileParticipant } from './profile-reservations.js';
import { getAuditProcessIdentity, observeAuditProcess } from './audit-process.js';
import { UiError } from './ui-server.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const catalogBusy = () => new UiError(409,
  'Model discovery needs a verified profile reservation. Finish sign-in or another exclusive operation, or recover an interrupted reservation.', 'catalog-profile-busy');
const unavailable = (reason, client = 'codex') => ({ status: 'unavailable', source: ({ 'claude-code': 'claude-agent-sdk/initialize', copilot: 'copilot-models.list' }[client] ?? 'codex-model/list'), reason, models: [],
  capabilities: { models: 'unknown', effort: 'unknown' } });

function waitForProbe(probe, signal) {
  if (signal.aborted) return;
  return new Promise(resolve => {
    const done = () => { signal.removeEventListener('abort', done); resolve(); };
    signal.addEventListener('abort', done, { once: true });
    probe.then(done, done);
  });
}

export function createUiCatalog({ store, defaultUserHome, context = {} }) {
  const active = new Map(), attempts = new Map(), runningByRoot = new Map();
  let closing = false;
  const resolveProfile = context.resolveProfile ?? resolveProfileExecutionProfile;
  const observeAccess = context.observeAccess ?? observeAuditProfileAccess;
  const resolverOptions = { defaultUserHome, terminalEnvironment: context.terminalEnvironment ?? process.env,
    profileResolvers: context.profileResolvers, allowUntrustedRepository: context.allowUntrustedRepository === true };
  const select = (name, client) => client ? { name, client } : name;
  const resolveContext = async input => {
    const repository = input.profile.bindingRepository === null || input.requestedWorkspace === null ? undefined : input.workspace;
    const profile = await resolveProfile(store, select(input.profile.profileName, input.profile.client === 'codex' && !input.requestedClient ? undefined : input.profile.client),
      { ...resolverOptions, ...(repository === undefined ? {} : { repository }) });
    return { ...input, profile, workspace: profile.cwd };
  };
  const discoveries = { codex: context.discover ?? discoverCodexModels, 'claude-code': discoverClaudeModels, copilot: discoverCopilotModels, ...context.discoveries };
  const cache = createClientCatalog({ resolveContext, discover: async options => {
    const { onDiscoveryResult, onBeforeDiscover, ...nativeOptions } = options;
    onBeforeDiscover();
    const client = nativeOptions.profile.client ?? 'codex';
    const discover = Object.hasOwn(discoveries, client) ? discoveries[client] : null;
    if (typeof discover !== 'function') throw new Error(`Catalog discovery is unavailable for ${client}`);
    const result = await discover(nativeOptions);
    await onDiscoveryResult(result);
    return result;
  } });
  async function selected(input) {
    if (typeof input?.profile !== 'string' || !input.profile.trim() || input.profile.length > 1024
      || input.client !== undefined && !['codex', 'claude-code', 'copilot'].includes(input.client)
      || input.workspace !== undefined && input.workspace !== ''
        && (typeof input.workspace !== 'string' || !input.workspace.startsWith('/') || input.workspace.length > 16384))
      throw new UiError(400, 'Choose a profile and workspace before discovering models.', 'catalog-context-required');
    const repository = input.workspace || undefined;
    let profile;
    try {
      profile = await resolveProfile(store, select(input.profile, input.client), { ...resolverOptions, ...(repository === undefined ? {} : { repository }) });
    } catch (error) {
      if (error.code === 'copilot-account-unverified')
        throw new UiError(422, 'Open Profiles to verify sign-in for the selected Copilot profile before discovering models.', error.code);
      throw error;
    }
    return { profile, workspace: profile.cwd, requestedWorkspace: repository ?? null, requestedClient: input.client ?? null };
  }
  const guard = (profile, action) => withProfileOperation(store, profile.profileId,
    { waitMs: 5000, recovery: true, ...context.lockOptions }, action);

  const withPermissions = (snapshot, client) => client === 'codex' ? { ...snapshot, permissionModes: CODEX_PERMISSION_MODES } : snapshot;
  async function get(input) {
    const chosen = await selected(input);
    const snapshot = cache.get(chosen) ?? unavailable('catalog-not-refreshed', chosen.profile.client);
    const view = snapshot.status === 'stale' ? { ...snapshot, status: 'unavailable' } : snapshot;
    return withPermissions(view, chosen.profile.client ?? 'codex');
  }
  async function validate(input, execution) {
    if (!execution?.model && !execution?.reasoningEffort && !execution?.permissionMode && !execution?.route) return { status: 'inherited' };
    const snapshot = await get(input);
    try {
      const client = snapshot.scope?.environmentBinding?.client ?? input.client ?? 'codex';
      const modes = client === 'codex' ? snapshot.permissionModes
        : snapshot.status === 'ready' ? snapshot.permissionModes ?? snapshot.capabilities?.permissionModes : null;
      if (execution.permissionMode && !modes?.includes(execution.permissionMode))
        throw new UiError(422, 'The selected permission mode is unavailable. Refresh the catalog or use the profile default.', 'catalog-permission-unavailable');
      if (input.executable && (execution.model || execution.reasoningEffort)
        && snapshot.scope?.environmentBinding?.executable?.path !== input.executable)
        throw new UiError(422, 'The model catalog belongs to another executable. Use the profile executable or inherit its settings.', 'catalog-context-changed');
      return execution.model || execution.reasoningEffort || execution.route
        ? validateCatalogSelection(snapshot, execution) : { status: 'validated' };
    }
    catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('catalog-'))
        throw new UiError(422, error.message, error.code);
      throw error;
    }
  }
  function assertOpen(work) {
    if (closing) throw new UiError(409, 'Xenoflux is stopping.', 'stopping');
    if (work.controller.signal.aborted) throw new UiError(409, 'Model discovery was cancelled.', 'catalog-cancelled');
  }
  async function launchProbe(chosen, input, work) {
    const { profile } = chosen;
    const { controller } = work, id = input.requestId;
    const root = join(store.directory, 'catalog-probes'), directory = join(root, id);
    await privateDirectory(store.directory, true); await privateDirectory(root, true);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new UiError(409, 'This discovery attempt already exists. Read or cancel it; refresh with a new request.', 'catalog-attempt-exists');
      throw error;
    }
    const owner = { kind: 'catalog-probe', membershipVersion: 1, runId: id, generation: randomUUID(), profileId: profile.profileId,
      home: profile.home, storePath: await realpath(store.directory), pid: process.pid, host: hostname(),
      coordinatorIdentity: await getAuditProcessIdentity() };
    const state = { kind: 'xfx-catalog-probe', schemaVersion: 1, id, owner, root: profile.reservationRoot,
      environmentBinding: profile.environmentBinding, status: 'prepared', process: null, shutdown: null };
    const save = () => record(join(directory, 'probe.json'), state);
    Object.assign(work, { directory, state, save, profile });
    const reservation = join(profile.reservationRoot, '.run-lock');
    let held = false, shared = false;
    try {
      await save();
      assertOpen(work);
      // Startup hooks can write native state. Share only with verified access under the profile gate.
      await guard(profile, async () => {
        const fresh = await resolveContext(chosen);
        if (JSON.stringify(fresh.profile.environmentBinding) !== JSON.stringify(profile.environmentBinding)
          || JSON.stringify(fresh.profile.accountQualification) !== JSON.stringify(profile.accountQualification))
          throw new UiError(409, 'The profile changed. Refresh the model list again.', 'catalog-context-changed');
        assertOpen(work);
        shared = Boolean(await exists(reservation));
        const access = shared ? await observeAccess(fresh.profile, { store, allowInteractivePeers: true }) : null;
        if (access && access.status !== 'ready') throw catalogBusy();
        assertOpen(work);
        try { await acquireProfileParticipant(profile.reservationRoot, owner, access?.nativeOwners ?? access?.desktopOwner); }
        catch (error) {
          if (shared || await exists(reservation)) throw catalogBusy();
          throw error;
        }
        held = true;
      });
      assertOpen(work);
      state.status = 'starting'; await save();
      assertOpen(work);
      const result = await cache.refresh(chosen, { signal: controller.signal,
        ...((profile.client ?? 'codex') === 'codex' ? { runtimeDirectory: directory } : {}),
        stdoutPath: join(directory, 'stdout.jsonl'), stderrPath: join(directory, 'stderr.jsonl'),
        onSpawn: async process => { state.process = process; state.status = 'running'; await save(); },
        onDiscoveryResult: async result => { state.shutdown = result.process?.shutdown ?? null; await save(); },
        onBeforeDiscover: () => { assertOpen(work); work.discoveryAttempted = true; } });
      state.shutdown = result.process?.shutdown ?? state.shutdown; state.status = result.status;
      await save();
      return withPermissions(result, profile.client ?? 'codex');
    } catch (error) {
      state.status = work.discoveryAttempted && state.shutdown?.groupTerminated !== true ? 'uncertain' : 'unavailable';
      state.reason = typeof error.code === 'string' ? error.code : 'catalog-discovery-failed';
      await save();
      throw error;
    } finally {
      if (held && (state.shutdown?.groupTerminated === true || !work.discoveryAttempted)) {
        await guard(profile, () => releaseProfileParticipant(profile.reservationRoot, owner));
        state.released = true; await save();
      }
    }
  }
  async function launch(input, work) {
    assertOpen(work);
    let chosen = await selected(input), waited = false;
    for (;;) {
      assertOpen(work);
      const { reservationRoot, client } = chosen.profile;
      const prior = runningByRoot.get(reservationRoot);
      if (prior) {
        // Cleanup takes the profile gate too. Wait for it before acquiring that gate.
        await waitForProbe(prior, work.controller.signal);
        assertOpen(work);
        chosen = await selected(input);
        waited = true;
        continue;
      }
      const saved = waited ? cache.get(chosen) : null;
      if (saved?.status === 'ready') return withPermissions(saved, client ?? 'codex');
      const probe = launchProbe(chosen, input, work).finally(() => runningByRoot.delete(reservationRoot));
      runningByRoot.set(reservationRoot, probe);
      return probe;
    }
  }
  function refresh(input) {
    if (!UUID.test(input?.requestId ?? '')) throw new UiError(400, 'Model discovery request ID is invalid.', 'invalid-catalog-request');
    const fingerprint = JSON.stringify([input.client ?? null, input.profile, input.workspace]);
    if (attempts.has(input.requestId)) {
      const previous = attempts.get(input.requestId);
      if (previous.fingerprint !== fingerprint) throw new UiError(409, 'This discovery request belongs to another profile or workspace.', 'catalog-request-mismatch');
      return previous.promise;
    }
    const work = { controller: new AbortController(), state: null, discoveryAttempted: false };
    active.set(input.requestId, work);
    const promise = launch(input, work).finally(() => active.delete(input.requestId));
    attempts.set(input.requestId, { fingerprint, promise });
    while (attempts.size > 100) {
      const key = [...attempts.keys()].find(key => !active.has(key));
      if (!key) break;
      attempts.delete(key);
    }
    return promise;
  }
  async function cancel({ requestId } = {}) {
    if (!UUID.test(requestId ?? '')) throw new UiError(400, 'Discovery request ID is invalid.', 'invalid-catalog-request');
    const work = active.get(requestId);
    if (work) {
      work.controller.abort();
      await attempts.get(requestId)?.promise.catch(() => {});
      return { status: work.state?.shutdown?.groupTerminated || !work.discoveryAttempted ? 'cancelled' : 'uncertain' };
    }
    // Recovery is read-only until the recorded process/group is confirmed stopped.
    const directory = join(store.directory, 'catalog-probes', requestId);
    await privateDirectory(directory);
    const saved = await readJSON(join(directory, 'probe.json'));
    if (saved.kind !== 'xfx-catalog-probe' || saved.schemaVersion !== 1 || saved.id !== requestId
      || saved.owner?.runId !== requestId || saved.root !== saved.environmentBinding?.roots.reservation
      || saved.owner?.storePath !== await realpath(store.directory)) throw new Error('Invalid catalog ownership; preserving probe');
    if (saved.released) return { status: 'stopped' };
    const observation = await (context.observeProcess ?? observeAuditProcess)(saved.process?.processIdentity);
    if (saved.shutdown?.groupTerminated !== true
      && (saved.environmentBinding.client !== 'codex' || observation.status !== 'stopped')) return { status: 'uncertain' };
    await guard({ profileId: saved.owner.profileId }, () => saved.owner.membershipVersion === 1
      ? releaseProfileParticipant(saved.root, saved.owner)
      : release(join(saved.root, '.run-lock'), saved.owner));
    saved.released = true; saved.shutdown = { ...saved.shutdown, groupTerminated: true };
    await record(join(directory, 'probe.json'), saved);
    return { status: 'stopped' };
  }
  async function close() {
    closing = true;
    for (const work of active.values()) work.controller.abort();
    await Promise.allSettled([...attempts.values()].map(value => value.promise));
  }
  return { get, refresh, cancel, validate, close, invalidate: client => cache.invalidateClient(client) };
}
