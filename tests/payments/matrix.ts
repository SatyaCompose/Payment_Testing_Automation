import type {
  PaymentMethod,
  ShippingMethod,
  ShippingRegion,
  UserType,
} from '../fixtures/testData';

/**
 * Single source of truth for the checkout happy-path test matrix.
 *
 * Sections 1–5 are the "cookie-cutter" matrix — every payment method
 * (CC, PayPal, Afterpay, GPay, ApplePay) runs the same 3 user-types per
 * section. Sections 6–8 (discounts, cross-payment retry, riskified) are
 * one-off scenarios and are declared inline in their own spec files.
 *
 * Both the spec factory (`checkoutMatrixSpec.ts`) and the run report
 * (`globalTeardown.ts`) read from these constants so folder names, test
 * ids, and section headings stay in sync.
 */

export interface MatrixSection {
  section: number;
  shipping: ShippingMethod;
  region: ShippingRegion;
  /** Human-readable label for the describe title (e.g. "AU · Standard shipping"). */
  label: string;
  /** Short parenthetical suffix in test titles (e.g. "Standard", "NZ"). */
  short: string;
  /** Slug embedded in screenshot folder names (e.g. "au-standard", "nz", "cnc"). */
  folderTag: string;
  /** Section heading used in the final teardown report. */
  reportHeading: string;
}

export const CHECKOUT_MATRIX: readonly MatrixSection[] = [
  {
    section: 1,
    shipping: 'standard',
    region: 'AU',
    label: 'AU · Standard shipping',
    short: 'Standard',
    folderTag: 'au-standard',
    reportHeading: 'Australia Shipping Methods · Standard',
  },
  {
    section: 2,
    shipping: 'express',
    region: 'AU',
    label: 'AU · Express shipping',
    short: 'Express',
    folderTag: 'au-express',
    reportHeading: 'Express Shipping',
  },
  {
    section: 3,
    shipping: 'international',
    region: 'NZ',
    label: 'International · New Zealand',
    short: 'NZ',
    folderTag: 'nz',
    reportHeading: 'International Shipping (New Zealand)',
  },
  {
    section: 4,
    shipping: 'international',
    region: 'SG',
    label: 'International · Singapore',
    short: 'SG',
    folderTag: 'sg',
    reportHeading: 'International Shipping (Singapore)',
  },
  {
    section: 5,
    shipping: 'cnc',
    region: 'AU',
    label: 'Click & Collect',
    short: 'CNC',
    folderTag: 'cnc',
    reportHeading: 'Click & Collect',
  },
];

export interface MatrixUserType {
  /** Position within the section — becomes the "M" in the "N.M" test id. */
  idx: number;
  userType: UserType;
  /** Human-readable phrase used in the test title. */
  titlePhrase: string;
  /** Slug embedded in screenshot folder names (e.g. "logged-in"). */
  folderSlug: string;
  /** Env var that must be present for this row to run — null means always. */
  envGuard: string | null;
  /** Short label used in the report. */
  reportLabel: string;
}

export const USER_TYPES: readonly MatrixUserType[] = [
  {
    idx: 1,
    userType: 'logged-in',
    titlePhrase: 'Logged-in checkout',
    folderSlug: 'logged-in',
    envGuard: 'TEST_USER_EMAIL',
    reportLabel: 'Logged-In',
  },
  {
    idx: 2,
    userType: 'new-user',
    titlePhrase: 'Newly registered user checkout',
    folderSlug: 'new-user',
    envGuard: null,
    reportLabel: 'Newly Registered User',
  },
  {
    idx: 3,
    userType: 'guest-existing-email',
    titlePhrase: 'Guest (existing email) checkout',
    folderSlug: 'guest-existing',
    envGuard: 'GUEST_EXISTING_EMAIL',
    reportLabel: 'Guest (Existing Email)',
  },
];

export interface PaymentMethodDescriptor {
  method: PaymentMethod;
  /** Prefix used in describe titles (e.g. "CC"). */
  shortLabel: string;
  /** Long label used inside test titles (e.g. "Credit Card"). */
  longLabel: string;
  /** Slug embedded in screenshot folder names (e.g. "cc"). */
  folderSlug: string;
  /** Playwright browserName values to skip (e.g. Google Pay doesn't
   *  run on WebKit, Apple Pay only runs on WebKit). */
  skipBrowsers?: readonly string[];
  /** Env var that must be present for this method to run — auto-skip
   *  when absent (e.g. PAYPAL_SANDBOX_EMAIL for PayPal). */
  envGuard?: string;
  /** Minimum cart total AUD required by the provider. Afterpay refuses
   *  orders < $100, so the flow must add products until the total
   *  clears this threshold before Place Order becomes enabled. */
  minCartTotalAud?: number;
}

export const PAYMENT_METHODS: Record<PaymentMethod, PaymentMethodDescriptor> = {
  'credit-card': { method: 'credit-card', shortLabel: 'CC', longLabel: 'Credit Card', folderSlug: 'cc' },
  paypal: { method: 'paypal', shortLabel: 'PP', longLabel: 'PayPal', folderSlug: 'pp', envGuard: 'PAYPAL_SANDBOX_EMAIL' },
  afterpay: { method: 'afterpay', shortLabel: 'AP', longLabel: 'Afterpay', folderSlug: 'ap', envGuard: 'AFTERPAY_SANDBOX_EMAIL', minCartTotalAud: 100 },
  gpay: { method: 'gpay', shortLabel: 'GP', longLabel: 'Google Pay', folderSlug: 'gp', skipBrowsers: ['webkit'] },
  applepay: { method: 'applepay', shortLabel: 'AP-A', longLabel: 'Apple Pay', folderSlug: 'apay' },
};

export function screenshotFolder(
  section: MatrixSection,
  user: MatrixUserType,
  payment: PaymentMethodDescriptor,
): string {
  return `${section.section}.${user.idx}-${payment.folderSlug}-${section.folderTag}-${user.folderSlug}`;
}

export function testId(section: MatrixSection, user: MatrixUserType): string {
  return `${section.section}.${user.idx}`;
}
