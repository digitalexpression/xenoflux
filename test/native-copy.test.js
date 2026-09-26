import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { Store, create, renameProfile } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { planCopy, applyCopy, planUndo, undoCopy } from '../src/native-copy.js';
import { createDesktopRuntime, DESKTOP_APP } from '../src/desktop-runtime.js';

const text = path => readFile(path, 'utf8');
const absent = path => assert.rejects(stat(path), { code: 'ENOENT' });
const role = name => `name = "${name}"\ndescription = "A focused role"\ndeveloper_instructions = "Inspect the assigned files."\nmodel = "source-model"\n`;
async function put(home, path, content, mode = 0o600) {
  await writeFile(join(home, path), content, { mode });
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-native-copy-')));
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
  await put(defaultProfile, 'config.toml', 'model = "source-model"\nmodel_reasoning_effort = "high"\n[agents]\nmax_threads = 3\n[features]\nmulti_agent = true\n');
  await put(defaultProfile, 'AGENTS.md', 'Source global instructions.\n');
  await mkdir(join(defaultProfile, 'agents'), { mode: 0o700 });
  await put(defaultProfile, 'agents/reviewer.toml', role('reviewer'));
  await put(b.home, 'AGENTS.md', 'Destination global instructions.\n', 0o640);
  await put(b.home, 'AGENTS.override.md', 'An old overriding instruction.\n');
  await put(b.home, 'auth.json', 'credential sentinel');
  await put(b.home, 'history.jsonl', 'history sentinel');
  const options = { include: ['instructions'], defaultUserHome, lockPath: join(root, 'desktop.lock'), runtime: { assertIdle: async () => {} } };
  return { root, store, a, b, defaultProfile, options };
}

test('preview is read-only and refuses unsupported scope, Default target, and identical homes', async t => {
  const f = await fixture(t), before = await text(join(f.b.home, 'AGENTS.md'));
  const result = await planCopy(f.store, 'Default', 'B', f.options);
  assert.deepEqual(result.changes.map(c => [c.path, c.action]), [['AGENTS.md', 'replace'], ['AGENTS.override.md', 'remove']]);
  assert.ok(!JSON.stringify(result).includes('Source global instructions'));
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), before);
  await absent(join(f.store.directory, 'native-copies'));
  await assert.rejects(planCopy(f.store, 'Default', 'B', { ...f.options, include: ['history'] }), /not supported/);
  await assert.rejects(planCopy(f.store, 'A', 'Default', f.options), /named profile/);
  await assert.rejects(planCopy(f.store, 'A', 'A', f.options), /must be separate/);
});

test('instruction copy preserves config, credentials and history; undo restores bytes and mode', async t => {
  const f = await fixture(t), config = await text(join(f.b.home, 'config.toml'));
  const prior = await text(join(f.b.home, 'AGENTS.md'));
  const preview = await planCopy(f.store, 'Default', 'B', f.options);
  const result = await applyCopy(f.store, 'Default', 'B', { ...f.options, expectedHash: preview.hash });
  assert.equal(result.status, 'applied');
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), await text(join(f.defaultProfile, 'AGENTS.md')));
  await absent(join(f.b.home, 'AGENTS.override.md'));
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
  assert.equal(await text(join(f.b.home, 'config.toml')), config);
  assert.equal(await text(join(f.b.home, 'auth.json')), 'credential sentinel');
  assert.equal(await text(join(f.b.home, 'history.jsonl')), 'history sentinel');
  const undo = await planUndo(f.store, result.id);
  await undoCopy(f.store, result.id, { ...f.options, expectedHash: undo.hash });
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), prior);
  assert.equal((await stat(join(f.b.home, 'AGENTS.md'))).mode & 0o777, 0o640);
  assert.equal(await text(join(f.b.home, 'AGENTS.override.md')), 'An old overriding instruction.\n');
  await absent(join(f.store.directory, 'native-copies/pending.json'));
  await absent(f.options.lockPath);
});

test('copy and a fresh undo runtime both accept verified orphan reporters without lifecycle commands', async t => {
  const f = await fixture(t), before = await text(join(f.b.home, 'AGENTS.md'));
  const fixtureVersion = 'fixture-version', fixtureBuild = 'fixture-build';
  const fixtureCrashReporter = '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/1.2.3/Helpers/browser_crashpad_handler';
  const calls = [];
  const runtime = () => createDesktopRuntime({
    expected: DESKTOP_APP,
    readFile: async () => Buffer.from('copy crashpad fixture'),
    realpath: async () => fixtureCrashReporter,
    processSnapshot: async () => [34503, 34505].map(pid => ({ pid, ppid: 1, uid: process.getuid(),
      startedAt: 'fixture start', executable: fixtureCrashReporter })),
    execFile: async path => {
      calls.push(path);
      if (path === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: DESKTOP_APP.bundleId,
        CFBundleShortVersionString: fixtureVersion, CFBundleVersion: fixtureBuild, CFBundleExecutable: 'ChatGPT' }) };
      if (path === '/usr/bin/codesign') return { stdout: '' };
      assert.fail('Copy and undo must not issue lifecycle commands: ' + path);
    },
  });
  const copyRuntime = runtime();
  const result = await applyCopy(f.store, 'Default', 'B', { ...f.options, runtime: copyRuntime });
  assert.equal(result.status, 'applied');
  assert.equal(copyRuntime.retainedCrashpad().length, 2);
  const undoRuntime = runtime();
  await undoCopy(f.store, result.id, { ...f.options, runtime: undoRuntime });
  assert.equal(undoRuntime.retainedCrashpad().length, 2);
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), before);
  assert.equal(await text(join(f.b.home, 'auth.json')), 'credential sentinel');
  assert.equal(await text(join(f.b.home, 'history.jsonl')), 'history sentinel');
  assert.equal(calls.filter(path => path === '/usr/bin/codesign').length, 2);
  await absent(f.options.lockPath);
  await absent(join(f.store.directory, 'native-copies/pending.json'));
});

test('config projection copies general choices and preserves target routing, integrations and agent settings', async t => {
  const f = await fixture(t), base = await text(join(f.b.home, 'config.toml'));
  await put(f.defaultProfile, 'config.toml', `${await text(join(f.defaultProfile, 'config.toml'))}\nallow_symlinked_codex_home = false\n[mcp_servers.private]\ncommand = "/source/tool"\napi_key = "sk-1234567890abcdef"\n`);
  await put(f.b.home, 'config.toml', stringify({ ...parse(base), model: 'target-model', model_verbosity: 'low',
    notify: ['/target/notify'], agents: { max_threads: 1 }, features: { memories: true },
    plugins: { test: { enabled: true } }, mcp_servers: { local: { command: '/target/tool' } } }));
  const before = parse(await text(join(f.b.home, 'config.toml')));
  const preview = await planCopy(f.store, 'Default', 'B', { ...f.options, include: ['config'] });
  assert.deepEqual(preview.config.enforcedKeys, ['allow_symlinked_codex_home']);
  assert.ok(!preview.config.preservedKeys.includes('allow_symlinked_codex_home'));
  const result = await applyCopy(f.store, 'Default', 'B', { ...f.options, include: ['config'] });
  const after = parse(await text(join(f.b.home, 'config.toml')));
  assert.equal(after.model, 'source-model');
  assert.equal(after.model_reasoning_effort, 'high');
  assert.equal(after.model_verbosity, undefined);
  assert.equal(after.allow_symlinked_codex_home, true);
  for (const key of ['cli_auth_credentials_store', 'sqlite_home', 'notify', 'agents', 'features', 'plugins', 'mcp_servers']) assert.deepEqual(after[key], before[key]);
  assert.ok(!JSON.stringify(result).includes('1234567890abcdef'));
  assert.ok(!(await text(result.backup)).includes('1234567890abcdef'));
});

test('copy preserves TOML dates and table values, repeats without changes, and undoes original bytes', async t => {
  const f = await fixture(t);
  const dates = '\n[retained]\ndate = 2026-09-26\ntime = 07:32:00\noffset = 1979-05-27T07:32:00-07:00\nlocal = 1979-05-27T07:32:00\n';
  const before = `${await text(join(f.b.home, 'config.toml'))}${dates}`;
  await put(f.b.home, 'config.toml', before);
  const result = await applyCopy(f.store, 'Default', 'B', { ...f.options, include: ['config', 'agents'] });
  const copied = await text(join(f.b.home, 'config.toml'));
  for (const [key, value] of Object.entries(parse(before).retained))
    assert.equal(parse(copied).retained[key].toISOString(), value.toISOString());
  const repeated = await planCopy(f.store, 'Default', 'B', { ...f.options, include: ['config', 'agents'] });
  assert.deepEqual(repeated.changes, []);
  await undoCopy(f.store, result.id, f.options);
  assert.equal(await text(join(f.b.home, 'config.toml')), before);
});

test('a copied bounded native configuration remains resolvable and undoable', async t => {
  const f = await fixture(t);
  const retained = '"'.repeat(49 * 1024);
  const before = `${await text(join(f.b.home, 'config.toml'))}\n[mcp_servers.retained]\ncommand = '${retained}'\n`;
  assert.ok(Buffer.byteLength(before) < 64 * 1024);
  await put(f.b.home, 'config.toml', before);

  const result = await applyCopy(f.store, 'Default', 'B', { ...f.options, include: ['config'] });
  const copied = await text(join(f.b.home, 'config.toml'));
  assert.ok(Buffer.byteLength(copied) > 64 * 1024);
  assert.ok(Buffer.byteLength(copied) <= 256 * 1024);

  const undo = await planUndo(f.store, result.id);
  await undoCopy(f.store, result.id, { ...f.options, expectedHash: undo.hash });
  assert.equal(await text(join(f.b.home, 'config.toml')), before);
});

test('copy refuses a configuration projection that expands beyond the new-copy limit', async t => {
  const f = await fixture(t);
  const retained = '"'.repeat(130 * 1024);
  await put(f.b.home, 'config.toml', `${await text(join(f.b.home, 'config.toml'))}\n[mcp_servers.retained]\ncommand = '${retained}'\n`);

  await assert.rejects(planCopy(f.store, 'Default', 'B', { ...f.options, include: ['config'] }),
    /bounded file limit: config\.toml/);
  assert.ok(Buffer.byteLength(await text(join(f.b.home, 'config.toml'))) < 256 * 1024);
});

test('agents selection replaces direct definitions and agent settings while preserving general config', async t => {
  const f = await fixture(t);
  const source = parse(await text(join(f.defaultProfile, 'config.toml')));
  source.agents.default_subagent_model = 'worker-model';
  source.agents.default_subagent_reasoning_effort = 'medium';
  await put(f.defaultProfile, 'config.toml', stringify(source));
  await mkdir(join(f.b.home, 'agents'), { mode: 0o700 });
  await put(f.b.home, 'agents/old.toml', role('old'));
  await put(f.b.home, 'config.toml', stringify({ ...parse(await text(join(f.b.home, 'config.toml'))),
    model: 'target-model', agents: { max_depth: 1 }, features: { memories: true } }));
  const before = await text(join(f.b.home, 'config.toml'));
  const result = await applyCopy(f.store, 'Default', 'B', { ...f.options, include: ['agents'] });
  const after = parse(await text(join(f.b.home, 'config.toml')));
  assert.equal(after.model, 'target-model');
  assert.deepEqual({ ...after.agents }, { max_threads: 3, default_subagent_model: 'worker-model', default_subagent_reasoning_effort: 'medium' });
  assert.deepEqual({ ...after.features }, { memories: true, multi_agent: true });
  assert.deepEqual(await readdir(join(f.b.home, 'agents')), ['reviewer.toml']);
  await undoCopy(f.store, result.id, f.options);
  assert.equal(await text(join(f.b.home, 'config.toml')), before);
  assert.deepEqual(await readdir(join(f.b.home, 'agents')), ['old.toml']);
});

test('agent copy refuses malformed destination tables instead of silently losing selected fields', async t => {
  const f = await fixture(t), original = await text(join(f.b.home, 'config.toml'));
  for (const key of ['features', 'agents']) {
    const config = parse(original); config[key] = ['unexpected'];
    const content = stringify(config); await put(f.b.home, 'config.toml', content);
    await assert.rejects(applyCopy(f.store, 'Default', 'B', { ...f.options, include: ['agents'] }), /require a TOML table/);
    assert.equal(await text(join(f.b.home, 'config.toml')), content);
  }
});

test('changed previews, running clients and newer target edits fail without overwriting', async t => {
  const f = await fixture(t), preview = await planCopy(f.store, 'Default', 'B', f.options);
  await put(f.defaultProfile, 'AGENTS.md', 'Changed source');
  await assert.rejects(applyCopy(f.store, 'Default', 'B', { ...f.options, expectedHash: preview.hash }), /preview changed/);
  await assert.rejects(applyCopy(f.store, 'Default', 'B', { ...f.options, runtime: { assertIdle: async () => { throw new Error('busy client'); } } }), /busy client/);
  await absent(join(f.store.directory, 'native-copies'));
  const result = await applyCopy(f.store, 'Default', 'B', f.options);
  await put(f.b.home, 'AGENTS.md', 'Newer user edit');
  await assert.rejects(undoCopy(f.store, result.id, f.options), /refusing to overwrite/);
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), 'Newer user edit');
  await absent(join(f.store.directory, 'native-copies/pending.json'));
});

test('copy prepares clients before a strict idle check and does not write when preparation declines', async t => {
  const f = await fixture(t), before = await text(join(f.b.home, 'AGENTS.md')), calls = [];
  const runtime = {
    prepareClients: async options => { calls.push(['prepare', options]); throw Object.assign(new Error('declined'), { code: 'CANCELLED' }); },
    assertIdle: async () => calls.push(['idle']),
  };
  await assert.rejects(applyCopy(f.store, 'Default', 'B', { ...f.options, runtime }), { code: 'CANCELLED' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'prepare');
  assert.equal(calls[0][1].includeDesktop, true);
  assert.equal(calls[0][1].cliExecutables.length, 1);
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), before);
  await absent(join(f.store.directory, 'native-copies'));
});

test('deterministic copy and undo conflicts are refused before client preparation', async t => {
  const f = await fixture(t); let preparations = 0;
  const runtime = { prepareClients: async () => { preparations += 1; }, assertIdle: async () => {} };
  const copies = join(f.store.directory, 'native-copies');
  await mkdir(copies, { mode: 0o700 });
  await writeFile(join(copies, 'pending.json'), JSON.stringify({ id: randomUUID() }), { mode: 0o600 });
  await assert.rejects(applyCopy(f.store, 'Default', 'B', { ...f.options, runtime }), /copy needs copy undo pending/);
  assert.equal(preparations, 0);
  await rm(join(copies, 'pending.json'));

  const result = await applyCopy(f.store, 'Default', 'B', f.options);
  await put(f.b.home, 'AGENTS.md', 'Newer destination edit');
  await assert.rejects(undoCopy(f.store, result.id, { ...f.options, runtime }), /refusing to overwrite/);
  assert.equal(preparations, 0);
  await put(f.b.home, 'AGENTS.md', 'Source global instructions.\n');
  await writeFile(join(copies, 'pending.json'), JSON.stringify({ id: randomUUID() }), { mode: 0o600 });
  await assert.rejects(undoCopy(f.store, result.id, { ...f.options, runtime }), /different copy is pending/);
  assert.equal(preparations, 0);
});

test('selected symlinks, hard links, parent symlinks and credential-like text are refused', async t => {
  for (const kind of ['symlink', 'hardlink', 'parent-link', 'secret', 'oversize']) {
    await t.test(kind, async t => {
      const f = await fixture(t), path = join(f.defaultProfile, 'AGENTS.md');
      if (kind === 'symlink' || kind === 'hardlink') {
        await rm(path);
        await (kind === 'symlink' ? symlink : link)(join(f.b.home, 'AGENTS.md'), path);
      } else if (kind === 'parent-link') {
        await rm(join(f.defaultProfile, 'agents'), { recursive: true });
        await symlink(f.b.home, join(f.defaultProfile, 'agents'));
        f.options.include = ['agents'];
      } else await put(f.defaultProfile, 'AGENTS.md', kind === 'secret' ? 'api_key = sk-1234567890abcdef\n' : 'x'.repeat(256 * 1024 + 1));
      await assert.rejects(planCopy(f.store, 'Default', 'B', f.options));
      await absent(join(f.store.directory, 'native-copies'));
    });
  }
});

test('a failed copy rolls back every selected file and releases locks', async t => {
  const f = await fixture(t), prior = await text(join(f.b.home, 'AGENTS.md'));
  await assert.rejects(applyCopy(f.store, 'Default', 'B', { ...f.options, checkpoint: async () => { throw new Error('injected failure'); } }), /prior settings were restored/);
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), prior);
  assert.equal(await text(join(f.b.home, 'AGENTS.override.md')), 'An old overriding instruction.\n');
  for (const path of [f.options.lockPath, f.options.lockPath + '.selection', join(f.b.root, '.run-lock'), join(f.store.directory, 'native-copies/pending.json')]) await absent(path);
});

test('interrupted undo resumes through pending without overwriting unrelated edits', async t => {
  const f = await fixture(t), prior = await text(join(f.b.home, 'AGENTS.md'));
  const result = await applyCopy(f.store, 'Default', 'B', f.options);
  await assert.rejects(undoCopy(f.store, result.id, { ...f.options, checkpoint: async () => { throw new Error('interrupted undo'); } }), /interrupted undo/);
  assert.equal((await planUndo(f.store, 'pending')).id, result.id);
  await undoCopy(f.store, 'pending', f.options);
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), prior);
  await absent(join(f.store.directory, 'native-copies/pending.json'));
});

test('completed undo recovers its stale locks without asking any applications to close', async t => {
  const f = await fixture(t);
  const result = await applyCopy(f.store, 'Default', 'B', f.options);
  await undoCopy(f.store, result.id, f.options);
  const locks = [f.options.lockPath + '.selection', f.options.lockPath, join(f.b.root, '.run-lock')];
  const owner = { kind: 'native-copy', host: hostname(), pid: 7654321, runId: result.id, storePath: f.store.directory };
  for (const path of locks) {
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  }
  await writeFile(join(f.store.directory, 'native-copies/pending.json'), JSON.stringify({ id: result.id }), { mode: 0o600 });
  const undo = await undoCopy(f.store, 'pending', { ...f.options, isAlive: () => false,
    runtime: { prepareClients: async () => assert.fail('completed undo must not close apps'),
      assertIdle: async () => assert.fail('completed undo only cleans metadata') } });
  assert.equal(undo.status, 'undone');
  for (const path of [...locks, join(f.store.directory, 'native-copies/pending.json')]) await absent(path);
});

test('hard exit after a write is recoverable using the recorded pending copy and dead-owner locks', async t => {
  const f = await fixture(t), prior = await text(join(f.b.home, 'AGENTS.md'));
  const modules = { profiles: new URL('../src/profiles.js', import.meta.url).href, copy: new URL('../src/native-copy.js', import.meta.url).href };
  const script = `import { Store } from ${JSON.stringify(modules.profiles)}; import { applyCopy } from ${JSON.stringify(modules.copy)};
    await applyCopy(new Store(${JSON.stringify(f.store.directory)}), 'Default', 'B', {
      include: ['instructions'], defaultUserHome: ${JSON.stringify(f.options.defaultUserHome)}, lockPath: ${JSON.stringify(f.options.lockPath)},
      runtime: { assertIdle: async () => {} }, checkpoint: async () => process.exit(77)
    });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 77, child.stderr);
  assert.notEqual(await text(join(f.b.home, 'AGENTS.md')), prior);
  await f.store.update(data => renameProfile(data, 'B', 'Research'));
  await undoCopy(f.store, 'pending', f.options);
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), prior);
  for (const path of [f.options.lockPath, f.options.lockPath + '.selection', join(f.b.root, '.run-lock')]) await absent(path);
});

test('journal tampering and externally rerouted destination files are refused during undo', async t => {
  const f = await fixture(t), result = await applyCopy(f.store, 'Default', 'B', f.options);
  const original = await text(result.backup), j = JSON.parse(original);
  j.files[0].path = '../outside';
  await writeFile(result.backup, JSON.stringify(j));
  await assert.rejects(planUndo(f.store, result.id), /Invalid settings-copy journal/);
  await writeFile(result.backup, original);
  await rm(join(f.b.home, 'AGENTS.md'));
  await symlink(join(f.defaultProfile, 'AGENTS.md'), join(f.b.home, 'AGENTS.md'));
  await assert.rejects(undoCopy(f.store, result.id, f.options), /Unsafe or unreadable/);
});

test('renaming a profile does not prevent undo into the same bound home', async t => {
  const f = await fixture(t), prior = await text(join(f.b.home, 'AGENTS.md'));
  const result = await applyCopy(f.store, 'Default', 'B', f.options);
  await f.store.update(data => renameProfile(data, 'B', 'Research'));
  await undoCopy(f.store, result.id, f.options);
  assert.equal(await text(join(f.b.home, 'AGENTS.md')), prior);
});

test('config copy refuses custom providers instead of combining a model with different routing', async t => {
  const f = await fixture(t);
  const from = parse(await text(join(f.defaultProfile, 'config.toml')));
  await put(f.defaultProfile, 'config.toml', stringify({ ...from, model_provider: 'custom' }));
  await assert.rejects(planCopy(f.store, 'Default', 'B', { ...f.options, include: ['config'] }), /custom model providers/);
  await absent(join(f.store.directory, 'native-copies'));
});
