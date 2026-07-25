import { test as base, expect, type BrowserContext } from '@playwright/test';
import * as fs from 'fs';
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
  sharedContext: [
    async ({ browser }, use, workerInfo) => {
      // We create the context manually to share it across tests, which
      // bypasses `use.video` from playwright.config.ts. Honor the runner's
      // "Record video" toggle (RECORD_VIDEO=1) by wiring recordVideo here.
      const recordVideo =
        process.env.RECORD_VIDEO === '1'
          ? { dir: path.join(workerInfo.project.outputDir ?? 'test-results', 'videos') }
          : undefined;
      const context = await browser.newContext({
        storageState: fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined,
        ...(recordVideo ? { recordVideo } : {}),
      });
      // Inject a floating cursor overlay so a human watching the headed
      // browser can see exactly where the script is pointing/clicking.
      await context.addInitScript(CURSOR_OVERLAY_SCRIPT);
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],

  // Override Playwright's built-in `page` — instead of a fresh context/page
  // per test, hand back the single page from the shared context. First test
  // creates it; subsequent tests reuse. We do NOT close it in between.
  page: async ({ sharedContext }, use) => {
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
