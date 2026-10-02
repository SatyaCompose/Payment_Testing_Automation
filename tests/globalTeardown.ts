import * as fs from 'fs';
import * as path from 'path';
import { displayDate, reportFileName, runStartedAtMs, screenshotsRoot } from './utils/runTimestamp';
import {
  CHECKOUT_MATRIX,
  PAYMENT_METHODS,
  USER_TYPES,
  screenshotFolder,
  testId,
} from './payments/matrix';

/**
 * Writes `screenshots/Final regression testing document for payments - DD-MM-YYYY.md`
 * in the exact section order of the source Google Doc. Re-running on the
 * same date overwrites the file. The doc title inside preserves `DD/MM/YYYY`.
 *
 * Sections 1–5 (the happy-path matrix) are derived from `payments/matrix.ts`
 * so folder names auto-sync with what the specs write. Sections 6–8
 * (discounts, cross-payment, riskified) are one-off scenarios kept inline.
 */

interface ReportCase {
  id: string;
  title: string;
  folder: string;
}

interface ReportSection {
  heading: string;
  cases: ReportCase[];
}

function matrixSections(paymentSlug: 'credit-card'): ReportSection[] {
  const payment = PAYMENT_METHODS[paymentSlug];
  return CHECKOUT_MATRIX.map((section) => ({
    heading: `## ${payment.longLabel} · ${section.reportHeading}`,
    cases: USER_TYPES.map((user) => ({
      id: testId(section, user),
      title: `${user.reportLabel} Checkout with ${payment.longLabel} Payment (${section.short})`,
      folder: screenshotFolder(section, user, payment),
    })),
  }));
}

const SPECIAL_SECTIONS: ReportSection[] = [
  {
    heading: '## Credit Card · Gift Cards / Promo',
    cases: [
      { id: '6.1', title: 'Apply Promo Code with Credit Card Payment', folder: '6.1-cc-promo-code' },
      { id: '6.2', title: 'Fail and Succeed Payment with Credit Card After Applying Gift Card', folder: '6.2-cc-gift-card-fail-then-succeed' },
    ],
  },
  {
    heading: '## Credit Card · Cross-Payment Methods',
    cases: [
      { id: '7.1', title: 'Payment Failure with Credit Card and Retry with Google Pay', folder: '7.1-cc-fail-retry-gpay' },
      { id: '7.2', title: 'Payment Failure with Credit Card and Retry with PayPal', folder: '7.2-cc-fail-retry-paypal' },
      { id: '7.3', title: 'Payment Failure with Credit Card and Retry with Afterpay', folder: '7.3-cc-fail-retry-afterpay' },
    ],
  },
  {
    heading: '## Credit Card · Riskified Verification',
    cases: [
      { id: '8.1', title: 'Payment Failure with Credit Card by Blocking Dispatch Order API and Retrying', folder: '8.1-cc-riskified-dispatch-block' },
    ],
  },
];

const REPORT_SECTIONS: ReportSection[] = [...matrixSections('credit-card'), ...SPECIAL_SECTIONS];

const DESKTOP_PROJECTS = ['chromium-desktop', 'safari-desktop'];
const MOBILE_PROJECTS = ['mobile-safari', 'android-chrome'];

interface Shot {
  file: string;
  modifiedAt: Date;
  /**
   * True only when the file was last written at or after this run started.
   * A screenshot is rewritten (old one deleted first) every time a test
   * captures it, so its modified time is the only fact the teardown has
   * about when it was produced; it has no access to per-test results.
   * If the run start was not recorded, nothing can be proven fresh.
   */
  fromThisRun: boolean;
}

let carriedOverCount = 0;

function screenshotsFor(caseDir: string, projects: string[]): Shot[] {
  if (!fs.existsSync(caseDir)) return [];
  // Read at call time, not import time: the start is recorded by globalSetup.
  const runStartedAt = runStartedAtMs();
  return fs
    .readdirSync(caseDir)
    .filter((f) => projects.some((p) => f.startsWith(p)) && f.endsWith('.png'))
    .map((f) => {
      const file = path.join(caseDir, f);
      const modifiedAt = fs.statSync(file).mtime;
      return {
        file,
        modifiedAt,
        fromThisRun: runStartedAt !== null && modifiedAt.getTime() >= runStartedAt,
      };
    });
}

function relative(from: string, to: string): string {
  return path.relative(path.dirname(from), to).split(path.sep).join('/');
}

function formatTimestamp(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${displayDate(d)} ${hh}:${mm}`;
}

function appendScreenshotBlock(
  lines: string[],
  label: string,
  shots: Shot[],
  reportPath: string,
): void {
  lines.push(`**${label}:**`, '');
  if (shots.length === 0) {
    lines.push('_(not captured this run)_', '');
    return;
  }
  for (const shot of shots) {
    const image = `![](${relative(reportPath, shot.file)})`;
    if (shot.fromThisRun) {
      lines.push(`- \`${path.basename(shot.file)}\` — ${image}`);
    } else {
      carriedOverCount += 1;
      lines.push(
        `- \`${path.basename(shot.file)}\` — **CARRIED OVER, NOT FROM THIS RUN** (captured ${formatTimestamp(shot.modifiedAt)}; this test did not produce a new screenshot in this run, so this is not this run's result) — ${image}`,
      );
    }
  }
  lines.push('');
}

async function globalTeardown(): Promise<void> {
  carriedOverCount = 0;
  const root = screenshotsRoot();
  fs.mkdirSync(root, { recursive: true });

  const reportPath = path.join(root, reportFileName());
  const lines: string[] = [
    `# Final regression testing document for payments - ${displayDate()}`,
    '',
    `Run date: ${displayDate()}`,
    '',
    `Source doc format preserved. Paste each row's image into the matching cell in the Google Doc — rename the Google Doc to match this file's date.`,
    '',
    '---',
    '',
  ];

  for (const section of REPORT_SECTIONS) {
    lines.push(section.heading, '');
    for (const tc of section.cases) {
      const caseDir = path.join(root, tc.folder);
      lines.push(`### Test Case ${tc.id}: ${tc.title}`, '');
      appendScreenshotBlock(lines, 'Desktop Screenshot', screenshotsFor(caseDir, DESKTOP_PROJECTS), reportPath);
      appendScreenshotBlock(lines, 'Mobile Screenshot', screenshotsFor(caseDir, MOBILE_PROJECTS), reportPath);
      lines.push('---', '');
    }
  }

  if (carriedOverCount > 0) {
    // Insert after the intro paragraph's trailing blank line, before the first '---' (index 6).
    const warning = [
      `> **WARNING: ${carriedOverCount} screenshot(s) below are CARRIED OVER from an earlier run, not produced by this run.** They are marked "CARRIED OVER, NOT FROM THIS RUN". Do not present them as this run's results.`,
      '',
    ];
    lines.splice(6, 0, ...warning);
  }

  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n📄 Report written: ${path.relative(process.cwd(), reportPath)}\n`);
  if (carriedOverCount > 0) {
    console.log(`⚠️  ${carriedOverCount} screenshot(s) in the report are carried over from an earlier run and are labelled as such.\n`);
  }
}

export default globalTeardown;
