import { useMemo } from 'react';

export interface TestScope {
  /** Empty string = all payment methods. */
  paymentMethod: string;
  /** 0 = all sections; 1..8 selects a section. */
  section: number;
  /** Empty string = all sub-tests in the section. Otherwise a "N.M" id. */
  subtest: string;
  /**
   * Free-form comma-separated list of "N.M" ids ("2.3, 3.1, 4.2"). When
   * non-empty, overrides `section` + `subtest` and runs exactly the
   * listed tests in one Playwright invocation.
   */
  subtestIds: string;
}

export interface PaymentMethodOption {
  value: string;
  label: string;
  /** Folder name under tests/payments/ — used server-side to path-scope the run. */
  pathSlug?: string;
}

export interface SubtestOption {
  id: string;
  label: string;
}

export interface SectionDef {
  id: number;
  label: string;
  subtests: SubtestOption[];
}

export const PAYMENT_METHODS: PaymentMethodOption[] = [
  { value: '', label: 'All payment methods' },
  { value: 'credit-card', label: 'Credit Card', pathSlug: 'credit-card' },
  { value: 'paypal', label: 'PayPal', pathSlug: 'paypal' },
  { value: 'afterpay', label: 'Afterpay', pathSlug: 'afterpay' },
  { value: 'gpay', label: 'Google Pay', pathSlug: 'gpay' },
  { value: 'applepay', label: 'Apple Pay', pathSlug: 'applepay' },
];

export const SECTIONS: SectionDef[] = [
  {
    id: 1,
    label: '1. AU · Standard shipping',
    subtests: [
      { id: '1.1', label: '1.1 · Logged-in' },
      { id: '1.2', label: '1.2 · New user' },
      { id: '1.3', label: '1.3 · Guest (existing email)' },
    ],
  },
  {
    id: 2,
    label: '2. AU · Express shipping',
    subtests: [
      { id: '2.1', label: '2.1 · Logged-in' },
      { id: '2.2', label: '2.2 · New user' },
      { id: '2.3', label: '2.3 · Guest (existing email)' },
    ],
  },
  {
    id: 3,
    label: '3. International · New Zealand',
    subtests: [
      { id: '3.1', label: '3.1 · Logged-in' },
      { id: '3.2', label: '3.2 · New user' },
      { id: '3.3', label: '3.3 · Guest (existing email)' },
    ],
  },
  {
    id: 4,
    label: '4. International · Singapore',
    subtests: [
      { id: '4.1', label: '4.1 · Logged-in' },
      { id: '4.2', label: '4.2 · New user' },
      { id: '4.3', label: '4.3 · Guest (existing email)' },
    ],
  },
  {
    id: 5,
    label: '5. Click & Collect',
    subtests: [
      { id: '5.1', label: '5.1 · Logged-in' },
      { id: '5.2', label: '5.2 · New user' },
      { id: '5.3', label: '5.3 · Guest (existing email)' },
    ],
  },
  {
    id: 6,
    label: '6. Discounts',
    subtests: [
      { id: '6.1', label: '6.1 · Promo code' },
      { id: '6.2', label: '6.2 · Gift card + CC failover' },
    ],
  },
  {
    id: 7,
    label: '7. Cross-payment retry',
    subtests: [
      { id: '7.1', label: '7.1 · CC → Google Pay' },
      { id: '7.2', label: '7.2 · CC → PayPal' },
      { id: '7.3', label: '7.3 · CC → Afterpay' },
    ],
  },
  {
    id: 8,
    label: '8. Riskified',
    subtests: [{ id: '8.1', label: '8.1 · Dispatch block + retry' }],
  },
];

interface Props {
  value: TestScope;
  onChange: (next: TestScope) => void;
}

/**
 * Parse the free-form "specific ids" input into a normalised list.
 * Accepts commas, whitespace, or both as separators. Silently drops
 * tokens that don't match `N.M` — validation happens on the caller so
 * the UI can show a hint.
 */
export function parseSubtestIds(raw: string): string[] {
  return raw
    .split(/[,\s]+/g)
    .map((t) => t.trim())
    .filter((t) => /^\d+\.\d+$/.test(t));
}

export function TestScopeSelector({ value, onChange }: Props) {
  const selectedSection = useMemo(
    () => SECTIONS.find((s) => s.id === value.section),
    [value.section],
  );
  const overrideActive = parseSubtestIds(value.subtestIds).length > 0;
  const subtestDisabled = !selectedSection || overrideActive;
  const sectionDisabled = overrideActive;

  const parsedIds = useMemo(() => parseSubtestIds(value.subtestIds), [value.subtestIds]);
  const rawTokens = value.subtestIds
    .split(/[,\s]+/g)
    .map((t) => t.trim())
    .filter(Boolean);
  const invalidTokens = rawTokens.filter((t) => !/^\d+\.\d+$/.test(t));

  const commonSelectClass =
    'rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Payment method
        <select
          value={value.paymentMethod}
          onChange={(e) => onChange({ ...value, paymentMethod: e.target.value })}
          className={commonSelectClass}
        >
          {PAYMENT_METHODS.map((p) => (
            <option key={p.value || 'all'} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Section
        <select
          value={value.section}
          disabled={sectionDisabled}
          onChange={(e) => {
            const next = Number(e.target.value);
            onChange({ ...value, section: next, subtest: '' });
          }}
          className={commonSelectClass}
        >
          <option value={0}>All sections</option>
          {SECTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Sub-test
        <select
          value={value.subtest}
          disabled={subtestDisabled}
          onChange={(e) => onChange({ ...value, subtest: e.target.value })}
          className={commonSelectClass}
        >
          <option value="">
            {subtestDisabled ? 'All (choose a section first)' : 'All in section'}
          </option>
          {selectedSection?.subtests.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        <span>
          Specific IDs
          <span className="ml-1 text-slate-500">
            (comma-separated — e.g. "2.3, 3.1, 4.2"). Overrides Section + Sub-test when set.
          </span>
        </span>
        <input
          type="text"
          value={value.subtestIds}
          onChange={(e) => onChange({ ...value, subtestIds: e.target.value })}
          placeholder="2.3, 3.1, 4.2"
          className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 focus:border-accent focus:outline-none"
        />
        {overrideActive && (
          <span className="text-[11px] text-accent">
            Will run: {parsedIds.join(', ')} ({parsedIds.length} test{parsedIds.length === 1 ? '' : 's'})
          </span>
        )}
        {invalidTokens.length > 0 && (
          <span className="text-[11px] text-warn">
            Ignoring invalid: {invalidTokens.join(', ')} — expected format "N.M"
          </span>
        )}
      </label>
    </div>
  );
}

/**
 * Builds Playwright CLI extras (grep + positional file path) from a scope
 * selection. Kept alongside the component so the mapping lives in one
 * place. The runner server can consume `paymentMethod` / `section` /
 * `subtest` directly instead if that turns out to be cleaner.
 */
export function scopeToStartOptions(scope: TestScope): {
  paymentMethod?: string;
  section?: number;
  subtest?: string;
  subtests?: string[];
} {
  const parsedIds = parseSubtestIds(scope.subtestIds);
  if (parsedIds.length > 0) {
    // Multi-id run — ignore section/subtest, hand the server the list.
    return {
      paymentMethod: scope.paymentMethod || undefined,
      subtests: parsedIds,
    };
  }
  return {
    paymentMethod: scope.paymentMethod || undefined,
    section: scope.section || undefined,
    subtest: scope.subtest || undefined,
  };
}
