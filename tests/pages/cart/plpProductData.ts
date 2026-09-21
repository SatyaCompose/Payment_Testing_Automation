import { Page } from '@playwright/test';
import type { Logger } from './ageRestriction';
import type { ShippingMethod } from '../../fixtures/testData';

/** Per-store stock entry from the embedded product-list data. */
export interface PlpStockStatusEntry {
  id?: string;
  name?: string;
  availability?: number;
  channelType?: string;
}

/**
 * One product entry read from the search/listing page's embedded
 * `__NEXT_DATA__` payload. This is third-party page data, not our schema —
 * every field is optional here even though KWH usually populates them, so
 * a page-data shape change degrades gracefully instead of throwing.
 */
export interface PlpProduct {
  name: string;
  productUrl: string;
  productSku?: string;
  productCode?: string;
  availInternationalShipping?: boolean;
  isAvailableOnline?: boolean;
  isAvailableInStore?: boolean;
  dropShipItem?: boolean;
  availableQuantity?: number;
  storeChannelsAvailableQuantity?: number;
  warehouseChannelsAvailableQuantity?: number;
  stockStatus?: PlpStockStatusEntry[];
  buyBoxCNCMessage?: { text?: string; isInStock?: boolean; isLowStock?: boolean; isOutOfStock?: boolean };
  buyBoxDTDMessage?: { isInStock?: boolean; isOutOfStock?: boolean };
  isInactive?: boolean;
  hide?: boolean;
  isGiftCard?: boolean;
  allowPreOrder?: boolean;
  productClearanceFlag?: boolean;
  restrictedKnife?: boolean;
  onlineOnly?: boolean;
}

export interface PlpChoice {
  productUrl: string;
  name: string;
  /** Human-readable reason the product qualified — for logging. */
  reason: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Reads the search/listing page's embedded Next.js data and returns its
 * product list. KWH nests it at
 * `props.pageProps.data.data.dataSources.<guid>.productList` — the GUID
 * key varies per render (confirmed live against /search?q=coffee), so
 * every `dataSources` entry is scanned for the first one carrying a
 * `productList` array rather than hard-coding the key. Never throws —
 * any shape mismatch returns an empty list so the caller can fall back
 * (fresh search term / different requirement outcome) instead of the
 * whole flow dying on a page-data change.
 */
export async function readPlpProductList(page: Page, log: Logger): Promise<PlpProduct[]> {
  const raw = await page
    .locator('#__NEXT_DATA__')
    .textContent()
    .catch(() => null);
  if (!raw) {
    log('  · no #__NEXT_DATA__ script found on this page');
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`  · #__NEXT_DATA__ was not valid JSON: ${(err as Error).message}`);
    return [];
  }

  const dataSources = asRecord(
    asRecord(asRecord(asRecord(parsed)?.props)?.pageProps)?.data,
  );
  const sources = asRecord(asRecord(dataSources?.data)?.dataSources);
  if (!sources) {
    log('  · __NEXT_DATA__ has no props.pageProps.data.data.dataSources object');
    return [];
  }

  for (const key of Object.keys(sources)) {
    const entry = asRecord(sources[key]);
    const list = entry?.productList;
    if (Array.isArray(list)) {
      const products = list.map(normalizeProduct).filter((p): p is PlpProduct => p !== null);
      log(
        `  · found productList under dataSources["${key}"] — ${list.length} raw entr${
          list.length === 1 ? 'y' : 'ies'
        }, ${products.length} usable`,
      );
      return products;
    }
  }
  log('  · no dataSources entry carries a productList array');
  return [];
}

function normalizeProduct(raw: unknown): PlpProduct | null {
  const r = asRecord(raw);
  const name = asStr(r?.name);
  const productUrl = asStr(r?.productUrl);
  if (!r || !name || !productUrl) return null;

  const stockStatus = Array.isArray(r.stockStatus)
    ? r.stockStatus
        .map((s) => asRecord(s))
        .filter((s): s is Record<string, unknown> => s !== undefined)
        .map((s) => ({
          id: asStr(s.id),
          name: asStr(s.name),
          availability: asNum(s.availability),
          channelType: asStr(s.channelType),
        }))
    : undefined;

  const cnc = asRecord(r.buyBoxCNCMessage);
  const dtd = asRecord(r.buyBoxDTDMessage);

  return {
    name,
    productUrl,
    productSku: asStr(r.productSku),
    productCode: asStr(r.productCode),
    availInternationalShipping: asBool(r.availInternationalShipping),
    isAvailableOnline: asBool(r.isAvailableOnline),
    isAvailableInStore: asBool(r.isAvailableInStore),
    dropShipItem: asBool(r.dropShipItem),
    availableQuantity: asNum(r.availableQuantity),
    storeChannelsAvailableQuantity: asNum(r.storeChannelsAvailableQuantity),
    warehouseChannelsAvailableQuantity: asNum(r.warehouseChannelsAvailableQuantity),
    stockStatus,
    buyBoxCNCMessage: cnc
      ? {
          text: asStr(cnc.text),
          isInStock: asBool(cnc.isInStock),
          isLowStock: asBool(cnc.isLowStock),
          isOutOfStock: asBool(cnc.isOutOfStock),
        }
      : undefined,
    buyBoxDTDMessage: dtd ? { isInStock: asBool(dtd.isInStock), isOutOfStock: asBool(dtd.isOutOfStock) } : undefined,
    isInactive: asBool(r.isInactive),
    hide: asBool(r.hide),
    isGiftCard: asBool(r.isGiftCard),
    allowPreOrder: asBool(r.allowPreOrder),
    productClearanceFlag: asBool(r.productClearanceFlag),
    restrictedKnife: asBool(r.restrictedKnife),
    onlineOnly: asBool(r.onlineOnly),
  };
}

/** Flags that disqualify a product regardless of shipping method. */
function isBaseEligible(p: PlpProduct): boolean {
  if (p.isInactive) return false;
  if (p.hide) return false;
  if (p.isGiftCard) return false; // gift cards have their own suite
  if (p.allowPreOrder) return false;
  return true;
}

function isOutOfStockOnline(p: PlpProduct): boolean {
  return p.buyBoxDTDMessage?.isOutOfStock === true;
}

/**
 * Returns a human-readable qualification reason if `p` satisfies
 * `requirement`, else null. Rules (see plpProductData task write-up):
 *  - international (3.x NZ / 4.x SG): ships internationally, available
 *    online, not out of stock.
 *  - cnc (5.x): CNC buy-box reports in stock AND at least one store's
 *    `stockStatus` entry has positive availability.
 *  - express (2.x): available online and explicitly not a dropship item
 *    — same two conditions the PLP "Express delivery available" facet
 *    already enforces; this is a second, data-backed confirmation.
 *  - standard (1.x): available online, not out of stock.
 */
function qualifyingReason(p: PlpProduct, requirement: ShippingMethod): string | null {
  switch (requirement) {
    case 'international': {
      if (p.availInternationalShipping !== true) return null;
      if (p.isAvailableOnline === false) return null;
      if (isOutOfStockOnline(p)) return null;
      return `availInternationalShipping=true, isAvailableOnline=${p.isAvailableOnline}, not out of stock`;
    }
    case 'cnc': {
      if (p.buyBoxCNCMessage?.isInStock !== true) return null;
      const storeHit = (p.stockStatus ?? []).find(
        (s) => s.channelType === 'Store' && typeof s.availability === 'number' && s.availability > 0,
      );
      if (!storeHit) return null;
      return `buyBoxCNCMessage.isInStock=true, in-stock store "${storeHit.name ?? storeHit.id ?? '?'}" (qty ${storeHit.availability})`;
    }
    case 'express': {
      if (p.isAvailableOnline === false) return null;
      if (p.dropShipItem !== false) return null;
      return `isAvailableOnline=${p.isAvailableOnline}, dropShipItem=false`;
    }
    case 'standard':
    default: {
      if (p.isAvailableOnline === false) return null;
      if (isOutOfStockOnline(p)) return null;
      return `isAvailableOnline=${p.isAvailableOnline}, not out of stock`;
    }
  }
}

/**
 * Picks the first product satisfying `requirement`. Returns null (never
 * throws) so the caller can try a different search term rather than
 * silently buying whatever came up first — a test that adds an
 * unsuitable product and discovers it mid-checkout is a false pass.
 */
export function chooseQualifyingProduct(
  products: PlpProduct[],
  requirement: ShippingMethod,
  log: Logger,
): PlpChoice | null {
  const eligible = products.filter(isBaseEligible);
  log(
    `  · ${products.length} product(s) read from the embedded list, ${eligible.length} pass base eligibility (active/visible/not-gift-card/not-preorder)`,
  );
  for (const p of eligible) {
    const reason = qualifyingReason(p, requirement);
    if (reason) {
      return { productUrl: p.productUrl, name: p.name, reason };
    }
  }
  return null;
}

/** Convenience: read the page's embedded product list, then choose. */
export async function pickQualifyingProductFromPlp(
  page: Page,
  log: Logger,
  requirement: ShippingMethod,
): Promise<PlpChoice | null> {
  const products = await readPlpProductList(page, log);
  if (products.length === 0) return null;
  return chooseQualifyingProduct(products, requirement, log);
}
