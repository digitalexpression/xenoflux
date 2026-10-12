import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile, lstat, access, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, create, renameProfile, bind } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome, listHomes } from '../src/homes.js';
import { launchPlan, launchHome } from '../src/launcher.js';

const cli = new URL('../bin/xfx.js', import.meta.url).pathname;
const shutdown = { groupTerminated: true, escapedDescendantsUnverified: true };
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-launch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const a = await prepareNativeHome({ directory: join(root, 'native-a'), executable, codexVersion: '0.153.4' });
  const b = await prepareNativeHome({ directory: join(root, 'native-b'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  await registerHome(store, 'A', a.root, { executable, version: '0.153.4' });
  await registerHome(store, 'B', b.root, { executable, version: '0.153.4' });
  const profiles = await store.read();
  a.native = profiles.profiles.find(profile => profile.name === 'A').native;
  b.native = profiles.profiles.find(profile => profile.name === 'B').native;
  const ramCalls = [];
  const ramLogs = { prepareHome: async options => { ramCalls.push(options); } };
  return { root, executable, a, b, store, ramCalls, ramLogs };
}
const launch = (f, name, options = {}) => launchHome(f.store, name, { ramLogs: f.ramLogs, ...options });

const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function task(environment, cwd = environment.cwd, rollout) {
  const path = rollout ?? join(environment.home, `rollout-test-${taskId}.jsonl`);
  await writeFile(path, '{"synthetic":true}\n', { mode: 0o600 });
  const literal = v => `'${v.replaceAll("'", "''")}'`;
  await promisify(execFile)('/usr/bin/sqlite3', ['-init','/dev/null',join(environment.home, 'state_5.sqlite'),
    'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, rollout_path TEXT);'+
    `INSERT INTO threads VALUES (${literal(taskId)},${literal(cwd)},'Local fixture',1,2,0,${literal(path)});`]);
  return path;
}

test('repository launches require an explicit binding and preserve the same fixed native home', async t => {
  const f = await fixture(t), repo = join(f.root, 'work'); await mkdir(repo);
  await assert.rejects(launchPlan(f.store, 'A', undefined, { repository: repo }), /Bind this repository/);
  await f.store.update(data => bind(data, 'A', repo));
  const alias = join(f.root, 'alias'); await symlink(repo, alias);
  const plan = await launchPlan(f.store, 'A', undefined, { repository: alias });
  assert.equal(plan.cwd, repo); assert.equal(plan.home, f.a.home);
  assert.equal(plan.env.CODEX_SQLITE_HOME, plan.home);
  await assert.rejects(launchPlan(f.store, 'B', undefined, { repository: repo }), /Bind this repository/);
});

test('resume selects the exact source home even when both homes contain the same task ID', async t => {
  const f = await fixture(t);
  for (const e of [f.a, f.b]) await task(e);
  for (const label of ['A','B']) {
    const plan = await launchPlan(f.store, label, undefined, { resumeId: taskId });
    assert.equal(plan.operation, 'resume'); assert.equal(plan.resumeId, taskId);
    assert.equal(plan.home, label === 'A' ? f.a.home : f.b.home);
    assert.deepEqual(plan.args.slice(0,2), ['resume',taskId]);
    const result = await launch(f, label, { resumeId: taskId, probe: async ()=>'0.153.4', run: async opts=> {
      assert.equal(opts.env.CODEX_HOME, plan.home); assert.equal(opts.cwd, plan.cwd);
      await opts.onSpawn(123); return {exitCode:0,signal:null,shutdown};
    }});
    assert.equal(result.resumeId, taskId); assert.equal(result.status, 'exited');
  }
  const {stdout} = await promisify(execFile)(process.execPath,[cli,'--store',f.store.directory,'resume','A',taskId,'--dry-run','--json']);
  assert.equal(JSON.parse(stdout).home, f.a.home);
});

test('resume refuses transcript paths outside the selected home without translating matching relative paths', async t => {
  const f = await fixture(t);
  const relativeTranscript = join('sessions', 'rollout.jsonl');
  const inHome = join(f.a.home, relativeTranscript);
  const external = join(f.root, 'legacy-default-home', relativeTranscript);
  await mkdir(dirname(inHome), { recursive: true, mode: 0o700 });
  await mkdir(dirname(external), { recursive: true, mode: 0o700 });
  await writeFile(inHome, 'bound home transcript\n', { mode: 0o600 });
  await writeFile(external, 'outside transcript\n', { mode: 0o600 });
  await task(f.a, f.a.cwd, inHome);
  const db = join(f.a.home, 'state_5.sqlite');
  await promisify(execFile)('/usr/bin/sqlite3', [db,
    `UPDATE threads SET rollout_path='${external.replaceAll("'", "''")}';`]);
  await assert.rejects(launchPlan(f.store, 'A', undefined, { resumeId: taskId }), /transcript is unavailable/);
  const recorded = (await promisify(execFile)('/usr/bin/sqlite3', ['-readonly', db, 'SELECT rollout_path FROM threads;'])).stdout.trim();
  assert.equal(recorded, external);
  await assert.rejects(access(join(f.a.root, 'launches')), { code: 'ENOENT' });
});

test('history CLI reads combined fixture metadata without creating a launch record or changing the store', async t => {
  const f = await fixture(t); await task(f.a);
  const before = await readFile(f.store.file);
  const run = args => promisify(execFile)(process.execPath,[cli,'--store',f.store.directory,...args]);
  const result = JSON.parse((await run(['history','--json','--profile','A','--search','fixture','--limit','1'])).stdout);
  assert.equal(result.entries.length,1); assert.equal(result.entries[0].profileName,'A');
  assert.deepEqual(await readFile(f.store.file),before);
  for(const args of [['history','--limit','0'],['history','--limit','101'],['history','--repo',f.root],['launch','A','--search','x']]) await assert.rejects(run(args));
  await assert.rejects(access(join(f.a.root, 'launches')),{code:'ENOENT'});
});

test('preview fixes all native paths without inheriting parent credentials or creating launch state', async t => {
  const f = await fixture(t);
  const a = await launchPlan(f.store, 'A', { CODEX_HOME: '/wrong', OPENAI_API_KEY: 'secret', TERM: 'screen-256color', LANG: 'en_US.UTF-8', COLORTERM: '\u001bunsafe' });
  const b = await launchPlan(f.store, 'B');
  assert.equal(a.env.CODEX_HOME, f.a.home);
  assert.equal(a.env.CODEX_SQLITE_HOME, a.env.CODEX_HOME);
  assert.equal(a.env.HOME, f.a.userHome);
  assert.equal(a.env.TMPDIR, f.a.temporary);
  assert.equal(a.env.TERM, 'screen-256color'); assert.equal(a.env.LANG, 'en_US.UTF-8');
  assert.equal(a.env.OPENAI_API_KEY, undefined); assert.equal(a.env.COLORTERM, undefined);
  assert.deepEqual(a.args, ['--no-alt-screen', '--cd', a.cwd, '-c', `sqlite_home=${JSON.stringify(a.home)}`]);
  assert.notEqual(a.home, b.home);
  await assert.rejects(access(join(f.a.root, 'launches')), { code: 'ENOENT' });
  await assert.rejects(access(join(f.a.root, '.run-lock')), { code: 'ENOENT' });
});

test('launch accepts a newer probed CLI, journals only metadata, and retains native settings after exit and profile rename', async t => {
  const f = await fixture(t);
  const config = join(f.a.home, 'config.toml');
  const result = await launch(f, 'A', { probe: async () => '0.154.0', run: async options => {
    await options.onSpawn(123);
    await assert.rejects(launch(f, 'A'), /in use/);
    await writeFile(join(options.env.CODEX_HOME, 'auth.json'), 'not-read-or-recorded', { mode: 0o600 });
    await writeFile(config, `${await readFile(config, 'utf8')}\nmodel = "native-choice"\n`, { mode: 0o600 });
    await f.store.update(data => renameProfile(data, 'A', 'Renamed'));
    return { exitCode: 0, signal: null, shutdown };
  } });
  assert.equal(result.status, 'exited'); assert.equal(result.pid, 123);
  assert.equal(result.version, '0.154.0');
  assert.equal(result.postflight, 'paths-and-auth-metadata-checked');
  assert.equal((await lstat(result.reportPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(result.reportPath, 'utf8'), /not-read-or-recorded|native-choice/);
  await assert.rejects(access(join(f.a.root, '.run-lock')), { code: 'ENOENT' });
  assert.equal((await launchPlan(f.store, 'Renamed')).configurationChangedSinceRegistration, false);
});

test('launch refuses changed executable and releases its lock before native interaction', async t => {
  const f = await fixture(t); let started = false;
  const result = await launch(f, 'A', { probe: async () => {
    await writeFile(f.executable, '#!/bin/sh\nexit 100\n'); return '0.153.4';
  }, run: async () => { started = true; } });
  assert.equal(result.status, 'incomplete'); assert.equal(result.error, 'EXECUTABLE_CHANGED');
  assert.equal(started, false);
  await assert.rejects(access(join(f.a.root, '.run-lock')), { code: 'ENOENT' });
});

test('uncertain shutdown retains the lock and static failure without private error text', async t => {
  const f = await fixture(t);
  const result = await launch(f, 'A', { probe: async () => '0.153.4', run: async () => {
    throw Object.assign(new Error('private error text'), { code: 'SHUTDOWN_FAILED' });
  } });
  assert.equal(result.error, 'SHUTDOWN_FAILED');
  assert.equal(result.postflight, undefined);
  await access(join(f.a.root, '.run-lock'));
  assert.doesNotMatch(await readFile(result.reportPath, 'utf8'), /private error text/);
  await assert.rejects(launch(f, 'A'), /in use/);
});

test('postflight rejects a native credential backend change without rewriting it', async t => {
  const f = await fixture(t);
  const config = join(f.a.home, 'config.toml');
  const result = await launch(f, 'A', { probe: async () => '0.153.4', run: async () => {
    await writeFile(config, 'cli_auth_credentials_store = "keyring"\n');
    return { exitCode: 0, signal: null, shutdown };
  } });
  assert.equal(result.status, 'incomplete'); assert.equal(result.postflight, 'failed');
  assert.match(await readFile(config, 'utf8'), /keyring/);
});

test('native sqlite redirection fails preflight and postflight and never becomes a ready home', async t => {
  const f = await fixture(t);
  const config = join(f.a.home, 'config.toml');
  const result = await launch(f, 'A', { probe: async () => '0.153.4', run: async () => {
    await writeFile(config, 'cli_auth_credentials_store = "file"\nsqlite_home = "/other/home"\n');
    return { exitCode: 0, signal: null, shutdown };
  } });
  assert.equal(result.status, 'incomplete'); assert.equal(result.postflight, 'failed');
  await assert.rejects(launchPlan(f.store, 'A'), /Native configuration must use the bound file credential store/);
  assert.equal((await listHomes(f.store))[0].state, 'unavailable');
});

test('CLI supports noninteractive dry-run and rejects interactive launch or picker without a TTY', async t => {
  const f = await fixture(t);
  const run = args => promisify(execFile)(process.execPath, [cli, '--store', join(f.root, 'store'), ...args]);
  const plan = JSON.parse((await run(['launch', 'A', '--dry-run', '--json'])).stdout);
  assert.equal(plan.home, f.a.home);
  for (const args of [['launch', 'A'], ['pick'], ['profile', 'list', '--dry-run']]) await assert.rejects(run(args));
  await assert.rejects(access(join(f.a.root, 'launches')), { code: 'ENOENT' });
});

test('RAM log preparation follows launch preflight and prevents spawning if it fails', async t => {
  const f = await fixture(t), order = [];
  const result = await launch(f, 'A', {
    probe: async () => { order.push('probe'); return '0.153.4'; },
    ramLogs: { prepareHome: async options => { order.push(`ram:${options.key}`); } },
    run: async () => { order.push('run'); return { exitCode: 0, signal: null, shutdown }; },
  });
  assert.equal(result.status, 'exited');
  assert.deepEqual(order, ['probe', `ram:${f.a.native.environmentId}`, 'run']);

  let spawned = false;
  const failed = await launch(f, 'B', {
    probe: async () => '0.153.4',
    ramLogs: { prepareHome: async () => { throw Object.assign(new Error('RAM unavailable'), { code: 'RAM_LOGS_UNAVAILABLE' }); } },
    run: async () => { spawned = true; },
  });
  assert.equal(failed.status, 'incomplete');
  assert.equal(failed.error, 'RAM_LOGS_UNAVAILABLE');
  assert.equal(spawned, false);
  await assert.rejects(access(join(f.b.root, '.run-lock')), { code: 'ENOENT' });
});
