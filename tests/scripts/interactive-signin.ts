import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const AUTH_FILE = path.resolve(__dirname, '..', '.auth', 'user.json');
const STAGING_URL = process.env.STAGING_URL ?? 'https://staging.kitchenwarehouse.com.au';

const MANUAL_TIMEOUT_MS = 10 * 60 * 1000;

async function waitForUrlLeaving(page: import('@playwright/test').Page, pattern: RegExp, timeoutMs: number) {
  await page.waitForFunction(
    (rx) => !new RegExp(rx, 'i').test(location.href),
    pattern.source,
    { timeout: timeoutMs, polling: 1000 },
  );
}

async function main() {
  console.log('\n=== KWH Payments · Manual Sign-in ===\n');
  console.log('A real Chrome window is opening. Sign in as you normally would.');
  console.log('This script will detect the login and save the session automatically.\n');

  const browser = await chromium.launch({
    headless: false,
    channel: process.env.SIGNIN_CHANNEL || 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  }).catch(async () => {
    // Fall back to Playwright's bundled Chromium if real Chrome isn't installed.
    console.log('(Real Chrome not found — falling back to bundled Chromium.)');
    return chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // ---------- Step 1: Google ----------
  console.log('👤 Step 1 — sign into your Google account…');
  await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForURL(
      (url) =>
        /myaccount\.google\.com|accounts\.google\.com\/b\/0\/|google\.com\/intl\//i.test(url.href),
      { timeout: MANUAL_TIMEOUT_MS },
    );
    console.log('✓ Google sign-in detected.\n');
  } catch {
    console.error('❌ Timed out waiting for Google sign-in after 10 minutes.');
    await browser.close();
    process.exit(1);
  }

  // ---------- Step 2: KWH ----------
  console.log(`👤 Step 2 — sign into KWH at ${STAGING_URL}/Account …`);
  console.log('   You can use "Continue with Google" — you\'re already signed into Google.');
  await page.goto(`${STAGING_URL}/Account`, { waitUntil: 'domcontentloaded' });
  try {
    // Consider signed-in once we leave the /login and Kinde-hosted flow.
    await waitForUrlLeaving(page, /kinde\.com|\/login|accounts\.google\.com/i, MANUAL_TIMEOUT_MS);
    console.log('✓ KWH sign-in detected.\n');
  } catch {
    console.error('❌ Timed out waiting for KWH sign-in after 10 minutes.');
    await browser.close();
    process.exit(1);
  }

  // ---------- Save state ----------
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await context.storageState({ path: AUTH_FILE });
  await context.close();
  await browser.close();

  console.log(`💾 Session saved to ${path.relative(process.cwd(), AUTH_FILE)}`);
  console.log('\nYou can close this terminal. All subsequent test runs will reuse this session.\n');
}

main().catch(async (err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
