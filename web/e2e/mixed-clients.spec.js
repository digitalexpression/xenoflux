import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bind } from '../../src/profiles.js';
import { createMixedClientFixture, pinnedCheck } from '../../test-support/ui-mixed-client-fixture.js';

test('switching Codex and Claude scopes model choices to the selected repository without requiring a binding', async ({ page }) => {
  const app = await createMixedClientFixture();
  try {
    const codexOnly = join(app.root, 'codex-only');
    execFileSync('git', ['clone', '-q', '--local', app.repository, codexOnly]);
    await app.store.update(data => bind(data, 'baseline', codexOnly));
    const probes = [];
    page.on('request', request => {
      if (request.url().endsWith('/api/catalog/refresh')) probes.push(request.postDataJSON());
    });

    await page.goto(app.url);
    await page.getByRole('link', { name: 'Run a new task', exact: true }).click();
    const repository = page.getByLabel('Repository', { exact: true });
    const leftProfile = page.getByRole('combobox', { name: /First · left side/ });
    const rightProfile = page.getByRole('combobox', { name: /Second · right side/ });
    const leftModel = page.getByLabel('Model ID · Left', { exact: true });
    const rightModel = page.getByLabel('Model ID · Right', { exact: true });
    await leftProfile.selectOption('baseline');
    await repository.fill(codexOnly);
    await repository.press('Tab');
    await rightProfile.selectOption({ label: 'Claude managed · Claude Code' });
    await expect(page.getByRole('checkbox', { name: 'Load models automatically in this tab', exact: true })).toBeChecked();
    await expect(leftModel.getByRole('option', { name: 'Fixture · fixture', exact: true })).toHaveCount(1);
    await expect(rightModel.getByRole('option', { name: /sonnet/i })).toHaveCount(1);
    expect(probes.some(probe => probe.profile === 'Claude managed' && probe.workspace === codexOnly)).toBe(true);

    await repository.fill(app.repository);
    await repository.press('Tab');
    await leftModel.selectOption('fixture');
    await rightModel.selectOption('sonnet');
    await expect(leftModel.getByRole('option', { name: /sonnet/i })).toHaveCount(0);
    await expect(rightModel.getByRole('option', { name: 'Fixture · fixture', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Swap the two sides', exact: true }).click();
    await expect(leftModel).toHaveValue('sonnet');
    await expect(rightModel).toHaveValue('fixture');
    await leftProfile.selectOption('baseline');
    await expect(leftModel.getByRole('option', { name: 'Fixture · fixture', exact: true })).toHaveCount(1);
    await expect(leftModel.getByRole('option', { name: /sonnet/i })).toHaveCount(0);
    await expect(leftModel).toHaveValue('');
    await expect(rightModel).toHaveValue('fixture');
    await leftProfile.selectOption({ label: 'Claude managed · Claude Code' });
    await expect(leftModel.getByRole('option', { name: /sonnet/i })).toHaveCount(1);
    await expect(leftModel.getByRole('option', { name: 'Fixture · fixture', exact: true })).toHaveCount(0);
    await expect(leftModel).toHaveValue('');
    expect(probes.some(probe => probe.profile === 'Claude managed' && probe.workspace === app.repository)).toBe(true);
  } finally { await app.close(); }
});

test('an unsaved repository loads models and reaches review without adding profile bindings', async ({ page }) => {
  const app = await createMixedClientFixture();
  try {
    const unboundRepo = join(app.root, 'unbound-repository');
    execFileSync('git', ['clone', '-q', '--local', app.repository, unboundRepo]);
    const bindingPosts = [], probes = [], starts = [];
    page.on('request', request => {
      if (request.method() !== 'POST') return;
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/binding')) bindingPosts.push(path);
      if (path === '/api/catalog/refresh') probes.push(request.postDataJSON());
      if (path === '/api/runs') starts.push(path);
    });
    const bindingNames = async () => (await app.store.read()).profiles
      .filter(profile => profile.repositories.some(repo => repo.path === unboundRepo)).map(profile => profile.name).sort();
    const problem = 'Read the disposable repository with both profiles.';
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Run a new task', exact: true }).click();
    const task = page.getByRole('textbox', { name: 'What should both profiles do?' });
    const repository = page.getByLabel('Repository', { exact: true });
    const commit = page.getByLabel('Commit or branch', { exact: true });
    await page.getByRole('combobox', { name: /First · left side/ }).selectOption('baseline');
    await page.getByRole('combobox', { name: /Second · right side/ }).selectOption({ label: 'Claude managed · Claude Code' });
    await repository.fill(unboundRepo);
    await repository.press('Tab');
    await task.fill(problem);
    await expect(page.getByRole('checkbox', { name: 'Load models automatically in this tab', exact: true })).toBeChecked();
    await expect(page.getByLabel('Model ID · Left', { exact: true }).getByRole('option', { name: 'Fixture · fixture', exact: true })).toHaveCount(1);
    await expect(page.getByLabel('Model ID · Right', { exact: true }).getByRole('option', { name: /sonnet/i })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Bind profiles', exact: true })).toHaveCount(0);
    expect([...new Set(probes.filter(probe => probe.workspace === unboundRepo).map(probe => probe.profile))].sort()).toEqual(['Claude managed', 'baseline']);
    await expect(commit).toHaveValue('HEAD');
    await page.getByRole('button', { name: 'Review before starting' }).click();
    await expect(page.getByRole('button', { name: 'Start 2 model runs' })).toBeEnabled();
    await expect(page.getByText(`Pinned commit: ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: unboundRepo, encoding: 'utf8' }).trim()}`, { exact: true })).toBeVisible();
    const projectTrust = page.getByText('Project trust', { exact: true }).locator('..');
    await expect(projectTrust).toContainText('The entries remain after the comparison.');
    await expect(projectTrust.getByText(unboundRepo, { exact: true }).first()).toBeVisible();
    await page.getByRole('link', { name: 'Edit task and source' }).click();
    await expect(task).toHaveValue(problem);
    await expect(repository).toHaveValue(unboundRepo);
    await expect(commit).toHaveValue('HEAD');
    expect(await bindingNames()).toEqual([]);
    expect(bindingPosts).toEqual([]);
    expect(starts).toEqual([]);
  } finally { await app.close(); }
});

test('Claude and Copilot can review and edit approvals and network settings without a Codex side', async ({ page }) => {
  const app = await createMixedClientFixture();
  try {
    await page.addInitScript(() => sessionStorage.setItem('xenoflux-run-auto-load-models', 'false'));
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Run a new task', exact: true }).click();
    await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Inspect the disposable fixture.');
    await page.getByRole('combobox', { name: /First · left side/ }).selectOption({ label: 'Copilot managed · Copilot CLI' });
    await page.getByRole('combobox', { name: /Second · right side/ }).selectOption({ label: 'Claude managed · Claude Code' });

    const approvals = page.getByRole('combobox', { name: 'Approvals', exact: true });
    const network = page.getByRole('checkbox', { name: 'Allow network access', exact: true });
    const limits = page.getByRole('region', { name: 'Execution limits' });
    await expect(approvals.getByRole('option')).toHaveText(['Profile default', 'Ask me', 'Automatic review', 'Autonomous']);
    await expect(network).toBeChecked();
    await approvals.selectOption({ label: 'Automatic review' });
    await page.getByRole('button', { name: 'Review before starting' }).click();
    await expect(page.getByRole('button', { name: 'Start 2 model runs' })).toBeEnabled();
    await expect(limits.getByText(/native automatic review/)).toBeVisible();
    await expect(limits.getByText(/Copilot CLI.*network/)).toBeVisible();
    await expect(limits.getByText(/Claude Code.*profile.*network/)).toBeVisible();

    await page.getByRole('link', { name: 'Edit checks and limits' }).click();
    await expect(approvals).toHaveValue('auto_review');
    await expect(network).toBeChecked();
    await approvals.selectOption({ label: 'Autonomous' });
    await network.uncheck();
    await page.getByRole('button', { name: 'Review before starting' }).click();
    await expect(page.getByRole('button', { name: 'Start 2 model runs' })).toBeEnabled();
    await expect(limits.getByText(/run without approval prompts/)).toBeVisible();
    await expect(limits.getByText(/Copilot CLI.*outbound network block/)).toBeVisible();
    await expect(limits.getByText(/Claude Code.*profile.*network/)).toBeVisible();
    await page.getByRole('link', { name: 'Edit checks and limits' }).click();
    await expect(approvals).toHaveValue('autonomous');
    await expect(network).not.toBeChecked();
  } finally { await app.close(); }
});

test('mixed clients expose native choices and keep path and command decisions separate', async ({ page }) => {
  test.setTimeout(45000);
  const app = await createMixedClientFixture();
  try {
    await writeFile(app.copilotConfig, JSON.stringify({ label: 'Copilot fixture', storedText: 'Stored Copilot answer.' }), { mode: 0o600 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('xenoflux-theme', 'dark');
      sessionStorage.setItem('xenoflux-run-auto-load-models', 'false');
    });
    await page.goto(app.url);
    await page.getByRole('link', { name: 'Run a new task' }).click();
    await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Read the pinned disposable fixture.');
    await page.getByRole('combobox', { name: /First · left side/ }).selectOption({ label: 'Copilot managed · Copilot CLI' });
    await page.getByRole('combobox', { name: /Second · right side/ }).selectOption({ label: 'Claude managed · Claude Code' });
    const leftCatalog = page.getByRole('region', { name: 'Left model catalog', exact: true });
    await leftCatalog.getByText('Catalog details', { exact: true }).click();
    await leftCatalog.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Auto · Copilot routing' })).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Model ID' }).first().selectOption('auto');
    await page.getByRole('combobox', { name: 'Permission mode' }).first().selectOption('manual');
    await expect(page.getByRole('combobox', { name: 'Permission mode' }).last().locator('option')).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Approvals', exact: true }).selectOption({ label: 'Ask me' });
    await page.getByRole('button', { name: 'Add a check command' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Pinned fixture input');
    await page.getByRole('textbox', { name: 'Command you already use' }).fill(pinnedCheck);
    await page.getByRole('button', { name: 'Review before starting' }).click();
    await expect(page.getByText('These sides use different native permission rules.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Execution limits' }).getByText(/asks you to approve/)).toBeVisible();
    await expect(page.getByText(/Pinned commit:/)).toBeVisible();
    const differences = page.getByRole('region', { name: 'Setup differences', exact: true });
    const permission = differences.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Permission mode', exact: true }) });
    await expect(permission.getByText('Unknown', { exact: true })).toBeVisible();
    await differences.getByRole('checkbox', { name: 'Hide matches', exact: true }).check();
    await expect(permission.getByText('Unknown', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Start 2 model runs' }).first().click();
    const path = page.getByRole('region', { name: 'Native request' }).filter({ hasText: 'requests path access' });
    const command = page.getByRole('region', { name: 'Native request' }).filter({ hasText: 'requests command execution' });
    const approve = path.getByRole('button', { name: 'Approve once' });
    await expect(approve).toBeEnabled({ timeout: 12000 });
    await expect(command.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await approve.focus();
    await page.keyboard.press('Enter');
    await expect(path).toHaveCount(0);
    await command.getByRole('button', { name: 'Reject' }).click();
    await page.getByRole('link', { name: 'Open the report' }).click();
    await page.locator('details.comparison-side-details > summary').first().click();
    await expect(page.getByText('Copilot Auto · repeating this pair may route to different models.')).toBeVisible();
    await expect(page.getByText(/Turn 1 · fixture-routed-model/)).toBeVisible();
    await page.locator('summary').filter({ hasText: /^Outcome$/ }).click();
    await expect(page.getByText('Pinned fixture input', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Claude fixture completed.', { exact: true }).first()).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Inspect session', exact: true }).first().click();
    await expect(page.getByText(/Retained xfx capture/).first()).toBeVisible();
    await page.getByRole('navigation', { name: 'Session sections' }).getByRole('link', { name: 'Activity', exact: true }).click();
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
    const inventories = page.getByRole('region', { name: 'Setup comparison', exact: true });
    await expect(inventories).toBeVisible();
    await page.getByText('Reading limits', { exact: true }).click();
    await expect(page.getByRole('region', { name: 'Claude managed · Claude Code coverage' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'baseline · Codex coverage' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto(app.origin + '/compare/setups?a=Claude+managed&b=Default&aClient=claude-code&bClient=claude-code');
    await expect(page.getByRole('link', { name: 'Preview copying selected settings' })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Find an item' }).fill('settings.json');
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
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const details of await page.locator('details.comparison-side-details > summary').all()) await details.click();
    await expect(page.getByText(/Import read context · Copilot managed · CLI · managed root · local/)).toBeVisible();
    await expect(page.getByText(/Private Claude list title/)).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally { await app.close(); }
});
