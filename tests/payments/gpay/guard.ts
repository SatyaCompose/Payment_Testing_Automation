import { test } from '@playwright/test';

/**
 * Single definition of "is Google Pay automation switched on".
 *
 * GPAY_MODE:
 *   off    (default) every Google Pay test skips, with a visible reason.
 *   manual a human clicks Pay in Google's popup while the test waits
 *          (see GPAY_MANUAL_TIMEOUT_MS and tests/payments/gpay/MANUAL.md).
 *   auto   RESERVED. No automated Pay click exists yet, so today this
 *          behaves exactly like `manual`. Do not read it as "automation
 *          is implemented".
 *
 * An unrecognised value throws rather than silently picking a mode.
 */
export type GpayMode = 'off' | 'manual' | 'auto';

export function gpayMode(): GpayMode {
  const raw = (process.env.GPAY_MODE ?? '').trim().toLowerCase();
  if (raw === '') return 'off';
  if (raw === 'off' || raw === 'manual' || raw === 'auto') return raw;
  throw new Error(`GPAY_MODE="${process.env.GPAY_MODE}" is not valid. Use off, manual or auto.`);
}

/** Skip reason when Google Pay tests must not run, or undefined when they may. */
export function gpaySkipReason(): string | undefined {
  return gpayMode() === 'off'
    ? 'Google Pay is off (GPAY_MODE=off). Set GPAY_MODE=manual to run it with a human clicking Pay in the popup.'
    : undefined;
}

/** Call inside a test or hook: skips the current test when Google Pay is off. */
export function requireGpayMode(): void {
  const reason = gpaySkipReason();
  test.skip(reason !== undefined, reason);
}
