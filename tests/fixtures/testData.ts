export interface BuyerDetails {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export type ShippingRegion = 'AU' | 'NZ' | 'SG';
export type ShippingMethod = 'standard' | 'express' | 'international' | 'cnc';
export type UserType = 'logged-in' | 'new-user' | 'guest-existing-email';
export type PaymentMethod = 'credit-card' | 'paypal' | 'afterpay' | 'gpay' | 'applepay';

/**
 * Full country name matching the option label in the checkout's country select.
 */
export const countryLabel: Record<ShippingRegion, string> = {
  AU: 'Australia',
  NZ: 'New Zealand',
  SG: 'Singapore',
};

/**
 * Returns a random 3-character search string — either 3 lowercase letters
 * or 3 digits (50/50). Fed into the site's address-finder autocomplete,
 * which is country-scoped by the country selector.
 */
export function randomAddressSearch(): string {
  const useDigits = Math.random() < 0.5;
  if (useDigits) {
    return String(Math.floor(Math.random() * 900) + 100); // 100..999
  }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 3; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

/** 12 random digits — the KWH phone field accepts any numeric string. */
export function randomPhoneNumber(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/**
 * Returns a random address at a disposable-inbox domain. YOPMail auto-
 * provisions inboxes on demand (no signup) at https://yopmail.com — any
 * address ending in @yopmail.com is real and receives mail. Override the
 * domain with `TEMP_EMAIL_DOMAIN` if you prefer mail.tm, sharklasers, etc.
 */
export function randomTempEmail(): string {
  const domain = process.env.TEMP_EMAIL_DOMAIN ?? 'yopmail.com';
  const rand = Math.random().toString(36).slice(2, 10);
  return `kwhtest-${Date.now()}-${rand}@${domain}`;
}

export function guestBuyer(overrides: Partial<BuyerDetails> = {}): BuyerDetails {
  return {
    firstName: 'QA',
    lastName: 'Tester',
    email: process.env.GUEST_EXISTING_EMAIL || process.env.TEST_USER_EMAIL || 'qa2000tester@gmail.com',
    phone: randomPhoneNumber(),
    ...overrides,
  };
}

export function newUserBuyer(): BuyerDetails & { password: string } {
  const unique = Date.now();
  return {
    ...guestBuyer(),
    email: randomTempEmail(),
    password: `Kwh!Test${unique}`,
  };
}

export const existingGuestEmail = () => process.env.GUEST_EXISTING_EMAIL ?? '';

/**
 * Listing path used when a caller opts for listing-based random picks
 * (e.g. `cartPage.addRandomProductFromListing()`). Search-based random
 * picking (the default) does not read this. Override via
 * `PRODUCT_LISTING_PATH`.
 */
export const productListingPath = () => process.env.PRODUCT_LISTING_PATH ?? '/clearance';

/**
 * Kitchen-related search terms fed into the site search. One is picked at
 * random per product add so runs cover a wide slice of the catalog. Override
 * via `KITCHEN_SEARCH_TERMS` (comma-separated) to focus a run on specific
 * words (e.g. higher-price categories for the >200 AUD gift-card test).
 */
export const KITCHEN_SEARCH_TERMS: string[] = (process.env.KITCHEN_SEARCH_TERMS
  ? process.env.KITCHEN_SEARCH_TERMS.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'napkins',
      'water bottle',
      'casserole',
      'lids',
      'pans',
      'knives',
      'glasses',
      'plates',
      'kitchen',
      'wolstead',
      'chopping board',
      'baking tray',
      'saucepan',
      'wok',
      'mixing bowl',
      'coffee',
      'kettle',
      'toaster',
      'cutlery',
    ]);

export function randomKitchenSearchTerm(): string {
  return KITCHEN_SEARCH_TERMS[Math.floor(Math.random() * KITCHEN_SEARCH_TERMS.length)];
}

/**
 * Every KWH gift card caps at 200 AUD. To exercise the "gift card + CC for
 * remainder" flow, cart total must be strictly greater than the cap.
 */
export const GIFT_CARD_MAX_AUD = 200;
