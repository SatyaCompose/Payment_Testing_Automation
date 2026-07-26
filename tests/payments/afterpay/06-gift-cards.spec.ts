import { test, expect } from '../../fixtures';
import { getFirstAvailableGiftCard } from '../../utils/giftCards';
import { GIFT_CARD_MAX_AUD } from '../../fixtures/testData';

const CART_MIN_AUD = GIFT_CARD_MAX_AUD;

test.describe('AP · Discounts', () => {
  test('6.1 Apply promo code, pay with Afterpay', async ({ flow }, testInfo) => {
    test.skip(!process.env.PROMO_CODE, 'PROMO_CODE not set');
    test.skip(!process.env.AFTERPAY_SANDBOX_EMAIL, 'AFTERPAY_SANDBOX_EMAIL not set');
    const orderNumber = await flow.run({
      userType: 'guest-existing-email',
      shipping: 'standard',
      region: 'AU',
      payment: 'afterpay',
      promoCode: process.env.PROMO_CODE,
      testId: '6.1-ap-promo-code',
      testInfo,
    });
    expect(orderNumber).not.toBe('');
  });

  test('6.2 Apply gift card, pay remainder with Afterpay', async ({ flow }, testInfo) => {
    test.skip(!process.env.AFTERPAY_SANDBOX_EMAIL, 'AFTERPAY_SANDBOX_EMAIL not set');
    const giftCardCode = await getFirstAvailableGiftCard();
    testInfo.annotations.push({ type: 'gift-card', description: giftCardCode });

    // Afterpay sandbox doesn't expose a reliable decline path that
    // mirrors Cybersource visa_declined, so 6.2 asserts the happy path:
    // gift card applied → Afterpay covers the remainder → order confirms.
    const orderNumber = await flow.run({
      userType: 'guest-existing-email',
      shipping: 'standard',
      region: 'AU',
      payment: 'afterpay',
      giftCard: { number: giftCardCode, pin: process.env.GIFT_CARD_PIN },
      minCartTotalAud: CART_MIN_AUD,
      testId: '6.2-ap-gift-card-remainder',
      testInfo,
    });
    expect(orderNumber).not.toBe('');
  });
});
