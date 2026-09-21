import { chromium, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { AUTH_FILE } from '../fixtures/auth';
import { STAGING_ORIGIN, isSignedInStorageState, isSignedInOnPage } from '../fixtures/authState';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

// STAGING_ORIGIN is derived from STAGING_URL (with the repo's usual
// fallback) in tests/fixtures/authState.ts — reused here instead of
// re-reading the env var so there is exactly one definition of "the
// staging host" to keep in sync.
const STAGING_URL = STAGING_ORIGIN;

const MANUAL_TIMEOUT_MS = 10 * 60 * 1000;

// Set SIGNIN_SKIP_GOOGLE=1 to skip straight to the KWH sign-in step —
// useful if you're already signed into Google in the opened browser
// profile, or don't need the Google Pay / Google SSO session at all.
const SKIP_GOOGLE = /^(1|true|yes)$/i.test(process.env.SIGNIN_SKIP_GOOGLE ?? '');

/**
 * Context options mirroring playwright.config.ts's `chromium-desktop`
 * project (devices['Desktop Chrome'] + a 1920x1080 viewport). Sign-in
 * launches a real, channel:'chrome' browser (needed for a genuine
 * Google/GPay session), but the tests themselves run a stealth Chromium
 * context using these exact device options (see tests/fixtures/index.ts
 * `projectContextOptions`). Cloudflare's `cf_clearance` cookie is bound
 * to the exact User-Agent that obtained it — if sign-in used real
 * Chrome's own UA and tests replay the cookie under a different UA,
 * Cloudflare can silently invalidate the session even though it IS
 * signed in. Matching the UA/viewport here keeps the captured cookies
 * valid at test time.
 */
function signInContextOptions() {
  const chromeDesktop = devices['Desktop Chrome'];
  return {
    viewport: { width: 1920, height: 1080 },
    userAgent: chromeDesktop.userAgent,
    deviceScaleFactor: chromeDesktop.deviceScaleFactor,
    isMobile: chromeDesktop.isMobile,
    hasTouch: chromeDesktop.hasTouch,
  };
}

/** True if `err` looks like Playwright's "target already closed" error text — a backstop, not the primary signal (that's `page.isClosed()`). */
function isTargetClosedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /target (page, context or browser )?(has been closed|closed)/i.test(message);
}

type SignInWaitResult = 'signed-in' | 'timeout' | 'closed';

/**
 * Polls the real "signed in" signal (localStorage customerId/customerInfo
 * on the KWH origin — see tests/fixtures/authState.ts) using
 * `page.waitForFunction`, not a fixed sleep. Each iteration is bounded to
 * `sliceMs` so a mid-poll navigation (which destroys the current
 * execution context and makes `waitForFunction` throw) is treated as
 * "try again on whatever loaded next" rather than a crash, right up to
 * the overall `timeoutMs` deadline.
 *
 * The in-page predicate below necessarily duplicates the boolean rule
 * from `evaluateSignedIn` (it runs inside the browser, so it can't import
 * Node code) — but it is only used to decide *when to stop polling*. The
 * actual pass/fail decision always goes through the shared
 * `isSignedInOnPage` helper once the poll resolves, so there is still
 * exactly one authoritative definition of "signed in".
 *
 * If the operator closes the browser/tab mid-wait, `page.waitForFunction`
 * rejects almost instantly instead of after a `sliceMs` timeout — a blanket
 * catch-and-retry would then spin through rejected promises for whatever's
 * left of the overall budget. Detect that explicitly (primarily via
 * `page.isClosed()`, with the error-text match as a backstop for the
 * moment right after closure before `isClosed()` reflects it) and stop
 * immediately instead of treating it as a retryable timeout.
 */
export async function waitForSignedIn(page: import('@playwright/test').Page, timeoutMs: number): Promise<SignInWaitResult> {
  const deadline = Date.now() + timeoutMs;
  const sliceMs = 15_000;
  while (Date.now() < deadline) {
    if (page.isClosed()) return 'closed';
    const remaining = deadline - Date.now();
    try {
      // `page.waitForFunction` is a THREE-parameter call —
      // (pageFunction, arg, options) — not two. The predicate below takes
      // no argument, so `undefined` must be passed explicitly in the
      // `arg` slot; skipping straight to `{ timeout, polling }` as the
      // second argument makes it match the `arg` overload instead (typed
      // `any`, so TypeScript won't catch it), silently dropping this
      // options object and leaving Playwright's own 30s default in force
      // regardless of `sliceMs`/`remaining`. Measured: with the two-arg
      // form, a requested 3000ms slice actually took ~30000ms; with
      // `undefined` restored here it took ~3000ms as requested.
      await page.waitForFunction(
        () => {
          try {
            const customerId = window.localStorage.getItem('customerId') ?? '';
            const customerInfo = window.localStorage.getItem('customerInfo') ?? '';
            return customerId.trim().length > 0 || /"(email|customerId|id)"\s*:/i.test(customerInfo);
          } catch {
            return false;
          }
        },
        undefined,
        { timeout: Math.min(remaining, sliceMs), polling: 1000 },
      );
      // Confirm against the shared, authoritative predicate before
      // declaring success — the in-page check above is only a wake-up
      // signal.
      if (await isSignedInOnPage(page)) return 'signed-in';
    } catch (err) {
      if (page.isClosed() || isTargetClosedError(err)) return 'closed';
      // Otherwise: a genuine timeout on this slice, or the execution
      // context was destroyed by a navigation the human made mid-poll.
      // Loop and try again against the current page until the deadline.
    }
  }
  return 'timeout';
}

async function main() {
  console.log('\n=== KWH Payments · Manual Sign-in ===\n');
  console.log('A real Chrome window is opening. Sign in as you normally would.');
  console.log('This script will detect the login and save the session automatically.\n');

  const contextOptions = signInContextOptions();

  const browser = await chromium.launch({
    headless: false,
    channel: process.env.SIGNIN_CHANNEL || 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  }).catch(async () => {
    // Fall back to Playwright's bundled Chromium if real Chrome isn't installed.
    console.log('(Real Chrome not found — falling back to bundled Chromium.)');
    return chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  });

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // ---------- Step 1: Google (optional, non-fatal) ----------
  // A Google timeout used to hard-exit here, which blocked capturing a
  // perfectly good KWH session for anyone who signs in a different way
  // (e.g. email/password) or is already signed into Google in this
  // profile. Failing this step is now just a warning — sign-in continues
  // to the step that actually matters (KWH).
  if (SKIP_GOOGLE) {
    console.log('👤 Step 1 — skipped (SIGNIN_SKIP_GOOGLE=1).\n');
  } else {
    console.log('👤 Step 1 — sign into your Google account… (optional — you can skip this window)');
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForURL(
        (url) =>
          /myaccount\.google\.com|accounts\.google\.com\/b\/0\/|google\.com\/intl\//i.test(url.href),
        { timeout: MANUAL_TIMEOUT_MS },
      );
      console.log('✓ Google sign-in detected.\n');
    } catch {
      console.warn(
        '⚠ Did not detect a completed Google sign-in in time — continuing anyway.\n' +
        '  (Google Pay / Google SSO tests may not work until you sign in to Google\n' +
        '  and re-run this script. Set SIGNIN_SKIP_GOOGLE=1 to skip this step next time.)\n',
      );
    }
  }

  // ---------- Step 2: KWH (must succeed) ----------
  // Go straight to the Kinde-hosted login route rather than /Account.
  // /Account does NOT render a login form for a signed-out visitor — it
  // silently redirects to the home page, leaving the operator staring at
  // the storefront with nothing to sign into (the account control there
  // is a hover-only menu button, not a link, so it isn't discoverable
  // either). This is the same URL that menu's "Log in to manage your
  // account" item points at, observed live on staging.
  const LOGIN_URL =
    `${STAGING_URL}/api/auth/login` +
    `?post_login_redirect_url=${encodeURIComponent(`${STAGING_URL}/`)}`;
  console.log('👤 Step 2 — sign into Kitchen Warehouse in the browser window.');
  console.log('   "Continue with Google" is the quickest route.');
  if (SKIP_GOOGLE) {
    console.log('   You skipped step 1, so Google will ask you to sign in first.');
  }
  console.log('   Email is slower: it does NOT use your password — it emails a');
  console.log('   one-time code you would have to fetch from the inbox yourself.');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const waitResult = await waitForSignedIn(page, MANUAL_TIMEOUT_MS);
  if (waitResult === 'closed') {
    // Only the tracked page/context is confirmed gone — the browser
    // process itself may still be alive (e.g. the operator closed just
    // this tab while another window stayed open), so close it best-effort
    // rather than assuming there's nothing left to close. Nothing was
    // ever written, so any previously saved session is untouched either way.
    await browser.close().catch(() => undefined);
    console.error(
      '\n❌ The browser window was closed before sign-in finished.\n' +
      '   Nothing was saved — any previously saved session is untouched.\n' +
      '   Please run this again and keep the window open until you see the\n' +
      '   "✓ KWH sign-in detected" message below.\n',
    );
    process.exit(1);
  }
  if (waitResult === 'timeout') {
    console.error(
      '\n❌ Sign-in was not detected within 10 minutes.\n' +
      '   Nothing was saved — any previously saved session is untouched.\n' +
      '   Please run this again and make sure you finish signing in to KWH\n' +
      '   (you should see your account/orders page, not a login form) before\n' +
      '   the timeout.\n',
    );
    // Best-effort, matching the 'closed' branch above — the browser is
    // normally still alive here, but guarding it the same way keeps both
    // failure paths consistent instead of letting one throw uncaught while
    // main().catch(...) below already exits non-zero either way.
    await browser.close().catch(() => undefined);
    process.exit(1);
  }
  console.log('✓ KWH sign-in detected.\n');

  // ---------- Re-verify, then save ----------
  // Never overwrite a good saved session with a failed attempt: capture
  // the state once, confirm it independently against the same rule used
  // everywhere else in the repo, and only THEN write to disk. This guard
  // is fail-closed on purpose — a false "signed in" here would silently
  // place a whole run's test orders on a guest identity, which produces
  // invalid regression evidence. A loud stop is the safer failure mode.
  const state = await context.storageState();
  if (!isSignedInStorageState(state, STAGING_ORIGIN)) {
    console.error(
      '\n❌ The captured browser session does not look signed in after all —\n' +
      '   refusing to save it. Any previously saved session is untouched.\n' +
      '   Please try again and confirm you can see your account page before\n' +
      '   this script finishes.\n',
    );
    // Best-effort, matching the other failure branches — nothing was
    // written to disk either way, so a close error here shouldn't mask the
    // real failure being reported.
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));
  await context.close();
  await browser.close();

  console.log(`💾 Session saved to ${path.relative(process.cwd(), AUTH_FILE)}`);
  console.log('\nYou can close this terminal. All subsequent test runs will reuse this session.\n');
}

main().catch(async (err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
