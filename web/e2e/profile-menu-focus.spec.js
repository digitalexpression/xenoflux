import { test, expect } from './fixtures.js';

for (const theme of ['light', 'dark']) {
  test(`profile edit dialogs return keyboard focus to More in ${theme}`, async ({ app, page }, testInfo) => {
    await page.goto(`${app.origin}/profiles`);
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const before = await app.store.read();
    const more = page.getByRole('button', { name: 'More actions for baseline', exact: true });
    for (const [label, title] of [['Change project binding', 'Change project binding: baseline'], ['Rename', 'Rename profile: baseline'], ['Remove from Xenoflux', 'Remove from Xenoflux: baseline']]) {
      await more.focus();
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu', { name: 'More actions for baseline', exact: true });
      const item = menu.getByRole('menuitem', { name: new RegExp(`^${label}`) });
      await item.focus();
      await expect(item).toBeFocused();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await expect(dialog).toBeVisible();
      if (label === 'Rename') {
        await dialog.getByRole('textbox', { name: 'New name', exact: true }).focus();
        await page.screenshot({ path: testInfo.outputPath(`profile-edit-${theme}.png`), animations: 'disabled' });
      }
      if (label === 'Remove from Xenoflux') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      else await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(more).toBeFocused();
    }
    expect(await app.store.read()).toEqual(before);
  });
}
