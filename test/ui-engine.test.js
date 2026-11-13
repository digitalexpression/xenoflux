import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { createEngineProvider } from '../src/ui-engine.js';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const record = (type, payload, timestamp = '2026-10-15T08:00:00.000Z') => ({ timestamp, type, payload });

async function seedSession(home, taskId, { title, model, originator = 'codex_cli', turn, source = 'cli' }) {
  const rollout = join(home, 'sessions', '2026', '10', '15', `rollout-${taskId}.jsonl`);
  await mkdir(dirname(rollout), { recursive: true, mode: 0o700 });
  await writeFile(rollout, [
    record('session_meta', { id: taskId, cli_version: '0.153.4', originator }),
    record('turn_context', { turn_id: turn, cwd: '/workspace/project', model, effort: 'medium' }),
    record('event_msg', { type: 'task_complete', turn_id: turn, success: true }),
  ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, source TEXT, rollout_path TEXT);');
  db.prepare('INSERT INTO threads (id,cwd,title,created_at,updated_at,archived,source,rollout_path) VALUES (?,?,?,?,?,?,?,?)')
    .run(taskId, '/workspace/project', title, 1, 2, 0, source, rollout);
  db.close();
  return rollout;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-ui-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const [a, b] = await Promise.all(['a', 'b'].map(name => prepareNativeHome({ directory: join(root, `native-${name}`), executable, codexVersion: '0.153.4' })));
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'baseline'); create(data, 'strict-review'); });
  await registerHome(store, 'baseline', a.root, { executable, version: '0.153.4' });
  await registerHome(store, 'strict-review', b.root, { executable, version: '0.153.4' });
  const task = id(501);
  const rollouts = [
    await seedSession(a.home, task, { title: 'PRIVATE TASK TITLE', model: 'model-a', turn: id(502) }),
    await seedSession(b.home, task, { title: 'PRIVATE TASK TITLE', model: 'model-b', turn: id(503), originator: 'Codex Desktop', source: 'vscode' }),
  ];
  const reportsRoot = join(root, 'reports');
  const provider = createEngineProvider({ store, reportsRoot, defaultUserHome: join(root, 'no-default-home'),
    observeClients: async () => ({ cli: { state: 'not-running', text: 'not running' }, desktop: { state: 'not-running', text: 'not running' } }) });
  return { root, store, provider, task, rollouts, reportsRoot };
}

test('lists real profiles and sessions without reading content or starting clients', async t => {
  const f = await fixture(t);
  const profiles = await f.provider.profiles();
  assert.deepEqual(profiles.profiles.map(p => p.name), ['baseline', 'strict-review']);
  assert.ok(profiles.profiles.every(p => p.state === 'ready' && p.moreMenu.some(item => item.id === 'remove')));
  assert.deepEqual(profiles.profiles[0].clientActions.map(action => action.id), ['open-terminal', 'signin', 'open-desktop'], 'opening a new profile is separate from explicit sign-in');
  const sessions = await f.provider.sessions({});
  assert.equal(sessions.sessions.length, 2);
  const clients = Object.fromEntries(sessions.sessions.map(row => [row.profile, row.client]));
  assert.deepEqual(clients, { baseline: 'cli', 'strict-review': 'desktop' });
  assert.equal((await f.provider.sessions({ client: 'desktop' })).sessions.length, 1);
  assert.equal((await f.provider.sessions({ profile: 'baseline' })).sessions[0].profile, 'baseline');
  const features = (await f.provider.info()).features;
  assert.deepEqual([features.runs, features.copy, features.clientControls], [true, true, true]);
});

test('session and report client classification share originator and native index evidence', async t => {
  const f = await fixture(t);
  const futureTask = id(504);
  const futureRollout = await seedSession(join((await f.store.read()).profiles[0].native.root, 'codex-home'), futureTask,
    { title: 'Future client', model: 'model-c', turn: id(505), originator: 'Future Editor', source: 'vscode' });
  const { DatabaseSync } = await import('node:sqlite');
  const data = await f.store.read();
  const homeA = join(data.profiles.find(profile => profile.name === 'baseline').native.root, 'codex-home');
  const homeB = join(data.profiles.find(profile => profile.name === 'strict-review').native.root, 'codex-home');
  const updateSource = (home, thread, source) => {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.prepare('UPDATE threads SET source=? WHERE id=?').run(source, thread);
    db.close();
  };
  // Missing originator is resolved by cli; a desktop originator conflicts with cli;
  // an unrecognized originator plus vscode remains unknown.
  const baselineRollout = f.rollouts[0];
  const baselineLines = (await readFile(baselineRollout, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  delete baselineLines[0].payload.originator;
  await writeFile(baselineRollout, baselineLines.map(row => JSON.stringify(row)).join('\n') + '\n');
  updateSource(homeA, f.task, 'cli');
  updateSource(homeB, f.task, 'cli');

  const sessions = (await f.provider.sessions({})).sessions;
  const row = profile => sessions.find(item => item.profile === profile);
  assert.equal(row('baseline').client, 'cli');
  assert.equal(row('strict-review').client, 'unknown');
  assert.equal(sessions.find(item => item.key.endsWith(futureTask)).client, 'unknown');

  const pair = async (left, right) => f.provider.report({ ref: (await f.provider.compareSessions({ left, right })).ref });
  const contradiction = await pair(row('baseline').key, row('strict-review').key);
  assert.deepEqual([contradiction.a.client, contradiction.b.client], ['Codex CLI', 'Client not known']);
  const vscode = await pair(row('baseline').key, sessions.find(item => item.key.endsWith(futureTask)).key);
  assert.deepEqual([vscode.a.client, vscode.b.client], ['Codex CLI', 'Client not known']);
  await rm(futureRollout);
});

test('compares two sessions into the shared report model and keeps titles out of the link', async t => {
  const f = await fixture(t);
  const [baseline, strict] = ['baseline', 'strict-review'].map(name => (async () => (await f.provider.sessions({ profile: name })).sessions[0].key)());
  const left = await baseline, right = await strict;
  const association = await f.provider.association({ left, right });
  assert.equal(association.basis, 'unknown');
  assert.ok(association.suggestedVariables.includes('Model'));
  const { ref } = await f.provider.compareSessions({ left, right, title: 'PRIVATE TASK TITLE', variables: ['Model'] });
  assert.doesNotMatch(Buffer.from(ref.slice(2), 'base64url').toString(), /PRIVATE/);
  const report = await f.provider.report({ ref });
  assert.equal(report.title, 'PRIVATE TASK TITLE');
  assert.equal(report.a.profile, 'baseline');
  assert.equal(report.b.client, 'Codex Desktop');
  const model = report.conditions.rows.find(row => row.name === 'Model');
  assert.deepEqual([model.a, model.b, model.intent], ['model-a', 'model-b', 'intended']);
  assert.ok(report.limits.some(limit => /consistency is unmeasured/.test(limit)));
  assert.equal(report.verification.reviews.text, 'Not reviewed');
  assert.match(report.cliCommand, /^xfx audit diff --left-profile "baseline"/);
  assert.equal(report.counts.different + report.counts.same + report.counts.cannotCompare, report.findings.length + report.moreFindings.items.length);
  const evidence = await f.provider.evidence({ ref });
  assert.equal(typeof evidence.refsNote, 'string');
  const reviews = await f.provider.reviews({ ref });
  assert.equal(reviews.topics[0].notReviewed, true);

  const declared = await f.provider.compareSessions({ left, right, sameTask: 'Fix the date test' });
  assert.match(declared.ref, /^p\.[0-9a-f-]{36}$/);
  assert.doesNotMatch(declared.ref, /Fix the date test/);
  assert.equal(Buffer.from(declared.ref.slice(2), 'base64url').toString().includes('Fix the date test'), false);
  const declaredReport = await f.provider.report({ ref: declared.ref });
  assert.equal(declaredReport.association.basis, 'user-declared');
  assert.match(declaredReport.association.text, /your statement, not proof/);
  const reopened = await f.provider.report({ ref: declared.ref });
  assert.equal(reopened.association.basis, 'user-declared');
  await assert.rejects(f.provider.compareSessions({ left, right: left }), /two different sessions/);
  await assert.rejects(f.provider.compareSessions({ left: 'nope', right }), /Choose sessions/);
});

test('exports a Markdown and JSON pair, never overwrites, and reopens after the sources are gone', async t => {
  const f = await fixture(t);
  const rows = (await f.provider.sessions({})).sessions;
  const keys = ['baseline', 'strict-review'].map(name => rows.find(row => row.profile === name).key);
  const { ref } = await f.provider.compareSessions({ left: keys[0], right: keys[1], title: 'Date test' });
  const plan = await f.provider.exportPlan({ ref });
  assert.deepEqual(plan.contentFiles, []);
  const first = await f.provider.exportReport({ ref });
  const second = await f.provider.exportReport({ ref });
  assert.notEqual(first.folder, second.folder);
  assert.match(second.folder, /\(2\)\/$/);
  const folders = await readdir(f.reportsRoot);
  assert.equal(folders.length, 2);
  const files = await readdir(join(f.reportsRoot, folders[0]));
  assert.deepEqual(files.sort(), ['date-test.md', 'date-test.md.audit.json']);
  const markdown = await readFile(join(f.reportsRoot, folders[0], 'date-test.md'), 'utf8');
  assert.match(markdown, /^> Keep this file next to date-test\.md\.audit\.json\./);
  for (const heading of ['Comparison conditions', 'What we could not see', 'Session replay', 'Verification', 'Time and tokens', 'Outcome and code changes'])
    assert.match(markdown, new RegExp(`## ${heading}\\n`));
  const json = await readFile(join(f.reportsRoot, folders[0], 'date-test.md.audit.json'), 'utf8');
  assert.doesNotMatch(json + markdown, /PRIVATE TASK TITLE/);

  // Remove the original histories; the saved pair still reopens.
  for (const rollout of f.rollouts) await rm(rollout);
  const recent = await f.provider.savedReports();
  assert.equal(recent.recent.length, 2);
  assert.deepEqual(recent.recent[0].sides.map(side => [side.side, side.profile]), [['A', 'baseline'], ['B', 'strict-review']]);
  assert.ok(recent.recent[0].sides.every(side => side.state === 'unknown' && side.detail === 'Task completion not recorded'));
  assert.equal(recent.recent[0].sides[0].checks, 'Checks not recorded');
  assert.deepEqual((await f.provider.openRecentReport({ id: recent.recent[0].id })).sides, recent.recent[0].sides);
  const reopened = await f.provider.openRecentReport({ id: recent.recent[0].id });
  const saved = await f.provider.report({ ref: reopened.ref });
  assert.ok(saved.saved);
  assert.match(saved.cliCommand, /^xfx audit show /);
  const uploaded = await f.provider.openReport({ fileName: 'date-test.md.audit.json', text: json });
  assert.equal(uploaded.title, 'date-test');
  assert.equal((await f.provider.report({ ref: uploaded.ref })).a.profile, 'baseline');

  const savedFile = join(f.store.directory, 'ui-saved-reports.json');
  const entries = JSON.parse(await readFile(savedFile, 'utf8'));
  entries[0].jsonPath = join(f.reportsRoot, 'moved', 'missing.audit.json');
  await writeFile(savedFile, JSON.stringify(entries));
  assert.equal((await f.provider.savedReports()).recent[0].sides, null, 'a missing frozen file does not imply side identities or outcomes');

  await assert.rejects(f.provider.openReport({ fileName: 'date-test.md', text: '' }), error => error.code === 'json-missing');
  await assert.rejects(f.provider.openReport({ fileName: 'x.json', text: '{"kind":"nothing"}' }), error => error.code === 'unreadable');
  await assert.rejects(f.provider.report({ ref: 'f.unknown' }), error => error.status === 404);
});

test('private declarations survive export and reopen while expired launch links fail clearly', async t => {
  const f = await fixture(t);
  const rows = (await f.provider.sessions({})).sessions;
  const declaration = 'PRIVATE DECLARED TASK';
  const { ref } = await f.provider.compareSessions({ left: rows[0].key, right: rows[1].key, sameTask: declaration });
  assert.match(ref, /^p\.[0-9a-f-]{36}$/);
  assert.doesNotMatch(Buffer.from(ref.slice(2), 'base64url').toString(), /PRIVATE/);
  const exported = await f.provider.exportReport({ ref });
  const jsonFile = exported.files.find(file => file.endsWith('.audit.json'));
  const json = await readFile(join(exported.folder, jsonFile), 'utf8');
  assert.match(json, /PRIVATE DECLARED TASK/);
  const restarted = createEngineProvider({ store: f.store, reportsRoot: f.reportsRoot, defaultUserHome: join(f.root, 'no-default-home') });
  await assert.rejects(restarted.report({ ref }), error => error.status === 410 && error.code === 'expired-ref');
  for (const rollout of f.rollouts) await rm(rollout);
  const opened = await restarted.openReport({ fileName: jsonFile, text: json });
  const report = await restarted.report({ ref: opened.ref });
  assert.equal(report.association.basis, 'user-declared');
  assert.match(report.association.text, /your statement, not proof/);
});

test('native replay bodies are local until selected, and frozen replay reopens without histories', async t => {
  const f = await fixture(t);
  for (const rollout of f.rollouts) {
    const records = (await readFile(rollout, 'utf8')).trim().split('\n').map(JSON.parse);
    records.splice(2, 0,
      record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE REPLAY PROMPT' }] }),
      record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'replay-call', arguments: 'node --check app.js' }),
      record('response_item', { type: 'function_call_output', call_id: 'replay-call', output: 'PRIVATE REPLAY RESULT' }));
    await writeFile(rollout, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  const rows = (await f.provider.sessions({})).sessions;
  const keys = ['baseline', 'strict-review'].map(name => rows.find(row => row.profile === name).key);
  const { ref } = await f.provider.compareSessions({ left: keys[0], right: keys[1] });
  const view = await f.provider.report({ ref });
  const events = view.replay.a.sessions[0].events;
  assert.ok(events.some(event => event.body === 'PRIVATE REPLAY PROMPT'));
  assert.ok(events.some(event => event.body === 'PRIVATE REPLAY RESULT' && event.relatedEventId));
  assert.equal((await f.provider.exportPlan({ ref })).replayAvailable, true);
  const excluded = await f.provider.exportReport({ ref });
  const included = await f.provider.exportReport({ ref, includeReplayContent: true });
  const excludedText = await readFile(join(excluded.folder, excluded.files[1]), 'utf8');
  const includedText = await readFile(join(included.folder, included.files[1]), 'utf8');
  assert.doesNotMatch(excludedText, /PRIVATE REPLAY (PROMPT|RESULT)/);
  assert.match(includedText, /PRIVATE REPLAY PROMPT/);
  assert.match(includedText, /PRIVATE REPLAY RESULT/);
  for (const rollout of f.rollouts) await rm(rollout);
  const fresh = createEngineProvider({ store: f.store, reportsRoot: f.reportsRoot, defaultUserHome: join(f.root, 'no-default-home') });
  const reopened = await fresh.openReport({ fileName: included.files[1], text: includedText });
  const saved = await fresh.report({ ref: reopened.ref });
  assert.deepEqual(saved.replay.a.sessions[0].events.map(event => event.id), events.map(event => event.id));
  assert.ok(saved.replay.a.sessions[0].events.some(event => event.body === 'PRIVATE REPLAY RESULT' && event.relatedEventId));
  const metadataOnly = await fresh.openReport({ fileName: excluded.files[1], text: excludedText });
  const omitted = await fresh.report({ ref: metadataOnly.ref });
  assert.ok(omitted.replay.a.sessions[0].events.every(event => event.body == null));
});

test('concurrent exports reserve separate folders and retain every Recent entry', async t => {
  const f = await fixture(t);
  const rows = (await f.provider.sessions({})).sessions;
  const keys = ['baseline', 'strict-review'].map(name => rows.find(row => row.profile === name).key);
  const { ref } = await f.provider.compareSessions({ left: keys[0], right: keys[1], title: 'Concurrent exports' });
  const other = createEngineProvider({ store: new Store(f.store.directory), reportsRoot: f.reportsRoot, defaultUserHome: join(f.root, 'no-default-home') });
  const otherRef = (await other.compareSessions({ left: keys[0], right: keys[1], title: 'Concurrent exports' })).ref;
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => index % 2
    ? other.exportReport({ ref: otherRef }) : f.provider.exportReport({ ref })));
  assert.equal(new Set(results.map(result => result.folder)).size, 10);
  assert.ok(results.every(result => result.warning === undefined));
  assert.equal((await readdir(f.reportsRoot)).length, 10);
  const { recent } = await f.provider.savedReports();
  assert.equal(recent.length, 10);
  for (const entry of recent) assert.equal((await f.provider.openRecentReport({ id: entry.id })).title, 'Concurrent exports');
});

test('an exported pair remains available when the Recent index cannot be updated', async t => {
  const f = await fixture(t);
  const rows = (await f.provider.sessions({})).sessions;
  const keys = ['baseline', 'strict-review'].map(name => rows.find(row => row.profile === name).key);
  const { ref } = await f.provider.compareSessions({ left: keys[0], right: keys[1] });
  const index = join(f.store.directory, 'ui-saved-reports.json');
  await writeFile(index, 'broken index');
  const result = await f.provider.exportReport({ ref });
  assert.match(result.warning, /Both files were saved/);
  assert.equal(await readFile(index, 'utf8'), 'broken index');
  const folders = await readdir(f.reportsRoot);
  const json = await readFile(join(f.reportsRoot, folders[0], result.files.find(name => name.endsWith('.json'))), 'utf8');
  assert.ok((await f.provider.openReport({ fileName: 'saved.audit.json', text: json })).ref);
});

test('session client filtering finds matches older than the unfiltered limit and searches project paths', async t => {
  const f = await fixture(t);
  const native = (await f.store.read()).profiles.find(profile => profile.name === 'baseline').native;
  const home = join(native.root, 'codex-home');
  const oldId = id(600);
  await seedSession(home, oldId, { title: 'Old desktop task', model: 'model', turn: id(601), originator: 'Codex Desktop', source: 'vscode' });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  const insert = db.prepare('INSERT INTO threads (id,cwd,title,created_at,updated_at,archived,source) VALUES(?,?,?,?,?,0,?)');
  for (let i = 0; i < 120; i++) insert.run(id(700 + i), '/workspace/new-project', `New CLI task ${i}`, i + 10, i + 10, 'cli');
  db.close();
  assert.equal((await f.provider.sessions({ profile: 'baseline' })).sessions.length, 100);
  const desktop = await f.provider.sessions({ profile: 'baseline', client: 'desktop' });
  assert.deepEqual(desktop.sessions.map(row => row.title), ['Old desktop task']);
  assert.equal(desktop.truncated, false);
  const byProject = await f.provider.sessions({ profile: 'baseline', query: 'new-project' });
  assert.equal(byProject.sessions.length, 100);
  assert.equal(byProject.truncated, true);
});
