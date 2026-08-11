import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import type { BuyerDetails, ShippingMethod, ShippingRegion } from '../fixtures/testData';
import { handleLoginPromptIfPresent } from './checkout/loginPromptFlow';
import {
  ensureCustomerEmail,
  enterCustomerEmail,
  chooseGuestCheckout,
  chooseCreateAccountDuringCheckout,
  continueToShipping,
} from './checkout/customerStep';
import { currentCountry, hasSavedAddressForRegion, pickAddress } from './checkout/addressPicker';
import {
  fillContactAndName,
  ensureBillingSameAsShipping,
  fillDifferentBillingAddress,
} from './checkout/billingSection';
import {
  selectShippingMethod,
  selectFirstInStockCncStore,
  continueToPayment,
} from './checkout/shippingMethod';
import { selectClickAndCollectTab } from './checkout/cncStore';
import { fillCncPickupContact, fillCncBillingContact } from './checkout/cncContact';

/**
 * KWH checkout is a 3-step flow: Customer → Shipping → Payment.
 * The address block uses an autocomplete typeahead backed by an
 * address-finder API — call `pickAddress()`, not manual field-by-field entry.
 *
 * The class acts as a thin facade over focused helpers in `./checkout/`.
 * Public API is preserved — spec files and CheckoutFlow call these methods
 * directly.
 */
export class CheckoutPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.goto('/checkout');
  }

  private logMsg = (message: string): void => this.log(message);
  private overlayWaiter = (): Promise<void> => this.waitForLoadingOverlay();

  async handleLoginPromptIfPresent(): Promise<void> {
    await handleLoginPromptIfPresent(this.page, this.logMsg, this.overlayWaiter);
  }

  async ensureCustomerEmail(email: string): Promise<void> {
    await ensureCustomerEmail(this.page, this.logMsg, email);
  }

  // ---------- Step 1: Customer ----------
  async enterCustomerEmail(email: string): Promise<void> {
    await enterCustomerEmail(this.page, this.logMsg, email);
  }

  async chooseGuestCheckout(): Promise<void> {
    await chooseGuestCheckout(this.page, this.logMsg);
  }

  async chooseCreateAccountDuringCheckout(password: string): Promise<void> {
    await chooseCreateAccountDuringCheckout(this.page, this.logMsg, password);
  }

  async continueToShipping(): Promise<void> {
    await continueToShipping(this.page, this.logMsg);
  }

  // ---------- Step 2: Shipping ----------
  async fillContactAndName(buyer: BuyerDetails): Promise<void> {
    await fillContactAndName(this.page, this.logMsg, buyer);
  }

  async currentCountry(): Promise<string | null> {
    return currentCountry(this.page);
  }

  async hasSavedAddressForRegion(region: ShippingRegion): Promise<boolean> {
    return hasSavedAddressForRegion(this.page, this.logMsg, region);
  }

  async pickAddress(region: ShippingRegion): Promise<string> {
    return pickAddress(this.page, this.logMsg, region);
  }

  /**
   * CNC layout has no shipping address input — only billing. The
   * autocomplete search runs against that input via the same underlying
   * pickAddress helper. Wrapper exists so the log line reflects that
   * we're filling the billing block, not shipping.
   */
  async pickCncBillingAddress(region: ShippingRegion): Promise<string> {
    this.logMsg('step 2 · pickCncBillingAddress (CNC layout — billing address is the only address block)');
    return pickAddress(this.page, this.logMsg, region);
  }

  async ensureBillingSameAsShipping(): Promise<void> {
    await ensureBillingSameAsShipping(this.page, this.logMsg);
  }

  async fillDifferentBillingAddress(buyer: BuyerDetails, region: ShippingRegion): Promise<void> {
    await fillDifferentBillingAddress(this.page, this.logMsg, buyer, region);
  }

  async selectShippingMethod(method: ShippingMethod): Promise<void> {
    await selectShippingMethod(this.page, this.logMsg, method);
  }

  async selectClickAndCollectTab(): Promise<void> {
    await selectClickAndCollectTab(this.page, this.logMsg);
  }

  async selectFirstInStockCncStore(): Promise<string> {
    return selectFirstInStockCncStore(this.page, this.logMsg);
  }

  async fillCncPickupContact(buyer: BuyerDetails): Promise<void> {
    await fillCncPickupContact(this.page, this.logMsg, buyer);
  }

  async fillCncBillingContact(buyer: BuyerDetails): Promise<void> {
    await fillCncBillingContact(this.page, this.logMsg, buyer);
  }

  async continueToPayment(shippingMethodForConflict?: ShippingMethod): Promise<void> {
    await continueToPayment(this.page, this.logMsg, this.overlayWaiter, shippingMethodForConflict);
  }
}
