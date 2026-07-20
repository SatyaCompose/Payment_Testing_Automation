import { Page } from '@playwright/test';

export interface FilledInputSnapshot {
  label: string;
  value: string;
}

export interface AddressFormState {
  anyManualFilled: boolean;
  autocompleteVisible: boolean;
  inspected: string[];
}

/**
 * Enumerate every visible non-hidden, non-password input on the page and
 * return the ones with a value. Used to detect saved addresses / logged-in
 * prefill without depending on any specific field label.
 */
export async function enumerateFilledInputs(page: Page): Promise<FilledInputSnapshot[]> {
  return page
    .evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll('input:not([type="hidden"]):not([type="password"])'),
      ) as HTMLInputElement[];
      return nodes
        .filter((el) => {
          if (!el.value || !el.value.trim()) return false;
          // Skip inputs that are in the DOM but not actually rendered
          // (display:none, visibility:hidden, or zero-sized). This is
          // essential after tab-swaps like "Ship → Click & Collect"
          // where the delivery form's Address input keeps its saved
          // value but is no longer visible — treating it as "filled"
          // makes callers skip prompts for the newly-active section.
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return true;
        })
        .map((el) => {
          const label =
            (el.closest('label') as HTMLLabelElement | null)?.textContent?.trim() ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.name ||
            el.id ||
            '?';
          return { label: label.slice(0, 40), value: el.value.trim().slice(0, 120) };
        });
    })
    .catch(() => [] as FilledInputSnapshot[]);
}

/**
 * Read the address form's current shape: is an autocomplete search input
 * visible, and are any address-related manual fields already populated?
 * Label-agnostic — Singapore's form doesn't have a "Suburb" field, so a
 * label-based check would miss it.
 */
export async function readAddressFormState(page: Page): Promise<AddressFormState> {
  return page.evaluate(() => {
    const inputs = Array.from(
      document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'),
    ) as HTMLInputElement[];
    let anyManualFilled = false;
    let autocompleteVisible = false;
    const inspected: string[] = [];
    for (const i of inputs) {
      const rect = i.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const label =
        (i.closest('label')?.textContent || '') +
        ' ' +
        (i.getAttribute('aria-label') || '') +
        ' ' +
        (i.placeholder || '');
      const l = label.toLowerCase();
      if (/start typing|search (for )?address/.test(l)) {
        autocompleteVisible = true;
        continue;
      }
      // Any filled address-related field indicates manual mode.
      if (/address|suburb|city|town|postcode|postal|state|province/.test(l)) {
        if (i.value && i.value.trim()) {
          anyManualFilled = true;
          inspected.push(`${l.trim().slice(0, 30)}="${i.value.slice(0, 30)}"`);
        }
      }
    }
    return { anyManualFilled, autocompleteVisible, inspected };
  });
}
