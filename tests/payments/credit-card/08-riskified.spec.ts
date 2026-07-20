import { test, expect } from '../../fixtures';
import type { CheckoutFlowConfig } from '../../flows/CheckoutFlow';

/**
 * Test Case 8.1 — Payment failure with CC by blocking Dispatch Order API,
 * then retry. Uses page.route() to intercept the dispatch endpoint on the
 * first attempt, releases it on the second.
 *
 * The dispatch endpoint URL pattern is a placeholder — adjust to the actual
 * URL once observed in the network tab.
 */
test.describe('CC · Riskified · Dispatch Order failure & retry', () => {
  test('8.1 Blocking dispatch order fails payment, unblock and retry succeeds', async ({
    page,
    flow,
    paymentPage,
    confirmationPage,
  }, testInfo) => {
    let blockDispatch = true;
    const beacons: string[] = [];

    await page.route(/dispatch[-_]?order|api\/.*dispatch/i, async (route) => {
      if (blockDispatch) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Simulated dispatch failure' }),
        });
      } else {
        await route.continue();
      }
    });

    page.on('request', (req) => {
      const url = req.url();
      if (/riskified|beacon/i.test(url)) {
        beacons.push(url);
      }
    });

    const config: CheckoutFlowConfig = {
      userType: 'guest-existing-email',
      shipping: 'standard',
      region: 'AU',
      payment: 'credit-card',
    };

    await flow.arriveAtPayment(config);

    await paymentPage.fillCreditCard({
      number: process.env.TEST_CARD_NUMBER ?? '4111111111111111',
      expiryMonth: process.env.TEST_CARD_EXPIRY_MONTH ?? '12',
      expiryYear: process.env.TEST_CARD_EXPIRY_YEAR ?? '2030',
      cvv: process.env.TEST_CARD_CVV ?? '123',
    });

    await paymentPage.submitCreditCard();
    await paymentPage.expectPaymentError();

    blockDispatch = false;
    await paymentPage.submitCreditCard();
    const orderNumber = await confirmationPage.expectSuccess();
    await confirmationPage.captureScreenshot({ testId: '8.1-cc-riskified-dispatch-block', testInfo });
    expect(orderNumber).not.toBe('');

    expect(beacons.length, 'Expected Riskified beacon calls in network trace').toBeGreaterThan(0);
  });
});
