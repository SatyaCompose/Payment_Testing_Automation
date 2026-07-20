import { Page, expect } from '@playwright/test';
import { productListingPath } from '../../fixtures/testData';
import type { Goto, WaitForLoadingOverlay } from './searchAdd';

/**
 * Listing-based fallback — navigates to a listing page and picks any
 * product card. Prefer `addRandomProductFromSearch()` for coverage.
 */
export async function addRandomProductFromListing(
  page: Page,
  goto: Goto,
  waitForOverlay: WaitForLoadingOverlay,
  listingPath: string = productListingPath(),
): Promise<void> {
  await goto(listingPath);
  await page.waitForLoadState('domcontentloaded');
  await waitForOverlay();

  // Same as the search variant: only match product-detail URLs.
  const productLinks = page.locator('a[href*="/product/"]');

  const count = await productLinks.count();
  if (count === 0) {
    throw new Error(`No product cards found at ${listingPath}`);
  }
  await productLinks.nth(Math.floor(Math.random() * count)).click();

  await page.getByRole('button', { name: /add to cart|add to bag/i }).first().click();
  await expect(
    page.getByRole('dialog').or(page.getByRole('status')).filter({ hasText: /added|cart/i }),
  ).toBeVisible({ timeout: 15_000 });
}
