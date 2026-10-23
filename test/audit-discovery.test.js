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
