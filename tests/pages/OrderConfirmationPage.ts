import { Page, expect, TestInfo } from '@playwright/test';
import { BasePage } from './BasePage';
import { screenshotsRoot } from '../utils/runTimestamp';
import * as path from 'path';
import * as fs from 'fs';

export interface ConfirmationCaptureOptions {
  /** Folder-safe test id, e.g. `1.1-cc-au-standard-logged-in`. */
  testId: string;
  testInfo: TestInfo;
}

export class OrderConfirmationPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async expectSuccess(): Promise<string> {
    // Success can be detected by either the URL changing to an order/
    // confirmation path OR the "Thank you" text appearing on the page
    // (KWH renders the confirmation in-place sometimes). Race both.
    const urlSignal = this.page
      .waitForURL(/order|confirmation|thank|success/i, { timeout: 60_000 })
      .then(() => 'url' as const)
      .catch(() => null);
    const textSignal = this.page
      .getByText(/thank you for your order|order confirmed|order complete|order successfully/i)
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => 'text' as const)
      .catch(() => null);
    const orderNumberSignal = this.page
      .getByText(/CT-\d+/)
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => 'order-number' as const)
      .catch(() => null);

    const signal = await Promise.race([urlSignal, textSignal, orderNumberSignal]);
    if (!signal) {
      throw new Error(
        `Order confirmation not detected within 60s. URL=${this.page.url()}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[OrderConfirmationPage] ✓ confirmation detected via ${signal}`);

    const orderNumber =
      (await this.page.getByTestId('order-number').textContent().catch(() => null)) ??
      (await this.page.getByText(/CT-\d+/).first().textContent().catch(() => null)) ??
      (await this.page.getByText(/order (#|number|id)[:\s]*[A-Z0-9-]+/i).first().textContent().catch(() => null));
    return (orderNumber ?? '').trim();
  }

  /**
   * Screenshot into
   *   screenshots/<testId>/<browser>-order-confirmation.png
   *
   * Also attaches to the Playwright report.
   */
  async captureScreenshot(opts: ConfirmationCaptureOptions): Promise<string> {
    const { testId, testInfo } = opts;

    // Wait for the confirmation page's details to fully render before
    // snapping. KWH shows the order-number heading first, then fetches
    // shipping address / method / payment via a later API call — the
    // "Thank you" signal fires long before those are populated.
    // networkidle beyond ~8s usually means we're waiting on analytics /
    // tracking pixels, not order-confirmation content.
    await this.page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await this.page
      .waitForFunction(
        () => {
          const text = document.body.innerText || '';
          // Look for a card-brand mention near "Payment method" AND a
          // populated shipping-address block (>1 char after the label,
          // not just a stray comma).
          const paymentMatch = text.match(/Payment method[\s\S]{1,120}/i)?.[0] ?? '';
          const shippingMatch = text.match(/Shipping address\s*\n([\s\S]{0,200})/i)?.[1] ?? '';
          const paymentHasBrand = /master ?card|visa|amex|american express|paypal|afterpay|apple ?pay|google ?pay/i.test(paymentMatch);
          const shippingHasAddress = shippingMatch.replace(/[,\s]/g, '').length > 3;
          return paymentHasBrand && shippingHasAddress;
        },
        undefined,
        { timeout: 20_000, polling: 500 },
      )
      .catch(() => undefined);
    // Small buffer for any fade-in / late layout shift.
    await this.page.waitForTimeout(500);

    // The floating red cursor overlay (from utils/cursorOverlay.ts) is
    // injected on every page for headed-run visibility, but must not
    // appear in the confirmation screenshot. Hide via display:none for
    // the screenshot, then restore.
    await this.page
      .evaluate(() => {
        const cursor = document.getElementById('__pw_cursor__');
        const label = document.getElementById('__pw_cursor_label__');
        if (cursor) cursor.style.display = 'none';
        if (label) label.style.display = 'none';
      })
      .catch(() => undefined);

    const dir = path.join(screenshotsRoot(), testId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${testInfo.project.name}-order-confirmation.png`);
    // Remove any stale screenshot at this path before writing the new
    // one — Playwright's screenshot() overwrites in place, but the
    // explicit delete makes the "latest run wins" intent unambiguous.
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore — Playwright will overwrite anyway */
      }
    }
    await this.page.screenshot({ path: file, fullPage: true });

    // Restore the cursor overlay so subsequent tests keep the visual aid.
    await this.page
      .evaluate(() => {
        const cursor = document.getElementById('__pw_cursor__');
        const label = document.getElementById('__pw_cursor_label__');
        if (cursor) cursor.style.display = '';
        if (label) label.style.display = '';
      })
      .catch(() => undefined);
    await testInfo.attach(`order-confirmation-${testInfo.project.name}`, {
      path: file,
      contentType: 'image/png',
    });
    return file;
  }
}
