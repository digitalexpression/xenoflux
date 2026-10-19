// Controlled, sequential multi-profile experiment orchestration. Native profile
// state is observed and reserved; workspaces and process logs stay private.
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { validateAuditSpec } from './audit-spec.js';
import { inspectAuditRepository, authorizeAuditWorkspaceParent, createAuditWorkspace,
  snapshotAuditWorkspace, setAuditWorkspaceActive } from './audit-workspace.js';
import { createExperiment, createExperimentRun, writeAuditState, finalizeAuditRecord,
  reserveAuditProfile, releaseAuditProfileReservation, writeAuditCaptureCheckpoint } from './audit-experiment-store.js';
import { resolveAuditExecutionProfile, observeAuditProfileAccess, snapshotAuditProfileSettings,
  compareAuditProfileSettings } from './audit-profile.js';
import { runAuditCapture } from './audit-capture.js';
import { runAuditProcess, getAuditProcessIdentity } from './audit-process.js';
import { compareAuditRuns, auditExitCode } from './audit-report.js';
import { probeVersion } from './version-probe.js';
import { evaluateCaptureRequirements } from './audit-evidence.js';

const now = () => new Date().toISOString();
const duration = (start, end = Date.now()) => Math.max(0, end - start);
const safeProfile = profile => ({ id: profile.profileId, name: profile.profileName,
  profileId: profile.profileId, profileName: profile.profileName, home: profile.home,
  userHome: profile.userHome, executable: profile.executable, executableIdentity: profile.executableIdentity,
  nativeRoot: profile.nativeRoot ?? null, environmentId: profile.environmentId ?? null,
  executableSource: profile.executableSource, version: profile.version, versionSource: profile.versionSource,
  bindingRepository: profile.bindingRepository });
const SAFE_ERROR_TEXT = {
  'repository-limit': 'The source repository exceeds the supported Git tree or capture bounds.',
  'profile-repository-unbound': 'The selected repository is not already bound to this profile; no binding was changed.',
  'profile-access-blocked': 'A selected profile has an untrusted or mutating reservation.',
  'profile-access-unavailable': 'Safe access to a selected profile could not be verified.',
  'profile-clients-changed': 'An existing profile client or native reservation changed; remaining runs stopped.',
  'profile-reservation-failed': 'A selected profile could not be reserved.',
  'profile-settings-changed': 'Profile settings changed or became unverifiable.',
  'profile-settings-unavailable': 'Profile settings could not be safely fingerprinted.',
  'version-mismatch': 'The Codex executable version did not match the pinned version.',
  'version-probe-failed': 'The Codex executable version could not be verified.',
  'commit-changed': 'The selected repository commit changed during preflight.',
  timeout: 'The bounded experiment time limit expired.',
  cancelled: 'The experiment was cancelled.',
  'capture-incomplete': 'Required capture evidence is incomplete.',
  'task-failed': 'The Codex task process did not complete successfully.',
  'setup-failed': 'A setup command failed.',
  'process-shutdown-failed': 'A process group could not be confirmed stopped.',
};

const WORKSPACE_DELTA_BASIS = 'post-setup-snapshot-delta-v1';
function validOid(value) { return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value); }
function workspaceRecordIdentity(record) {
  if (record?.ignored === true) {
    if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) return null;
    return JSON.stringify(['ignored', record.sha256, record.size, record.newMode, record.symlink]);
  }
  if (!validOid(record?.oldOid) || !validOid(record?.newOid)) return null;
  return JSON.stringify(['git', record.status, record.oldMode, record.newMode, record.oldOid, record.newOid]);
}

/** Compare complete snapshot identities while preserving the original snapshots for cleanup. */
export function compareAuditWorkspaceDelta(before, taskEnd) {
  if (!before || !taskEnd || !Array.isArray(before.files) || !Array.isArray(taskEnd.files)
    || typeof before.fingerprint !== 'string' || typeof taskEnd.fingerprint !== 'string')
    return { changeCountStatus: 'unknown', changedFileCount: null, changeCountBasis: WORKSPACE_DELTA_BASIS,
      changeCountReason: 'workspace-snapshots-incomplete' };
  if (before.fingerprint === taskEnd.fingerprint)
    return { changeCountStatus: 'known', changedFileCount: 0, changeCountBasis: WORKSPACE_DELTA_BASIS };
  const byPath = snapshot => {
    const result = new Map();
    for (const record of snapshot.files) {
      if (!record || typeof record.path !== 'string' || !record.path || result.has(record.path)) return null;
      result.set(record.path, record);
    }
    return result;
  };
  const left = byPath(before), right = byPath(taskEnd);
  if (!left || !right) return { changeCountStatus: 'unknown', changedFileCount: null, changeCountBasis: WORKSPACE_DELTA_BASIS,
    changeCountReason: 'workspace-file-records-ambiguous' };
  let changedFileCount = 0;
  for (const path of new Set([...left.keys(), ...right.keys()])) {
    if (!left.has(path) || !right.has(path)) { changedFileCount++; continue; }
    if ((left.get(path)?.ignored === true) !== (right.get(path)?.ignored === true))
      return { changeCountStatus: 'unknown', changedFileCount: null, changeCountBasis: WORKSPACE_DELTA_BASIS,
        changeCountReason: 'workspace-file-origin-changed' };
    const a = workspaceRecordIdentity(left.get(path)), b = workspaceRecordIdentity(right.get(path));
    if (a === null || b === null) return { changeCountStatus: 'unknown', changedFileCount: null, changeCountBasis: WORKSPACE_DELTA_BASIS,
      changeCountReason: 'tracked-blob-identity-missing' };
    if (a !== b) changedFileCount++;
  }
  return { changeCountStatus: 'known', changedFileCount, changeCountBasis: WORKSPACE_DELTA_BASIS };
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
    observeAccess: context.observeAccess ?? observeAuditProfileAccess,
    snapshotSettings: context.snapshotSettings ?? snapshotAuditProfileSettings,
    compareSettings: context.compareSettings ?? compareAuditProfileSettings,
    probeVersion: context.probeVersion ?? probeVersion,
    capture: context.capture ?? runAuditCapture,
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

function selectionProfile(spec, profile) {
  return spec.profiles.find(item => item.name.toLowerCase() === profile.profileName.toLowerCase()) ?? {};
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
      const profile = await deps.resolveProfile(store, selection, { repository: repository?.repository ?? spec.repository });
      const requested = selectionProfile(spec, profile);
      const checks = [];
      if (!profile.profileId || !profile.home || !profile.reservationRoot || !profile.executable || !profile.version)
        throw new Error('Profile executable, version, or isolated home is unavailable');
      if (requested.executable && (profile.executable !== requested.executable || profile.version !== requested.version))
        throw new Error('Pinned profile executable or version could not be verified');
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
      else {
        let observedVersion;
        try { observedVersion = await deps.probeVersion({ executable: profile.executable, cwd: repository?.repository ?? spec.repository,
          env: profile.env, timeoutMs: 2000 }); }
        catch (error) {
          failures.push({ scope: 'profile', profile: profile.profileName, code: 'version-probe-failed', message: 'Codex executable version could not be verified.' });
        }
        if (observedVersion) {
          const expected = requested.version ?? profile.version;
          checks.push({ name: 'codex-version', status: observedVersion === expected ? 'ready' : 'mismatch', expected, observed: observedVersion });
          if (observedVersion !== expected) failures.push({ scope: 'profile', profile: profile.profileName,
            code: 'version-mismatch', message: SAFE_ERROR_TEXT['version-mismatch'] });
        }
      }
      checks.push({ name: 'capture-protocol', status: 'pending', reason: 'Confirmed by app-server initialize and skills/list during the run.' });
      let settings;
      try { settings = await deps.snapshotSettings(profile); }
      catch { settings = { status: 'unavailable' }; }
      checks.push({ name: 'settings-snapshot', status: settings?.status === 'ready' ? 'ready' : 'unknown' });
      if (settings?.status !== 'ready') failures.push({ scope: 'profile', profile: profile.profileName,
        code: 'profile-settings-unavailable', message: 'Profile settings cannot be safely fingerprinted; execution is blocked.' });
      profiles.push({ profileId: profile.profileId, profileName: profile.profileName, home: profile.home,
        executable: profile.executable, version: profile.version,
        status: failures.some(f => f.profile === profile.profileName) ? 'blocked' : 'ready',
        busy: (access?.clients?.length ?? 0) > 0, reason: null, checks });
    } catch (error) {
      failures.push({ scope: 'profile', profile: selection.name, code: errorCode(error), message: errorText(error) });
      profiles.push({ profileName: selection.name, profileId: null, home: null, executable: null,
        version: null, status: 'unavailable', busy: false, reason: errorText(error), checks: [] });
    }
  }
  // Same native home selected twice is never a valid paired experiment.
  const homes = new Map();
  for (const item of profiles) if (item.home) {
    const key = item.home;
    if (homes.has(key)) failures.push({ scope: 'profile', profile: item.profileName,
      code: 'duplicate-profile-home', message: 'Two selections resolve to the same profile home.' });
    else homes.set(key, item.profileName);
  }
  return { schemaVersion: 1, kind: 'audit-experiment-preview', status: failures.length ? 'blocked' : 'ready',
    baseline: repository ? { repository: repository.repository, commit: repository.commit, tree: repository.tree,
      selectedRevision: spec.revision, sourceHead: repository.sourceHead ?? null, sourceDirty: repository.sourceDirty ?? repository.clean === false } : null,
    repository: repository ? { path: repository.repository, commit: repository.commit, tree: repository.tree,
      files: repository.files, bytes: repository.bytes, clean: repository.clean } : null,
    profiles, taskCount: spec.profiles.length, executionOrder: spec.profiles.map(p => p.name),
    limits: { ...spec.limits, sandbox: spec.sandbox }, failures, warnings,
    ...(spec.captureRequirements ? { captureRequirements: spec.captureRequirements } : {}),
    capture: { status: 'partial', capabilities: { appServerV2: 'pending', skillsList: 'pending', skillUseObservability: 'native-otel-best-effort' },
      errors: [{ code: 'exhaustive-skill-use-unverified' }] },
    sideEffects: { profileReservations: false, records: false, workspaces: false, modelTasks: false } };
}

function requireProfileAccess(access) {
  if (access?.status !== 'ready') throw Object.assign(new Error('Safe profile access is unavailable.'),
    { code: access?.status === 'blocked' ? 'profile-access-blocked' : 'profile-access-unavailable' });
}

function compareProfileAccess(before, after) {
  const identity = client => JSON.stringify([client.pid, client.startedAt, client.uid, client.executable]);
  const observed = new Set((after?.clients ?? []).map(identity));
  const original = before?.clients ?? [];
  const missing = original.filter(client => !observed.has(identity(client)));
  const reservationUnchanged = JSON.stringify(before?.sourceReservation ?? null) === JSON.stringify(after?.sourceReservation ?? null);
  return { status: after?.status !== 'ready' ? 'unavailable' : missing.length || !reservationUnchanged ? 'changed' : 'unchanged',
    before: original, after: after?.clients ?? [], missing, reservationUnchanged,
    sourceReservation: before?.sourceReservation ?? null };
}

function reservationOwner(experimentId, runId, profile, store) {
  return { kind: 'audit-experiment', host: hostname(), pid: process.pid, runId, experimentId,
    storePath: store.directory, profileId: profile.profileId, home: profile.home };
}

async function ensureDirs(directory) {
  const artifacts = join(directory, 'artifacts'), temp = join(directory, 'tmp');
  await mkdir(artifacts, { mode: 0o700 }); await mkdir(temp, { mode: 0o700 });
  return { artifacts, temp };
}

async function runCommand(store, runId, deps, command, { profile, workspace, directory, phase, index, deadline, signal, outputBytes, owner }) {
  const started = Date.now(), stdoutPath = join(directory, `${phase}-${index}.stdout`), stderrPath = join(directory, `${phase}-${index}.stderr`);
  const timeoutMs = Math.max(1, Math.min(command.timeoutMs, deadline - Date.now()));
  if (timeoutMs <= 1 && Date.now() >= deadline) return { name: command.name, status: 'timeout', exitCode: null, elapsedMs: 0 };
  const env = { PATH: profile.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(directory, 'tmp'),
    TMPDIR: join(directory, 'tmp'), TMP: join(directory, 'tmp'), TEMP: join(directory, 'tmp'), LC_ALL: 'C' };
  const result = await deps.process({ executable: '/usr/bin/env', args: command.argv, cwd: workspace,
    env, timeoutMs, outputLimitBytes: outputBytes, stdoutPath, stderrPath, signal,
    onSpawn: async info => { await deps.writeState(store, runId, { status: 'running', phase,
      coordinator: await coordinatorIdentity(), reservation: { root: profile.reservationRoot, owner, status: 'held' },
      process: { pid: info.pid ?? null, processIdentity: info.processIdentity ?? null, host: hostname() } }); } });
  if (result.shutdown?.groupTerminated === false || result.status === 'shutdown-failed')
    return { name: command.name, status: 'recovery-required', exitCode: result.exitCode, elapsedMs: result.elapsedMs,
      process: result.processIdentity ?? null, pid: result.pid ?? null, shutdown: result.shutdown ?? null };
  await deps.writeState(store, runId, { phase, process: null });
  return { name: command.name, status: result.status === 'exited' && result.exitCode === 0 ? 'passed'
    : result.status === 'exited' ? 'failed' : result.status, exitCode: result.exitCode,
    signal: result.signal, elapsedMs: result.elapsedMs ?? duration(started), output: result.output,
    process: result.processIdentity ?? null, shutdown: result.shutdown ?? null };
}

function captureComplete(captured) {
  return captured?.run?.status === 'ready' && captured?.capture?.status === 'ready'
    && captured?.run?.coverage?.skills === 'complete';
}

/** Execute the validated paired experiment sequentially and persist recovery state. */
export async function runAuditExperiment(store, input, context = {}) {
  const spec = validateAuditSpec(input), deps = dependencies(context), preview = await previewAuditExperiment(store, spec, context);
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
      home: item.home, version: item.version })), baseline: { repository: preview.baseline, source: 'committed-snapshot' } });
  const runs = [], reservations = [], failures = [], warnings = [], runReferences = [], finalizedRuns = new Set(), releasedRunIds = new Set(), pendingFinalReports = new Map();
  let recoveryRequired = false;
  const startedAt = Date.now(), experimentDeadline = startedAt + spec.limits.experimentMs;
  let timer;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(deps.signal?.reason ?? 'cancelled');
  if (deps.signal?.aborted) abortFromParent(); else deps.signal?.addEventListener('abort', abortFromParent, { once: true });
  timer = setTimeout(() => controller.abort('experiment-timeout'), spec.limits.experimentMs);
  const bySelection = new Map();
  try {
    await deps.writeState(store, experiment.id, { status: 'reserving', phase: 'reservation', coordinator: await coordinatorIdentity() });
    // Resolve and reserve every profile before the first model task starts.
    for (const selection of spec.profiles) {
      const profile = await deps.resolveProfile(store, selection, { repository: repository.repository });
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
        await deps.reserve({ root: profile.reservationRoot, owner });
        reservations.push({ profile, owner });
        await deps.writeState(store, runRecord.id, { reservation: { root: profile.reservationRoot, owner, status: 'held' } });
      } catch (error) {
        runs.push({ id: runRecord.id, status: 'failed', phase: 'reservation', profile: safeProfile(profile),
          error: { code: errorCode(error), message: errorText(error) } });
        throw Object.assign(new Error(`Could not reserve profile ${profile.profileName}; no model task was started.`), { code: 'profile-reservation-failed' });
      }
      bySelection.set(selection.name, { profile, beforeSettings, beforeAccess, runRecord, owner });
    }
    // Audit-only leases serialize experiments without taking the native client lock.
    // Recheck access and the original clients before launching any model work.
    for (const { profile } of reservations) {
      const prepared = [...bySelection.values()].find(item => item.profile.profileId === profile.profileId);
      const access = await deps.observeAccess(profile, { store, expectedClients: prepared.beforeAccess.clients });
      requireProfileAccess(access);
      if (compareProfileAccess(prepared.beforeAccess, access).status !== 'unchanged')
        throw Object.assign(new Error(SAFE_ERROR_TEXT['profile-clients-changed']), { code: 'profile-clients-changed' });
      if (deps.compareSettings(prepared.beforeSettings, await deps.snapshotSettings(profile)).status !== 'unchanged')
        throw Object.assign(new Error(SAFE_ERROR_TEXT['profile-settings-changed']), { code: 'profile-settings-changed' });
      const observedVersion = await deps.probeVersion({ executable: profile.executable, cwd: repository.repository,
        env: profile.env, timeoutMs: 2000, signal: controller.signal });
      if (observedVersion !== prepared.profile.version) throw Object.assign(new Error('Version changed after reservation.'), { code: 'version-mismatch' });
    }
    await deps.writeState(store, experiment.id, { status: 'running', phase: 'workspace', startedAt: now(),
      coordinator: await coordinatorIdentity(), runs: runReferences.map(({ runRecord, profile }) => ({ id: runRecord.id, profileId: profile.profileId, status: 'prepared' })) });
    for (let index = 0; index < spec.profiles.length; index++) {
      const selection = spec.profiles[index], prepared = bySelection.get(selection.name);
      if (controller.signal.aborted || Date.now() >= experimentDeadline) {
        runs.push({ id: prepared.runRecord.id, profile: safeProfile(prepared.profile), status: 'cancelled', phase: 'not-started', reason: controller.signal.reason === 'experiment-timeout' ? 'experiment-timeout' : 'cancelled' });
        continue;
      }
      const { profile, beforeSettings, beforeAccess, runRecord, owner } = prepared;
      const phaseStart = Date.now(), runDeadline = Math.min(experimentDeadline, phaseStart + spec.limits.runMs);
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
        workspace = await deps.createWorkspace({ repository: repository.repository, commit: repository.commit,
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
          if (controller.signal.aborted || Date.now() >= runDeadline) { setupFailed = true; break; }
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
        const taskTimeout = Math.max(1, Math.min(spec.limits.runMs - duration(phaseStart), experimentDeadline - Date.now()));
        const selectedSkills = selection.skills ?? [];
        const captured = await deps.capture({ profile, workspace: workspace.directory, task: spec.task, selectedSkills,
          processOptions: { env: profile.env, timeoutMs: taskTimeout, outputLimitBytes: spec.limits.outputBytes,
            stdoutPath: join(runRecord.directory, 'codex.stdout'), stderrPath: join(runRecord.directory, 'codex.stderr'),
            signal: controller.signal,
          onSpawn: async info => deps.writeState(store, runRecord.id, { status: 'running', phase: 'task',
            coordinator: await coordinatorIdentity(), reservation: { root: profile.reservationRoot, owner, status: 'held' },
            process: { pid: info.pid ?? null, processIdentity: info.processIdentity ?? null, host: hostname() },
            workspace: { ...workspaceIntent, active: true } }) },
          limits: { id: runRecord.id },
          sandbox: spec.sandbox,
          onPhase: async phase => deps.writeState(store, runRecord.id, { phase }),
          onTaskEnd: async evidence => {
            // Capture calls this only after owned process-group shutdown, before
            // checks. Missing native child evidence still makes the boundary partial.
            const snapshot = await deps.snapshotWorkspace({ directory: workspace.directory, owner: workspaceOwner,
              outputDirectory: dirs.artifacts, label: 'task-end' });
            taskEndSnapshot = snapshot;
            const changeCount = compareAuditWorkspaceDelta(initialSnapshot, snapshot);
            taskEndCaptureComplete = evidence?.complete === true;
            runResult.timestamps.taskEndedAt = evidence?.at ?? now();
            runResult.taskEnd = { status: snapshot.status, fingerprint: snapshot.fingerprint,
              files: snapshot.files.length, patchPath: snapshot.patchPath, metadataPath: snapshot.metadataPath,
              baselineFingerprint: initialSnapshot?.fingerprint ?? null, ...changeCount,
              captureComplete: taskEndCaptureComplete, boundary: evidence?.boundary ?? null,
              nativeEndedAt: evidence?.nativeEndedAt ?? null, timing: taskEndCaptureComplete ? 'task-end' : 'unverified-task-end' };
            runResult.workspace = { ...runResult.workspace, taskEnd: { status: snapshot.status,
              path: snapshot.patchPath, fingerprint: snapshot.fingerprint, fileCount: snapshot.files.length,
              baselineFingerprint: initialSnapshot?.fingerprint ?? null, ...changeCount,
              captureComplete: taskEndCaptureComplete, timing: runResult.taskEnd.timing } };
            runResult.artifacts.push({ kind: 'workspace-snapshot', label: snapshot.label, fingerprint: snapshot.fingerprint,
              status: snapshot.status, files: snapshot.files.length, patchPath: snapshot.patchPath, metadataPath: snapshot.metadataPath,
              captureComplete: taskEndCaptureComplete, timing: runResult.taskEnd.timing });
            await deps.writeState(store, runRecord.id, { phase: 'checks', taskEnd: runResult.taskEnd,
              workspace: { ...workspaceIntent, active: true, finalFingerprint: snapshot.fingerprint } });
          },
          onSession: async (session, captureRecord) => {
            await deps.writeCaptureCheckpoint(store, runRecord.id, { run: session, capture: captureRecord });
            await deps.writeState(store, runRecord.id, { phase: 'capture',
            nativeSessionId: session?.source?.threadId ?? null,
            captureCheckpoint: { capturedAt: now(), status: session?.status ?? 'unknown',
              eventCount: Array.isArray(session?.events) ? session.events.length : null,
              agentCount: Array.isArray(session?.agents) ? session.agents.length : null,
              skillCount: Array.isArray(session?.skills) ? session.skills.length : null,
              skillInvocationCount: Array.isArray(session?.skillInvocations) ? session.skillInvocations.length : null,
              toolInvocationCount: Array.isArray(session?.toolInvocations) ? session.toolInvocations.length : null,
              coverage: session?.coverage ?? null, captureStatus: captureRecord?.status ?? 'unknown' } });
          } });
        const taskProcessUnsafe = captured?.process?.shutdown?.groupTerminated === false || captured?.process?.status === 'shutdown-failed';
        if (!taskProcessUnsafe) await deps.writeState(store, runRecord.id, { phase: 'capture', process: null });
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
        if (!taskEndSnapshot) {
          const snapshot = await deps.snapshotWorkspace({ directory: workspace.directory, owner: workspaceOwner,
            outputDirectory: dirs.artifacts, label: 'task-end-fallback' });
          taskEndSnapshot = snapshot;
          const changeCount = compareAuditWorkspaceDelta(initialSnapshot, snapshot);
          runResult.taskEnd = { status: snapshot.status, fingerprint: snapshot.fingerprint, files: snapshot.files.length,
            baselineFingerprint: initialSnapshot?.fingerprint ?? null, ...changeCount,
            patchPath: snapshot.patchPath, metadataPath: snapshot.metadataPath, captureComplete: false,
            timing: 'after-process-fallback' };
          runResult.workspace = { ...runResult.workspace, taskEnd: { status: snapshot.status,
            path: snapshot.patchPath, fingerprint: snapshot.fingerprint, fileCount: snapshot.files.length,
            baselineFingerprint: initialSnapshot?.fingerprint ?? null, ...changeCount,
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
        const nativeCompleted = runResult.normalized.outcome?.nativeTurnStatus === 'completed';
        const taskStatus = captured?.process?.status === 'exited' && captured?.process?.exitCode === 0 && nativeCompleted
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
        if (taskStatus === 'failed') throw Object.assign(new Error('Codex task process did not complete successfully.'), {
          code: captured?.process?.status === 'timeout' ? 'timeout' : captured?.process?.status === 'cancelled' ? 'cancelled' : 'task-failed' });
        const checkStart = Date.now();
        for (let cmd = 0; cmd < spec.checks.length; cmd++) {
          if (controller.signal.aborted || Date.now() >= runDeadline) { runResult.checks.push({ name: spec.checks[cmd].name, status: controller.signal.aborted ? 'cancelled' : 'timeout', exitCode: null }); break; }
          const result = await runCommand(store, runRecord.id, deps, spec.checks[cmd], { profile, workspace: workspace.directory,
            directory: runRecord.directory, phase: 'check', index: cmd, deadline: runDeadline,
            signal: controller.signal, outputBytes: spec.limits.outputBytes, owner });
          const required = context.checkRequired?.(spec.checks[cmd].name) ?? true;
          runResult.checks.push({ ...result, ...(context.checkRequired ? { required } : {}) });
          if (result.status === 'recovery-required' || (result.status !== 'passed' && required)) break;
        }
        runResult.metrics.checksMs = duration(checkStart);
        const finalSnapshot = await deps.snapshotWorkspace({ directory: workspace.directory, owner: workspaceOwner,
          outputDirectory: dirs.artifacts, label: 'after-checks' });
        runResult.finalWorkspace = { status: finalSnapshot.status, fingerprint: finalSnapshot.fingerprint,
          files: finalSnapshot.files.length, patchPath: finalSnapshot.patchPath, metadataPath: finalSnapshot.metadataPath };
        runResult.workspace = { taskEnd: { status: taskEndSnapshot.status, path: taskEndSnapshot.patchPath,
          fingerprint: taskEndSnapshot.fingerprint, fileCount: taskEndSnapshot.files.length,
          baselineFingerprint: initialSnapshot?.fingerprint ?? null,
          ...compareAuditWorkspaceDelta(initialSnapshot, taskEndSnapshot),
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
        runResult.runningClients = compareProfileAccess(beforeAccess, afterAccess);
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
            artifacts: runResult.artifacts, setup: runResult.setup, checks: runResult.checks,
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
        await deps.writeState(store, runRecord.id, { status: runResult.status, phase: 'complete', completedAt: runResult.timestamps.completedAt,
          process: null, metrics: runResult.metrics, outcome: runResult.outcome, profileSettings: runResult.profileSettings, runningClients: runResult.runningClients,
          workspace: { ...workspaceIntent, active: false, finalFingerprint: finalSnapshot.fingerprint } });
        pendingFinalReports.set(runRecord.id, { ...runResult.normalized, id: runRecord.id,
          experimentId: experiment.id, profile: safeProfile(profile), baseline: runRecord.record?.baseline,
          sourceWorkspace: runResult.sourceWorkspace, status: runResult.status,
          metrics: runResult.metrics, outcome: runResult.outcome, taskEnd: runResult.taskEnd, finalWorkspace: runResult.finalWorkspace,
          execution: runResult.execution, capture: runResult.capture, captureProtocol: runResult.captureProtocol, workspace: runResult.workspace,
          profileSettings: runResult.profileSettings, runningClients: runResult.runningClients, artifacts: runResult.artifacts, setup: runResult.setup, checks: runResult.checks,
          coverage: runResult.coverage, warnings: runResult.warnings });
        runs.push(runResult);
      } catch (error) {
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
          if (processInfo?.pid) { recoveryRequired = true; runResult.status = 'recovery-required'; }
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
          runResult.runningClients = compareProfileAccess(beforeAccess, access);
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
        if (!recoveryRequired) pendingFinalReports.set(runRecord.id, { ...runResult.normalized, id: runRecord.id,
          experimentId: experiment.id, profile: safeProfile(profile), baseline: runRecord.record?.baseline,
          sourceWorkspace: runResult.sourceWorkspace, status: runResult.status,
          metrics: runResult.metrics, outcome: runResult.outcome ?? { status: 'unknown' }, taskEnd: runResult.taskEnd ?? null,
          finalWorkspace: runResult.finalWorkspace ?? null,
          execution: runResult.execution, capture: runResult.capture, captureProtocol: runResult.captureProtocol, workspace: runResult.workspace,
          profileSettings: runResult.profileSettings, runningClients: runResult.runningClients, artifacts: runResult.artifacts, setup: runResult.setup, checks: runResult.checks,
          coverage: { ...runResult.normalized.coverage, ...runResult.coverage }, warnings: runResult.warnings });
        runs.push(runResult);
      }
      if (recoveryRequired || failures.some(f => ['profile-settings-changed', 'profile-clients-changed'].includes(f.code)) || controller.signal.aborted) break;
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
    try { await deps.finalize(store, runId, report); finalizedRuns.add(runId); }
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
      await deps.finalize(store, run.id, { ...capturedRun, id: run.id, experimentId: experiment.id, profile: run.profile,
        baseline: reference.runRecord.record?.baseline, sourceWorkspace: run.sourceWorkspace,
        status: run.status, execution: run.execution ?? { status: run.status, exitCode: null, elapsedMs: 0 },
        outcome: run.outcome ?? { status: 'unverified', checks: [] }, coverage: run.coverage ?? capturedRun.coverage,
        setup: run.setup ?? [], checks: run.checks ?? [], artifacts: run.artifacts ?? [], warnings: run.warnings ?? [] })
        .then(() => finalizedRuns.add(run.id)).catch(() => {});
    }
  }
  const profileOrder = new Map(spec.profiles.map((selection, index) => [selection.name.toLowerCase(), index]));
  runs.sort((left, right) => (profileOrder.get((left.profile?.profileName ?? left.profile?.name ?? '').toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
    - (profileOrder.get((right.profile?.profileName ?? right.profile?.name ?? '').toLowerCase()) ?? Number.MAX_SAFE_INTEGER));
  const reportRuns = runs.map(run => {
    const { normalized: capturedRun, ...execution } = run;
    return { ...(capturedRun ?? {}), ...execution,
      profile: { ...(capturedRun?.profile ?? {}), profileId: run.profile?.profileId ?? run.profile?.id ?? null,
        profileName: run.profile?.profileName ?? run.profile?.name ?? null, name: run.profile?.name ?? run.profile?.profileName ?? null,
        home: run.profile?.home ?? null },
      status: run.status, execution: run.execution ?? { status: run.status, exitCode: null, elapsedMs: run.metrics?.totalMs ?? null },
      coverage: run.coverage ?? capturedRun?.coverage ?? {}, metrics: { ...(capturedRun?.metrics ?? {}), ...(run.metrics ?? {}) },
      outcome: run.outcome ?? capturedRun?.outcome ?? { status: 'unknown' },
      workspace: run.workspace ?? { taskEnd: null, checkEnd: null } };
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
    baseline: { repository: preview.baseline?.repository ?? null, commit: preview.baseline?.commit ?? null,
      tree: preview.baseline?.tree ?? null, selectedRevision: preview.baseline?.selectedRevision ?? null,
      sourceHead: preview.baseline?.sourceHead ?? null, sourceDirty: preview.baseline?.sourceDirty ?? null,
      taskOrder: spec.profiles.map(p => p.name), source: 'same-committed-snapshot' },
    execution: { status: reportStatus, exitCode: recoveryRequired ? 2 : timedOut ? 124 : cancelled ? 130 : complete ? 0 : reservationBlocked ? 1 : strictFailure ? 4 : 2,
      startedAt: experiment.record.createdAt, completedAt: now(), elapsedMs: duration(startedAt),
      order: spec.profiles.map(p => p.name), parallelism: 1, retries: 0, sandbox: spec.sandbox },
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
