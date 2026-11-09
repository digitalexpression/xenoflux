import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { test, expect } from './fixtures.js';

async function choosePair(page) {
  if (!page.url().includes('/compare/sessions')) await page.goto(new URL('/compare/sessions', page.url()).toString());
  const search = page.getByRole('searchbox', { name: 'Search title or project' });
  await search.fill('Fix the date test');
  const baseline = page.getByRole('checkbox', { name: /Fix the date test, baseline, Codex CLI/ });
  await expect(baseline).toBeVisible();
  await baseline.check();
  const strict = page.getByRole('checkbox', { name: /Fix the date test, strict-review, Codex Desktop/ });
  await expect(strict).toBeVisible();
  await strict.check();
}

async function assertReportSides(page, { leftName = 'strict-review', rightName = 'baseline', leftClient = 'Codex Desktop', rightClient = 'Codex CLI' } = {}) {
  await expect(page.locator('.chip-a')).toContainText(leftName);
  await expect(page.locator('.chip-a')).toContainText(leftClient);
  await expect(page.locator('.chip-b')).toContainText(rightName);
  await expect(page.locator('.chip-b')).toContainText(rightClient);
  const sides = page.getByRole('group', { name: 'Compared profiles' });
  await expect(sides.getByText('Root model (reported): fixture-model', { exact: true })).toHaveCount(2);
  await expect(sides.getByText('Root reasoning effort (reported): medium', { exact: true })).toHaveCount(2);
}

async function assertCompactMeasurements(page, profiles = ['strict-review', 'baseline']) {
  const section = page.locator('section[aria-labelledby="time"]');
  await expect(page.getByRole('heading', { name: 'Time and tokens', exact: true })).toBeVisible();
  await expect(section.getByRole('list', { name: 'Token bar legend', exact: true })).toHaveCount(1);
  await expect(section.getByRole('table', { name: 'Time and tokens comparison' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Agent measurements', exact: true })).toHaveCount(0);
  const columns = profiles.map(profile => section.locator(`[aria-label="${profile} time and tokens"]`));
  for (const column of columns) await expect(column).toBeVisible();
  const [left, right] = await Promise.all(columns.map(column => column.boundingBox()));
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  expect(right.x).toBeGreaterThan(left.x + left.width - 1);
  expect(Math.abs(right.y - left.y)).toBeLessThanOrEqual(1);
}

test('compare saved sessions with replay-first outcomes across reload', async ({ page }) => {
  await choosePair(page);
  await page.getByRole('checkbox', { name: 'I say these are the same task' }).check();
  await page.getByRole('textbox', { name: 'Task name' }).fill('Fix the date test');
  await page.getByRole('button', { name: 'Optional: mark what you meant to vary' }).click();
  const variable = page.locator('fieldset label input[type=checkbox]').first();
  await expect(variable).toBeVisible();
  const variableName = (await variable.locator('xpath=..').innerText()).trim();
  await variable.check();

  await page.getByRole('button', { name: 'Swap sides' }).click();
  await expect(page.getByRole('checkbox', { name: 'I say these are the same task' })).not.toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Task name' })).toHaveCount(0);
  await expect(page.locator('section[aria-labelledby="your-comparison"]')).toContainText('strict-review');

  await page.getByRole('checkbox', { name: 'I say these are the same task' }).check();
  await page.getByRole('textbox', { name: 'Task name' }).fill('Fix the date test');
  await page.getByRole('button', { name: 'Optional: mark what you meant to vary' }).click();
  await page.getByRole('checkbox', { name: variableName, exact: true }).check();
  await page.getByRole('button', { name: 'Compare sessions' }).click();

  await expect(page.getByRole('heading', { name: 'Conditions' })).toBeVisible();
  await expect(page.getByText('Your statement:')).toBeVisible();
  await expect(page.getByText(variableName, { exact: true })).toBeVisible();
  await expect(page.getByText('You meant to vary this')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await assertCompactMeasurements(page);
  await expect(page.getByRole('heading', { name: 'Behavioral findings' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Paired action evidence' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open paired action evidence' })).toHaveCount(0);
  await assertReportSides(page);
  const limitsRegion = page.locator('section').filter({ has: page.getByRole('heading', { name: 'What we could not see', exact: true }) });
  const limits = await limitsRegion.innerText();
  expect(limits).toContain('Environment and cache state');
  expect(limits).toContain('one pair');
  const reportUrl = page.url();
  expect(new URL(reportUrl).pathname).toMatch(/^\/reports\/p\.[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await assertCompactMeasurements(page);
  await assertReportSides(page);
  expect(await limitsRegion.innerText()).toBe(limits);
  expect(new URL(page.url()).pathname).toBe(new URL(reportUrl).pathname);
});

test('export report files and reopen JSON after source histories are removed', async ({ app, page }) => {
  await choosePair(page);
  await page.getByRole('checkbox', { name: 'I say these are the same task' }).check();
  await page.getByRole('textbox', { name: 'Task name' }).fill('Fix the date test');
  await page.getByRole('button', { name: 'Swap sides' }).click();
  await page.getByRole('checkbox', { name: 'I say these are the same task' }).check();
  await page.getByRole('textbox', { name: 'Task name' }).fill('Fix the date test');
  await page.getByRole('button', { name: 'Compare sessions' }).click();
  await assertReportSides(page);
  await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await assertCompactMeasurements(page);
  const limitsRegion = page.locator('section').filter({ has: page.getByRole('heading', { name: 'What we could not see', exact: true }) });
  const limits = await limitsRegion.innerText();
  expect(limits).toContain('Environment and cache state');
  expect(limits).toContain('one pair');
  await page.getByRole('link', { name: 'Export report' }).first().click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Both files are in the folder above' })).toBeVisible();
  const folder = (await page.locator('aside p.font-mono').innerText()).replace(/^~(?=\/|$)/, homedir());
  const files = await readdir(folder);
  const mdName = files.find(name => name.endsWith('.md'));
  const jsonName = files.find(name => name.endsWith('.audit.json'));
  expect(mdName).toBeTruthy();
  expect(jsonName).toBeTruthy();
  const markdownPath = `${folder}/${mdName}`;
  const jsonPath = `${folder}/${jsonName}`;
  const markdown = await readFile(markdownPath, 'utf8');
  const savedJson = await readFile(jsonPath, 'utf8');
  expect(markdown.length).toBeGreaterThan(0);
  expect(savedJson).toContain('Fix the date test');
  const appendix = markdown.indexOf('## Technical details');
  expect(appendix).toBeGreaterThan(0);
  expect(markdown).toContain('## Session replay');
  expect(markdown).not.toMatch(/^## Behavioral findings$/m);
  expect(markdown).not.toMatch(/^## Paired action evidence$/m);
  for (const title of ['Comparison conditions', 'What we could not see', 'Time and tokens', 'Outcome and code changes']) {
    const section = markdown.indexOf(`## ${title}\n`);
    expect(section).toBeGreaterThan(0);
    expect(section).toBeLessThan(appendix);
  }
  expect(markdown.slice(0, appendix)).not.toContain('Recorded setup:');
  expect(markdown.slice(appendix)).toContain('Recorded setup:');
  expect(markdown).toContain('Whether these differences repeat — this is one pair, so consistency is unmeasured.');
  for (const content of [markdown, savedJson])
    for (const marker of Object.values(app.privacyMarkers)) expect(content).not.toContain(marker);

  await rm(app.rollouts[0], { force: true });
  await rm(app.rollouts[1], { force: true });
  await page.goto(`${app.origin}/reports/open`);
  await page.getByLabel('Choose the report’s JSON file').setInputFiles(markdownPath);
  await expect(page.getByText(/can’t reopen the saved report without its JSON file/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'View report' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Choose the report’s JSON file').setInputFiles({
    name: 'broken.audit.json', mimeType: 'application/json',
    buffer: Buffer.from('{"private":"PRIVATE_MALFORMED_REPORT_INPUT"'),
  });
  await expect(page.getByText('Couldn’t open this report', { exact: true })).toBeVisible();
  await expect(page.getByText(/Nothing was opened/)).toBeVisible();
  await expect(page.getByText('PRIVATE_MALFORMED_REPORT_INPUT', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View report' })).toHaveCount(0);
  await page.getByLabel('Choose the report’s JSON file').setInputFiles(jsonPath);
  await expect(page.getByText('Saved report', { exact: true })).toBeVisible();
  await expect(page.getByText('Fix the date test', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View report' }).click();
  expect(new URL(page.url()).pathname).toMatch(/^\/reports\//);
  expect(page.url()).not.toContain('Fix%20the%20date%20test');
  await expect(page.getByText('Your statement:')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conditions' })).toBeVisible();
  await assertReportSides(page);
  await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await assertCompactMeasurements(page);
  expect(await page.locator('section').filter({ has: page.getByRole('heading', { name: 'What we could not see', exact: true }) }).innerText()).toBe(limits);
});

test('find and carry an older session beyond the latest hundred into comparison', async ({ page }) => {
  await page.goto(`${new URL(page.url()).origin}/sessions`);
  await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Rare older task');
  const compare = page.getByRole('link', { name: 'Compare Rare older task (baseline) with another session' });
  await compare.click();
  await expect(page.getByRole('heading', { name: 'Choose two sessions' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your comparison' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Untick Rare older task (baseline)' })).toBeVisible();
  await expect(page.getByText('Rare older task', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Untick Rare older task (baseline)' }).click();
  await expect(page.getByRole('button', { name: 'Untick Rare older task (baseline)' })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Rare older task');
  await page.getByRole('checkbox', { name: /Rare older task, baseline, Codex CLI/ }).check();
  await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Fix the date test');
  const newer = page.getByRole('checkbox', { name: /Fix the date test, strict-review, Codex Desktop/ });
  await expect(newer).toBeVisible();
  await newer.check();
  await expect(page.getByRole('button', { name: 'Untick Rare older task (baseline)' })).toBeVisible();
  await expect(newer).toBeChecked();
  const pair = page.locator('section[aria-labelledby="your-comparison"]');
  const sides = await pair.innerText();
  expect(sides.indexOf('Rare older task')).toBeGreaterThanOrEqual(0);
  expect(sides.indexOf('Rare older task')).toBeLessThan(sides.indexOf('Fix the date test'));
  await page.getByRole('button', { name: 'Compare sessions' }).click();
  await expect(page.getByRole('heading', { name: 'Conditions' })).toBeVisible();
  await assertReportSides(page, { leftName: 'baseline', rightName: 'strict-review', leftClient: 'Codex CLI', rightClient: 'Codex Desktop' });
  await expect(page.getByText('Same task not shown:', { exact: false })).toBeVisible();
  await expect(page.locator('p').filter({ hasText: 'The records don’t show whether both sessions got the same task.' })).toBeVisible();
  await expect(page.getByText('Rare older task', { exact: true })).toBeVisible();
});
