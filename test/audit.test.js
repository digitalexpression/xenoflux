import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { compareAuditProfiles } from '../src/audit.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
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

test('setup comparison retains private-value uncertainty and shows public changes without inferring absent skills', async t => {
  const f = await fixture(t);
  await put(join(f.native[0].home, 'config.toml'), 'model="model-a"\ncredential_blob="PRIVATE_A"\n');
  await put(join(f.native[1].home, 'config.toml'), 'model="model-b"\ncredential_blob="PRIVATE_B"\n');
  await put(join(f.native[0].home, 'skills', 'solo', 'SKILL.md'), '---\nname: solo\ndescription: one side\n---\n');
  const value = await compareAuditProfiles(f.store, 'A', 'B', f.options);
  assert.ok(value.comparison.resources.changed.some(row => row.name === 'model' && row.left.value === 'model-a' && row.right.value === 'model-b'));
  assert.ok(value.comparison.resources.unavailable.some(row => row.name === 'credential_blob' && row.comparison === 'unknown'));
  assert.ok(value.comparison.resources.unavailable.some(row => row.name === 'solo' && row.comparison === 'unverified-on-right'));
  assert.equal(value.comparison.resources.removed.some(row => row.name === 'solo'), false);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_A|PRIVATE_B/);
  const rendered = renderAudit(value);
  assert.match(rendered, /model-a/); assert.match(rendered, /model-b/);
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

test('frozen reports reject links and invalid schemas and preserve existing Markdown sidecars', async t => {
  const f = await fixture(t), value = { schemaVersion: 1, kind: 'audit-run', id: 'frozen', status: 'partial', profile: {}, coverage: { skills: 'partial' } };
  const original = join(f.root, 'original.json');
  const receipt = await exportAuditReport(value, { output: original });
  assert.deepEqual(await readAuditReport(receipt.evidencePath), value);
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
