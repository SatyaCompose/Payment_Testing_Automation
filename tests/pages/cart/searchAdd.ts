import { Page, expect } from '@playwright/test';
import { randomKitchenSearchTerm } from '../../fixtures/testData';
import { handleAgeRestrictionCheckbox, Logger } from './ageRestriction';
import { dismissInsiderOverlay, installInsiderKiller } from './insiderOverlay';

export type WaitForLoadingOverlay = () => Promise<void>;
export type Goto = (path?: string) => Promise<void>;

export interface SearchAddOptions {
  /** Filter the PLP to only products that qualify for Express shipping
   *  before picking one. Set when the caller (typically CheckoutFlow with
   *  `shipping: 'express'`) requires the picked product to be Express-eligible
   *  — i.e. available online and NOT a dropship item. */
  filterExpressOnly?: boolean;
}

/**
 * Attempts up to `maxAttempts` random searches; if a picked product turns
 * out to be out-of-stock (or, with `filterExpressOnly`, no product on the
 * PLP survives the Express filter), retries with a fresh search term.
 */
export async function addRandomProductFromSearch(
  page: Page,
  log: Logger,
  goto: Goto,
  waitForOverlay: WaitForLoadingOverlay,
  term: string = randomKitchenSearchTerm(),
  maxAttempts = 3,
  opts: SearchAddOptions = {},
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await doAddRandomProductFromSearch(
        page,
        log,
        goto,
        waitForOverlay,
        attempt === 0 ? term : randomKitchenSearchTerm(),
        opts,
      );
    } catch (err) {
      lastError = err;
      log(`  ! attempt ${attempt + 1}/${maxAttempts} failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw lastError;
}

async function doAddRandomProductFromSearch(
  page: Page,
  log: Logger,
  goto: Goto,
  waitForOverlay: WaitForLoadingOverlay,
  term: string,
  opts: SearchAddOptions,
): Promise<string> {
  // Install the MutationObserver-based Insider killer on this page's
  // next navigation (idempotent per Page). Then do the goto — the init
  // script runs on the new document and starts nuking Insider nodes as
  // they're injected, whether pre-render or via a scroll/timer trigger.
  await installInsiderKiller(page);
  log(`STEP 1/6 · goto home, prepare to search for "${term}"`);
  await goto('/');
  await dismissInsiderOverlay(page, log);

  log('STEP 2/6 · locating the searchbox');
  const searchbox = page
    .getByRole('searchbox')
    .or(page.getByPlaceholder(/search/i))
    .first();
  await expect(searchbox).toBeVisible({ timeout: 30_000 });
  await expect(searchbox).toBeEditable({ timeout: 10_000 });

  log(`STEP 3/6 · typing "${term}" and pressing Enter`);
  await searchbox.fill(term);
  await page.keyboard.press('Enter');
  await page.waitForLoadState('domcontentloaded');
  await waitForOverlay();
  await dismissInsiderOverlay(page, log);
  log(`  → results URL: ${page.url()}`);

  if (opts.filterExpressOnly) {
    await applyExpressDeliveryFilter(page, log, waitForOverlay);
  }

  // KWH product detail pages live at `/product/<slug>` (singular).
  // `/brands/…` are brand category listings, not products.
  const allProductLinks = page.locator('a[href*="/product/"]');
  const totalCount = await allProductLinks.count();
  log(`STEP 4/6 · ${totalCount} link(s) match a[href*="/product/"]`);
  if (opts.filterExpressOnly && totalCount === 0) {
    throw new Error(`No products qualify for Express delivery after searching "${term}"`);
  }

  // The DOM often contains cards below the fold that are hidden until the
  // user scrolls (lazy render). Iterate and pick the first N that report
  // isVisible() = true, so Playwright's toBeVisible() doesn't fail on a
  // technically-in-DOM-but-invisible card.
  const visible: Array<{ index: number; href: string }> = [];
  for (let i = 0; i < totalCount && visible.length < 8; i++) {
    const l = allProductLinks.nth(i);
    const on = await l.isVisible().catch(() => false);
    if (on) {
      const href = (await l.getAttribute('href').catch(() => null)) ?? '(no href)';
      visible.push({ index: i, href });
    }
  }
  log(`  → ${visible.length} visible in the top-of-page pool`);

  if (visible.length === 0) {
    // Fall back: force the top card into view then retry the visibility check.
    log('  → no visible cards, scrolling to top and retrying');
    await page.evaluate(() => window.scrollTo(0, 0));
    await waitForOverlay();
    for (let i = 0; i < totalCount && visible.length < 8; i++) {
      const l = allProductLinks.nth(i);
      if (await l.isVisible().catch(() => false)) {
        const href = (await l.getAttribute('href').catch(() => null)) ?? '(no href)';
        visible.push({ index: i, href });
      }
    }
    log(`  → after scroll: ${visible.length} visible`);
  }

  if (visible.length === 0) {
    throw new Error(
      `No visible product cards after search for "${term}". ${totalCount} link(s) present in DOM but all hidden.`,
    );
  }

  const pick = visible[Math.floor(Math.random() * visible.length)];
  log(`STEP 5/6 · picked product #${pick.index}  href=${pick.href}`);

  const target = allProductLinks.nth(pick.index);
  await target.scrollIntoViewIfNeeded();
  await waitForOverlay();
  await expect(target).toBeVisible({ timeout: 10_000 });
  await target.click({ timeout: 20_000 });

  await page.waitForURL(/\/product\//, { timeout: 30_000 }).catch(() => {
    throw new Error(`Click did not navigate to /product/…  href was ${pick.href}, now at ${page.url()}`);
  });
  log(`  → on product page: ${page.url()}`);

  await page.waitForLoadState('domcontentloaded');
  await waitForOverlay();

  // Age-restriction checkbox — knives, alcohol, etc. show "I'm 18 or
  // over" that must be ticked before Add to cart enables. The DOM shape
  // varies (native <input>, custom div, wrapping label…) so try several
  // strategies and log which one worked.
  await handleAgeRestrictionCheckbox(page, log);

  // Product detail page — variant selectors (size/color) may need to be
  // picked before Add to cart enables. If a variant control exists, click
  // the first available option; harmless if none.
  const firstVariant = page
    .locator('[data-testid*="variant" i], [class*="variant" i] button, [class*="option" i] button')
    .first();
  if (await firstVariant.isVisible().catch(() => false)) {
    log('  → variant selector visible, clicking first option');
    await firstVariant.click().catch(() => undefined);
    await waitForOverlay();
  }

  // Product availability check — reject "Out of stock" / "Sold out"
  // products before we even try to click Add to cart. Also confirms the
  // primary Add to cart control is enabled (not greyed out because the
  // variant is unavailable).
  const outOfStock = page.getByText(/out of stock|sold out|unavailable/i).first();
  if (await outOfStock.isVisible().catch(() => false)) {
    throw new Error(`Product is out of stock at ${page.url()}`);
  }

  log('STEP 6/6 · clicking Add to cart');
  // Strict role-based match on the accessible NAME rules out:
  //   • related-products card wrappers whose textContent happens to
  //     contain "Add to cart" (e.g. a "Add to cart button" caption
  //     inside a carousel item on mobile).
  //   • sticky "Buy now" bars that mount off-screen.
  //   • large layout divs whose text spans multiple product tiles.
  // Filter `visible: true` so off-screen carousel copies (which are
  // sometimes first in DOM order on mobile) are excluded — that's the
  // silent "clicking somewhere else" case: the button click "succeeded"
  // but landed on a hidden related-products tile that opens a mini
  // wishlist modal instead of the main cart flyout.
  const addBtn = page
    .getByRole('button', { name: /^\s*add\s*to\s*(cart|bag)\s*$/i })
    .filter({ visible: true })
    .or(
      page
        .locator('button, [role="button"], input[type="submit"], input[type="button"]')
        .filter({ hasText: /^\s*add\s*to\s*(cart|bag)\s*$/i })
        .filter({ visible: true }),
    )
    .first();
  if (!(await addBtn.count().catch(() => 0))) {
    throw new Error('No visible "Add to cart" button found on product page');
  }
  const addBtnMeta = await addBtn
    .evaluate((el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 40).replace(/\s+/g, ' '),
        className: (el.getAttribute('class') || '').slice(0, 60),
        testid: el.getAttribute('data-testid') || null,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    })
    .catch(() => null);
  log(`  → clicking Add to cart: ${JSON.stringify(addBtnMeta)}`);
  await addBtn.scrollIntoViewIfNeeded().catch(() => undefined);
  await expect(addBtn).toBeEnabled({ timeout: 10_000 });
  await addBtn.click({ force: true });

  // Wait for the cart drawer's "Secure Checkout" BUTTON (not the header
  // "Secure checkout" badge). The site header on mobile renders a
  // <div>/<span> reading "Secure checkout" next to the cart icon — a
  // naked text-substring wait matched that badge and reported success
  // even when the flyout never opened, making the downstream
  // proceedToCheckout probe hang for 20s. Prefer the flyout-specific
  // data-testid; fall back to a role-scoped match on the accessible
  // name so header decorations are excluded.
  const secureCheckoutBtn = page
    .getByTestId('checkout-button')
    .or(
      page
        .getByRole('button', { name: /secure\s*checkout/i })
        .or(page.getByRole('link', { name: /secure\s*checkout/i })),
    )
    .filter({ visible: true })
    .first();
  try {
    await expect(secureCheckoutBtn).toBeVisible({ timeout: 20_000 });
    log('  ✓ product added — Secure Checkout button is visible in the flyout');
  } catch (err) {
    // Dump anything on the page whose text mentions "checkout" so a
    // future re-run can tell whether the flyout didn't open, or opened
    // under a different accessible name.
    const diag = await page
      .locator('button, [role="button"], a, [role="link"]')
      .filter({ hasText: /checkout/i })
      .evaluateAll((els) =>
        els.slice(0, 8).map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 40),
          testid: el.getAttribute('data-testid') || null,
          role: el.getAttribute('role') || null,
          visible:
            (el as HTMLElement).getBoundingClientRect().width > 0 &&
            (el as HTMLElement).offsetParent !== null,
        })),
      )
      .catch(() => []);
    log(`  ! flyout Secure Checkout button not visible in 20s. Nearby checkout-labelled elements: ${JSON.stringify(diag)}`);
    throw err;
  }

  return term;
}

/**
 * Clicks the "Express delivery available" facet on the search results page
 * so subsequent product picks are guaranteed to be online-available AND
 * not dropship items — the two conditions the KWH Express shipping method
 * requires. Waits for the PLP to re-render before returning.
 */
async function applyExpressDeliveryFilter(
  page: Page,
  log: Logger,
  waitForOverlay: WaitForLoadingOverlay,
): Promise<void> {
  log('  → applying "Express delivery available" filter (Express-only run)');
  // KWH renders the facet in both a desktop sidebar AND a hidden mobile
  // drawer; a raw `.first()` picks the drawer copy and fails on click.
  // Scope to the visible one.
  const filter = page
    .locator('label, button, [role="button"], a, [role="checkbox"]')
    .filter({ hasText: /express\s*delivery\s*available/i })
    .filter({ visible: true })
    .first();
  if (!(await filter.count().catch(() => 0))) {
    throw new Error('No "Express delivery available" filter on the results page');
  }
  await filter.scrollIntoViewIfNeeded().catch(() => undefined);
  await filter.click();
  await waitForOverlay();
  // Give the PLP a moment to swap in the filtered set.
  await page
    .waitForLoadState('networkidle', { timeout: 8_000 })
    .catch(() => undefined);
  log('  ✓ Express filter applied');
}
