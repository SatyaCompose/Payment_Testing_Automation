import { Page, expect } from '@playwright/test';
import { randomKitchenSearchTerm } from '../../fixtures/testData';
import { handleAgeRestrictionCheckbox, Logger } from './ageRestriction';
import { dismissInsiderOverlay, installInsiderKiller } from './insiderOverlay';

export type WaitForLoadingOverlay = () => Promise<void>;
export type Goto = (path?: string) => Promise<void>;

/**
 * The three delivery facets every KWH product-listing page offers. They
 * are the ONLY reliable way to put a product in the cart that supports
 * the shipping method a test is about to ask for:
 *
 *   available-online   → product ships, but Standard shipping only
 *   express-delivery   → product supports BOTH Standard and Express
 *   click-and-collect  → product can be collected in store (CNC)
 *
 * Picking an unfiltered product is what made section 2 (Express) place
 * its orders on Standard shipping: the checkout simply never offered an
 * Express card for a dropship item, and the suite carried on regardless.
 */
export type DeliveryFilter = 'available-online' | 'express-delivery' | 'click-and-collect';

interface DeliveryFacet {
  label: string;
  re: RegExp;
  /** Throw when the facet can't be applied, instead of continuing unfiltered. */
  required: boolean;
}

const DELIVERY_FACETS: Record<DeliveryFilter, DeliveryFacet> = {
  // Standard / international runs worked before any filtering existed, so
  // this one warns rather than throws — a missing facet must not turn a
  // currently-green section red.
  'available-online': { label: 'Available Online', re: /available\s*online/i, required: false },
  // Express and CNC genuinely depend on product eligibility: without the
  // facet the checkout won't offer the method at all, so a failure here
  // must surface (the caller then retries with a fresh search term).
  'express-delivery': { label: 'Express delivery', re: /express\s*delivery(\s*available)?/i, required: true },
  'click-and-collect': {
    label: 'Click & Collect',
    re: /click\s*(&|and)\s*collect/i,
    required: true,
  },
};

export interface SearchAddOptions {
  /** Which PLP delivery facet to apply before picking a product, so the
   *  product supports the shipping method the test will select at
   *  checkout. Omit to search unfiltered. */
  deliveryFilter?: DeliveryFilter;
}

/**
 * Attempts up to `maxAttempts` random searches; if a picked product turns
 * out to be out-of-stock (or no product on the PLP survives the requested
 * delivery facet), retries with a fresh search term.
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

  if (opts.deliveryFilter) {
    await applyDeliveryFilter(page, log, waitForOverlay, opts.deliveryFilter);
  }

  // KWH product detail pages live at `/product/<slug>` (singular).
  // `/brands/…` are brand category listings, not products.
  const allProductLinks = page.locator('a[href*="/product/"]');
  const totalCount = await allProductLinks.count();
  log(`STEP 4/6 · ${totalCount} link(s) match a[href*="/product/"]`);
  if (opts.deliveryFilter && totalCount === 0) {
    throw new Error(
      `No products left after applying the "${DELIVERY_FACETS[opts.deliveryFilter].label}" ` +
        `filter to a search for "${term}"`,
    );
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
 * Clicks one of the three PLP delivery facets so every subsequent product
 * pick is guaranteed to support the shipping method the test will choose
 * at checkout. Confirms the facet really engaged before returning — a
 * blind click here is how an ineligible product reached the cart and made
 * the Express run fall back to Standard shipping.
 */
async function applyDeliveryFilter(
  page: Page,
  log: Logger,
  waitForOverlay: WaitForLoadingOverlay,
  which: DeliveryFilter,
): Promise<void> {
  const facet = DELIVERY_FACETS[which];
  log(`  → applying "${facet.label}" PLP filter`);

  const fail = (msg: string): void => {
    if (facet.required) throw new Error(msg);
    log(`  ! ${msg} — continuing unfiltered (facet is advisory for this shipping method)`);
  };

  // KWH renders the facets in both a desktop sidebar AND a hidden mobile
  // drawer; a raw `.first()` picks the drawer copy and fails on click.
  // Scope to the visible one, and require it to OWN a checkbox — product
  // cards carry the same wording as a badge, and matching an <a> there
  // navigated to the product page instead of filtering the list.
  const facetControl = 'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]';
  const filter = page
    .locator('label, button, [role="button"], [role="checkbox"]')
    .filter({ hasText: facet.re })
    .filter({ has: page.locator(facetControl) })
    .filter({ visible: true })
    .first();
  if (!(await filter.count().catch(() => 0))) {
    fail(`No "${facet.label}" filter facet on the results page`);
    return;
  }
  await filter.scrollIntoViewIfNeeded().catch(() => undefined);

  // Snapshot the current result set so we can tell the PLP really
  // re-queried rather than the click landing on a dead wrapper.
  const urlBefore = page.url();
  const countBefore = await page.locator('a[href*="/product/"]').count().catch(() => 0);

  await filter.click();
  await waitForOverlay();

  // Confirm the facet actually engaged. Accept any one of: its control
  // reporting checked, the URL gaining facet state, or the result count
  // changing.
  const input = filter.locator(facetControl).first();
  const applied = await page
    .waitForFunction(
      ({ before, prevUrl, pattern }: { before: number; prevUrl: string; pattern: string }) => {
        const re = new RegExp(pattern, 'i');
        const boxes = Array.from(
          document.querySelectorAll('input[type="checkbox"], input[type="radio"]'),
        ) as HTMLInputElement[];
        const facetChecked = boxes.some((b) => {
          const name = b.closest('label')?.textContent || b.getAttribute('aria-label') || '';
          return re.test(name) && b.checked;
        });
        const urlChanged = window.location.href !== prevUrl;
        const countChanged = document.querySelectorAll('a[href*="/product/"]').length !== before;
        return facetChecked || urlChanged || countChanged;
      },
      { before: countBefore, prevUrl: urlBefore, pattern: facet.re.source },
      { timeout: 10_000, polling: 300 },
    )
    .then(() => true)
    .catch(() => false);

  if (!applied) {
    fail(
      `Clicked the "${facet.label}" facet but the results did not change — the filter ` +
        `never applied, so the picked product may not support the requested shipping method`,
    );
    return;
  }
  const checkedNow = await input.isChecked().catch(() => false);
  log(`  ✓ "${facet.label}" filter applied (facet checked: ${checkedNow})`);
}
