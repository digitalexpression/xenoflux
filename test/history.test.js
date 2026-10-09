import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rename, stat, symlink, writeFile, access, link, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { findHistory, listHistory } from '../src/history.js';

const run = promisify(execFile);
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

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
