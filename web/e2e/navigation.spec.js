import { test, expect } from './fixtures.js';

test('both sidebar states keep the same navigation icons and toolbar actions available', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const navigation = page.getByRole('navigation', { name: 'Primary', exact: true });
  await navigation.getByRole('link', { name: 'Profiles', exact: true }).click();
  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true });
  const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
  const add = page.locator('.app-toolbar').getByRole('button', { name: 'Add a profile', exact: true });
  const sidebar = page.locator('#app-sidebar');
  const iconLinks = ['Sessions', 'Comparisons', 'Saved reports', 'Profiles', 'Activity']
    .map(name => sidebar.getByRole('link', { name, exact: true }));
  await expect(add).toBeEnabled();
  for (const link of iconLinks) await expect(link.locator('svg')).toBeVisible();
  await collapse.press('Enter');
  await expect(navigation).toBeVisible();
  const profiles = navigation.getByRole('link', { name: 'Profiles', exact: true });
  await expect(profiles).toHaveAttribute('title', 'Profiles');
  await expect(profiles).toHaveAttribute('aria-current', 'page');
  await expect(profiles.getByText('Profiles', { exact: true })).toBeHidden();
  for (const link of iconLinks) await expect(link.locator('svg')).toBeVisible();
  expect((await sidebar.boundingBox()).width).toBeLessThanOrEqual(56);
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await add.click();
  await expect(page.getByRole('menuitem', { name: 'Create profile', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  await navigation.getByRole('link', { name: 'Sessions', exact: true }).click();
  await expect(navigation.getByRole('link', { name: 'Sessions', exact: true })).toHaveAttribute('aria-current', 'page');
  await profiles.click();
  await page.reload();
  await expect(expand).toBeVisible();
  await expect(profiles).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expand.press('Enter');
  await expect(profiles.getByText('Profiles', { exact: true })).toBeVisible();
  await expect(collapse).toBeFocused();
});

test('persist the theme and return keyboard focus after canceling either profile dialog on a narrow screen', async ({ app, page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page).not.toHaveURL(/launch=/);
  const theme = page.getByRole('combobox', { name: 'Theme' });
  await theme.selectOption('light');
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await background();
  await theme.selectOption('dark');
  await expect.poll(background).not.toBe(light);
  await page.reload();
  await expect(theme).toHaveValue('dark');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Profiles' }).click();
  const add = page.getByRole('button', { name: 'Add a profile', exact: true });
  const menu = page.getByRole('menu', { name: 'Add a profile', exact: true });
  const create = menu.getByRole('menuitem', { name: 'Create profile', exact: true });
  const existing = menu.getByRole('menuitem', { name: 'Add existing profile folder', exact: true });
  await expect(add).toBeEnabled();
  await add.focus();
  await add.press('ArrowDown');
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await expect(create).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(existing).toBeFocused();
  await page.keyboard.press('Enter');
  const addDialog = page.getByRole('dialog', { name: 'Add existing profile folder', exact: true });
  await expect(addDialog).toBeVisible();
  await expect(menu).toHaveCount(0);
  await addDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(addDialog).toHaveCount(0);
  await expect(add).toBeFocused();

  await add.press('Enter');
  await expect(create).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Create a profile', exact: true });
  await expect(dialog).toBeVisible();
  await expect(menu).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Name' }).fill('cancelled-profile');
  await page.keyboard.press('Tab');
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  expect((await app.store.read()).profiles.some(profile => profile.name === 'cancelled-profile')).toBe(false);
});

test('focus and describe the required profile name after empty submit', async ({ app, page }) => {
  const profileCount = (await app.store.read()).profiles.length;
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Profiles' }).click();
  await page.getByRole('button', { name: 'Add a profile', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Create profile', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a profile' });
  const submit = dialog.getByRole('button', { name: 'Create profile', exact: true });
  await submit.focus();
  await page.keyboard.press('Enter');

  const name = dialog.getByRole('textbox', { name: 'Name' });
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription('Enter a name for the new profile.');
  await expect(dialog.getByText('Enter a name for the new profile.')).toBeVisible();
  expect((await app.store.read()).profiles).toHaveLength(profileCount);
  await expect(submit).toBeVisible();
});
