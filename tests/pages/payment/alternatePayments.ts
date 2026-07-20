import { Page, FrameLocator } from '@playwright/test';

// ---------- PayPal (popup) ----------
export async function payWithPayPal(page: Page, email: string, password: string): Promise<void> {
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: /paypal|place order/i }).first().click(),
  ]);
  await popup.getByLabel(/email/i).fill(email);
  await popup.getByRole('button', { name: /next/i }).click();
  await popup.getByLabel(/password/i).fill(password);
  await popup.getByRole('button', { name: /log ?in/i }).click();
  await popup.getByRole('button', { name: /pay now|complete purchase/i }).click();
  await popup.waitForEvent('close', { timeout: 60_000 }).catch(() => undefined);
}

// ---------- Afterpay (redirect) ----------
export async function payWithAfterpay(page: Page, email: string, password: string): Promise<void> {
  await page.getByRole('button', { name: /place order|pay/i }).first().click();
  await page.waitForURL(/afterpay|clearpay/i, { timeout: 30_000 });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /log ?in|continue/i }).click();
  await page.getByRole('button', { name: /confirm|authorise|authorize/i }).click();
}

// ---------- Google Pay (iframe from pay.google.com) ----------
function gpayFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[src*="pay.google.com"]').first();
}

/**
 * Clicks the Google Pay button. No credentials — the browser must be
 * signed into Google via `tests/auth.setup.ts`, which every chromium /
 * android-chrome project inherits via `storageState`.
 */
export async function payWithGooglePay(page: Page): Promise<void> {
  await gpayFrame(page).getByRole('button', { name: /google ?pay|buy with/i }).click();
  const popup = await page.waitForEvent('popup', { timeout: 15_000 }).catch(() => null);
  if (popup) {
    await popup.getByRole('button', { name: /continue|pay/i }).click().catch(() => undefined);
    await popup.waitForEvent('close', { timeout: 60_000 }).catch(() => undefined);
  }
}
