import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';

test('demo review stays labelled simulated and its frozen task response survives reload', async ({ browser }) => {
  const server = await startUiServer({ provider: createDemoProvider(), staticRoot: resolve('dist/ui') });
  const page = await browser.newPage();
  try {
    await page.goto(server.launchUrl);
    await page.getByRole('heading', { name: 'What do you want to compare?' }).waitFor();
    await page.goto(`${server.origin}/reports/demo-run`);
    await page.getByRole('link', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Preview review' }).click();
    const preview = page.getByRole('region', { name: 'Review task preview' });
    await expect(preview).toContainText('simulated');
    await expect(preview).toContainText('no model will run');
    await page.getByRole('button', { name: 'Start review' }).click();
    await expect(page).toHaveURL(/\/reports\/r\.[0-9a-f-]+\/reviews\?task=[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible();
    await expect(page.getByText(/Simulated review:/)).toBeVisible();
    await expect(page.getByText(/Demo task result is simulated/i)).toBeVisible();
    const frozenUrl = page.url();
    await page.reload();
    await expect(page).toHaveURL(frozenUrl);
    await expect(page.getByRole('heading', { name: 'Reviews', level: 1 })).toBeVisible();
    await expect(page.getByText(/Simulated review:/)).toBeVisible();
    await expect(page.getByText(/Demo task result is simulated/i)).toBeVisible();
    const taskId = new URL(page.url()).searchParams.get('task');
    await page.getByRole('link', { name: 'Open its comparison and evidence' }).click();
    await expect(page).toHaveURL(`${server.origin}/reports/r.${taskId}`);
    await expect(page.getByRole('heading', { name: 'Fix the flaky date-parsing test', level: 1 })).toBeVisible();
    await expect(page.locator('[data-simulated="true"]')).toBeVisible();
    await expect(page.locator('[data-simulated="true"]')).toContainText('Demo data.');
  } finally {
    await page.close();
    await server.close();
  }
});
