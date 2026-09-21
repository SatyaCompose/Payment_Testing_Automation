import { Page, expect } from '@playwright/test';
import type { ShippingMethod } from '../../fixtures/testData';
import type { Logger, WaitForLoadingOverlay } from './loginPromptFlow';
import {
  classifyShippingText,
  escapeRegex,
  otherMethodLabels,
  readCommittedShippingMethod,
  readCurrentlySelectedCardText,
  readShippingCards,
  shippingMethodAliases,
  shippingMethodLabel,
  shippingMethodTargetRe,
  shippingOtherMethodsRe,
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
  const targetAliases = shippingMethodAliases[method];
  // Alias-aware — KWH sometimes labels the international card as
  // "New Zealand delivery" / "Standard International" rather than the
  // canonical "International shipping". Match any known alias so a
  // renamed card is still located instead of silently failing at the
  // final text fallback.
  const targetRe = shippingMethodTargetRe(method);

  // Cart items that don't ship to the saved address trigger a conflict
  // modal *before* the shipping cards render. Options KWH offers:
  //   • Select another store          (opens the CNC store list)
  //   • Ship all items instead        (forces standard/express delivery)
  //   • Remove low stock items and continue
  // We want the shipping method the test asked for. If the target is
  // 'cnc', pick "Select another store"; otherwise pick "Ship all items
  // instead" so the shipping method cards below render normally.
  await resolveShippingConflictIfPresent(page, log, method);

  // Wait for the shipping section to be FULLY stable, not just text-
  // rendered. Two signals must both hold:
  //   1. The target label (or a known alias) is on the page.
  //   2. At least one shipping-method label wraps a :checked input —
  //      i.e. KWH's rate fetch completed and its default selection
  //      landed. Without #2 the click race can fire against a section
  //      that's still mid re-render after the address change, and the
  //      verifier then reports "no label wraps a :checked input" while
  //      the site was simply not ready.
  // Also wait for any KWH "shipping loading" overlay to disappear.
  const targetAliasList = shippingMethodAliases[method]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const allAliasesList = (Object.values(shippingMethodAliases) as string[][])
    .flat()
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // First: soft wait for the target CARD to appear. Scoped to elements
  // that actually own a checkbox/radio — probing document.body.innerText
  // matched product marketing copy ("Express Post available") and let the
  // Express run proceed as if the card had rendered when it never did.
  await page
    .waitForFunction(
      (aliasPattern: string) => {
        const re = new RegExp(aliasPattern, 'i');
        const controls = Array.from(
          document.querySelectorAll(
            'input[type="checkbox"], input[type="radio"], [role="radio"], [role="checkbox"]',
          ),
        );
        return controls.some((el) => {
          const wrapping = el.closest('label');
          if (wrapping && re.test(wrapping.textContent || '')) return true;
          if (re.test(el.getAttribute('aria-label') || '')) return true;
          let node: Element | null = el.parentElement;
          for (let hops = 0; node && hops < 5; hops += 1, node = node.parentElement) {
            const t = node.textContent || '';
            if (t.length < 200 && re.test(t)) return true;
          }
          return false;
        });
      },
      targetAliasList,
      { timeout: 25_000, polling: 500 },
    )
    .catch(() => {
      log(`  ! shipping section did not render a "${target}" card (or an alias) in 25s — will still try`);
    });
  // Then: hard wait for a checked default among any shipping label —
  // that's the "rates fetched + default picked" signal. If it never
  // comes true within 15s, log and continue (some KWH revisions may
  // ship without a pre-checked default; downstream will still try).
  await page
    .waitForFunction(
      (allAliases: string) => {
        const methodRe = new RegExp(allAliases, 'i');
        const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[];
        return labels.some(
          (l) =>
            methodRe.test(l.textContent || '') &&
            !!l.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked'),
        );
      },
      allAliasesList,
      { timeout: 15_000, polling: 400 },
    )
    .then(() => log('  · shipping section is stable — a default option is checked'))
    .catch(() => log('  ! no shipping card reports :checked within 15s — proceeding anyway (may indicate mid-render)'));

  // Special case: only ONE shipping method is offered (typical for
  // international destinations — the international card is often the
  // only option). No selection needed and no explicit "selected"
  // indicator will be rendered because there's nothing to switch between.
  // `others` intentionally spans ALL alias forms of the non-target
  // methods so a card renamed to "Standard delivery" is still recognised
  // as "another method visible".
  const others = (Object.keys(shippingMethodAliases) as ShippingMethod[])
    .filter((m) => m !== method)
    .flatMap((m) => shippingMethodAliases[m]);
  // Enumerate the real controls once — used for the single-option
  // fast-path and for the diagnostics below.
  const cards = await readShippingCards(page);
  const cardSummary = cards.map((c) => (c.checked ? '[x] ' : '[ ] ') + c.text.slice(0, 40));
  log(`  · shipping-method controls on page: ${JSON.stringify(cardSummary)}`);
  const otherLabelsVisible = await visibleOtherLabels(page, others);
  if (otherLabelsVisible.length === 0) {
    // Only accept "sole option" when a target-named CONTROL really exists.
    // Previously this fell back to any page text matching the target, so a
    // page that offered no Express card at all could be treated as
    // "Express is the only option" and sail through to payment.
    const targetCardPresent = cards.some((c) => targetRe.test(c.text));
    if (targetCardPresent) {
      log(`  → "${target}" is the only shipping method offered — nothing to click, treated as selected`);
      return;
    }
    if (cards.length === 0) {
      log('  ! no shipping-method controls found at all — continuing into the click strategies');
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

  const escapedOthers = others.map(escapeRegex);
  const notOtherRe = new RegExp(escapedOthers.join('|'), 'i');

  // Strategy 1.4: some revisions render the shipping options as bare
  // checkboxes named by aria-label / label[for], with no wrapping <label>.
  // The label strategy below finds nothing there, so the card-click path took
  // over and clicked a container that isn't bound to the input — Express never
  // toggled and the run failed as `currently selected card is "(none)"`.
  // Address it by role, and use check() which is idempotent on a hidden input.
  const roleControl = page
    .getByRole('checkbox', { name: targetRe })
    .or(page.getByRole('radio', { name: targetRe }))
    .first();
  if (await roleControl.count().catch(() => 0)) {
    if (await roleControl.isChecked().catch(() => false)) {
      log(`  ✓ ${method} already checked (accessible-name match) — no click needed`);
      return;
    }
    log(`  → checking "${target}" control found by accessible name`);
    for (const strat of [
      { name: 'check()', fn: () => roleControl.check({ force: true, timeout: 5_000 }) },
      { name: 'click()', fn: () => roleControl.click({ force: true, timeout: 5_000 }) },
      { name: 'evaluate.click', fn: () => roleControl.evaluate((el: HTMLElement) => el.click()) },
    ]) {
      await strat.fn().catch((err) => log(`  · ${strat.name} threw: ${(err as Error).message?.split('\n')[0]}`));
      if (await roleControl.isChecked().catch(() => false)) {
        log(`  · toggled via "${strat.name}"`);
        const verdict = await verifyShippingSelection(page, target, others, targetAliases);
        if (verdict.ok) {
          log(`  ✓ ${method} shipping selected via accessible name`);
          return;
        }
        log(`  · input checked but verdict not ok (${verdict.reason}) — falling through`);
        break;
      }
      log(`  · "${strat.name}" did not toggle input — trying next`);
    }
  }

  // Strategy 1.5 (KWH-specific): shipping cards are <label> wrappers
  // around <input type="checkbox" class="sr-only">. Clicking any wrapper
  // <div>/<span> around the label does nothing — only the label itself is
  // bound to the input. Prefer the label directly.

  const kwhLabel = page
    .locator('label')
    .filter({ hasText: targetRe })
    .filter({ hasNotText: notOtherRe })
    .filter({ has: page.locator('input[type="checkbox"]') });
  const kwhLabelCount = await kwhLabel.count().catch(() => 0);
  log(`  · KWH label candidates (<label> with sr-only checkbox): ${kwhLabelCount}`);
  if (kwhLabelCount > 0) {
    const label = kwhLabel.first();
    const inputInside = label.locator('input[type="checkbox"]').first();
    const already = await inputInside.isChecked().catch(() => false);
    if (already) {
      log(`  ✓ ${method} already checked (site default) — no click needed`);
      return;
    }
    await label.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    const kwhCardText = ((await label.textContent().catch(() => null)) ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    log(`  → clicking KWH label: "${kwhCardText}"`);

    // Real-gesture strategies only. A prior "native setter + change
    // dispatch" fallback set the DOM `checked` attribute directly, but
    // KWH's React state never picked it up — verifyShippingSelection
    // then saw `:checked` on the target and reported success while the
    // server-side shipping method stayed at Standard. Result: Express
    // orders (e.g. 2.3) shipped as Standard. Do not reintroduce the
    // synthetic dispatch — if none of the three real clicks toggle the
    // input, fail loudly downstream.
    const tryStrategies: { name: string; fn: () => Promise<unknown> }[] = [
      { name: 'label.click', fn: () => label.click({ force: true, timeout: 5_000 }) },
      { name: 'input.click (Playwright)', fn: () => inputInside.click({ force: true, timeout: 5_000 }) },
      { name: 'input.evaluate.click', fn: () => inputInside.evaluate((el: HTMLInputElement) => el.click()) },
    ];

    let nowChecked = false;
    for (const strat of tryStrategies) {
      await strat.fn().catch((err) => log(`  · ${strat.name} threw: ${(err as Error).message?.split('\n')[0]}`));
      nowChecked = await inputInside.isChecked().catch(() => false);
      if (nowChecked) {
        log(`  · toggled via "${strat.name}"`);
        break;
      }
      log(`  · "${strat.name}" did not toggle input — trying next`);
    }

    if (nowChecked) {
      const verdict = await verifyShippingSelection(page, target, others, targetAliases);
      if (verdict.ok) {
        log(`  ✓ ${method} shipping selected via KWH label`);
        return;
      }
      log(`  · input checked but verdict not ok (${verdict.reason}) — falling through`);
    } else {
      log(`  · all KWH strategies failed to toggle input — falling through to card-click path`);
    }
  }

  // Strategy 2: click the card container that contains the target text
  // but NOT the other methods' texts (excludes parent wrappers).

  // The `has: input` filter is what stops this matching a product
  // description. Without it, "Ships within 1 business day. Express Post
  // available." in the order summary satisfied the text filter, `.last()`
  // resolved to that text node, the click was a no-op, and the run
  // continued on Standard shipping.
  const card = page
    .locator(':is(button, [role="button"], [role="radio"], label, [tabindex="0"], div, li, article)')
    .filter({ hasText: targetRe })
    .filter({ hasNotText: notOtherRe })
    .filter({ has: page.locator('input[type="checkbox"], input[type="radio"], [role="radio"], [role="checkbox"]') });
  const cardCount = await card.count().catch(() => 0);
  log(`  · card candidates matching only "${target}": ${cardCount}`);

  let target_loc = card.last();
  if (cardCount === 0) {
    if (cards.length > 0) {
      // Other methods ARE offered as real controls, the requested one is
      // not. Previously this fell back to `getByText(targetRe).first()`,
      // which could land on marketing copy, produce a no-op click, and
      // let the run continue on whatever was already selected. Fail
      // loudly — shipping the wrong method silently is far worse than a
      // red test.
      throw new Error(
        `"${target}" is not offered as a shipping method on this checkout. ` +
          `Controls present: ${JSON.stringify(cardSummary)}. ` +
          `For an Express run this usually means the cart contains a dropship / ` +
          `non-Express-eligible product — check the PLP "Express delivery available" filter.`,
      );
    }
    // No shipping controls of any kind on the page — a KWH revision that
    // renders the method as static text. Keep the legacy text fallback so
    // the single-option international sections don't regress.
    log('  · no control-bearing shipping card at all — falling back to the text node');
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
  // Wait for the KWH loading overlay (if any) rather than a fixed sleep.
  // Returns instantly when no overlay is present, so pass-through is cheap.
  await page
    .locator('div.fixed.inset-0.bg-gray-200, div[class*="loading"][class*="fixed"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 2_000 })
    .catch(() => undefined);

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
  const verdict = await verifyShippingSelection(page, target, others, targetAliases);

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
 * Detect and resolve the "cart has items that don't ship to your saved
 * address" modal. Renders BEFORE the shipping method cards, so leaving
 * it unresolved makes every downstream shipping locator return zero
 * matches. Idempotent: no-op if no such modal is present.
 */
async function resolveShippingConflictIfPresent(
  page: Page,
  log: Logger,
  method: ShippingMethod,
): Promise<boolean> {
  // KWH shows two families of conflict banners at checkout, depending on
  // WHY the cart can't ship to the current address:
  //   A) "Some items ship from a different store" — options:
  //        - Select another store
  //        - Ship all items instead
  //        - Remove low stock items and continue
  //   B) "Items unavailable for delivery" — options:
  //        - Remove unavailable items and continue with shipping
  //        - Click and Collect all items instead
  // Both render the KWH sr-only-checkbox pattern. Detect either.
  // Probe via document.body.innerText so a below-fold banner (common on
  // the 390×844 mobile viewport) still counts as "present". Playwright's
  // isVisible on `.first()` returned false for these banners because the
  // first DOM match was inside a display:none aria-live region.
  const conflictPresent = await page
    .evaluate(() =>
      /(ship all items instead|remove low stock items|this product is currently not available for delivery|remove unavailable items and continue|click and collect all items instead)/i.test(
        document.body.innerText,
      ),
    )
    .catch(() => false);
  if (!conflictPresent) return false;

  // Pick the resolution that preserves the requested shipping mode.
  // For method='cnc' we accept EITHER "Select another store" (store
  // mismatch) or "Click and Collect all items instead" (unavailable).
  // For any delivery method we prefer options that keep the user on
  // delivery: "Ship all items instead" > "Remove unavailable items".
  const targetActionRe =
    method === 'cnc'
      ? /select another store|click and collect all items instead/i
      : /ship all items instead|remove unavailable items and continue/i;
  const targetLabel = method === 'cnc' ? 'CNC option' : 'delivery option';
  log(`  ! shipping-conflict modal present — selecting "${targetLabel}"`);

  // Try increasingly forceful strategies — same escalation ladder as the
  // shipping method click. KWH cards are <label>-wrapped sr-only checkboxes
  // that sometimes don't respond to synthesized clicks on React 18.
  const label = page
    .locator('label')
    .filter({ hasText: targetActionRe })
    .filter({ has: page.locator('input[type="checkbox"]') })
    .first();
  const labelCount = await label.count().catch(() => 0);
  if (labelCount > 0) {
    const inputInside = label.locator('input[type="checkbox"]').first();
    await label.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    // Real-gesture strategies only — see the note in selectShippingMethod
    // above. Synthetic native-setter dispatch toggles the DOM `checked`
    // attribute without informing React, so the DOM looks right while
    // the site's state is unchanged.
    const strategies: { name: string; fn: () => Promise<unknown> }[] = [
      { name: 'label.click', fn: () => label.click({ force: true, timeout: 5_000 }) },
      { name: 'input.click', fn: () => inputInside.click({ force: true, timeout: 5_000 }) },
      { name: 'input.evaluate.click', fn: () => inputInside.evaluate((el: HTMLInputElement) => el.click()) },
    ];
    for (const s of strategies) {
      await s.fn().catch(() => undefined);
      if (await inputInside.isChecked().catch(() => false)) {
        log(`  · conflict option toggled via "${s.name}"`);
        break;
      }
    }
  } else {
    log(`  · no <label> match for "${targetLabel}" — trying plain button/text click`);
    await page
      .locator('button, [role="button"], label, div, span')
      .filter({ hasText: targetActionRe })
      .first()
      .click({ force: true, timeout: 5_000 })
      .catch(() => undefined);
  }

  // Broad submit-button lookup — the KWH modal sometimes labels its
  // commit button with more than one word (e.g. "Continue to shipping",
  // "Apply changes", "Confirm selection"). Match any short button text
  // containing one of the commit verbs, prioritising modal-scoped
  // buttons over the page-level Continue.
  // KWH commits the conflict banner with an explicit action label — observed
  // as "Remove out of stock items" — which no generic commit verb matches. The
  // verb-only list used to fall through to the order summary's promo-code
  // "Apply" (earlier in the DOM, so `.first()` won it); applying an empty promo
  // re-rendered the step without a Continue button. So: match the real action
  // labels first, then generic verbs, and never a bare "Apply" ("Apply
  // changes" is still fine).
  const conflictActionRe =
    /remove (out of stock|unavailable|low stock) items|ship all items instead|click and collect all items instead/i;
  const confirmVerbRe = /(continue|confirm|save|apply|update|ok|proceed)/i;
  const notCommitRe = /back to cart|log ?out|show|hide|view (my )?cart/i;
  const bareApplyRe = /^\s*apply\s*$/i;
  const clickable = 'button:visible, [role="button"]:visible, input[type="submit"]:visible';
  const modalScope = page.locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
  const candidates = [
    { label: 'modal action', locator: modalScope.locator(clickable).filter({ hasText: conflictActionRe }) },
    { label: 'page action', locator: page.locator(clickable).filter({ hasText: conflictActionRe }) },
    {
      label: 'modal verb',
      locator: modalScope
        .locator(clickable)
        .filter({ hasText: confirmVerbRe })
        .filter({ hasNotText: notCommitRe })
        .filter({ hasNotText: bareApplyRe }),
    },
    {
      label: 'page verb',
      locator: page
        .locator(clickable)
        .filter({ hasText: confirmVerbRe })
        .filter({ hasNotText: notCommitRe })
        .filter({ hasNotText: bareApplyRe }),
    },
  ];
  let confirmBtn = candidates[candidates.length - 1].locator.first();
  for (const candidate of candidates) {
    if (await candidate.locator.count().catch(() => 0)) {
      log(`  · commit control matched via ${candidate.label}`);
      confirmBtn = candidate.locator.first();
      break;
    }
  }
  if (await confirmBtn.count().catch(() => 0)) {
    const confirmLabel = ((await confirmBtn.textContent().catch(() => null)) ?? '').trim().slice(0, 60);
    log(`  · clicking confirm-like button "${confirmLabel}"`);
    await confirmBtn.click({ force: true, timeout: 5_000 }).catch(() => undefined);
  } else {
    log('  · no confirm button found — relying on auto-apply');
  }

  // Wait for the banner text to disappear AND the shipping section to
  // remain rendered. Includes the "delivery/unavailable" variant.
  const modalResolved = await page
    .waitForFunction(
      () => {
        const txt = document.body.innerText;
        const conflictGone =
          !/ship all items instead|remove low stock items|this product is currently not available for delivery|remove unavailable items and continue|click and collect all items instead/i.test(
            txt,
          );
        const shippingRendered = /standard shipping|express shipping|international shipping/i.test(txt);
        return conflictGone && shippingRendered;
      },
      undefined,
      { timeout: 8_000, polling: 500 },
    )
    .then(() => true)
    .catch(() => false);

  if (modalResolved) {
    log('  ✓ conflict resolved, shipping section is rendering');
    return true;
  }

  // Fallback: re-click the page-level "Continue to shipping" once. In
  // some KWH revisions the resolution options auto-apply but the page
  // waits for the user to advance step 1 again after they've been chosen.
  log('  · conflict-modal wait timed out — re-clicking Continue to shipping as a nudge');
  const continueBtn = page
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: /continue\s*to\s*(shipping|delivery)/i })
    .first();
  if (await continueBtn.count().catch(() => 0)) {
    await continueBtn.click({ force: true, timeout: 5_000 }).catch(() => undefined);
    await page
      .waitForFunction(
        () => /standard shipping|express shipping|international shipping/i.test(document.body.innerText),
        undefined,
        { timeout: 8_000, polling: 500 },
      )
      .catch(() => log('  · shipping still not rendered after nudge — proceeding anyway'));
  }
  // A conflict banner WAS present and we acted on it, even though the
  // "resolved" signal never went green — callers must still treat the
  // shipping rate as potentially reset.
  return true;
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
  shippingMethodForConflict: ShippingMethod = 'standard',
): Promise<void> {
  log('step 2 → 3 · Continue to Payment');

  await waitForOverlay();

  // Give the shipping section time to finish rendering. KWH fetches
  // shipping options async after the customer step, and the "items
  // unavailable" banner only paints once that fetch completes. Running
  // the resolver too early (right after waitForOverlay) misses the
  // banner and lets the failed button click surface first.
  await page
    .waitForFunction(
      () => /standard shipping|express shipping|international shipping/i.test(document.body.innerText),
      undefined,
      { timeout: 8_000, polling: 300 },
    )
    .catch(() => undefined);

  // If selectShippingMethod returned via the "already checked" fast-path
  // it may not have seen the conflict banner (rendered BETWEEN the
  // shipping cards and the Continue button). Re-run the resolver here
  // so an unresolved banner doesn't silently block the button click.
  const conflictResolvedHere = await resolveShippingConflictIfPresent(page, log, shippingMethodForConflict);

  // "Ship all items instead" puts the cart back on the default delivery
  // rate — i.e. Standard. If that ran AFTER selectShippingMethod had
  // already picked Express, the selection is silently undone. Re-apply it.
  if (conflictResolvedHere && shippingMethodForConflict !== 'cnc' && shippingMethodForConflict !== 'standard') {
    log(`  · conflict resolution may have reset the rate — re-selecting ${shippingMethodForConflict}`);
    await selectShippingMethod(page, log, shippingMethodForConflict);
  }

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
  // from 8s → 15s: mobile-safari can take 8-12s to render the payment
  // section after a genuine click; a shorter window fires the retry
  // logic even when the first click actually worked.
  const quickTransition = await hasPaymentSectionRendered(page, 15_000);
  if (quickTransition) return finalizePaymentTransition(page, log);

  // Between click attempts, re-check for the conflict banner. It
  // sometimes renders async AFTER the first Continue click reveals
  // validation state. Resolving it now unblocks the retry clicks.
  await resolveShippingConflictIfPresent(page, log, shippingMethodForConflict);

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

  // 4th attempt: submit the enclosing <form> natively. React's `onSubmit`
  // is bound to the form element, not the button. When the DOM `checked`
  // attribute got set outside React's controlled-input contract (e.g.
  // via our native setter dispatch), the button-onClick can silently
  // no-op — but the form's onSubmit still fires validation + navigation
  // against the current controlled state.
  log('  · still no transition — trying form.requestSubmit()');
  const formSubmitted = await btn
    .evaluate((el: HTMLElement) => {
      const form = el.closest('form') as HTMLFormElement | null;
      if (!form) return false;
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return true;
    })
    .catch(() => false);
  log(`  · form submit dispatched: ${formSubmitted}`);
  const fourthTransition = await hasPaymentSectionRendered(page, 6_000);
  if (fourthTransition) return finalizePaymentTransition(page, log);

  // All four strategies failed to transition. Dump validation
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
  log(`  ! step 2 did not advance after 4 click strategies. Validation errors: ${visibleErrors.join(' | ') || '(none found)'}`);
  throw new Error(
    `Continue to Payment click did not transition to step 3.` +
      (visibleErrors.length ? ` Validation errors: ${visibleErrors.join('; ')}` : ''),
  );
}

async function hasPaymentSectionRendered(page: Page, timeoutMs: number): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const txt = document.body.innerText;
        // Provider-name signals (fire when the CC/PP/AP/GP UI actually renders)
        const providerVisible =
          /credit(?:\s|\/)?(?:card|debit)|paypal|afterpay|google pay|apple pay|card number|cybersource/i.test(txt);
        // Payment-step heading — fires earlier than the provider UI, so we
        // don't spam retry clicks while a slow mobile-safari renders the
        // step 3 body.
        const paymentHeading =
          /(payment method|choose your (preferred )?payment|how (would|do) you (like|want) to pay|select (a )?payment)/i.test(txt);
        return providerVisible || paymentHeading;
      },
      undefined,
      { timeout: timeoutMs, polling: 400 },
    )
    .then(() => true)
    .catch(() => false);
}

function finalizePaymentTransition(_page: Page, log: Logger): void {
  log('  ✓ reached payment step');
}

/**
 * Safety net against a false pass: once the checkout has advanced to the
 * payment step it renders the COMMITTED shipping method in the collapsed
 * Shipping summary (e.g. "Standard shipping - $9.90"). Every path above
 * verifies the control we clicked, but KWH can re-price the cart after
 * that point — a conflict banner resolution, a rate re-fetch, or a
 * dropship line item silently drops the order back to Standard. Section 2
 * (Express) was completing orders as Standard for exactly that reason.
 *
 * Failure stance is deliberate and asymmetric:
 *   • summary line found AND it maps to a different method  → THROW.
 *     A regression suite reporting a green Express run that actually
 *     shipped Standard is the worst possible outcome.
 *   • no summary line rendered at all  → log and continue. Absence is a
 *     layout variance across the four browser projects, not evidence
 *     that the wrong method was committed, so it must not fail the run.
 */
export async function verifyCommittedShippingMethod(
  page: Page,
  log: Logger,
  expected: ShippingMethod,
): Promise<void> {
  const line = await readCommittedShippingMethod(page).catch(() => '');
  if (!line) {
    log(`  · no committed shipping-method line rendered — cannot cross-check ${expected} (continuing)`);
    return;
  }
  const actual = classifyShippingText(line);
  if (actual === expected) {
    log(`  ✓ committed shipping method confirmed: "${line}"`);
    return;
  }
  if (actual === null) {
    log(`  · committed shipping line "${line}" matches no known method — cannot cross-check (continuing)`);
    return;
  }
  throw new Error(
    `Checkout committed the wrong shipping method. Expected "${shippingMethodLabel[expected]}" ` +
      `but the payment step reports "${line}" (${actual}). ` +
      `The order would have been placed on ${actual} shipping, making this a false pass.`,
  );
}
