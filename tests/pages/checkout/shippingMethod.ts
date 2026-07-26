import { Page, expect } from '@playwright/test';
import type { ShippingMethod } from '../../fixtures/testData';
import type { Logger, WaitForLoadingOverlay } from './loginPromptFlow';
import {
  escapeRegex,
  otherMethodLabels,
  readCurrentlySelectedCardText,
  shippingMethodLabel,
  verifyShippingSelection,
  visibleOtherLabels,
} from './shippingSelection';

export async function selectShippingMethod(
  page: Page,
  log: Logger,
  method: ShippingMethod,
): Promise<void> {
  log(`step 2 · selectShippingMethod ${method}`);
  const target = shippingMethodLabel[method];
  // Unanchored — cards contain the label PLUS a description line, so
  // exact-match would filter them out. Substring is enough because the
  // "hasNotText" filter below rules out sibling / parent containers.
  const targetRe = new RegExp(escapeRegex(target), 'i');

  // Wait for the shipping section to render fully.
  await page
    .waitForFunction(
      () =>
        /standard shipping/i.test(document.body.innerText) &&
        /(express shipping|click.?and.?collect)/i.test(document.body.innerText),
      undefined,
      { timeout: 25_000, polling: 500 },
    )
    .catch(() => {
      log('  ! shipping section did not fully render — will still try');
    });

  // Special case: only ONE shipping method is offered (typical for
  // international destinations — "International shipping" is the only
  // option). No selection needed and no explicit "selected" indicator
  // will be rendered because there's nothing to switch between.
  const others = otherMethodLabels(method);
  const otherLabelsVisible = await visibleOtherLabels(page, others);
  if (otherLabelsVisible.length === 0) {
    const targetVisible = await page.getByText(targetRe).first().isVisible().catch(() => false);
    if (targetVisible) {
      log(`  → "${target}" is the only shipping method offered — nothing to click, treated as selected`);
      return;
    }
  }

  // Strategy 1 (preferred): a native or ARIA radio with the target
  // accessible name. KWH's shipping cards often wrap a hidden radio.
  const radio = page.getByRole('radio', { name: targetRe });
  const radioCount = await radio.count().catch(() => 0);
  log(`  · getByRole('radio', name~="${target}") count: ${radioCount}`);
  if (radioCount > 0) {
    const first = radio.first();
    const already = await first.isChecked().catch(() => false);
    if (already) {
      log(`  ✓ ${method} radio already checked`);
      return;
    }
    try {
      await first.check({ force: true, timeout: 5_000 });
      log(`  ✓ ${method} radio checked via check()`);
    } catch (err) {
      log(`  · radio.check() failed: ${(err as Error).message?.split('\n')[0]} — clicking label as fallback`);
      // Click the radio's associated label
      const labelForRadio = page.locator(`label`).filter({ hasText: targetRe }).first();
      if (await labelForRadio.count().catch(() => 0)) {
        await labelForRadio.click({ force: true });
      } else {
        await first.click({ force: true });
      }
    }
    // Playwright's toBeChecked auto-waits — no fixed sleep needed.
    const nowChecked = await first.isChecked().catch(() => false);
    if (nowChecked) {
      log(`  ✓ ${method} radio confirmed checked`);
      return;
    }
    log(`  · radio still not checked — falling through to card-click path`);
  }

  // Strategy 2: click the card container that contains the target text
  // but NOT the other methods' texts (excludes parent wrappers).
  const escapedOthers = others.map(escapeRegex);
  const notOtherRe = new RegExp(escapedOthers.join('|'), 'i');

  const card = page
    .locator(':is(button, [role="button"], [role="radio"], label, [tabindex="0"], div, li, article)')
    .filter({ hasText: targetRe })
    .filter({ hasNotText: notOtherRe });
  const cardCount = await card.count().catch(() => 0);
  log(`  · card candidates matching only "${target}": ${cardCount}`);

  let target_loc = cardCount > 0 ? card.last() : card.first();
  if (!(await target_loc.count().catch(() => 0))) {
    log(`  · no clean card container found — falling back to the text node`);
    target_loc = page.getByText(targetRe).first();
  }
  await expect(target_loc).toBeVisible({ timeout: 15_000 });
  await target_loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);

  // Log what we're about to click.
  const cardText = ((await target_loc.textContent().catch(() => null)) ?? '').trim().slice(0, 80);
  log(`  → clicking card: "${cardText.replace(/\s+/g, ' ')}"`);

  // Click via Playwright — force to bypass any transient overlay.
  await target_loc.click({ force: true, timeout: 8_000 }).catch((err) => {
    log(`  · click failed: ${err.message?.split('\n')[0]} — trying JS click`);
    return target_loc.evaluate((el: HTMLElement) => el.click());
  });
  await page.waitForTimeout(400);

  // Verify by reading which card is currently selected on the page.
  const currentlySelected = await readCurrentlySelectedCardText(page);
  log(`  · currently selected card: "${currentlySelected.replace(/\s+/g, ' ')}"`);

  if (!new RegExp(target, 'i').test(currentlySelected)) {
    log(`  · "${target}" not selected yet — retrying via keyboard focus + Space`);
    await target_loc.focus().catch(() => undefined);
    await page.keyboard.press('Space').catch(() => undefined);
    // No fixed sleep — verifyShippingSelection below auto-waits.
  }

  // STRICT verification — inspect the DOM directly to confirm the
  // target-labelled card is the one currently marked selected. If not,
  // fail loudly instead of proceeding to payment with the wrong method.
  const verdict = await verifyShippingSelection(page, target, others);

  log(`  · verdict: selected="${verdict.selectedText}" ok=${verdict.ok}`);
  if (!verdict.ok) {
    // Standard delivery on KWH is selected by default and has no
    // aria-checked / data-selected / class marker. If no method-card
    // reports a selected indicator AT ALL and the target is 'standard',
    // treat it as the site's default. Any other target must have an
    // explicit selection indicator — otherwise we'd risk completing an
    // order with the wrong shipping method.
    if (verdict.selectedText === '(none)' && method === 'standard') {
      log(`  ✓ ${method} is the KWH default (no explicit selection indicator) — accepting`);
      return;
    }
    // Diagnostic dump: our "is selected" heuristic missed the KWH indicator.
    // Only surface leaf-ish nodes whose text closely matches a card (short
    // text length) plus any form inputs whose name/value refers to shipping.
    const diagnostic = await page.evaluate(() => {
      const methodRe = /standard shipping|express shipping|international shipping|click.?and.?collect/i;
      const cards = Array.from(document.querySelectorAll('*'))
        .filter((el) => {
          const t = (el.textContent || '').trim();
          return (
            t.length > 0 &&
            t.length < 180 &&
            methodRe.test(t) &&
            // exclude wrappers where a child already contains the same match
            !Array.from(el.children).some((c) => methodRe.test((c.textContent || '').trim()))
          );
        })
        .slice(0, 8);
      const inputs = Array.from(document.querySelectorAll('input, [role="radio"], [data-state]'))
        .filter((el) => {
          const name = el.getAttribute('name') || el.getAttribute('aria-label') || '';
          const val = (el as HTMLInputElement).value || '';
          const parentTxt = ((el.closest('label, [role="radio"], article, li') || el).textContent || '').slice(0, 200);
          return (
            /ship|delivery|collect/i.test(name) ||
            /ship|delivery|collect/i.test(parentTxt) ||
            /despatch|express|standard/i.test(val)
          );
        })
        .slice(0, 8);
      const attrsOf = (el: Element) =>
        Array.from(el.attributes).map((a) => `${a.name}="${a.value.slice(0, 80)}"`).join(' ');
      return {
        cards: cards.map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          attrs: attrsOf(el),
        })),
        inputs: inputs.map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: (el as HTMLInputElement).type || null,
          name: el.getAttribute('name'),
          value: (el as HTMLInputElement).value || null,
          checked: (el as HTMLInputElement).checked ?? null,
          ariaChecked: el.getAttribute('aria-checked'),
          dataState: el.getAttribute('data-state'),
          attrs: attrsOf(el),
        })),
      };
    }).catch(() => ({ cards: [], inputs: [] }));
    log(`  ! shipping-card DOM dump: ${JSON.stringify(diagnostic)}`);
    throw new Error(
      `Wrong shipping method selected. Expected "${target}", but currently selected card is "${verdict.selectedText}". Reason: ${verdict.reason}`,
    );
  }
  log(`  ✓ ${method} shipping selected (verified)`);
}

/**
 * Picks the first selectable store on the CNC store list. The KWH CNC
 * store cards don't always render an explicit "in stock" badge — a store
 * is either offered (implicitly available) or excluded from the list.
 * We look for a store radio / "Select" button, skipping any container
 * explicitly marked "out of stock".
 */
export { selectFirstInStockCncStore } from './cncStore';

export async function continueToPayment(
  page: Page,
  log: Logger,
  waitForOverlay: WaitForLoadingOverlay,
): Promise<void> {
  log('step 2 → 3 · Continue to Payment');

  await waitForOverlay();

  const continueRe = /continue\s*to\s*payment|proceed\s*to\s*payment/i;
  // Prefer a real <button> or role="button" with the accessible name —
  // this is the only pattern that reliably targets the actual submit
  // control rather than a wrapper or a duplicate hidden one.
  const btn = page
    .getByRole('button', { name: continueRe })
    .or(page.locator('button[type="submit"]').filter({ hasText: continueRe }))
    .or(page.locator('input[type="submit"]').and(page.locator(`[value~="Continue" i]`)))
    .first();

  let btnFound = false;
  try {
    await btn.waitFor({ state: 'visible', timeout: 20_000 });
    btnFound = true;
  } catch {
    log('  ! "Continue to payment" button did not appear in 20s');
    const clickables = await page
      .locator('button, [role="button"], a, input[type="submit"]')
      .allTextContents()
      .catch(() => []);
    log(
      `  ! visible clickables: ${clickables
        .slice(0, 15)
        .map((s) => s.trim())
        .filter((s) => s && s.length < 60)
        .join(' | ')}`,
    );
  }

  if (!btnFound) {
    throw new Error('No "Continue to payment" button found on the page.');
  }

  // Log the exact element we're about to click so a mis-click reveals
  // itself in the trace.
  const meta = await btn.evaluate((el: Element) => ({
    tag: el.tagName,
    type: (el as HTMLInputElement).type ?? null,
    disabled: (el as HTMLButtonElement).disabled ?? false,
    ariaDisabled: el.getAttribute('aria-disabled'),
    className: (el.getAttribute('class') || '').slice(0, 80),
  })).catch(() => null);
  const label = ((await btn.textContent().catch(() => null)) ?? '').trim();
  log(`  → clicking "${label.slice(0, 40)}" meta=${JSON.stringify(meta)}`);

  await btn.scrollIntoViewIfNeeded().catch(() => undefined);

  // 1st attempt: normal Playwright click (real browser gesture, isTrusted).
  await btn.click({ force: true, timeout: 5_000 }).catch((err) => {
    log(`  · Playwright click failed: ${(err as Error).message?.split('\n')[0]}`);
  });

  // Give the SPA a beat to react, then check if we advanced. Bumped
  // from 2.5s → 8s: KWH staging often takes 5-7s to render the payment
  // section on the first click; a shorter window forces a redundant
  // 2nd click that itself triggers ~20s of extra network activity.
  const quickTransition = await hasPaymentSectionRendered(page, 8_000);
  if (quickTransition) return finalizePaymentTransition(page, log);

  // 2nd attempt: JS-native click. Some React handlers respond to
  // el.click() when overlay/portal interception blocks Playwright's.
  log('  · no transition after first click — retrying with el.click() via evaluate');
  await btn.evaluate((el: HTMLElement) => el.click()).catch(() => undefined);
  const secondTransition = await hasPaymentSectionRendered(page, 4_000);
  if (secondTransition) return finalizePaymentTransition(page, log);

  // 3rd attempt: dispatch a synthetic MouseEvent (bubbling, cancelable).
  log('  · still no transition — dispatching MouseEvent');
  await btn
    .evaluate((el: HTMLElement) => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })
    .catch(() => undefined);
  const thirdTransition = await hasPaymentSectionRendered(page, 4_000);
  if (thirdTransition) return finalizePaymentTransition(page, log);

  // All three click strategies failed to transition. Dump validation
  // errors (if any) and throw with a clear message so the trace shows
  // exactly why step 2 didn't advance. Tight selector list — avoids
  // matching page titles / SVG <title> elements / product-name blocks
  // that happen to have "error"-ish class names.
  const errorMessages = await page
    .locator(
      [
        '[role="alert"]:visible',
        '.error-message:visible',
        '.field-error:visible',
        '.invalid-feedback:visible',
        '.form-error:visible',
        '[aria-invalid="true"]:visible',
      ].join(', '),
    )
    .allTextContents()
    .catch(() => []);
  const isProbableError = (s: string) =>
    s.length > 0 &&
    s.length < 200 &&
    !/\|\s*Kitchen Warehouse/i.test(s) && // drop page-title-shaped strings
    !/^https?:\/\//.test(s);
  const visibleErrors = errorMessages
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(isProbableError)
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .slice(0, 8);
  log(`  ! step 2 did not advance after 3 click strategies. Validation errors: ${visibleErrors.join(' | ') || '(none found)'}`);
  throw new Error(
    `Continue to Payment click did not transition to step 3.` +
      (visibleErrors.length ? ` Validation errors: ${visibleErrors.join('; ')}` : ''),
  );
}

async function hasPaymentSectionRendered(page: Page, timeoutMs: number): Promise<boolean> {
  return page
    .waitForFunction(
      () =>
        /credit(?:\s|\/)?(?:card|debit)|paypal|afterpay|google pay|apple pay|card number|cybersource/i.test(
          document.body.innerText,
        ),
      undefined,
      { timeout: timeoutMs, polling: 400 },
    )
    .then(() => true)
    .catch(() => false);
}

function finalizePaymentTransition(_page: Page, log: Logger): void {
  log('  ✓ reached payment step');
}
