import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';

for (const theme of ['light', 'dark']) {
  test(`whole-app navigation and composition in ${theme}`, async ({ browser }, testInfo) => {
    test.setTimeout(90000);
    const provider = createDemoProvider();
    const inspection = await provider.inspectSession({ key: 's1' });
    const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const routes = [
      ['comparisons', '/', 'compare'], ['sessions', '/sessions', 'sessions'],
      ['session-inspection', inspection.href, 'sessions'],
      ['session-export', `/reports/${inspection.ref}/export`, 'sessions'],
      ['native-inspection', '/sessions/native', 'sessions'],
      ['session-picker', '/compare/sessions', 'compare'],
      ['native-comparison', '/compare/sessions/native', 'compare'],
      ['profiles', '/profiles', 'profiles'], ['clients', '/setup', 'setup'],
      ['setup-inspection', '/profiles/Default/setup?client=codex', 'profiles'],
      ['setup-comparison', '/compare/setups?a=baseline&b=strict-review', 'compare'],
      ['mixed-setups', '/compare/setups?a=Default&b=Default&bClient=claude-code', 'compare'],
      ['skill-package', '/compare/setups/skills/review-helper?a=baseline&b=strict-review', 'compare'],
      ['selected-copy', '/profiles/strict-review/copy?from=baseline', 'profiles'],
      ['profile-creation', '/profiles/new?name=visual-profile&client=codex', 'profiles'],
      ['task-preparation', '/runs/new', 'compare'], ['activity', '/activity', 'activity'],
      ['comparison-report', '/reports/demo-run', 'compare'],
      ['reviews', '/reports/demo-run/reviews', 'compare'],
      ['export', '/reports/demo-run/export', 'compare'], ['saved-reports', '/reports/open', 'open'],
      ['not-found', '/missing-page', null],
    ];
    const navigation = { compare: 'Comparisons', sessions: 'Sessions', profiles: 'Profiles', setup: 'Clients on this Mac', open: 'Saved reports' };
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(server.launchUrl);
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
      for (const [name, path, current] of routes) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(`${server.origin}${path}`);
        await page.waitForLoadState('networkidle');
        const heading = page.getByRole('heading', { level: 1 });
        await expect(heading).toHaveCount(1);
        await expect(heading).toBeVisible();
        await expect(heading).toBeFocused();
        await expect(page.getByRole('alert')).toHaveCount(0);
        if (current === 'activity') await expect(page.getByRole('link', { name: 'Activity', exact: true })).toHaveAttribute('aria-current', 'page');
        else if (current) await expect(page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: navigation[current], exact: true }), name).toHaveAttribute('aria-current', 'page');
        const homeCrumb = page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('link', { name: 'Comparisons', exact: true });
        if (await homeCrumb.count()) await expect(homeCrumb).toHaveAttribute('href', '/comparisons');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
        await page.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`), animations: 'disabled' });
        if (['comparisons', 'native-inspection', 'skill-package'].includes(name)) {
          await page.setViewportSize({ width: 320, height: 900 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} narrow`).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`${name}-narrow-${theme}.png`), fullPage: true, animations: 'disabled' });
        }
      }
      await page.getByRole('link', { name: 'Go to Comparisons', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(`${server.origin}/comparisons`);
      await page.getByRole('link', { name: 'Run a new task', exact: true }).click();
      await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Check the same committed source in both profiles.');
      await page.getByRole('button', { name: 'Review before starting', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Review before starting', exact: true })).toBeFocused();
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
      await page.screenshot({ path: testInfo.outputPath(`task-review-${theme}.png`), animations: 'disabled' });
      expect(errors).toEqual([]);
    } finally { await page.close(); await server.close(); }
  });
}
