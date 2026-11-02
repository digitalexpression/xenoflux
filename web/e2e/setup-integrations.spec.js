import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { test, expect } from './fixtures.js';

async function put(root, path, content) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600 });
  return target;
}

test('one integration row retains configuration, cache, shared machine source and keyboard inspection', async ({ app, page }) => {
  const defaultHome = join(app.defaultUserHome, '.codex');
  const paths = [app.store.file,
    await put(defaultHome, 'config.toml', '[mcp_servers.codebase-memory-mcp]\nenabled = true\n[plugins."codex-security@openai-curated"]\nenabled = false\n'),
    await put(app.homes.strict.home, 'config.toml', '[plugins."code-review@openai-bundled"]\nenabled = true\n')];
  await put(defaultHome, 'plugins/cache/openai-curated/codex-security/revision/.codex-plugin/plugin.json', '{"name":"codex-security","version":"0.1.10"}');
  await put(app.homes.strict.home, 'plugins/cache/openai-bundled/code-review/revision/.codex-plugin/plugin.json', '{"name":"code-review","version":"26.1007.30912"}');
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  await page.goto(`${app.origin}/compare/setups?a=Default&b=strict-review`);
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Find an item' });
  const detail = page.getByRole('complementary');
  for (const name of ['codebase-memory-mcp', 'codex-security@openai-curated', 'code-review@openai-bundled']) {
    await search.fill(name);
    const row = page.locator('li button').filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(detail.getByRole('heading', { level: 2 })).toHaveText(name);
    const inspect = detail.getByRole('button', { name: 'Inspect source evidence', exact: true });
    // Disclosure state can persist when selecting another row.
    if (await inspect.count()) {
      await inspect.focus();
      await page.keyboard.press('Enter');
    }
    await expect(detail.getByRole('heading', { level: 3, name: /Configuration/ })).toBeVisible();
    if (name === 'codebase-memory-mcp') {
      await expect(detail).not.toContainText('no corroborating record');
      await expect(detail).toContainText('Default · Profile');
      await expect(detail).toContainText('strict-review · User');
    } else {
      await expect(detail.getByRole('heading', { level: 3, name: /Cached package/ })).toBeVisible();
      await expect(detail).toContainText(name === 'code-review@openai-bundled' ? '26.1007.30912' : '0.1.10');
    }
  }
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(detail.getByRole('heading', { name: /Cached package/, level: 3 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Swap the two profiles' }).click();
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find an item' }).fill('codebase-memory-mcp');
  await expect(page.locator('li button').filter({ hasText: 'codebase-memory-mcp' })).toHaveCount(1);
  await page.reload();
  await page.getByRole('searchbox', { name: 'Find an item' }).fill('code-review@openai-bundled');
  await expect(page.locator('li button').filter({ hasText: 'code-review@openai-bundled' })).toHaveCount(1);
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
});

test('local settings expose nested values and integration definitions with source limits kept separate', async ({ app, page }) => {
  const paths = [app.store.file];
  for (const [home, setting] of [[app.homes.baseline.home, false], [app.homes.strict.home, true]]) {
    paths.push(await put(home, 'config.toml', `
allow_symlinked_codex_home = true
[desktop]
notifications = ${setting}
[custom_provider]
api_key = "fixture-local-setting"
[mcp_servers.reader]
command = "/opt/example/reader"
args = ["--mode", "local"]
[mcp_servers.reader.env]
CUSTOM_TOKEN = "fixture-env-value"
`));
  }
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  await page.goto(`${app.origin}/compare/setups?a=baseline&b=strict-review`);
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Find an item' });
  const detail = page.getByRole('complementary');
  await search.fill('desktop');
  await page.locator('li button').filter({ hasText: 'desktop' }).click();
  await expect(detail.locator('.edge-a')).toContainText('"notifications": false');
  await expect(detail.locator('.edge-b')).toContainText('"notifications": true');
  await expect(detail).not.toContainText('Value not shown');
  await search.fill('custom_provider');
  await page.locator('li button').filter({ hasText: 'custom_provider' }).click();
  await expect(detail).toContainText('fixture-local-setting');
  await search.fill('reader');
  await page.locator('li button').filter({ hasText: 'reader' }).click();
  await detail.getByRole('button', { name: 'Inspect source evidence', exact: true }).click();
  await expect(detail).toContainText('/opt/example/reader');
  await expect(detail).toContainText('fixture-env-value');
  await expect(detail).toContainText('"--mode"');
  await expect(detail).not.toContainText('undisclosed values');
  await detail.getByRole('button', { name: 'Where it’s set and what we know' }).click();
  await expect(detail).toContainText('Not known from setup alone');
  await page.getByRole('button', { name: 'Show sources', exact: true }).click();
  const configRow = page.getByRole('row').filter({ hasText: 'Profile config' });
  await expect(configRow).toContainText('Read in full');
  await page.setViewportSize({ width: 640, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before);
});

test('shared physical and combined Default roots compare across all profile pairs without losing source provenance', async ({ app, page }) => {
  const defaultCodex = join(app.defaultUserHome, '.codex');
  const baselineUserCodex = join(app.homes.baseline.userHome, '.codex');
  const strictUserCodex = join(app.homes.strict.userHome, '.codex');
  const files = [app.store.file,
    await put(defaultCodex, 'config.toml', 'model = "fixture-default"\n[plugins.reader]\nenabled = true\n'),
    await put(defaultCodex, 'AGENTS.override.md', 'Shared machine instruction.\n'),
    await put(baselineUserCodex, 'config.toml', 'model = "fixture-baseline-user"\n[plugins.reader]\nenabled = true\n'),
    await put(baselineUserCodex, 'AGENTS.override.md', 'Shared machine instruction.\n'),
    await put(strictUserCodex, 'config.toml', 'model = "fixture-strict-user"\n[plugins.reader]\nenabled = true\n'),
    await put(strictUserCodex, 'AGENTS.override.md', 'Different strict instruction.\n')];
  const before = await Promise.all(files.map(path => readFile(path, 'utf8')));

  const comparison = async (a, b) => {
    const response = await page.evaluate(async ([left, right]) => {
      const result = await fetch(`/api/compare/setups?a=${encodeURIComponent(left)}&b=${encodeURIComponent(right)}`, {
        headers: { 'x-xenoflux-request': '1' }, credentials: 'same-origin' });
      return { ok: result.ok, body: await result.json() };
    }, [a, b]);
    expect(response.ok, JSON.stringify(response.body)).toBeTruthy();
    return response.body;
  };
  const allItems = value => value.groups.flatMap(group => group.items);
  const byName = (value, name, category, scope) => allItems(value).find(item => item.name === name && item.category === category
    && (!scope || item.scope === scope));

  // Default reads this file as part of its combined Codex home. Named profiles
  // read the corresponding path from their separate user home. The paired value
  // and instruction evidence should therefore be comparable in every direction.
  for (const [a, b, expected] of [
    ['Default', 'baseline', 'fixture-baseline-user'],
    ['Default', 'strict-review', 'fixture-strict-user'],
    ['baseline', 'strict-review', 'fixture-strict-user'],
    ['baseline', 'Default', 'fixture-default'],
  ]) {
    const value = await comparison(a, b);
    const model = byName(value, 'model', 'config', 'User');
    expect(model, `${a} vs ${b} model evidence`).toBeTruthy();
    expect(model.label).toBe('different');
    expect(model.detail.values.find(row => row.side === 'b').value).toBe(expected);
    expect(model.detail.sources.map(source => source.status)).toEqual(['Present', 'Present']);

    const instruction = byName(value, 'AGENTS.override.md', 'instruction', 'User');
    expect(instruction, `${a} vs ${b} instruction evidence`).toBeTruthy();
    expect(instruction.label).toBe(a === 'baseline' && b === 'strict-review' || a === 'Default' && b === 'strict-review'
      ? 'different' : 'same');
    expect(instruction.detail.sources).toHaveLength(2);
    expect(instruction.detail.sources.every(source => source.status === 'Present')).toBe(true);
    if ([a, b].includes('Default')) {
      const missingUserInstruction = byName(value, 'AGENTS.md', 'instruction', 'User');
      expect(missingUserInstruction.label).toBe('different');
      expect(missingUserInstruction.detail.sources.map(source => source.status).sort()).toEqual(['Present', 'missing']);
      expect(missingUserInstruction.detail.sources.every(source => source.where.endsWith('/AGENTS.md'))).toBe(true);
      expect(missingUserInstruction.actions.copy).toBeUndefined();
    }
  }

  // Also exercise the rendered comparison page and its paired source labels.
  await page.goto(`${app.origin}/compare/setups?a=Default&b=baseline`);
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Find an item' });
  const detail = page.getByRole('complementary');
  await search.fill('model');
  await page.locator('li button').filter({ hasText: 'model' }).first().click();
  await expect(detail).toContainText('fixture-default');
  await expect(detail).toContainText('fixture-baseline-user');
  await detail.getByRole('button', { name: 'Where it’s set and what we know' }).click();
  await expect(detail).toContainText('Default · Profile');
  await expect(detail).toContainText('baseline · User');
  expect(await Promise.all(files.map(path => readFile(path, 'utf8')))).toEqual(before);
});
