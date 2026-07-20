export interface StartOptions {
  headed?: boolean;
  slowMoMs?: number;
  project?: string;
  /** Raw --grep escape hatch. Prefer paymentMethod / section / subtest. */
  grep?: string;
  paymentMethod?: string;
  section?: number;
  subtest?: string;
}

const PAYMENT_METHOD_SLUGS = new Set([
  'credit-card',
  'paypal',
  'afterpay',
  'gpay',
  'applepay',
]);

/**
 * Translate the structured scope selection into Playwright CLI extras.
 * - paymentMethod → positional path filter (`tests/payments/<slug>`)
 * - subtest → grep on the "N.M" test-id substring (highest priority)
 * - section → grep on the section prefix (`N\.\d`)
 *
 * Falls back to the raw `grep` field if the caller sent it and nothing
 * structured is set.
 */
export function buildScopeArgs(opts: StartOptions): { positional: string[]; grep?: string } {
  const positional: string[] = [];
  if (opts.paymentMethod && PAYMENT_METHOD_SLUGS.has(opts.paymentMethod)) {
    positional.push(`tests/payments/${opts.paymentMethod}`);
  }
  if (opts.subtest && /^\d\.\d$/.test(opts.subtest)) {
    const [maj, min] = opts.subtest.split('.');
    return { positional, grep: `\\b${maj}\\.${min}\\b` };
  }
  if (opts.section && opts.section >= 1 && opts.section <= 9) {
    return { positional, grep: `\\b${opts.section}\\.\\d` };
  }
  return { positional, grep: opts.grep };
}
