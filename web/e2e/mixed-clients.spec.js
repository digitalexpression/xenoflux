import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createMixedClientFixture, pinnedCheck } from '../../test-support/ui-mixed-client-fixture.js';

test('mixed clients expose native choices and keep path and command decisions separate', async ({ page }) => {
  test.setTimeout(45000);
  const app = await createMixedClientFixture();
  try {
    await writeFile(app.copilotConfig, JSON.stringify({ label: 'Copilot fixture', storedText: 'Stored Copilot answer.' }), { mode: 0o600 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('xenoflux-theme', 'dark'));
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Run a new task' }).click();
    await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Read the pinned disposable fixture.');
    await page.getByRole('combobox', { name: /First · left side/ }).selectOption({ label: 'Copilot managed · Copilot CLI' });
    await page.getByRole('combobox', { name: /Second · right side/ }).selectOption({ label: 'Claude managed · Claude Code' });
    const refresh = page.getByRole('button', { name: 'Refresh models' });
    await refresh.first().click();
    await expect(page.getByRole('option', { name: 'Auto · Copilot routing' })).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Model ID' }).first().selectOption('auto');
    await page.getByRole('combobox', { name: 'Permission mode' }).first().selectOption('manual');
    await expect(page.getByRole('combobox', { name: 'Permission mode' }).last().locator('option')).toHaveCount(1);
    await page.getByRole('button', { name: 'Add a check command' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Pinned fixture input');
    await page.getByRole('textbox', { name: 'Command you already use' }).fill(pinnedCheck);
    await page.getByRole('button', { name: 'Review before starting' }).click();
    await expect(page.getByText('These sides use different native permission rules.')).toBeVisible();
    await expect(page.getByText(/Pinned commit:/)).toBeVisible();
    await page.getByRole('button', { name: 'Start 2 model runs' }).first().click();
    const path = page.getByRole('region', { name: 'Native request' }).filter({ hasText: 'requests path access' });
    const command = page.getByRole('region', { name: 'Native request' }).filter({ hasText: 'requests command execution' });
    const approve = path.getByRole('button', { name: 'Approve once' });
    await expect(approve).toBeEnabled();
    await expect(command.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await approve.focus();
    await page.keyboard.press('Enter');
    await expect(path).toHaveCount(0);
    await command.getByRole('button', { name: 'Reject' }).click();
    await page.getByRole('link', { name: 'Open the report' }).click();
    await expect(page.getByText('Copilot Auto · repeating this pair may route to different models.')).toBeVisible();
    await expect(page.getByText(/Turn 1 · fixture-routed-model/)).toBeVisible();
    await expect(page.getByText('Pinned fixture input', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Claude fixture completed.', { exact: true }).first()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Inspect session', exact: true }).first().click();
    await expect(page.getByText(/Retained xfx capture/).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Session timeline', exact: true })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Right timeline', exact: true })).toHaveCount(0);
  } finally { await app.close(); }
});

test('profile-bound native sessions and mixed setup inventories remain usable in a narrow light layout', async ({ page }) => {
  const app = await createMixedClientFixture();
  try {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.addInitScript(() => localStorage.setItem('xenoflux-theme', 'light'));
    await page.goto(app.url);
    await page.goto(app.origin + '/compare/setups?a=Claude+managed&b=baseline&aClient=claude-code');
    await expect(page.getByText('Separate setup inventories')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Claude managed · Claude Code/ }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /baseline · Codex/ }).first()).toBeVisible();
    await page.goto(app.origin + '/compare/setups?a=Claude+managed&b=Default&aClient=claude-code&bClient=claude-code');
    await expect(page.getByRole('link', { name: 'Preview copying selected settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Could not compare settings.json/ }).first()).toBeVisible();
    await page.goto(app.origin + '/compare/sessions');
    await page.getByRole('link', { name: 'Choose recent sessions by profile' }).click();
    await page.getByRole('combobox', { name: 'Left profile' }).selectOption('claude-code:Claude managed');
    await page.getByRole('combobox', { name: 'Right profile' }).selectOption('copilot:Copilot managed');
    await expect(page.getByRole('radio')).toHaveCount(0);
    await page.getByRole('button', { name: 'List recent sessions' }).first().click();
    await page.getByRole('button', { name: 'List recent sessions' }).last().click();
    const claude = page.getByRole('radio', { name: /Private Claude list title/ });
    const copilot = page.getByRole('radio', { name: /Private Copilot list title/ });
    await claude.focus();
    await page.keyboard.press('Space');
    await expect(claude).toBeChecked();
    await copilot.check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Compare selected sessions' }).click();
    await expect(page.getByRole('heading', { name: 'Imported native sessions' })).toBeVisible();
    await expect(page.getByText(/Import read context · Copilot managed · CLI · managed root · local/)).toBeVisible();
    await expect(page.getByText(/Private Claude list title/)).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally { await app.close(); }
});
