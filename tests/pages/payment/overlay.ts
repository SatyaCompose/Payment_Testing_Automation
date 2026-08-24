import type { Page } from '@playwright/test';
import type { Logger } from './methodSelector';

/**
 * On the KWH payment step, Google's `.gpay-button` renders at the exact same
 * rect as `[data-testid="place-order-btn"]` — regardless of which payment
 * method is selected. Whichever element is on top receives the click, and the
 * app only clears the overlay's pointer events once GPay finishes wiring up.
 *
 * When GPay is on top, a real mouse click aimed at Place order silently lands
 * on Google's element: Playwright reports a successful click and nothing
 * happens, which callers previously only recovered from via a DOM-level
 * fallback click.
 *
 * Neutralises the overlay's pointer events — it is never removed, and the app
 * sets the same property itself in the opposite case. Returns a description of
 * whatever sits at the click point afterwards, for the caller to log.
 */
export async function clearGpayOverlayIfIntercepting(page: Page, log: Logger): Promise<string> {
  const describeTopAtPlaceOrder = async (): Promise<string> =>
    page
      .evaluate(() => {
        const target = document.querySelector('[data-testid="place-order-btn"]');
        if (!target) return 'no-place-order-btn';
        const r = target.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!top) return 'nothing-at-point';
        return `${top.tagName.toLowerCase()}.${(top.getAttribute('class') || '').slice(0, 60)}`;
      })
      .catch(() => 'evaluate-failed');

  const before = await describeTopAtPlaceOrder();
  if (!/gpay-button/.test(before)) return before;

  log(`  · Google Pay overlay is intercepting Place order (${before}) — disabling its pointer events`);
  await page
    .evaluate(() => {
      const selectors = ['.gpay-button.buy', '[class*="gpay-button-container"]'];
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          (el as HTMLElement).style.pointerEvents = 'none';
        });
      }
    })
    .catch(() => undefined);

  const after = await describeTopAtPlaceOrder();
  log(`  · click point now resolves to ${after}`);
  return after;
}
