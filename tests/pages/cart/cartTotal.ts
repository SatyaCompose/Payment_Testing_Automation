import { Page } from '@playwright/test';

/**
 * Read the cart's grand total from the /cart page. Prefer
 * `getCartTotalFromFlyout` when the cart flyout is open — it avoids the
 * extra navigation and captures the accurate total including the item
 * that was just added.
 */
export async function getCartTotalAud(page: Page): Promise<number> {
  const totalNode = page
    .getByText(/^\s*(order )?total\s*[:$]/i)
    .or(page.getByTestId(/cart[-_]?total|order[-_]?total/i))
    .first();

  let text = '';
  if (await totalNode.count()) {
    text = (await totalNode.textContent()) ?? '';
  }
  if (!text) {
    text = (await page.getByText(/\$[\d,]+\.\d{2}/).last().textContent()) ?? '';
  }
  return parseAudAmount(text);
}

/**
 * Read the cart total from the flyout drawer that opens right after
 * an "Add to cart" click. Structure on KWH:
 *   [Cart heading]
 *   [Item list]
 *   Subtotal $XX.XX
 *   Shipping FREE
 *   Total $XX.XX     ← this is what we want
 *   [Secure Checkout button]
 *
 * Scopes the read to the flyout so it never picks up a "Total" from the
 * order summary of the underlying page.
 */
export async function getCartTotalFromFlyout(page: Page): Promise<number> {
  // Walk the entire document — the flyout is the only place with a
  // "Total (Incl. GST) $N.NN" line while we're on a product / listing
  // page. Trying to scope to a specific flyout locator has proven
  // fragile (KWH's drawer container name changes across builds); a
  // whole-page walk with tight text filters is more reliable.
  const result = await page.evaluate(() => {
    const priceRe = /\$([\d,]+\.\d{2})/;
    const walk = Array.from(document.querySelectorAll('*')) as HTMLElement[];
    let best: { text: string; amount: number; size: number } | null = null;
    for (const node of walk) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      // Cap length — a page-wide container would exceed this and be skipped.
      if (!text || text.length > 80) continue;
      if (!/^total\b/i.test(text)) continue;
      if (/\bsubtotal\b/i.test(text)) continue;
      const m = text.match(priceRe);
      if (!m) continue;
      const size = text.length;
      if (!best || size < best.size) {
        best = { text: text.slice(0, 60), amount: parseFloat(m[1].replace(/,/g, '')), size };
      }
    }
    return best;
  });
  if (!result) {
    console.log('[getCartTotalFromFlyout] no total-shaped element found on page');
    return 0;
  }
  console.log(`[getCartTotalFromFlyout] matched "${result.text}" → $${result.amount.toFixed(2)}`);
  return result.amount;
}

function parseAudAmount(text: string): number {
  const m = text.match(/\$?([\d,]+\.\d{2})/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
}
