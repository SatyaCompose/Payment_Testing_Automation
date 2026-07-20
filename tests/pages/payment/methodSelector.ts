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

  // Wait for the payment section to render — it may take a moment
  // after continueToPayment for the method cards to appear.
  await page
    .waitForFunction(
      () =>
        /credit\s*card|paypal|afterpay|google pay|apple pay|card details|payment method/i.test(
          document.body.innerText,
        ),
      undefined,
      { timeout: 20_000, polling: 500 },
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

  // Card-based click — same pattern as the shipping cards. Find a
  // heading (or plain text) that matches the label, then click it.
  const heading = page
    .getByRole('heading', { name: label })
    .or(page.getByText(label, { exact: false }))
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

  await heading.click({ force: true, timeout: 8_000 });
  log(`  ✓ clicked ${method} card`);
}

export async function expectPaymentError(
  page: Page,
  text: string | RegExp = /declined|failed|unable|invalid/i,
): Promise<void> {
  await expect(
    page.getByRole('alert').or(page.getByText(/declined|failed|unable|invalid/i)),
  ).toContainText(text);
}
