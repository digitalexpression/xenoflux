import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './web/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results/ui-e2e',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
