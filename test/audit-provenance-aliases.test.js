import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourceProvenance } from '../src/audit-provenance.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
import { renderAudit } from '../src/audit-report.js';

async function temporary(t, prefix = 'xfx-provenance-aliases-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function item(name, path, options = {}) {
  return {
    id: options.id ?? '0123456789abcdef01234567',
    name,
    path,
    origin: options.origin ?? 'repository',
    scope: options.scope ?? 'project',
    ...(options.provider ? { provider: options.provider } : {})
  };
}

test('accepts an eight-link in-root alias chain and rejects a nine-link chain', async t => {
  const workspace = await temporary(t);
  const skills = join(workspace, '.agents', 'skills');
  const target = join(skills, 'target');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'SKILL.md'), 'alias chain definition');

  async function chain(count, stem) {
    const names = Array.from({ length: count }, (_, index) => `${stem}-${index + 1}`);
    for (let index = 0; index < names.length; index++) {
      const destination = index + 1 < names.length ? names[index + 1] : 'target';
      await symlink(destination, join(skills, names[index]));
    }
    return join(skills, names[0], 'SKILL.md');
  }

  const eightPath = await chain(8, 'eight');
  const ninePath = await chain(9, 'nine');
  const traversed = [];
  const fs = {
    lstat: async path => lstat(path),
    readlink: async path => {
      const value = await readlink(path);
      traversed.push({ path, value });
      return value;
    }
  };
  const provenance = createResourceProvenance({ workspace, fs });
  await provenance.observeCatalog([item('eight', eightPath, { id: '1123456789abcdef01234567' })]);
  await provenance.observeCatalog([item('nine', ninePath, { id: '2123456789abcdef01234567' })], { agentId: 'child' });
  const block = provenance.snapshot();

  assert.equal(block.resources.length, 2);
  const accepted = block.resources.find(resource => resource.nativeSkillIds.includes('1123456789abcdef01234567'));
  const rejected = block.resources.find(resource => resource.nativeSkillIds.includes('2123456789abcdef01234567'));
  assert.equal(accepted.identity.location, 'workspace/.agents/skills/target');
  assert.equal(accepted.aliases[0], 'workspace/.agents/skills/eight-1');
  assert.equal(accepted.snapshots[0].definition.status, 'present');
  assert.equal(rejected.identity.location, 'workspace/.agents/skills/nine-1');
  assert.equal(rejected.snapshots[0].definition.status, 'unsafe');
  assert.ok(traversed.some(entry => entry.path.endsWith('/eight-1') && entry.value === 'eight-2'));
  assert.ok(traversed.some(entry => entry.path.endsWith('/eight-8') && entry.value === 'target'));
  assert.ok(traversed.some(entry => entry.path.endsWith('/nine-8') && entry.value === 'nine-9'));
  assert.equal(traversed.some(entry => entry.path.endsWith('/nine-9')), false,
    'the ninth symlink is rejected before following its target');
});

test('keeps missing, cyclic, outside, and root-level aliases bounded and visible', async t => {
  const workspace = await temporary(t);
  const skills = join(workspace, '.agents', 'skills');
  await mkdir(join(skills, 'inside'), { recursive: true });
  await writeFile(join(skills, 'inside', 'SKILL.md'), 'inside');
  await symlink('missing-target', join(skills, 'dangling'));
  await symlink('cycle-b', join(skills, 'cycle-a'));
  await symlink('cycle-a', join(skills, 'cycle-b'));
  await symlink('/etc/passwd', join(skills, 'outside'));

  const rootTarget = await temporary(t, 'xfx-root-alias-target-');
  await mkdir(join(rootTarget, '.agents', 'skills', 'rooted'), { recursive: true });
  await writeFile(join(rootTarget, '.agents', 'skills', 'rooted', 'SKILL.md'), 'root link target');
  const linkedWorkspace = await temporary(t, 'xfx-root-alias-');
  await symlink(join(rootTarget, '.agents'), join(linkedWorkspace, '.agents'));

  const provenance = createResourceProvenance({ workspace });
  await provenance.observeCatalog([
    item('dangling', join(skills, 'dangling', 'SKILL.md'), { id: '3123456789abcdef01234567' }),
    item('cycle', join(skills, 'cycle-a', 'SKILL.md'), { id: '4123456789abcdef01234567' }),
    item('outside', join(skills, 'outside', 'SKILL.md'), { id: '5123456789abcdef01234567' })
  ]);
  const linked = createResourceProvenance({ workspace: linkedWorkspace });
  await linked.observeCatalog([item('rooted', join(linkedWorkspace, '.agents', 'skills', 'rooted', 'SKILL.md'))]);

  const block = provenance.snapshot();
  assert.equal(block.resources.length, 3);
  assert.deepEqual(new Set(block.resources.map(resource => resource.snapshots[0].definition.status)),
    new Set(['missing', 'unsafe', 'outside-boundary']));
  assert.equal(block.status, 'partial');
  assert.equal(linked.snapshot().resources.length, 0);
  assert.equal(linked.snapshot().counts.omitted, 1);
  assert.equal(linked.snapshot().omissionReasons['outside-approved-root'], 1);
});

test('merges aliases to one canonical resource while preserving catalog identities', async t => {
  const workspace = await temporary(t);
  const userHome = await temporary(t, 'xfx-plugin-user-root-');
  const skills = join(workspace, '.agents', 'skills');
  const target = join(skills, 'canonical');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'SKILL.md'), 'shared bytes');
  await symlink('canonical', join(skills, 'alias-one'));
  await symlink('alias-one', join(skills, 'alias-two'));
  const shared = join(skills, 'canonical', 'SKILL.md');
  const provenance = createResourceProvenance({ workspace });
  await provenance.observeCatalog([
    item('canonical', shared, { id: '6123456789abcdef01234567' }),
    item('alias-one', join(skills, 'alias-one', 'SKILL.md'), { id: '7123456789abcdef01234567' }),
    item('alias-two', join(skills, 'alias-two', 'SKILL.md'), { id: '8123456789abcdef01234567' })
  ], { agentId: 'root' });
  const sharedWithOtherOrigin = item('same path different origin', join(skills, 'alias-one', 'SKILL.md'), {
    id: '9123456789abcdef01234567', origin: 'project', scope: 'project'
  });
  await provenance.observeCatalog([sharedWithOtherOrigin], { agentId: 'child' });

  const samePluginPath = join(userHome, '.codex', 'plugins', 'cache', 'fixture', 'skills', 'review', 'SKILL.md');
  await mkdir(join(samePluginPath, '..'), { recursive: true });
  await writeFile(samePluginPath, 'plugin bytes');
  const aliasPluginPath = join(userHome, '.codex', 'plugins', 'cache', 'fixture', 'skills', 'review-alias');
  await symlink('review', aliasPluginPath);
  const pluginProvenance = createResourceProvenance({ workspace, userHome });
  await pluginProvenance.observeCatalog([
    item('review', samePluginPath, { id: 'a123456789abcdef01234567', origin: 'plugin', scope: 'plugin', provider: 'vendor-a' }),
    item('review-alias', join(aliasPluginPath, 'SKILL.md'), { id: 'b123456789abcdef01234567', origin: 'plugin', scope: 'plugin', provider: 'vendor-b' })
  ]);

  const resources = [...provenance.snapshot().resources, ...pluginProvenance.snapshot().resources];
  const repository = resources.filter(resource => resource.identity.location === 'workspace/.agents/skills/canonical' && resource.identity.origin === 'repository');
  assert.equal(repository.length, 1);
  assert.deepEqual(new Set(repository[0].nativeSkillIds), new Set([
    '6123456789abcdef01234567', '7123456789abcdef01234567', '8123456789abcdef01234567'
  ]));
  assert.deepEqual(new Set(repository[0].aliases), new Set([
    'workspace/.agents/skills/canonical', 'workspace/.agents/skills/alias-one', 'workspace/.agents/skills/alias-two'
  ]));
  assert.equal(resources.filter(resource => resource.identity.location === 'workspace/.agents/skills/canonical').length, 2,
    'equal canonical paths under distinct catalog origins stay distinct');
  assert.equal(resources.filter(resource => resource.identity.location === 'workspace/.agents/skills/canonical' && resource.identity.origin === 'project').length, 1);
  const pluginResources = resources.filter(resource => resource.identity.location === 'user/.codex/plugins/cache/fixture/skills/review');
  assert.equal(pluginResources.length, 2);
  assert.equal(new Set(pluginResources.map(resource => resource.identity.provider)).size, 2,
    'provider identity remains part of resource identity even for one canonical path');
});

test('captures supported workspace, profile, and user layouts and leaves unsupported roots explicit', async t => {
  const workspace = await temporary(t);
  const profileHome = await temporary(t, 'xfx-profile-root-');
  const userHome = await temporary(t, 'xfx-user-root-');
  const locations = [
    { path: join(workspace, '.codex', 'skills', 'workspace', 'SKILL.md'), origin: 'repository', scope: 'project', location: 'workspace/.codex/skills/workspace' },
    { path: join(profileHome, 'skills', 'profile', 'SKILL.md'), origin: 'profile', scope: 'profile', location: 'profile/skills/profile' },
    { path: join(userHome, '.agents', 'skills', 'user', 'SKILL.md'), origin: 'user', scope: 'user', location: 'user/.agents/skills/user' },
    { path: join(userHome, '.codex', 'skills', 'user-codex', 'SKILL.md'), origin: 'user', scope: 'user', location: 'user/.codex/skills/user-codex' }
  ];
  for (const row of locations) {
    await mkdir(join(row.path, '..'), { recursive: true });
    await writeFile(row.path, `definition for ${row.origin}`);
  }
  const unsupported = await temporary(t, 'xfx-unsupported-origin-');
  await mkdir(join(unsupported, 'skills', 'admin'), { recursive: true });
  const unsupportedPath = join(unsupported, 'skills', 'admin', 'SKILL.md');
  await writeFile(unsupportedPath, 'must remain outside approved roots');

  const provenance = createResourceProvenance({ workspace, profileHome, userHome });
  await provenance.observeCatalog([
    ...locations.map((row, index) => item(`layout-${index}`, row.path, { id: `${(index + 1).toString(16)}${'0'.repeat(23)}`, origin: row.origin, scope: row.scope })),
    item('unsupported admin', unsupportedPath, { id: '5123456789abcdef01234567', origin: 'admin', scope: 'admin' })
  ]);
  const block = provenance.snapshot();

  assert.equal(block.resources.length, locations.length);
  for (const row of locations) {
    assert.ok(block.resources.some(resource => resource.identity.origin === row.origin && resource.identity.location === row.location));
  }
  assert.equal(block.counts.omitted, 1);
  assert.equal(block.omissionReasons['outside-approved-root'], 1);
  assert.equal(JSON.stringify(block).includes(unsupported), false);
});

test('preserves logical alias and canonical fingerprints through compact JSON and Markdown reopen after source removal', async t => {
  const workspace = await temporary(t);
  const target = join(workspace, '.agents', 'skills', 'canonical');
  const alias = join(workspace, '.agents', 'skills', 'alias-name');
  await mkdir(target, { recursive: true });
  const definition = join(target, 'SKILL.md');
  await writeFile(definition, 'private alias fixture definition');
  await symlink('canonical', alias);
  const provenance = createResourceProvenance({ workspace });
  await provenance.observeCatalog([item('visible-name', join(alias, 'SKILL.md'))], { agentId: 'root' });
  const captured = provenance.snapshot();
  const fingerprint = captured.resources[0].snapshots[0].definition.fingerprint;
  const compact = compactAuditTrial({ runs: [{ id: 'alias-roundtrip', profileName: 'fixture', resourceProvenance: captured }] }).runs[0];
  const exportRoot = await temporary(t, 'xfx-alias-export-');

  await rm(workspace, { recursive: true, force: true });
  for (const format of ['json', 'markdown']) {
    const output = join(exportRoot, `run.${format === 'json' ? 'json' : 'md'}`);
    const exported = await exportAuditReport({ ...compact, schemaVersion: 1, kind: 'audit-run' }, { format, output });
    const reopened = await readAuditReport(exported.evidencePath);
    const resource = reopened.resourceProvenance.resources[0];
    assert.equal(resource.identity.location, 'workspace/.agents/skills/canonical');
    assert.equal(resource.canonicalRef, 'workspace/.agents/skills/canonical');
    assert.deepEqual(resource.aliases, ['workspace/.agents/skills/alias-name']);
    assert.equal(resource.snapshots[0].definition.fingerprint, fingerprint);
    assert.doesNotMatch(JSON.stringify(reopened), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(reopened), /private alias fixture definition|SKILL\.md/);
    if (format === 'markdown') {
      const text = await import('node:fs/promises').then(fs => fs.readFile(output, 'utf8'));
      assert.ok(text.includes('workspace/\\.agents/skills/alias\\-name'));
      assert.ok(text.includes(fingerprint));
      assert.doesNotMatch(text, /private alias fixture definition|SKILL\.md/);
    }
  }
  assert.ok(renderAudit(compact, { format: 'markdown' }).includes('workspace/\\.agents/skills/alias\\-name'));
});
