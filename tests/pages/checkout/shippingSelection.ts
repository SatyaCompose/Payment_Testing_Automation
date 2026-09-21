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
  // 'Express Post' was removed deliberately. KWH product descriptions
  // carry marketing copy like "Ships within 1 business day. Express Post
  // available." — with that alias in the list, `shippingMethodTargetRe`
  // matched the product blurb, the card-click path clicked a plain text
  // node, and section 2 orders shipped as Standard while the suite
  // reported a pass (observed on 2.2: payment step read
  // "Standard shipping - $9.90"). Aliases here must only ever be real
  // card names, never phrases that can appear in body copy.
  express: ['Express shipping', 'Express delivery'],
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

export interface ShippingCard {
  /** Trimmed accessible text of the card (max 120 chars). */
  text: string;
  checked: boolean;
}

/**
 * Enumerates the actual shipping-method CONTROLS on the page — i.e. a
 * checkbox/radio (native or ARIA) whose accessible name matches a known
 * method alias. Deliberately does NOT read `document.body.innerText`:
 * product descriptions, order-summary lines and promo banners all
 * mention delivery wording, and scanning body text is what let the
 * Express run mistake a product blurb for a shipping card.
 */
export async function readShippingCards(page: Page): Promise<ShippingCard[]> {
  const allAliases = (Object.values(shippingMethodAliases) as string[][]).flat();
  return page.evaluate((aliases: string[]) => {
    const methodRe = new RegExp(
      aliases.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'i',
    );
    const controls = Array.from(
      document.querySelectorAll(
        'input[type="checkbox"], input[type="radio"], [role="radio"], [role="checkbox"]',
      ),
    ) as HTMLElement[];

    const nameFor = (el: HTMLElement): string => {
      const wrapping = el.closest('label');
      if (wrapping?.textContent && methodRe.test(wrapping.textContent)) return wrapping.textContent;
      const aria = el.getAttribute('aria-label');
      if (aria && methodRe.test(aria)) return aria;
      if (el.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (forLabel?.textContent && methodRe.test(forLabel.textContent)) return forLabel.textContent;
      }
      // Nearest small ancestor that names a method — bounded text length
      // so a whole step wrapper can't masquerade as one card.
      let node: HTMLElement | null = el.parentElement;
      for (let hops = 0; node && hops < 5; hops += 1, node = node.parentElement) {
        const t = node.textContent || '';
        if (t.length < 200 && methodRe.test(t)) return t;
      }
      return '';
    };

    const seen = new Set<string>();
    const cards: { text: string; checked: boolean }[] = [];
    for (const el of controls) {
      const name = nameFor(el).trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const checked =
        (el as HTMLInputElement).checked === true || el.getAttribute('aria-checked') === 'true';
      cards.push({ text: name, checked });
    }
    return cards;
  }, allAliases);
}

/**
 * Returns the subset of other-method labels that are rendered as real
 * shipping-method CONTROLS. Empty result → the target is the only method
 * offered (common for international destinations).
 */
export async function visibleOtherLabels(page: Page, others: string[]): Promise<string[]> {
  const cards = await readShippingCards(page);
  const cardText = cards.map((c) => c.text.toLowerCase());
  return others.filter((l) => cardText.some((t) => t.includes(l.toLowerCase())));
}

/**
 * Reads the shipping method the checkout has actually COMMITTED, as
 * rendered in the collapsed Shipping summary on the payment step
 * (e.g. "Standard shipping - $9.90"). Returns an empty string when no
 * such line is rendered.
 */
export async function readCommittedShippingMethod(page: Page): Promise<string> {
  const allAliases = (Object.values(shippingMethodAliases) as string[][]).flat();
  return page.evaluate((aliases: string[]) => {
    const methodRe = new RegExp(
      aliases.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'i',
    );
    // Leaf-ish nodes only: the summary line is a short standalone element,
    // never a wrapper that also contains the address block.
    const candidates = Array.from(document.querySelectorAll('div, span, p, li, dd, strong'))
      .filter((el) => {
        const t = (el.textContent || '').trim();
        if (!t || t.length > 80 || !methodRe.test(t)) return false;
        return !Array.from(el.children).some((c) => methodRe.test((c.textContent || '').trim()));
      })
      .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '));
    // Prefer a line that also carries a price or "free" — that is the
    // committed summary rather than a heading.
    const priced = candidates.find((t) => /\$\s?[\d,.]+|\bfree\b/i.test(t));
    return (priced || candidates[0] || '').slice(0, 80);
  }, allAliases);
}

/**
 * Classifies a rendered shipping line back to a ShippingMethod, or null
 * when it matches none / is ambiguous.
 */
export function classifyShippingText(text: string): ShippingMethod | null {
  const lower = text.toLowerCase();
  const hits = (Object.keys(shippingMethodAliases) as ShippingMethod[]).filter((m) =>
    shippingMethodAliases[m].some((a) => lower.includes(a.toLowerCase())),
  );
  return hits.length === 1 ? hits[0] : null;
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
      const checkedNames = shippingLabels
        .filter((l) => !!l.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked'))
        .map((l) => (l.textContent || '').trim());

      // Not every revision wraps the input in a <label>: some render a bare
      // checkbox named by aria-label or label[for]. Reading only wrapped
      // labels reported "(none)" on those pages even with a method checked.
      if (checkedNames.length === 0) {
        const inputs = Array.from(
          document.querySelectorAll('input[type="checkbox"]:checked, input[type="radio"]:checked'),
        ) as HTMLInputElement[];
        for (const input of inputs) {
          let name = input.getAttribute('aria-label') || '';
          if (!name && input.id) {
            const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
            name = forLabel?.textContent || '';
          }
          if (!name) {
            // Nearest small ancestor naming a shipping method.
            let node: HTMLElement | null = input.parentElement;
            for (let hops = 0; node && hops < 5; hops += 1, node = node.parentElement) {
              const t = node.textContent || '';
              if (methodRe.test(t) && t.length < 200) {
                name = t;
                break;
              }
            }
          }
          if (methodRe.test(name)) checkedNames.push(name.trim());
        }
      }

      const checkedLabels = checkedNames;
      // Desync guard: KWH treats shipping options as a radio group, so
      // exactly one label may be :checked. If two are checked at once,
      // the second one was set by a synthetic dispatch that bypassed
      // React's onChange — the DOM lies but the server-side state is
      // still whatever KWH thought was selected first. Fail loudly.
      if (checkedLabels.length > 1) {
        const names = checkedLabels
          .map((l) => l.replace(/\s+/g, ' ').slice(0, 40))
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
          reason: 'no shipping-method control reports :checked (label-wrapped or named)',
        };
      }
      const text = selected.trim();
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
