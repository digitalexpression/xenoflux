import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { createUiRunsFixture } from '../../test-support/ui-runs-fixture.js';

const LEFT = '11111111-1111-4111-8111-111111111111';
const RIGHT = '22222222-2222-4222-8222-222222222222';
const secrets = ['COPILOT_REASONING_PRIVATE', 'COPILOT_TRANSFORMED_PRIVATE', 'COPILOT_TOOL_PRIVATE', 'COPILOT_SYSTEM_PRIVATE'];
const test = base.extend({
  app: async ({}, use) => {
    const reads = [], directories = [];
    let release, rejectRead = false;
    const gate = new Promise(resolve => { release = resolve; });
    const readJournal = async ({ sessionId, directory }) => {
      reads.push(sessionId); directories.push(directory);
      await gate;
      if (rejectRead) throw new Error('PRIVATE_NATIVE_ERROR_BODY');
      const label = sessionId === LEFT ? 'First' : 'Second';
      const event = (id, type, data) => ({ id, type, timestamp: '2026-11-10T00:00:00Z', data });
      const page = { events: [
        event('native-user', 'user.message', { content: `${label} public user message` }),
        event('native-assistant', 'assistant.message', { content: `${label} public assistant answer`, reasoningText: secrets[0], transformedContent: secrets[1] }),
        event('native-tool', 'tool.execution_complete', { content: secrets[2] }),
        event('native-system', 'system.message', { content: secrets[3] }),
      ], cursor: 'fixture-cursor', cursorStatus: 'ok', hasMore: false };
      const bytes = Buffer.from(JSON.stringify(page) + '\n'), file = 'raw-page-01.json';
      await writeFile(join(directory, file), bytes, { flag: 'wx', mode: 0o600 });
      return { complete: true, runtime: { version: 'fixture', protocolVersion: 3 },
        pages: [{ file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }],
        shutdown: { sdkStopJoined: true, childrenClosed: true } };
    };
    const app = await createUiRunsFixture({ copilotImportContext: { readJournal } });
    Object.assign(app, { copilotReads: reads, copilotDirectories: directories, releaseCopilot: release, rejectCopilot: () => { rejectRead = true; release(); } });
    try { await use(app); } finally { release(); await app.close(); }
  },
});
const first = page => page.getByLabel('First Copilot session ID', { exact: true });
const second = page => page.getByLabel('Second Copilot session ID', { exact: true });
const compare = page => page.getByRole('button', { name: 'Compare Copilot conversations', exact: true });
async function openImport(page, app) {
  await page.goto(app.url);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open saved report', exact: true }).click();
  await page.getByText('Import Copilot conversations', { exact: true }).click();
}

test('explicit Copilot import guards duplicate reads and freezes private-safe evidence for source-free reopen', async ({ page, app }, testInfo) => {
  const posts = [];
  page.on('request', request => { if (request.url().endsWith('/api/reports/import/copilot')) posts.push(request.postDataJSON()); });
  await openImport(page, app);
  await first(page).fill(LEFT); await second(page).fill(RIGHT);
  expect(app.copilotReads).toEqual([]); expect(posts).toEqual([]);
  await compare(page).click();
  await expect.poll(() => app.copilotReads.length).toBeGreaterThan(0);
  expect(posts).toEqual([{ left: { sessionId: LEFT }, right: { sessionId: RIGHT } }]);
  await expect(first(page)).toBeDisabled(); await expect(second(page)).toBeDisabled();
  await expect(page.getByLabel('Choose the report’s JSON file')).toBeDisabled();
  const pending = page.getByRole('button', { name: 'Reading Copilot conversations…', exact: true });
  await expect(pending).toBeDisabled(); await pending.evaluate(button => button.form.requestSubmit());
  expect(posts).toHaveLength(1); expect(app.copilotReads.length).toBeLessThanOrEqual(2);
  app.releaseCopilot();
  await expect(page.getByText('Imported Copilot conversations', { exact: true })).toBeVisible();
  await expect(page.getByText('Imported conversations', { exact: true })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="saved-summary"]')).toBeFocused();
  expect(app.copilotReads).toEqual([LEFT, RIGHT]); expect(app.calls.captures).toEqual([]);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`copilot-import-${theme}-320.png`), fullPage: true });
  }
  await page.getByRole('link', { name: 'View report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session replay', exact: true })).toBeVisible();
  const ref = decodeURIComponent(new URL(page.url()).pathname.split('/reports/')[1]);
  const presented = await app.provider.report({ ref });
  const publicReport = JSON.stringify(presented);
  expect(publicReport).toContain('First public assistant answer');
  for (const secret of secrets) expect(publicReport).not.toContain(secret);
  const exported = await app.provider.exportReport({ ref });
  const path = join(exported.folder, exported.files.find(file => file.endsWith('.audit.json')));
  const frozen = await readFile(path, 'utf8');
  for (const secret of secrets) expect(frozen).not.toContain(secret);
  for (const run of [JSON.parse(frozen).left, JSON.parse(frozen).right]) expect(run.source.kind).toBe('copilot-sdk-persisted-import');
  for (const directory of app.copilotDirectories) await rm(directory, { recursive: true, force: true });
  await app.restartServer(); await page.goto(app.url);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open saved report', exact: true }).click();
  await page.getByLabel('Choose the report’s JSON file').setInputFiles(path);
  await page.getByRole('link', { name: 'View report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session replay', exact: true })).toBeVisible();
  expect(app.copilotReads).toEqual([LEFT, RIGHT]); expect(posts).toHaveLength(1); expect(app.calls.captures).toEqual([]);
});

test('missing IDs and links cannot submit a Copilot native read', async ({ page, app }) => {
  await openImport(page, app); await first(page).fill(LEFT); await compare(page).click();
  expect(app.copilotReads).toEqual([]);
  for (const invalid of ['ghapp://sessions/example', '../session', 'session?prompt=hello', 'contains space']) {
    await second(page).fill(invalid); await compare(page).click();
    expect(app.copilotReads).toEqual([]);
    await expect(page.getByRole('link', { name: 'View report', exact: true })).toHaveCount(0);
  }
  expect(app.calls.captures).toEqual([]);
});

test('native read failure shows a sanitized error and restores the selection controls', async ({ page, app }) => {
  await openImport(page, app); await first(page).fill(LEFT); await second(page).fill(RIGHT);
  app.rejectCopilot(); await compare(page).click();
  await expect(page.getByText('Nothing was opened.', { exact: false })).toBeVisible();
  await expect(first(page)).toBeEnabled(); await expect(second(page)).toBeEnabled();
  await expect(page.getByText('PRIVATE_NATIVE_ERROR_BODY', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View report', exact: true })).toHaveCount(0);
  expect(app.calls.captures).toEqual([]);
});
