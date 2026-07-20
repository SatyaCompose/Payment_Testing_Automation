import { Page } from '@playwright/test';
import type { BuyerDetails } from '../../fixtures/testData';
import type { Logger } from './loginPromptFlow';
import { fillIfPresent } from './billingSection';

const PICKUP_HEADING_RE = /who will pick up your order|pick ?up (details|contact)|collection contact/i;
const BILLING_HEADING_RE = /billing address/i;

function pickupSection(page: Page) {
  return page.locator(':is(section, div, form, fieldset)').filter({ hasText: PICKUP_HEADING_RE }).last();
}

function billingSection(page: Page) {
  return page.locator(':is(section, div, form, fieldset)').filter({ hasText: BILLING_HEADING_RE }).last();
}

/**
 * Fills the "Who will pick up your order?" section on the CNC layout —
 * First name, Last name, Phone number. Fields already populated (e.g.
 * for a logged-in user) are left alone.
 */
export async function fillCncPickupContact(page: Page, log: Logger, buyer: BuyerDetails): Promise<void> {
  log('step 2 · fillCncPickupContact');
  const section = pickupSection(page);
  await fillIfPresent(log, section.getByLabel(/first name/i).first(), buyer.firstName, 'pickup first name');
  await fillIfPresent(log, section.getByLabel(/last name/i).first(), buyer.lastName, 'pickup last name');
  await fillIfPresent(log, section.getByLabel(/phone|mobile/i).first(), buyer.phone, 'pickup phone');
}

/**
 * Fills the "Billing Address" section's contact fields on the CNC layout
 * — First name, Last name, Phone number. Address is filled separately
 * via pickCncBillingAddress (autocomplete search).
 */
export async function fillCncBillingContact(page: Page, log: Logger, buyer: BuyerDetails): Promise<void> {
  log('step 2 · fillCncBillingContact');
  const section = billingSection(page);
  await fillIfPresent(log, section.getByLabel(/first name/i).first(), buyer.firstName, 'billing first name');
  await fillIfPresent(log, section.getByLabel(/last name/i).first(), buyer.lastName, 'billing last name');
  await fillIfPresent(log, section.getByLabel(/phone|mobile/i).first(), buyer.phone, 'billing phone');
}
