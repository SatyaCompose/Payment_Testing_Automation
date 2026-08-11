export interface StartOptions {
  headed?: boolean;
  slowMoMs?: number;
  project?: string;
  /** Raw --grep escape hatch. Prefer paymentMethod / section / subtest. */
  grep?: string;
  paymentMethod?: string;
  section?: number;
  subtest?: string;
  /**
   * Free-form list of "N.M" ids to run together (e.g. ["2.3", "3.1", "4.2"]).
   * When present, overrides `section` + `subtest` and grep matches any of them.
   */
  subtests?: string[];
  /** Record every test as WebM video (overrides retain-on-failure default). */
  recordVideo?: boolean;
  /** Playwright worker count. Undefined → let the config default fire. */
  workers?: number;
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
  // Multi-id run — build a single alternation grep, e.g. `\b(2\.3|3\.1|4\.2)\b`.
  // Highest priority: overrides section + subtest.
  const validIds = (opts.subtests ?? []).filter((s) => /^\d+\.\d+$/.test(s));
  if (validIds.length > 0) {
    const alt = validIds.map((s) => s.replace('.', '\\.')).join('|');
    return { positional, grep: `\\b(${alt})\\b` };
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
