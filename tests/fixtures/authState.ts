import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { AUTH_FILE } from './auth';

// Playwright's own entry points (playwright.config.ts, interactive-signin.ts)
// each load the root `.env` themselves before reading `process.env.STAGING_URL`.
// The runner server (runner/server/*) had no such load at all when this
// bug was found; it now loads the root .env too (runner/server/index.ts),
// but relying on any importer to have done so first is fragile: `import` statements execute top-to-bottom as written, so
// whichever file imports this module first and doesn't load dotenv would
// silently compute STAGING_ORIGIN from an unset env var. Loading it here,
// before STAGING_ORIGIN is computed below, makes this module self-sufficient
// regardless of who imports it or in what order. `dotenv.config()` is
// idempotent w.r.t. already-set vars (it won't override a value the process
// already has), so calling it again from files that already do this (e.g.
// playwright.config.ts) is harmless.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

/**
 * Single source of truth for "is this session actually signed in".
 *
 * KWH mirrors the signed-in customer into localStorage (`customerId` /
 * `customerInfo`) on its own origin — a far more reliable signal than a
 * Kinde/login URL redirect or a cookie's mere presence, because the
 * account icon and Cloudflare/Kinde cookies exist for guests too. This
 * rule was first established in tests/pages/LoginPage.ts; every other
 * consumer (the interactive sign-in script, globalSetup, the runner
 * server) must call into THIS module rather than re-deriving it, or the
 * definition will drift and silently disagree with itself again.
 * (tests/auth.setup.ts also calls in here and keeps the guard, but it is
 * `testIgnore`'d in playwright.config.ts and no project declares it as a
 * setup dependency, so it never actually runs — see the comment in
 * tests/globalSetup.ts for why this suite avoids a setup project. Not
 * counted as a real consumer above.)
 *
 * Fail-closed by design: every predicate below treats "unknown" /
 * "unreadable" / "can't tell" as NOT signed in. A false "signed in" here
 * would silently place a whole regression run's orders on a guest
 * identity and produce invalid evidence — a loud stop is the safer
 * failure mode.
 *
 * Known structural limit (not fixed here — out of scope): the saved
 * session is captured under one browser identity (real desktop Chrome,
 * UA-matched to the `chromium-desktop` project — see
 * tests/scripts/interactive-signin.ts). Cloudflare's `cf_clearance`
 * cookie in that file is bound to that identity, so `safari-desktop` /
 * `mobile-safari` (a different engine) and `android-chrome` (a
 * different UA) may get re-challenged by Cloudflare on their first
 * request and simply obtain their own fresh clearance — that's normal,
 * not a bug. The KWH login state this module actually checks (the
 * `customerId` / `customerInfo` cookies + localStorage entries) is NOT
 * UA-bound and does carry across every project. Capturing a separate
 * session per project would remove the Cloudflare re-challenge too, but
 * is deliberately not built — one shared session is what every other
 * part of this repo (globalSetup, the runner) assumes.
 */

// AUTH_FILE is imported above purely as the default argument to
// isSignedInFile below. It is deliberately NOT re-exported from here:
// every consumer already imports it straight from ./auth, and a second
// export path would just be two names for one constant.

/**
 * Origin whose localStorage we inspect. Derived from STAGING_URL so this
 * still works if the target host ever changes; falls back to the same
 * default used elsewhere in the repo (see .env.example / interactive-signin.ts)
 * when the env var is unset or malformed.
 */
export const STAGING_ORIGIN = (() => {
  const raw = process.env.STAGING_URL ?? 'https://staging.kitchenwarehouse.com.au';
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://staging.kitchenwarehouse.com.au';
  }
})();

/** The actual rule, factored out so both predicates below apply exactly the same test. */
export function evaluateSignedIn(customerId: string, customerInfo: string): boolean {
  return customerId.trim().length > 0 || /"(email|customerId|id)"\s*:/i.test(customerInfo);
}

/**
 * Minimal duck-typed shape of a Playwright `Page` — deliberately not
 * importing `@playwright/test` here so this module stays usable from
 * plain Node contexts (e.g. the runner server) that don't depend on it.
 */
interface EvaluableLike {
  evaluate<T>(pageFunction: () => T): Promise<T>;
}

export interface CustomerLocalStorageState {
  customerId: string;
  customerInfo: string;
}

/**
 * Reads the two raw localStorage keys off whatever page is currently
 * loaded. Exposed separately from `isSignedInOnPage` so callers that want
 * to log the raw values (e.g. LoginPage) don't have to re-implement the
 * `page.evaluate` call themselves.
 */
export async function readCustomerState(page: EvaluableLike): Promise<CustomerLocalStorageState> {
  return page
    .evaluate(() => ({
      customerId: window.localStorage.getItem('customerId') ?? '',
      customerInfo: window.localStorage.getItem('customerInfo') ?? '',
    }))
    .catch(() => ({ customerId: '', customerInfo: '' }));
}

/**
 * Live-page predicate — reads the two localStorage keys from whatever
 * page is currently loaded and applies `evaluateSignedIn`. The caller is
 * responsible for being on the staging origin first; if not, this simply
 * (and correctly) reports "not signed in" rather than throwing.
 */
export async function isSignedInOnPage(page: EvaluableLike): Promise<boolean> {
  const state = await readCustomerState(page);
  return evaluateSignedIn(state.customerId, state.customerInfo);
}

/** Shape Playwright's `storageState()` actually returns — declared locally to avoid a Playwright dependency. */
export interface StorageStateLike {
  origins?: Array<{
    origin: string;
    localStorage?: Array<{ name: string; value: string }>;
  }>;
}

/**
 * Applies the same rule to a saved/serialized `storageState` object,
 * scoped to `origin` (defaults to the staging site). Used by anything
 * that only has the JSON on disk, not a live page — globalSetup and the
 * runner server (tests/auth.setup.ts also uses it, but see the header
 * comment above — it is never actually reached in a real run).
 */
export function isSignedInStorageState(state: StorageStateLike, origin: string = STAGING_ORIGIN): boolean {
  const match = state.origins?.find((o) => o.origin === origin);
  const customerId = match?.localStorage?.find((e) => e.name === 'customerId')?.value ?? '';
  const customerInfo = match?.localStorage?.find((e) => e.name === 'customerInfo')?.value ?? '';
  return evaluateSignedIn(customerId, customerInfo);
}

/**
 * Reads `filePath` (defaults to the shared AUTH_FILE) off disk and
 * applies `isSignedInStorageState`. Returns false — never throws — for a
 * missing or corrupt file, per the fail-closed stance above.
 */
export function isSignedInFile(filePath: string = AUTH_FILE, origin: string = STAGING_ORIGIN): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const state = JSON.parse(raw) as StorageStateLike;
    return isSignedInStorageState(state, origin);
  } catch {
    return false;
  }
}
