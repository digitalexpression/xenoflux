import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstallation } from '../src/installation.js';
import { userPaths } from '../src/paths.js';
import { readLogSettings, writeLogSettings } from '../src/log-storage.js';

async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'xfx-install home '));
  t.after(async () => { await (await import('node:fs/promises')).rm(home, { recursive: true, force: true }); });
  const calls = [], prepared = [], restored = [];
  const instance = createInstallation({
    source: process.cwd(),
    execute: async (file, args, options) => { calls.push(['execute', file, args, options.env]); return { stdout: 'v22.13.0\n' }; },
    check: async ({ env }) => { calls.push(['node', env]); return 'v22.13.0'; },
    runService: async (file, args, options) => { calls.push([file, args, options.env]); },
    serviceLoaded: async () => false,
    readLogSettings: () => options.settings ?? { enabled: false, backgroundPath: '/fixture/node:/usr/bin:/bin' },
    writeLogSettings: async value => { calls.push(['settings', value]); },
    prepareLogs: async value => { prepared.push(value); },
    restoreLogs: async value => { restored.push(value); },
    ...options,
  });
  return { home, env: { HOME: home, PATH: '/caller/node:/usr/bin:/bin' }, instance, calls, prepared, restored };
}

test('install validates Node first, stages a runnable package, and writes a portable stable entry', async t => {
  const f = await fixture(t);
  const result = await f.instance.install({ env: f.env });
  assert.equal(result.app, userPaths(f.home).app);
  assert.match(await readFile(userPaths(f.home).bin, 'utf8'), /#!\/bin\/sh\n# xenoflux-managed-entry[\s\S]*exec node '.*bin\/xfx\.js' "\$@"/);
  assert.match(await readFile(join(result.app, '.xfx-install.json'), 'utf8'), /com\.xenoflux\.app\.v1/);
  assert.match(await readFile(join(result.app, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Copyright \(c\) 2026 Digital Expression/);
  await access(join(result.app, 'node_modules', 'smol-toml', 'package.json'));
  assert.equal(f.calls.filter(([kind]) => kind === 'node').length, 2);
  assert.equal(f.calls.some(([kind, file, args]) => kind === 'execute' && file === 'node' && args[1] === '--help' && args[0].includes('.stage-')), true);
});

test('missing or unsupported Node fails before installation writes', async t => {
  const f = await fixture(t, { check: async () => { throw new Error('Node 22.13.0 or newer is required; found v20.0.0'); } });
  await assert.rejects(f.instance.install({ env: f.env }), /Node 22\.13\.0/);
  await assert.rejects(access(userPaths(f.home).app));
});

test('enable prepares links before registering the service and records only a supported background Node', async t => {
  const f = await fixture(t);
  await f.instance.install({ env: f.env });
  const result = await f.instance.enable({ env: f.env, backgroundPath: '/custom/node:/usr/bin:/bin' });
  assert.equal(result.enabled, true);
  assert.equal(f.prepared.length, 2);
  assert.deepEqual(f.calls.find(([kind]) => kind === '/bin/launchctl')[1], ['bootstrap', `gui/${process.getuid()}`, userPaths(f.home).launchAgent]);
  const plist = await readFile(userPaths(f.home).launchAgent, 'utf8');
  assert.match(plist, /<string>\/usr\/bin\/env<\/string>[\s\S]*<string>node<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /KeepAlive|NODE_OPTIONS|\/caller\/node/);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'settings').at(-1)[1], { enabled: true, backgroundPath: '/custom/node:/usr/bin:/bin' });
});

test('saved custom background PATH survives enable, disable, and reinstall', async t => {
  const customPath = '/custom/node:/usr/bin:/bin';
  let settings = { enabled: false, backgroundPath: customPath };
  let f;
  f = await fixture(t, {
    readLogSettings: async () => ({ ...settings }),
    writeLogSettings: async value => { settings = { ...value }; },
    check: async ({ env }) => {
      f?.calls.push(['node', env]);
      if (env.PATH !== '/caller/node:/usr/bin:/bin' && env.PATH !== customPath)
        throw new Error(`Unexpected background PATH: ${env.PATH}`);
      return 'v22.13.0';
    },
  });

  await f.instance.install({ env: f.env });
  assert.ok((await readFile(userPaths(f.home).launchAgent, 'utf8')).includes(`<string>${customPath}</string>`));
  await f.instance.disable({ env: f.env });
  await f.instance.enable({ env: f.env });
  await f.instance.install({ env: f.env });
  // A malformed terminal PATH must not prevent use of a working saved service.
  assert.equal((await f.instance.enable({ env: { ...f.env, PATH: ':relative' } })).enabled, true);

  const plist = await readFile(userPaths(f.home).launchAgent, 'utf8');
  assert.ok(plist.includes(`<string>${customPath}</string>`));
  assert.deepEqual(settings, { enabled: true, backgroundPath: customPath });
  const checkedPaths = f.calls.filter(([kind]) => kind === 'node').map(([, env]) => env.PATH);
  assert.equal(checkedPaths.filter(path => path === customPath).length >= 3, true);
});

for (const savedPath of [null, '/removed/node:/usr/bin:/bin']) {
  test(`installation discovers caller Node with ${savedPath ? 'a stale saved PATH' : 'fresh settings'}`, async t => {
    const f = await fixture(t, {
      readLogSettings: undefined, writeLogSettings: undefined,
      check: async ({ env }) => {
        if (env.PATH !== '/caller/node:/usr/bin:/bin') throw new Error('Node is unavailable on PATH');
        return 'v22.13.0';
      },
    });
    if (savedPath) await writeLogSettings({ enabled: false, backgroundPath: savedPath }, { home: f.home });
    assert.equal((await f.instance.install({ env: f.env })).enabled, true);
    assert.deepEqual(readLogSettings({ home: f.home }), { enabled: true, backgroundPath: f.env.PATH });
    assert.ok((await readFile(userPaths(f.home).launchAgent, 'utf8')).includes(`<string>${f.env.PATH}</string>`));
    // A later terminal need not expose the same Node: the proven service PATH persists.
    assert.equal((await f.instance.enable({ env: { ...f.env, PATH: '/other/bin:/usr/bin:/bin' } })).enabled, true);
  });
}

test('missing background Node leaves RAM startup explicitly disabled without preparing or registering', async t => {
  const f = await fixture(t, { check: async ({ env }) => {
    if (env.PATH === '/usr/bin:/bin') throw new Error('Node is unavailable on PATH');
    return 'v22.13.0';
  } });
  const result = await f.instance.install({ env: f.env, backgroundPath: '/usr/bin:/bin' });
  assert.deepEqual(result.ramStartup, { enabled: false, reason: 'Node is unavailable on PATH' });
  assert.equal(f.prepared.length, 0);
  assert.equal(f.calls.some(([kind]) => kind === '/bin/launchctl'), false);
});

test('service failure reports failure and restores a consistent disabled disk mode', async t => {
  const f = await fixture(t, { runService: async () => { throw new Error('bootstrap failed'); } });
  await assert.rejects(f.instance.install({ env: f.env }), /bootstrap failed/);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.restored.length, 1);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'settings').at(-1)[1], { enabled: false, backgroundPath: '/fixture/node:/usr/bin:/bin' });
});

test('repeated installation replaces only owned package and entry', async t => {
  const f = await fixture(t);
  await f.instance.install({ env: f.env });
  await f.instance.install({ env: f.env });
  assert.match(await readFile(userPaths(f.home).bin, 'utf8'), /xenoflux-managed-entry/);
});

test('foreign install paths are refused and paths containing spaces remain supported', async t => {
  const f = await fixture(t);
  await mkdir(userPaths(f.home).app, { recursive: true });
  await writeFile(join(userPaths(f.home).app, 'foreign'), 'do not replace');
  await assert.rejects(f.instance.install({ env: f.env }), /Application path/);
  assert.equal(await readFile(join(userPaths(f.home).app, 'foreign'), 'utf8'), 'do not replace');
});

test('uninstall restores logs and removes only owned artifacts while preserving controller and profiles', async t => {
  const f = await fixture(t);
  await f.instance.install({ env: f.env });
  await mkdir(userPaths(f.home).controller, { recursive: true });
  await mkdir(userPaths(f.home).profiles, { recursive: true });
  await writeFile(join(userPaths(f.home).controller, 'registry.json'), '{}');
  await f.instance.uninstall({ env: f.env });
  assert.equal(f.restored.length, 1);
  assert.equal(await readFile(join(userPaths(f.home).controller, 'registry.json'), 'utf8'), '{}');
  await assert.rejects(access(userPaths(f.home).app));
  await assert.rejects(access(userPaths(f.home).bin));
});


test('reconfiguration and uninstall accept the owned plist with XML-special PATH characters', async t => {
  const f = await fixture(t);
  const backgroundPath = "/custom/a&b/<tools>/say'hi:/usr/bin:/bin";
  await f.instance.install({env:f.env, backgroundPath});
  await f.instance.enable({env:f.env, backgroundPath:'/another/node:/usr/bin:/bin'});
  await f.instance.uninstall({env:f.env});
  await assert.rejects(access(userPaths(f.home).launchAgent), {code:'ENOENT'});
});

test('an unexpected service inspection failure stops uninstall before touching logs or app', async t => {
  let failInspection = false;
  const f = await fixture(t, { serviceLoaded: undefined, runService: async (file,args) => {
    if (args[0] === 'print') throw Object.assign(new Error('inspection failed'), {code:failInspection ? 5 : 113});
  } });
  await f.instance.install({env:f.env});
  failInspection = true;
  await assert.rejects(f.instance.uninstall({env:f.env}), /Unable to inspect/);
  assert.equal(f.restored.length, 0);
  await access(userPaths(f.home).launchAgent);
  await access(userPaths(f.home).app);
  await access(userPaths(f.home).bin);
});
