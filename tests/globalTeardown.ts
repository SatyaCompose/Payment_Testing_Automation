import * as fs from 'fs';
import * as path from 'path';
import { displayDate, reportFileName, screenshotsRoot } from './utils/runTimestamp';
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

function screenshotsFor(caseDir: string, projects: string[]): string[] {
  if (!fs.existsSync(caseDir)) return [];
  return fs
    .readdirSync(caseDir)
    .filter((f) => projects.some((p) => f.startsWith(p)) && f.endsWith('.png'))
    .map((f) => path.join(caseDir, f));
}

function relative(from: string, to: string): string {
  return path.relative(path.dirname(from), to).split(path.sep).join('/');
}

function appendScreenshotBlock(
  lines: string[],
  label: string,
  shots: string[],
  reportPath: string,
): void {
  lines.push(`**${label}:**`, '');
  if (shots.length === 0) {
    lines.push('_(not captured this run)_', '');
    return;
  }
  for (const f of shots) {
    lines.push(`- \`${path.basename(f)}\` — ![](${relative(reportPath, f)})`);
  }
  lines.push('');
}

async function globalTeardown(): Promise<void> {
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

  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n📄 Report written: ${path.relative(process.cwd(), reportPath)}\n`);
}

export default globalTeardown;
