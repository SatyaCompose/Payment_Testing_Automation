import { Page } from '@playwright/test';
import type { Logger } from './ageRestriction';
import type { WaitForLoadingOverlay } from './searchAdd';

export type OpenCart = () => Promise<void>;

/**
 * Preferred: click "Secure Checkout" in the cart flyout that opens right
 * after add-to-cart. Falls back to the /cart page's checkout button if
 * the flyout has already been dismissed.
 */
export async function proceedToCheckout(
  page: Page,
  log: Logger,
  openCart: OpenCart,
  waitForOverlay: WaitForLoadingOverlay,
): Promise<void> {
  log('proceeding to checkout');

  // Prefer data-testid; fall back to text.
  const secureCheckout = page
    .getByTestId('checkout-button')
    .or(
      page
        .locator('button, [role="button"], a, input[type="submit"], input[type="button"]')
        .filter({ hasText: /secure\s*checkout/i }),
    )
    .first();

  if (await secureCheckout.count().catch(() => 0)) {
    const label = ((await secureCheckout.textContent().catch(() => null)) ?? '').trim();
    log(`  → clicking "${label}" in the cart flyout`);
    await secureCheckout.scrollIntoViewIfNeeded().catch(() => undefined);
    // Give the flyout drawer a moment to finish its slide-in animation.
    await page.waitForTimeout(300);
    try {
      await secureCheckout.click({ force: true, timeout: 5_000 });
    } catch (err) {
      log(`  · native click failed (${(err as Error).message.split('\n')[0]}); using JS click`);
      await secureCheckout.evaluate((el: HTMLElement) => el.click());
    }
    await page.waitForURL(/checkout/i, { timeout: 30_000 });
    log(`  → on ${page.url()}`);
    return;
  }

  log('  → flyout not open, falling back via /cart');
  await openCart();
  await waitForOverlay();
  const cartPageCheckout = page
    .getByTestId('checkout-button')
    .or(
      page
        .locator('button, [role="button"], a, input[type="submit"]')
        .filter({ hasText: /secure\s*checkout|^checkout$|^proceed/i }),
    )
    .first();
  if (!(await cartPageCheckout.count().catch(() => 0))) {
    throw new Error('No Checkout button found on cart page');
  }
  await cartPageCheckout.scrollIntoViewIfNeeded().catch(() => undefined);
  try {
    await cartPageCheckout.click({ force: true, timeout: 5_000 });
  } catch {
    await cartPageCheckout.evaluate((el: HTMLElement) => el.click());
  }
  await page.waitForURL(/checkout/i, { timeout: 30_000 });
  log(`  → on ${page.url()}`);
}
