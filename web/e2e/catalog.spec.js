import { test as base, expect } from '@playwright/test';
import { createUiRunsFixture } from '../../test-support/ui-runs-fixture.js';

const test = base.extend({
  app: async ({}, use, testInfo) => {
    const app = await createUiRunsFixture({ mode: testInfo.title.includes('cancellation') ? { catalog: 'delayed' } : {} });
    try { await use(app); } finally { await app.close(); }
  },
});

async function openForm(page, app) {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await expect(page.getByLabel('Repository')).toHaveValue(app.repository);
}

async function refreshFirst(page) {
  await page.getByRole('button', { name: 'Refresh models', exact: true }).first().click();
  await expect(page.getByLabel('Model ID').first().getByRole('option', { name: /fixture-left/ })).toHaveCount(1);
}

test('model catalog preserves sparse native efforts and independent inheritance without sending a task', async ({ page, app }) => {
  await openForm(page, app);
  const model = page.getByLabel('Model ID').first(), effort = page.getByLabel('Reasoning effort').first();
  await expect(model).toHaveValue('');
  await expect(effort).toHaveValue('');
  await expect(model.getByRole('option')).toHaveCount(1);
  await refreshFirst(page);
  const snapshot = await page.evaluate(async ({ repository }) => {
    const query = new URLSearchParams({ profile: 'baseline', workspace: repository });
    return (await fetch(`/api/catalog?${query}`, { headers: { 'x-xenoflux-request': '1' } })).json();
  }, { repository: app.repository });
  expect(snapshot.status).toBe('ready');
  const left = snapshot.models.find(item => item.model === 'fixture-left');
  const defaults = snapshot.models.find(item => item.isDefault);
  if (defaults?.supportedReasoningEfforts?.length) {
    await effort.selectOption(defaults.supportedReasoningEfforts[0].reasoningEffort);
    await expect(model).toHaveValue('');
  }
  await model.selectOption('fixture-left');
  await expect(effort).toHaveValue('');
  expect(await effort.locator('option').evaluateAll(options => options.map(option => option.value)))
    .toEqual(['', ...(left.supportedReasoningEfforts ?? []).map(item => item.reasoningEffort)]);
  await effort.selectOption('low');
  await model.selectOption('fixture-right');
  await expect(effort).toHaveValue('');
  await expect(page.getByText(/Source: codex-model\/list/).first()).toBeVisible();
  await expect(page.getByText(/Account identity: unknown/).first()).toBeVisible();
  expect(app.calls.captures).toEqual([]);
});

test('profile and workspace changes discard catalog choices and preserve defaults in both themes', async ({ page, app }, testInfo) => {
  await openForm(page, app);
  await refreshFirst(page);
  const model = page.getByLabel('Model ID').first(), effort = page.getByLabel('Reasoning effort').first();
  await model.selectOption('fixture-left');
  await effort.selectOption('low');
  await page.getByLabel(/left side of the report/i).selectOption('strict-review');
  await expect(model).toHaveValue('');
  await expect(effort).toHaveValue('');
  await expect(model.getByRole('option')).toHaveCount(1);
  await page.getByLabel('Repository').fill(`${app.repository}/missing`);
  await expect(model.getByRole('option')).toHaveCount(1);
  await expect(model).toBeEnabled();
  await expect(effort).toBeEnabled();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`catalog-${theme}-320.png`), fullPage: true });
  }
  expect(app.calls.captures).toEqual([]);
});


test('explicit refresh cancellation reaps discovery and leaves inherited run preview available', async ({ page, app }) => {
  await openForm(page, app);
  await page.getByRole('button', { name: 'Refresh models', exact: true }).first().click();
  await expect.poll(() => app.calls.catalogs.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel model refresh' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel model refresh' }).click();
  await expect(page.getByText('Model refresh cancelled. Profile defaults remain available.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel model refresh' })).toHaveCount(0);
  await expect(page.getByLabel('Model ID').first()).toHaveValue('');
  await expect(page.getByLabel('Reasoning effort').first()).toHaveValue('');
  await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Inspect the fixture using inherited settings.');
  await page.getByRole('button', { name: 'Review before starting' }).click();
  await expect(page.getByText('Ready to start')).toBeVisible();
  expect(app.calls.captures).toEqual([]);
});

test('context switch cancellation fences the late refresh response from the new profile', async ({ page, app }) => {
  await openForm(page, app);
  await page.getByRole('button', { name: 'Refresh models', exact: true }).first().click();
  await expect.poll(() => app.calls.catalogs.length).toBe(1);
  const cancelled = page.waitForResponse(response => response.url().endsWith('/api/catalog/cancel'));
  await page.getByLabel(/left side of the report/i).selectOption('strict-review');
  await cancelled;
  await expect(page.getByRole('button', { name: 'Cancel model refresh' })).toHaveCount(0);
  await expect(page.getByLabel('Model ID').first()).toHaveValue('');
  await expect(page.getByLabel('Model ID').first().getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Refresh models', exact: true }).first()).toBeEnabled();
  expect(app.calls.catalogs[0].profile).toBe('baseline');
  expect(app.calls.captures).toEqual([]);
});
