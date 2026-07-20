import { Page, expect } from '@playwright/test';

/**
 * Apply the promo code via the Order Summary panel (right-hand side of
 * checkout). The panel is present on every checkout step, so this can
 * be called any time between opening /checkout and payment. Waits for
 * the code / "applied" / "discount" text to appear in the summary
 * before returning — ensures downstream totals reflect the discount.
 *
 * Retries up to `maxAttempts` if the input can't be reached OR the
 * confirmation text doesn't render within the timeout — KWH's
 * order-summary component sometimes hydrates slightly late on the
 * customer step.
 */
export async function applyPromoCode(page: Page, code: string, maxAttempts = 3): Promise<void> {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const confirmation = page
    .getByText(new RegExp(escaped, 'i'))
    .or(page.getByText(/applied|discount|promo(?:tion)? applied/i))
    .first();

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const input = page
        .getByLabel(/promo|discount|coupon/i)
        .or(page.getByPlaceholder(/promo|discount|coupon/i))
        .first();
      await input.waitFor({ state: 'visible', timeout: 6_000 });
      await input.fill(code);
      await page.getByRole('button', { name: /^apply$/i }).first().click({ force: true });
      await expect(confirmation).toBeVisible({ timeout: 8_000 });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await page.waitForTimeout(700);
      }
    }
  }
  throw new Error(
    `Failed to apply promo code "${code}" after ${maxAttempts} attempts: ${
      (lastError as Error)?.message?.split('\n')[0] ?? lastError
    }`,
  );
}

/**
 * KWH renders Gift Card as its own payment-method tile at step 3. The
 * "Gift card code" input + "Apply" button are only visible AFTER the
 * tile is clicked (which expands it). Sequence:
 *   1. Click the "Gift Card" tile.
 *   2. Fill the "Gift card code" input.
 *   3. (Optional) fill PIN if the site prompts for one.
 *   4. Click the tile-scoped "Apply" button.
 *   5. Wait for a "gift card applied" / "balance" / "remaining" confirmation.
 *
 * The gift card acts as a partial payment — the remaining balance still
 * needs to be covered by another payment method (Credit Card in 6.2).
 */
export async function applyGiftCard(page: Page, cardNumber: string, pin?: string): Promise<void> {
  const tile = page
    .locator('div, section, article, button, [role="button"], label')
    .filter({ hasText: /^\s*gift\s*card\s*$/i })
    .first();
  if (!(await tile.isVisible({ timeout: 8_000 }).catch(() => false))) {
    throw new Error('Gift Card tile is not visible on the payment step');
  }
  await tile.scrollIntoViewIfNeeded().catch(() => undefined);
  await tile.click({ force: true });

  // The expanded tile now contains the input + Apply button. Scope to
  // the tile so we don't grab the promo-code input from Order Summary.
  const gcInput = tile
    .getByLabel(/gift\s*card(?:\s*code)?/i)
    .or(tile.getByPlaceholder(/gift\s*card\s*code|enter (your )?gift\s*card/i))
    .or(page.getByPlaceholder(/gift\s*card\s*code/i))
    .first();
  await gcInput.waitFor({ state: 'visible', timeout: 6_000 });
  await gcInput.fill(cardNumber);

  if (pin) {
    const pinInput = tile.getByLabel(/pin/i).or(page.getByLabel(/gift\s*card\s*pin/i)).first();
    if (await pinInput.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await pinInput.fill(pin);
    }
  }

  const applyBtn = tile
    .getByRole('button', { name: /^\s*apply\s*$/i })
    .or(tile.locator('button, [role="button"]').filter({ hasText: /^\s*apply\s*$/i }))
    .first();
  await applyBtn.click({ force: true });

  await expect(
    page.getByText(/gift\s*card\s*applied|gift\s*card\s*balance|balance remaining|remaining balance/i),
  ).toBeVisible({ timeout: 12_000 });
}
