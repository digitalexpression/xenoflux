import { test, expect } from './fixtures.js';

for (const theme of ['light', 'dark']) {
  test(`setup evidence retains side identity and visible filter selection in ${theme}`, async ({ app, page }, testInfo) => {
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
    expect((await page.getByRole('combobox', { name: 'Theme' }).boundingBox()).height).toBeGreaterThanOrEqual(40);
    await page.goto(`${app.origin}/compare/setups?a=baseline&b=strict-review`);
    await page.getByRole('searchbox', { name: 'Find an item' }).fill('model_reasoning_effort');
    await page.getByRole('button', { name: /Different model_reasoning_effort/ }).click();
    for (const control of await page.getByRole('group', { name: 'Filter results' }).getByRole('button').all()) {
      expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(32);
    }
    const detail = page.getByRole('complementary');
    const sideColors = await page.locator('.setup-compare-profiles .setup-compare-mark').evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
    await expect(detail.getByText('medium', { exact: true })).toHaveCSS('color', sideColors[0]);
    await expect(detail.getByText('high', { exact: true })).toHaveCSS('color', sideColors[1]);
    const same = page.getByRole('group', { name: 'Filter results', exact: true }).getByRole('button', { name: /Same/ });
    await same.click();
    await expect(same).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('searchbox', { name: 'Find an item' }).fill('cli_auth_credentials_store');
    const muted = await page.locator('.hint').first().evaluate(element => getComputedStyle(element).color);
    await expect(detail.getByText('file', { exact: true }).first()).toHaveCSS('color', muted);
    for (const width of [1280, 800, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`setup-${theme}-${width}.png`), fullPage: true });
    }
  });

  test(`comparison hub and report keep keyboard focus visible in ${theme}`, async ({ page }, testInfo) => {
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
    const task = page.getByRole('region', { name: 'Compare a task', exact: true });
    const setups = page.getByRole('region', { name: 'Compare setups', exact: true });
    const saved = page.getByRole('region', { name: 'Saved reports', exact: true });
    const existing = task.getByRole('link', { name: 'Use existing sessions', exact: true });
    await expect(existing).toHaveAttribute('href', '/compare/sessions');
    await expect(existing).toHaveAccessibleDescription(/\S/);
    await expect(task.getByRole('link', { name: 'Run a new task', exact: true })).toHaveAttribute('href', '/runs/new');
    await expect(setups.getByRole('link', { name: 'Choose two profiles', exact: true })).toHaveAttribute('href', '/compare/setups');
    await expect(setups.getByRole('link', { name: 'Inspect a setup', exact: true })).toHaveAttribute('href', '/profiles');
    await expect(saved.getByRole('link', { name: 'Open saved report', exact: true })).toHaveAttribute('href', '/reports/open');
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`comparisons-${theme}-${width}.png`), fullPage: true });
    }
    await page.getByRole('heading', { name: 'Comparisons', level: 1, exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(existing).toBeFocused();
    await expect(existing).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Enter');
    await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Fix the date test');
    await page.getByRole('checkbox', { name: /Fix the date test, baseline, Codex CLI/ }).check();
    await page.getByRole('checkbox', { name: /Fix the date test, strict-review, Codex Desktop/ }).check();
    await page.getByRole('button', { name: 'Compare sessions', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Last recorded response', exact: true })).toBeVisible();
    const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
    expect(headings.indexOf('Conditions')).toBeLessThan(headings.indexOf('Last recorded response'));
    expect(headings.indexOf('What we could not see')).toBeLessThan(headings.indexOf('Last recorded response'));
    for (const target of [page.locator('[data-slot="trace"] button').first()]) {
      await target.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(target).toBeFocused();
      await expect(target).toHaveCSS('outline-style', 'solid');
      await expect(target).toHaveCSS('outline-width', '2px');
      await expect(target).toHaveCSS('outline-offset', '2px');
    }
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`report-${theme}-${width}.png`), fullPage: true });
    }
  });
}
