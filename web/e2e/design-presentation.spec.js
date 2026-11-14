import { test, expect } from './fixtures.js';

for (const theme of ['light', 'dark']) {
  test(`setup evidence retains side identity and visible filter selection in ${theme}`, async ({ app, page }, testInfo) => {
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
    expect((await page.getByRole('combobox', { name: 'Theme' }).boundingBox()).height).toBeGreaterThanOrEqual(40);
    await page.goto(`${app.origin}/compare/setups?a=baseline&b=strict-review`);
    await page.getByRole('button', { name: /Different model_reasoning_effort/ }).click();
    for (const control of await page.getByRole('group', { name: 'Which items to list' }).getByRole('button').all()) {
      expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(40);
    }
    const detail = page.getByRole('complementary');
    const sideColors = await page.locator('.chip .side-a, .chip .side-b').evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
    await expect(detail.getByText('medium', { exact: true })).toHaveCSS('color', sideColors[0]);
    await expect(detail.getByText('high', { exact: true })).toHaveCSS('color', sideColors[1]);
    const same = page.getByRole('group', { name: 'Summary', exact: true }).getByRole('button', { name: /Same/ });
    await same.click();
    await expect(same).toHaveAttribute('aria-pressed', 'true');
    await expect(same.getByText(/Selected/, { exact: false })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Find an item' }).fill('cli_auth_credentials_store');
    const muted = await page.locator('.hint').first().evaluate(element => getComputedStyle(element).color);
    await expect(detail.getByText('file', { exact: true }).first()).toHaveCSS('color', muted);
    for (const width of [1280, 800, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`setup-${theme}-${width}.png`), fullPage: true });
    }
  });

  test(`report presents conditions and coverage before responses with solid keyboard focus in ${theme}`, async ({ page }, testInfo) => {
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
    await page.getByRole('link', { name: /^Use existing sessions/ }).click();
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
    for (const width of [1280, 800, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`report-${theme}-${width}.png`), fullPage: true });
    }
  });
}
