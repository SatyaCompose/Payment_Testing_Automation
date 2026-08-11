import { Page } from '@playwright/test';
import type { ShippingMethod } from '../../fixtures/testData';

/** Display text on each shipping-method card. */
export const shippingMethodLabel: Record<ShippingMethod, string> = {
  standard: 'Standard shipping',
  express: 'Express shipping',
  international: 'International shipping',
  cnc: 'Click and Collect',
};

/**
 * Substring alternatives that KWH sometimes uses instead of the canonical
 * label. Used for locating cards / verifying selection. Kept lowercase +
 * escaped-free so callers wrap them in a case-insensitive alternation.
 *
 * The international card in particular has been observed rendered as
 * "International delivery", "New Zealand delivery", "Singapore delivery",
 * and "Standard International" across country/product combinations.
 * Always accept the canonical form first; extras are fallbacks.
 */
export const shippingMethodAliases: Record<ShippingMethod, string[]> = {
  standard: ['Standard shipping', 'Standard delivery'],
  express: ['Express shipping', 'Express delivery', 'Express Post'],
  international: [
    'International shipping',
    'International delivery',
    'International Post',
    'New Zealand delivery',
    'Singapore delivery',
    'Standard International',
  ],
  cnc: ['Click and Collect', 'Click & Collect', 'Pickup in store'],
};

export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a case-insensitive regex that matches ANY known alias for the
 * given method. This is what locators + text-node checks should use —
 * `shippingMethodLabel` is only for logging.
 */
export function shippingMethodTargetRe(method: ShippingMethod): RegExp {
  const alternation = shippingMethodAliases[method].map(escapeRegex).join('|');
  return new RegExp(alternation, 'i');
}

/**
 * Build a case-insensitive regex matching aliases of every method
 * EXCEPT the target — for use as `hasNotText` filters that exclude
 * wrapper elements containing multiple method labels.
 */
export function shippingOtherMethodsRe(method: ShippingMethod): RegExp {
  const others = (Object.keys(shippingMethodAliases) as ShippingMethod[])
    .filter((m) => m !== method)
    .flatMap((m) => shippingMethodAliases[m])
    .map(escapeRegex)
    .join('|');
  return new RegExp(others, 'i');
}

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
  // Feed all aliases into the DOM scanner so labels like "New Zealand
  // delivery" or "Express Post" are recognised as shipping-method
  // cards, not skipped.
  const allAliases = (Object.values(shippingMethodAliases) as string[][]).flat();
  return page.evaluate((aliases: string[]) => {
    const methodRe = new RegExp(aliases.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
    const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[];
    const selected = labels.find(
      (l) =>
        methodRe.test((l.textContent || '')) &&
        !!l.querySelector('input[type="checkbox"]:checked'),
    );
    return (selected?.textContent || '').trim().slice(0, 60);
  }, allAliases);
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
  targetAliases: string[] = [targetText],
): Promise<SelectionVerdict> {
  const allAliases = (Object.values(shippingMethodAliases) as string[][]).flat();
  return page.evaluate(
    ({ targetText, otherLabels, targetAliases, allAliases }) => {
      const bodyText = (document.body.innerText || '').toLowerCase();
      const othersOnPage = otherLabels.filter((l) => bodyText.includes(l.toLowerCase()));
      const targetOnPage = targetAliases.some((a) => bodyText.includes(a.toLowerCase()));
      if (othersOnPage.length === 0 && targetOnPage) {
        return {
          ok: true,
          selectedText: targetText,
          reason: 'only target method visible — implicitly selected',
        };
      }

      // KWH shipping cards are <label>-wrapped sr-only checkboxes. The
      // reliable "is selected" signal is a :checked input inside a label
      // whose text contains a shipping-method name (any alias).
      const methodRe = new RegExp(
        allAliases.map((s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
        'i',
      );
      const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[];
      const shippingLabels = labels.filter((l) => methodRe.test(l.textContent || ''));
      const checkedLabels = shippingLabels.filter(
        (l) => !!l.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked'),
      );
      // Desync guard: KWH treats shipping options as a radio group, so
      // exactly one label may be :checked. If two are checked at once,
      // the second one was set by a synthetic dispatch that bypassed
      // React's onChange — the DOM lies but the server-side state is
      // still whatever KWH thought was selected first. Fail loudly.
      if (checkedLabels.length > 1) {
        const names = checkedLabels
          .map((l) => (l.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40))
          .join(' | ');
        return {
          ok: false,
          selectedText: `(multi: ${names})`,
          reason: `${checkedLabels.length} shipping-method labels report :checked simultaneously — likely a synthetic-dispatch desync`,
        };
      }
      const selected = checkedLabels[0];
      if (!selected) {
        return {
          ok: false,
          selectedText: '(none)',
          reason: 'no shipping-method label wraps a :checked input',
        };
      }
      const text = (selected.textContent || '').trim();
      const lowerText = text.toLowerCase();
      const hasTarget = targetAliases.some((a) => lowerText.includes(a.toLowerCase()));
      const hasOther = otherLabels.some((o) => lowerText.includes(o.toLowerCase()));
      const ok = hasTarget && !hasOther;
      return {
        ok,
        selectedText: text.slice(0, 80).replace(/\s+/g, ' '),
        reason: ok ? 'ok' : `selected card text mismatch`,
      };
    },
    { targetText, otherLabels, targetAliases, allAliases },
  );
}
