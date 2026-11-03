import { test, expect } from './fixtures.js';

test('persist the theme and cancel a keyboard-operated dialog on a narrow screen', async ({ app, page }) => {
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
  const create = page.getByRole('button', { name: 'Create profile…' });
  await create.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Create a profile' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Name' }).fill('cancelled-profile');
  await page.keyboard.press('Tab');
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(create).toBeFocused();
  expect((await app.store.read()).profiles.some(profile => profile.name === 'cancelled-profile')).toBe(false);
});

test('focus and describe the required profile name after empty submit', async ({ app, page }) => {
  const profileCount = (await app.store.read()).profiles.length;
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Profiles' }).click();
  await page.getByRole('button', { name: 'Create profile…' }).click();
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
