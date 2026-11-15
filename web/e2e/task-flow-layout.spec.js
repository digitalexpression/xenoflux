import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';

function progress(state = 'running') {
  return { id: 'visual-job', task: 'Investigate the retained date test', meta: 'Synthetic task · isolated copies',
    state, stateText: state === 'running' ? 'Waiting for input' : 'Interrupted',
    headline: state === 'running' ? 'Left needs your input; Right has not started' : 'The task stopped; partial evidence is retained',
    elapsed: '1:04 elapsed', timeUsed: null,
    columns: [
      { side: 'a', profile: 'baseline', state: 'Waiting for input', steps: [{ text: 'Project copy prepared', state: 'done' }, { text: 'Task waiting for a native decision', state: 'active' }, { text: 'Evidence capture', state: 'waiting' }] },
      { side: 'b', profile: 'strict-review', state: 'Not started', steps: [{ text: 'Waiting for Left', state: 'waiting' }] },
    ], pendingRequests: state === 'running' ? [{ requestId: 'request-1', legId: 'left-leg', side: 'a', method: 'item/commandExecution/requestApproval', params: { command: 'npm test', cwd: '[SYNTHETIC COPY]', reason: 'The selected client requests this command.', availableDecisions: ['accept', 'decline'] } }] : [],
    sofar: 'Partial output is retained. No check result has been recorded.', reportHref: null,
    recovery: state === 'interrupted' ? { previewToken: 'synthetic-recovery', facts: ['The owned processes are confirmed stopped.', 'Keep the partial record.', 'Release only this task’s stopped reservations.'] } : null,
    simulated: true };
}

for (const theme of ['light', 'dark']) {
  test(`task preparation, review and Activity preserve scope and input in ${theme}`, async ({ browser }, testInfo) => {
    const provider = createDemoProvider();
    const server = await startUiServer({ provider, staticRoot: resolve('dist/ui') });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let active = false, state = 'running', responses = [];
    const job = { id: 'visual-job', kind: 'comparison', task: 'Investigate the retained date test', profiles: ['baseline', 'strict-review'], href: '/runs/visual-job' };
    try {
      await page.route('**/api/info', async route => route.fulfill({ json: { ...await provider.info(), activeJobs: active ? [job] : [], maxActiveJobs: 8 } }));
      await page.route('**/api/runs/visual-job', route => route.fulfill({ json: progress(state) }));
      await page.route('**/api/runs/visual-job/requests/request-1', async route => { responses.push(route.request().postDataJSON()); await route.fulfill({ json: { ...progress(), pendingRequests: [], headline: 'Native decision sent' } }); });
      await page.goto(server.launchUrl);
      await page.goto(`${server.origin}/runs/new`);
      await page.getByRole('combobox', { name: 'Theme' }).selectOption(theme);
      const task = page.getByRole('textbox', { name: 'What should both profiles do?' });
      await page.getByRole('button', { name: 'Review before starting' }).click();
      await expect(task).toBeFocused();
      await expect(task).toHaveAttribute('aria-invalid', 'true');
      const validation = page.getByText('Describe the task both profiles should do.', { exact: true });
      await expect(validation).toBeVisible();
      const errorColor = await validation.evaluate(node => getComputedStyle(node).color);
      await expect(task).toHaveCSS('border-color', errorColor);
      await task.fill('Compare the date parser with the same committed source.');
      await expect(task).not.toHaveAttribute('aria-invalid', 'true');
      await expect(validation).toHaveCount(0);
      await expect(task).not.toHaveCSS('border-color', errorColor);
      await page.getByRole('textbox', { name: /Files it may change/ }).fill('src/date.js');
      await page.getByRole('navigation', { name: 'Preparation stages' }).getByRole('link', { name: 'Two setups' }).click();
      await expect(task).toHaveValue('Compare the date parser with the same committed source.');
      await page.getByRole('navigation', { name: 'Preparation stages' }).getByRole('link', { name: 'Task and source' }).click();
      await page.screenshot({ path: testInfo.outputPath(`preparation-${theme}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Review before starting' }).click();
      await expect(page.getByRole('region', { name: /Ready to start Profiles/ })).toBeVisible();
      await expect(page.locator('blockquote')).toHaveText('Compare the date parser with the same committed source.');
      await expect(page.getByText(/Uncommitted edits and untracked or ignored files/)).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`review-${theme}.png`), fullPage: true });
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('link', { name: 'Edit the two setups', exact: true }).click();
      await expect(task).toHaveValue('Compare the date parser with the same committed source.');
      await expect(page.getByRole('textbox', { name: /Files it may change/ })).toHaveValue('src/date.js');
      await page.getByRole('navigation', { name: 'Preparation stages' }).getByRole('link', { name: 'Checks and limits' }).click();
      await expect(page.getByText('No verification checks selected.', { exact: true })).toBeVisible();
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      await page.screenshot({ path: testInfo.outputPath(`preparation-narrow-${theme}.png`), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('link', { name: 'Activity', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'No jobs running', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open record for Fix the flaky date-parsing test', exact: true })).toBeVisible();
      active = true;
      await page.getByRole('button', { name: 'Refresh activity' }).click();
      await expect(page.getByRole('link', { name: `Open progress for ${job.task}`, exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`activity-${theme}.png`), fullPage: true });
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('link', { name: `Open progress for ${job.task}`, exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Left needs your input; Right has not started' })).toBeVisible();
      await expect(page.getByRole('progressbar')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
      expect(responses).toHaveLength(0);
      await page.screenshot({ path: testInfo.outputPath(`waiting-${theme}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Decline', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Native decision sent' })).toBeVisible();
      expect(responses).toEqual([{ response: { decision: 'decline' } }]);
      state = 'interrupted'; active = false;
      await page.reload();
      await expect(page.getByRole('button', { name: 'Tidy up and keep the record', exact: true })).toBeVisible();
      await expect(page.getByText('Last recorded state', { exact: true })).toHaveCount(2);
      await expect(page.getByText('Retained step history · these steps are no longer live', { exact: true })).toHaveCount(2);
      await expect(page.getByRole('button', { name: 'Cancel the run…', exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`recovery-${theme}.png`), fullPage: true });
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`recovery-narrow-${theme}.png`), fullPage: true });
    } finally { await page.close(); await server.close(); }
  });
}
