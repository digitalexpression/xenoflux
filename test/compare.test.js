import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { compareHomes, openNativeComparison } from '../src/compare.js';

async function put(home, path, content) {
  await mkdir(dirname(join(home, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(home, path), content, { mode: 0o600 });
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-native-compare-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const a = await prepareNativeHome({ directory: join(root, 'native-a'), executable, codexVersion: '0.153.4' });
  const b = await prepareNativeHome({ directory: join(root, 'native-b'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  await registerHome(store, 'A', a.root, { executable, version: '0.153.4' });
  await registerHome(store, 'B', b.root, { executable, version: '0.153.4' });
  const defaultUserHome = join(root, 'user'), defaultProfile = join(defaultUserHome, '.codex');
  await mkdir(defaultProfile, { recursive: true, mode: 0o700 });
  await put(defaultProfile, 'config.toml', 'model = "alpha"\n[agents]\nmax_threads = 2\n[features]\nmulti_agent = true\n');
  await put(defaultProfile, 'AGENTS.md', 'Do safe work. token = "sk-123456789012345"\n');
  await put(b.home, 'AGENTS.override.md', 'Override.\n');
  await put(defaultProfile, 'agents/reviewer.toml', 'name = "reviewer"\ndescription = "Review"\ndeveloper_instructions = "Inspect."\n');
  return { root, store, defaultProfile, defaultUserHome, b };
}

test('compares supported native settings with actual redacted content', async t => {
  const f = await fixture(t);
  const result = await compareHomes(f.store, 'Default', 'B', { include: ['config', 'instructions', 'agents'], defaultUserHome: f.defaultUserHome });
  assert.equal(result.state, 'native-settings-comparison');
  assert.equal(result.effectiveConfigurationVerified, false);
  assert.deepEqual(result.scope.included, ['config', 'instructions', 'agents']);
  assert.equal(result.files.changed.some(file => file.path === 'config.toml'), true);
  assert.equal(result.files.added.some(file => file.path === 'AGENTS.override.md'), true);
  assert.match(result.left.files.find(file => file.path === 'AGENTS.md').content, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), /sk-123456789012345/);
});

test('defaults to every copy-supported component when include is omitted', async t => {
  const f = await fixture(t);
  const result = await compareHomes(f.store, 'Default', 'Default', { defaultUserHome: f.defaultUserHome });
  assert.deepEqual(result.scope.included, ['config', 'instructions', 'agents']);
  const cli = spawnSync(process.execPath, [join(process.cwd(), 'bin', 'xfx.js'), '--json', '--store', join(f.root, 'cli-store'), 'compare', 'Default', 'Default'], {
    cwd: process.cwd(), env: { ...process.env, HOME: f.defaultUserHome }, encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).scope.included, ['config', 'instructions', 'agents']);
});

test('classifies missing settings as additions/removals and mutual absence as unchanged', async t => {
  const f = await fixture(t);
  const result = await compareHomes(f.store, 'Default', 'B', { include: ['instructions'], defaultUserHome: f.defaultUserHome });
  const leftOverride = result.left.files.find(file => file.path === 'AGENTS.override.md');
  assert.equal(leftOverride.status, 'missing');
  assert.equal(result.files.added.some(file => file.path === 'AGENTS.override.md'), true);
  assert.equal(result.files.unavailable.length, 0);
  const equal = await compareHomes(f.store, 'Default', 'Default', { include: ['instructions'], defaultUserHome: f.defaultUserHome });
  assert.equal(equal.summary.changed, 0);
  assert.deepEqual(equal.files.unchanged.map(file => [file.path, file.status]), [['AGENTS.md', 'present'], ['AGENTS.override.md', 'missing']]);
});

test('marks unsafe selected files as unavailable without exposing their contents', async t => {
  const f = await fixture(t);
  await put(f.b.home, 'AGENTS.md', 'safe\0not-readable');
  const result = await compareHomes(f.store, 'Default', 'B', { include: ['instructions'], defaultUserHome: f.defaultUserHome });
  assert.deepEqual(result.files.unavailable.find(file => file.path === 'AGENTS.md'),
    { component: 'instructions', path: 'AGENTS.md', left: 'present', right: 'unreadable' });
  assert.doesNotMatch(JSON.stringify(result), /not-readable/);
});

test('refuses a result when a selected input changes between its two reads', async t => {
  const f = await fixture(t);
  await assert.rejects(compareHomes(f.store, 'Default', 'B', { include: ['instructions'], defaultUserHome: f.defaultUserHome,
    afterFirstCapture: async () => put(f.defaultProfile, 'AGENTS.md', 'Changed after initial read.\n'),
  }), /changed while being compared/);
});

test('does not expose internal input hashes in any public difference', async t => {
  const f = await fixture(t);
  const result = await compareHomes(f.store, 'Default', 'B', { include: ['config', 'instructions'], defaultUserHome: f.defaultUserHome });
  assert.doesNotMatch(JSON.stringify(result), /_inputHash/);
});

test('excludes native settings outside the copy surface', async t => {
  const f = await fixture(t);
  await put(f.defaultProfile, 'auth.json', 'private auth');
  await put(f.b.home, 'history.jsonl', 'private history');
  const result = await compareHomes(f.store, 'Default', 'B', { include: ['config'], defaultUserHome: f.defaultUserHome });
  assert.equal(JSON.stringify(result).includes('private auth'), false);
  assert.equal(JSON.stringify(result).includes('private history'), false);
  assert.ok(result.scope.excluded.includes('sign-in and credentials'));
});

test('creates a detached private redacted viewer tree', async t => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'xfx-native-compare-viewer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await openNativeComparison(f.store, 'Default', 'B', { include: ['instructions'], defaultUserHome: f.defaultUserHome, directory });
  assert.equal(result.viewer.status, 'not-requested');
  const manifest = await readFile(join(result.left, 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifest, /sk-123456789012345/);
  assert.match(await readFile(join(result.left, 'content', 'instructions', 'AGENTS.md'), 'utf8'), /\[REDACTED\]/);
});

test('viewer receives only the safe GUI environment', async t => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'xfx-native-compare-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = ['OPENAI_API_KEY', 'CODEX_HOME', 'VIEWER_SECRET_SENTINEL', 'PATH', 'HOME'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: 'not-for-viewer', CODEX_HOME: '/private/home', VIEWER_SECRET_SENTINEL: 'not-for-viewer', PATH: '/safe-path', HOME: '/safe-home' });
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const script = "const fs=require('fs'); fs.writeFileSync(process.argv[1]+'/environment.json',JSON.stringify({api:process.env.OPENAI_API_KEY??null,home:process.env.CODEX_HOME??null,sentinel:process.env.VIEWER_SECRET_SENTINEL??null,path:process.env.PATH,guiHome:process.env.HOME}))";
  const result = await openNativeComparison(f.store, 'Default', 'B', { include: ['instructions'], defaultUserHome: f.defaultUserHome, directory,
    viewer: { executable: process.execPath, args: ['-e', script, '{left}'] } });
  assert.deepEqual(JSON.parse(await readFile(join(result.left, 'environment.json'), 'utf8')), { api: null, home: null, sentinel: null, path: '/safe-path', guiHome: '/safe-home' });
});
