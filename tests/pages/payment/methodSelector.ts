import { Page, expect } from '@playwright/test';
import type { PaymentMethod } from '../../fixtures/testData';

export type Logger = (message: string) => void;

/** Accessible-name regexes per payment-method card. */
const methodLabel: Record<PaymentMethod, RegExp> = {
  'credit-card': /^credit\s*(&|and|\/)?\s*(debit\s*)?card$|^credit\s*card$|^card$|^visa\/mastercard/i,
  paypal: /^paypal$/i,
  afterpay: /^afterpay$/i,
  gpay: /^google\s*pay$/i,
  applepay: /^apple\s*pay$/i,
};

export async function selectMethod(page: Page, log: Logger, method: PaymentMethod): Promise<void> {
  log(`step 3 · selectMethod ${method}`);
  const label = methodLabel[method];

  // Payment section is typically already rendered by continueToPayment.
  // Short wait as a safety net for slow SPA hydration; don't double-spend
  // the 20s budget both here AND in continueToPayment.
  await page
    .waitForFunction(
      () =>
        /credit\s*card|paypal|afterpay|google pay|apple pay|card details|payment method/i.test(
          document.body.innerText,
        ),
      undefined,
      { timeout: 5_000, polling: 250 },
    )
    .catch(() => undefined);

  // Debug — log payment-related snippets so we can see the DOM.
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  const snippets = bodyText
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s && /credit|paypal|afterpay|google pay|apple pay|card|payment/i.test(s))
    .slice(0, 10);
  log(`  DOM payment snippets: ${snippets.map((s) => s.slice(0, 60)).join(' | ')}`);

  // Card-based click — same pattern as the shipping cards. Prefer a real
  // interactive role (mobile renders the tiles as radios), then a heading,
  // then plain text as a last resort.
  //
  // Next.js keeps an sr-only live region — <p id="__next-route-announcer__">
  // — holding the current route's title. It is 1x1px and `clip`ped, so
  // toBeVisible() passes while click() fails with "Element is outside of
  // the viewport". Its text can equal a payment label exactly ("Afterpay"),
  // and it sits late in the DOM, so it wins `.first()` whenever the real
  // tile's own text isn't an exact match — which is what happens on
  // android-chrome. Exclude it from text matching entirely.
  const notAnnouncer = page.locator(':not(#__next-route-announcer__)');
  const heading = page
    .getByRole('radio', { name: label })
    .or(page.getByRole('button', { name: label }))
    .or(page.getByRole('heading', { name: label }))
    .or(page.getByText(label).and(notAnnouncer))
    .first();
  await expect(heading).toBeVisible({ timeout: 15_000 });
  await heading.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);

  // Skip if already selected (checkmark or aria-checked).
  const card = heading
    .locator(
      'xpath=ancestor-or-self::*[self::button or @role="button" or @role="radio" or contains(@class,"card") or @tabindex][1]',
    )
    .first();
  const alreadySelected = await card
    .locator('svg[aria-label*="check" i], svg[data-selected], [aria-checked="true"], [class*="selected" i]')
    .first()
    .isVisible()
    .catch(() => false);
  if (alreadySelected) {
    log(`  → ${method} card is already selected — skipping click`);
    return;
  }

  // Log exactly what we matched. A tile click that lands on the wrong
  // element fails silently — the method never switches and the failure
  // only surfaces much later as "no redirect" in the provider helper.
  const matched = await heading
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        id: el.id || null,
        class: (el.getAttribute('class') || '').slice(0, 60),
        text: (el.textContent || '').trim().slice(0, 40),
        box: `${Math.round(r.width)}x${Math.round(r.height)}`,
      };
    })
    .catch(() => null);
  log(`  → click target: ${JSON.stringify(matched)}`);

  await heading.click({ force: true, timeout: 8_000 });
  log(`  ✓ clicked ${method} card`);

  // Did the selection actually take? For alt payments KWH disables its own
  // Place order button (pointer-events:none) and mounts the provider's
  // widget, so pointerEvents is a reliable post-click signal.
  const selectionState = await page
    .evaluate(() => {
      const el = document.querySelector('[data-testid="place-order-btn"]');
      if (!el) return null;
      return window.getComputedStyle(el as HTMLElement).pointerEvents;
    })
    .catch(() => null);
  log(`  · post-click Place order pointerEvents=${selectionState}`);
}

export async function expectPaymentError(
  page: Page,
  text: string | RegExp = /declined|failed|unable|invalid/i,
): Promise<void> {
  await expect(
    page.getByRole('alert').or(page.getByText(/declined|failed|unable|invalid/i)),
  ).toContainText(text);
}
