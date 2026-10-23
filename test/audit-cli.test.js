import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';

const cli = fileURLToPath(new URL('../bin/xfx.js', import.meta.url));
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

async function put(path, text = 'private instruction') {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-audit-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-codex');
  const marker = join(root, 'client-launched');
  await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\nexit 99\n`, { mode: 0o700 });
  const [a, b] = await Promise.all(['a', 'b'].map(name => prepareNativeHome({
    directory: join(root, `native-${name}`), executable, codexVersion: '0.153.4',
  })));
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  await registerHome(store, 'A', a.root, { executable, version: '0.153.4' });
  await registerHome(store, 'B', b.root, { executable, version: '0.153.4' });
  return { root, marker, store, homes: [a.home, b.home], native: [a, b] };
}

function audit(f, args, { json = true, home = f.homes[0], extraEnv = {} } = {}) {
  const result = spawnSync(process.execPath, [cli, '--store', f.store.directory, ...(json ? ['--json'] : []), 'audit', ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: f.root, CODEX_HOME: home, XFX_NATIVE_PROFILE_OPEN: '0', ...extraEnv },
  });
  assert.ifError(result.error);
  return { ...result, value: json && result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

async function seedIndex(home, threads, columns = 'source TEXT, rollout_path TEXT') {
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(home, 'state_5.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, ${columns});`);
  const insert = db.prepare('INSERT INTO threads (id,cwd,title,created_at,updated_at,archived,source,rollout_path) VALUES (?,?,?,?,?,?,?,?)');
  for (const thread of threads) insert.run(thread.id, `/workspace/${thread.id}`, 'PRIVATE INDEX TITLE', 1, 2, 0, thread.source ?? null, thread.rolloutPath ?? null);
  db.close();
  return path;
}

async function seedRollout(home, taskId, records) {
  const path = join(home, 'sessions', '2026', '10', '15', `rollout-${taskId}.jsonl`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
  return path;
}

const record = (type, payload, timestamp = '2026-10-15T08:00:00.000Z') => ({ timestamp, type, payload });
const context = (turnId, extra = {}) => record('turn_context', { turn_id: turnId, cwd: '/workspace/project', model: 'model-a', effort: 'medium', ...extra });

test('audit profiles reports resources independently of profile-copy support and launch readiness', async t => {
  const f = await fixture(t), repo = join(f.root, 'project');
  await mkdir(repo, { mode: 0o700 });
  const origins = [
    [join(f.native[0].home, 'skills', 'shared'), 'profile'],
    [join(f.native[0].userHome, '.agents', 'skills', 'shared'), 'user'],
    [join(repo, '.agents', 'skills', 'shared'), 'project'],
    [join(f.native[0].home, 'skills', '.system', 'shared'), 'system'],
  ];
  for (const [root, origin] of origins) await put(join(root, 'SKILL.md'), `PRIVATE_SKILL_${origin}`);
  const plugin = join(f.native[0].home, 'plugins', 'cache', 'market', 'example', '1.0.0');
  await put(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ id: 'market/example', name: 'Private Plugin', version: '1.0.0' }));
  await put(join(plugin, 'skills', 'shared', 'SKILL.md'), 'PRIVATE_SKILL_plugin');

  const env = { HOME: f.root };
  // No profile-copy eligibility is involved: the audit inventories all known origins.
  const result = audit(f, ['profiles', 'A', 'B', '--repo', repo, '--client', 'cli'], { extraEnv: env });
  assert.ok([0, 2].includes(result.status), result.stderr);
  const value = result.value;
  assert.equal(value.kind, 'audit-profile-comparison');
  const skills = [value.left, value.right].flatMap(side => side.resources.filter(resource => resource.category === 'skill' && resource.name === 'shared'));
  assert.ok(skills.length >= 5, JSON.stringify(skills));
  assert.deepEqual(new Set(skills.map(skill => skill.scope)), new Set(['profile', 'user', 'project', 'system', 'plugin']));
  assert.ok(skills.every(skill => skill.status === 'present'));
  assert.ok(skills.some(skill => skill.provider === 'market/example'));
  // Setup comparison intentionally exposes bounded readable instruction content.
  // This is separate from normalized run reports, which still omit raw payloads.
  assert.match(JSON.stringify(value), /PRIVATE_SKILL_profile/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE Plugin/);
  assert.equal(JSON.stringify(value).includes('PRIVATE INDEX TITLE'), false);
  await assert.rejects(stat(f.marker), { code: 'ENOENT' });

  const snapshotPath = join(f.root, 'profiles.json');
  const saved = audit(f, ['export', 'profiles', 'A', 'B', '--repo', repo, '--client', 'cli', '--format', 'json', '--output', snapshotPath], { extraEnv: env });
  assert.ok([0, 2].includes(saved.status), saved.stderr);
  assert.equal(saved.value.kind, 'audit-export');
  assert.equal(saved.value.sourceKind, 'audit-profile-comparison');
  const snapshot = JSON.parse(await readFile(saved.value.evidencePath, 'utf8'));
  assert.equal(snapshot.kind, 'audit-profile-comparison');
  assert.ok(snapshot.left.resources.some(resource => resource.category === 'skill' && resource.scope === 'project'));
  assert.ok(snapshot.left.resources.some(resource => resource.category === 'skill' && resource.scope === 'plugin'));
});

test('audit show and diff retain exact-home evidence and report unknown historical skill use', async t => {
  const f = await fixture(t), task = id(301), leftTurn = id(302), rightTurn = id(303);
  const leftRollout = await seedRollout(f.homes[0], task, [
    record('session_meta', { id: task, cli_version: '0.153.4', originator: 'codex_cli' }),
    context(leftTurn),
    record('event_msg', { type: 'task_complete', turn_id: leftTurn, success: true }),
  ]);
  const rightRollout = await seedRollout(f.homes[1], task, [
    record('session_meta', { id: task, cli_version: '0.153.4', originator: 'codex_cli' }),
    context(rightTurn, { model: 'model-b', effort: 'low' }),
  ]);
  await seedIndex(f.homes[0], [{ id: task, rolloutPath: leftRollout }]);
  await seedIndex(f.homes[1], [{ id: task, rolloutPath: rightRollout }]);

  const preserve = [f.store.file, ...f.homes.map(home => join(home, 'config.toml')), leftRollout, rightRollout,
    ...f.homes.map(home => join(home, 'state_5.sqlite'))];
  const before = await Promise.all(preserve.map(path => readFile(path)));
  const shown = audit(f, ['show', '--profile', 'A', '--id', task]);
  assert.equal(shown.status, 2, shown.stderr);
  assert.equal(shown.value.kind, 'audit-run');
  assert.equal(shown.value.profile.profileName, 'A');
  assert.equal(shown.value.source.nativeSessionId, task);
  assert.ok(shown.value.coverage.skills === 'unavailable' || shown.value.coverage.skills === 'partial');
  assert.equal(shown.value.outcome.status, 'claim-recorded');
  assert.deepEqual(shown.value.outcome.checks, []);
  assert.equal(shown.value.coverage.outcome, 'partial');

  const diff = audit(f, ['diff', '--left-profile', 'A', '--left-id', task, '--right-profile', 'B', '--right-id', task]);
  assert.equal(diff.status, 2, diff.stderr);
  assert.equal(diff.value.kind, 'audit-comparison');
  assert.equal(diff.value.left.profile.profileName, 'A');
  assert.equal(diff.value.right.profile.profileName, 'B');
  assert.equal(diff.value.comparison.models.status, 'different');
  assert.ok(diff.value.comparison.skills);
  assert.match(diff.value.comparison.conclusion, /do not establish/);
  assert.doesNotMatch(JSON.stringify(diff.value) + shown.stdout, /PRIVATE/);
  assert.deepEqual(await Promise.all(preserve.map(path => readFile(path))), before);
  await assert.rejects(stat(f.marker), { code: 'ENOENT' });

  const missing = audit(f, ['diff', '--left-profile', 'A', '--left-id', task, '--right-profile', 'B', '--right-id', id(399)]);
  assert.equal(missing.status, 1);
  assert.ok(['ready', 'partial'].includes(missing.value.left.status));
  assert.equal(missing.value.right.status, 'not-found');
});

test('audit show attributes skill load, read and invocation to agents and owned turns across origins', async t => {
  const f = await fixture(t), parent = id(305), child = id(306), rootTurn = id(307), childTurn = id(308);
  const catalogs = [
    { name: 'Shared Skill', origin: 'profile', scope: 'profile', path: join(f.native[0].home, 'skills', 'shared', 'SKILL.md') },
    { name: 'Shared Skill', origin: 'user', scope: 'user', path: join(f.native[0].userHome, '.agents', 'skills', 'shared', 'SKILL.md') },
    { name: 'Shared Skill', origin: 'project', scope: 'project', path: join(f.root, 'repo', '.agents', 'skills', 'shared', 'SKILL.md') },
    { name: 'Shared Skill', origin: 'admin', scope: 'admin', path: '/etc/codex/skills/shared/SKILL.md' },
    { name: 'Shared Skill', origin: 'system', scope: 'system', path: '/opt/codex/skills/.system/shared/SKILL.md' },
    { name: 'Shared Skill', origin: 'plugin', scope: 'plugin', provider: 'market/shared-plugin', path: join(f.native[0].home, 'plugins', 'cache', 'market', 'shared', 'skills', 'shared', 'SKILL.md') },
  ];
  const activityRecords = turnId => catalogs.flatMap((skill, index) => [
    record('event_msg', { type: 'skill_loaded', turn_id: turnId, name: skill.name, path: skill.path, private_payload: 'PRIVATE_SKILL_EVENT' }, `2026-10-15T08:00:0${index}.000Z`),
    record('event_msg', { type: 'skill_read', turn_id: turnId, name: skill.name, path: skill.path }, `2026-10-15T08:00:1${index}.000Z`),
    record('event_msg', { type: 'skill_invoked', turn_id: turnId, name: skill.name, path: skill.path }, `2026-10-15T08:00:2${index}.000Z`),
  ]);
  const parentPath = await seedRollout(f.homes[0], parent, [
    record('session_meta', { id: parent }), context(rootTurn, { skills_instructions: catalogs }), ...activityRecords(rootTurn),
  ]);
  const childPath = await seedRollout(f.homes[0], child, [
    record('session_meta', { id: child, session_id: parent, parent_thread_id: parent,
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } }, forked_from_id: parent }),
    // These rows copy the parent's context and events into the child rollout.
    // They must not be attributed to the child without positive turn ownership.
    context(rootTurn, { skills_instructions: catalogs }), ...activityRecords(rootTurn),
    context(childTurn, { skills_instructions: catalogs }), ...activityRecords(childTurn),
    record('token_usage_record', { thread_id: child, session_id: parent, turn_id: childTurn, root_turn_id: rootTurn,
      total_token_usage: { input_tokens: 4 } }),
  ]);
  const source = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: parent } } });
  await seedIndex(f.homes[0], [
    { id: parent, rolloutPath: parentPath },
    { id: child, source, rolloutPath: childPath },
  ]);
  const result = audit(f, ['show', '--profile', 'A', '--id', parent]);
  assert.equal(result.status, 2, result.stderr);
  const childAgent = result.value.agents.find(agent => agent.id === child);
  assert.equal(childAgent.parentId, parent);
  assert.equal(childAgent.depth, 1);
  assert.equal(result.value.skills.length, catalogs.length);
  assert.equal(new Set(result.value.skills.map(skill => skill.path)).size, catalogs.length);
  for (const catalog of catalogs) {
    const skill = result.value.skills.find(item => item.path === catalog.path);
    assert.ok(skill, `missing ${catalog.origin} skill`);
    assert.equal(skill.name, catalog.name);
    assert.equal(skill.origin, catalog.origin);
    assert.equal(skill.scope, catalog.scope);
    assert.equal(skill.provider ?? null, catalog.provider ?? null);
    const observations = skill.observations.map(observation => [observation.kind, observation.agentId, observation.turnId]);
    const expectedKinds = ['advertised', 'load-observed', 'definition-read-observed', 'explicit-invocation'];
    assert.deepEqual(observations.filter(([, agentId]) => agentId === parent).map(([kind]) => kind), expectedKinds);
    assert.deepEqual(observations.filter(([, agentId]) => agentId === child).map(([kind]) => kind), expectedKinds);
    assert.ok(observations.every(([, agentId, turnId]) => (agentId === parent && turnId === rootTurn)
      || (agentId === child && turnId === childTurn)), `${catalog.origin} inherited observations escaped ownership filtering`);
  }
  assert.doesNotMatch(JSON.stringify(result.value) + result.stdout, /PRIVATE_SKILL_EVENT/);
  await assert.rejects(stat(f.marker), { code: 'ENOENT' });
});

test('audit export uses exclusive output creation and preserves evidence status and privacy', async t => {
  const f = await fixture(t), task = id(311), turn = id(312);
  const rollout = await seedRollout(f.homes[0], task, [
    record('session_meta', { id: task }), context(turn, { skills_instructions: [{ name: 'Listed Skill', path: '/project/.agents/skills/listed/SKILL.md', origin: 'project', scope: 'project' }], private_instructions: 'PRIVATE_EXPORT_SENTINEL' }),
    record('response_item', { type: 'function_call', name: 'shell', arguments: 'PRIVATE_COMMAND_SENTINEL' }),
  ]);
  await seedIndex(f.homes[0], [{ id: task, rolloutPath: rollout }]);
  const jsonPath = join(f.root, 'audit.json'), markdownPath = join(f.root, 'audit.md');
  const json = audit(f, ['export', '--profile', 'A', '--id', task, '--format', 'json', '--output', jsonPath]);
  assert.equal(json.status, 2, json.stderr);
  assert.equal(json.value.kind, 'audit-export');
  assert.equal(json.value.format, 'json');
  const frozen = JSON.parse(await readFile(json.value.evidencePath, 'utf8'));
  assert.equal(frozen.kind, 'audit-run');
  assert.ok(frozen.coverage.skills);
  assert.ok(frozen.skills.some(skill => skill.name === 'Listed Skill'));
  assert.doesNotMatch(JSON.stringify(frozen), /PRIVATE_(?:EXPORT|COMMAND)_SENTINEL/);
  const reopened = audit(f, ['show', json.value.evidencePath]);
  assert.equal(reopened.status, 2);
  assert.equal(reopened.value.id, frozen.id);
  const collision = audit(f, ['export', '--profile', 'A', '--id', task, '--format', 'json', '--output', jsonPath]);
  assert.notEqual(collision.status, 0);
  assert.deepEqual(JSON.parse(await readFile(json.value.evidencePath, 'utf8')), frozen);
  const markdown = audit(f, ['export', json.value.evidencePath, '--format', 'markdown', '--output', markdownPath]);
  assert.equal(markdown.status, 2, markdown.stderr);
  assert.equal(markdown.value.kind, 'audit-export');
  assert.equal(markdown.value.format, 'markdown');
  assert.equal(await realpath(markdown.value.evidencePath), await realpath(`${markdownPath}.audit.json`));
  const sidecar = JSON.parse(await readFile(markdown.value.evidencePath, 'utf8'));
  assert.equal(sidecar.id, frozen.id);
  const rendered = await readFile(markdownPath, 'utf8');
  assert.match(rendered, /Audit run/);
  assert.match(rendered, /Skills/);
  assert.match(rendered, /unavailable|partial/);
  assert.doesNotMatch(rendered, /PRIVATE_(?:EXPORT|COMMAND)_SENTINEL/);
});

test('frozen JSON sessions can be compared and exported without consulting native homes', async t => {
  const f = await fixture(t), task = id(316), turn = id(317);
  const rollout = await seedRollout(f.homes[0], task, [record('session_meta', { id: task }), context(turn)]);
  await seedIndex(f.homes[0], [{ id: task, rolloutPath: rollout }]);
  const source = join(f.root, 'source.json');
  const captured = audit(f, ['export', '--profile', 'A', '--id', task, '--format', 'json', '--output', source]);
  assert.equal(captured.status, 2);
  const frozenPath = captured.value.evidencePath;
  const frozen = JSON.parse(await readFile(frozenPath, 'utf8'));
  await rm(join(f.homes[0], 'state_5.sqlite'));
  const output = join(f.root, 'frozen-diff.json');
  const diff = audit(f, ['diff', frozenPath, frozenPath]);
  assert.ok([0, 2].includes(diff.status), diff.stderr);
  assert.equal(diff.value.left.id, frozen.id);
  assert.equal(diff.value.right.id, frozen.id);
  const copied = audit(f, ['export', frozenPath, '--format', 'json', '--output', output]);
  assert.equal(copied.status, 2);
  assert.equal(JSON.parse(await readFile(copied.value.evidencePath, 'utf8')).id, frozen.id);
});

test('audit validates selectors and options, and retired comparison commands are unavailable', async t => {
  const f = await fixture(t), task = id(321);
  for (const args of [
    ['show'], ['show', '--profile', 'A'], ['show', '--profile', 'A', '--id', 'bad'],
    ['diff', '--left-profile', 'A', '--left-id', task, '--right-profile', 'B'],
    ['diff', '--left-profile', 'A', '--left-id', task, '--right-profile', 'B', '--right-id', task, '--turns'],
    ['export', '--profile', 'A', '--id', task, '--format', 'xml', '--output', join(f.root, 'bad.xml')],
    ['show', '--profile', 'A', '--id', task, '--same-task', 'task'],
    ['profiles', 'A', 'B', '--variables', 'model'],
    ['diff', 'missing.json', 'missing.json', '--same-task', '/private/task'],
    ['diff', 'missing.json', 'missing.json', '--variables', 'model,,effort'],
    ['run', '--spec', 'missing.json', '--same-task', 'task'],
  ]) {
    const result = audit(f, args);
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error);
  }
  for (const command of ['compare', 'compare-tasks']) {
    const result = spawnSync(process.execPath, [cli, '--store', f.store.directory, '--json', command, 'A', task, 'B', task], {
      encoding: 'utf8', env: { ...process.env, HOME: f.root, CODEX_HOME: f.homes[0], XFX_NATIVE_PROFILE_OPEN: '0' },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  const result = audit(f, ['profiles', 'A', 'B', '--repo', 'relative/project', '--client', 'cli']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('direct CLI and Desktop comparisons retain user declarations through export and source-free reopen', async t => {
  const f = await fixture(t), tasks = [id(401), id(402)], turns = [id(403), id(404)];
  for (let index = 0; index < 2; index++) {
    const rollout = await seedRollout(f.homes[index], tasks[index], [
      record('session_meta', { id: tasks[index], originator: index ? 'Codex Desktop' : 'codex_cli_rs' }),
      context(turns[index], { model: index ? 'model-b' : 'model-a', effort: index ? 'high' : 'low' }),
    ]);
    await seedIndex(f.homes[index], [{ id: tasks[index], rolloutPath: rollout }]);
  }
  const selectors = ['--left-profile', 'A', '--left-id', tasks[0], '--right-profile', 'B', '--right-id', tasks[1]];
  const noDeclaration = audit(f, ['diff', ...selectors]);
  assert.equal(noDeclaration.value.selection.taskAssociation.status, 'unknown');
  const declarations = ['--same-task', 'booking ledger', '--variables', 'model,reasoning effort'];
  const compared = audit(f, ['diff', ...selectors, ...declarations]);
  assert.equal(compared.status, 2, 'partial source evidence remains partial');
  assert.equal(compared.value.selection.left.client, 'cli');
  assert.equal(compared.value.selection.right.client, 'desktop');
  assert.equal(compared.value.selection.taskAssociation.status, 'user-declared');
  assert.deepEqual(compared.value.selection.declaredVariables, ['model', 'reasoning effort']);
  assert.equal(compared.value.comparison.explanation.conditions.sameTaskEligible, true);
  assert.equal(compared.value.comparison.models.status, 'different');
  const output = join(f.root, 'declared.md');
  const exported = audit(f, ['export', ...selectors, ...declarations, '--output', output, '--format', 'markdown']);
  assert.equal(exported.status, 2, exported.stderr);
  const markdown = (await readFile(output, 'utf8')).replaceAll('\\', '');
  assert.match(markdown, /Task association: user-declared/);
  assert.match(markdown, /recorded run evidence/);
  assert.match(markdown, /User-declared comparison variables: model, reasoning effort/);
  for (const home of f.homes) await rm(join(home, 'state_5.sqlite'));
  const reopened = audit(f, ['show', exported.value.evidencePath]);
  const frozen = JSON.parse(await readFile(exported.value.evidencePath, 'utf8'));
  assert.deepEqual(reopened.value.selection, frozen.selection);
  assert.equal(reopened.value.selection.left.sessionId, tasks[0]);
  assert.deepEqual(reopened.value.selection.declaration, compared.value.selection.declaration);
  assert.equal(reopened.value.comparison.explanation.conditions.sameTaskEligible, true);
  await assert.rejects(stat(f.marker), { code: 'ENOENT' });
});

test('frozen run pairs accept declarations and export without a native session source', async t => {
  const f = await fixture(t), files = [join(f.root, 'left.json'), join(f.root, 'right.json')];
  for (let i = 0; i < 2; i++) await put(files[i], JSON.stringify({ schemaVersion: 1, kind: 'audit-run', id: id(410 + i), status: 'partial',
    profile: { profileName: i ? 'B' : 'A' }, source: { kind: 'native-rollout', nativeSessionId: id(410 + i) },
    turns: [{ turnId: id(420 + i), model: 'fixture', reasoningEffort: 'low' }], agents: [], events: [], coverage: {} }));
  const output = join(f.root, 'paired.json');
  const result = audit(f, ['export', ...files, '--same-task', 'same change', '--output', output]);
  assert.equal(result.status, 2, result.stderr);
  const frozen = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(frozen.selection.declaration.taskId, 'same change');
  const reopened = audit(f, ['show', output]);
  assert.equal(reopened.value.selection.taskAssociation.status, 'user-declared');
  await assert.rejects(stat(f.marker), { code: 'ENOENT' });
});

test('profile setup export requires explicit content inclusion and preserves readable diff on reopen', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    await put(join(f.homes[i], 'skills', 'review', 'SKILL.md'), '# Same skill\n');
    await put(join(f.homes[i], 'skills', 'review', 'scripts', 'check.js'), `console.log('LOCAL_SOURCE_${i}');\napi_key=NEVER_EXPORT_SECRET\n`);
    await chmod(join(f.homes[i], 'skills', 'review', 'scripts', 'check.js'), i ? 0o700 : 0o600);
  }
  const local = audit(f, ['profiles', 'A', 'B']);
  assert.match(JSON.stringify(local.value), /LOCAL_SOURCE_0/);
  assert.doesNotMatch(JSON.stringify(local.value), /NEVER_EXPORT_SECRET/);
  const without = join(f.root, 'without-content.json'), withContent = join(f.root, 'with-content.md');
  const omitted = audit(f, ['export', 'profiles', 'A', 'B', '--output', without]);
  assert.equal(omitted.status, 2, omitted.stderr);
  assert.doesNotMatch(await readFile(without, 'utf8'), /LOCAL_SOURCE_|NEVER_EXPORT_SECRET/);
  const exportedSetup = JSON.parse(await readFile(without, 'utf8'));
  const modeChange = exportedSetup.comparison.resources.changed.flatMap(row => row.detailDiff?.hunks ?? []).find(row => row.kind === 'metadata-changed');
  assert.deepEqual(modeChange.left, { mode: 0o600 });
  assert.deepEqual(modeChange.right, { mode: 0o700 });
  const included = audit(f, ['export', 'profiles', 'A', 'B', '--include-content', '--output', withContent, '--format', 'markdown']);
  assert.equal(included.status, 2, included.stderr);
  const markdown = (await readFile(withContent, 'utf8')).replaceAll('\\', '');
  assert.match(markdown, /LOCAL_SOURCE_0/);
  assert.match(markdown, /LOCAL_SOURCE_1/);
  assert.doesNotMatch(markdown, /NEVER_EXPORT_SECRET/);
  for (const home of f.homes) await rm(join(home, 'skills'), { recursive: true });
  const reopened = audit(f, ['show', included.value.evidencePath]);
  assert.match(JSON.stringify(reopened.value), /LOCAL_SOURCE_0/);
  assert.equal(reopened.value.contentBoundary, 'selected-redacted-setup-content');
  assert.equal((await stat(without)).mode & 0o777, 0o600);
  await assert.rejects(stat(f.marker), { code: 'ENOENT' });
});

test('partial integration definitions never become unchanged and retain known changes through export and reopen', async t => {
  const f = await fixture(t);
  for (const [i, home] of f.homes.entries()) await put(join(home, 'config.toml'), `
model="same-model"
[mcp_servers.example]
command="node"
args=["server-${i}.js"]
[plugins.example]
enabled=true
private_option="PRIVATE_PLUGIN_${i}"
[hooks.example]
enabled=true
command="PRIVATE_HOOK_${i}"
[mcp_servers.changed]
command="${i ? 'python' : 'node'}"
args=["PRIVATE_ARGUMENT_${i}"]
`);
  const check = value => {
    const resources = value.comparison.resources;
    for (const category of ['mcp', 'plugin', 'hook']) {
      const matches = row => row.category === category && row.name === 'example' && row.scope === 'profile';
      assert.equal(resources.unchanged.some(matches), false, `${category} equality is unproven`);
      const row = resources.unavailable.find(matches);
      assert.ok(row, `${category} must retain partial-value uncertainty`);
      assert.equal(row.comparison, 'unknown');
      assert.equal(row.left.valueStatus, 'partial');
      assert.equal(row.right.valueStatus, 'partial');
    }
    const changed = resources.changed.find(row => row.category === 'mcp' && row.name === 'changed');
    assert.ok(changed.detailDiff.hunks.some(hunk => hunk.left === 'node' && hunk.right === 'python'));
    assert.equal(changed.detailDiff.coverage, 'partial');
    assert.ok(resources.unchanged.some(row => row.name === 'model' && row.value === 'same-model'));
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_PLUGIN_|PRIVATE_HOOK_|PRIVATE_ARGUMENT_|server-[01]\.js/);
  };
  check(audit(f, ['profiles', 'A', 'B']).value);
  const output = join(f.root, 'partial-integrations.md');
  const exported = audit(f, ['export', 'profiles', 'A', 'B', '--output', output, '--format', 'markdown']);
  assert.equal(exported.status, 2, exported.stderr);
  await Promise.all(f.homes.map(home => rm(join(home, 'config.toml'))));
  check(audit(f, ['show', exported.value.evidencePath]).value);
  const markdown = (await readFile(output, 'utf8')).replaceAll('\\', '');
  assert.match(markdown, /undisclosed values or runtime state remain unverified/);
  assert.doesNotMatch(markdown, /PRIVATE_PLUGIN_|PRIVATE_HOOK_|PRIVATE_ARGUMENT_|server-[01]\.js/);
  await assert.rejects(stat(f.marker), { code: 'ENOENT' });
});

test('setup comparison proves removals only from complete matching inventories', async t => {
  const f = await fixture(t);
  await put(join(f.homes[0], 'skills', 'retired', 'SKILL.md'), '# Retired skill\n');
  await put(join(f.homes[0], 'config.toml'), 'model_reasoning_effort="none"\n[memories]\nenabled=true\n');
  await put(join(f.homes[1], 'config.toml'), 'model_reasoning_effort="high"\n');
  const compare = () => audit(f, ['profiles', 'A', 'B']).value.comparison.resources;
  const known = compare();
  assert.ok(known.removed.some(row => row.category === 'skill' && row.name === 'retired'));
  assert.ok(known.removed.some(row => row.category === 'memory-setting' && row.name === 'memories.enabled'));
  assert.ok(known.changed.some(row => row.name === 'model_reasoning_effort' && row.left.value === 'none' && row.right.value === 'high'));
  await put(join(f.homes[1], 'config.toml'), 'not = valid = toml');
  const unknown = compare();
  assert.ok(!unknown.removed.some(row => row.category === 'memory-setting'));
  assert.ok(unknown.unavailable.some(row => row.category === 'memory-setting' && row.name === 'memories.enabled'));
  await assert.rejects(stat(f.marker), { code: 'ENOENT' });
});
