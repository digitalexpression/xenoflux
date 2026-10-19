import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, link, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourceProvenance, projectResourceProvenance, compareResourceProvenance } from '../src/audit-provenance.js';

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'xfx-provenance-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const skillDir = join(workspace, '.agents', 'skills', 'alpha');
  await mkdir(skillDir, { recursive: true });
  const path = join(skillDir, 'SKILL.md');
  await writeFile(path, 'name: Alpha\n');
  return { workspace, path };
}

test('captures bounded root and after-task definition fingerprints with logical identity', async t => {
  const f = await fixture(t);
  const p = createResourceProvenance({ workspace: f.workspace });
  await p.observeCatalog([{ id: '0123456789abcdef01234567', name: 'alpha', path: f.path, origin: 'repository', scope: 'project' }], { agentId: 'root-agent' });
  await writeFile(f.path, 'name: Alpha changed\n');
  const result = await p.finish();
  assert.equal(result.resources.length, 1);
  assert.deepEqual(result.resources[0].nativeSkillIds, ['0123456789abcdef01234567']);
  assert.deepEqual(result.resources[0].agentIds, ['root-agent']);
  assert.equal(result.resources[0].identity.location, 'workspace/.agents/skills/alpha');
  assert.equal(result.resources[0].snapshots.length, 2);
  assert.notEqual(result.resources[0].snapshots[0].definition.fingerprint, result.resources[0].snapshots[1].definition.fingerprint);
  assert.equal(result.resources[0].snapshots[0].definition.before, undefined);
});

test('rejects external aliases and projects absent or malformed blocks to explicit unknown', async t => {
  const f = await fixture(t);
  const p = createResourceProvenance({ workspace: f.workspace });
  await p.observeCatalog([{ id: 'outside', name: 'secret', path: '/etc/passwd', origin: 'project', scope: 'project' }]);
  const result = p.snapshot();
  assert.equal(result.status, 'partial');
  assert.equal(result.resources.length, 0);
  assert.equal(projectResourceProvenance(undefined).reason, 'not-recorded');
  assert.equal(projectResourceProvenance({ schemaVersion: 1, status: 'complete', resources: [] }).reason, 'invalid');
  const auth = join(f.workspace, '.agents', 'skills', 'alpha', 'auth.json'); await writeFile(auth, 'AUTH_INSIDE_SKILL_SENTINEL');
  const restricted = createResourceProvenance({ workspace: f.workspace });
  await restricted.observeCatalog([{ id: '8123456789abcdef01234567', name: 'auth', path: auth, origin: 'repository', scope: 'project' }]);
  assert.equal(restricted.snapshot().counts.omitted, 1);
  assert.equal(restricted.snapshot().omissionReasons['unsafe-resource-reference'], 1);
  assert.equal(JSON.stringify(restricted.snapshot()).includes('AUTH_INSIDE_SKILL_SENTINEL'), false);
});

test('projector strips absolute paths and enforces resource and byte budgets', () => {
  const value = { schemaVersion: 1, status: 'complete', counts: { observed: 2, omitted: 0, snapshots: 1 }, resources: [1,2].map(n => ({
    identity: { origin: 'project', location: 'workspace/skills/same' }, name: `skill${n}`, scope: 'project', nativeSkillIds: [`id${n}`], agentIds: ['root'], aliases: ['workspace/skills/same'],
    snapshots: [{ phase: 'before-task', agentId: 'root', status: 'present', definition: { status: 'present', fingerprint: 'a'.repeat(64), before: '/Users/person/private' } }]
  })) };
  const one = projectResourceProvenance(value, { maxResources: 1 });
  assert.equal(one.resources.length, 1);
  assert.equal(one.counts.omitted, 1);
  assert.equal(one.status, 'partial');
  assert.equal(projectResourceProvenance(one).counts.omitted, one.counts.omitted);
  assert.equal(JSON.stringify(one).includes('/Users/person/private'), false);
  const tiny = projectResourceProvenance(value, { maxBytes: 256 });
  assert.ok(Buffer.byteLength(JSON.stringify(tiny)) <= 256);
  assert.equal(tiny.status, 'partial');
});

test('comparison keeps missing fingerprints unknown and compares matching identities by snapshots', () => {
  const block = fingerprint => ({ schemaVersion: 1, status: 'complete', counts: { observed: 1, omitted: 0, snapshots: 1 }, resources: [{ identity: { origin: 'user', location: 'user/skills/a' }, name: 'same', scope: 'user', snapshots: [{ phase: 'before-task', status: 'present', definition: { status: 'present', ...(fingerprint ? { fingerprint } : {}) } }] }] });
  assert.equal(compareResourceProvenance(block('a'.repeat(64)), block('b'.repeat(64)), { sameBaseline: true }).changes[0].status, 'changed');
  assert.equal(compareResourceProvenance(block(null), block('b'.repeat(64))).changes[0].status, 'unknown');
  assert.equal(compareResourceProvenance(block('a'.repeat(64)), block('a'.repeat(64)), { sameBaseline: true }).stabilityProven, false);
});

test('projector rejects malformed nested blocks without throwing and downgrades unsupported complete claims', () => {
  const base = { schemaVersion: 1, status: 'complete', counts: { observed: 1, omitted: 0, snapshots: 1 }, resources: [] };
  for (const resource of [null, {}, { snapshots: null }, { identity: null, snapshots: [] }]) {
    const projected = projectResourceProvenance({ ...base, resources: [resource] });
    assert.equal(projected.status, 'unavailable');
    assert.equal(projected.reason, 'invalid');
  }

  const missingDefinition = { ...base, resources: [{ identity: { origin: 'user', location: 'user/skills/a' }, scope: 'user', snapshots: [{ phase: 'before-task', status: 'present', definition: { status: 'present', scope: 'skill-definition-bytes' } }] }] };
  assert.equal(projectResourceProvenance(missingDefinition).status, 'partial');

  const missingManifest = { ...base, resources: [{ identity: { origin: 'plugin', provider: 'market/plugin', location: 'user/plugins/plugin/skills/a' }, scope: 'plugin', snapshots: [{ phase: 'before-task', status: 'present', definition: { status: 'present', fingerprint: 'a'.repeat(64), scope: 'skill-definition-bytes' }, manifest: { status: 'present', fingerprint: 'b'.repeat(64), scope: 'plugin-manifest-allowlist' } }] }] };
  assert.equal(projectResourceProvenance(missingManifest).status, 'partial');

  assert.equal(projectResourceProvenance({ ...base, counts: { ...base.counts, snapshots: 0 }, resources: missingDefinition.resources }).reason, 'invalid');
  assert.equal(projectResourceProvenance({ ...base, counts: { ...base.counts, observed: 2 }, resources: [] }).reason, 'invalid');
});

test('projector records detail dropped at per-resource limits as partial omissions', () => {
  const block = {
    schemaVersion: 1,
    status: 'complete',
    counts: { observed: 1, omitted: 0, snapshots: 1 },
    resources: [{
      identity: { origin: 'user', location: 'user/skills/a' },
      scope: 'user',
      nativeSkillIds: Array.from({ length: 161 }, (_, i) => i.toString(16).padStart(24, '0')),
      aliases: Array.from({ length: 17 }, (_, i) => `user/skills/alias-${i}`),
      snapshots: [{ phase: 'before-task', status: 'present', definition: { status: 'present', fingerprint: 'a'.repeat(64), scope: 'skill-definition-bytes' } }]
    }]
  };
  const projected = projectResourceProvenance(block);
  assert.equal(projected.status, 'partial');
  assert.equal(projected.counts.omitted, 1);
  assert.equal(projected.omissionReasons['projection-limit'], 1);
  assert.equal(projected.resources[0].nativeSkillIds.length, 160);
  assert.equal(projected.resources[0].aliases.length, 16);
  assert.equal(projectResourceProvenance(projected).counts.omitted, 1);
});

test('profile and user resources compare without repository baseline alignment', () => {
  const block = (origin, location, fingerprint) => ({ schemaVersion: 1, status: 'complete', counts: { observed: 1, omitted: 0, snapshots: 1 }, resources: [{ identity: { origin, location }, scope: origin, snapshots: [{ phase: 'before-task', status: 'present', definition: { status: 'present', fingerprint, scope: 'skill-definition-bytes' } }] }] });
  assert.equal(compareResourceProvenance(block('profile', 'profile/skills/a', 'a'.repeat(64)), block('profile', 'profile/skills/a', 'a'.repeat(64))).changes[0].status, 'same');
  assert.equal(compareResourceProvenance(block('user', 'user/skills/a', 'a'.repeat(64)), block('user', 'user/skills/a', 'b'.repeat(64))).changes[0].status, 'changed');
  assert.equal(compareResourceProvenance(block('project', 'workspace/.agents/skills/a', 'a'.repeat(64)), block('project', 'workspace/.agents/skills/a', 'a'.repeat(64))).changes[0].reason, 'repository-alignment-unknown');
});

test('limits filesystem reads to authorized skill roots and deduplicates actors per snapshot', async t => {
  const f = await fixture(t); let opens = 0;
  const p = createResourceProvenance({ workspace: f.workspace, fs: { open: async (...args) => { opens++; const { open } = await import('node:fs/promises'); return open(...args); } } });
  const skill = { id: '0123456789abcdef01234567', name: 'alpha', path: f.path, origin: 'repository', scope: 'project', version: 'untrusted-native-version' };
  await p.observeCatalog([skill], { agentId: 'root' });
  await Promise.all(['child', 'grandchild'].map(agentId => p.observeCatalog([skill], { agentId, phase: 'after-task' })));
  await p.observeCatalog([{ ...skill, enabled: false }], { agentId: 'inactive-child', phase: 'after-task' });
  await p.finish();
  const block = p.snapshot();
  assert.deepEqual(block.resources[0].agentIds.sort(), ['child', 'grandchild', 'inactive-child', 'root']);
  assert.ok(block.resources[0].catalogs.some(c => c.agentId === 'inactive-child' && c.status === 'inactive'));
  assert.equal(block.resources[0].snapshots.length, 2);
  assert.equal(block.resources[0].version, undefined);
  assert.equal(opens, 2);

  const arbitrary = await join(f.workspace, 'auth.json'); await writeFile(arbitrary, 'AUTH_SENTINEL');
  const unauthorised = createResourceProvenance({ userHome: f.workspace });
  await unauthorised.observeCatalog([{ id: 'auth', name: 'auth', path: arbitrary, origin: 'user', scope: 'user' }]);
  assert.equal(unauthorised.snapshot().resources.length, 0);
  assert.equal(JSON.stringify(unauthorised.snapshot()).includes('AUTH_SENTINEL'), false);
});

test('defers shared child after-task sampling until finish and records conflicting catalog status as partial', async t => {
  const f = await fixture(t); let opens = 0;
  const p = createResourceProvenance({ workspace: f.workspace, fs: { open: async (...args) => { opens++; const { open } = await import('node:fs/promises'); return open(...args); } } });
  const skill = { id: '0123456789abcdef01234567', name: 'alpha', path: f.path, origin: 'repository', scope: 'project' };
  await p.observeCatalog([skill], { agentId: 'root', phase: 'before-task', cwd: f.workspace });
  await p.observeCatalog([skill], { agentId: 'child', phase: 'after-task', cwd: f.workspace });
  assert.equal(opens, 1);
  assert.equal(p.snapshot().resources[0].snapshots.length, 1);
  assert.ok(p.snapshot().resources[0].catalogs.some(c => c.agentId === 'child' && c.phase === 'after-task' && c.status === 'present'));
  await writeFile(f.path, 'changed after child catalog, before process stop');
  const finished = await p.finish();
  assert.equal(opens, 2);
  assert.equal(finished.resources[0].snapshots.length, 2);
  assert.equal(finished.resources[0].snapshots[1].phase, 'after-task');
  assert.notEqual(finished.resources[0].snapshots[0].definition.fingerprint, finished.resources[0].snapshots[1].definition.fingerprint);

  const conflicted = createResourceProvenance({ workspace: f.workspace });
  await conflicted.observeCatalog([
    { ...skill, enabled: true },
    { ...skill, enabled: false }
  ], { agentId: 'root', phase: 'before-task', cwd: f.workspace });
  assert.equal(conflicted.snapshot().resources[0].catalogs[0].status, 'unavailable');
  assert.equal(conflicted.snapshot().status, 'partial');
});

test('accepts late-observation as partial evidence and defers shared-resource sampling until finish', async t => {
  const f = await fixture(t);
  const p = createResourceProvenance({ workspace: f.workspace });
  const skill = { id: '0123456789abcdef01234567', name: 'alpha', path: f.path, origin: 'repository', scope: 'project' };
  await p.observeCatalog([skill], { agentId: 'root', phase: 'before-task', cwd: f.workspace });
  await p.observeCatalog([skill], { agentId: 'active-child', phase: 'late-observation', cwd: f.workspace });
  const observed = p.snapshot();
  assert.equal(observed.status, 'partial');
  assert.equal(observed.resources[0].snapshots.length, 1);
  assert.ok(observed.resources[0].catalogs.some(c => c.agentId === 'active-child' && c.phase === 'late-observation'));
  assert.equal(projectResourceProvenance({ ...observed, status: 'complete' }).status, 'partial');
  const finished = await p.finish();
  assert.equal(finished.status, 'partial');
  assert.equal(finished.resources[0].snapshots.length, 2);
  assert.deepEqual(finished.resources[0].snapshots.map(s => s.phase), ['before-task', 'after-task']);
});

test('bounds alias traversal, records aliases and canonical refs, and rejects secret symlink targets', async t => {
  const f = await fixture(t); const skillsRoot = join(f.workspace, '.agents', 'skills');
  const alias = join(skillsRoot, 'alias'); await symlink(join(skillsRoot, 'alpha'), alias);
  const p = createResourceProvenance({ workspace: f.workspace });
  await p.observeCatalog([{ id: '1123456789abcdef01234567', name: 'alias', path: join(alias, 'SKILL.md'), origin: 'repository', scope: 'project' }]);
  const result = p.snapshot();
  assert.equal(result.resources.length, 1);
  assert.ok(result.resources[0].aliases.includes('workspace/.agents/skills/alias'));
  assert.equal(result.resources[0].canonicalRef, 'workspace/.agents/skills/alpha');
  assert.equal(result.resources[0].identity.location, 'workspace/.agents/skills/alpha');

  const privateTarget = join(skillsRoot, 'alpha', '.env'); await writeFile(privateTarget, 'ENV_SENTINEL');
  await rm(join(skillsRoot, 'alpha', 'SKILL.md'));
  await symlink(privateTarget, join(skillsRoot, 'alpha', 'SKILL.md'));
  const denied = createResourceProvenance({ workspace: f.workspace });
  await denied.observeCatalog([{ id: '2123456789abcdef01234567', name: 'alpha', path: join(skillsRoot, 'alpha', 'SKILL.md'), origin: 'repository', scope: 'project' }]);
  assert.equal(denied.snapshot().resources[0].snapshots[0].status, 'unsafe');
  assert.equal(JSON.stringify(denied.snapshot()).includes('ENV_SENTINEL'), false);
});

test('captures only allowlisted plugin manifest fields and leaves unavailable versions unknown', async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'xfx-plugin-home-')); t.after(() => rm(userHome, { recursive: true, force: true }));
  const pkg = join(userHome, '.codex', 'plugins', 'cache', 'market', 'shared', '2.3.1'); const skillDir = join(pkg, 'skills', 'review');
  await mkdir(skillDir, { recursive: true }); const path = join(skillDir, 'SKILL.md'); await writeFile(path, 'definition');
  await mkdir(join(pkg, '.codex-plugin'), { recursive: true });
  await writeFile(join(pkg, '.codex-plugin', 'plugin.json'), JSON.stringify({ id: 'market/shared', version: '2.3.1', accessToken: 'PLUGIN_SECRET_SENTINEL' }));
  const p = createResourceProvenance({ userHome });
  await p.observeCatalog([{ id: '3123456789abcdef01234567', name: 'review', path, origin: 'plugin', scope: 'plugin', provider: 'market/shared', version: 'untrusted-version' }]);
  const block = p.snapshot();
  assert.equal(block.resources[0].version, '2.3.1');
  assert.equal(block.resources[0].snapshots[0].manifest.status, 'present');
  assert.ok(block.resources[0].identity.providerRef.startsWith('opaque-'));
  assert.equal(block.resources[0].identity.provider, undefined);
  assert.equal(JSON.stringify(block).includes('PLUGIN_SECRET_SENTINEL'), false);

  const missingPkg = join(userHome, '.codex', 'plugins', 'cache', 'market', 'missing');
  const missingVersion = join(missingPkg, '1.0.0'); const missingSkillDir = join(missingVersion, 'skills', 'doc');
  await mkdir(missingSkillDir, { recursive: true }); await writeFile(join(missingSkillDir, 'SKILL.md'), 'definition');
  await writeFile(join(missingPkg, 'plugin.json'), JSON.stringify({ id: 'market/missing', version: '9.9.9' }));
  const noFallback = createResourceProvenance({ userHome });
  await noFallback.observeCatalog([{ id: '4123456789abcdef01234567', name: 'doc', path: join(missingSkillDir, 'SKILL.md'), origin: 'plugin', scope: 'plugin', provider: 'market/missing' }]);
  assert.equal(noFallback.snapshot().resources[0].version, undefined);
  assert.equal(noFallback.snapshot().resources[0].snapshots[0].manifest.status, 'missing');
  assert.equal(noFallback.snapshot().status, 'partial');

  const simplePkg = join(userHome, '.codex', 'plugins', 'cache', 'simple'); const simpleSkillDir = join(simplePkg, 'skills', 'tool');
  await mkdir(simpleSkillDir, { recursive: true }); await writeFile(join(simpleSkillDir, 'SKILL.md'), 'simple definition');
  await writeFile(join(simplePkg, 'plugin.json'), JSON.stringify({ id: 'simple', version: '1.0.0' }));
  const unversioned = createResourceProvenance({ userHome });
  await unversioned.observeCatalog([{ id: '5123456789abcdef01234567', name: 'tool', path: join(simpleSkillDir, 'SKILL.md'), origin: 'plugin', scope: 'plugin', provider: 'simple' }]);
  assert.equal(unversioned.snapshot().resources[0].version, '1.0.0');
});

test('compares verified plugin versions across cache paths and keeps multiple installed versions ambiguous', async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'xfx-plugin-compare-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));

  async function capture(versions) {
    const skills = [];
    for (const [index, version] of versions.entries()) {
      const pkg = join(userHome, '.codex', 'plugins', 'cache', 'market', 'shared', version);
      const skillDir = join(pkg, 'skills', 'review');
      await mkdir(skillDir, { recursive: true });
      const path = join(skillDir, 'SKILL.md');
      await writeFile(path, 'same review definition');
      await writeFile(join(pkg, 'plugin.json'), JSON.stringify({ id: 'market/shared', version }));
      skills.push({
        id: `${(index + 1).toString(16).padStart(1, '0')}${'0'.repeat(23)}`,
        name: 'review', path, origin: 'plugin', scope: 'plugin', provider: 'market/shared'
      });
    }
    const provenance = createResourceProvenance({ userHome });
    await provenance.observeCatalog(skills, { agentId: 'root' });
    return provenance.snapshot();
  }

  const oldVersion = await capture(['1.0.0']);
  const newVersion = await capture(['2.0.0']);
  const changed = compareResourceProvenance(oldVersion, newVersion);
  assert.equal(changed.changes.length, 1);
  assert.equal(changed.changes[0].status, 'changed');
  assert.ok(changed.changes[0].identity.location.includes('/1.0.0/skills/review') ||
    changed.changes[0].identity.location.includes('/2.0.0/skills/review'));

  const multipleVersions = await capture(['1.0.0', '2.0.0']);
  const ambiguous = compareResourceProvenance(multipleVersions, oldVersion);
  assert.equal(ambiguous.changes.length, 1);
  assert.equal(ambiguous.changes[0].status, 'unknown');
  assert.equal(ambiguous.changes[0].reason, 'ambiguous-or-missing');
});

test('rejects oversized, hardlinked, and world-writable definitions before opening them', async t => {
  const f = await fixture(t);
  const skillsRoot = join(f.workspace, '.agents', 'skills');
  const oversizedDir = join(skillsRoot, 'oversized');
  const hardlinkedDir = join(skillsRoot, 'hardlinked');
  const writableDir = join(skillsRoot, 'writable');
  await Promise.all([mkdir(oversizedDir), mkdir(hardlinkedDir), mkdir(writableDir)]);
  const oversizedPath = join(oversizedDir, 'SKILL.md');
  const hardlinkedPath = join(hardlinkedDir, 'SKILL.md');
  const writablePath = join(writableDir, 'SKILL.md');
  await writeFile(oversizedPath, Buffer.alloc(512 * 1024 + 1, 0x61));
  await writeFile(hardlinkedPath, 'hardlinked definition');
  await link(hardlinkedPath, join(hardlinkedDir, 'second-link'));
  await writeFile(writablePath, 'writable definition');
  await chmod(writablePath, 0o666);

  let opens = 0;
  const provenance = createResourceProvenance({
    workspace: f.workspace,
    fs: { open: async (...args) => {
      opens++;
      const { open } = await import('node:fs/promises');
      return open(...args);
    } }
  });
  await provenance.observeCatalog([
    { id: 'a123456789abcdef01234567', name: 'oversized', path: oversizedPath, origin: 'repository', scope: 'project' },
    { id: 'b123456789abcdef01234567', name: 'hardlinked', path: hardlinkedPath, origin: 'repository', scope: 'project' },
    { id: 'c123456789abcdef01234567', name: 'writable', path: writablePath, origin: 'repository', scope: 'project' }
  ]);
  assert.equal(opens, 0);
  assert.deepEqual(new Set(provenance.snapshot().resources.map(r => r.snapshots[0].definition.status)), new Set(['unsafe']));
});

test('aggregate byte and resource limits stop further reads and count omitted resources', async t => {
  const f = await fixture(t);
  const root = join(f.workspace, '.agents', 'skills');
  const firstDir = join(root, 'first');
  const secondDir = join(root, 'second');
  const thirdDir = join(root, 'third');
  await Promise.all([mkdir(firstDir), mkdir(secondDir), mkdir(thirdDir)]);
  const entries = [];
  for (const [index, dir] of [firstDir, secondDir, thirdDir].entries()) {
    const path = join(dir, 'SKILL.md');
    await writeFile(path, '1234');
    entries.push({ id: `${(index + 1).toString(16)}${'0'.repeat(23)}`, name: `resource-${index}`, path, origin: 'repository', scope: 'project' });
  }

  let opens = 0;
  const byteLimited = createResourceProvenance({
    workspace: f.workspace,
    limits: { maxBytes: 5 },
    fs: { open: async (...args) => {
      opens++;
      const { open } = await import('node:fs/promises');
      return open(...args);
    } }
  });
  await byteLimited.observeCatalog(entries.slice(0, 2));
  assert.equal(opens, 1);
  assert.deepEqual(byteLimited.snapshot().resources.map(r => r.snapshots[0].definition.status), ['present', 'budget-exceeded']);

  const resourceLimited = createResourceProvenance({ workspace: f.workspace, limits: { maxResources: 1 } });
  await resourceLimited.observeCatalog(entries);
  const result = resourceLimited.snapshot();
  assert.equal(result.resources.length, 1);
  assert.equal(result.counts.omitted, 2);
  assert.equal(result.omissionReasons['resource-limit'], 2);
  assert.equal(result.status, 'partial');
});

test('marks incomplete comparison and changed within-run endpoints unknown', () => {
  const make = (first, second) => ({ schemaVersion: 1, status: 'complete', counts: { observed: 1, omitted: 0, snapshots: 2 }, resources: [{ identity: { origin: 'project', location: 'workspace/.agents/skills/a' }, name: 'a', scope: 'project', snapshots: [first, second].map((fingerprint, index) => ({ phase: index ? 'after-task' : 'before-task', status: 'present', definition: { status: 'present', fingerprint, scope: 'skill-definition-bytes' } })) }] });
  assert.equal(compareResourceProvenance(make('a'.repeat(64), 'b'.repeat(64)), make('c'.repeat(64), 'c'.repeat(64)), { sameBaseline: true }).changes[0].status, 'unknown');
  assert.equal(compareResourceProvenance(make('a'.repeat(64), 'a'.repeat(64)), make('a'.repeat(64), 'a'.repeat(64))).changes[0].reason, 'repository-alignment-unknown');
  assert.equal(projectResourceProvenance({ schemaVersion: 2, status: 'complete', counts: { observed: 0, omitted: 0, snapshots: 0 }, resources: [] }).reason, 'invalid');
  const plugin = (firstVersion, secondVersion) => ({ schemaVersion: 1, status: 'complete', counts: { observed: 1, omitted: 0, snapshots: 2 }, resources: [{ identity: { origin: 'plugin', provider: 'market/plugin', location: 'user/.codex/plugins/cache/market/plugin/1.0/skills/a' }, name: 'a', scope: 'plugin', version: firstVersion, snapshots: ['before-task', 'after-task'].map((phase, i) => ({ phase, status: 'present', definition: { status: 'present', fingerprint: 'a'.repeat(64), scope: 'skill-definition-bytes' }, manifest: { status: 'present', fingerprint: (i ? secondVersion : firstVersion) === '1.0.0' ? 'b'.repeat(64) : 'c'.repeat(64), version: i ? secondVersion : firstVersion, scope: 'plugin-manifest-allowlist' } })) }] });
  assert.equal(compareResourceProvenance(plugin('1.0.0', '2.0.0'), plugin('1.0.0', '1.0.0'), { sameBaseline: true }).changes[0].status, 'unknown');
});

test('detects read races and rejects external symlink and cyclic alias targets', async t => {
  const f = await fixture(t);
  const { open } = await import('node:fs/promises'); let mutated = false, sawNoFollowAny = false;
  const p = createResourceProvenance({ workspace: f.workspace, fs: { open: async (...args) => {
    sawNoFollowAny ||= (args[1] & 0x20000000) !== 0;
    const handle = await open(...args);
    return { stat: (...a) => handle.stat(...a), close: () => handle.close(), read: async (...a) => {
      const result = await handle.read(...a);
      if (!mutated) { mutated = true; await writeFile(f.path, 'changed while provenance was reading'); }
      return result;
    } };
  } } });
  await p.observeCatalog([{ id: '4123456789abcdef01234567', name: 'alpha', path: f.path, origin: 'repository', scope: 'project' }]);
  assert.equal(p.snapshot().resources[0].snapshots[0].definition.status, 'changed-during-read');
  assert.equal(sawNoFollowAny, true);

  const skillsRoot = join(f.workspace, '.agents', 'skills');
  const out = join(skillsRoot, 'outside'); await symlink('/etc/passwd', out);
  const cycle = join(skillsRoot, 'cycle'); await mkdir(cycle); await symlink('SKILL.md', join(cycle, 'loop')); await symlink('loop', join(cycle, 'SKILL.md'));
  const denied = createResourceProvenance({ workspace: f.workspace });
  await denied.observeCatalog([
    { id: '5123456789abcdef01234567', name: 'outside', path: join(out, 'SKILL.md'), origin: 'repository', scope: 'project' },
    { id: '6123456789abcdef01234567', name: 'cycle', path: join(cycle, 'SKILL.md'), origin: 'repository', scope: 'project' }
  ]);
  assert.equal(denied.snapshot().resources.length, 2);
  assert.deepEqual(new Set(denied.snapshot().resources.map(r => r.snapshots[0].definition.status)), new Set(['outside-boundary', 'unsafe']));
});

test('rejects an approved-root path whose intermediate directory is a symlink outside the workspace', async t => {
  const f = await fixture(t); const outside = await mkdtemp(join(tmpdir(), 'xfx-outside-skills-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const secret = join(outside, 'secret'); await mkdir(secret); await writeFile(join(secret, 'SKILL.md'), 'ROOT_SYMLINK_SECRET');
  await rm(join(f.workspace, '.agents'), { recursive: true, force: true });
  await symlink(outside, join(f.workspace, '.agents'));
  let opens = 0; const p = createResourceProvenance({ workspace: f.workspace, fs: { open: async () => { opens++; throw new Error('must not open'); } } });
  await p.observeCatalog([{ id: '7123456789abcdef01234567', name: 'secret', path: join(f.workspace, '.agents', 'secret', 'SKILL.md'), origin: 'repository', scope: 'project' }]);
  const block = p.snapshot();
  assert.equal(opens, 0);
  assert.equal(block.counts.omitted, 1);
  assert.equal(block.omissionReasons['outside-approved-root'], 1);
  assert.equal(JSON.stringify(block).includes('ROOT_SYMLINK_SECRET'), false);
});

test('authorizes child catalogs only under their verified workspace cwd and keeps distinct logical refs', async t => {
  const f = await fixture(t);
  const makeChild = async (relativePath, name) => {
    const dir = join(f.workspace, relativePath, '.agents', 'skills', name);
    await mkdir(dir, { recursive: true }); const path = join(dir, 'SKILL.md'); await writeFile(path, `definition ${name}`);
    return { cwd: join(f.workspace, relativePath), skill: { id: name === 'child' ? 'a123456789abcdef01234567' : 'b123456789abcdef01234567', name, path, origin: 'repository', scope: 'project' } };
  };
  const child = await makeChild('child-worktree', 'child'); const grandchild = await makeChild('grandchild-worktree', 'grandchild');
  const p = createResourceProvenance({ workspace: f.workspace });
  await p.observeCatalog([{ id: '0123456789abcdef01234567', name: 'alpha', path: f.path, origin: 'repository', scope: 'project' }], { agentId: 'root', cwd: f.workspace });
  await p.observeCatalog([child.skill], { agentId: 'child', phase: 'after-task', cwd: child.cwd });
  await p.observeCatalog([grandchild.skill], { agentId: 'grandchild', phase: 'after-task', cwd: grandchild.cwd });
  const block = await p.finish();
  assert.equal(block.resources.length, 3);
  assert.ok(block.resources.some(r => r.identity.location === 'workspace/child-worktree/.agents/skills/child'));
  assert.ok(block.resources.some(r => r.identity.location === 'workspace/grandchild-worktree/.agents/skills/grandchild'));

  const outside = await mkdtemp(join(tmpdir(), 'xfx-cwd-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideDir = join(outside, '.agents', 'skills', 'outside'); await mkdir(outsideDir, { recursive: true }); const outsidePath = join(outsideDir, 'SKILL.md'); await writeFile(outsidePath, 'outside');
  const denied = createResourceProvenance({ workspace: f.workspace });
  await denied.observeCatalog([{ id: '9123456789abcdef01234567', name: 'outside', path: outsidePath, origin: 'repository', scope: 'project' }], { cwd: outside });
  assert.equal(denied.snapshot().counts.omitted, 1);
  assert.equal(denied.snapshot().omissionReasons['outside-approved-root'], 1);
});
