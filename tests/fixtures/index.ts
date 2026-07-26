import { test as base, expect, type Browser, type BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { CartPage } from '../pages/CartPage';
import { CheckoutPage } from '../pages/CheckoutPage';
import { LoginPage } from '../pages/LoginPage';
import { RegisterPage } from '../pages/RegisterPage';
import { PaymentPage } from '../pages/PaymentPage';
import { OrderConfirmationPage } from '../pages/OrderConfirmationPage';
import { CheckoutFlow } from '../flows/CheckoutFlow';
import { AUTH_FILE } from './auth';
import { BuyerDetails, guestBuyer } from './testData';
import { CURSOR_OVERLAY_SCRIPT } from '../utils/cursorOverlay';

// Register the stealth plugin once — patches ~15 anti-automation
// detection surfaces (webdriver flag, WebGL fingerprint, plugin list,
// chrome runtime, permissions API, etc.). Enables Google Pay's SDK to
// render its sheet contents under Playwright automation.
chromiumExtra.use(StealthPlugin());

interface Fixtures {
  cartPage: CartPage;
  loginPage: LoginPage;
  registerPage: RegisterPage;
  checkoutPage: CheckoutPage;
  paymentPage: PaymentPage;
  confirmationPage: OrderConfirmationPage;
  flow: CheckoutFlow;
  buyer: BuyerDetails;
}

interface WorkerFixtures {
  /**
   * A single BrowserContext created once per worker and reused across
   * every test. Combined with the overridden `page` fixture below, this
   * means: one browser window, one tab, tests run sequentially inside it,
   * signed-in `storageState` is loaded once at the start.
   */
  sharedContext: BrowserContext;
  /**
   * Stealth-launched Chromium browser (via playwright-extra + stealth
   * plugin). Only initialised when the current project targets chromium
   * or android-chrome; other browsers fall back to Playwright's default
   * `browser` fixture. Google Pay's SDK checks ~15 fingerprint surfaces
   * that stealth patches, letting the sheet render under automation.
   */
  stealthBrowser: Browser | null;
}

import * as path from 'path';
import { screenshotsRoot } from '../utils/runTimestamp';

const SCREENSHOTS_DIR = screenshotsRoot();

/**
 * If a screenshot for the current test's ID + project already exists on
 * disk, skip re-running the test. Useful when iterating on a subset —
 * once a test passes, its screenshot stays and it won't be re-tested.
 * Delete the folder in `screenshots/` to force a re-run.
 */
function shouldSkipBecauseScreenshotExists(title: string, projectName: string): string | null {
  const titleMatch = title.match(/(\d+\.\d+)/);
  if (!titleMatch) return null;
  const idPrefix = titleMatch[1];
  if (!fs.existsSync(SCREENSHOTS_DIR)) return null;
  const dirs = fs
    .readdirSync(SCREENSHOTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(`${idPrefix}-`));
  for (const d of dirs) {
    const file = path.join(SCREENSHOTS_DIR, d.name, `${projectName}-order-confirmation.png`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  stealthBrowser: [
    async ({}, use, workerInfo) => {
      const isChromium = workerInfo.project.name.startsWith('chromium-') ||
        workerInfo.project.name.startsWith('android-');
      if (!isChromium) {
        await use(null);
        return;
      }
      const b = await chromiumExtra.launch({
        headless: false,
        args: [
          '--start-maximized',
          '--disable-blink-features=AutomationControlled',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      await use(b);
      await b.close();
    },
    { scope: 'worker' },
  ],

  sharedContext: [
    async ({ browser, stealthBrowser }, use, workerInfo) => {
      // Prefer the stealth browser for chromium projects; fall back to
      // Playwright's default browser fixture for webkit / mobile-safari.
      const effectiveBrowser = stealthBrowser ?? browser;
      // When RECORD_VIDEO=1 the `page` fixture creates a fresh context
      // per test (so each test's video can be finalized + renamed). In
      // that mode the shared context is unused — hand back a placeholder
      // so we don't open an extra browser window.
      if (process.env.RECORD_VIDEO === '1') {
        await use({} as BrowserContext);
        return;
      }
      const isChromium = workerInfo.project.name.startsWith('chromium-') ||
        workerInfo.project.name.startsWith('android-');
      const context = await effectiveBrowser.newContext({
        storageState: fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
        ...(isChromium ? { viewport: { width: 1920, height: 1080 } } : {}),
      });
      // Inject a floating cursor overlay so a human watching the headed
      // browser can see exactly where the script is pointing/clicking.
      await context.addInitScript(CURSOR_OVERLAY_SCRIPT);
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],

  // Override Playwright's built-in `page`:
  // - Default mode (no video): hand back the single shared page.
  // - RECORD_VIDEO=1: build a per-test context so `page.video()` can be
  //   finalized and the resulting `.webm` renamed to include the date
  //   and test id.
  page: async ({ sharedContext, browser, stealthBrowser }, use, testInfo) => {
    if (process.env.RECORD_VIDEO === '1') {
      const isChromium = testInfo.project.name.startsWith('chromium-') ||
        testInfo.project.name.startsWith('android-');
      const effectiveBrowser = stealthBrowser ?? browser;
      const videoDir = path.join(testInfo.project.outputDir ?? 'test-results', 'videos');
      const context = await effectiveBrowser.newContext({
        storageState: fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
        ...(isChromium ? { viewport: { width: 1920, height: 1080 } } : {}),
        recordVideo: {
          dir: videoDir,
          // Playwright's default recording resolution is very small
          // (~800px wide) and gets upscaled during playback → blurry.
          // Pin to 1080p so text/logos in the recording stay readable.
          size: { width: 1920, height: 1080 },
        },
      });
      await context.addInitScript(CURSOR_OVERLAY_SCRIPT);
      const testPage = await context.newPage();
      await use(testPage);
      // Read the raw video path BEFORE closing (path() only resolves
      // after close, but we grab the Video ref now so we can call it).
      const video = testPage.video();
      await context.close();
      if (video) {
        try {
          const rawPath = await video.path();
          const testId = testInfo.title.match(/(\d+\.\d+)/)?.[1] ?? 'unknown';
          const date = new Date().toISOString().slice(0, 10);
          const safeProject = testInfo.project.name.replace(/[^a-z0-9_-]/gi, '-');
          const newName = `${date}-${testId}-${safeProject}.webm`;
          const newPath = path.join(path.dirname(rawPath), newName);
          fs.renameSync(rawPath, newPath);
        } catch (err) {
          console.warn(`[video] rename failed: ${(err as Error).message}`);
        }
      }
      return;
    }
    // Default path: reuse the worker-scoped shared page.
    const existing = sharedContext.pages();
    const page = existing[0] ?? (await sharedContext.newPage());
    await use(page);
  },

  cartPage: async ({ page }, use) => {
    await use(new CartPage(page));
  },
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  registerPage: async ({ page }, use) => {
    await use(new RegisterPage(page));
  },
  checkoutPage: async ({ page }, use) => {
    await use(new CheckoutPage(page));
  },
  paymentPage: async ({ page }, use) => {
    await use(new PaymentPage(page));
  },
  confirmationPage: async ({ page }, use) => {
    await use(new OrderConfirmationPage(page));
  },
  flow: async ({ page }, use) => {
    await use(new CheckoutFlow(page));
  },
  buyer: async ({}, use) => {
    await use(guestBuyer());
  },
});

test.beforeEach(async ({}, testInfo) => {
  // The runner sets FORCE_RERUN=1 when the user targets a single sub-test
  // in the UI — in that case skip the auto-skip so the explicit selection
  // always runs.
  if (process.env.FORCE_RERUN === '1') return;

  const existing = shouldSkipBecauseScreenshotExists(testInfo.title, testInfo.project.name);
  if (existing) {
    testInfo.annotations.push({
      type: 'skipped-already-passed',
      description: `Screenshot already exists: ${path.relative(process.cwd(), existing)}`,
    });
    console.log(`[skip] "${testInfo.title}" — already has a confirmation screenshot at ${existing}`);
    test.skip(true, `Already passed — delete ${path.relative(process.cwd(), existing)} to re-run.`);
  }
});

export { expect };
