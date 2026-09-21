import { Page, expect } from '@playwright/test';
import { BasePage } from './BasePage';
import { evaluateSignedIn, readCustomerState } from '../fixtures/authState';

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

  /**
   * The header's account control is a hover-only menu BUTTON, not a link —
   * clicking it navigates nowhere, which is why a `getByRole('link')` here
   * used to retry against a permanently disabled element and never leave
   * the page. Hover it, then click the "Log in to manage your account"
   * item it reveals (which points at the Kinde `/api/auth/login` route).
   */
  async openFromHeader(): Promise<void> {
    await this.page.getByRole('button', { name: /account/i }).first().hover();
    const loginLink = this.page.getByRole('link', { name: /log in to manage your account/i });
    await expect(loginLink).toBeVisible();
    await loginLink.click();
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
    if (!(await this.isSignedIn())) {
      // eslint-disable-next-line no-console
      console.log('[LoginPage] already signed out (no customer in app state)');
      return;
    }

    await this.tryHeaderMenuLogout();

    if (await this.isSignedIn()) {
      // The header profile menu is easy to miss (hover-only, and the icon
      // renders for guests too). Kinde's own route is deterministic.
      // eslint-disable-next-line no-console
      console.log('[LoginPage] header logout did not take — using /api/auth/logout');
      await this.goto('/api/auth/logout');
    }

    if (await this.isSignedIn()) {
      // Never continue: a guest / new-user test would place its order on the
      // signed-in QA account, producing a confirmation with the wrong email
      // that looks like a valid pass.
      throw new Error(
        'Sign-out failed — still authenticated. A guest/new-user test would place its order on the signed-in account.',
      );
    }
    // eslint-disable-next-line no-console
    console.log('[LoginPage] ✓ signed out (verified — no customer in app state)');
  }

  /**
   * KWH mirrors the signed-in customer into localStorage (`customerId` /
   * `customerInfo`), which is a far more reliable signal than the header — the
   * account icon renders for guests too. The rule itself lives in
   * `tests/fixtures/authState.ts` (shared with the sign-in script,
   * globalSetup, and the runner server — the only consumers that actually
   * run; `tests/auth.setup.ts` uses it too but is `testIgnore`'d and never
   * executes) so it can't drift between them.
   */
  private async isSignedIn(): Promise<boolean> {
    if (!/kitchenwarehouse\.com\.au/i.test(this.page.url())) {
      await this.goto('/');
    }
    const state = await readCustomerState(this.page);
    const signedIn = evaluateSignedIn(state.customerId, state.customerInfo);
    // eslint-disable-next-line no-console
    console.log(
      `[LoginPage] signed-in check: customerId="${state.customerId.slice(0, 24)}" info=${state.customerInfo.slice(0, 40)} → ${signedIn}`,
    );
    return signedIn;
  }

  /** Best-effort header profile menu logout — kept for a real user gesture. */
  private async tryHeaderMenuLogout(): Promise<void> {
    await this.goto('/');
    const profileIcon = this.page
      .getByRole('button', { name: /account|profile|my account/i })
      .or(this.page.getByRole('link', { name: /account|profile|my account/i }))
      .or(this.page.locator('[data-testid*="account" i], [aria-label*="account" i]'))
      .first();

    if (!(await profileIcon.count().catch(() => 0))) {
      // eslint-disable-next-line no-console
      console.log('[LoginPage] no profile icon in header — nothing to click, falling back');
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
      console.log('[LoginPage] no Log out control in the header menu — falling back');
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
    // No success claim here — logoutIfLoggedIn() verifies and decides.
    // eslint-disable-next-line no-console
    console.log('[LoginPage] header logout clicked');
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
