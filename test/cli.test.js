import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const executable = fileURLToPath(new URL('../bin/xfx.js', import.meta.url));

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, 'controller'), codex = join(root, 'codex');
  await mkdir(codex, { mode: 0o700 });
  await writeFile(join(codex, 'auth.json'), 'credential sentinel', { mode: 0o600 });
  const run = (...args) => {
    const result = spawnSync(process.execPath, [executable, '--store', store, '--json', ...args], {
      encoding: 'utf8', env: { ...process.env, CODEX_HOME: codex },
    });
    return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null };
  };
  const ok = (...args) => { const result = run(...args); assert.equal(result.status, 0, result.stderr); return result.value; };
  return { root, store, codex, run, ok };
}

test('help and retained read-only commands do not create a controller', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.ok('profile', 'list'), []);
  assert.deepEqual(f.ok('desktop', 'current'), { status: 'unmanaged', activeProfile: null });
  await assert.rejects(stat(f.store), { code: 'ENOENT' });
  const help = spawnSync(process.execPath, [executable, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /profile create NAME/);
  assert.doesNotMatch(help.stdout, /\n  home /);
  assert.match(help.stdout, /desktop add-target NAME/);
  assert.doesNotMatch(help.stdout, /asset put|checkpoint create|storage migrate/);
});

test('profile registry commands change only requested metadata', async t => {
  const f = await fixture(t);
  const native = join(f.root, 'native'), binary = join(f.root, 'codex-bin');
  for (const path of [native, join(native, 'codex-home'), join(native, 'workspace'), join(native, 'user-home'), join(native, 'tmp')])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(native, 'codex-home', 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  const created = f.ok('profile', 'register', 'daily', native, '--codex', binary, '--codex-version', '0.153.4');
  assert.equal(created.revision, 2);
  f.ok('profile', 'rename', 'daily', 'renamed');
  const repository = join(f.root, 'repository'); await mkdir(repository, { mode: 0o700 });
  const bound = f.ok('profile', 'bind', 'renamed', repository);
  assert.equal(bound.repositories[0].path, repository);
  const after = f.ok('profile', 'unbind', 'renamed', repository);
  assert.deepEqual(after.repositories, []);
  assert.equal(f.ok('profile', 'unbind', 'renamed').native, undefined);
  assert.equal((await stat(native)).isDirectory(), true);
  assert.equal(f.ok('profile', 'delete', 'renamed').name, 'renamed');
  assert.deepEqual(f.ok('profile', 'list'), []);
  assert.equal(await readFile(join(f.codex, 'auth.json'), 'utf8'), 'credential sentinel');
});

test('retired stored-policy commands and their flags fail before changing the registry', async t => {
  const f = await fixture(t);
  for (const args of [
    ['asset', 'list', 'missing'], ['checkpoint', 'list', 'missing'], ['set', 'missing', 'instructions', 'shared'],
    ['verify', 'missing'], ['duplicate', 'missing', 'copy'], ['storage', 'plan', '/tmp/x'],
    ['create', 'p'], ['list'], ['inspect', 'p'], ['rename', 'p', 'q'], ['delete', 'p'], ['bind', 'p', '/tmp'], ['unbind', 'p', '/tmp'],
    ['home', 'list'], ['compare', 'a', 'b', '--scope', 'global'],
  ]) assert.equal(f.run(...args).status, 1, args.join(' '));
  await assert.rejects(stat(f.store), { code: 'ENOENT' });
});

test('profile register validates first, atomically creates its record, and leaves credentials untouched', async t => {
  const f = await fixture(t), native = join(f.root, 'native'), binary = join(f.root, 'codex-bin');
  for (const path of [native, join(native, 'codex-home'), join(native, 'workspace'), join(native, 'user-home'), join(native, 'tmp')])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(native, 'codex-home', 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  await writeFile(join(native, 'codex-home', 'auth.json'), 'native credential sentinel', { mode: 0o600 });
  const profile = f.ok('profile', 'register', 'work', native, '--codex', binary, '--codex-version', '0.153.4');
  assert.ok(profile.native.environmentId);
  const inspected = f.ok('profile', 'inspect', 'work');
  assert.equal(inspected.home, join(native, 'codex-home'));
  assert.ok(inspected.logStorage);
  assert.equal(await readFile(join(native, 'codex-home', 'auth.json'), 'utf8'), 'native credential sentinel');
});

test('malformed stores and symbolic manifests fail closed', async t => {
  const f = await fixture(t);
  const native = join(f.root, 'native'), binary = join(f.root, 'codex-bin');
  for (const path of [native, join(native, 'codex-home'), join(native, 'workspace'), join(native, 'user-home'), join(native, 'tmp')])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(native, 'codex-home', 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  f.ok('profile', 'register', 'one', native, '--codex', binary, '--codex-version', '0.153.4');
  const file = join(f.store, 'profiles.json');
  await writeFile(file, '{broken', { mode: 0o600 });
  assert.equal(f.run('profile', 'register', 'two', native, '--codex', binary, '--codex-version', '0.153.4').status, 1);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await rm(file); await symlink(join(f.codex, 'auth.json'), file);
  assert.equal(f.run('profile', 'list').status, 1);
  assert.equal(await readFile(join(f.codex, 'auth.json'), 'utf8'), 'credential sentinel');
  assert.deepEqual((await readdir(f.store)).sort(), ['profiles.json']);
});

test('profile recovery validates arguments and requires an external terminal for apply', async t => {
  const f = await fixture(t);
  assert.match(f.run('profile', 'recover').stderr, /Use profile recover NAME/);
  assert.match(f.run('profile', 'recover', 'work', '--apply').stderr, /external interactive terminal/);
  assert.match(f.run('profile', 'recover', 'work', '--close-clients').stderr, /not supported/);
  await assert.rejects(stat(f.store), { code: 'ENOENT' });
});

test('RAM-log recovery requires an external terminal without creating controller state',async t=>{
  const f=await fixture(t), result=f.run('ramlogs','recover','--close-clients');
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/external interactive terminal/);
  await assert.rejects(stat(f.store),{code:'ENOENT'});
});
