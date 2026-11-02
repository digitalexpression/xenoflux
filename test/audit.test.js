import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { compareAuditProfiles, sameCompleteLocalSkillPackage } from '../src/audit.js';
import { exportAuditReport, readAuditReport, projectReportResourceProvenance } from '../src/audit-store.js';
import { renderAudit } from '../src/audit-report.js';

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-integration-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex'); await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  const native = [];
  for (const name of ['A', 'B']) {
    const home = await prepareNativeHome({ directory: join(root, name), executable, codexVersion: '0.153.4' });
    await registerHome(store, name, home.root, { executable, version: '0.153.4' }); native.push(home);
  }
  return { root, store, native, options: { defaultUserHome: root, adminRoots: [] } };
}
async function nestedSkillFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-shared-skill-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex'); await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  const first = await prepareNativeHome({ directory: join(root, 'A'), executable, codexVersion: '0.153.4' });
  const second = await prepareNativeHome({ directory: join(first.userHome, 'nested-B'), executable, codexVersion: '0.153.4' });
  await registerHome(store, 'A', first.root, { executable, version: '0.153.4' });
  await registerHome(store, 'B', second.root, { executable, version: '0.153.4' });
  return { root, store, native: [first, second], options: { defaultUserHome: root, adminRoots: [] } };
}

test('setup comparison retains private-value uncertainty and proves skill absence only from complete inventory', async t => {
  const f = await fixture(t);
  await put(join(f.native[0].home, 'config.toml'), 'model="model-a"\ncredential_blob="PRIVATE_A"\n');
  await put(join(f.native[1].home, 'config.toml'), 'model="model-b"\ncredential_blob="PRIVATE_B"\n');
  await put(join(f.native[0].home, 'skills', 'solo', 'SKILL.md'), '---\nname: solo\ndescription: one side\n---\n');
  const value = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  assert.ok(value.comparison.resources.changed.some(row => row.name === 'model' && row.left.value === 'model-a' && row.right.value === 'model-b'));
  assert.ok(value.comparison.resources.unavailable.some(row => row.name === 'credential_blob' && row.comparison === 'unknown'));
  assert.ok(value.comparison.resources.removed.some(row => row.name === 'solo'));
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_A|PRIVATE_B/);
  const rendered = renderAudit(value);
  assert.match(rendered, /model-a/); assert.match(rendered, /model-b/);
  await rm(join(f.native[1].home, 'skills'), { recursive: true, force: true });
  await symlink(join(f.native[0].home, 'skills'), join(f.native[1].home, 'skills'));
  const partial = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  assert.ok(partial.comparison.resources.unavailable.some(row => row.name === 'solo' && row.comparison === 'unverified-on-right'));
  assert.equal(partial.comparison.resources.removed.some(row => row.name === 'solo'), false);
});

test('comparison does not collapse same-name project resources in distinct ancestor roots', async t => {
  const f = await fixture(t), repo = join(f.root, 'project'), nested = join(repo, 'nested');
  await mkdir(nested, { recursive: true, mode: 0o700 });
  for (const root of [repo, nested]) await put(join(root, '.agents', 'skills', 'same', 'SKILL.md'), '---\nname: same\ndescription: scoped\n---\n');
  const value = await compareAuditProfiles(f.store, 'A', 'B', { ...f.options, repo: nested });
  const records = Object.values(value.comparison.resources).flat().filter(row => row.category === 'skill' && row.scope === 'project' && row.name === 'same');
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map(row => row.path)).size, 2);
});

test('matches Default profile configuration to the same physical machine-user source', async t => {
  const f = await fixture(t), sharedConfig = join(f.root, '.codex', 'config.toml');
  await put(sharedConfig, '[mcp_servers.shared]\ncommand = "safe"\n');
  const value = await compareAuditProfiles(f.store, 'Default', 'A', f.options);
  const rows = Object.values(value.comparison.resources).flat().filter(row => row.category === 'mcp' && row.name === 'shared');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].left && rows[0].right);
  assert.equal(rows[0].left.sourceRole, 'profile-home');
  assert.equal(rows[0].right.sourceRole, 'machine-user');
  assert.doesNotMatch(rows[0].reason ?? '', /discovery source has no corroborating record/);
});

test('local setup values stay in local comparisons while ordinary setup exports keep their projection', async t => {
  const f = await fixture(t);
  await put(join(f.native[0].home, 'config.toml'), 'local_value = "LOCAL_DISPLAY_ONLY_FIXTURE"\n');
  await put(join(f.native[1].home, 'config.toml'), 'local_value = "OTHER_LOCAL_DISPLAY_ONLY_FIXTURE"\n');
  const local = await compareAuditProfiles(f.store, 'A', 'B', { ...f.options, includeSourceValues: true });
  assert.ok(local.comparison.resources.changed.some(row => row.name === 'local_value'));
  for (const [index, value] of [local, local.left].entries()) for (const includeContent of [false, true]) {
    const output = join(f.root, `local-${index}-${includeContent}.json`);
    await assert.rejects(exportAuditReport(value, { output, includeContent }), /sanitized setup snapshot/);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  const ordinary = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  const output = join(f.root, 'ordinary.json');
  await exportAuditReport(ordinary, { output });
  assert.doesNotMatch(await readFile(output, 'utf8'), /LOCAL_DISPLAY_ONLY_FIXTURE/);
});

test('exact profile-source matches take priority over machine-user physical aliases in either direction', async t => {
  const f = await fixture(t), defaultConfig = join(f.root, '.codex', 'config.toml');
  const contents = '[mcp_servers.shared]\ncommand = "safe"\n';
  await put(defaultConfig, contents);
  await put(join(f.native[0].home, 'config.toml'), contents);
  for (const [left, right] of [['Default', 'A'], ['A', 'Default']]) {
    const value = await compareAuditProfiles(f.store, left, right, f.options);
    const rows = Object.values(value.comparison.resources).flat().filter(row => row.category === 'mcp' && row.name === 'shared');
    assert.equal(rows.length, 2, `${left} → ${right} must retain one own-profile pair and one machine-user observation`);
    const ownProfile = rows.find(row => row.left?.scope === 'profile' && row.right?.scope === 'profile');
    assert.ok(ownProfile, `${left} → ${right} should pair the exact profile sources`);
    const machine = rows.find(row => row.sourceRole === 'machine-user');
    assert.match(machine.reason, /same physical source was read under/);
    assert.ok(machine.corroboratingSource?.path);
    assert.ok(machine, `${left} → ${right} should retain the unpaired machine-user source`);
    assert.equal(machine.left === ownProfile.left || machine.right === ownProfile.right, false,
      `${left} → ${right} must not reuse a resource already consumed by an exact match`);
  }
});

test('local shared non-skill sources retain exact profile pairs and independently comparable machine evidence', async t => {
  const f = await fixture(t), config = join(f.root, '.codex', 'config.toml');
  await put(config, 'model="shared-model"\n[features]\nmulti_agent=true\n[mcp_servers.reader]\ncommand="reader"\n[plugins.reader]\nenabled=true\n');
  await put(join(f.native[0].home, 'config.toml'), 'model="different-model"\n[features]\nmulti_agent=false\n[mcp_servers.reader]\ncommand="other"\n[plugins.reader]\nenabled=false\n');
  await put(join(f.root, '.codex', 'AGENTS.md'), 'Full shared instructions.\n');
  for (const [a, b] of [['Default', 'A'], ['A', 'Default']]) {
    const value = await compareAuditProfiles(f.store, a, b, { ...f.options, includeSourceValues: true });
    const rows = Object.values(value.comparison.resources).flat();
    for (const [category, name] of [['config', 'model'], ['feature', 'multi_agent'], ['mcp', 'reader'], ['plugin', 'reader'], ['instruction', 'AGENTS.md'], ['instruction', 'AGENTS.override.md']]) {
      const shared = rows.find(row => row.category === category && row.name === name && row.sourceRelationship === 'shared-physical-source');
      assert.ok(shared, `${a}/${b}: ${category}/${name}`);
      assert.ok(value.comparison.resources.unchanged.includes(shared));
      assert.equal(shared.left.path, shared.right.path);
      assert.deepEqual(new Set([shared.left.sourceRole, shared.right.sourceRole]), new Set(['profile-home', 'machine-user']));
    }
    const own = value.comparison.resources.changed.find(row => row.name === 'model' && row.left?.scope === 'profile' && row.right?.scope === 'profile');
    assert.ok(own, 'own-profile differences must not be replaced by shared-source equality');
    assert.equal(value.comparison.resources.unavailable.length, 0);
  }
});

test('combined Default user root compares present and missing files without duplicate source reads or identities', async t => {
  const f = await fixture(t);
  await put(join(f.root, '.codex', 'config.toml'), 'model="default-model"\n');
  await put(join(f.root, '.codex', 'AGENTS.md'), 'Default instruction.\n');
  for (const [a, b] of [['Default', 'A'], ['A', 'Default']]) {
    const value = await compareAuditProfiles(f.store, a, b, { ...f.options, includeSourceValues: true });
    const rows = Object.values(value.comparison.resources).flat();
    const aliases = rows.filter(row => row.sourceRelationship === 'shared-profile-user-root');
    assert.deepEqual(aliases.map(row => row.name).sort(), ['AGENTS.md', 'AGENTS.override.md', 'config.toml']);
    const changedBucket = a === 'Default' ? value.comparison.resources.removed : value.comparison.resources.added;
    for (const name of ['config.toml', 'AGENTS.md']) {
      const alias = aliases.find(row => row.name === name);
      assert.ok(changedBucket.includes(alias));
      assert.equal(alias.scope, 'user');
      assert.equal(alias.sourceRole, 'profile-user');
      assert.ok(alias.left && alias.right);
    }
    assert.ok(value.comparison.resources.unchanged.includes(aliases.find(row => row.name === 'AGENTS.override.md')));
    const snapshot = a === 'Default' ? value.left : value.right;
    assert.equal(snapshot.resources.some(row => row.sourceRole === 'profile-user'), false);
    assert.ok(snapshot.inventory.some(row => row.sourceRole === 'profile-user' && row.aliasOf));
    const presented = (await import('../src/audit-presentation.js')).presentSetupComparison(value);
    const items = presented.groups.flatMap(group => group.items);
    assert.equal(new Set(items.map(item => item.id)).size, items.length, 'logical aliases retain unique UI identities');
    const aliasItems = items.filter(item => item.detail.facts.some(fact => fact.label === 'Shared profile and user directory'));
    assert.equal(aliasItems.length, 3);
    assert.ok(aliasItems.every(item => item.detail.sources.length === 2), 'both present and missing source locations remain visible');
    assert.ok(aliasItems.every(item => !item.actions.copyable), 'alias evidence does not offer a duplicate copy with the wrong source scope');
    for (const name of ['config.toml', 'AGENTS.md']) {
      const sourceStatuses = aliasItems.find(item => item.name === name).detail.sources.map(source => source.status);
      assert.ok(sourceStatuses.includes('missing'));
      assert.ok(sourceStatuses.includes('Present'));
    }
  }
});

test('shared unreadable and undisclosed non-skill sources remain unknown despite matching physical paths', async t => {
  const f = await fixture(t);
  const config = 'private_setting="undisclosed"\n';
  await put(join(f.root, '.codex', 'config.toml'), config);
  await put(join(f.native[0].home, 'config.toml'), config);
  // Oversized instructions cannot be fully read by source discovery.
  await put(join(f.root, '.codex', 'AGENTS.md'), 'x'.repeat(2 * 1024 * 1024));
  for (const [a, b] of [['Default', 'A'], ['A', 'Default']]) {
    const local = await compareAuditProfiles(f.store, a, b, { ...f.options, includeSourceValues: true });
    const unreadable = local.comparison.resources.unavailable.find(row => row.name === 'AGENTS.md' && row.sourceRelationship === 'shared-physical-source');
    assert.ok(unreadable);
    assert.match(unreadable.reason, /incomplete source comparison/);
    const publicValue = await compareAuditProfiles(f.store, a, b, f.options);
    assert.ok(publicValue.comparison.resources.unavailable.some(row => row.name === 'private_setting'));
    assert.doesNotMatch(JSON.stringify(publicValue), /"undisclosed"/);
  }
});

test('source-value budget differences cannot turn identical local source files into Different', async t => {
  const f = await fixture(t), project = join(f.root, 'project'), nested = join(project, 'nested');
  const content = `[features]\npadding="${'x'.repeat(510000)}"\n`;
  await put(join(f.native[0].home, 'config.toml'), content);
  for (const root of [project, nested]) await put(join(root, '.codex', 'config.toml'), content);
  const value = await compareAuditProfiles(f.store, 'A', 'B', { ...f.options, includeSourceValues: true, repo: nested });
  const path = join(nested, '.codex', 'config.toml');
  for (const name of ['config.toml', 'features', 'features.padding']) {
    const row = value.comparison.resources.unavailable.find(row => row.path === path && row.name === name);
    assert.ok(row, `${name}: unequal detail budgets must remain unknown`);
    assert.equal(row.left.valueStatus, 'omitted');
    assert.equal(row.right.valueStatus, 'present');
    assert.match(row.reason, /incomplete.*do not establish a difference/);
  }
  assert.equal(value.comparison.resources.changed.some(row => row.path === path), false);
});

test('matches shared Codex skill and agent-skill roots by unique physical source in both directions', async t => {
  const f = await fixture(t);
  const codexSkill = join(f.root, '.codex', 'skills', 'shared', 'SKILL.md');
  const agentSkill = join(f.root, '.agents', 'skills', 'shared', 'SKILL.md');
  const contents = '---\nname: shared\ndescription: shared fixture\n---\nRead the local guide.\n';
  await put(codexSkill, contents);
  await put(agentSkill, contents);
  for (const [left, right] of [['Default', 'A'], ['A', 'Default']]) {
    const value = await compareAuditProfiles(f.store, left, right, f.options);
    const rows = Object.values(value.comparison.resources).flat().filter(row => row.category === 'skill' && row.name === 'shared');
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.left && row.right));
    assert.deepEqual(new Set(rows.map(row => row.left.path)), new Set([codexSkill.replace('/SKILL.md', ''), agentSkill.replace('/SKILL.md', '')]));
    assert.ok(rows.every(row => row.left.path === row.right.path));
  }
});

async function pluginSkill(f, profileIndex, pluginId, version, skillName, body) {
  const root = join(f.native[profileIndex].home, 'plugins', 'cache', pluginId, version);
  await put(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ id: pluginId, name: pluginId, version }));
  if (skillName) await put(join(root, 'skills', skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: fixture\n---\n${body}\n`);
}

test('pairs unique plugin skills across cache versions and keeps changed package details visible', async t => {
  const f = await fixture(t);
  await pluginSkill(f, 0, 'vendor/plugin', '1.0.0', 'helper', 'old package');
  await pluginSkill(f, 1, 'vendor/plugin', '2.0.0', 'helper', 'new package');
  for (const [left, right] of [['A', 'B'], ['B', 'A']]) {
    const value = await compareAuditProfiles(f.store, left, right, f.options);
    const rows = Object.values(value.comparison.resources).flat().filter(row => row.category === 'skill' && row.name === 'helper');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].left && rows[0].right);
    assert.equal(value.comparison.resources.changed.some(row => row.name === 'helper'), true);
  }
});

test('plugin skill matching uses full directory identity rather than truncated display names', async t => {
  const f = await fixture(t), prefix = 'x'.repeat(200), names = [`${prefix}a`, `${prefix}b`];
  for (const [index, name] of names.entries()) {
    await pluginSkill(f, index, 'vendor/plugin', `${index + 1}.0.0`, name, 'same package');
    await put(join(f.native[index].home, 'plugins', 'cache', 'vendor/plugin', `${index + 1}.0.0`, 'skills', name, 'SKILL.md'), 'Identical source bytes.\n');
  }
  for (const includeSourceValues of [false, true]) {
    const value = await compareAuditProfiles(f.store, 'A', 'B', { ...f.options, includeSourceValues });
    const rows = Object.values(value.comparison.resources).flat().filter(row => row.category === 'skill' && row.scope === 'plugin');
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => !row.left || !row.right), 'different full names must not become one pair');
    assert.equal(value.comparison.resources.unchanged.some(row => row.category === 'skill' && row.scope === 'plugin'), false);
  }
});

test('does not logically pair ambiguous same-name plugin skills or skills from different plugins', async t => {
  const f = await fixture(t);
  await pluginSkill(f, 0, 'vendor/plugin', '1.0.0', 'helper', 'first');
  await pluginSkill(f, 0, 'vendor/plugin', '2.0.0', 'helper', 'second');
  await pluginSkill(f, 1, 'vendor/plugin', '3.0.0', 'helper', 'other');
  await pluginSkill(f, 0, 'other/plugin', '1.0.0', 'distinct', 'left');
  await pluginSkill(f, 1, 'different/plugin', '1.0.0', 'distinct', 'right');
  const value = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  const helper = Object.values(value.comparison.resources).flat().filter(row => row.category === 'skill' && row.name === 'helper');
  assert.equal(helper.length, 3);
  assert.ok(helper.every(row => !row.left || !row.right));
  assert.ok(helper.every(row => !/no corroborating record/.test(row.reason ?? '')));
  assert.ok(helper.every(row => /multiple cached source versions/i.test(row.reason ?? '')));
  const distinct = Object.values(value.comparison.resources).flat().filter(row => row.category === 'skill' && row.name === 'distinct');
  assert.equal(distinct.length, 2);
  assert.ok(distinct.every(row => !row.left || !row.right));
});

test('proves plugin skill absence only from complete inventories for every cached version', async t => {
  const f = await fixture(t);
  await pluginSkill(f, 0, 'vendor/plugin', '1.0.0', 'helper', 'present');
  await pluginSkill(f, 1, 'vendor/plugin', '2.0.0', null, '');
  const complete = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  assert.ok(complete.comparison.resources.removed.some(row => row.category === 'skill' && row.name === 'helper'));

  await pluginSkill(f, 1, 'vendor/plugin', '3.0.0', null, '');
  const externalSkills = join(f.root, 'external-skills');
  await mkdir(externalSkills, { recursive: true, mode: 0o700 });
  await symlink(externalSkills, join(f.native[1].home, 'plugins', 'cache', 'vendor', 'plugin', '3.0.0', 'skills'));
  const partial = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  assert.equal(partial.comparison.resources.removed.some(row => row.category === 'skill' && row.name === 'helper'), false);
  assert.ok(partial.comparison.resources.unavailable.some(row => row.category === 'skill' && row.name === 'helper'));
});

test('proves cached plugin skill absence only when the parent plugin cache scan is complete', async t => {
  const f = await fixture(t);
  await pluginSkill(f, 0, 'vendor/plugin', '1.0.0', 'helper', 'present');
  const absent = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  assert.ok(absent.comparison.resources.removed.some(row => row.category === 'skill' && row.name === 'helper'));

  const otherPlugin = join(f.native[1].home, 'plugins', 'cache', 'other');
  await mkdir(otherPlugin, { recursive: true, mode: 0o700 });
  await symlink(otherPlugin, join(f.native[1].home, 'plugins', 'cache', 'partial-entry'));
  const partial = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  assert.equal(partial.comparison.resources.removed.some(row => row.category === 'skill' && row.name === 'helper'), false);
  assert.ok(partial.comparison.resources.unavailable.some(row => row.category === 'skill' && row.name === 'helper'));
});

test('keeps shared physical skill provenance as separate Same corroboration rows only with complete matching local packages', async t => {
  const f = await nestedSkillFixture(t);
  const shared = join(f.native[1].home, 'skills', 'shared');
  await put(join(shared, 'SKILL.md'), '---\nname: shared\ndescription: shared fixture\n---\nComplete local package.\n');
  await mkdir(join(f.native[0].home, 'skills'), { recursive: true, mode: 0o700 });
  await mkdir(join(f.native[0].userHome, '.agents', 'skills'), { recursive: true, mode: 0o700 });
  await symlink(shared, join(f.native[0].home, 'skills', 'shared'));
  await symlink(shared, join(f.native[0].userHome, '.agents', 'skills', 'shared'));
  for (const [left, right] of [['A', 'B'], ['B', 'A']]) {
    const value = await compareAuditProfiles(f.store, left, right, { ...f.options, includeSourceValues: true });
    const rows = Object.values(value.comparison.resources).flat().filter(row => row.category === 'skill' && row.name === 'shared');
    assert.equal(rows.length, 2);
    const own = rows.find(row => row.left?.scope === 'profile' && row.right?.scope === 'profile');
    assert.ok(own, 'exact profile comparison remains intact');
    const alias = rows.find(row => row.sourceRelationship === 'shared-physical-source');
    assert.ok(alias && alias.left && alias.right);
    assert.equal(alias.sourceRelationship, 'shared-physical-source');
    assert.equal(value.comparison.resources.unchanged.includes(alias), true);
  }
});

test('keeps shared physical skills unavailable when complete digests differ or comparison coverage is partial', async t => {
  const f = await nestedSkillFixture(t);
  const shared = join(f.native[1].home, 'skills', 'shared');
  await put(join(shared, 'SKILL.md'), '---\nname: shared\ndescription: shared fixture\n---\nComplete package A.\n');
  await mkdir(join(f.native[0].home, 'skills'), { recursive: true, mode: 0o700 });
  await mkdir(join(f.native[0].userHome, '.agents', 'skills'), { recursive: true, mode: 0o700 });
  await symlink(shared, join(f.native[0].home, 'skills', 'shared'));
  await symlink(shared, join(f.native[0].userHome, '.agents', 'skills', 'shared'));
  await symlink(join(f.root, 'outside-package'), join(shared, 'unsafe-link'));
  const value = await compareAuditProfiles(f.store, 'A', 'B', { ...f.options, includeSourceValues: true });
  const alias = Object.values(value.comparison.resources).flat().find(row => row.category === 'skill' && row.name === 'shared'
    && row.sourceRelationship === 'shared-physical-source');
  assert.ok(alias && value.comparison.resources.unavailable.includes(alias));
  assert.match(alias.reason, /incomplete local package/);
  const complete = (fingerprint, comparison = 'complete') => ({ category: 'skill', fingerprintScope: 'local-skill-package', fingerprint,
    detail: { coverage: { comparison } } });
  assert.equal(sameCompleteLocalSkillPackage(complete('digest-a'), complete('digest-b'), true), false);
  assert.equal(sameCompleteLocalSkillPackage(complete('digest-a', 'partial'), complete('digest-a'), true), false);
});

test('incomplete skill comparisons stay not comparable unless their detail diff proves a difference', async t => {
  const f = await fixture(t);
  await put(join(f.native[0].home, 'skills', 'large', 'SKILL.md'), `---\nname: large\ndescription: fixture\n---\n${'x'.repeat(530_000)}\n`);
  await put(join(f.native[1].home, 'skills', 'large', 'SKILL.md'), '---\nname: large\ndescription: fixture\n---\nshort preview\n');
  const value = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  const row = value.comparison.resources.unavailable.find(item => item.category === 'skill' && item.name === 'large');
  assert.ok(row);
  assert.equal(value.comparison.resources.changed.some(item => item.category === 'skill' && item.name === 'large'), false);
  assert.ok(row.detailDiff.hunks.some(hunk => hunk.kind === 'unknown'));
});

test('retains a verified skill file difference when other package files are unknown', async t => {
  const f = await fixture(t);
  for (const [index, text] of [[0, 'left verified text'], [1, 'right verified text']]) {
    const skill = join(f.native[index].home, 'skills', 'mixed');
    await put(join(skill, 'SKILL.md'), `---\nname: mixed\ndescription: fixture\n---\n${text}\n`);
    await symlink(join(f.root, 'outside'), join(skill, 'unsafe-link'));
  }
  const value = await compareAuditProfiles(f.store, 'A', 'B', { ...f.options, includeSourceValues: true });
  const row = value.comparison.resources.changed.find(item => item.category === 'skill' && item.name === 'mixed');
  assert.ok(row);
  assert.ok(row.detailDiff.hunks.some(hunk => hunk.kind === 'content-changed'));
  assert.equal(row.detailDiff.coverage, 'partial');
});

test('frozen reports reject links and invalid schemas and preserve existing Markdown sidecars', async t => {
  const f = await fixture(t), value = { schemaVersion: 1, kind: 'audit-run', id: 'frozen', status: 'partial', profile: {}, coverage: { skills: 'partial' } };
  const original = join(f.root, 'original.json');
  const receipt = await exportAuditReport(value, { output: original });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened, projectReportResourceProvenance(value));
  assert.equal(reopened.id, value.id);
  assert.equal(reopened.status, value.status);
  assert.ok(reopened.comparisonEvidence);
  assert.equal((await stat(original)).mode & 0o777, 0o600);
  const linked = join(f.root, 'linked.json'); await symlink(original, linked);
  await assert.rejects(readAuditReport(linked), /unsafe/);
  await assert.rejects(exportAuditReport(value, { output: linked }), /overwrite/);
  const markdown = join(f.root, 'report.md'); await put(`${markdown}.audit.json`, 'preserve');
  await assert.rejects(exportAuditReport(value, { output: markdown, format: 'markdown' }), /overwrite/);
  await assert.rejects(stat(markdown), { code: 'ENOENT' });
  assert.equal(await readFile(`${markdown}.audit.json`, 'utf8'), 'preserve');
  const invalid = join(f.root, 'invalid.json'); await put(invalid, '{"schemaVersion":2,"kind":"audit-run"}');
  await assert.rejects(readAuditReport(invalid), /Unsupported/);
});
