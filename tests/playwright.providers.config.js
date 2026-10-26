const path = require('node:path');

const { defineConfig, devices } = require('@playwright/test');

/**
 * Focused end-to-end suite for the /providers page.
 *
 * The page is served by the real React client. Every /api/providers/* and
 * /api/zetaris response is mocked inside the browser, so the suite is
 * deterministic and does not need a Meterless Runtime or Zetaris instance.
 */
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'providers.spec.js',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3002',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'npm --prefix client start',
    cwd: path.join(__dirname, '..'),
    url: 'http://127.0.0.1:3002',
    reuseExistingServer: true,
    timeout: 240_000,
    env: {
      BROWSER: 'none'
    }
  }
});
