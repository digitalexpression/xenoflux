// Command integration and restart reconciliation for controlled experiments.
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { readAuditSpec, readAuditInput } from './audit-spec.js';
import { previewAuditExperiment, runAuditExperiment } from './audit-runner.js';
import { readAuditRecord, writeAuditState, finalizeAuditRecord, inspectAuditReservation,
  releaseAuditProfileReservation, recordAuditCleanup, recordAuditRecovery } from './audit-experiment-store.js';
import { cleanupAuditWorkspace, snapshotAuditWorkspace, setAuditWorkspaceActive } from './audit-workspace.js';
import { observeAuditProcess } from './audit-process.js';
import { resolveAuditProfile } from './audit-discovery.js';
import { auditNativeSession } from './audit-session.js';
import { compareAuditRuns, auditExitCode } from './audit-report.js';
import { readAuditSkillTelemetry } from './audit-telemetry.js';
import { mergeAuditSkillTelemetry } from './audit-skill-usage.js';
import { projectRetainedAuditRun } from './audit-replay.js';

export const isAuditRecordId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const profileSummary = profile => Object.fromEntries(['profileId', 'profileName', 'home', 'userHome', 'environmentId', 'executable', 'version']
  .filter(key => profile?.[key] !== undefined).map(key => [key, profile[key]]));

function pendingRun(current) {
  const { state, record } = current;
  return { schemaVersion: 1, kind: 'audit-run', id: current.id, experimentId: record.experimentId,
    profile: profileSummary(record.profile), status: 'partial', reason: 'This run has not been finalized.',
    execution: { status: state.status, phase: state.phase, process: state.process?.status ?? null },
    agents: [], events: [], turns: [], skills: [], usage: { totals: null }, metrics: {}, artifacts: [],
    outcome: { status: 'unverified', checks: [] }, coverage: { execution: 'partial', skills: 'unavailable' },
    warnings: ['Inspect or recover the saved experiment before starting a new attempt.'] };
}

export async function showAuditRecord(store, id) {
  const current = await readAuditRecord(store, id);
  if (current.record.kind === 'audit-series' && current.record.spec?.kind === 'audit-cohort') {
    if (!current.report) throw new Error('Selected-session cohort has no finalized report');
    return current.report;
  }
  if (current.record.kind === 'audit-series') return (await import('./audit-series.js')).buildAuditSeriesReport(store, id);
  if (current.record.kind === 'audit-experiment-run' && current.report) return projectRetainedAuditRun(store, current);
  if (current.record.kind === 'audit-evaluation' && current.report) return current.report;
  if (current.record.kind === 'audit-experiment-run') return pendingRun(current);
  const runs = [];
  for (const reference of current.state.runs ?? []) {
    try { const run = await readAuditRecord(store, reference.id); runs.push(run.report
      ? await projectRetainedAuditRun(store, run) : pendingRun(run)); }
    catch { runs.push({ schemaVersion: 1, kind: 'audit-run', id: reference.id, status: 'unavailable',
      profile: {}, agents: [], events: [], turns: [], skills: [], metrics: {}, coverage: { source: 'unavailable' } }); }
  }
  if (current.report) return { ...current.report, runs,
    comparisons: runs.slice(1).map(run => compareAuditRuns(runs[0], run)) };
  return { schemaVersion: 1, kind: 'audit-experiment-report', id, status: 'partial',
    baseline: current.record.baseline, runs, comparisons: [], execution: { status: current.state.status },
    coverage: { execution: 'partial' }, warnings: ['The saved experiment is not finalized; no native task was resumed.'], exitCode: 2 };
}

async function members(store, current) {
  if (current.record.kind === 'audit-experiment-run') return [current];
  return Promise.all((current.state.runs ?? []).map(reference => readAuditRecord(store, reference.id)));
}

async function observeStopped(value, observe) {
  if (value?.shutdown?.groupTerminated === true && ['exited', 'failed', 'timeout', 'cancelled', 'output-limit', 'spawn-failed'].includes(value.status))
    return { status: 'stopped', evidence: 'persisted-owned-group-shutdown' };
  const identity = value?.processIdentity ?? value;
  if (!identity?.pid) return { status: value ? 'unknown' : 'stopped' };
  if (identity.host && identity.host !== hostname()) return { status: 'unknown' };
  if (identity.started) return observe(identity);
  try { process.kill(identity.pid, 0); return { status: 'unknown' }; }
  catch (error) { if (error.code !== 'ESRCH') return { status: 'unknown' }; }
  // Legacy records can lack a start identity, but a vanished leader still
  // cannot release a lease while its process group is observable.
  try { process.kill(-identity.pid, 0); return { status: 'unknown' }; }
  catch (error) { return { status: error.code === 'ESRCH' ? 'stopped' : 'unknown' }; }
}

async function recoverableProfile(store, current, context) {
  const reservation = current.state.reservation;
  if (!reservation) return null;
  const owner = reservation.owner;
  if (owner?.kind !== 'audit-experiment' || owner.runId !== current.id || owner.experimentId !== current.record.experimentId
    || owner.storePath !== store.directory || owner.host !== hostname()) throw new Error('Saved audit reservation identity is inconsistent');
  const saved = current.record.profile;
  const resolveProfile = context.resolveProfile ?? resolveAuditProfile;
  const profile = await resolveProfile(store, saved.profileId ?? saved.profileName);
  const root = profile.nativeRoot ?? profile.home;
  if (root !== reservation.root || profile.home !== owner.home || profile.profileId !== owner.profileId)
    throw new Error('The profile binding changed; preserve the saved reservation');
  const held = await inspectAuditReservation({ root, owner });
  if (held && JSON.stringify(held) !== JSON.stringify(owner)) throw new Error('A different operation owns the profile reservation');
  return { ...profile, reservationRoot: root, reservation, held };
}

/** Read-only by default; never resumes a model task or signals a stored PID. */
export async function recoverAuditExperiment(store, id, { apply = false, ...context } = {}) {
  const current = await readAuditRecord(store, id), runs = await members(store, current);
  if (current.recovery) return { ...current.recovery, kind: 'audit-experiment-recovery' };
  const parent = current.record.experimentId ? await readAuditRecord(store, current.record.experimentId) : current;
  const observe = context.observeProcess ?? observeAuditProcess;
  const actions = [], recoveredRuns = [];
  let blocked = false;
  for (const run of runs) {
    if (run.recovery) { actions.push({ runId: run.id, status: 'already-recovered' }); if (run.report) recoveredRuns.push(run.report); continue; }
    const coordinatorValue = run.state.coordinator ?? parent.state.coordinator ?? run.state.reservation?.owner;
    const coordinator = coordinatorValue ? await observeStopped(coordinatorValue, observe) : { status: 'unknown' };
    const task = await observeStopped(run.state.process, observe);
    if (!['stopped', 'different'].includes(coordinator.status) || !['stopped', 'different'].includes(task.status)) {
      blocked = true; actions.push({ runId: run.id, status: 'blocked', reason: 'The coordinator or owned process is live or its identity is uncertain.' }); continue;
    }
    let profile;
    try {
      profile = await recoverableProfile(store, run, context);
      // Audit leases are independent of Codex's native home lock. Recovery
      // observes and releases only this exact lease after its own processes stop;
      // a live desktop client may continue using the native home.
    } catch (error) { blocked = true; actions.push({ runId: run.id, status: 'blocked', reason: error.message }); continue; }
    actions.push({ runId: run.id, status: apply ? 'reconciled' : 'recoverable', releasesOwnedReservation: Boolean(profile?.held), resumesTask: false });
    if (!apply) continue;
    let report = run.report;
    if (!report) {
      let evidence;
      if (run.captureCheckpoint?.run && run.captureCheckpoint.threadId === run.captureCheckpoint.run.source?.threadId
        && run.captureCheckpoint.profileHome === (run.record.profile?.home ?? run.record.profile?.userHome)) {
        evidence = run.captureCheckpoint.run;
      } else if (run.state.nativeSessionId && run.record.profile?.profileName) {
        try { evidence = await (context.readNative ?? auditNativeSession)(store, run.record.profile.profileName, run.state.nativeSessionId); } catch {}
      }
      report = { ...(evidence ?? pendingRun(run)), id: run.id, kind: 'audit-run', schemaVersion: 1,
        experimentId: run.record.experimentId, status: 'partial',
        execution: { status: 'interrupted', recovery: 'process-stopped-no-rerun', originalPhase: run.state.phase,
          groupStopped: true, escapedDescendants: 'unverified' },
        metrics: { ...(evidence?.metrics ?? {}), ...(run.state.metrics ?? {}) },
        outcome: run.state.outcome ?? { status: 'unverified', checks: [] },
        ...(run.state.taskEnd ? { taskEnd: run.state.taskEnd } : {}),
        coverage: { ...(evidence?.coverage ?? {}), execution: 'partial', settingsPreservation: 'unavailable' },
        warnings: [...(evidence?.warnings ?? []), ...(run.captureCheckpoint ? ['Recovery used the durable in-memory capture checkpoint; it remains partial and is not a native transcript.'] : []),
          'Recovery preserved partial evidence; no task or verification command was rerun.'] };
      // The journal is a fixed child of the validated private run directory.
      // Receipt proves observed events only; recovery cannot prove delivery or
      // create lineage for threads absent from the corroborated native evidence.
      const telemetry = readAuditSkillTelemetry(join(run.directory, 'skill-telemetry.jsonl'));
      mergeAuditSkillTelemetry(report, { ...telemetry, metadata: { ...telemetry.metadata,
        delivery: 'best-effort', warnings: [...telemetry.metadata.warnings, 'skill-telemetry-recovered-partial'] } });
      const workspace = run.state.workspace;
      if (workspace?.directory && workspace.owner) {
        try {
          const outputDirectory = join(run.directory, `recovery-${randomUUID()}`); await mkdir(outputDirectory, { mode: 0o700 });
          const snapshot = await snapshotAuditWorkspace({ directory: workspace.directory, owner: workspace.owner, outputDirectory, label: 'recovered' });
          await setAuditWorkspaceActive({ directory: workspace.directory, owner: workspace.owner, active: false });
          await writeAuditState(store, run.id, { workspace: { ...workspace, active: false, finalFingerprint: snapshot.fingerprint }, status: 'interrupted' });
          report.artifacts = [...(report.artifacts ?? []), { kind: 'recovered-workspace-snapshot', ...snapshot }];
          report.warnings.push('The recovered workspace snapshot is not asserted to be the original task-end state.');
        } catch { report.warnings.push('Owned workspace snapshot or deactivation could not be verified; it was preserved.'); }
      }
      await writeAuditState(store, run.id, { status: 'interrupted', recoveredAt: new Date().toISOString() });
      report = await finalizeAuditRecord(store, run.id, report);
    }
    if (profile?.held) await releaseAuditProfileReservation({ root: profile.reservationRoot, owner: profile.reservation.owner });
    const receipt = { schemaVersion: 1, kind: 'audit-experiment-recovery', id: run.id,
      status: 'recovered', recoveredAt: new Date().toISOString(), actions: [actions.at(-1)], exitCode: 2 };
    await recordAuditRecovery(store, run.id, receipt);
    recoveredRuns.push(report);
  }
  const result = { schemaVersion: 1, kind: 'audit-experiment-recovery', id,
    status: blocked ? 'blocked' : apply ? 'recovered' : 'preview', actions, runs: recoveredRuns,
    warnings: blocked ? ['Live, foreign, changed, or uncertain resources were preserved.'] : [], exitCode: 2 };
  if (apply && !blocked && current.record.kind === 'audit-experiment') {
    if (!current.finalized) {
      const comparisons = recoveredRuns.slice(1).map(run => compareAuditRuns(recoveredRuns[0], run));
      await writeAuditState(store, current.id, { status: 'interrupted', recoveredAt: new Date().toISOString() });
      await finalizeAuditRecord(store, current.id, { schemaVersion: 1, kind: 'audit-experiment-report', id,
        status: 'interrupted', baseline: current.record.baseline, runs: recoveredRuns, comparisons,
        coverage: { execution: 'partial' }, warnings: ['Recovered after coordinator interruption without restarting any native task.'], exitCode: 2 });
    }
    await recordAuditRecovery(store, id, result);
  }
  return result;
}

/** Remove only owned inactive checkouts whose final content fingerprint matches. */
export async function cleanAuditExperiment(store, id, { apply = false } = {}) {
  const current = await readAuditRecord(store, id), runs = await members(store, current), actions = [];
  let blocked = false;
  for (const run of runs) {
    if (run.cleanup) { actions.push({ runId: run.id, status: 'already-cleaned' }); continue; }
    const workspace = run.state.workspace;
    if (run.finalized && !workspace) { actions.push({ runId: run.id, status: 'no-workspace' }); continue; }
    if (!run.finalized || workspace.active !== false || !workspace.finalFingerprint) {
      blocked = true; actions.push({ runId: run.id, status: 'blocked', reason: 'Run is active, unfinished, or has no verified final workspace fingerprint.' }); continue;
    }
    try {
      const result = await cleanupAuditWorkspace(workspace.directory, { owner: workspace.owner, expectedFingerprint: workspace.finalFingerprint, apply });
      if (result.fingerprint !== workspace.finalFingerprint) throw new Error('Workspace contents changed');
      const action = { runId: run.id, status: apply ? 'cleaned' : 'cleanable', ...result }; actions.push(action);
      if (apply) await recordAuditCleanup(store, run.id, { schemaVersion: 1, kind: 'audit-experiment-cleanup', id: run.id, status: 'cleaned', actions: [action], cleanedAt: new Date().toISOString() });
    } catch { blocked = true; actions.push({ runId: run.id, status: 'blocked', reason: 'Workspace ownership, inactivity, or contents changed; preserved.' }); }
  }
  return { schemaVersion: 1, kind: 'audit-experiment-cleanup', id, status: blocked ? 'blocked' : apply ? 'cleaned' : 'preview', actions, exitCode: blocked ? 2 : 0 };
}

export async function auditExperimentCommand(store, params, flags, context = {}) {
  const [operation, ...args] = params;
  if (operation === 'cohort') {
    if (args.length || !flags['--spec'] || Object.keys(flags).some(key => !['--spec', '--store', 'json'].includes(key)))
      throw new Error('Use audit cohort --spec COHORT.json');
    const value = await (await import('./audit-cohort.js')).createAuditCohort(store, flags['--spec'], context);
    return { value, exitCode: auditExitCode(value) };
  }
  if (operation === 'run') {
    if (args.length || !flags['--spec'] || Object.keys(flags).some(key => !['--spec', '--dry-run', '--store', 'json'].includes(key)))
      throw new Error('Use audit run --spec EXPERIMENT.json [--dry-run]');
    const spec = await readAuditSpec(flags['--spec']);
    const series = spec.trials ? await import('./audit-series.js') : null;
    const value = series ? flags['--dry-run'] ? await series.previewAuditSeries(store, spec, context) : await series.runAuditSeries(store, spec, context)
      : flags['--dry-run'] ? await previewAuditExperiment(store, spec, context) : await runAuditExperiment(store, spec, context);
    return { value, exitCode: value.exitCode ?? auditExitCode(value) };
  }
  if (operation === 'evaluate') {
    if (args.length !== 1 || Object.keys(flags).some(key => !['--store', 'json', '--spec'].includes(key)))
      throw new Error('Use audit evaluate UUID|REPORT.json [--spec REVIEWS.json]');
    // Keep the established series rubric input, while using the same immutable
    // evaluation store for all frozen evidence and attributed review modes.
    const selected = isAuditRecordId(args[0]) ? await readAuditRecord(store, args[0]) : null;
    const input = flags['--spec'] ? await readAuditInput(flags['--spec']) : null;
    const legacySeries = selected?.record.kind === 'audit-series' && selected.record.spec?.kind !== 'audit-cohort'
      && input && input.kind === undefined;
    const value = legacySeries
      ? await (await import('./audit-series.js')).evaluateAuditSeries(store, args[0], flags['--spec'])
      : await (await import('./audit-review-command.js')).evaluateAuditEvidence(store, args[0], flags['--spec']);
    return { value, exitCode: auditExitCode(value) };
  }
  if (operation === 'resume') {
    if (args.length !== 1 || !isAuditRecordId(args[0]) || Object.keys(flags).some(key =>
      !['--store', 'json'].includes(key)))
      throw new Error('Use audit resume SERIES_UUID');
    if ((await readAuditRecord(store, args[0])).record.spec?.kind === 'audit-cohort')
      throw new Error('A selected-session cohort contains captured evidence only; it has no tasks to resume');
    const series = await import('./audit-series.js');
    const value = await series.resumeAuditSeries(store, args[0], context);
    return { value, exitCode: auditExitCode(value) };
  }
  if (!['recover', 'clean'].includes(operation) || args.length !== 1 || !isAuditRecordId(args[0])
    || Object.keys(flags).some(key => !['--apply', '--store', 'json'].includes(key))) throw new Error('Use audit recover|clean UUID [--apply]');
  const selected = await readAuditRecord(store, args[0]);
  if (selected.record.spec?.kind === 'audit-cohort')
    throw new Error('A selected-session cohort owns no processes or workspaces to recover or clean');
  if (selected.record.kind === 'audit-series') {
    const value = await (await import('./audit-series.js')).auditSeriesLifecycle(store, args[0], operation, { apply: flags['--apply'] === true, ...context });
    return { value, exitCode: auditExitCode(value) };
  }
  const value = operation === 'recover' ? await recoverAuditExperiment(store, args[0], { ...context, apply: flags['--apply'] ?? false })
    : await cleanAuditExperiment(store, args[0], { apply: flags['--apply'] ?? false });
  return { value, exitCode: value.exitCode ?? auditExitCode(value) };
}
