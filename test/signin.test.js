import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSigninDecoder, runSigninProcess } from '../src/signin-process.js';
import { acquireCopilotAccount } from '../src/copilot-account-lock.js';
import { managedNativeProfiles } from '../src/managed-native-profile.js';
import { createUiSignins } from '../src/ui-signins.js';
import { Store } from '../src/profiles.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { startUiServer } from '../src/ui-server.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-signin-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function done(manager, id) {
  for (let i = 0; i < 200; i++) {
    const result = manager.get({ id });
    if (!['starting', 'waiting-for-browser', 'verifying'].includes(result.state)) return result;
    await delay(20);
  }
  throw new Error('Sign-in fixture did not settle');
}

test('sign-in decoding retains split vendor hyperlinks and device codes without exposing arbitrary output or credentials', () => {
  const claude = [], github = [];
  const decode = createSigninDecoder('claude-code', value => claude.push(value));
  const url = 'https://claude.ai/oauth/authorize?code=true&state=fixture';
  for (const part of ['\x1b]8;;https://claude.ai/oauth/', 'authorize?code=true&state=fixture\x1b\\', url, '\x1b]8;;\x1b\\\n']) decode(part);
  assert.deepEqual(claude.at(-1), { state: 'waiting-for-browser' });
  for (const origin of ['https://claude.com/cai', 'https://platform.claude.com']) {
    const current = [];
    const decodeCurrent = createSigninDecoder('claude-code', value => current.push(value));
    decodeCurrent('Opening browser to sign in…\n' + origin + '/oauth/');
    decodeCurrent('authorize?code=true&state=fixture&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback\n');
    assert.deepEqual(current.at(-1), { state: 'waiting-for-browser' });
  }
  const gh = createSigninDecoder('copilot', value => github.push(value));
  gh('\x1b[33m! First copy your one-time co'); gh('de: ABCD-'); gh('1234\x1b[0m\nOpen this URL: https://github.com/login/device\n');
  assert.deepEqual(github.at(-1), { browserUrl: 'https://github.com/login/device', deviceCode: 'ABCD-1234' });
  for (const bad of ['https://evil.test/oauth/authorize', 'https://claude.ai.evil.test/oauth/authorize',
    'https://claude.ai/oauth/authorize?access_token=secret', 'https://claude.ai/oauth/authorize?code=credential',
    'https://claude.ai/oauth/authorize#token', 'https://claude.com/cai/oauth/authorize?code=credential',
    'https://platform.claude.com/oauth/authorize?token=secret', 'https://claude.com/cai/oauth/token']) {
    const output = [];
    createSigninDecoder('claude-code', value => output.push(value))(bad + '\n');
    assert.deepEqual(output, []);
  }
  assert.equal(JSON.stringify([...claude, ...github]).includes('secret'), false);
});

test('owned sign-in process streams instructions, bounds output, and joins cancellation and timeout', async t => {
  const root = await temporary(t);
  const script = join(root, 'login.js');
  await writeFile(script, "process.stderr.write('! First copy your one-time code: ABCD-1234\\nhttps://github.com/login/device\\n'); setInterval(() => {}, 1000);");
  for (const mode of ['cancel', 'timeout']) {
    const controller = new AbortController(), progress = [];
    let identity;
    const result = runSigninProcess({ executable: process.execPath, args: [script], cwd: root, env: { PATH: '/usr/bin:/bin' }, client: 'copilot',
      signal: controller.signal, timeoutMs: mode === 'timeout' ? 150 : 10000,
      onSpawn: value => { identity = value; }, onProgress: value => { progress.push(value); if (mode === 'cancel') controller.abort(); } });
    const receipt = await result;
    assert.equal(receipt.status, mode === 'cancel' ? 'cancelled' : 'timeout');
    assert.equal(receipt.shutdown.groupTerminated, true);
    assert.equal(progress.at(-1).deviceCode, 'ABCD-1234');
    if (identity) assert.throws(() => process.kill(identity.pid, 0), { code: 'ESRCH' });
  }
  await writeFile(script, "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000);");
  const bounded = await runSigninProcess({ executable: process.execPath, args: [script], cwd: root,
    env: {}, client: 'claude-code', timeoutMs: 10000 });
  assert.equal(bounded.status, 'output-limit');
  assert.equal(bounded.shutdown.groupTerminated, true);
});

test('shared Copilot account excludes sign-in across independent readers and supports its own verification', async t => {
  const home = await temporary(t);
  const a = await acquireCopilotAccount(home), b = await acquireCopilotAccount(home);
  await a.run(async () => {
    const nested = await acquireCopilotAccount(home);
    assert.notEqual(nested.reference.path, a.reference.path);
    await assert.rejects(acquireCopilotAccount(home, { exclusive: true }), { code: 'copilot-account-busy' });
    await nested.release();
  });
  await assert.rejects(acquireCopilotAccount(home, { exclusive: true }), { code: 'copilot-account-busy' });
  await a.release(); await b.release();
  const writer = await acquireCopilotAccount(home, { exclusive: true });
  await assert.rejects(acquireCopilotAccount(home), { code: 'copilot-account-busy' });
  await writer.run(async () => { const check = await acquireCopilotAccount(home); await check.release(); });
  await writer.release();
  const after = await acquireCopilotAccount(home); await after.release();
});

test('a dead coordinator cannot erase an explicit unjoined shared account receipt', async t => {
  const home = await temporary(t), reader = await acquireCopilotAccount(home);
  t.after(async () => { if (await lstat(reader.reference.path).catch(() => null)) await reader.release(); });
  await reader.checkpoint({ pid: 2147483646, spawnIntent: true,
    processIdentity: { pid: 2147483646, started: 'fixture-start', command: process.execPath, host: hostname() },
    shutdown: { groupTerminated: false, childrenClosed: false } });
  await assert.rejects(acquireCopilotAccount(home, { exclusive: true }).then(async unexpected => {
    await unexpected.release();
    return unexpected;
  }), { code: 'copilot-account-busy' });
  assert.equal(JSON.parse(await readFile(join(reader.reference.path, 'owner.json'), 'utf8')).shutdown.groupTerminated, false);
});

async function claudeFixture(t, mode = 'success') {
  const root = await temporary(t), executable = join(root, 'claude');
  const marker = join(root, 'signed-in'), log = join(root, 'log');
  await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$*" = --version ]; then printf '2.1.319 (Claude Code)\\n'; exit; fi
if [ "$*" = 'auth login --claudeai' ]; then
  printf 'https://claude.com/cai/oauth/authorize?state=fixture\\n'
  ${mode === 'success' ? `touch '${marker}'` : mode === 'hang' ? 'exec /bin/sleep 30' : mode === 'failure' ? 'exit 2' : ':'}
  exit
fi
if [ "$*" = 'auth status' ]; then
  if [ -f '${marker}' ]; then printf '{"loggedIn":true,"authMethod":"claude.ai"}\\n'; exit; fi
  printf '{"loggedIn":false}\\n'; exit 1
fi
exit 88
`, { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  const native = managedNativeProfiles({ store, profilesBase: join(root, 'profiles'), defaultUserHome: root,
    terminalEnvironment: { PATH: root + ':/usr/bin:/bin', USER: process.env.USER, LOGNAME: process.env.LOGNAME },
    lockOptions: { lockPath: join(root, 'operation') }, signinTimeoutMs: 1500 });
  const selected = await native.createProfile('Claude fixture', 'claude-code', await native.binary('claude-code'));
  const manager = createUiSignins({ nativeProfiles: native, select: async () => selected, browser: async () => assert.fail('Claude owns its browser'), invalidate: () => {} });
  t.after(() => manager.close());
  return { native, selected, manager, log, marker, root, store, executable };
}

test('native Claude sign-in stays profile-bound and verifies automatically before success', async t => {
  const { manager, selected, log } = await claudeFixture(t);
  const attempt = await manager.start({ name: selected.name });
  const result = await done(manager, attempt.id);
  assert.equal(result.state, 'completed');
  assert.equal(result.accountScope, 'per-root');
  assert.equal(await readFile(log, 'utf8'), '--version\nauth login --claudeai\nauth status\n');
  await assert.rejects(lstat(join(selected.native.root, '.run-lock')), { code: 'ENOENT' });
  assert.equal(JSON.stringify(result).includes('processIdentity'), false);
});

test('Claude keeps its last checked sign-in after Copilot invalidation and freshness expiry without granting admission', async t => {
  const { manager, native, selected } = await claudeFixture(t);
  assert.equal((await done(manager, (await manager.start({ name: selected.name })).id)).state, 'completed');
  const profile = await native.resolveProfile('claude-code', selected);
  native.invalidate('copilot');
  assert.equal((await native.observed(profile)).state, 'signed-in');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 6 * 60 * 1000);
  assert.equal(await native.observed(profile), null);
  const display = await native.observed(profile, { forDisplay: true });
  assert.equal(display.state, 'signed-in');
  assert.equal(display.stale, true);
  assert.equal(display.qualification, null);
  native.invalidate('claude-code');
  assert.equal(await native.observed(profile, { forDisplay: true }), null);
});

test('a profile reservation that prevents a check leaves the last verified sign-in visible', async t => {
  const { native, selected, log, marker } = await claudeFixture(t);
  await writeFile(marker, '');
  assert.equal((await native.check(selected.name, selected.client)).state, 'signed-in');
  const profile = await native.resolveProfile(selected.client, selected);
  await mkdir(join(selected.native.root, '.run-lock'), { mode: 0o700 });

  await assert.rejects(native.check(selected.name, selected.client), /Desktop or CLI run is locked/);
  assert.equal(await readFile(log, 'utf8'), '--version\nauth status\n');
  assert.equal((await native.observed(profile, { forDisplay: true }))?.state, 'signed-in');
});

test('native sign-in exit zero is insufficient and cancellation releases the profile', async t => {
  const failed = await claudeFixture(t, 'signed-out');
  const attempt = await failed.manager.start({ name: failed.selected.name });
  assert.equal((await done(failed.manager, attempt.id)).state, 'failed');
  assert.match((await done(failed.manager, attempt.id)).message, /could not be verified/);
  const hanging = await claudeFixture(t, 'hang');
  const started = await hanging.manager.start({ name: hanging.selected.name });
  assert.equal((await hanging.manager.start({ name: hanging.selected.name })).id, started.id);
  while (hanging.manager.get({ id: started.id }).state === 'starting') await delay(10);
  assert.equal(hanging.manager.get({ id: started.id }).state, 'waiting-for-browser');
  assert.equal(hanging.manager.get({ id: started.id }).browserUrl, undefined);
  assert.equal((await hanging.manager.cancel({ id: started.id })).state, 'cancelled');
  await assert.rejects(lstat(join(hanging.selected.native.root, '.run-lock')), { code: 'ENOENT' });
});

test('the authenticated UI starts browser sign-in and publishes only automatically verified account state', async t => {
  const fixture = await claudeFixture(t);
  const provider = createEngineProvider({ store: fixture.store, defaultUserHome: fixture.root,
    profilesBase: join(fixture.root, 'profiles'), reportsRoot: join(fixture.root, 'reports'),
    runContext: { terminalEnvironment: { PATH: fixture.root + ':/usr/bin:/bin', USER: process.env.USER, LOGNAME: process.env.LOGNAME } },
    lockOptions: { lockPath: join(fixture.root, 'operation') },
    clientOps: { openTerminal: async () => assert.fail('Sign-in must not open Terminal') },
  });
  const server = await startUiServer({ provider, launchToken: 'signin-fixture' });
  t.after(async () => { await provider.close(); await server.close(); });
  const headers = { origin: server.origin, 'content-type': 'application/json', 'x-xenoflux-request': '1' };
  const post = (path, body = {}) => fetch(server.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const login = await post('/api/session', { token: 'signin-fixture' });
  headers.cookie = login.headers.get('set-cookie').split(';')[0];
  const assertAccountCard = async (signIn, actions) => {
    const cards = await (await fetch(server.origin + '/api/profiles', { headers })).json();
    const card = cards.profiles.find(row => row.name === 'Claude fixture');
    assert.equal(card.signIn, signIn);
    assert.deepEqual(card.clientActions.filter(action => ['check', 'signin'].includes(action.id)), actions);
  };
  const checkAction = { id: 'check', label: 'Check sign-in' };
  await assertAccountCard('Sign-in not checked', [checkAction]);
  const checked = await post('/api/profiles/Claude%20fixture/clients', { action: 'check' });
  assert.equal(checked.status, 200);
  await assertAccountCard('Signed out', [{ id: 'signin', label: 'Sign in' }]);
  const response = await post('/api/profiles/Claude%20fixture/sign-in', { executable: '/bin/false', command: 'ignored' });
  assert.equal(response.status, 200);
  const attempt = await response.json();
  let result;
  for (let i = 0; i < 100; i++) {
    result = await (await fetch(server.origin + '/api/sign-ins/' + attempt.id, { headers })).json();
    if (!['starting', 'waiting-for-browser', 'verifying'].includes(result.state)) break;
    await delay(20);
  }
  assert.equal(result.state, 'completed', JSON.stringify(result));
  await assertAccountCard('Signed in', []);
  const checkedAt = Date.now();
  t.mock.method(Date, 'now', () => checkedAt + 6 * 60 * 1000);
  await assertAccountCard('Signed in (last checked)', [checkAction]);
  assert.equal(JSON.stringify(result).includes('oauth'), false);
});

test('Copilot device sign-in uses the selected native profile and never probes stock', async t => {
  const root = await temporary(t), store = new Store(join(root, 'store')), executable = join(root, 'copilot');
  const log = join(root, 'copilot-args');
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'GitHub Copilot CLI 1.0.107\\n'
  exit
fi
printf '%s\\n' "$*" "$COPILOT_HOME" "$GH_CONFIG_DIR" > '${log}'
printf 'To authenticate, visit https://github.com/login/device and enter code ABCD-1234\\n' >&2
touch "$COPILOT_HOME/signed-in"
`, { mode: 0o700 });
  const checked = [], opened = [];
  const native = managedNativeProfiles({ store, profilesBase: join(root, 'profiles'),
    terminalEnvironment: { ...process.env, PATH: root + ':/usr/bin:/bin' },
    lockOptions: { lockPath: join(root, 'operation') },
    acquireAccount: (_, options) => acquireCopilotAccount(root, options),
    readCopilotAccount: async ({ profile }) => {
      await lstat(join(profile.home, 'signed-in')); checked.push(profile.home);
      return { state: 'signed-in', route: 'user', token: 'opaque-fixture-account', version: '1.0.107' };
    },
  });
  const selected = await native.createProfile('Copilot fixture', 'copilot', await native.binary('copilot'));
  const manager = createUiSignins({ nativeProfiles: native, select: async () => selected,
    browser: async url => { opened.push(url); }, invalidate: () => {} });
  t.after(() => manager.close());
  const attempt = await manager.start({ name: selected.name });
  const result = await done(manager, attempt.id);
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.accountScope, 'per-root');
  assert.deepEqual(checked, [selected.native.configRoot]);
  assert.deepEqual(opened, ['https://github.com/login/device']);
  assert.equal(await readFile(log, 'utf8'), ['login --device-code', selected.native.configRoot, join(selected.native.configRoot, 'gh'), ''].join('\n'));
  assert.equal(JSON.stringify(result).includes('opaque-fixture-account'), false);
});

test('changed executable during browser sign-in prevents success and shutdown drains an active attempt', async t => {
  const fixture = await claudeFixture(t, 'hang');
  const attempt = await fixture.manager.start({ name: fixture.selected.name });
  while (fixture.manager.get({ id: attempt.id }).state === 'starting') await delay(10);
  await fixture.manager.close();
  assert.equal(fixture.manager.get({ id: attempt.id }).state, 'cancelled');
  await assert.rejects(lstat(join(fixture.selected.native.root, '.run-lock')), { code: 'ENOENT' });
  await assert.rejects(fixture.manager.start({ name: fixture.selected.name }), { code: 'closing' });
  const changed = await claudeFixture(t);
  const native = managedNativeProfiles({ store: changed.store, profilesBase: join(changed.root, 'profiles'), defaultUserHome: changed.root,
    terminalEnvironment: { PATH: changed.root + ':/usr/bin:/bin' }, lockOptions: { lockPath: join(changed.root, 'operation') },
    signinProcess: async () => { await writeFile(changed.executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      return { status: 'exited', exitCode: 0, shutdown: { groupTerminated: true } }; },
  });
  await assert.rejects(native.signin(changed.selected.name, 'claude-code'), /binding changed/);
});

test('sign-in close reports uncertain shutdown and shared attempts remain bound to their selected profile', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const manager = createUiSignins({ select: async name => ({ name, id: name, client: 'copilot' }),
    nativeProfiles: { signin: () => pending }, browser: async () => {} });
  const attempt = await manager.start({ name: 'First' });
  assert.equal((await manager.start({ name: 'First' })).id, attempt.id);
  await assert.rejects(manager.start({ name: 'Second' }), { code: 'signin-busy' });
  release(); await done(manager, attempt.id); await manager.close();
  const uncertain = createUiSignins({ select: async () => ({ name: 'Uncertain', id: 'u', client: 'copilot' }),
    nativeProfiles: { signin: async () => { throw Object.assign(new Error('Native shutdown was not confirmed.'), { code: 'SHUTDOWN_FAILED' }); } } });
  const failed = await uncertain.start({ name: 'Uncertain' });
  assert.equal((await done(uncertain, failed.id)).state, 'uncertain');
  await assert.rejects(uncertain.close(), AggregateError);
});

test('shutdown during asynchronous selection cannot start a new sign-in process', async () => {
  let selected, launches = 0;
  const selection = new Promise(resolve => { selected = resolve; });
  const manager = createUiSignins({ select: () => selection,
    nativeProfiles: { signin: async () => { launches++; } } });
  const start = manager.start({ name: 'Late' });
  await manager.close(); selected({ name: 'Late', id: 'late', client: 'claude-code' });
  await assert.rejects(start, { code: 'closing' });
  assert.equal(launches, 0);
});

test('unconfirmed account verification shutdown remains uncertain after cancellation', async () => {
  let opened = 0;
  const manager = createUiSignins({ select: async () => ({ id: 'copilot-fixture', name: 'Copilot fixture', client: 'copilot' }),
    browser: async () => { opened++; },
    nativeProfiles: { signin: async (_name, _client, { signal, onProgress }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        onProgress({ browserUrl: 'https://github.com/login/device' });
        reject(Object.assign(new Error('Verification shutdown is unconfirmed.'), { process: { shutdown: { groupTerminated: false } } }));
      }, { once: true });
    }) } });
  const attempt = await manager.start({ name: 'Copilot fixture' });
  await Promise.resolve();
  assert.equal((await manager.cancel({ id: attempt.id })).state, 'uncertain');
  assert.equal(opened, 0);
  await assert.rejects(manager.close(), AggregateError);
});

test('active sign-in capacity is bounded before starting an additional native process', async () => {
  const releases = [];
  const manager = createUiSignins({ select: async name => ({ name, id: name, client: 'claude-code' }),
    nativeProfiles: { signin: () => new Promise(resolve => { releases.push(resolve); }) } });
  for (let i = 0; i < 8; i++) await manager.start({ name: 'Profile ' + i });
  await assert.rejects(manager.start({ name: 'Profile 9' }), { code: 'signin-capacity' });
  assert.equal(releases.length, 8);
  for (const release of releases) release();
  await manager.close();
});
