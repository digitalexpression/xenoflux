import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect } from './fixtures.js';
import { createUiBrowserFixture } from '../../test-support/ui-browser-fixture.js';
import { remove } from '../../src/profiles.js';

const test = base.extend({
  app: async ({}, use) => {
    const app = await createUiBrowserFixture({ setupInspection: true });
    try { await use(app); } finally { await app.close(); }
  },
});
const inspectPath = (name, client = 'codex', repo) => `/profiles/${encodeURIComponent(name)}/setup?${new URLSearchParams({ client, ...(repo ? { repo } : {}) })}`;
async function inspect(page, app, name, client = 'codex', repo) {
  await page.goto(app.origin + inspectPath(name, client, repo));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Inspect setup · ${name}`);
  await expect(page.getByRole('button', { name: 'Refresh setup', exact: true })).toBeEnabled();
}
const sourceRow = (within, name) => within.getByRole('button', { name: `Inspect ${name} source`, exact: true }).first();
const inspectorPane = page => page.getByRole('complementary', { name: 'Inspector', exact: true });
const sourceSearch = page => page.getByRole('searchbox', { name: 'Find a source', exact: true });

async function openSource(page, name) {
  await sourceSearch(page).fill(name);
  const row = sourceRow(page, name);
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  const inspector = inspectorPane(page);
  await expect(inspector.getByRole('heading', { name, exact: true })).toBeVisible();
  return inspector;
}

test('single Codex setup exposes current values and source files and refreshes only on request', async ({ app, page }) => {
  await page.clock.install();
  await inspect(page, app, 'baseline');
  const inspector = inspectorPane(page);
  await expect(inspector).toBeVisible();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  const settingsGroup = settings.getByRole('button', { name: /^Settings/ });
  await expect(settingsGroup).toHaveAttribute('aria-expanded', 'true');
  await sourceRow(settings, 'model_reasoning_effort').click();
  await expect(inspector).toContainText('medium');
  await expect(inspector).toContainText('config.toml');
  const instructions = page.getByRole('region', { name: 'Instructions, agents and rules', exact: true });
  const instructionsGroup = instructions.getByRole('button', { name: /^Instructions, agents and rules/ });
  const agents = sourceRow(instructions, 'AGENTS.md');
  await expect(instructionsGroup).toHaveAttribute('aria-expanded', 'false');
  await instructionsGroup.press('Enter');
  await agents.click();
  await expect(inspector).toContainText('Source files');
  await expect(inspector).not.toContainText('No value was returned by this read.');
  await inspector.getByRole('button', { name: 'Source preview', exact: true }).click();
  await expect(inspector).toContainText('Run the test suite before proposing a commit.');
  await instructionsGroup.press('Space');
  await expect(agents).toBeHidden();
  await expect(inspector).toContainText('Run the test suite before proposing a commit.');
  await writeFile(app.instructions.baseline, 'Changed inspection instructions.\n');
  await page.clock.fastForward(5000);
  await expect(inspector).not.toContainText('Changed inspection instructions.');
  await page.getByRole('button', { name: 'Refresh setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh setup', exact: true })).toBeEnabled();
  await expect(inspector).toContainText('Changed inspection instructions.');
  await instructionsGroup.press('Enter');
  await expect(agents).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('button', { name: /^Show \d+ missing sources$/ }).first()).toBeVisible();
  await sourceSearch(page).fill('AGENTS.override.md');
  await expect(sourceRow(page, 'AGENTS.override.md')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Show \d+ missing sources$/ })).toHaveCount(0);
  await sourceSearch(page).fill('no-such-source-observation');
  await expect(inspector).toBeVisible();
  await expect(page.getByRole('region', { name: 'Setup sources', exact: true }).getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Copy from/ })).toHaveCount(0);
  await expect(readFile(app.nativeProfileLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

for (const [client, name, instructionName] of [['claude-code', 'Claude source', 'CLAUDE.md'], ['copilot', 'Copilot source', 'copilot-instructions.md']]) {
  test(`${client} source inspection works with no installed bound CLI and shows values, skills and integration state`, async ({ app, page }) => {
    await inspect(page, app, name, client);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const settings = await openSource(page, 'settings.json');
    await expect(settings).toContainText(`${client}-fixture`);
    await expect(settings).toContainText(app.setupSources.nativeRoots[client]);
    const instructions = await openSource(page, instructionName);
    await instructions.getByRole('button', { name: 'Source preview', exact: true }).click();
    await expect(instructions).toContainText(`${client} profile inspection instruction.`);
    const skill = await openSource(page, 'source-helper');
    await skill.getByRole('button', { name: 'Source preview', exact: true }).click();
    await expect(skill).toContainText('Keep the inspection source text visible.');
    await expect(skill).toContainText('scripts/check.sh');
    const integration = await openSource(page, 'source-tools');
    await expect(integration).toContainText('enabled');
    await expect(integration).toContainText('settings.json');
    await expect(integration).toContainText('false');
    await expect(integration).toContainText('Source role');
    await page.getByText('Reading limits', { exact: true }).click();
    const limits = page.getByRole('region', { name: 'Reading limits', exact: true });
    await expect(limits.getByText('Current source evidence', { exact: true })).toBeVisible();
    await expect(limits.getByText(/native loading or use|native loading and use|native loading, loading and use/).first()).toBeVisible();
    await expect(readFile(app.nativeProfileLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
}

test('inspector carries its first choice and repository into mixed categories, swap and change', async ({ app, page }) => {
  const repo = app.setupSources.repository;
  await inspect(page, app, 'baseline', 'codex', repo);
  await page.getByRole('link', { name: 'Compare with…', exact: true }).click();
  await expect(page.getByRole('combobox', { name: /First · left side/ })).toHaveValue(JSON.stringify(['codex', 'baseline']));
  await expect(page.getByRole('textbox', { name: 'Repository scope (optional)' })).toHaveValue(repo);
  await page.getByRole('combobox', { name: /Second · right side/ }).selectOption({ label: 'Claude source · Claude Code' });
  await page.getByRole('button', { name: 'Compare setups', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Setup comparison', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Filter results' }).getByRole('button', { name: 'Different', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Copy from|Preview copying/ })).toHaveCount(0);
  const category = page.getByRole('region', { name: 'Instructions, agents and rules', exact: true });
  const instructions = category.getByRole('button', { name: /^Instructions, agents and rules/ });
  await expect(instructions).toHaveAttribute('aria-expanded', 'false');
  await instructions.press('Enter');
  await category.getByRole('button', { name: 'Source record CLAUDE.md Project', exact: true }).click();
  const sourceDetails = page.getByRole('complementary', { name: 'Inspector', exact: true });
  await expect(sourceDetails).toContainText(join(repo, 'CLAUDE.md'));
  await sourceDetails.getByRole('button', { name: 'Inspect CLAUDE.md source', exact: true }).click();
  await expect(sourceDetails).toContainText('Project Claude inspection instruction.');
  await page.getByRole('button', { name: 'Swap the two profiles', exact: true }).click();
  await expect(page).toHaveURL(/a=Claude\+source/);
  expect(new URL(page.url()).searchParams.get('repo')).toBe(repo);
  await page.getByRole('button', { name: 'Change profiles…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Change profiles' });
  await expect(dialog.getByRole('textbox', { name: 'Repository scope (optional)' })).toHaveValue(repo);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh setups', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh setups', exact: true })).toBeEnabled();
  expect(new URL(page.url()).searchParams.get('repo')).toBe(repo);
});

test('mixed setups align exact skill names and keep per-profile source evidence on refresh', async ({ app, page }) => {
  const { repository: repo, nativeRoots } = app.setupSources;
  const claude = nativeRoots['claude-code'];
  for (const [root, name, description] of [
    [app.homes.baseline.home, 'source-helper', 'Codex source helper.'],
    [join(repo, '.claude'), 'source-helper', 'Project source helper.'],
    [claude, 'Review-helper', 'Case-variant Claude skill.'],
  ]) {
    const directory = join(root, 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${app.origin}/compare/setups?${new URLSearchParams({ a: 'baseline', b: 'Claude source', bClient: 'claude-code', repo })}`);
  const skills = page.getByRole('region', { name: 'Skills', exact: true });
  const skill = skills.getByRole('button', { name: 'Name match source-helper', exact: true });
  await expect(skill).toContainText('1 source');
  await expect(skill).toContainText('2 sources');
  const caseVariant = skills.getByRole('button', { name: 'Seen on one side Review-helper', exact: true });
  await expect(caseVariant).toContainText('Not observed');
  await page.getByRole('button', { name: 'Name matches', exact: true }).click();
  await expect(skills.getByRole('listitem')).toHaveCount(1);
  await skill.press('Enter');
  const inspector = page.getByRole('dialog', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: 'source-helper' })).toBeFocused();
  await expect(inspector).toContainText(join(repo, '.claude', 'skills', 'source-helper'));
  await expect(inspector).toContainText(join(claude, 'skills', 'source-helper'));
  await page.keyboard.press('Escape');
  await expect(skill).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole('button', { name: 'One side observed', exact: true }).click();
  await expect(skill).toHaveCount(0);
  const search = page.getByRole('searchbox', { name: 'Find an item' });
  await search.fill('review-helper');
  await expect(skills.getByRole('listitem')).toHaveCount(2);
  await search.fill('no-such-skill');
  await expect(page.getByRole('status')).toHaveText('0 items');
  await rm(join(claude, 'skills', 'Review-helper'), { recursive: true });
  await search.fill('review-helper');
  await page.getByRole('button', { name: 'Refresh setups', exact: true }).click();
  await expect(skills.getByRole('listitem')).toHaveCount(1);
  await expect(caseVariant).toHaveCount(0);
  await expect(readFile(app.nativeProfileLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('qualified Default choices and colon profile names stay distinct without parsing names', async ({ app, page }) => {
  await inspect(page, app, 'codex:with:colon');
  const inspector = await openSource(page, 'AGENTS.md');
  await inspector.getByRole('button', { name: 'Source preview', exact: true }).click();
  await expect(inspector).toContainText('Colon profile inspection instruction.');
  await page.getByRole('link', { name: 'Compare with…', exact: true }).click();
  const left = page.getByRole('combobox', { name: /First · left side/ });
  await expect(left).toHaveValue(JSON.stringify(['codex', 'codex:with:colon']));
  for (const label of ['Default · Codex', 'Default · Claude Code', 'Default · GitHub Copilot']) await expect(left.getByRole('option', { name: label, exact: true })).toHaveCount(1);
  await page.getByRole('combobox', { name: /Second · right side/ }).selectOption({ label: 'Default · Claude Code' });
  await page.getByRole('button', { name: 'Compare setups', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Setup comparison', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('a')).toBe('codex:with:colon');
  expect(new URL(page.url()).searchParams.get('aClient')).toBeNull();
});

test('removed setup choices retain the explicit selection and request a replacement', async ({ app, page }) => {
  await page.clock.install();
  await page.goto(`${app.origin}/compare/setups?a=codex%3Awith%3Acolon`);
  const left = page.getByRole('combobox', { name: /First · left side/ });
  await expect(left).toHaveValue(JSON.stringify(['codex', 'codex:with:colon']));
  await app.store.update(data => { remove(data, 'codex:with:colon'); });
  const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/setups/options');
  await page.clock.fastForward(5000);
  await checked;
  await expect(left.locator('option:checked')).toContainText('codex:with:colon · Codex · unavailable');
  await expect(page.getByText('codex:with:colon · Codex · This setup is no longer available. Choose a setup explicitly.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare setups', exact: true })).toBeDisabled();
});

test('Change setup switches vendors and applies the selected repository scope', async ({ app, page }) => {
  await inspect(page, app, 'baseline');
  const repo = app.setupSources.repository;
  await page.getByRole('button', { name: 'Change setup…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Change setup', exact: true });
  await dialog.getByRole('combobox', { name: 'Profile and client' }).selectOption({ label: 'Copilot source · GitHub Copilot' });
  await dialog.getByRole('textbox', { name: 'Repository scope (optional)' }).fill(repo);
  await dialog.getByRole('button', { name: 'Inspect setup', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Copilot source');
  await expect(dialog).toBeHidden();
  expect(new URL(page.url()).searchParams.get('repo')).toBe(repo);
  await sourceSearch(page).fill('copilot-instructions.md');
  await expect(inspectorPane(page).getByRole('heading', { name: 'copilot-instructions.md' })).toBeVisible();
});

test('scope validation errors retain the repository and unreadable sources stay explicit', async ({ app, page }) => {
  await inspect(page, app, 'baseline', 'codex', '/missing-inspection-repository');
  await expect(page.getByRole('alert')).toContainText('Couldn’t read this project');
  await page.getByRole('button', { name: 'Change setup…', exact: true }).click();
  const scope = page.getByRole('dialog', { name: 'Change setup', exact: true });
  const repository = scope.getByRole('textbox', { name: 'Repository scope (optional)' });
  await expect(repository).toHaveValue('/missing-inspection-repository');
  await repository.fill(app.setupSources.repository);
  await scope.getByRole('button', { name: 'Inspect setup', exact: true }).click();
  await expect(inspectorPane(page)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('repo')).toBe(app.setupSources.repository);
  const claudeRoot = app.setupSources.nativeRoots['claude-code'];
  await rm(join(claudeRoot, 'settings.json'));
  await mkdir(join(claudeRoot, 'settings.json'));
  await inspect(page, app, 'Claude source', 'claude-code');
  const unreadable = await openSource(page, 'settings.json');
  await expect(unreadable).toContainText('settings.json');
  await expect(unreadable).toContainText('unavailable');
  const limitsTrigger = page.getByText('Reading limits', { exact: true });
  await limitsTrigger.click();
  const limits = page.getByRole('region', { name: 'Reading limits', exact: true });
  await limits.getByRole('button', { name: 'Show reading coverage', exact: true }).click();
  await expect(limits).toContainText('Partly read');
  await limitsTrigger.press('Escape');
  await sourceSearch(page).clear();
  const memory = page.getByRole('region', { name: 'Memory settings', exact: true });
  await memory.getByRole('button', { name: /^Memory settings/ }).click();
  await expect(memory).toContainText('No sources observed');
  await expect(memory).toContainText('Not known');
});

for (const [width, theme] of [[320, 'light'], [390, 'dark'], [1200, 'light']]) {
  test(`source inspection preserves keyboard focus and reflows at ${width}px in ${theme}`, async ({ app, page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(theme => localStorage.setItem('xenoflux-theme', theme), theme);
    await inspect(page, app, 'Claude source', 'claude-code');
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    const inspector = inspectorPane(page);
    await expect(inspector).toBeInViewport();
    const source = sourceRow(page, 'settings.json');
    await source.focus();
    await page.keyboard.press('Enter');
    await expect(source).toBeFocused();
    await expect(inspector).toBeInViewport();
    await expect(inspector.getByRole('heading', { name: 'settings.json', exact: true })).toBeInViewport();
    await expect(inspector).toContainText('claude-code-fixture');
    await sourceSearch(page).fill('source-helper');
    await inspector.getByRole('button', { name: 'Source preview' }).click();
    const preview = inspector.getByRole('region', { name: /Source file .*SKILL\.md/ });
    await expect(preview).toBeInViewport();
    await expect(preview).toContainText('Keep the inspection source text visible.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  });
}
