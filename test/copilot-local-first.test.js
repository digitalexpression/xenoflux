import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCopilotRuntime } from '../src/copilot-runtime.js';
import { copilotAccountRoute, resolveCopilotProfile } from '../src/copilot-profile.js';
import { resolveAuditExecutionProfile } from '../src/audit-profile.js';
import { readAuditRecord } from '../src/audit-experiment-store.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { createUiRunsFixture } from '../test-support/ui-runs-fixture.js';

const privateError = 'Copilot PRIVATE_NATIVE_PAYLOAD_DO_NOT_PROJECT';
const peers = new URL('./fixtures/copilot/', import.meta.url);
async function fixture(t, config = {}, workspace) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-copilot-readiness-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'config'), evidence = join(root, 'evidence');
  await mkdir(home, { mode: 0o700 });
  await mkdir(evidence, { mode: 0o700 });
  workspace ??= join(root, 'workspace');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const executable = join(root, 'cli.js');
  const original = await readFile(new URL('cli.cjs', peers), 'utf8');
  const anchor = '  switch (method) {';
  assert.equal(original.split(anchor).length, 2);
  const faults = `  if (config.failureMethod === method) {
    if (config.wrongAuto) return reply({modelId:'auto',autoTier:'other-tier'});
    if (config.wrongManual) return reply({success:false,mode:'assisted'});
    return write({id,error:{code:-32601,message:${JSON.stringify(privateError)}}});
  }
`;
  await writeFile(executable, original.replace(anchor, faults + anchor), { mode: 0o700 });
  await chmod(executable, 0o700);
  await symlink(executable, join(root, 'copilot'));
  await copyFile(new URL(config.capturedMarker ? 'live-marker-events.json' : 'events.json', peers), join(root, 'events.json'));
  await writeFile(join(home, 'fixture.json'), JSON.stringify({ label: 'Readiness fixture', noTools: true, ...config }), { mode: 0o600 });
  const profile = await resolveCopilotProfile({ stored: { id: randomUUID(), name: 'Readiness', client: 'copilot',
    native: { root, configRoot: home, rootMode: 'explicit', executable } }, workspace, bindingRepository: workspace,
    terminalEnvironment: { ...process.env, PATH: root + ':' + process.env.PATH } });
  profile.accountQualification = { authType: 'gh-cli', scope: 'shared', sdk: '1.0.29', rootMode: 'explicit',
    executableIdentity: profile.executableIdentity, runtimeVersion: '1.0.107',
    route: copilotAccountRoute(profile.environmentBinding), expiresAt: Date.now() + 300000 };
  const paths = { stdoutPath: join(evidence, 'native.stdout'), stderrPath: join(evidence, 'native.stderr') };
  const methods = async directory => (await readFile(join(directory ?? evidence, 'fixture-rpc.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line).method);
  return { root, home, evidence, profile, paths, methods };
}

const failures = [
  ['session-create', { failureMethod: 'session.create' }, 'Copilot could not create the owned native session.'],
  ['cwd-confirmation', { wrongCwd: true }, 'Copilot did not confirm the exact working directory.'],
  ['model-confirmation', { failureMethod: 'session.model.getCurrent' }, 'Copilot did not confirm the requested model, effort or route.'],
  ['model-confirmation', { failureMethod: 'session.model.getCurrent', wrongAuto: true }, 'Copilot did not confirm the requested model, effort or route.'],
  ['permission-confirmation', { failureMethod: 'session.permissions.setMode' }, 'Copilot did not confirm the native permission mode.'],
  ['permission-confirmation', { failureMethod: 'session.permissions.setMode', wrongManual: true }, 'Copilot did not confirm the native permission mode.'],
];

test('pre-send readiness failures carry fixed stages, safe reasons and exact joined shutdown', async t => {
  for (const [index, [stage, config, reason]] of failures.entries()) await t.test(stage + ' ' + index, async t => {
    const f = await fixture(t, config), checkpoints = [];
    const result = await createCopilotRuntime().capture({ executionMode: 'profile', profile: f.profile, workspace: f.profile.cwd,
      task: 'Inert fixture prompt.', execution: { model: 'auto', route: 'balance', permissionMode: 'manual' },
      processOptions: { ...f.paths, env: f.profile.env, timeoutMs: 5000 }, onSession: run => { checkpoints.push(run); } });
    assert.equal(result.run.reason, reason);
    assert.equal(result.capture.errors[0].stage, stage);
    assert.equal(result.process.shutdown.sdkStopJoined, true);
    assert.equal(result.process.shutdown.childClosed, true);
    assert.equal(result.process.shutdown.groupTerminated, true);
    assert.equal(result.process.status, 'failed');
    assert.equal(result.response, undefined);
    assert.deepEqual(checkpoints, []);
    assert.equal(JSON.stringify(result).includes(privateError), false);
    assert.equal((await f.methods()).includes('session.send'), false);
    assert.equal((await f.methods()).filter(method => method === 'session.create').length, 1);
  });
});

test('ordinary inherited settings and explicit Auto/manual settings both reach one inert send', async t => {
  for (const execution of [undefined, { model: 'auto', route: 'balance', permissionMode: 'manual' }]) await t.test(execution ? 'explicit' : 'inherited', async t => {
    const f = await fixture(t);
    const result = await createCopilotRuntime().capture({ executionMode: 'profile', profile: f.profile, workspace: f.profile.cwd,
      task: 'Inert fixture prompt.', execution, processOptions: { ...f.paths, env: f.profile.env, timeoutMs: 5000 }, onSession: () => {} });
    assert.equal(result.response.status, 'complete');
    assert.equal(result.process.shutdown.groupTerminated, true);
    assert.equal(result.capture.errors.length, 0);
    assert.equal((await f.methods()).filter(method => method === 'session.send').length, 1);
    assert.equal((await f.methods()).includes('session.permissions.setMode'), !!execution);
  });
});

async function until(action, match) {
  let value;
  for (let index = 0; index < 240; index++) {
    value = await action();
    if (match(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(JSON.stringify(value));
}

test('the normal controller retains a safe model-stage failure and releases a joined comparison', async t => {
  const base = await createUiRunsFixture();
  t.after(() => base.close());
  const f = await fixture(t, { failureMethod: 'session.model.getCurrent' }, base.repository);
  const provider = createEngineProvider({ store: base.store, reportsRoot: base.reportsRoot,
    reviewContext: { resolveProfile: async () => f.profile, recheckProfile: async () => f.profile },
    runContext: { ...base.runContext, resolveProfile: (store, selection, options) => selection.client === 'copilot' ? f.profile
      : resolveAuditExecutionProfile(store, selection, options) } });
  t.after(() => provider.close());
  const preview = await provider.runPreview({ task: 'Inert fixture prompt.', a: 'Readiness', b: 'baseline', clients: { a: 'copilot' },
    repository: base.repository, commit: 'HEAD', checks: [] });
  assert.equal(preview.ready, true, JSON.stringify(preview));
  const started = await provider.startRun({ previewToken: preview.previewToken });
  const done = await until(() => provider.run(started), value => ['failed', 'cannot-tidy', 'finished-partial'].includes(value.state));
  assert.equal(done.state, 'failed', JSON.stringify(done));
  const experiment = await readAuditRecord(base.store, started.id);
  const leg = await readAuditRecord(base.store, experiment.state.runs[0].id);
  assert.equal(leg.report.capture.errors[0].stage, 'model-confirmation');
  assert.equal(leg.report.capture.errors[0].message, failures[2][2]);
  assert.equal(leg.state.nativeShutdownPending, false);
  assert.equal(leg.state.reservation, null);
  assert.equal(JSON.stringify(leg.report).includes(privateError), false);
  assert.equal((await f.methods(leg.directory)).includes('session.send'), false);
  await assert.rejects(lstat(join(f.root, '.run-lock')), { code: 'ENOENT' });
  const ref = 'e.' + started.id;
  const review = await provider.previewReviewTask({ ref, profile: 'Readiness', client: 'copilot', cwd: base.repository });
  const task = await provider.startReviewTask({ ref, previewToken: review.previewToken });
  const failed = await until(() => provider.reviewTask(task), value => ['failed', 'uncertain'].includes(value.status));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, failures[2][2]);
  assert.equal(failed.shutdown.groupTerminated, true);
  const directory = join(base.store.directory, 'review-tasks', task.id);
  const saved = JSON.parse(await readFile(join(directory, 'task.json'), 'utf8'));
  assert.equal(saved.capture.errors[0].stage, 'model-confirmation');
  assert.equal(saved.reservation.status, 'released');
  assert.equal((await f.methods(directory)).includes('session.send'), false);
  assert.equal(JSON.stringify(failed).includes(privateError), false);
  await assert.rejects(lstat(join(f.root, '.run-lock')), { code: 'ENOENT' });
});

test('a fixed cwd failure stage does not imply an unobserved process join', async t => {
  const f = await fixture(t, { wrongCwd: true, escapedDescendant: true });
  const result = await createCopilotRuntime().capture({ executionMode: 'profile', profile: f.profile, workspace: f.profile.cwd,
    task: 'Inert fixture prompt.', processOptions: { ...f.paths, env: f.profile.env, timeoutMs: 5000 },
    onSession: () => assert.fail('No native session checkpoint was received.') });
  assert.equal(result.capture.errors[0].stage, 'cwd-confirmation');
  assert.equal(result.process.shutdown.sdkStopJoined, true);
  assert.equal(result.process.shutdown.childClosed, true);
  assert.equal(result.process.shutdown.groupTerminated, false);
  assert.equal((await f.methods()).includes('session.send'), false);
});

test('a fresh native start confirms cwd even when the session metadata lookup is empty', async t => {
  for (const startBeforeResponse of [false, true]) await t.test(startBeforeResponse ? 'early start' : 'start after create', async t => {
    const f = await fixture(t, { noMetadata: true, startBeforeResponse });
    const result = await createCopilotRuntime().capture({ executionMode: 'profile', profile: f.profile, workspace: f.profile.cwd,
      task: 'Inert fixture prompt.', processOptions: { ...f.paths, env: f.profile.env, timeoutMs: 5000 }, onSession: () => {} });
    assert.equal(result.response.status, 'complete');
    assert.equal(result.process.shutdown.groupTerminated, true);
    const methods = await f.methods();
    assert.equal(methods.includes('session.getMetadata'), false);
    assert.equal(methods.filter(method => method === 'session.send').length, 1);
  });
});

test('missing, child, foreign and duplicate starts cannot confirm the owned cwd', async t => {
  for (const config of [{ noSessionStart: true }, { childSessionStart: true }, { wrongStartSession: true }, { duplicateSessionStart: true }]) {
    await t.test(Object.keys(config)[0], async t => {
      const f = await fixture(t, config), checkpoints = [];
      const result = await createCopilotRuntime().capture({ executionMode: 'profile', profile: f.profile, workspace: f.profile.cwd,
        task: 'Inert fixture prompt.', processOptions: { ...f.paths, env: f.profile.env, timeoutMs: 1200 },
        onSession: run => { checkpoints.push(run); } });
      assert.equal(result.capture.errors[0].stage, 'cwd-confirmation');
      assert.equal(result.process.shutdown.groupTerminated, true);
      assert.equal((await f.methods()).includes('session.send'), false);
      if (config.duplicateSessionStart) {
        assert.ok(checkpoints.every(run => run.nativeReference?.sessionId && run.turns.length === 0));
      } else assert.deepEqual(checkpoints, []);
    });
  }
});

test('captured marker shapes reach normalized replay and a verified root task-end through the pinned SDK', async t => {
  const f = await fixture(t, { capturedMarker: true, noTools: false }), taskEnds = [];
  const result = await createCopilotRuntime().capture({ executionMode: 'profile', profile: f.profile, workspace: f.profile.cwd,
    task: 'Inert fixture prompt.', processOptions: { ...f.paths, env: f.profile.env, timeoutMs: 5000 },
    onSession: () => {}, onTaskEnd: evidence => { taskEnds.push(evidence); } });
  assert.equal(result.response.status, 'complete');
  assert.equal(result.response.text, 'Marker created.');
  assert.equal(result.response.turnId, '1');
  const rows = result.run.sessionReplay.sessions[0].events;
  const response = rows.find(row => row.label === 'Assistant final answer');
  assert.equal(response.body, 'Marker created.');
  assert.equal(response.turnId, null, 'Opaque native turn IDs are not converted into replay UUIDs.');
  assert.equal(rows.at(-1).kind, 'session');
  assert.equal(rows.at(-1).status, 'completed');
  assert.ok(rows.indexOf(response) < rows.length - 1);
  assert.equal(rows.filter(row => row.kind === 'tool-call').length, 1);
  assert.equal(rows.filter(row => row.kind === 'tool-result').length, 1);
  assert.equal(result.run.turns.at(-1).reasoningEffort, 'medium');
  assert.equal(taskEnds[0].complete, true);
  assert.equal(taskEnds[0].childAgentsComplete, false);
  assert.equal((await f.methods()).filter(method => method === 'session.send').length, 1);
});
