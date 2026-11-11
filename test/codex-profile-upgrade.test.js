import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { Store } from '../src/profiles.js';
import { createHome, startHomeSignIn } from '../src/home-create.js';
import { listHomes, resolveHome } from '../src/homes.js';
import { launchHome, launchPlan } from '../src/launcher.js';
import { desktopInstancePlan } from '../src/desktop-instances.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp('/private/tmp/xfx-codex-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), base = join(root, 'profiles');
  await mkdir(bin, { mode: 0o700 });
  await mkdir(base, { mode: 0o700 });
  const old = join(root, 'codex-v1'), current = join(root, 'codex-v2'), next = join(root, 'codex-v3');
  for (const [index, path] of [old, current, next].entries())
    await writeFile(path, '#!/bin/sh\nprintf "codex ' + (index + 1) + '.0.0\\n"\n', { mode: 0o700 });
  const command = join(bin, 'codex');
  await symlink(current, command);
  const store = new Store(join(root, 'controller'));
  const created = await createHome({ store, name: 'Upgrade', base, executable: old, version: '1.0.0' });
  const bytes = await readFile(store.file, 'utf8');
  await rm(old);
  const env = { PATH: bin + ':' + dirname(process.execPath) + ':/usr/bin:/bin' };
  const switchCli = async () => { await unlink(command); await symlink(next, command); };
  return { root, store, base, env, current, next, command, bytes, created, switchCli };
}
const ramLogs = { prepareHome: async () => {} };

test('Codex metadata and fresh Desktop plans survive removal of the registration-time CLI', async t => {
  const f = await fixture(t);
  assert.equal((await resolveHome(f.store, 'Upgrade')).environment.home, f.created.home);
  assert.equal((await listHomes(f.store))[0].state, 'ready');
  let version = '99.0.0';
  const runtime = { inspectApp: async () => ({ appPath: '/fixture/Codex.app', executable: '/fixture/Codex.app/Contents/MacOS/Codex', version }) };
  assert.equal((await desktopInstancePlan(f.store, 'Upgrade', { runtime })).app.version, version);
  version = '100.0.0';
  assert.equal((await desktopInstancePlan(f.store, 'Upgrade', { runtime })).app.version, version);
  await unlink(f.command);
  await assert.rejects(launchPlan(f.store, 'Upgrade', { PATH: join(f.root, 'bin') }), /unavailable on PATH/);
  assert.equal((await listHomes(f.store))[0].state, 'ready');
  assert.equal(await readFile(f.store.file, 'utf8'), f.bytes);
});

test('Codex launch and sign-in use the current selection while registration keeps its history', async t => {
  const f = await fixture(t);
  const plan = await launchPlan(f.store, 'Upgrade', f.env);
  assert.equal(await realpath(plan.executable), f.current);
  assert.equal(plan.version, null);
  const result = await launchHome(f.store, 'Upgrade', { terminalEnvironment: f.env, ramLogs,
    probe: async () => '2.0.0', run: async options => {
      assert.equal(await realpath(options.executable), f.current);
      return { exitCode: 0, shutdown: { groupTerminated: true } };
    } });
  assert.equal(result.status, 'exited');
  assert.equal(result.version, '2.0.0');
  const login = await startHomeSignIn({ store: f.store, name: 'Upgrade', base: f.base, terminalEnvironment: f.env, ramLogs,
    probe: async () => '2.0.0', run: async options => {
      assert.equal(await realpath(options.executable), f.current);
      return { exitCode: 0 };
    } });
  assert.equal(login.native.version, '2.0.0');
  assert.equal(await readFile(f.store.file, 'utf8'), f.bytes);
});

test('Codex selection changes during launch or sign-in preparation refuse dispatch', async t => {
  const f = await fixture(t);
  let calls = 0;
  const outcome = await launchHome(f.store, 'Upgrade', { terminalEnvironment: f.env, ramLogs,
    probe: async () => { await f.switchCli(); return '2.0.0'; }, run: async () => { calls++; } });
  assert.equal(outcome.error, 'EXECUTABLE_CHANGED');
  assert.equal(calls, 0);
  await unlink(f.command);
  await symlink(f.current, f.command);
  await assert.rejects(startHomeSignIn({ store: f.store, name: 'Upgrade', base: f.base, terminalEnvironment: f.env, ramLogs,
    probe: async () => { await f.switchCli(); return '2.0.0'; }, run: async () => { calls++; } }), { code: 'EXECUTABLE_CHANGED' });
  assert.equal(calls, 0);
  assert.equal(await readFile(f.store.file, 'utf8'), f.bytes);
});

test('Codex preparation selects the current CLI instead of inheriting a previous profile executable', async t => {
  const f = await fixture(t);
  const module = new URL('../src/profile-command.js', import.meta.url).href;
  const code = 'import { nativeClient } from ' + JSON.stringify(module) + '; console.log(JSON.stringify(await nativeClient(null, {})))';
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: f.env.PATH, TMPDIR: '/private/tmp' }, timeout: 10000,
  });
  assert.deepEqual(JSON.parse(stdout), { executable: f.current, version: '2.0.0' });
  assert.equal(await readFile(f.store.file, 'utf8'), f.bytes);
});
