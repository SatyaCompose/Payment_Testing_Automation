import { Page, Locator } from '@playwright/test';
import type { BuyerDetails, ShippingRegion } from '../../fixtures/testData';
import { pickAddress } from './addressPicker';
import type { Logger } from './loginPromptFlow';

/**
 * Fills a field only if it exists, is visible, and is currently empty.
 * Logs pre-fills so a "why isn't this typed?" diagnosis is one line away.
 */
export async function fillIfPresent(
  log: Logger,
  locator: Locator,
  value: string,
  label: string,
): Promise<void> {
  const present = (await locator.count().catch(() => 0)) > 0 && (await locator.isVisible().catch(() => false));
  if (!present) {
    log(`  → no ${label} field on this step — skipping`);
    return;
  }
  const current = (await locator.inputValue().catch(() => '')) ?? '';
  if (current.trim()) {
    log(`  → ${label} already filled: "${current.slice(0, 40)}" — skipping`);
    return;
  }
  await locator.fill(value);
}

/**
 * Fills first name / last name / phone. If any field is already
 * populated (logged-in users often have these pre-filled), the field
 * is left alone.
 */
export async function fillContactAndName(page: Page, log: Logger, buyer: BuyerDetails): Promise<void> {
  log(`step 2 · fill name = ${buyer.firstName} ${buyer.lastName}  phone = ${buyer.phone}`);
  await fillIfPresent(log, page.getByLabel(/first name|given name|forename/i).first(), buyer.firstName, 'first name');
  await fillIfPresent(log, page.getByLabel(/last name|surname|family name/i).first(), buyer.lastName, 'last name');
  await fillIfPresent(log, page.getByLabel(/phone|mobile/i).first(), buyer.phone, 'phone');
}

/**
 * Ensures "My billing address is the same as my shipping address" is
 * ticked. Tries native check(), verifies the state, falls back to
 * clicking the label, then to a JS-native click on the checkbox.
 */
export async function ensureBillingSameAsShipping(page: Page, log: Logger): Promise<void> {
  // Multiple locators — the DOM shape varies.
  const byRole = page.getByRole('checkbox', {
    name: /billing.*same|same.*shipping|same as my shipping/i,
  });
  const byLabel = page.getByLabel(
    /my billing address is the same as my shipping|billing.*same.*shipping/i,
  );
  const byInputInLabel = page.locator('label:has-text("billing")').locator('input[type="checkbox"]');
  const checkbox = byRole.or(byLabel).or(byInputInLabel).first();

  if (!(await checkbox.count().catch(() => 0))) {
    log('  → no billing-same-as-shipping checkbox on page — skipping');
    return;
  }

  const isCheckedNow = async () =>
    (await checkbox.isChecked().catch(() => false)) ||
    (await checkbox.evaluate((el: HTMLInputElement) => el.checked).catch(() => false));

  if (await isCheckedNow()) {
    log('  → billing = shipping (checkbox already ticked)');
    return;
  }

  log('  → billing checkbox is unchecked, ticking it now');

  // 1. Playwright's check() — cleanest path.
  await checkbox.check({ force: true, timeout: 5_000 }).catch(() => undefined);
  if (await isCheckedNow()) {
    log('    ✓ ticked via check()');
    return;
  }

  // 2. Click the enclosing label (custom checkboxes hide the real input).
  const label = page
    .locator('label')
    .filter({ hasText: /billing.*same.*shipping|same.*shipping.*billing/i })
    .first();
  if (await label.count().catch(() => 0)) {
    await label.click({ force: true }).catch(() => undefined);
    if (await isCheckedNow()) {
      log('    ✓ ticked via label click');
      return;
    }
  }

  // 3. Fire a native DOM click on the checkbox.
  await checkbox.evaluate((el: HTMLInputElement) => el.click()).catch(() => undefined);
  if (await isCheckedNow()) {
    log('    ✓ ticked via JS click');
    return;
  }

  log('    ! could NOT tick the billing checkbox — proceeding anyway');
}

/**
 * Uncheck "billing = shipping" and fill the separate billing block
 * that appears (first / last name / phone / address). Used only when
 * a test explicitly wants a different billing address.
 */
export async function fillDifferentBillingAddress(
  page: Page,
  log: Logger,
  buyer: BuyerDetails,
  region: ShippingRegion,
): Promise<void> {
  log('step 2 · unchecking "billing same as shipping" and filling billing block');
  const checkbox = page
    .getByRole('checkbox', { name: /billing.*same|same.*shipping|same as my shipping/i })
    .or(page.getByLabel(/my billing address is the same as my shipping address/i))
    .first();
  if (await checkbox.isChecked().catch(() => false)) {
    await checkbox.uncheck({ force: true });
  }

  // The billing block appears with its own First / Last / Phone / Address
  // fields, scoped under a "Billing Address" section.
  const billingSection = page
    .locator(':is(section, div, form):has-text("Billing Address")')
    .last();
  const billingFirst = billingSection.getByLabel(/first name/i).first();
  const billingLast = billingSection.getByLabel(/last name/i).first();
  const billingPhone = billingSection.getByLabel(/phone|mobile/i).first();
  await fillIfPresent(log, billingFirst, buyer.firstName, 'billing first name');
  await fillIfPresent(log, billingLast, buyer.lastName, 'billing last name');
  await fillIfPresent(log, billingPhone, buyer.phone, 'billing phone');

  // Reuse the address picker; it types into the visible "Address*"
  // input. When the billing block is open, the picker targets the
  // billing address input because it's the second on the page — the
  // shipping input is already filled.
  await pickAddress(page, log, region);
}
