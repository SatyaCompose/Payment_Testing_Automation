import { Page, expect } from '@playwright/test';
import type { Logger } from './methodSelector';
import {
  findRealInputInIframe,
  readIframeLabels,
  readIframeMeta,
  readInlineInputs,
  typeIntoIframeInput,
} from './cybersourceInputs';

export interface CardDetails {
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
}

export async function fillCreditCard(page: Page, log: Logger, card: CardDetails): Promise<void> {
  log('step 3 · fillCreditCard');
  const expiry = `${card.expiryMonth.padStart(2, '0')}/${card.expiryYear.slice(-2)}`;

  // Wait for the CC section to be ready — either an inline card number
  // input appears, OR a Cybersource iframe attaches. Either satisfies
  // us; whichever fires first ends the wait. Bounded 15s, still faster
  // than the old fixed 2.5s in the common case (usually resolves in
  // 300–800ms) and doesn't hang past 15s on a slow render.
  await page
    .waitForFunction(
      () => {
        const inlineCcInput =
          !!document.querySelector('input[autocomplete="cc-number"], input[autocomplete^="cc-exp"], input[autocomplete="cc-csc"]');
        const csIframe = Array.from(document.querySelectorAll('iframe')).some((f) =>
          /cybersource|microform|flex/i.test((f as HTMLIFrameElement).src || (f as HTMLIFrameElement).title || ''),
        );
        return inlineCcInput || csIframe;
      },
      undefined,
      { timeout: 15_000, polling: 200 },
    )
    .catch(() => undefined);

  // 0. Inline path — try to find real text inputs on the page directly
  //    (Cybersource Microform can be embedded inline via autocomplete
  //    attributes; only Secure Acceptance uses iframes).
  const inlineInputs = await readInlineInputs(page);
  log(
    `  visible text/tel inputs (${inlineInputs.length}): ${inlineInputs
      .map((i) => `[${i.labelText || i.ariaLabel || i.placeholder || i.name || '?'} ac=${i.autocomplete}]`)
      .join(' ')}`,
  );

  const inlineNumber = page
    .locator('input[autocomplete="cc-number"]')
    .or(page.getByRole('textbox', { name: /card number/i }))
    .first();
  const inlineExpiry = page
    .locator('input[autocomplete^="cc-exp"]')
    .or(page.getByRole('textbox', { name: /expir/i }))
    .first();
  const inlineCvv = page
    .locator('input[autocomplete="cc-csc"]')
    .or(page.getByRole('textbox', { name: /cvv|cvc|security/i }))
    .first();

  const numberOk = (await inlineNumber.count().catch(() => 0)) > 0;
  const expiryOk = (await inlineExpiry.count().catch(() => 0)) > 0;
  const cvvOk = (await inlineCvv.count().catch(() => 0)) > 0;
  if (numberOk && expiryOk && cvvOk) {
    log('  → inline card inputs found — filling directly');
    await inlineNumber.fill(card.number);
    await inlineExpiry.fill(expiry);
    await inlineCvv.fill(card.cvv);
    return;
  }
  log(
    `  · inline detection incomplete: number=${numberOk} expiry=${expiryOk} cvv=${cvvOk} — falling back to iframe iteration`,
  );

  // 1. Wait for at least 3 card-related iframes (Cybersource Microform
  //    renders one per field). If only 2 attach, we still proceed and
  //    infer by position.
  await page
    .waitForFunction(
      () => {
        const frames = Array.from(document.querySelectorAll('iframe'));
        return frames.filter((f) => {
          const t = (f.getAttribute('title') || f.getAttribute('name') || f.getAttribute('src') || '').toLowerCase();
          return /card|cvv|cvc|expir|secure|microform|cybersource|payment/.test(t);
        }).length >= 3;
      },
      undefined,
      { timeout: 30_000, polling: 500 },
    )
    .catch(() => {
      log("  ! didn't reach 3 payment iframes within 30s — using whatever loaded");
    });

  // 2. Log every iframe on the page, then iterate them to fill card
  //    fields. The waitForFunction above already blocks until >=3
  //    payment iframes exist, so no extra fixed sleep is needed — the
  //    iframes have already hydrated by the time we reach this line.
  const iframeMeta = await readIframeMeta(page);
  for (const m of iframeMeta) {
    log(`  iframe #${m.idx}: title="${m.title}" name="${m.name}" id="${m.id}" src="${m.src}"`);
  }

  // 2. Label-based routing. Each Cybersource iframe is preceded on the
  //    parent page by a label ("Card number", "Expiration date (MM/YY)",
  //    "CVV"). Identify each iframe by that label, then fill its first
  //    truly-visible input with the corresponding value.
  //
  //    Some KWH configurations put Expiration inline (as a normal
  //    <input> on the parent page) rather than in an iframe — handle
  //    that too.
  const cybersourceIframes: number[] = [];
  for (let i = 0; i < iframeMeta.length; i++) {
    const m = iframeMeta[i];
    const desc = `${m.title} ${m.name} ${m.id} ${m.src}`.toLowerCase();
    if (/secure\s*payment\s*field|cybersource|microform/.test(desc)) {
      cybersourceIframes.push(i);
    }
  }
  log(`  Cybersource iframes at indices: [${cybersourceIframes.join(', ')}]`);

  const iframeLabels = await readIframeLabels(page, cybersourceIframes);
  for (const { idx, label } of iframeLabels) {
    log(`    · iframe #${idx} label: "${label.slice(0, 60)}"`);
  }

  const findByLabel = (rx: RegExp) => iframeLabels.find((x) => rx.test(x.label))?.idx ?? -1;
  const numberIdx = findByLabel(/card\s*number|cardnumber|pan/i);
  const expiryIdx = findByLabel(/expir|exp\s*date|mm\s*\/\s*yy/i);
  const cvvIdx = findByLabel(/cvv|cvc|security|csc/i);
  log(`  routed: number=iframe#${numberIdx}  expiry=iframe#${expiryIdx}  cvv=iframe#${cvvIdx}`);

  if (numberIdx >= 0) {
    const inp = await findRealInputInIframe(page, numberIdx);
    if (!inp) throw new Error(`Card number iframe #${numberIdx} has no real input`);
    log('  → typing CARD NUMBER');
    await typeIntoIframeInput(inp, card.number);
  } else {
    throw new Error('Could not find a Cybersource iframe labelled Card number');
  }

  // Expiry: inline first, else iframe.
  if ((await inlineExpiry.count().catch(() => 0)) > 0) {
    log('  → filling EXPIRY (inline on parent page)');
    await inlineExpiry.fill(expiry);
  } else if (expiryIdx >= 0) {
    const inp = await findRealInputInIframe(page, expiryIdx);
    if (!inp) throw new Error(`Expiry iframe #${expiryIdx} has no real input`);
    log('  → typing EXPIRY (iframe)');
    await typeIntoIframeInput(inp, expiry);
  } else {
    throw new Error('Could not find an Expiry input (inline or iframe)');
  }

  if (cvvIdx >= 0) {
    const inp = await findRealInputInIframe(page, cvvIdx);
    if (!inp) throw new Error(`CVV iframe #${cvvIdx} has no real input`);
    log('  → typing CVV');
    await typeIntoIframeInput(inp, card.cvv);
  } else if ((await inlineCvv.count().catch(() => 0)) > 0) {
    log('  → filling CVV (inline on parent page)');
    await inlineCvv.fill(card.cvv);
  } else {
    throw new Error('Could not find a CVV input (inline or iframe)');
  }

  log('  ✓ card number, expiry, cvv all typed');
}

export async function submitCreditCard(page: Page, log: Logger): Promise<void> {
  log('step 3 · submitCreditCard (Place order / Proceed to checkout)');
  const buttonNameRe =
    /place\s*order|complete\s*(order|purchase|payment)|pay\s*now|proceed\s*(to\s*)?checkout|submit\s*payment|confirm\s*(order|payment)|^pay$/i;
  // Role-based primary — matches only real buttons with the accessible
  // name, never a wrapper element that happens to contain the phrase.
  const btn = page
    .getByRole('button', { name: buttonNameRe })
    .or(page.locator('button[type="submit"]').filter({ hasText: buttonNameRe }))
    .first();

  try {
    await btn.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    const clickables = await page
      .locator('button, [role="button"], a, input[type="submit"]')
      .allTextContents()
      .catch(() => []);
    throw new Error(
      `No Place-order / Pay button visible after 20s. Clickables: ${clickables
        .slice(0, 15)
        .map((s) => s.trim())
        .filter((s) => s && s.length < 60)
        .join(' | ')}`,
    );
  }

  const label = ((await btn.textContent().catch(() => null)) ?? '').trim();

  // Cybersource tokenization on sandbox usually finishes in 1–3s. Cap
  // the wait at 12s — if it hasn't happened by then it isn't happening.
  log(`  → waiting for "${label}" to be enabled (post-tokenization)`);
  try {
    await expect(btn).toBeEnabled({ timeout: 12_000 });
  } catch {
    throw new Error(
      `"${label}" never became enabled within 12s — Cybersource likely didn't tokenize the card (bad number or events not fired).`,
    );
  }

  const meta = await btn
    .evaluate((el: Element) => ({
      tag: el.tagName,
      type: (el as HTMLInputElement).type ?? null,
      disabled: (el as HTMLButtonElement).disabled ?? false,
      className: (el.getAttribute('class') || '').slice(0, 80),
    }))
    .catch(() => null);
  log(`  → clicking "${label.slice(0, 40)}" meta=${JSON.stringify(meta)}`);
  await btn.scrollIntoViewIfNeeded().catch(() => undefined);

  // 1st attempt: real browser click.
  await btn.click({ force: true, timeout: 5_000 }).catch((err) => {
    log(`  · Playwright click failed: ${(err as Error).message?.split('\n')[0]}`);
  });
  if (await hasLeftCheckout(page, 4_000)) return;

  // 2nd attempt: JS-native click (bypasses portal / overlay interception).
  log('  · no navigation after first click — retrying with el.click() via evaluate');
  await btn.evaluate((el: HTMLElement) => el.click()).catch(() => undefined);
  if (await hasLeftCheckout(page, 8_000)) return;

  // 3rd attempt: dispatch a bubbling MouseEvent.
  log('  · still no navigation — dispatching MouseEvent');
  await btn
    .evaluate((el: HTMLElement) => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })
    .catch(() => undefined);
  if (await hasLeftCheckout(page, 8_000)) return;

  log('  ! all 3 click strategies fired but the checkout URL never advanced — payment likely still processing');
}

/**
 * Returns true if the page navigated away from /checkout OR a
 * confirmation / thank-you signal appeared, within `timeoutMs`.
 */
async function hasLeftCheckout(page: Page, timeoutMs: number): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const url = window.location.href;
        if (!/\/checkout(\?|$)/i.test(url)) return true;
        return /thank you for your order|order confirmed|order complete|order successfully|CT-\d+/i.test(
          document.body.innerText || '',
        );
      },
      undefined,
      { timeout: timeoutMs, polling: 400 },
    )
    .then(() => true)
    .catch(() => false);
}
