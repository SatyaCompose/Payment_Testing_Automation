import { Page, Locator } from '@playwright/test';

export interface InlineInputMeta {
  name: string;
  id: string;
  type: string;
  placeholder: string;
  autocomplete: string;
  ariaLabel: string;
  labelText: string;
}

export interface IframeMeta {
  idx: number;
  title: string;
  name: string;
  id: string;
  src: string;
}

export interface IframeLabelHit {
  idx: number;
  label: string;
}

/** Snapshot every visible non-hidden/checkbox/radio input on the page. */
export async function readInlineInputs(page: Page): Promise<InlineInputMeta[]> {
  return page
    .evaluate(() => {
      const list = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
      return list
        .filter((el) => {
          const t = el.type;
          if (t === 'hidden' || t === 'checkbox' || t === 'radio') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((el) => ({
          name: el.name || '',
          id: el.id || '',
          type: el.type || '',
          placeholder: el.placeholder || '',
          autocomplete: el.autocomplete || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          labelText: (el.labels?.[0]?.textContent || '').trim().slice(0, 60),
        }));
    })
    .catch(() => [] as InlineInputMeta[]);
}

/** List every iframe on the page with its identifying attributes. */
export async function readIframeMeta(page: Page): Promise<IframeMeta[]> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).map((f, i) => ({
        idx: i,
        title: f.getAttribute('title') || '',
        name: f.getAttribute('name') || '',
        id: f.getAttribute('id') || '',
        src: (f.getAttribute('src') || '').slice(0, 120),
      })),
    )
    .catch(() => [] as IframeMeta[]);
}

/**
 * For each Cybersource iframe index, walk up the parent chain looking
 * for a nearby <label> or preceding-sibling text that identifies the
 * field ("Card number", "Expiration date (MM/YY)", "CVV").
 */
export async function readIframeLabels(page: Page, indices: number[]): Promise<IframeLabelHit[]> {
  return page.evaluate((indices: number[]) => {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    return indices.map((idx) => {
      const iframe = iframes[idx];
      if (!iframe) return { idx, label: '' };
      let el: HTMLElement | null = iframe.parentElement;
      let bestLabel = '';
      for (let hop = 0; hop < 6 && el && el !== document.body; hop++) {
        const labelEl = el.querySelector('label');
        if (labelEl && labelEl.textContent) {
          const t = labelEl.textContent.trim();
          if (t) {
            bestLabel = t;
            break;
          }
        }
        const prev = el.previousElementSibling;
        if (prev && prev.textContent) {
          const t = prev.textContent.trim();
          if (/card\s*number|expir|cvv|cvc|security/i.test(t)) {
            bestLabel = t;
            break;
          }
        }
        el = el.parentElement;
      }
      return { idx, label: bestLabel };
    });
  }, indices);
}

/**
 * Find the biggest (widest) visible input inside an iframe — Cybersource
 * Microform iframes have several helper inputs (1×1 tokens, form controls)
 * but only the real user-facing one has meaningful screen area.
 */
export async function findRealInputInIframe(
  page: Page,
  idx: number,
  timeoutMs = 15_000,
): Promise<Locator | null> {
  const frame = page.frameLocator('iframe').nth(idx);
  const inputs = frame.locator('input:not([type="hidden"])');
  // Cybersource attaches its iframe.html fast but the inner <input>
  // mounts asynchronously — an instant .count() often returns 0 while
  // the microform is still hydrating. Wait for the first input to
  // attach before iterating; without this, callers see "iframe has no
  // real input" on runs where the site just needed another 200-500 ms.
  await inputs
    .first()
    .waitFor({ state: 'attached', timeout: timeoutMs })
    .catch(() => undefined);
  const count = await inputs.count().catch(() => 0);
  let best: Locator | null = null;
  let bestWidth = 0;
  for (let k = 0; k < count; k++) {
    const inp = inputs.nth(k);
    const size = await inp
      .evaluate((el: HTMLInputElement) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || el.type === 'hidden') {
          return { w: 0, h: 0 };
        }
        return { w: rect.width, h: rect.height };
      })
      .catch(() => ({ w: 0, h: 0 }));
    if (size.w > 50 && size.h > 5 && size.w > bestWidth) {
      best = inp;
      bestWidth = size.w;
    }
  }
  return best;
}

/**
 * Cybersource inputs listen for real input events, not programmatic
 * .value assignment. Focus first, then type character-by-character.
 */
export async function typeIntoIframeInput(input: Locator, text: string): Promise<void> {
  await input.click({ force: true }).catch(() => undefined);
  await input.focus().catch(() => undefined);
  await input.pressSequentially(text, { delay: 30 });
}
