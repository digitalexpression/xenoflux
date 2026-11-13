import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from './fixtures.js';

async function openProfiles(page) {
  await page.goto(new URL('/profiles', page.url()).toString());
  await page.getByRole('heading', { name: 'Profiles', exact: true }).waitFor();
}

async function createDialog(page, name) {
  await page.getByRole('button', { name: 'Create profile…' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
}

async function chooseSourceAndPreview(page, name, source = 'baseline') {
  await createDialog(page, name);
  await page.getByRole('radio', { name: /Selected parts of another profile/ }).check();
  await page.getByLabel('Copy parts from').selectOption({ label: source });
  await page.getByRole('button', { name: 'Choose parts and preview' }).click();
  await page.getByRole('heading', { name: new RegExp(`Create ${name} from parts`) }).waitFor();
}

for (const theme of ['light', 'dark']) {
  test(`busy profile actions retain their width and colours in ${theme} mode`, async ({ app, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openProfiles(page);
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
    for (const action of ['create', 'remove']) {
      if (action === 'create') await createDialog(page, 'busy-profile');
      else {
        await page.getByRole('button', { name: 'More actions for baseline' }).click();
        await page.getByRole('menuitem', { name: /^Remove from Xenoflux/ }).click();
      }
      const dialog = page.getByRole('dialog');
      const idleName = action === 'create' ? 'Create profile' : 'Remove from Xenoflux';
      const busyName = action === 'create' ? 'Checking…' : 'Saving…';
      const button = dialog.getByRole('button', { name: idleName, exact: true });
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      await button.focus();
      await page.mouse.move(0, 0);
      const appearance = element => {
        const box = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { width: box.width, height: box.height, background: style.backgroundColor, color: style.color, border: style.borderColor };
      };
      const before = await button.evaluate(appearance);
      const cancelBefore = await cancel.boundingBox();
      const endpoint = action === 'create' ? '**/api/profiles/new' : '**/api/profiles/baseline/remove';
      let release, requests = 0;
      const pending = new Promise(resolve => { release = resolve; });
      await page.route(endpoint, async route => {
        requests++;
        await pending;
        await route.fulfill({ status: 409, contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Fixture request finished.', code: 'fixture' } }) });
      });
      try {
        await page.keyboard.press('Enter');
        const busy = dialog.getByRole('button', { name: busyName, exact: true });
        await expect(busy).toBeDisabled();
        expect(await busy.evaluate(appearance)).toEqual(before);
        expect(await cancel.boundingBox()).toEqual(cancelBefore);
        await page.keyboard.press('Enter');
        await busy.evaluate(element => element.click());
        expect(requests).toBe(1);
      } finally { release(); }
      await expect(dialog.getByText('Fixture request finished.')).toBeVisible();
      await expect(button).toBeEnabled();
      expect(await button.evaluate(appearance)).toEqual(before);
      await page.unroute(endpoint);
      await page.keyboard.press('Escape');
    }
    const profiles = (await app.store.read()).profiles.map(profile => profile.name);
    expect(profiles).toContain('baseline');
    expect(profiles).not.toContain('busy-profile');
  });
}

test('create an empty profile and verify its isolated native home on disk', async ({ app, page }) => {
  await openProfiles(page);
  await createDialog(page, 'browser-empty');
  await page.getByRole('button', { name: 'Create profile', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'browser-empty created' })).toBeVisible();

  const profile = (await app.store.read()).profiles.find(item => item.name === 'browser-empty');
  expect(profile?.native?.root).toBeTruthy();
  const config = await readFile(join(profile.native.root, 'codex-home', 'config.toml'), 'utf8');
  expect(config).toContain('cli_auth_credentials_store = "file"');
  await expect(page.getByRole('heading', { name: 'browser-empty', exact: true })).toBeVisible();
});

test('create from selected instructions only and verify files and credentials boundary', async ({ app, page }) => {
  await openProfiles(page);
  await chooseSourceAndPreview(page, 'browser-parts');
  const agents = page.locator('label.row-select').filter({ hasText: 'AGENTS.md' });
  await expect(agents).toHaveCount(1);
  await agents.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create browser-parts with 1 item' }).click();
  await expect(page.getByRole('heading', { name: '✓ browser-parts created', exact: true })).toBeVisible();

  const profile = (await app.store.read()).profiles.find(item => item.name === 'browser-parts');
  expect(profile?.native?.root).toBeTruthy();
  const home = join(profile.native.root, 'codex-home');
  expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe(await readFile(app.instructions.baseline, 'utf8'));
  expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain('model_reasoning_effort');
  await expect(access(join(home, 'skills', 'review-helper'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(home, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('apply one settings item, preserve the unchecked setup, then undo to original bytes', async ({ app, page }) => {
  const targetBefore = await readFile(app.instructions.strict, 'utf8');
  const source = await readFile(app.instructions.baseline, 'utf8');
  const config = join(app.homes.strict.home, 'config.toml');
  const configBefore = await readFile(config, 'utf8');
  await openProfiles(page);
  await page.getByRole('button', { name: 'More actions for strict-review' }).click();
  await page.getByRole('menuitem', { name: /Copy settings from another profile/ }).click();
  await page.getByLabel('Copy from').selectOption({ label: 'baseline' });
  await page.getByRole('button', { name: 'Choose items' }).click();
  await expect(page.getByRole('heading', { name: 'Copy from baseline into strict-review' })).toBeVisible();

  const agents = page.locator('label.row-select').filter({ hasText: 'AGENTS.md' });
  await expect(agents).toHaveCount(1);
  await agents.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Apply 1 change to strict-review' }).click();
  await expect(page.getByRole('heading', { name: '✓ Copied into strict-review', exact: true })).toBeVisible();
  expect(await readFile(app.instructions.strict, 'utf8')).toBe(source);
  expect(await readFile(config, 'utf8')).toBe(configBefore);

  await page.getByRole('button', { name: 'Undo this copy' }).click();
  await expect(page.getByRole('heading', { name: 'Undone', exact: true })).toBeVisible();
  expect(await readFile(app.instructions.strict, 'utf8')).toBe(targetBefore);

  await page.getByRole('link', { name: 'Back to Profiles' }).click();
  await page.getByRole('button', { name: 'More actions for strict-review' }).click();
  await page.getByRole('menuitem', { name: /Copy settings from another profile/ }).click();
  await page.getByLabel('Copy from').selectOption({ label: 'baseline' });
  await page.getByRole('button', { name: 'Choose items' }).click();
  await page.locator('label.row-select').filter({ hasText: 'AGENTS.md' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Apply 1 change to strict-review' }).click();
  await expect(page.getByRole('heading', { name: '✓ Copied into strict-review', exact: true })).toBeVisible();

  const laterEdit = 'Edited after the copy was applied.\n';
  await writeFile(app.instructions.strict, laterEdit);
  await page.getByRole('button', { name: 'Undo this copy' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Can’t undo safely/i })).toBeVisible();
  await expect(page.getByText(/Nothing was changed/i)).toBeVisible();
  expect(await readFile(app.instructions.strict, 'utf8')).toBe(laterEdit);
});

test('replace one skill package from the UI, preserve other setup, and undo its exact files and modes', async ({ app, page }) => {
  const sourceSkill = join(app.homes.baseline.home, 'skills', 'review-helper');
  const targetSkill = join(app.homes.strict.home, 'skills', 'review-helper');
  const unrelatedSkill = join(app.homes.strict.home, 'skills', app.longSkillNames[0]);
  await writeFile(join(sourceSkill, 'SKILL.md'), 'Updated source skill.\n');
  const sourceBody = await readFile(join(sourceSkill, 'SKILL.md'));
  const targetBody = await readFile(join(targetSkill, 'SKILL.md'));
  const obsoletePath = join(targetSkill, 'extra.txt');
  const obsoleteBody = await readFile(obsoletePath);
  const sourceMode = (await stat(join(sourceSkill, 'SKILL.md'))).mode & 0o777;
  const targetMode = (await stat(join(targetSkill, 'SKILL.md'))).mode & 0o777;
  const obsoleteMode = (await stat(obsoletePath)).mode & 0o777;
  const unrelatedBody = await readFile(join(unrelatedSkill, 'SKILL.md'));
  const configPath = join(app.homes.strict.home, 'config.toml');
  const configBody = await readFile(configPath);
  const configMode = (await stat(configPath)).mode & 0o777;

  await openProfiles(page);
  await page.getByRole('button', { name: 'More actions for strict-review' }).click();
  await page.getByRole('menuitem', { name: /Copy settings from another profile/ }).click();
  await page.getByLabel('Copy from').selectOption({ label: 'baseline' });
  await page.getByRole('button', { name: 'Choose items' }).click();
  const skillRow = page.locator('label.row-select').filter({ hasText: 'review-helper' });
  await expect(skillRow).toContainText('exact replacement');
  await skillRow.getByRole('button', { name: 'Inspect file changes' }).click();
  await expect(skillRow).toContainText('extra.txt');
  await expect(skillRow).toContainText('remove');
  await expect(skillRow.getByText('skills/review-helper/extra.txt', { exact: true })).toBeVisible();
  await expect(skillRow.getByText('skills/review-helper/SKILL.md', { exact: true })).toBeVisible();
  await expect(skillRow.locator('pre').filter({ hasText: 'Check the diff.' })).toBeVisible();
  await expect(skillRow.getByText('Updated source skill.', { exact: true })).toBeVisible();
  await expect(skillRow.getByText('0600 → —', { exact: false })).toBeVisible();
  await skillRow.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Apply 1 change to strict-review' }).click();
  await expect(page.getByRole('heading', { name: '✓ Copied into strict-review', exact: true })).toBeVisible();

  expect(await readFile(join(sourceSkill, 'SKILL.md'))).toEqual(sourceBody);
  expect(await readFile(join(targetSkill, 'SKILL.md'))).toEqual(sourceBody);
  expect((await stat(join(targetSkill, 'SKILL.md'))).mode & 0o777).toBe(sourceMode);
  await expect(access(obsoletePath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(unrelatedSkill, 'SKILL.md'))).toEqual(unrelatedBody);
  expect(await readFile(configPath)).toEqual(configBody);
  expect((await stat(configPath)).mode & 0o777).toBe(configMode);

  await page.getByRole('button', { name: 'Undo this copy' }).click();
  await expect(page.getByRole('heading', { name: 'Undone', exact: true })).toBeVisible();
  expect(await readFile(join(targetSkill, 'SKILL.md'))).toEqual(targetBody);
  expect((await stat(join(targetSkill, 'SKILL.md'))).mode & 0o777).toBe(targetMode);
  expect(await readFile(obsoletePath)).toEqual(obsoleteBody);
  expect((await stat(obsoletePath)).mode & 0o777).toBe(obsoleteMode);
  expect(await readFile(join(unrelatedSkill, 'SKILL.md'))).toEqual(unrelatedBody);
  expect(await readFile(configPath)).toEqual(configBody);
});

test('reject create when selected source instructions changed after preview', async ({ app, page }) => {
  await openProfiles(page);
  await chooseSourceAndPreview(page, 'browser-stale');
  const agents = page.locator('label.row-select').filter({ hasText: 'AGENTS.md' });
  await agents.getByRole('checkbox').check();
  await writeFile(app.instructions.baseline, 'Changed after the preview.\n');
  await page.getByRole('button', { name: 'Create browser-stale with 1 item' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Nothing was changed' })).toBeVisible();
  await expect(page.getByText(/source changed after preview/i)).toBeVisible();
  expect((await app.store.read()).profiles.some(item => item.name === 'browser-stale')).toBe(false);
});

test('compare two setups and inspect all lines of a skill package', async ({ app, page }) => {
  await openProfiles(page);
  const baseline = page.locator('article').filter({ has: page.getByRole('heading', { name: 'baseline', exact: true }) });
  await baseline.getByRole('link', { name: 'Compare with…' }).click();
  await page.getByRole('combobox', { name: /Second · right side/ }).selectOption({ label: 'strict-review · Codex' });
  await page.getByRole('button', { name: 'Compare setups', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Compare setups', exact: true })).toBeVisible();

  const setting = page.getByRole('button').filter({ hasText: 'model_reasoning_effort' });
  await setting.click();
  const detail = page.getByRole('complementary');
  await expect(detail.locator('.edge-a')).toContainText('baseline');
  await expect(detail.locator('.edge-a').getByText('medium', { exact: true })).toBeVisible();
  await expect(detail.locator('.edge-b')).toContainText('strict-review');
  await expect(detail.locator('.edge-b').getByText('high', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Where it’s set and what we know' }).click();
  await expect(detail.getByText(/config\.toml/).first()).toBeVisible();
  await expect(detail.locator('p.meta')).toContainText(/profile/i);
  const unknownFilter = page.getByRole('group', { name: 'Summary' }).getByRole('button', { name: /Could not compare/ });
  await expect(unknownFilter).toBeVisible();
  await page.getByRole('button', { name: 'Show sources' }).click();
  await expect(page.getByText('Reading limits', { exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByText(/couldn’t be read|partial evidence/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  const sourceItem = page.getByRole('button').filter({ hasText: 'allow_symlinked_codex_home' });
  await expect(sourceItem).toBeVisible();
  await sourceItem.click();
  const sourceDetail = page.getByRole('complementary');
  await expect(sourceDetail.getByText('Same within what was read', { exact: true })).toBeVisible();
  await expect(sourceDetail.getByText('true', { exact: true })).toHaveCount(2);
  await expect(sourceDetail).not.toContainText('Value not shown');
  for (const name of app.longSkillNames) {
    const row = page.getByRole('button').filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
  }

  await page.getByRole('button').filter({ hasText: 'review-helper' }).first().click();
  await page.getByRole('link', { name: 'Open package files' }).click();
  await expect(page.getByRole('heading', { name: 'review-helper' })).toBeVisible();
  await page.getByRole('button', { name: /^Show \d+ more lines$/ }).click();
  const packageFile = page.locator('pre').filter({ hasText: app.skillLines[0] });
  for (const line of app.skillLines) await expect(packageFile).toContainText(line);
  await page.getByRole('button', { name: 'Show fewer lines' }).click();
  await expect(packageFile).not.toContainText(app.skillLines[14]);
});

test('Claude creation previews and cancels without launching; selected copy and Undo preserve the profile', async ({ app, page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await openProfiles(page);
  await createDialog(page, 'claude-cancelled');
  await page.getByLabel('Client', { exact: true }).selectOption('claude-code');
  await page.getByRole('button', { name: 'Review profile' }).click();
  await expect(page.getByText('Claude Code executable:', { exact: false })).toBeVisible();
  await expect(access(app.nativeProfileLog)).rejects.toMatchObject({ code: 'ENOENT' });
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  expect((await app.store.read()).profiles.some(p => p.name === 'claude-cancelled')).toBe(false);

  await createDialog(page, 'claude-parts');
  await page.getByLabel('Client', { exact: true }).selectOption('claude-code');
  await page.getByRole('radio', { name: /Selected parts of another profile/ }).check();
  await expect(page.getByLabel('Copy parts from').locator('option')).toHaveText(['Default']);
  await page.getByRole('button', { name: 'Choose parts and preview' }).click();
  const instructions = page.locator('label.row-select').filter({ hasText: 'CLAUDE.md' });
  await instructions.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create claude-parts with 1 item' }).click();
  await expect(page.getByRole('heading', { name: '✓ claude-parts created' })).toBeVisible();
  const profile = (await app.store.read()).profiles.find(p => p.name === 'claude-parts');
  expect(profile.client).toBe('claude-code');
  expect(await readFile(join(profile.native.configRoot, 'CLAUDE.md'), 'utf8')).toBe('Claude fixture instructions.\n');
  await page.getByRole('button', { name: 'Undo this copy' }).click();
  await expect(page.getByRole('heading', { name: 'Undone', exact: true })).toBeVisible();
  await expect(access(join(profile.native.configRoot, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await page.getByRole('link', { name: 'Back to Profiles' }).click();
  const card = page.getByRole('article', { name: 'claude-parts' });
  await expect(card.getByText('Account independence: not verified.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Open Claude Desktop for claude-parts', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Native setup and sign-in' }).click();
  await expect(card.getByText(/CLAUDE_CONFIG_DIR=.*auth login/)).toBeVisible();
  await expect(card.getByText('This command uses the currently installed Claude Code.', { exact: false })).toBeVisible();
  await card.getByRole('button', { name: 'Check sign-in for claude-parts' }).click();
  await expect(card.getByText(/Claude Code · CLI: Signed out/)).toBeVisible();
  expect(await readFile(app.nativeProfileLog, 'utf8')).toBe('--version\nauth status\n');
  const opens = [];
  await page.route('**/api/profiles/claude-parts/clients', async route => {
    opens.push(route.request().postDataJSON());
    await route.fulfill({ json: { status: 'success', message: 'Fixture terminal opened for claude-parts.' } });
  });
  await card.getByRole('button', { name: 'Open in Terminal (Claude Code) for claude-parts', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Fixture terminal opened for claude-parts.');
  expect(opens).toEqual([{ action: 'open-terminal' }]);
});
