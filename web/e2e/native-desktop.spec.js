import { test, expect } from './fixtures.js';

test('Close CLI targets the displayed run and leaves its Desktop running', async ({ page, app }) => {
  const name = 'Claude Work';
  const runId = '00000000-0000-4000-8000-000000000001';
  let cliRunning = true, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const requests = [];
  await page.route('**/api/profiles/refresh', route => route.fulfill({ json: {
    profiles: [{ name, client: 'claude-code', isDefault: false, state: 'ready', accountCheck: false,
      signIn: 'Signed in', binding: 'no project', summary: 'Managed Claude profile', moreMenu: null,
      cli: cliRunning ? { state: 'running', text: 'The CLI is running in Terminal.' } : { state: 'not-running', text: 'The CLI is closed.' },
      desktop: { state: 'running', text: 'Claude Desktop is using this profile.' },
      clientActions: [
        ...(cliRunning ? [{ id: 'show-terminal', label: 'Show Terminal' }, { id: 'close-terminal', label: 'Close CLI', runId }]
          : [{ id: 'open-terminal', label: 'Open in Terminal (Claude Code)…' }]),
        { id: 'focus-desktop', label: 'Show Claude Desktop' }, { id: 'close-desktop', label: 'Close Claude Desktop' },
      ] }], notes: [], simulated: false,
  } }));
  await page.route(`**/api/profiles/${encodeURIComponent(name)}/clients`, async route => {
    requests.push(route.request().postDataJSON());
    await pending;
    cliRunning = false;
    await route.fulfill({ json: { status: 'success', message: `Closed the CLI for ${name}.` } });
  });
  try {
    await page.goto(`${app.origin}/profiles`);
    const card = page.getByRole('article', { name, exact: true });
    const close = card.getByRole('button', { name: `Close CLI for ${name}` });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(close).toHaveAttribute('aria-busy', 'true');
    await expect(card).toContainText('Closing CLI…');
    expect(requests).toEqual([{ action: 'close-terminal', runId }]);
    finish();

    await expect(page.getByRole('status').filter({ hasText: `Closed the CLI for ${name}.` })).toBeVisible();
    await expect(card.getByRole('button', { name: `Open in Terminal (Claude Code) for ${name}` })).toBeEnabled();
    await expect(close).toHaveCount(0);
    await expect(card.getByRole('heading', { name })).toBeFocused();
    await expect(card.getByRole('button', { name: `Show Claude Desktop for ${name}` })).toBeEnabled();
    await expect(card).toContainText('Claude Desktop is using this profile.');
    expect(requests).toHaveLength(1);
  } finally { finish(); }
});

for (const [client, vendor, cli] of [['copilot', 'GitHub Copilot', 'Copilot CLI'], ['claude-code', 'Claude', 'Claude Code']]) {
  const name = `${vendor} desktop fixture`;
  async function surface(page, { stale = false } = {}) {
    let phase = 'available', appKey = 'a'.repeat(64), finish, reconciled = 0;
    const pending = new Promise(resolve => { finish = resolve; });
    const requests = [];
    const card = () => ({ name, client, isDefault: false, state: 'ready', reason: null,
      signIn: 'Sign-in not checked', accountScope: client === 'claude-code' ? 'per-root' : 'unverified', accountIndependence: 'not verified',
      binding: 'no project', summary: `Disposable native startup boundary at /fixtures/${'a'.repeat(140)}/profile.`,
      cli: { state: 'unavailable', text: `${cli} is not installed in this fixture.` },
      desktop: { state: phase === 'running' ? 'running' : 'not-running', text: phase === 'running'
        ? 'Running with the selected profile storage. Account scope and model use remain unverified.'
        : appKey.startsWith('b') ? 'Updated installation is available for this profile.' : 'Available for this profile.' },
      clientActions: phase === 'available' ? [{ id: 'open-desktop', label: `Open ${vendor} Desktop`, appKey }]
        : [{ id: 'focus-desktop', label: `Show ${vendor} Desktop` }, { id: 'close-desktop', label: `Close ${vendor} Desktop` }], moreMenu: [] });
    await page.route('**/api/profiles/refresh', route => {
      if (phase === 'stopped') {
        phase = 'available';
        reconciled++;
      }
      return route.fulfill({ json: { profiles: [card()], notes: [], simulated: false } });
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
      } else if (body.action === 'close-desktop' && phase === 'running') phase = 'available';
      else if (body.action !== 'focus-desktop' || phase !== 'running') throw new Error('Unexpected native action in fixture');
      const message = { 'open-desktop': `Opened the selected ${vendor} profile.`,
        'focus-desktop': `Showed ${vendor} Desktop for this profile.`, 'close-desktop': `Closed ${vendor} Desktop for this profile.` }[body.action];
      await route.fulfill({ json: { status: 'success', message } });
    });
    return { requests, finish: () => finish(), quit: () => { phase = 'stopped'; }, get reconciled() { return reconciled; } };
  }

  for (const [width, theme] of [[320, 'light'], [390, 'dark'], [1280, 'light']]) {
    test(`${vendor} Desktop supports opening, focusing, closing and reopening at ${width}px ${theme}`, async ({ page, app }) => {
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
        await expect(open).toHaveCount(0);
        await expect(card.getByRole('button', { name: /Check sign-in/ })).toHaveCount(0);
        await card.getByRole('button', { name: `Show ${vendor} Desktop for ${name}` }).click();
        await expect(page.getByRole('status')).toContainText(`Showed ${vendor} Desktop for this profile.`);
        expect(native.requests[1]).toEqual({ action: 'focus-desktop' });
        native.quit();
        await page.clock.fastForward(5000);
        await expect(open).toBeEnabled();
        expect(native.reconciled).toBe(1);
        expect(native.requests).toHaveLength(2);
        await open.click();
        await card.getByRole('button', { name: `Close ${vendor} Desktop for ${name}` }).click();
        await expect(page.getByRole('status')).toContainText(`Closed ${vendor} Desktop for this profile.`);
        await expect(open).toBeEnabled();
        expect(native.requests.slice(2)).toEqual([{ action: 'open-desktop', appKey: 'a'.repeat(64) }, { action: 'close-desktop' }]);
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
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/profiles/refresh');
    await page.clock.fastForward(5000); await refreshed;
    await expect(card).toContainText('Updated installation is available for this profile.');
    const retried = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/clients'));
    await open.click();
    await retried;
    expect(native.requests).toHaveLength(2);
    expect(native.requests[1]).toEqual({ action: 'open-desktop', appKey: 'b'.repeat(64) });
  });

}
