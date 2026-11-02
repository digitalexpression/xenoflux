import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { createDemoProvider } from '../../src/ui-demo.js';
import { startUiServer } from '../../src/ui-server.js';

test('demo comparison no longer exposes legacy findings or paired evidence pages', async ({ browser }) => {
  const server = await startUiServer({ provider: createDemoProvider(), staticRoot: resolve('dist/ui') });
  const page = await browser.newPage();
  try {
    await page.goto(server.launchUrl);
    await page.getByRole('heading', { name: 'What do you want to compare?' }).waitFor();
    await page.goto(`${server.origin}/reports/demo-run`);
    await expect(page.getByRole('heading', { name: 'Behavioral findings' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Paired action evidence' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open paired action evidence' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /legacy behavioral findings/i })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Conditions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Outcome and code' })).toBeVisible();
  } finally {
    await page.close();
    await server.close();
  }
});
