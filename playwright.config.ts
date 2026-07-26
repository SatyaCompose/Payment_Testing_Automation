import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const STAGING_URL = process.env.STAGING_URL ?? 'https://staging.example.com';
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./tests/globalSetup'),
  globalTeardown: require.resolve('./tests/globalTeardown'),
  // Sequential: one browser window at a time, one test at a time.
  // Each test still gets a fresh context (with the saved storageState),
  // so the "signed in" state carries across, but the window opens and
  // drives one test to completion before the next starts.
  fullyParallel: false,
  workers: 1,
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
