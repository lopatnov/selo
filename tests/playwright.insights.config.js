const path = require('node:path');

const { defineConfig, devices } = require('@playwright/test');

/**
 * Focused end-to-end suite for the /insights page.
 *
 * The page is served by the real React client. Every /api/insights response is
 * mocked inside the browser, so the suite is deterministic and needs neither a
 * server nor Zetaris. PW_PORT moves the client dev server off port 3002; the
 * client's own `npm start` script pins 3002, so react-scripts is started directly.
 */
const port = Number.parseInt(process.env.PW_PORT, 10) || 3002;

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'insights.spec.js',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
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
    command: 'npx react-scripts start',
    cwd: path.join(__dirname, '..', 'client'),
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 240_000,
    env: {
      BROWSER: 'none',
      PORT: String(port)
    }
  }
});
