import { Page, expect } from '@playwright/test';
import type { Logger } from './loginPromptFlow';
import {
  confirmPickupStore,
  logCncPageSnapshot,
  pickFromMainPageStoreCards,
  pickInStockStoreInDrawer,
} from './cncStorePickers';

const CNC_TAB_RE = /click\s*(&|and)\s*collect|pick\s*up\s*in\s*store|in-store\s*pickup|store\s*pickup/i;
const CNC_LAYOUT_MARKER_RE =
  /your selected store is|change store|who will pick up your order|billing address/i;
const DRAWER_HEADING_RE = /check store stock|please select a store where all products are in stock/i;
const STOCK_WARNING_RE =
  /not all (of )?your items are in stock|items are out of stock for collection|below items are out of stock/i;
const AU_ADDRESS_RE = /\b(?:ACT|NSW|VIC|QLD|SA|WA|TAS|NT)[, ]+\d{4}\b/;
/**
 * Triggers that open the KWH "Check store stock" drawer, in the order we
 * try them. Anchored (^...$) so we never hit the drawer's own instruction
 * text ("Please select a store where all products are in stock…").
 */
const DRAWER_TRIGGER_PATTERNS: RegExp[] = [
  /^select another store$/i,
  /^change store$/i,
  /^change pickup store$/i,
  /^find (a )?store$/i,
  /^choose (a )?store$/i,
  /^show more$/i,
];

export async function selectClickAndCollectTab(page: Page, log: Logger): Promise<void> {
  log('step 2 · switching to Click & Collect tab');

  // Mobile checkout renders the Delivery / Click & Collect switcher as
  // a plain <div> card or a segmented control — no role=tab/button/link.
  // Match any visible element whose accessible name OR text content
  // reads as a CNC label, including the widely-styled div/span cases.
  // `visible: true` filters out the hidden desktop copy that mobile
  // layouts sometimes keep in the DOM.
  const tab = page
    .getByRole('tab', { name: CNC_TAB_RE })
    .or(page.getByRole('radio', { name: CNC_TAB_RE }))
    .or(page.getByRole('button', { name: CNC_TAB_RE }))
    .or(page.getByRole('link', { name: CNC_TAB_RE }))
    .or(page.locator('label').filter({ hasText: CNC_TAB_RE }))
    .or(
      // Mobile fallback — any visible clickable-ish element with the
      // right text and a compact size (rules out page-level wrappers
      // whose text contains the phrase across many descendants).
      page
        .locator('div, span, li, [tabindex], [class*="tab" i], [class*="option" i], [class*="segment" i]')
        .filter({ hasText: CNC_TAB_RE }),
    )
    .filter({ visible: true })
    .first();

  try {
    await expect(tab).toBeVisible({ timeout: 10_000 });
  } catch {
    await logCncPageSnapshot(page, log);
    throw new Error('No "Click & Collect" tab at step 2 — refusing to fall through to delivery.');
  }

  const meta = await tab
    .evaluate((el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        className: (el.getAttribute('class') || '').slice(0, 60),
        text: (el.textContent || '').trim().slice(0, 40),
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
      };
    })
    .catch(() => null);
  log(`  → clicking CNC tab: ${JSON.stringify(meta)}`);
  await tab.scrollIntoViewIfNeeded().catch(() => undefined);

  // Real gesture first. If nothing happens (mobile handlers listening
  // only on touchend), escalate to tap → coordinate click.
  const hasTouch = await page
    .evaluate(() => 'ontouchstart' in window || navigator.maxTouchPoints > 0)
    .catch(() => false);

  const clickStrategies: Array<{ label: string; run: () => Promise<void> }> = [
    { label: 'click', run: () => tab.click({ force: true, timeout: 5_000 }) },
  ];
  if (hasTouch) {
    clickStrategies.push({ label: 'tap', run: () => tab.tap({ force: true, timeout: 5_000 }) });
    clickStrategies.push({
      label: 'coord tap centre',
      run: async () => {
        const box = await tab.boundingBox().catch(() => null);
        if (!box) throw new Error('no bounding box');
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      },
    });
  }
  clickStrategies.push({
    label: 'DOM el.click()',
    run: () => tab.evaluate((el: HTMLElement) => el.click()),
  });

  for (const { label, run } of clickStrategies) {
    log(`  · try ${label}`);
    await run().catch((err: Error) => log(`    · ${label} threw: ${err.message?.split('\n')[0]}`));
    const layoutReady = await page
      .getByText(CNC_LAYOUT_MARKER_RE)
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (layoutReady) {
      log(`  ✓ Click & Collect layout is active (via ${label})`);
      return;
    }
    log(`  · ${label} did not switch layout — escalating`);
  }

  await logCncPageSnapshot(page, log);
  throw new Error(
    'Clicked "Click & Collect" through every strategy but the CNC layout markers did not appear — refusing to fall through to delivery.',
  );
}

/**
 * Ensures a CNC store is chosen. Two happy paths:
 *  1. KWH has pre-selected a store AND there's no stock warning — accept.
 *  2. Everything else — open the "Check store stock" drawer, expand
 *     state accordions, pick a card with an explicit "In stock" status,
 *     click "Confirm pickup store".
 *
 * Any qualifier that means "not fully in stock" (Out of stock, Limited
 * stock, Low stock) disqualifies a card. Never falls through to a
 * delivery-mode radio or an unconfirmed pick.
 */
export async function selectFirstInStockCncStore(page: Page, log: Logger): Promise<string> {
  log('step 2 · selectFirstInStockCncStore');

  // Fast path: a store is already selected AND no stock warning is
  // shown. Typical for logged-in users with a saved default store.
  const preSelected = page.getByText(/your selected store is|selected store\s*:/i).first();
  const isPreSelected = await preSelected.isVisible({ timeout: 4_000 }).catch(() => false);
  const stockWarningVisible = await page
    .getByText(STOCK_WARNING_RE)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);

  if (isPreSelected && !stockWarningVisible) {
    const text = ((await preSelected.textContent().catch(() => null)) ?? '').trim();
    log(`  ✓ store already pre-selected (no stock warning): "${text.slice(0, 80)}"`);
    return text;
  }
  if (stockWarningVisible) {
    log('  ! pre-selected store has stock issues — opening drawer');
  }

  // Preferred path for new / guest users: KWH lists the 3 nearest
  // in-stock stores directly on the main page under the heading
  // "There are N stores with stock close to your location". Click the
  // first — no drawer needed. Only if that heading isn't visible do we
  // fall back to opening the drawer via "Change store" / "Show more".
  if (!stockWarningVisible) {
    const mainPagePicked = await pickFromMainPageStoreCards(page, log);
    if (mainPagePicked !== null) {
      log(`  ✓ picked main-page store: "${mainPagePicked.slice(0, 60)}"`);
      return mainPagePicked;
    }
  }

  await openStoreDrawer(page, log);
  await expandAllStateAccordions(page, log);

  const picked = await pickInStockStoreInDrawer(page, log);
  if (picked === null) {
    await logCncPageSnapshot(page, log);
    throw new Error(
      'No CNC store with explicit "In stock" status found in the drawer. Refusing to fall through to delivery.',
    );
  }
  await confirmPickupStore(page, log);
  return picked;
}

/**
 * Opens the "Check store stock" drawer. Tries several triggers in order
 * — the label varies by user state:
 *   - Logged-in with pre-selected store: "Change store"
 *   - Warning shown for auto-picked store: "Select another store"
 *   - New user, no default: "Show more"
 * After each candidate click, verifies the drawer heading OR a store
 * card appeared before accepting. Throws with a DOM dump if none work.
 */
async function openStoreDrawer(page: Page, log: Logger): Promise<void> {
  if (await drawerLooksOpen(page)) {
    log('  · drawer already open');
    return;
  }

  for (const pattern of DRAWER_TRIGGER_PATTERNS) {
    const trigger = page
      .locator('a, button, [role="button"], [role="link"]')
      .filter({ hasText: pattern })
      .first();
    if (!(await trigger.isVisible({ timeout: 500 }).catch(() => false))) continue;

    const label = ((await trigger.textContent().catch(() => null)) ?? '').trim();
    log(`  → clicking "${label}" to open store drawer`);
    await trigger.scrollIntoViewIfNeeded().catch(() => undefined);
    await trigger.click({ force: true });

    // Verify a store-selection UI appeared. Accept either the drawer
    // heading OR at least one store card (state+postcode pattern).
    const opened = await Promise.race([
      page
        .getByText(DRAWER_HEADING_RE)
        .first()
        .waitFor({ state: 'visible', timeout: 4_000 })
        .then(() => true)
        .catch(() => false),
      page
        .locator('li, article, section, div')
        .filter({ hasText: AU_ADDRESS_RE })
        .first()
        .waitFor({ state: 'visible', timeout: 4_000 })
        .then(() => true)
        .catch(() => false),
    ]);
    if (opened) {
      log('  ✓ store selection UI is now visible');
      return;
    }
    log(`  · click "${label}" did not open store selector — trying next trigger`);
  }

  await logCncPageSnapshot(page, log);
  throw new Error(
    'Could not open the CNC store drawer with any known trigger (Select another store / Change store / Show more / Find a store / Choose a store).',
  );
}

async function drawerLooksOpen(page: Page): Promise<boolean> {
  const heading = await page
    .getByText(DRAWER_HEADING_RE)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (heading) return true;
  const cards = await page
    .locator('li, article, section, div')
    .filter({ hasText: AU_ADDRESS_RE })
    .first()
    .isVisible({ timeout: 300 })
    .catch(() => false);
  return cards;
}

/**
 * Expands every state accordion in the drawer (each has label like
 * "New South Wales (5)"). Store cards live inside them and only render
 * as visible when the accordion is open. Best-effort — swallows errors
 * and lets the downstream picker filter cards.
 */
async function expandAllStateAccordions(page: Page, log: Logger): Promise<void> {
  const accordionRe = /^\s*[A-Za-z][A-Za-z '&-]{3,}\s*\(\s*[1-9]\d*\s*\)\s*$/;
  const accordions = page
    .locator('button, [role="button"], summary, [aria-expanded]')
    .filter({ hasText: accordionRe });
  const total = await accordions.count().catch(() => 0);
  log(`  · expanding ${total} state accordion(s) so store cards are visible`);
  for (let i = 0; i < total; i++) {
    const acc = accordions.nth(i);
    if (!(await acc.isVisible().catch(() => false))) continue;
    const expanded = (await acc.getAttribute('aria-expanded').catch(() => null)) === 'true';
    if (expanded) continue;
    await acc.scrollIntoViewIfNeeded().catch(() => undefined);
    await acc.click({ force: true }).catch(() => undefined);
  }
}
