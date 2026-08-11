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
   * Open the mobile "Order summary" accordion if it's currently
   * collapsed. Real Playwright clicks (not DOM `.click()`) so React
   * onClick handlers fire. Escalates through: the heading text, its
   * parent, its clickable ancestor, and a nearby chevron icon. Verifies
   * success by looking for the "Subtotal" line after each attempt.
   *
   * No-op when Subtotal is already visible (desktop, or a mobile skin
   * that renders the accordion open by default).
   */
  private async expandOrderSummary(): Promise<void> {
    const subtotal = this.page.getByText(/^\s*subtotal\s*/i).first();
    if (await subtotal.isVisible().catch(() => false)) {
      // eslint-disable-next-line no-console
      console.log('[OrderConfirmationPage] order-summary: already open (Subtotal visible)');
      return;
    }

    // Locate the heading. Prefer a role=heading match (accessible name
    // usually maps to the visible label), then fall back to a strict
    // text-node match anywhere on the page.
    const heading = this.page
      .getByRole('heading', { name: /^\s*order\s*summary\s*$/i })
      .or(this.page.getByText(/^\s*order\s*summary\s*$/i))
      .first();

    if (!(await heading.isVisible().catch(() => false))) {
      // eslint-disable-next-line no-console
      console.log('[OrderConfirmationPage] order-summary: no "Order summary" heading found');
      return;
    }

    // Detect whether this browser context emulates touch (mobile
    // projects). Some KWH accordion handlers only listen on touchend,
    // not click, so a synthesized mouse click on a mobile viewport
    // dispatches without triggering the toggle.
    const hasTouch = await this.page
      .evaluate(() => 'ontouchstart' in window || navigator.maxTouchPoints > 0)
      .catch(() => false);

    const headingParent = heading.locator('..');
    const grandparent = headingParent.locator('..');
    const chevron = headingParent
      .locator('svg, button, [role="button"], [class*="chevron" i], [class*="arrow" i]')
      .first();
    // The accordion header ROW — the widest ancestor whose click
    // handler covers both the label and the chevron. KWH typically
    // marks it with role="button" or cursor:pointer.
    const rowAncestor = heading
      .locator(
        'xpath=ancestor::*[self::button or @role="button" or contains(@class, "accordion") or contains(@class, "collapsible") or contains(@class, "toggle")][1]',
      )
      .first();

    const attempts: Array<{
      label: string;
      run: () => Promise<void>;
    }> = [
      { label: 'heading click', run: () => heading.click({ force: true, timeout: 3_000 }) },
      { label: 'heading parent click', run: () => headingParent.click({ force: true, timeout: 3_000 }) },
      { label: 'grandparent click', run: () => grandparent.click({ force: true, timeout: 3_000 }) },
      { label: 'chevron click', run: () => chevron.click({ force: true, timeout: 3_000 }) },
      { label: 'row-ancestor click', run: () => rowAncestor.click({ force: true, timeout: 3_000 }) },
    ];

    // On mobile add tap variants and a coordinate click at the row's
    // right edge (where the chevron sits — direct hit on the toggle
    // even if the DOM structure is unusual).
    if (hasTouch) {
      attempts.push(
        { label: 'heading TAP', run: () => heading.tap({ force: true, timeout: 3_000 }) },
        { label: 'heading parent TAP', run: () => headingParent.tap({ force: true, timeout: 3_000 }) },
        { label: 'chevron TAP', run: () => chevron.tap({ force: true, timeout: 3_000 }) },
        {
          label: 'coord click at chevron edge',
          run: async () => {
            const box = await headingParent.boundingBox().catch(() => null);
            if (!box) throw new Error('no bounding box');
            // Chevron sits at the right edge of the row (see the 4.2
            // screenshot). Click 20px inside the right edge, vertical
            // centre.
            const x = box.x + Math.max(0, box.width - 20);
            const y = box.y + box.height / 2;
            await this.page.mouse.click(x, y);
          },
        },
      );
    }

    for (const { label, run } of attempts) {
      // eslint-disable-next-line no-console
      console.log(`[OrderConfirmationPage] order-summary: trying ${label}`);
      await heading.scrollIntoViewIfNeeded().catch(() => undefined);
      await run().catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.log(`[OrderConfirmationPage]   · ${label} threw: ${err.message?.split('\n')[0]}`);
      });
      const opened = await subtotal
        .waitFor({ state: 'visible', timeout: 1_500 })
        .then(() => true)
        .catch(() => false);
      if (opened) {
        // eslint-disable-next-line no-console
        console.log(`[OrderConfirmationPage] order-summary: opened via ${label}`);
        await this.page.waitForTimeout(300);
        return;
      }
    }

    // All strategies missed — dump the heading's ancestor chain so we
    // can see exactly what KWH renders (event listeners, class names,
    // wrapping tag types). This diagnostic is what tells us where the
    // real click handler lives.
    const diagnostic = await heading
      .evaluate((el: Element) => {
        const trail: Array<Record<string, unknown>> = [];
        let node: Element | null = el;
        for (let i = 0; i < 6 && node && node !== document.body; i++) {
          const rect = (node as HTMLElement).getBoundingClientRect();
          const cs = window.getComputedStyle(node as HTMLElement);
          trail.push({
            level: i,
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute('role'),
            testid: node.getAttribute('data-testid'),
            className: (node.getAttribute('class') || '').slice(0, 80),
            id: node.getAttribute('id'),
            cursor: cs.cursor,
            pointerEvents: cs.pointerEvents,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
          });
          node = node.parentElement;
        }
        return trail;
      })
      .catch(() => null);
    // eslint-disable-next-line no-console
    console.log(
      `[OrderConfirmationPage] order-summary: ALL strategies missed. Heading ancestor chain: ${JSON.stringify(diagnostic)}`,
    );
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

    // Mobile confirmation collapses the "Order summary" accordion by
    // default — the line-item breakdown + subtotal / shipping / total
    // lives inside. Expand it before snapping so the archive shot
    // captures the whole receipt. Desktop already renders it open.
    await this.expandOrderSummary();

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
