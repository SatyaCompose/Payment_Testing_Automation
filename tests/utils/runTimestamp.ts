import * as path from 'path';

const SCREENSHOTS_ROOT = path.resolve(__dirname, '..', '..', 'screenshots');

export function screenshotsRoot(): string {
  return SCREENSHOTS_ROOT;
}

/**
 * `18/07/2026` — used inside the markdown report as the human-readable date.
 */
export function displayDate(d: Date = new Date()): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * `18-07-2026` — used in the report filename. macOS treats `/` as a path
 * separator so we can't use it in filenames; the doc title inside preserves
 * the `/` form.
 */
export function fileDate(d: Date = new Date()): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

const RUN_START_ENV = 'PW_RUN_STARTED_AT_MS';

/**
 * Called by globalSetup. globalSetup and globalTeardown run in the same
 * Playwright main process, so an env var carries the start time between them.
 */
export function markRunStart(): void {
  process.env[RUN_START_ENV] = String(Date.now());
}

/** Epoch ms when this run began, or null if globalSetup did not record it. */
export function runStartedAtMs(): number | null {
  const raw = process.env[RUN_START_ENV];
  const ms = raw ? Number(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function reportFileName(): string {
  return `Final regression testing document for payments - ${fileDate()}.md`;
}
