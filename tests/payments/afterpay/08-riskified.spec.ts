import { test, expect } from '../../fixtures';
import type { CheckoutFlowConfig } from '../../flows/CheckoutFlow';

/**
 * Test Case 8.1 (Afterpay) — payment failure via Dispatch Order API
 * block, then retry. Mirrors credit-card/08-riskified.spec.ts but drives
 * Afterpay for both the failing and succeeding attempts.
 */
test.describe('AP · Riskified · Dispatch Order failure & retry', () => {
  test('8.1 Blocking dispatch order fails Afterpay, unblock and retry succeeds', async ({
    page,
    flow,
    paymentPage,
    confirmationPage,
  }, testInfo) => {
    test.skip(!process.env.AFTERPAY_SANDBOX_EMAIL, 'AFTERPAY_SANDBOX_EMAIL not set');

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
      payment: 'afterpay',
    };

    await flow.arriveAtPayment(config);

    // First attempt — dispatch blocked → expect payment error.
    await paymentPage.payWithAfterpay(
      process.env.AFTERPAY_SANDBOX_EMAIL!,
      process.env.AFTERPAY_SANDBOX_PASSWORD!,
    );
    await paymentPage.expectPaymentError();

    // Unblock and retry.
    blockDispatch = false;
    await paymentPage.payWithAfterpay(
      process.env.AFTERPAY_SANDBOX_EMAIL!,
      process.env.AFTERPAY_SANDBOX_PASSWORD!,
    );

    const orderNumber = await confirmationPage.expectSuccess();
    await confirmationPage.captureScreenshot({ testId: '8.1-ap-riskified-dispatch-block', testInfo });
    expect(orderNumber).not.toBe('');

    expect(beacons.length, 'Expected Riskified beacon calls in network trace').toBeGreaterThan(0);
  });
});
