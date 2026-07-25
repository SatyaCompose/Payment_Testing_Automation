import { Page } from '@playwright/test';
import type { Logger } from './ageRestriction';

/**
 * Insider ("useinsider.com") injects a marketing overlay on KWH staging
 * ("Get $20 off*" email-capture dialog). The overlay's backdrop
 * (`#ins-frameless-overlay`) intercepts pointer events and blocks
 * product-card clicks even when the underlying element is visible.
 *
 * The overlay is lazy — a one-off probe right after `goto()` usually
 * misses it because it renders on a scroll/timer trigger. We fight it
 * two ways:
 *
 *   1. `installInsiderKiller(page)` — attaches a MutationObserver via
 *      `page.addInitScript` that removes every Insider node the moment
 *      it's appended, on every future navigation. Idempotent per Page.
 *   2. `dismissInsiderOverlay(page, log)` — imperative fallback that
 *      tries the close cross, then removes the DOM if the cross fails.
 */

const KILLER_INSTALLED = new WeakSet<Page>();

const INSIDER_SELECTORS = '.ins-preview-wrapper, #ins-frameless-overlay, [class*="ins-preview"], [id^="ins-"], [class*="ins-notification"]';

export async function installInsiderKiller(page: Page): Promise<void> {
  if (KILLER_INSTALLED.has(page)) return;
  KILLER_INSTALLED.add(page);

  await page.addInitScript((selectors: string) => {
    const nuke = () => {
      document.querySelectorAll(selectors).forEach((el) => el.remove());
      if (document.body) document.body.style.overflow = '';
    };
    const startObserving = () => {
      nuke();
      const observer = new MutationObserver(nuke);
      observer.observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) {
      startObserving();
    } else {
      document.addEventListener('DOMContentLoaded', startObserving, { once: true });
    }
  }, INSIDER_SELECTORS);
}

export async function dismissInsiderOverlay(page: Page, log: Logger): Promise<void> {
  const overlay = page.locator('.ins-preview-wrapper, #ins-frameless-overlay').first();
  if (!(await overlay.isVisible({ timeout: 300 }).catch(() => false))) return;

  log('  → Insider marketing overlay detected — attempting close');

  const closeCandidates = [
    page.locator('.ins-preview-wrapper [class*="close" i]').first(),
    page.locator('.ins-preview-wrapper [aria-label*="close" i]').first(),
    page.locator('.ins-preview-wrapper button:has(svg)').first(),
    page.getByRole('button', { name: /close/i }).first(),
    page.locator('[class*="ins-close" i], [id*="ins-close" i]').first(),
  ];

  for (const btn of closeCandidates) {
    if (!(await btn.isVisible({ timeout: 400 }).catch(() => false))) continue;
    try {
      await btn.click({ force: true, timeout: 2_000 });
      if (!(await overlay.isVisible({ timeout: 500 }).catch(() => false))) {
        log('  ✓ Insider overlay closed via cross icon');
        return;
      }
    } catch {
      // fall through to next candidate
    }
  }

  log('  · cross-icon click did not clear it — removing overlay nodes from DOM');
  await page
    .evaluate((selectors) => {
      document.querySelectorAll(selectors).forEach((el) => el.remove());
      document.body.style.overflow = '';
    }, INSIDER_SELECTORS)
    .catch(() => undefined);
}
