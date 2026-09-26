import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controllerLocation } from '../src/storage-location.js';

test('controller defaults to the new location and honors explicit selection', async t => {
  const home = await mkdtemp(join(tmpdir(), 'xfx-location-')); t.after(() => rm(home, { recursive: true, force: true }));
  const next = join(home, '.xfx/controller'), selected = join(home, 'selected');
  assert.equal(await controllerLocation(undefined, null, home), next);
  await mkdir(selected, { recursive: true });
  assert.equal(await controllerLocation(selected, next, home), selected);
  await assert.rejects(controllerLocation('', next, home), /nonempty/);
});
