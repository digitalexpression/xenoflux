import assert from 'node:assert/strict';
import { copyFile, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClientRuntime } from '../src/client-runtime.js';
import { decodeCopilotCatalog, selectCopilotSettings } from '../src/copilot-catalog.js';
import { copilotDecision, copilotPermission } from '../src/copilot-events.js';
import { assertCopilotEnvironment, resolveCopilotProfile } from '../src/copilot-profile.js';
import { assertCopilotSessionSelection, createCopilotRuntime } from '../src/copilot-runtime.js';
import { importCopilotTranscript } from '../src/copilot-transcript.js';
import { createUiReviewTasks } from '../src/ui-review-tasks.js';

const sdk = '1.0.29';
const fixture = name => new URL(`./fixtures/copilot/${name}`, import.meta.url);
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-copilot-runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fixture.js');
  await copyFile(fixture('cli.cjs'), executable);
  await chmod(executable, 0o700);
  await copyFile(fixture('events.json'), join(root, 'events.json'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const profileFor = async (label, settings = {}) => {
    const reservation = join(root, label), home = join(reservation, 'config');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, 'fixture.json'), JSON.stringify({ label, ...settings }), { mode: 0o600 });
    const profile = await resolveCopilotProfile({
      stored: { id: label, name: label, client: 'copilot', native: { root: reservation, configRoot: home, rootMode: 'explicit', executable } },
      workspace,
    });
    profile.accountQualification = { scope: 'shared', authType: 'gh-cli', sdk,
      rootMode: 'explicit', executableIdentity: profile.executableIdentity, runtimeVersion: '1.0.107' };
    return profile;
  };
  const evidence = async label => {
    const path = join(root, label);
    await mkdir(path, { mode: 0o700 });
    return { stdoutPath: join(path, 'native.stdout'), stderrPath: join(path, 'native.stderr'),
      log: async () => (await readFile(join(path, 'fixture-rpc.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) };
  };
  return { root, workspace, profileFor, evidence };
}

test('Copilot catalog keeps advertised explicit and Auto choices separate', () => {
  const catalog = decodeCopilotCatalog({ models: [
    { id: 'opaque/model', name: 'Fixture', supportedReasoningEfforts: ['low', 'max'], defaultReasoningEffort: 'low' },
    { id: 'disabled', name: 'Unavailable', policy: { state: 'disabled' } },
  ], auto: { defaultTier: 'balance', tiers: [{ id: 'balance', type: 'auto', status: { enabled: true } }] },
  imageModels: [{ id: 'image' }] });
  assert.deepEqual(selectCopilotSettings(catalog, { model: 'opaque/model', reasoningEffort: 'max' }),
    { model: 'opaque/model', reasoningEffort: 'max', permissionMode: undefined });
  for (const request of [{ model: 'image' }, { model: 'disabled' }, { model: 'opaque/model', reasoningEffort: 'xhigh' },
    { model: 'auto', reasoningEffort: 'low' }, { permissionMode: 'allow-all' }]) {
    assert.throws(() => selectCopilotSettings(catalog, request));
  }
  assert.deepEqual(selectCopilotSettings(catalog, { model: 'auto' }), { model: 'auto', route: 'balance', permissionMode: undefined });
});

test('pinned SDK refresh and bound listing/import issue only metadata RPCs on each owned root', async t => {
  const { workspace, profileFor, evidence, root } = await setup(t);
  const left = await profileFor('Left'), right = await profileFor('Right');
  const runtime = createCopilotRuntime();
  const refresh = await evidence('refresh');
  const catalog = await runtime.discover({ ...refresh, profile: left, workspace });
  assert.equal(catalog.status, 'ready');
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.auto.tiers.find(tier => tier.id === 'fast').visible, false);
  assert.deepEqual((await refresh.log()).map(row => row.method),
    ['connect', 'status.get', 'auth.getStatus', 'models.list', 'auth.getStatus', 'runtime.shutdown']);
  assert.ok((await refresh.log()).every(row => row.root === left.home && row.cwd === workspace));
  const leftRead = await evidence('left-list'), rightRead = await evidence('right-list');
  const [leftSessions, rightSessions] = await Promise.all([
    runtime.listSessions({ ...leftRead, profile: left, workspace }),
    runtime.listSessions({ ...rightRead, profile: right, workspace }),
  ]);
  const [a] = leftSessions, [b] = rightSessions;
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(a.title, 'Left');
  assert.equal(b.title, 'Right');
  assert.throws(() => assertCopilotSessionSelection(a.selection, right), /binding does not match/);
  const aRun = await importCopilotTranscript(a, { profile: left, directory: join(root, 'read-left') });
  const bRun = await importCopilotTranscript(b, { profile: right, directory: join(root, 'read-right') });
  assert.equal(aRun.sessionReplay.sessions[0].events.at(-1).body, 'Left');
  assert.equal(bRun.sessionReplay.sessions[0].events.at(-1).body, 'Right');
  assert.equal(aRun.source.readContext.profileId, left.profileId);
  assert.equal(Object.hasOwn(aRun, 'environmentBinding'), false);
  await assert.rejects(importCopilotTranscript(a, { profile: right, directory: join(root, 'refused-read') }));
  await writeFile(join(left.home, 'fixture.json'), JSON.stringify({ label: 'Left', login: 'another-fixture-login' }), { mode: 0o600 });
  await assert.rejects(importCopilotTranscript(a, { profile: left, directory: join(root, 'changed-account-read') }));
});

test('ambient override and unverified managed route refuse effects', async t => {
  const { workspace, profileFor, evidence } = await setup(t);
  const profile = await profileFor('Bound');
  for (const key of ['GH_TOKEN', 'COPILOT_PROVIDER_NEW', 'COPILOT_HOME', 'GH_CONFIG_DIR', 'COPILOT_CACHE_HOME'])
    assert.throws(() => assertCopilotEnvironment({ ...profile.env, [key]: '' }), /ambient Copilot/);
  const paths = await evidence('invalid');
  await assert.rejects(createCopilotRuntime().discover({ ...paths, profile: { ...profile, accountQualification: null }, workspace }), /verified account scope/);
  await assert.rejects(paths.log(), { code: 'ENOENT' });
});

async function runCapture(t, settings = {}) {
  const { workspace, profileFor, evidence } = await setup(t);
  const profile = await profileFor('Bound', settings);
  const paths = await evidence('capture');
  const controller = new AbortController();
  const requests = [], turns = [], checkpoints = [];
  let resolveQueued;
  const queued = new Promise(resolve => { resolveQueued = resolve; });
  const runtime = createClientRuntime({ runtimes: { copilot: createCopilotRuntime() } });
  const result = runtime.capture({ jobId: 'fixture-job', executionMode: 'profile', profile, workspace,
    execution: { model: 'auto', permissionMode: 'manual' }, task: 'Exact fixture task.',
    processOptions: { ...paths, env: profile.env, timeoutMs: 4000, signal: controller.signal },
    onSession: async (run, evidence) => { checkpoints.push([run.nativeReference?.sessionId, evidence.checkpoint]); },
    onTurn: async turn => { turns.push(turn); },
    onNativeRequest: (request, { signal }) => new Promise((resolve, reject) => {
      requests.push({ request, resolve });
      signal.addEventListener('abort', () => reject(Error('Stopped fixture')), { once: true });
      if (requests.length === 2) resolveQueued();
    }),
  });
  return { controller, requests, turns, checkpoints, result, queued: Promise.race([queued, result.then(value => assert.fail(value.run.reason))]), paths };
}

test('qualified capture queues path and command approvals and distinguishes shell yield from typed exit', async t => {
  const { requests, turns, checkpoints, queued, result, paths } = await runCapture(t);
  await queued;
  assert.deepEqual(requests.map(row => row.request.params.category), ['path', 'commands']);
  assert.equal(requests[0].request.params.itemId, requests[1].request.params.itemId);
  assert.notEqual(requests[0].request.id, requests[1].request.id);
  assert.equal(requests[0].request.params.action.commandSegments[0].staticTokens, null);
  requests[0].resolve({ kind: 'approve-once' });
  requests[1].resolve({ kind: 'reject' });
  const capture = await result;
  assert.equal(capture.process.shutdown.groupTerminated, true);
  assert.equal(capture.response.text, 'Synthetic final answer.');
  assert.equal(capture.response.status, 'complete');
  assert.equal(capture.run.nativeReference.turnId, turns.at(-1).turnId);
  assert.equal(capture.run.settingsEvidence.sent.model, 'auto');
  assert.equal(capture.run.settingsEvidence.confirmed.route, 'balance');
  assert.equal(capture.run.settingsEvidence.observed.model, 'fixture-routed-model');
  assert.equal(capture.run.sessionReplay.sessions[0].events.at(-1).body, 'Synthetic final answer.');
  assert.equal(capture.run.toolInvocations.find(tool => tool.toolName === 'bash').exitCode, 0);
  assert.deepEqual(capture.run.events.filter(row => row.shell).map(row => [row.toolName, row.shell.state, row.shell.exitCode]),
    [['bash', 'yielded', null], ['read_bash', 'exited', 0]]);
  assert.equal(checkpoints[0][1], 'native-session-started');
  const wire = await paths.log();
  assert.equal(wire.filter(row => row.method === 'session.send').length, 1);
  assert.equal(wire.find(row => row.method === 'session.send').params.prompt, 'Exact fixture task.');
  assert.deepEqual(wire.filter(row => row.method === 'session.permissions.handlePendingPermissionRequest').map(row => row.params.result.kind),
    ['approve-once', 'reject']);
  assert.ok(wire.every(row => row.params?.trustWorkingDirectory === undefined));
});

test('cancel aborts the owned session before teardown and ignores stale decisions', async t => {
  const { controller, requests, queued, result, paths } = await runCapture(t);
  await queued;
  controller.abort();
  requests[0].resolve({ kind: 'approve-once' });
  const capture = await result;
  assert.equal(capture.process.status, 'cancelled');
  assert.equal(capture.process.shutdown.abortAcknowledged, true);
  assert.equal(capture.process.shutdown.nativeAbortedIdle, true);
  assert.equal(capture.process.shutdown.groupTerminated, true);
  const methods = (await paths.log()).map(row => row.method);
  assert.ok(methods.indexOf('session.abort') < methods.indexOf('session.detach'));
  assert.equal(methods.includes('session.permissions.handlePendingPermissionRequest'), false);
});

test('wrong native working directory prevents initial submission', async t => {
  const { result, paths, queued } = await runCapture(t, { wrongCwd: true });
  queued.catch(() => {});
  const capture = await result;
  assert.match(capture.run.reason, /exact working directory/);
  assert.ok(!(await paths.log()).some(row => row.method === 'session.send'));
});

test('ordinary review uses the client registry and retains the exact Copilot final response', async t => {
  const { root, profileFor } = await setup(t);
  const profile = await profileFor('Review', { noTools: true });
  const store = { directory: join(root, 'store') };
  await mkdir(store.directory, { mode: 0o700 });
  const run = id => ({ id, source: { threadId: id }, turns: [], checks: [] });
  const service = createUiReviewTasks({ store,
    resolveComparison: async () => ({ title: 'Fixture report', value: { schemaVersion: 1, kind: 'audit-comparison',
      id: 'fixture-pair', status: 'partial', left: run('left'), right: run('right') } }),
    context: {
      resolveProfile: async () => profile, recheckProfile: async () => profile,
      reserve: async () => {}, release: async () => {},
      lockOptions: { lockPath: join(root, 'desktop.lock'), isAlive: () => false },
      clientRuntimes: { copilot: createCopilotRuntime() },
    } });
  t.after(() => service.close());
  const preview = await service.previewReviewTask({ ref: 's.fixture', profile: 'Review', prompt: 'Review the evidence.' });
  const { id } = await service.startReviewTask({ ref: 's.fixture', previewToken: preview.previewToken });
  let result;
  for (let index = 0; index < 150; index++) {
    result = await service.reviewTask({ id });
    if (['completed', 'failed', 'cancelled', 'uncertain'].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.response.text, 'Synthetic final answer.');
  assert.equal(result.shutdown.groupTerminated, true);
  const saved = JSON.parse(await readFile(join(store.directory, 'review-tasks', id, 'task.json'), 'utf8'));
  assert.equal(saved.nativeReference.client, 'copilot');
  assert.equal(saved.nativeReference.sessionId, saved.threadId);
  assert.equal(saved.settingsEvidence.observed.model, 'fixture-routed-model');
});

test('an observed out-of-group descendant keeps shutdown uncertain after the CLI closes', async t => {
  const { queued, requests, result } = await runCapture(t, { escapedDescendant: true });
  await queued;
  // Let the macOS ancestry sampler observe the deliberately separate fixture group.
  await new Promise(resolve => setTimeout(resolve, 350));
  requests[0].resolve({ kind: 'approve-once' });
  requests[1].resolve({ kind: 'reject' });
  const capture = await result;
  assert.equal(capture.response.status, 'complete');
  assert.equal(capture.process.shutdown.childClosed, true);
  assert.equal(capture.process.shutdown.groupTerminated, false);
  assert.ok(capture.process.shutdown.trackedProcesses >= 2);
});

test('a different current auth route stops before Copilot discovery or submission', async t => {
  const { profileFor, workspace, evidence } = await setup(t);
  const profile = await profileFor('Changed', { authType: 'user' });
  const paths = await evidence('changed-discovery');
  await assert.rejects(createCopilotRuntime().discover({ ...paths, profile, workspace }), /account scope is unverified/);
  assert.deepEqual((await paths.log()).map(row => row.method), ['connect', 'status.get', 'auth.getStatus', 'runtime.shutdown']);
});

test('permission validation refuses altered action ownership and any persistent decision', async () => {
  const rows = JSON.parse(await readFile(fixture('events.json'), 'utf8'));
  const event = rows.find(row => row.data.promptRequest?.kind === 'commands');
  const scope = [event.data.ownerSessionId, 'turn-fixture', '@WORKSPACE@'];
  assert.equal(copilotPermission(event, ...scope).params.category, 'commands');
  event.data.promptRequest.commandIdentifiers = ['/bin/echo'];
  assert.throws(() => copilotPermission(event, ...scope), /does not match/);
  assert.throws(() => copilotDecision({ kind: 'approve-for-session' }), /Approve once or Reject/);
  assert.throws(() => copilotDecision({ kind: 'approve-once', scope: 'location' }), /Approve once or Reject/);
});

test('a separately qualified native user route is carried through bound list and import', async t => {
  const { profileFor, workspace, evidence, root } = await setup(t);
  const profile = await profileFor('UserRoute', { authType: 'user' });
  profile.accountQualification = { ...profile.accountQualification, authType: 'user', scope: 'per-root' };
  const paths = await evidence('user-list');
  const [row] = await createCopilotRuntime().listSessions({ ...paths, profile, workspace });
  assert.equal(row.selection.authType, 'user');
  assert.equal(row.selection.accountScope, 'per-root');
  const imported = await importCopilotTranscript(row, { profile, directory: join(root, 'user-import') });
  assert.equal(imported.source.readContext.authType, 'user');
  assert.equal(imported.source.readContext.accountScope, 'per-root');
  assert.equal(JSON.stringify(imported).includes(row.selection.accountToken), false);
});
