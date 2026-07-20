import { Page } from '@playwright/test';
import type { ShippingMethod } from '../../fixtures/testData';

/** Display text on each shipping-method card. */
export const shippingMethodLabel: Record<ShippingMethod, string> = {
  standard: 'Standard shipping',
  express: 'Express shipping',
  international: 'International shipping',
  cnc: 'Click and Collect',
};

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every method's label except the target — used to exclude parent
 *  wrappers when matching a specific card. */
export function otherMethodLabels(method: ShippingMethod): string[] {
  return Object.entries(shippingMethodLabel)
    .filter(([m]) => m !== method)
    .map(([, t]) => t);
}

/**
 * Returns the subset of other-method labels currently rendered anywhere
 * on the page. Empty result → the target is the only method offered.
 */
export async function visibleOtherLabels(page: Page, others: string[]): Promise<string[]> {
  return page.evaluate(
    (labels) => {
      const text = (document.body.innerText || '').toLowerCase();
      return labels.filter((l) => text.includes(l.toLowerCase()));
    },
    others,
  );
}

/**
 * Reads which shipping-method card is currently marked selected by
 * scanning aria-checked / data-selected / class~=selected / a checkmark
 * SVG. Returns the trimmed text of that card (up to 60 chars) or an
 * empty string if none appears selected.
 */
export async function readCurrentlySelectedCardText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], [role="radio"], [tabindex], label'),
    );
    const hit = candidates.find((c) => {
      return (
        c.getAttribute('aria-checked') === 'true' ||
        c.getAttribute('data-selected') !== null ||
        /(^|\s)selected(\s|$)/i.test(c.getAttribute('class') || '') ||
        c.querySelector('svg[data-selected], svg[aria-label*="check" i]') !== null
      );
    });
    return (hit?.textContent || '').trim().slice(0, 60);
  });
}

export interface SelectionVerdict {
  ok: boolean;
  selectedText: string;
  reason: string;
}

/**
 * Strict DOM inspection: is the currently-selected card (aria-checked /
 * class~=selected / etc.) the target method, and NOT one of the other
 * labels? Falls back to "implicitly selected" when only the target is
 * on the page.
 */
export async function verifyShippingSelection(
  page: Page,
  targetText: string,
  otherLabels: string[],
): Promise<SelectionVerdict> {
  return page.evaluate(
    ({ targetText, otherLabels }) => {
      const bodyText = (document.body.innerText || '').toLowerCase();
      const othersOnPage = otherLabels.filter((l) => bodyText.includes(l.toLowerCase()));
      if (othersOnPage.length === 0 && bodyText.includes(targetText.toLowerCase())) {
        return {
          ok: true,
          selectedText: targetText,
          reason: 'only target method visible — implicitly selected',
        };
      }

      const candidates = Array.from(
        document.querySelectorAll(
          'button, [role="button"], [role="radio"], label, [tabindex], div, li, article',
        ),
      ) as HTMLElement[];
      const selected = candidates.find((c) => {
        if (c.getAttribute('aria-checked') === 'true') return true;
        if (c.getAttribute('data-selected') !== null) return true;
        const cls = c.getAttribute('class') || '';
        if (/(^|\s)selected(\s|$)/i.test(cls)) return true;
        if (
          c.querySelector(
            'svg[data-selected], svg[aria-label*="check" i], [aria-checked="true"]',
          )
        )
          return true;
        return false;
      });
      if (!selected) {
        return { ok: false, selectedText: '(none)', reason: 'no selected indicator on any card' };
      }
      const text = (selected.textContent || '').trim();
      const hasTarget = text.toLowerCase().includes(targetText.toLowerCase());
      const hasOther = otherLabels.some((o) => text.toLowerCase().includes(o.toLowerCase()));
      const ok = hasTarget && !hasOther;
      return {
        ok,
        selectedText: text.slice(0, 80).replace(/\s+/g, ' '),
        reason: ok ? 'ok' : `selected card text mismatch`,
      };
    },
    { targetText, otherLabels },
  );
}
