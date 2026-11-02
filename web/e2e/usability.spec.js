import { test, expect } from './fixtures.js';

// Traverse the actual tab order; focusing a locator would conceal lost focus.
async function tabTo(page, target) {
  for (let i = 0; i < 30; i++) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

test('keep keyboard focus through session replay, export, and saved reopen', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await tabTo(page, page.getByRole('link', { name: 'Choose two profiles' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Compare setups', level: 1 })).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Compare setups', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Compare setups', level: 1 })).toBeFocused();
  const items = page.getByRole('searchbox', { name: 'Find an item' });
  await tabTo(page, items);
  await items.fill('model_reasoning_effort');
  const effort = page.getByRole('button', { name: /Different model_reasoning_effort/ });
  await tabTo(page, effort);
  await page.keyboard.press('Enter');
  await expect(effort).toBeFocused();
  const sources = page.getByRole('button', { name: 'Where it’s set and what we know' });
  await tabTo(page, sources);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Hide where it’s set' })).toBeFocused();
  await expect(page.locator('aside')).toContainText('Not known');
  await tabTo(page, page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Compare', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  const existing = page.getByRole('link', { name: /^Use existing sessions/ });
  await tabTo(page, existing);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Choose two sessions' })).toBeFocused();
  const search = page.getByRole('searchbox', { name: 'Search task text or project' });
  await tabTo(page, search);
  await search.fill('Fix the date test');
  const strict = page.getByRole('checkbox', { name: /Fix the date test, strict-review, Codex Desktop/ });
  await expect(strict).toBeVisible();
  await tabTo(page, strict);
  await page.keyboard.press('Space');
  await expect(strict).toBeFocused();
  const baseline = page.getByRole('checkbox', { name: /Fix the date test, baseline, Codex CLI/ });
  await tabTo(page, baseline);
  await page.keyboard.press('Space');
  await expect(baseline).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Compare sessions', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  const expandResponse = page.getByRole('button', { name: 'Read full response', exact: true }).first();
  let openedResponseEvent = false;
  if (await expandResponse.count()) {
    await tabTo(page, expandResponse);
    await page.keyboard.press('Enter');
    openedResponseEvent = true;
    const collapseResponse = page.getByRole('button', { name: 'Hide full response', exact: true }).first();
    await expect(collapseResponse).toBeFocused();
    const openResponseEvent = page.getByRole('button', { name: 'Open response event', exact: true }).first();
    await expect(openResponseEvent).toBeVisible();
    await tabTo(page, openResponseEvent);
    await page.keyboard.press('Enter');
    const inspector = page.getByRole('dialog', { name: 'Event inspector', exact: true });
    await expect(inspector.getByRole('heading', { name: 'Event inspector', exact: true })).toBeFocused();
    await inspector.getByRole('button', { name: 'Back to recorded response', exact: true }).click();
    await expect(openResponseEvent).toBeFocused();
  }
  await expect(page.getByRole('heading', { name: 'Behavioral findings' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Paired action evidence' })).toHaveCount(0);

  if (openedResponseEvent) {
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  }
  await tabTo(page, page.getByRole('link', { name: 'Export report', exact: true }).first());
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Export this report' })).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Export', exact: true }));
  await page.keyboard.press('Enter');
  const saved = page.getByRole('status', { name: 'Report saved' });
  await expect(saved).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Copy folder location' })).toBeFocused();

  await tabTo(page, page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open saved report' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Open saved report', level: 1 })).toBeFocused();
  const recent = page.getByRole('region', { name: 'Recently saved' }).getByRole('button')
    .filter({ has: page.getByText('Fix the date test', { exact: true }) });
  await expect(recent).toBeVisible();
  await expect(recent).toContainText('baseline');
  await expect(recent).toContainText('strict-review');
  await tabTo(page, recent);
  await page.keyboard.press('Enter');
  const summary = page.locator('section[aria-labelledby="saved-summary"]');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'View report' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByText('Shown exactly as saved', { exact: false })).toBeVisible();
});

test('saved report summary stays within viewport at narrow and enlarged text sizes', async ({ page }) => {
  await page.getByRole('link', { name: /^Use existing sessions/ }).click();
  await page.getByRole('searchbox', { name: 'Search task text or project' }).fill('Fix the date test');
  await page.getByRole('checkbox', { name: /Fix the date test, baseline, Codex CLI/ }).check();
  await page.getByRole('checkbox', { name: /Fix the date test, strict-review, Codex Desktop/ }).check();
  await page.getByRole('button', { name: 'Compare sessions', exact: true }).click();
  await page.getByRole('link', { name: 'Export report', exact: true }).first().click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Report saved' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open saved report' }).click();
  await page.getByRole('region', { name: 'Recently saved' }).getByRole('button')
    .filter({ has: page.getByText('Fix the date test', { exact: true }) }).click();
  const facts = page.locator('section[aria-labelledby="saved-summary"] dl');
  await expect(facts).toBeVisible();
  for (const [width, fontSize] of [[320, '100%'], [800, '200%']]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(size => { document.documentElement.style.fontSize = size; }, fontSize);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const entries = await facts.locator(':scope > div').all();
    for (const entry of entries) {
      const term = await entry.locator('dt').boundingBox();
      const value = await entry.locator('dd').boundingBox();
      expect(term).not.toBeNull();
      expect(value).not.toBeNull();
      expect(term.y).toBeGreaterThanOrEqual(0);
      expect(value.y).toBeGreaterThanOrEqual(0);
      expect(value.x + value.width).toBeLessThanOrEqual(width + 1);
    }
  }
});
