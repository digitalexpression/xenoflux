import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { test, expect } from './fixtures.js';
import { bookingLedgerPair } from '../../test-support/audit-explanation/booking-ledger.js';
import { compareAuditRuns } from '../../src/audit-report.js';
import { captureAuditWorkspacePatch } from '../../src/audit-workspace-patch.js';

function comparisonWithPatch() {
  const pair = bookingLedgerPair();
  const bytes = Buffer.from('diff --git a/example.js b/example.js\n--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-export const sum = 0;\n+export const sum = 10;\n');
  const fingerprint = 'a'.repeat(64), baselineFingerprint = 'b'.repeat(64);
  const patchSha256 = createHash('sha256').update(bytes).digest('hex');
  pair[0].workspace.taskEnd = { status: 'changed', fingerprint, baselineFingerprint, patchSha256,
    fileCount: 1, patchContent: captureAuditWorkspacePatch(bytes, { fingerprint, patchSha256 }, {
      baselineFingerprint, sourceBaselineCommit: pair[0].sourceWorkspace.sourceCommit, sourceBaselineTree: pair[0].sourceWorkspace.sourceTree,
    }) };
  return compareAuditRuns(...pair);
}

async function openValue(page, app, value) {
  await page.goto(`${app.origin}/reports/open`);
  await page.getByLabel('Choose the report’s JSON file').setInputFiles({ name: 'patches.audit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await page.getByRole('link', { name: 'View report' }).click();
}

async function exportValue(page, include) {
  await page.getByRole('link', { name: 'Export report', exact: true }).first().click();
  if (include) await page.getByRole('checkbox', { name: 'Include recorded messages and tool content' }).check();
  const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/export'));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const result = await (await response).json();
  const path = `${result.folder.replace(/^~(?=\/|$)/, homedir())}${result.files.find(file => file.endsWith('.audit.json'))}`;
  return JSON.parse(await readFile(path, 'utf8'));
}

test('empty captured patches show no changes without a missing-content warning', async ({ app, page }) => {
  const pair = bookingLedgerPair();
  const patchSha256 = createHash('sha256').update('').digest('hex');
  const fingerprint = 'a'.repeat(64);
  for (const run of pair) run.workspace.taskEnd = { status: 'clean', fingerprint, baselineFingerprint: fingerprint, patchSha256,
    captureComplete: true, timing: 'task-end', fileCount: 0,
    patchContent: captureAuditWorkspacePatch(Buffer.alloc(0), { fingerprint, patchSha256 }, {
      baselineFingerprint: fingerprint, sourceBaselineCommit: run.sourceWorkspace.sourceCommit, sourceBaselineTree: run.sourceWorkspace.sourceTree,
    }) };
  await openValue(page, app, compareAuditRuns(...pair));
  await expect(page.getByText('No patch changes', { exact: true })).toHaveCount(2);
  await expect(page.getByText(/^Not in this report:/)).toHaveCount(0);
  await expect(page.getByText('Content omitted', { exact: true })).toHaveCount(0);
});

test('task-end patches remain inspectable only with selected content and explain absent evidence', async ({ app, page }, testInfo) => {
  const value = comparisonWithPatch();
  await openValue(page, app, value);
  const left = page.getByRole('region', { name: 'A task-end patch', exact: true });
  await expect(left).toContainText('may include setup changes');
  await expect(page.getByRole('region', { name: 'B task-end patch', exact: true })).toContainText('did not retain patch content');
  await left.getByRole('button', { name: 'Inspect A patch', exact: true }).click();
  await expect(page.getByLabel('A captured patch', { exact: true })).toContainText('+export const sum = 10;');
  for (const theme of ['light', 'dark']) {
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
    await page.setViewportSize({ width: 800, height: 900 });
    await left.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`patch-${theme}-800.png`) });
  }
  const omitted = await exportValue(page, false);
  expect(omitted.left.workspace.taskEnd.patchContent.status).toBe('omitted');
  expect(omitted.left.workspace.taskEnd.patchContent.text).toBeUndefined();
  await openValue(page, app, omitted);
  await expect(page.getByRole('region', { name: 'A task-end patch', exact: true })).toContainText('omitted from this export');
  await expect(page.getByRole('button', { name: 'Inspect A patch', exact: true })).toHaveCount(0);

  await openValue(page, app, value);
  const included = await exportValue(page, true);
  await openValue(page, app, included);
  await page.getByRole('button', { name: 'Inspect A patch', exact: true }).click();
  await expect(page.getByLabel('A captured patch', { exact: true })).toContainText('+export const sum = 10;');
});
