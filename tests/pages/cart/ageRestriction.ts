import { Page } from '@playwright/test';

export type Logger = (message: string) => void;

/**
 * Handles the "I'm 18 or over" age-verification checkbox that shows on
 * knives and other age-restricted products. Tries multiple selector
 * strategies; no-op if no such checkbox exists.
 */
export async function handleAgeRestrictionCheckbox(page: Page, log: Logger): Promise<void> {
  const anyAgeText = page.getByText(/i.?m 18 or over|18 or over|age verification/i).first();
  if (!(await anyAgeText.isVisible().catch(() => false))) {
    // Nothing to do — this isn't an age-restricted product.
    return;
  }

  log('  → age-restricted product detected');

  const candidates = [
    {
      name: 'role=checkbox, name~18',
      get: () => page.getByRole('checkbox', { name: /18 or over|over 18|age|adult/i }).first(),
    },
    {
      name: 'getByLabel(/18 or over/)',
      get: () => page.getByLabel(/i.?m 18 or over|18 or over|over 18/i).first(),
    },
    {
      name: 'label:has-text(18 or over) input',
      get: () => page.locator('label:has-text("18 or over") input[type="checkbox"]').first(),
    },
    {
      name: 'label:has-text(18 or over)',
      get: () => page.locator('label').filter({ hasText: /18 or over/i }).first(),
    },
    {
      name: 'input[type="checkbox"] near /18 or over/',
      get: () => page.locator('input[type="checkbox"]').first(),
    },
  ];

  for (const c of candidates) {
    const loc = c.get();
    if (!(await loc.count().catch(() => 0))) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;

    const already = await loc.isChecked().catch(() => false);
    if (already) {
      log(`  → age checkbox already ticked (via ${c.name})`);
      return;
    }

    try {
      await loc.check({ force: true, timeout: 4_000 });
      log(`  ✓ age checkbox ticked via ${c.name}`);
      // Verify it stuck.
      const checkedNow = await loc.isChecked().catch(() => false);
      if (checkedNow) return;
      log("  · check() didn't stick, trying click fallback");
    } catch (err) {
      log(`  · ${c.name}.check() failed: ${(err as Error).message.split('\n')[0]}`);
    }

    try {
      await loc.click({ force: true, timeout: 4_000 });
      log(`  ✓ clicked ${c.name}`);
      return;
    } catch {
      // continue to next candidate
    }
  }

  // Last-ditch: click the visible age text itself (a span/div, not a label).
  log('  → clicking the "I\'m 18 or over" text as fallback');
  await anyAgeText.click({ force: true }).catch(() => undefined);
}
