import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStockDesktopApps } from '../src/stock-desktop-apps.js';

async function fixture(t, client = 'claude') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-stock-apps-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, client === 'claude' ? 'Claude.app' : 'GitHub Copilot.app'), executable = join(path, 'Contents', 'MacOS', 'Claude');
  await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true });
  const infoPath = join(path, 'Contents', 'Info.plist');
  const info = { CFBundleIdentifier: client === 'claude' ? 'com.anthropic.claudefordesktop' : 'com.github.githubapp', CFBundleExecutable: 'Claude', CFBundleShortVersionString: '1.2.3', CFBundleVersion: '42' };
  if (client === 'copilot') info.CFBundleURLTypes = [{ CFBundleURLSchemes: ['ghapp'] }];
  await writeFile(infoPath, JSON.stringify(info)); await writeFile(executable, 'fixture signed executable', { mode: 0o700 });
  const calls = [];
  let badSignature = false, team = client === 'claude' ? 'Q6L2SF6YDW' : 'VEKTX9H2N7';
  const execFile = async (command, args, options) => {
    assert.equal(options.timeout, 15000);
    calls.push({ command, args });
    if (command === '/usr/bin/plutil') return { stdout: await readFile(args.at(-1), 'utf8'), stderr: '' };
    if (command === '/usr/bin/codesign') {
      if (badSignature) throw new Error('bad signature');
      return { stdout: '', stderr: `Identifier=${info.CFBundleIdentifier}\nTeamIdentifier=${team}\nCDHash=fixture-code-directory-hash\n` };
    }
    assert.equal(command, '/usr/bin/open');
    return { stdout: '', stderr: '' };
  };
  const service = createStockDesktopApps({ execFile, appPaths: { claude: client === 'claude' ? path : join(root, 'Missing.app'), copilot: client === 'copilot' ? path : join(root, 'Missing.app') } });
  return { service, path, executable, info, infoPath, calls, setBadSignature: value => { badSignature = value; }, setTeam: value => { team = value; } };
}

test('listing reports exact signed installed identity without opening or mutating an app', async t => {
  const f = await fixture(t), before = await readFile(f.executable);
  const [claude, copilot] = await f.service.list();
  assert.equal(claude.status, 'available'); assert.match(claude.appKey, /^[a-f0-9]{64}$/);
  assert.equal(claude.version, '1.2.3'); assert.equal(claude.build, '42'); assert.equal(claude.teamIdentifier, 'Q6L2SF6YDW');
  assert.deepEqual(copilot, { client: 'copilot', name: 'GitHub Copilot', status: 'unavailable' });
  assert.equal(f.calls.some(call => call.command === '/usr/bin/open'), false);
  assert.deepEqual(await readFile(f.executable), before);
  assert.ok(f.calls.some(call => call.command === '/usr/bin/codesign' && JSON.stringify(call.args) === JSON.stringify(['--verify', '--deep', '--strict', f.path])));
  assert.equal((await f.service.list())[0].appKey, claude.appKey);
});

test('open rechecks the exact app and passes only its absolute path to native open', async t => {
  const f = await fixture(t), [app] = await f.service.list();
  f.calls.length = 0;
  const result = await f.service.open({ client: 'claude', appKey: app.appKey });
  assert.equal(result.status, 'opened');
  assert.match(result.message, /existing setup/);
  assert.match(result.message, /No managed profile was selected/);
  assert.deepEqual(f.calls.filter(call => call.command === '/usr/bin/open'), [{ command: '/usr/bin/open', args: ['-a', f.path] }]);
  assert.ok(f.calls.findIndex(call => call.command === '/usr/bin/codesign') < f.calls.findIndex(call => call.command === '/usr/bin/open'));
});

test('changed executable, bundle metadata or signing identity refuses a stale appKey', async t => {
  for (const change of ['executable', 'bundle', 'team']) await t.test(change, async t => {
    const f = await fixture(t), [app] = await f.service.list();
    if (change === 'executable') await writeFile(f.executable, 'different executable bytes', { mode: 0o700 });
    if (change === 'bundle') await writeFile(f.infoPath, JSON.stringify({ ...f.info, CFBundleVersion: '43' }));
    if (change === 'team') f.setTeam('REPLACEMENTTEAM');
    await assert.rejects(f.service.open({ client: 'claude', appKey: app.appKey }), /changed or is unavailable/);
    assert.equal(f.calls.some(call => call.command === '/usr/bin/open'), false);
  });
});

test('bad signatures, wrong bundle IDs and unsigned identities are unavailable and never open', async t => {
  for (const change of ['signature', 'bundleId', 'unsigned']) await t.test(change, async t => {
    const f = await fixture(t), [app] = await f.service.list();
    if (change === 'signature') f.setBadSignature(true);
    if (change === 'bundleId') await writeFile(f.infoPath, JSON.stringify({ ...f.info, CFBundleIdentifier: 'foreign.bundle' }));
    if (change === 'unsigned') f.setTeam('not set');
    assert.equal((await f.service.list())[0].status, 'unavailable');
    await assert.rejects(f.service.open({ client: 'claude', appKey: app.appKey }), /changed or is unavailable/);
    assert.equal(f.calls.some(call => call.command === '/usr/bin/open'), false);
  });
});

test('unknown clients and missing identities cannot fall back to searching app names', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.open({ client: 'unknown', appKey: 'a'.repeat(64) }), /Unsupported/);
  await assert.rejects(f.service.open({ client: 'claude' }), /identity is required/);
  await assert.rejects(f.service.open({ client: 'copilot', appKey: 'a'.repeat(64) }), /unavailable/);
  assert.equal(f.calls.length, 0);
});


test('standalone Copilot requires the GitHub vendor signing team', async t => {
  const f = await fixture(t, 'copilot'), apps = await f.service.list();
  assert.equal(apps[1].status, 'available');
  assert.equal(apps[1].teamIdentifier, 'VEKTX9H2N7');
  f.setTeam('Q6L2SF6YDW');
  assert.equal((await f.service.list())[1].status, 'unavailable');
  await assert.rejects(f.service.open({ client: 'copilot', appKey: apps[1].appKey }), /unavailable/);
  assert.equal(f.calls.some(call => call.command === '/usr/bin/open'), false);
});


test('Copilot navigation opens only an app-local session link in the verified signed app', async t => {
  const f = await fixture(t, 'copilot'), app = (await f.service.list())[1];
  assert.equal(app.sessionNavigation, 'available');
  f.calls.length = 0;
  const result = await f.service.open({ client: 'copilot', appKey: app.appKey, sessionId: 'Native_session-42' });
  assert.equal(result.status, 'link-opened');
  assert.match(result.message, /association and completion are not confirmed/);
  assert.match(result.message, /no new task was requested/);
  assert.deepEqual(f.calls.filter(call => call.command === '/usr/bin/open'), [
    { command: '/usr/bin/open', args: ['-a', f.path, 'ghapp://sessions/Native_session-42'] },
  ]);
  assert.ok(f.calls.findIndex(call => call.command === '/usr/bin/codesign') < f.calls.findIndex(call => call.command === '/usr/bin/open'));
  await f.service.open({ client: 'copilot', appKey: app.appKey, sessionId: 'Native_session-42' });
  assert.equal(f.calls.filter(call => call.command === '/usr/bin/open').length, 2, 'repeated navigation creates no completion or identity association');
  await f.service.open({ client: 'copilot', appKey: app.appKey, sessionId: 'a'.repeat(128) });
  assert.equal(f.calls.at(-1).args.at(-1), `ghapp://sessions/${'a'.repeat(128)}`);
});

test('navigation rejects wrong clients, URLs, route injection and malformed session IDs before any native effect', async t => {
  const f = await fixture(t, 'copilot'), app = (await f.service.list())[1];
  f.calls.length = 0;
  for (const sessionId of ['', null, 42, [], 'a'.repeat(129), '-leading', 'two words', 'a/b', 'a%2Fb', '../tasks/id',
    'ghapp://sessions/id', 'https://github.com/owner/repo/tasks/id', 'id?prompt=run', 'id#fragment', 'id\n', 'id\u0000']) {
    await assert.rejects(f.service.open({ client: 'copilot', appKey: app.appKey, sessionId }), /valid app-local session ID/);
  }
  await assert.rejects(f.service.open({ client: 'claude', appKey: app.appKey, sessionId: 'native-id' }), /valid app-local session ID/);
  assert.equal(f.calls.length, 0);
});

test('missing or malformed ghapp registration disables navigation while preserving ordinary opening', async t => {
  for (const registration of [undefined, {}, [{ CFBundleURLSchemes: 'ghapp' }], [{ CFBundleURLSchemes: ['https', 'github-app'] }]]) {
    const f = await fixture(t, 'copilot');
    await writeFile(f.infoPath, JSON.stringify({ ...f.info, CFBundleURLTypes: registration }));
    const app = (await f.service.list())[1];
    assert.equal(app.status, 'available');
    assert.equal(app.sessionNavigation, 'unavailable');
    await assert.rejects(f.service.open({ client: 'copilot', appKey: app.appKey, sessionId: 'native-id' }), /does not register/);
    assert.equal(f.calls.some(call => call.command === '/usr/bin/open'), false);
    assert.equal((await f.service.open({ client: 'copilot', appKey: app.appKey })).status, 'opened');
    assert.deepEqual(f.calls.filter(call => call.command === '/usr/bin/open'), [{ command: '/usr/bin/open', args: ['-a', f.path] }]);
  }
});

test('changed scheme registration, app build or signature invalidates navigation without dispatch', async t => {
  for (const change of ['scheme', 'build', 'signature']) await t.test(change, async t => {
    const f = await fixture(t, 'copilot'), app = (await f.service.list())[1];
    if (change === 'scheme') await writeFile(f.infoPath, JSON.stringify({ ...f.info, CFBundleURLTypes: [{ CFBundleURLSchemes: ['ghapp', 'new-scheme'] }] }));
    if (change === 'build') await writeFile(f.infoPath, JSON.stringify({ ...f.info, CFBundleVersion: '43' }));
    if (change === 'signature') f.setBadSignature(true);
    await assert.rejects(f.service.open({ client: 'copilot', appKey: app.appKey, sessionId: 'native-id' }), /changed or is unavailable/);
    assert.equal(f.calls.some(call => call.command === '/usr/bin/open'), false);
  });
});

test('managed binding freshly verifies executable while stock listing retains its public shape', async t => {
  const f = await fixture(t, 'copilot'), app = (await f.service.list())[1];
  assert.equal(Object.hasOwn(app, 'executable'), false);
  const binding = await f.service.binding({ client: 'copilot', appKey: app.appKey });
  assert.equal(binding.executable, f.executable);
  assert.match(binding.executableIdentity.sha256, /^[a-f0-9]{64}$/);
  assert.equal(binding.appKey, app.appKey);
  await writeFile(f.executable, 'changed signed fixture');
  await assert.rejects(f.service.binding({ client: 'copilot', appKey: app.appKey }), /changed or is unavailable/);
  assert.equal(f.calls.some(call => call.command === '/usr/bin/open'), false);
});
