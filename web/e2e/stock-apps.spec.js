import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { Store } from '../../src/profiles.js';
import { createEngineProvider } from '../../src/ui-engine.js';
import { startUiServer, UiError } from '../../src/ui-server.js';

const test = base.extend({
  copilotSessions: [false, { option: true }],
  app: async ({ copilotSessions }, use) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-stock-apps-ui-')));
    const claudePath = join(root, 'Claude.app');
    const copilotPath = join(root, 'GitHub Copilot.app');
    const writeBundle = (path, version) => {
      mkdirSync(join(path, 'Contents'), { recursive: true });
      writeFileSync(join(path, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
    };
    writeBundle(claudePath, '1.0');
    if (copilotSessions) writeBundle(copilotPath, '1.1.35');
    const store = new Store(join(root, 'store'));
    await store.update(() => {});
    let appKey = 'a'.repeat(64), version = '1.0', listCalls = 0, unavailable = false, delayed = false, release;
    const openCalls = [], opened = [];
    const provider = createEngineProvider({ store, defaultUserHome: join(root, 'no-account-home'),
      reportsRoot: join(root, 'reports'), profilesBase: join(root, 'profiles'),
      desktopSurface: { list: async () => ({ instances: [] }), inspect: async () => { throw new Error('No Codex app in fixture'); } },
      discoveryContext: { desktopLocations: [], inspectDesktop: async () => { throw new Error('No fixture Codex desktop app is installed'); } },
      stockApps: {
        locations: [claudePath, copilotPath],
        list: async () => { listCalls++; return { apps: [
          { client: 'claude', name: 'Claude', status: unavailable ? 'unavailable' : 'available', path: claudePath, appKey, version, build: '10' },
          copilotSessions
            ? { client: 'copilot', name: 'GitHub Copilot', status: 'available', path: copilotPath, appKey, version: '1.1.35', build: '35', sessionNavigation: 'available' }
            : { client: 'copilot', name: 'GitHub Copilot', status: 'unavailable', reason: 'Not installed in fixture' },
        ] }; },
        open: async input => {
          openCalls.push(input);
          if (!['claude', ...(copilotSessions ? ['copilot'] : [])].includes(input.client) || input.appKey !== appKey)
            throw new UiError(409, `${input.client === 'copilot' ? 'GitHub Copilot' : 'Claude'} changed after discovery.`, 'app-changed');
          if (input.sessionId !== undefined && (input.client !== 'copilot' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sessionId)))
            throw new UiError(400, 'Use a bounded app-local session ID.', 'invalid-session');
          if (delayed) await new Promise(resolve => { release = resolve; });
          opened.push(input);
          return input.sessionId !== undefined
            ? { status: 'link-opened', message: 'Opened the Copilot session link. The existing session association and completion are unconfirmed; no task was requested.' }
            : { status: 'opened', message: `Opened ${input.client === 'copilot' ? 'GitHub Copilot' : 'Claude'} with its existing account.` };
        },
      },
    });
    const server = await startUiServer({ provider, staticRoot: join(process.cwd(), 'dist', 'ui') });
    const app = { url: server.launchUrl, openCalls, opened,
      get listCalls() { return listCalls; },
      delay: () => { delayed = true; }, release: () => { delayed = false; release?.(); },
      changeIdentity: () => { appKey = 'b'.repeat(64); version = '2.0'; writeBundle(claudePath, version); },
      hide: () => { unavailable = true; rmSync(claudePath, { recursive: true, force: true }); } };
    try { await use(app); }
    finally { app.release(); await provider.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  },
});

async function openProfiles(page, app) {
  await page.goto(app.url);
  await page.getByRole('link', { name: 'Profiles', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
  await expect.poll(() => app.listCalls).toBeGreaterThan(0);
}

test('app discovery is read-only; explicit stock opening uses its exact app identity and prevents duplicate launch', async ({ page, app }, testInfo) => {
  await openProfiles(page, app);
  const section = page.getByRole('region', { name: 'Native apps' });
  await expect(section).toBeVisible();
  await expect(section.getByText(/app with its existing setup/)).toBeVisible();
  await expect(section.getByText(/Use a profile card for separate Desktop storage/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open GitHub Copilot', exact: true })).toHaveCount(0);
  await expect(section.getByLabel('Copilot app-local session ID', { exact: true })).toHaveCount(0);
  expect(app.openCalls).toEqual([]);
  app.delay();
  const open = section.getByRole('button', { name: 'Open Claude', exact: true });
  await open.click();
  await expect.poll(() => app.openCalls.length).toBe(1);
  expect(app.openCalls[0]).toEqual({ client: 'claude', appKey: 'a'.repeat(64) });
  await expect(section.getByRole('button', { name: 'Opening Claude…', exact: true })).toBeDisabled();
  await section.getByRole('button', { name: 'Opening Claude…', exact: true }).evaluate(button => button.click());
  expect(app.openCalls).toHaveLength(1);
  app.release();
  await expect(section.getByRole('status')).toHaveText('Opened Claude with its existing account.');
  expect(app.opened).toHaveLength(1);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`native-apps-${theme}-320.png`), fullPage: true });
  }
});

test('changed app identity reports failure and refreshes discovery before retrying', async ({ page, app }) => {
  await openProfiles(page, app);
  const section = page.getByRole('region', { name: 'Native apps' });
  await expect(section.getByRole('button', { name: 'Open Claude', exact: true })).toBeVisible();
  app.changeIdentity();
  await section.getByRole('button', { name: 'Open Claude', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('Claude changed after discovery.');
  await expect(section.getByRole('alert')).toContainText('Check apps again before retrying.');
  expect(app.opened).toEqual([]);
  await expect.poll(() => app.listCalls).toBeGreaterThan(1);
  await section.getByRole('button', { name: 'Check apps again' }).click();
  await expect(section.getByRole('button', { name: 'Check apps again' })).toBeEnabled();
  await section.getByRole('button', { name: 'Open Claude', exact: true }).click();
  await expect(section.getByRole('status')).toHaveText('Opened Claude with its existing account.');
  expect(app.openCalls.at(-1)).toEqual({ client: 'claude', appKey: 'b'.repeat(64) });
});

test('unavailable apps remain hidden without opening any app', async ({ page, app }) => {
  app.hide();
  await openProfiles(page, app);
  await expect(page.getByRole('heading', { name: 'Native apps', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Claude', exact: true })).toHaveCount(0);
  expect(app.openCalls).toEqual([]);
});


test.describe('Copilot existing session links', () => {
  test.use({ copilotSessions: true });

  test('only explicit session-link submission sends the exact app-local ID and locks duplicate actions', async ({ page, app }, testInfo) => {
    await openProfiles(page, app);
    const section = page.getByRole('region', { name: 'Native apps' });
    const input = section.getByLabel('Copilot app-local session ID', { exact: true });
    await expect(input).not.toBeVisible();
    await section.getByText('Open an existing Copilot session', { exact: true }).click();
    await input.fill('session_123-abc');
    expect(app.openCalls).toEqual([]);
    await expect(section.getByText(/GitHub task and runtime IDs aren’t interchangeable/)).toBeVisible();
    app.delay();
    await section.getByRole('button', { name: 'Open existing session link', exact: true }).click();
    await expect.poll(() => app.openCalls.length).toBe(1);
    expect(app.openCalls[0]).toEqual({ client: 'copilot', appKey: 'a'.repeat(64), sessionId: 'session_123-abc' });
    await expect(input).toBeDisabled();
    const pending = section.getByRole('button', { name: 'Opening existing session link…', exact: true });
    await expect(pending).toBeDisabled();
    await pending.evaluate(button => button.click());
    expect(app.openCalls).toHaveLength(1);
    app.release();
    await expect(section.getByRole('status')).toContainText('association and completion are unconfirmed; no task was requested');
    expect(app.opened).toHaveLength(1);
    await input.fill('a'.repeat(128));
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`copilot-session-${theme}-320.png`), fullPage: true });
    }
  });

  test('URLs, paths, query strings and malformed session IDs are blocked without dispatch', async ({ page, app }) => {
    await openProfiles(page, app);
    const section = page.getByRole('region', { name: 'Native apps' });
    await section.getByText('Open an existing Copilot session', { exact: true }).click();
    const input = section.getByLabel('Copilot app-local session ID', { exact: true });
    for (const value of ['', 'https://example.test/session', '/session/path', 'session?query=1', '_wrong', 'a'.repeat(129)]) {
      await input.fill(value);
      await expect(input).toHaveValue(value);
      await section.getByRole('button', { name: 'Open existing session link', exact: true }).click();
      expect(app.openCalls).toEqual([]);
    }
  });

  test('a changed app requires a fresh identity and another explicit submission, including after refresh', async ({ page, app }) => {
    await openProfiles(page, app);
    const section = page.getByRole('region', { name: 'Native apps' });
    await section.getByText('Open an existing Copilot session', { exact: true }).click();
    const input = section.getByLabel('Copilot app-local session ID', { exact: true });
    await input.fill('session_123');
    app.changeIdentity();
    await section.getByRole('button', { name: 'Open existing session link', exact: true }).click();
    await expect(section.getByRole('alert')).toContainText('GitHub Copilot changed after discovery.');
    await expect.poll(() => app.listCalls).toBeGreaterThan(1);
    expect(app.opened).toEqual([]);
    expect(app.openCalls).toHaveLength(1);
    await section.getByRole('button', { name: 'Check apps again' }).click();
    await expect(section.getByRole('button', { name: 'Check apps again' })).toBeEnabled();
    expect(app.openCalls).toHaveLength(1);
    await expect(input).toHaveValue('session_123');
    await section.getByRole('button', { name: 'Open existing session link', exact: true }).click();
    await expect(section.getByRole('status')).toContainText('no task was requested');
    expect(app.openCalls.at(-1)).toEqual({ client: 'copilot', appKey: 'b'.repeat(64), sessionId: 'session_123' });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
    expect(app.openCalls).toHaveLength(2);
  });
});


test('automatic app checks show updates and removals, preserve focused input and recover safely after transport failures', async ({ page, app }) => {
  await page.clock.install({ time: 0 });
  await openProfiles(page, app);
  await page.clock.pauseAt(1000);
  const section = page.getByRole('region', { name: 'Native apps' });
  const check = section.getByRole('button', { name: 'Check apps again', exact: true });
  await check.focus();
  app.changeIdentity();
  let response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/apps');
  await page.clock.fastForward(5000);
  await response;
  await expect(section.getByText('Version 2.0 · Build 10', { exact: true })).toBeVisible();
  await expect(check).toBeFocused();
  await expect(check).toBeEnabled();
  expect(app.openCalls).toEqual([]);
  await page.route('**/api/apps*', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { message: 'Fixture app inspection failed', code: 'fixture' } }) }));
  response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/apps');
  await page.clock.fastForward(5000);
  await response;
  await expect(section.getByText(/Previous app findings are shown/)).toBeVisible();
  await expect(section.getByRole('button', { name: 'Open Claude', exact: true })).toBeDisabled();
  await expect(section.getByText('Version 2.0 · Build 10', { exact: true })).toBeVisible();
  await page.unroute('**/api/apps*');
  response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/apps');
  await page.clock.fastForward(5000);
  await response;
  await expect(section.getByRole('button', { name: 'Open Claude', exact: true })).toBeEnabled();
  app.hide();
  response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/apps');
  await page.clock.fastForward(5000);
  await response;
  await expect(section).toHaveCount(0);
  expect(app.openCalls).toEqual([]);
});
