// Controlled, sequential multi-profile experiment orchestration. Native profile
// state is observed and reserved; workspaces and process logs stay private.
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CODEX_PERMISSION_MODES, selectionKey, validateAuditSpec } from './audit-spec.js';
import { inspectAuditRepository, authorizeAuditWorkspaceParent, createAuditWorkspace,
  snapshotAuditWorkspace, setAuditWorkspaceActive } from './audit-workspace.js';
import { createExperiment, createExperimentRun, writeAuditState, finalizeAuditRecord,
  reserveAuditProfile, releaseAuditProfileReservation, writeAuditCaptureCheckpoint } from './audit-experiment-store.js';
import { COPILOT_PERMISSION_MODES } from './copilot-catalog.js';
import { normalizeSessionReplay } from './audit-session-replay.js';
import { resolveAuditExecutionProfile, observeAuditProfileAccess, snapshotAuditProfileSettings,
  compareAuditProfileSettings, inspectAuditExecutable, auditSettingsIdentity } from './audit-profile.js';
import { createClientRuntime } from './client-runtime.js';
import { createEnvironmentBinding } from './client-contracts.js';
import { retainedNativeReference } from './capture-projection.js';
import { runAuditProcess, getAuditProcessIdentity } from './audit-process.js';
import { compareAuditRuns, auditExitCode } from './audit-report.js';
import { probeAuditVersion } from './audit-native-version.js';
import { evaluateCaptureRequirements } from './audit-evidence.js';
import { buildAuditComparisonConditions } from './audit-conditions.js';
import { auditRetainedNativeSession } from './audit-session.js';
import { joinRetainedNativeTurnEvidence } from './audit-replay.js';
import { deriveAuditFileInventory } from './audit-file-inventory.js';
import { buildAuditCheckEvidence, readAuditCheckOutput } from './audit-check-evidence.js';

const now = () => new Date().toISOString();
const duration = (start, end = Date.now()) => Math.max(0, end - start);
const safeProfile = profile => ({
  ...(profile.sideId ? { sideId: profile.sideId } : {}),
  ...(profile.execution ? { execution: profile.execution } : {}), id: profile.profileId, name: profile.profileName,
  profileId: profile.profileId, profileName: profile.profileName, home: profile.home,
  client: profile.client ?? 'codex', surface: profile.surface ?? 'cli',
  executionLocation: profile.executionLocation ?? 'local', rootMode: profile.rootMode ?? 'explicit',
  userHome: profile.userHome, executable: profile.executable, executableIdentity: profile.executableIdentity,
  nativeRoot: profile.nativeRoot ?? null, environmentId: profile.environmentId ?? null,
  executableSource: profile.executableSource, version: profile.version, versionSource: profile.versionSource,
  ...(profile.requestedVersion !== undefined ? { requestedVersion: profile.requestedVersion } : {}),
  bindingRepository: profile.bindingRepository,
  ...(profile.nativeConfig !== undefined ? { nativeConfig: { ...profile.nativeConfig } } : {}) });
const SAFE_ERROR_TEXT = {
  'repository-limit': 'The source repository exceeds the supported Git tree or capture bounds.',
  'copilot-account-unverified': 'This Copilot profile needs a verified native account scope before it can start.',
  'profile-repository-unbound': 'The selected repository is not already bound to this profile; no binding was changed.',
  'profile-access-blocked': 'A selected profile has an untrusted or mutating reservation.',
  'profile-access-unavailable': 'Safe access to a selected profile could not be verified.',
  'profile-clients-changed': 'An existing profile client or native reservation changed; remaining runs stopped.',
  'native-request-failed': 'The native approval or input request could not be handled. The comparison leg stopped.',
  'requested-execution-unconfirmed': 'Codex did not confirm the requested model or reasoning effort. The model turn did not start.',
  'requested-approval-reviewer-unconfirmed': 'Codex did not confirm user approval routing. The model turn did not start.',
  'requested-approval-reviewer-unsupported': 'User approval routing is available only for Codex comparisons.',
  'profile-reservation-failed': 'A selected profile could not be reserved.',
  'profile-settings-changed': 'Profile settings changed or became unverifiable.',
  'profile-settings-unavailable': 'Profile settings could not be safely fingerprinted.',
  'executable-changed': 'The selected Codex executable changed after preflight.',
  'version-probe-failed': 'The Codex executable version could not be observed.',
  'commit-changed': 'The selected repository commit changed during preflight.',
  timeout: 'The bounded experiment time limit expired.',
  cancelled: 'The experiment was cancelled.',
  'capture-incomplete': 'Required capture evidence is incomplete.',
  'required-context-unavailable': 'Required loaded context was not verified in the audit workspace.',
  'task-failed': 'The task process did not complete successfully.',
  'claude-native-rate-limit': 'Claude Code reached its native usage limit. The task did not complete.',
  'copilot-task-failed': 'The Copilot task did not record a completed response.',
  'setup-failed': 'A setup command failed.',
  'process-shutdown-failed': 'A process group could not be confirmed stopped.',
};

const WORKSPACE_DELTA_BASIS = 'post-setup-snapshot-delta-v1';

export const compareAuditWorkspaceInventory = deriveAuditFileInventory;

/** Compare complete snapshot identities while preserving the original snapshots for cleanup. */
export function compareAuditWorkspaceDelta(before, taskEnd) {
  const inventory = deriveAuditFileInventory(before, taskEnd);
  if (inventory?.status === 'recorded') return { changeCountStatus: 'known', changedFileCount: inventory.entries.length,
    changeCountBasis: WORKSPACE_DELTA_BASIS };
  const reasons = { 'workspace-snapshots-incomplete': 'workspace-snapshots-incomplete',
    'workspace-file-records-ambiguous': 'workspace-file-records-ambiguous',
    'workspace-file-origin-changed': 'workspace-file-origin-changed',
    'workspace-file-identity-missing': 'tracked-blob-identity-missing',
    'workspace-file-inventory-limit-exceeded': 'workspace-file-inventory-limit-exceeded' };
  return { changeCountStatus: 'unknown', changedFileCount: null, changeCountBasis: WORKSPACE_DELTA_BASIS,
    changeCountReason: reasons[inventory?.reason] ?? 'workspace-snapshots-incomplete' };
}
const KNOWN_ERROR_CODES = new Set([...Object.keys(SAFE_ERROR_TEXT), 'profile-reservation-failed', 'profile-idle-unknown', 'profile-settings-unavailable', 'commit-changed']);
const errorCode = error => typeof error?.code === 'string' && (KNOWN_ERROR_CODES.has(error.code) || /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code))
  ? error.code : 'operation-failed';
const errorText = error => SAFE_ERROR_TEXT[error?.code] ?? 'The operation could not be verified; inspect the private run record.';

async function coordinatorIdentity() {
  return { pid: process.pid, host: hostname(), processIdentity: await getAuditProcessIdentity() };
}

function dependencies(context) {
  return {
    inspectRepository: context.inspectRepository ?? inspectAuditRepository,
    resolveProfile: context.resolveProfile ?? resolveAuditExecutionProfile,
    inspectExecutable: context.inspectExecutable ?? inspectAuditExecutable,
    observeAccess: context.observeAccess ?? observeAuditProfileAccess,
    snapshotSettings: context.snapshotSettings ?? snapshotAuditProfileSettings,
    compareSettings: context.compareSettings ?? compareAuditProfileSettings,
    probeVersion: context.probeVersion ?? probeAuditVersion,
    capture: createClientRuntime({ capture: context.capture, runtimes: context.clientRuntimes }).capture,
    readReplay: context.readReplay ?? ((_store, profile, id, options) => auditRetainedNativeSession(profile, id, options)),
    clientRuntimes: context.clientRuntimes,
    process: context.process ?? runAuditProcess,
    createExperiment: context.createExperiment ?? createExperiment,
    createExperimentRun: context.createExperimentRun ?? createExperimentRun,
    writeState: context.writeState ?? writeAuditState,
    writeCaptureCheckpoint: context.writeCaptureCheckpoint ?? writeAuditCaptureCheckpoint,
    finalize: context.finalize ?? finalizeAuditRecord,
    reserve: context.reserve ?? reserveAuditProfile,
    release: context.release ?? releaseAuditProfileReservation,
    authorizeParent: context.authorizeParent ?? authorizeAuditWorkspaceParent,
    createWorkspace: context.createWorkspace ?? createAuditWorkspace,
    snapshotWorkspace: context.snapshotWorkspace ?? snapshotAuditWorkspace,
    setWorkspaceActive: context.setWorkspaceActive ?? setAuditWorkspaceActive,
    baseDirectory: context.baseDirectory,
    signal: context.signal ?? null,
  };
}

/** Freeze a bounded native replay beside the finalized run report. */
export async function captureFrozenSessionReplay(deps, store, profile, capturedRun, runDirectory, capturedAt = now()) {
  if (profile.client === 'claude-code' && capturedRun?.sessionReplay && capturedRun?.source?.fingerprint)
    return { sessionReplay: capturedRun.sessionReplay,
      replayCapture: { status: 'partial', capturedAt, sourceFingerprint: capturedRun.source.fingerprint,
        boundary: 'owned-native-sdk-stream' }, coverage: capturedRun.coverage, childDiscovery: undefined };
  const { client, sessionId: id, nativeReference: reference } = retainedNativeReference(capturedRun, profile,
    capturedRun?.id, capturedRun?.source?.threadId) ?? {};
  const validId = typeof id === 'string' && (client === 'codex'
    ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
    : id.trim().length > 0 && id.length <= 1024 && !/[\p{Cc}\p{Cf}]/u.test(id));
  if (validId && client === 'copilot' && capturedRun.replayCapture?.boundary === 'owned-copilot-live-message-projection') {
    const sessionReplay = normalizeSessionReplay(capturedRun.sessionReplay);
    const [root] = sessionReplay.sessions;
    if (sessionReplay.sessions.length === 1 && root.id === id && root.parentId === null
      && root.source.fingerprint === capturedRun.replayCapture.sourceFingerprint)
      return { sessionReplay, replayCapture: capturedRun.replayCapture };
  }
  const readReplay = client === 'codex' ? deps.readReplay : deps.clientRuntimes?.[client]?.readReplay;
  const unavailable = reason => ({ sessionReplay: { schemaVersion: 1, kind: 'session-replay', sessions: [{
    id, parentId: null, depth: 0, status: 'unavailable', reason, source: { fingerprint: null }, events: [],
    limits: [{ kind: 'capture-boundary', message: `Replay capture attempted at ${capturedAt}; unavailable evidence is frozen for this run.` },
      { kind: 'source-unavailable', message: reason }],
  }] }, replayCapture: { status: 'unavailable', capturedAt, sourceFingerprint: null,
    boundary: 'finalized-native-history-snapshot' }, coverage: { ...(capturedRun.coverage ?? {}), agents: 'partial' },
  childDiscovery: undefined });
  if (!validId) return { replayCapture: { status: 'unavailable', capturedAt, sourceFingerprint: null,
    boundary: 'finalized-native-history-snapshot', reason: 'The completed run has no verifiable native session ID.' },
  coverage: { ...(capturedRun.coverage ?? {}), agents: 'partial' }, childDiscovery: undefined };
  if (typeof readReplay !== 'function') return unavailable('This client has no retained native history reader.');
  try {
    const native = await readReplay(store, profile, id, { includeReplay: true,
      actionRepoRoot: capturedRun.source?.workspace ?? undefined,
      ...(reference ? { nativeReference: reference } : {}),
      ...(Array.isArray(capturedRun.agents) ? { recordedAgents: capturedRun.agents } : {}),
      ...(capturedRun.childDiscovery ? { recordedDiscovery: capturedRun.childDiscovery } : {}),
      ...(client === 'codex' && typeof runDirectory === 'string' ? { childIndexHome: join(runDirectory, 'runtime', 'sqlite') } : {}) });
    const fingerprint = native?.source?.fingerprint;
    const rootReplay = native?.sessionReplay?.sessions?.find(session => session.id === id && session.parentId === null);
    if (native?.source?.nativeSessionId !== id
      || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')
      || rootReplay?.source?.fingerprint !== fingerprint)
      return unavailable('The selected native history could not be verified for this completed run.');
    if (!native.sessionReplay?.sessions?.length) return unavailable('The selected native history did not provide replay evidence.');
    if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '')) {
      if (native.sessionReplay.sessions.every(session => ['unavailable', 'not-found'].includes(session.status)
        && session.events.length === 0)) {
        const sessionReplay = structuredClone(native.sessionReplay);
        for (const session of sessionReplay.sessions) session.limits.push({ kind: 'capture-boundary',
          message: `Replay capture attempted at ${capturedAt}; unavailable evidence is frozen for this run.` });
        return { sessionReplay, replayCapture: { status: 'unavailable', capturedAt, sourceFingerprint: null,
          boundary: 'finalized-native-history-snapshot' }, coverage: { ...(capturedRun.coverage ?? {}), agents: 'partial' },
        childDiscovery: undefined };
      }
      return unavailable('The selected native history has no verifiable source fingerprint.');
    }
    const sessionReplay = structuredClone(native.sessionReplay);
    const orderedEdges = rows => rows.map(row => ({ id: row.id, parentId: row.parentId ?? null }))
      .filter(row => row.id !== id).sort((a, b) => a.parentId.localeCompare(b.parentId) || a.id.localeCompare(b.id));
    const discovery = capturedRun.childDiscovery;
    const capturedAgents = Array.isArray(capturedRun.agents) ? capturedRun.agents : [];
    const capturedRoot = capturedAgents.find(agent => agent?.id === id && agent.parentId == null);
    const capturedEdges = orderedEdges(capturedAgents);
    const replayEdges = orderedEdges(sessionReplay.sessions.map(session => ({ id: session.id, parentId: session.parentId })));
    const replayRoot = sessionReplay.sessions.find(session => session.id === id && session.parentId === null);
    const sameEdges = !!capturedRoot && !!replayRoot && discovery?.rootId === id
      && JSON.stringify(capturedEdges) === JSON.stringify(replayEdges)
      && JSON.stringify(capturedEdges) === JSON.stringify(orderedEdges(discovery?.edges ?? []));
    const discoveryComplete = discovery?.complete === true && native.coverage?.agents === 'complete' && sameEdges;
    const boundary = `Frozen from native history at ${capturedAt}; later activity is outside this replay.`;
    for (const session of sessionReplay.sessions) session.limits.push({ kind: 'capture-boundary', message: boundary });
    if (!discoveryComplete) {
      sessionReplay.sessions[0]?.limits.push({ kind: 'child-discovery-partial',
        message: sameEdges ? 'The native child index did not provide complete bounded discovery evidence.'
          : 'Captured app-server actors, indexed child links, and replay sessions did not agree at the finalized boundary.' });
    }
    const replayCapture = { status: discoveryComplete ? native.status : 'partial', capturedAt,
      sourceFingerprint: fingerprint, boundary: 'finalized-native-history-snapshot' };
    if (discovery) replayCapture.childDiscovery = { status: discoveryComplete ? 'complete' : 'partial',
      capturedAt: discovery.capturedAt, fingerprint: discovery.fingerprint, indexFingerprint: discovery.indexFingerprint,
      actorCount: replayEdges.length + 1, boundary: 'owned-native-process-terminated' };
    const coverage = { ...(capturedRun.coverage ?? {}), agents: discoveryComplete ? 'complete' : 'partial' };
    const controls = client === 'codex' ? joinRetainedNativeTurnEvidence(capturedRun, native, profile) : null;
    // The durable run reader has a 16 MiB record cap. Leave 4 MiB for the
    // remaining finalized run fields and keep replay within the same bound.
    const maxCapturedRun = 12 * 1024 * 1024;
    let bytes = Buffer.byteLength(JSON.stringify({ ...capturedRun, ...controls?.fields, sessionReplay, replayCapture, coverage }));
    if (bytes > maxCapturedRun) {
      const omittedBySession = new Map();
      for (const event of sessionReplay.sessions.slice().reverse().flatMap(session => session.events.slice().reverse())) {
        if (event.body == null) continue;
        bytes -= Math.max(0, Buffer.byteLength(JSON.stringify(event.body)) - Buffer.byteLength('null'));
        event.body = null; event.bodyStatus = 'omitted'; event.bodyReason = 'frozen-report-size-limit';
        omittedBySession.set(event.sessionId, (omittedBySession.get(event.sessionId) ?? 0) + 1);
        if (bytes <= maxCapturedRun) break;
      }
      for (const session of sessionReplay.sessions) {
        const omitted = omittedBySession.get(session.id) ?? 0;
        if (omitted) session.limits.push({ kind: 'frozen-report-size-limit', omitted,
          message: 'Some event bodies were omitted to keep the completed replay within the durable report size limit.' });
      }
    }
    bytes = Buffer.byteLength(JSON.stringify({ ...capturedRun, ...controls?.fields, sessionReplay, replayCapture, coverage }));
    if (bytes > maxCapturedRun) return unavailable('Replay metadata exceeded the bounded finalized report size.');
    return { ...controls?.fields, sessionReplay, replayCapture, coverage, childDiscovery: undefined };
  } catch { return unavailable('The selected native history could not be read at the finalized capture boundary.'); }
}

function selectionProfile(spec, profile) {
  return spec.profiles.find(item => selectionKey(item) === (profile?.sideId ?? profile?.profileName?.toLowerCase())) ?? {};
}

/** Read-only preflight. It does not reserve profiles, create records or workspaces. */
export async function previewAuditExperiment(store, input, context = {}) {
  const spec = validateAuditSpec(input), deps = dependencies(context);
  const profiles = [], failures = [], warnings = [];
  warnings.push({ code: 'exhaustive-skill-use-unverified', message: spec.allowIncompleteCapture
    ? 'Native skill detection and telemetry delivery are best effort; successful runs retain partial evidence.'
    : spec.captureRequirements ? 'Declared capture observations are required; exhaustive native skill consumption remains unverified.'
    : 'Exhaustive native skill capture is unverified; declare captureRequirements or explicitly allow incomplete capture.' });
  let repository;
  try { repository = await deps.inspectRepository(spec.repository, spec.revision); }
  catch (error) { failures.push({ scope: 'repository', code: errorCode(error), message: errorText(error) }); }
  for (const selection of spec.profiles) {
    try {
      const resolvedProfile = await deps.resolveProfile(store, selection, { repository: repository?.repository ?? spec.repository });
      const profile = { ...resolvedProfile, sideId: selection.sideId, execution: selection.execution, ...(selection.version !== undefined ? { requestedVersion: selection.version } : {}) };
      const requested = selection, codex = (profile.client ?? 'codex') === 'codex';
      if (requested.execution?.permissionMode && !(profile.client === 'claude-code'
        ? ['default', 'acceptEdits', 'plan'].includes(requested.execution.permissionMode)
        : profile.client === 'copilot' ? COPILOT_PERMISSION_MODES.includes(requested.execution.permissionMode)
          : codex && CODEX_PERMISSION_MODES.includes(requested.execution.permissionMode))
        || requested.execution?.route && profile.client !== 'copilot')
        throw new Error('The selected client does not support this execution override');
      if (!codex && spec.captureRequirements?.context)
        throw new Error('The selected client does not support Codex context verification');
      const checks = [];
      if (spec.approvalsReviewer && (profile.client ?? 'codex') !== 'codex')
        throw Object.assign(new Error(SAFE_ERROR_TEXT['requested-approval-reviewer-unsupported']), { code: 'requested-approval-reviewer-unsupported' });
      if (!profile.profileId || !profile.home || !profile.reservationRoot || !profile.executable)
        throw new Error('Profile executable or home is unavailable');
      if (requested.executable && profile.executable !== requested.executable)
        throw new Error('Selected profile executable could not be verified');
      if (repository && profile.bindingRepository && await realpath(profile.bindingRepository).catch(() => null) !== repository.repository)
        throw new Error('Profile repository binding does not match the selected source repository');
      if (!profile.bindingRepository) checks.push({ name: 'repository-binding', status: 'unknown' });
      else checks.push({ name: 'repository-binding', status: 'ready' });
      const access = await deps.observeAccess(profile, { store });
      checks.push({ name: 'profile-access', status: access?.status ?? 'unavailable', reason: access?.reason ?? null,
        clients: access?.clients ?? [], sourceReservation: access?.sourceReservation ?? null });
      if (access?.status !== 'ready') failures.push({ scope: 'profile', profile: profile.profileName,
        code: access?.status === 'blocked' ? 'profile-access-blocked' : 'profile-access-unavailable',
        message: 'Safe coexistence with this profile could not be established.' });
      else if (codex) {
        let observedVersion = null;
        try { observedVersion = await deps.probeVersion({ executable: profile.executable, cwd: repository?.repository ?? spec.repository,
          env: profile.env, timeoutMs: 2000 }) ?? null; }
        catch (error) {
          if (['SHUTDOWN_FAILED', 'CANCELLED'].includes(error?.code))
            failures.push({ scope: 'profile', profile: profile.profileName, code: 'version-probe-failed', message: SAFE_ERROR_TEXT['version-probe-failed'] });
        }
        checks.push({ name: 'codex-version', status: observedVersion ? 'observed' : 'unknown',
          observed: observedVersion, registered: profile.version ?? null,
          ...(requested.version !== undefined ? { requested: requested.version } : {}) });
      }
      checks.push({ name: 'capture-protocol', status: 'pending', reason: codex ? 'Confirmed by app-server initialize and skills/list during the run.' : 'Checked on the selected native connection during the run.' });
      let settings;
      try { settings = await deps.snapshotSettings(profile); }
      catch { settings = { status: 'unavailable' }; }
      checks.push({ name: 'settings-snapshot', status: settings?.status === 'ready' ? 'ready' : 'unknown' });
      if (settings?.status !== 'ready') failures.push({ scope: 'profile', profile: profile.profileName,
        code: 'profile-settings-unavailable', message: 'Profile settings cannot be safely fingerprinted; execution is blocked.' });
      profiles.push({ sideId: selection.sideId, profileId: profile.profileId, profileName: profile.profileName, home: profile.home, client: profile.client ?? 'codex',
        rootMode: profile.rootMode, surface: profile.surface, executionLocation: profile.executionLocation, executable: profile.executable, version: profile.version ?? null, versionSource: profile.versionSource ?? 'unavailable',
        ...(profile.requestedVersion !== undefined ? { requestedVersion: profile.requestedVersion } : {}),
        status: failures.some(f => f.profile === profile.profileName) ? 'blocked' : 'ready',
        busy: (access?.clients?.length ?? 0) > 0, reason: null, checks });
    } catch (error) {
      failures.push({ scope: 'profile', profile: selection.name, code: errorCode(error), message: errorText(error) });
      profiles.push({ profileName: selection.name, client: selection.client ?? 'codex', profileId: null, home: null, executable: null,
        version: null, status: 'unavailable', busy: false, reason: errorText(error), checks: [] });
    }
  }
  const homes = new Map();
  for (const [index, item] of profiles.entries()) if (item.home) {
    const selection = spec.profiles[index], previous = homes.get(item.home);
    if (previous && (!selection.sideId || !previous.sideId)) failures.push({ scope: 'profile', profile: item.profileName,
      code: 'duplicate-profile-home', message: 'Selections sharing a profile home need distinct side IDs.' });
    else homes.set(item.home, selection);
  }
  return { schemaVersion: 1, kind: 'audit-experiment-preview', status: failures.length ? 'blocked' : 'ready',
    baseline: repository ? { repository: repository.repository, commit: repository.commit, tree: repository.tree,
      selectedRevision: spec.revision, sourceHead: repository.sourceHead ?? null, sourceDirty: repository.sourceDirty ?? (typeof repository.clean === 'boolean' ? !repository.clean : null) } : null,
    repository: repository ? { path: repository.repository, commit: repository.commit, tree: repository.tree,
      files: repository.files, bytes: repository.bytes, clean: repository.clean } : null,
    profiles, taskCount: spec.profiles.length, executionOrder: spec.profiles.map(p => p.sideId ?? p.name),
    limits: { ...spec.limits, sandbox: spec.sandbox, ...(spec.approvalsReviewer ? { approvalsReviewer: spec.approvalsReviewer } : {}) }, failures, warnings,
    ...(spec.captureRequirements ? { captureRequirements: spec.captureRequirements } : {}),
    capture: { status: 'partial', capabilities: { appServerV2: 'pending', skillsList: 'pending', skillUseObservability: 'native-otel-best-effort' },
      errors: [{ code: 'exhaustive-skill-use-unverified' }] },
    sideEffects: { profileReservations: false, records: false, workspaces: false, modelTasks: false } };
}

function requireProfileAccess(access) {
  if (access?.status !== 'ready') throw Object.assign(new Error('Safe profile access is unavailable.'),
    { code: access?.status === 'blocked' ? 'profile-access-blocked' : 'profile-access-unavailable' });
}

function compareProfileAccess(before, after, experimentId) {
  const identity = client => JSON.stringify([client.pid, client.startedAt, client.uid, client.executable]);
  const observed = new Set((after?.clients ?? []).map(identity));
  const original = before?.clients ?? [];
  const missing = original.filter(client => !observed.has(identity(client)));
  const expected = new Set(original.map(identity));
  const added = before?.sourceReservation ? [] : (after?.clients ?? []).filter(client => !expected.has(identity(client)));
  const reservationUnchanged = JSON.stringify(before?.sourceReservation ?? null) === JSON.stringify(after?.sourceReservation ?? null);
  return { status: after?.status !== 'ready' ? 'unavailable' : missing.length || added.length || !reservationUnchanged ? 'changed' : 'unchanged',
    overlap: [...new Map([...(before?.overlap ?? []), ...(after?.overlap ?? [])].filter(row => row.experimentId !== experimentId || row.kind !== 'audit-experiment').map(row => [row.runId, row])).values()],
    before: original, after: after?.clients ?? [], missing, added, reservationUnchanged,
    sourceReservation: before?.sourceReservation ?? null };
}

function reservationOwner(experimentId, runId, profile, store) {
  return { kind: 'audit-experiment', membershipVersion: 1, generation: randomUUID(), host: hostname(), pid: process.pid, runId, experimentId,
    storePath: store.directory, profileId: profile.profileId, home: profile.home,
    ...(profile.client === 'copilot' || profile.client === 'claude-code' ? { binding: profile.environmentBinding } : {}) };
}

async function ensureDirs(directory) {
  const artifacts = join(directory, 'artifacts'), temp = join(directory, 'tmp');
  await mkdir(artifacts, { mode: 0o700 }); await mkdir(temp, { mode: 0o700 });
  return { artifacts, temp };
}

async function runCommand(store, runId, deps, command, { profile, workspace, directory, phase, index, deadline, signal, outputBytes, owner }) {
  const started = Date.now(), stdoutPath = join(directory, `${phase}-${index}.stdout`), stderrPath = join(directory, `${phase}-${index}.stderr`);
  const timeoutMs = deadline === null ? command.timeoutMs : Math.max(1, Math.min(command.timeoutMs, deadline - Date.now()));
  if (deadline !== null && timeoutMs <= 1 && Date.now() >= deadline) return { name: command.name, status: 'timeout', exitCode: null,
    startedAt: null, elapsedMs: 0 };
  const env = { PATH: profile.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(directory, 'tmp'),
    TMPDIR: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp'), LC_ALL: 'C' };
  const result = await deps.process({ executable: '/usr/bin/env', args: command.argv, cwd: workspace,
    env, timeoutMs, outputLimitBytes: outputBytes, stdoutPath, stderrPath, signal,
    onSpawn: async info => { await deps.writeState(store, runId, { status: 'running', phase,
      coordinator: await coordinatorIdentity(), reservation: { root: profile.reservationRoot, owner, status: 'held' },
      process: { pid: info.pid ?? null, processIdentity: info.processIdentity ?? null, host: hostname(), ...(info.nativeAncestry ? { nativeAncestry: info.nativeAncestry } : {}) } }); } });
  if (result.shutdown?.groupTerminated === false || result.status === 'shutdown-failed')
    return { name: command.name, status: 'recovery-required', exitCode: result.exitCode, elapsedMs: result.elapsedMs,
      process: result.processIdentity ?? null, pid: result.pid ?? null, shutdown: result.shutdown ?? null };
  await deps.writeState(store, runId, { phase, process: null });
  return { name: command.name, status: result.status === 'exited' && result.exitCode === 0 ? 'passed'
    : result.status === 'exited' ? 'failed' : result.status, exitCode: result.exitCode,
    signal: result.signal, startedAt: new Date(started).toISOString(), elapsedMs: result.elapsedMs ?? duration(started), output: result.output,
    process: result.processIdentity ?? null, shutdown: result.shutdown ?? null };
}

function captureComplete(captured) {
  return captured?.run?.status === 'ready' && captured?.capture?.status === 'ready'
    && captured?.run?.coverage?.skills === 'complete';
}

/** Execute the validated paired experiment sequentially and persist recovery state. */
export async function runAuditExperiment(store, input, context = {}) {
  const spec = validateAuditSpec(input);
  if (spec.approvalsReviewer && typeof context.onNativeRequest !== 'function')
    throw new TypeError('User approval routing requires an interactive comparison request handler');
  const deps = dependencies(context), preview = await previewAuditExperiment(store, spec, context);
  if (preview.status !== 'ready') return { ...preview, exitCode: auditExitCode(preview) };
  const verifiedRepository = await deps.inspectRepository(spec.repository, preview.baseline.commit);
  if (verifiedRepository.commit !== preview.baseline.commit || verifiedRepository.tree !== preview.baseline.tree)
    return { ...preview, status: 'blocked', reason: { kind: 'commit-changed' },
      failures: [...preview.failures, { code: 'commit-changed', message: SAFE_ERROR_TEXT['commit-changed'] }], exitCode: 1 };
  const repository = { ...verifiedRepository, commit: preview.baseline.commit, tree: preview.baseline.tree };
  // The mutable branch is resolved only by preview; all later work uses its pinned object.
  spec.revision = repository.commit;
  const baseDirectory = deps.baseDirectory ?? join(store.directory, 'audits');
  const experiment = await deps.createExperiment(store, { ...(context.experimentId ? { id: context.experimentId } : {}),
    ...(context.series ? { series: context.series } : {}), spec: { ...spec, task: undefined }, task: spec.task,
    profiles: preview.profiles.map(item => safeProfile({ profileId: item.profileId, profileName: item.profileName,
      home: item.home, sideId: item.sideId, version: item.version, client: item.client, rootMode: item.rootMode, surface: item.surface, executionLocation: item.executionLocation })), baseline: { repository: preview.baseline, source: 'committed-snapshot' } });
  const runs = [], reservations = [], failures = [], warnings = [], runReferences = [], finalizedRuns = new Set(), releasedRunIds = new Set(), pendingFinalReports = new Map();
  let recoveryRequired = false;
  const startedAt = Date.now(), experimentDeadline = spec.limits.experimentMs === null ? null : startedAt + spec.limits.experimentMs;
  let timer;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(deps.signal?.reason ?? 'cancelled');
  if (deps.signal?.aborted) abortFromParent(); else deps.signal?.addEventListener('abort', abortFromParent, { once: true });
  if (spec.limits.experimentMs !== null) timer = setTimeout(() => controller.abort('experiment-timeout'), spec.limits.experimentMs);
  const bySelection = new Map();
  try {
    await deps.writeState(store, experiment.id, { status: 'reserving', phase: 'reservation', coordinator: await coordinatorIdentity() });
    // Resolve and reserve every profile before the first model task starts.
    for (const selection of spec.profiles) {
      const resolvedProfile = await deps.resolveProfile(store, selection, { repository: repository.repository });
      const profile = { ...resolvedProfile, sideId: selection.sideId, execution: selection.execution,
        ...(selection.nativeConfig !== undefined ? { nativeConfig: { ...selection.nativeConfig } } : {}),
        ...(selection.version !== undefined ? { requestedVersion: selection.version } : {}) };
      const beforeAccess = await deps.observeAccess(profile, { store });
      requireProfileAccess(beforeAccess);
      const beforeSettings = await deps.snapshotSettings(profile);
      if (beforeSettings?.status !== 'ready') throw Object.assign(new Error(SAFE_ERROR_TEXT['profile-settings-unavailable']), { code: 'profile-settings-unavailable' });
      const runRecord = await deps.createExperimentRun(store, { experimentId: experiment.id,
        profile: safeProfile(profile), baseline: { repository: repository.repository, commit: repository.commit,
          tree: repository.tree, settingsStatus: beforeSettings?.status ?? 'unavailable' } });
      const owner = reservationOwner(experiment.id, runRecord.id, profile, store);
      const reference = { runRecord, profile, owner, beforeSettings, reservationAttempted: false };
      runReferences.push(reference);
      await deps.writeState(store, runRecord.id, { status: 'prepared', phase: 'reservation', coordinator: await coordinatorIdentity(),
        reservation: { root: profile.reservationRoot, owner, status: 'acquiring' }, process: null, workspace: null });
      try {
        reference.reservationAttempted = true;
        await deps.reserve({ root: profile.reservationRoot, owner, desktopOwner: beforeAccess.desktopOwner });
        reservations.push({ profile, owner });
        await deps.writeState(store, runRecord.id, { reservation: { root: profile.reservationRoot, owner, status: 'held' } });
      } catch (error) {
        runs.push({ id: runRecord.id, status: 'failed', phase: 'reservation', profile: safeProfile(profile),
          error: { code: errorCode(error), message: errorText(error) } });
        throw Object.assign(new Error(`Could not reserve profile ${profile.profileName}; no model task was started.`), { code: 'profile-reservation-failed' });
      }
      bySelection.set(selectionKey(selection), { profile, beforeSettings, beforeAccess, runRecord, owner });
    }
    // Recheck access and the original clients before launching any model work.
    for (const selection of spec.profiles) {
      const prepared = bySelection.get(selectionKey(selection)), { profile } = prepared;
      const fresh = await deps.resolveProfile(store, selection, { repository: repository.repository });
      const keys = ['profileId', 'profileName', 'home', 'nativeRoot', 'reservationRoot', 'environmentId', 'executable', 'executableIdentity', 'bindingRepository', 'client', 'rootMode', 'surface'];
      if (keys.some(key => fresh[key] !== profile[key]) || JSON.stringify(fresh.accountQualification) !== JSON.stringify(profile.accountQualification))
        throw Object.assign(new Error('The selected profile binding changed before its reservation was held.'), { code: 'profile-binding-changed' });
      const executable = await deps.inspectExecutable(profile.executable);
      if (executable.executableIdentity !== profile.executableIdentity)
        throw Object.assign(new Error(SAFE_ERROR_TEXT['executable-changed']), { code: 'executable-changed' });
      const access = await deps.observeAccess(profile, { store, expectedClients: prepared.beforeAccess.clients });
      requireProfileAccess(access);
      if (compareProfileAccess(prepared.beforeAccess, access).status !== 'unchanged')
        throw Object.assign(new Error(SAFE_ERROR_TEXT['profile-clients-changed']), { code: 'profile-clients-changed' });
      if (deps.compareSettings(prepared.beforeSettings, await deps.snapshotSettings(profile)).status !== 'unchanged')
        throw Object.assign(new Error(SAFE_ERROR_TEXT['profile-settings-changed']), { code: 'profile-settings-changed' });
      if ((profile.client ?? 'codex') !== 'codex') continue;
      let observedVersion = null;
      try { observedVersion = await deps.probeVersion({ executable: profile.executable, cwd: repository.repository,
        env: profile.env, timeoutMs: 2000, signal: controller.signal }) ?? null; }
      catch (error) {
        if (['SHUTDOWN_FAILED', 'CANCELLED'].includes(error?.code)) throw error;
      }
      // Versions are descriptive metadata. Actual app-server initialize and
      // skills/list responses establish whether the native capture protocol works.
      profile.version = observedVersion;
      profile.versionSource = observedVersion ? 'observed' : 'unavailable';
    }
    await deps.writeState(store, experiment.id, { status: 'running', phase: 'workspace', startedAt: now(),
      coordinator: await coordinatorIdentity(), runs: runReferences.map(({ runRecord, profile }) => ({ id: runRecord.id, profileId: profile.profileId, status: 'prepared' })) });
    for (let index = 0; index < spec.profiles.length; index++) {
      const selection = spec.profiles[index], prepared = bySelection.get(selectionKey(selection));
      if (controller.signal.aborted || (experimentDeadline !== null && Date.now() >= experimentDeadline)) {
        runs.push({ id: prepared.runRecord.id, profile: safeProfile(prepared.profile), status: 'cancelled', phase: 'not-started', reason: controller.signal.reason === 'experiment-timeout' ? 'experiment-timeout' : 'cancelled' });
        continue;
      }
      const { profile, beforeSettings, beforeAccess, runRecord, owner } = prepared;
      const phaseStart = Date.now(), runDeadline = [experimentDeadline,
        spec.limits.runMs === null ? null : phaseStart + spec.limits.runMs].filter(value => value !== null).reduce((a, b) => a === null ? b : Math.min(a, b), null);
      const dirs = await ensureDirs(runRecord.directory);
      const runResult = { id: runRecord.id, profile: safeProfile(profile), status: 'running', phase: 'workspace',
        timestamps: { startedAt: now() }, metrics: { setupMs: 0, taskMs: null, captureMs: null, checksMs: 0, totalMs: null },
        setup: [], checks: [], artifacts: [], warnings: [], coverage: { workspaceDiff: 'partial', skills: 'partial' } };
      let workspace = null, workspaceIntent = null, initialSnapshot = null, taskEndSnapshot = null, taskEndCaptureComplete = false,
        workspaceActive = false, settingsChecked = false, clientsChecked = false;
      const workspaceOwner = { experimentId: experiment.id, runId: runRecord.id };
      const intendedWorkspaceDirectory = join(runRecord.directory, 'workspace');
      try {
        const access = await deps.observeAccess(profile, { store, expectedClients: beforeAccess.clients });
        requireProfileAccess(access);
        if (compareProfileAccess(beforeAccess, access).status !== 'unchanged')
          throw Object.assign(new Error(SAFE_ERROR_TEXT['profile-clients-changed']), { code: 'profile-clients-changed' });
        if (deps.compareSettings(beforeSettings, await deps.snapshotSettings(profile)).status !== 'unchanged')
          throw Object.assign(new Error(SAFE_ERROR_TEXT['profile-settings-changed']), { code: 'profile-settings-changed' });
        await deps.authorizeParent({ parentDirectory: runRecord.directory, baseDirectory, owner: { experimentId: experiment.id, runId: runRecord.id } });
        workspaceIntent = { directory: intendedWorkspaceDirectory, owner: workspaceOwner,
          active: true, ownershipVerified: false };
        await deps.writeState(store, runRecord.id, { status: 'running', phase: 'workspace-creating',
          coordinator: await coordinatorIdentity(), reservation: { root: profile.reservationRoot, owner, status: 'held' },
          workspace: workspaceIntent, process: null, startedAt: runResult.timestamps.startedAt });
        workspace = await deps.createWorkspace({ repository: repository.repository, commit: repository.commit, expectedTree: repository.tree,
          directory: intendedWorkspaceDirectory, owner: workspaceOwner });
        runResult.sourceWorkspace = { directory: workspace.directory, sourceCommit: workspace.sourceCommit, sourceTree: workspace.sourceTree };
        // createAuditWorkspace creates the owned active marker atomically.
        // Only deactivate it after task/check execution or confirmed shutdown.
        workspaceActive = workspace.active === true;
        workspaceIntent = { directory: workspace.directory, owner: workspaceOwner,
          active: workspaceActive, ownershipVerified: true };
        await deps.writeState(store, runRecord.id, { status: 'running', phase: 'setup',
          coordinator: await coordinatorIdentity(), reservation: { root: profile.reservationRoot, owner, status: 'held' },
          workspace: workspaceIntent,
          process: null, startedAt: runResult.timestamps.startedAt });
        const setupStart = Date.now();
        let setupFailed = false;
        for (let cmd = 0; cmd < spec.setup.length; cmd++) {
          if (controller.signal.aborted || (runDeadline !== null && Date.now() >= runDeadline)) { setupFailed = true; break; }
          const result = await runCommand(store, runRecord.id, deps, spec.setup[cmd], { profile, workspace: workspace.directory,
            directory: runRecord.directory, phase: 'setup', index: cmd, deadline: runDeadline,
            signal: controller.signal, outputBytes: spec.limits.outputBytes, owner });
          runResult.setup.push(result);
          if (result.status === 'recovery-required') {
            recoveryRequired = true;
            runResult.recovery = { pid: result.pid ?? null, process: result.process ?? null, host: hostname(), reason: 'Setup process group could not be confirmed stopped.' };
            setupFailed = true; break;
          }
          if (result.status !== 'passed') { setupFailed = true; break; }
        }
        runResult.metrics.setupMs = duration(setupStart);
        if (setupFailed) {
          const failedSetup = runResult.setup.at(-1);
          const code = controller.signal.reason === 'experiment-timeout' || failedSetup?.status === 'timeout' ? 'timeout'
            : controller.signal.aborted ? 'cancelled' : failedSetup?.status === 'recovery-required' ? 'process-shutdown-failed' : 'setup-failed';
          throw Object.assign(new Error(code === 'timeout' ? 'Experiment timed out during setup.' : code === 'cancelled' ? 'Experiment was cancelled during setup.' : 'Setup command failed.'), { code });
        }
        const initial = await deps.snapshotWorkspace({ directory: workspace.directory, owner: workspaceOwner,
          outputDirectory: dirs.artifacts, label: 'before-task' });
        initialSnapshot = initial;
        runResult.artifacts.push({ kind: 'workspace-snapshot', label: initial.label, fingerprint: initial.fingerprint,
          status: initial.status, files: initial.files.length, patchPath: initial.patchPath, metadataPath: initial.metadataPath });
        await deps.writeState(store, runRecord.id, { phase: 'task', process: null,
          workspace: { ...workspaceIntent, active: true } });
        const taskStart = Date.now();
        const remainingLimits = [spec.limits.runMs === null ? null : spec.limits.runMs - duration(phaseStart),
          experimentDeadline === null ? null : experimentDeadline - Date.now()].filter(value => value !== null);
        const taskTimeout = remainingLimits.length ? Math.max(1, Math.min(...remainingLimits)) : null;
        const selectedSkills = selection.skills ?? [];
        let capturing = true;
        const captureState = async patch => {
          if (!capturing || controller.signal.aborted) return;
          return deps.writeState(store, runRecord.id, patch, { owner, signal: controller.signal });
        };
        let executionProfile = profile;
        if (profile.client && profile.client !== 'codex' && profile.environmentBinding) {
          executionProfile = { ...profile, cwd: workspace.directory };
          executionProfile.settingsSnapshot = await deps.snapshotSettings(executionProfile);
          executionProfile.settingsIdentity = auditSettingsIdentity(executionProfile.settingsSnapshot);
          if (!executionProfile.settingsIdentity) throw new Error('The prepared workspace settings could not be verified');
          executionProfile.environmentBinding = createEnvironmentBinding({ ...profile.environmentBinding,
            workspace: workspace.directory, settingsIdentity: executionProfile.settingsIdentity });
        }
        if (profile.client === 'copilot')
          await deps.writeState(store, runRecord.id, { nativeShutdownPending: true }, { owner, signal: controller.signal });
        const captured = await deps.capture({ executionMode: 'audit', profile: executionProfile, execution: selection.execution, workspace: workspace.directory, task: spec.task, selectedSkills,
          requiredContext: spec.captureRequirements?.context,
          onProcessReady: async info => captureState({
            process: { pid: info.pid, processIdentity: info.processIdentity, host: hostname(), ...(info.nativeAncestry ? { nativeAncestry: info.nativeAncestry } : {}) } }),
          ...(context.onNativeRequest ? { onNativeRequest: (request, details) => {
            if (!capturing || controller.signal.aborted) throw new Error('Comparison leg stopped');
            return context.onNativeRequest(runRecord.id, selection.sideId, request, details);
          } } : {}),
          processOptions: { env: profile.env, timeoutMs: taskTimeout, outputLimitBytes: spec.limits.outputBytes,
            stdoutPath: join(runRecord.directory, `${profile.client ?? 'codex'}.stdout`), stderrPath: join(runRecord.directory, `${profile.client ?? 'codex'}.stderr`),
            signal: controller.signal,
          onSpawn: async info => captureState({ status: 'running', phase: 'task',
            coordinator: await coordinatorIdentity(), reservation: { root: profile.reservationRoot, owner, status: 'held' },
            process: { pid: info.pid ?? null, processIdentity: info.processIdentity ?? null, host: hostname(), ...(info.nativeAncestry ? { nativeAncestry: info.nativeAncestry } : {}) },
            workspace: { ...workspaceIntent, active: true } }) },
          limits: { id: runRecord.id },
          sandbox: (profile.client ?? 'codex') === 'codex' ? selection.execution?.permissionMode ?? spec.sandbox : spec.sandbox,
          ...(spec.approvalsReviewer ? { approvalsReviewer: spec.approvalsReviewer } : {}),
          onPhase: async phase => captureState({ phase }),
          onTaskEnd: async evidence => {
            if (!capturing) return;
            // Capture calls this only after owned process-group shutdown, before
            // checks. Missing native child evidence still makes the boundary partial.
            const snapshot = await deps.snapshotWorkspace({ directory: workspace.directory, owner: workspaceOwner,
              outputDirectory: dirs.artifacts, label: 'task-end', retainPatchContent: true,
              sourceBaselineCommit: workspace.sourceCommit, sourceBaselineTree: workspace.sourceTree,
              baselineFingerprint: initialSnapshot?.fingerprint });
            if (!capturing) return;
            taskEndSnapshot = snapshot;
            const changeCount = compareAuditWorkspaceDelta(initialSnapshot, snapshot);
            const changeInventory = compareAuditWorkspaceInventory(initialSnapshot, snapshot);
            taskEndCaptureComplete = evidence?.complete === true;
            runResult.timestamps.taskEndedAt = evidence?.at ?? now();
            runResult.taskEnd = { status: snapshot.status, fingerprint: snapshot.fingerprint,
              files: snapshot.files.length, patchPath: snapshot.patchPath, metadataPath: snapshot.metadataPath, patchSha256: snapshot.patchSha256,
              baselineFingerprint: initialSnapshot?.fingerprint ?? null, ...changeCount, changeInventory,
              captureComplete: taskEndCaptureComplete, boundary: evidence?.boundary ?? null,
              nativeEndedAt: evidence?.nativeEndedAt ?? null, timing: taskEndCaptureComplete ? 'task-end' : 'unverified-task-end' };
            runResult.workspace = { ...runResult.workspace, taskEnd: { status: snapshot.status,
              path: snapshot.patchPath, fingerprint: snapshot.fingerprint, fileCount: snapshot.files.length,
              patchSha256: snapshot.patchSha256, baselineFingerprint: initialSnapshot?.fingerprint ?? null, ...changeCount, changeInventory,
              ...(snapshot.patchContent ? { patchContent: snapshot.patchContent } : {}),
              captureComplete: taskEndCaptureComplete, timing: runResult.taskEnd.timing } };
            runResult.artifacts.push({ kind: 'workspace-snapshot', label: snapshot.label, fingerprint: snapshot.fingerprint,
              status: snapshot.status, files: snapshot.files.length, patchPath: snapshot.patchPath, metadataPath: snapshot.metadataPath,
              captureComplete: taskEndCaptureComplete, timing: runResult.taskEnd.timing });
            await captureState({ phase: 'checks', taskEnd: runResult.taskEnd,
              workspace: { ...workspaceIntent, active: true, finalFingerprint: snapshot.fingerprint } });
          },
          onSession: async (session, captureRecord) => {
            if (!capturing || controller.signal.aborted) return;
            await deps.writeCaptureCheckpoint(store, runRecord.id, { run: session, capture: captureRecord, owner, signal: controller.signal });
            await deps.writeState(store, runRecord.id, { phase: 'capture',
            nativeSessionId: session?.source?.threadId ?? null,
            captureCheckpoint: { capturedAt: now(), status: session?.status ?? 'unknown',
              eventCount: Array.isArray(session?.events) ? session.events.length : null,
              agentCount: Array.isArray(session?.agents) ? session.agents.length : null,
              skillCount: Array.isArray(session?.skills) ? session.skills.length : null,
              skillInvocationCount: Array.isArray(session?.skillInvocations) ? session.skillInvocations.length : null,
              toolInvocationCount: Array.isArray(session?.toolInvocations) ? session.toolInvocations.length : null,
              coverage: session?.coverage ?? null, captureStatus: captureRecord?.status ?? 'unknown' } }, { owner, signal: controller.signal });
          } }).catch(async error => {
            if (profile.client === 'copilot') {
              if (error.process?.shutdown?.groupTerminated === true)
                await deps.writeState(store, runRecord.id, { process: null, nativeShutdownPending: false });
              else recoveryRequired = true;
            }
            throw error;
          }).finally(() => { capturing = false; });
        const taskProcessUnsafe = profile.client === 'copilot' && captured?.process?.shutdown?.groupTerminated !== true
          || captured?.process?.shutdown?.groupTerminated === false || captured?.process?.status === 'shutdown-failed';
        if (!taskProcessUnsafe) await deps.writeState(store, runRecord.id, { phase: 'capture', process: null,
          ...(profile.client === 'copilot' ? { nativeShutdownPending: false } : {}) });
        const taskElapsedMs = duration(taskStart);
        runResult.metrics = { ...(captured?.run?.metrics ?? {}), ...runResult.metrics,
          taskMs: taskElapsedMs, captureMs: captured?.run?.metrics?.wallMs ?? taskElapsedMs };
        runResult.capture = captured?.capture ?? { status: 'unavailable' };
        runResult.captureProtocol = { status: captured?.capabilities?.appServerV2 === 'available'
          && captured?.capabilities?.skillsList === 'available' ? 'ready' : 'partial',
          appServerV2: captured?.capabilities?.appServerV2 ?? 'unknown', skillsList: captured?.capabilities?.skillsList ?? 'unknown' };
        runResult.normalized = captured?.run ?? { status: 'unavailable', coverage: { skills: 'unavailable' }, skills: [], agents: [], turns: [], events: [] };
        runResult.warnings.push(...(Array.isArray(runResult.normalized.warnings) ? runResult.normalized.warnings : []));
        runResult.normalized.metrics = { ...(runResult.normalized.metrics ?? {}), ...runResult.metrics };
        runResult.coverage = { ...(runResult.normalized.coverage ?? {}), ...runResult.coverage };
        if (!taskEndSnapshot && !taskProcessUnsafe) {
          const snapshot = await deps.snapshotWorkspace({ directory: workspace.directory, owner: workspaceOwner,
            outputDirectory: dirs.artifacts, label: 'task-end-fallback', retainPatchContent: true,
            sourceBaselineCommit: workspace.sourceCommit, sourceBaselineTree: workspace.sourceTree,
            baselineFingerprint: initialSnapshot?.fingerprint });
          taskEndSnapshot = snapshot;
          const changeCount = compareAuditWorkspaceDelta(initialSnapshot, snapshot);
          const changeInventory = compareAuditWorkspaceInventory(initialSnapshot, snapshot);
          runResult.taskEnd = { status: snapshot.status, fingerprint: snapshot.fingerprint, files: snapshot.files.length,
            patchSha256: snapshot.patchSha256,
            baselineFingerprint: initialSnapshot?.fingerprint ?? null, ...changeCount,
            changeInventory,
            patchPath: snapshot.patchPath, metadataPath: snapshot.metadataPath, captureComplete: false,
            timing: 'after-process-fallback' };
          runResult.workspace = { ...runResult.workspace, taskEnd: { status: snapshot.status,
            path: snapshot.patchPath, fingerprint: snapshot.fingerprint, fileCount: snapshot.files.length,
            patchSha256: snapshot.patchSha256, baselineFingerprint: initialSnapshot?.fingerprint ?? null, ...changeCount, changeInventory,
            ...(snapshot.patchContent ? { patchContent: snapshot.patchContent } : {}),
            captureComplete: false, timing: 'after-process-fallback' } };
          taskEndCaptureComplete = false;
          runResult.artifacts.push({ kind: 'workspace-snapshot', label: snapshot.label, fingerprint: snapshot.fingerprint,
            status: snapshot.status, files: snapshot.files.length, patchPath: snapshot.patchPath, metadataPath: snapshot.metadataPath,
            captureComplete: false, timing: 'after-process-fallback' });
        }
        const processResult = captured?.process;
        if (taskProcessUnsafe || processResult?.shutdown?.groupTerminated === false || processResult?.status === 'shutdown-failed') {
          recoveryRequired = true; runResult.status = 'recovery-required'; runResult.phase = 'process-shutdown';
          runResult.recovery = { process: processResult.processIdentity ?? null, pid: processResult.pid ?? null, host: hostname(),
            reason: 'Process group termination could not be confirmed; workspace and profile reservation remain active.' };
          runs.push(runResult); await deps.writeState(store, runRecord.id, { status: runResult.status, phase: runResult.phase, recovery: runResult.recovery });
          break;
        }
        runResult.coverage.skills = runResult.normalized.coverage?.skills ?? 'unavailable';
        runResult.coverage.agents = runResult.normalized.coverage?.agents ?? 'unavailable';
        runResult.coverage.workspaceDiff = !taskEndSnapshot ? 'unavailable'
          : taskEndCaptureComplete ? 'complete' : 'partial';
        runResult.coverage.captureProtocol = runResult.captureProtocol.status;
        if (spec.captureRequirements?.context) {
          const preflight = runResult.normalized.captureAcceptance;
          if (preflight?.mode === 'required-context-preflight' && preflight.status === 'failed') {
            runResult.captureAcceptance = preflight;
            runResult.coverage.captureRequirements = 'failed';
            throw Object.assign(new Error(SAFE_ERROR_TEXT['required-context-unavailable']), { code: 'required-context-unavailable' });
          }
          const acceptance = evaluateCaptureRequirements(runResult.normalized, spec.captureRequirements,
            { protocolReady: runResult.captureProtocol.status === 'ready' });
          runResult.captureAcceptance = acceptance;
          runResult.normalized.captureAcceptance = acceptance;
          runResult.coverage.captureRequirements = acceptance.status;
          if (acceptance.checks.some(check => check.id.startsWith('context:') && check.status === 'failed'))
            throw Object.assign(new Error(SAFE_ERROR_TEXT['required-context-unavailable']), { code: 'required-context-unavailable' });
        }
        if (captured?.capture?.errors?.some(error => error.code === 'requested-execution-unconfirmed'))
          throw Object.assign(new Error(SAFE_ERROR_TEXT['requested-execution-unconfirmed']), { code: 'requested-execution-unconfirmed' });
        if (captured?.capture?.errors?.some(error => error.code === 'requested-approval-reviewer-unconfirmed'))
          throw Object.assign(new Error(SAFE_ERROR_TEXT['requested-approval-reviewer-unconfirmed']), { code: 'requested-approval-reviewer-unconfirmed' });
        if (captured?.capture?.errors?.some(error => error?.code === 'native-request-failed'))
          throw Object.assign(new Error(SAFE_ERROR_TEXT['native-request-failed']), { code: 'native-request-failed' });
        const nativeCompleted = runResult.normalized.outcome?.nativeTurnStatus === 'completed';
        const taskStatus = nativeCompleted && (profile.client === 'claude-code' || captured?.process?.status === 'exited' && captured?.process?.exitCode === 0)
          ? 'passed' : 'failed';
        runResult.task = { status: taskStatus, processStatus: captured?.process?.status ?? 'unknown',
          exitCode: captured?.process?.exitCode ?? null, nativeTurnStatus: runResult.normalized.outcome?.nativeTurnStatus ?? null, nativeThreadId: runResult.normalized.source?.threadId ?? null };
        runResult.execution = { status: captured?.process?.status ?? 'unknown', exitCode: captured?.process?.exitCode ?? null,
          elapsedMs: captured?.process?.elapsedMs ?? runResult.metrics.captureMs };
        const processStatus = captured?.process?.status;
        if (processStatus === 'timeout' || controller.signal.reason === 'experiment-timeout')
          throw Object.assign(new Error(SAFE_ERROR_TEXT.timeout), { code: 'timeout' });
        if (processStatus === 'cancelled' || controller.signal.aborted)
          throw Object.assign(new Error(SAFE_ERROR_TEXT.cancelled), { code: 'cancelled' });
        if (taskStatus === 'failed') {
          const rateLimited = profile.client === 'claude-code'
            && captured?.capture?.errors?.some(error => error?.code === 'claude-native-rate-limit');
          const code = rateLimited ? 'claude-native-rate-limit' : profile.client === 'copilot' ? 'copilot-task-failed' : 'task-failed';
          throw Object.assign(new Error(SAFE_ERROR_TEXT[code]), { code });
        }
        const checkStart = Date.now();
        for (let cmd = 0; cmd < spec.checks.length; cmd++) {
          if (controller.signal.aborted || (runDeadline !== null && Date.now() >= runDeadline)) { runResult.checks.push({ name: spec.checks[cmd].name, status: controller.signal.aborted ? 'cancelled' : 'timeout', exitCode: null }); break; }
          const result = await runCommand(store, runRecord.id, deps, spec.checks[cmd], { profile, workspace: workspace.directory,
            directory: runRecord.directory, phase: 'check', index: cmd, deadline: runDeadline,
            signal: controller.signal, outputBytes: spec.limits.outputBytes, owner });
          const required = context.checkRequired?.(spec.checks[cmd].name) ?? true;
          runResult.checks.push({ ...result, ...(context.checkRequired ? { required } : {}) });
          if (result.status === 'recovery-required' || (result.status !== 'passed' && required)) break;
        }
        runResult.checkEvidence = buildAuditCheckEvidence({ checks: spec.checks, results: runResult.checks,
          workspaceFingerprint: taskEndSnapshot?.fingerprint ?? null,
          outputs: await Promise.all(spec.checks.map((_, index) => readAuditCheckOutput(runRecord.directory, index))) });
        runResult.metrics.checksMs = duration(checkStart);
        const finalSnapshot = await deps.snapshotWorkspace({ directory: workspace.directory, owner: workspaceOwner,
          outputDirectory: dirs.artifacts, label: 'after-checks' });
        runResult.finalWorkspace = { status: finalSnapshot.status, fingerprint: finalSnapshot.fingerprint,
          files: finalSnapshot.files.length, patchPath: finalSnapshot.patchPath, metadataPath: finalSnapshot.metadataPath };
        runResult.workspace = { taskEnd: { status: taskEndSnapshot.status, path: taskEndSnapshot.patchPath,
          fingerprint: taskEndSnapshot.fingerprint, fileCount: taskEndSnapshot.files.length,
          patchSha256: taskEndSnapshot.patchSha256,
          baselineFingerprint: initialSnapshot?.fingerprint ?? null,
          ...(taskEndSnapshot.patchContent ? { patchContent: taskEndSnapshot.patchContent } : {}),
          ...compareAuditWorkspaceDelta(initialSnapshot, taskEndSnapshot),
          changeInventory: compareAuditWorkspaceInventory(initialSnapshot, taskEndSnapshot),
          captureComplete: taskEndCaptureComplete, timing: runResult.taskEnd?.timing ?? 'after-process-fallback' },
          checkEnd: { status: finalSnapshot.status, path: finalSnapshot.patchPath,
            fingerprint: finalSnapshot.fingerprint, fileCount: finalSnapshot.files.length } };
        runResult.artifacts.push({ kind: 'workspace-snapshot', label: finalSnapshot.label, fingerprint: finalSnapshot.fingerprint,
          status: finalSnapshot.status, files: finalSnapshot.files.length, patchPath: finalSnapshot.patchPath, metadataPath: finalSnapshot.metadataPath });
        await deps.setWorkspaceActive({ directory: workspace.directory, owner: { experimentId: experiment.id, runId: runRecord.id }, active: false });
        workspaceActive = false;
        runResult.outcome = { status: runResult.checks.some(c => c.status === 'timeout' && c.required !== false) ? 'timeout'
          : runResult.checks.some(c => c.status === 'cancelled' && c.required !== false) ? 'cancelled'
          : runResult.checks.some(c => c.status === 'failed' && c.required !== false) ? 'failed'
          : runResult.checks.some(c => c.status === 'passed') ? 'passed' : 'not-evaluated',
          task: runResult.task, checks: runResult.checks.map(({ name, status, exitCode }) => ({ name, status, exitCode })),
          taskEndWorkspace: runResult.taskEnd, finalWorkspace: runResult.finalWorkspace };
        // Coverage describes whether the declared checks were evaluated, not
        // whether they passed or whether skill consumption is exhaustive.
        runResult.coverage.outcome = spec.checks.length === 0 ? 'unavailable'
          : runResult.checks.length === spec.checks.length
            && runResult.checks.every(check => ['passed', 'failed'].includes(check.status)) ? 'complete' : 'partial';
        const afterSettings = await deps.snapshotSettings(profile), settings = deps.compareSettings(beforeSettings, afterSettings);
        settingsChecked = true;
        runResult.profileSettings = { status: settings.status, changedPaths: settings.changedPaths ?? [] };
        const afterAccess = await deps.observeAccess(profile, { store, expectedClients: beforeAccess.clients });
        runResult.runningClients = compareProfileAccess(beforeAccess, afterAccess, experiment.id);
        runResult.coverage.runningClients = runResult.runningClients.status;
        clientsChecked = true;
        if (settings.status !== 'unchanged' || runResult.runningClients.status !== 'unchanged') {
          runResult.status = 'partial'; runResult.phase = 'preservation-check';
          if (settings.status !== 'unchanged') failures.push({ code: 'profile-settings-changed', profile: profile.profileName,
            changedPaths: settings.changedPaths ?? [], message: 'Profile settings changed or became unverifiable during execution; remaining runs stopped.' });
          if (runResult.runningClients.status !== 'unchanged') failures.push({ code: 'profile-clients-changed', profile: profile.profileName,
            message: SAFE_ERROR_TEXT['profile-clients-changed'] });
          runResult.timestamps.completedAt = now(); runResult.metrics.totalMs = duration(phaseStart);
          runResult.id = runRecord.id;
          Object.assign(runResult.normalized, await captureFrozenSessionReplay(deps, store,
            runRecord.record?.profile ?? safeProfile(profile), runResult.normalized, runRecord.directory));
          runResult.coverage = { ...runResult.normalized.coverage, ...runResult.coverage,
            agents: runResult.normalized.coverage.agents };
          runs.push(runResult); await deps.writeState(store, runRecord.id, { status: runResult.status, phase: runResult.phase,
            completedAt: runResult.timestamps.completedAt, metrics: runResult.metrics, outcome: runResult.outcome,
            profileSettings: runResult.profileSettings, runningClients: runResult.runningClients, workspace: { ...workspaceIntent,
              active: false, finalFingerprint: finalSnapshot.fingerprint } });
          pendingFinalReports.set(runRecord.id, { ...runResult.normalized, id: runRecord.id,
            experimentId: experiment.id, profile: safeProfile(profile), baseline: runRecord.record?.baseline,
            sourceWorkspace: runResult.sourceWorkspace, status: runResult.status,
            metrics: runResult.metrics, outcome: runResult.outcome, taskEnd: runResult.taskEnd,
            finalWorkspace: runResult.finalWorkspace, profileSettings: runResult.profileSettings, runningClients: runResult.runningClients,
            execution: runResult.execution, capture: runResult.capture, captureProtocol: runResult.captureProtocol, workspace: runResult.workspace,
            artifacts: runResult.artifacts, setup: runResult.setup, checks: runResult.checks, checkEvidence: runResult.checkEvidence,
            coverage: runResult.coverage, warnings: runResult.warnings });
          break;
        }
        const captureAcceptance = evaluateCaptureRequirements(runResult.normalized, spec.captureRequirements,
          { protocolReady: runResult.captureProtocol.status === 'ready' });
        if (captureAcceptance) {
          runResult.captureAcceptance = captureAcceptance;
          runResult.normalized.captureAcceptance = captureAcceptance;
          runResult.coverage.captureRequirements = captureAcceptance.status;
        }
        // An explicit requirement is never waived by allowIncompleteCapture.
        // It can pass for observable evidence while the overall report remains partial.
        if (captureAcceptance?.status === 'failed'
          || (!captureAcceptance && !captureComplete(captured) && !spec.allowIncompleteCapture))
          throw Object.assign(new Error(SAFE_ERROR_TEXT['capture-incomplete']), { code: 'capture-incomplete' });
        runResult.status = ['failed', 'timeout', 'cancelled'].includes(runResult.outcome.status) ? runResult.outcome.status
          : runResult.coverage.skills === 'complete' && runResult.normalized.status === 'ready' ? 'complete' : 'partial';
        runResult.phase = 'complete';
        runResult.timestamps.completedAt = now(); runResult.metrics.totalMs = duration(phaseStart);
        runResult.normalized.status = runResult.status === 'complete' ? 'ready' : runResult.normalized.status;
        runResult.id = runRecord.id;
        Object.assign(runResult.normalized, await captureFrozenSessionReplay(deps, store,
          runRecord.record?.profile ?? safeProfile(profile), runResult.normalized, runRecord.directory));
        runResult.coverage = { ...runResult.normalized.coverage, ...runResult.coverage,
            agents: runResult.normalized.coverage.agents };
        await deps.writeState(store, runRecord.id, { status: runResult.status, phase: 'complete', completedAt: runResult.timestamps.completedAt,
          process: null, metrics: runResult.metrics, outcome: runResult.outcome, profileSettings: runResult.profileSettings, runningClients: runResult.runningClients,
          workspace: { ...workspaceIntent, active: false, finalFingerprint: finalSnapshot.fingerprint } });
        pendingFinalReports.set(runRecord.id, { ...runResult.normalized, id: runRecord.id,
          experimentId: experiment.id, profile: safeProfile(profile), baseline: runRecord.record?.baseline,
          sourceWorkspace: runResult.sourceWorkspace, status: runResult.status,
          metrics: runResult.metrics, outcome: runResult.outcome, taskEnd: runResult.taskEnd, finalWorkspace: runResult.finalWorkspace,
          execution: runResult.execution, capture: runResult.capture, captureProtocol: runResult.captureProtocol, workspace: runResult.workspace,
          profileSettings: runResult.profileSettings, runningClients: runResult.runningClients, artifacts: runResult.artifacts, setup: runResult.setup, checks: runResult.checks, checkEvidence: runResult.checkEvidence,
          coverage: runResult.coverage, warnings: runResult.warnings });
        runs.push(runResult);
      } catch (error) {
        runResult.checkEvidence ??= buildAuditCheckEvidence({ checks: spec.checks, results: runResult.checks,
          workspaceFingerprint: taskEndSnapshot?.fingerprint ?? null,
          outputs: await Promise.all(spec.checks.map((_, index) => readAuditCheckOutput(runRecord.directory, index))) });
        const failed = error.code === 'timeout' || controller.signal.reason === 'experiment-timeout' ? 'timeout'
          : error.code === 'cancelled' || controller.signal.aborted ? 'cancelled' : 'failed';
        runResult.status = failed; runResult.phase = error.code ?? 'execution'; runResult.error = { code: error.code ?? errorCode(error), message: errorText(error) };
        runResult.timestamps.completedAt = now(); runResult.metrics.totalMs = duration(phaseStart);
        failures.push({ profile: profile.profileName, code: runResult.error.code, message: runResult.error.message });
        let persistedWorkspace = null;
        if (workspace) {
          // Only clear active after confirmed child-group shutdown. Otherwise keep
          // both the workspace guard and profile reservation for explicit recovery.
          const processState = (await import('./audit-experiment-store.js')).readAuditRecord;
          const persisted = await processState(store, runRecord.id).catch(() => null);
          const processInfo = persisted?.state?.process;
          if ((profile.client === 'copilot' && recoveryRequired) || processInfo?.pid) { recoveryRequired = true; runResult.status = 'recovery-required'; }
          else {
            // Preserve a final state for cleanup even when setup failed before
            // the task-end checkpoint. This is explicitly not task-end evidence.
            if (!runResult.finalWorkspace) {
              try {
                const snapshot = await deps.snapshotWorkspace({ directory: workspace.directory,
                  owner: { experimentId: experiment.id, runId: runRecord.id },
                  outputDirectory: dirs.artifacts, label: 'failure-finalization' });
                runResult.finalWorkspace = { status: snapshot.status, fingerprint: snapshot.fingerprint,
                  files: snapshot.files.length, patchPath: snapshot.patchPath, metadataPath: snapshot.metadataPath,
                  timing: 'failure-finalization' };
                runResult.artifacts.push({ kind: 'workspace-snapshot', label: snapshot.label,
                  fingerprint: snapshot.fingerprint, status: snapshot.status, files: snapshot.files.length,
                  patchPath: snapshot.patchPath, metadataPath: snapshot.metadataPath, timing: 'failure-finalization' });
              } catch {
                runResult.finalWorkspace = { status: 'unavailable', fingerprint: null, timing: 'failure-finalization' };
                runResult.warnings.push({ code: 'failure-snapshot-unavailable' });
              }
            }
            if (workspaceActive) {
              await deps.setWorkspaceActive({ directory: workspace.directory,
                owner: { experimentId: experiment.id, runId: runRecord.id }, active: false }).catch(() => {});
              workspaceActive = false;
            }
          }
          persistedWorkspace = { ...workspaceIntent, active: workspaceActive,
            finalFingerprint: runResult.finalWorkspace?.fingerprint ?? taskEndSnapshot?.fingerprint ?? null };
        } else if (workspaceIntent) {
          // A crash or creation error may leave a partial checkout before the
          // helper returns its verified ownership marker. Preserve the intent
          // unless absence is positively established; recovery can inspect it.
          try {
            await lstat(workspaceIntent.directory);
            recoveryRequired = true;
            runResult.status = 'recovery-required';
            runResult.phase = 'workspace-creation';
            persistedWorkspace = workspaceIntent;
          } catch (statError) {
            if (statError?.code !== 'ENOENT') {
              recoveryRequired = true;
              runResult.status = 'recovery-required';
              runResult.phase = 'workspace-creation';
              persistedWorkspace = workspaceIntent;
            }
          }
        }
        if (!settingsChecked) {
          const afterSettings = await deps.snapshotSettings(profile).catch(() => ({ status: 'unavailable' }));
          const settings = deps.compareSettings(beforeSettings, afterSettings);
          runResult.profileSettings = { status: settings.status, changedPaths: settings.changedPaths ?? [] };
          if (settings.status !== 'unchanged') {
            failures.push({ code: 'profile-settings-changed', profile: profile.profileName,
              changedPaths: settings.changedPaths ?? [], message: 'Profile settings changed or became unverifiable during execution.' });
          }
        }
        if (!clientsChecked) {
          const access = await deps.observeAccess(profile, { store, expectedClients: beforeAccess.clients }).catch(() => null);
          runResult.runningClients = compareProfileAccess(beforeAccess, access, experiment.id);
          if (runResult.runningClients.status !== 'unchanged') failures.push({ code: 'profile-clients-changed',
            profile: profile.profileName, message: SAFE_ERROR_TEXT['profile-clients-changed'] });
        }
        await deps.writeState(store, runRecord.id, { status: runResult.status, phase: runResult.phase,
          completedAt: runResult.timestamps.completedAt, error: runResult.error, process: recoveryRequired ? undefined : null,
          metrics: runResult.metrics, outcome: runResult.outcome ?? { status: 'unknown' },
          profileSettings: runResult.profileSettings, runningClients: runResult.runningClients,
          taskEnd: runResult.taskEnd ?? null, finalWorkspace: runResult.finalWorkspace ?? null,
          workspace: persistedWorkspace }).catch(() => {});
        runResult.normalized ??= { schemaVersion: 1, kind: 'audit-run', id: runRecord.id, status: failed,
          profile: safeProfile(profile), agents: [], events: [], turns: [], skills: [], usage: {}, metrics: runResult.metrics,
          coverage: { timeline: 'unavailable', agents: 'unavailable', skills: 'unavailable', workspaceDiff: runResult.finalWorkspace?.fingerprint ? 'complete' : 'unavailable', outcome: 'partial' },
          outcome: { status: 'unknown' }, artifacts: runResult.artifacts, warnings: [] };
        if (!recoveryRequired) Object.assign(runResult.normalized, await captureFrozenSessionReplay(deps, store,
          runRecord.record?.profile ?? safeProfile(profile), runResult.normalized, runRecord.directory));
        if (!recoveryRequired) runResult.coverage = { ...runResult.normalized.coverage, ...runResult.coverage,
            agents: runResult.normalized.coverage.agents };
        if (!recoveryRequired) pendingFinalReports.set(runRecord.id, { ...runResult.normalized, id: runRecord.id,
          experimentId: experiment.id, profile: safeProfile(profile), baseline: runRecord.record?.baseline,
          sourceWorkspace: runResult.sourceWorkspace, status: runResult.status,
          metrics: runResult.metrics, outcome: runResult.outcome ?? { status: 'unknown' }, taskEnd: runResult.taskEnd ?? null,
          finalWorkspace: runResult.finalWorkspace ?? null,
          execution: runResult.execution, capture: runResult.capture, captureProtocol: runResult.captureProtocol, workspace: runResult.workspace,
          profileSettings: runResult.profileSettings, runningClients: runResult.runningClients, artifacts: runResult.artifacts, setup: runResult.setup, checks: runResult.checks, checkEvidence: runResult.checkEvidence,
          coverage: { ...runResult.normalized.coverage, ...runResult.coverage }, warnings: runResult.warnings,
          checkEvidence: runResult.checkEvidence });
        runs.push(runResult);
      }
      if (recoveryRequired || failures.some(f => ['profile-settings-changed', 'profile-clients-changed', 'requested-approval-reviewer-unconfirmed'].includes(f.code)) || controller.signal.aborted) break;
    }
  } catch (error) {
    failures.push({ code: error.code ?? errorCode(error), message: errorText(error) });
  } finally {
    clearTimeout(timer); deps.signal?.removeEventListener('abort', abortFromParent);
    if (!recoveryRequired) for (const reservation of reservations.reverse()) {
      try {
        await deps.release({ root: reservation.profile.reservationRoot, owner: reservation.owner });
        await deps.writeState(store, reservation.owner.runId, { reservation: null, coordinator: await coordinatorIdentity() });
        releasedRunIds.add(reservation.owner.runId);
      }
      catch (error) { failures.push({ code: 'reservation-release-failed', profile: reservation.profile.profileName, message: errorText(error) }); }
    }
  }
  // Publish per-run reports only after this coordinator both released the
  // audit lease and durably cleared its reservation state. A failure leaves
  // the unfinished record available to exact-owner recovery.
  for (const [runId, report] of pendingFinalReports) {
    if (!releasedRunIds.has(runId)) continue;
    try {
      await deps.finalize(store, runId, { ...report, comparisonConditions: buildAuditComparisonConditions({ spec,
      baseline: preview.baseline, profile: selectionProfile(spec, report.profile), sharedProfileOverlap: Boolean(report.runningClients?.overlap?.length),
      profileOrder: context.profileOrder ?? spec.profiles.map(item => item.sideId ?? item.name), trialIndex: context.series?.trialIndex,
      environment: context.comparisonEnvironment }) }); finalizedRuns.add(runId);
    }
    catch (error) { failures.push({ code: 'run-report-finalize-failed', runId, message: errorText(error) }); }
  }
  for (const reference of runReferences) {
    let run = runs.find(item => item.id === reference.runRecord.id);
    // A reservation attempt can fail after creating its lock, and shutdown or
    // release failures can deliberately leave locks held. Preserve the exact
    // owner in state so audit recover can reconcile it after restart.
    const reservationMayBeHeld = reference.reservationAttempted && !releasedRunIds.has(reference.runRecord.id);
    if (reservationMayBeHeld) continue;
    if (!run) {
      const status = controller.signal.reason === 'experiment-timeout' ? 'timeout'
        : controller.signal.aborted ? 'cancelled' : 'not-started';
      run = { id: reference.runRecord.id, profile: safeProfile(reference.profile), status, phase: 'not-started',
        reason: status === 'not-started' ? 'Earlier preflight or reservation failure prevented this profile from starting.' : status,
        metrics: { setupMs: 0, taskMs: null, captureMs: null, checksMs: 0, totalMs: 0 }, setup: [], checks: [], artifacts: [], warnings: [],
        execution: { status, exitCode: null, elapsedMs: 0 }, outcome: { status: 'unverified', checks: [] },
        coverage: { timeline: 'unavailable', agents: 'unavailable', skills: 'unavailable', workspaceDiff: 'unavailable', outcome: 'partial' },
        normalized: { schemaVersion: 1, kind: 'audit-run', id: reference.runRecord.id, profile: safeProfile(reference.profile),
          status, agents: [], events: [], turns: [], skills: [], usage: { totals: null }, metrics: {}, artifacts: [],
          outcome: { status: 'unverified', checks: [] }, coverage: { timeline: 'unavailable', skills: 'unavailable' } } };
      runs.push(run);
      await deps.writeState(store, run.id, { status, phase: 'not-started', coordinator: await coordinatorIdentity(),
        reservation: null, process: null, workspace: null, outcome: run.outcome }).catch(() => {});
    }
    if (!finalizedRuns.has(reference.runRecord.id) && run.status !== 'recovery-required') {
      await deps.writeState(store, run.id, { status: run.status, phase: run.phase ?? 'not-started',
        coordinator: await coordinatorIdentity(), reservation: null, process: null,
        workspace: run.sourceWorkspace?.directory ? { directory: run.sourceWorkspace.directory,
          owner: { experimentId: experiment.id, runId: run.id }, active: false,
          finalFingerprint: run.finalWorkspace?.fingerprint ?? run.taskEnd?.fingerprint ?? null } : null }).catch(() => {});
      const capturedRun = run.normalized ?? { schemaVersion: 1, kind: 'audit-run', id: run.id, profile: run.profile,
        status: run.status, agents: [], events: [], turns: [], skills: [], usage: { totals: null }, metrics: {}, artifacts: [],
        outcome: run.outcome ?? { status: 'unverified', checks: [] }, coverage: run.coverage ?? { timeline: 'unavailable' } };
      const replay = await captureFrozenSessionReplay(deps, store,
        reference.runRecord.record?.profile ?? run.profile, capturedRun, reference.runRecord.directory);
      await deps.finalize(store, run.id, { ...capturedRun, ...(replay ?? {}), id: run.id, experimentId: experiment.id, profile: run.profile,
        baseline: reference.runRecord.record?.baseline, sourceWorkspace: run.sourceWorkspace,
        status: run.status, execution: run.execution ?? { status: run.status, exitCode: null, elapsedMs: 0 },
        outcome: run.outcome ?? { status: 'unverified', checks: [] },
        coverage: { ...(replay?.coverage ?? capturedRun.coverage ?? {}), ...(run.coverage ?? {}),
          agents: replay?.coverage?.agents ?? capturedRun.coverage?.agents ?? 'partial' },
        setup: run.setup ?? [], checks: run.checks ?? [], artifacts: run.artifacts ?? [], warnings: run.warnings ?? [],
        comparisonConditions: buildAuditComparisonConditions({ spec, baseline: preview.baseline,
          profile: selectionProfile(spec, run.profile), sharedProfileOverlap: Boolean(run.runningClients?.overlap?.length),
          profileOrder: context.profileOrder ?? spec.profiles.map(item => item.sideId ?? item.name), trialIndex: context.series?.trialIndex,
          environment: context.comparisonEnvironment }) })
        .then(() => finalizedRuns.add(run.id)).catch(() => {});
    }
  }
  const profileOrder = new Map(spec.profiles.map((selection, index) => [selectionKey(selection), index]));
  runs.sort((left, right) => (profileOrder.get(left.profile?.sideId ?? left.profile?.profileName?.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
    - (profileOrder.get(right.profile?.sideId ?? right.profile?.profileName?.toLowerCase()) ?? Number.MAX_SAFE_INTEGER));
  const reportRuns = runs.map(run => {
    const { normalized: capturedRun, ...execution } = run;
    // Full replay is stored once in each immutable run report. Repeating it in
    // every aggregate/comparison can exceed the experiment record's size bound;
    // showAuditRecord reconstructs opted-in replay from those exact run records.
    const { sessionReplay, ...capturedSummary } = capturedRun ?? {};
    return { ...capturedSummary, ...execution,
      profile: { ...(capturedRun?.profile ?? {}), profileId: run.profile?.profileId ?? run.profile?.id ?? null,
        profileName: run.profile?.profileName ?? run.profile?.name ?? null, name: run.profile?.name ?? run.profile?.profileName ?? null,
        home: run.profile?.home ?? null,
        ...(run.profile?.sideId ? { sideId: run.profile.sideId } : {}),
        ...(run.profile?.execution ? { execution: run.profile.execution } : {}),
        version: run.profile?.version ?? null, versionSource: run.profile?.versionSource ?? 'unavailable',
        ...(run.profile?.requestedVersion !== undefined ? { requestedVersion: run.profile.requestedVersion } : {}),
        ...(run.profile?.nativeConfig !== undefined ? { nativeConfig: { ...run.profile.nativeConfig } } : {}) },
      status: run.status, execution: run.execution ?? { status: run.status, exitCode: null, elapsedMs: run.metrics?.totalMs ?? null },
      coverage: run.coverage ?? capturedRun?.coverage ?? {}, metrics: { ...(capturedRun?.metrics ?? {}), ...(run.metrics ?? {}) },
      outcome: run.outcome ?? capturedRun?.outcome ?? { status: 'unknown' },
      workspace: run.workspace ?? { taskEnd: null, checkEnd: null },
      comparisonConditions: buildAuditComparisonConditions({ spec, baseline: preview.baseline,
        profile: selectionProfile(spec, run.profile), sharedProfileOverlap: Boolean(run.runningClients?.overlap?.length),
        profileOrder: context.profileOrder ?? spec.profiles.map(item => item.sideId ?? item.name), trialIndex: context.series?.trialIndex,
        environment: context.comparisonEnvironment }) };
  });
  const comparisons = reportRuns.length > 1 ? reportRuns.slice(1).map(run => compareAuditRuns(reportRuns[0], run)) : [];
  const complete = runs.length === spec.profiles.length && runs.every(run => run.status === 'complete') && !failures.length && !recoveryRequired;
  const timedOut = runs.some(run => run.status === 'timeout');
  const cancelled = runs.some(run => run.status === 'cancelled');
  const partial = runs.some(run => run.status === 'partial' || run.status === 'recovery-required');
  const reservationBlocked = failures.some(failure => ['profile-reservation-failed', 'profile-access-blocked', 'profile-access-unavailable', 'profile-clients-changed', 'commit-changed'].includes(failure.code))
    || runs.some(run => run.phase === 'reservation');
  const strictFailure = runs.some(run => run.status === 'failed' && run.phase !== 'reservation');
  const reportStatus = recoveryRequired ? 'recovery-required' : timedOut ? 'timeout' : cancelled ? 'cancelled'
    : complete ? 'complete' : reservationBlocked ? 'blocked' : strictFailure ? 'failed' : partial || runs.length ? 'partial' : 'failed';
  const report = { schemaVersion: 1, kind: 'audit-experiment-report', id: experiment.id,
    status: reportStatus,
    limits: { ...spec.limits, sandbox: spec.sandbox, ...(spec.approvalsReviewer ? { approvalsReviewer: spec.approvalsReviewer } : {}) },
    baseline: { repository: preview.baseline?.repository ?? null, commit: preview.baseline?.commit ?? null,
      tree: preview.baseline?.tree ?? null, selectedRevision: preview.baseline?.selectedRevision ?? null,
      sourceHead: preview.baseline?.sourceHead ?? null, sourceDirty: preview.baseline?.sourceDirty ?? null,
      taskOrder: spec.profiles.map(p => p.sideId ?? p.name), source: 'same-committed-snapshot' },
    execution: { status: reportStatus, exitCode: recoveryRequired ? 2 : timedOut ? 124 : cancelled ? 130 : complete ? 0 : reservationBlocked ? 1 : strictFailure ? 4 : 2,
      startedAt: experiment.record.createdAt, completedAt: now(), elapsedMs: duration(startedAt),
      order: spec.profiles.map(p => p.sideId ?? p.name), parallelism: 1, retries: 0, sandbox: spec.sandbox },
    profileOrder: context.profileOrder ?? spec.profiles.map(item => item.sideId ?? item.name),
    runs: reportRuns, comparisons, coverage: { profiles: runs.length === spec.profiles.length && runs.every(run => run.phase !== 'not-started') ? 'complete' : 'partial',
      skills: runs.every(run => run.coverage?.skills === 'complete') ? 'complete' : 'partial',
      outcomes: runs.every(run => run.coverage?.outcome === 'complete') ? 'complete' : 'partial' },
    warnings, failures, exitCode: recoveryRequired ? 2 : timedOut ? 124 : cancelled ? 130 : complete ? 0 : reservationBlocked ? 1 : strictFailure ? 4 : 2 };
  await deps.writeState(store, experiment.id, { status: report.status, phase: recoveryRequired ? 'recovery-required' : 'finished', completedAt: report.execution.completedAt,
    coordinator: await coordinatorIdentity(), runs: runReferences.map(ref => {
      const run = runs.find(item => item.id === ref.runRecord.id);
      return { id: ref.runRecord.id, profileId: ref.profile.profileId, status: run?.status ?? 'unknown' };
    }), failures, recoveryRequired }).catch(() => {});
  if (!recoveryRequired) await deps.finalize(store, experiment.id, report).catch(error => { report.warnings.push({ code: 'final-report-write-failed', message: errorText(error) }); report.exitCode = 2; });
  return { ...report, directory: experiment.directory, exitCode: report.exitCode ?? auditExitCode(report) };
}
