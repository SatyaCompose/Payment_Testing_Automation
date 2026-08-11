import { Page, expect } from '@playwright/test';
import type { Logger } from './loginPromptFlow';

/**
 * Ensures the customer email input has a value. After a logged-in SSO,
 * the site may or may not autofill this — if it's blank we fill it.
 */
export async function ensureCustomerEmail(page: Page, log: Logger, email: string): Promise<void> {
  const field = page.getByLabel(/email/i).first();
  if (!(await field.count().catch(() => 0))) {
    log('  → no email field visible — assume already past customer step');
    return;
  }
  const current = ((await field.inputValue().catch(() => '')) ?? '').trim();
  if (current) {
    log(`  → email already filled: "${current}"`);
    return;
  }
  log(`  → email empty, filling with ${email}`);
  await field.fill(email);
}

export async function enterCustomerEmail(page: Page, log: Logger, email: string): Promise<void> {
  log(`step 1 · entering customer email = ${email}`);
  await page.getByLabel(/email/i).first().fill(email);
}

export async function chooseGuestCheckout(page: Page, log: Logger): Promise<void> {
  // KWH performs an async email lookup after enterCustomerEmail. If the
  // email is registered, the "Continue as guest" button surfaces after
  // that lookup completes. We can't race it against the "Continue to
  // shipping" button — that one is always visible on step 1, so the
  // race would exit immediately and skip the guest prompt. Wait
  // explicitly for the guest button up to 4s; if it never appears the
  // email wasn't recognized as existing and we can proceed directly.
  const guest = page
    .locator('button, [role="button"], a')
    .filter({
      hasText: /continue\s*as\s*guest|checkout\s*as\s*guest|guest\s*checkout|skip.*guest|no\s*thanks.*guest|proceed\s*as\s*guest/i,
    })
    .first();

  const found = await guest
    .waitFor({ state: 'visible', timeout: 4_000 })
    .then(() => true)
    .catch(() => false);

  if (!found) {
    log('step 1 · no guest-checkout prompt within 4s — proceeding directly');
    return;
  }

  const label = ((await guest.textContent().catch(() => null)) ?? '').trim();
  log(`step 1 · clicking "${label}"`);
  await guest.scrollIntoViewIfNeeded().catch(() => undefined);
  await guest.click({ force: true }).catch(() => undefined);
  // If the guest button lived in a modal, wait for the dialog to close.
  await page
    .getByRole('dialog')
    .filter({ hasText: /already|register|account|guest/i })
    .first()
    .waitFor({ state: 'hidden', timeout: 4_000 })
    .catch(() => undefined);
}

export async function chooseCreateAccountDuringCheckout(
  page: Page,
  log: Logger,
  password: string,
): Promise<void> {
  log('step 1 · toggling Create account and setting password');
  const create = page
    .getByRole('checkbox', { name: /create (an )?account|register/i })
    .or(page.getByLabel(/create (an )?account|register/i))
    .first();
  // Short-timeout check — for a fresh temp email the site returns
  // "no account" fast, so the checkbox should render within a second.
  // Longer waits here were the noticeable "3s" delay after email input.
  await create.check({ timeout: 3_000 }).catch(() => undefined);
  const pwd = page.getByLabel(/^password$/i).first();
  if (await pwd.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await pwd.fill(password);
  }
}

export async function continueToShipping(page: Page, log: Logger): Promise<void> {
  log('step 1 · Continue → Shipping');

  // Prefer "Continue to shipping"; fall back to bare "Continue".
  // Wait for the preferred button to render — some checkout layouts
  // hydrate it late.
  const preferred = page
    .locator('button, [role="button"], a, input[type="submit"], input[type="button"]')
    .filter({ hasText: /continue\s*to\s*(shipping|delivery)/i })
    .first();
  const fallback = page
    .locator('button, [role="button"], a, input[type="submit"]')
    .filter({ hasText: /^\s*continue\s*$/i })
    .first();

  // Wait up to 15s for the preferred "Continue to shipping" button.
  // Mobile-safari can take 8-12s to hydrate the button after the
  // customer step renders, and the fallback "Continue" locator often
  // matches nothing (or matches a stale button from step 2/3 collapsed
  // headers), which then wastes the full 20s click timeout.
  const preferredVisible = await preferred
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const continueBtn = preferredVisible ? preferred : fallback;

  const clickable = await continueBtn.count().catch(() => 0);
  if (clickable) {
    const label = ((await continueBtn.textContent().catch(() => null)) ?? '').trim();
    const enabled = await continueBtn.isEnabled().catch(() => true);
    log(`  → clicking "${label}" (enabled=${enabled})`);
    await continueBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await continueBtn.click({ force: true });
  } else {
    const clickables = await page
      .locator('button, [role="button"], a, input[type="submit"]')
      .allTextContents()
      .catch(() => []);
    log(
      `  → no Continue-labeled control found. Clickables: ${clickables.slice(0, 15).map((s) => s.trim()).filter((s) => s && s.length < 60).join(' | ')}`,
    );
  }

  // Post-click: wait for anything that indicates step 2 is up. Include
  // the shipping-conflict modal's action labels — that modal renders ON
  // step 2 and can cover the usual "search for an address / billing /
  // shipping method" text, so its presence is itself proof step 2
  // loaded. selectShippingMethod resolves the modal downstream.
  const shippingReady = page
    .getByText(/search for an address|billing address|shipping method|delivery method|ship all items instead|select another store|remove low stock items/i)
    .or(page.getByLabel(/first name|given name|forename/i))
    .or(page.getByLabel(/^address\*?$|street address|address line/i))
    .or(page.getByLabel(/postcode|postal code|zip/i))
    .or(page.getByLabel(/city|suburb|town/i))
    .first();

  try {
    await expect(shippingReady).toBeVisible({ timeout: 20_000 });
    log('  ✓ step 2 is visible');
  } catch (err) {
    const labels = await page.locator('label:visible').allTextContents().catch(() => []);
    const headings = await page
      .locator('h1:visible, h2:visible, h3:visible, h4:visible')
      .allTextContents()
      .catch(() => []);
    log(
      `  ! step-2 wait timed out.\n     Visible labels: ${labels.slice(0, 15).map((s) => s.trim().slice(0, 40)).filter(Boolean).join(' | ')}` +
        `\n     Visible headings: ${headings.slice(0, 10).map((s) => s.trim().slice(0, 40)).filter(Boolean).join(' | ')}`,
    );
    throw err;
  }
}
