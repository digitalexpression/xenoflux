import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClaudeRuntime } from '../src/claude-runtime.js';
import { createClientRuntime } from '../src/client-runtime.js';
import { claudeEnvironment } from '../src/claude-profile.js';
import { resolveProfileExecutionProfile, recheckProfileExecutionProfile } from '../src/audit-profile.js';

const fixturePath = fileURLToPath(new URL('./fixtures/claude-runtime-cli.mjs', import.meta.url));
async function fixture(t, runtimeOptions = {}) {
  const root = await mkdtemp('/private/tmp/xfx-claude-test-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const [home, repo, bin, out] = ['home', 'repo', 'bin', 'out'].map(name => join(root, name));
  for (const dir of [home, repo, bin, out, join(home, '.claude')]) await mkdir(dir, { mode: 0o700 });
  const executable = join(bin, 'claude');
  const fixtureSource = (await readFile(fixturePath, 'utf8')).replace(
    '/* CLAUDE_SANITIZED_NATIVE_FRAMES */ null', await readFile(new URL('./fixtures/claude-sanitized-native.json', import.meta.url), 'utf8'));
  await writeFile(executable, '#!' + await realpath(process.execPath) + '\n' + fixtureSource, { mode: 0o700 });
  const terminalEnvironment = { PATH: bin + ':' + dirname(process.execPath) + ':/usr/bin:/bin', USER: process.env.USER, LOGNAME: process.env.LOGNAME, TZ: 'UTC' };
  const store = { read: async () => ({ profiles: [] }) };
  const options = { repository: repo, defaultUserHome: home, terminalEnvironment, accessOptions: { inspectResources: async () => [] } };
  const profile = await resolveProfileExecutionProfile(store, { name: 'Default', client: 'claude-code' }, options);
  const runtime = createClaudeRuntime(runtimeOptions);
  const capture = createClientRuntime({ runtimes: { 'claude-code': runtime } }).capture;
  return { profile, store, options, repo, home, runtime, capture: (name, details = {}) => capture({ jobId: randomUUID(), executionMode: 'profile',
    profile, workspace: repo, task: name, processOptions: { env: profile.env, timeoutMs: 10000,
      stdoutPath: join(out, name + '.jsonl'), stderrPath: join(out, name + '.stderr'), ...details.processOptions },
    ...Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'processOptions')) }),
  stdout: name => readFile(join(out, name + '.jsonl'), 'utf8'), paths: name => ({ stdoutPath: join(out, name + '.jsonl'), stderrPath: join(out, name + '.stderr') }) };
}

test('Claude implicit and explicit same-path mode stay distinct; preview rejects ambient overrides', async t => {
  const f = await fixture(t);
  assert.equal(f.profile.rootMode, 'implicit');
  assert.equal(f.profile.profileId, 'default-claude-code');
  assert.equal(f.profile.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(claudeEnvironment({}, { ...f.profile, rootMode: 'explicit' }).CLAUDE_CONFIG_DIR, f.profile.home);
  await assert.rejects(resolveProfileExecutionProfile(f.store, { name: 'Default', client: 'claude-code' },
    { ...f.options, terminalEnvironment: { ...f.options.terminalEnvironment, ANTHROPIC_API_KEY: '' } }), { code: 'claude-ambient-override' });
  await assert.doesNotReject(recheckProfileExecutionProfile(f.store, f.profile, f.options));
  await writeFile(join(f.repo, 'CLAUDE.md'), 'changed after preview');
  await assert.rejects(recheckProfileExecutionProfile(f.store, f.profile, f.options), { code: 'profile-settings-changed' });
});

test('pinned SDK waits for process and session checkpoints, preserves absent native turn and effort', async t => {
  const f = await fixture(t), checkpoints = [];
  const result = await f.capture('completion-usage', { execution: { model: 'sonnet', reasoningEffort: 'low', permissionMode: 'plan' },
    processOptions: { onSpawn: () => { checkpoints.push('spawn'); } },
    onProcessReady: () => { checkpoints.push('initialized'); },
    onSession: (run, capture) => {
      assert.equal(run.nativeReference.client, 'claude-code');
      checkpoints.push(capture.checkpoint);
    },
    onTurn: turn => { assert.equal(turn.turnId, null); checkpoints.push('turn'); } });
  assert.equal(result.failure, null, JSON.stringify(result));
  assert.equal(result.response.status, 'complete');
  assert.equal(result.response.text, 'Claude fixture completed.');
  assert.equal(result.run.nativeReference.turnId, null);
  assert.equal(result.capture.settingsEvidence.confirmed.reasoningEffort, null);
  assert.equal(result.capture.settingsEvidence.sent.reasoningEffort, 'low');
  assert.equal(result.capture.settingsEvidence.observed.reasoningEffort, null);
  assert.equal(result.run.usage.observations[0].values.input_tokens, 11);
  assert.equal(result.process.shutdown.groupTerminated, true);
  assert.equal(result.process.shutdown.mainCloseJoined, true);
  assert.deepEqual(checkpoints, ['spawn', 'initialized', 'launch-bound', 'session', 'turn', 'final']);
  assert.doesNotMatch(await f.stdout('completion-usage'), /private-fixture|control_response/);
});

test('catalog never submits a prompt and keeps absent effort capabilities unknown', async t => {
  const f = await fixture(t);
  const result = await f.runtime.discover({ profile: f.profile, workspace: f.repo, ...f.paths('catalog') });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.deepEqual(result.models.map(model => model.effortCapability), ['supported', 'unknown', 'unsupported']);
  assert.equal(await f.stdout('catalog'), '');
  const capture = await f.capture('unknown-effort', { execution: { model: 'haiku', reasoningEffort: 'low' } });
  assert.equal(capture.failure?.code, 'catalog-effort-unavailable');
  assert.equal(await f.stdout('unknown-effort'), '');
});

test('signed out startup and failed durable checkpoint never submit a task', async t => {
  const f = await fixture(t);
  const fail = await f.capture('checkpoint-refusal', { onSession() { throw new Error('fixture persistence failed'); } });
  assert.equal(fail.response.status, 'unavailable');
  assert.equal(await f.stdout('checkpoint-refusal'), '');
  await writeFile(join(f.home, 'fixture-signed-out'), '');
  const signedOut = await f.capture('signed-out');
  assert.equal(signedOut.failure?.code, 'claude-profile-signed-out');
  assert.equal(await f.stdout('signed-out'), '');
});

test('pinned SDK binds several queued approvals to exact current actions and retains advisory child heartbeat', async t => {
  const f = await fixture(t), pending = [];
  const result = await f.capture('queue', { onNativeRequest(request, { item }) {
    assert.equal(item.id, request.params.itemId);
    assert.deepEqual(item.input, request.params.input);
    return new Promise(resolve => {
      pending.push({ request, resolve });
      if (pending.length === 2) {
        pending[1].resolve({ decision: 'decline' }); pending[0].resolve({ decision: 'accept' });
      }
    });
  } });
  assert.equal(result.failure, null, JSON.stringify(result));
  assert.equal(result.response.status, 'complete');
  assert.deepEqual(pending.map(row => row.request.id), ['request-fixture-0', 'request-fixture-1']);
  assert.deepEqual(result.run.toolInvocations.map(row => row.status), ['completed', 'failed']);
  assert.equal(result.run.events.find(row => row.kind === 'claude-advisory-tool-progress').executionProven, false);
  const wrong = await f.capture('mismatch', { onNativeRequest() { assert.fail('unmatched action was offered'); } });
  assert.match(wrong.failure.message, /exact tool action/);
});

for (const mode of ['pending-cancel', 'running-cancel']) test(`${mode} invalidates the answer and joins owned work while the companion completes`, async t => {
  const f = await fixture(t), controller = new AbortController();
  let answer, cancellation;
  const result = f.capture(mode, { processOptions: { signal: controller.signal }, onNativeRequest(_request, { signal }) {
    if (mode === 'running-cancel') {
      const observedAfter = Date.now() + 400;
      cancellation = setInterval(async () => {
        if (Date.now() >= observedAfter && (await f.stdout(mode)).includes('"tool_use_id":"tool-fixture-0","tool_name":"Bash"')) controller.abort();
      }, 15);
      return { decision: 'accept' };
    }
    return new Promise((resolve, reject) => {
      answer = resolve;
      signal.addEventListener('abort', () => reject(new Error('request cancelled')), { once: true });
      controller.abort();
    });
  } });
  const [stopped, companion] = await Promise.all([result, f.capture('companion')]).finally(() => clearInterval(cancellation));
  answer?.({ decision: 'accept' });
  assert.equal(stopped.failure?.code, 'claude-cancelled', JSON.stringify(stopped));
  assert.equal(stopped.process.shutdown.groupTerminated, true, JSON.stringify(stopped));
  assert.equal(stopped.process.shutdown.mainCloseJoined, true);
  assert.equal(stopped.capture.interruption.acknowledged, true);
  if (mode === 'running-cancel') {
    assert.equal(stopped.run.toolInvocations[0].status, 'stopped-while-running');
    assert.ok(stopped.process.shutdown.observedDescendants > 0);
  }
  assert.equal(companion.response.status, 'complete');
  assert.notEqual(companion.run.nativeReference.sessionId, stopped.run.nativeReference.sessionId);
});

test('a late native turn ID is acknowledged and never replaced with a synthetic ID', async t => {
  const f = await fixture(t), turnIds = [];
  const result = await f.capture('late-turn', { onTurn({ turnId }) { turnIds.push(turnId); } });
  assert.equal(result.response.status, 'complete', JSON.stringify(result.failure));
  assert.deepEqual(turnIds, [null, 'opaque-turn-fixture']);
  assert.equal(result.run.nativeReference.turnId, 'opaque-turn-fixture');
  assert.equal(result.run.sessionReplay.sessions[0].events[0].turnId, null);
});

test('cwd and project trust guards stop before sending the task', async t => {
  const wrong = await fixture(t, { readCwd: async () => '/private/tmp' });
  const wrongCwd = await wrong.capture('wrong-cwd');
  assert.match(wrongCwd.failure.message, /working directory/);
  assert.equal(await wrong.stdout('wrong-cwd'), '');
  let trustChecks = 0;
  const changed = await fixture(t, { readTrust: async () => ++trustChecks });
  const changedTrust = await changed.capture('changed-trust');
  assert.match(changedTrust.failure.message, /trust metadata changed/);
  assert.equal(await changed.stdout('changed-trust'), '');
});
