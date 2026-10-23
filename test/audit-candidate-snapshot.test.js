import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink, link, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const snapshot = fileURLToPath(new URL('../test-support/evaluation-isolation/snapshot-candidate.py', import.meta.url));
const acquire = path => spawnSync('/usr/bin/python3', ['-I', '-B', snapshot, path], {
  env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', PYTHONNOUSERSITE: '1' },
  cwd: path, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
});

test('candidate acquisition reads regular bytes without importing modules and rejects path escapes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-snapshot-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), outside = join(root, 'outside');
  await mkdir(workspace, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
  await mkdir(join(workspace, 'src'), { mode: 0o700 });
  const bytes = 'throw new Error("must never import on host");\n';
  await writeFile(join(workspace, 'src/candidate.js'), bytes);
  await writeFile(join(outside, 'secret.txt'), 'SYNTHETIC_OUTSIDE_CONTENT');
  const valid = acquire(workspace);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual((await readdir(workspace)).sort(), ['src']);
  assert.equal(Buffer.from(JSON.parse(valid.stdout)['src/candidate.js'].base64, 'base64').toString(), bytes);
  await rm(join(workspace, 'src'), { recursive: true });
  await symlink(outside, join(workspace, 'src'));
  const escaped = acquire(workspace);
  assert.equal(escaped.status, 1);
  assert.equal(escaped.stdout, '');
  assert.doesNotMatch(escaped.stderr, /SYNTHETIC_OUTSIDE_CONTENT|secret\.txt/);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'SYNTHETIC_OUTSIDE_CONTENT');
});

test('candidate acquisition refuses hardlinks, oversized files and FIFOs before staging', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-snapshot-types-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); await mkdir(workspace, { mode: 0o700 });
  const outside = join(root, 'owned-canary'); await writeFile(outside, 'synthetic');
  await link(outside, join(workspace, 'hardlink'));
  assert.equal(acquire(workspace).status, 1);
  await rm(join(workspace, 'hardlink'));
  await writeFile(join(workspace, 'too-large'), Buffer.alloc(1048577));
  assert.equal(acquire(workspace).status, 1);
  await rm(join(workspace, 'too-large'));
  const fifo = spawnSync('/usr/bin/mkfifo', [join(workspace, 'fifo')], { timeout: 3000 });
  assert.equal(fifo.status, 0);
  const result = acquire(workspace);
  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, '');
});
