// The UI's two-profile adapter over the existing durable experiment runner.
// Preview is read-only; only an explicitly submitted preview token starts work.
import { randomUUID } from 'node:crypto';
import { lstat, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateDirectory, readJSON, record } from './metadata.js';
import { listHomes } from './homes.js';
import { validateAuditSpec } from './audit-spec.js';
import { previewAuditExperiment, runAuditExperiment } from './audit-runner.js';
import { inspectAuditRepository } from './audit-workspace.js';
import { resolveAuditExecutionProfile, snapshotAuditProfileSettings, compareAuditProfileSettings } from './audit-profile.js';
import { readAuditRecord } from './audit-experiment-store.js';
import { showAuditRecord, recoverAuditExperiment } from './audit-experiment.js';
import { compareAuditRuns } from './audit-report.js';
import { resolveAuditProfile } from './audit-discovery.js';
import { buildAuditComparisonConditions } from './audit-conditions.js';
import { validateNativeResponse } from './native-requests.js';
import { UiError } from './ui-server.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const errorText = reason => reason instanceof Error ? reason.message : String(reason);
const minutes = value => value === null ? 'No time cap' : Number.isFinite(value) ? `${Math.ceil(value / 60000)} min` : 'not recorded';
const identity = profile => ['profileId', 'home', 'nativeRoot', 'environmentId', 'executable', 'executableIdentity', 'bindingRepository']
  .map(key => profile[key] ?? null);
const checkedId = id => { if (!UUID.test(id ?? '')) throw new UiError(400, 'Choose a saved task run.', 'invalid-run'); return id; };

function requestSpec(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Describe the task first.');
  const advanced = request.advanced ?? {};
  const execution = request.execution;
  if (execution !== undefined && (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || Object.keys(execution).some(key => key !== 'a' && key !== 'b')))
    throw new Error('Choose execution settings for comparison sides A and B');
  const commandList = (rows = []) => {
    if (!Array.isArray(rows) || rows.length > 20) throw new Error('Choose at most twenty commands.');
    return rows.map(row => {
      if (typeof row?.command !== 'string' || !row.command.trim()) throw new Error('Each setup or verification command must contain the command you want to run.');
      return { name: row.name, argv: ['/bin/sh', '-lc', row.command], timeoutMs: 60000 };
    });
  };
  const files = typeof request.files === 'string' ? request.files.split(/[,\n]/).map(value => value.trim()).filter(Boolean) : [];
  const defaultExecution = advanced.reasoningEffort ? { reasoningEffort: advanced.reasoningEffort } : {};
  const runMs = advanced.timeMinutes === null ? null : (advanced.timeMinutes ?? 15) * 60000;
  return validateAuditSpec({ schemaVersion: 1, repository: request.repository, revision: request.commit,
    task: request.task, profiles: ['a', 'b'].map(sideId => ({ name: request[sideId], sideId,
      ...(advanced.program ? { executable: advanced.program } : {}), execution: execution && Object.hasOwn(execution, sideId) ? execution[sideId] : defaultExecution })),
    limits: { runMs, ...(runMs === null ? { experimentMs: null } : {}), outputBytes: (advanced.outputMiB ?? 8) * 1024 * 1024, maxRuns: 2 },
    checks: commandList(request.checks), setup: commandList(advanced.setup), sandbox: advanced.sandbox ?? 'workspace-write',
    allowIncompleteCapture: true, ...(files.length ? { taskContract: { id: 'ui-task', editableFiles: files } } : {}) });
}

export function createUiRuns({ store, defaultUserHome, context = {}, admission }) {
  const root = join(store.directory, 'ui-runs');
  const previews = new Map(), starts = new Map(), active = new Map(), finished = new Map(), recoveryPlans = new Map();
  let closing = false;
  const baseContext = { ...context,
    resolveProfile: (selectedStore, selection, options = {}) => (context.resolveProfile ?? resolveAuditExecutionProfile)(selectedStore, selection, { defaultUserHome, ...options }) };
  // Recovery checks the saved home/lease identity; it never prepares execution.
  const recoveryContext = { ...context, resolveProfile: (selectedStore, selection) =>
    (context.recoverProfile ?? resolveAuditProfile)(selectedStore, selection, { defaultUserHome }) };
  const snapshot = context.snapshotSettings ?? snapshotAuditProfileSettings;
  const compareSettings = context.compareSettings ?? compareAuditProfileSettings;
  const boundedSet = (map, key, value) => { map.set(key, value); while (map.size > 30) map.delete(map.keys().next().value); };

  async function receipt(id) {
    checkedId(id);
    try {
      await privateDirectory(root);
      const value = await readJSON(join(root, `${id}.json`));
      if (value?.id !== id || !Array.isArray(value.profiles) || value.profiles.length !== 2
        || (value.sideIds !== undefined && !same(value.sideIds, ['a', 'b']))
        || value.profiles.some(name => typeof name !== 'string' || !name.trim()) || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Invalid UI run receipt');
      return value;
    }
    catch { throw new UiError(404, 'This task run was not found. Its existing records have not been changed.', 'run-missing'); }
  }
  async function receiptList() {
    try {
      await privateDirectory(root);
      const files = (await readdir(root)).filter(name => UUID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
      const rows = await Promise.all(files.map(name => receipt(name.slice(0, -5)).catch(() => null)));
      return rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async function inspect(spec) {
    const profiles = [], snapshots = [];
    const preview = await previewAuditExperiment(store, spec, { ...baseContext,
      resolveProfile: async (...args) => { const value = await baseContext.resolveProfile(...args); profiles.push(identity(value)); return value; },
      snapshotSettings: async profile => { const value = await snapshot(profile); snapshots.push(value); return value; } });
    return { preview, profiles, snapshots };
  }

  async function runOptions() {
    const homes = await listHomes(store), data = await store.read();
    const paths = [...new Set(data.profiles.flatMap(profile => profile.repositories.map(repo => repo.path)))];
    const repositories = await Promise.all(paths.map(async path => {
      try { const repo = await inspectAuditRepository(path, 'HEAD'); return { path, commit: repo.commit }; }
      catch { return { path, commit: 'HEAD' }; }
    }));
    const profiles = homes.map(home => ({ name: home.name, ready: home.state === 'ready',
      readiness: home.state === 'ready' ? 'Profile available; sign-in and access are checked before Start.' : home.reason ?? 'Set up this profile in Profiles first.' })),
      defaults = { timeMinutes: 15, access: 'its workspace copy, no network', outputCap: '8 MiB', outputMiB: 8, program: '' };
    if (await lstat(join(defaultUserHome, '.codex')).then(info => info.isDirectory(), () => false)) profiles.push({ name: 'Default', ready: false,
      readiness: 'Choose the Codex program in Advanced settings to preview Default. Its saved setup is not changed.' });
    return { profiles, repositories, defaults, simulated: false };
  }

  async function runPreview(request) {
    let spec;
    try { spec = requestSpec(request); }
    catch (error) { throw new UiError(400, errorText(error), 'invalid-run'); }
    const reviewed = await inspect(spec), { preview } = reviewed;
    const ready = preview.status === 'ready', token = ready ? randomUUID() : null;
    if (ready) boundedSet(previews, token, { ...reviewed, spec, at: Date.now() });
    const profileText = profile => `${profile.executable ?? 'Codex CLI unavailable'} · ${profile.version ?? 'version not known'} · ${profile.status}${profile.busy ? ' · existing clients stay open' : ''}`;
    return { ready, previewToken: token, blocked: ready ? null : { title: 'This task cannot start yet',
      reason: preview.failures.map(failure => `${failure.profile ? `${failure.profile}: ` : ''}${failure.message}`).join(' ') },
      summary: `2 model runs, one after the other · ${minutes(spec.limits.experimentMs)}`, limit: minutes(spec.limits.experimentMs),
      task: spec.task, files: spec.taskContract?.editableFiles.join(', ') ?? '',
      runs: preview.profiles.map((profile, index) => ({ side: index ? 'b' : 'a', profile: profile.profileName, text: `${profileText(profile)} · Model: ${spec.profiles[index].execution.model ?? 'profile default'} · Effort: ${spec.profiles[index].execution.reasoningEffort ?? 'profile default'}` })),
      where: [preview.baseline?.repository ?? spec.repository, `Pinned commit: ${preview.baseline?.commit ?? 'not available'}`,
        'Each profile starts in a separate checkout of this commit. Uncommitted edits and untracked or ignored files are excluded.',
        'Workspace preparation preserves the source checkout. Task, setup and check commands can have effects outside their copy.'],
      checks: spec.checks.map(check => `${check.name}: ${check.argv[2]} (up to ${minutes(check.timeoutMs)})`),
      limits: [`${minutes(spec.limits.runMs)} per profile; ${minutes(spec.limits.experimentMs)} overall.`,
        `Codex access: ${spec.sandbox}; network disabled inside the sandbox. Native approvals are shown during the run. Output per program: ${spec.limits.outputBytes / 1024 / 1024} MiB.`,
        ...spec.setup.map(command => `Setup before each task: ${command.name}: ${command.argv[2]} (ordinary program outside the Codex sandbox).`),
        'Native skill-use capture is best effort; incomplete evidence stays explicit. No automatic review or rating is run.'],
      willDo: ['Start exactly two real model tasks using the selected profiles’ sign-ins.', 'Run only the setup and verification commands listed here.', 'Retain the evidence and open the shared comparison report.'],
      never: ['Never silently swap or sign in a profile.', 'Never quit existing Codex or Terminal clients.', 'Never automatically restart interrupted model tasks.'],
      cliCommand: 'xfx audit run --spec PATH_TO_REVIEWED_SPEC.json', simulated: false };
  }

  async function launch(token) {
    checkedId(token);
    try { await receipt(token); return { id: token }; } catch (error) { if (error.code !== 'run-missing') throw error; }
    const reviewed = previews.get(token);
    if (!reviewed || Date.now() - reviewed.at > 20 * 60000) throw new UiError(409, 'This preview expired. Refresh the preview before starting.', 'preview-stale');
    if (closing) throw new UiError(409, 'Xenoflux is stopping. Start it again before reviewing a new task.', 'stopping');
    let admitted = false, launched = false;
    try {
      if (admission) { await admission.acquire(token); admitted = true; }
      const fresh = await inspect(reviewed.spec);
      const changed = fresh.preview.status !== 'ready' || !same(fresh.preview.baseline, reviewed.preview.baseline)
        || !same(fresh.profiles, reviewed.profiles) || reviewed.snapshots.some((before, index) => compareSettings(before, fresh.snapshots[index]).status !== 'unchanged');
      if (changed) throw new UiError(409, 'The commit, profile setup or access changed after review. Nothing started; refresh the preview.', 'preview-stale');
      if (closing) throw new UiError(409, 'Xenoflux stopped while checking the preview. No task started.', 'stopping');
      await privateDirectory(store.directory, true); await privateDirectory(root, true);
      const entry = { id: token, createdAt: new Date().toISOString(), profiles: reviewed.spec.profiles.map(profile => profile.name), sideIds: reviewed.spec.profiles.map(profile => profile.sideId) };
      try { await writeFile(join(root, `${token}.json`), JSON.stringify(entry) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') return { id: token }; throw error; }
      if (closing) {
        // This attempt exclusively created the receipt, but has not created an audit.
        await unlink(join(root, `${token}.json`));
        throw new UiError(409, 'Xenoflux stopped before the experiment started. No task started.', 'stopping');
      }
      const controller = new AbortController();
      const work = { ...entry, task: reviewed.spec.task, spec: reviewed.spec, controller, done: false, pendingRequests: new Map() };
      active.set(token, work);
      launched = true;
      work.promise = runAuditExperiment(store, { ...reviewed.spec, revision: reviewed.preview.baseline.commit },
        { ...baseContext, experimentId: token, signal: controller.signal,
          onNativeRequest: (legId, side, request, { signal, item }) => {
            if (signal.aborted || controller.signal.aborted) throw new Error('Comparison stopped');
            const requestId = randomUUID();
            return new Promise((resolve, reject) => {
              const abort = () => { work.pendingRequests.delete(requestId); reject(new Error('Comparison leg stopped')); };
              signal.addEventListener('abort', abort, { once: true });
              work.pendingRequests.set(requestId, { legId, side, requestId, request, item,
                signal, resolve: value => { signal.removeEventListener('abort', abort); resolve(value); } });
            });
          } })
        .then(async result => {
          work.result = result;
          if (result.kind === 'audit-experiment-preview') {
            work.error = result.failures.map(failure => failure.message).join(' ') || 'Native preflight could not complete.';
            await record(join(root, `${token}.json`), { ...entry, startFailure: work.error }).catch(() => {});
          }
        }, async error => {
          work.error = errorText(error);
          await record(join(root, `${token}.json`), { ...entry, startFailure: work.error }).catch(() => {});
        })
        .finally(() => { work.done = true; active.delete(token); boundedSet(finished, token, work); admission?.release(token); });
      return { id: token };
    } finally {
      if (admitted && !launched) admission.release(token);
    }
  }
  async function startRun({ previewToken } = {}) {
    if (starts.has(previewToken)) return starts.get(previewToken);
    const promise = launch(previewToken);
    boundedSet(starts, previewToken, promise);
    try { return await promise; }
    catch (error) { starts.delete(previewToken); throw error; }
  }

  async function load(id) {
    const saved = await receipt(id);
    let current = null;
    try { current = await readAuditRecord(store, id); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const work = active.get(id) ?? finished.get(id);
    return { saved, current, work };
  }
  async function run({ id }) {
    const { saved, current, work } = await load(id);
    const live = work && !work.done;
    const state = current?.state, report = current?.report ?? work?.result;
    const spec = current?.record.spec ?? work?.spec;
    const runRecords = await Promise.all((state?.runs ?? []).map(reference => readAuditRecord(store, reference.id)));
    const checksFailed = (report?.runs ?? []).some(item => (item.outcome?.checks ?? item.checks ?? []).some(check => check.status === 'failed'));
    const tasksCompleted = report?.runs?.length === saved.profiles.length && report.runs.every(item =>
      (item.task?.nativeTurnStatus ?? item.outcome?.task?.nativeTurnStatus ?? item.outcome?.nativeTurnStatus) === 'completed'
      && (item.task?.status ?? item.outcome?.task?.status) !== 'failed');
    let status = live ? 'running' : !current ? 'failed' : !current.finalized ? 'interrupted'
      : report.status === 'timeout' ? 'time-limit' : report.status === 'cancelled' ? saved.stoppedAt ? 'interrupted' : 'cancelled'
        : report.status === 'interrupted' ? 'interrupted' : report.status === 'complete' ? 'finished'
          : checksFailed ? 'check-failed' : report.status === 'partial' && tasksCompleted && !report.failures?.length ? 'finished-partial' : 'failed';
    let recovery = null;
    if (!live && current && !current.finalized) {
      const plan = await recoverAuditExperiment(store, id, { ...recoveryContext, apply: false });
      if (plan.status === 'blocked') status = 'cannot-tidy';
      else {
        const fingerprint = JSON.stringify(plan.actions);
        const previous = recoveryPlans.get(id);
        const previewToken = previous?.fingerprint === fingerprint ? previous.previewToken : randomUUID();
        boundedSet(recoveryPlans, id, { fingerprint, previewToken });
        recovery = { previewToken, facts: plan.actions.map(action => `Run ${action.runId}: ${action.status}${action.releasesOwnedReservation ? '; release its owned reservation' : ''}${action.reason ? `; ${action.reason}` : ''}. No task will resume.`) };
      }
    }
    const stateText = { running: 'Running', finished: 'Finished', 'finished-partial': 'Tasks completed · evidence partial', 'check-failed': 'A check failed', cancelled: 'Cancelled', 'time-limit': 'Time limit reached', interrupted: 'Interrupted', 'cannot-tidy': 'Cannot tidy up yet', failed: 'Could not finish' }[status];
    const started = Date.parse(current?.record.createdAt ?? saved.createdAt), ended = Date.parse(report?.execution?.completedAt ?? '') || Date.now();
    const elapsedMs = Math.max(0, ended - started), limit = spec?.limits.experimentMs;
    const columns = saved.profiles.map((profile, index) => {
      const record = runRecords.find(item => (saved.sideIds ? item.record.profile.sideId === saved.sideIds[index] : item.record.profile.profileName === profile));
      const phase = record?.state.phase ?? 'waiting';
      const outcome = record?.report ?? report?.runs?.find(item => item.id === record?.id) ?? {};
      const task = outcome.outcome?.task ?? record?.state.outcome?.task;
      const nativeStatus = task?.nativeTurnStatus ?? outcome.outcome?.nativeTurnStatus
        ?? record?.captureCheckpoint?.run?.outcome?.nativeTurnStatus;
      const setup = outcome.setup ?? [], checks = outcome.outcome?.checks ?? outcome.checks ?? record?.state.outcome?.checks ?? [];
      const captureErrors = [
        ...(Array.isArray(outcome.capture?.errors) ? outcome.capture.errors : []),
        ...(Array.isArray(record?.captureCheckpoint?.capture?.errors) ? record.captureCheckpoint.capture.errors : []),
      ];
      const hasNativeActivity = (outcome.turns?.length ?? record?.captureCheckpoint?.run?.turns?.length ?? 0) > 0
        || ['completed', 'failed'].includes(nativeStatus) || checks.length > 0;
      const startupSandboxUnavailable = !hasNativeActivity && captureErrors.some(error => error?.code === 'startup-command-sandbox-unavailable');
      const started = phase !== 'not-started' && Boolean(outcome.sourceWorkspace?.directory || record?.state.workspace?.finalFingerprint
        || (['setup', 'task', 'capture', 'checks', 'complete'].includes(phase) && record?.state.workspace?.directory));
      // Process elapsed time is not evidence that a native model turn began or completed.
      const taskCompleted = nativeStatus === 'completed';
      const neverStarted = !record || phase === 'not-started';
      const phaseAt = /workspace/.test(phase) ? 0 : phase === 'setup' ? 1 : ['task', 'capture'].includes(phase) ? 2
        : phase === 'checks' ? 3 : phase === 'complete' ? 4 : -1;
      const phaseState = (position, done) => done ? 'done' : live && phaseAt === position ? 'active'
        : record?.finalized ? phase === 'not-started' ? 'skipped' : 'waiting' : 'waiting';
      const steps = [
        { text: 'Prepared copy', state: phaseState(0, started) },
        { text: spec?.setup?.length ? 'Setup commands' : 'No setup commands selected', state: !spec?.setup?.length ? 'skipped'
          : setup.some(item => item.status === 'failed') ? 'failed' : phaseState(1, phaseAt > 1 || (setup.length === spec.setup.length && setup.every(item => item.status === 'passed'))) },
        { text: neverStarted ? 'Model task not started' : startupSandboxUnavailable ? 'Model task did not start' : !live && !taskCompleted ? 'Model task stopped; completion not recorded' : 'Model task',
          state: neverStarted ? 'skipped' : startupSandboxUnavailable || nativeStatus === 'failed' ? 'failed' : phaseState(2, taskCompleted) },
        { text: !spec?.checks?.length ? 'No verification checks selected' : startupSandboxUnavailable ? 'Verification checks skipped' : 'Verification checks', state: startupSandboxUnavailable || !spec?.checks?.length ? 'skipped'
          : checks.some(item => item.status === 'failed') ? 'failed' : phaseState(3, checks.length === spec.checks.length && checks.every(item => item.status === 'passed')) },
        { text: 'Evidence saved', state: record?.finalized ? 'done' : phaseState(4, false) },
      ];
      const side = index ? 'b' : 'a';
      const waitingForUser = live && [...work.pendingRequests.values()].some(request => request.side === side);
      return { side, profile, state: waitingForUser ? 'Waiting for your response' : record?.state.status ?? 'Not started',
        failure: startupSandboxUnavailable ? 'The native command sandbox could not be verified, so the model task did not start.'
          : captureErrors.some(error => error?.code === 'requested-execution-unconfirmed') ? 'Codex did not confirm the requested model or reasoning effort. The model turn did not start.'
            : captureErrors.some(error => error?.code === 'native-request-failed') ? 'The native approval or input request could not be handled.' : null,
        steps };
    });
    const counts = runRecords.reduce((total, record) => total + (record.captureCheckpoint?.run?.events?.length ?? record.report?.events?.length ?? 0), 0);
    return { id, task: current?.record.task ?? work?.task ?? 'Task comparison',
      meta: `${saved.profiles.join(' then ')} · commit ${current?.record.baseline?.repository?.commit ?? work?.result?.baseline?.commit ?? 'recorded in the reviewed preview'} · ${id}`,
      state: status, stateText, headline: live ? work.controller.signal.aborted ? 'Cancelling the owned run and preserving its evidence…' : 'Reading the recorded progress of the two profiles'
        : work?.error ?? saved.startFailure ?? (status === 'cannot-tidy' ? 'A coordinator or owned process is still running or uncertain. Existing resources are preserved.' : stateText),
      elapsed: `${Math.floor(elapsedMs / 1000)} s elapsed · overall limit ${minutes(limit)}`, timeUsed: Number.isFinite(limit) && limit > 0 ? Math.min(1, elapsedMs / limit) : null, columns,
      sofar: `${counts} recorded events retained so far. Messages and command output are not shown here.${status === 'finished-partial' ? ' Some evidence could not be captured; see the report’s limits.' : ''}`,
      pendingRequests: live ? [...work.pendingRequests.values()].map(({ legId, side, requestId, request, item }) =>
        ({ legId, side, requestId, method: request.method, params: request.params, item })) : [],
      reportHref: !live && current && (current.finalized || runRecords.length) ? `/reports/e.${id}` : null, recovery, simulated: false };
  }
  async function respondRun({ id, requestId, response }) {
    checkedId(id);
    const work = active.get(id), request = work?.pendingRequests.get(requestId);
    if (!request || request.signal.aborted || work.controller.signal.aborted)
      throw new UiError(409, 'This comparison request is no longer waiting for an answer.', 'stale-run-request');
    try { validateNativeResponse(request.request, response); }
    catch (error) { throw new UiError(400, errorText(error), 'invalid-run-request'); }
    work.pendingRequests.delete(requestId);
    request.resolve(response);
    return run({ id });
  }
  async function cancelRun({ id }) {
    await receipt(id);
    const work = active.get(id);
    if (!work || work.done) return run({ id });
    work.controller.abort('user-cancelled');
    await work.promise;
    return run({ id });
  }
  async function recoverRun({ id, previewToken }) {
    await receipt(id);
    const plan = recoveryPlans.get(id);
    if (!plan || previewToken !== plan.previewToken) throw new UiError(409, 'Read the recovery preview again before tidying up.', 'preview-stale');
    if (active.get(id) && !active.get(id).done) throw new UiError(409, 'This run is still active. Cancel it first.', 'run-active');
    const fresh = await recoverAuditExperiment(store, id, { ...recoveryContext, apply: false });
    if (fresh.status === 'blocked' || JSON.stringify(fresh.actions) !== plan.fingerprint) throw new UiError(409, 'The recovery conditions changed. Check the run again; nothing was changed.', 'preview-stale');
    await recoverAuditExperiment(store, id, { ...recoveryContext, apply: true });
    recoveryPlans.delete(id);
    return run({ id });
  }
  async function comparison(id) {
    const { current, saved } = await load(id);
    if (!current) throw new UiError(404, 'No experiment evidence was created for this attempt.', 'report-missing');
    const evidence = await showAuditRecord(store, id, { includeReplay: true });
    const runs = saved.profiles.map((name, index) => evidence.runs.find(item => (saved.sideIds ? item.profile?.sideId === saved.sideIds[index] : (item.profile?.profileName ?? item.profile?.name) === name))
      ?? { schemaVersion: 1, kind: 'audit-run', id: `not-started-${index}`, profile: { profileName: name }, status: 'not-started',
        agents: [], events: [], turns: [], skills: [], metrics: {}, outcome: { status: 'unverified', checks: [] }, coverage: { execution: 'unavailable' } });
    const spec = { ...current.record.spec, task: current.record.task };
    const withConditions = runs.map((run, index) => run.comparisonConditions ? run : { ...run,
      comparisonConditions: buildAuditComparisonConditions({ spec, baseline: current.record.baseline?.repository,
        profile: spec.profiles[index], profileOrder: saved.profiles }) });
    return compareAuditRuns(withConditions[0], withConditions[1]);
  }
  function activeJobs() {
    return [...active.values()].map(work => ({ id: work.id, kind: 'comparison', task: work.task, profiles: work.profiles, href: `/runs/${work.id}` }));
  }
  const activeRun = () => activeJobs()[0] ?? null;
  async function recent() {
    return (await receiptList()).slice(0, 5).map(row => ({ kind: 'task', title: 'Task comparison', meta: `started ${new Date(row.createdAt).toLocaleString('en-GB')}`, href: `/runs/${row.id}` }));
  }
  async function close() {
    closing = true;
    await Promise.allSettled([...starts.values()]);
    const working = [...active.values()].filter(entry => !entry.done);
    for (const work of working) {
      const saved = await receipt(work.id);
      await record(join(root, `${work.id}.json`), { ...saved, stoppedAt: new Date().toISOString() });
      work.controller.abort('server-stopped');
    }
    await Promise.allSettled(working.map(work => work.promise));
  }
  return { runOptions, runPreview, startRun, run, respondRun, cancelRun, recoverRun, comparison, activeJobs, activeRun, recent, close };
}
