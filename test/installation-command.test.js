import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/profiles.js';
import { installationCommand, restoreHomeLogs } from '../src/installation-command.js';
import { readLogSettings, writeLogSettings } from '../src/log-storage.js';
import { supportedNode, checkNode, nativePath } from '../src/node-runtime.js';

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'xfx-install-command-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.codex'), { mode: 0o700 });
  const store = new Store(join(home, '.xfx', 'controller'));
  const events = [];
  const runtime = {
    assertExternal: async () => events.push('external'),
    prepareClients: async () => events.push('quit'),
    assertIdle: async () => events.push('idle'),
  };
  return { home, store, events, runtime, lockPath: join(home, 'native-lock') };
}

test('installation holds native authority during routing and releases it on failure', async t => {
  const f = await fixture(t);
  await assert.rejects(installationCommand(f.store, 'install', {
    ...f, userHome: f.home, nodeCheck: async () => f.events.push('node'),
    logs: { prepareHome: async ({home,key}) => {
      assert.equal(home, join(f.home, '.codex')); assert.equal(key, 'default');
      assert.ok((await lstat(f.lockPath)).isDirectory());
      f.events.push('prepare'); throw new Error('mount failed');
    } },
    installation: ({ prepareLogs }) => ({ install: prepareLogs }),
  }), /mount failed/);
  assert.deepEqual(f.events.slice(0, 4), ['node', 'external', 'quit', 'idle']);
  await assert.rejects(lstat(f.lockPath), {code:'ENOENT'});
  await assert.rejects(lstat(f.lockPath + '.selection'), {code:'ENOENT'});
});

test('CLI Node failure precedes client shutdown and controller writes', async t => {
  const f = await fixture(t);
  await assert.rejects(installationCommand(f.store, 'install', { ...f,
    nodeCheck: async () => { throw new Error('missing Node'); }, userHome: f.home,
  }), /missing Node/);
  assert.deepEqual(f.events, []);
  await assert.rejects(lstat(f.store.directory), {code:'ENOENT'});
});

test('disk log cleanup does not read a controller and rejects a self-hosted operation', async t => {
  const f = await fixture(t);
  let restores = 0;
  const logs = { restoreHome: async request => { restores++; return request; } };
  const result = await restoreHomeLogs(join(f.home, '.codex'), 'default', { ...f, logs });
  assert.equal(result.key, 'default'); assert.equal(restores, 1);
  await assert.rejects(restoreHomeLogs(join(f.home, '.codex'), 'default', { ...f, logs,
    runtime: { assertExternal: async () => { throw new Error('external terminal required'); } },
  }), /external terminal/);
  assert.equal(restores, 1);
});

test('RAM mode is explicit, private, and survives a new settings read', async t => {
  const {home} = await fixture(t);
  assert.equal(readLogSettings({home}).enabled, false);
  const settings = {enabled:true, backgroundPath:'/usr/bin:/bin'};
  await writeLogSettings(settings, {home});
  assert.deepEqual(readLogSettings({home}), settings);
  assert.equal((await lstat(join(home,'.xfx','ramlogs','settings.json'))).mode & 0o777, 0o600);
  await writeFile(join(home,'.xfx','ramlogs','settings.json'), '{}');
  assert.throws(() => readLogSettings({home}), /Invalid RAM-log settings/);
});

test('Node prerequisite checks use the passed environment and never pin an executable path', async () => {
  for (const version of ['v20.0.0', 'v22.12.9', 'v23.0.0', 'v23.3.0'])
    assert.equal(supportedNode(version), false, version);
  for (const version of ['v22.13.0', 'v22.14.0', 'v23.4.0', 'v23.11.0', 'v24.0.0'])
    assert.equal(supportedNode(version), true, version);
  assert.throws(() => nativePath({PATH:'.:/bin'}), /absolute/);
  let seen;
  await checkNode({env:{HOME:'/fixture/user',PATH:'/fixture/bin:/bin'}, execute:async (...args) => {
    seen = args; return {stdout:'v22.13.0\n'};
  }});
  assert.equal(seen[0], 'node');
  assert.deepEqual(seen[2].env, {HOME:'/fixture/user',PATH:'/fixture/bin:/bin'});
  await assert.rejects(checkNode({execute: async () => ({stdout:'v20.0.0'})}), /22.13.0/);
});
