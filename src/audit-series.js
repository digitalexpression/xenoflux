// Frozen repeated experiments. Resume advances unused slots; it never retries a task.
import { createHash, randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { validateAuditSpec, readAuditInput } from './audit-spec.js';
import { previewAuditExperiment, runAuditExperiment } from './audit-runner.js';
import { createAuditSeries, createAuditEvaluation, readAuditRecord, writeAuditState, finalizeAuditRecord } from './audit-experiment-store.js';
import { resolveAuditExecutionProfile, snapshotAuditProfileSettings, auditSettingsIdentity } from './audit-profile.js';
import { getAuditProcessIdentity, observeAuditProcess } from './audit-process.js';
import { acquire, release, privateDirectory, readJSON } from './metadata.js';
import { auditQualityFingerprint, validateAuditReview } from './audit-quality.js';
import { compactAuditTrial, summarizeAuditSeries } from './audit-statistics.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const profileKeys = ['profileId', 'profileName', 'home', 'userHome', 'nativeRoot', 'environmentId',
  'executable', 'executableIdentity', 'version', 'bindingRepository'];
const identityOf = profile => Object.fromEntries(profileKeys.map(key => [key, profile[key] ?? null]));
const stableError = code => Object.assign(new Error(code.replaceAll('-', ' ')), { code });
const environment = epoch => ({ platform: process.platform, architecture: process.arch, nodeVersion: process.version,
  settings: 'tracked-file-metadata-unchanged', cache: 'uncontrolled-not-reset', integrations: 'not-fingerprinted', epoch });
const baseSpec = spec => {
  const { quality, trials, variables, ...base } = spec;
  return base;
};
// Leave room in the private 16 MiB record for manifests, evaluated criteria,
// summaries and statistics. Every planned slot retains its run accounting.
const trialEvidenceBudget = record => Math.floor(6 * 1024 * 1024 / Math.max(1, record.plan.length));

function trialPlan(spec) {
  const budgetMs = Math.min(spec.limits.experimentMs, Math.floor(spec.trials.budgetMs / spec.trials.count));
  return Array.from({ length: spec.trials.count }, (_, trialIndex) => {
    const names = spec.profiles.map(p => p.name), offset = spec.trials.order === 'balanced' ? trialIndex % names.length : 0;
    return { index: trialIndex + 1, trialIndex, experimentId: randomUUID(),
      profileOrder: [...names.slice(offset), ...names.slice(0, offset)], budgetMs };
  });
}

function recipeFor(spec, baseline, profiles, plan) {
  return { fingerprint: digest({ spec: { ...spec, revision: baseline.commit },
    baseline: { repository: baseline.repository, commit: baseline.commit, tree: baseline.tree }, profiles, plan }), qualityFingerprint: auditQualityFingerprint(spec.quality, spec.checks),
    criteria: spec.quality, meta: { adapterVersion: 1, taskFingerprint: digest(spec.task),
      checkRecipes: spec.checks.map(check => ({ name: check.name, fingerprint: digest(check) })),
      variables: spec.variables, order: spec.trials.order, trialCount: spec.trials.count,
      taskBudgetMs: spec.trials.budgetMs, checkSemantics: 'Command exits 0 for a declared pass; this is evidence for its frozen named criterion.',
      cachePolicy: 'No cache reset; source settings metadata and observed model/tool/skill differences are reported, not causal controls.' } };
}

/** Read-only scheduling preview; no manifest, lease, workspace or model task. */
export async function previewAuditSeries(store, input, context = {}) {
  const spec = validateAuditSpec(input);
  if (!spec.trials) throw stableError('series-definition-required');
  const preview = await previewAuditExperiment(store, baseSpec(spec), context);
  return { ...preview, kind: 'audit-series-preview', quality: spec.quality,
    qualityFingerprint: auditQualityFingerprint(spec.quality, spec.checks),
    schedule: trialPlan(spec).map(({ experimentId, ...slot }) => slot),
    plannedRuns: spec.trials.count * spec.profiles.length,
    budget: { totalTaskBudgetMs: spec.trials.budgetMs, allocation: 'equal fixed experiment deadline per trial, including setup and checks; preflight/filesystem/shutdown can add overhead' } };
}

async function freezeProfiles(store, spec, context) {
  const profiles = [];
  for (const selection of spec.profiles) {
    const profile = await (context.resolveProfile ?? resolveAuditExecutionProfile)(store, selection, { repository: spec.repository });
    const snapshot = await (context.snapshotSettings ?? snapshotAuditProfileSettings)(profile);
    const settingsIdentity = (context.settingsIdentity ?? auditSettingsIdentity)(snapshot);
    if (!settingsIdentity) throw stableError('series-settings-unavailable');
    // The resolver already allowlists path variables; no authentication value is copied.
    profiles.push({ ...identityOf(profile), env: { ...profile.env }, settingsIdentity });
  }
  return profiles;
}

function validateFrozenSeries(record) {
  validateAuditSpec(record.spec);
  if (!equal(recipeFor(record.spec, record.baseline, record.profiles, record.plan), record.recipe))
    throw stableError('series-frozen-definition-changed');
  const expected = trialPlan(record.spec).map(({ experimentId, ...slot }) => slot);
  const observed = record.plan.map(({ experimentId, ...slot }) => slot);
  if (!equal(expected, observed) || new Set(record.plan.map(slot => slot.experimentId)).size !== record.plan.length)
    throw stableError('series-frozen-plan-changed');
}

async function observeCoordinator(owner, context) {
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid)) return { status: 'unknown' };
  if (owner.processIdentity?.started) return (context.observeProcess ?? observeAuditProcess)(owner.processIdentity);
  try { process.kill(owner.pid, 0); return { status: 'unknown' }; }
  catch (error) { return { status: error.code === 'ESRCH' ? 'stopped' : 'unknown' }; }
}

async function staleLease(path, expected) {
  // Keep one nonempty tombstone for each retired generation. Two resumptions
  // that observed the same stopped owner must target the same directory: the
  // second rename then cannot replace a newly acquired live coordinator.
  const retired = `${path}.retired-${expected.runId}`;
  await rename(path, retired);
  if (!equal(await readJSON(join(retired, 'owner.json')), expected)) {
    throw stableError('series-coordinator-changed');
  }
}

async function claimSeries(store, current, { fresh = false, ...context } = {}) {
  const path = join(current.directory, '.coordinator-lock');
  let previous = null;
  try { await privateDirectory(path); previous = await readJSON(join(path, 'owner.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw stableError('series-coordinator-unavailable'); }
  if (previous) {
    if (previous.kind !== 'audit-series' || previous.seriesId !== current.id || previous.storePath !== store.directory
      || !UUID.test(previous.runId ?? '') || !['stopped', 'different'].includes((await observeCoordinator(previous, context)).status))
      throw stableError('series-coordinator-live-or-unknown');
    await staleLease(path, previous);
  } else if (!fresh && current.state.coordinatorReleased !== true && !['stopped', 'different'].includes((await observeCoordinator(current.state.coordinator, context)).status)) {
    throw stableError('series-coordinator-live-or-unknown');
  }
  const owner = { kind: 'audit-series', seriesId: current.id, storePath: store.directory, runId: randomUUID(),
    pid: process.pid, host: hostname(), processIdentity: await getAuditProcessIdentity() };
  await acquire(path, owner, true);
  return { path, owner };
}

function publicProfiles(profiles) {
  return profiles.map(profile => ({ profileId: profile.profileId, profileName: profile.profileName,
    executable: profile.executable, version: profile.version }));
}

async function childMembers(store, child) {
  const members = [];
  for (const reference of child.state.runs ?? []) {
    const member = await readAuditRecord(store, reference.id);
    if (member.record.kind !== 'audit-experiment-run' || member.record.experimentId !== child.id)
      throw stableError('series-child-member-identity-changed');
    members.push(member);
  }
  return members;
}

async function childEvidence(store, child) {
  const members = await childMembers(store, child), runs = [];
  const show = (await import('./audit-experiment.js')).showAuditRecord;
  for (const member of members) runs.push(member.report ?? await show(store, member.id));
  return { ...(child.report ?? {}), kind: 'audit-experiment-report',
    status: child.report?.status ?? 'interrupted', runs };
}

async function childNeedsRecovery(store, child) {
  const members = await childMembers(store, child);
  return !child.finalized || members.some(member => !member.recovery &&
    (!member.finalized || member.state.reservation || member.state.process?.pid || member.state.workspace?.active));
}

async function collectTrials(store, current) {
  const trials = [];
  for (const slot of current.record.plan) {
    const saved = current.state.trials.find(row => row.experimentId === slot.experimentId);
    let child;
    try { child = await readAuditRecord(store, slot.experimentId); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (child) {
      if (child.record.series?.id !== current.id || child.record.series.trialIndex !== slot.trialIndex)
        throw stableError('series-trial-identity-changed');
      const report = await childEvidence(store, child);
      trials.push(compactAuditTrial(report, { index: slot.index, experimentId: slot.experimentId,
        status: child.report ? report.status : 'interrupted', environment: saved?.environment,
        maxBytes: trialEvidenceBudget(current.record) }));
    } else if (saved?.summary) trials.push(saved.summary);
    else trials.push({ index: slot.index, experimentId: slot.experimentId, status: saved?.status ?? 'not-started', runs: [] });
  }
  return trials;
}

/** Deterministic regeneration reads saved observations and never launches a client. */
export async function buildAuditSeriesReport(store, id, { reviews = [] } = {}) {
  const current = await readAuditRecord(store, id);
  if (current.record.kind !== 'audit-series') throw stableError('series-record-required');
  validateFrozenSeries(current.record);
  const trials = await collectTrials(store, current);
  const report = summarizeAuditSeries({ id, baseline: current.record.baseline,
    profiles: publicProfiles(current.record.profiles), plan: current.record.plan,
    spec: current.record.spec, recipe: current.record.recipe, trials, reviews });
  if (!current.finalized && ['blocked', 'interrupted', 'running', 'prepared'].includes(current.state.status)) {
    report.execution = { status: current.state.status, resumesTasks: false };
    if (current.state.status === 'blocked') { report.status = 'blocked'; report.exitCode = 2; }
  }
  report.warnings.push(...(current.state.warnings ?? []),
    'Results are descriptive. Profile/account/model/tool/cache differences can confound comparisons; no causal winner is established.');
  return report;
}

async function guardedProfiles(store, current, context, lease) {
  validateFrozenSeries(current.record);
  const resolved = new Map();
  for (const selection of current.record.spec.profiles) {
    if (!equal(await readJSON(join(lease.path, 'owner.json')), lease.owner)) throw stableError('series-coordinator-changed');
    const profile = await (context.resolveProfile ?? resolveAuditExecutionProfile)(store, selection, { repository: current.record.spec.repository });
    const frozen = current.record.profiles.find(item => item.profileName === selection.name);
    if (!frozen || !equal(identityOf(profile), identityOf(frozen))) throw stableError('series-profile-identity-changed');
    const token = (context.settingsIdentity ?? auditSettingsIdentity)(await (context.snapshotSettings ?? snapshotAuditProfileSettings)(profile));
    if (!token || !equal(token, frozen.settingsIdentity)) throw stableError('series-settings-drift');
    resolved.set(selection.name.toLowerCase(), { ...profile, env: { ...frozen.env } });
  }
  return resolved;
}

async function executeSeries(store, initial, { fresh = false, ...context } = {}) {
  let current = initial, lease;
  try { lease = await claimSeries(store, current, { ...context, fresh }); }
  catch (error) {
    const report = await buildAuditSeriesReport(store, current.id);
    return { ...report, status: 'blocked', failures: [{ code: error.code ?? 'series-coordinator-unavailable' }], exitCode: 2 };
  }
  const epoch = randomUUID(), warnings = [...(current.state.warnings ?? [])];
  let interrupted = false, blocked = false;
  const setState = async patch => {
    await writeAuditState(store, current.id, patch); current = await readAuditRecord(store, current.id);
  };
  const setTrial = async (slot, patch) => setState({ trials: current.state.trials.map(row => row.experimentId === slot.experimentId ? { ...row, ...patch } : row) });
  try {
    await setState({ status: 'running', coordinator: lease.owner, coordinatorReleased: false, warnings });
    for (const slot of current.record.plan) {
      const saved = current.state.trials.find(row => row.experimentId === slot.experimentId);
      if (saved.status !== 'not-started') {
        let child;
        try { child = await readAuditRecord(store, slot.experimentId); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (child && (child.record.series?.id !== current.id || child.record.series.trialIndex !== slot.trialIndex))
          throw stableError('series-trial-identity-changed');
        const needsRecovery = child && await childNeedsRecovery(store, child);
        if (needsRecovery) {
          const recovered = await (await import('./audit-experiment.js')).recoverAuditExperiment(store, child.id, { apply: true, ...context });
          if (recovered.status === 'blocked') throw stableError('series-trial-recovery-blocked');
          child = await readAuditRecord(store, slot.experimentId);
        }
        if (!saved.summary || needsRecovery) {
          const summary = child ? compactAuditTrial(await childEvidence(store, child), { index: slot.index, experimentId: slot.experimentId,
            status: child.report?.status ?? 'interrupted', environment: saved.environment,
            maxBytes: trialEvidenceBudget(current.record) })
            : { index: slot.index, experimentId: slot.experimentId, status: 'interrupted', runs: [] };
          await setTrial(slot, { status: child ? 'recorded' : 'interrupted', summary });
        }
        continue; // A started slot is never executed again, even if it left no task evidence.
      }
      if (context.signal?.aborted) { interrupted = true; break; }
      await guardedProfiles(store, current, context, lease);
      const spec = current.record.spec, trial = baseSpec(spec);
      trial.revision = current.record.baseline.commit;
      trial.profiles = slot.profileOrder.map(name => spec.profiles.find(item => item.name === name));
      trial.limits = { ...trial.limits, runMs: Math.min(trial.limits.runMs, slot.budgetMs), experimentMs: slot.budgetMs };
      const envObservation = environment(epoch);
      await setTrial(slot, { status: 'starting', environment: envObservation });
      await context.onTrialPrepared?.({ seriesId: current.id, slot });
      const result = await (context.runTrial ?? runAuditExperiment)(store, trial, { ...context,
        experimentId: slot.experimentId, series: { id: current.id, trialIndex: slot.trialIndex },
        resolveProfile: async (selectedStore, selection) => {
          const profiles = await guardedProfiles(selectedStore, current, context, lease);
          const profile = profiles.get(selection.name.toLowerCase());
          if (!profile) throw stableError('series-profile-identity-changed');
          return profile;
        },
        checkRequired: name => spec.quality.checks.find(check => check.name === name)?.required ?? true });
      await context.onTrialComplete?.({ seriesId: current.id, slot, report: result });
      const summary = compactAuditTrial(result.kind === 'audit-experiment-report' ? result : null,
        { index: slot.index, experimentId: slot.experimentId, status: result.status, environment: envObservation,
          maxBytes: trialEvidenceBudget(current.record) });
      if (result.kind !== 'audit-experiment-report') summary.failures = (result.failures ?? [])
        .slice(0, 40).map(failure => ({ code: failure.code ?? 'trial-preflight-blocked' }));
      await setTrial(slot, { status: 'recorded', summary });
      let child;
      try { child = await readAuditRecord(store, slot.experimentId); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (child && await childNeedsRecovery(store, child)) throw stableError('series-trial-recovery-required');
      if (result.status === 'blocked' || result.status === 'recovery-required' || (result.failures ?? []).some(failure =>
        ['profile-settings-changed', 'profile-clients-changed', 'profile-access-unavailable', 'profile-access-blocked',
          'reservation-release-failed', 'run-report-finalize-failed'].includes(failure.code))) {
        throw stableError('series-preservation-or-recovery-blocked');
      }
      if (context.signal?.aborted) { interrupted = true; break; }
    }
  } catch (error) {
    blocked = true; warnings.push({ code: error.code ?? 'series-operation-failed' });
  } finally {
    await setState({ status: blocked ? 'blocked' : interrupted ? 'interrupted' : 'finished', warnings }).catch(() => {});
    try { await release(lease.path, lease.owner); await setState({ coordinatorReleased: true }); }
    catch { blocked = true; warnings.push({ code: 'series-coordinator-release-failed' }); }
  }
  const report = await buildAuditSeriesReport(store, current.id);
  if (blocked || interrupted) {
    report.status = blocked ? 'blocked' : 'interrupted'; report.exitCode = interrupted ? 130 : 2;
    report.warnings = [...report.warnings, ...warnings]; return report;
  }
  await finalizeAuditRecord(store, current.id, report);
  return report;
}

export async function runAuditSeries(store, input, context = {}) {
  const spec = validateAuditSpec(input), preview = await previewAuditSeries(store, spec, context);
  if (preview.status !== 'ready') return preview;
  const pinned = { ...spec, repository: preview.baseline.repository, revision: preview.baseline.commit };
  const profiles = await freezeProfiles(store, pinned, context);
  pinned.profiles = pinned.profiles.map(selection => {
    const profile = profiles.find(item => item.profileName.toLowerCase() === selection.name.toLowerCase());
    return { ...selection, name: profile.profileName, executable: profile.executable, version: profile.version };
  });
  const plan = trialPlan(pinned);
  const current = await createAuditSeries(store, { spec: pinned, baseline: preview.baseline,
    profiles, plan, recipe: recipeFor(pinned, preview.baseline, profiles, plan) });
  await context.onSeriesCreated?.(current);
  return executeSeries(store, current, { ...context, fresh: true });
}

export async function resumeAuditSeries(store, id, context = {}) {
  const current = await readAuditRecord(store, id);
  if (current.record.kind !== 'audit-series' || current.finalized) throw stableError('unfinished-series-required');
  // No caller-supplied task, criteria, profile selection or ordering may replace the manifest.
  validateFrozenSeries(current.record);
  return executeSeries(store, current, context);
}

/** New immutable report revision; this never executes checks or starts model/judge tasks. */
export async function evaluateAuditSeries(store, id, reviewPath) {
  const current = await readAuditRecord(store, id);
  if (current.record.kind !== 'audit-series' || !current.finalized) throw stableError('finalized-series-required');
  validateFrozenSeries(current.record);
  const input = reviewPath ? await readAuditInput(reviewPath) : { schemaVersion: 1, reviews: [] };
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.reviews) || input.reviews.length > 160
    || Object.keys(input).some(key => !['schemaVersion', 'reviews'].includes(key))) throw stableError('invalid-review-file');
  const trials = await collectTrials(store, current), runs = trials.flatMap(trial => trial.runs ?? []);
  const seen = new Set(), reviews = input.reviews.map(review => {
    if (seen.has(review.runId)) throw stableError('duplicate-run-review'); seen.add(review.runId);
    const run = runs.find(item => item.id === review.runId);
    if (!run) throw stableError('review-run-not-in-series');
    return validateAuditReview(review, { run, quality: current.record.spec.quality, checks: current.record.spec.checks });
  });
  const summary = await buildAuditSeriesReport(store, id, { reviews });
  const source = { id, fingerprint: digest(current.report), recipeFingerprint: current.record.recipe.fingerprint };
  return (await createAuditEvaluation(store, { source, reviews, report: {
    schemaVersion: 1, kind: 'audit-evaluation-report', source, series: summary,
    reviewMethod: 'Human rubric ratings; command checks and review scores are separate. No model judge was run.',
    status: summary.status, exitCode: summary.exitCode } })).report;
}

/** Existing recovery/cleanup commands also accept a series, without advancing its schedule. */
export async function auditSeriesLifecycle(store, id, operation, { apply = false, ...context } = {}) {
  let current = await readAuditRecord(store, id), lease = null;
  if (current.record.kind !== 'audit-series' || !['recover', 'clean'].includes(operation)) throw stableError('series-record-required');
  if (apply && operation === 'recover' && !current.finalized) {
    try { lease = await claimSeries(store, current, context); }
    catch (error) { return { schemaVersion: 1, kind: 'audit-series-recovery', id, status: 'blocked',
      actions: [], warnings: [error.code ?? 'series-coordinator-unavailable'], exitCode: 2 }; }
    await writeAuditState(store, id, { coordinator: lease.owner, coordinatorReleased: false });
  }
  const actions = []; let blocked = false;
  try {
    for (const slot of current.record.plan) {
      let child;
      try { child = await readAuditRecord(store, slot.experimentId); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!child) { actions.push({ experimentId: slot.experimentId, status: 'no-started-experiment' }); continue; }
      if (child.record.series?.id !== id || child.record.series.trialIndex !== slot.trialIndex) throw stableError('series-trial-identity-changed');
      const lifecycle = await import('./audit-experiment.js');
      const result = operation === 'recover' ? await lifecycle.recoverAuditExperiment(store, child.id, { apply, ...context })
        : await lifecycle.cleanAuditExperiment(store, child.id, { apply });
      actions.push({ experimentId: child.id, status: result.status, actions: result.actions });
      if (result.status === 'blocked') blocked = true;
    }
    if (lease) await writeAuditState(store, id, { status: blocked ? 'blocked' : 'interrupted' });
  } finally {
    if (lease) { await release(lease.path, lease.owner); await writeAuditState(store, id, { coordinatorReleased: true }); }
  }
  return { schemaVersion: 1, kind: operation === 'recover' ? 'audit-series-recovery' : 'audit-series-cleanup', id,
    status: blocked ? 'blocked' : apply ? operation === 'recover' ? 'recovered' : 'cleaned' : 'preview', actions,
    warnings: ['No trial, model task, check or judge was started. Pending slots are unchanged.'], exitCode: blocked || operation === 'recover' ? 2 : 0 };
}
