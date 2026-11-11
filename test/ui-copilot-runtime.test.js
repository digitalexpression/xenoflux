import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

async function setup(t, { escapedDescendant = false, defaultRuntime = false } = {}) {
  const base = await createUiRunsFixture();
  t.after(() => base.close());
  const { root, repository } = base;
  const executable = join(root, 'copilot-fixture.js');
  await copyFile(nativeFixture('cli.cjs'), executable);
  await copyFile(nativeFixture('events.json'), join(root, 'events.json'));
  await chmod(executable, 0o700);
  const managed = [];
  for (const label of ['Copilot A', 'Copilot B']) {
    const rootPath = join(root, label), configRoot = join(rootPath, 'config'), reviewPath = join(root, label + ' review');
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await mkdir(reviewPath, { mode: 0o700 });
    await writeFile(join(configRoot, 'fixture.json'), JSON.stringify({ label, escapedDescendant }), { mode: 0o600 });
    managed.push({ id: randomUUID(), name: label, client: 'copilot', repositories: [{ path: repository }, { path: reviewPath }],
      native: { root: rootPath, configRoot, rootMode: 'explicit', executable,
        executableIdentity: copilotExecutableIdentity(await lstat(executable)), environmentId: randomUUID(), version: '1.0.107' } });
  }
  const store = { directory: base.store.directory, read: async () => {
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
  const clientRuntimes = defaultRuntime ? { copilot: createCopilotRuntime({ launch: fixtureDefaultLaunch }) } : undefined;
  const accessOptions = { inspectResources: async () => [], processSnapshot: async () => [] };
  const provider = createEngineProvider({ store, defaultUserHome, reportsRoot: base.reportsRoot,
    lockOptions: { lockPath: join(root, 'operation') },
    runContext: { ...base.runContext, profileResolvers, clientRuntimes },
    reviewContext: { profileResolvers, accessOptions, clientRuntimes, lockOptions: { lockPath: join(root, 'operation') } },
    catalogContext: { profileResolvers } });
  t.after(() => provider.close());
  return { ...base, store, provider, managed, defaultRoot };
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
  const { root, owner } = run.state.reservation;
  await assert.rejects(inspectAuditReservation({ root, owner }), /shutdown is uncertain/);
  await assert.rejects(releaseAuditProfileReservation({ root, owner }), /shutdown is uncertain/);
  await assert.rejects(releaseAuditProfileReservation({ root, owner: { ...owner, generation: randomUUID() } }), /durable run owner/);
  assert.equal(JSON.parse(await readFile(join(root, '.run-lock', 'owner.json'), 'utf8')).runId, run.id);
});

test('authenticated Copilot list and import bind opaque tokens to their exact roots', async t => {
  const app = await setup(t);
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
  await writeFile(join(app.managed[1].native.configRoot, 'settings.json'), '{}', { mode: 0o600 });
  assert.equal((await post({ token: a.token }, { token: b.token })).status, 422);
  assert.equal((await post({ token: a.token }, { sessionId: b.sessionId })).status, 422);
  assert.deepEqual(await readdir(join(app.store.directory, 'ui-imports')), retained);
});
