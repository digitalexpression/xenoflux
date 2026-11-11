import { test, expect } from '@playwright/test';
import { createUiRunsFixture } from '../../test-support/ui-runs-fixture.js';

test('previews and runs Codex Default versus Claude Code Default through the real controller', async ({ page }) => {
  const fixture = await createUiRunsFixture({ mode: { mixedClaude: true } });
  try {
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Run a new task' }).click();
    await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Compare the disposable fixture.');
    await page.getByRole('combobox', { name: /First · left side/ }).selectOption({ label: 'Codex Default' });
    await page.getByRole('combobox', { name: /Second · right side/ }).selectOption({ label: 'Claude Code Default' });
    await page.getByRole('button', { name: /min per run/ }).click();
    await page.getByRole('textbox', { name: /Codex program/ }).fill(fixture.executable);
    await page.getByRole('button', { name: 'Review before starting' }).click();
    await expect(page.getByText('Ready to start')).toBeVisible();
    await expect(page.getByText('These sides use different native permission rules.', { exact: false })).toBeVisible();
    expect(fixture.calls.captures).toEqual([]);
    await page.getByRole('button', { name: 'Start 2 model runs' }).first().click();
    await expect(page.getByRole('region', { name: 'Tasks completed · evidence partial' })).toBeVisible({ timeout: 15000 });
    expect(fixture.calls.captures).toEqual(['Default']);
    await page.getByRole('link', { name: 'Open the report' }).click();
    await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
    await expect(page.getByText('Claude Code CLI', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Claude fixture completed.', { exact: true }).first()).toBeVisible();
  } finally { await fixture.close(); }
});
