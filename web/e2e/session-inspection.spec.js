import { test, expect } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createUiBrowserFixture } from '../../test-support/ui-browser-fixture.js';
import { createMixedClientFixture } from '../../test-support/ui-mixed-client-fixture.js';

for (const theme of ['light', 'dark']) {
  test(`one Codex session is inspectable without a second selection in ${theme}`, async ({ page }) => {
    const app = await createUiBrowserFixture();
    try {
      await page.setViewportSize({ width: theme === 'dark' ? 320 : 1280, height: 900 });
      await page.addInitScript(value => localStorage.setItem('xenoflux-theme', value), theme);
      await page.goto(app.url);
      await page.getByRole('link', { name: 'Browse sessions', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Fix the date test');
      await page.getByRole('button', { name: 'Inspect Fix the date test', exact: true }).last().click();
      await expect(page.getByRole('heading', { name: 'Harness and context' })).toBeVisible();
      await expect(page.getByText(/Historical import/, { exact: false }).first()).toBeVisible();
      await expect(page.getByRole('region', { name: 'Session timeline', exact: true })).toHaveCount(1);
      await expect(page.getByRole('region', { name: 'Right timeline', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Turn setting observations (1)' }).click();
      await expect(page.getByText('Model: fixture-model · Effort: medium')).toBeVisible();
      const inspect = page.getByRole('button', { name: 'Inspect selected event', exact: true });
      await inspect.focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Event inspector', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Event inspector' })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const sessionHref = new URL(page.url()).pathname;
      await page.getByRole('link', { name: 'Export session', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Export this report', exact: true })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Include recorded messages and tool content' })).not.toBeChecked();
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const saved = page.getByRole('status', { name: 'Report saved', exact: true });
      await expect(saved).toBeVisible();
      const back = saved.getByRole('link', { name: 'Back to the report', exact: true });
      await expect(back).toHaveAttribute('href', sessionHref);
      await back.click();
      await expect(page).toHaveURL(new RegExp(`${sessionHref}$`));
      await expect(page.getByRole('heading', { name: 'Harness and context', exact: true })).toBeVisible();
    } finally { await app.close(); }
  });
}

for (const [client, profile, title, response] of [
  ['claude-code', 'Claude managed', 'Private Claude list title', 'Stored Claude answer.'],
  ['copilot', 'Copilot managed', 'Private Copilot list title', 'Stored Copilot answer.'],
]) {
  test(`${client} profile opens one partial imported session and freezes its content`, async ({ page }) => {
    test.setTimeout(45000);
    const app = await createMixedClientFixture();
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(app.url);
      await page.goto(`${app.origin}/sessions/native?${new URLSearchParams({ profile, client })}`);
      await expect(page.getByRole('combobox', { name: 'Profile', exact: true })).toHaveValue(`${client}:${profile}`, { timeout: 15000 });
      await page.getByRole('button', { name: 'List recent sessions', exact: true }).click();
      await page.getByRole('button', { name: `Inspect ${title}`, exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Session inspection', exact: true })).toBeVisible();
      const lastResponse = page.getByRole('article', { name: `${profile} last recorded response` });
      await expect(lastResponse.getByText(response, { exact: true })).toBeVisible();
      await expect(lastResponse.getByText(/Completion and final-answer status are unknown/)).toBeVisible();
      await expect(page.getByText('Historical turn settings are unavailable from this source.')).toHaveCount(0);
      await page.getByRole('button', { name: 'Turn setting observations (0)' }).click();
      await expect(page.getByText('Historical turn settings are unavailable from this source.')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Session timeline', exact: true })).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const ref = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1));
      const exported = await app.provider.exportReport({ ref, includeReplayContent: true });
      const file = join(exported.folder, exported.files[1]);
      const text = await readFile(file, 'utf8');
      expect(JSON.parse(text).kind).toBe('audit-run');
      expect(text).toContain(response);
      await rm(client === 'claude-code' ? app.transcript : app.copilotConfig);
      await page.getByRole('link', { name: 'Open saved report', exact: true }).click();
      await page.getByLabel('Choose the report’s JSON file').setInputFiles(resolve(file));
      await page.getByRole('link', { name: 'View report', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Harness and context' })).toBeVisible();
      await expect(page.getByText(/Shown from the frozen report/)).toBeVisible();
      await expect(page.getByText(response, { exact: true }).first()).toBeVisible();
    } finally { await app.close(); }
  });
}

test('leaving a pending inspection keeps the newer page when its response arrives', async ({ page }) => {
  const app = await createUiBrowserFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Browse sessions', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Rare older task');
    await page.route('**/api/sessions/inspect', async route => {
      await gate;
      await route.fulfill({ json: { ref: 'late', href: '/sessions/late' } });
    });
    await page.getByRole('button', { name: 'Inspect Rare older task', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reading session…', exact: true })).toBeDisabled();
    await page.getByRole('link', { name: 'Choose a session by profile', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Choose a session', exact: true })).toBeVisible();
    const response = page.waitForResponse(response => response.url().endsWith('/api/sessions/inspect'));
    release();
    await response;
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(app.origin + '/sessions/native');
  } finally { release(); await app.close(); }
});
