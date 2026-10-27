const path = require('node:path');

const { defineConfig, devices } = require('@playwright/test');

/**
 * End-to-end suite for the news feed: the answer, the ask/thinking toggles,
 * posting a comment and the live agent statistics in the header.
 *
 * The page is served by the real React client. Every /api/* response and the
 * WebSocket are replaced inside the browser, so the suite is deterministic and
 * never calls a Meterless runtime.
 */
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'feed.spec.js',
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
    // Locally the CRA dev server is usually already running (and it watches the
    // sources, so it serves the current code). In CI it must always be started.
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      BROWSER: 'none'
    }
  }
});
