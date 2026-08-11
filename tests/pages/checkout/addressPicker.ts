import { Page, expect } from '@playwright/test';
import { randomAddressSearch, ShippingRegion, countryLabel } from '../../fixtures/testData';
import { countryCode, countryName, addressSeedsByRegion } from './regionData';
import { enumerateFilledInputs, readAddressFormState } from './formStateReader';
import type { Logger } from './loginPromptFlow';

/**
 * Reads the country dropdown/selector's current value. Returns null if
 * no country selector is visible (assume default region).
 */
export async function currentCountry(page: Page): Promise<string | null> {
  const select = page.getByLabel(/country/i).first();
  if (!(await select.count().catch(() => 0))) return null;
  // Native <select> exposes selected option text via .inputValue() (name)
  // or the selected <option>'s text.
  const val = ((await select.inputValue().catch(() => '')) ?? '').trim();
  if (val) return val;
  // Fall back to selected option's text.
  const selected = select.locator('option[selected], [aria-selected="true"]').first();
  return ((await selected.textContent().catch(() => null)) ?? '').trim() || null;
}

/**
 * Looks for a saved / already-filled address matching the target
 * country. Checks multiple signals:
 *  - any visible input with a value that ends in ", <countryCode>"
 *  - any visible input with a value containing the full country name
 *  - any text node on the page ending in ", <countryCode>"
 *  - any text node containing the full country name near address text
 */
async function detectSavedAddressForCountry(
  page: Page,
  log: Logger,
  code: string,
): Promise<string | null> {
  const name = ({ AU: countryName.AU, NZ: countryName.NZ, SG: countryName.SG } as Record<string, string>)[code] ?? '';

  // 1. Enumerate ALL visible non-hidden inputs & log the ones with values.
  const filledInputs = await enumerateFilledInputs(page);
  log(
    `  · filled form inputs: ${filledInputs
      .map((i) => `[${i.label}]="${i.value.slice(0, 50)}"`)
      .slice(0, 10)
      .join(' | ') || '(none)'}`,
  );

  const codeSuffix = new RegExp(`,\\s*${code}\\s*$`);
  const nameRe = name ? new RegExp(`\\b${name}\\b`, 'i') : null;

  // Match by ", CODE" suffix or by full country name inside the value.
  const inputMatch = filledInputs.find(
    (i) => codeSuffix.test(i.value) || (nameRe && nameRe.test(i.value)),
  );
  if (inputMatch) {
    log(`  → input already has ${code} address: [${inputMatch.label}]="${inputMatch.value}"`);
    return inputMatch.value;
  }

  // Text-node scan (saved address cards without inputs).
  for (const rx of [codeSuffix, nameRe].filter(Boolean) as RegExp[]) {
    const hit = page.getByText(rx).first();
    if (await hit.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const t = ((await hit.textContent().catch(() => null)) ?? '').trim();
      if (t) {
        log(`  → text on page matches ${code}: "${t.slice(0, 100)}"`);
        return t;
      }
    }
  }

  log(`  · no saved ${code} address detected — will use random search`);
  return null;
}

/**
 * Checks whether the checkout is currently set to the target region and
 * has an address already populated. For logged-in users this means the
 * saved profile matches — no need to re-search.
 */
export async function hasSavedAddressForRegion(
  page: Page,
  log: Logger,
  region: ShippingRegion,
): Promise<boolean> {
  const country = countryLabel[region];
  const code = countryCode[region];
  const current = (await currentCountry(page).catch(() => null)) ?? '';

  const countryMatches =
    !current /* no selector */ ||
    current.toLowerCase().includes(country.toLowerCase()) ||
    current.toLowerCase() === code.toLowerCase();

  if (!countryMatches) {
    log(`  · country selector shows "${current}" but target is "${country}" — will pickAddress`);
    return false;
  }

  // If the site is showing an "Address is not valid" (or similar)
  // validation error, treat the saved address as unusable — force a
  // fresh search.
  const invalid = await page
    .getByText(/address (is )?not valid|invalid address|please enter (a )?valid address|address is required/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (invalid) {
    log(`  · "Address not valid" error is visible — will pickAddress`);
    return false;
  }

  const filled = await detectSavedAddressForCountry(page, log, code).catch(() => null);
  if (filled) {
    log(`  ✓ saved ${code} address detected, country selector matches — skipping search`);
    return true;
  }
  return false;
}

/**
 * Selects the country, types a random 3-char search string into the
 * address autocomplete labeled "Address*", and picks the first
 * suggestion whose textContent ends with the country code (", AU" /
 * ", NZ" / ", SG"). Suggestions can be `role="option"` or plain `<li>`
 * / `<div>` items — the country-suffix match works either way.
 */
export async function pickAddress(page: Page, log: Logger, region: ShippingRegion): Promise<string> {
  const country = countryLabel[region];
  const suffix = countryCode[region];
  log(`step 2 · pickAddress country=${country} (expect ", ${suffix}" suffix)`);

  // Logged-in profiles are AU-based; a stale AU street/postcode lingers
  // in the manual fields even after the country selector flips to NZ/SG.
  // Reusing the saved address early-exit leaves that stale data in the
  // form and fails validation on Continue → payment. For international,
  // always run the full autocomplete search so the picked suggestion
  // overwrites the AU values.
  if (region === 'AU' && (await hasSavedAddressForRegion(page, log, region))) {
    return `(reused saved ${suffix} address)`;
  }

  const countrySelect = page.getByLabel(/country/i);
  if (await countrySelect.count()) {
    await countrySelect
      .first()
      .selectOption({ label: country })
      .catch(async () => {
        await countrySelect.first().click();
        await page
          .getByRole('option', { name: new RegExp(`^${country}$`, 'i') })
          .click();
      });
    // No fixed sleep — the next locator's auto-wait handles the
    // country-change reflow.
  }

  // Detect whether we're in manual-entry mode (any address-related
  // field on the parent page has a pre-filled value). Label-agnostic —
  // Singapore's form doesn't have a "Suburb" field, so a label-based
  // check misses. Instead, look at any filled input whose surrounding
  // label mentions an address concept.
  const state = await readAddressFormState(page);
  log(
    `  · address form state: autocompleteVisible=${state.autocompleteVisible} manualFilled=${state.anyManualFilled} ${state.inspected.slice(0, 3).join(' | ')}`,
  );

  // Logged-in users often arrive with a saved AU address already filled
  // in the shipping form. Switching country to SG/NZ does NOT auto-clear
  // it, so typing straight into the visible Address field would overwrite
  // the saved AU value instead of driving the autocomplete. We must open
  // the "Search for an address" flow first, then find the search input
  // strictly by its placeholder — no label-based fallback.
  const openSearchToggle = async () => {
    const searchToggle = page
      .locator('a, button, [role="button"], span, [role="link"]')
      .filter({
        hasText:
          /^\s*(search (for )?(an |a |my |your )?address|use address search|find (my )?address|change address|edit address|add (new |another )?address|enter (a )?new address|address (search|lookup))\s*$/i,
      })
      .first();
    if (!(await searchToggle.count().catch(() => 0))) {
      log('  ! no address-search toggle found on page');
      return false;
    }
    const label = ((await searchToggle.textContent().catch(() => null)) ?? '').trim();
    log(`  → clicking "${label}" to open autocomplete`);
    await searchToggle.scrollIntoViewIfNeeded().catch(() => undefined);
    await searchToggle.click({ force: true });
    // Wait for the autocomplete input to actually render instead of a
    // fixed sleep. Bounded so a missing toggle-target still surfaces.
    await page
      .locator('input[role="combobox"], input[autocomplete="off"][placeholder*="address" i]')
      .first()
      .waitFor({ state: 'visible', timeout: 3_000 })
      .catch(() => undefined);
    return true;
  };

  // For international, force-open the search toggle regardless of the
  // form state — logged-in AU prefill can look "autocomplete ready"
  // (the KWH input is the same DOM node) but typing straight in would
  // overwrite the visible Address field, not drive the autocomplete.
  const forceSearch = region !== 'AU';
  if (forceSearch || !state.autocompleteVisible || state.anyManualFilled) {
    await openSearchToggle();
  }

  // The autocomplete input is identified strictly by its placeholder /
  // combobox role. The pre-filled Address field is NEVER a valid target,
  // even though it also has label="Address" — matching it would overwrite
  // the saved AU value with a seed word.
  const placeholderRe =
    /start typing|search (for )?address|enter (your |a )?address|type (your |a )?address|look ?up address|address (search|lookup)/i;
  const finderStrict = () =>
    page
      .getByPlaceholder(placeholderRe)
      .or(page.locator('input[autocomplete="off"][role="combobox"]'))
      .first();

  let finder = finderStrict();
  if (!(await finder.isVisible({ timeout: 5_000 }).catch(() => false))) {
    // Toggle may not have been clicked (state check said autocomplete was
    // already visible) but the actual search input isn't there — retry
    // the toggle once and re-locate.
    log('  · autocomplete input not visible — forcing search toggle and retrying');
    await openSearchToggle();
    finder = finderStrict();
    await expect(finder).toBeVisible({ timeout: 15_000 });
  }

  // Match either the ISO code ("Orchard Rd, SG") OR the full country
  // name ("Orchard Rd, Singapore") — different autocomplete providers
  // format the tail differently.
  const suffixEscaped = country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffixRe = new RegExp(`,\\s*(?:${suffix}|${suffixEscaped})\\b`, 'i');

  const seeds = addressSeedsByRegion[region];
  const attempts: string[] = [
    // Try seeds first
    ...seeds,
    // Then fall through to random 3-char attempts
    ...Array.from({ length: 5 }, () => randomAddressSearch()),
  ];

  let search = '';
  for (let i = 0; i < attempts.length; i++) {
    search = attempts[i];
    log(`  attempt ${i + 1}/${attempts.length} · typing "${search}"`);
    await finder.fill('');
    await finder.type(search, { delay: 40 });

    const suggestion = page
      .getByRole('option', { name: suffixRe })
      .or(page.getByText(suffixRe))
      .first();

    try {
      await expect(suggestion).toBeVisible({ timeout: 6_000 });
      const label = (await suggestion.textContent().catch(() => null)) ?? '(unknown)';
      log(`  ✓ suggestion picked: ${label.trim().slice(0, 80)}`);
      await suggestion.click();
      return search;
    } catch {
      log(`  → no ${suffix} suggestion for "${search}", trying next`);
    }
  }
  throw new Error(
    `No ${suffix} address suggestion after ${attempts.length} attempts (last: "${search}"). ` +
      `Check the country selector actually switched to ${country}.`,
  );
}
