import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPackagedDocs } from '../scripts/check-docs.mjs';

test('packaged docs reject omitted local targets and broken headings, ignoring example code and remote URLs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-docs-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), '[Guide](docs/guide.md#safe-copy)\n[Web](https://example.invalid/)\n```md\n[Example](missing.md)\n```\n');
  await writeFile(join(root, 'docs/guide.md'), '# Safe copy\n[Home](../README.md)\n');
  assert.deepEqual(await checkPackagedDocs(root, ['README.md', 'docs/guide.md']), []);
  assert.match((await checkPackagedDocs(root, ['README.md'])).join('\n'), /target is not packaged/);
  await writeFile(join(root, 'docs/guide.md'), '# Renamed heading\n[Private](../private.md)\n');
  await writeFile(join(root, 'private.md'), 'Present locally but excluded from package.');
  const errors = await checkPackagedDocs(root, ['README.md', 'docs/guide.md']);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /missing heading/);
  assert.match(errors[1], /target is not packaged/);
});
