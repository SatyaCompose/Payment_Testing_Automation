import { Page, Locator, expect } from '@playwright/test';

/**
 * Common checkout / DOM utilities shared across page objects.
 * Extracted from CheckoutPage, PaymentPage, CartPage to keep those files
 * focused on flow-specific logic.
 */

/**
 * Waits until `document.body.innerText` matches the given regex.
 * Fires and forgets on timeout — callers get whatever's on the page.
 */
export async function waitForTextOnPage(
  page: Page,
  pattern: RegExp,
  timeout = 20_000,
): Promise<void> {
  await page
    .waitForFunction(
      (rx: string) => new RegExp(rx, 'i').test(document.body.innerText || ''),
      pattern.source,
      { timeout, polling: 500 },
    )
    .catch(() => undefined);
}

/**
 * Logs body-innerText lines matching `filter` (up to `max`) — useful for
 * diagnosing "which labels ARE on the page?" when a locator fails.
 */
export async function dumpTextSnippets(
  page: Page,
  filter: RegExp,
  max = 10,
): Promise<string[]> {
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
  return bodyText
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s && filter.test(s))
    .slice(0, max);
}

/**
 * Fires a `HTMLElement.click()` via evaluate — bypasses Playwright's
 * actionability checks (viewport, overlay, pointer-events, animation).
 * Use when a locator's native click is blocked by those guards.
 */
export async function domClick(locator: Locator): Promise<void> {
  await locator.evaluate((el: HTMLElement) => el.click());
}

/**
 * Tries `locator.click({ force: true })` first, falls back to a raw DOM
 * click via `evaluate`. Returns which strategy succeeded.
 */
export async function robustClick(locator: Locator, timeout = 5_000): Promise<'native' | 'js'> {
  try {
    await locator.click({ force: true, timeout });
    return 'native';
  } catch {
    await domClick(locator);
    return 'js';
  }
}

/**
 * "Truly visible" check inside an iframe — non-zero size, no display:none
 * or visibility:hidden, and not type=hidden.
 */
export async function isTrulyVisible(locator: Locator, minWidth = 1, minHeight = 1): Promise<boolean> {
  return locator
    .evaluate(
      (el, { minW, minH }) => {
        const inp = el as HTMLInputElement;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width >= minW &&
          rect.height >= minH &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          (inp.type ? inp.type !== 'hidden' : true)
        );
      },
      { minW: minWidth, minH: minHeight },
    )
    .catch(() => false);
}

/**
 * expect(locator).toBeVisible() with a short timeout, returning a boolean
 * instead of throwing. Convenient for optional detection.
 */
export async function isVisibleSoon(locator: Locator, timeout = 2_000): Promise<boolean> {
  return locator
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

/** Regex-escape a string so it can be embedded inside `new RegExp(...)`. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads the currently-visible country label from a checkout country
 * selector. Returns `null` if no country selector is present.
 */
export async function readCurrentCountry(page: Page): Promise<string | null> {
  const select = page.getByLabel(/country/i).first();
  if (!(await select.count().catch(() => 0))) return null;
  const v = ((await select.inputValue().catch(() => '')) ?? '').trim();
  if (v) return v;
  const selected = select.locator('option[selected], [aria-selected="true"]').first();
  return ((await selected.textContent().catch(() => null)) ?? '').trim() || null;
}
