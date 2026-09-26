import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile, lstat, access, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { userInfo } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
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

async function writePairedActivation(store, natives) {
  const data = await store.read(), defaultUserHome = userInfo().homedir;
  const profiles = data.profiles.map((profile, index) => {
    const native = natives[index], activationTarget = `profile:${profile.id}`;
    return { profileId: profile.id, name: profile.name, native: profile.native, activationTarget,
      environmentId: profile.native.environmentId, home: native.home, cwd: native.cwd, desktopData: native.desktopData };
  });
  const aliases = [join(defaultUserHome, '.codex'), join(defaultUserHome, 'Library', 'Application Support', 'Codex')];
  const components = ['codex-home', 'desktop-data'].map((name, index) => ({ name, alias: aliases[index],
    original: `${aliases[index]}.xenoflux-original`, originalFact: { path: aliases[index] },
    targets: Object.fromEntries(profiles.map(profile => [profile.activationTarget, index === 0 ? profile.home : profile.desktopData])) }));
  const facts = [...new Set(components.flatMap(component => [dirname(component.alias), ...Object.values(component.targets),
    ...Object.values(component.targets).map(dirname)]))].sort().map(path => ({ path }));
  const cliByProfile = Object.fromEntries(profiles.map(profile => [profile.profileId,
    { executable: profile.native.executable, identity: profile.native.executableIdentity, version: profile.native.version }]));
  const body = { schemaVersion: 1, kind: 'paired-native-home-plan', id: randomUUID(), storePath: store.directory, defaultUserHome,
    app: {}, cliByProfile, profiles, components, facts,
    originalRouting: {}, resourcePaths: [], resourcePolicy: '', steps: [], liveHomeChanged: false };
  await mkdir(join(store.directory, 'activation'), { recursive: true, mode: 0o700 });
  await writeFile(join(store.directory, 'activation', 'manifest.json'), `${JSON.stringify({ ...body,
    approvalId: createHash('sha256').update(JSON.stringify(body)).digest('hex') })}\n`, { mode: 0o600 });
}

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

test('resume translates a trusted recorded .codex transcript into the originating home and preserves workspace boundaries', async t => {
  const f = await fixture(t), repo = join(f.root, 'work'); await mkdir(repo);
  const source = f.a;
  const transcript = join(source.home, 'sessions', 'rollout.jsonl');
  await mkdir(dirname(transcript), { recursive: true, mode: 0o700 });
  await task(source, repo, transcript);
  await writePairedActivation(f.store, [f.a, f.b]);
  const recorded = join(userInfo().homedir, '.codex', 'sessions', 'rollout.jsonl');
  await promisify(execFile)('/usr/bin/sqlite3', [join(source.home, 'state_5.sqlite'),
    `UPDATE threads SET rollout_path='${recorded.replaceAll("'", "''")}';`]);
  await f.store.update(async data => { await bind(data, 'A', repo); await bind(data, 'A', source.cwd); });

  const plan = await launchPlan(f.store, 'A', undefined, { resumeId: taskId });
  assert.equal(plan.home, source.home); assert.equal(plan.cwd, repo);
  assert.deepEqual(plan.args.slice(0, 2), ['resume', taskId]);
  const { stdout } = await promisify(execFile)(process.execPath,
    [cli, '--store', f.store.directory, 'resume', 'A', taskId, '--dry-run', '--json']);
  assert.deepEqual({ home: JSON.parse(stdout).home, cwd: JSON.parse(stdout).cwd }, { home: source.home, cwd: repo });
  assert.deepEqual(plan.resumeIndexRepair, { from: recorded, to: transcript, createdAt: 1, updatedAt: 2 });
  assert.equal(indexRows(source)[0].rollout_path, recorded, 'planning and CLI dry-run do not write the index');
  await assert.rejects(launchPlan(f.store, 'A', undefined, { resumeId: taskId, repository: f.a.cwd }), /Selected repository differs/);
  await assert.rejects(launchPlan(f.store, 'B', undefined, { resumeId: taskId }), /unavailable/);
});

function indexRows(environment, update) {
  const db = new DatabaseSync(join(environment.home, 'state_5.sqlite'), { readOnly: !update });
  try {
    update?.(db);
    return db.prepare('SELECT * FROM threads ORDER BY id').all().map(row => ({ ...row }));
  } finally { db.close(); }
}

async function aliasedTask(t) {
  const f = await fixture(t), source = f.a;
  const transcript = join(source.home, 'sessions', 'rollout.jsonl');
  await mkdir(dirname(transcript), { recursive: true, mode: 0o700 });
  await task(source, source.cwd, transcript);
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: taskId, cwd: source.cwd } }) + '\n');
  await writePairedActivation(f.store, [f.a, f.b]);
  const recorded = join(userInfo().homedir, '.codex', 'sessions', 'rollout.jsonl');
  indexRows(source, db => db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(recorded, taskId));
  return { ...f, source, transcript, recorded };
}

test('actual resume normalizes only the selected source row before native ID lookup and leaves a durable journal', async t => {
  const f = await aliasedTask(t), other = f.b;
  await task(other);
  indexRows(f.source, db => db.exec("INSERT INTO threads SELECT 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cwd, title, created_at, updated_at, archived, rollout_path FROM threads"));
  const before = indexRows(f.source), otherBefore = indexRows(other), content = await readFile(f.transcript);
  for (const exitCode of [1, 0]) {
    const result = await launch(f, 'A', { resumeId: taskId, probe: async () => '0.153.4', run: async opts => {
      // Model the native downstream lookup: resolve the ID again from SQLite.
      const row = indexRows(f.source).find(row => row.id === opts.args[1]);
      assert.equal(row.rollout_path, f.transcript);
      assert.equal(JSON.parse((await readFile(row.rollout_path, 'utf8')).trim()).payload.id, taskId);
      await opts.onSpawn(123); return { exitCode, signal: null, shutdown };
    } });
    assert.equal(result.status, exitCode === 0 ? 'exited' : 'failed');
    if (exitCode === 1) assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).resumeIndexRepair.status, 'applied');
    else assert.equal(result.resumeIndexRepair, undefined, 'retry is already canonical');
    assert.deepEqual(indexRows(f.source), before.map(row => row.id === taskId ? { ...row, rollout_path: f.transcript } : row));
    assert.deepEqual(indexRows(other), otherBefore);
    assert.deepEqual(await readFile(f.transcript), content);
  }
});

test('resume leaves alias metadata untouched if preflight fails or launch is cancelled', async t => {
  const f = await aliasedTask(t), before = indexRows(f.source);
  const controller = new AbortController();
  for (const options of [
    { ramLogs: { prepareHome: async () => { throw Object.assign(new Error('unavailable'), { code: 'RAM_LOGS_UNAVAILABLE' }); } } },
    { signal: controller.signal, onStart: async () => controller.abort() },
  ]) {
    const result = await launch(f, 'A', { resumeId: taskId, probe: async () => '0.153.4', ...options,
      run: async () => assert.fail('must not spawn') });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(indexRows(f.source), before);
  }
});

test('resume supports native timestamp triggers without changing their maintained fields', async t => {
  const f = await aliasedTask(t);
  indexRows(f.source, db => db.exec(`
    ALTER TABLE threads ADD COLUMN created_at_ms INTEGER;
    ALTER TABLE threads ADD COLUMN updated_at_ms INTEGER;
    UPDATE threads SET created_at_ms = created_at * 1000, updated_at_ms = updated_at * 1000;
    CREATE TRIGGER threads_created_at_ms_after_insert AFTER INSERT ON threads WHEN NEW.created_at_ms IS NULL
    BEGIN UPDATE threads SET created_at_ms = NEW.created_at * 1000 WHERE id = NEW.id; END;
    CREATE TRIGGER threads_updated_at_ms_after_update AFTER UPDATE OF updated_at ON threads
    WHEN NEW.updated_at != OLD.updated_at AND NEW.updated_at_ms IS OLD.updated_at_ms
    BEGIN UPDATE threads SET updated_at_ms = NEW.updated_at * 1000 WHERE id = NEW.id; END;
  `));
  const before = indexRows(f.source);
  const result = await launch(f, 'A', { resumeId: taskId, probe: async () => '0.153.4', run: async () => ({ exitCode: 0, signal: null, shutdown }) });
  assert.equal(result.status, 'exited');
  assert.deepEqual(indexRows(f.source), before.map(row => ({ ...row, rollout_path: f.transcript })));
});

test('resume refuses changed task metadata, mismatched transcript identity, redirected paths and update hooks', async t => {
  for (const variant of ['cwd', 'archived', 'updated_at', 'rollout_path', 'identity', 'transcript-cwd', 'symlink', 'trigger']) {
    await t.test(variant, async t => {
      const f = await aliasedTask(t); let expected;
      const result = await launch(f, 'A', { resumeId: taskId, probe: async () => '0.153.4', onStart: async () => {
        if (variant === 'identity' || variant === 'transcript-cwd') await writeFile(f.transcript, JSON.stringify({ type: 'session_meta', payload: {
          id: variant === 'identity' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : taskId,
          cwd: variant === 'transcript-cwd' ? f.root : f.source.cwd } }) + '\n');
        else if (variant === 'symlink') { await rm(f.transcript); await symlink(join(f.root, 'unrelated'), f.transcript); }
        else indexRows(f.source, db => {
          if (variant === 'trigger') db.exec('CREATE TRIGGER forbidden AFTER UPDATE ON threads BEGIN DELETE FROM threads; END');
          else db.prepare(`UPDATE threads SET ${variant} = ?`).run({ cwd: f.root, archived: 1, updated_at: 3, rollout_path: '/untrusted/rollout.jsonl' }[variant]);
        });
        expected = indexRows(f.source);
      }, run: async () => assert.fail('must not spawn') });
      assert.equal(result.status, 'incomplete'); assert.equal(result.error, 'RESUME_INDEX_CHANGED');
      assert.deepEqual(indexRows(f.source), expected, 'failed repair preserves current metadata');
      await assert.rejects(access(join(f.a.root, '.run-lock')), { code: 'ENOENT' });
    });
  }
});

test('resume rejects an unknown source, unbound workspace, or redirected transcript before launch', async t => {
  const f = await fixture(t), repo = join(f.root,'work'); await mkdir(repo);
  await task(f.a, repo);
  await assert.rejects(launchPlan(f.store,'B',undefined,{resumeId:taskId}),/unavailable/);
  await assert.rejects(launchPlan(f.store,'A',undefined,{resumeId:taskId}),/Bind the task repository/);
  await f.store.update(data=>bind(data,'A',repo));
  assert.equal((await launchPlan(f.store,'A',undefined,{resumeId:taskId})).cwd,repo);
  await task(f.b, f.b.cwd, join(f.root,'outside.jsonl'));
  await assert.rejects(launchPlan(f.store,'B',undefined,{resumeId:taskId}),/transcript is unavailable/);
  await assert.rejects(access(join(f.a.root, 'launches')),{code:'ENOENT'});
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
