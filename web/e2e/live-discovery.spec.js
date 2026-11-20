import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remove } from '../../src/profiles.js';
import { test, expect } from './fixtures.js';

async function freeze(page) {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
}
async function tick(page, endpoint) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === endpoint);
  await page.clock.fastForward(5000);
  await response;
}
async function showDiscovery(page) {
  await freeze(page);
  await page.getByRole('link', { name: 'Profiles', exact: true }).click();
  await page.getByRole('button', { name: 'Show client discovery' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Discovery check complete.' })).toBeVisible();
}

test('expanded discovery observes installation and folder changes without opening clients', async ({ page, app }) => {
  await showDiscovery(page);
  const executable = join(app.root, 'codex');
  const original = await readFile(executable);
  const cli = page.getByRole('heading', { name: 'Codex', exact: true }).first().locator('..');
  await cli.getByRole('button', { name: 'Show Codex CLI details', exact: true }).click();
  const toggle = cli.getByRole('button', { name: 'Hide Codex CLI details', exact: true });
  await toggle.focus();
  await writeFile(executable, Buffer.concat([original, Buffer.from('\n# replacement installation\n')]));
  await tick(page, '/api/discovery');
  await expect(page.getByText('Codex CLI installation changed.', { exact: true })).toBeVisible();
  await expect(toggle).toBeFocused();
  await expect(cli.getByText('Version not checked', { exact: true })).toBeVisible();
  await rm(executable);
  await tick(page, '/api/discovery');
  await expect(cli.getByText('Found on selected PATH', { exact: true })).toHaveCount(0);
  await writeFile(executable, original, { mode: 0o700 });
  await tick(page, '/api/discovery');
  await expect(cli.getByText('Found on selected PATH', { exact: true })).toBeVisible();
  await rm(app.homes.baseline.root, { recursive: true });
  await tick(page, '/api/discovery');
  const findings = page.getByRole('region', { name: 'Folder and registry findings' });
  await expect(findings.getByText('baseline', { exact: true }).locator('../..')).toContainText('Folder not found');
  const discovery = page.getByRole('region', { name: 'Client discovery', exact: true });
  await expect(discovery.getByRole('button', { name: /open|sign.in|migrat|creat|copy/i })).toHaveCount(0);
  const calls = await readFile(app.nativeProfileLog, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  expect(calls.split('\n').filter(Boolean).every(line => line === 'auth status\tDefault')).toBe(true);
});

test('automatic discovery failures retain stale findings and recover without announcing every check', async ({ page }) => {
  await showDiscovery(page);
  const status = page.getByRole('status').filter({ hasText: 'Discovery check complete.' });
  const initial = await status.textContent();
  await tick(page, '/api/discovery');
  await expect(status).toHaveText(initial);
  await page.route('**/api/discovery*', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Fixture read unavailable', code: 'fixture' } }) }));
  await tick(page, '/api/discovery');
  await expect(page.getByRole('alert')).toContainText('Previous findings are shown. Checks retry automatically');
  await expect(page.getByText('Codex CLI', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'baseline', exact: true })).toBeVisible();
  await page.unroute('**/api/discovery*');
  await tick(page, '/api/discovery');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
});

test('manual checks queue behind a slow automatic read and suppress its obsolete findings', async ({ page, app }) => {
  await showDiscovery(page);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let calls = 0;
  await page.route('**/api/discovery*', async route => {
    calls++;
    if (calls === 1) {
      const response = await route.fetch();
      const data = await response.json();
      data.clients[0].cli.label = 'Obsolete fixture finding';
      await hold;
      await route.fulfill({ response, json: data });
    } else await route.continue();
  });
  await page.clock.fastForward(5000);
  await expect.poll(() => calls).toBe(1);
  await page.clock.fastForward(15000);
  expect(calls).toBe(1);
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
  await rm(join(app.root, 'codex'));
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
  release();
  await expect.poll(() => calls).toBe(2);
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
  await expect(page.getByText('Obsolete fixture finding', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Found on selected PATH', { exact: true })).toHaveCount(1);
});

test('hidden pages pause discovery and returning to the window refreshes immediately', async ({ page }) => {
  await showDiscovery(page);
  let calls = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/discovery') calls++; });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(15000);
  expect(calls).toBe(0);
  const refreshed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/discovery');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await refreshed;
  expect(calls).toBe(1);
  await page.getByRole('button', { name: 'Hide client discovery', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Profiles', exact: true })).toBeVisible();
  await page.clock.fastForward(15000);
  expect(calls).toBe(1);
});

test('Profiles reconciles another controller removal while preserving entered form and explicit copy source', async ({ page, app }) => {
  await freeze(page);
  const advanceUntilVisible = locator => expect.poll(async () => {
    await page.clock.fastForward(5000);
    return locator.isVisible();
  }).toBe(true);
  await page.getByRole('link', { name: 'Profiles', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'baseline', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add a profile', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create profile', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('keep-my-input');
  await dialog.getByRole('radio', { name: /Selected parts/ }).check();
  await dialog.getByLabel('Copy parts from').selectOption('baseline');
  await name.focus();
  await app.store.update(data => remove(data, 'baseline'));
  await advanceUntilVisible(dialog.getByText('This source is no longer available. Choose another profile before continuing.'));
  await expect(name).toHaveValue('keep-my-input');
  await expect(name).toBeFocused();
  await expect(dialog.getByLabel('Copy parts from')).toHaveValue('baseline');
  await expect(dialog.getByRole('button', { name: 'Choose parts and preview' })).toBeDisabled();
  await dialog.getByLabel('Copy parts from').selectOption('strict-review');
  await expect(dialog.getByRole('button', { name: 'Choose parts and preview' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'baseline', exact: true })).toHaveCount(0);
  await rm(app.homes.strict.root, { recursive: true });
  const strict = page.getByRole('article', { name: 'strict-review', exact: true });
  await advanceUntilVisible(strict.getByText('Couldn’t read this profile', { exact: true }));
});

test('a local profile removal fences a pending older profile response and immediately queues a fresh read', async ({ page }) => {
  await freeze(page);
  await page.getByRole('link', { name: 'Profiles', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'baseline', exact: true })).toBeVisible();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let calls = 0;
  await page.route('**/api/profiles/refresh', async route => {
    calls++;
    if (calls === 1) {
      const response = await route.fetch();
      const data = await response.json();
      data.profiles.find(profile => profile.name === 'baseline').name = 'Obsolete removed profile';
      await hold;
      await route.fulfill({ response, json: data });
    } else await route.continue();
  });
  await page.clock.fastForward(5000);
  await expect.poll(() => calls).toBe(1);
  await page.getByRole('button', { name: 'More actions for baseline', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Remove from Xenoflux/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove from Xenoflux', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  release();
  await expect.poll(() => calls).toBe(2);
  await expect(page.getByRole('heading', { name: 'baseline', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Obsolete removed profile', exact: true })).toHaveCount(0);
});

test('removing an earlier registry finding preserves the later folder disclosure and focus', async ({ page, app }) => {
  await Promise.all([app.homes.baseline.root, app.homes.strict.root].map(root => rm(root, { recursive: true })));
  await showDiscovery(page);
  const findings = page.getByRole('region', { name: 'Folder and registry findings' });
  await expect(findings.getByText('baseline', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show details for strict-review', exact: true }).click();
  const toggle = page.getByRole('button', { name: 'Hide details for strict-review', exact: true });
  await toggle.focus();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await app.store.update(data => remove(data, 'baseline'));
  await tick(page, '/api/discovery');
  await expect(findings.getByText('baseline', { exact: true })).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
});
