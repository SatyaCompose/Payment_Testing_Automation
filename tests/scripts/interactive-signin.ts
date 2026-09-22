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

/**
 * Matches a URL Google only serves to an already-authenticated browser
 * (the myaccount app, the post-signin account-chooser redirect, or the
 * localized google.com landing). Used both to decide when the manual
 * Google wait in Step 1 has succeeded, and — before that wait even starts
 * — to detect that a seeded `storageState` already carries a live Google
 * session, so the wait can be skipped instead of duplicated.
 */
const GOOGLE_SIGNED_IN_URL_PATTERN =
  /myaccount\.google\.com|accounts\.google\.com\/b\/0\/|google\.com\/intl\//i;

/**
 * Paths Google serves while it still wants something from the human — its
 * sign-in form, a challenge/2FA step, an account chooser, an OAuth consent
 * screen. `accounts.google.com/b/0/` alone is too loose to mean "signed
 * in": several of these live under URL shapes that would otherwise match
 * it, which would make us announce "already signed into Google" and skip a
 * step the operator still had to complete, and simultaneously fail to
 * notice they were stuck — reproducing the exact silent stall this file
 * exists to prevent. Checked FIRST, so it always wins over the
 * signed-in patterns above.
 */
const GOOGLE_PENDING_PATH_PATTERN =
  /\/(signin|challenge|accountchooser|oauth2|consent|speedbump|deniedsigninrejected)/i;

/**
 * True when the browser is sitting on one of Google's own accounts.google.com
 * pages (its login form, 2FA challenge, etc.) rather than having completed
 * the sign-in flow. Several distinct states land here — an expired saved
 * session, a never-signed-in profile, an account chooser when the profile
 * holds more than one Google account, a consent screen, a 2FA challenge —
 * and this predicate cannot tell them apart. It means only "Google stopped
 * the redirect and wants something from the human", so messaging built on
 * it must say that and never diagnose a specific cause. Deliberately the
 * inverse of
 * `GOOGLE_SIGNED_IN_URL_PATTERN` restricted to the accounts.google.com host,
 * so the two never both report true for the same URL.
 */
function isOnGoogleLoginPage(url: string): boolean {
  if (!/accounts\.google\.com/i.test(url)) return false;
  // A pending path wins outright — some of them sit under URL shapes the
  // signed-in patterns would otherwise match.
  if (GOOGLE_PENDING_PATH_PATTERN.test(url)) return true;
  return !GOOGLE_SIGNED_IN_URL_PATTERN.test(url);
}

/**
 * True only when Google has genuinely finished with the human. The pending
 * check is applied here too, so a URL that merely looks like a signed-in
 * shape but is really a chooser/challenge never counts as done.
 */
function isGoogleSignedIn(url: string): boolean {
  if (GOOGLE_PENDING_PATH_PATTERN.test(url)) return false;
  return GOOGLE_SIGNED_IN_URL_PATTERN.test(url);
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
 *
 * `onProgress`, if given, is called at most once — the first loop
 * iteration at or past the halfway point of `timeoutMs` — with the
 * elapsed time and the page's current URL. It exists purely to give the
 * operator one confirmation partway through a long silent wait that the
 * script is still watching (and what it's watching); it never affects
 * the deadline or the eventual result.
 */
export async function waitForSignedIn(
  page: import('@playwright/test').Page,
  timeoutMs: number,
  onProgress?: (info: { elapsedMs: number; url: string }) => void,
): Promise<SignInWaitResult> {
  const deadline = Date.now() + timeoutMs;
  const sliceMs = 15_000;
  let progressReported = false;
  while (Date.now() < deadline) {
    if (page.isClosed()) return 'closed';
    const remaining = deadline - Date.now();
    if (onProgress && !progressReported && timeoutMs - remaining >= timeoutMs / 2) {
      progressReported = true;
      onProgress({ elapsedMs: timeoutMs - remaining, url: page.url() });
    }
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
  console.log('This script will detect the login and save the session automatically.');

  const seededFromExistingSession = fs.existsSync(AUTH_FILE);
  if (seededFromExistingSession) {
    console.log('A previously saved session was found and its Google cookies will be');
    console.log('reused, which can skip the Google step entirely. Nothing is overwritten');
    console.log('until a fresh sign-in is confirmed.\n');
  } else {
    console.log('No previously saved session was found — this will be a full manual sign-in.\n');
  }

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

  // Seed the new context from any existing saved session (computed above).
  // Its Google cookies are what let "Continue with Google" on the KWH
  // login page complete with no prompt at all (proven live against
  // staging) instead of forcing a full Google sign-in every run. Carrying
  // over a stale *guest* KWH session from the same file is harmless: a
  // successful sign-in below fully replaces the file's contents (see the
  // re-verify + write step at the end), and a failed attempt never writes
  // at all — so seeding here cannot turn a good saved session into a bad
  // one, it can only save a fresh sign-in faster. A first-ever run has no
  // file yet, so this is conditional rather than always-on.
  const context = await browser.newContext(
    seededFromExistingSession ? { ...contextOptions, storageState: AUTH_FILE } : contextOptions,
  );
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
    console.log('👤 Step 1 — checking Google sign-in status…');
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded' });
    // If the seeded session already carries a live Google session,
    // accounts.google.com redirects away from /signin immediately —
    // no need to sit through the manual wait below for something that's
    // already true.
    if (seededFromExistingSession && isGoogleSignedIn(page.url())) {
      console.log('✓ Step 1 — the saved session is already signed into Google — skipping the wait.\n');
    } else {
      console.log(
        '   Sign into your Google account in the window now.\n' +
        '   This step is skippable, but if Google is not signed in here and you\n' +
        '   skip it, Step 2\'s "Continue with Google" click will very likely land\n' +
        '   you back on this same Google page and then wait the full 10 minutes\n' +
        '   for it — signing in here now avoids that. If you\n' +
        '   would rather not sign in to Google at all, Step 2 also offers a\n' +
        '   slower email one-time-code route that does not need it.',
      );
      try {
        await page.waitForURL((url) => isGoogleSignedIn(url.href), {
          timeout: MANUAL_TIMEOUT_MS,
        });
        console.log('✓ Google sign-in detected.\n');
      } catch {
        console.warn(
          '⚠ Did not detect a completed Google sign-in in time — continuing anyway.\n' +
          '  With Google not signed in here, Step 2\'s "Continue with Google" click\n' +
          '  will very likely stall on a Google page waiting for you.\n' +
          '  When that happens, sign in to Google in the window that is open and\n' +
          '  the rest will finish automatically — or use the slower email\n' +
          '  one-time-code option in Step 2 instead. Set SIGNIN_SKIP_GOOGLE=1 to\n' +
          '  skip this step next time.\n',
        );
      }
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
  console.log('   "Continue with Google" is the quickest route — this script will try');
  console.log('   clicking it for you; if that does not work, click it yourself.');
  if (SKIP_GOOGLE) {
    console.log('   You skipped step 1, so Google may ask you to sign in first.');
  }
  console.log('   Email is slower: it does NOT use your password — it emails a');
  console.log('   one-time code you would have to fetch from the inbox yourself.');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // Accelerator only, never a hard dependency: if "Continue with Google" is
  // on screen, click it — the seeded Google cookies (when present) let this
  // complete with no prompt at all. If it isn't there, or the click fails
  // for any reason, log it and fall straight through to the same manual
  // wait below exactly as if this block didn't exist — the human still has
  // the full 10-minute window to finish sign-in by hand.
  try {
    const continueWithGoogle = page.getByRole('button', { name: 'Continue with Google', exact: true });
    // `isVisible()` does NOT wait — it samples the DOM the instant it is
    // called, which here is immediately after `goto`, before this
    // client-rendered button has had a chance to mount. It would report
    // false almost every time and silently drop us back to "click it
    // yourself", defeating the accelerator. `waitFor` is the waiting form.
    const googleButtonReady = await continueWithGoogle
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (googleButtonReady) {
      console.log('   Found "Continue with Google" — clicking it automatically…');
      await continueWithGoogle.click();
      console.log('   Clicked. Waiting for sign-in to complete…');

      // The click either completes the flow and returns to the store, or
      // Google stops the redirect and parks the browser on one of its own
      // pages, wanting something from the human first. Check
      // for that second case right away instead of only finding out ten
      // minutes from now. This is a notification only: whether or not it
      // fires, the full wait below still runs for its complete duration —
      // the human may already be sitting at that exact page about to sign in.
      const landedOnGoogleLoginPage = await page
        .waitForURL((url) => isOnGoogleLoginPage(url.href), { timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (landedOnGoogleLoginPage) {
        console.log(
          '\n' +
          '   ══════════════════════════════════════════════════════════════\n' +
          '   ⚠  Google is waiting on you.\n' +
          '   The browser is sitting on a Google page instead of returning to\n' +
          '   the store — usually a sign-in prompt, sometimes an account chooser\n' +
          '   or a confirmation step.\n' +
          '   Sign in to Google in the window that is open now — the rest of\n' +
          '   this script will continue automatically once you do.\n' +
          '   ══════════════════════════════════════════════════════════════\n',
        );
      }
    } else {
      console.log('   "Continue with Google" was not visible — continue manually.');
    }
  } catch (err) {
    console.log(
      `   Auto-click of "Continue with Google" failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — continue manually.`,
    );
  }

  const waitResult = await waitForSignedIn(page, MANUAL_TIMEOUT_MS, ({ elapsedMs, url }) => {
    const minutes = Math.round(elapsedMs / 60_000);
    const where = isOnGoogleLoginPage(url)
      ? 'a Google page waiting on you — finish what it asks to continue'
      : 'the Kitchen Warehouse sign-in flow';
    console.log(`   …still waiting (${minutes} min elapsed) — the window is currently on ${where}.`);
  });
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
    // Report specifically that sign-in stalled at Google, rather than the
    // generic message below, when the browser is currently sitting on
    // one of Google's own pages, which is the most likely reason ten
    // minutes passed with nothing detected. Report what is on screen, not
    // a guess at why — see isOnGoogleLoginPage's note on the several
    // states that look identical from here.
    const stalledAtGoogleLogin = isOnGoogleLoginPage(page.url());
    console.error(
      stalledAtGoogleLogin
        ? '\n❌ Sign-in stalled on a Google page and was not detected within 10\n' +
          '   minutes — Google was waiting on something (a sign-in, an account\n' +
          '   choice, or a confirmation) and it was never completed.\n' +
          '   Nothing was saved — any previously saved session is untouched.\n' +
          '   Run this again, finish whatever Google asks in the window, and the\n' +
          '   rest completes automatically.\n'
        : '\n❌ Sign-in was not detected within 10 minutes.\n' +
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
