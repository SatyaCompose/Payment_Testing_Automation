import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const STAGING_URL = process.env.STAGING_URL ?? 'https://staging.example.com';
// Explicit truth check — `CI=false` in .env used to satisfy `!!process.env.CI`
// (any non-empty string is truthy), which silently kept `retries: 2` on
// every local run and inflated wall time 3x on flakes.
const IS_CI = /^(1|true|yes)$/i.test(process.env.CI ?? '');

// Local parallelism — one browser window per worker. Bumping workers
// runs multiple spec files simultaneously (different files can run in
// parallel; tests within one file still run sequentially in that
// worker's shared context, which avoids race conditions on the
// logged-in / guest-existing email addresses that both single-session
// providers might reject if double-logged-in). Override via env when
// you know your hardware and provider limits can take more.
const WORKERS = Number(process.env.PW_WORKERS ?? (IS_CI ? 1 : 3));

export default defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./tests/globalSetup'),
  globalTeardown: require.resolve('./tests/globalTeardown'),
  // Cross-file parallel, in-file sequential. Each worker owns one
  // browser context (see fixtures/index.ts sharedContext) that runs its
  // assigned tests back-to-back — cheaper than tearing down + relaunching
  // per test.
  fullyParallel: false,
  workers: WORKERS,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  // Full checkout flow (search → product → cart → shipping → payment → confirm)
  // needs a generous ceiling on staging.
  timeout: Number(process.env.BASE_TIMEOUT_MS ?? 180_000),
  expect: {
    timeout: 15_000,
  },
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
    ...(process.env.UI_REPORTER === '1'
      ? ([[require.resolve('./tests/reporters/ui-reporter')]] as const)
      : []),
    ...(IS_CI ? [['github'] as const] : []),
  ],
  use: {
    baseURL: STAGING_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.RECORD_VIDEO === '1' ? 'on' : 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    ignoreHTTPSErrors: true,
    launchOptions: {
      slowMo: Number(process.env.RUN_SLOW_MO_MS ?? 0),
    },
  },

  // Setup runs as a globalSetup (no worker/browser). Every project uses the
  // saved storageState via the sharedContext fixture in tests/fixtures/index.ts,
  // so only ONE browser window opens per run.
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        // Full-HD viewport so the page area fills modern monitors when
        // the browser window is maximised. `viewport: null` would let
        // the OS window size take over, but conflicts with the device
        // preset's deviceScaleFactor — an explicit size sidesteps that.
        viewport: { width: 1920, height: 1080 },
        launchOptions: {
          args: [
            '--start-maximized',
            // Google Pay / Payment Request API silently refuse to open
            // the payment sheet when navigator.webdriver === true. This
            // flag hides Chromium's automation fingerprint so the SDK
            // treats us like a normal user session.
            '--disable-blink-features=AutomationControlled',
          ],
          ignoreDefaultArgs: ['--enable-automation'],
        },
      },
    },
    {
      name: 'safari-desktop',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1680, height: 1050 },
      },
    },
    {
      name: 'mobile-safari',
      use: {
        ...devices['iPhone 14'],
      },
    },
    {
      name: 'android-chrome',
      use: {
        ...devices['Pixel 7'],
      },
    },
  ],
  testIgnore: ['**/auth.setup.ts'],

  outputDir: 'test-results/',
});
