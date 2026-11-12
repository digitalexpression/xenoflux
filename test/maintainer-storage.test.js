import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkMaintainerStorage } from '../scripts/check-maintainer-storage.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-maintainer-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('public checks work without private context and allow stable maintainer files', async t => {
  const root = await fixture(t);
  assert.deepEqual(await checkMaintainerStorage(root), []);
  const directory = join(root, 'private/maintainer');
  await mkdir(join(directory, 'workflows'), { recursive: true });
  for (const name of ['instructions.md', 'current-work.md', 'evidence-index.md', 'knowledge.md', '.DS_Store', 'workflows/release.md', 'workflows/locate-evidence.py'])
    await writeFile(join(directory, name), 'Stable context or reusable workflow.\n');
  await mkdir(join(root, 'private/work/current-task'), { recursive: true });
  await writeFile(join(root, 'private/work/current-task/output.log'), 'Active output');
  assert.deepEqual(await checkMaintainerStorage(root), []);
});

test('task directories, recovery bundles and hidden workflow artifacts are rejected', async t => {
  const root = await fixture(t);
  const directory = join(root, 'private/maintainer');
  await mkdir(join(directory, 'storage-2026-11-12'), { recursive: true });
  await mkdir(join(directory, 'recovery'));
  await mkdir(join(directory, 'workflows'));
  await writeFile(join(directory, 'recovery/repository.bundle'), 'Task artifact');
  await writeFile(join(directory, 'workflows/output.log'), 'Task artifact');
  await writeFile(join(directory, 'workflows/run-2026-11-12.md'), 'Dated task report');
  await writeFile(join(directory, 'workflows/results.md'), 'Undated task report');
  const errors = (await checkMaintainerStorage(root)).join('\n');
  for (const name of ['storage-2026-11-12', 'recovery', 'output.log', 'run-2026-11-12.md', 'results.md']) assert.ok(errors.includes(name), name);
  assert.match(errors, /private\/work\/.*private\/archive\//);
});

test('symlinks cannot conceal artifacts under stable names', async t => {
  const root = await fixture(t);
  const directory = join(root, 'private/maintainer');
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, 'output.log'), 'Artifact');
  await symlink(join(root, 'output.log'), join(directory, 'instructions.md'));
  assert.match((await checkMaintainerStorage(root)).join('\n'), /instructions\.md/);
});
