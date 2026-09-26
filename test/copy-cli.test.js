import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';

const cli = new URL('../bin/xfx.js', import.meta.url).pathname;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-copy-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const a = await prepareNativeHome({ directory: join(root, 'a'), executable, codexVersion: '0.153.4' });
  const b = await prepareNativeHome({ directory: join(root, 'b'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  await registerHome(store, 'A', a.root, { executable, version: '0.153.4' });
  await registerHome(store, 'B', b.root, { executable, version: '0.153.4' });
  await writeFile(join(a.home, 'config.toml'), `${await readFile(join(a.home, 'config.toml'), 'utf8')}model = "source-model"\n`, { mode: 0o600 });
  return { root, store, a, b };
}

function run(f, ...args) {
  return spawnSync(process.execPath, [cli, '--store', f.store.directory, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: f.root },
  });
}

async function absent(path) { await assert.rejects(stat(path), { code: 'ENOENT' }); }

test('copy preview with explicit include is JSON-safe and leaves native homes and backup storage untouched', async t => {
  const f = await fixture(t), target = join(f.b.home, 'config.toml');
  const before = await readFile(target, 'utf8');
  const result = run(f, '--json', 'copy', 'A', 'B', '--include', 'config');
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.status, 'preview');
  assert.deepEqual(preview.components, ['config']);
  assert.match(preview.config.scope, /General model/);
  assert.ok(preview.changes.some(change => change.path === 'config.toml'));
  assert.equal(await readFile(target, 'utf8'), before);
  await absent(join(f.store.directory, 'native-copies'));
});

test('copy parser rejects unsupported selections and conflicting flags before copy storage exists', async t => {
  const f = await fixture(t);
  for (const args of [
    ['--json', 'copy', 'A', 'B', '--include', 'history'],
    ['--json', 'copy', 'undo', 'pending', '--include', 'config'],
    ['--json', 'copy', 'A', 'B', '--include', 'config,config'],
    ['--json', 'copy', 'A', 'B', '--include', 'config', '--apply', '--dry-run'],
  ]) {
    const result = run(f, ...args);
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
  }
  await absent(join(f.store.directory, 'native-copies'));
});

test('copy and undo mutation are refused in a noninteractive terminal before native work', async t => {
  const f = await fixture(t), target = join(f.b.home, 'config.toml');
  const before = await readFile(target, 'utf8');
  for (const args of [
    ['--json', 'copy', 'A', 'B', '--include', 'config', '--apply'],
    ['--json', 'copy', 'undo', 'pending', '--apply'],
    ['--json', 'copy', 'A', 'B', '--include', 'config', '--apply', '--close-clients'],
    ['--json', 'copy', 'undo', 'pending', '--apply', '--close-clients'],
  ]) {
    const result = run(f, ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /external interactive terminal/);
  }
  assert.equal(await readFile(target, 'utf8'), before);
  await absent(join(f.store.directory, 'native-copies'));
});

test('help documents preview, application, and undo without exposing unsupported categories', async () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /copy SOURCE TARGET \[--include config,instructions,agents\]/);
  assert.match(result.stdout, /copy undo COPY_ID/);
  assert.match(result.stdout, /--close-clients/);
  assert.match(result.stdout, /Read-only operations never quit applications/);
});
