import { Page, Locator, expect } from '@playwright/test';

export type Logger = (message: string) => void;
export type WaitForLoadingOverlay = () => Promise<void>;

/**
 * The Kinde social-login row shows three icon-only buttons: G / Apple /
 * Facebook. The Google one has no visible text — match by the alt/src
 * of its <img>, its aria-label, or (last resort) its position.
 */
export function googleSsoButton(page: Page): Locator {
  return page
    // Explicit name (some Kinde themes set aria-label)
    .getByRole('button', { name: /google|continue with google|sign in with google/i })
    .or(page.getByRole('link', { name: /google|continue with google|sign in with google/i }))
    // A button whose <img> alt or src mentions Google
    .or(page.locator('button:has(img[alt*="google" i])'))
    .or(page.locator('button:has(img[src*="google" i])'))
    // A button containing an <svg> with a Google aria-label
    .or(page.locator('button:has(svg[aria-label*="google" i])'))
    .first();
}

/**
 * Returns a Locator for the Log in link on the checkout, or null if
 * none is visible (already signed in).
 */
export async function findLoginControl(page: Page, log: Logger): Promise<Locator | null> {
  const strategies: Array<{ name: string; get: () => Locator }> = [
    {
      name: 'near "Already have an account"',
      get: () =>
        page
          .locator(':is(p, div, span, section):has-text("Already have an account")')
          .locator('a, button')
          .filter({ hasText: /log ?in|sign ?in/i })
          .first(),
    },
    {
      name: 'getByRole(link, name=/log ?in/)',
      get: () => page.getByRole('link', { name: /^\s*log ?in\s*$/i }).first(),
    },
    {
      name: 'getByRole(button, name=/log ?in/)',
      get: () => page.getByRole('button', { name: /^\s*log ?in\s*$/i }).first(),
    },
    {
      name: 'a/button filter text=Log in',
      get: () =>
        page
          .locator('a, button, [role="link"], [role="button"]')
          .filter({ hasText: /^\s*(log ?in|sign ?in|login|signin)\s*$/i })
          .first(),
    },
  ];

  for (const s of strategies) {
    const loc = s.get();
    const count = await loc.count().catch(() => 0);
    const visible = count > 0 ? await loc.isVisible().catch(() => false) : false;
    log(`  · login strategy "${s.name}" — count=${count} visible=${visible}`);
    if (visible) return loc;
  }
  return null;
}

/**
 * After clicking a "Sign in with Google" button, Google may:
 *   1. Auto-redirect (session valid + previous consent) → nothing to do
 *   2. Show a "Choose an account" chooser  → click our email
 *   3. Show a "Continue as X" consent screen → click Continue / Allow
 * Poll for these signals and click through until we're back on the KWH host.
 */
export async function completeGoogleAuthFlow(page: Page, log: Logger, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const email = (process.env.TEST_USER_EMAIL ?? '').toLowerCase();

  while (Date.now() < deadline) {
    const url = page.url();
    if (/kitchenwarehouse\.com\.au/.test(url)) {
      return;
    }

    // Log the current step so a stall is diagnosable.
    log(`  · Google auth flow at ${url.slice(0, 100)}`);

    // 1. Account chooser — click the account matching our email.
    if (email) {
      const emailTile = page.getByText(email, { exact: false }).first();
      if (await emailTile.isVisible({ timeout: 2_000 }).catch(() => false)) {
        log(`  → clicking account tile "${email}"`);
        await emailTile.click({ force: true }).catch(() => undefined);
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        continue;
      }
    }

    // 2. Consent / continue button.
    const continueBtn = page
      .getByRole('button', { name: /^continue$|^allow$|^next$|^confirm$/i })
      .or(page.getByRole('link', { name: /^continue$|^allow$|^next$|^confirm$/i }))
      .first();
    if (await continueBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      log('  → clicking Continue / Allow');
      await continueBtn.click({ force: true }).catch(() => undefined);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      continue;
    }

    // 3. Password prompt — if Google forces us to re-enter password
    //    (first-time consent for this OAuth app). Fill from env.
    const pwField = page.getByLabel(/password/i).first();
    if (await pwField.isVisible({ timeout: 2_000 }).catch(() => false)) {
      const pw = process.env.TEST_USER_PASSWORD ?? '';
      if (pw) {
        log('  → filling password (Google re-auth prompt)');
        await pwField.fill(pw);
        await page.getByRole('button', { name: /next|sign in|continue/i }).first().click();
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        continue;
      }
    }

    // Nothing actionable this cycle — brief wait for the next signal.
    await page.waitForTimeout(500);
  }

  throw new Error(
    `Google auth flow did not redirect back to KWH within ${timeoutMs}ms. Stuck at ${page.url()}`,
  );
}

async function completeKindeGoogleOnPopup(
  page: Page,
  popup: Page,
  log: Logger,
  waitForOverlay: WaitForLoadingOverlay,
): Promise<void> {
  const btn = popup
    .getByRole('button', { name: /google|continue with google|sign in with google/i })
    .or(popup.locator('button:has(img[alt*="google" i])'))
    .or(popup.locator('button:has(img[src*="google" i])'))
    .first();
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await btn.click({ force: true });
  await popup.waitForEvent('close', { timeout: 60_000 }).catch(() => undefined);
  await page.waitForURL(/kitchenwarehouse\.com\.au/, { timeout: 30_000 }).catch(() => undefined);
  log('✓ signed in via popup — back on KWH');
  await waitForOverlay();
}

/**
 * If the checkout is asking us to sign in (Kinde flow), complete it via
 * "Sign in with Google". The Google button on Kinde is icon-only — its
 * accessible name comes from the `<img alt>` of the Google G logo, so we
 * match by multiple strategies.
 *
 * After the click, Google may show:
 *   - "Choose an account" list  → click our account
 *   - "Continue" / "Allow" consent → click it
 * Both are handled here. The final wait is for a redirect back to
 * kitchenwarehouse.com.au.
 */
export async function handleLoginPromptIfPresent(
  page: Page,
  log: Logger,
  waitForOverlay: WaitForLoadingOverlay,
): Promise<void> {
  // 1. Wait for the Customer section to render.
  await page
    .getByText(/already have an account|continue to shipping|customer/i)
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => undefined);

  // 2. Locate the Log in link/button in the "Already have an account?
  //    Log in or continue as guest." sentence.
  const loginBtn = await findLoginControl(page, log);
  if (!loginBtn) {
    log('no Log in control found — proceeding as already signed in / guest');
    return;
  }

  const text = ((await loginBtn.textContent().catch(() => null)) ?? '').trim();
  // Diagnose the element we're about to click — helps if it turns out
  // to be a decorative <span> whose onClick handler doesn't run.
  const elInfo = await loginBtn
    .evaluate((el) => {
      const anchor = el as HTMLAnchorElement;
      return {
        tag: el.tagName,
        role: el.getAttribute('role') ?? null,
        href: anchor.href ?? null,
        target: anchor.target ?? null,
        onclick: !!(el as HTMLElement).onclick,
      };
    })
    .catch(() => null);
  log(`step 1 · clicking Log in ("${text}")  el=${JSON.stringify(elInfo)}`);
  await loginBtn.scrollIntoViewIfNeeded().catch(() => undefined);

  // Watch for a popup in case the click opens a new tab.
  const popupPromise = page.waitForEvent('popup', { timeout: 5_000 }).catch(() => null);

  // First try: Playwright's native click with `force` so overlays don't block.
  await loginBtn.click({ force: true }).catch(async (err) => {
    log(`  · native click failed: ${err.message?.split('\n')[0]}`);
  });

  // 3. Wait for the Kinde login page (URL change, Google button, or popup).
  const outcome = await Promise.race([
    page.waitForURL(/kinde\.com|\/api\/auth|\/(login|signin)/i, { timeout: 8_000 })
      .then(() => 'url-changed' as const)
      .catch(() => null),
    googleSsoButton(page).waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => 'google-visible' as const)
      .catch(() => null),
    popupPromise.then((p) => (p ? 'popup' : null)),
  ]);

  if (!outcome) {
    // Fallback: JS-based click. Bypasses Playwright's actionability
    // engine so any framework onClick fires regardless.
    log('  · native click did not transition — trying el.click() via evaluate');
    await loginBtn.evaluate((el) => (el as HTMLElement).click()).catch((err) => {
      log(`  · evaluate-click failed: ${err.message?.split('\n')[0]}`);
    });

    const second = await Promise.race([
      page.waitForURL(/kinde\.com|\/api\/auth|\/(login|signin)/i, { timeout: 15_000 })
        .then(() => 'url-changed' as const)
        .catch(() => null),
      googleSsoButton(page).waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => 'google-visible' as const)
        .catch(() => null),
    ]);

    if (!second) {
      throw new Error(
        `After clicking Log in (native+JS), page did not open Kinde. url=${page.url().slice(0, 120)}  element=${JSON.stringify(elInfo)}`,
      );
    }
    log(`  → transition detected via evaluate-click: ${second}`);
  } else {
    log(`  → transition detected: ${outcome}`);
  }

  // If a popup opened, switch focus to it — that's where Kinde renders.
  const popup = await popupPromise;
  if (popup) {
    log('  → login opened in a popup; using it for the SSO flow');
    // We can't simply "swap" the working page for the popup in this
    // helper, so drive it directly and close when done.
    await completeKindeGoogleOnPopup(page, popup, log, waitForOverlay);
    return;
  }

  log(`  → on Kinde login: ${page.url().slice(0, 100)}`);

  // 4. Click the Google icon on Kinde.
  const googleBtn = googleSsoButton(page);
  await expect(googleBtn).toBeVisible({ timeout: 15_000 });
  log('step 2 · clicking Google icon on Kinde (quick login via existing session)');
  await googleBtn.click({ force: true });

  // 5. Google auto-consents because the session cookie is loaded from
  //    tests/.auth/user.json. Walk any intermediate screens just in case.
  await completeGoogleAuthFlow(page, log);
  log('✓ signed in — back on KWH, waiting for callback to settle');

  // KWH's OAuth callback lands with ?code=… in the URL. The page needs
  // a moment to exchange the code + hydrate the checkout form before
  // any input is interactive. On mobile-safari the redirect chain can
  // take a beat longer than networkidle — explicitly wait for the URL
  // to reach the KWH domain before declaring "signed in".
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page
    .waitForURL(/staging\.kitchenwarehouse\.com\.au\/checkout/i, { timeout: 30_000 })
    .catch(() => log('  ! did not land on KWH /checkout within 30s — will still probe'));
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await waitForOverlay();
  log(`  → checkout ready. url=${page.url().slice(0, 100)}`);
}
