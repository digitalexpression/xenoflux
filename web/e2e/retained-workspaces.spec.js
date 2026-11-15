import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';
import { createUiBrowserFixture } from '../../test-support/ui-browser-fixture.js';

for (const theme of ['light', 'dark']) {
  test(`review and saved evidence workspaces in ${theme}`, async ({ browser }, testInfo) => {
    const server = await startUiServer({ provider: createDemoProvider(), staticRoot: resolve('dist/ui') });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const capture = async name => {
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
      await page.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`), fullPage: true, animations: 'disabled' });
    };
    let failList = false, failOpen = false;
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.route('**/api/reports/recent', route => failList ? route.fulfill({ status: 503, json: { error: { code: 'fixture', message: 'Synthetic saved list unavailable.' } } }) : route.continue());
      await page.route('**/api/reports/recent/*/open', route => failOpen ? route.fulfill({ status: 404, json: { error: { code: 'fixture', message: 'Synthetic saved location is missing.' } } }) : route.continue());
      await page.goto(server.launchUrl);
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
      await page.goto(`${server.origin}/reports/demo-run/reviews`);
      await expect(page.getByRole('button', { name: 'Preview review', exact: true })).toBeVisible();
      await capture('review-form');
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capture('review-form-narrow');
      await page.setViewportSize({ width: 1440, height: 1000 });
      const previewButton = page.getByRole('button', { name: 'Preview review', exact: true });
      await previewButton.focus(); await page.keyboard.press('Enter');
      const preview = page.getByRole('region', { name: 'Review task preview', exact: true });
      await expect(preview).toBeFocused();
      expect((await preview.boundingBox()).y).toBeLessThan(100);
      await expect(preview).toContainText('Effective prompt (sent unchanged)');
      await capture('review-preview');
      await page.getByRole('button', { name: 'Edit review', exact: true }).click();
      await expect(previewButton).toBeFocused();
      await expect(preview).toHaveCount(0);
      await page.getByLabel('Review prompt').fill('Review this synthetic frozen evidence and explain its limits.');
      await previewButton.click();
      await expect(preview).toBeFocused();
      await page.getByRole('button', { name: 'Start review', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Captured response', exact: true })).toBeVisible();
      await expect(page.getByText(/Demo task result is simulated/)).toBeVisible();
      await capture('review-response');
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Captured response', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Return to review form', exact: true }).click();
      await page.getByRole('link', { name: 'Attached ratings', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Attached ratings', exact: true })).toBeFocused();
      await expect(page.getByText(/The reviewers disagree/)).toBeVisible();
      await capture('review-ratings');
      await page.getByRole('link', { name: 'Saved reports', exact: true }).click();
      const recent = page.getByRole('region', { name: 'Recently saved', exact: true });
      const entry = recent.getByRole('button', { name: /Add CSV export to the report/ });
      await expect(entry).toBeVisible();
      await capture('saved-library');
      failList = true;
      await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
      await expect(recent.getByRole('alert')).toContainText('Synthetic saved list unavailable.');
      await expect(recent).toContainText('Previous list shown. Refresh failed');
      await expect(entry).toBeVisible();
      await capture('saved-list-error');
      failList = false;
      await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
      await expect(recent.getByRole('alert')).toHaveCount(0);
      await entry.focus(); await page.keyboard.press('Enter');
      const opened = page.getByRole('region', { name: 'Saved report Add CSV export to the report', exact: true });
      await expect(opened).toBeFocused();
      await expect(opened).toContainText('shown exactly as saved');
      await capture('saved-opened');
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capture('saved-opened-narrow');
      await page.setViewportSize({ width: 1440, height: 1000 });
      failOpen = true;
      await entry.click();
      await expect(page.getByRole('alert')).toContainText('Synthetic saved location is missing.');
      await expect(page.getByRole('link', { name: 'View report', exact: true })).toHaveCount(0);
    } finally { await page.close(); await server.close(); }
  });

  test(`export inclusion and save result stay explicit in ${theme}`, async ({ browser }, testInfo) => {
    const app = await createUiBrowserFixture();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const capture = async name => {
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
      await page.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`), fullPage: true, animations: 'disabled' });
    };
    let releaseExport;
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(app.url);
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
      await page.goto(`${app.origin}/compare/sessions`);
      await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Fix the date test');
      await page.getByRole('checkbox', { name: /Fix the date test, baseline, Codex CLI/ }).check();
      await page.getByRole('checkbox', { name: /Fix the date test, strict-review, Codex Desktop/ }).check();
      await page.getByRole('checkbox', { name: 'I say these are the same task' }).check();
      await page.getByRole('textbox', { name: 'Task name' }).fill('Fix the date test');
      await page.getByRole('button', { name: 'Compare sessions', exact: true }).click();
      await page.getByRole('link', { name: 'Export report', exact: true }).first().click();
      const content = page.getByRole('checkbox', { name: /^Include recorded messages and tool content/ });
      await expect(content).not.toBeChecked();
      await expect(page.locator('.export-inclusion')).toContainText('Not included');
      await capture('export-default');
      await content.check();
      await expect(page.getByText(/Read both exported files before sharing them\./)).toBeVisible();
      await capture('export-content');
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capture('export-content-narrow');
      await page.setViewportSize({ width: 1440, height: 1000 });
      const gate = new Promise(resolve => { releaseExport = resolve; });
      await page.route('**/api/reports/*/export', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        expect(route.request().postDataJSON()).toMatchObject({ includeReplayContent: true, includeContent: false, prepareReview: false });
        await gate; await route.continue();
      });
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await expect(content).toBeDisabled();
      releaseExport();
      const saved = page.getByRole('status', { name: 'Report saved', exact: true });
      await expect(saved).toBeFocused();
      await expect(saved).toContainText('Both files are in the folder above');
      await capture('export-saved');
    } finally { releaseExport?.(); await page.close(); await app.close(); }
  });
}
