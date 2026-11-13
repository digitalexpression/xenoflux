import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, create } from '../src/profiles.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { presentSetupInventory } from '../src/audit-presentation.js';
import { createDemoProvider } from '../src/ui-demo.js';
import { uiRoutes } from '../src/ui-server.js';

const folders = { codex: '.codex', 'claude-code': '.claude', copilot: '.copilot' };
const items = inventory => inventory.groups.flatMap(group => group.items);
async function put(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-inspect-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'user'), store = new Store(join(root, 'store'));
  const profiles = {};
  for (const [client, folder] of Object.entries(folders)) {
    const managed = join(root, client), home = join(managed, client === 'codex' ? 'codex-home' : folder);
    await mkdir(join(managed, 'user-home'), { recursive: true, mode: 0o700 });
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(join(user, folder), { recursive: true, mode: 0o700 });
    const name = `${client}:baseline`;
    profiles[client] = { name, home, managed };
    await store.update(data => {
      const profile = create(data, name);
      profile.client = client;
      profile.native = { root: managed, environmentId: randomUUID(), executable: join(root, 'missing-client'),
        executableIdentity: '[1,2,3,4,5]', version: '1.2.3',
        ...(client === 'codex' ? {} : { configRoot: home, rootMode: 'explicit' }) };
    });
    for (const path of [home, join(user, folder)]) await put(join(path, client === 'codex' ? 'config.toml' : 'settings.json'),
      client === 'codex' ? 'model = "fixture-model"\n[custom]\ncolor = "aubergine"\n' : { model: 'fixture-model', custom: { color: 'aubergine' }, enabledPlugins: { 'sample@market': false } });
    await put(join(home, client === 'claude-code' ? 'CLAUDE.md' : client === 'codex' ? 'AGENTS.md' : 'copilot-instructions.md'), 'Read the local instructions.');
    await put(join(home, 'skills/example/SKILL.md'), 'Example skill instructions.');
    await put(join(home, 'skills/example/extra.txt'), 'Package resource.');
  }
  let nativeCalls = 0;
  const forbidden = () => { nativeCalls++; throw new Error('Native operation must not run during source inspection'); };
  const provider = createEngineProvider({ store, defaultUserHome: user, reportsRoot: join(root, 'reports'),
    resolveClient: forbidden, observeClients: forbidden, clientOps: { openTerminal: forbidden },
    desktopSurface: { list: forbidden, reconcile: forbidden }, stockApps: { list: forbidden },
    accountContext: { resolveClaude: forbidden, resolveCopilot: forbidden } });
  return { root, user, store, profiles, provider, nativeCalls: () => nativeCalls };
}

test('setup choices and one-profile reads admit all static roots without installed executables or native operations', async t => {
  const f = await fixture(t), before = await readFile(f.store.file);
  const choices = await f.provider.setupChoices();
  assert.equal(choices.choices.length, 6);
  assert.equal(new Set(choices.choices.map(choice => choice.key)).size, 6);
  assert.ok(choices.choices.every(choice => choice.available && choice.reason === null));
  assert.deepEqual(choices.choices.filter(choice => choice.name === 'Default').map(choice => choice.label),
    ['Default · Codex', 'Default · Claude Code', 'Default · GitHub Copilot']);
  for (const [client, profile] of Object.entries(f.profiles)) {
    const path = join(profile.home, client === 'codex' ? 'config.toml' : 'settings.json'), configBefore = await readFile(path);
    const result = await f.provider.profileSetup({ name: profile.name, client });
    assert.equal(result.profile.client, client);
    assert.equal(result.profile.name, profile.name);
    assert.equal(result.project, null);
    assert.ok(result.readAt);
    assert.ok(items(result.inventory).some(item => item.value?.includes('fixture-model')));
    if (client === 'codex') assert.ok(items(result.inventory).some(item => item.value?.includes('aubergine')));
    else assert.ok(items(result.inventory).some(item => item.note.includes('omitted values')));
    assert.ok(items(result.inventory).some(item => item.files.some(file => file.preview === 'Read the local instructions.')));
    assert.ok(items(result.inventory).some(item => item.category === 'skill' && item.files.some(file => file.path.endsWith('extra.txt') && file.preview === 'Package resource.')));
    assert.ok(items(result.inventory).every(item => !('actions' in item) && item.sources.length && item.facts.some(fact => fact.label === 'Source role')));
    if (client !== 'codex') assert.equal(items(result.inventory).find(item => item.name === 'sample@market').facts.find(fact => fact.label === 'enabled').value, 'false');
    assert.deepEqual(await readFile(path), configBefore);
    await f.provider.profileSetup({ name: 'Default', client });
  }
  assert.deepEqual(await readFile(f.store.file), before);
  assert.equal(f.nativeCalls(), 0);
});

test('mixed clients preserve independent values, package files and state, including a missing side', async t => {
  const f = await fixture(t), a = f.profiles['claude-code'], b = f.profiles.copilot;
  await put(join(a.home, 'plugins/cache/market/sample/1/.claude-plugin/plugin.json'), { name: 'sample', version: '1.0.0' });
  const view = await f.provider.setupComparison({ a: a.name, aClient: 'claude-code', b: b.name, bClient: 'copilot' });
  assert.equal(view.groups.length, 0);
  assert.deepEqual(view.counts, { same: 0, different: 0, cannotCompare: 0 });
  assert.equal(view.copyHref, undefined);
  for (const side of ['a', 'b']) {
    assert.ok(items(view.separate[side]).some(item => item.value?.includes('fixture-model')));
    assert.ok(items(view.separate[side]).some(item => item.category === 'skill' && item.files.length > 1));
    assert.ok(view.separate[side].coverage.length);
  }
  const plugin = items(view.separate.a).find(item => item.name === 'sample');
  for (const label of ['configured', 'cached', 'installed', 'enabled', 'available', 'loaded', 'used']) assert.ok(plugin.facts.some(fact => fact.label === label));
  await rm(b.managed, { recursive: true });
  const missing = await f.provider.setupComparison({ a: a.name, aClient: 'claude-code', b: b.name, bClient: 'copilot', fresh: '1' });
  assert.ok(items(missing.separate.a).length);
  assert.equal(missing.separate.b.status, 'unavailable');
  assert.ok(missing.separate.b.warnings.length);
  assert.ok(missing.separate.b.groups.every(group => /Not known/.test(group.coverage)));
  assert.equal((await f.provider.setupChoices()).choices.find(choice => choice.name === b.name).available, false);
  await assert.rejects(f.provider.profileSetup({ name: b.name, client: 'copilot' }), /Couldn’t read this setup/);
});

test('repository context reaches direct and both comparison readers and scopes cache and skill links', async t => {
  const f = await fixture(t), a = f.profiles.codex, b = f.profiles['claude-code'];
  const repos = [join(f.root, 'first-repo'), join(f.root, 'second-repo')];
  for (const [index, repo] of repos.entries()) {
    await put(join(repo, '.codex/config.toml'), `model = "repo-${index}"\n`);
    await put(join(repo, '.claude/settings.json'), { model: `repo-${index}` });
    await put(join(repo, 'AGENTS.md'), `Repository ${index} instructions.`);
    await put(join(repo, 'CLAUDE.md'), `Repository ${index} instructions.`);
    await put(join(repo, '.agents/skills/project-helper/SKILL.md'), `Repository ${index} skill.`);
    const single = await f.provider.profileSetup({ name: a.name, repo });
    assert.equal(single.project, repo);
    assert.ok(items(single.inventory).some(item => item.scope === 'Project' && item.value === `repo-${index}`));
    const view = await f.provider.setupComparison({ a: a.name, b: b.name, bClient: 'claude-code', repo });
    assert.equal(view.project, repo);
    for (const side of ['a', 'b']) assert.ok(items(view.separate[side]).some(item => item.scope === 'Project' && item.value?.includes(`repo-${index}`)));
  }
  const repo = repos[0];
  const same = await f.provider.setupComparison({ a: a.name, b: 'Default', repo });
  const link = same.groups.flatMap(group => group.items).find(item => item.name === 'project-helper').actions.packageHref;
  assert.equal(new URL(link, 'http://localhost').searchParams.get('repo'), repo);
  const detail = await f.provider.skillDetail({ a: a.name, b: 'Default', skill: 'project-helper', repo });
  assert.equal(detail.source, 'Project');
  assert.ok(detail.files.some(file => file.path === 'SKILL.md'));
  assert.equal(detail.copy, null);
  await put(join(a.home, 'config.toml'), 'model = "changed-model"\n');
  const cached = await f.provider.setupComparison({ a: a.name, b: b.name, bClient: 'claude-code', repo });
  assert.ok(items(cached.separate.a).some(item => item.scope === 'Profile' && item.value === 'fixture-model'));
  const refreshed = await f.provider.setupComparison({ a: a.name, b: b.name, bClient: 'claude-code', repo, fresh: '1' });
  assert.ok(items(refreshed.separate.a).some(item => item.scope === 'Profile' && item.value === 'changed-model'));
  const linkRepo = join(f.root, 'linked-repo'); await symlink(repo, linkRepo);
  for (const invalid of ['', 'relative', `${repo}/..`, join(f.root, 'missing'), linkRepo]) {
    await assert.rejects(f.provider.profileSetup({ name: a.name, repo: invalid }), error => error.code === 'invalid-project');
    await assert.rejects(f.provider.setupComparison({ a: a.name, b: b.name, bClient: 'claude-code', repo: invalid }), error => error.code === 'invalid-project');
  }
  await assert.rejects(f.provider.profileSetup({ name: a.name, client: 'unknown' }), error => error.code === 'invalid-selection');
  assert.equal(f.nativeCalls(), 0);
});

test('bad registries leave standard setup inspection available and show managed choices as unavailable', async t => {
  const f = await fixture(t);
  const data = JSON.parse(await readFile(f.store.file, 'utf8'));
  data.profiles.push(data.profiles[0]);
  await put(f.store.file, data);
  const blocked = await f.provider.setupChoices();
  assert.ok(blocked.warnings.length);
  assert.equal(new Set(blocked.choices.map(choice => choice.key)).size, blocked.choices.length);
  assert.ok(blocked.choices.filter(choice => choice.name !== 'Default').every(choice => !choice.available));
  assert.ok(blocked.choices.filter(choice => choice.name === 'Default').every(choice => choice.available));
  await put(f.store.file, '{ broken');
  const malformed = await f.provider.setupChoices();
  assert.ok(malformed.warnings.length);
  assert.equal(malformed.choices.length, 3);
  assert.ok((await f.provider.profileSetup({ name: 'Default', client: 'claude-code' })).inventory.groups.length);
});

test('source reading and preview limits remain explicit without treating partial empty groups as absence', async t => {
  const f = await fixture(t), profile = f.profiles['claude-code'];
  await put(join(profile.home, 'settings.json'), '{ malformed');
  await put(join(profile.home, 'agents/unreadable.md'), 'Do not expose this unreadable instruction.');
  await chmod(join(profile.home, 'agents/unreadable.md'), 0o666);
  await put(join(profile.home, 'skills/large/SKILL.md'), 'a'.repeat(70 * 1024));
  const result = await f.provider.profileSetup({ name: profile.name, client: 'claude-code' });
  assert.ok(result.inventory.coverage.some(fact => fact.label === 'Profile config' && fact.value === 'Partly read'));
  assert.equal(items(result.inventory).find(item => item.name === 'unreadable.md').status, 'unreadable');
  const large = items(result.inventory).find(item => item.category === 'skill' && item.name === 'large');
  assert.ok(large.files.some(file => file.note?.includes('truncated')));
  assert.ok(result.inventory.groups.find(group => group.id === 'tools').coverage.includes('Couldn’t be read'));
  const presented = presentSetupInventory({ status: 'partial', resources: [{ id: 'omitted', category: 'config', name: 'custom', scope: 'profile',
    status: 'present', valueStatus: 'omitted', note: 'Source value omitted by the detail budget.' }], coverage: { sourceValues: 'partial' } });
  assert.equal(items(presented)[0].value, null);
  assert.match(items(presented)[0].note, /omitted/);
  assert.match(presented.coverage[0].value, /omitted/);
  const preview = presentSetupInventory({ status: 'partial', resources: [{ category: 'instruction', name: 'AGENTS.md', path: '/fixture/AGENTS.md',
    detail: { status: 'partial', text: '[redacted] preview', redacted: true, truncated: true } }] });
  const note = items(preview)[0].files[0].note;
  assert.match(note, /truncated/);
  assert.match(note, /redacted/);
});

test('demo choices, direct inspection and mixed setup evidence stay synthetic', async () => {
  const provider = createDemoProvider();
  const choices = await provider.setupChoices();
  assert.ok(choices.choices.some(choice => choice.client === 'copilot'));
  const single = await provider.profileSetup({ name: 'Default', client: 'claude-code' });
  assert.ok(single.inventory.warnings.some(warning => warning.includes('Synthetic')));
  const mixed = await provider.setupComparison({ a: 'Default', aClient: 'codex', b: 'Default', bClient: 'copilot' });
  assert.ok(items(mixed.separate.a).some(item => item.value === 'gpt-6'));
  assert.equal(mixed.groups.length, 0);
});

test('setup GET routes preserve qualified profile names and repository context', async t => {
  const f = await fixture(t), routes = uiRoutes(f.provider), profile = f.profiles.copilot;
  const invoke = async path => {
    const url = new URL(path, 'http://localhost');
    const route = routes.find(route => route.method === 'GET' && route.match(url.pathname));
    return route.handler({ params: route.match(url.pathname), query: url.searchParams });
  };
  assert.equal((await invoke('/api/setups/options')).choices.length, 6);
  const single = await invoke(`/api/profiles/${encodeURIComponent(profile.name)}/setup?client=copilot&name=Default&repo=${encodeURIComponent(f.root)}`);
  assert.equal(single.profile.name, profile.name);
  assert.equal(single.profile.client, 'copilot');
  assert.equal(single.project, f.root);
  const mixed = await invoke(`/api/compare/setups?a=Default&aClient=claude-code&b=Default&bClient=copilot&repo=${encodeURIComponent(f.root)}&fresh=1`);
  assert.equal(mixed.project, f.root);
  assert.ok(mixed.separate.a.groups.length && mixed.separate.b.groups.length);
});
