import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEngineProvider } from '../src/ui-engine.js';
import { startUiServer } from '../src/ui-server.js';
import { bind, Store } from '../src/profiles.js';
import { copilotExecutableIdentity } from '../src/copilot-profile.js';
import { claudeEnvironment } from '../src/claude-profile.js';

test('Copilot creation, status qualification, copy and Undo use the real Store and authenticated controller', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-e1-fixture-')));
  const executable = join(root, 'copilot'), launches = join(root, 'launches.log');
  const stock = join(root, 'simulated-stock');
  await mkdir(stock, { mode: 0o700 });
  await writeFile(executable, `#!/bin/sh
[ "$*" = --version ] && [ -d "$COPILOT_HOME" ] || exit 99
printf '%s\\n' "$COPILOT_HOME" >> "${launches}"
printf 'GitHub Copilot CLI 1.0.107\\n'
`, { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  const profilesBase = join(root, 'profiles');
  let managedStatus = { state: 'signed-out', version: '1.0.107' };
  let stockToken = 'matching-fixture-token';
  const statusRoutes = [];
  const provider = createEngineProvider({ store, profilesBase, reportsRoot: join(root, 'reports'),
    lockOptions: { lockPath: join(root, 'operation') }, copyRuntime: () => ({ assertIdle: async () => {} }),
    accountContext: {
      terminalEnvironment: { ...process.env, PATH: root + ':/usr/bin:/bin' },
      resolveStockCopilot: async () => ({ home: stock, executable, executableIdentity: copilotExecutableIdentity(await lstat(executable)), rootMode: 'implicit' }),
      readCopilotAccount: async ({ profile }) => {
        statusRoutes.push([profile.rootMode, profile.home]);
        return profile.rootMode === 'implicit'
          ? { state: 'signed-in', route: 'gh-cli', version: '1.0.107', token: stockToken }
          : managedStatus;
      },
    },
  });
  const server = await startUiServer({ provider, launchToken: 'managed-native-test' });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { origin: server.origin, 'content-type': 'application/json', 'x-xenoflux-request': '1' };
  const post = (path, body) => fetch(server.origin + path, { headers, method: 'POST', body: JSON.stringify(body) });
  const get = path => fetch(server.origin + path, { headers });
  const login = await post('/api/session', { token: 'managed-native-test' });
  assert.equal(login.status, 200);
  headers.cookie = login.headers.get('set-cookie').split(';')[0];
  async function json(responsePromise, status = 200) {
    const response = await responsePromise;
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  }
  const preview = (name, from) => json(get('/api/profiles/new?' + new URLSearchParams({ name, client: 'copilot', ...(from && { from }) })));
  const create = (name, plan, items = [], manualItems = []) => json(post('/api/profiles/new',
    { name, client: 'copilot', planToken: plan.planToken, items, manualItems, accountQualification: { scope: 'shared' } }));
  const cancelled = await preview('Cancelled');
  assert.equal(cancelled.executable, executable);
  assert.deepEqual((await store.read()).profiles, []);
  await assert.rejects(lstat(profilesBase), { code: 'ENOENT' });
  await assert.rejects(lstat(launches), { code: 'ENOENT' });
  await json(post('/api/profiles/new', { name: 'Cancelled', client: 'claude-code', planToken: cancelled.planToken }), 409);
  assert.deepEqual(statusRoutes, []);

  await create('Source', await preview('Source'));
  const source = (await new Store(store.directory).read()).profiles[0];
  assert.equal(source.client, 'copilot');
  assert.equal(source.native.rootMode, 'explicit');
  assert.equal(source.native.version, '1.0.107');
  assert.equal(await realpath(source.native.configRoot), source.native.configRoot);
  await writeFile(join(source.native.configRoot, 'settings.json'), '{"theme":"dark","stream":true}', { mode: 0o600 });
  await writeFile(join(source.native.configRoot, 'config.json'), '{"fixture":"credentials not for copy"}', { mode: 0o600 });
  await writeFile(join(source.native.configRoot, 'mcp-config.json'), '{"mcpServers":{"manual":{"command":"fixture"}}}', { mode: 0o600 });
  const plan = await preview('Target', 'Source');
  const selected = plan.items.find(item => item.name === 'theme');
  assert.equal(selected.details[0].path, 'settings.json:theme');
  const manual = plan.manualOptions.find(item => item.label.includes('manual'));
  assert.ok(manual);
  assert.equal(plan.items.some(item => item.id === manual.id), false);
  const result = await create('Target', plan, [selected.id], [manual.id]);
  assert.ok(result.undo?.id);
  assert.deepEqual(result.guidance.map(item => item.id), [manual.id]);
  const target = (await store.read()).profiles.find(profile => profile.name === 'Target');
  assert.equal(target.native.configRoot, join(profilesBase, target.id, 'config'));
  assert.deepEqual(JSON.parse(await readFile(join(target.native.configRoot, 'settings.json'), 'utf8')), { theme: 'dark' });
  await assert.rejects(lstat(join(target.native.configRoot, 'config.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(target.native.configRoot, 'mcp-config.json')), { code: 'ENOENT' });
  await json(post('/api/copies/' + result.undo.id + '/undo', {}));
  await assert.rejects(lstat(join(target.native.configRoot, 'settings.json')), { code: 'ENOENT' });

  const repository = join(root, 'repo');
  await mkdir(repository);
  await store.update(data => bind(data, target.id, repository));
  assert.deepEqual(statusRoutes, []);
  assert.equal((await readFile(launches, 'utf8')).trim().split('\n').length, 2);
  const card = async () => (await json(get('/api/profiles'))).profiles.find(profile => profile.name === 'Target');
  assert.equal((await card()).accountScope, 'unverified');
  const account = () => json(post('/api/profiles/Target/account', { client: 'copilot', accountQualification: { scope: 'shared' } }));
  assert.equal((await account()).state, 'signed-out');
  assert.equal((await card()).signIn, 'Signed out');
  assert.equal(statusRoutes.length, 1, 'signed-out managed route does not try stock');
  const catalog = () => json(get('/api/catalog?' + new URLSearchParams({ profile: 'Target', client: 'copilot', workspace: repository })), 422);
  await catalog();
  managedStatus = { state: 'signed-in', route: 'gh-cli', version: '1.0.107', token: 'matching-fixture-token' };
  stockToken = 'different-fixture-token';
  assert.equal((await account()).accountScope, 'unverified');
  assert.equal((await card()).accountScope, 'unverified');
  stockToken = managedStatus.token;
  const shared = await account();
  assert.deepEqual(shared, { state: 'signed-in', route: 'gh-cli', accountScope: 'shared', accountIndependence: 'not verified' });
  assert.equal((await card()).accountScope, 'shared');
  assert.match((await card()).setup.command, /COPILOT_HOME=.*--no-auto-update/);
  assert.equal(JSON.stringify(await store.read()).includes('accountQualification'), false);
  const catalogReady = await json(get('/api/catalog?' + new URLSearchParams({ profile: 'Target', client: 'copilot', workspace: repository })));
  assert.equal(catalogReady.status, 'unavailable');
  assert.equal(catalogReady.reason, 'catalog-not-refreshed');
  assert.equal(JSON.stringify(catalogReady).includes(managedStatus.token), false);
  await rm(target.native.configRoot, { recursive: true });
  await mkdir(target.native.configRoot, { mode: 0o700 });
  assert.equal((await card()).accountScope, 'unverified');
  await catalog();

  await json(post('/api/profiles/Target/remove', {}));
  assert.ok((await lstat(target.native.configRoot)).isDirectory());
  assert.equal((await store.read()).profiles.some(profile => profile.id === target.id), false);
});

test('Claude explicit root equal to the implicit path still sets CLAUDE_CONFIG_DIR', () => {
  const ambient = { PATH: '/usr/bin:/bin', USER: 'fixture', LOGNAME: 'fixture' };
  const userHome = homedir(), home = join(userHome, '.claude');
  const stock = claudeEnvironment(ambient, { userHome, home, rootMode: 'implicit' });
  assert.deepEqual(claudeEnvironment(ambient, { userHome, home, rootMode: 'explicit' }), { ...stock, CLAUDE_CONFIG_DIR: home });
  assert.equal(stock.HOME, userHome);
  assert.equal(stock.USER, ambient.USER);
  assert.equal(stock.LOGNAME, ambient.LOGNAME);
  assert.throws(() => claudeEnvironment({ ...ambient, CLAUDE_CONFIG_DIR: '' }, { userHome, home, rootMode: 'explicit' }), /ambient/);
});
