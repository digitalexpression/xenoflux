import { test as base, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { bind } from '../../src/profiles.js';
import { createUiRunsFixture } from '../../test-support/ui-runs-fixture.js';

const test = base.extend({
  app: async ({}, use, testInfo) => {
    const app = await createUiRunsFixture({ mode: testInfo.title.includes('cancellation') ? { catalog: 'delayed' } : {} });
    try { await use(app); } finally { await app.close(); }
  },
});

async function openForm(page, app, { manual = false } = {}) {
  if (manual) await page.addInitScript(() => sessionStorage.setItem('xenoflux-run-auto-load-models', 'false'));
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await expect(page.getByLabel('Repository')).toHaveValue(app.repository);
}

async function openFirstCatalog(page) {
  const catalog = page.getByRole('region', { name: 'Left model catalog', exact: true });
  await catalog.getByText('Catalog details', { exact: true }).click();
  return catalog;
}

async function refreshFirst(page) {
  await page.getByRole('region', { name: 'Left model catalog', exact: true })
    .getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect(page.getByLabel('Model ID').first().getByRole('option', { name: /fixture-left/ })).toHaveCount(1);
}

test('model catalog preserves sparse efforts and reloads cached choices without sending a task', async ({ page, app }) => {
  await openForm(page, app, { manual: true });
  const model = page.getByLabel('Model ID').first(), effort = page.getByLabel('Reasoning effort').first();
  await expect(model).toHaveValue('');
  await expect(effort).toHaveValue('');
  await expect(model.getByRole('option')).toHaveCount(1);
  const catalog = await openFirstCatalog(page);
  expect(app.calls.catalogs).toEqual([]);
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
  await expect(catalog.getByText(/Source: codex-model\/list/)).toBeVisible();
  await expect(catalog.getByText(/Account identity: unknown/)).toBeVisible();

  expect(app.calls.catalogs).toHaveLength(1);
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Comparisons', exact: true }).click();
  await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.ok() && response.request().method() === 'GET' && url.pathname === '/api/catalog' &&
        url.searchParams.get('profile') === 'baseline' && url.searchParams.get('workspace') === app.repository;
    }),
    page.getByRole('link', { name: 'Run a new task', exact: true }).click(),
  ]);
  await expect(model.getByRole('option', { name: /fixture-left/ })).toHaveCount(1);
  await expect(model).toHaveValue('');
  expect(app.calls.catalogs).toHaveLength(1);
  expect(app.calls.captures).toEqual([]);
});

test('model loading defaults on in each tab and respects a stored off choice', async ({ page, app }) => {
  const profiles = ['baseline', 'strict-review'];
  const alternate = join(app.root, 'alternate-repository');
  execFileSync('git', ['clone', '-q', '--local', app.repository, alternate]);
  await app.store.update(async data => {
    for (const profile of profiles) await bind(data, profile, alternate);
  });
  const automatic = tab => tab.getByRole('checkbox', { name: 'Load models automatically in this tab', exact: true });
  const modelOptions = tab => tab.getByRole('combobox', { name: /^Model ID · (Left|Right)$/ }).getByRole('option', { name: /fixture-left/ });
  const noCatalogs = tab => tab.getByRole('region', { name: /^(Left|Right) model catalog$/ }).getByText('No saved model catalog.', { exact: true });
  const discoveredFor = workspace => app.calls.catalogs.filter(call => call.workspace === workspace).map(call => call.profile).sort();
  await openForm(page, app);
  await expect(automatic(page)).toBeChecked();
  await expect(modelOptions(page)).toHaveCount(2);
  expect(discoveredFor(app.repository)).toEqual(profiles);

  await automatic(page).uncheck();
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Comparisons', exact: true }).click();
  await page.getByRole('link', { name: 'Run a new task', exact: true }).click();
  await expect(automatic(page)).not.toBeChecked();
  await expect(modelOptions(page)).toHaveCount(2);
  const repository = page.getByLabel('Repository', { exact: true });
  await repository.fill(alternate);
  await repository.press('Tab');
  await expect(noCatalogs(page)).toHaveCount(2);
  expect(app.calls.catalogs).toHaveLength(2);

  const freshTab = await page.context().newPage();
  try {
    await freshTab.goto(`${app.origin}/runs/new`);
    await expect(automatic(freshTab)).toBeChecked();
    await expect(modelOptions(freshTab)).toHaveCount(2);
    expect(app.calls.catalogs).toHaveLength(2);
    const freshRepository = freshTab.getByLabel('Repository', { exact: true });
    await freshRepository.fill(alternate);
    await expect(noCatalogs(freshTab)).toHaveCount(2);
    expect(discoveredFor(alternate)).toEqual([]);
    await freshRepository.press('Tab');
    await expect(modelOptions(freshTab)).toHaveCount(2);
    expect(discoveredFor(alternate)).toEqual(profiles);
  } finally { await freshTab.close(); }
  expect(app.calls.catalogs).toHaveLength(4);
  await expect(automatic(page)).not.toBeChecked();
  expect(app.calls.captures).toEqual([]);
});

base('returning to a profile during catalog cleanup loads that profile’s models', async ({ page }) => {
  let cancellingBaseline = false, baselineRequests = 0;
  const allowShutdown = Promise.withResolvers();
  const probes = [];
  const app = await createUiRunsFixture({ catalogContext: {
    discover: async ({ profile, workspace, signal }) => {
      const name = profile.profileName;
      const firstBaseline = name === 'baseline' && !probes.includes(name);
      probes.push(name);
      if (firstBaseline) {
        await new Promise(resolve => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', resolve, { once: true });
        });
        cancellingBaseline = true;
        await allowShutdown.promise;
      }
      const model = name === 'baseline' ? 'baseline-only' : 'strict-only';
      const status = signal.aborted ? 'cancelled' : 'ready';
      return { status, source: 'codex-model/list',
        scope: { environmentBinding: profile.environmentBinding, workspace, account: null },
        models: signal.aborted ? [] : [{ id: model, model, displayName: model, hidden: false, isDefault: true }],
        capabilities: { models: 'supported', effort: 'unknown' }, discoveredAt: new Date().toISOString(),
        process: { status: signal.aborted ? 'cancelled' : 'exited', exitCode: 0, shutdown: { groupTerminated: true } } };
    },
  } });
  page.on('request', request => {
    if (request.url().endsWith('/api/catalog/refresh') && request.postDataJSON()?.profile === 'baseline') baselineRequests++;
  });
  try {
    await openForm(page, app);
    const leftProfile = page.getByRole('combobox', { name: /First · left side/ });
    const leftModel = page.getByLabel('Model ID · Left', { exact: true });
    const rightModel = page.getByLabel('Model ID · Right', { exact: true });
    const leftCatalog = page.getByRole('region', { name: 'Left model catalog', exact: true });
    await expect(page.getByRole('checkbox', { name: 'Load models automatically in this tab', exact: true })).toBeChecked();
    await expect.poll(() => probes.includes('baseline')).toBe(true);
    await rightModel.selectOption('strict-only');
    await leftProfile.selectOption('strict-review');
    await expect.poll(() => cancellingBaseline).toBe(true);
    await leftProfile.selectOption('baseline');
    await expect.poll(() => baselineRequests).toBe(2);
    await expect(leftCatalog.getByRole('status')).toHaveText('Refreshing models…');
    expect(probes.filter(profile => profile === 'baseline')).toHaveLength(1);

    allowShutdown.resolve();
    await expect(leftModel.getByRole('option', { name: /baseline-only/ })).toHaveCount(1);
    await expect(leftModel.getByRole('option', { name: /strict-only/ })).toHaveCount(0);
    await expect(leftModel).toHaveValue('');
    await expect(rightModel).toHaveValue('strict-only');
    expect(probes.filter(profile => profile === 'baseline')).toHaveLength(2);
    expect(app.calls.captures).toEqual([]);
  } finally { allowShutdown.resolve(); await app.close(); }
});

test('profile and workspace changes discard catalog choices and preserve defaults in both themes', async ({ page, app }, testInfo) => {
  await openForm(page, app, { manual: true });
  await openFirstCatalog(page);
  await refreshFirst(page);
  const model = page.getByLabel('Model ID').first(), effort = page.getByLabel('Reasoning effort').first();
  await model.selectOption('fixture-left');
  await effort.selectOption('low');
  await page.getByRole('combobox', { name: /First · left side/ }).selectOption('strict-review');
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

test('a changed setup explains discarded discovery and requires another explicit refresh', async ({ page, app }) => {
  let refreshes = 0;
  await page.route('**/api/catalog/refresh', async route => {
    const response = await route.fetch();
    refreshes++;
    await route.fulfill({ response, json: refreshes === 1
      ? { ...(await response.json()), status: 'unavailable', models: [], reason: 'catalog-context-changed' }
      : await response.json() });
  });
  await openForm(page, app, { manual: true });
  const catalog = await openFirstCatalog(page);
  const refresh = catalog.getByRole('button', { name: 'Refresh models', exact: true });
  await refresh.click();
  await expect(catalog.getByText('Profile setup changed during discovery. Refresh models again before choosing a model.')).toBeVisible();
  await expect(page.getByLabel('Model ID').first().getByRole('option')).toHaveCount(1);
  await expect(refresh).toBeEnabled();
  expect(refreshes).toBe(1);
  await refreshFirst(page);
  expect(refreshes).toBe(2);
  expect(app.calls.captures).toEqual([]);
});


test('explicit refresh cancellation reaps discovery and leaves inherited run preview available', async ({ page, app }) => {
  await openForm(page, app, { manual: true });
  const catalog = await openFirstCatalog(page);
  await catalog.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect.poll(() => app.calls.catalogs.length).toBe(1);
  const cancel = catalog.getByRole('button', { name: 'Cancel model refresh' });
  await cancel.click();
  await expect(catalog.getByText('Model refresh cancelled. Profile defaults remain available.')).toBeVisible();
  await expect(cancel).toHaveCount(0);
  await expect(page.getByLabel('Model ID').first()).toHaveValue('');
  await expect(page.getByLabel('Reasoning effort').first()).toHaveValue('');
  await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Inspect the fixture using inherited settings.');
  await page.getByRole('button', { name: 'Review before starting' }).click();
  await expect(page.getByText('Ready to start')).toBeVisible();
  expect(app.calls.captures).toEqual([]);
});

test('context switch cancellation fences the late refresh response from the new profile', async ({ page, app }) => {
  await openForm(page, app, { manual: true });
  const catalog = await openFirstCatalog(page);
  await catalog.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await expect.poll(() => app.calls.catalogs.length).toBe(1);
  const cancelled = page.waitForResponse(response => response.url().endsWith('/api/catalog/cancel'));
  await page.getByRole('combobox', { name: /First · left side/ }).selectOption('strict-review');
  await cancelled;
  await expect(catalog.getByRole('button', { name: 'Cancel model refresh' })).toHaveCount(0);
  await expect(page.getByLabel('Model ID').first()).toHaveValue('');
  await expect(page.getByLabel('Model ID').first().getByRole('option')).toHaveCount(1);
  await expect(catalog.getByRole('button', { name: 'Refresh models', exact: true })).toBeEnabled();
  expect(app.calls.catalogs[0].profile).toBe('baseline');
  expect(app.calls.captures).toEqual([]);
});
