import { Page, TestInfo } from '@playwright/test';
import { CartPage } from '../pages/CartPage';
import { CheckoutPage } from '../pages/CheckoutPage';
import { LoginPage } from '../pages/LoginPage';
import { PaymentPage } from '../pages/PaymentPage';
import { OrderConfirmationPage } from '../pages/OrderConfirmationPage';
import {
  BuyerDetails,
  PaymentMethod,
  ShippingMethod,
  ShippingRegion,
  UserType,
  guestBuyer,
  newUserBuyer,
  existingGuestEmail,
} from '../fixtures/testData';
import { TEST_CARDS } from '../utils/testCards';
import { selectCncStoreWithProductRetry } from './cncRetry';

export interface CheckoutFlowConfig {
  userType: UserType;
  shipping: ShippingMethod;
  region: ShippingRegion;
  payment: PaymentMethod;
  promoCode?: string;
  giftCard?: { number: string; pin?: string };
  /** How many random products to add. Defaults to 1. */
  productCount?: number;
  /** If set, keeps adding random products until cart total exceeds this AUD threshold. Overrides `productCount`. */
  minCartTotalAud?: number;
  /** When true, uncheck "billing same as shipping" and fill a separate billing block. */
  differentBilling?: boolean;
  /** Folder-safe id used to name the screenshot dir, e.g. `1.1-cc-au-standard-logged-in`. */
  testId?: string;
  /** Playwright TestInfo — required if `testId` is set so screenshots attach to the report. */
  testInfo?: TestInfo;
}

/**
 * Shared phase methods for the checkout flow. Every payment method (CC,
 * PayPal, Afterpay, GPay, Apple Pay) reuses the same customer/shipping
 * setup — only `completePayment` branches per method.
 *
 * `run()` composes the full happy path. Specs that need to intervene
 * mid-flow (decline retry, dispatch failure, gift-card partial pay)
 * call the phase methods directly via `arriveAtPayment()` and then
 * drive the payment step themselves.
 */
export class CheckoutFlow {
  readonly cart: CartPage;
  readonly login: LoginPage;
  readonly checkout: CheckoutPage;
  readonly payment: PaymentPage;
  readonly confirmation: OrderConfirmationPage;

  constructor(private readonly page: Page) {
    this.cart = new CartPage(page);
    this.login = new LoginPage(page);
    this.checkout = new CheckoutPage(page);
    this.payment = new PaymentPage(page);
    this.confirmation = new OrderConfirmationPage(page);
  }

  buyerFor(config: CheckoutFlowConfig): BuyerDetails & { password?: string } {
    switch (config.userType) {
      case 'logged-in':
        return {
          ...guestBuyer(),
          email: process.env.TEST_USER_EMAIL ?? '',
        };
      case 'new-user':
        return newUserBuyer();
      case 'guest-existing-email':
        return {
          ...guestBuyer(),
          email: existingGuestEmail(),
        };
    }
  }

  /**
   * The saved storageState leaves us signed in. For guest / new-user runs
   * we log out first so the cart is built anonymously and the checkout
   * offers the guest flow.
   */
  async signOutIfGuestFlow(userType: UserType): Promise<void> {
    if (userType !== 'logged-in') {
      await this.login.logoutIfLoggedIn();
    }
  }

  async addProductsToCart(config: CheckoutFlowConfig): Promise<void> {
    // Express shipping requires online-available + non-dropship products.
    // The PLP "Express delivery available" filter enforces both.
    const opts = { filterExpressOnly: config.shipping === 'express' };
    if (config.minCartTotalAud !== undefined) {
      await this.cart.addProductsUntilMinTotal(config.minCartTotalAud, 8, opts);
      return;
    }
    await this.cart.addRandomProducts(config.productCount ?? 1, opts);
  }

  async openCheckout(): Promise<void> {
    await this.cart.proceedToCheckout();
  }

  /**
   * Step 1 — customer identification. Signed-in users pass through the
   * login prompt if the checkout presents one; guests type the email and
   * choose guest or create-during-checkout. Ends by clicking through to
   * the shipping step.
   *
   * Returns `hasSavedAddressForRegion` for the logged-in path so
   * `shippingStep` can skip re-entering the address.
   */
  async customerStep(config: CheckoutFlowConfig, buyer: BuyerDetails & { password?: string }): Promise<{ hasSavedAddress: boolean }> {
    if (config.userType === 'logged-in') {
      // Complete Kinde/Google SSO if the checkout offers a Log in button.
      // If we're already signed in, this is a no-op.
      await this.checkout.handleLoginPromptIfPresent();
      // KWH sometimes leaves the customer email blank even for signed-in
      // users. Backfill so the Continue button passes validation.
      await this.checkout.ensureCustomerEmail(process.env.TEST_USER_EMAIL ?? '');
      await this.checkout.continueToShipping();
      const hasSavedAddress = await this.checkout
        .hasSavedAddressForRegion(config.region)
        .catch(() => false);
      return { hasSavedAddress };
    }

    await this.checkout.enterCustomerEmail(buyer.email);
    if (config.userType === 'guest-existing-email') {
      await this.checkout.chooseGuestCheckout();
    } else if (config.userType === 'new-user' && buyer.password) {
      await this.checkout.chooseCreateAccountDuringCheckout(buyer.password);
    }
    await this.checkout.continueToShipping();
    return { hasSavedAddress: false };
  }

  /**
   * Step 2 — shipping. Two shapes:
   *
   * **CNC**: no delivery address on the UI. Pick the CNC method first
   * (reveals the store list), choose a store, then fill or verify the
   * billing address block, then continue.
   *
   * **All other methods** (standard / express / international): fill
   * shipping address (unless a logged-in user already has a saved one),
   * set billing-same-as-shipping (or a separate billing block), pick the
   * shipping method, then continue.
   */
  async shippingStep(
    config: CheckoutFlowConfig,
    buyer: BuyerDetails,
    opts: { hasSavedAddress?: boolean } = {},
  ): Promise<void> {
    if (config.shipping === 'cnc') {
      // KWH's step 2 for CNC uses a tab at the top ("Click & Collect")
      // that swaps the delivery layout for the CNC layout. That tab MUST
      // click first, otherwise the checkout proceeds with default
      // standard delivery and we complete an online-delivery order (a
      // false pass for the CNC suite). Every step here throws on failure
      // — no silent fallback.
      //
      // CNC step-2 order on KWH staging:
      //   1. Fill pickup contact  (First name / Last name / Phone)
      //   2. Fill billing contact (First name / Last name / Phone)
      //   3. Fill billing address — MUST be first-time filled before the
      //      store list renders. KWH uses the billing address to fetch
      //      "N stores with stock close to your location". For logged-in
      //      users with a saved billing block the picker is a no-op.
      //   4. Pick a store (main-page 3-card list or drawer via "Show more").
      //   5. Continue to payment.
      await this.checkout.selectClickAndCollectTab();
      await this.checkout.fillCncPickupContact(buyer);
      await this.checkout.fillCncBillingContact(buyer);
      await this.checkout.pickCncBillingAddress(config.region);
      await selectCncStoreWithProductRetry(this, config, buyer);
      await this.checkout.continueToPayment('cnc');
      return;
    }

    if (!opts.hasSavedAddress) {
      await this.checkout.fillContactAndName(buyer);
      await this.checkout.pickAddress(config.region);
    }
    if (config.differentBilling) {
      await this.checkout.fillDifferentBillingAddress(buyer, config.region);
    } else {
      await this.checkout.ensureBillingSameAsShipping();
    }
    await this.checkout.selectShippingMethod(config.shipping);
    await this.checkout.continueToPayment(config.shipping);
  }

  /**
   * Step 3, part 1 — applies any promo / gift card and selects the
   * payment tile. Does NOT submit the payment — call `completePayment`
   * (or drive the payment page directly) to finish.
   */
  async paymentStep(config: CheckoutFlowConfig): Promise<void> {
    // Promo code is applied earlier (in arriveAtPayment, right after
    // customerStep) so the discount is reflected in the running Order
    // Summary throughout step 2. Gift cards still apply at step 3 —
    // KWH puts the gift-card input on the payment step, not the summary.
    if (config.giftCard) {
      await this.payment.applyGiftCard(config.giftCard.number, config.giftCard.pin);
    }
    await this.payment.selectMethod(config.payment);
  }

  /**
   * Convenience: signOut → addProducts → openCheckout → customerStep →
   * shippingStep → paymentStep. After this returns, the payment tile is
   * selected and the spec can drive the final payment interaction (fill
   * card, click PayPal button, etc.).
   */
  async arriveAtPayment(
    config: CheckoutFlowConfig,
    buyer?: BuyerDetails & { password?: string },
  ): Promise<BuyerDetails & { password?: string }> {
    await this.signOutIfGuestFlow(config.userType);
    // Logged-in accounts have a server-side cart that persists across
    // test retries. Probe first — if items already exist (retry attempt,
    // or a previous run of this spec that failed mid-checkout), skip
    // re-adding products and let openCheckout proceed from /cart.
    // Guest / new-user flows always start with a fresh browser context,
    // so their cart is empty by definition.
    let skipAdd = false;
    if (config.userType === 'logged-in') {
      skipAdd = await this.cart.probeHasItems().catch(() => false);
      if (skipAdd) {
        console.log('[CheckoutFlow] logged-in cart already has items — skipping product add, proceeding via /cart');
      }
    }
    if (!skipAdd) {
      await this.addProductsToCart(config);
    }
    await this.openCheckout();
    const buyerToUse = buyer ?? this.buyerFor(config);
    const { hasSavedAddress } = await this.customerStep(config, buyerToUse);
    // Apply promo BEFORE step 2 so Order Summary reflects the discount
    // through step-2 shipping cost calculation. Retry built into applyPromoCode.
    if (config.promoCode) {
      console.log(`[CheckoutPage] step 1 → 2 · applying promo "${config.promoCode}" from Order Summary`);
      await this.payment.applyPromoCode(config.promoCode);
      console.log('[CheckoutPage]   ✓ promo visible in Order Summary');
    }
    await this.shippingStep(config, buyerToUse, { hasSavedAddress });
    await this.paymentStep(config);
    return buyerToUse;
  }

  /**
   * Full happy-path run — cart → customer → shipping → payment →
   * confirmation → screenshot. Returns the order number.
   */
  async run(config: CheckoutFlowConfig): Promise<string> {
    const buyer = await this.arriveAtPayment(config);
    await this.completePayment(config, buyer);
    return this.confirmOrder(config);
  }

  /**
   * Asserts the order-confirmation page rendered, captures the
   * per-test-id screenshot when `testId` + `testInfo` are provided.
   */
  async confirmOrder(config: CheckoutFlowConfig): Promise<string> {
    const orderNumber = await this.confirmation.expectSuccess();
    if (config.testId && config.testInfo) {
      await this.confirmation.captureScreenshot({ testId: config.testId, testInfo: config.testInfo });
    }
    return orderNumber;
  }

  async completePayment(
    config: CheckoutFlowConfig,
    _buyer?: BuyerDetails,
  ): Promise<void> {
    switch (config.payment) {
      case 'credit-card':
        await this.payment.fillCreditCard({
          number: process.env.TEST_CARD_NUMBER ?? TEST_CARDS.visa_approved.number,
          expiryMonth: process.env.TEST_CARD_EXPIRY_MONTH ?? '12',
          expiryYear: process.env.TEST_CARD_EXPIRY_YEAR ?? '2030',
          cvv: process.env.TEST_CARD_CVV ?? TEST_CARDS.visa_approved.cvv,
        });
        await this.payment.submitCreditCard();
        break;
      case 'paypal':
        await this.payment.payWithPayPal(
          process.env.PAYPAL_SANDBOX_EMAIL ?? '',
          process.env.PAYPAL_SANDBOX_PASSWORD ?? '',
        );
        break;
      case 'afterpay':
        await this.payment.payWithAfterpay(
          process.env.AFTERPAY_SANDBOX_EMAIL ?? '',
          process.env.AFTERPAY_SANDBOX_PASSWORD ?? '',
        );
        break;
      case 'gpay':
        await this.payment.payWithGooglePay();
        break;
      case 'applepay':
        // Apple Pay in Playwright requires a signed-in WebKit context with a
        // stored card. Real coverage is manual on a device.
        await this.page.getByRole('button', { name: /apple ?pay|place order/i }).first().click();
        break;
    }
  }
}
