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
async function openSource(page, name, within = page) {
  const trigger = within.getByRole('button', { name: `Inspect ${name} source`, exact: true }).first();
  await trigger.click();
  return within.getByRole('button', { name: `Hide ${name} source`, exact: true }).first().locator('../../..');
}

test('single Codex setup exposes current values and source files and refreshes only on request', async ({ app, page }) => {
  await page.clock.install();
  await inspect(page, app, 'baseline');
  await expect(page.getByText('Current source evidence', { exact: true })).toBeVisible();
  const effort = await openSource(page, 'model_reasoning_effort');
  await expect(effort).toContainText('medium');
  await expect(effort).toContainText('config.toml');
  const instructions = await openSource(page, 'AGENTS.md');
  await expect(instructions).toContainText('Run the test suite before proposing a commit.');
  await expect(instructions).toContainText('Source files');
  await expect(instructions).not.toContainText('No value was returned by this read.');
  await writeFile(app.instructions.baseline, 'Changed inspection instructions.\n');
  await page.clock.fastForward(5000);
  await expect(instructions).not.toContainText('Changed inspection instructions.');
  await page.getByRole('button', { name: 'Refresh setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh setup', exact: true })).toBeEnabled();
  await expect(instructions).toContainText('Changed inspection instructions.');
  await expect(page.getByRole('button', { name: /^Show \d+ missing sources$/ }).first()).toBeVisible();
  await page.getByRole('searchbox', { name: 'Find a source', exact: true }).fill('AGENTS.override.md');
  await expect(page.getByRole('button', { name: 'Inspect AGENTS.override.md source', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Show \d+ missing sources$/ })).toHaveCount(0);
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
    await expect(await openSource(page, instructionName)).toContainText(`${client} profile inspection instruction.`);
    const skill = await openSource(page, 'source-helper');
    await expect(skill).toContainText('Keep the inspection source text visible.');
    await expect(skill).toContainText('scripts/check.sh');
    const integration = await openSource(page, 'source-tools');
    await expect(integration).toContainText('enabled');
    await expect(integration).toContainText('settings.json');
    await expect(integration).toContainText('false');
    await expect(integration).toContainText('Source role');
    await expect(page.getByText(/native loading or use|native loading and use|native loading, loading and use/).first()).toBeVisible();
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
  await expect(page.getByText('Separate setup inventories', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Summary', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Copy from|Preview copying/ })).toHaveCount(0);
  const category = page.getByRole('region', { name: 'Instructions, agents and rules', exact: true });
  const claude = category.getByRole('region', { name: 'Claude source · Claude Code Instructions, agents and rules', exact: true });
  const projectSource = claude.getByRole('listitem').filter({ hasText: join(repo, 'CLAUDE.md') }).first();
  await projectSource.getByRole('button', { name: 'Inspect CLAUDE.md source', exact: true }).click();
  await expect(claude).toContainText('Project Claude inspection instruction.');
  await expect(claude).toContainText('Project');
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

test('qualified Default choices and colon profile names stay distinct without parsing names', async ({ app, page }) => {
  await inspect(page, app, 'codex:with:colon');
  await expect(await openSource(page, 'AGENTS.md')).toContainText('Colon profile inspection instruction.');
  await page.getByRole('link', { name: 'Compare with…', exact: true }).click();
  const left = page.getByRole('combobox', { name: /First · left side/ });
  await expect(left).toHaveValue(JSON.stringify(['codex', 'codex:with:colon']));
  for (const label of ['Default · Codex', 'Default · Claude Code', 'Default · GitHub Copilot']) await expect(left.getByRole('option', { name: label, exact: true })).toHaveCount(1);
  await page.getByRole('combobox', { name: /Second · right side/ }).selectOption({ label: 'Default · Claude Code' });
  await page.getByRole('button', { name: 'Compare setups', exact: true }).click();
  await expect(page.getByText('Separate setup inventories', { exact: true })).toBeVisible();
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

test('scope validation errors retain the repository and unreadable sources stay explicit', async ({ app, page }) => {
  await inspect(page, app, 'baseline', 'codex', '/missing-inspection-repository');
  await expect(page.getByRole('alert')).toContainText('Couldn’t read this project');
  await expect(page.getByRole('textbox', { name: 'Repository scope (optional)' })).toHaveValue('/missing-inspection-repository');
  const claudeRoot = app.setupSources.nativeRoots['claude-code'];
  await rm(join(claudeRoot, 'settings.json'));
  await mkdir(join(claudeRoot, 'settings.json'));
  await inspect(page, app, 'Claude source', 'claude-code');
  const unreadable = await openSource(page, 'settings.json');
  await expect(unreadable).toContainText('settings.json');
  await expect(unreadable).toContainText('unavailable');
  await page.getByRole('button', { name: 'Show reading coverage', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Setup source inventory' })).toContainText('Partly read');
  await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('memory');
  await expect(page.getByText('No source observations in this category. Read the coverage above for limits.', { exact: true })).toBeVisible();
});

for (const [width, theme] of [[320, 'light'], [390, 'dark'], [1200, 'light']]) {
  test(`source inspection preserves keyboard focus and reflows at ${width}px in ${theme}`, async ({ app, page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(theme => localStorage.setItem('xenoflux-theme', theme), theme);
    await inspect(page, app, 'Claude source', 'claude-code');
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    const source = page.getByRole('button', { name: 'Inspect settings.json source', exact: true });
    await source.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Hide settings.json source', exact: true })).toBeFocused();
    await expect(page.getByText('claude-code-fixture', { exact: false }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  });
}
