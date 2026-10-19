import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rename, stat, symlink, writeFile, access, link, mkdir, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { resolveNativeSettingsHome } from '../src/native-copy.js';
import { findHistory, listHistory } from '../src/history.js';

const run = promisify(execFile);
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const cli = fileURLToPath(new URL('../bin/xfx.js', import.meta.url));

function historyCLI(f, args, json = true, extraEnv = {}) {
  const result = spawnSync(process.execPath, [cli, '--store', f.store.directory, ...(json ? ['--json'] : []), 'history', ...args], {
    encoding: 'utf8', env: { ...process.env, CODEX_HOME: f.homes[0], XFX_NATIVE_PROFILE_OPEN: '0', ...extraEnv },
  });
  assert.ifError(result.error);
  return { ...result, value: json && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-history-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-codex'); await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const a = await prepareNativeHome({ directory: join(root, 'native-a'), executable, codexVersion: '0.153.4' });
  const b = await prepareNativeHome({ directory: join(root, 'native-b'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  await registerHome(store, 'A', a.root, { executable, version: '0.153.4' });
  await registerHome(store, 'B', b.root, { executable, version: '0.153.4' });
  return { root, store, homes: [a.home, b.home] };
}
async function seed(home, values) {
  const db = join(home, 'state_5.sqlite');
  await run('/usr/bin/sqlite3', [db, 'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);']);
  for (const value of values) await run('/usr/bin/sqlite3', [db, `INSERT INTO threads VALUES ('${value.id}', '/workspace/${value.id}', '${value.title.replaceAll("'", "''")}', ${value.created ?? value.updated}, ${value.updated}, ${value.archived ? 1 : 0});`]);
  return db;
}

async function seedRollout(home, taskId, records) {
  const database = join(home, 'state_5.sqlite');
  await run('/usr/bin/sqlite3', [database, 'ALTER TABLE threads ADD COLUMN rollout_path TEXT;']);
  const rolloutPath = join(home, 'sessions', `rollout-${taskId}.jsonl`);
  await mkdir(dirname(rolloutPath), { recursive: true, mode: 0o700 });
  await writeFile(rolloutPath, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
  await run('/usr/bin/sqlite3', [database,
    `UPDATE threads SET rollout_path='${rolloutPath.replaceAll("'", "''")}' WHERE id='${taskId}';`]);
  return rolloutPath;
}

const rolloutRecord = (timestamp, type, payload) => ({ timestamp, type, payload });

const context = (turn, cwd, model = 'model-a', effort = 'medium') => rolloutRecord('2026-10-13T12:01:00Z', 'turn_context', {
  turn_id: turn, cwd, workspace_roots: [cwd], model, effort,
  instructions: 'PRIVATE INSTRUCTIONS', tool_output: 'PRIVATE TOOL OUTPUT', api_key: 'PRIVATE CREDENTIAL',
});

test('lists each bound native origin, preserves duplicate IDs, searches and limits newest metadata', async t => {
  const f = await fixture(t); const duplicate = id(1);
  await seed(f.homes[0], [{ id: duplicate, title: 'Alpha task', updated: 20 }, { id: id(2), title: 'Secret sk-123456789012345', updated: 10 }]);
  await seed(f.homes[1], [{ id: duplicate, title: 'alpha newer', updated: 30 }, { id: id(3), title: 'Archived', updated: 40, archived: true }]);
  const all = await listHistory(f.store, { limit: 2 });
  assert.deepEqual(all.entries.map(item => [item.profileName, item.id]), [['B', duplicate], ['A', duplicate]]);
  assert.match((await listHistory(f.store, { limit: 10 })).entries.find(item => item.id === id(2)).title, /REDACTED/); assert.equal(all.truncated, true);
  const searched = await listHistory(f.store, { query: 'ALPHA', limit: 10 });
  assert.deepEqual(searched.entries.map(item => item.profileName), ['B', 'A']);
  assert.equal((await listHistory(f.store, { archived: true, limit: 10 })).entries.length, 4);
  const exact = await findHistory(f.store, 'A', duplicate);
  assert.equal(exact.entry.profileName, 'A'); assert.equal(exact.entry.environmentId, all.entries[1].environmentId);
});

test('CLI exact lookup isolates duplicate IDs, includes archives and preserves fixture contents', async t => {
  const f = await fixture(t), duplicate = id(21), archived = id(22), otherOnly = id(23);
  const a = await seed(f.homes[0], [
    { id: duplicate, title: 'Selected profile task', updated: 21 },
    { id: archived, title: 'Archived selected task', updated: 22, archived: true },
  ]);
  const b = await seed(f.homes[1], [
    { id: duplicate, title: 'Other profile task', updated: 31 },
    { id: otherOnly, title: 'Only elsewhere', updated: 32 },
  ]);
  const marker = join(f.root, 'client-launched');
  await writeFile(join(f.root, 'fake-codex'), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`, { mode: 0o700 });
  const transcript = join(f.homes[0], 'rollout.jsonl');
  await writeFile(transcript, 'invalid transcript body: must not be parsed', { mode: 0o000 });
  await run('/usr/bin/sqlite3', [a, 'ALTER TABLE threads ADD COLUMN rollout_path TEXT;']);
  await run('/usr/bin/sqlite3', [a, `UPDATE threads SET rollout_path='${transcript}';`]);
  const preserved = [f.store.file, a, b, ...f.homes.flatMap(home => [join(home, 'config.toml')])];
  const before = await Promise.all(preserved.map(path => readFile(path)));
  for (const profile of ['A', 'B']) {
    const result = historyCLI(f, ['--profile', profile, '--id', duplicate]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.value.status, 'found');
    assert.equal(result.value.id, duplicate);
    assert.equal(result.value.entry.id, duplicate);
    assert.equal(result.value.entry.profileName, profile);
    assert.equal(result.value.entry.title, profile === 'A' ? 'Selected profile task' : 'Other profile task');
    assert.equal(result.value.entry.cwd, `/workspace/${duplicate}`);
    assert.equal(result.value.entry.home, f.homes[profile === 'A' ? 0 : 1]);
    assert.equal(result.value.entry.profileId, result.value.home.profileId);
    assert.equal(result.value.entry.environmentId, result.value.home.environmentId);
    assert.equal(result.value.entry.archived, false);
    assert.equal(result.value.turnMetadata, undefined);
    assert.equal(result.value.turns, undefined);
  }
  const archivedResult = historyCLI(f, ['--profile=A', `--id=${archived}`]);
  assert.equal(archivedResult.status, 0, archivedResult.stderr);
  assert.equal(archivedResult.value.entry.archived, true);
  const terminal = historyCLI(f, ['--profile', 'A', '--id', archived], false);
  assert.equal(terminal.status, 0, terminal.stderr);
  for (const text of [archived, `/workspace/${archived}`, 'Profile: A', f.homes[0], 'Archived: yes'])
    assert.ok(terminal.stdout.includes(text), terminal.stdout);
  for (const missing of [otherOnly, id(24)]) {
    const result = historyCLI(f, ['--profile', 'A', '--id', missing]);
    assert.equal(result.status, 1);
    assert.equal(result.value.status, 'not-found');
    assert.equal(result.value.entry, null);
    assert.equal(result.value.home.status, 'ready');
    assert.equal(result.value.home.profileName, 'A');
    const output = historyCLI(f, ['--profile', 'A', '--id', missing], false);
    assert.equal(output.status, 1);
    assert.match(output.stdout, /not found in profile A/);
    assert.ok(output.stdout.includes(missing));
  }
  const listed = historyCLI(f, ['--profile', 'A']);
  assert.equal(listed.status, 0);
  assert.deepEqual(listed.value.entries.map(entry => entry.id), [duplicate]);
  const searched = historyCLI(f, ['--profile', 'A', '--search', 'archived', '--archived', '--limit', '1']);
  assert.equal(searched.status, 0);
  assert.deepEqual(searched.value.entries.map(entry => entry.id), [archived]);
  assert.deepEqual(await Promise.all(preserved.map(path => readFile(path))), before);
  assert.equal((await stat(transcript)).mode & 0o777, 0);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('CLI lookup preserves unbound, empty, unavailable and partial evidence with exit 2', async t => {
  const f = await fixture(t), task = id(25);
  await f.store.update(data => create(data, 'Unbound'));
  const database = await seed(f.homes[1], [{ id: task, title: 'Malformed workspace', updated: 25 }]);
  await run('/usr/bin/sqlite3', [database, "UPDATE threads SET cwd='relative';"]);
  for (const [profile, status] of [['Unbound', 'unbound'], ['A', 'empty'], ['B', 'partial']]) {
    const result = historyCLI(f, ['--profile', profile, '--id', task]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.value.status, 'unavailable');
    assert.equal(result.value.entry, null);
    assert.equal(result.value.home.status, status);
    assert.ok(result.value.home.reason);
    const terminal = historyCLI(f, ['--profile', profile, '--id', task], false);
    assert.equal(terminal.status, 2);
    assert.ok(terminal.stdout.includes(`History ${status}`));
    assert.doesNotMatch(terminal.stdout, /not found/);
  }
  await rm(database);
  await run('/usr/bin/sqlite3', [database, 'CREATE TABLE threads (id TEXT);']);
  const result = historyCLI(f, ['--profile', 'B', '--id', task]);
  assert.equal(result.status, 2);
  assert.equal(result.value.home.status, 'unavailable');
  assert.match(result.value.home.reason, /unsupported thread schema/);
});

test('CLI exact lookup rejects invalid arguments using the existing error contract', async t => {
  const f = await fixture(t), before = await readFile(f.store.file);
  const cases = [
    [['--turns'], /--turns requires --id/],
    [['--turns', '--id', id(26)], /--id requires --profile/],
    [['--id', id(26)], /--id requires --profile/],
    [['--profile', 'A', '--id', 'bad'], /Invalid native thread ID/],
    [['--profile', 'A', '--id='], /Invalid native thread ID/],
    [['--profile', 'A', '--id'], /Missing value for --id/],
    [['--profile', 'A', '--id', id(26), '--id', id(27)], /Repeated option/],
    ...[['--search', ''], ['--limit', '1'], ['--archived']].map(flags => [
      ['--profile', 'A', '--id', id(26), ...flags], /--id cannot be combined/,
    ]),
  ];
  for (const [args, message] of cases) {
    for (const json of [true, false]) {
      const result = historyCLI(f, args, json);
      assert.equal(result.status, 1, args.join(' '));
      assert.equal(result.stdout, '');
      assert.match(json ? JSON.parse(result.stderr).error : result.stderr, message);
    }
  }
  const otherCommand = spawnSync(process.execPath, [cli, '--store', f.store.directory, 'profile', 'list', '--id', id(26)], { encoding: 'utf8' });
  assert.equal(otherCommand.status, 1);
  assert.match(otherCommand.stderr, /--id is not supported by profile/);
  assert.deepEqual(await readFile(f.store.file), before);
});

test('uses read-only SQLite access with WAL visibility and does not change native database files', async t => {
  const f = await fixture(t); const db = await seed(f.homes[0], [{ id: id(5), title: 'WAL task', updated: 5 }]);
  const writer = spawn('/usr/bin/sqlite3', ['-batch', db], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => writer.kill());
  let output = ''; writer.stdout.on('data', chunk => { output += chunk; });
  writer.stdin.write(`PRAGMA journal_mode=WAL; INSERT INTO threads VALUES ('${id(6)}', '/workspace/wal', 'visible via WAL', 6, 6, 0); SELECT 'writer-ready';\n`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SQLite WAL writer did not become ready')), 2_000);
    const ready = () => { if (output.includes('writer-ready')) { clearTimeout(timer); resolve(); } };
    writer.stdout.on('data', ready); writer.once('error', reject); ready();
  });
  const before = await readFile(db), logicalBefore = (await run('/usr/bin/sqlite3', ['-readonly', db, 'SELECT count(*) FROM threads;'])).stdout.trim();
  assert.ok((await stat(`${db}-wal`)).size > 0);
  const result = await listHistory(f.store, { profile: 'A', limit: 10 });
  assert.ok(result.entries.some(item => item.id === id(6)));
  assert.deepEqual(await readFile(db), before); assert.equal((await run('/usr/bin/sqlite3', ['-readonly', db, 'SELECT count(*) FROM threads;'])).stdout.trim(), logicalBefore);
});

test('reads a closed WAL database with absent coordination files without changing saved rows', async t => {
  const f=await fixture(t); const db=await seed(f.homes[0],[{id:id(7),title:'Closed WAL',updated:7}]);
  await run('/usr/bin/sqlite3',[db,'PRAGMA journal_mode=WAL;']);
  await assert.rejects(access(`${db}-wal`),{code:'ENOENT'});
  await assert.rejects(access(`${db}-shm`),{code:'ENOENT'});
  const before=await readFile(db);
  const result=await listHistory(f.store,{profile:'A'});
  assert.equal(result.homes[0].status,'ready'); assert.equal(result.entries[0].title,'Closed WAL');
  assert.deepEqual(await readFile(db),before);
  assert.equal((await findHistory(f.store,'A',id(7))).entry.title,'Closed WAL');
});

test('reports absent and unsupported indexes as actionable unavailable states without reading other files', async t => {
  const f = await fixture(t);
  let result = await listHistory(f.store, { profile: 'A' });
  assert.equal(result.homes[0].status, 'empty');
  await run('/usr/bin/sqlite3', [join(f.homes[1], 'state_5.sqlite'), "CREATE VIEW threads AS SELECT 'x' AS id, '/' AS cwd, 'x' AS title, 0 AS created_at, 0 AS updated_at, 0 AS archived;"]);
  result = await listHistory(f.store, { profile: 'B' });
  assert.equal(result.homes[0].status, 'unavailable'); assert.match(result.homes[0].reason, /unsupported thread schema/);
  await assert.rejects(findHistory(f.store, 'A', 'not-a-uuid'), /Invalid native thread ID/);
  await assert.rejects(listHistory(f.store, { limit: 101 }), /limit/);
});

test('refuses a linked database path and reports malformed metadata as partial', async t => {
  const f = await fixture(t); const db = await seed(f.homes[0], [{ id: id(9), title: 'safe', updated: 9 }]);
  const retained = `${db}.retained`; await rename(db, retained); await symlink(retained, db);
  let result = await listHistory(f.store, { profile: 'A' });
  assert.equal(result.homes[0].status, 'unavailable');
  await rm(db); await rename(retained, db);
  await run('/usr/bin/sqlite3', [db, "INSERT INTO threads VALUES ('not-a-uuid', 'relative', 'bad', 10, 10, 0);"]);
  result = await listHistory(f.store, { profile: 'A', limit: 10 });
  assert.deepEqual(result.entries.map(item => item.id), [id(9)]);
  assert.equal(result.homes[0].status, 'partial'); assert.match(result.homes[0].reason, /malformed/);
});

test('ignores inherited SQLite startup scripts and treats search punctuation as literal data', async t => {
  const f = await fixture(t); await seed(f.homes[0],[{id:id(11),title:"50%_done's",updated:11}]);
  const fakeHome=join(f.homes[0],'fake-user-home'); await mkdir(fakeHome);
  const marker=join(fakeHome,'startup-ran');
  await writeFile(join(fakeHome,'.sqliterc'),`.output ${marker}\nSELECT 'unexpected startup';\n`);
  const previous=process.env.HOME; process.env.HOME=fakeHome;
  try {
    assert.equal((await listHistory(f.store,{query:"%_done's"})).entries.length,1);
    assert.equal((await listHistory(f.store,{query:"' OR 1=1 --"})).entries.length,0);
    await assert.rejects(access(marker),{code:'ENOENT'});
  } finally { if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous; }
});

test('title search matches Unicode case and canonically equivalent diacritics', async t => {
  const f=await fixture(t); await seed(f.homes[0],[{id:id(13),title:'ȘEDINȚĂ de lucru',updated:13}]);
  const result=await listHistory(f.store,{query:'ședință'.normalize('NFD')});
  assert.equal(result.entries.length,1); assert.equal(result.entries[0].title,'ȘEDINȚĂ de lucru');
});

test('validates canonical transcript paths and rejects symbolic or hard link targets without reading contents', async t => {
  const f=await fixture(t); const db=await seed(f.homes[0],[{id:id(12),title:'resumable',updated:12}]);
  await run('/usr/bin/sqlite3',[db,'ALTER TABLE threads ADD COLUMN rollout_path TEXT;']);
  const path=join(f.homes[0],'rollout.jsonl'); await writeFile(path,'not parsed by metadata reader');
  const set=async value=>run('/usr/bin/sqlite3',[db,`UPDATE threads SET rollout_path='${value.replaceAll("'","''")}';`]);
  await set(path);
  assert.equal((await findHistory(f.store,'A',id(12))).entry.rolloutPath,path);
  const alias=join(f.homes[0],'alias.jsonl'); await symlink(path,alias); await set(alias);
  assert.equal((await findHistory(f.store,'A',id(12))).entry.rolloutPath,undefined);
  await rm(alias); await link(path,alias); await set(path);
  assert.equal((await findHistory(f.store,'A',id(12))).entry.rolloutPath,undefined);
});

test('history rejects transcript paths outside the selected home without translating matching relative paths', async t => {
  const f = await fixture(t), db = await seed(f.homes[0], [{ id: id(14), title: 'external transcript', updated: 14 }]);
  const relativeTranscript = join('sessions', 'rollout.jsonl');
  const inHome = join(f.homes[0], relativeTranscript);
  const external = join(f.root, 'legacy-default-home', relativeTranscript);
  await mkdir(dirname(inHome), { recursive: true, mode: 0o700 });
  await mkdir(dirname(external), { recursive: true, mode: 0o700 });
  await writeFile(inHome, 'bound home transcript\n', { mode: 0o600 });
  await writeFile(external, 'outside transcript\n', { mode: 0o600 });
  await run('/usr/bin/sqlite3', [db, 'ALTER TABLE threads ADD COLUMN rollout_path TEXT;']);
  const set = async value => run('/usr/bin/sqlite3', [db,
    `UPDATE threads SET rollout_path='${value.replaceAll("'", "''")}';`]);
  await set(inHome);
  assert.equal((await findHistory(f.store, 'A', id(14))).entry.rolloutPath, inHome);
  await set(external);
  assert.equal((await findHistory(f.store, 'A', id(14))).entry.rolloutPath, undefined);
});

test('opt-in turn metadata records native per-turn workspace, model and effort without saved-setting fallbacks', async t => {
  const f = await fixture(t), task = id(31), firstTurn = id(131), secondTurn = id(132);
  const dbA = await seed(f.homes[0], [{ id: task, title: 'Default pilot', updated: 31 }]);
  const dbB = await seed(f.homes[1], [{ id: task, title: 'Advanced pilot', updated: 32 }]);
  const recordsA = [
    rolloutRecord('2026-10-13T08:47:43.000Z', 'session_meta', { id: task, cli_version: '0.162.0-alpha.17.2', originator: 'Codex Desktop' }),
    rolloutRecord('2026-10-13T08:48:00.000Z', 'event_msg', { type: 'task_started', turn_id: firstTurn }),
    rolloutRecord('2026-10-13T08:48:01.000Z', 'turn_context', { turn_id: firstTurn, cwd: '/workspace/default-a', workspace_roots: ['/workspace/default-a'], model: 'gpt-6.1-sol', effort: 'medium' }),
    rolloutRecord('2026-10-13T08:49:00.000Z', 'event_msg', { type: 'task_started', turn_id: secondTurn }),
    rolloutRecord('2026-10-13T08:49:01.000Z', 'turn_context', { turn_id: secondTurn, cwd: '/workspace/default-b', workspace_roots: ['/workspace/default-b', '/workspace/shared'], model: 'gpt-6.1-sol', effort: 'medium' }),
    rolloutRecord('2026-10-13T08:49:02.000Z', 'response_item', { type: 'message', content: [{ text: 'PRIVATE MESSAGE BODY' }], api_key: 'sk-123456789012345', tool_output: 'PRIVATE TOOL OUTPUT' }),
  ];
  const recordsB = [
    rolloutRecord('2026-10-13T08:49:28.000Z', 'session_meta', { id: task, cli_version: '0.162.0-alpha.17.2', originator: 'Codex Desktop' }),
    rolloutRecord('2026-10-13T08:50:00.000Z', 'event_msg', { type: 'task_started', turn_id: firstTurn }),
    rolloutRecord('2026-10-13T08:50:01.000Z', 'turn_context', { turn_id: firstTurn, cwd: '/workspace/advanced', workspace_roots: [], model: 'gpt-6.1-sol', effort: 'low' }),
  ];
  const pathA = await seedRollout(f.homes[0], task, recordsA);
  const pathB = await seedRollout(f.homes[1], task, recordsB);
  const preserved = [f.store.file, dbA, dbB, ...f.homes.flatMap(home => [join(home, 'config.toml')]), pathA, pathB];
  const before = await Promise.all(preserved.map(path => readFile(path)));

  const [defaultResult, advancedResult] = await Promise.all([
    findHistory(f.store, 'A', task, { turns: true }), findHistory(f.store, 'B', task, { turns: true }),
  ]);
  assert.equal(defaultResult.entry.profileName, 'A');
  assert.equal(defaultResult.turnMetadata.status, 'ready');
  assert.equal(defaultResult.turnMetadata.source, 'native-codex-rollout');
  assert.equal(defaultResult.turnMetadata.rolloutPath, pathA);
  assert.equal(defaultResult.turnMetadata.clientVersion, '0.162.0-alpha.17.2');
  assert.equal(defaultResult.turnMetadata.originator, 'Codex Desktop');
  assert.deepEqual(defaultResult.turns.map(turn => [turn.turnId, turn.cwd, turn.workspaceRoots, turn.model, turn.reasoningEffort]), [
    [firstTurn, '/workspace/default-a', ['/workspace/default-a'], 'gpt-6.1-sol', 'medium'],
    [secondTurn, '/workspace/default-b', ['/workspace/default-b', '/workspace/shared'], 'gpt-6.1-sol', 'medium'],
  ]);
  assert.ok(defaultResult.turns.every(turn => Number.isInteger(turn.sourceLine) && turn.issues.length === 0));
  assert.deepEqual(advancedResult.turns.map(turn => [turn.cwd, turn.model, turn.reasoningEffort]), [['/workspace/advanced', 'gpt-6.1-sol', 'low']]);
  assert.deepEqual(advancedResult.turns[0].workspaceRoots, []);
  assert.deepEqual(advancedResult.turns[0].issues, []);
  assert.equal(advancedResult.turnMetadata.status, 'ready');
  assert.equal(advancedResult.entry.profileName, 'B');

  const cliResult = historyCLI(f, ['--profile', 'A', '--id', task, '--turns']);
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(cliResult.value.status, 'found');
  assert.deepEqual(cliResult.value.turns.map(turn => turn.reasoningEffort), ['medium', 'medium']);
  const terminal = historyCLI(f, ['--profile', 'A', '--id', task, '--turns'], false);
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.match(terminal.stdout, /gpt-6\.1-sol/);
  assert.match(terminal.stdout, /medium/);
  assert.doesNotMatch(`${JSON.stringify(cliResult.value)}${terminal.stdout}`, /PRIVATE MESSAGE BODY|PRIVATE TOOL OUTPUT|sk-123456789012345|api_key/);

  assert.deepEqual(await Promise.all(preserved.map(path => readFile(path))), before);
});

test('turn metadata keeps incomplete, start-only and conflicting native evidence visible', async t => {
  const f = await fixture(t), task = id(32), missingContext = id(133), partialContext = id(134), conflicting = id(135);
  await seed(f.homes[0], [{ id: task, title: 'Partial turns', updated: 32 }]);
  const path = await seedRollout(f.homes[0], task, [
    rolloutRecord('2026-10-13T09:00:00.000Z', 'session_meta', { id: task }),
    rolloutRecord('2026-10-13T09:01:00.000Z', 'event_msg', { type: 'task_started', turn_id: missingContext }),
    rolloutRecord('2026-10-13T09:02:00.000Z', 'turn_context', { turn_id: partialContext, cwd: '/workspace/partial', workspace_roots: ['/workspace/partial'], model: 'gpt-6.1-sol' }),
    rolloutRecord('2026-10-13T09:03:00.000Z', 'turn_context', { turn_id: conflicting, cwd: '/workspace/first', workspace_roots: ['/workspace/first'], model: 'gpt-6.1-sol', effort: 'low' }),
    rolloutRecord('2026-10-13T09:04:00.000Z', 'turn_context', { turn_id: conflicting, cwd: '/workspace/second', workspace_roots: ['/workspace/second'], model: 'gpt-6.1-sol', effort: 'medium' }),
  ]);
  const result = await findHistory(f.store, 'A', task, { turns: true });
  assert.equal(result.turnMetadata.status, 'partial');
  assert.deepEqual(result.turns.map(turn => turn.turnId), [missingContext, partialContext, conflicting, conflicting]);
  assert.equal(result.turns[0].cwd, null);
  assert.ok(result.turns[0].issues.length);
  assert.equal(result.turns[1].reasoningEffort, null);
  assert.ok(result.turns[1].issues.length);
  assert.deepEqual(result.turns.slice(2).map(turn => [turn.cwd, turn.reasoningEffort]), [['/workspace/first', 'low'], ['/workspace/second', 'medium']]);
  assert.ok(result.turns[2].issues.length && result.turns[3].issues.length);
  const partialCLI = historyCLI(f, ['--profile', 'A', '--id', task, '--turns']);
  assert.equal(partialCLI.status, 2);
  assert.equal(partialCLI.value.status, 'found');
  assert.equal(partialCLI.value.turnMetadata.status, 'partial');
  assert.equal(partialCLI.value.turns.length, 4);

  await run('/usr/bin/sqlite3', [join(f.homes[1], 'state_5.sqlite'), 'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);']);
  const noContextTask = id(33);
  await run('/usr/bin/sqlite3', [join(f.homes[1], 'state_5.sqlite'), `INSERT INTO threads VALUES ('${noContextTask}', '/workspace/empty-turns', 'No contexts', 33, 33, 0);`]);
  const noContextPath = await seedRollout(f.homes[1], noContextTask, [
    rolloutRecord('2026-10-13T09:10:00.000Z', 'session_meta', { id: noContextTask }),
  ]);
  const noContexts = await findHistory(f.store, 'B', noContextTask, { turns: true });
  assert.equal(noContexts.turnMetadata.status, 'unavailable');
  assert.deepEqual(noContexts.turns, []);
  assert.equal(noContexts.turnMetadata.rolloutPath, noContextPath);
  assert.ok(noContexts.turnMetadata.reason);
  assert.equal((await findHistory(f.store, 'A', id(34))).turnMetadata, undefined);
});

test('child turn lookup attributes only ownership backed observations and preserves bounded metadata', async t => {
  const f = await fixture(t), child = id(301), parent = id(302), owned = id(303), inherited = id(304), startOnly = id(305), tokenOnly = id(306);
  const db = await seed(f.homes[0], [
    { id: child, title: 'Child', updated: 301 }, { id: parent, title: 'Parent', updated: 302 },
  ]);
  await run('/usr/bin/sqlite3', [db, 'ALTER TABLE threads ADD COLUMN source TEXT;']);
  await run('/usr/bin/sqlite3', [db, `UPDATE threads SET source='{"subagent":{"thread_spawn":{"parent_thread_id":"${parent}"}}}' WHERE id='${child}';`]);
  const header = { id: child, session_id: parent, parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } };
  const path = await seedRollout(f.homes[0], child, [
    rolloutRecord('2026-10-13T13:00:00Z', 'session_meta', { ...header, forked_from_id: parent }),
    rolloutRecord('2026-10-13T13:00:00.500Z', 'session_meta', { id: parent, session_id: parent }),
    rolloutRecord('2026-10-13T13:00:00.750Z', 'session_meta', { id: child, session_id: parent, parent_thread_id: parent, source: header.source }),
    rolloutRecord('2026-10-13T13:00:01Z', 'event_msg', { type: 'task_started', turn_id: owned }),
    context(owned, '/workspace/child', 'gpt-6.1-sol'), context(owned, '/workspace/child', 'gpt-6.1-sol'),
    rolloutRecord('2026-10-13T13:00:02Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: owned, root_turn_id: id(307), total_token_usage: { input_tokens: 999999 } }),
    rolloutRecord('2026-10-13T13:00:02.500Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: owned, root_turn_id: id(307), total_token_usage: { input_tokens: 999999 } }),
    rolloutRecord('2026-10-13T13:00:03Z', 'event_msg', { type: 'task_started', turn_id: inherited }),
    context(inherited, '/workspace/parent', 'gpt-6.1-sol'),
    rolloutRecord('2026-10-13T13:00:04Z', 'token_usage_record', { thread_id: parent, session_id: parent, turn_id: inherited, root_turn_id: id(308), total_token_usage: { input_tokens: 888888 } }),
    rolloutRecord('2026-10-13T13:00:05Z', 'event_msg', { type: 'task_started', turn_id: startOnly }),
    rolloutRecord('2026-10-13T13:00:06Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: startOnly, root_turn_id: id(309), total_token_usage: { input_tokens: 777777 } }),
    rolloutRecord('2026-10-13T13:00:07Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: tokenOnly, root_turn_id: id(310), total_token_usage: { input_tokens: 666666 } }),
    rolloutRecord('2026-10-13T13:00:08Z', 'response_item', { type: 'message', content: [{ text: 'PRIVATE MESSAGE' }] }),
  ]);
  const preserved = [f.store.file, db, path, join(f.homes[0], 'config.toml')];
  const before = await Promise.all(preserved.map(file => readFile(file)));
  const result = await findHistory(f.store, 'A', child, { turns: true });
  assert.equal(result.turnMetadata.status, 'partial');
  assert.equal(result.turnMetadata.parentTaskId, parent);
  assert.equal(result.turnMetadata.unattributedTurnCount, 1);
  assert.deepEqual(result.turns.map(turn => turn.turnId), [owned, owned, startOnly]);
  assert.equal(result.turns[2].cwd, null);
  assert.ok(result.turns[2].issues.length);
  assert.ok(result.turns.every(turn => Number.isInteger(turn.sourceLine)));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE MESSAGE|999999|888888|777777|666666|total_token_usage/);
  assert.deepEqual(await Promise.all(preserved.map(file => readFile(file))), before);
});

test('child lookup rejects invalid lineage and conflicting ownership or roots without attributed turns', async t => {
  const f = await fixture(t), child = id(311), parent = id(312), turn = id(313);
  const db = await seed(f.homes[0], [{ id: child, title: 'Child', updated: 311 }, { id: parent, title: 'Parent', updated: 312 }]);
  await run('/usr/bin/sqlite3', [db, 'ALTER TABLE threads ADD COLUMN source TEXT;']);
  await run('/usr/bin/sqlite3', [db, `UPDATE threads SET source='{"subagent":{"thread_spawn":{"parent_thread_id":"${parent}"}}}' WHERE id='${child}';`]);
  const header = { id: child, session_id: parent, parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } };
  const path = await seedRollout(f.homes[0], child, [
    rolloutRecord('2026-10-13T14:00:00Z', 'session_meta', header),
    context(turn, '/workspace/child'),
    rolloutRecord('2026-10-13T14:00:01Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: turn, root_turn_id: id(314) }),
    rolloutRecord('2026-10-13T14:00:02Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: turn, root_turn_id: id(315) }),
  ]);
  let result = await findHistory(f.store, 'A', child, { turns: true });
  assert.equal(result.turnMetadata.status, 'unavailable');
  assert.deepEqual(result.turns, []);

  const consistent = id(317), rootConflict = id(318);
  await writeFile(path, [
    rolloutRecord('2026-10-13T14:00:00Z', 'session_meta', header),
    rolloutRecord('2026-10-13T14:00:00.500Z', 'turn_context', { turn_id: turn, root_turn_id: rootConflict, cwd: '/workspace/conflict', workspace_roots: ['/workspace/conflict'], model: 'model-a', effort: 'medium' }),
    rolloutRecord('2026-10-13T14:00:01Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: turn, root_turn_id: id(314) }),
    context(consistent, '/workspace/consistent'),
    rolloutRecord('2026-10-13T14:00:02Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: consistent, root_turn_id: id(319) }),
  ].map(JSON.stringify).join('\n') + '\n');
  result = await findHistory(f.store, 'A', child, { turns: true });
  assert.equal(result.turnMetadata.status, 'unavailable');
  assert.deepEqual(result.turns, []);

  await writeFile(path, [
    rolloutRecord('2026-10-13T14:00:00Z', 'session_meta', { ...header, parent_thread_id: id(316) }),
    context(turn, '/workspace/child'),
    rolloutRecord('2026-10-13T14:00:01Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: turn, root_turn_id: id(314) }),
  ].map(JSON.stringify).join('\n') + '\n');
  result = await findHistory(f.store, 'A', child, { turns: true });
  assert.equal(result.turnMetadata.status, 'unavailable');
  assert.deepEqual(result.turns, []);

  await run('/usr/bin/sqlite3', [db, `UPDATE threads SET source='{"subagent":{"thread_spawn":{"parent_thread_id":"${child}"}}}' WHERE id='${child}';`]);
  result = await findHistory(f.store, 'A', child, { turns: true });
  assert.equal(result.turnMetadata.status, 'unavailable');
  assert.deepEqual(result.turns, []);
});

test('child lineage requires a parent row in the selected profile and valid positive ownership roots', async t => {
  const f = await fixture(t), child = id(321), parent = id(322), turn = id(323);
  const selectedDb = await seed(f.homes[0], [{ id: child, title: 'Child', updated: 321 }]);
  await seed(f.homes[1], [{ id: parent, title: 'Same parent elsewhere', updated: 322 }]);
  await run('/usr/bin/sqlite3', [selectedDb, 'ALTER TABLE threads ADD COLUMN source TEXT;']);
  await run('/usr/bin/sqlite3', [selectedDb, `UPDATE threads SET source='{"subagent":{"thread_spawn":{"parent_thread_id":"${parent}"}}}' WHERE id='${child}';`]);
  const header = rolloutRecord('2026-10-13T15:00:00Z', 'session_meta', {
    id: child, session_id: parent, parent_thread_id: parent,
    source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
  });
  const path = await seedRollout(f.homes[0], child, [header, context(turn, '/workspace/child'),
    rolloutRecord('2026-10-13T15:00:01Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: turn, root_turn_id: id(324) })]);
  let result = await findHistory(f.store, 'A', child, { turns: true });
  assert.equal(result.turnMetadata.status, 'unavailable');
  assert.deepEqual(result.turns, []);

  await run('/usr/bin/sqlite3', [selectedDb, `INSERT INTO threads (id,cwd,title,created_at,updated_at,archived) VALUES ('${parent}','/workspace/${parent}','Parent',322,322,0);`]);
  await run('/usr/bin/sqlite3', [selectedDb, `UPDATE threads SET rollout_path='${path}' WHERE id='${child}';`]);
  for (const [label, ownership] of [
    ['missing', { thread_id: child, session_id: parent, turn_id: turn }],
    ['malformed', { thread_id: child, session_id: parent, turn_id: turn, root_turn_id: 'not-a-uuid' }],
  ]) {
    await writeFile(path, [header, context(turn, '/workspace/child'), rolloutRecord('2026-10-13T15:00:02Z', 'token_usage_record', ownership)]
      .map(JSON.stringify).join('\n') + '\n');
    result = await findHistory(f.store, 'A', child, { turns: true });
    assert.equal(result.turnMetadata.status, 'unavailable', label);
    assert.deepEqual(result.turns, [], label);
  }

  await run('/usr/bin/sqlite3', [selectedDb, `UPDATE threads SET source='{"subagent":{"thread_spawn":{"parent_thread_id":"${parent}"}}}' WHERE id='${child}';`]);
  await writeFile(path, [header, context(turn, '/workspace/child'),
    rolloutRecord('2026-10-13T15:00:02Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: turn, root_turn_id: id(324) })]
    .map(JSON.stringify).join('\n') + '\n');
  result = await findHistory(f.store, 'A', child, { turns: true });
  assert.equal(result.turnMetadata.status, 'ready');
  assert.equal(result.turnMetadata.parentTaskId, parent);
  assert.equal(result.turnMetadata.unattributedTurnCount, 0);
  assert.deepEqual(result.turns.map(item => item.turnId), [turn]);
});

test('child ownership records share the existing bounded metadata record budget', async t => {
  const f = await fixture(t), child = id(331), parent = id(332), turn = id(333);
  const db = await seed(f.homes[0], [{ id: child, title: 'Child', updated: 331 }, { id: parent, title: 'Parent', updated: 332 }]);
  await run('/usr/bin/sqlite3', [db, 'ALTER TABLE threads ADD COLUMN source TEXT;']);
  await run('/usr/bin/sqlite3', [db, `UPDATE threads SET source='{"subagent":{"thread_spawn":{"parent_thread_id":"${parent}"}}}' WHERE id='${child}';`]);
  const records = [
    rolloutRecord('2026-10-13T16:00:00Z', 'session_meta', {
      id: child, session_id: parent, parent_thread_id: parent,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
    }),
    context(turn, '/workspace/child'),
    rolloutRecord('2026-10-13T16:00:01Z', 'token_usage_record', { thread_id: child, session_id: parent, turn_id: turn, root_turn_id: id(334) }),
  ];
  for (let n = 0; n < 9999; n++) records.push(rolloutRecord('2026-10-13T16:00:02Z', 'token_usage_record', {
    thread_id: child, session_id: parent, turn_id: id(10000 + n), root_turn_id: id(30000 + n),
  }));
  await seedRollout(f.homes[0], child, records);
  const result = await findHistory(f.store, 'A', child, { turns: true });
  assert.equal(result.turnMetadata.status, 'partial');
  assert.deepEqual(result.turns.map(item => item.turnId), [turn]);
  assert.ok(result.turnMetadata.reason.includes('record limit'));
});

test('turn metadata rejects mismatched, linked, outside and unreadable rollout sources', async t => {
  const f = await fixture(t), task = id(35), turns = id(136);
  const db = await seed(f.homes[0], [{ id: task, title: 'Unsafe source', updated: 35 }]);
  const valid = [
    rolloutRecord('2026-10-13T10:00:00.000Z', 'session_meta', { id: task }),
    rolloutRecord('2026-10-13T10:01:00.000Z', 'turn_context', { turn_id: turns, cwd: '/workspace/safe', workspace_roots: ['/workspace/safe'], model: 'gpt-6.1-sol', effort: 'medium' }),
  ];
  const selected = await seedRollout(f.homes[0], task, valid);
  const outside = join(f.root, 'outside.jsonl');
  await writeFile(outside, valid.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
  const updatePath = path => run('/usr/bin/sqlite3', [db, `UPDATE threads SET rollout_path='${path.replaceAll("'", "''")}';`]);

  await updatePath(outside);
  let result = await findHistory(f.store, 'A', task, { turns: true });
  assert.equal(result.turnMetadata.status, 'unavailable');
  assert.deepEqual(result.turns, []);

  await updatePath(selected);
  await writeFile(selected, valid.map(record => JSON.stringify(record.type === 'session_meta'
    ? rolloutRecord(record.timestamp, record.type, { ...record.payload, id: id(36) }) : record)).join('\n') + '\n');
  result = await findHistory(f.store, 'A', task, { turns: true });
  assert.equal(result.turnMetadata.status, 'unavailable');
  assert.deepEqual(result.turns, []);

  await writeFile(selected, valid.map(record => JSON.stringify(record)).join('\n') + '\n');
  const alias = join(f.homes[0], 'sessions', 'linked-rollout.jsonl');
  await symlink(selected, alias);
  await updatePath(alias);
  result = await findHistory(f.store, 'A', task, { turns: true });
  assert.equal(result.turnMetadata.status, 'unavailable');
  assert.deepEqual(result.turns, []);

  await updatePath(selected);
  await chmod(selected, 0);
  result = await findHistory(f.store, 'A', task, { turns: true });
  assert.equal(result.turnMetadata.status, 'unavailable');
  assert.deepEqual(result.turns, []);
  await chmod(selected, 0o600);
});

test('turn metadata bounds malformed, truncated and oversized records while retaining valid context', async t => {
  const f = await fixture(t), task = id(38), turn = id(138);
  const db = await seed(f.homes[0], [{ id: task, title: 'Bounded source', updated: 38 }]);
  const selected = join(f.homes[0], 'sessions', 'bounded.jsonl');
  await mkdir(dirname(selected), { recursive: true, mode: 0o700 });
  const validHeader = JSON.stringify(rolloutRecord('2026-10-13T12:00:00.000Z', 'session_meta', { id: task }));
  const validTurn = JSON.stringify(rolloutRecord('2026-10-13T12:01:00.000Z', 'turn_context', {
    turn_id: turn, cwd: '/workspace/bounded', workspace_roots: ['/workspace/bounded'], model: 'gpt-6.1-sol', effort: 'medium',
  }));
  await writeFile(selected, `${validHeader}\n{broken json\n${validTurn}\n${JSON.stringify(rolloutRecord('2026-10-13T12:02:00.000Z', 'event_msg', { type: 'task_started', turn_id: id(139) }))}` , { mode: 0o600 });
  await run('/usr/bin/sqlite3', [db, 'ALTER TABLE threads ADD COLUMN rollout_path TEXT;']);
  await run('/usr/bin/sqlite3', [db, `UPDATE threads SET rollout_path='${selected}';`]);
  let result = await findHistory(f.store, 'A', task, { turns: true });
  assert.equal(result.turnMetadata.status, 'partial');
  assert.equal(result.turns[0].turnId, turn);
  assert.equal(result.turns[0].reasoningEffort, 'medium');
  assert.equal(result.turns[1].cwd, null);
  assert.ok(result.turns[1].issues.length);

  await writeFile(selected, `${validHeader}\n${'x'.repeat(1024 * 1024 + 1)}\n${validTurn}\n`, { mode: 0o600 });
  result = await findHistory(f.store, 'A', task, { turns: true });
  assert.equal(result.turnMetadata.status, 'partial');
  assert.deepEqual(result.turns.map(item => item.turnId), [turn]);
  assert.equal(result.turns[0].reasoningEffort, 'medium');
});

test('Default turn lookup uses an explicit disposable home without registering it', async t => {
  const f = await fixture(t), canonicalRoot = await realpath(f.root), defaultUserHome = join(canonicalRoot, 'default-user'), defaultHome = join(defaultUserHome, '.codex'), task = id(37), turn = id(137);
  await mkdir(defaultHome, { recursive: true, mode: 0o700 });
  const database = await seed(defaultHome, [{ id: task, title: 'Default task', updated: 37 }]);
  const path = await seedRollout(defaultHome, task, [
    rolloutRecord('2026-10-13T11:00:00.000Z', 'session_meta', { id: task, cli_version: '0.162.0-alpha.17.2', originator: 'Codex Desktop' }),
    rolloutRecord('2026-10-13T11:01:00.000Z', 'turn_context', { turn_id: turn, cwd: '/workspace/default', workspace_roots: ['/workspace/default'], model: 'gpt-6.1-sol', effort: 'medium' }),
  ]);
  const registryBefore = await readFile(f.store.file), databaseBefore = await readFile(database), rolloutBefore = await readFile(path);
  const endpoint = await resolveNativeSettingsHome(f.store, 'Default', { defaultUserHome });
  assert.equal(endpoint.home, defaultHome);
  const result = await findHistory(f.store, 'Default', task, { turns: true, defaultUserHome });
  assert.equal(result.entry?.profileName, 'Default', JSON.stringify(result));
  assert.equal(result.turnMetadata.status, 'ready');
  assert.equal(result.turns[0].reasoningEffort, 'medium');
  assert.deepEqual(await readFile(f.store.file), registryBefore);
  assert.deepEqual(await readFile(database), databaseBefore);
  assert.deepEqual(await readFile(path), rolloutBefore);

  const cliResult = historyCLI(f, ['--profile', 'Default', '--id', task, '--turns'], true, { HOME: defaultUserHome });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(cliResult.value.entry.home, defaultHome);
  assert.equal(cliResult.value.turnMetadata.status, 'ready');
  assert.equal(cliResult.value.turns[0].reasoningEffort, 'medium');
  assert.deepEqual(await readFile(f.store.file), registryBefore);
  assert.deepEqual(await readFile(database), databaseBefore);
  assert.deepEqual(await readFile(path), rolloutBefore);
});
