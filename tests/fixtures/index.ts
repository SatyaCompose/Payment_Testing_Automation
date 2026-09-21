import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type FullProject,
} from '@playwright/test';
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
//
// `user-agent-override` is disabled on purpose. That evasion's
// `onPageCreated` hook calls CDP `Network.setUserAgentOverride` with a
// UA it derives from `page.browser().userAgent()` — the browser's own
// baseline UA — AFTER Playwright has already applied the context-level
// `userAgent` option (see `projectContextOptions` below and
// `tests/scripts/interactive-signin.ts`). That silently overwrote both:
//   - `chromium-desktop`'s intended `devices['Desktop Chrome']` UA with a
//     same-Chrome-but-different-build-number string (measured:
//     `Chrome/149.0.7827.55` requested vs `Chrome/149.0.0.0` served),
//     which breaks the UA-binding this suite relies on to keep the
//     signed-in session's Cloudflare `cf_clearance` cookie valid at test
//     time.
//   - `android-chrome`'s `devices['Pixel 7']` UA with a desktop UA
//     entirely — the project wasn't even emulating mobile.
// Every stealth launch here runs headed (`headless: false`), so the
// baseline UA never contains "HeadlessChrome" — the one thing this
// evasion exists to strip — meaning it protects against nothing our own
// context-level `userAgent` doesn't already handle. Trade-off: with the
// evasion off, `navigator.userAgentData` may no longer be rewritten to
// agree with a spoofed UA. Accepted — Google Pay's sheet is already
// undriveable under automation and its specs are skipped (see
// tests/payments/gpay/MANUAL.md), so this evasion wasn't buying a
// working GPay path anyway, while a correct UA is required for both
// session validity and honest mobile emulation. Do not re-enable this
// without re-measuring both projects' `navigator.userAgent`.
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('user-agent-override');
chromiumExtra.use(stealth);

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
  const paymentSlug = paymentSlugFromTitle(title);
  if (!paymentSlug) return null;
  if (!fs.existsSync(SCREENSHOTS_DIR)) return null;
  const folderPrefix = `${idPrefix}-${paymentSlug}-`;
  const dirs = fs
    .readdirSync(SCREENSHOTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(folderPrefix));
  for (const d of dirs) {
    const file = path.join(SCREENSHOTS_DIR, d.name, `${projectName}-order-confirmation.png`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Forward the emulation options the project declared in
 * playwright.config.ts into a manually-created context.
 *
 * Project-level `use` options are applied by Playwright's *built-in*
 * `context`/`page` fixtures. This suite builds its own context off the
 * `browser` fixture (so one window is shared across tests), which means
 * none of them arrive on their own — without this, `devices['Pixel 7']`
 * and `devices['iPhone 14']` are silently discarded and every project
 * renders as a default desktop window.
 */
function projectContextOptions(project: FullProject): BrowserContextOptions {
  const {
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    locale,
    timezoneId,
  } = project.use;
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, locale, timezoneId };
}

/** Mobile device presets set `isMobile` — used to skip desktop-only launch args. */
function isMobileProject(project: FullProject): boolean {
  return project.use.isMobile === true;
}

function paymentSlugFromTitle(title: string): string | null {
  if (/google pay/i.test(title)) return 'gp';
  if (/apple pay/i.test(title)) return 'apay';
  if (/credit card/i.test(title)) return 'cc';
  if (/paypal/i.test(title)) return 'pp';
  if (/afterpay/i.test(title)) return 'ap';
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
      // --start-maximized only makes sense for desktop projects. On a
      // mobile preset it maximises the window around a 412px viewport,
      // leaving the page letterboxed in a sea of grey.
      const b = await chromiumExtra.launch({
        headless: false,
        args: [
          ...(isMobileProject(workerInfo.project) ? [] : ['--start-maximized']),
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
      const context = await effectiveBrowser.newContext({
        storageState: fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
        ...projectContextOptions(workerInfo.project),
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
      const effectiveBrowser = stealthBrowser ?? browser;
      const videoDir = path.join(testInfo.project.outputDir ?? 'test-results', 'videos');
      const contextOptions = projectContextOptions(testInfo.project);
      const context = await effectiveBrowser.newContext({
        storageState: fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
        ...contextOptions,
        recordVideo: {
          dir: videoDir,
          // Playwright's default recording resolution is very small
          // (~800px wide) and gets upscaled during playback → blurry.
          // Record at the project's own viewport so desktop stays 1080p
          // and mobile isn't stretched into a 1920-wide letterbox.
          size: contextOptions.viewport ?? { width: 1920, height: 1080 },
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
      type: 'skipped-not-run',
      description: `Skipped — did not run this pass because a prior confirmation screenshot already exists at ${path.relative(process.cwd(), existing)}. This is not a pass; delete the file to re-run.`,
    });
    // stdout, not stderr: the runner server parses stdout line by line and
    // broadcasts each line to the dashboard, while its stderr handler keeps
    // only the last 3 lines of a chunk — a batch of auto-skips written to
    // stderr would be silently truncated on exactly the screen where this
    // warning matters most. The wording carries the loudness, not the channel.
    console.log(`[skip] WARNING: "${testInfo.title}" did NOT run this pass — a confirmation screenshot already exists at ${existing}; this result proves nothing. Delete it to re-run.`);
    test.skip(true, `Did not run — a confirmation screenshot already exists. Delete ${path.relative(process.cwd(), existing)} to re-run.`);
  }
});

export { expect };
