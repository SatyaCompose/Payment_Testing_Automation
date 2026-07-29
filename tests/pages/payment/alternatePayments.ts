import { Page } from '@playwright/test';

// ---------- PayPal (new tab / popup) ----------
/**
 * KWH PayPal flow:
 *   1. PayPal tile is already selected. KWH's Place Order button gets
 *      `pointer-events-none` and PayPal's smart-buttons iframe overlays
 *      it — clicking the KWH button directly does nothing.
 *   2. Click at Place Order's visual centre via page.mouse.click; the
 *      click passes through to PayPal's iframe which opens the PayPal
 *      login popup.
 *   3. Log in and confirm inside the popup.
 *   4. Popup closes → KWH renders order confirmation.
 */
export async function payWithPayPal(page: Page, email: string, password: string): Promise<void> {
  console.log('[PayPal] === entering payWithPayPal ===');

  // Full page-state snapshot on entry: iframes + any PayPal-labeled
  // elements + Place Order button state.
  const initialState = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll('iframe')).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        src: (el.getAttribute('src') || '').slice(0, 100),
        title: el.getAttribute('title'),
        w: Math.round(r.width),
        h: Math.round(r.height),
        onscreen: r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.top > -100,
      };
    });
    const paypalEls = Array.from(document.querySelectorAll('button, a, [role="button"], div'))
      .filter((el) => {
        const text = (el.textContent || '').trim();
        const aria = el.getAttribute('aria-label') || '';
        return /^paypal$|pay with paypal|checkout with paypal/i.test(text) || /paypal/i.test(aria);
      })
      .slice(0, 8)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 50),
          ariaLabel: el.getAttribute('aria-label')?.slice(0, 40),
          class: (el.getAttribute('class') || '').slice(0, 60),
          w: Math.round(r.width),
          h: Math.round(r.height),
          onscreen: r.width > 0 && r.height > 0 && r.top < window.innerHeight,
        };
      });
    const placeOrder = (() => {
      const el = document.querySelector('[data-testid="place-order-btn"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        class: (el.getAttribute('class') || '').slice(0, 100),
        display: window.getComputedStyle(el as HTMLElement).display,
        visibility: window.getComputedStyle(el as HTMLElement).visibility,
        pointerEvents: window.getComputedStyle(el as HTMLElement).pointerEvents,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    })();
    return { iframes, paypalEls, placeOrder };
  });
  console.log(`[PayPal] initial iframes (${initialState.iframes.length}): ${JSON.stringify(initialState.iframes)}`);
  console.log(`[PayPal] initial PayPal elements (${initialState.paypalEls.length}): ${JSON.stringify(initialState.paypalEls)}`);
  console.log(`[PayPal] Place Order state: ${JSON.stringify(initialState.placeOrder)}`);

  console.log('[PayPal] searching for click target — iframe first (up to 30s), then attr/img fallback');
  // Log a periodic snapshot every 3s during the search so we see how
  // the DOM evolves as PayPal's SDK loads.
  const searchStart = Date.now();
  const snapshotInterval = setInterval(() => {
    void (async () => {
      const snap = await page
        .evaluate(() => {
          const iframes = Array.from(document.querySelectorAll('iframe'))
            .filter((el) => /paypal/i.test(el.getAttribute('src') || '') || /paypal/i.test(el.getAttribute('title') || ''))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { src: (el.getAttribute('src') || '').slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) };
            });
          const btn = Array.from(document.querySelectorAll('button, [role="button"], a'))
            .filter((el) => /paypal/i.test(el.textContent || ''))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) };
            })
            .slice(0, 3);
          return { iframes, btn };
        })
        .catch(() => null);
      const elapsed = ((Date.now() - searchStart) / 1000).toFixed(1);
      console.log(`[PayPal] t+${elapsed}s snapshot: ${JSON.stringify(snap)}`);
    })();
  }, 3_000);

  // Phase 1: wait for a real PayPal iframe (paypal.com src, or an
  // iframe nested inside .paypal-wrapper / #paypal-button-container-*).
  // The SDK renders wrappers + placeholder <img alt="paypal"> BEFORE
  // it injects the iframe — if we let attr/img strategies win they
  // point at inert wrappers and the click hits dead space.
  let clickBox = await page
    .waitForFunction(
      () => {
        const iframes = Array.from(document.querySelectorAll('iframe')) as HTMLIFrameElement[];
        for (const el of iframes) {
          const src = el.getAttribute('src') || '';
          const title = el.getAttribute('title') || '';
          const insidePaypalContainer = !!el.closest('.paypal-wrapper, [id^="paypal-button-container"], [class*="paypal-buttons"]');
          const looksPaypal = /paypal\.com/i.test(src) || /paypal/i.test(title) || insidePaypalContainer;
          if (!looksPaypal) continue;
          const r = el.getBoundingClientRect();
          if (r.width >= 100 && r.height >= 30) {
            return { kind: 'iframe', x: r.left, y: r.top, width: r.width, height: r.height, why: `src="${src.slice(0,60)}" title="${title}" inWrap=${insidePaypalContainer}` };
          }
        }
        return null;
      },
      undefined,
      { timeout: 30_000, polling: 400 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);

  // Phase 2 (fallback): iframe never rendered — try labeled elements
  // and img-ancestor. This branch clicks by coordinate and is less
  // reliable, so we only take it as a last resort.
  if (!clickBox) {
    console.log('[PayPal] no PayPal iframe within 30s — falling back to attr/img strategies (up to 15s)');
    clickBox = await page
      .waitForFunction(
        () => {
          const isButtonSized = (r: DOMRect) =>
            r.width >= 100 && r.width <= 600 &&
            r.height >= 30 && r.height <= 120 &&
            r.top >= 0 && r.top < window.innerHeight;

          // class / data-testid / aria-label / name attribute contains
          // "paypal". Reject wrapper class names — they hold the SDK
          // iframe but aren't themselves clickable.
          const WRAPPER_CLASSES = /\b(paypal-wrapper|paypal-button-container|paypal-buttons-container)\b/i;
          const attrCandidates = Array.from(
            document.querySelectorAll(
              'button, a, [role="button"], [class*="paypal" i], [data-testid*="paypal" i], [aria-label*="paypal" i], [name*="paypal" i]',
            ),
          ) as HTMLElement[];
          for (const el of attrCandidates) {
            const cls = el.getAttribute('class') || '';
            if (WRAPPER_CLASSES.test(cls)) continue;
            const tid = el.getAttribute('data-testid') || '';
            const aria = el.getAttribute('aria-label') || '';
            const name = el.getAttribute('name') || '';
            const alt = el.getAttribute('alt') || '';
            const hasPaypal = /paypal/i.test(`${cls} ${tid} ${aria} ${name} ${alt}`);
            if (!hasPaypal) continue;
            const r = el.getBoundingClientRect();
            if (!isButtonSized(r)) continue;
            return { kind: 'attr', x: r.left, y: r.top, width: r.width, height: r.height, why: `class="${cls.slice(0,30)}" tid="${tid}" aria="${aria}"` };
          }

          // <img alt~="paypal"> ancestor sized like a button — also
          // reject if the ancestor is a known wrapper.
          const imgs = Array.from(document.querySelectorAll('img[alt*="paypal" i]')) as HTMLImageElement[];
          for (const img of imgs) {
            let el: HTMLElement | null = img.parentElement;
            while (el && el !== document.body) {
              const cls = el.getAttribute('class') || '';
              if (WRAPPER_CLASSES.test(cls)) { el = el.parentElement; continue; }
              const r = el.getBoundingClientRect();
              if (isButtonSized(r)) {
                return { kind: 'img-ancestor', x: r.left, y: r.top, width: r.width, height: r.height, why: `img alt="${img.alt.slice(0,30)}"` };
              }
              el = el.parentElement;
            }
          }
          return null;
        },
        undefined,
        { timeout: 15_000, polling: 400 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
  }

  clearInterval(snapshotInterval);
  if (!clickBox) {
    const domSnapshot = await page.evaluate(() => ({
      iframes: Array.from(document.querySelectorAll('iframe')).map((el) => {
        const r = el.getBoundingClientRect();
        return { src: (el.getAttribute('src') || '').slice(0, 90), w: Math.round(r.width), h: Math.round(r.height) };
      }),
      paypalTexts: Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter((el) => /paypal/i.test(el.textContent || ''))
        .slice(0, 5)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) };
        }),
    }));
    console.log(`[PayPal] no PayPal click target found: ${JSON.stringify(domSnapshot)}`);
    throw new Error('No PayPal button/iframe found on the page');
  }

  const clickX = clickBox.x + clickBox.width / 2;
  const clickY = clickBox.y + clickBox.height / 2;
  const why = (clickBox as { why?: string }).why;
  console.log(`[PayPal] click target: kind=${clickBox.kind} at (${Math.round(clickX)}, ${Math.round(clickY)}) size=${Math.round(clickBox.width)}x${Math.round(clickBox.height)}${why ? ` — ${why}` : ''}`);

  // Cross-origin coordinate clicks on the PayPal SDK iframe don't
  // always fire the popup handler — the SDK renders a prerender +
  // live button pair and the mouse coord can land on the prerender.
  // When we identified an iframe, drill into it with frameLocator
  // and click the actual .paypal-button element. Coordinate-click
  // is the fallback (attr / img-ancestor kinds).
  //
  // Popup detection: PayPal's SDK opens the login window as a real
  // new tab from inside the (cross-origin) SDK iframe. Depending on
  // browser + SDK version this can attach to the BrowserContext as a
  // brand-new Page rather than firing page.on('popup') on the parent.
  // Race both events so we catch either surface.
  const context = page.context();
  const awaitNewSurface = () =>
    Promise.race([
      page.waitForEvent('popup', { timeout: 30_000 }).then((p) => ({ p, via: 'page.popup' as const })),
      context.waitForEvent('page', { timeout: 30_000 }).then((p) => ({ p, via: 'context.page' as const })),
    ]);
  let popup: Page;
  if (clickBox.kind === 'iframe') {
    const paypalFrame = page.frameLocator('iframe[title="PayPal"], iframe[src*="paypal.com"]').first();
    const innerBtn = paypalFrame.locator('[role="link"], .paypal-button, [data-funding-source="paypal"]').first();
    console.log('[PayPal] clicking inside PayPal iframe via frameLocator — waiting for popup/new-tab (30s)…');
    const [surface] = await Promise.all([
      awaitNewSurface(),
      innerBtn.click({ timeout: 15_000 }),
    ]);
    popup = surface.p;
    console.log(`[PayPal] ✓ new surface via ${surface.via}`);
  } else {
    console.log('[PayPal] dispatching mouse.click and waiting for popup/new-tab (30s)…');
    const [surface] = await Promise.all([
      awaitNewSurface(),
      page.mouse.click(clickX, clickY),
    ]);
    popup = surface.p;
    console.log(`[PayPal] ✓ new surface via ${surface.via}`);
  }
  console.log(`[PayPal] ✓ popup opened: ${popup.url()}`);
  await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
  console.log('[PayPal] popup DOM loaded — filling email');
  // `getByLabel(/email/i)` matches the "Login with email one-time
  // code" link + OTP chevron button — scope to the actual textbox.
  await popup.getByRole('textbox', { name: /email or mobile/i }).fill(email);
  console.log('[PayPal] email filled — clicking Next');
  await popup.getByRole('button', { name: /^next$/i }).click();
  console.log('[PayPal] Next clicked — filling password');
  // Same rationale — use the password textbox specifically. Some
  // PayPal skins render it as an input, others as a passwordbox
  // role; match either.
  const passwordBox = popup
    .getByRole('textbox', { name: /^password$/i })
    .or(popup.locator('input#password'));
  await passwordBox.fill(password);
  console.log('[PayPal] password filled — clicking Log In');
  await popup.getByRole('button', { name: /log ?in/i }).click();
  console.log('[PayPal] logged in — clicking Pay Now / Complete Purchase');
  await popup.getByRole('button', { name: /pay now|complete purchase|continue/i }).click();
  console.log('[PayPal] Pay Now clicked — waiting for popup to close');
  await popup.waitForEvent('close', { timeout: 60_000 }).catch(() => undefined);
  console.log('[PayPal] popup closed — outer flow will assert confirmation');
}

// ---------- Afterpay (same-page redirect) ----------
/**
 * KWH Afterpay flow:
 *   1. Afterpay tile is already selected.
 *   2. Click "Place order" on the KWH checkout — the current tab
 *      navigates to portal.afterpay.com / clearpay.
 *   3. Log in on the Afterpay page and authorise the payment.
 *   4. Afterpay redirects back to KWH → order confirmation renders.
 */
export async function payWithAfterpay(page: Page, email: string, password: string): Promise<void> {
  console.log('[Afterpay] === entering payWithAfterpay ===');

  // Snapshot Place Order + any afterpay-specific triggers so we know
  // which selector to click. KWH disables Place Order (pointer-events:
  // none) for alt payments and renders the provider's own button.
  const snap = await page.evaluate(() => {
    const placeOrder = (() => {
      const el = document.querySelector('[data-testid="place-order-btn"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        display: window.getComputedStyle(el as HTMLElement).display,
        pointerEvents: window.getComputedStyle(el as HTMLElement).pointerEvents,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    })();
    const afterpayEls = Array.from(
      document.querySelectorAll(
        'button, a, [role="button"], [class*="afterpay" i], [class*="clearpay" i], [data-testid*="afterpay" i], iframe',
      ),
    )
      .filter((el) => {
        const s = `${el.getAttribute('class') || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('src') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`;
        return /afterpay|clearpay/i.test(s);
      })
      .slice(0, 8)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          class: (el.getAttribute('class') || '').slice(0, 60),
          tid: el.getAttribute('data-testid') || '',
          src: (el.getAttribute('src') || '').slice(0, 60),
          w: Math.round(r.width),
          h: Math.round(r.height),
          onscreen: r.width > 0 && r.height > 0,
        };
      });
    return { placeOrder, afterpayEls };
  });
  console.log(`[Afterpay] Place Order state: ${JSON.stringify(snap.placeOrder)}`);
  console.log(`[Afterpay] afterpay-labeled elements (${snap.afterpayEls.length}): ${JSON.stringify(snap.afterpayEls)}`);

  // Try Afterpay-branded trigger first (dedicated button/link/iframe).
  // If none found, fall back to Place Order with force:true — that
  // bypasses the pointer-events:none actionability check some skins
  // apply while the SDK is still mounting.
  const branded = page
    .locator('button, a, [role="button"]')
    .filter({ hasText: /^(pay with )?afterpay|^(pay with )?clearpay|continue with afterpay/i })
    .first();
  const brandedCount = await branded.count().catch(() => 0);

  const clickAndWait = async (label: string, fn: () => Promise<void>) => {
    console.log(`[Afterpay] clicking via ${label} — waiting for redirect (30s)…`);
    await Promise.all([
      page.waitForURL(/afterpay|clearpay/i, { timeout: 30_000 }),
      fn(),
    ]);
    console.log(`[Afterpay] ✓ redirected to ${page.url()}`);
  };

  if (brandedCount > 0) {
    await clickAndWait('branded Afterpay button', () => branded.click({ timeout: 10_000 }));
  } else {
    console.log('[Afterpay] no branded button — falling back to Place Order (force click)');
    await clickAndWait('Place Order (force)', () =>
      page.locator('[data-testid="place-order-btn"]').first().click({ force: true, timeout: 10_000 }),
    );
  }

  console.log('[Afterpay] on portal — resolving login screen');
  // KWH passes the checkout email through to Afterpay, which lands us
  // on a "Welcome back!" password-only screen pre-filled with the
  // buyer's guest email. Our sandbox creds are a different identity,
  // so click "Not you?" to reveal the full email+password form.
  // `.isVisible()` doesn't retry; use `.waitFor({ state: 'visible' })`
  // so we actually wait for the portal to hydrate.
  const notYou = page.getByRole('button', { name: /not you/i });
  const emailInput = page.getByRole('textbox', { name: /email/i });
  const notYouVisible = await notYou
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (notYouVisible) {
    console.log('[Afterpay] "Welcome back" screen detected — clicking "Not you?"');
    await notYou.click();
    await emailInput.waitFor({ state: 'visible', timeout: 10_000 });
  } else {
    console.log('[Afterpay] no "Not you?" — assuming full login form is ready');
    await emailInput.waitFor({ state: 'visible', timeout: 10_000 });
  }
  // Afterpay's portal is a two-step login: email screen → Continue →
  // password screen → Continue → order-review with a final confirm/pay
  // button. Filling both on the email screen doesn't work — the
  // password textbox on step 2 needs its own fill after the screen
  // transitions.
  console.log('[Afterpay] step A · filling email + clicking Continue');
  await emailInput.fill(email);
  await page.getByRole('button', { name: /^continue$/i }).first().click();

  console.log('[Afterpay] step B · waiting for password screen');
  const passwordInput = page.getByRole('textbox', { name: /password/i });
  await passwordInput.waitFor({ state: 'visible', timeout: 15_000 });
  await passwordInput.fill(password);
  await page.getByRole('button', { name: /^continue$/i }).first().click();

  console.log('[Afterpay] step C · waiting for confirm/pay button');
  const confirmBtn = page.getByRole('button', {
    name: /confirm(?:\s*(?:&|and)\s*pay)?|authori[sz]e|pay now|place order/i,
  });
  await confirmBtn.waitFor({ state: 'visible', timeout: 20_000 });
  await confirmBtn.click();
  // Afterpay redirects back to KWH — wait for the URL to leave the
  // afterpay domain so downstream assertions see the confirmation page.
  await page.waitForURL(/kitchenwarehouse/i, { timeout: 60_000 }).catch(() => undefined);
  console.log('[Afterpay] ✓ returned to KWH — outer flow will assert confirmation');
}

// ---------- Google Pay (popup from pay.google.com) ----------
/**
 * KWH Google Pay flow:
 *   1. GPay tile is already selected (paymentPage.selectMethod handles it).
 *   2. Click the visible `.gpay-button` overlay — KWH's Place order
 *      button beneath has `pointer-events-none` when GPay is selected,
 *      Google's SDK overlays this div. The click bubbles to the SDK
 *      button and opens the pay.google.com popup.
 *   3. In the popup, click "Pay".
 *   4. Popup closes → KWH renders order confirmation.
 *
 * No credentials — the browser must be signed into Google via
 * `tests/auth.setup.ts`, which chromium/android projects inherit
 * via storageState.
 */
/**
 * Semi-automated Google Pay: the test drives everything up to opening
 * the Google Pay popup. Because Google's SDK refuses to populate the
 * sheet under Playwright automation (verified: pay.google.com iframes
 * stay empty for 97+ seconds even with stealth), a human clicks the
 * blue "Pay" button in the popup manually. The helper then waits up
 * to 3 minutes for the KWH page to navigate away from /checkout —
 * that navigation is the signal Google's success handler fired and
 * KWH's frontend has proceeded to order placement.
 *
 * Everything before AND after the manual Pay click is automated. Only
 * the single popup-button click is manual.
 */
export async function payWithGooglePay(page: Page): Promise<void> {
  console.log('[GPay] === entering payWithGooglePay ===');
  const context = page.context();

  // ---------- OBSERVE-ONLY LISTENERS ----------
  page.on('popup', (p) => console.log(`[GPay] ! page.on('popup') → ${p.url()}`));
  context.on('page', (p) => console.log(`[GPay] ! context.on('page') → ${p.url()}`));
  page.on('framenavigated', (f) => {
    if (/pay\.google\.com|googlepay|google\.com\/pay/i.test(f.url())) {
      console.log(`[GPay] ! framenavigated → ${f.url().slice(0, 120)}`);
    }
  });
  page.on('request', (req) => {
    const url = req.url();
    const isKwhDomain = /kitchenwarehouse\.com|frontastic|cybersource|pay\.google\.com|googlepay/i.test(url);
    const isAnalytics = /tagmanager|analytics|gtm|hotjar|clarity|datadoghq|newrelic|pixlee|stackadapt|paypal\.com\/xoplatform/i.test(url);
    const isBoring = /\.(png|jpg|jpeg|gif|svg|webp|woff2?|ttf|css|ico)$/i.test(url.split('?')[0]);
    if (isKwhDomain && !isAnalytics && !isBoring) {
      console.log(`[GPay] → ${req.method()} ${url.slice(0, 140)}`);
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    const isKwhBackend = /kitchenwarehouse\.com|frontastic|cybersource/i.test(url);
    const isAnalytics = /tagmanager|analytics|gtm|hotjar|clarity|datadoghq/i.test(url);
    const isBoring = /\.(png|jpg|jpeg|gif|svg|webp|woff2?|ttf|css|ico)$/i.test(url.split('?')[0]);
    if (isKwhBackend && !isAnalytics && !isBoring && res.request().method() !== 'GET') {
      console.log(`[GPay] ← ${res.status()} ${res.request().method()} ${url.slice(0, 140)}`);
    }
  });
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error' || msg.type() === 'warning' || /gpay|google|paymentsclient|loadpaymentdata|token|cybersource|microform|flex|order|checkout|fail|reject|catch/i.test(t)) {
      console.log(`[GPay] ! console (${msg.type()}): ${t.slice(0, 600)}`);
    }
  });
  page.on('pageerror', (err) => {
    console.log(`[GPay] ! page error: ${err.message.slice(0, 500)}`);
  });

  // Wait for the GPay button container to render before we snapshot.
  await page
    .locator('[class*="gpay-button-container"]')
    .filter({ visible: true })
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => console.log('[GPay] gpay-button-container did not appear within 15s'));

  // ---------- LAYOUT SNAPSHOT BEFORE CLICK ----------
  const layout = await page.evaluate(() => {
    const readEl = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el as HTMLElement);
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 40),
        class: (el.getAttribute('class') || '').slice(0, 80),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        display: cs.display,
        visibility: cs.visibility,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        position: cs.position,
        disabled: (el as HTMLButtonElement).disabled ?? null,
      };
    };
    const placeOrder = document.querySelector('[data-testid="place-order-btn"]');
    const gpayBtn = document.querySelector('[class*="gpay-button-container"]');
    // What's at the visual centre of each element? Tells us which
    // element intercepts clicks at that position.
    const atCenterOf = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top
        ? {
            tag: top.tagName.toLowerCase(),
            class: (top.getAttribute('class') || '').slice(0, 80),
            text: (top.textContent || '').trim().slice(0, 40),
          }
        : null;
    };
    return {
      placeOrder: readEl(placeOrder),
      gpayBtn: readEl(gpayBtn),
      elementAtPlaceOrderCentre: atCenterOf(placeOrder),
      elementAtGpayBtnCentre: atCenterOf(gpayBtn),
    };
  });
  // Single-line JSON so grep captures the whole thing.
  console.log(`[GPay] layout.placeOrder: ${JSON.stringify(layout.placeOrder)}`);
  console.log(`[GPay] layout.gpayBtn: ${JSON.stringify(layout.gpayBtn)}`);
  console.log(`[GPay] layout.elementAtPlaceOrderCentre: ${JSON.stringify(layout.elementAtPlaceOrderCentre)}`);
  console.log(`[GPay] layout.elementAtGpayBtnCentre: ${JSON.stringify(layout.elementAtGpayBtnCentre)}`);

  // ---------- CLICK ----------
  // Click the inner `.gpay-button.buy` div (the real click target bound
  // to Google's PaymentRequest handler), not the outer container wrapper.
  // Drop force:true so Playwright routes through hover→mousedown→mouseup —
  // PaymentRequest requires a real user gesture on the bound element.
  const gpayButton = page
    .locator('.gpay-button.buy')
    .filter({ visible: true })
    .first();
  await gpayButton.waitFor({ state: 'visible', timeout: 15_000 });
  console.log('[GPay] clicking .gpay-button.buy — waiting for MANUAL Pay click in popup (up to 3 min)');
  await gpayButton.click();

  // Heartbeat: every 10s log the page URL + any visible errors so we
  // can see progress (or lack of) in real time.
  const deadline = Date.now() + 180_000;
  const heartbeat = (async () => {
    while (Date.now() < deadline) {
      await page.waitForTimeout(10_000).catch(() => undefined);
      if (page.isClosed?.()) return;
      const snap = await page
        .evaluate(() => {
          const url = window.location.href;
          const errorText = Array.from(document.querySelectorAll('[role="alert"], [class*="error" i]'))
            .map((el) => (el.textContent || '').trim())
            .filter((s) => s && s.length < 200)
            .slice(0, 3);
          const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="overlay" i]'))
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 100 && r.height > 100;
            })
            .slice(0, 3)
            .map((el) => ({
              class: (el.getAttribute('class') || '').slice(0, 60),
              text: (el.textContent || '').trim().slice(0, 60),
            }));
          return { url, errors: errorText, modals };
        })
        .catch(() => null);
      if (!snap) return;
      console.log(`[GPay] ♥ url=${snap.url} modals=${JSON.stringify(snap.modals)} errors=${JSON.stringify(snap.errors)}`);
    }
  })();

  // Wait up to 3 minutes for the manual Pay click to complete. Two
  // signals: the URL navigates away from /checkout, OR confirmation
  // text renders on the page. Whichever fires first, we return and let
  // the outer flow assert the full confirmation page.
  await Promise.race([
    heartbeat,
    page
      .waitForURL((url) => !/\/checkout(?:\?|$|\/)/i.test(url.toString()), {
        timeout: 180_000,
      })
      .then(() => console.log(`[GPay] URL navigated: ${page.url()}`))
      .catch(() => undefined),
    page
      .getByText(/thank you for your order|order confirmed|order complete|order successfully|CT-\d+/i)
      .first()
      .waitFor({ state: 'visible', timeout: 180_000 })
      .then(() => console.log('[GPay] confirmation text visible'))
      .catch(() => undefined),
  ]);
  console.log(`[GPay] === exiting payWithGooglePay, final URL=${page.url()} ===`);
}
