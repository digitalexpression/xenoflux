import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { createUiRunsFixture } from '../../test-support/ui-runs-fixture.js';

const test = base.extend({
  app: async ({}, use) => {
    const app = await createUiRunsFixture();
    try { await use(app); } finally { await app.close(); }
  },
});
const leftSession = '11111111-1111-4111-8111-111111111111';
const rightSession = '22222222-2222-4222-8222-222222222222';
const canaries = ['THINKING_SECRET_CANARY', 'SIGNATURE_SECRET_CANARY', 'OPAQUE_SECRET_CANARY'];
function transcript(sessionId, label) {
  const userId = '33333333-3333-4333-8333-333333333333', assistantId = '44444444-4444-4444-8444-444444444444';
  return [
    { type: 'user', uuid: userId, parentUuid: null, sessionId, cwd: '/fixture/project', timestamp: '2026-11-10T00:00:00Z',
      message: { role: 'user', content: `${label} public user message` } },
    { type: 'assistant', uuid: assistantId, parentUuid: userId, sessionId, cwd: '/fixture/project', timestamp: '2026-11-10T00:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `${label} public assistant answer` },
        { type: 'thinking', thinking: canaries[0], signature: canaries[1] }, { type: 'redacted_thinking', data: canaries[2] }] } },
  ].map(JSON.stringify).join('\n') + '\n';
}
const upload = (sessionId, label) => ({ name: `${sessionId}.jsonl`, mimeType: 'application/jsonl', buffer: Buffer.from(transcript(sessionId, label)) });
async function openImport(page, app) {
  await page.goto(app.url);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open saved report' }).click();
  await expect(page.getByRole('heading', { name: 'Open saved report', exact: true })).toBeVisible();
  await page.getByText('Import Claude Code transcripts', { exact: true }).click();
}
const first = page => page.getByLabel('First Claude transcript', { exact: true });
const second = page => page.getByLabel('Second Claude transcript', { exact: true });
const compare = page => page.getByRole('button', { name: 'Compare stored conversations', exact: true });

// Uses the actual server/importer. Only the HTTP delivery is held to exercise the pending UI guard.
test('explicit Claude snapshot comparison stays private and survives source loss, export and reopen', async ({ page, app }, testInfo) => {
  const posts = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/reports/import/claude-code', async route => {
    posts.push(route.request().postDataJSON()); await gate; await route.continue();
  });
  await openImport(page, app);
  const left = upload(leftSession, 'First'), right = upload(rightSession, 'Second');
  const leftPath = join(app.root, left.name), rightPath = join(app.root, right.name);
  await writeFile(leftPath, left.buffer); await writeFile(rightPath, right.buffer);
  await first(page).setInputFiles(leftPath); await second(page).setInputFiles(rightPath);
  expect(posts).toEqual([]);
  expect(app.calls.captures).toEqual([]);
  await expect(page.getByRole('link', { name: 'View report', exact: true })).toHaveCount(0);
  await compare(page).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({ left: { fileName: left.name, text: left.buffer.toString('utf8') }, right: { fileName: right.name, text: right.buffer.toString('utf8') } });
  await expect(first(page)).toBeDisabled(); await expect(second(page)).toBeDisabled();
  await expect(page.getByLabel('Choose the report’s JSON file')).toBeDisabled();
  const pending = page.getByRole('button', { name: 'Reading stored conversations…', exact: true });
  await expect(pending).toBeDisabled();
  await pending.evaluate(button => button.form.requestSubmit());
  expect(posts).toHaveLength(1);
  release();
  await expect(page.getByText('Imported conversations', { exact: true })).toBeVisible();
  await expect(page.getByText('Imported stored conversations. Missing earlier state and source unknowns remain explicit.', { exact: true })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="saved-summary"]')).toBeFocused();
  await rm(leftPath); await rm(rightPath);
  for (const marker of canaries) await expect(page.getByText(marker, { exact: false })).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`claude-import-${theme}-320.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('link', { name: 'View report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session replay', exact: true })).toBeVisible();
  const reportRef = decodeURIComponent(new URL(page.url()).pathname.split('/reports/')[1]);
  const presented = await app.provider.report({ ref: reportRef });
  for (const marker of canaries) expect(JSON.stringify(presented)).not.toContain(marker);
  const receipt = await app.provider.exportReport({ ref: reportRef });
  const savedPath = join(receipt.folder, receipt.files.find(name => name.endsWith('.audit.json')));
  const frozen = await readFile(savedPath, 'utf8');
  for (const marker of canaries) expect(frozen).not.toContain(marker);
  const report = JSON.parse(frozen);
  for (const run of [report.left, report.right]) {
    expect(run.source.kind).toBe('claude-code-sdk-file-import');
    for (const session of run.sessionReplay.sessions) for (const event of session.events) {
      expect(event.body).toBeNull(); expect(event.bodyStatus).toBe('omitted');
    }
  }
  await app.restartServer();
  await page.goto(app.url);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open saved report' }).click();
  await expect(page.getByRole('heading', { name: 'Open saved report', exact: true })).toBeVisible();
  await page.getByLabel('Choose the report’s JSON file').setInputFiles(savedPath);
  await expect(page.getByRole('link', { name: 'View report', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session replay', exact: true })).toBeVisible();
  expect(app.calls.captures).toEqual([]);
  expect(posts).toHaveLength(1);
});

test('missing, wrongly named, oversized, empty and invalid UTF-8 inputs never import or open a report', async ({ page, app }) => {
  const posts = [];
  page.on('request', request => { if (request.url().endsWith('/api/reports/import/claude-code')) posts.push(request); });
  await openImport(page, app);
  await first(page).setInputFiles(upload(leftSession, 'First'));
  await compare(page).click();
  expect(posts).toEqual([]);
  const badFiles = [
    { name: 'not-a-session.jsonl', buffer: Buffer.from('{}\n') },
    { name: `${leftSession}.jsonl`, buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 0x61) },
    { name: `${leftSession}.jsonl`, buffer: Buffer.alloc(0) },
    { name: `${leftSession}.jsonl`, buffer: Buffer.from([0xc3, 0x28]) },
  ];
  await second(page).setInputFiles(upload(rightSession, 'Second'));
  for (const file of badFiles) {
    await first(page).setInputFiles({ ...file, mimeType: 'application/jsonl' });
    await compare(page).click();
    await expect(page.getByText(/Nothing was opened/)).toBeVisible();
    expect(posts).toEqual([]);
    await expect(page.getByRole('link', { name: 'View report', exact: true })).toHaveCount(0);
  }
  expect(app.calls.captures).toEqual([]);
});

test('UTF-8 decoding preserves a selected leading BOM in the explicit import request', async ({ page, app }) => {
  let observed;
  await page.route('**/api/reports/import/claude-code', async route => {
    observed = route.request().postDataJSON();
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Selected snapshot rejected.', code: 'fixture-rejection' }) });
  });
  await openImport(page, app);
  const left = upload(leftSession, 'First'); left.buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), left.buffer]);
  await first(page).setInputFiles(left); await second(page).setInputFiles(upload(rightSession, 'Second'));
  await compare(page).click();
  await expect(page.getByText(/Nothing was opened/)).toBeVisible();
  expect(observed.left.text.startsWith('\ufeff')).toBe(true);
  await expect(page.getByRole('link', { name: 'View report', exact: true })).toHaveCount(0);
  expect(app.calls.captures).toEqual([]);
});
