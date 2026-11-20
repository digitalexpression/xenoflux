import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';

function nativeProfile(client) {
  return { name: client === 'copilot' ? 'copilot-work' : 'claude-work', client,
    accountScope: 'per-root', accountIndependence: 'not verified',
    isDefault: false, state: 'ready', reason: null,
    signIn: client === 'copilot' ? 'Signed out' : 'Signed in (last checked)', binding: 'bound to date-utils',
    summary: 'Separate settings and retained local history.',
    cli: { state: 'not-running', text: 'Not running' }, desktop: { state: 'unavailable', text: 'Desktop sign-in is unverified' },
    clientActions: [{ id: 'open-terminal', label: 'Open in Terminal' },
      ...(client === 'copilot' ? [{ id: 'signin', label: 'Sign in with GitHub' }] : [])], moreMenu: null };
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

test('cards label each surface in text, show the full folder on focus, reveal through the API and open the inspector', async ({ browser }) => {
  const server = await startUiServer({ provider: createDemoProvider(), staticRoot: resolve('dist/ui') });
  const page = await browser.newPage();
  const reveals = [];
  try {
    await page.route('**/api/profiles/*/reveal', async route => { reveals.push(route.request().postDataJSON()); await route.continue(); });
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/profiles`);
    const card = page.getByRole('article', { name: 'baseline', exact: true });
    await expect(card.getByRole('group', { name: 'CLI', exact: true }).getByText('Open', { exact: true })).toBeVisible();
    await expect(card.getByRole('group', { name: 'Desktop', exact: true }).getByText('Closed', { exact: true })).toBeVisible();
    await expect(card.locator('.surface-dot[data-state="open"]')).toHaveCount(1);
    await expect(card.locator('.surface-dot[data-state="closed"]')).toHaveCount(1);

    const path = card.locator('.profile-card-header').getByRole('button', { name: 'Show baseline folder in Finder', exact: true });
    const tooltip = card.getByRole('tooltip');
    await expect(tooltip).toBeHidden();
    await path.focus();
    await expect(path).toBeFocused();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('[DEMO]/.codex-baseline');
    await expect(path).toHaveAccessibleDescription(/\[DEMO\]\/\.codex-baseline/);
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();

    await card.getByRole('button', { name: 'Show baseline folder in Finder', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Simulated: Finder was not opened.' })).toBeVisible();
    expect(reveals).toEqual([{ client: 'codex' }]);

    const details = card.getByRole('button', { name: 'Details for baseline', exact: true });
    await details.click();
    const inspector = page.getByRole('complementary', { name: 'baseline', exact: true });
    await expect(inspector.getByRole('heading', { name: 'How sign-in works' })).toBeVisible();
    await expect(inspector.getByText('[DEMO]/.codex-baseline', { exact: true })).toBeVisible();
    await expect(inspector.getByRole('link', { name: 'Inspect setup' })).toBeVisible();
    await inspector.getByRole('button', { name: 'Close profile details', exact: true }).click();
    await expect(inspector).toHaveCount(0);
    await expect(details).toBeFocused();
  } finally {
    await page.close();
    await server.close();
  }
});

test('profile card notices appear above icon-only surface actions and open details', async ({ browser }) => {
  const server = await startUiServer({ provider: createDemoProvider(), staticRoot: resolve('dist/ui') });
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  let finish;
  try {
    const failure = 'Could not open Desktop. This profile is reserved by another client. Close that client and try again.';
    const replies = [
      { status: 'warning', message: 'Desktop status unavailable.' },
      { status: 'error', message: failure },
      { status: 'success', message: 'Desktop opened.' },
    ];
    await page.route('**/api/profiles/baseline/clients', async route => {
      await new Promise(resolve => { finish = resolve; });
      await route.fulfill({ json: replies.shift() });
    });
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/profiles`);
    const card = page.getByRole('article', { name: 'baseline', exact: true });
    const desktop = card.getByRole('group', { name: 'Desktop', exact: true });
    const open = desktop.getByRole('button', { name: 'Open Codex Desktop for baseline', exact: true });
    const notice = card.locator('.profile-card-notice');
    await expect(notice).toHaveText('Auto-checks on');
    await expect(open).toHaveText('');
    await open.focus();
    await expect(desktop.getByRole('tooltip')).toHaveText('Open Codex Desktop');
    const geometry = () => Promise.all([card, open].map(async locator => locator.evaluate(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return [x, y + scrollY, width, height];
    })));
    const idle = await geometry();
    for (const [status, message] of [['warning', 'Desktop status unavailable.'], ['error', failure], ['success', 'Desktop opened.']]) {
      finish = undefined;
      await open.click();
      await expect(notice).toHaveText('Opening Desktop…');
      expect(await geometry()).toEqual(idle);
      expect(await notice.evaluate(node => node.nextElementSibling.classList.contains('profile-surfaces'))).toBe(true);
      await expect.poll(() => Boolean(finish)).toBe(true);
      finish();
      await expect(notice).toHaveAttribute('data-status', status);
      await expect(notice).toContainText(message);
      expect(await geometry()).toEqual(idle);
      const details = notice.getByRole('button', { name: 'See details', exact: true });
      if (status === 'success') {
        await expect(details).toHaveCount(0);
      } else {
        await details.click();
        await expect(page.getByRole('complementary', { name: 'baseline', exact: true }).getByText(message)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(details).toBeFocused();
      }
    }
  } finally {
    finish?.();
    await page.close();
    await server.close();
  }
});

test('Default cards route actions by vendor and show a common sign-in requirement', async ({ browser }) => {
  const provider = createDemoProvider();
  const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
  const actions = [];
  try {
    const inventory = await provider.profiles();
    const states = [
      ['codex', 'signed-out', 'No sign-in saved', false],
      ['claude-code', 'signed-out', 'Signed out (last checked)', true],
      ['copilot', 'unverified', 'Sign-in route unverified (last checked)', true],
    ];
    await page.route('**/api/profiles', route => route.fulfill({ json: { ...inventory, simulated: false,
      profiles: states.map(([client, state, signIn, lastChecked]) => ({ ...inventory.profiles[0], name: 'Default', client, signIn,
        accountCheck: false, accountFinding: { state, lastChecked }, desktop: { state: 'unavailable', text: 'Desktop unavailable' },
        clientActions: [{ id: 'open-terminal', label: 'Open in Terminal' }],
      })) } }));
    await page.route('**/api/profiles/Default/clients', route => {
      actions.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: 'success', message: 'Opened Terminal.' } });
    });
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/profiles`);
    await expect(page.getByRole('article', { name: 'Default', exact: true }).getByText('Sign in required', { exact: true })).toHaveCount(3);
    await expect(page.getByText('Last checked', { exact: true })).toHaveCount(2);
    await expect(page.getByText('Unavailable', { exact: true })).toHaveCount(3);
    await page.getByRole('region', { name: 'Claude Code profiles' }).getByRole('button', { name: 'Open in Terminal for Default' }).click();
    const copilot = page.getByRole('region', { name: 'GitHub Copilot profiles' }).getByRole('article', { name: 'Default', exact: true });
    await copilot.getByRole('button', { name: 'Open in Terminal for Default' }).click();
    await expect.poll(() => actions).toEqual([{ action: 'open-terminal', client: 'claude-code' }, { action: 'open-terminal', client: 'copilot' }]);
    await copilot.getByRole('button', { name: 'Details for Default' }).click();
    await expect(page.getByRole('complementary', { name: 'Default' }).getByText('Sign-in route unverified (last checked)')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await page.close();
    await server.close();
  }
});

test('profile refreshes keep accounts, actions and keyboard focus in place', async ({ browser }) => {
  const provider = createDemoProvider();
  const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  const account = 'long.enterprise.account.with.a.display.name@engineering.example.test';
  let showAccount = false, fail = false;
  try {
    await page.route('**/api/profiles', async route => {
      if (fail) return route.fulfill({ status: 503, json: { error: { message: 'Synthetic refresh failure.' } } });
      const inventory = await provider.profiles();
      const profiles = inventory.profiles.map(profile => showAccount && profile.name === 'baseline' ? {
        ...profile,
        account: { label: account, lastChecked: true },
        clientActions: [...profile.clientActions, { id: 'close-terminal', label: 'Close CLI' }],
      } : profile);
      return route.fulfill({ json: { ...inventory, profiles } });
    });
    await page.goto(server.launchUrl);
    await page.goto(`${server.origin}/profiles`);
    const card = page.getByRole('article', { name: 'baseline', exact: true });
    const cli = card.getByRole('group', { name: 'CLI', exact: true });
    const desktop = card.getByRole('group', { name: 'Desktop', exact: true });
    const show = cli.getByRole('button', { name: 'Show Terminal for baseline', exact: true });
    const details = card.getByRole('button', { name: 'Details for baseline', exact: true });
    await expect(desktop.getByText('Same account as CLI', { exact: true })).toBeVisible();
    await details.focus();
    await page.evaluate(() => document.fonts.ready);
    const positions = () => Promise.all([card, cli, desktop, show].map(locator => locator.boundingBox()));
    const initial = await positions();
    const refresh = async () => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/profiles');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await response;
    };

    showAccount = true;
    await refresh();
    await expect(cli.getByText(account, { exact: true })).toBeVisible();
    await expect(cli.getByText('Last checked', { exact: true })).toBeVisible();
    await expect(details).toBeFocused();
    expect(await positions()).toEqual(initial);
    fail = true;
    await refresh();
    await expect(page.getByText('Showing previous profile findings.', { exact: true })).toBeVisible();
    await expect(cli.getByText(account, { exact: true })).toBeVisible();
    expect(await positions()).toEqual(initial);
    fail = false;
    await refresh();
    await expect(page.getByText('Showing previous profile findings.', { exact: true })).toHaveCount(0);
    await expect(details).toBeFocused();
    expect(await positions()).toEqual(initial);
  } finally {
    await page.close();
    await server.close();
  }
});

for (const theme of ['light', 'dark']) {
  test(`profile details dock beside an interactive inventory in ${theme}`, async ({ browser }) => {
    const server = await startUiServer({ provider: createDemoProvider(), staticRoot: resolve('dist/ui') });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(server.launchUrl);
      await page.goto(`${server.origin}/profiles`);
      await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
      const inventory = page.getByRole('region', { name: 'Codex profiles', exact: true });
      const baseline = inventory.getByRole('article', { name: 'baseline', exact: true });
      const strict = inventory.getByRole('article', { name: 'strict-review', exact: true });
      const baselineDetails = baseline.getByRole('button', { name: 'Details for baseline', exact: true });
      const strictDetails = strict.getByRole('button', { name: 'Details for strict-review', exact: true });
      const baselineInspector = page.getByRole('complementary', { name: 'baseline', exact: true });
      const strictInspector = page.getByRole('complementary', { name: 'strict-review', exact: true });
      const guide = page.getByRole('complementary', { name: 'Profiles guide', exact: true });
      const discovery = page.getByRole('button', { name: 'Show client discovery', exact: true });
      const neutralBorder = await baseline.evaluate(card => getComputedStyle(card).borderColor);
      const selectedBorder = theme === 'light' ? 'rgb(17, 121, 110)' : 'rgb(100, 200, 188)';
      await expect(baselineDetails).toHaveAttribute('aria-expanded', 'false');
      await expect(guide).toBeVisible();
      const beforeSelection = await baseline.boundingBox();
      const [workspaceBounds, discoveryBounds] = await Promise.all([page.locator('.profiles-workspace').boundingBox(), discovery.boundingBox()]);
      expect(discoveryBounds.width).toBeGreaterThanOrEqual(workspaceBounds.width - 2);
      expect(discoveryBounds.y).toBeGreaterThanOrEqual(workspaceBounds.y + workspaceBounds.height);
      expect(discoveryBounds.height).toBeLessThanOrEqual(44);

      await baselineDetails.click();
      await expect(baselineDetails).toHaveAttribute('aria-expanded', 'true');
      await expect(baseline).toHaveCSS('border-width', '1px');
      await expect(baseline).toHaveCSS('border-color', selectedBorder);
      await expect(strict).toHaveCSS('border-width', '1px');
      await expect(strict).toHaveCSS('border-color', neutralBorder);
      await expect(baselineInspector).toBeVisible();
      await expect(guide).toHaveCount(0);
      expect(await baseline.boundingBox()).toEqual(beforeSelection);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('[data-slot="sheet-overlay"], .dialog-overlay')).toBeHidden();
      expect(await baseline.evaluate(element => {
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.filter !== 'none' || style.backdropFilter !== 'none') return false;
        }
        return true;
      })).toBe(true);
      const inventoryBounds = await inventory.boundingBox();
      expect((await baselineInspector.boundingBox()).x).toBeGreaterThanOrEqual(inventoryBounds.x + inventoryBounds.width);

      await strictDetails.click();
      await expect(strictInspector).toBeVisible();
      await expect(baselineInspector).toBeHidden();
      await expect(strictDetails).toHaveAttribute('aria-expanded', 'true');
      await expect(baselineDetails).toHaveAttribute('aria-expanded', 'false');
      await expect(baseline).toHaveCSS('border-color', neutralBorder);
      await expect(strict).toHaveCSS('border-width', '1px');
      await expect(strict).toHaveCSS('border-color', selectedBorder);
      await strictDetails.press('Escape');
      await expect(strictInspector).toBeHidden();
      await expect(guide).toBeVisible();
      await expect(strictDetails).toBeFocused();

      await page.setViewportSize({ width: 320, height: 900 });
      await baselineDetails.press('Enter');
      await expect(baselineInspector).toBeVisible();
      const close = baselineInspector.getByRole('button', { name: 'Close profile details', exact: true });
      await expect(close).toBeFocused();
      const [selected, inspector, next] = await Promise.all([baseline, baselineInspector, strict].map(locator => locator.boundingBox()));
      expect(inspector.y).toBeGreaterThanOrEqual(selected.y + selected.height);
      expect(next.y).toBeGreaterThanOrEqual(inspector.y + inspector.height);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(baselineInspector).toBeHidden();
      await expect(guide).toBeVisible();
      await expect(baselineDetails).toBeFocused();
    } finally {
      await page.close();
      await server.close();
    }
  });

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
      const attempt = () => ({ id: 'visual-signin', client: 'copilot', profileName: 'copilot-work', accountScope: 'per-root', state: signinState,
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
      await expect(page.getByRole('complementary', { name: 'Profiles guide', exact: true })).toBeVisible();
      for (const name of ['claude-work', 'copilot-work']) {
        await page.getByRole('button', { name: `Details for ${name}`, exact: true }).click();
        await expect(page.getByRole('complementary', { name, exact: true }).getByText('Sign in separately to CLI and Desktop for this profile.')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: `Details for ${name}`, exact: true })).toBeFocused();
      }
      await expect(claude.getByText(/Signed in \(last checked\)/)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Native apps', exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`profiles-${theme}.png`), fullPage: true, animations: 'disabled' });
      await copilot.getByRole('button', { name: 'Sign in with GitHub for copilot-work', exact: true }).focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Sign in to GitHub Copilot', exact: true });
      await expect(dialog.getByText('Continue in your browser', { exact: true })).toBeVisible();
      await expect(dialog.getByText(/Sign in to GitHub for this Copilot CLI profile/)).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`copilot-signin-${theme}.png`), fullPage: true, animations: 'disabled' });
      signinState = 'completed'; signedIn = true;
      await expect(dialog.getByText('Sign-in verified', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
      await expect(copilot.getByText('Signed in', { exact: true })).toBeVisible();
      await expect(copilot.getByRole('heading', { name: 'copilot-work', exact: true })).toBeFocused();
      await expect(copilot.getByRole('button', { name: /Sign in with GitHub|Check sign-in/ })).toHaveCount(0);
      await expect(claude.getByText(/Signed in \(last checked\)/)).toBeVisible();
      expect(signIns).toBe(1); expect(clientActions).toBe(0);
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`profiles-narrow-${theme}.png`), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Add a profile', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Create profile', exact: true }).click();
      const create = page.getByRole('dialog', { name: 'Create a profile', exact: true });
      const client = create.getByRole('combobox', { name: 'Client' });
      await expect(client).toHaveAccessibleDescription('One sign-in works in CLI and Desktop for this profile.');
      for (const value of ['claude-code', 'copilot']) {
        await client.selectOption(value);
        await expect(client).toHaveAccessibleDescription('Sign in separately to CLI and Desktop for this profile.');
      }
      await expect(page.getByRole('dialog', { name: 'Create a profile', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Add a profile', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Show client discovery', exact: true }).click();
      const apps = page.getByRole('region', { name: 'Native apps', exact: true });
      await expect(apps.getByText(/Use a profile’s Desktop row for separate storage/)).toBeVisible();
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
