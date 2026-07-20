import { Page } from '@playwright/test';
import type { Logger } from './loginPromptFlow';

/** Any status that means "not fully in stock — skip this store." */
const NOT_IN_STOCK_RE = /out of stock|limited stock|low stock|unavailable|no stock/i;
/** The only positive stock signal we accept. */
const IN_STOCK_RE = /\bin\s*stock\b/i;
/** Top-of-page delivery-mode radio (Ship / Standard / Express / CNC), NOT a store card. */
const MODE_LABEL_RE =
  /^\s*(ship|standard( shipping)?|express( shipping)?|click\s*(&|and)\s*collect)(\s*(free|\$[\d.]+))?\s*$/i;
const AU_ADDRESS_RE = /\b(?:ACT|NSW|VIC|QLD|SA|WA|TAS|NT)[, ]+\d{4}\b/;

/**
 * Fast path for the main-page CNC layout: KWH lists the 3 nearest stores
 * that already have stock (heading "There are N stores with stock close
 * to your location"). Any of those cards is safe to click — the site
 * already filtered them for stock. Returns null if the heading / cards
 * aren't visible so the caller can fall back to the drawer flow.
 */
export async function pickFromMainPageStoreCards(page: Page, log: Logger): Promise<string | null> {
  const heading = page
    .getByText(/\d+ stores? with stock close to your location/i)
    .first();
  if (!(await heading.isVisible({ timeout: 2_500 }).catch(() => false))) {
    return null;
  }
  log('  · main-page CNC store cards visible ("N stores with stock close to your location")');

  const cards = page
    .locator('li, article, section, div, button, [role="button"], label')
    .filter({ hasText: AU_ADDRESS_RE });
  const total = await cards.count().catch(() => 0);
  log(`  · ${total} store-card candidate(s)`);

  const seen = new Set<string>();
  for (let i = total - 1; i >= 0; i--) {
    const card = cards.nth(i);
    if (!(await card.isVisible().catch(() => false))) continue;
    const text = ((await card.textContent().catch(() => null)) ?? '').trim();
    if (!text) continue;
    const addressMatches = text.match(new RegExp(AU_ADDRESS_RE, 'g')) ?? [];
    if (addressMatches.length !== 1) continue;
    const firstLine = text.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? '';
    if (MODE_LABEL_RE.test(firstLine)) continue;
    if (seen.has(firstLine)) continue;
    seen.add(firstLine);
    // No IN_STOCK filter here — the heading guarantees all three cards
    // are in stock.
    log(`  → clicking main-page store card "${firstLine.slice(0, 60)}"`);
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    await card.click({ force: true });
    return firstLine;
  }
  return null;
}

/**
 * In the "Check store stock" drawer, pick the smallest store card that
 * contains an explicit "In stock" AND no "Out of stock" / "Limited
 * stock" / "Low stock" markers. Deepest-first traversal so we click a
 * single-store container, not an ancestor wrapping multiple. Returns
 * null if no card qualifies — the caller should throw rather than pick
 * a non-in-stock store.
 */
export async function pickInStockStoreInDrawer(page: Page, log: Logger): Promise<string | null> {
  // KWH fetches each store's inventory asynchronously after the drawer
  // opens. Wait until at least a few stock indicators have rendered
  // before scanning — otherwise every card looks "no-in-stock-signal".
  await waitForStockSignalsToLoad(page, log);

  // Direct DOM scan: find the smallest ancestor of each "In stock" text
  // node that contains a single AU state+postcode address. That ancestor
  // is the store card. Tags a `data-cnc-target` attribute on candidates
  // so Playwright can then click them by locator. Playwright's own
  // filter({hasText, has}) sometimes misses cross-subtree layouts KWH
  // uses (e.g. status badge rendered as a sibling of the address block).
  const picks = await page.evaluate(() => {
    const AU_ADDRESS = /\b(?:ACT|NSW|VIC|QLD|SA|WA|TAS|NT)[, ]+\d{4}\b/;
    const AU_ADDRESS_G = /\b(?:ACT|NSW|VIC|QLD|SA|WA|TAS|NT)[, ]+\d{4}\b/g;
    const IN_STOCK = /\bin\s*stock\b/i;
    const BAD_STOCK = /out of stock|limited stock|low stock|unavailable|no stock/i;
    const MODE_LABEL =
      /^\s*(ship|standard( shipping)?|express( shipping)?|click\s*(&|and)\s*collect)(\s*(free|\$[\d.]+))?\s*$/i;

    // Clean any tags from a prior scan.
    document
      .querySelectorAll('[data-cnc-target]')
      .forEach((el) => el.removeAttribute('data-cnc-target'));

    const collected: Array<{ heading: string; targetIdx: number; badge: string }> = [];
    let uid = 0;

    const inStockNodes: HTMLElement[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent ?? '';
      if (IN_STOCK.test(t) && !BAD_STOCK.test(t)) {
        const parent = (n as Text).parentElement;
        if (parent) inStockNodes.push(parent);
      }
    }

    for (const inStockEl of inStockNodes) {
      let node: HTMLElement | null = inStockEl;
      while (node) {
        const text = node.textContent ?? '';
        const addrs = text.match(AU_ADDRESS_G) ?? [];
        if (addrs.length === 1 && AU_ADDRESS.test(text)) {
          // Skip mode-radio-shaped containers.
          const firstLine = text.replace(/\s+/g, ' ').trim().slice(0, 60);
          if (MODE_LABEL.test(firstLine)) break;
          // Skip if the container also matches a bad-stock signal —
          // means multiple stock indicators, some bad.
          if (BAD_STOCK.test(text)) break;
          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) break;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') break;
          const key = ++uid;
          node.setAttribute('data-cnc-target', String(key));
          const heading =
            node.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')?.textContent?.trim() ??
            firstLine.split(/[,·•\d]/)[0].trim() ??
            '(store)';
          collected.push({ heading: heading.slice(0, 60), targetIdx: key, badge: 'in-stock' });
          break;
        }
        node = node.parentElement;
      }
    }
    return collected;
  });

  log(`  · in-stock store candidate(s) found: ${picks.length}`);
  if (picks.length === 0) return null;

  const decisions = picks
    .map((p) => `"${p.heading}"`)
    .slice(0, 6)
    .join(' | ');
  log(`  · candidates: ${decisions}`);

  const target = page.locator(`[data-cnc-target="${picks[0].targetIdx}"]`).first();
  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  log(`  → clicking in-stock store "${picks[0].heading}"`);
  await target.click({ force: true });
  return picks[0].heading;
}

/**
 * The "Check store stock" drawer has a red "Confirm pickup store" button
 * pinned at the bottom. Selecting a store card enables it; clicking it
 * closes the drawer and applies the choice on the main checkout.
 */
export async function confirmPickupStore(page: Page, log: Logger): Promise<void> {
  const confirm = page
    .getByRole('button', { name: /confirm (pickup |pick-up )?store/i })
    .or(page.locator('button, [role="button"]').filter({ hasText: /^\s*confirm (pickup|pick-up)?\s*store\s*$/i }))
    .first();
  if (!(await confirm.isVisible({ timeout: 3_000 }).catch(() => false))) {
    log('  · no "Confirm pickup store" button visible — assuming card click was auto-applied');
    return;
  }
  const enabled = await confirm.isEnabled().catch(() => true);
  log(`  → clicking "Confirm pickup store" (enabled=${enabled})`);
  await confirm.scrollIntoViewIfNeeded().catch(() => undefined);
  await confirm.click({ force: true });
  await confirm.waitFor({ state: 'hidden', timeout: 6_000 }).catch(() => undefined);
  await page
    .getByText(/check store stock|please select a store where all products are in stock/i)
    .first()
    .waitFor({ state: 'hidden', timeout: 4_000 })
    .catch(() => undefined);
  log('  ✓ drawer closed, store selection applied');
}

/**
 * Wait for the drawer's async per-store inventory calls to render stock
 * status text on the cards. Polls every 500 ms up to 15 s. Returns when
 * a majority of stores have signals so the scanner has real data.
 */
async function waitForStockSignalsToLoad(page: Page, log: Logger): Promise<void> {
  const stockSignal = page.getByText(/in stock|out of stock|limited stock|low stock/i);
  const startCount = await stockSignal.count().catch(() => 0);
  log(`  · waiting for per-store stock signals to load (start: ${startCount})`);
  let last = startCount;
  // 20 × 400ms = 8s max — KWH stock APIs typically respond in 2–4s.
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(400);
    const now = await stockSignal.count().catch(() => 0);
    if (now >= 5 && now === last) {
      log(`  · ${now} stock signals visible — proceeding to scan`);
      return;
    }
    last = now;
  }
  log(`  · stock-signal wait finished (${last} visible) — scanning anyway`);
}

/** Debug dump used when the store picker can't find a qualifying card. */
export async function logCncPageSnapshot(page: Page, log: Logger): Promise<void> {
  const clickables = await page
    .locator('button, [role="button"], a, [role="link"], input[type="submit"], input[type="button"]')
    .allTextContents()
    .catch(() => []);
  log(
    `  ! nearby clickables: ` +
      clickables
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .filter((s) => s && s.length < 80)
        .slice(0, 20)
        .join(' | '),
  );
  const cardish = await page
    .locator('li, article, div[role="listitem"]')
    .allTextContents()
    .catch(() => []);
  log(
    `  ! cardish containers (first 3): ` +
      cardish
        .map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 80))
        .filter(Boolean)
        .slice(0, 3)
        .join(' || '),
  );
}
