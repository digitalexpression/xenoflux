import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { snapshotAuditProfileSettings, compareAuditProfileSettings, auditSettingsIdentity } from '../src/audit-profile.js';

const bucket = '11111111-1111-4111-8111-111111111111_22222222-2222-4222-8222-222222222222';
const manifestText = JSON.stringify({ lastUpdated: 1, skills: [{ name: 'pkg', skillId: 'fixture',
  userInvocable: true, disableModelInvocation: false }], unknownActivation: 'aaaa' });
async function fixture(t, { marker = true, withManifest = true } = {}) {
  const root = await mkdtemp('/private/tmp/xfx-native-sync-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'config'), userHome = join(root, 'user'), cwd = join(root, 'repo');
  const synced = join(home, 'skills', 'synced'), container = join(synced, bucket), skill = join(container, 'pkg');
  for (const path of [home, userHome, cwd, synced, container, skill]) await mkdir(path, { recursive: true, mode: 0o700 });
  const ownership = join(synced, '.bucket-' + bucket), manifest = join(container, 'manifest.json');
  const stamp = join(container, '.last-complete-round');
  if (marker) await writeFile(ownership, '', { mode: 0o600 });
  if (withManifest) await writeFile(manifest, manifestText, { mode: 0o600 });
  await writeFile(join(skill, 'SKILL.md'), '# Fixture\n', { mode: 0o600 });
  const profile = { client: 'claude-code', executionMode: 'profile', home, userHome, cwd, nativeRoot: root };
  const snap = () => snapshotAuditProfileSettings(profile);
  return { root, home, cwd, synced, container, skill, ownership, manifest, stamp, profile, snap };
}
const same = (before, after) => {
  assert.equal(after.status, 'ready');
  assert.deepEqual(auditSettingsIdentity(after), auditSettingsIdentity(before));
  assert.equal(compareAuditProfileSettings(before, after).status, 'unchanged');
};
const changed = (before, after, logical) => {
  assert.equal(after.status, 'ready');
  assert.notDeepEqual(auditSettingsIdentity(after), auditSettingsIdentity(before));
  assert.equal(compareAuditProfileSettings(before, after).status, 'changed');
  if (logical) assert.ok(compareAuditProfileSettings(before, after).changedPaths.some(path => path.endsWith(logical)));
};

test('validated sync metadata uses v2 and tolerates touches, equal atomic rewrites and round stamps', async t => {
  const f = await fixture(t), before = await f.snap();
  assert.equal(auditSettingsIdentity(before).algorithm, 'sha256-settings-metadata-v2');
  await utimes(f.manifest, new Date(1000), new Date(2000));
  same(before, await f.snap());
  await writeFile(f.manifest + '.replacement', await readFile(f.manifest), { mode: 0o600 });
  await rename(f.manifest + '.replacement', f.manifest);
  same(before, await f.snap());
  await writeFile(f.stamp, 'round-fixture skills', { mode: 0o600 });
  same(before, await f.snap());
  await utimes(f.stamp, new Date(3000), new Date(4000));
  same(before, await f.snap());
  await rm(f.stamp);
  same(before, await f.snap());
});

test('manifest bytes, unknown fields, permissions and actual resources stay protected', async t => {
  for (const kind of ['same-size', 'invocation', 'mode', 'skill', 'nested-manifest', 'nested-stamp']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      const nested = kind === 'nested-manifest' ? 'manifest.json' : '.last-complete-round';
      if (kind.startsWith('nested')) await writeFile(join(f.skill, nested), 'before', { mode: 0o600 });
      const before = await f.snap();
      if (kind === 'same-size') {
        const next = manifestText.replace('aaaa', 'bbbb');
        assert.equal(Buffer.byteLength(next), Buffer.byteLength(manifestText));
        await writeFile(f.manifest, next);
      } else if (kind === 'invocation') {
        await writeFile(f.manifest, manifestText.replace('"userInvocable":true', '"userInvocable":false'));
      } else if (kind === 'mode') await chmod(f.manifest, 0o644);
      else if (kind === 'skill') await writeFile(join(f.skill, 'SKILL.md'), '# Changed fixture\n');
      else await writeFile(join(f.skill, nested), 'changed contents');
      changed(before, await f.snap());
    });
  }
});

test('only the exact marked config-root bucket receives the exception', async t => {
  const f = await fixture(t, { marker: false }), before = await f.snap();
  assert.equal(auditSettingsIdentity(before).algorithm, 'sha256-file-stat-metadata-v1');
  await utimes(f.manifest, new Date(5000), new Date(6000));
  changed(before, await f.snap(), 'manifest.json');
  const project = join(f.cwd, '.claude', 'skills', 'synced', bucket);
  await mkdir(project, { recursive: true, mode: 0o700 });
  await writeFile(join(project, '..', '.bucket-' + bucket), '', { mode: 0o600 });
  await writeFile(join(project, 'manifest.json'), manifestText, { mode: 0o600 });
  const projectBefore = await f.snap();
  assert.equal(auditSettingsIdentity(projectBefore).algorithm, 'sha256-file-stat-metadata-v1');
  await utimes(join(project, 'manifest.json'), new Date(7000), new Date(8000));
  changed(projectBefore, await f.snap());
});

test('missing-to-populated skills is a real setup change; no manifest means stat-only v1', async t => {
  const f = await fixture(t, { withManifest: false });
  assert.equal(auditSettingsIdentity(await f.snap()).algorithm, 'sha256-file-stat-metadata-v1');
  await rm(join(f.home, 'skills'), { recursive: true });
  const before = await f.snap();
  await mkdir(join(f.home, 'skills'), { mode: 0o700 });
  await writeFile(join(f.home, 'skills', 'SKILL.md'), '# New fixture', { mode: 0o600 });
  changed(before, await f.snap());
});

test('ambiguous containers, unsafe ownership markers and unsafe stamp types fail closed', async t => {
  for (const kind of ['container-skill', 'marker-link', 'marker-mode', 'stamp-link', 'stamp-directory']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      if (kind === 'container-skill') await writeFile(join(f.container, 'SKILL.md'), '# Actual package', { mode: 0o600 });
      else if (kind === 'marker-mode') await chmod(f.ownership, 0o622);
      else if (kind === 'stamp-directory') await mkdir(f.stamp, { mode: 0o700 });
      else {
        const target = kind === 'marker-link' ? f.ownership : f.stamp;
        await rm(target, { force: true });
        await symlink(join(f.skill, 'SKILL.md'), target);
      }
      assert.equal((await f.snap()).status, 'unavailable');
    });
  }
});

test('malformed, oversized, linked and unstable sync manifests fail closed', async t => {
  for (const kind of ['json', 'array', 'schema', 'oversize', 'link', 'replacement']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      if (kind === 'json') await writeFile(f.manifest, '{not-json');
      else if (kind === 'array') await writeFile(f.manifest, '[]');
      else if (kind === 'schema') await writeFile(f.manifest, '{"skills":"not-an-array"}');
      else if (kind === 'oversize') await truncate(f.manifest, 1024 * 1024 + 1);
      else if (kind === 'link') {
        await rm(f.manifest);
        await symlink(join(f.skill, 'SKILL.md'), f.manifest);
      } else {
        const original = fsPromises.open;
        let replaced = false;
        const mocked = t.mock.method(fsPromises, 'open', async (...args) => {
          if (args[0] === f.manifest && !replaced) {
            replaced = true;
            await writeFile(f.manifest + '.new', manifestText, { mode: 0o600 });
            await rename(f.manifest + '.new', f.manifest);
          }
          return original(...args);
        });
        syncBuiltinESMExports();
        try { assert.equal((await f.snap()).status, 'unavailable'); assert.equal(replaced, true); }
        finally { mocked.mock.restore(); syncBuiltinESMExports(); }
        return;
      }
      assert.equal((await f.snap()).status, 'unavailable');
    });
  }
});
