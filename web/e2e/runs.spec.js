import { readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { createUiRunsFixture } from '../../test-support/ui-runs-fixture.js';

const test = base.extend({
  app: async ({}, use, testInfo) => {
    const mode = testInfo.title.includes('check assessment output retention') ? { check: 'output' }
      : testInfo.title.includes('native sandbox preflight failure') ? { capture: 'sandbox-unavailable' }
      : testInfo.title.includes('successful partial capture') ? { capture: 'partial' }
      : testInfo.title.includes('failed verification') ? { check: 'fail' }
      : testInfo.title.includes('cancellation') ? { capture: 'delayed' }
        : testInfo.title.includes('server restart') ? { capture: 'delayed' }
        : testInfo.title.includes('commit that changed') ? { staleCommit: true } : {};
    const app = await createUiRunsFixture({ mode });
    try { await use(app); } finally { await app.close(); }
  },
  page: async ({ page, app }, use, testInfo) => {
    await page.goto(app.url);
    await page.getByRole('heading', { name: 'What do you want to compare?', level: 1 }).waitFor();
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus && app.serverLogs.length) {
      await testInfo.attach('ui-server.log', { body: app.serverLogs.join('\n'), contentType: 'text/plain' });
    }
  },
});

function checkRecords(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    for (const entry of value) checkRecords(entry, result);
    return result;
  }
  if (Array.isArray(value.checkEvidence?.records)) result.push(...value.checkEvidence.records);
  for (const [key, entry] of Object.entries(value)) if (key !== 'checkEvidence') checkRecords(entry, result);
  return result;
}

async function prepareRun(page, task = 'Inspect the disposable fixture.') {
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await page.getByRole('heading', { name: 'Run a new task', level: 1 }).waitFor();
  await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill(task);
  await page.getByRole('button', { name: 'Review before starting' }).click();
  await page.getByRole('heading', { name: 'Review before starting', level: 1 }).waitFor();
  await expect(page.getByText('Ready to start')).toBeVisible();
}

async function startRun(page) {
  await page.getByRole('button', { name: 'Start 2 model runs' }).first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
}

test('label advanced setup fields independently after removing a row', async ({ page }) => {
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await page.getByRole('button', { name: /min per run/ }).click();
  const add = page.getByRole('button', { name: 'Add setup command' });
  await add.click();
  await add.click();

  const names = page.getByRole('textbox', { name: 'Setup name', exact: true });
  const commands = page.getByRole('textbox', { name: 'Command', exact: true });
  await expect(names).toHaveCount(2);
  await expect(commands).toHaveCount(2);
  const nameIds = await names.evaluateAll(inputs => inputs.map(input => input.id));
  const commandIds = await commands.evaluateAll(inputs => inputs.map(input => input.id));
  expect(new Set(nameIds).size).toBe(2);
  expect(new Set(commandIds).size).toBe(2);
  await names.nth(0).fill('first setup');
  await page.getByRole('textbox', { name: 'Command', exact: true }).nth(0).fill('echo first');
  await names.nth(1).fill('second setup');
  await page.getByRole('textbox', { name: 'Command', exact: true }).nth(1).fill('echo second');

  await names.first().locator('xpath=../..').getByRole('button', { name: 'Remove' }).click();
  await expect(names).toHaveCount(1);
  await expect(commands).toHaveCount(1);
  const remainingNameId = await names.first().getAttribute('id');
  const remainingCommandId = await commands.first().getAttribute('id');
  expect(remainingNameId).toBeTruthy();
  expect(remainingCommandId).toBeTruthy();
  await expect(names.first()).toHaveValue('second setup');
  await expect(commands.first()).toHaveValue('echo second');
  const nameLabel = page.locator(`label[for="${remainingNameId}"]`);
  const commandLabel = page.locator(`label[for="${remainingCommandId}"]`);
  await expect(nameLabel).toHaveText('Setup name');
  await expect(commandLabel).toHaveText('Command');
  await nameLabel.click();
  await expect(names.first()).toBeFocused();
  await commandLabel.click();
  await expect(commands.first()).toBeFocused();
});

test('pins the reviewed commit, runs both profiles, then exports and reopens the frozen report', async ({ app, page }) => {
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Inspect the fixture without changing the source repository.');
  await page.getByRole('textbox', { name: 'Files it may change (optional)' }).fill('README.md');
  await expect.poll(() => page.getByLabel('Commit or branch').inputValue()).not.toBe('');
  const head = (await readFile(join(app.repository, '.git', 'HEAD'), 'utf8')).trim();
  const selectedCommit = await page.getByLabel('Commit or branch').inputValue();
  const gitHead = execFileSync('git', ['-C', app.repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  expect(selectedCommit).toBe(gitHead);
  expect(head.startsWith('ref:')).toBe(true);
  await page.getByRole('button', { name: 'Review before starting' }).click();
  await expect(page.getByRole('heading', { name: 'Review before starting', level: 1 })).toBeVisible();
  await expect(page.getByText(gitHead)).toBeVisible();
  await expect(page.getByText('No verification checks selected.').first()).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  await startRun(page);
  await expect(page.getByRole('region', { name: 'Finished' })).toBeVisible({ timeout: 15000 });
  expect(app.calls.captures).toEqual(['baseline', 'strict-review']);
  await page.getByRole('link', { name: 'Open the report' }).click();
  await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export report' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Export report' }).first().click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Report saved' })).toBeVisible();

  const folders = await readdir(app.reportsRoot, { withFileTypes: true });
  const folder = folders.find(entry => entry.isDirectory());
  expect(folder).toBeTruthy();
  const folderPath = join(app.reportsRoot, folder.name);
  const files = await readdir(folderPath);
  const jsonName = files.find(name => name.endsWith('.audit.json'));
  expect(jsonName).toBeTruthy();
  const savedJson = join(folderPath, jsonName);
  const original = await readFile(savedJson, 'utf8');
  await rm(join(app.store.directory, 'audits'), { recursive: true });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open saved report' }).click();
  await page.getByLabel('Choose the report’s JSON file').setInputFiles(savedJson);
  await expect(page.getByText('shown exactly as saved; today’s setup and files aren’t used.')).toBeVisible();
  await page.getByRole('link', { name: 'View report' }).click();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  expect(await readFile(savedJson, 'utf8')).toBe(original);
});

test('reports a failed verification command as a failed check after both tasks', async ({ page, app }) => {
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Inspect the disposable fixture.');
  await page.getByRole('button', { name: 'Add a check command' }).click();
  await page.getByLabel('Name').fill('smoke');
  await page.getByLabel('Command you already use').fill('true');
  await page.getByRole('button', { name: 'Review before starting' }).click();
  await expect(page.getByText('Ready to start')).toBeVisible();
  await startRun(page);
  await expect(page.getByRole('region', { name: 'A check failed' })).toBeVisible({ timeout: 15000 });
  expect(app.calls.captures).toEqual(['baseline', 'strict-review']);
  expect(app.calls.checks).toHaveLength(2);
  await expect(page.getByRole('link', { name: 'Open the report' })).toBeVisible();
});

test('check assessment output retention inspects safely, navigates, and exports only on opt-in without rerunning checks', async ({ page, app }) => {
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Inspect retained check evidence in the disposable fixture.');
  await page.getByRole('button', { name: 'Add a check command' }).click();
  await page.getByLabel('Name').nth(0).fill('smoke');
  await page.getByLabel('Command you already use').nth(0).fill('printf CHECK_STDOUT; printf CHECK_STDERR >&2');
  await page.getByRole('button', { name: 'Add a check command' }).click();
  await page.getByLabel('Name').nth(1).fill('policy');
  await page.getByLabel('Command you already use').nth(1).fill('printf policy-check');
  await page.getByRole('button', { name: 'Review before starting' }).click();
  await expect(page.getByText('Ready to start')).toBeVisible();
  await startRun(page);
  await expect(page.getByRole('region', { name: 'Finished' })).toBeVisible({ timeout: 15000 });
  expect(app.calls.captures).toEqual(['baseline', 'strict-review']);
  expect(app.calls.checks).toHaveLength(4);
  await page.getByRole('link', { name: 'Open the report' }).click();

  const table = page.getByRole('table', { name: 'Recorded checks assessment' });
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.getByText('Same check definition').first()).toBeVisible();
  const trigger = table.getByRole('button', { name: 'Inspect baseline result for smoke' });
  await trigger.click();
  const inspector = page.getByRole('dialog', { name: 'Check result inspector' });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText('CHECK_STDOUT retained fixture output')).toBeVisible();
  await expect(inspector.getByText(/OPENAI_API_KEY=\[REDACTED\]/)).toBeVisible();
  await expect(inspector.getByText('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh')).toHaveCount(0);
  const search = inspector.getByRole('searchbox', { name: 'Search check output' });
  await search.fill('CHECK_STDOUT');
  await expect(inspector.getByRole('region', { name: 'Matching check output' }).getByText('CHECK_STDOUT retained fixture output')).toBeVisible();
  await inspector.getByRole('button', { name: 'Show strict-review check details' }).click();
  await expect(inspector.getByRole('button', { name: 'Show strict-review check details' })).toHaveAttribute('aria-pressed', 'true');
  await inspector.getByRole('button', { name: 'Next check' }).click();
  await expect(inspector.getByRole('heading', { name: 'policy' })).toBeVisible();
  await inspector.getByRole('button', { name: 'Previous check' }).click();
  await expect(inspector.getByRole('heading', { name: 'smoke' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inspector).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(app.calls.checks).toHaveLength(4);
  expect(app.calls.captures).toHaveLength(2);

  const reportUrl = page.url();
  await page.getByRole('link', { name: 'Export report' }).first().click();
  await expect(page.getByRole('checkbox').last()).not.toBeChecked();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Report saved' })).toBeVisible();
  const firstFolders = new Set((await readdir(app.reportsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name));
  const firstFolder = [...firstFolders][0];
  const firstFiles = await readdir(join(app.reportsRoot, firstFolder));
  const firstJson = JSON.parse(await readFile(join(app.reportsRoot, firstFolder, firstFiles.find(name => name.endsWith('.audit.json'))), 'utf8'));
  const omitted = checkRecords(firstJson);
  expect(omitted.length).toBeGreaterThanOrEqual(4);
  expect(omitted.every(record => record.output.status === 'omitted' && record.output.stdout === null && record.output.stderr === null)).toBe(true);
  expect(JSON.stringify(firstJson)).not.toContain('CHECK_STDOUT');
  expect(JSON.stringify(firstJson)).not.toContain('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh');

  await page.getByRole('link', { name: 'Back to the report' }).click();
  await expect(page).toHaveURL(reportUrl);
  await page.getByRole('link', { name: 'Export report' }).first().click();
  await page.getByRole('checkbox').last().check();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Report saved' })).toBeVisible();
  const exportedFolders = (await readdir(app.reportsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const secondFolder = exportedFolders.find(name => !firstFolders.has(name));
  expect(secondFolder).toBeTruthy();
  const secondFiles = await readdir(join(app.reportsRoot, secondFolder));
  const secondJson = JSON.parse(await readFile(join(app.reportsRoot, secondFolder, secondFiles.find(name => name.endsWith('.audit.json'))), 'utf8'));
  const retained = checkRecords(secondJson);
  expect(retained.length).toBeGreaterThanOrEqual(4);
  expect(retained.every(record => record.output.status === 'retained')).toBe(true);
  expect(JSON.stringify(secondJson)).toContain('CHECK_STDOUT retained fixture output');
  expect(JSON.stringify(secondJson)).toContain('[REDACTED]');
  expect(JSON.stringify(secondJson)).not.toContain('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh');
  expect(app.calls.checks).toHaveLength(4);
  expect(app.calls.captures).toHaveLength(2);
});

test('successful partial capture preserves task completion, validation and recorded edits through a frozen reopen', async ({ page, app }) => {
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Update README.md in the disposable fixture.');
  await page.getByRole('textbox', { name: 'Files it may change (optional)' }).fill('README.md');
  await page.getByRole('button', { name: /min per run.*output/ }).click();
  await page.getByLabel('Codex program', { exact: false }).fill(app.executable);
  await page.getByRole('button', { name: 'Add a check command' }).click();
  await page.getByLabel('Name', { exact: true }).fill('smoke');
  await page.getByLabel('Command you already use').fill('true');
  await page.getByRole('button', { name: 'Review before starting' }).click();
  await expect(page.getByText('Ready to start')).toBeVisible();
  await startRun(page);
  await expect(page.getByRole('region', { name: 'Tasks completed · evidence partial' })).toBeVisible({ timeout: 15000 });
  await page.setViewportSize({ width: 800, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByText('Could not finish', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'Model task (done)' })).toHaveCount(2);
  expect(app.calls.checks).toHaveLength(2);
  await page.getByRole('link', { name: 'Open the report', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Compared profiles' }).getByText('Model task completed', { exact: true })).toHaveCount(2);
  const measurements = page.locator('section[aria-labelledby="time"]');
  await expect(measurements.getByRole('table', { name: 'Time and tokens comparison' })).toHaveCount(0);
  await expect(measurements.getByRole('list', { name: 'Token bar legend' }).getByRole('listitem')).toHaveCount(4);
  const leftMeasurements = measurements.locator('[aria-label="baseline time and tokens"]');
  const rightMeasurements = measurements.locator('[aria-label="strict-review time and tokens"]');
  const leftRows = leftMeasurements.locator('details.measurement-row');
  const rightRows = rightMeasurements.locator('details.measurement-row');
  await expect(leftRows).toHaveCount(2);
  await expect(rightRows).toHaveCount(2);
  await expect(leftRows.nth(0).locator('summary')).toContainText('Workflow');
  await expect(leftRows.nth(1).locator('summary')).toContainText('Main session');
  await expect(leftRows.nth(0).locator('.measurement-total')).toHaveText('Not validated');
  await expect(leftRows.nth(0).getByRole('img')).toHaveCount(0);
  await leftRows.nth(0).locator('summary').click();
  await expect(leftRows.nth(0)).toContainText('Workflow mix withheld until its accounting is validated');
  const assessment = page.getByRole('table', { name: 'Recorded checks assessment' });
  await expect(assessment.locator('tbody tr')).toHaveCount(1);
  await expect(assessment.getByRole('button', { name: 'Inspect baseline result for smoke' })).toBeVisible();
  await expect(assessment.getByRole('button', { name: 'Inspect strict-review result for smoke' })).toBeVisible();
  const outcome = page.getByRole('table', { name: 'Outcome comparison', exact: true });
  const sideFileCounts = outcome.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'File-change result' }) }).getByRole('cell');
  await expect(sideFileCounts.nth(0)).toContainText('1 tracked file · 0 ignored files or artifacts');
  await expect(sideFileCounts.nth(1)).toContainText('1 tracked file · 0 ignored files or artifacts');
  await page.getByRole('button', { name: 'Show changed files and code' }).click();
  const changedFiles = page.getByRole('table', { name: 'Changed files comparison' });
  const rowsWithFiles = changedFiles.locator('tbody tr').filter({ has: page.getByRole('cell') });
  await expect(rowsWithFiles).toHaveCount(1);
  const row = rowsWithFiles.filter({ has: page.getByRole('cell', { name: 'README.md', exact: true }) });
  await expect(row.getByRole('cell')).toHaveText(['README.md', 'Tracked', 'Changed', 'Changed']);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="time"]').getByRole('list', { name: 'Token bar legend' })).toHaveCount(1);
  await page.getByRole('link', { name: 'Export report' }).first().click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Report saved' })).toBeVisible();
  const folders = await readdir(app.reportsRoot, { withFileTypes: true });
  const folder = join(app.reportsRoot, folders.find(entry => entry.isDirectory()).name);
  const savedJson = join(folder, (await readdir(folder)).find(name => name.endsWith('.audit.json')));
  const original = await readFile(savedJson, 'utf8');
  await rm(join(app.store.directory, 'audits'), { recursive: true });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open saved report' }).click();
  await page.getByLabel('Choose the report’s JSON file').setInputFiles(savedJson);
  await page.getByRole('link', { name: 'View report' }).click();
  await expect(page.getByText('Shown exactly as saved')).toBeVisible();
  const reopenedOutcome = page.getByRole('table', { name: 'Outcome comparison', exact: true });
  const reopenedCounts = reopenedOutcome.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'File-change result' }) }).getByRole('cell');
  await expect(reopenedCounts.nth(0)).toContainText('1 tracked file · 0 ignored files or artifacts');
  await expect(reopenedCounts.nth(1)).toContainText('1 tracked file · 0 ignored files or artifacts');
  await page.getByRole('button', { name: 'Show changed files and code' }).click();
  const reopenedRows = page.getByRole('table', { name: 'Changed files comparison' }).locator('tbody tr').filter({ has: page.getByRole('cell') });
  await expect(reopenedRows).toHaveCount(1);
  await expect(reopenedRows.getByRole('cell')).toHaveText(['README.md', 'Tracked', 'Changed', 'Changed']);
  const reopenedAssessment = page.getByRole('table', { name: 'Recorded checks assessment' });
  await expect(reopenedAssessment.locator('tbody tr')).toHaveCount(1);
  await expect(reopenedAssessment.getByRole('button', { name: 'Inspect baseline result for smoke' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  expect(await readFile(savedJson, 'utf8')).toBe(original);
  expect(app.calls.captures).toEqual(['baseline', 'strict-review']);
});

test('native sandbox preflight failure is clear in progress and the reopened frozen report', async ({ page, app }) => {
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Inspect the disposable fixture.');
  await page.getByRole('button', { name: 'Add a check command' }).click();
  await page.getByLabel('Name').fill('smoke');
  await page.getByLabel('Command you already use').fill('true');
  await page.getByRole('button', { name: 'Review before starting' }).click();
  await expect(page.getByText('Ready to start')).toBeVisible();
  await startRun(page);
  await expect(page.getByRole('region', { name: 'Could not finish' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Model task did not start', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('listitem').filter({ hasText: 'Verification checks skipped' })).toHaveCount(2);
  await expect(page.getByText(/The native command sandbox could not be verified, so the model task did not start\./)).toHaveCount(2);
  expect(app.calls.checks).toHaveLength(0);
  await page.getByRole('link', { name: 'Open the partial report' }).click();
  await expect(page.getByText('Neither model task started', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Compared profiles' }).getByText(/The native command sandbox could not be verified, so the model task did not start\./)).toHaveCount(2);
  const assessment = page.getByRole('table', { name: 'Recorded checks assessment' });
  await expect(assessment.locator('tbody tr')).toHaveCount(1);
  const assessmentRow = assessment.locator('tbody tr');
  await expect(assessmentRow.getByRole('rowheader')).toContainText('smoke');
  await expect(assessmentRow.getByRole('cell').nth(0)).toContainText('not run');
  await expect(assessmentRow.getByRole('cell').nth(1)).toContainText('not run');
  await page.getByRole('link', { name: 'Export report' }).first().click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Report saved' })).toBeVisible();
  const folders = await readdir(app.reportsRoot, { withFileTypes: true });
  const folderPath = join(app.reportsRoot, folders.find(entry => entry.isDirectory()).name);
  const savedJson = join(folderPath, (await readdir(folderPath)).find(name => name.endsWith('.audit.json')));
  await rm(join(app.store.directory, 'audits'), { recursive: true });
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Open saved report' }).click();
  await page.getByLabel('Choose the report’s JSON file').setInputFiles(savedJson);
  await page.getByRole('link', { name: 'View report' }).click();
  await expect(page.getByRole('group', { name: 'Compared profiles' }).getByText(/The native command sandbox could not be verified, so the model task did not start\./)).toHaveCount(2);
  const reopenedAssessment = page.getByRole('table', { name: 'Recorded checks assessment' });
  await expect(reopenedAssessment.locator('tbody tr')).toHaveCount(1);
  const reopenedRow = reopenedAssessment.locator('tbody tr');
  await expect(reopenedRow.getByRole('rowheader')).toContainText('smoke');
  await expect(reopenedRow.getByRole('cell').nth(0)).toContainText('not run');
  await expect(reopenedRow.getByRole('cell').nth(1)).toContainText('not run');
});

test('cancellation keeps a partial record and stops the second profile from starting', async ({ page, app }) => {
  await prepareRun(page);
  await startRun(page);
  await expect(page.getByRole('button', { name: 'Cancel the run…' })).toBeVisible();
  await expect.poll(() => app.calls.captures.length).toBe(1);
  await page.getByRole('button', { name: 'Cancel the run…' }).click();
  await page.getByRole('button', { name: 'Cancel the run', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Cancelled' })).toBeVisible({ timeout: 15000 });
  expect(app.calls.captures).toHaveLength(1);
  await expect(page.getByRole('link', { name: 'Open the partial report' })).toBeVisible();
});

test('server restart shows interrupted progress without repeating the model task', async ({ page, app }) => {
  await prepareRun(page);
  await startRun(page);
  await expect.poll(() => app.calls.captures.length).toBe(1);
  const id = new URL(page.url()).pathname.split('/').at(-1);
  const server = await app.restartServer();
  const progress = new URL(server.url);
  progress.pathname = `/runs/${id}`;
  await page.goto(progress.href);
  await expect(page.getByRole('region', { name: 'Interrupted' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the partial report' })).toBeVisible();
  expect(app.calls.captures).toEqual(['baseline']);
});

test('cancellation stays terminal when an older manual progress retry returns afterward', async ({ page, app }) => {
  await prepareRun(page);
  await startRun(page);
  await expect.poll(() => app.calls.captures.length).toBe(1);
  const progressPath = new URL(page.url()).pathname;
  await page.route(`**/api${progressPath}`, async route => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Fixture read unavailable', code: 'fixture-offline' } }) });
  }, { times: 1 });
  await expect(page.getByRole('button', { name: 'Retry read' })).toBeVisible({ timeout: 10000 });
  let releaseRead, readStarted;
  const held = new Promise(resolve => { releaseRead = resolve; });
  const started = new Promise(resolve => { readStarted = resolve; });
  await page.route(`**/api${progressPath}`, async route => {
    const response = await route.fetch();
    const body = await response.text();
    readStarted();
    await held;
    await route.fulfill({ response, body });
  }, { times: 1 });
  await page.getByRole('button', { name: 'Retry read' }).click();
  await started;
  try {
    await page.getByRole('button', { name: 'Cancel the run…' }).click();
    await page.getByRole('button', { name: 'Cancel the run', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Cancelled' })).toBeVisible({ timeout: 15000 });
  } finally { releaseRead(); }
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByRole('region', { name: 'Cancelled' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the partial report' })).toBeVisible();
});

test('rejects a commit that changed after review without starting a task', async ({ page, app }) => {
  await prepareRun(page);
  await page.getByRole('button', { name: 'Start 2 model runs' }).first().click();
  const failedStart = page.getByRole('alert').filter({ hasText: 'Start request failed' });
  await expect(failedStart).toBeVisible();
  await expect(failedStart).toContainText(/commit, profile setup or access changed/i);
  expect(app.calls.captures).toHaveLength(0);
});

test('reviews and applies recovery for stopped runs opened from Recent', async ({ page, app }) => {
  await app.seedStoppedRun();
  await page.reload();
  await page.getByRole('heading', { name: 'Recent' }).waitFor();
  await page.getByRole('link', { name: 'Task comparison' }).click();
  await expect(page.getByRole('region', { name: 'Interrupted' })).toBeVisible();
  const progress = page.getByRole('region', { name: 'Interrupted' });
  await expect(progress.getByText('Before changing anything')).toBeVisible();
  await expect(progress.getByText('recoverable', { exact: false })).toHaveCount(2);
  await progress.getByRole('button', { name: 'Tidy up and keep the record' }).click();
  await expect(page.getByRole('button', { name: 'Tidy up and keep the record' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open the partial report' })).toBeVisible();
  expect(app.calls.captures).toHaveLength(0);
});

test('one profile can use separate model settings on both sides of a comparison', async ({ page }) => {
  await page.getByRole('link', { name: 'Run a new task' }).click();
  await page.getByRole('textbox', { name: 'What should both profiles do?' }).fill('Compare the two fixture settings.');
  await page.getByLabel(/right side of the report/i).selectOption('baseline');
  await page.getByRole('button', { name: 'Refresh models', exact: true }).nth(0).click();
  await expect(page.getByLabel('Model ID').nth(0).getByRole('option', { name: /fixture-left/ })).toHaveCount(1);
  await page.getByLabel('Model ID').nth(0).selectOption('fixture-left');
  await page.getByRole('button', { name: 'Refresh models', exact: true }).nth(1).click();
  await expect(page.getByLabel('Model ID').nth(1).getByRole('option', { name: /fixture-right/ })).toHaveCount(1);
  await page.getByLabel('Model ID').nth(1).selectOption('fixture-right');
  await page.getByLabel('Reasoning effort').nth(0).selectOption('low');
  await page.getByLabel('Reasoning effort').nth(1).selectOption('high');
  await page.getByRole('button', { name: 'Review before starting' }).click();
  await expect(page.getByText(/Model: fixture-left · Effort: low/)).toBeVisible();
  await expect(page.getByText(/Model: fixture-right · Effort: high/)).toBeVisible();
  await startRun(page);
  await page.getByRole('link', { name: 'Open the report' }).click({ timeout: 20000 });
  await expect(page.getByText('Requested model: fixture-left')).toBeVisible();
  await expect(page.getByText('Requested model: fixture-right')).toBeVisible();
});
