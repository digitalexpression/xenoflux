import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDocumentationPolicy, checkPackagedDocs } from '../scripts/check-docs.mjs';

test('documentation policy requires the repo-only product owner and rejects duplicate owners and misplaced channel notices', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-doc-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  const users = ['README.md', 'docs/INSTALLATION.md', 'docs/GUIDE.md', 'docs/CLI.md'];
  const sources = [...users, 'PRODUCT.md', 'CONTRIBUTING.md', 'docs/CONTRACTS.md'];
  for (const path of sources) await writeFile(join(root, path), '# Document\n');
  assert.deepEqual(await checkDocumentationPolicy(root, sources, [...users, 'node_modules/sdk/README.md']), []);
  assert.match((await checkDocumentationPolicy(root, sources.filter(path => path !== 'PRODUCT.md'), users)).join('\n'), /Missing document owner: PRODUCT\.md/);
  await writeFile(join(root, 'docs/README.md'), '# Duplicate index\n');
  assert.match((await checkDocumentationPolicy(root, [...sources, 'docs/README.md'], users)).join('\n'), /Consolidate docs\/README/);
  for (const path of ['docs/PRODUCT.md', 'ROADMAP.md']) {
    await writeFile(join(root, path), '# Parallel owner\n');
    assert.ok((await checkDocumentationPolicy(root, [...sources, path], users)).includes(`Consolidate ${path} into an existing document owner`));
  }
  assert.match((await checkDocumentationPolicy(root, sources, [...users, 'CONTRIBUTING.md'])).join('\n'), /out of npm/);
  assert.match((await checkDocumentationPolicy(root, sources, [...users, 'PRODUCT.md'])).join('\n'), /Keep contributor\/internal document out of npm: PRODUCT\.md/);
  await writeFile(join(root, 'PRODUCT.md'), '# Beta product\n');
  assert.match((await checkDocumentationPolicy(root, sources, users)).join('\n'), /PRODUCT\.md: channel wording belongs/);
  await writeFile(join(root, 'PRODUCT.md'), '# Product\n');
  await writeFile(join(root, 'docs/GUIDE.md'), '# Beta workflow\n');
  assert.match((await checkDocumentationPolicy(root, sources, users)).join('\n'), /channel wording belongs/);
});

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


test('bundled upstream documentation is outside application link validation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-bundled-docs-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'node_modules', 'fixture'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Application\n');
  await writeFile(join(root, 'node_modules', 'fixture', 'README.md'), '[Upstream development link](not-shipped.md)\n');
  assert.deepEqual(await checkPackagedDocs(root, ['README.md', 'node_modules/fixture/README.md']), []);
});
