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
    // KWH renders each shipping-method card as a <label> wrapping an
    // <input type="checkbox" class="sr-only">. The visible checkmark
    // badge is driven by whichever checkbox is :checked. That's the only
    // reliable selection marker on the page.
    const methodRe = /standard shipping|express shipping|international shipping|click.?and.?collect/i;
    const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[];
    const selected = labels.find(
      (l) =>
        methodRe.test((l.textContent || '')) &&
        !!l.querySelector('input[type="checkbox"]:checked'),
    );
    return (selected?.textContent || '').trim().slice(0, 60);
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

      // KWH shipping cards are <label>-wrapped sr-only checkboxes. The
      // reliable "is selected" signal is a :checked input inside a label
      // whose text contains a shipping-method name.
      const methodRe = /standard shipping|express shipping|international shipping|click.?and.?collect/i;
      const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[];
      const shippingLabels = labels.filter((l) => methodRe.test(l.textContent || ''));
      const selected = shippingLabels.find(
        (l) => !!l.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked'),
      );
      if (!selected) {
        return {
          ok: false,
          selectedText: '(none)',
          reason: 'no shipping-method label wraps a :checked input',
        };
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
