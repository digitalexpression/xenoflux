import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, lstatSync } from 'node:fs';
import { mkdtemp, lstat, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire } from '../src/metadata.js';

test('atomic metadata acquisition never replaces a competing empty mkdir-first reservation', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xfx-metadata-race-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, '.run-lock');
  let competitor;
  const owner = { runId: 'candidate', toJSON() {
    mkdirSync(path, { mode: 0o700 });
    competitor = lstatSync(path);
    return { runId: 'candidate' };
  } };
  await assert.rejects(acquire(path, owner, true), /locked/);
  const preserved = await lstat(path);
  assert.ok(preserved.isDirectory());
  assert.equal(preserved.ino, competitor.ino);
  assert.equal(preserved.dev, competitor.dev);
  assert.deepEqual(await readdir(path), [], 'competing empty lock remains empty, without candidate owner');
  assert.deepEqual(await readdir(base), ['.run-lock'], 'staging was cleaned without removing competitor');
});
