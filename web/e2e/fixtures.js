import { test as base, expect } from '@playwright/test';
import { createUiBrowserFixture } from '../../test-support/ui-browser-fixture.js';

export { expect };
export const test = base.extend({
  app: async ({}, use) => {
    const app = await createUiBrowserFixture();
    try { await use(app); }
    finally { await app.close(); }
  },
  page: async ({ page, app }, use, testInfo) => {
    await page.goto(app.url);
    await page.getByRole('heading', { name: 'Comparisons', level: 1, exact: true }).waitFor();
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus && app.serverLogs.length) {
      await testInfo.attach('ui-server.log', {
        body: app.serverLogs.join('\n'),
        contentType: 'text/plain',
      });
    }
  },
});
