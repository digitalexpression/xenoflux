import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test, expect } from './fixtures.js';

async function put(root, path, content) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600 });
  return target;
}

async function showAll(page, origin, a, b) {
  await page.goto(`${origin}/compare/setups?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  await expect(page.getByRole('searchbox', { name: 'Find an item' })).toBeVisible();
  const everything = page.getByRole('button', { name: 'Everything', exact: true });
  if (await everything.count()) await everything.click();
}

test('all three pairs compare large and binary package files, retain true unknowns and follow the selected owner', async ({ app, page }) => {
  const defaultHome = join(app.defaultUserHome, '.codex');
  const homes = [defaultHome, app.homes.baseline.home, app.homes.strict.home];
  const paths = [app.store.file];
  const large = 'reference text\n'.repeat(45000);
  const outside = join(app.root, 'outside-skill');
  await put(outside, 'SKILL.md', 'Outside the selected skill boundary.\n');
  for (const [index, home] of homes.entries()) {
    paths.push(await put(home, 'skills/full-package/SKILL.md', 'Compare all package files.\n'));
    paths.push(await put(home, 'skills/full-package/references/large.txt', `${large}${index === 2 ? 'changed tail' : 'same tail'}`));
    const bytes = Buffer.alloc(4096, 0); bytes[4095] = index === 2 ? 2 : 1;
    paths.push(await put(home, 'skills/full-package/assets/sample.bin', bytes));
    await symlink(outside, join(home, 'skills/unsafe-source'));
    const version = `v${index + 1}`;
    const base = `plugins/cache/market/versioned/${version}`;
    await put(home, `${base}/plugin.json`, '{"name":"versioned","version":"1.0"}');
    await put(home, `${base}/skills/versioned-skill/SKILL.md`, 'Same skill across cache versions.\n');
    for (const plugin of ['owner-a', 'owner-b']) {
      const root = `plugins/cache/market/${plugin}/${version}`;
      await put(home, `${root}/plugin.json`, JSON.stringify({ name: plugin, version: '1.0' }));
      await put(home, `${root}/skills/shared-tool/SKILL.md`, `Owned by ${plugin}.\n`);
      await put(home, `${root}/skills/shared-tool/reference.txt`, `${plugin}: ${index === 2 && plugin === 'owner-b' ? 'changed owner-b evidence' : 'unchanged evidence'}\n`);
    }
  }
  const before = await Promise.all(paths.map(path => readFile(path)));
  for (const [a, b, same] of [['Default', 'baseline', true], ['Default', 'strict-review', false], ['baseline', 'strict-review', false]]) {
    await showAll(page, app.origin, a, b);
    const row = page.locator('section[aria-labelledby="group-skills"] li button').filter({ hasText: 'full-package' }).filter({ has: page.getByText('Profile', { exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(same ? 'Same' : 'Different');
    await row.click();
    await page.getByRole('complementary').getByRole('link', { name: 'Open package files' }).click();
    expect(new URL(page.url()).searchParams.get('item')).toBeTruthy();
    await expect(page.getByText('All discovered file bytes and file permissions were compared on both sides. Text previews have separate limits.')).toBeVisible();
    for (const path of ['references/large.txt', 'assets/sample.bin']) {
      const file = page.locator('article').filter({ has: page.getByRole('heading', { name: path, exact: true }) });
      await expect(file).toContainText(same ? 'Full file bytes and file permissions match' : 'Full file contents differ');
    }
    await showAll(page, app.origin, a, b);
    const versioned = page.locator('section[aria-labelledby="group-skills"] li button').filter({ hasText: 'versioned-skill' });
    await expect(versioned).toHaveCount(1);
    await expect(versioned).toContainText('Same');
    const unknown = page.locator('section[aria-labelledby="group-skills"] li button').filter({ hasText: 'unsafe-source' }).filter({ has: page.getByText('Profile', { exact: true }) });
    await expect(unknown).toContainText('Could not compare');
  }
  await showAll(page, app.origin, 'baseline', 'strict-review');
  const owner = page.locator('section[aria-labelledby="group-skills"] li button').filter({ hasText: 'shared-tool' }).filter({ hasText: 'owner-b@market' });
  await expect(owner).toHaveCount(1);
  await owner.click();
  await page.getByRole('complementary').getByRole('link', { name: 'Open package files' }).click();
  await expect(page.locator('p.meta')).toContainText('owner-b@market');
  await expect(page.locator('article').filter({ has: page.getByRole('heading', { name: 'reference.txt', exact: true }) })).toContainText('changed owner-b evidence');
  await expect(page.getByRole('heading', { name: 'Make one side match?' })).toHaveCount(0);
  await page.setViewportSize({ width: 640, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before);
});
