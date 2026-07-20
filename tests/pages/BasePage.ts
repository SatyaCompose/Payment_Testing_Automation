import { Page, expect } from '@playwright/test';

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  /**
   * Prefixed console.log so the runner UI's Server log makes it obvious
   * which page object emitted the message. All logs propagate through
   * Playwright's stdout → server → SSE → dashboard.
   */
  protected log(message: string): void {
    // eslint-disable-next-line no-console
    console.log(`[${this.constructor.name}] ${message}`);
  }

  async goto(path = '/'): Promise<void> {
    this.log(`goto ${path}`);
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('load').catch(() => undefined);
    await this.waitForLoadingOverlay();
  }

  /**
   * KWH renders a full-screen dimmer overlay while data loads. It intercepts
   * pointer events, so clicks fired against elements underneath silently
   * fail (Playwright reports `<div> intercepts pointer events`). This waits
   * until the dimmer is gone before returning.
   */
  async waitForLoadingOverlay(timeoutMs = 20_000): Promise<void> {
    const overlay = this.page.locator(
      'div.fixed.inset-0.bg-gray-200, div[class*="loading"][class*="fixed"], div[class*="Loading"][class*="fixed"]',
    );
    // The overlay may not exist at all — that's fine.
    await overlay
      .first()
      .waitFor({ state: 'hidden', timeout: timeoutMs })
      .catch(() => undefined);
  }

  async waitForIdle(): Promise<void> {
    await this.page.waitForLoadState('networkidle');
  }

  async expectUrlToInclude(fragment: string): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}
