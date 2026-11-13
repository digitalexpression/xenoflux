import { test, expect } from './fixtures.js';

for (const [client, vendor, cli] of [['copilot', 'GitHub Copilot', 'Copilot CLI'], ['claude-code', 'Claude', 'Claude Code']]) {
  const name = `${vendor} desktop fixture`;
  async function surface(page, { stale = false } = {}) {
    let phase = 'available', appKey = 'a'.repeat(64), finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const requests = [];
    const card = () => ({ name, client, isDefault: false, state: 'ready', reason: null,
      signIn: 'Sign-in not checked', accountScope: client === 'claude-code' ? 'per-root' : 'unverified', accountIndependence: 'not verified',
      binding: 'no project', summary: `Disposable native startup boundary at /fixtures/${'a'.repeat(140)}/profile.`,
      cli: { state: 'unavailable', text: `${cli} is not installed in this fixture.` },
      desktop: { state: phase === 'running' ? 'running' : 'not-running', text: phase === 'running'
        ? 'Running with the selected profile storage. Account scope and model use remain unverified.'
        : phase === 'stopped' ? 'Closed. Release its reservation before reusing this profile.' : 'Available for this profile.' },
      clientActions: phase === 'available' ? [{ id: 'open-desktop', label: `Open ${vendor} Desktop`, appKey }]
        : phase === 'stopped' ? [{ id: 'recover-desktop', label: 'Release closed Desktop reservation' }] : [], moreMenu: [] });
    await page.route('**/api/profiles', async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, profiles: [...data.profiles, card()] } });
    });
    await page.route(`**/api/profiles/${encodeURIComponent(name)}/clients`, async route => {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (body.action === 'open-desktop') {
        if (stale) {
          appKey = 'b'.repeat(64);
          await route.fulfill({ status: 409, json: { error: { code: 'app-changed', message: `${vendor} changed after discovery. Refresh before opening.` } } });
          return;
        }
        await pending;
        phase = 'running';
      } else if (body.action === 'recover-desktop') phase = 'available';
      else throw new Error('Unexpected native action in fixture');
      await route.fulfill({ json: { status: 'success', message: body.action === 'open-desktop' ? `Opened the selected ${vendor} profile.` : 'Released the closed Desktop reservation.' } });
    });
    return { requests, finish: () => finish(), quit: () => { phase = 'stopped'; } };
  }

  for (const [width, theme] of [[320, 'light'], [390, 'dark'], [1280, 'light']]) {
    test(`${vendor} Desktop action carries installation identity, fences duplicates and releases closed ownership at ${width}px ${theme}`, async ({ page, app }) => {
      await page.clock.install();
      await page.setViewportSize({ width, height: 900 });
      const native = await surface(page);
      try {
        await page.goto(`${app.origin}/profiles`);
        await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
        const card = page.getByRole('article', { name, exact: true });
        await expect(card).toContainText(`${cli} is not installed`);
        await expect(card).toContainText(vendor);
        const open = card.getByRole('button', { name: `Open ${vendor} Desktop for ${name}`, exact: true });
        await open.focus(); await page.keyboard.press('Enter');
        await expect(open).toBeDisabled();
        await expect(open).toHaveAttribute('aria-busy', 'true');
        await expect(card).toContainText('Opening Desktop…');
        expect(native.requests).toEqual([{ action: 'open-desktop', appKey: 'a'.repeat(64) }]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        native.finish();
        await expect(card).toContainText('Running with the selected profile storage');
        await expect(card.getByRole('button', { name: `Open ${vendor} Desktop for ${name}` })).toHaveCount(0);
        await expect(card.getByRole('button', { name: /Check sign-in/ })).toHaveCount(0);
        native.quit();
        const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/profiles');
        await page.clock.fastForward(5000); await refreshed;
        await card.getByRole('button', { name: `Release closed Desktop reservation for ${name}`, exact: true }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Released the closed Desktop reservation.' })).toBeVisible();
        await expect(open).toBeEnabled();
        expect(native.requests[1]).toEqual({ action: 'recover-desktop' });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally { native.finish(); }
    });
  }

  test(`a changed ${vendor} installation leaves opening available for an explicit retry after refreshed discovery`, async ({ page, app }) => {
    await page.clock.install();
    const native = await surface(page, { stale: true });
    await page.goto(`${app.origin}/profiles`);
    const card = page.getByRole('article', { name, exact: true });
    const open = card.getByRole('button', { name: `Open ${vendor} Desktop for ${name}`, exact: true });
    await open.click();
    await expect(page.getByRole('status').filter({ hasText: `${vendor} changed after discovery.` })).toBeVisible();
    await expect(open).toBeEnabled();
    expect(native.requests).toEqual([{ action: 'open-desktop', appKey: 'a'.repeat(64) }]);
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/profiles');
    await page.clock.fastForward(5000); await refreshed;
    await open.click();
    await expect.poll(() => native.requests.length).toBe(2);
    expect(native.requests[1]).toEqual({ action: 'open-desktop', appKey: 'b'.repeat(64) });
  });

}
