import { test, expect } from '../../fixtures';
import type { CheckoutFlowConfig } from '../../flows/CheckoutFlow';

/**
 * Test Case 8.1 (GPay) — payment failure via Dispatch Order API block,
 * then retry. Mirrors credit-card/08-riskified.spec.ts but drives Google
 * Pay for both the failing and succeeding attempts. Beacon calls are
 * captured to assert Riskified fingerprinting ran.
 */
test.describe('GP · Riskified · Dispatch Order failure & retry', () => {
  test('8.1 Blocking dispatch order fails Google Pay, unblock and retry succeeds', async ({
    page,
    flow,
    paymentPage,
    confirmationPage,
    browserName,
  }, testInfo) => {
    test.skip(browserName === 'webkit', 'Google Pay is not supported on WebKit');

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
      payment: 'gpay',
    };

    await flow.arriveAtPayment(config);

    // First attempt — dispatch is blocked, expect payment error.
    await paymentPage.payWithGooglePay();
    await paymentPage.expectPaymentError();

    // Unblock and retry.
    blockDispatch = false;
    await paymentPage.payWithGooglePay();

    const orderNumber = await confirmationPage.expectSuccess();
    await confirmationPage.captureScreenshot({ testId: '8.1-gp-riskified-dispatch-block', testInfo });
    expect(orderNumber).not.toBe('');

    expect(beacons.length, 'Expected Riskified beacon calls in network trace').toBeGreaterThan(0);
  });
});
