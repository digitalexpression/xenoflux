import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClaudeRuntime, claudeWorkspaceTrust } from '../src/claude-runtime.js';
import { ownClaudeProcess } from '../src/claude-process.js';
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
  assert.equal(result.capture.shutdown.sdkIteratorJoined, true);
  assert.equal(result.capture.shutdown.inputIteratorJoined, true);
  assert.equal(result.capture.shutdown.pendingApprovals, 0);
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

test('captured API-error terminal provenance survives trailing lifecycle rejection without claiming success', async t => {
  for (const name of ['captured-rate-limit', 'captured-rate-limit-no-trailing', 'captured-rate-limit-foreign',
    'captured-rate-limit-work', 'captured-rate-limit-repeat-result']) await t.test(name, async t => {
    const f = await fixture(t);
    let ended;
    const result = await f.capture(name, { onTaskEnd: value => { ended = value; } });
    assert.equal(result.failure?.code, 'claude-native-rate-limit');
    assert.equal(result.failure.message, 'Claude native task failed: rate_limit (HTTP 429)');
    assert.equal(result.run.reason, result.failure.message);
    assert.deepEqual(result.capture.terminalResult, { source: 'claude-sdk-result', subtype: 'success',
      isError: true, assistantError: 'rate_limit', apiErrorStatus: 429 });
    assert.equal(result.run.outcome.nativeTurnStatus, 'failed');
    assert.equal(result.capture.settingsEvidence.observed.model, null);
    assert.equal(result.run.turns[0].model, null);
    assert.notEqual(result.run.outcome.status, 'completed');
    assert.notEqual(result.response.status, 'complete');
    assert.equal(ended.complete, false);
    assert.equal(result.process.shutdown.groupTerminated, true);
    assert.equal(result.process.shutdown.mainCloseJoined, true);
    assert.equal(result.capture.shutdown.groupTerminated, true);
    assert.equal(result.capture.shutdown.sdkIteratorJoined, true);
    assert.equal(result.capture.shutdown.interruptRequested, false);
    assert.equal(result.run.sessionReplay.sessions[0].events.at(-1).status, 'failed');
    assert.ok(result.run.sessionReplay.sessions[0].events.every(event => event.status !== 'completed'));
    const errors = result.capture.errors;
    if (name.endsWith('-no-trailing')) assert.equal(errors.length, 1);
    else {
      assert.equal(errors.length, 2);
      assert.match(errors[1].message, name.endsWith('-foreign') ? /does not match the owned session/ : /after the terminal result/);
    }
  });
});

test('work after a successful terminal still fails the protocol guard', async t => {
  const f = await fixture(t), result = await f.capture('captured-success-work');
  assert.match(result.failure?.message, /after the terminal result/);
  assert.equal(result.capture.terminalResult.isError, false);
  assert.notEqual(result.response.status, 'complete');
  assert.notEqual(result.run.outcome.status, 'completed');
  assert.ok(result.run.sessionReplay.sessions[0].events.every(event => event.status !== 'completed'));
});

test('shutdown projection leaves missing owner observations unknown and excludes private diagnostics', async t => {
  const f = await fixture(t, { processOwner(options) {
    const owner = ownClaudeProcess(options);
    return { ...owner, async stop() {
      const result = await owner.stop();
      return { ...result, shutdown: { groupTerminated: result.shutdown.groupTerminated,
        mainCloseJoined: result.shutdown.mainCloseJoined, observationError: 'private-fixture-diagnostic' } };
    } };
  } });
  const result = await f.capture('companion'), proof = result.capture.shutdown;
  assert.equal(proof.groupTerminated, true);
  assert.equal(proof.sdkIteratorJoined, true);
  assert.equal(proof.observedDescendants, null);
  assert.equal(proof.remainingPids, null);
  assert.equal(proof.escapedDescendantsUnverified, null);
  assert.equal(proof.observationFailed, true);
  assert.equal(proof.interruptAcknowledged, null);
  assert.doesNotMatch(JSON.stringify(proof), /private-fixture|observationError/);
});

test('native startup and hook frames before submission are advisory; model activity and foreign frames stop', async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'fixture-session-hook'), '');
  const catalog = await f.runtime.discover({ profile: f.profile, workspace: f.repo, ...f.paths('hook-catalog') });
  // Positive control: the fixture client really emitted the hook frames.
  assert.match(await f.stdout('hook-catalog'), /hook_started[\s\S]*hook_response[\s\S]*commands_changed/);
  assert.equal(catalog.status, 'ready', JSON.stringify(catalog));
  const done = await f.capture('hook-completion');
  assert.equal(done.failure, null);
  assert.ok(done.run.warnings.includes('claude-native-hook-observed'));
  // Model activity before the prompt is still refused.
  const early = await fixture(t);
  await writeFile(join(early.home, 'fixture-early-assistant'), '');
  const refused = await early.capture('early-assistant');
  assert.match(refused.failure.message, /before the task was submitted/);
  await writeFile(join(f.home, 'fixture-foreign-hook'), '');
  const foreign = await f.runtime.discover({ profile: f.profile, workspace: f.repo, ...f.paths('foreign-hook') });
  assert.equal(foreign.status, 'unavailable');
  assert.equal(foreign.models.length, 0);
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
  assert.equal(stopped.capture.shutdown.groupTerminated, true);
  assert.equal(stopped.capture.shutdown.mainCloseJoined, true);
  assert.equal(stopped.capture.shutdown.sdkIteratorJoined, true);
  assert.equal(stopped.capture.shutdown.inputIteratorJoined, true);
  assert.equal(stopped.capture.shutdown.pendingApprovals, 0);
  assert.equal(stopped.capture.shutdown.interruptRequested, true);
  assert.equal(stopped.capture.shutdown.interruptAcknowledged, true);
  assert.deepEqual(stopped.capture.shutdown.remainingPids, []);
  assert.equal(stopped.run.sessionReplay.sessions[0].events.at(-1).status, 'interrupted');
  assert.ok(stopped.run.sessionReplay.sessions[0].events.every(event => event.status !== 'completed'));
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

test('native state rewrites are not trust or settings changes; a trust flag change is', async t => {
  const { profile, store, options, repo, home, capture } = await fixture(t);
  const state = join(home, '.claude.json');
  const write = (projects, extra) => writeFile(state, JSON.stringify({ numStartups: extra, projects }), { mode: 0o600 });
  const absent = await claudeWorkspaceTrust(profile, repo);
  assert.ok(absent.every(([, accepted]) => accepted === false));

  await write({ [repo]: { hasTrustDialogAccepted: false, lastCost: 1 } }, 1);
  const before = await claudeWorkspaceTrust(profile, repo);
  assert.equal(before.find(([path]) => path === repo)[1], false);
  assert.deepEqual(before, absent);
  // Positive control: the bookkeeping fields really differ between the two files.
  await write({ [repo]: { hasTrustDialogAccepted: false, lastCost: 2 }, '/elsewhere': { hasTrustDialogAccepted: true } }, 2);
  assert.notEqual(JSON.parse(await readFile(state, 'utf8')).numStartups, 1);
  assert.deepEqual(await claudeWorkspaceTrust(profile, repo), before);
  const again = await resolveProfileExecutionProfile(store, { name: 'Default', client: 'claude-code' }, options);
  assert.deepEqual(again.settingsIdentity, profile.settingsIdentity);

  await write({ [repo]: { hasTrustDialogAccepted: true } }, 3);
  assert.equal((await claudeWorkspaceTrust(profile, repo)).find(([path]) => path === repo)[1], true);
  await write({ [dirname(repo)]: { hasTrustDialogAccepted: true } }, 4);
  assert.equal((await claudeWorkspaceTrust(profile, repo)).find(([path]) => path === dirname(repo))[1], true);

  // A real settings source still changes the identity.
  await writeFile(join(home, '.claude', 'settings.json'), '{"model":"changed"}', { mode: 0o600 });
  const changed = await resolveProfileExecutionProfile(store, { name: 'Default', client: 'claude-code' }, options);
  assert.notDeepEqual(changed.settingsIdentity, profile.settingsIdentity);

  await writeFile(state, '{not json', { mode: 0o600 });
  await assert.rejects(claudeWorkspaceTrust(profile, repo), /unreadable/);
  await write({}, 5); await chmod(state, 0o622);
  await assert.rejects(claudeWorkspaceTrust(profile, repo), /unsafe/);
  await chmod(state, 0o600);

  // The fixture client leaves the trust flag alone, so an ordinary task still starts.
  const ordinary = await capture('ordinary-after-state-rewrite');
  assert.equal(ordinary.failure, null);
});

test('only declared shaped startup metadata may precede submission', async t => {
  for (const marker of ['fixture-unknown-startup', 'fixture-startup-invalid-mode', 'fixture-startup-requesting', 'fixture-malformed-commands',
    'fixture-startup-init', 'fixture-startup-task', 'fixture-malformed-hook']) {
    const f = await fixture(t);
    await writeFile(join(f.home, marker), '');
    const result = await f.capture(marker);
    assert.notEqual(result.failure, null, marker);
    assert.equal(result.response.status, 'unavailable', marker);
    assert.equal(result.capture.sessionBinding.status, 'unconfirmed', marker);
  }
});

test('trust projection refuses links, ambiguous flags and unsafe credential-like sources', async t => {
  const f = await fixture(t), state = join(f.home, '.claude.json');
  const credential = join(f.home, 'do-not-read.fixture');
  await writeFile(credential, 'NOT_JSON_CREDENTIAL_SENTINEL', { mode: 0o600 });
  await symlink(credential, state);
  await assert.rejects(claudeWorkspaceTrust(f.profile, f.repo), /unsafe/);
  await rm(state);
  for (const value of [null, [], { projects: [] }, { projects: { [f.repo]: { hasTrustDialogAccepted: 'true' } } }]) {
    await writeFile(state, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(claudeWorkspaceTrust(f.profile, f.repo), /unreadable/);
  }
  await writeFile(state, JSON.stringify({ projects: {}, oauthAccount: { emailAddress: 'PRIVATE_FIXTURE' },
    mcpServers: { fixture: { env: { TOKEN: 'PRIVATE_MCP_VALUE' } } } }), { mode: 0o600 });
  assert.doesNotMatch(JSON.stringify(await claudeWorkspaceTrust(f.profile, f.repo)), /PRIVATE|TOKEN|oauth|mcp/);
});

test('actual inert startup bookkeeping is accepted but a trust grant is refused before submission', async t => {
  const ordinary = await fixture(t);
  await writeFile(join(ordinary.home, 'fixture-native-bookkeeping'), '');
  const result = await ordinary.capture('bookkeeping-only');
  assert.equal(result.failure, null, JSON.stringify(result.failure));
  assert.equal(result.response.status, 'complete');
  assert.equal(JSON.parse(await readFile(join(ordinary.home, '.claude.json'), 'utf8')).numStartups, 2);
  const fresh = await resolveProfileExecutionProfile(ordinary.store, { name: 'Default', client: 'claude-code' }, ordinary.options);
  assert.deepEqual(fresh.settingsIdentity, ordinary.profile.settingsIdentity);
  const changed = await fixture(t);
  await writeFile(join(changed.home, 'fixture-native-trust-change'), '');
  const refused = await changed.capture('startup-trust-change');
  assert.match(refused.failure.message, /trust metadata changed/);
  assert.equal(refused.response.status, 'unavailable');
  assert.equal(await changed.stdout('startup-trust-change'), '');
});

test('trust reads retry a real atomic replacement and never follow a replacement symlink', async t => {
  const f = await fixture(t), state = join(f.home, '.claude.json');
  const encoded = accepted => JSON.stringify({ projects: { [f.repo]: { hasTrustDialogAccepted: accepted } } });
  await writeFile(state, encoded(false), { mode: 0o600 });
  const originalOpen = fsPromises.open;
  let replacements = 0;
  const replace = t.mock.method(fsPromises, 'open', async (...args) => {
    if (args[0] === state && replacements++ === 0) {
      await fsPromises.rename(state, state + '.previous-fixture');
      await writeFile(state, encoded(true), { mode: 0o600 });
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    const flags = await claudeWorkspaceTrust(f.profile, f.repo);
    assert.equal(flags.find(([path]) => path === f.repo)[1], true);
    assert.equal(replacements, 2, 'replacement was observed and retried once');
  } finally { replace.mock.restore(); syncBuiltinESMExports(); }

  const sentinel = join(f.home, 'credential-do-not-open.fixture');
  await writeFile(sentinel, 'PRIVATE_SENTINEL_NOT_JSON', { mode: 0o600 });
  let swapped = false;
  const link = t.mock.method(fsPromises, 'open', async (...args) => {
    if (args[0] === state && !swapped) {
      swapped = true;
      await rm(state);
      await symlink(sentinel, state);
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(claudeWorkspaceTrust(f.profile, f.repo), /unsafe/);
    assert.equal(swapped, true, 'symlink replaced the previously statted regular file');
  } finally { link.mock.restore(); syncBuiltinESMExports(); }
});
