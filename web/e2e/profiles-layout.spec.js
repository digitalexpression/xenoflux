import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';

function nativeProfile(client) {
  return { name: client === 'copilot' ? 'copilot-work' : 'claude-work', client,
    accountScope: client === 'copilot' ? 'shared' : 'per-root', accountIndependence: 'not verified',
    isDefault: false, state: 'ready', reason: null,
    signIn: client === 'copilot' ? 'Signed out' : 'Signed in (last checked)', binding: 'bound to date-utils',
    summary: 'Separate settings and retained local history.',
    cli: { state: 'not-running', text: 'Not running' }, desktop: { state: 'unavailable', text: 'Desktop sign-in is unverified' },
    clientActions: [{ id: 'open-terminal', label: 'Open in Terminal' },
      client === 'copilot' ? { id: 'signin', label: 'Sign in with GitHub' } : { id: 'check', label: 'Check sign-in' }], moreMenu: null };
}

test('Codex profiles retain the open client control when the other surface starts', async ({ browser }) => {
  const server = await startUiServer({ provider: createDemoProvider(), staticRoot: resolve('dist/ui') });
  const page = await browser.newPage();
  try {
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/profiles`);
    const cliFirst = page.getByRole('article', { name: 'baseline', exact: true });
    const desktopFirst = page.getByRole('article', { name: 'strict-review', exact: true });

    await expect(cliFirst.getByRole('button', { name: 'Show Terminal for baseline' })).toBeVisible();
    await cliFirst.getByRole('button', { name: 'Open Codex Desktop for baseline' }).click();
    await expect(cliFirst.getByRole('button', { name: 'Show Codex Desktop for baseline' })).toBeVisible();
    await expect(cliFirst.getByRole('button', { name: 'Show Terminal for baseline' })).toBeVisible();

    await expect(desktopFirst.getByRole('button', { name: 'Show Codex Desktop for strict-review' })).toBeVisible();
    await desktopFirst.getByRole('button', { name: 'Open in Terminal (Codex CLI) for strict-review' }).click();
    await expect(desktopFirst.getByRole('button', { name: 'Show Terminal for strict-review' })).toBeVisible();
    await expect(desktopFirst.getByRole('button', { name: 'Show Codex Desktop for strict-review' })).toBeVisible();
  } finally {
    await page.close();
    await server.close();
  }
});

for (const theme of ['light', 'dark']) {
  test(`profile inventory and client discovery preserve scope and keyboard actions in ${theme}`, async ({ browser }, testInfo) => {
    const provider = createDemoProvider();
    const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let signedIn = false, signinState = 'waiting-for-browser', failedDiscovery = false, opened = [];
    let signIns = 0, clientActions = 0;
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const original = await provider.profiles();
      const discovery = await provider.discovery();
      await page.route('**/api/profiles', route => {
        const copilot = nativeProfile('copilot');
        if (signedIn) {
          copilot.signIn = 'Signed in';
          copilot.clientActions = copilot.clientActions.filter(action => action.id !== 'signin');
        }
        return route.fulfill({ json: { ...original, profiles: [original.profiles[0], nativeProfile('claude-code'), copilot] } });
      });
      const attempt = () => ({ id: 'visual-signin', client: 'copilot', profileName: 'copilot-work', accountScope: 'shared', state: signinState,
        message: signinState === 'completed' ? 'Native sign-in verified.' : 'Complete authorization in your browser.', deviceCode: 'DEMO-1234' });
      await page.route('**/api/profiles/copilot-work/sign-in', route => { signIns++; return route.fulfill({ json: attempt() }); });
      await page.route('**/api/sign-ins/visual-signin', route => route.fulfill({ json: attempt() }));
      await page.route('**/api/profiles/*/clients', route => { clientActions++; return route.fulfill({ json: {} }); });
      await page.route('**/api/discovery*', route => failedDiscovery ? route.fulfill({ status: 503, json: { error: { message: 'Synthetic discovery unavailable.', code: 'fixture' } } }) : route.fulfill({ json: discovery }));
      await page.route('**/api/apps*', route => route.fulfill({ json: { apps: [
        { client: 'claude', name: 'Claude', status: 'available', version: 'Synthetic', appKey: 'fixture-claude' },
        { client: 'copilot', name: 'GitHub Copilot', status: 'available', version: 'Synthetic', appKey: 'fixture-copilot', sessionNavigation: 'available' },
      ] } }));
      await page.route('**/api/apps/open', route => { opened.push(route.request().postDataJSON()); return route.fulfill({ json: { status: 'opened', message: 'Simulated opening with the existing setup. No native app was started.' } }); });
      await page.goto(server.launchUrl);
      await page.goto(`${server.origin}/profiles`);
      await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
      await expect(page.getByRole('region', { name: 'Codex profiles', exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Claude Code profiles', exact: true })).toBeVisible();
      const copilot = page.getByRole('article', { name: 'copilot-work', exact: true });
      const claude = page.getByRole('article', { name: 'claude-work', exact: true });
      await expect(copilot.getByText(/Signing in changes the shared GitHub CLI account/)).toBeVisible();
      await expect(claude.getByText(/Signed in \(last checked\)/)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Native apps', exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`profiles-${theme}.png`), fullPage: true, animations: 'disabled' });
      await copilot.getByRole('button', { name: 'Sign in with GitHub for copilot-work', exact: true }).focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Sign in to GitHub Copilot', exact: true });
      await expect(dialog.getByText('Continue in your browser', { exact: true })).toBeVisible();
      await expect(dialog.getByText(/all qualified Copilot profiles and other tools using GitHub CLI/)).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`shared-signin-${theme}.png`), fullPage: true, animations: 'disabled' });
      signinState = 'completed'; signedIn = true;
      await expect(dialog.getByText('Sign-in verified', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
      await expect(copilot.getByText(/CLI: Signed in/)).toBeVisible();
      await expect(copilot.getByRole('heading', { name: 'copilot-work', exact: true })).toBeFocused();
      await expect(copilot.getByRole('button', { name: /Sign in with GitHub|Check sign-in/ })).toHaveCount(0);
      await expect(claude.getByText(/Signed in \(last checked\)/)).toBeVisible();
      expect(signIns).toBe(1); expect(clientActions).toBe(0);
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`profiles-narrow-${theme}.png`), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Create profile…', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Create a profile', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Create profile…', exact: true })).toBeFocused();
      await page.getByRole('link', { name: 'Clients on this Mac', exact: true }).click();
      const apps = page.getByRole('region', { name: 'Native apps', exact: true });
      await expect(apps.getByText(/Use Profiles for separate Desktop storage/)).toBeVisible();
      expect(opened).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`clients-${theme}.png`), fullPage: true, animations: 'disabled' });
      await apps.getByRole('button', { name: 'Open Claude', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(apps.getByText(/Simulated opening with the existing setup/)).toBeVisible();
      expect(opened).toEqual([{ client: 'claude', appKey: 'fixture-claude' }]);
      failedDiscovery = true;
      await page.getByRole('button', { name: 'Check again', exact: true }).click();
      await expect(page.getByRole('alert').getByText('Could not refresh discovery', { exact: true })).toBeVisible();
      await expect(page.getByText('Previous check, could not refresh.', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Installed clients', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`clients-stale-${theme}.png`), fullPage: true, animations: 'disabled' });
      failedDiscovery = false;
      await page.getByRole('button', { name: 'Check again', exact: true }).click();
      await expect(page.getByText('Discovery check complete.', { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`clients-narrow-${theme}.png`), fullPage: true, animations: 'disabled' });
    } finally { await page.close(); await server.close(); }
  });
}
