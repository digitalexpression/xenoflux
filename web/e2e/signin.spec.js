import { test, expect } from './fixtures.js';

async function signinFixture(page, client) {
  let state = 'waiting-for-browser', profileReads = 0, cancelCalls = 0, terminalCalls = 0, startCalls = 0;
  let checkOffline = false, cancelOffline = false, cancellationState = 'cancelled';
  const profileName = client === 'copilot' ? 'copilot-work' : 'claude-work';
  const attempt = () => ({ id: 'fixture-signin', client, profileName, accountScope: client === 'copilot' ? 'shared' : 'per-root',
    state, browserUrl: client === 'copilot' ? 'https://github.com/login/device' : undefined,
    deviceCode: client === 'copilot' ? 'ABCD-1234' : undefined,
    message: state === 'completed' ? 'Account sign-in verified.' : state === 'verifying' ? 'Checking the native account.' : 'Finish authorization in your browser.' });
  await page.route('**/api/profiles', route => {
    profileReads++;
    return route.fulfill({ json: { profiles: [{ name: profileName, client, accountScope: client === 'copilot' ? 'shared' : 'per-root',
      accountIndependence: 'not verified', isDefault: false, state: 'ready', reason: null,
      signIn: state === 'completed' ? 'Signed in' : 'Not signed in', binding: 'Fixture folder', summary: 'Separate settings and history.',
      cli: { state: 'not-running', text: 'Not running' }, desktop: { state: 'unavailable', text: 'Not verified' },
      clientActions: [{ id: 'signin', label: client === 'copilot' ? 'Sign in with GitHub' : 'Sign in' }], moreMenu: null }],
      notes: [], simulated: false } });
  });
  await page.route('**/api/profiles/*/clients', route => { terminalCalls++; return route.fulfill({ json: {} }); });
  await page.route('**/api/profiles/*/sign-in', route => { startCalls++; return route.fulfill({ json: attempt() }); });
  await page.route('**/api/sign-ins/fixture-signin', route => checkOffline ? route.abort() : route.fulfill({ json: attempt() }));
  await page.route('**/api/sign-ins/fixture-signin/cancel', route => {
    cancelCalls++;
    if (cancelOffline) return route.abort();
    state = cancellationState;
    return route.fulfill({ json: { ...attempt(), ...(state === 'uncertain' ? { message: 'Could not confirm shutdown. The sign-in reservation is preserved.' } : {}) } });
  });
  await page.goto(new URL('/profiles', page.url()).toString());
  const button = page.getByRole('button', { name: `${client === 'copilot' ? 'Sign in with GitHub' : 'Sign in'} for ${profileName}`, exact: true });
  await expect(button).toBeVisible();
  return { button, profileName, state: value => { state = value; }, offline: value => { checkOffline = value; },
    cancelOffline: value => { cancelOffline = value; }, cancellationState: value => { cancellationState = value; }, get profileReads() { return profileReads; }, get cancelCalls() { return cancelCalls; },
    get terminalCalls() { return terminalCalls; }, get startCalls() { return startCalls; } };
}

for (const client of ['claude-code', 'copilot']) {
  test(`${client} signs in through browser and automatically verifies in narrow light and dark layouts`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fixture = await signinFixture(page, client);
    if (client === 'copilot') await expect(page.getByText(/Signing in changes the shared GitHub CLI account/)).toBeVisible();
    await fixture.button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Continue in your browser', { exact: true })).toBeVisible();
    const link = dialog.getByRole('link', { name: 'Open sign-in page in browser' });
    if (client === 'copilot') await expect(link).toHaveAttribute('href', 'https://github.com/login/device');
    else await expect(link).toHaveCount(0);
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    if (client === 'copilot') {
      await expect(dialog.getByText('ABCD-1234')).toBeVisible();
      await expect(dialog.getByText(/all qualified Copilot profiles and other tools using GitHub CLI/)).toBeVisible();
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`signin-${client}-${theme}-320.png`), fullPage: true, animations: 'disabled' });
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    fixture.state('verifying');
    await expect(dialog.getByText('Verifying sign-in…', { exact: true })).toBeVisible();
    const reads = fixture.profileReads;
    fixture.state('completed');
    await expect(dialog.getByText('Sign-in verified', { exact: true })).toBeVisible();
    await expect.poll(() => fixture.profileReads).toBeGreaterThan(reads);
    await expect(page.getByText(/Signed in · Fixture folder/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toHaveCount(0);
    await expect(fixture.button).toBeFocused();
    expect(fixture.startCalls).toBe(1);
    expect(fixture.terminalCalls).toBe(0);
  });
}

test('Escape cancels sign-in before dismissing and returns keyboard focus', async ({ page }) => {
  const fixture = await signinFixture(page, 'copilot');
  await fixture.button.click();
  await expect(page.getByRole('dialog').getByText('ABCD-1234')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fixture.cancelCalls).toBe(1);
  await expect(fixture.button).toBeFocused();
  expect(fixture.terminalCalls).toBe(0);
});

test('profile checks pause during browser authorization and refresh after verification', async ({ page }) => {
  await page.clock.install();
  const fixture = await signinFixture(page, 'claude-code');
  await fixture.button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Continue in your browser', { exact: true })).toBeVisible();
  const reads = fixture.profileReads;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(5_100);
  expect(fixture.profileReads).toBe(reads);
  fixture.state('completed');
  await page.clock.runFor(1_000);
  await expect(dialog.getByText('Sign-in verified', { exact: true })).toBeVisible();
  await expect.poll(() => fixture.profileReads).toBeGreaterThan(reads);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(fixture.button).toBeFocused();
});

test('network and cancellation failures retain the attempt and offer recovery', async ({ page }) => {
  const fixture = await signinFixture(page, 'claude-code');
  await fixture.button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Continue in your browser', { exact: true })).toBeVisible();
  fixture.offline(true);
  await expect(dialog.getByRole('alert')).toBeVisible();
  fixture.cancelOffline(true);
  await dialog.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Sign-in is still tracked here');
  fixture.offline(false); fixture.cancelOffline(false);
  fixture.state('failed');
  await dialog.getByRole('button', { name: 'Retry sign-in check', exact: true }).click();
  await expect(dialog.getByText('Sign-in failed', { exact: true })).toBeVisible();
  expect(fixture.startCalls).toBe(1);
  expect(fixture.terminalCalls).toBe(0);
});


test('uncertain cancellation retains the shutdown message until explicitly closed', async ({ page }) => {
  const fixture = await signinFixture(page, 'copilot');
  fixture.cancellationState('uncertain');
  await fixture.button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('ABCD-1234')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Could not confirm shutdown. The sign-in reservation is preserved.');
  await expect(dialog.getByText('Sign-in could not be verified', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel sign-in', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.cancelCalls).toBe(1);
  await expect(fixture.button).toBeFocused();
});
