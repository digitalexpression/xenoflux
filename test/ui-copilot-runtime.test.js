import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { createUiRunsFixture } from '../test-support/ui-runs-fixture.js';
import { inspectAuditReservation, readAuditRecord, releaseAuditProfileReservation } from '../src/audit-experiment-store.js';
import { resolveCopilotProfile, copilotAccountRoute, copilotExecutableIdentity } from '../src/copilot-profile.js';
import { createCopilotRuntime } from '../src/copilot-runtime.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { startUiServer } from '../src/ui-server.js';

const nativeFixture = name => new URL(`./fixtures/copilot/${name}`, import.meta.url);
async function waitFor(action, match, label) {
  let value;
  for (let index = 0; index < 240; index++) {
    value = await action();
    if (match(value)) return value;
    await setTimeout(25);
  }
  assert.fail(label + ' ' + JSON.stringify(value));
}

async function setup(t, { wrongCwd = false, escapedDescendant = false, defaultRuntime = false, productRouting = false } = {}) {
  const base = await createUiRunsFixture();
  t.after(() => base.close());
  const { root, repository } = base;
  const executable = join(root, 'copilot-fixture.js');
  await copyFile(nativeFixture('cli.cjs'), executable);
  await copyFile(nativeFixture('events.json'), join(root, 'events.json'));
  await chmod(executable, 0o700);
  await symlink(executable, join(root, 'copilot'));
  const terminalEnvironment = { ...process.env, PATH: root + ':' + process.env.PATH };
  const managed = [], invocationLog = join(root, 'copilot-invocations.jsonl');
  for (const label of ['Copilot A', 'Copilot B']) {
    const rootPath = join(root, label), configRoot = join(rootPath, 'config'), reviewPath = join(root, label + ' review');
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await mkdir(reviewPath, { mode: 0o700 });
    await writeFile(join(configRoot, 'fixture.json'), JSON.stringify({ label, wrongCwd, escapedDescendant, ...(productRouting && { noTools: true, invocationLog }) }), { mode: 0o600 });
    managed.push({ id: randomUUID(), name: label, description: '', revision: 1, client: 'copilot', repositories: [{ path: repository }, { path: reviewPath }],
      native: { root: rootPath, configRoot, rootMode: 'explicit', executable,
        executableIdentity: copilotExecutableIdentity(await lstat(executable)), environmentId: randomUUID(), version: '1.0.107' } });
  }
  if (productRouting) await base.store.update(data => { data.profiles.push(...managed); });
  const store = productRouting ? base.store : { directory: base.store.directory, read: async () => {
    const data = await base.store.read();
    return { ...data, profiles: [...data.profiles, ...managed] };
  } };
  const defaultUserHome = defaultRuntime ? join(root, 'default-user-home') : homedir();
  const defaultRoot = join(defaultUserHome, '.copilot');
  if (defaultRuntime) await mkdir(defaultRoot, { mode: 0o700 });
  const profileResolvers = { copilot: async options => {
    if (!options.selected && defaultRuntime) {
      const profileId = 'default-copilot', cwd = options.repository, executableIdentity = managed[0].native.executableIdentity;
      return { client: 'copilot', surface: 'cli', executionLocation: 'local', profileId, profileName: 'Default',
        home: defaultRoot, reservationRoot: defaultRoot, nativeRoot: null, userHome: defaultUserHome, rootMode: 'implicit',
        cwd, bindingRepository: cwd, executable, executableIdentity, version: null, env: process.env,
        environmentBinding: { roots: { config: defaultRoot, user: defaultUserHome }, workspace: cwd } };
    }
    const profile = await resolveCopilotProfile(options);
    if (options.selected) profile.accountQualification = { scope: 'shared', authType: 'gh-cli', sdk: '1.0.29',
      rootMode: 'explicit', runtimeVersion: '1.0.107', executableIdentity: profile.executableIdentity,
      route: copilotAccountRoute(profile.environmentBinding), expiresAt: Number.MAX_SAFE_INTEGER };
    return profile;
  } };
  const runtime = createCopilotRuntime();
  const reservations = [];
  const clientRuntimes = defaultRuntime ? { copilot: createCopilotRuntime({ launch: fixtureDefaultLaunch }) }
    : productRouting ? { copilot: { ...runtime, async capture(options) {
      const lock = join(options.profile.reservationRoot, '.run-lock', 'owner.json');
      reservations.push(JSON.parse(await readFile(lock, 'utf8')));
      return runtime.capture(options);
    } } } : undefined;
  const accessOptions = { inspectResources: async () => [], processSnapshot: async () => [] };
  const fixtureResolvers = productRouting ? {} : { profileResolvers };
  const fixtureAccounts = new Map();
  // The explicit status launches use the inert SDK CLI. Substitute only the stock account check.
  const accountContext = productRouting ? {
    resolveStockCopilot: async ({ workspace }) => ({ workspace, rootMode: 'implicit', home: defaultRoot, executable,
      executableIdentity: managed[0].native.executableIdentity }),
    readCopilotAccount: async options => {
      if (options.profile.rootMode === 'implicit') {
        const status = fixtureAccounts.get(options.workspace);
        fixtureAccounts.delete(options.workspace);
        return status;
      }
      const status = await runtime.accountStatus(options);
      fixtureAccounts.set(options.workspace, status);
      return status;
    },
  } : undefined;
  const provider = createEngineProvider({ store, defaultUserHome, reportsRoot: base.reportsRoot,
    lockOptions: { lockPath: join(root, 'operation') },
    runContext: { ...base.runContext, terminalEnvironment, ...fixtureResolvers, clientRuntimes },
    reviewContext: { terminalEnvironment, ...fixtureResolvers, accessOptions, clientRuntimes, lockOptions: { lockPath: join(root, 'operation') } },
    catalogContext: { terminalEnvironment, ...fixtureResolvers }, accountContext });
  t.after(() => provider.close());
  return { ...base, store, provider, managed, defaultRoot, invocationLog, reservations };
}

// The implicit stock route is disposable here. Managed cases exercise the
// installed SDK against the actual fake stdio executable instead of this seam.
function fixtureDefaultLaunch({ binding }, receive) {
  assert.equal(binding.profileId, 'default-copilot');
  assert.equal(binding.rootMode, 'implicit');
  const sessionId = randomUUID(), turnId = randomUUID();
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const event = (type, data) => receive({ type: 'event', value: { type, data, id: randomUUID(), timestamp: new Date().toISOString() } });
  queueMicrotask(() => receive({ id: 1, type: 'session', value: { sessionId, version: 'fixture',
    selection: {}, confirmed: { model: 'auto', route: 'balance' } } }, reply => {
    if (reply.error) return finish({ failure: 'fixture checkpoint refused', output: {}, shutdown: { groupTerminated: true } });
    event('assistant.turn_start', { turnId });
    event('assistant.message', { turnId, phase: 'final_answer', content: 'Default fixture answer.', model: 'fixture-default-route' });
    event('assistant.turn_end', { turnId });
    event('session.idle', { mode: 'interactive' });
  }));
  return { result, send: message => {
    if (message.done || message.cancel) finish({ result: message.done ? { completed: true } : null,
      shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } });
  } };
}

const compareInput = (app, a = 'Copilot A') => ({ task: 'Use the disposable fixture.', a, b: 'baseline',
  clients: { a: 'copilot' }, repository: app.repository, commit: 'HEAD', checks: [] });
const terminalRun = value => ['finished', 'finished-partial', 'failed', 'cannot-tidy', 'cancelled'].includes(value.state);
async function startComparison(app, input) {
  const preview = await app.provider.runPreview(input);
  assert.equal(preview.ready, true, JSON.stringify(preview));
  return app.provider.startRun({ previewToken: preview.previewToken });
}
async function answerPair(ask, waiting, respond) {
  const value = await waitFor(ask, waiting, 'Queued permissions were not presented');
  assert.deepEqual(value.pendingRequests.map(request => request.params.category), ['path', 'commands']);
  assert.equal(value.pendingRequests[0].params.itemId, value.pendingRequests[1].params.itemId);
  const [path, command] = value.pendingRequests;
  assert.notEqual(path.requestId, command.requestId);
  await assert.rejects(respond(command.requestId, { kind: 'reject' }), error => error.status === 409);
  await assert.rejects(respond(path.requestId, { kind: 'approve-for-session' }), error => error.status === 400);
  await respond(path.requestId, { kind: 'approve-once' });
  await assert.rejects(respond(path.requestId, { kind: 'approve-once' }), error => error.status === 409);
  await respond(command.requestId, { kind: 'reject' });
}

test('Copilot Default reaches the normal controller with an implicit client-qualified binding', async t => {
  const app = await setup(t, { defaultRuntime: true });
  const started = await startComparison(app, compareInput(app, 'Default'));
  const finished = await waitFor(() => app.provider.run(started), terminalRun, 'Default comparison');
  assert.equal(finished.state, 'finished-partial', JSON.stringify(finished));
  const report = await app.provider.report({ ref: 'e.' + started.id });
  assert.match(JSON.stringify(report), /Default fixture answer/);
  await assert.rejects(lstat(join(app.defaultRoot, '.run-lock')), { code: 'ENOENT' });
});

test('managed Copilot refresh, comparison and independently owned reviews use the normal controller', async t => {
  const app = await setup(t);
  const chosen = { profile: 'Copilot A', client: 'copilot', workspace: app.repository };
  const catalog = await app.provider.refreshCatalog({ ...chosen, requestId: randomUUID() });
  assert.equal(catalog.status, 'ready', JSON.stringify(catalog));
  assert.equal(catalog.models.length, 0);
  assert.equal(catalog.auto.defaultTier, 'balance');
  assert.equal(catalog.process.shutdown.groupTerminated, true);
  assert.equal((await app.provider.catalog(chosen)).scope.environmentBinding.profileId, app.managed[0].id);
  await assert.rejects(app.provider.runPreview({ ...compareInput(app), execution: { a: { model: 'auto', route: 'fast' } } }),
    error => error.code === 'catalog-model-unavailable');
  const started = await startComparison(app, { ...compareInput(app), checks: [{ name: 'fixture check', command: 'true' }],
    execution: { a: { model: 'auto', route: 'balance', permissionMode: 'manual' } } });
  await answerPair(() => app.provider.run(started), value => value.pendingRequests.length === 2,
    (requestId, response) => app.provider.respondRun({ ...started, requestId, response }));
  const finished = await waitFor(() => app.provider.run(started), terminalRun, 'Managed comparison');
  assert.equal(finished.state, 'finished-partial', JSON.stringify(finished));
  assert.equal(app.calls.checks.length, 2);
  const ref = 'e.' + started.id;
  const report = await app.provider.report({ ref });
  assert.match(JSON.stringify(report), /Synthetic final answer/);
  const experiment = await readAuditRecord(app.store, started.id);
  const first = await readAuditRecord(app.store, experiment.state.runs[0].id);
  assert.equal(first.report.settingsEvidence.observed.model, 'fixture-routed-model');
  assert.equal(first.report.settingsEvidence.sent.model, 'auto');
  assert.equal(first.report.settingsEvidence.confirmed.permissionMode, 'manual');
  assert.equal(first.report.coverage.skills, 'unavailable');
  const replay = first.report.sessionReplay.sessions[0].events;
  assert.equal(replay.at(-1).kind, 'session');
  assert.equal(replay.at(-1).status, 'completed');
  assert.ok(replay.some(event => event.label === 'Assistant final answer'));
  assert.equal(first.report.taskEnd.captureComplete, true);
  assert.equal(first.report.taskEnd.timing, 'task-end');
  assert.equal(first.report.coverage.agents, 'partial');
  assert.equal(first.report.capture.shutdown.groupTerminated, true);
  assert.equal(first.report.capture.shutdown.sdkStopJoined, true);
  assert.equal(first.report.capture.shutdown.childClosed, true);
  assert.equal(first.report.capture.shutdown.abortAcknowledged, false);
  assert.equal(first.report.capture.shutdown.nativeAbortedIdle, false);
  assert.equal(first.report.capture.shutdown.ancestryCoverage, 'sampled');
  assert.equal(first.report.capture.shutdown.ancestryUncertain, false);
  assert.ok(first.report.capture.shutdown.trackedProcesses >= 1);
  assert.notEqual(first.report.environmentBinding.workspace, app.repository);

  const startReview = async profile => {
    const preview = await app.provider.previewReviewTask({ ref, profile: profile.name, client: 'copilot', cwd: profile.repositories[1].path });
    return app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  };
  const [cancelled, survivor] = await Promise.all(app.managed.map(startReview));
  const isWaiting = value => value.pendingRequests.length === 2;
  const abandoned = await waitFor(() => app.provider.reviewTask(cancelled), isWaiting, 'Cancelled review queue');
  await waitFor(() => app.provider.reviewTask(survivor), isWaiting, 'Surviving review queue');
  const stopped = await app.provider.cancelReviewTask(cancelled);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.shutdown.abortAcknowledged, true);
  assert.equal(stopped.shutdown.nativeAbortedIdle, true);
  assert.equal(stopped.shutdown.sdkStopJoined, true);
  await assert.rejects(app.provider.respondReviewTask({ ...cancelled, requestId: abandoned.pendingRequests[0].requestId, response: { kind: 'approve-once' } }),
    error => error.status === 409);
  await answerPair(() => app.provider.reviewTask(survivor), isWaiting,
    (requestId, response) => app.provider.respondReviewTask({ ...survivor, requestId, response }));
  const done = await waitFor(() => app.provider.reviewTask(survivor), value => value.status === 'completed', 'Surviving Copilot review');
  assert.equal(done.response.text, 'Synthetic final answer.');
  assert.equal(done.settingsEvidence.observed.model, 'fixture-routed-model');
  assert.equal(done.shutdown.groupTerminated, true);
  const log = await readFile(join(app.store.directory, 'review-tasks', cancelled.id, 'fixture-rpc.jsonl'), 'utf8');
  const methods = log.trim().split('\n').map(line => JSON.parse(line).method);
  assert.ok(methods.indexOf('session.abort') < methods.indexOf('session.detach'));
  assert.equal(methods.includes('session.permissions.handlePendingPermissionRequest'), false);
});

test('two persisted Copilot profiles reserve the requested repository and launch in separate owned checkouts', async t => {
  const app = await setup(t, { productRouting: true });
  for (const { name } of app.managed) {
    const account = await app.provider.profileAccount({ name, client: 'copilot' });
    assert.equal(account.accountScope, 'shared');
  }
  const launched = async () => (await readFile(app.invocationLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const before = await launched();
  assert.equal(before.length, 2, 'only the two explicit fixture status processes have launched');
  const input = { ...compareInput(app), b: 'Copilot B', clients: { a: 'copilot', b: 'copilot' } };
  const started = await startComparison(app, input);
  const finished = await waitFor(() => app.provider.run(started), terminalRun, 'Two managed Copilot profiles');
  assert.equal(finished.state, 'finished-partial', JSON.stringify(finished));

  const experiment = await readAuditRecord(app.store, started.id);
  const legs = await Promise.all(experiment.state.runs.map(run => readAuditRecord(app.store, run.id)));
  const captures = (await launched()).slice(before.length);
  assert.equal(legs.length, 2);
  assert.equal(captures.length, 2);
  assert.equal(app.reservations.length, 2);
  assert.notEqual(captures[0].workspace, captures[1].workspace);
  for (const [index, leg] of legs.entries()) {
    const { native, id } = app.managed[index];
    assert.equal(leg.record.profile.bindingRepository, app.repository);
    assert.equal(app.reservations[index].binding.workspace, app.repository);
    assert.equal(app.reservations[index].profileId, id);
    assert.equal(app.reservations[index].runId, leg.record.id);
    assert.equal(leg.state.reservation, null);
    assert.equal(leg.report.environmentBinding.workspace, leg.state.workspace.directory);
    assert.deepEqual(captures[index], { workspace: leg.state.workspace.directory, home: homedir(), root: native.configRoot });
    assert.notEqual(captures[index].workspace, app.repository);
    await assert.rejects(lstat(join(native.root, '.run-lock')), { code: 'ENOENT' });
  }

  const [left] = app.managed;
  const listed = await app.provider.copilotSessions({ profile: left.name });
  assert.equal(listed.sessions.length, 1);
  assert.equal((await launched()).at(-1).workspace, app.repository);
  const reviewCwd = left.repositories[1].path;
  const review = await app.provider.previewReviewTask({ ref: 'e.' + started.id, profile: left.name, client: 'copilot', cwd: reviewCwd });
  const reviewStarted = await app.provider.startReviewTask({ ref: 'e.' + started.id, previewToken: review.previewToken });
  const completed = await waitFor(() => app.provider.reviewTask(reviewStarted), value => value.status === 'completed', 'Managed review');
  assert.equal(completed.shutdown.groupTerminated, true);
  assert.equal((await launched()).at(-1).workspace, reviewCwd);

  await app.store.update(data => {
    data.profiles.find(profile => profile.id === app.managed[1].id).repositories.shift();
  });
  const priorLaunches = await launched();
  const blocked = await app.provider.runPreview(input);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.previewToken, null);
  assert.match(blocked.blocked.reason, /Copilot B: The selected repository is not already bound/);
  assert.deepEqual(await launched(), priorLaunches);
  for (const { native } of app.managed)
    await assert.rejects(lstat(join(native.root, '.run-lock')), { code: 'ENOENT' });
});

test('uncertain Copilot shutdown leaves the exact reservation and skips verification checks', async t => {
  const app = await setup(t, { escapedDescendant: true });
  const started = await startComparison(app, { ...compareInput(app), checks: [{ name: 'fixture check', command: 'true' }] });
  await waitFor(() => app.provider.run(started), value => value.pendingRequests.length === 2, 'Uncertain fixture queue');
  await setTimeout(350);
  await answerPair(() => app.provider.run(started), value => value.pendingRequests.length === 2,
    (requestId, response) => app.provider.respondRun({ ...started, requestId, response }));
  const done = await waitFor(() => app.provider.run(started), terminalRun, 'Uncertain Copilot comparison');
  assert.equal(done.state, 'cannot-tidy', JSON.stringify(done));
  assert.deepEqual(app.calls.checks, []);
  const experiment = await readAuditRecord(app.store, started.id);
  const run = await readAuditRecord(app.store, experiment.state.runs[0].id);
  assert.equal(run.state.nativeShutdownPending, true);
  assert.equal(run.state.workspace.active, true);
  assert.equal(run.report, null);
  assert.equal(run.captureCheckpoint.capture.checkpoint, 'final');
  assert.equal(run.captureCheckpoint.capture.shutdown.groupTerminated, false);
  assert.equal(run.captureCheckpoint.capture.shutdown.sdkStopJoined, true);
  assert.equal(run.captureCheckpoint.capture.shutdown.childClosed, true);
  assert.equal(run.captureCheckpoint.capture.shutdown.ancestryCoverage, 'sampled');
  assert.equal(run.captureCheckpoint.capture.shutdown.ancestryUncertain, true);
  assert.ok(run.captureCheckpoint.capture.shutdown.trackedProcesses >= 2);
  const { root, owner } = run.state.reservation;
  await assert.rejects(inspectAuditReservation({ root, owner }), /shutdown is uncertain/);
  await assert.rejects(releaseAuditProfileReservation({ root, owner }), /shutdown is uncertain/);
  await assert.rejects(releaseAuditProfileReservation({ root, owner: { ...owner, generation: randomUUID() } }), /durable run owner/);
  assert.equal(JSON.parse(await readFile(join(root, '.run-lock', 'owner.json'), 'utf8')).runId, run.id);
});


async function assertNoCopilotSend(directory) {
  const log = await readFile(join(directory, 'fixture-rpc.jsonl'), 'utf8');
  const methods = log.trim().split('\n').map(line => JSON.parse(line).method);
  assert.equal(methods.filter(method => method === 'session.create').length, 1);
  assert.equal(methods.filter(method => method === 'session.send').length, 0);
  assert.ok(methods.includes('runtime.shutdown'));
}

test('joined Copilot failure before the session checkpoint releases the comparison reservation', async t => {
  const app = await setup(t, { wrongCwd: true });
  const started = await startComparison(app, compareInput(app));
  const done = await waitFor(() => app.provider.run(started), terminalRun, 'Joined pre-session failure');
  assert.equal(done.state, 'failed', JSON.stringify(done));
  const experiment = await readAuditRecord(app.store, started.id);
  const leg = await readAuditRecord(app.store, experiment.state.runs[0].id);
  assert.equal(leg.state.nativeShutdownPending, false);
  assert.equal(leg.state.reservation, null);
  assert.equal(leg.captureCheckpoint ?? null, null);
  assert.match(leg.report.capture.errors[0].message, /exact working directory/);
  await assertNoCopilotSend(leg.directory);
  await assert.rejects(lstat(join(app.managed[0].native.root, '.run-lock')), { code: 'ENOENT' });
});

test('unjoined Copilot failure before the session checkpoint preserves comparison ownership', async t => {
  const app = await setup(t, { wrongCwd: true, escapedDescendant: true });
  const started = await startComparison(app, { ...compareInput(app), checks: [{ name: 'fixture check', command: 'true' }] });
  const done = await waitFor(() => app.provider.run(started), terminalRun, 'Unjoined pre-session failure');
  assert.equal(done.state, 'cannot-tidy', JSON.stringify(done));
  assert.deepEqual(app.calls.checks, []);
  const experiment = await readAuditRecord(app.store, started.id);
  const leg = await readAuditRecord(app.store, experiment.state.runs[0].id);
  assert.equal(leg.state.phase, 'process-shutdown');
  assert.equal(leg.state.nativeShutdownPending, true);
  assert.equal(leg.state.workspace.active, true);
  assert.equal(leg.captureCheckpoint ?? null, null);
  await assertNoCopilotSend(leg.directory);
  await assert.rejects(releaseAuditProfileReservation(leg.state.reservation), /shutdown is uncertain/);
});

test('joined Copilot failure before the session checkpoint remains a failed ordinary review', async t => {
  const app = await setup(t, { wrongCwd: true });
  const comparison = await startComparison(app, { ...compareInput(app, 'strict-review'), clients: {} });
  await waitFor(() => app.provider.run(comparison), terminalRun, 'Review source');
  const ref = 'e.' + comparison.id, [profile] = app.managed;
  const preview = await app.provider.previewReviewTask({ ref, profile: profile.name, client: 'copilot', cwd: profile.repositories[1].path });
  const started = await app.provider.startReviewTask({ ref, previewToken: preview.previewToken });
  const task = await waitFor(() => app.provider.reviewTask(started), value => ['failed', 'uncertain'].includes(value.status), 'Pre-session review');
  assert.equal(task.status, 'failed');
  assert.equal(task.threadId, null);
  assert.equal(task.nativeReference?.sessionId ?? null, null);
  assert.match(task.error, /exact working directory/);
  assert.equal(task.shutdown.groupTerminated, true);
  assert.equal(task.shutdown.sdkStopJoined, true);
  await assertNoCopilotSend(join(app.store.directory, 'review-tasks', started.id));
  await assert.rejects(lstat(join(profile.native.root, '.run-lock')), { code: 'ENOENT' });
});

test('authenticated Copilot list and import bind opaque tokens to their exact roots and workspaces', async t => {
  const app = await setup(t);
  const invocationLog = join(app.root, 'metadata-invocations.jsonl');
  const launches = async () => (await readFile(invocationLog, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const profile of app.managed) {
    profile.repositories.reverse();
    await writeFile(join(profile.native.configRoot, 'fixture.json'), JSON.stringify({ label: profile.name, invocationLog }), { mode: 0o600 });
  }
  const server = await startUiServer({ provider: app.provider, staticRoot: join(process.cwd(), 'dist', 'ui'), launchToken: 'copilot-route-fixture-token' });
  t.after(() => server.close());
  const headers = { origin: server.origin, 'content-type': 'application/json', 'x-xenoflux-request': '1' };
  const login = await fetch(server.origin + '/api/session', { method: 'POST', headers, body: JSON.stringify({ token: 'copilot-route-fixture-token' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const list = (profile, auth = cookie) => fetch(server.origin + '/api/sessions/copilot?profile=' + encodeURIComponent(profile),
    { headers: { ...headers, ...(auth ? { cookie: auth } : {}) } });
  assert.equal((await list('Copilot A', '')).status, 401);
  const [a, b] = await Promise.all(app.managed.map(async profile => {
    const response = await list(profile.name);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).sessions[0];
  }));
  assert.equal(a.sessionId, b.sessionId);
  assert.notEqual(a.token, b.token);
  assert.equal(Object.hasOwn(a, 'selection'), false);
  const post = (left, right) => fetch(server.origin + '/api/reports/import/copilot',
    { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ left, right }) });
  const imported = await post({ token: a.token }, { token: b.token });
  assert.equal(imported.status, 200, await imported.clone().text());
  const report = await app.provider.report({ ref: (await imported.json()).ref });
  assert.match(JSON.stringify(report), /Copilot A/);
  assert.match(JSON.stringify(report), /Copilot B/);
  const retained = await readdir(join(app.store.directory, 'ui-imports'));
  const expected = app.managed.flatMap(profile => Array.from({ length: 2 }, () => ({
    workspace: profile.repositories[0].path, home: homedir(), root: profile.native.configRoot,
  })));
  const order = rows => rows.map(row => JSON.stringify(row)).sort();
  assert.deepEqual(order(await launches()), order(expected));

  const [first, second] = app.managed.map(profile => profile.repositories[0].path);
  const backup = first + ' original';
  await rename(first, backup);
  await mkdir(first, { mode: 0o700 });
  assert.equal((await post({ token: a.token }, { token: b.token })).status, 422);
  assert.deepEqual(order(await launches()), order(expected));
  await rmdir(first);
  await symlink(second, first);
  assert.equal((await list('Copilot A')).status, 422);
  assert.deepEqual(order(await launches()), order(expected));
  await unlink(first);
  await rename(backup, first);

  const firstBinding = app.managed[0].repositories.shift();
  assert.equal((await post({ token: a.token }, { token: b.token })).status, 422);
  assert.deepEqual(order(await launches()), order(expected));
  const lastBinding = app.managed[0].repositories.pop();
  assert.equal((await list('Copilot A')).status, 422);
  assert.deepEqual(order(await launches()), order(expected));
  app.managed[0].repositories.push(firstBinding, lastBinding);

  await writeFile(join(app.managed[1].native.configRoot, 'settings.json'), '{}', { mode: 0o600 });
  assert.equal((await post({ token: a.token }, { token: b.token })).status, 422);
  assert.equal((await post({ token: a.token }, { sessionId: b.sessionId })).status, 422);
  assert.deepEqual(await readdir(join(app.store.directory, 'ui-imports')), retained);
});
