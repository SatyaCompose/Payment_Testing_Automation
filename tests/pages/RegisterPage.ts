import { Page, expect } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * KWH uses Kinde for auth. Registration is either a dedicated page or an
 * inline "create account" toggle inside the Kinde-hosted screens. This class
 * covers both; call registerFromCheckout() when inside the checkout flow.
 */
export class RegisterPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async openStandalone(): Promise<void> {
    await this.goto('/Account/Register');
  }

  async register(email: string, password: string, firstName = 'Test', lastName = 'User'): Promise<void> {
    await this.page.getByLabel(/first name/i).fill(firstName).catch(() => undefined);
    await this.page.getByLabel(/last name/i).fill(lastName).catch(() => undefined);
    await this.page.getByLabel(/email/i).fill(email);
    await this.page.getByLabel(/^password$/i).fill(password);
    const confirm = this.page.getByLabel(/confirm password|repeat password/i);
    if (await confirm.count()) {
      await confirm.fill(password);
    }
    await this.page.getByRole('button', { name: /register|create account|sign up/i }).click();
    await expect(this.page).not.toHaveURL(/register/i, { timeout: 30_000 });
  }
}
