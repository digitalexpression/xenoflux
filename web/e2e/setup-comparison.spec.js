import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from './fixtures.js';

test('setup filters select a matching detail and report the visible item count', async ({ app, page }) => {
  await page.goto(`${app.origin}/compare/setups?a=baseline&b=strict-review`);
  const search = page.getByRole('searchbox', { name: 'Find an item' });
  const detail = page.getByRole('complementary', { name: 'Inspector' });
  const filters = page.getByRole('group', { name: 'Filter results' });
  await search.fill('model_reasoning_effort');
  await page.getByRole('button', { name: /Different model_reasoning_effort/ }).click();
  await search.fill('AGENTS.md');
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('AGENTS.md');
  await expect(page.getByRole('button', { name: /Different AGENTS.md/ })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('region', { name: 'Settings', exact: true })).toHaveCount(0);
  await search.fill('no-matching-item');
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('No item selected');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();

  for (const label of ['Different', 'Same']) {
    const filter = filters.getByRole('button', { name: label, exact: true });
    await filter.click();
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status')).toHaveText(/^\d+ items?$/);
    const selected = page.locator('li > button[aria-current="true"]');
    await expect(selected).toHaveAccessibleName(new RegExp('^' + label + ' '));
    await expect(detail.getByRole('heading', { level: 2 })).toHaveText(await selected.locator('.setup-compare-result-name strong').innerText());
  }
  await filters.getByRole('button', { name: 'All items', exact: true }).click();
  await expect(filters.getByRole('button', { name: 'All items', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

for (const width of [390, 800]) {
  test(`setup details open in a sheet and restore row focus at ${width}px`, async ({ app, page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${app.origin}/compare/setups?a=baseline&b=strict-review`);
    await page.getByRole('button', { name: /^Instructions, agents and rules/ }).click();
    const row = page.getByRole('button', { name: /Different AGENTS.md/ });
    await row.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Inspector' });
    const heading = sheet.getByRole('heading', { name: 'AGENTS.md', exact: true });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await row.press('Enter');
    await expect(sheet).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'AGENTS.md' })).toBeVisible();
    await page.setViewportSize({ width, height: 844 });
    await expect(sheet).toBeHidden();
  });
}

test('setup detail does not offer copying an item absent from the source', async ({ app, page }) => {
  await page.goto(`${app.origin}/compare/setups?a=Default&b=baseline`);
  await page.getByRole('searchbox', { name: 'Find an item' }).fill('config.toml');
  const detail = page.getByRole('complementary');
  await expect(detail).toContainText('Not present');
  await expect(detail.getByRole('link', { name: /Copy from/ })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Find an item' }).fill('AGENTS.md');
  await expect(detail.getByRole('link', { name: 'Copy from Default into baseline…', exact: true })).toBeVisible();
});

test('collapsing a same-client category preserves its content diff and copy action', async ({ app, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${app.origin}/compare/setups?a=baseline&b=strict-review`);
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: /^Settings/ }).click();
  await expect(settings.getByRole('button', { name: /Different model_reasoning_effort/ })).toContainText('medium');
  await expect(settings.getByRole('button', { name: /Different model_reasoning_effort/ })).toContainText('high');
  const instructions = page.getByRole('button', { name: /^Instructions, agents and rules/ });
  await expect(instructions).toHaveAttribute('aria-expanded', 'false');
  await instructions.press('Enter');
  const row = page.getByRole('button', { name: /Different AGENTS.md/ });
  await row.click();
  const detail = page.getByRole('complementary', { name: 'Inspector' });
  const diff = detail.getByRole('group', { name: 'Differences in AGENTS.md' });
  await expect(diff).toContainText('Run the test suite before proposing a commit.');
  const copy = detail.getByRole('link', { name: 'Copy from strict-review into baseline…', exact: true });
  const href = await copy.getAttribute('href');
  expect(href).toMatch(/^\/profiles\/baseline\/copy\?from=strict-review&item=./);
  await instructions.press('Space');
  await expect(row).toBeHidden();
  await expect(diff).toBeVisible();
  await expect(copy).toHaveAttribute('href', href);
  await instructions.press('Enter');
  await expect(row).toHaveAttribute('aria-current', 'true');
  await copy.click();
  await expect(page.getByRole('region', { name: 'Selected changes' })).toContainText('AGENTS.md');
});

test('comparison keeps its toolbar and inspector visible when inspecting a row deep in the results', async ({ app, page }) => {
  const root = join(app.homes.strict.home, 'skills');
  for (let index = 0; index < 22; index++) {
    const name = `workspace-skill-${String(index).padStart(2, '0')}`;
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Workspace fixture.\n---\nRun the relevant checks.\n`);
  }
  await page.setViewportSize({ width: 1440, height: 680 });
  await page.goto(`${app.origin}/compare/setups?a=baseline&b=strict-review`);
  const toolbar = page.getByRole('group', { name: 'Comparison toolbar' });
  await expect(toolbar.getByText('Reading limits', { exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Change profiles…' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Refresh setups' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveClass('sr-only');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const results = page.getByRole('region', { name: 'Comparison results' });
  const before = await inspector.boundingBox();
  const actionBefore = await toolbar.boundingBox();
  const row = results.getByRole('button', { name: /Different workspace-skill-21/ });
  await row.scrollIntoViewIfNeeded();
  const scroll = await results.evaluate(element => element.scrollTop);
  expect(scroll).toBeGreaterThan(100);
  await row.click();
  await expect(inspector.getByRole('heading', { name: 'workspace-skill-21' })).toBeInViewport();
  expect(await inspector.boundingBox()).toEqual(before);
  expect(await toolbar.boundingBox()).toEqual(actionBefore);
  expect(await results.evaluate(element => element.scrollTop)).toBe(scroll);
});
