import { join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';

test('setup discovers installations before profile controls and preserves comparison access', async ({ page, app }, testInfo) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  const before = await readFile(app.store.file);
  const requests = [];
  page.on('request', request => { if (request.url().includes('/api/discovery')) requests.push(request.method()); });
  await page.getByRole('link', { name: 'Discover clients and profiles', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Find clients and profiles' })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Discovery check complete.' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Installed clients' })).toBeVisible();
  await expect(page.getByText('GitHub Copilot CLI', { exact: true })).toBeVisible();
  await expect(page.getByText('Found on selected PATH', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /open|sign.in|migrat|creat|copy/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show Codex CLI details', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Version not checked', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show checked locations' }).click();
  await expect(page.getByText('Stock apps: /Applications/Claude.app and /Applications/GitHub Copilot.app', { exact: true })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
    await page.setViewportSize({ width: 320, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`discovery-${theme}-320.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
  expect(requests).toEqual(['GET', 'GET']);
  expect(await readFile(app.store.file)).toEqual(before);
  await page.getByRole('link', { name: 'Continue to profiles', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Profiles', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Find clients and existing profiles', exact: true }).click();
  await page.getByRole('link', { name: 'Continue to comparisons', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Compare a task', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Compare setups', exact: true })).toBeVisible();
});

test('unsupported registry rows stay visible without mutation controls', async ({ page, app }) => {
  const registry = JSON.parse(await readFile(app.store.file, 'utf8'));
  registry.profiles.push({ id: 'unsupported', name: 'Older unsupported setup', client: 'future-client', settings: 'SECRET_SETTINGS' });
  await writeFile(app.store.file, JSON.stringify(registry));
  const before = await readFile(app.store.file);
  await page.getByRole('link', { name: 'Setup', exact: true }).click();
  await expect(page.getByText('Older unsupported setup', { exact: true })).toBeVisible();
  await expect(page.getByText('Registry needs attention.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to profiles', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Show details for Older unsupported setup', exact: true }).click();
  await expect(page.getByText(/Automatic migration is not available/)).toBeVisible();
  await expect(page.getByText('SECRET_SETTINGS')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Continue to comparisons', exact: true })).toBeEnabled();
  expect(await readFile(app.store.file)).toEqual(before);
});

test('refresh retains previous observations, disables duplicates and labels failed freshness', async ({ page }) => {
  await page.getByRole('link', { name: 'Setup', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Discovery check complete.' })).toBeVisible();
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  let refreshes = 0;
  await page.route('**/api/discovery*', async route => {
    refreshes++;
    await response;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Fixture inspection failed', code: 'fixture' } }) });
  });
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Previous check, refreshing…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
  await expect(page.getByText('Codex CLI', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to profiles', exact: true })).toBeDisabled();
  finish();
  await expect(page.getByRole('status').filter({ hasText: 'Previous check, could not refresh.' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not refresh discovery' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to profiles', exact: true })).toBeDisabled();
  expect(refreshes).toBe(1);
});

test('initial discovery failure offers retry and keeps comparisons accessible', async ({ page }) => {
  await page.route('**/api/discovery*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'No snapshot available', code: 'fixture' } }) }));
  await page.getByRole('link', { name: 'Setup', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not refresh discovery' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Continue to comparisons', exact: true })).toBeEnabled();
});


test('empty known locations still show all clients and keep profile and comparison entry points', async ({ page, app }) => {
  for (const path of [join(app.root, 'codex'), join(app.root, 'claude'),
    ...['.codex', '.claude', '.copilot'].map(name => join(app.defaultUserHome, name))])
    await rm(path, { recursive: true, force: true });
  await writeFile(app.store.file, JSON.stringify({ schemaVersion: 1, profiles: [] }));
  const before = await readFile(app.store.file);
  await page.getByRole('link', { name: 'Setup', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Discovery check complete.' })).toBeVisible();
  for (const name of ['Codex CLI', 'Claude Code CLI', 'GitHub Copilot CLI'])
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText('Found on selected PATH', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Folder not found', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Continue to profiles', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue to comparisons', exact: true })).toBeVisible();
  expect(await readFile(app.store.file)).toEqual(before);
});
