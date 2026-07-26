import { test, expect } from '../../fixtures';
import { getFirstAvailableGiftCard } from '../../utils/giftCards';
import { GIFT_CARD_MAX_AUD } from '../../fixtures/testData';

// Cart must exceed the gift card cap so GPay covers a non-zero remainder.
const CART_MIN_AUD = GIFT_CARD_MAX_AUD;

test.describe('GP · Discounts', () => {
  test('6.1 Apply promo code, pay with Google Pay', async ({ flow, browserName }, testInfo) => {
    test.skip(browserName === 'webkit', 'Google Pay is not supported on WebKit');
    test.skip(!process.env.PROMO_CODE, 'PROMO_CODE not set');
    const orderNumber = await flow.run({
      userType: 'guest-existing-email',
      shipping: 'standard',
      region: 'AU',
      payment: 'gpay',
      promoCode: process.env.PROMO_CODE,
      testId: '6.1-gp-promo-code',
      testInfo,
    });
    expect(orderNumber).not.toBe('');
  });

  test('6.2 Apply gift card, pay remainder with Google Pay', async ({ flow, browserName }, testInfo) => {
    test.skip(browserName === 'webkit', 'Google Pay is not supported on WebKit');
    const giftCardCode = await getFirstAvailableGiftCard();
    testInfo.annotations.push({ type: 'gift-card', description: giftCardCode });

    // GPay's tokenization sheet is browser-driven — there's no reliable
    // way to force a decline like Cybersource visa_declined. Unlike CC
    // 6.2 (fail-then-succeed), this variant only asserts the happy path:
    // gift card applied, GPay covers the remainder, order confirms.
    const orderNumber = await flow.run({
      userType: 'guest-existing-email',
      shipping: 'standard',
      region: 'AU',
      payment: 'gpay',
      giftCard: { number: giftCardCode, pin: process.env.GIFT_CARD_PIN },
      minCartTotalAud: CART_MIN_AUD,
      testId: '6.2-gp-gift-card-remainder',
      testInfo,
    });
    expect(orderNumber).not.toBe('');
  });
});
