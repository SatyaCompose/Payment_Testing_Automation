import { test, expect } from '../../fixtures';
import { TEST_CARDS } from '../../utils/testCards';
import type { CheckoutFlowConfig } from '../../flows/CheckoutFlow';

/**
 * Cross-payment retry: first attempt fails on Credit Card, user switches to
 * a different method and completes the order.
 *
 * The pre-payment setup (cart, customer, shipping, payment-tile select) is
 * delegated to `flow.arriveAtPayment()` so this file never re-implements
 * the checkout steps.
 */
test.describe('CC · Cross-payment retry', () => {
  const baseConfig: CheckoutFlowConfig = {
    userType: 'guest-existing-email',
    shipping: 'standard',
    region: 'AU',
    payment: 'credit-card',
  };

  test.beforeEach(async ({ flow, paymentPage }) => {
    await flow.arriveAtPayment(baseConfig);
    await paymentPage.fillCreditCard({
      number: TEST_CARDS.visa_declined.number,
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: TEST_CARDS.visa_declined.cvv,
    });
    await paymentPage.submitCreditCard();
    await paymentPage.expectPaymentError();
  });

  test('7.1 CC fails → retry with Google Pay', async ({ paymentPage, confirmationPage, browserName }, testInfo) => {
    test.skip(browserName === 'webkit', 'Google Pay not supported on WebKit');
    await paymentPage.selectMethod('gpay');
    await paymentPage.payWithGooglePay();
    const orderNumber = await confirmationPage.expectSuccess();
    await confirmationPage.captureScreenshot({ testId: '7.1-cc-fail-retry-gpay', testInfo });
    expect(orderNumber).not.toBe('');
  });

  test('7.2 CC fails → retry with PayPal', async ({ paymentPage, confirmationPage }, testInfo) => {
    test.skip(!process.env.PAYPAL_SANDBOX_EMAIL, 'PAYPAL_SANDBOX_EMAIL not set');
    await paymentPage.selectMethod('paypal');
    await paymentPage.payWithPayPal(
      process.env.PAYPAL_SANDBOX_EMAIL!,
      process.env.PAYPAL_SANDBOX_PASSWORD!,
    );
    const orderNumber = await confirmationPage.expectSuccess();
    await confirmationPage.captureScreenshot({ testId: '7.2-cc-fail-retry-paypal', testInfo });
    expect(orderNumber).not.toBe('');
  });

  test('7.3 CC fails → retry with Afterpay', async ({ paymentPage, confirmationPage }, testInfo) => {
    test.skip(!process.env.AFTERPAY_SANDBOX_EMAIL, 'AFTERPAY_SANDBOX_EMAIL not set');
    await paymentPage.selectMethod('afterpay');
    await paymentPage.payWithAfterpay(
      process.env.AFTERPAY_SANDBOX_EMAIL!,
      process.env.AFTERPAY_SANDBOX_PASSWORD!,
    );
    const orderNumber = await confirmationPage.expectSuccess();
    await confirmationPage.captureScreenshot({ testId: '7.3-cc-fail-retry-afterpay', testInfo });
    expect(orderNumber).not.toBe('');
  });
});
