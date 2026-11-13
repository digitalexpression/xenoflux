import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { Store } from '../src/profiles.js';
import { createProfileDiscovery, discoverProfiles } from '../src/profile-discovery.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { createEngineProvider } from '../src/ui-engine.js';

const profile = (name, extra = {}) => ({ id: name, name, description: '', revision: 1, repositories: [], ...extra });
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-discovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), base = join(root, 'profiles'), bin = join(root, 'bin');
  for (const path of [home, base, bin]) await mkdir(path, { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  const options = { store, profilesBase: base, defaultUserHome: home, terminalEnvironment: { PATH: bin, HOME: userInfo().homedir, USER: userInfo().username, LOGNAME: userInfo().username },
    desktopLocations: [join(root, 'Codex.app')], stockLocations: [join(root, 'Claude.app')],
    inspectDesktop: async () => { throw Object.assign(new Error('unverified'), { code: 'APP_SIGNATURE_INVALID' }); },
    stockApps: { list: async () => [{ client: 'claude', status: 'available', path: '/fixture/Claude.app', version: '1.2.3' }], open: () => assert.fail('Discovery must not open apps') } };
  const registry = async value => { await mkdir(store.directory, { recursive: true }); await writeFile(store.file, JSON.stringify(value)); };
  return { root, home, base, bin, store, options, registry };
}

test('discovery inspects all CLI installations without execution and preserves independent standard folders', async t => {
  const f = await fixture(t), log = join(f.root, 'executed');
  for (const command of ['codex', 'claude', 'copilot']) await writeFile(join(f.bin, command), `#!/bin/sh\nprintf invoked >> '${log}'\n`, { mode: 0o700 });
  await mkdir(join(f.home, '.claude'), { mode: 0o700 });
  const result = await discoverProfiles(f.options);
  assert.deepEqual(result.clients.map(row => row.cli.kind), ['found', 'found', 'found']);
  assert.ok(result.clients.every(row => row.cli.version === null));
  assert.equal(result.clients[0].desktop.kind, 'unavailable');
  assert.equal(result.clients[1].desktop.kind, 'found');
  assert.equal(result.clients[1].setups[0].kind, 'found');
  assert.equal(result.clients[2].setups[0].kind, 'not-found');
  await assert.rejects(access(log), { code: 'ENOENT' });
  await assert.rejects(access(f.store.directory), { code: 'ENOENT' });
  f.options.terminalEnvironment.CLAUDE_CONFIG_DIR = '/override';
  const changed = await discoverProfiles(f.options);
  assert.equal(changed.clients[1].cli.kind, 'unavailable');
  assert.equal(changed.clients[1].setups[0].kind, 'found');
  assert.equal(changed.clients[0].cli.kind, 'found');
  assert.equal(changed.clients[2].cli.kind, 'found');
});

test('registry inspection preserves valid older/unbound rows beside unsupported records without relaxing reads', async t => {
  const f = await fixture(t);
  await f.registry({ schemaVersion: 1, profiles: [profile('Older'), profile('Foreign', { client: 'unsupported', settings: 'PRIVATE_VALUE' })] });
  const before = await readFile(f.store.file);
  const inspection = await f.store.inspect();
  assert.equal(inspection.kind, 'blocked');
  assert.equal(inspection.rows[0].kind, 'supported');
  assert.equal(inspection.rows[0].olderEncoding, true);
  assert.equal(inspection.rows[1].kind, 'unsupported');
  const result = await discoverProfiles(f.options);
  assert.equal(result.clients[0].setups[1].kind, 'unbound');
  assert.match(result.clients[0].setups[1].reason, /without migration/);
  assert.equal(result.attention[0].name, 'Foreign');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));
  assert.deepEqual(await readFile(f.store.file), before);
  await assert.rejects(f.store.read(), /Unsupported profile client/);
});

test('collection conflicts, malformed metadata and unknown schema remain inspection-only', async t => {
  const f = await fixture(t);
  const native = { root: join(f.base, 'missing'), environmentId: '11111111-1111-1111-1111-111111111111',
    executable: join(f.bin, 'codex'), executableIdentity: '[1,2,3,4,5]', version: '1.2.3' };
  for (const records of [[profile('Same'), profile('Same')], [profile('One', { native }), profile('Two', { native })],
    [null, profile('Fine')], [profile('Invalid', { native: { root: '/bad' } })]]) {
    await f.registry({ schemaVersion: 1, profiles: records });
    assert.equal((await f.store.inspect()).kind, 'blocked');
    await assert.rejects(f.store.read());
  }
  await f.registry({ schemaVersion: 99, profiles: [profile('Future', { native, secret: 'PRIVATE_VALUE' })] });
  const future = await f.store.inspect();
  assert.equal(future.rows[0].kind, 'unsupported');
  assert.equal(future.rows[0].client, null);
  assert.ok(!JSON.stringify(future).includes(native.root));
  await writeFile(f.store.file, '{broken');
  assert.equal((await f.store.inspect()).kind, 'blocked');
  assert.equal((await discoverProfiles(f.options)).clients.length, 3);
  await writeFile(f.store.file, ' '.repeat(1024 * 1024 + 1));
  assert.match((await f.store.inspect()).reason, /1 MiB/);
  await f.registry({ schemaVersion: 1, profiles: Array.from({ length: 201 }, (_, i) => profile(`Row${i}`)) });
  const limited = await f.store.inspect();
  assert.equal(limited.kind, 'blocked');
  assert.equal(limited.rows.length, 200);
  assert.equal(limited.limits.length, 1);
});

test('folder discovery stays bounded, refuses links and never treats missing executables as missing profiles', async t => {
  const f = await fixture(t);
  const orphan = join(f.base, 'orphan');
  await mkdir(orphan, { mode: 0o700 });
  for (const child of ['codex-home', 'workspace', 'user-home', 'tmp']) await mkdir(join(orphan, child), { mode: 0o700 });
  await mkdir(join(f.base, 'unidentified'), { mode: 0o700 });
  await symlink(orphan, join(f.base, 'linked'));
  await mkdir(join(f.home, '.codex'), { mode: 0o700 });
  await writeFile(join(f.home, '.codex', 'auth.json'), 'PRIVATE_CREDENTIAL');
  await f.registry({ schemaVersion: 1, profiles: [profile('Gone', { client: 'codex', native: {
    root: join(f.base, 'missing'), environmentId: '11111111-1111-1111-1111-111111111111',
    executable: '/old/codex', executableIdentity: '[1,2,3,4,5]', version: '0.1.0',
  } })] });
  const result = await discoverProfiles(f.options);
  assert.equal(result.clients[0].cli.kind, 'unavailable');
  assert.equal(result.clients[0].setups[0].kind, 'found');
  assert.equal(result.clients[0].setups.find(row => row.name === 'Gone').kind, 'not-found');
  assert.ok(result.clients[0].setups.some(row => row.location === orphan));
  assert.ok(result.attention.some(row => row.name === 'linked' && row.kind === 'unavailable'));
  assert.ok(result.attention.some(row => row.name === 'unidentified'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_CREDENTIAL'));
  await symlink(f.store.file, join(f.root, 'linked-store'));
  const linked = new Store(join(f.root, 'elsewhere'));
  await mkdir(linked.directory);
  await symlink(f.store.file, linked.file);
  assert.equal((await linked.inspect()).kind, 'blocked');
});

test('engine discovery avoids operational observation and reconciliation', async t => {
  const f = await fixture(t);
  const fail = () => assert.fail('Operational client observation is forbidden during discovery');
  const provider = createEngineProvider({ store: f.store, profilesBase: f.base, defaultUserHome: f.home,
    runContext: { terminalEnvironment: f.options.terminalEnvironment }, stockApps: f.options.stockApps,
    discoveryContext: { inspectDesktop: f.options.inspectDesktop }, observeClients: fail,
    desktopSurface: { list: fail }, clientOps: { check: fail, open: fail }, resolveClient: fail });
  const result = await provider.discovery();
  assert.equal(result.clients.length, 3);
  await assert.rejects(access(f.store.directory), { code: 'ENOENT' });
});


test('registered Codex config validation finds incompatible bindings without a current CLI or writes', async t => {
  const f = await fixture(t);
  const executable = join(f.root, 'registered-codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const homes = [];
  for (const name of ['Current', 'CredentialsRouting', 'SqliteRouting'])
    homes.push(await prepareNativeHome({ directory: join(f.base, name), executable, codexVersion: '0.1.0' }));
  await writeFile(join(homes[1].home, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n', { mode: 0o600 });
  await writeFile(join(homes[2].home, 'config.toml'), 'cli_auth_credentials_store = "file"\nsqlite_home = "/another/home"\n', { mode: 0o600 });
  await f.registry({ schemaVersion: 1, profiles: homes.map((home, i) => profile(['Current', 'CredentialsRouting', 'SqliteRouting'][i], { client: 'codex', native: home.native })) });
  const paths = [f.store.file, ...homes.map(home => join(home.home, 'config.toml'))];
  const before = await Promise.all(paths.map(path => readFile(path)));
  const result = await discoverProfiles(f.options);
  assert.equal(result.clients[0].cli.kind, 'unavailable');
  const rows = result.clients[0].setups;
  assert.equal(rows.find(row => row.name === 'Current').kind, 'found');
  for (const name of ['CredentialsRouting', 'SqliteRouting']) {
    const row = rows.find(row => row.name === name);
    assert.equal(row.kind, 'unavailable');
    assert.equal(row.label, 'Binding needs attention');
    assert.match(row.reason, /credential store and sqlite home/);
  }
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
});


const cli = result => result.clients[0].cli;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function desktopFixture(f) {
  const app = f.options.desktopLocations[0], stock = f.options.stockLocations[0];
  for (const path of [app, stock]) {
    await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(join(path, 'Contents', 'Resources'));
    await writeFile(join(path, 'Contents', 'Info.plist'), '1.0');
    await writeFile(join(path, 'Contents', 'MacOS', 'Client'), 'executable');
    await writeFile(join(path, 'Contents', 'Resources', 'app.asar'), 'bundle-v1');
  }
  let desktopScans = 0, stockScans = 0;
  f.options.inspectDesktop = async () => {
    desktopScans++;
    return { appPath: app, version: await readFile(join(app, 'Contents', 'Info.plist'), 'utf8'),
      asarSha256: await readFile(join(app, 'Contents', 'Resources', 'app.asar'), 'utf8') };
  };
  f.options.stockApps.list = async () => {
    stockScans++;
    try {
      const version = await readFile(join(stock, 'Contents', 'Info.plist'), 'utf8');
      return [{ client: 'claude', status: 'available', path: stock, version, appKey: version }];
    } catch { return [{ client: 'claude', status: 'unavailable' }]; }
  };
  return { app, stock, counts: () => [desktopScans, stockScans] };
}

test('cached discovery detects same-path executable replacement, removal, reinstall and PATH symlink retargeting', async t => {
  const f = await fixture(t), path = join(f.bin, 'codex');
  await writeFile(path, '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  const reader = createProfileDiscovery(f.options);
  const first = cli(await reader.discovery());
  assert.equal(first.kind, 'found');
  await writeFile(join(f.bin, 'replacement'), '#!/bin/sh\nexit 92\n', { mode: 0o700 });
  await rename(join(f.bin, 'replacement'), path);
  const replaced = cli(await reader.discovery());
  assert.equal(replaced.location, first.location);
  assert.notEqual(replaced.identity, first.identity);
  await rm(path);
  assert.equal(cli(await reader.discovery()).kind, 'unavailable');
  await writeFile(path, '#!/bin/sh\nexit 93\n', { mode: 0o700 });
  assert.equal(cli(await reader.discovery()).kind, 'found');
  const target = join(f.root, 'target-codex');
  await writeFile(target, '#!/bin/sh\nexit 94\n', { mode: 0o700 });
  await rm(path);
  await symlink(target, path);
  const linked = cli(await reader.discovery());
  await writeFile(join(f.root, 'target-next'), '#!/bin/sh\nexit 95\n', { mode: 0o700 });
  await rename(join(f.root, 'target-next'), target);
  assert.notEqual(cli(await reader.discovery()).identity, linked.identity);
});

test('discovery and raw app reads share cached verification and invalidate for app metadata and deletion', async t => {
  const f = await fixture(t), app = await desktopFixture(f);
  const reader = createProfileDiscovery(f.options);
  const first = await reader.discovery();
  assert.equal(first.clients[0].desktop.version, '1.0');
  assert.deepEqual(app.counts(), [1, 1]);
  assert.equal((await reader.apps()).apps[0].version, '1.0');
  await reader.discovery();
  assert.deepEqual(app.counts(), [1, 1]);
  await writeFile(join(app.app, 'Contents', 'Info.plist'), '2.0');
  await writeFile(join(app.stock, 'Contents', 'Info.plist'), '2.0');
  const changed = await reader.discovery();
  assert.equal(changed.clients[0].desktop.version, '2.0');
  assert.notEqual(changed.clients[0].desktop.identity, first.clients[0].desktop.identity);
  assert.equal((await reader.apps()).apps[0].version, '2.0');
  assert.deepEqual(app.counts(), [2, 2]);
  await writeFile(join(app.app, 'Contents', 'Resources', 'app.asar'), 'bundle-v2');
  assert.notEqual((await reader.discovery()).clients[0].desktop.identity, changed.clients[0].desktop.identity);
  await rm(app.app, { recursive: true });
  await rm(app.stock, { recursive: true });
  const gone = await reader.discovery();
  assert.equal(gone.clients[0].desktop.kind, 'unavailable');
  assert.equal(gone.clients[1].desktop.kind, 'unavailable');
  assert.equal((await reader.apps()).apps[0].status, 'unavailable');
  await desktopFixture(f);
  assert.equal((await reader.discovery()).clients[0].desktop.kind, 'found');
});

test('concurrent readers share a scan and explicit fresh requests during it coalesce one subsequent scan', async t => {
  const f = await fixture(t), app = await desktopFixture(f);
  const entered = deferred(), release = deferred();
  const inspect = f.options.inspectDesktop;
  f.options.inspectDesktop = async () => { entered.resolve(); await release.promise; return inspect(); };
  const reader = createProfileDiscovery(f.options);
  const first = reader.discovery(), concurrent = reader.apps();
  await entered.promise;
  const fresh = reader.discovery({ fresh: true }), freshApps = reader.apps({ fresh: true });
  release.resolve();
  await Promise.all([first, concurrent, fresh, freshApps]);
  assert.deepEqual(app.counts(), [2, 2]);
  await reader.apps();
  assert.deepEqual(app.counts(), [2, 2]);
  await reader.discovery({ fresh: true });
  assert.deepEqual(app.counts(), [3, 3]);
});

test('a change during verification cannot stamp the old observation with a newer fingerprint', async t => {
  const f = await fixture(t), app = await desktopFixture(f);
  const inspect = f.options.inspectDesktop, entered = deferred(), release = deferred();
  let first = true;
  f.options.inspectDesktop = async () => {
    const observation = await inspect();
    if (first) { first = false; entered.resolve(); await release.promise; }
    return observation;
  };
  const reader = createProfileDiscovery(f.options), pending = reader.discovery();
  await entered.promise;
  await writeFile(join(app.app, 'Contents', 'Info.plist'), '2.0');
  release.resolve();
  assert.equal((await pending).clients[0].desktop.version, '1.0');
  assert.equal((await reader.discovery()).clients[0].desktop.version, '2.0');
  assert.deepEqual(app.counts(), [2, 2]);
});

test('quiet reads observe registry removal and manually deleted profile roots without writing state', async t => {
  const f = await fixture(t), executable = join(f.bin, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const home = await prepareNativeHome({ directory: join(f.base, 'Named'), executable, codexVersion: '0.1.0' });
  await f.registry({ schemaVersion: 1, profiles: [profile('Named', { client: 'codex', native: home.native })] });
  const before = await readFile(f.store.file);
  const reader = createProfileDiscovery(f.options);
  assert.equal((await reader.discovery()).clients[0].setups.find(row => row.name === 'Named').kind, 'found');
  await writeFile(join(home.home, 'auth.json'), 'PRIVATE_CREDENTIAL', { mode: 0o600 });
  assert.ok(!JSON.stringify(await reader.discovery()).includes('PRIVATE_CREDENTIAL'));
  await rm(home.root, { recursive: true });
  const missing = (await reader.discovery()).clients[0].setups.find(row => row.name === 'Named');
  assert.equal(missing.kind, 'not-found');
  assert.deepEqual(await readFile(f.store.file), before);
  await f.registry({ schemaVersion: 1, profiles: [] });
  assert.ok(!(await reader.discovery()).clients[0].setups.some(row => row.name === 'Named'));
});

test('quiet reads retry deeper verification within thirty seconds and update metadata observation time', async t => {
  const f = await fixture(t), app = await desktopFixture(f);
  let clock = 1000;
  const reader = createProfileDiscovery({ ...f.options, now: () => clock, maxAgeMs: 999999 });
  await reader.discovery();
  clock += 5000;
  assert.equal((await reader.discovery()).checkedAt, new Date(clock).toISOString());
  assert.deepEqual(app.counts(), [1, 1]);
  clock += 25000;
  await reader.apps();
  assert.deepEqual(app.counts(), [2, 2]);
});

test('profile listing reads journals without reconciliation and preserves unknown stopped state', async t => {
  const f = await fixture(t), executable = join(f.bin, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const home = await prepareNativeHome({ directory: join(f.base, 'Named'), executable, codexVersion: '0.1.0' });
  await f.registry({ schemaVersion: 1, profiles: [profile('Named', { client: 'codex', native: home.native })] });
  let listings = 0;
  const provider = createEngineProvider({ store: f.store, profilesBase: f.base, defaultUserHome: f.home,
    runContext: { terminalEnvironment: f.options.terminalEnvironment }, stockApps: f.options.stockApps,
    discoveryContext: { inspectDesktop: f.options.inspectDesktop },
    desktopSurface: { list: async ({ observe }) => { listings++; assert.equal(observe, false); return { instances: [{ profileId: 'Named' }] }; } },
    observeClients: async (path, { desktopRunning }) => {
      assert.equal(desktopRunning, null);
      return { cli: { state: 'not-running', text: 'not running' }, desktop: { state: 'not-running', text: 'not running' } };
    } });
  assert.equal((await provider.profiles()).profiles[0].desktop.state, 'unknown');
  assert.equal(listings, 1);
  await rm(home.root, { recursive: true });
  const missing = (await provider.profiles()).profiles[0];
  assert.equal(missing.name, 'Named');
  assert.equal(missing.state, 'unavailable');
  await f.registry({ schemaVersion: 1, profiles: [] });
  assert.deepEqual((await provider.profiles()).profiles, []);
});


test('transient stock inspection failures remain unavailable and automatic reads retry instead of caching empty apps', async t => {
  const f = await fixture(t);
  let scans = 0;
  f.options.stockApps.list = async () => {
    scans++;
    if (scans <= 2) throw new Error('temporary native metadata failure');
    return [{ client: 'claude', status: 'available', path: '/fixture/Claude.app', version: '1.2.3', appKey: 'fixture' }];
  };
  const reader = createProfileDiscovery(f.options);
  assert.equal((await reader.discovery()).clients[1].desktop.kind, 'unavailable');
  await assert.rejects(reader.apps(), /temporary native metadata failure/);
  assert.equal((await reader.apps()).apps[0].status, 'available');
  assert.equal(scans, 3);
  assert.equal((await reader.discovery()).clients[1].desktop.kind, 'found');
  assert.equal(scans, 3);
});

test('fingerprints never read ambient secret values or invalidate for an unrelated secret change', async t => {
  const f = await fixture(t), app = await desktopFixture(f);
  Object.defineProperty(f.options.terminalEnvironment, 'UNRELATED_SECRET', {
    enumerable: true, configurable: true, get: () => assert.fail('Discovery must not read ambient secret values'),
  });
  const reader = createProfileDiscovery(f.options);
  await reader.discovery();
  Object.defineProperty(f.options.terminalEnvironment, 'UNRELATED_SECRET', { value: 'REPLACED_SECRET', enumerable: true });
  await reader.apps();
  assert.deepEqual(app.counts(), [1, 1]);
  f.options.terminalEnvironment.CLAUDE_OAUTH_TOKEN = 'PRIVATE_TOKEN_A';
  const refused = await reader.discovery();
  assert.equal(refused.clients[1].cli.kind, 'unavailable');
  assert.ok(!JSON.stringify(refused).includes('PRIVATE_TOKEN_A'));
  f.options.terminalEnvironment.CLAUDE_OAUTH_TOKEN = 'PRIVATE_TOKEN_B';
  await reader.discovery();
  assert.deepEqual(app.counts(), [2, 2]);
});

test('fast fingerprints do not traverse refused profile or app directory links', async t => {
  const f = await fixture(t), app = await desktopFixture(f);
  const outside = join(f.root, 'outside');
  await mkdir(join(outside, 'codex-home'), { recursive: true });
  await writeFile(join(outside, 'codex-home', 'config.toml'), 'PRIVATE_CONTENT');
  await symlink(outside, join(f.base, 'linked-profile'));
  await rm(app.app, { recursive: true });
  await symlink(outside, app.app);
  let scans = 0;
  f.options.inspectDesktop = async () => { scans++; throw new Error('Refused app fixture'); };
  const reader = createProfileDiscovery(f.options);
  const first = await reader.discovery();
  assert.equal(first.attention.find(row => row.name === 'linked-profile').kind, 'unavailable');
  await writeFile(join(outside, 'codex-home', 'config.toml'), 'CHANGED_PRIVATE_CONTENT');
  await reader.discovery();
  assert.equal(scans, 1, 'unobserved descendants do not enter the fingerprint');
});


test('retained registry and orphan presentation keys survive removal of earlier entries without registry writes', async t => {
  const f = await fixture(t);
  const records = [profile('Earlier'), profile('Retained')];
  await f.registry({ schemaVersion: 1, profiles: records });
  for (const name of ['earlier-folder', 'retained-folder']) await mkdir(join(f.base, name), { mode: 0o700 });
  const original = await readFile(f.store.file);
  const reader = createProfileDiscovery(f.options);
  const before = await reader.discovery();
  const profileKey = result => result.clients[0].setups.find(row => row.name === 'Retained').key;
  const folderKey = result => result.attention.find(row => row.name === 'retained-folder').key;
  assert.deepEqual(await readFile(f.store.file), original);
  await f.registry({ schemaVersion: 1, profiles: records.slice(1) });
  await rm(join(f.base, 'earlier-folder'), { recursive: true });
  const edited = await readFile(f.store.file);
  const after = await reader.discovery();
  assert.equal(profileKey(after), profileKey(before));
  assert.equal(folderKey(after), folderKey(before));
  assert.deepEqual(await readFile(f.store.file), edited);
});

test('blocked registry duplicate IDs and unsupported rows always have unique inspection keys', async t => {
  const f = await fixture(t);
  await f.registry({ schemaVersion: 1, profiles: [profile('Same'), profile('Same'),
    { id: 'Same', name: 'Unsupported', client: 'future', secret: 'PRIVATE_VALUE' }, null] });
  const before = await readFile(f.store.file);
  const result = await f.store.inspect();
  assert.equal(result.kind, 'blocked');
  assert.equal(new Set(result.rows.map(row => row.key)).size, result.rows.length);
  assert.equal(result.rows[0].kind, 'supported');
  assert.equal(result.rows[1].kind, 'supported');
  assert.notEqual(result.rows[0].key, result.rows[1].key);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));
  await assert.rejects(f.store.read(), /Duplicate profile ID or name/);
  assert.deepEqual(await readFile(f.store.file), before);
  await f.registry({ schemaVersion: 99, profiles: [profile('Same'), profile('Same'), null] });
  const unknown = await f.store.inspect();
  assert.equal(new Set(unknown.rows.map(row => row.key)).size, unknown.rows.length);
  assert.ok(unknown.rows.every(row => row.kind === 'unsupported'));
});
