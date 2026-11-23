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
  for (const side of await sides.locator(':scope > section').all()) {
    const details = side.locator('details.comparison-side-details');
    if (await details.getAttribute('open') === null) await details.locator('summary').click();
  }
  await expect(sides.getByText('Root model (reported): fixture-model', { exact: true })).toHaveCount(2);
  await expect(sides.getByText('Root reasoning effort (reported): medium', { exact: true })).toHaveCount(2);
}

async function openEvidenceGroup(page, name) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${name}$`) });
  if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
}

async function checkReplayView(page) {
  const views = page.getByRole('navigation', { name: 'Report views' });
  await views.getByRole('link', { name: 'Session replay' }).click();
  await expect(page.getByRole('heading', { name: 'Session replay' })).toBeVisible();
  await views.getByRole('link', { name: 'Grouped evidence' }).click();
}

async function assertCompactMeasurements(page, profiles = ['strict-review', 'baseline']) {
  await openEvidenceGroup(page, 'Time and tokens');
  const section = page.getByRole('region', { name: 'Time and tokens evidence' });
  const details = section.getByRole('button', { name: 'Workflow and per-session details' });
  if (await details.count()) await details.click();
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

  await openEvidenceGroup(page, 'Conditions and coverage');
  await openEvidenceGroup(page, 'Outcome');
  await expect(page.getByRole('heading', { name: 'Conditions', exact: true })).toBeVisible();
  await expect(page.getByText('Your statement:')).toBeVisible();
  await expect(page.getByText(variableName, { exact: true })).toBeVisible();
  await expect(page.getByText('You meant to vary this')).toBeVisible();
  await checkReplayView(page);
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await assertCompactMeasurements(page);
  await expect(page.getByRole('heading', { name: 'Behavioral findings' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Paired action evidence' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open paired action evidence' })).toHaveCount(0);
  await assertReportSides(page);
  const limitsRegion = page.locator('section').filter({ has: page.getByRole('heading', { name: 'What we could not see', exact: true }) });
  await limitsRegion.getByRole('button', { name: 'Show recorded coverage limits' }).click();
  const limits = await limitsRegion.innerText();
  expect(limits).toContain('Environment and cache state');
  expect(limits).toContain('one pair');
  const reportUrl = page.url();
  expect(new URL(reportUrl).pathname).toMatch(/^\/reports\/p\.[0-9a-f-]{36}$/);
  await page.reload();
  await checkReplayView(page);
  await openEvidenceGroup(page, 'Outcome');
  await openEvidenceGroup(page, 'Conditions and coverage');
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await assertCompactMeasurements(page);
  await assertReportSides(page);
  await limitsRegion.getByRole('button', { name: 'Show recorded coverage limits' }).click();
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
  await checkReplayView(page);
  await openEvidenceGroup(page, 'Outcome');
  await openEvidenceGroup(page, 'Conditions and coverage');
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await assertCompactMeasurements(page);
  const limitsRegion = page.locator('section').filter({ has: page.getByRole('heading', { name: 'What we could not see', exact: true }) });
  await limitsRegion.getByRole('button', { name: 'Show recorded coverage limits' }).click();
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
  await openEvidenceGroup(page, 'Conditions and coverage');
  await openEvidenceGroup(page, 'Outcome');
  await expect(page.getByRole('heading', { name: 'Conditions', exact: true })).toBeVisible();
  await assertReportSides(page);
  await checkReplayView(page);
  await expect(page.getByRole('heading', { name: 'Last recorded response' })).toBeVisible();
  await assertCompactMeasurements(page);
  await limitsRegion.getByRole('button', { name: 'Show recorded coverage limits' }).click();
  expect(await limitsRegion.innerText()).toBe(limits);
});

test('collect two sessions in the library tray, swap them and compare', async ({ page }) => {
  await page.goto(`${new URL(page.url()).origin}/sessions`);
  await expect(page.getByRole('heading', { name: 'Sessions', level: 1 })).toBeVisible();
  const tray = page.getByRole('region', { name: 'Comparison', exact: true });
  await expect(tray).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Fix the date test');
  const addBaseline = page.getByRole('button', { name: 'Add Fix the date test (baseline) to the comparison' });
  await addBaseline.focus();
  await page.keyboard.press('Enter');
  const removeBaseline = page.getByRole('list', { name: 'Sessions' }).getByRole('button', { name: 'Remove Fix the date test (baseline) from the comparison' });
  await expect(removeBaseline).toBeFocused();
  await expect(removeBaseline).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Add Fix the date test (strict-review) to the comparison' }).click();
  await expect(page.getByText('Two sessions are in the comparison. Remove one to add another.')).toBeVisible();
  expect((await tray.innerText()).indexOf('baseline')).toBeLessThan((await tray.innerText()).indexOf('strict-review'));
  await tray.getByRole('button', { name: 'Swap sides' }).click();
  await expect.poll(async () => { const text = await tray.innerText(); return text.indexOf('strict-review') < text.indexOf('baseline'); }).toBe(true);
  // The pair follows the reader to other pages.
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Profiles' }).click();
  await tray.getByRole('link', { name: 'Compare…' }).click();
  await expect(page.getByRole('heading', { name: 'Choose two sessions' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Fix the date test');
  await expect(page.getByRole('checkbox', { name: /Fix the date test, strict-review, Codex Desktop.*left side/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Fix the date test, baseline, Codex CLI.*right side/ })).toBeChecked();
  await page.getByRole('button', { name: 'Compare sessions' }).click();
  await expect(page.getByRole('link', { name: 'Grouped evidence' })).toHaveAttribute('aria-current', 'page');
  await expect(tray).toHaveCount(0);
  expect(await page.evaluate(() => window.sessionStorage.getItem('xenoflux.comparison-tray'))).toBeNull();
});

test('find and carry an older session beyond the latest hundred into comparison', async ({ page }) => {
  await page.goto(`${new URL(page.url()).origin}/sessions`);
  await page.getByRole('searchbox', { name: 'Search title or project' }).fill('Rare older task');
  await page.getByRole('button', { name: 'Add Rare older task (baseline) to the comparison' }).click();
  const tray = page.getByRole('region', { name: 'Comparison', exact: true });
  await expect(tray.getByText('Rare older task', { exact: true })).toBeVisible();
  await expect(tray.getByText('Add one more session')).toBeVisible();
  // The pair survives a reload and follows the reader to the picker.
  await page.reload();
  await expect(tray.getByText('Rare older task', { exact: true })).toBeVisible();
  await page.goto(`${new URL(page.url()).origin}/compare/sessions`);
  await expect(page.getByRole('heading', { name: 'Choose two sessions' })).toBeVisible();
  await expect(tray).toHaveCount(0);
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
  await expect(page.getByRole('link', { name: 'Grouped evidence' })).toHaveAttribute('aria-current', 'page');
  await assertReportSides(page, { leftName: 'baseline', rightName: 'strict-review', leftClient: 'Codex CLI', rightClient: 'Codex Desktop' });
  await expect(page.getByText('Same task not shown:', { exact: false })).toBeVisible();
  await expect(page.locator('p').filter({ hasText: 'The records don’t show whether both sessions got the same task.' })).toBeVisible();
  await expect(page.getByText('Rare older task', { exact: true })).toBeVisible();
});
