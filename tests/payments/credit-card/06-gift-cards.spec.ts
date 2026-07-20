import { test, expect } from '../../fixtures';
import { TEST_CARDS } from '../../utils/testCards';
import { getFirstAvailableGiftCard } from '../../utils/giftCards';
import { GIFT_CARD_MAX_AUD } from '../../fixtures/testData';
import type { CheckoutFlowConfig } from '../../flows/CheckoutFlow';

// Stop adding products as soon as the cart exceeds the gift card cap
// ($200). The next random add will push us over, so the CC still covers
// a non-zero remainder without adding extra buffer items.
const CART_MIN_AUD = GIFT_CARD_MAX_AUD;

test.describe('CC · Discounts', () => {
  test('6.1 Apply promo code, pay with Credit Card', async ({ flow }, testInfo) => {
    test.skip(!process.env.PROMO_CODE, 'PROMO_CODE not set');
    const orderNumber = await flow.run({
      userType: 'guest-existing-email',
      shipping: 'standard',
      region: 'AU',
      payment: 'credit-card',
      promoCode: process.env.PROMO_CODE,
      testId: '6.1-cc-promo-code',
      testInfo,
    });
    expect(orderNumber).not.toBe('');
  });

  test('6.2 Apply gift card, fail then succeed CC payment for remainder', async ({
    flow,
    paymentPage,
    confirmationPage,
  }, testInfo) => {
    const giftCardCode = await getFirstAvailableGiftCard();
    testInfo.annotations.push({ type: 'gift-card', description: giftCardCode });

    const config: CheckoutFlowConfig = {
      userType: 'guest-existing-email',
      shipping: 'standard',
      region: 'AU',
      payment: 'credit-card',
      giftCard: { number: giftCardCode, pin: process.env.GIFT_CARD_PIN },
      // Gift card caps at 200 AUD — cart must exceed that so the CC covers the rest.
      minCartTotalAud: CART_MIN_AUD,
    };

    await flow.arriveAtPayment(config);
    // arriveAtPayment already applied the gift card and selected the CC tile.

    await paymentPage.fillCreditCard({
      number: TEST_CARDS.visa_declined.number,
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: TEST_CARDS.visa_declined.cvv,
    });
    await paymentPage.submitCreditCard();
    await paymentPage.expectPaymentError();

    await paymentPage.fillCreditCard({
      number: TEST_CARDS.visa_approved.number,
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: TEST_CARDS.visa_approved.cvv,
    });
    await paymentPage.submitCreditCard();

    const orderNumber = await confirmationPage.expectSuccess();
    await confirmationPage.captureScreenshot({ testId: '6.2-cc-gift-card-fail-then-succeed', testInfo });
    expect(orderNumber).not.toBe('');
  });
});
