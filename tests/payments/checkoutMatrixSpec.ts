import { test, expect } from '../fixtures';
import type { PaymentMethod } from '../fixtures/testData';
import {
  CHECKOUT_MATRIX,
  PAYMENT_METHODS,
  USER_TYPES,
  screenshotFolder,
  testId,
  type MatrixSection,
  type MatrixUserType,
} from './matrix';

/**
 * Registers the 3-test happy-path matrix (logged-in / new-user /
 * guest-existing-email) for a given payment method + section. Called at
 * module load time by every `NN-<section>.spec.ts` file — Playwright
 * discovers the tests via the standard `test.describe` side-effects.
 */
export function registerCheckoutMatrixSpec(paymentMethod: PaymentMethod, sectionId: number): void {
  const section = CHECKOUT_MATRIX.find((s) => s.section === sectionId);
  if (!section) {
    throw new Error(`No matrix section with id=${sectionId}. Known: ${CHECKOUT_MATRIX.map((s) => s.section).join(', ')}`);
  }
  const payment = PAYMENT_METHODS[paymentMethod];

  test.describe(`${payment.shortLabel} · ${section.label}`, () => {
    for (const user of USER_TYPES) {
      registerRow({ section, user, paymentMethod, paymentLabel: payment.longLabel, folderSlug: payment.folderSlug });
    }
  });
}

function registerRow(args: {
  section: MatrixSection;
  user: MatrixUserType;
  paymentMethod: PaymentMethod;
  paymentLabel: string;
  folderSlug: string;
}): void {
  const { section, user, paymentMethod, paymentLabel } = args;
  const id = testId(section, user);
  const title = `${id} ${user.titlePhrase} with ${paymentLabel} (${section.short})`;
  const folder = screenshotFolder(section, user, PAYMENT_METHODS[paymentMethod]);

  test(title, async ({ flow, browserName }, testInfo) => {
    const method = PAYMENT_METHODS[paymentMethod];
    if (method.skipBrowsers?.includes(browserName)) {
      test.skip(true, `${paymentMethod} is not supported on ${browserName}`);
    }
    if (method.envGuard && !process.env[method.envGuard]) {
      test.skip(true, `${method.envGuard} not set`);
    }
    if (user.envGuard && !process.env[user.envGuard]) {
      test.skip(true, `${user.envGuard} not set`);
    }

    const orderNumber = await flow.run({
      userType: user.userType,
      shipping: section.shipping,
      region: section.region,
      payment: paymentMethod,
      testId: folder,
      testInfo,
    });
    expect(orderNumber).not.toBe('');
  });
}
