import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { test, expect } from './fixtures.js';

test('prepare an export-bound review packet, import a citation, and reopen source-free', async ({ app, page }, testInfo) => {
  await page.goto(`${app.origin}/compare/sessions`);
  const search = page.getByRole('searchbox', { name: 'Search title or project' });
  await search.fill('Fix the date test');
  await page.getByRole('checkbox', { name: /Fix the date test, baseline, Codex CLI/ }).check();
  await page.getByRole('checkbox', { name: /Fix the date test, strict-review, Codex Desktop/ }).check();
  await page.getByRole('checkbox', { name: 'I say these are the same task' }).check();
  await page.getByRole('textbox', { name: 'Task name' }).fill('Fix the date test');
  await page.getByRole('button', { name: 'Compare sessions' }).click();
  await page.getByRole('link', { name: 'Not reviewed' }).click();
  await page.getByRole('link', { name: 'Prepare packet for external review' }).click();
  const before = await readdir(`${app.store.directory}/audits`).catch(() => []);
  await page.getByRole('button', { name: 'Prepare review packet' }).click();
  await expect(page.getByText(/Review packet fingerprint:/)).toBeVisible();
  const result = await page.getByRole('status', { name: 'Report saved' }).innerText();
  expect(result).toContain('Both files are in the folder above');
  const files = await readdir(app.reportsRoot);
  const folder = files.find(name => name.includes('Fix the date test'));
  expect(folder).toBeTruthy();
  const folderPath = `${app.reportsRoot}/${folder}`;
  const names = await readdir(folderPath);
  const jsonPath = `${folderPath}/${names.find(name => name.endsWith('.audit.json'))}`;
  const packet = JSON.parse(await readFile(jsonPath, 'utf8'));
  expect(packet.kind).toBe('audit-evaluation-report');
  expect(packet.reviewPacket.evidenceFingerprint).toBeTruthy();
  expect(packet.reviewState.status).toBe('not-reviewed');
  expect(await readdir(`${app.store.directory}/audits`).catch(() => [])).toEqual(before,
    'preparing a packet does not create a saved evaluation');

  await page.getByRole('link', { name: 'Return to this review packet' }).click();
  await expect(page.getByRole('heading', { name: 'Attach a review' })).toBeVisible();
  const replayRef = packet.reviewPacket.evidenceRefs.find(reference => reference.startsWith('replay:'));
  expect(replayRef, 'the fixture comparison retains reviewable replay-event citations').toBeTruthy();
  const [runId, sessionId, eventId] = JSON.parse(decodeURIComponent(replayRef.slice('replay:'.length)));
  const sideName = packet.subject.left.id === runId ? 'Left' : 'Right';
  const sourceRun = packet.subject.left.id === runId ? packet.subject.left : packet.subject.right;
  const citedEvent = sourceRun.sessionReplay.sessions.find(session => session.id === sessionId).events.find(event => event.id === eventId);
  const submission = { schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.reviewPacket.evidenceFingerprint,
    reviews: [{ id: 'fixture-human', reviewer: { type: 'human', name: 'Fixture reviewer' },
      reviewedAt: '2026-11-01T12:00:00Z', method: 'retained-export-review', scope: packet.reviewPacket.claimScopes[0],
      conclusion: 'positive', preferredRunId: runId, summary: 'This task result meets the stated requirements.', evidenceRefs: [replayRef] }],
    supplementalChecks: [] };
  await page.getByLabel('Review submission JSON').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(submission)) });
  await page.getByRole('button', { name: 'Preview imported review' }).click();
  const reviewPreview = page.getByRole('region', { name: 'Review preview' });
  await expect(reviewPreview).toContainText('Fixture reviewer');
  for (const theme of ['light', 'dark']) {
    await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
    await page.setViewportSize({ width: 800, height: 900 });
    await reviewPreview.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`review-preview-${theme}-800.png`), fullPage: true });
  }
  const saveButton = page.getByRole('button', { name: 'Save review' });
  await saveButton.focus();
  await expect(saveButton).toBeFocused();
  await saveButton.press('Enter');
  await expect(page.getByText('Fixture reviewer', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Review preview' })).toHaveCount(0);
  const invalidPayloadMarker = 'PRIVATE_UPLOAD_PAYLOAD_MARKER';
  await page.getByLabel('Review submission JSON').setInputFiles({ name: 'malformed.json', mimeType: 'application/json', buffer: Buffer.from(`{"private":"${invalidPayloadMarker}"`) });
  const attachPanel = page.getByRole('heading', { name: 'Attach a review' }).locator('..');
  await expect(page.getByText(/Could not read this file as JSON/)).toBeVisible();
  await expect(attachPanel).not.toContainText(invalidPayloadMarker);
  await page.getByRole('link', { name: `${sideName}: ${citedEvent.label}` }).click();
  const inspector = page.getByRole('dialog', { name: 'Event inspector' });
  await expect(inspector).toContainText(citedEvent.label);
  await page.getByRole('link', { name: /reviews? attached/ }).click();

  const revision = { ...submission, reviews: [{ ...submission.reviews[0], id: 'fixture-human-v2',
    conclusion: 'mixed', summary: 'The result is useful with one unresolved tradeoff.', supersedes: 'fixture-human' }] };
  await page.getByLabel('Review submission JSON').setInputFiles({ name: 'review-revision.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(revision)) });
  await page.getByRole('button', { name: 'Preview imported review' }).click();
  await page.getByRole('button', { name: 'Save review' }).click();
  await expect(page.getByText('Show earlier version')).toBeVisible();
  await page.getByText('Show earlier version').click();
  await expect(page.getByText(/Earlier version · replaced/)).toBeVisible();
  await page.getByRole('link', { name: 'Export report' }).click();
  const exportResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/export'));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const savedExport = await (await exportResponse).json();
  const finalJson = `${savedExport.folder.replace(/^~(?=\/|$)/, homedir())}${savedExport.files.find(name => name.endsWith('.audit.json'))}`;
  const retained = JSON.parse(await readFile(finalJson, 'utf8'));
  expect(retained.reviewHistory.entries.some(entry => entry.reviewer.name === 'Fixture reviewer')).toBe(true);

  for (const rollout of app.rollouts) await rm(rollout, { force: true });
  await page.goto(`${app.origin}/reports/open`);
  await page.getByLabel('Choose the report’s JSON file').setInputFiles(finalJson);
  await page.getByRole('link', { name: 'View report' }).click();
  await page.getByRole('link', { name: /reviews? attached/ }).click();
  await expect(page.getByText('Fixture reviewer', { exact: true })).toBeVisible();
});
