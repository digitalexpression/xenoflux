import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { auditResourceAbsent, discoverAuditProfile, resolveAuditProfile } from '../src/audit-discovery.js';
import { compareAuditResourceDetails, comparableAuditResource } from '../src/audit-profile-diff.js';

async function put(path, value = 'private skill text') {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-discovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'not-launchable'); await writeFile(executable, 'not an executable', { mode: 0o700 });
  const native = await prepareNativeHome({ directory: join(root, 'native'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store')); await store.update(data => create(data, 'Profile'));
  await registerHome(store, 'Profile', native.root, { executable, version: '0.153.4' });
  const user = join(root, 'user'); await mkdir(user, { mode: 0o700 });
  return { root, native, store, user };
}
const matching = (report, category, name) => report.resources.filter(item => item.category === category && item.name === name);

test('resolves registered profiles independently of launcher readiness and Default ignores ambient CODEX_HOME', async t => {
  const f = await fixture(t);
  const profile = await resolveAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  assert.equal(profile.home, join(f.native.root, 'codex-home'));
  assert.equal(profile.userHome, join(f.native.root, 'user-home'));
  assert.equal(typeof profile.environmentId, 'string');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(f.root, 'ambient');
  try {
    const standard = await resolveAuditProfile(f.store, 'Default', { defaultUserHome: f.user });
    assert.equal(standard.home, join(f.user, '.codex'));
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test('discovers same-name skills across profile, user, project, plugin, system, and admin origins with safe local detail', async t => {
  const f = await fixture(t), repo = join(f.root, 'repo'), admin = join(f.root, 'admin-skills');
  await mkdir(repo, { mode: 0o700 });
  const roots = [
    join(f.native.home, 'skills', 'shared'),
    join(f.native.userHome, '.agents', 'skills', 'shared'),
    join(repo, '.agents', 'skills', 'shared'),
    join(f.native.home, 'skills', '.system', 'shared'),
    join(admin, 'shared'),
  ];
  for (const [index, root] of roots.entries()) await put(join(root, 'SKILL.md'), `Use the skill workflow ${index}.`);
  const plugin = join(f.native.home, 'plugins', 'cache', 'market', 'plugin', '1.0.0');
  await put(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ id: 'market/plugin', name: 'Example Plugin', version: '1.0.0', api_key: 'plugin-password-sentinel' }));
  await put(join(plugin, 'skills', 'shared', 'SKILL.md'), 'Use the plugin workflow.');
  const report = await discoverAuditProfile(f.store, 'Profile', { repo, defaultUserHome: f.user, adminRoots: [admin] });
  const skills = matching(report, 'skill', 'shared');
  assert.equal(skills.length, 6);
  assert.deepEqual(new Set(skills.map(item => item.scope)), new Set(['profile', 'user', 'project', 'system', 'admin', 'plugin']));
  assert.ok(skills.every(item => item.status === 'present' && item.fingerprint));
  assert.ok(skills.every(item => item.logicalPath === 'shared' && item.sourceRole));
  assert.ok(skills.every(item => item.clientApplicability?.status === 'unknown'));
  assert.ok(skills.some(item => item.provider === 'market/plugin'));
  assert.equal(matching(report, 'plugin', 'Example Plugin').length, 1);
  assert.equal(report.coverage.client, 'partial');
  const serialized = JSON.stringify(report);
  for (const secret of ['plugin-password-sentinel', 'auth.json']) assert.equal(serialized.includes(secret), false);
  assert.ok(serialized.includes('Use the skill workflow 0.'));
  assert.ok(serialized.includes('Use the plugin workflow.'));
});

test('discovers the Default Codex home once when profile and user roots are the same directory', async t => {
  const f = await fixture(t), config = join(f.user, '.codex', 'config.toml');
  await put(config, '[mcp_servers.alpha]\ncommand = "safe"\n');
  const report = await discoverAuditProfile(f.store, 'Default', { defaultUserHome: f.user, adminRoots: [] });
  const rows = matching(report, 'mcp', 'alpha');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, config);
  assert.equal(rows[0].scope, 'profile');
});

test('plugin config and recognizable cache layout share a namespaced integration identity', async t => {
  const f = await fixture(t);
  await put(join(f.native.home, 'config.toml'), '[plugins]\n"code-review@openai-bundled" = { enabled = true }\n');
  const packageRoot = join(f.native.home, 'plugins', 'cache', 'openai-bundled', 'code-review', 'revision-1');
  await put(join(packageRoot, 'plugin.json'), JSON.stringify({ name: 'Code Review', version: '1.2.3' }));
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, adminRoots: [] });
  const configured = matching(report, 'plugin', 'code-review@openai-bundled')[0];
  const cached = matching(report, 'plugin', 'Code Review')[0];
  assert.equal(configured.integrationId, 'code-review@openai-bundled');
  assert.equal(cached.integrationId, 'code-review@openai-bundled');
  assert.equal(cached.provider, 'openai-bundled');
  assert.equal(cached.version, '1.2.3');
});

test('opt-in local source comparison includes cached plugin manifest metadata but leaves runtime state unknown', async t => {
  const f = await fixture(t), packageRoot = join(f.native.home, 'plugins', 'cache', 'marketplace', 'cached-plugin', '1.0.0');
  await put(join(packageRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    id: 'cached-plugin@marketplace', name: 'Cached Plugin', version: '1.0.0', custom_field: 'synthetic-manifest-marker',
  }));
  const standard = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const local = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const standardEntry = standard.resources.find(item => item.sourceRole === 'plugin-cache' && item.name === 'Cached Plugin');
  const localEntry = local.resources.find(item => item.sourceRole === 'plugin-cache' && item.name === 'Cached Plugin');
  assert.equal(standardEntry.value, undefined);
  assert.equal(JSON.stringify(standard).includes('synthetic-manifest-marker'), false);
  assert.equal(localEntry.value.custom_field, 'synthetic-manifest-marker');
  assert.equal(localEntry.valueStatus, 'present');
  assert.equal(localEntry.comparison, 'available');
  assert.equal(localEntry.state.cached, 'present');
  assert.equal(localEntry.state.installed, 'unknown');
  assert.equal(localEntry.state.loaded, 'unknown');
  assert.equal(localEntry.state.used, 'unknown');
});

test('plugin cache layouts deeper than marketplace/plugin/version do not infer an integration identity', async t => {
  const f = await fixture(t);
  const packageRoot = join(f.native.home, 'plugins', 'cache', 'marketplace', 'custom-plugin', 'extra', 'revision-1');
  await put(join(packageRoot, 'plugin.json'), JSON.stringify({ name: 'Loose Depth', version: '1.0.0' }));
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, adminRoots: [] });
  const cached = matching(report, 'plugin', 'Loose Depth')[0];
  assert.equal(cached.integrationId, undefined);
});

test('plugin cache aliases are corroborated only against an already read in-cache canonical package', async t => {
  const f = await fixture(t), cache = join(f.native.home, 'plugins', 'cache');
  const packageRoot = join(cache, 'marketplace', 'alias-plugin', '1.0.0');
  await put(join(packageRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'Alias Plugin', version: '1.0.0' }));
  const aliasPath = join(dirname(packageRoot), 'latest');
  await symlink(packageRoot, aliasPath);
  const cleanAliasReport = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, adminRoots: [] });
  const plugin = matching(cleanAliasReport, 'plugin', 'Alias Plugin')[0];
  assert.ok(plugin.aliasPaths.includes(aliasPath));
  assert.ok(plugin.observations.some(observation => observation.kind === 'alias' && observation.source === aliasPath));
  assert.equal(cleanAliasReport.inventory.find(item => item.sourceRole === 'plugin-cache').status, 'complete');

  const outside = join(f.root, 'external-plugin');
  await put(join(outside, 'plugin.json'), JSON.stringify({ name: 'Outside Plugin', version: '1.0.0' }));
  await symlink(outside, join(dirname(packageRoot), 'outside-alias'));
  const unsafeReport = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, adminRoots: [] });
  assert.equal(unsafeReport.coverage.plugins, 'partial');
  assert.equal(unsafeReport.inventory.find(item => item.sourceRole === 'plugin-cache').status, 'partial');
  assert.ok(matching(unsafeReport, 'plugin', 'outside-alias').some(item => item.status === 'unsafe'));
});

test('plugin cache traversal caps leave inventory partial and cannot prove absence', async t => {
  const f = await fixture(t), cache = join(f.native.home, 'plugins', 'cache');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 257; index++) await mkdir(join(cache, `entry-${String(index).padStart(3, '0')}`), { mode: 0o700 });
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, adminRoots: [] });
  const inventory = report.inventory.find(item => item.sourceRole === 'plugin-cache');
  assert.equal(inventory.status, 'partial');
  assert.equal(auditResourceAbsent({ category: 'plugin', scope: 'plugin', sourceRole: 'plugin-cache', logicalPath: 'missing/1.0.0', inventoryKey: inventory.key }, report), false);
});

test('unreadable resources and plugin symlinks remain visible and lower coverage', async t => {
  const f = await fixture(t);
  await put(join(f.native.home, 'AGENTS.md'), 'instruction text');
  await chmod(join(f.native.home, 'AGENTS.md'), 0o666);
  const cache = join(f.native.home, 'plugins', 'cache');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const target = join(f.root, 'plugin-target'); await mkdir(target, { mode: 0o700 });
  await symlink(target, join(cache, 'linked-plugin'));
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  assert.equal(report.coverage.instructions, 'partial');
  assert.equal(matching(report, 'instruction', 'AGENTS.md')[0].status, 'unreadable');
  assert.equal(report.coverage.plugins, 'partial');
  assert.equal(matching(report, 'plugin', 'linked-plugin')[0].status, 'unsafe');
  assert.ok(matching(report, 'config', 'config.toml')[0].logicalPath);
});

test('redacts arbitrary credential fields before output and fingerprints, and gives definitions distinct IDs', async t => {
  const f = await fixture(t), configPath = join(f.native.home, 'config.toml');
  const configText = [
    'model = "safe-model"',
    'private_setting = "audit-private-sentinel"',
    'opaque_password = "audit-password-sentinel"',
    'api_key = "audit-api-key-sentinel"',
    '[mcp_servers.alpha]',
    'command = "safe-alpha"',
    '[mcp_servers.beta]',
    'command = "safe-beta"',
    '',
  ].join('\n');
  await put(configPath, configText);
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const text = JSON.stringify(report);
  assert.equal(text.includes('audit-password-sentinel'), false);
  assert.equal(text.includes('audit-private-sentinel'), false);
  assert.equal(text.includes('audit-api-key-sentinel'), false);
  assert.equal(text.includes('plugin-password-sentinel'), false);
  const firstFingerprint = matching(report, 'config', 'config.toml')[0].fingerprint;
  const changedPrivateValues = configText.replace('audit-private-sentinel', 'another-private-sentinel')
    .replace('audit-password-sentinel', 'another-password-sentinel').replace('audit-api-key-sentinel', 'another-api-key-sentinel');
  await put(configPath, changedPrivateValues);
  const privateOnlyChange = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  assert.equal(matching(privateOnlyChange, 'config', 'config.toml')[0].fingerprint, firstFingerprint);
  await put(configPath, changedPrivateValues.replace('safe-model', 'another-safe-model'));
  const publicChange = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  assert.notEqual(matching(publicChange, 'config', 'config.toml')[0].fingerprint, firstFingerprint);
  const definitions = matching(report, 'mcp', 'alpha').concat(matching(report, 'mcp', 'beta'));
  assert.equal(definitions.length, 2);
  assert.notEqual(definitions[0].id, definitions[1].id);
  const samePathKeys = matching(report, 'config', 'model').concat(matching(report, 'config', 'private_setting'));
  assert.notEqual(samePathKeys[0].id, samePathKeys[1].id);
  const omitted = samePathKeys[1];
  assert.equal(omitted.valueStatus, 'omitted');
  assert.equal(omitted.comparison, 'unknown');
  assert.equal(matching(report, 'config', 'config.toml')[0].fingerprintScope, 'public-safe-projection');
  assert.equal(matching(report, 'config', 'config.toml')[0].comparison, 'partial');
  assert.equal(report.coverage.config, 'complete');
});

test('opt-in local source comparison exposes parsed config values without claiming runtime state', async t => {
  const f = await fixture(t), configPath = join(f.native.home, 'config.toml');
  await put(configPath, [
    'model = "safe-model"',
    'private_setting = false',
    'not_finite = nan',
    'source_date = 1979-05-27T07:32:00Z',
    '[custom.nested]',
    'credential_hint = "synthetic-local-marker"',
    '[memory]',
    'private_path = "synthetic-memory-marker"',
    '[features.experimental]',
    'enabled = true',
    '[mcp_servers.alpha]',
    'command = "synthetic-command"',
    'args = ["--synthetic", "synthetic-arg-marker"]',
    '[mcp_servers.alpha.env]',
    'TOKEN = "synthetic-env-marker"',
    '[hooks.PostToolUse]',
    'command = "synthetic-hook-command"',
    '[plugins.local]',
    'enabled = true',
    'local_option = "synthetic-plugin-marker"',
    '[tools.shell]',
    'enabled = true',
    'command = "synthetic-tool-command"',
  ].join('\n'));
  const standard = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const local = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const standardText = JSON.stringify(standard), localText = JSON.stringify(local);
  assert.equal(standardText.includes('synthetic-local-marker'), false);
  assert.equal(standardText.includes('synthetic-env-marker'), false);
  for (const marker of ['synthetic-local-marker', 'synthetic-memory-marker', 'synthetic-arg-marker', 'synthetic-env-marker',
    'synthetic-hook-command', 'synthetic-plugin-marker', 'synthetic-tool-command']) assert.ok(localText.includes(marker), marker);
  assert.equal(local.context.includeSourceValues, true);
  assert.equal(local.coverage.config, 'complete');
  assert.equal(local.coverage.sourceValues, 'complete');
  const config = matching(local, 'config', 'config.toml')[0];
  assert.equal(config.comparison, 'available');
  assert.equal(config.valueStatus, 'present');
  assert.equal(config.fingerprintScope, 'local-source-config');
  assert.equal(config.value.custom.nested.credential_hint, 'synthetic-local-marker');
  assert.deepEqual(config.value.not_finite, { __xfxTomlType: 'number', value: 'NaN' });
  assert.deepEqual(config.value.source_date, { __xfxTomlType: 'date', value: '1979-05-27T07:32:00.000Z' });
  assert.equal(matching(local, 'config', 'private_setting')[0].value, false);
  assert.equal(matching(local, 'memory-setting', 'memory.private_path')[0].value, 'synthetic-memory-marker');
  for (const [category, name] of [['mcp', 'alpha'], ['hook', 'PostToolUse'], ['plugin', 'local'], ['tool', 'shell']]) {
    const resource = matching(local, category, name)[0];
    assert.equal(resource.comparison, 'available');
    assert.equal(resource.valueStatus, 'present');
  }
  for (const [category, name] of [['mcp', 'mcp_servers'], ['hook', 'hooks'], ['plugin', 'plugins']]) {
    const resource = matching(local, category, name)[0];
    assert.equal(resource.comparison, 'available');
    assert.equal(resource.valueStatus, 'present');
    assert.ok(resource.value);
  }
  assert.equal(matching(local, 'mcp', 'alpha')[0].state.loaded, 'unknown');
  assert.equal(matching(local, 'mcp', 'alpha')[0].state.used, 'unknown');
});

test('opt-in local source values share the bounded source-value budget', async t => {
  const f = await fixture(t), repo = join(f.root, 'repo');
  const payload = 'x'.repeat(480_000);
  const roots = [repo];
  for (let index = 0; index < 10; index++) {
    roots.push(join(roots.at(-1), `nested-${index}`));
  }
  for (const root of roots) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await put(join(root, '.codex', 'config.toml'), `payload = "${payload}"\n`);
  }
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, repo: roots.at(-1), includeSourceValues: true });
  const configRows = matching(report, 'config', 'config.toml');
  assert.ok(configRows.some(row => row.valueStatus === 'omitted' && row.note?.includes('local source-value limit')),
    JSON.stringify(configRows.map(row => [row.scope, row.valueStatus, row.comparison, row.note])));
  assert.ok(configRows.some(row => row.valueStatus === 'present'));
  assert.equal(report.coverage.config, 'complete');
  assert.equal(report.coverage.sourceValues, 'partial');
  assert.ok(report.warnings.some(warning => warning.includes('Some locally parsed configuration values exceeded')));
});

test('skill preview saturation does not consume the later machine config source-value allowance', async t => {
  const f = await fixture(t), payload = 'safe visible package text\n'.repeat(2500);
  for (let index = 0; index < 90; index++) await put(join(f.native.home, 'skills', `preview-heavy-${index}`, 'SKILL.md'), payload);
  await put(join(f.user, '.codex', 'config.toml'), 'private_setting = "machine-user-value"\n');
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const machineConfig = matching(report, 'config', 'config.toml').find(row => row.origin === 'machine-user');
  assert.equal(machineConfig.value.private_setting, 'machine-user-value');
  assert.equal(machineConfig.valueStatus, 'present');
  assert.equal(report.coverage.sourceValues, 'complete');
  assert.ok(report.warnings.some(warning => warning.includes('aggregate text preview limit')));
});

test('local source fingerprints ignore TOML key and table ordering', async t => {
  const f = await fixture(t), configPath = join(f.native.home, 'config.toml');
  await put(configPath, ['first = 1', 'second = 2', '[custom]', 'alpha = "a"', 'beta = "b"', '[other]', 'one = 1', 'two = 2'].join('\n'));
  const first = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  await put(configPath, ['second = 2', 'first = 1', '[other]', 'two = 2', 'one = 1', '[custom]', 'beta = "b"', 'alpha = "a"'].join('\n'));
  const reordered = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const firstConfig = matching(first, 'config', 'config.toml')[0], reorderedConfig = matching(reordered, 'config', 'config.toml')[0];
  assert.equal(firstConfig.fingerprint, reorderedConfig.fingerprint);
  assert.deepEqual(JSON.parse(JSON.stringify(firstConfig.value)), JSON.parse(JSON.stringify(reorderedConfig.value)));
});

test('local integration and tool values that exceed the shared detail budget stay omitted and unknown', async t => {
  const f = await fixture(t), roots = [join(f.root, 'repo')], payload = 'x'.repeat(160_000);
  for (let index = 1; index <= 5; index++) roots.push(join(roots.at(-1), `nested-${index}`));
  const content = `[[mcp_servers]]\nname = "alpha"\nenabled = true\ncommand = "${payload}"\n\n[tools.shell]\nenabled = true\ncommand = "${payload}"\n`;
  for (const root of roots) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await put(join(root, '.codex', 'config.toml'), content);
  }
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, repo: roots.at(-1), includeSourceValues: true });
  for (const [category, name] of [['mcp', 'alpha'], ['tool', 'shell']]) {
    const resource = matching(report, category, name).find(item => item.comparison === 'unknown'
      && item.note?.includes('local source-value limit'));
    assert.ok(resource, `${category} ${name} has an explicit limit result: ${JSON.stringify(matching(report, category, name).map(item => [item.scope, item.comparison, item.valueStatus, item.note]))}`);
    assert.equal(resource.valueStatus, 'omitted');
    assert.equal(resource.value, undefined);
  }
});

test('returns readable safe setup values, memory settings, integration fields, and complete skill package details', async t => {
  const f = await fixture(t), configPath = join(f.native.home, 'config.toml');
  await put(configPath, [
    'model = "safe-model"',
    'api_key = "api-key-sentinel-value"',
    '[memory]',
    'enabled = true',
    'max_entries = 12',
    'retention = "session"',
    'private_path = "/Users/private/memory"',
    '[mcp_servers.alpha]',
    'command = "node"',
    'enabled = true',
    'args = ["--token", "mcp-secret-sentinel"]',
    '[tools.search]',
    'enabled = true',
  ].join('\n'));
  const skill = join(f.native.home, 'skills', 'example');
  await put(join(skill, 'SKILL.md'), 'Follow these steps.\napi_key = "skill-secret-sentinel"');
  await put(join(skill, 'scripts', 'run.sh'), '#!/bin/sh\necho safe');
  await put(join(f.native.home, 'AGENTS.md'), 'Use the preferred approach.\npassword = "instruction-secret-sentinel"');
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const config = matching(report, 'config', 'model')[0];
  assert.equal(config.value, 'safe-model');
  const memory = matching(report, 'memory-setting', 'memory.enabled')[0];
  assert.equal(memory.value, true);
  assert.equal(matching(report, 'memory-setting', 'memory.max_entries')[0].value, 12);
  assert.equal(matching(report, 'memory-setting', 'memory.private_path')[0].comparison, 'unknown');
  const mcp = matching(report, 'mcp', 'alpha')[0];
  assert.deepEqual(JSON.parse(JSON.stringify(mcp.value)), { command: 'node', enabled: true });
  assert.ok(mcp.note.includes('args'));
  assert.deepEqual(JSON.parse(JSON.stringify(matching(report, 'tool', 'search')[0].value)), { enabled: true });
  const instruction = matching(report, 'instruction', 'AGENTS.md')[0];
  assert.match(instruction.detail.text, /Use the preferred approach/);
  assert.doesNotMatch(instruction.detail.text, /instruction-secret-sentinel/);
  const skillResource = matching(report, 'skill', 'example')[0];
  assert.ok(skillResource.detail.files.some(file => file.path === 'scripts/run.sh' && file.content.includes('echo safe')));
  assert.ok(skillResource.detail.files.some(file => file.path === 'SKILL.md'));
  const serialized = JSON.stringify(report);
  for (const sentinel of ['api-key-sentinel-value', 'mcp-secret-sentinel', 'skill-secret-sentinel', 'instruction-secret-sentinel', '/Users/private/memory'])
    assert.equal(serialized.includes(sentinel), false);
  assert.equal(report.coverage.tools, 'unavailable');
  assert.equal(report.coverage.memorySettings, 'partial');
});

test('safe resource comparison shows changed skill resources while retaining incomplete coverage', () => {
  const left = { detail: { status: 'available', files: [
    { path: 'SKILL.md', status: 'available', content: 'Keep this unchanged.', fingerprint: 'a' },
    { path: 'scripts/run.sh', status: 'available', content: 'echo old', fingerprint: 'b' },
  ] } };
  const right = { detail: { status: 'available', files: [
    { path: 'SKILL.md', status: 'available', content: 'Keep this unchanged.', fingerprint: 'a' },
    { path: 'scripts/run.sh', status: 'available', content: 'echo new', fingerprint: 'c' },
  ] } };
  const diff = compareAuditResourceDetails(left, right);
  assert.equal(diff.status, 'available');
  assert.ok(diff.hunks.some(hunk => hunk.path === 'scripts/run.sh' && hunk.kind === 'changed'));
  assert.ok(!diff.hunks.some(hunk => hunk.path === 'SKILL.md'));
  const partial = compareAuditResourceDetails(
    { detail: { status: 'partial', files: [] } },
    { detail: { status: 'available', files: [{ path: 'scripts/run.sh', status: 'available', content: 'echo new' }] } });
  assert.equal(partial.status, 'partial');
  assert.ok(partial.hunks.some(hunk => hunk.kind === 'unknown'));
  const observedRedacted = compareAuditResourceDetails(
    { detail: { status: 'partial', files: [{ path: 'SKILL.md', status: 'partial', content: "console.log('LOCAL_SOURCE_0');\napi_key=[REDACTED]" }] } },
    { detail: { status: 'partial', files: [{ path: 'SKILL.md', status: 'partial', content: "console.log('LOCAL_SOURCE_1');\napi_key=[REDACTED]" }] } });
  assert.equal(observedRedacted.status, 'partial');
  assert.ok(observedRedacted.hunks.some(hunk => hunk.path === 'SKILL.md' && hunk.left.includes("console.log('LOCAL_SOURCE_0');")));
  const safeMcp = compareAuditResourceDetails(
    { comparison: 'partial', valueStatus: 'partial', value: { command: 'node', enabled: true } },
    { comparison: 'partial', valueStatus: 'partial', value: { command: 'node', enabled: false } });
  assert.equal(safeMcp.status, 'partial');
  assert.ok(safeMcp.hunks.some(hunk => hunk.path === 'value.enabled' && hunk.kind === 'changed'));
  assert.equal(comparableAuditResource({ status: 'present', path: '/private/path', value: 'safe' }).path, undefined);
});

test('skill package diffs include executable mode changes and accept the none reasoning enum', async t => {
  const f = await fixture(t), skill = join(f.native.home, 'skills', 'mode-sensitive');
  await put(join(skill, 'SKILL.md'), 'Use this skill.');
  const script = join(skill, 'scripts', 'run.sh');
  await put(script, '#!/bin/sh\necho safe'); await chmod(script, 0o644);
  const left = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  await chmod(script, 0o755);
  await put(join(f.native.home, 'config.toml'), 'model_reasoning_effort = "none"\nplan_mode_reasoning_effort = "none"\n');
  const right = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const leftSkill = matching(left, 'skill', 'mode-sensitive')[0], rightSkill = matching(right, 'skill', 'mode-sensitive')[0];
  const diff = compareAuditResourceDetails(leftSkill, rightSkill);
  assert.ok(diff.hunks.some(hunk => hunk.path === 'scripts/run.sh' && hunk.kind === 'metadata-changed'));
  assert.equal(matching(right, 'config', 'model_reasoning_effort')[0].value, 'none');
  assert.equal(matching(right, 'config', 'plan_mode_reasoning_effort')[0].value, 'none');
});

test('local package digests compare bytes beyond previews while public reports keep redacted bytes unknown', async t => {
  const f = await fixture(t), skill = join(f.native.home, 'skills', 'large-package');
  const payload = 'A'.repeat(600_000);
  await put(join(skill, 'SKILL.md'), payload);
  await put(join(skill, 'assets', 'image.bin'), Buffer.from([0, 255, 1, 254]));
  await put(join(f.native.home, 'README.md'), 'root artifact');
  const firstPublic = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const firstLocal = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  assert.equal(matching(firstPublic, 'skill', 'README.md').length, 0);
  assert.equal(matching(firstLocal, 'skill', 'README.md').length, 0);
  const a = matching(firstLocal, 'skill', 'large-package')[0];
  assert.equal(a.detail.coverage.comparison, 'complete', JSON.stringify(a.detail.coverage));
  assert.equal(a.detail.coverage.content, 'partial');
  assert.equal(a.detail.files.find(file => file.path === 'SKILL.md').bytes, payload.length);
  assert.equal(a.detail.files.find(file => file.path === 'assets/image.bin').digest.length, 64);
  assert.equal(JSON.stringify(firstPublic).includes('"digest"'), false);
  assert.equal(matching(firstPublic, 'skill', 'large-package')[0].detail.files.find(file => file.path === 'SKILL.md').comparison, 'unknown');

  const before = matching(firstLocal, 'skill', 'large-package')[0];
  const publicBefore = matching(firstPublic, 'skill', 'large-package')[0];
  assert.equal(compareAuditResourceDetails(before, before).hunks.length, 0);
  const differentPreview = structuredClone(before);
  differentPreview.detail.status = 'partial';
  differentPreview.detail.files[0].content = 'a different bounded preview';
  differentPreview.detail.files[0].status = 'partial';
  differentPreview.detail.files[0].contentReason = 'report-detail-budget-exceeded';
  differentPreview.detail.files[0].truncated = true;
  differentPreview.detail.coverage.content = 'partial';
  assert.deepEqual(comparableAuditResource(before), comparableAuditResource(differentPreview));
  const previewOnlyDiff = compareAuditResourceDetails(before, differentPreview);
  assert.equal(previewOnlyDiff.status, 'available');
  assert.equal(previewOnlyDiff.hunks.length, 0);
  await put(join(skill, 'SKILL.md'), `${payload.slice(0, -1)}B`);
  await put(join(skill, 'assets', 'image.bin'), Buffer.from([0, 255, 1, 253]));
  const secondLocal = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const secondPublic = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const after = matching(secondLocal, 'skill', 'large-package')[0];
  const diff = compareAuditResourceDetails(before, after);
  assert.equal(diff.comparisonCoverage, 'complete');
  assert.ok(diff.hunks.some(hunk => hunk.path === 'SKILL.md' && hunk.kind === 'content-changed'));
  assert.ok(diff.hunks.some(hunk => hunk.path === 'assets/image.bin' && hunk.kind === 'content-changed'));
  const publicDiff = compareAuditResourceDetails(publicBefore, matching(secondPublic, 'skill', 'large-package')[0]);
  assert.equal(publicDiff.comparisonCoverage, 'partial');
  assert.notEqual(publicDiff.status, 'available');
});

test('public fully visible safe skill text remains comparable without local source digests', async t => {
  const f = await fixture(t), skill = join(f.native.home, 'skills', 'public-safe');
  await put(join(skill, 'SKILL.md'), 'Visible safe instructions.\n'.repeat(3000));
  const left = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const same = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const leftSkill = matching(left, 'skill', 'public-safe')[0], sameSkill = matching(same, 'skill', 'public-safe')[0];
  assert.equal(leftSkill.detail.coverage.comparison, 'complete');
  assert.equal(leftSkill.detail.files[0].comparisonBasis, 'public-safe-text');
  assert.equal(leftSkill.detail.files[0].digest, undefined);
  assert.equal(leftSkill.detail.coverage.content, 'partial');
  const differentPreview = structuredClone(sameSkill);
  differentPreview.detail.files[0].content = 'another preview';
  differentPreview.detail.files[0].status = 'partial';
  differentPreview.detail.files[0].truncated = true;
  differentPreview.detail.coverage.content = 'partial';
  assert.deepEqual(comparableAuditResource(leftSkill), comparableAuditResource(differentPreview));
  const comparison = compareAuditResourceDetails(leftSkill, differentPreview);
  assert.equal(comparison.status, 'available');
  assert.equal(comparison.hunks.length, 0);
  assert.equal(comparison.comparisonCoverage, 'complete');
});

test('package comparison marks unsafe files and omitted source budgets unknown without faking root skills', async t => {
  const f = await fixture(t), skill = join(f.native.home, 'skills', 'unsafe-package');
  await put(join(skill, 'SKILL.md'), 'A real skill');
  const unsafe = join(skill, 'assets', 'writable.dat');
  await put(unsafe, 'unsafe mode'); await chmod(unsafe, 0o666);
  await put(join(f.native.home, 'plugin.json'), '{"name":"artifact"}');
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const resource = matching(report, 'skill', 'unsafe-package')[0];
  const file = resource.detail.files.find(item => item.path === 'assets/writable.dat');
  assert.equal(file.comparison, 'unknown');
  assert.equal(file.comparisonReason, 'unsafe');
  assert.equal(resource.detail.coverage.comparison, 'partial');
  assert.equal(matching(report, 'skill', 'plugin.json').length, 0);
});

test('local package manifests preserve long relative paths without false deduplication', async t => {
  const f = await fixture(t), skill = join(f.native.home, 'skills', 'long-paths');
  await put(join(skill, 'SKILL.md'), 'Long path skill');
  const levelOne = `dir-${'a'.repeat(90)}`, levelTwo = `nested-${'b'.repeat(90)}`;
  const prefix = 'shared-prefix-'.repeat(4);
  const leftPath = join(skill, levelOne, levelTwo, `${prefix}left.txt`);
  const rightPath = join(skill, levelOne, levelTwo, `${prefix}right.txt`);
  await put(leftPath, 'left content'); await put(rightPath, 'right content');
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const resource = matching(report, 'skill', 'long-paths')[0];
  const paths = resource.detail.files.map(file => file.path);
  assert.ok(paths.includes(`${levelOne}/${levelTwo}/${prefix}left.txt`));
  assert.ok(paths.includes(`${levelOne}/${levelTwo}/${prefix}right.txt`));
  assert.equal(resource.detail.coverage.comparison, 'complete');
  assert.equal(typeof resource.detail.fingerprint, 'string');
  const publicReport = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const publicResource = matching(publicReport, 'skill', 'long-paths')[0];
  assert.equal(publicResource.detail.coverage.comparison, 'partial');
  assert.equal(new Set(publicResource.detail.files.map(file => file.path)).size, publicResource.detail.files.length);
});

test('local package traversal safely exceeds preview-era tree limits and marks capped trees unknown', async t => {
  const f = await fixture(t), siteSkill = join(f.native.home, 'skills', 'sites-large');
  await put(join(siteSkill, 'SKILL.md'), 'Large site bundle');
  let deep = join(siteSkill, 'assets');
  for (let depth = 0; depth < 8; depth++) deep = join(deep, `level-${depth}`);
  for (let index = 0; index < 132; index++) await put(join(deep, `file-${index}.txt`), `content ${index}`);
  const largeReport = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const large = matching(largeReport, 'skill', 'sites-large')[0];
  assert.equal(large.detail.coverage.comparison, 'complete');
  assert.equal(large.detail.files.length, 133);
  assert.equal(typeof large.detail.fingerprint, 'string');

  const cappedSkill = join(f.native.home, 'skills', 'capped-tree');
  await put(join(cappedSkill, 'SKILL.md'), 'Capped tree skill');
  const assets = join(cappedSkill, 'assets'); await mkdir(assets, { mode: 0o700 });
  for (let index = 0; index < 4095; index++) await mkdir(join(assets, `a-${String(index).padStart(4, '0')}`), { mode: 0o700 });
  const cappedChild = join(assets, 'y-directory'); await mkdir(cappedChild, { mode: 0o700 });
  await put(join(cappedChild, 'hidden.txt'), 'not fully scanned');
  await put(join(assets, 'z-extra.txt'), 'omitted by per-directory cap');
  const cappedReport = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const capped = matching(cappedReport, 'skill', 'capped-tree')[0];
  assert.equal(capped.detail.coverage.comparison, 'partial');
  assert.ok(capped.detail.coverage.reasons.includes('directory-entry-limit'));
  assert.ok(capped.detail.coverage.reasons.includes('entry-limit'));
  assert.equal(capped.detail.fingerprint, undefined);
  assert.equal(compareAuditResourceDetails(capped, capped).status, 'unknown');
});

test('nested unreadable package directories cannot produce a complete manifest', async t => {
  const f = await fixture(t), skill = join(f.native.home, 'skills', 'unreadable-tree');
  await put(join(skill, 'SKILL.md'), 'Unreadable nested tree');
  const blocked = join(skill, 'assets', 'blocked'); await mkdir(blocked, { recursive: true, mode: 0o700 });
  await chmod(blocked, 0o666);
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, includeSourceValues: true });
  const resource = matching(report, 'skill', 'unreadable-tree')[0];
  assert.equal(resource.detail.coverage.comparison, 'partial');
  assert.ok(resource.detail.coverage.reasons.some(reason => reason === 'directory-unsafe'));
  assert.equal(resource.detail.fingerprint, undefined);
  assert.equal(compareAuditResourceDetails(resource, resource).status, 'unknown');
});

test('malformed structured skill files never expose public raw-content fingerprints', async t => {
  const f = await fixture(t), skill = join(f.native.home, 'skills', 'malformed-structured');
  await put(join(skill, 'SKILL.md'), 'Safe instructions');
  await put(join(skill, 'assets', 'broken.json'), '{"api_key":"sk-abcdefghijklmnopqrst"');
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const resource = matching(report, 'skill', 'malformed-structured')[0];
  const file = resource.detail.files.find(item => item.path === 'assets/broken.json');
  assert.equal(file.comparison, 'unknown');
  assert.equal(file.fingerprint, undefined);
  assert.equal(file.content, undefined);
  assert.equal(JSON.stringify(report).includes('sk-abcdefghijklmnopqrst'), false);
});

test('absence requires a complete inventory of the matching logical source', async t => {
  const f = await fixture(t), configPath = join(f.native.home, 'config.toml');
  await put(configPath, '[memory]\nenabled = true\n');
  const left = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const resource = matching(left, 'memory-setting', 'memory.enabled')[0];
  await put(configPath, 'model = "safe-model"\n');
  const right = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  assert.equal(auditResourceAbsent(resource, right), true);
  const partial = { ...right, inventory: right.inventory.map(item => item.key === resource.inventoryKey ? { ...item, status: 'partial' } : item) };
  assert.equal(auditResourceAbsent(resource, partial), false);
  const unrelated = { ...right, inventory: right.inventory.filter(item => item.key !== resource.inventoryKey) };
  assert.equal(auditResourceAbsent(resource, unrelated), false);
});

test('caps per-resource and aggregate readable setup content', async t => {
  const f = await fixture(t), large = 'safe-content-line\n'.repeat(4000);
  const root = join(f.native.home, 'skills');
  for (let index = 0; index < 100; index++) await put(join(root, `large-${index}`, 'SKILL.md'), large);
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const detailed = matching(report, 'skill', 'large-0')[0];
  assert.equal(detailed.detail.status, 'partial');
  assert.ok(detailed.detail.files.find(file => file.path === 'SKILL.md').content.length <= 48 * 1024);
  const contentBytes = report.resources.reduce((total, resource) => {
    const texts = [resource.detail?.text, ...(resource.detail?.files ?? []).map(file => file.content)];
    return total + texts.filter(text => typeof text === 'string').reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  }, 0);
  assert.ok(contentBytes <= 4 * 1024 * 1024);
  assert.equal(report.coverage.skills, 'partial');
});

test('follows bounded symlinked skill aliases and gives aliases a canonical identity', async t => {
  const f = await fixture(t), external = join(f.native.root, 'external-skill');
  await put(join(external, 'SKILL.md'), 'Read the linked skill safely.');
  const aliases = join(f.native.home, 'skills'); await mkdir(aliases, { recursive: true, mode: 0o700 });
  await symlink(external, join(aliases, 'alias-a')); await symlink(external, join(aliases, 'alias-b'));
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  const found = ['alias-a', 'alias-b'].map(name => matching(report, 'skill', name)[0]);
  assert.ok(found.every(item => item.status === 'present' && item.canonicalPath === external));
  assert.equal(found[0].id, found[1].id);
  assert.equal(JSON.stringify(report).includes('Read the linked skill safely.'), true);
});

test('reports missing and unsafe roots and malformed configuration without writes', async t => {
  const f = await fixture(t), before = await readFile(join(f.native.home, 'config.toml'));
  await put(join(f.native.home, 'config.toml'), 'model = [');
  const malformed = await readFile(join(f.native.home, 'config.toml'));
  const external = join(f.root, 'outside'); await mkdir(external, { mode: 0o700 });
  await mkdir(join(f.native.home, 'skills'), { mode: 0o700 });
  await symlink(external, join(f.native.home, 'skills', 'unsafe-link'));
  const report = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user, repo: join(f.root, 'missing') }).catch(error => error);
  assert.match(report.message, /missing or unsafe/);
  const partial = await discoverAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  assert.equal(partial.coverage.config, 'partial');
  assert.equal(matching(partial, 'skill', 'unsafe-link')[0].status, 'unsafe');
  assert.ok(matching(partial, 'instruction', 'AGENTS.md').some(item => item.status === 'missing'));
  assert.notDeepEqual(malformed, before);
  assert.deepEqual(await readFile(join(f.native.home, 'config.toml')), malformed);
});

test('resolves an existing native audit home when the profile user-home has been removed', async t => {
  const f = await fixture(t);
  await rm(f.native.userHome, { recursive: true, force: true });
  const profile = await resolveAuditProfile(f.store, 'Profile', { defaultUserHome: f.user });
  assert.equal(profile.home, f.native.home);
  assert.equal(profile.userHome, f.native.userHome);
});
