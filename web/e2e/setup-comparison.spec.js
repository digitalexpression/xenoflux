import { test, expect } from './fixtures.js';

test('setup filters select the first matching detail and show their actual scope', async ({ app, page }) => {
  await page.goto(`${app.origin}/compare/setups?a=baseline&b=strict-review`);
  const search = page.getByRole('searchbox', { name: 'Find an item' });
  const detail = page.getByRole('complementary');
  const rows = page.locator('li > button');
  const presets = page.getByRole('group', { name: 'Which items to list' });
  await page.getByRole('button', { name: /Different model_reasoning_effort/ }).click();
  await search.fill('AGENTS.md');
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('AGENTS.md');
  await expect(rows.filter({ hasText: 'AGENTS.md' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0);
  await search.fill('no-matching-item');
  await expect(detail).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(rows.first()).toHaveAttribute('aria-current', 'true');

  for (const label of ['Different', 'Same']) {
    await page.getByRole('group', { name: 'Summary', exact: true }).getByRole('button', { name: new RegExp(label) }).first().click();
    await expect(presets.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(`${label} only`);
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await expect(detail.getByRole('heading', { level: 2 })).toHaveText(await rows.first().locator('.font-mono').innerText());
  }
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  await expect(presets.getByRole('button', { name: 'Everything', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status')).not.toContainText('only');
});

for (const width of [390, 800]) {
  test(`stacked setup details have explicit keyboard navigation at ${width}px`, async ({ app, page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${app.origin}/compare/setups?a=baseline&b=strict-review`);
    const row = page.getByRole('button', { name: /Different AGENTS.md/ });
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(row).toBeFocused();
    const jump = page.getByRole('link', { name: 'View details for AGENTS.md', exact: true });
    await page.keyboard.press('Tab');
    await expect(jump).toBeFocused();
    await page.keyboard.press('Enter');
    const heading = page.getByRole('complementary').getByRole('heading', { name: 'AGENTS.md', exact: true });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    await page.getByRole('link', { name: 'Back to selected item', exact: true }).click();
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
