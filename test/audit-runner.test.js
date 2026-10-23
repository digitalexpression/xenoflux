import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareAuditWorkspaceDelta, previewAuditExperiment, runAuditExperiment } from '../src/audit-runner.js';
import { renderAudit, auditExitCode } from '../src/audit-report.js';
import { runAuditProcess } from '../src/audit-process.js';

const spec = repository => ({ schemaVersion: 1, repository, revision: 'deadbeef', task: 'Inspect the fixture.',
  profiles: [{ name: 'Alpha' }, { name: 'Beta' }], limits: { runMs: 5000, experimentMs: 15000, outputBytes: 4096 },
  setup: [], checks: [{ name: 'smoke', argv: ['true'], timeoutMs: 1000 }], sandbox: 'workspace-write' });

async function harness(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-audit-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = { directory: join(directory, 'store') };
  await mkdir(store.directory, { mode: 0o700 });
  let repository = join(directory, 'repo'); await mkdir(repository, { mode: 0o700 }); repository = await realpath(repository);
  const auditRoot = join(store.directory, 'audits'); await mkdir(auditRoot, { mode: 0o700 });
  const states = new Map(), finalized = new Map(), reservations = [], releases = [], calls = [], probes = [];
  let experimentNumber = 0, runNumber = 0, settingsRevision = 0;
  const profiles = new Map(['Alpha', 'Beta'].map((name, i) => [name, {
    profileId: `profile-${i}`, profileName: name, home: join(directory, `home-${i}`), reservationRoot: join(directory, `root-${i}`),
    nativeRoot: join(directory, `native-${i}`), environmentId: `env-${i}`, executable: `/private/codex-${i}`,
    executableSource: 'registered', version: '1.2.3', env: { PATH: '/usr/bin:/bin', HOME: join(directory, `home-${i}`) },
    bindingRepository: repository,
  }]));
  for (const profile of profiles.values()) { await mkdir(profile.home, { mode: 0o700 }); await mkdir(profile.reservationRoot, { mode: 0o700 }); }
  const captureFixture = async input => {
    calls.push(`capture:${input.profile.profileName}`);
    await input.processOptions.onSpawn?.({ pid: 200 + calls.length, processIdentity: { pid: 200, started: 'fixture', command: 'codex', host: 'test' } });
    const threadId = `thread-${input.profile.profileName}`;
    const run = { schemaVersion: 1, kind: 'audit-run', id: input.limits.id, status: 'ready', profile: { profileId: input.profile.profileId },
      agents: [{ id: threadId, parentId: null, depth: 0 }], turns: [{ agentId: threadId, turnId: 'turn-1', model: 'fixture-model', reasoningEffort: 'high' }], events: [],
      skills: [{ id: 'skill-origin-one', name: 'demo', origin: 'plugin', scope: 'system', path: '/plugins/demo/SKILL.md', observations: [{ kind: 'advertised', agentId: threadId }] }],
      usage: {}, metrics: { wallMs: 10, processElapsedMs: 8, toolsActiveIntervalMs: 6, activeWaitMs: 2 }, coverage: { skills: 'complete', agents: 'complete', timeline: 'complete' }, outcome: { status: 'native-claim', nativeTurnStatus: 'completed' },
      source: { kind: 'native-rollout', nativeSessionId: threadId, threadId, clientVersion: '1.2.3' } };
    await input.onTaskEnd?.({ at: new Date().toISOString(), run, complete: true });
    return { process: { status: 'exited', exitCode: 0, elapsedMs: 10, pid: 200, processIdentity: null,
      shutdown: { groupTerminated: true }, output: { bytes: 1, truncated: false } }, run,
      capture: { status: 'ready', capabilities: { skillsList: 'available' }, errors: [] }, capabilities: { appServerV2: 'available', skillsList: 'available' } };
  };
  const context = {
    baseDirectory: auditRoot,
    inspectRepository: async () => ({ repository, commit: 'a'.repeat(40), tree: 'b'.repeat(40), files: 1, bytes: 12, clean: true }),
    resolveProfile: async (_store, selection) => profiles.get(selection.name),
    inspectExecutable: async executable => ({ executable, executableIdentity: [...profiles.values()].find(profile => profile.executable === executable)?.executableIdentity }),
    probeVersion: async options => { probes.push(options.executable); return '1.2.3'; },
    observeAccess: async () => ({ status: 'ready', clients: [], sourceReservation: null }),
    snapshotSettings: async () => ({ status: 'ready', revision: settingsRevision }),
    compareSettings: (before, after) => ({ status: before.revision === after.revision ? 'unchanged' : 'changed', changedPaths: before.revision === after.revision ? [] : ['config.toml'] }),
    createExperiment: async (_store, input) => {
      const id = `experiment-${++experimentNumber}`, dir = join(auditRoot, id); await mkdir(dir, { mode: 0o700 });
      states.set(id, { status: 'prepared' }); return { id, directory: dir, record: { id, createdAt: new Date().toISOString(), ...input } };
    },
    createExperimentRun: async (_store, { experimentId, profile, baseline }) => {
      const id = `run-${++runNumber}`, dir = join(auditRoot, id); await mkdir(dir, { mode: 0o700 });
      states.set(id, { status: 'prepared' }); return { id, directory: dir, record: { id, experimentId, profile, baseline } };
    },
    writeState: async (_store, id, patch) => {
      if (finalized.has(id)) throw new Error(`State update after immutable finalization: ${id}`);
      states.set(id, { ...states.get(id), ...patch }); return states.get(id);
    },
    finalize: async (_store, id, report) => {
      if (id.startsWith('run-') && states.get(id)?.reservation !== null)
        throw new Error(`Run finalized before its audit lease state was cleared: ${id}`);
      finalized.set(id, report); return report;
    },
    reserve: async options => { reservations.push(options); },
    release: async options => { releases.push(options); },
    authorizeParent: async () => ({}),
    createWorkspace: async ({ directory, repository: source, commit }) => {
      await mkdir(directory, { mode: 0o700 });
      return { directory, sourceCommit: commit, sourceTree: 'b'.repeat(40), active: true };
    },
    snapshotWorkspace: async ({ label }) => {
      calls.push(`snapshot:${label}`);
      return { label, fingerprint: `fingerprint-${label}`, status: label === 'before-task' ? 'clean' : 'changed', files: [{ path: 'result.txt' }], patchPath: `/private/${label}.patch`, metadataPath: `/private/${label}.json` };
    },
    setWorkspaceActive: async ({ active }) => { calls.push(`active:${active}`); },
    process: async options => {
      if (options.args[0] === 'true') calls.push(`check:${options.cwd ?? 'workspace'}`);
      await options.onSpawn?.({ pid: 100 + calls.length, processIdentity: { pid: 100, started: 'fixture', command: 'fixture', host: 'test' } });
      return { status: 'exited', exitCode: 0, elapsedMs: 5, processIdentity: { pid: 100, started: 'fixture', command: 'fixture', host: 'test' }, shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } };
    },
    capture: captureFixture,
    ...overrides,
  };
  return { store, repository, context, states, finalized, reservations, releases, calls, profiles, captureFixture,
    probes, setSettingsRevision(value) { settingsRevision = value; } };
}

test('preview is read-only and blocks unsafe profile access without creating records', async t => {
  const h = await harness(t, { observeAccess: async profile => profile.profileName === 'Beta' ? { status: 'blocked', reason: 'profile-reservation-untrusted' } : { status: 'ready', clients: [], sourceReservation: null } });
  const preview = await previewAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(preview.status, 'blocked');
  assert.equal(preview.kind, 'audit-experiment-preview');
  assert.equal(preview.baseline.commit, 'a'.repeat(40));
  assert.equal(preview.profiles[0].profileName, 'Alpha');
  assert.equal(preview.profiles[0].profileId, 'profile-0');
  assert.match(renderAudit(preview), /Audit experiment preview/);
  assert.equal(preview.failures[0].code, 'profile-access-blocked');
  assert.deepEqual(preview.sideEffects, { profileReservations: false, records: false, workspaces: false, modelTasks: false });
  assert.equal(h.reservations.length, 0);
  assert.equal(h.finalized.size, 0);
  assert.deepEqual(h.probes, ['/private/codex-0']);
});

test('workspace quality delta excludes unchanged ignored dependencies and counts task files', () => {
  const ignored = index => ({ path: `node_modules/pkg-${index}.js`, status: 'I', oldMode: null, newMode: '100644',
    size: 10, sha256: index.toString(16).padStart(64, '0'), symlink: false, ignored: true, contentCaptured: false });
  const setupFiles = Array.from({ length: 40601 }, (_, index) => ignored(index + 1));
  const tracked = (path, status, oldOid, newOid) => ({ path, status, oldMode: status === 'A' ? '000000' : '100644',
    newMode: status === 'D' ? '000000' : '100644', oldOid, newOid, size: 12, symlink: false });
  const before = { fingerprint: 'before', files: setupFiles };
  const taskEnd = { fingerprint: 'task-end', files: [...setupFiles,
    tracked('apps/bot/changed.js', 'M', 'a'.repeat(40), 'b'.repeat(40)),
    tracked('apps/bot/new.js', 'A', '0'.repeat(40), 'c'.repeat(40))] };
  assert.deepEqual(compareAuditWorkspaceDelta(before, taskEnd), {
    changeCountStatus: 'known', changedFileCount: 2, changeCountBasis: 'post-setup-snapshot-delta-v1' });
});

test('workspace quality delta counts ignored additions, removals and content changes', () => {
  const ignored = (path, digest) => ({ path, status: 'I', oldMode: null, newMode: '100644', size: 10,
    sha256: digest.repeat(64), symlink: false, ignored: true, contentCaptured: false });
  const before = { fingerprint: 'before', files: [ignored('cache/changed', 'a'), ignored('cache/removed', 'b')] };
  const taskEnd = { fingerprint: 'end', files: [ignored('cache/changed', 'c'), ignored('cache/added', 'd')] };
  assert.equal(compareAuditWorkspaceDelta(before, taskEnd).changedFileCount, 3);
});

test('workspace quality delta fails closed when legacy tracked records lack blob identities', () => {
  const oldRecord = { path: 'src/file.js', status: 'M', oldMode: '100644', newMode: '100644', size: 20, symlink: false };
  const result = compareAuditWorkspaceDelta({ fingerprint: 'before', files: [oldRecord] },
    { fingerprint: 'after', files: [{ ...oldRecord }] });
  assert.equal(result.changeCountStatus, 'unknown');
  assert.equal(result.changedFileCount, null);
  assert.equal(result.changeCountReason, 'tracked-blob-identity-missing');
  assert.equal(compareAuditWorkspaceDelta({ fingerprint: 'same', files: [oldRecord] },
    { fingerprint: 'same', files: [oldRecord] }).changedFileCount, 0);
  const originChange = compareAuditWorkspaceDelta({ fingerprint: 'before', files: [
    { path: 'cache/file', status: 'I', ignored: true, sha256: 'a'.repeat(64), size: 20, newMode: '100644', symlink: false },
  ] }, { fingerprint: 'after', files: [{ ...oldRecord, path: 'cache/file', oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40) }] });
  assert.equal(originChange.changeCountStatus, 'unknown', 'Git tracking/ignore reclassification does not prove content changed');
  assert.equal(originChange.changeCountReason, 'workspace-file-origin-changed');
});

test('strict declared capture can pass while exhaustive coverage remains partial; required evidence is never waived', async t => {
  for (const missing of [false, true]) await t.test(missing ? 'missing required counters' : 'observed required counters', async subtest => {
    const h = await harness(subtest);
    h.context.capture = async input => {
      const captured = await h.captureFixture(input), run = captured.run;
      run.agents[0].id = run.source.threadId;
      run.turns = [{ agentId: run.source.threadId, turnId: 'root-turn', status: 'completed' }];
      const values = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
      run.usage = { [run.source.threadId]: { total: values }, observations: missing ? [] : [
        { agentId: run.source.threadId, turnId: 'root-turn', total: values, disposition: 'accepted' },
      ] };
      run.status = 'partial'; run.coverage.skills = 'partial'; captured.capture.status = 'partial';
      run.warnings = ['native-source-observability-limited'];
      return captured;
    };
    const input = { ...spec(h.repository), allowIncompleteCapture: missing,
      captureRequirements: { usage: { agents: 'all', fields: ['inputTokens', 'outputTokens', 'totalTokens'] } } };
    const report = await runAuditExperiment(h.store, input, h.context);
    assert.equal(report.runs[0].captureAcceptance.status, missing ? 'failed' : 'passed');
    assert.equal(report.runs[0].coverage.skills, 'partial');
    assert.equal(report.status, missing ? 'failed' : 'partial');
    assert.equal(report.failures.some(failure => failure.code === 'capture-incomplete'), missing);
    assert.equal(h.finalized.get(report.runs[0].id).captureAcceptance.status, missing ? 'failed' : 'passed');
    assert.ok(h.finalized.get(report.runs[0].id).warnings.includes('native-source-observability-limited'));
    assert.equal(h.finalized.get(report.runs[0].id).coverage.workspaceDiff, 'complete');
    assert.equal(report.runs[0].outcome.task.status, 'passed');
    assert.equal(report.runs[0].outcome.status, 'passed');
    assert.equal(report.runs[0].coverage.outcome, 'complete');
    assert.equal(h.finalized.get(report.runs[0].id).coverage.outcome, 'complete');
    assert.equal(auditExitCode(report), missing ? 4 : 2);
    assert.equal(auditExitCode(h.finalized.get(report.runs[0].id)), missing ? 1 : 2);
  });
});

test('outcome coverage distinguishes evaluated failure, interrupted checks and absent checks', async t => {
  for (const mode of ['failed', 'timeout', 'cancelled', 'none', 'stopped-early']) await t.test(mode, async subtest => {
    const h = await harness(subtest);
    h.context.process = async () => ({ status: mode === 'failed' || mode === 'stopped-early' ? 'exited' : mode,
      exitCode: mode === 'failed' || mode === 'stopped-early' ? 1 : null,
      elapsedMs: 1, shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } });
    const input = spec(h.repository);
    if (mode === 'none') input.checks = [];
    if (mode === 'stopped-early') input.checks.push({ name: 'not-run', argv: ['true'], timeoutMs: 1000 });
    const report = await runAuditExperiment(h.store, input, h.context);
    const run = h.finalized.get(report.runs[0].id);
    assert.equal(run.outcome.task.status, 'passed');
    assert.equal(run.coverage.outcome, mode === 'none' ? 'unavailable' : mode === 'failed' ? 'complete' : 'partial');
    assert.equal(run.outcome.status, mode === 'none' ? 'not-evaluated' : mode === 'stopped-early' ? 'failed' : mode);
    assert.equal(auditExitCode(report), mode === 'none' ? 2 : mode === 'timeout' ? 124 : mode === 'cancelled' ? 130 : 4);
  });
});

test('an unfamiliar or different version is context and does not gate actual protocol checks', async t => {
  const h = await harness(t, { probeVersion: async () => '9.9.9' });
  const input = spec(h.repository);
  input.profiles[0].version = 'future-build-identifier';
  const preview = await previewAuditExperiment(h.store, input, h.context);
  assert.equal(preview.status, 'ready');
  assert.equal(preview.failures.some(failure => /version/.test(failure.code)), false);
  assert.deepEqual(preview.profiles.map(profile => profile.checks.find(check => check.name === 'codex-version').status), ['observed', 'observed']);
  assert.equal(h.reservations.length, 0);
  const report = await runAuditExperiment(h.store, input, h.context);
  assert.equal(report.status, 'complete');
  assert.equal(report.runs[0].profile.version, '9.9.9');
  assert.equal(report.runs[0].profile.requestedVersion, 'future-build-identifier');
});

test('unavailable version output stays unknown while native protocol evidence controls readiness', async t => {
  const h = await harness(t, { probeVersion: async () => { throw Object.assign(new Error('token=secret-value'), { code: 'PROTOCOL_ERROR' }); } });
  const preview = await previewAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(preview.status, 'ready');
  assert.equal(preview.profiles[0].checks.find(check => check.name === 'codex-version').status, 'unknown');
  assert.doesNotMatch(JSON.stringify(preview), /secret-value/);
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'complete');
  assert.equal(report.runs[0].profile.version, null);
});

test('executable identity changes still block before any native task starts', async t => {
  const h = await harness(t, { inspectExecutable: async executable => ({ executable, executableIdentity: 'changed' }) });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'partial');
  assert.equal(report.failures.some(failure => failure.code === 'executable-changed'), true);
  assert.equal(h.calls.some(call => call.startsWith('capture:')), false);
});

test('run stops if the revision resolves to a different commit after preview', async t => {
  let lookups = 0;
  const h = await harness(t, { inspectRepository: async () => ({ repository: h.repository,
    commit: ++lookups === 1 ? 'a'.repeat(40) : 'c'.repeat(40), tree: 'b'.repeat(40), files: 1, bytes: 12, clean: true }) });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'blocked');
  assert.equal(report.failures[0].code, 'commit-changed');
  assert.equal(h.reservations.length, 0);
  assert.equal(h.finalized.size, 0);
});

test('two profiles run sequentially with a task-end diff before checks and origin-aware skill evidence', async t => {
  const h = await harness(t);
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.kind, 'audit-experiment-report');
  assert.equal(report.status, 'complete');
  assert.equal(h.calls.includes('active:true'), false);
  assert.equal(report.runs[0].metrics.processElapsedMs, 8);
  assert.equal(report.runs[0].metrics.toolsActiveIntervalMs, 6);
  assert.equal(report.runs[0].metrics.activeWaitMs, 2);
  assert.equal(report.comparisons[0].comparison.outcomes.checks.status, 'match');
  assert.ok(report.comparisons[0].comparison.metrics.processElapsedMs.status === 'known');
  assert.ok(report.comparisons[0].comparison.artifacts.left.artifacts.some(item => item.kind === 'workspace-snapshot'));
  assert.deepEqual(report.execution.order, ['Alpha', 'Beta']);
  assert.equal(h.reservations.length, 2);
  assert.equal(h.probes.length, 4); // preview and post-reservation verification for each selected profile
  assert.equal(h.releases.length, 2);
  assert.deepEqual(h.calls.filter(x => x.startsWith('capture:')), ['capture:Alpha', 'capture:Beta']);
  const taskEndIndex = h.calls.indexOf('snapshot:task-end'), checkIndex = h.calls.findIndex(x => x.startsWith('check:'));
  const finalIndex = h.calls.indexOf('snapshot:after-checks');
  assert.ok(taskEndIndex < checkIndex);
  assert.ok(checkIndex < finalIndex);
  for (const run of report.runs) {
    assert.match(run.taskEnd.fingerprint, /task-end/);
    assert.match(run.finalWorkspace.fingerprint, /after-checks/);
    assert.equal(run.skills[0].origin, 'plugin');
    assert.equal(run.agents[0].id, run.source.threadId);
    const stored = h.finalized.get(run.id);
    assert.equal(stored.capture.status, 'ready');
    assert.ok(stored.execution);
    assert.deepEqual(stored.baseline, { repository: h.repository, commit: 'a'.repeat(40), tree: 'b'.repeat(40), settingsStatus: 'ready' });
    assert.equal(stored.sourceWorkspace.sourceCommit, stored.baseline.commit);
    assert.equal(stored.sourceWorkspace.sourceTree, stored.baseline.tree);
    assert.ok(stored.workspace.taskEnd && stored.workspace.checkEnd);
    assert.equal(h.states.get(run.id).reservation, null);
    assert.equal(h.states.get(run.id).workspace.active, false);
  }
  assert.equal(h.finalized.get(report.id).runs.length, 2);
});

test('retains exact task-end delta evidence when the later workspace snapshot fails', async t => {
  const h = await harness(t, { snapshotWorkspace: async ({ label }) => {
    if (label === 'before-task') return { label, fingerprint: 'setup-fingerprint', status: 'clean', files: [], patchPath: '/private/before.patch', metadataPath: '/private/before.json' };
    if (label === 'task-end') return { label, fingerprint: 'task-fingerprint', status: 'changed',
      files: [{ path: 'src/changed.js', status: 'A', oldMode: '000000', newMode: '100644',
        oldOid: '0'.repeat(40), newOid: 'a'.repeat(40), size: 5, symlink: false }],
      patchPath: '/private/task-end.patch', metadataPath: '/private/task-end.json' };
    if (label === 'after-checks') throw new Error('fixture after-check snapshot failure');
    return { label, fingerprint: `${label}-fingerprint`, status: 'changed', files: [],
      patchPath: `/private/${label}.patch`, metadataPath: `/private/${label}.json` };
  } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  const run = report.runs[0], stored = h.finalized.get(run.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.workspace.taskEnd.fingerprint, 'task-fingerprint');
  assert.equal(run.workspace.taskEnd.changedFileCount, 1);
  assert.equal(run.workspace.taskEnd.changeCountStatus, 'known');
  assert.equal(stored.workspace.taskEnd.changedFileCount, 1);
  assert.equal(stored.workspace.taskEnd.fingerprint, 'task-fingerprint');
});

test('reservation race prevents every model task and releases only reservations already acquired', async t => {
  const h = await harness(t, { reserve: async options => {
    h.reservations.push(options);
    if (options.owner.profileId === 'profile-1') throw Object.assign(new Error('busy'), { code: 'profile-busy' });
  } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'blocked');
  assert.equal(report.exitCode, 1);
  assert.equal(h.calls.some(x => x.startsWith('capture:')), false);
  assert.equal(h.releases.length, 1);
  assert.equal(report.runs.length, 2);
  assert.deepEqual(report.runs.map(run => run.profile.profileName), ['Alpha', 'Beta']);
  assert.ok(report.runs.some(run => run.phase === 'reservation'));
  assert.ok(report.runs.some(run => run.phase === 'not-started'));
  assert.equal(h.finalized.size, 2); // acquired run plus experiment; uncertain acquisition stays unfinished
});

test('native config stays attached to its selected profile through execution and reporting', async t => {
  const h = await harness(t), nativeConfig = { forced_login_method: 'chatgpt', model_reasoning_effort: 'low' };
  const observed = [];
  h.context.capture = async input => { observed.push({ name: input.profile.profileName, config: input.profile.nativeConfig }); return h.captureFixture(input); };
  const input = spec(h.repository);
  input.profiles[0].nativeConfig = nativeConfig;
  const report = await runAuditExperiment(h.store, input, h.context);
  assert.deepEqual(observed, [{ name: 'Alpha', config: nativeConfig }, { name: 'Beta', config: undefined }]);
  assert.deepEqual(report.runs[0].profile.nativeConfig, nativeConfig);
  assert.equal(Object.hasOwn(report.runs[1].profile, 'nativeConfig'), false);
});

test('profile settings drift stops later profiles and is recorded without restoration', async t => {
  const h = await harness(t);
  // Make the first profile's after-snapshot differ. The runner reports drift and
  // never tries to rewrite the saved settings.
  h.context.snapshotSettings = async profile => ({ status: 'ready', revision: profile.profileName === 'Alpha' && h.calls.includes('capture:Alpha') ? 1 : 0 });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.notEqual(report.status, 'complete');
  assert.equal(report.runs.length, 2);
  assert.equal(report.runs.find(run => run.profile.profileName === 'Alpha').profileSettings.status, 'changed');
  assert.equal(h.calls.some(x => x === 'capture:Beta'), false);
  assert.equal(h.releases.length, 2);
});

test('incomplete capture still retains check results before strict acceptance fails', async t => {
  const h = await harness(t, { capture: async input => {
    const result = await h.captureFixture(input);
    result.run.status = 'partial'; result.run.coverage.skills = 'partial'; result.capture.status = 'partial';
    return result;
  } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  const run = report.runs.find(item => item.profile.profileName === 'Alpha');
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'capture-incomplete');
  assert.equal(report.status, 'failed');
  assert.equal(report.exitCode, 4);
  assert.ok(run.checks.some(check => check.status === 'passed'));
  assert.ok(h.calls.some(call => call.startsWith('check:')));
});

test('setup failure snapshots the workspace before deactivation and preserves cleanup fingerprint', async t => {
  const h = await harness(t, { process: async options => {
    await options.onSpawn?.({ pid: 401, processIdentity: { pid: 401, started: 'fixture', command: 'setup', host: 'test' } });
    return { status: 'exited', exitCode: 1, elapsedMs: 3, processIdentity: null,
      shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } };
  } });
  const input = spec(h.repository);
  input.setup = [{ name: 'prepare', argv: ['false'], timeoutMs: 1000 }];
  const report = await runAuditExperiment(h.store, input, h.context);
  const run = report.runs.find(item => item.profile.profileName === 'Alpha');
  assert.equal(run.status, 'failed');
  assert.equal(run.taskEnd, undefined);
  assert.equal(run.finalWorkspace.timing, 'failure-finalization');
  assert.equal(run.finalWorkspace.fingerprint, 'fingerprint-failure-finalization');
  assert.ok(run.artifacts.some(item => item.label === 'failure-finalization'));
  assert.equal(h.states.get(run.id).workspace.finalFingerprint, 'fingerprint-failure-finalization');
  assert.equal(h.states.get(run.id).workspace.active, false);
  assert.equal(h.finalized.get(run.id).finalWorkspace.timing, 'failure-finalization');
});

test('incomplete child shutdown retains the task snapshot but marks its timing and diff partial', async t => {
  const h = await harness(t, { capture: async input => {
    const onTaskEnd = input.onTaskEnd;
    input.onTaskEnd = evidence => onTaskEnd({ ...evidence, complete: false });
    return h.captureFixture(input);
  } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  const run = report.runs.find(item => item.profile.profileName === 'Alpha');
  assert.equal(run.taskEnd.fingerprint, 'fingerprint-task-end');
  assert.equal(run.taskEnd.captureComplete, false);
  assert.equal(run.taskEnd.timing, 'unverified-task-end');
  assert.equal(run.coverage.workspaceDiff, 'partial');
  assert.equal(run.workspace.taskEnd.fingerprint, 'fingerprint-task-end');
  assert.equal(run.workspace.taskEnd.captureComplete, false);
  assert.equal(run.workspace.taskEnd.timing, 'unverified-task-end');
  assert.equal(run.workspace.checkEnd.fingerprint, 'fingerprint-after-checks');
});

test('workspace creation failure preserves intent when an unverified directory remains', async t => {
  const h = await harness(t, { createWorkspace: async ({ directory }) => {
    await mkdir(directory, { mode: 0o700 });
    throw Object.assign(new Error('interrupted materialization'), { code: 'EIO' });
  } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  const run = report.runs.find(item => item.profile.profileName === 'Alpha');
  const state = h.states.get(run.id);
  assert.equal(report.status, 'recovery-required');
  assert.equal(run.status, 'recovery-required');
  assert.equal(state.phase, 'workspace-creation');
  assert.equal(state.workspace.directory, join(h.store.directory, 'audits', run.id, 'workspace'));
  assert.equal(state.workspace.owner.runId, run.id);
  assert.equal(state.workspace.ownershipVerified, false);
  assert.equal(state.workspace.active, true);
  assert.equal(h.finalized.has(run.id), false);
});

test('task timeout is reported as exit 124 before capture completeness', async t => {
  const h = await harness(t, { capture: async input => {
    const result = await h.captureFixture(input);
    result.process.status = 'timeout'; result.process.exitCode = null;
    result.run.status = 'partial'; result.capture.status = 'partial';
    return result;
  } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'timeout');
  assert.equal(report.exitCode, 124);
  assert.equal(report.runs.find(item => item.profile.profileName === 'Alpha').status, 'timeout');
  assert.equal(h.calls.some(call => call.startsWith('check:')), false);
});

test('unsafe task shutdown preserves every acquired reservation for restart recovery', async t => {
  const h = await harness(t, { capture: async input => {
    const result = await h.captureFixture(input);
    result.process.status = 'shutdown-failed';
    result.process.shutdown.groupTerminated = false;
    return result;
  } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'recovery-required');
  for (const run of report.runs) {
    const reservation = h.states.get(run.id).reservation;
    assert.ok(reservation, JSON.stringify({ run, state: h.states.get(run.id) }));
    assert.equal(reservation.owner.runId, run.id);
    assert.equal(reservation.status, 'held');
  }
  assert.equal(h.releases.length, 0);
  assert.equal(h.finalized.has('run-2'), false); // the not-started run stays recoverable
});

test('reservation release failure retains exact owner instead of finalizing cleared state', async t => {
  const h = await harness(t, { release: async () => { throw Object.assign(new Error('release failed'), { code: 'EIO' }); } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'partial');
  for (const run of report.runs) {
    const reservation = h.states.get(run.id).reservation;
    assert.ok(reservation, JSON.stringify({ run, state: h.states.get(run.id) }));
    assert.equal(reservation.owner.runId, run.id);
    assert.equal(reservation.status, 'held');
  }
});

test('dirty source uses one pinned commit even when the selected branch and work change', async t => {
  const revisions = [];
  const h = await harness(t, { inspectRepository: async (_repository, revision) => {
    revisions.push(revision);
    return { repository: h.repository, commit: 'a'.repeat(40), tree: 'b'.repeat(40), files: 1, bytes: 12,
      clean: false, sourceDirty: true, sourceHead: revisions.length === 1 ? 'c'.repeat(40) : 'd'.repeat(40) };
  } });
  const input = { ...spec(h.repository), revision: 'develop' };
  const report = await runAuditExperiment(h.store, input, h.context);
  assert.equal(report.status, 'complete');
  assert.deepEqual(revisions, ['develop', 'a'.repeat(40)]);
  assert.equal(report.baseline.commit, 'a'.repeat(40));
  assert.equal(report.baseline.selectedRevision, 'develop');
  assert.equal(report.baseline.sourceDirty, true);
  assert.equal(report.baseline.source, 'same-committed-snapshot');
  for (const run of report.runs) assert.equal(run.sourceWorkspace.sourceCommit, 'a'.repeat(40));
});

test('running clients and native reservations can coexist and are checked after each run', async t => {
  const client = { pid: 101, ppid: 1, uid: 501, startedAt: '2026-10-16T01:00:00Z', executable: '/Applications/Codex' };
  const native = { kind: 'desktop-instance', runId: 'native-run', phase: 'running' };
  const h = await harness(t, { observeAccess: async (_profile, { expectedClients }) => {
    if (expectedClients) assert.equal(expectedClients[0].pid, client.pid);
    return { status: 'ready', clients: [{ ...client, ppid: 2 }], sourceReservation: native };
  } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'complete');
  for (const run of report.runs) {
    assert.equal(run.runningClients.status, 'unchanged');
    assert.equal(run.runningClients.reservationUnchanged, true);
    assert.equal(h.finalized.get(run.id).runningClients.status, 'unchanged');
  }
});

test('client identity loss during a task stops later profiles and preserves the evidence', async t => {
  const client = { pid: 101, ppid: 1, uid: 501, startedAt: '2026-10-16T01:00:00Z', executable: '/Applications/Codex' };
  let changed = false;
  const h = await harness(t, { observeAccess: async () => ({ status: 'ready', clients: changed ? [] : [client], sourceReservation: null }) });
  h.context.capture = async input => { const result = await h.captureFixture(input); changed = true; return result; };
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.ok(report.failures.some(f => f.code === 'profile-clients-changed'));
  assert.deepEqual(h.calls.filter(call => call.startsWith('capture:')), ['capture:Alpha']);
  assert.equal(report.runs[0].runningClients.status, 'changed');
  assert.equal(report.runs[0].runningClients.missing[0].pid, 101);
  assert.equal(report.runs[1].phase, 'not-started');
  assert.equal(h.releases.length, 2);
});

test('cancellation across execution phases stops later profiles and finalizes only after owned groups stop', async t => {
  for (const phase of ['setup', 'task', 'checks', 'finalization']) await t.test(phase, async subtest => {
    const controller = new AbortController();
    let ownedGroupStopped = false, spawned = 0;
    const h = await harness(subtest, {
      signal: controller.signal,
      release: async options => {
        if (options.owner.profileId === 'profile-0' && ['setup', 'task', 'checks'].includes(phase))
          assert.equal(ownedGroupStopped, true, 'profile lease is released after its owned group is confirmed stopped');
        h.releases.push(options);
      },
      process: async options => {
        if (phase === 'finalization') {
          h.calls.push(`check:${options.cwd}`);
          await options.onSpawn?.({ pid: 100 + h.calls.length, processIdentity: { pid: 100, started: 'fixture', command: 'fixture', host: 'test' } });
          return { status: 'exited', exitCode: 0, elapsedMs: 5,
            processIdentity: { pid: 100, started: 'fixture', command: 'fixture', host: 'test' },
            shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } };
        }
        const result = await runAuditProcess({ ...options, executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'], onSpawn: async info => {
            await options.onSpawn?.(info);
            assert.equal(h.states.get('run-1').process.pid, info.pid, 'persist process ownership before cancellation');
            spawned++;
            controller.abort('fixture-cancel');
          } });
        ownedGroupStopped = result.shutdown?.groupTerminated === true;
        return result;
      },
      ...(phase === 'task' ? { capture: async input => {
        h.calls.push(`capture:${input.profile.profileName}`);
        const result = await runAuditProcess({ ...input.processOptions, cwd: input.workspace, executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'], onSpawn: async info => {
            await input.processOptions.onSpawn?.(info);
            assert.equal(h.states.get('run-1').process.pid, info.pid, 'persist task process ownership before cancellation');
            spawned++;
            controller.abort('fixture-cancel');
          } });
        ownedGroupStopped = result.shutdown?.groupTerminated === true;
        return { process: result, capture: { status: 'partial' }, capabilities: { appServerV2: 'unavailable', skillsList: 'unavailable' },
          run: { schemaVersion: 1, kind: 'audit-run', status: 'partial', profile: { profileId: input.profile.profileId },
            agents: [], turns: [], events: [], skills: [], usage: {}, metrics: {}, coverage: { skills: 'unavailable' },
            outcome: { status: 'unverified', nativeTurnStatus: 'unknown' }, source: { threadId: 'fixture-task' } } };
      } } : {}),
      snapshotWorkspace: async options => {
        const snapshot = { label: options.label, fingerprint: `fingerprint-${options.label}`, status: 'changed',
          files: [{ path: 'result.txt' }], patchPath: `/private/${options.label}.patch`, metadataPath: `/private/${options.label}.json` };
        h.calls.push(`snapshot:${options.label}`);
        if (phase === 'finalization' && options.label === 'after-checks') controller.abort('fixture-cancel-after-checks');
        return snapshot;
      },
    });
    const input = spec(h.repository);
    input.setup = phase === 'setup' ? [{ name: 'cancel-setup', argv: ['true'], timeoutMs: 10000 }] : [];
    input.checks = phase === 'checks' || phase === 'finalization'
      ? [{ name: 'cancel-check', argv: ['true'], timeoutMs: 10000 }] : [];

    const report = await runAuditExperiment(h.store, input, h.context);
    const alpha = report.runs.find(run => run.profile.profileName === 'Alpha');
    const beta = report.runs.find(run => run.profile.profileName === 'Beta');
    assert.ok(alpha, JSON.stringify(report));
    assert.ok(beta, JSON.stringify(report));
    assert.equal(beta.phase, 'not-started', `cancellation stops the later profile before workspace or task setup: ${JSON.stringify(report)}`);
    assert.equal(h.calls.some(call => call === 'capture:Beta'), false);
    assert.equal(h.finalized.has(alpha.id), true, 'cancellation leaves immutable run evidence');
    assert.equal(h.states.get(alpha.id).reservation, null);
    assert.equal(h.states.get(beta.id).reservation, null);
    assert.equal(h.releases.length, 2, 'all acquired leases are released after cancellation cleanup');

    if (['setup', 'task', 'checks'].includes(phase)) {
      assert.equal(spawned, 1);
      assert.equal(ownedGroupStopped, true);
      assert.equal(report.status, 'cancelled');
      assert.equal(alpha.status, 'cancelled');
      if (phase !== 'checks') assert.equal(alpha.error?.code, 'cancelled');
      assert.ok(alpha.finalWorkspace?.timing === 'failure-finalization' || alpha.finalWorkspace?.fingerprint,
        'workspace evidence records the completed cleanup boundary');
      assert.ok(h.releases.length > 0);
    } else {
      assert.equal(spawned, 0);
      assert.equal(report.status, 'cancelled');
      assert.equal(alpha.status, 'complete', 'all checks completed before cancellation stopped the next profile');
      assert.equal(alpha.outcome.status, 'passed');
      assert.ok(alpha.finalWorkspace.fingerprint);
      assert.ok(alpha.artifacts.some(item => item.label === 'after-checks'));
    }
    if (phase === 'task') {
      assert.equal(alpha.execution.status, 'cancelled');
      assert.equal(alpha.outcome.status, 'unverified');
      assert.notEqual(alpha.task.status, 'passed');
    }
    if (phase === 'checks') {
      assert.equal(alpha.checks[0].status, 'cancelled');
      assert.equal(alpha.outcome.status, 'cancelled');
    }
    if (phase === 'setup') assert.equal(alpha.setup[0].status, 'cancelled');
    for (const run of report.runs) assert.ok(h.finalized.has(run.id), `final evidence is available for ${run.id}`);
  });
});

test('normalized capture checkpoints persist before phase markers can expose a crash boundary', async t => {
  const order = [];
  const h = await harness(t, { writeCaptureCheckpoint: async (_store, id, snapshot) => {
    assert.equal(snapshot.run.id, id); assert.equal(snapshot.capture.status, 'ready'); order.push(`checkpoint:${id}`);
  } });
  const writeState = h.context.writeState;
  h.context.writeState = async (store, id, patch) => { if (patch.captureCheckpoint) order.push(`state:${id}`); return writeState(store, id, patch); };
  h.context.capture = async input => { const result = await h.captureFixture(input); await input.onSession(result.run, result.capture); return result; };
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'complete');
  assert.deepEqual(order, ['checkpoint:run-1', 'state:run-1', 'checkpoint:run-2', 'state:run-2']);
});


test('settings that become unavailable after preview block before reservations and native launch', async t => {
  let snapshots = 0;
  const h = await harness(t, { snapshotSettings: async () => ++snapshots <= 2 ? { status: 'ready', revision: 0 } : { status: 'unavailable' } });
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.ok(report.failures.some(failure => failure.code === 'profile-settings-unavailable'));
  assert.equal(h.reservations.length, 0);
  assert.equal(h.calls.some(call => call.startsWith('capture:')), false);
});


test('a clean app-server exit cannot turn a failed native turn into a successful task', async t => {
  const h = await harness(t);
  h.context.capture = async input => { const result = await h.captureFixture(input); result.run.outcome.nativeTurnStatus = 'failed'; return result; };
  const report = await runAuditExperiment(h.store, spec(h.repository), h.context);
  assert.equal(report.status, 'failed');
  assert.equal(report.exitCode, 4);
  assert.ok(report.failures.some(failure => failure.code === 'task-failed'));
  assert.equal(h.calls.some(call => call.startsWith('check:')), false);
});
