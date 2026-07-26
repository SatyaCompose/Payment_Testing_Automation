import { test, expect } from '../../fixtures';
import { getFirstAvailableGiftCard } from '../../utils/giftCards';
import { GIFT_CARD_MAX_AUD } from '../../fixtures/testData';

const CART_MIN_AUD = GIFT_CARD_MAX_AUD;

test.describe('PP · Discounts', () => {
  test('6.1 Apply promo code, pay with PayPal', async ({ flow }, testInfo) => {
    test.skip(!process.env.PROMO_CODE, 'PROMO_CODE not set');
    test.skip(!process.env.PAYPAL_SANDBOX_EMAIL, 'PAYPAL_SANDBOX_EMAIL not set');
    const orderNumber = await flow.run({
      userType: 'guest-existing-email',
      shipping: 'standard',
      region: 'AU',
      payment: 'paypal',
      promoCode: process.env.PROMO_CODE,
      testId: '6.1-pp-promo-code',
      testInfo,
    });
    expect(orderNumber).not.toBe('');
  });

  test('6.2 Apply gift card, pay remainder with PayPal', async ({ flow }, testInfo) => {
    test.skip(!process.env.PAYPAL_SANDBOX_EMAIL, 'PAYPAL_SANDBOX_EMAIL not set');
    const giftCardCode = await getFirstAvailableGiftCard();
    testInfo.annotations.push({ type: 'gift-card', description: giftCardCode });

    // PayPal sandbox doesn't expose decline scenarios that mirror
    // Cybersource visa_declined, so 6.2 asserts the happy path only:
    // gift card applied → PayPal covers the remainder → order confirms.
    const orderNumber = await flow.run({
      userType: 'guest-existing-email',
      shipping: 'standard',
      region: 'AU',
      payment: 'paypal',
      giftCard: { number: giftCardCode, pin: process.env.GIFT_CARD_PIN },
      minCartTotalAud: CART_MIN_AUD,
      testId: '6.2-pp-gift-card-remainder',
      testInfo,
    });
    expect(orderNumber).not.toBe('');
  });
});
