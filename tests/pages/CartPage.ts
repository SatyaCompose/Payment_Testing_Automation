import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { randomKitchenSearchTerm, productListingPath } from '../fixtures/testData';
import { addRandomProductFromSearch, type SearchAddOptions } from './cart/searchAdd';
import { addRandomProductFromListing } from './cart/listingAdd';
import { getCartTotalAud, getCartTotalFromFlyout } from './cart/cartTotal';
import { proceedToCheckout } from './cart/proceedToCheckout';

/**
 * The cart page + product-add helpers. Thin facade over focused modules
 * in `./cart/`. Public API is preserved — spec files and CheckoutFlow
 * call these methods directly.
 */
export class CartPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    // Use lowercase /cart — KWH's canonical URL. Some routes 404 on /Cart.
    await this.goto('/cart');
  }

  private logMsg = (message: string): void => this.log(message);
  private overlayWaiter = (): Promise<void> => this.waitForLoadingOverlay();
  private gotoFn = (path?: string): Promise<void> => this.goto(path);

  /**
   * Types a random kitchen-related search term into the site search, waits
   * for results, and adds a random product from the results page. Attempts
   * up to `maxAttempts` random searches; if a picked product turns out to
   * be out-of-stock, retries with a fresh search term.
   */
  async addRandomProductFromSearch(
    term: string = randomKitchenSearchTerm(),
    maxAttempts = 3,
    opts: SearchAddOptions = {},
  ): Promise<string> {
    return addRandomProductFromSearch(
      this.page,
      this.logMsg,
      this.gotoFn,
      this.overlayWaiter,
      term,
      maxAttempts,
      opts,
    );
  }

  /**
   * Listing-based fallback — navigates to a listing page and picks any
   * product card. Prefer `addRandomProductFromSearch()` for coverage.
   */
  async addRandomProductFromListing(listingPath: string = productListingPath()): Promise<void> {
    await addRandomProductFromListing(this.page, this.gotoFn, this.overlayWaiter, listingPath);
  }

  /**
   * Adds N random products. Each pick uses a fresh random kitchen search
   * term so the products are usually distinct across categories.
   */
  async addRandomProducts(count: number, opts: SearchAddOptions = {}): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.addRandomProductFromSearch(undefined, 3, opts);
    }
  }

  async getCartTotalAud(): Promise<number> {
    return getCartTotalAud(this.page);
  }

  /**
   * Cheap probe: navigate to /cart and report whether it already has any
   * line items. Used by CheckoutFlow to skip re-adding products for
   * logged-in retries — the server-side cart persists across attempts,
   * so a retry that starts from scratch would double-stock the cart.
   */
  async probeHasItems(): Promise<boolean> {
    await this.open();
    await this.waitForLoadingOverlay();
    const total = await getCartTotalAud(this.page).catch(() => 0);
    this.log(`probeHasItems: /cart total = $${total.toFixed(2)}`);
    return total > 0;
  }

  /**
   * Adds random products (via search) until cart total > minAud. Bails out
   * after `maxAttempts` picks to avoid infinite loops on cheap-only pools.
   */
  async addProductsUntilMinTotal(
    minAud: number,
    maxAttempts = 8,
    opts: SearchAddOptions = {},
  ): Promise<number> {
    this.log(`target cart total > $${minAud} AUD (max ${maxAttempts} random adds)`);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.addRandomProductFromSearch(undefined, 3, opts);
      // Read total from the flyout drawer that's already open after the
      // add — no extra /cart navigation, and the value reflects the item
      // we just added (unlike a /cart navigation which sometimes drops
      // the flyout's uncommitted state on staging).
      const total = await getCartTotalFromFlyout(this.page);
      this.log(`  cart total after ${attempt + 1} product(s): $${total.toFixed(2)} (from flyout)`);
      if (total > minAud) return total;
    }
    throw new Error(`Cart total did not exceed ${minAud} AUD after ${maxAttempts} random products`);
  }

  async proceedToCheckout(): Promise<void> {
    await proceedToCheckout(this.page, this.logMsg, () => this.open(), this.overlayWaiter);
  }

  /**
   * Removes every line item from the cart. Used when a CNC retry needs a
   * different product because no store had the current one in stock.
   */
  async clearCart(): Promise<void> {
    await this.open();
    this.log('clearing every item from the cart');
    for (let safety = 0; safety < 20; safety++) {
      const removeBtn = this.page
        .getByRole('button', { name: /^remove$|remove item|delete/i })
        .or(this.page.locator('button, [role="button"]').filter({ hasText: /^\s*remove\s*$/i }))
        .first();
      if (!(await removeBtn.isVisible({ timeout: 1_500 }).catch(() => false))) break;
      await removeBtn.scrollIntoViewIfNeeded().catch(() => undefined);
      await removeBtn.click({ force: true }).catch(() => undefined);
      // Confirmation dialog / undo — accept if present.
      const confirm = this.page
        .getByRole('button', { name: /confirm|yes|remove|ok/i })
        .first();
      if (await confirm.isVisible({ timeout: 800 }).catch(() => false)) {
        await confirm.click({ force: true }).catch(() => undefined);
      }
      await this.page.waitForTimeout(400);
    }
    this.log('  ✓ cart cleared');
  }
}
