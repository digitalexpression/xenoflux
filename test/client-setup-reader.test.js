import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverAuditProfile, resolveAuditProfile, auditResourceAbsent } from '../src/audit-discovery.js';
import { compareAuditProfiles } from '../src/audit.js';

async function put(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-client-setup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'user'); await mkdir(user, { mode: 0o700 });
  return { root, user, store: { read: async () => ({ profiles: [] }) }, options: { defaultUserHome: user, adminRoots: [] } };
}
const matching = (snapshot, category, name) => snapshot.resources.filter(item => item.category === category && (!name || item.name === name));

for (const clientId of ['claude-code', 'copilot']) {
  test(`${clientId}: category parity, project/user scopes, plugin ownership and safe details`, async t => {
    const f = await fixture(t), claude = clientId === 'claude-code', home = join(f.user, claude ? '.claude' : '.copilot');
    const repo = join(f.root, 'repo'), project = join(repo, claude ? '.claude' : '.github');
    await put(join(home, 'settings.json'), { model: 'fixture-model', hooks: { SessionStart: [{ hooks: [{ command: 'TOP-SECRET-COMMAND' }] }] },
      enabledPlugins: { 'sample@market': false }, env: { PASSWORD: 'TOP-SECRET-ENV' } });
    await put(join(home, claude ? 'CLAUDE.md' : 'copilot-instructions.md'), 'User guidance');
    await put(join(home, 'skills', 'shared', 'SKILL.md'), 'User skill');
    await put(join(home, 'skills', 'shared', 'resource.bin'), Buffer.from([0, 1, 2]).toString());
    await put(join(home, 'agents', 'review.agent.md'), 'Agent instructions');
    await put(join(project, claude ? 'rules' : 'instructions', 'style.md'), 'Project rule');
    await put(join(project, 'skills', 'shared', 'SKILL.md'), 'Project skill');
    await put(join(project, ...(claude ? [] : ['copilot']), 'settings.local.json'), { model: 'local-model' });
    await put(join(repo, claude ? 'CLAUDE.md' : 'AGENTS.md'), 'Project guidance');
    const mcp = { mcpServers: { sample: { command: 'node', args: ['TOP-SECRET-ARG'], url: 'https://example.invalid/TOP-SECRET-URL',
      headers: { Authorization: 'TOP-SECRET-HEADER' }, env: { UNKNOWN: 'TOP-SECRET-ENV' }, enabled: false } } };
    await put(join(repo, claude ? '.mcp.json' : '.github/mcp.json'), mcp);
    const plugin = join(home, ...(claude ? ['plugins', 'cache', 'market', 'sample', '1'] : ['installed-plugins', 'sample']));
    await put(join(plugin, claude ? '.claude-plugin/plugin.json' : 'plugin.json'), { name: 'sample', version: '1.0.0',
      hooks: { SessionEnd: [{ command: 'TOP-SECRET-PLUGIN' }] }, mcpServers: mcp.mcpServers, token: 'TOP-SECRET-TOKEN' });
    await put(join(plugin, 'skills', 'shared', 'SKILL.md'), 'Plugin skill');
    await put(join(plugin, 'agents', 'plugin.md'), 'Plugin agent');
    await put(join(plugin, 'rules', 'plugin.md'), 'Plugin rule');
    // Credential stores are unsafe symlinks: discovery must not even inventory them.
    await put(join(f.root, 'credentials'), 'TOP-SECRET-CREDENTIALS');
    for (const file of claude ? ['.credentials.json'] : ['config.json']) await symlink(join(f.root, 'credentials'), join(home, file));
    const snapshot = await discoverAuditProfile(f.store, 'Default', { ...f.options, repo, clientId, includeSourceValues: true });
    assert.equal(snapshot.context.clientId, clientId);
    assert.equal(snapshot.status, 'partial');
    for (const category of ['instruction', 'skill', 'agent', 'rule', 'config', 'hook', 'mcp', 'plugin'])
      assert.ok(matching(snapshot, category).some(item => item.status === 'present'), category);
    const skills = matching(snapshot, 'skill', 'shared');
    assert.deepEqual(new Set(skills.map(item => item.scope)), new Set(['user', 'project', 'plugin']));
    assert.ok(skills.every(item => item.origin && item.sourceRole && item.inventoryKey));
    const owned = skills.find(item => item.scope === 'plugin');
    assert.ok(owned.provider && owned.sourceRole === `plugin:${owned.provider}`);
    const packageEntry = matching(snapshot, 'plugin', 'sample')[0];
    assert.equal(packageEntry.state.installed, 'unknown');
    assert.equal(packageEntry.state.enabled, 'unknown');
    assert.equal(matching(snapshot, 'plugin', 'sample@market')[0].state.enabled, false);
    assert.equal(matching(snapshot, 'mcp', 'sample').find(item => item.scope === 'project').state.enabled, false);
    assert.equal(JSON.stringify(snapshot).includes('TOP-SECRET'), false);
    assert.equal(snapshot.resources.some(item => /(?:credentials|config\.json)$/.test(item.path)), false);
  });

  test(`${clientId}: unreadable, malformed, unsafe and bounded sources stay partial`, async t => {
    const f = await fixture(t), home = join(f.user, clientId === 'claude-code' ? '.claude' : '.copilot');
    await put(join(home, 'settings.json'), '{ broken');
    await put(join(home, 'agents', 'unsafe.md'), 'Unreadable content');
    await chmod(join(home, 'agents', 'unsafe.md'), 0o666);
    await put(join(f.root, 'outside.md'), 'Outside instructions');
    await symlink(join(f.root, 'outside.md'), join(home, clientId === 'claude-code' ? 'CLAUDE.md' : 'copilot-instructions.md'));
    const snapshot = await discoverAuditProfile(f.store, 'Default', { ...f.options, clientId });
    assert.equal(snapshot.coverage.config, 'partial');
    assert.equal(snapshot.coverage.agents, 'partial');
    assert.equal(snapshot.coverage.instructions, 'partial');
    assert.equal(matching(snapshot, 'config')[0].status, 'unsupported');
    assert.equal(matching(snapshot, 'agent')[0].status, 'unreadable');
    assert.equal(snapshot.resources.some(item => item.detail?.text === 'Outside instructions'), false);
    const agent = matching(snapshot, 'agent')[0];
    assert.equal(auditResourceAbsent(agent, snapshot), false);
  });

  test(`${clientId}: same-client comparison proves safe differences without equating hidden definitions`, async t => {
    const f = await fixture(t), other = join(f.root, 'other'), directory = clientId === 'claude-code' ? '.claude' : '.copilot';
    await put(join(f.user, directory, 'settings.json'), { model: 'first' });
    await put(join(other, directory, 'settings.json'), { model: 'second' });
    const result = await compareAuditProfiles(f.store, 'Default', 'Default', { ...f.options, clientId,
      rightOptions: { defaultUserHome: other } });
    assert.equal(result.comparison.resources.changed.filter(item => item.category === 'config').length, 1);
    assert.equal(result.comparison.resources.changed[0].detailDiff.hunks.some(item => item.path === 'value.model'), true);
  });
}

test('mixed clients return separate snapshots with no category equivalence or unchanged claims', async t => {
  const f = await fixture(t);
  for (const home of ['.claude', '.copilot']) await put(join(f.user, home, 'settings.json'), { model: 'same' });
  const result = await compareAuditProfiles(f.store, 'Default', 'Default', { ...f.options,
    leftOptions: { clientId: 'claude-code' }, rightOptions: { clientId: 'copilot' } });
  assert.equal(result.comparison.mode, 'separate');
  assert.equal(result.left.context.clientId, 'claude-code');
  assert.equal(result.right.context.clientId, 'copilot');
  assert.ok(Object.values(result.comparison.resources).every(items => !items.length));
  assert.equal(result.coverage.equivalence, 'unavailable');
});

test('Copilot JSONC settings preserve strings, comments and trailing commas', async t => {
  const f = await fixture(t);
  await put(join(f.user, '.copilot/settings.json'), '// comment\n{ "model": "fixture", /* comment */ "askUser": false, }');
  const snapshot = await discoverAuditProfile(f.store, 'Default', { ...f.options, clientId: 'copilot' });
  assert.deepEqual(matching(snapshot, 'config')[0].value, Object.assign(Object.create(null), { model: 'fixture', askUser: false }));
  assert.equal(snapshot.coverage.config, 'complete');
});

test('validated binding preserves root mode and refuses wrong client/profile/root without fallback', async t => {
  const f = await fixture(t), reservation = join(f.root, 'managed'), home = join(reservation, 'config');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await put(join(home, 'settings.json'), { model: 'bound-model' });
  const binding = { client: 'claude-code', surface: 'cli', executionLocation: 'local', profileId: 'fixture-profile', rootMode: 'explicit',
    roots: { config: home, user: f.user, reservation, runtime: null }, workspace: null,
    executable: { path: join(f.root, 'never-executed'), identity: 'fixture', version: '1.0.0' }, settingsIdentity: null };
  const store = { read: async () => ({ profiles: [{ id: 'fixture-profile', name: 'Fixture', client: 'claude-code', native: { root: reservation } }] }) };
  const snapshot = await discoverAuditProfile(store, 'Fixture', { ...f.options, clientId: 'claude-code', binding });
  assert.equal(snapshot.profile.home, home);
  assert.equal(snapshot.profile.rootMode, 'explicit');
  assert.equal(snapshot.resources.find(item => item.category === 'config').scope, 'profile');
  for (const changed of [{ client: 'copilot' }, { profileId: 'wrong' }, { roots: { ...binding.roots, reservation: f.root } }])
    await assert.rejects(resolveAuditProfile(store, 'Fixture', { clientId: 'claude-code', binding: { ...binding, ...changed } }), /match/);
  await assert.rejects(resolveAuditProfile(store, 'Fixture', { clientId: 'claude-code' }), /resolved environment binding/);
  await assert.rejects(resolveAuditProfile(store, 'Default', { clientId: 'unknown' }), /Unsupported/);
});

test('Claude installation registrations prove only matching scoped package installation; custom components stay owned', async t => {
  const f = await fixture(t), home = join(f.user, '.claude'), plugin = join(home, 'plugins/cache/market/sample/1');
  await put(join(home, 'plugins/installed_plugins.json'), { version: 2, plugins: {
    'sample@market': [{ scope: 'user', installPath: plugin, version: '1.0.0', private: 'TOP-SECRET-REGISTRY' }],
    'foreign@market': [{ scope: 'project', projectPath: join(f.root, 'other-repo'), installPath: plugin }],
  } });
  await put(join(plugin, '.claude-plugin/plugin.json'), { name: 'sample', version: '1.0.0', skills: ['./extra-skills'],
    agents: './extra-agents/helper.md', hooks: './custom/hooks.json', mcpServers: './custom/mcp.json' });
  await put(join(plugin, 'extra-skills/tool/SKILL.md'), 'Custom skill');
  await put(join(plugin, 'extra-agents/helper.md'), 'Custom agent');
  await put(join(plugin, 'custom/hooks.json'), { hooks: { SessionStart: [{ command: 'TOP-SECRET-HOOK' }] } });
  await put(join(plugin, 'custom/mcp.json'), { mcpServers: { custom: { type: 'stdio', args: ['TOP-SECRET-ARG'] } } });
  const snapshot = await discoverAuditProfile(f.store, 'Default', { ...f.options, clientId: 'claude-code', includeSourceValues: true });
  const packageEntry = matching(snapshot, 'plugin', 'sample')[0];
  assert.equal(packageEntry.integrationId, 'sample@market');
  assert.equal(packageEntry.state.installed, 'present');
  assert.equal(packageEntry.state.enabled, 'unknown');
  for (const [category, name] of [['skill', 'tool'], ['agent', 'helper.md'], ['hook', 'SessionStart'], ['mcp', 'custom']])
    assert.equal(matching(snapshot, category, name)[0].provider, 'sample@market');
  assert.equal(JSON.stringify(snapshot).includes('TOP-SECRET'), false);
});

test('plugin traversal and credential paths are refused; integration agent frontmatter is withheld', async t => {
  const f = await fixture(t), home = join(f.user, '.copilot'), plugin = join(home, 'installed-plugins/sample');
  await put(join(plugin, 'plugin.json'), { name: 'sample', skills: '../outside', mcpServers: './config.json', agents: '/private/tmp' });
  await put(join(plugin, 'config.json'), 'TOP-SECRET-STORE');
  await put(join(home, 'agents/helper.md'), '---\nname: helper\nmcp-servers:\n  sample:\n    env:\n      UNKNOWN: TOP-SECRET-INLINE\n---\nAgent guidance');
  const snapshot = await discoverAuditProfile(f.store, 'Default', { ...f.options, clientId: 'copilot', includeSourceValues: true });
  assert.equal(snapshot.coverage.skills, 'partial');
  assert.equal(snapshot.coverage.agents, 'partial');
  assert.equal(JSON.stringify(snapshot).includes('TOP-SECRET'), false);
  assert.equal(matching(snapshot, 'agent', 'helper.md')[0].comparison, 'unknown');
  assert.ok(snapshot.warnings.some(item => item.includes('Unsafe plugin')));
});

test('Copilot portable plugin components use their namespace and shared settings remain separate', async t => {
  const f = await fixture(t), home = join(f.user, '.copilot'), plugin = join(home, 'installed-plugins/portable'), repo = join(f.root, 'repo');
  await put(join(plugin, 'plugin.json'), { name: 'portable', $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' });
  await put(join(plugin, 'com.github.copilot/agents/helper.agent.md'), 'Namespaced agent');
  await put(join(plugin, 'com.github.copilot/hooks/hooks.json'), { hooks: { preToolUse: [{ bash: 'TOP-SECRET-COMMAND' }] } });
  await put(join(plugin, 'mcp.json'), { mcpServers: { portable: { type: 'stdio' } } });
  await put(join(repo, '.github/copilot/settings.json'), { model: 'copilot-model', enabledPlugins: { portable: true } });
  await put(join(repo, '.claude/settings.json'), { model: 'not-copilot-model', hooks: { SessionStart: [] } });
  const snapshot = await discoverAuditProfile(f.store, 'Default', { ...f.options, clientId: 'copilot', repo });
  assert.equal(matching(snapshot, 'agent', 'helper.agent.md')[0].scope, 'plugin');
  assert.equal(matching(snapshot, 'hook', 'preToolUse')[0].scope, 'plugin');
  assert.equal(matching(snapshot, 'mcp', 'portable')[0].scope, 'plugin');
  assert.equal(JSON.stringify(snapshot).includes('TOP-SECRET'), false);
  assert.equal(JSON.stringify(snapshot).includes('not-copilot-model'), false);
  assert.equal(matching(snapshot, 'config').find(item => item.origin === 'cross-tool-shared').value.model, undefined);
});

test('source count bounds keep unobserved resources unknown', async t => {
  const f = await fixture(t), home = join(f.user, '.copilot');
  const hooks = Object.fromEntries(Array.from({ length: 258 }, (_, i) => [`event${i}`, []]));
  await put(join(home, 'settings.json'), { hooks });
  const snapshot = await discoverAuditProfile(f.store, 'Default', { ...f.options, clientId: 'copilot' });
  assert.equal(matching(snapshot, 'hook').length, 256);
  assert.equal(snapshot.coverage.hooks, 'partial');
  assert.ok(snapshot.inventory.some(item => item.category === 'hook' && item.status === 'partial'));
});

test('same-client local skill comparison includes binary resources and executable modes', async t => {
  const f = await fixture(t), other = join(f.root, 'other');
  for (const user of [f.user, other]) {
    await put(join(user, '.claude/skills/tool/SKILL.md'), 'Same skill text');
    await put(join(user, '.claude/skills/tool/run.sh'), '#!/bin/sh\nexit 0\n');
    await put(join(user, '.claude/skills/tool/data.bin'), 'same initial bytes');
  }
  await writeFile(join(other, '.claude/skills/tool/data.bin'), Buffer.from([0, 255, 128, 5]));
  await chmod(join(other, '.claude/skills/tool/run.sh'), 0o700);
  const result = await compareAuditProfiles(f.store, 'Default', 'Default', { ...f.options, clientId: 'claude-code', includeSourceValues: true,
    rightOptions: { defaultUserHome: other } });
  const changed = result.comparison.resources.changed.find(item => item.category === 'skill');
  assert.ok(changed);
  assert.equal(changed.left.fingerprintScope, 'local-skill-package');
  assert.notEqual(changed.left.fingerprint, changed.right.fingerprint);
  assert.ok(changed.detailDiff.hunks.some(item => item.path === 'data.bin'));
  assert.ok(changed.detailDiff.hunks.some(item => item.path === 'run.sh' && item.kind === 'metadata-changed'));
});

test('explicit identical-path Default binding preserves root mode independently of stock-root discovery', async t => {
  const f = await fixture(t), home = join(f.user, '.copilot');
  await mkdir(home, { mode: 0o700 });
  const binding = { client: 'copilot', surface: 'cli', executionLocation: 'local', profileId: 'default', rootMode: 'explicit',
    roots: { config: home, user: f.user, reservation: f.user, runtime: null }, workspace: null,
    executable: { path: join(f.root, 'never-executed'), identity: 'fixture', version: '1.0.0' }, settingsIdentity: null };
  const explicit = await resolveAuditProfile(f.store, 'Default', { ...f.options, binding });
  const implicit = await resolveAuditProfile(f.store, 'Default', { ...f.options, clientId: 'copilot' });
  assert.equal(explicit.home, implicit.home);
  assert.equal(explicit.rootMode, 'explicit');
  assert.equal(implicit.rootMode, 'implicit');
});
