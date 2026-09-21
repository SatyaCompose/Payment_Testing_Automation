import { Page, Locator, expect } from '@playwright/test';
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
 * A real store card carries a stock status or trading-hours badge. The
 * shipping/billing address block also contains exactly one AU address and was
 * being picked as a "store card", after which the checkout refused to advance
 * because no pickup store had actually been chosen.
 */
const STORE_CARD_SIGNAL_RE = /\bin\s*stock\b|\b(open|closed)\b|\bkm\b|pick ?up/i;

/** Same "selection applied" summary the pre-selected-store fast path checks for. */
const SELECTED_STORE_SUMMARY_RE = /your selected store is|selected store\s*:/i;

/**
 * Fast path for the main-page CNC layout: KWH lists the 3 nearest stores
 * that already have stock (heading "There are N stores with stock close
 * to your location"). Any of those cards is safe to pick — the site
 * already filtered them for stock. Returns null if the heading / cards
 * aren't visible, or nothing could be reliably selected, so the caller
 * can fall back to the drawer flow.
 */
export async function pickFromMainPageStoreCards(page: Page, log: Logger): Promise<string | null> {
  const heading = page
    .getByText(/\d+ stores? with stock close to your location/i)
    .first();
  if (!(await heading.isVisible({ timeout: 2_500 }).catch(() => false))) {
    return null;
  }
  log('  · main-page CNC store cards visible ("N stores with stock close to your location")');

  // Preferred path: the list is a set of radio (or checkbox) inputs whose
  // accessible name is the store name + address. It also re-fetches after
  // the billing address is picked, so give it up to ~10s to settle before
  // deciding nothing is there.
  const controlPick = await pickMainPageStoreControl(page, log);
  if (controlPick) return controlPick;

  log('  · no radio/checkbox-shaped store control selected — falling back to generic card scan');
  return pickMainPageStoreGenericCard(page, log);
}

type ControlKind = 'radio' | 'checkbox' | 'label';

/**
 * Locate the store list as accessible form controls. The main-page list
 * turned out (per the form-state diagnostic) to be real radio inputs whose
 * accessible name is the concatenated store name + address lines — not
 * plain clickable divs — so `getByRole('radio', ...)` is the primary
 * signal. Falls back to checkbox role, then to a `<label>` that wraps a
 * radio/checkbox, in case a given store's markup differs.
 */
async function resolveMainPageStoreControls(
  page: Page,
  log: Logger,
): Promise<{ kind: ControlKind; locator: Locator } | null> {
  const shapes: Array<{ kind: ControlKind; locator: Locator }> = [
    { kind: 'radio', locator: page.getByRole('radio', { name: AU_ADDRESS_RE }) },
    { kind: 'checkbox', locator: page.getByRole('checkbox', { name: AU_ADDRESS_RE }) },
    {
      kind: 'label',
      locator: page
        .locator('label')
        .filter({ hasText: AU_ADDRESS_RE })
        .filter({ has: page.locator('input[type="radio"], input[type="checkbox"]') }),
    },
  ];
  const counts = [0, 0, 0];
  let picked: { kind: ControlKind; locator: Locator } | null = null;

  // Auto-retrying poll (no manual sleeps) — bounded to ~10s so a
  // genuinely-missing list still falls through to the drawer fallback.
  await expect
    .poll(
      async () => {
        for (let i = 0; i < shapes.length; i++) {
          counts[i] = await shapes[i].locator.count().catch(() => 0);
          if (counts[i] > 0 && !picked) picked = shapes[i];
        }
        return picked ? 1 : 0;
      },
      { timeout: 10_000, message: 'waiting for main-page CNC store controls to render' },
    )
    .toBeGreaterThan(0)
    .catch(() => undefined);

  log(
    `  · store-control candidates — radio:${counts[0]} checkbox:${counts[1]} label:${counts[2]}`,
  );
  return picked;
}

/** Read the text a screen reader would announce for a store radio/checkbox. */
async function controlLabelText(control: Locator): Promise<string> {
  return control
    .evaluate((el) => {
      const closestLabel = (el.closest('label') as HTMLLabelElement | null)?.textContent?.trim();
      if (closestLabel) return closestLabel;
      const id = el.getAttribute('id');
      if (id) {
        const forLabel = document
          .querySelector(`label[for="${CSS.escape(id)}"]`)
          ?.textContent?.trim();
        if (forLabel) return forLabel;
      }
      return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
    })
    .catch(() => '');
}

/**
 * Loose match: strip everything except letters/digits and lowercase.
 * The candidate's label text and the "selected store" summary text never
 * match byte-for-byte (different punctuation/whitespace, sometimes a
 * truncated address), so comparisons below use this normalised form
 * rather than an exact substring match.
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * KWH's store-radio label text is several sibling text nodes concatenated
 * with no whitespace between them, e.g. "Majura ParkUnit 2,10 Catalina
 * DriveMajura Park, ACT, 2609Closed" — so a lower-to-upper letter
 * boundary is the only reliable break between "store name", "address
 * line 1", "address line 2", "trading status". Returns the first
 * segment, i.e. the store name.
 */
function extractStoreName(rawText: string): string {
  const segments = rawText
    .split(/(?<=[a-z0-9])(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segments[0] ?? rawText.trim();
}

/**
 * A click/check on the wrong node silently does nothing on this site — so
 * a selection only counts once the app's own state reflects it: either the
 * exact control we interacted with reports checked, or the page's "your
 * selected store is …" summary line is visible AND names this candidate.
 * The summary check is intentionally scoped to `candidateLabelText` —
 * matching the generic phrase alone would also match a late-arriving
 * default-store selection racing in from elsewhere, which is exactly the
 * silent false pass this function exists to prevent. Returns false rather
 * than trusting the click, so the caller falls back to the drawer instead
 * of reporting a store that wasn't really picked.
 */
async function storeSelectionRegistered(
  page: Page,
  control: Locator | null,
  candidateLabelText: string,
): Promise<boolean> {
  if (control) {
    const checked = await control.isChecked({ timeout: 2_000 }).catch(() => false);
    if (checked) return true;
  }
  const candidateName = normalizeForMatch(extractStoreName(candidateLabelText));
  if (!candidateName) return false;
  const summary = page.getByText(SELECTED_STORE_SUMMARY_RE).first();
  if (!(await summary.isVisible({ timeout: 2_000 }).catch(() => false))) return false;
  const summaryText = (await summary.textContent().catch(() => '')) ?? '';
  return normalizeForMatch(summaryText).includes(candidateName);
}

/**
 * A short, best-effort lookup of the visible `<label>` that owns a store
 * control — either an ancestor `<label>`, or one wired via `for="<id>"`.
 * Used as the fallback gesture when `.check()` doesn't register: KWH wires
 * the actual click handler to the label text, not the sr-only input.
 *
 * Resolved via `evaluate` + a throwaway tag attribute (same pattern
 * `scanAndTagInStockStores` uses below) rather than an XPath ancestor
 * selector or a `page.locator('label').filter({ has: control })` union:
 * `control` here is already one specific nth-selected element, and a
 * fresh page-level `has:` filter can't safely re-derive "the same one"
 * through that nth composition. Resolving inside `evaluate` — like
 * `controlLabelText` above already does for text extraction — always
 * operates on the concrete element Playwright already picked out.
 */
async function associatedLabel(page: Page, control: Locator): Promise<Locator | null> {
  const TAG_ATTR = 'data-cnc-label-target';
  const tagged = await control
    .evaluate((el, attr) => {
      document.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr));
      let label = el.closest('label') as HTMLLabelElement | null;
      if (!label) {
        const id = el.getAttribute('id');
        if (id) label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      }
      if (!label) return false;
      label.setAttribute(attr, '1');
      return true;
    }, TAG_ATTR)
    .catch(() => false);
  if (!tagged) return null;
  return page.locator(`[${TAG_ATTR}]`).first();
}

/**
 * Primary path: select a store via its radio/checkbox control. KWH renders
 * these as visually-hidden (`sr-only`) inputs — the same pattern already
 * proven for the Click & Collect tab switch in `selectClickAndCollectTab`
 * (see cncStore.ts) — so a bare `.check()` times out waiting for
 * actionability that never comes; `force: true` is required. Falls back to
 * clicking the control's associated `<label>` (same store name + address
 * text) if the forced check still doesn't register. Timeouts are kept
 * short (~2s) per attempt so 3 candidates never costs more than a few
 * seconds — the drawer fallback must stay cheap to reach on genuine
 * failure, not budget-exhausting.
 */
async function pickMainPageStoreControl(page: Page, log: Logger): Promise<string | null> {
  const resolved = await resolveMainPageStoreControls(page, log);
  if (!resolved) {
    log('  · no radio/checkbox/label-shaped store control rendered within 10s');
    return null;
  }
  const { kind, locator } = resolved;
  const total = await locator.count().catch(() => 0);
  log(`  · using ${kind}-shaped store controls (${total} candidate(s))`);

  const seen = new Set<string>();
  for (let i = 0; i < total; i++) {
    const item = locator.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;

    const control = kind === 'label'
      ? item.locator('input[type="radio"], input[type="checkbox"]').first()
      : item;
    const text = await controlLabelText(control);
    if (!text) continue;

    const firstLine = text.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? text.slice(0, 60);
    // Skip shipping-mode radios ("Ship", "Click and Collect") that also
    // happen to carry an AU address elsewhere on the page.
    if (MODE_LABEL_RE.test(firstLine)) continue;
    if (NOT_IN_STOCK_RE.test(text)) continue;
    if (seen.has(firstLine)) continue;
    seen.add(firstLine);

    log(`  → selecting main-page store control "${firstLine.slice(0, 60)}" (${kind})`);
    await control.scrollIntoViewIfNeeded().catch(() => undefined);

    // sr-only input — force skips the actionability wait that never
    // resolves for a 1x1/clipped element (matches selectClickAndCollectTab).
    let selectedVia = 'check()';
    let actionOk = await control
      .check({ force: true, timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (!actionOk) {
      const label = await associatedLabel(page, control);
      if (label) {
        selectedVia = 'label click';
        actionOk = await label
          .click({ force: true, timeout: 1_500 })
          .then(() => true)
          .catch(() => false);
      }
    }
    if (!actionOk) {
      log(`  · check() and label click both failed on "${firstLine.slice(0, 60)}" — trying next candidate`);
      continue;
    }
    if (!(await storeSelectionRegistered(page, control, text))) {
      log(`  · selection on "${firstLine.slice(0, 60)}" (via ${selectedVia}) did not register — trying next candidate`);
      continue;
    }
    log(`  ✓ selected main-page store "${firstLine.slice(0, 60)}" (${kind} control, via ${selectedVia})`);
    return firstLine;
  }
  return null;
}

/**
 * Secondary path: the original generic-card scan, kept for a layout that
 * isn't radio/checkbox-shaped. Deepest-first so a single-store container
 * is preferred over an ancestor wrapping multiple.
 */
async function pickMainPageStoreGenericCard(page: Page, log: Logger): Promise<string | null> {
  const cards = page
    .locator('li, article, section, div, button, [role="button"], label')
    .filter({ hasText: AU_ADDRESS_RE });
  const total = await cards.count().catch(() => 0);
  log(`  · ${total} generic store-card candidate(s)`);

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
    if (!STORE_CARD_SIGNAL_RE.test(text)) continue;
    if (NOT_IN_STOCK_RE.test(text)) continue;
    // Form fields mean this is the address block, not a store card.
    const formFields = await card
      .locator('input:not([type="radio"]):not([type="checkbox"]), textarea, select')
      .count()
      .catch(() => 0);
    if (formFields > 0) continue;
    if (seen.has(firstLine)) continue;
    seen.add(firstLine);
    // No IN_STOCK filter here — the heading guarantees all three cards
    // are in stock.
    log(`  → clicking generic store card "${firstLine.slice(0, 60)}"`);
    await card.scrollIntoViewIfNeeded().catch(() => undefined);
    await card.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    if (!(await storeSelectionRegistered(page, null, firstLine))) {
      log(`  · click on "${firstLine.slice(0, 60)}" did not register — trying next candidate`);
      continue;
    }
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

  // The drawer re-renders continuously while per-store inventory streams in,
  // so a data-cnc-target tag written by one evaluate is usually gone by the
  // time Playwright clicks it — the locator resolves to nothing and the click
  // burns its timeout. Scan and click inside the SAME evaluate, where no
  // re-render can intervene; only fall back to a Playwright click if that
  // never registers with the app.
  const inPage = await scanAndTagInStockStores(page, true);
  if (inPage.length === 0) return null;
  log(`  · in-stock store candidate(s) found: ${inPage.length}`);
  log(`  · candidates: ${inPage.map((p) => `"${p.heading}"`).slice(0, 6).join(' | ')}`);

  if (inPage[0].clicked && (await selectionRegistered(page))) {
    log(`  ✓ selected in-stock store "${inPage[0].heading}" (in-page click)`);
    return inPage[0].heading;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const picks = await scanAndTagInStockStores(page, false);
    if (picks.length === 0) return null;
    const target = page.locator(`[data-cnc-target="${picks[0].targetIdx}"]`).first();
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    log(`  → clicking in-stock store "${picks[0].heading}" (Playwright attempt ${attempt}/2)`);
    const clicked = await target
      .click({ force: true, timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (clicked) return picks[0].heading;
    log('  · tag went stale before the click (drawer re-rendered) — rescanning');
  }

  return null;
}

/**
 * A store card click is only real if the drawer's "Confirm pickup store" action
 * becomes available — an in-page click that the app ignored leaves it disabled.
 */
async function selectionRegistered(page: Page): Promise<boolean> {
  const confirm = page
    .getByRole('button', { name: /confirm pickup store|confirm store|confirm/i })
    .first();
  if (!(await confirm.isVisible({ timeout: 3_000 }).catch(() => false))) return false;
  return confirm.isEnabled().catch(() => false);
}

interface StorePick {
  heading: string;
  targetIdx: number;
  badge: string;
  clicked: boolean;
}

/**
 * Scans the drawer for in-stock store cards and tags them with
 * `data-cnc-target`. With `clickFirst` the best candidate is also clicked
 * in-page, inside the same JS turn as the scan — the only way to act on a node
 * that a re-render may detach a moment later.
 */
async function scanAndTagInStockStores(page: Page, clickFirst: boolean): Promise<StorePick[]> {
  return page.evaluate((doClick: boolean) => {
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

    const collected: Array<{
      heading: string;
      targetIdx: number;
      badge: string;
      clicked: boolean;
    }> = [];
    const nodesByKey = new Map<number, HTMLElement>();
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
          nodesByKey.set(key, node);
          const heading = (
            node.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')?.textContent?.trim() ??
            firstLine.split(/[,·•\d]/)[0].trim() ??
            '(store)'
          )
            // The trading-status badge is rendered inside the heading on
            // this drawer ("Majura Park" + "Closed") — strip it so the log
            // names the store rather than its opening hours.
            .replace(/\s*(closed|now open|open( now)?)\s*$/i, '')
            .trim();
          collected.push({
            heading: heading.slice(0, 60) || '(store)',
            targetIdx: key,
            badge: 'in-stock',
            clicked: false,
          });
          break;
        }
        node = node.parentElement;
      }
    }

    if (doClick && collected.length > 0) {
      const first = nodesByKey.get(collected[0].targetIdx);
      if (first) {
        first.scrollIntoView({ block: 'center' });
        first.click();
        collected[0].clicked = true;
      }
    }
    return collected;
  }, clickFirst);
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
