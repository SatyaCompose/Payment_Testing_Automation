import { Page, expect } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * KWH uses Kinde for auth. `openFromHeader()` clicks the account icon, which
 * redirects to Kinde. `login()` fills the Kinde form.
 */
export class LoginPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.goto('/Account');
  }

  async openFromHeader(): Promise<void> {
    await this.page.getByRole('link', { name: /account|sign in|log ?in/i }).first().click();
  }

  async login(email: string, password: string): Promise<void> {
    await this.page.getByLabel(/email/i).fill(email);
    // Kinde flow: Continue → password
    const continueBtn = this.page.getByRole('button', { name: /continue|next/i });
    if (await continueBtn.count()) {
      await continueBtn.first().click();
    }
    await this.page.getByLabel(/password/i).fill(password);
    await this.page.getByRole('button', { name: /log ?in|sign ?in|continue/i }).click();
    await expect(this.page).not.toHaveURL(/kinde\.com|\/login/i, { timeout: 30_000 });
  }

  /**
   * If the browser session is logged in (via storageState) but the test
   * needs a guest / new-user flow, sign out first. KWH renders the
   * profile menu in the header — hover the icon, click the last item
   * ("Log out"). No-op if we're already signed out.
   */
  async logoutIfLoggedIn(): Promise<void> {
    // Fastest check: is a "Log out" menu item reachable at all?
    // We probe the header profile icon and hover to reveal the menu.
    await this.goto('/');
    const profileIcon = this.page
      .getByRole('button', { name: /account|profile|my account/i })
      .or(this.page.getByRole('link', { name: /account|profile|my account/i }))
      .or(this.page.locator('[data-testid*="account" i], [aria-label*="account" i]'))
      .first();

    if (!(await profileIcon.count().catch(() => 0))) {
      // eslint-disable-next-line no-console
      console.log('[LoginPage] no profile icon in header — assuming already signed out');
      return;
    }

    // Hover to open the menu.
    await profileIcon.hover().catch(() => undefined);
    await this.page.waitForTimeout(400);

    const logoutItem = this.page
      .locator('a, button, [role="menuitem"], [role="button"]')
      .filter({ hasText: /^\s*(log ?out|sign ?out)\s*$/i })
      .first();

    if (!(await logoutItem.count().catch(() => 0))) {
      // Try clicking the profile icon (some sites toggle a menu on click).
      await profileIcon.click({ force: true }).catch(() => undefined);
      await this.page.waitForTimeout(400);
    }

    if (!(await logoutItem.count().catch(() => 0))) {
      // eslint-disable-next-line no-console
      console.log('[LoginPage] no Log out control found — assuming already signed out');
      return;
    }

    const label = ((await logoutItem.textContent().catch(() => null)) ?? '').trim();
    // eslint-disable-next-line no-console
    console.log(`[LoginPage] clicking "${label}" from header profile menu`);
    await logoutItem.click({ force: true }).catch(() => undefined);

    // Wait for the logout to take effect — either URL change or the
    // "Log in / Sign in" control reappears.
    await this.page
      .getByRole('link', { name: /log ?in|sign ?in/i })
      .or(this.page.getByRole('button', { name: /log ?in|sign ?in/i }))
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => undefined);
    // eslint-disable-next-line no-console
    console.log('[LoginPage] ✓ signed out');
  }

  async loginWithGoogle(): Promise<void> {
    // Google SSO opens a popup on Kinde. Uses TEST_USER_EMAIL/PASSWORD.
    const [popup] = await Promise.all([
      this.page.waitForEvent('popup'),
      this.page.getByRole('button', { name: /google/i }).click(),
    ]);
    await popup.getByLabel(/email/i).fill(process.env.TEST_USER_EMAIL ?? '');
    await popup.getByRole('button', { name: /next/i }).click();
    await popup.getByLabel(/password/i).fill(process.env.TEST_USER_PASSWORD ?? '');
    await popup.getByRole('button', { name: /next/i }).click();
    await popup.waitForEvent('close', { timeout: 60_000 }).catch(() => undefined);
  }
}
