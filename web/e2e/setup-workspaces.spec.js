import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';

for (const theme of ['light', 'dark']) {
  test(`setup evidence, comparison and selected copying in ${theme}`, async ({ browser }, testInfo) => {
    const provider = createDemoProvider();
    const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const capture = name => page.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`), fullPage: true, animations: 'disabled' });
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(server.launchUrl);
      await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
      await page.goto(`${server.origin}/profiles/Default/setup?client=codex`);
      await page.getByRole('button', { name: 'Inspect model source', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Hide model source', exact: true })).toBeFocused();
      await capture('inspection');
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capture('inspection-narrow');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${server.origin}/compare/setups?a=baseline&b=strict-review`);
      await page.getByRole('searchbox', { name: 'Find an item' }).fill('model_reasoning_effort');
      await expect(page.getByRole('complementary').getByRole('heading', { name: 'model_reasoning_effort', exact: true })).toBeVisible();
      await expect(page.locator('h1')).toHaveClass('sr-only');
      await capture('comparison');
      const same = page.getByRole('group', { name: 'Filter results', exact: true }).getByRole('button', { name: /Same/ });
      await page.getByRole('searchbox', { name: 'Find an item' }).clear();
      await same.click();
      await expect(same).toHaveAttribute('aria-pressed', 'true');
      await capture('comparison-filter');
      await page.getByRole('button', { name: 'All items', exact: true }).click();
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capture('comparison-narrow');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${server.origin}/compare/setups?a=Default&b=Default&bClient=claude-code`);
      await expect(page.getByRole('region', { name: 'Setup comparison', exact: true })).toBeVisible();
      await expect(page.getByRole('group', { name: 'Filter results' }).getByRole('button', { name: 'Name matches' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Copy from|Preview copying/ })).toHaveCount(0);
      await capture('mixed-inventories');
      await page.goto(`${server.origin}/profiles/strict-review/copy?from=baseline`);
      const summary = page.getByRole('region', { name: 'Selected changes', exact: true });
      const agents = page.getByRole('checkbox', { name: /AGENTS.md/ });
      await expect(summary).toContainText('0 of 4 items selected');
      await agents.focus();
      await page.keyboard.press('Space');
      await expect(summary).toContainText('1 of 4 items selected');
      await expect(summary.getByRole('list')).toHaveText('AGENTS.md');
      await capture('copy-selected');
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capture('copy-narrow');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('button', { name: 'Apply 1 change to strict-review', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Undo this copy', exact: true })).toBeVisible();
      await capture('copy-result');
      await page.getByRole('button', { name: 'Try undo after a later edit (demo)', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Can’t undo safely');
      await capture('undo-refused');
      await page.getByRole('button', { name: 'Undo this copy', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Undone', exact: true })).toBeVisible();
      await capture('copy-undone');
    } finally { await page.close(); await server.close(); }
  });
}
