# KWH Payments Staging Tests

Playwright + TypeScript end-to-end tests for `staging.kitchenwarehouse.com.au` (Next.js). Covers the full checkout across four payment methods — **Credit Card (Cybersource)**, **PayPal (sandbox)**, **Afterpay (sandbox)**, **Google Pay** — plus an **Apple Pay** smoke, across four browser projects: desktop Chrome, desktop Safari, mobile Safari (iPhone 14), Android Chrome (Pixel 7).

Ships with a React + Express **runner dashboard** (`runner/`) for live test-feed monitoring and one-tap termination, and an automatic dated markdown report that mirrors the source Google Doc's format for easy screenshot pasting.

---

## Prerequisites

- Node.js 20+
- npm 10+
- Access to KWH staging + sandbox credentials

## Setup

```bash
npm install
npx playwright install --with-deps
cp .env.example .env
# then fill in what you need (see "Environment variables" below)

# Optional: runner UI
npm run runner:install
```

## Running tests

### CLI

```bash
npm test                       # all browsers, all specs
npm run test:ui                # Playwright UI mode — best for iteration
npm run test:headed            # watch the browser drive itself
npm run test:debug             # step through with the Inspector

# By browser project
npm run test:chromium
npm run test:webkit
npm run test:mobile-safari
npm run test:android

# By CC test group
npm run test:cc

# Reports
npm run report                 # open the last HTML report
npm run codegen                # record locators against staging
```

### Runner UI (React dashboard)

```bash
npm run runner:dev             # Vite:5173 + Express:3001 in one command
# open http://localhost:5173 → click Start → watch live feed → Stop terminates all remaining tests
```

Auto-detects desktop vs mobile viewport and swaps the layout. Mobile view has a sticky bottom Stop button; desktop view is a sidebar + main-feed grid. Details in `runner/README.md`.

---

## Project structure

```
tests/
├── payments/
│   └── credit-card/                     # reference suite — 8 files, 21 tests
│       ├── au-standard.spec.ts          # 1.1 – 1.3
│       ├── au-express.spec.ts           # 2.1 – 2.3
│       ├── international-nz.spec.ts     # 3.1 – 3.3
│       ├── international-sg.spec.ts     # 4.1 – 4.3
│       ├── cnc.spec.ts                  # 5.1 – 5.3   (auto-picks first in-stock store)
│       ├── gift-cards.spec.ts           # 6.1 – 6.2   (fetches code from Google Sheet)
│       ├── cross-payment.spec.ts        # 7.1 – 7.3   (CC fail → retry gpay / paypal / afterpay)
│       └── riskified.spec.ts            # 8.1         (page.route() blocks Dispatch Order)
├── pages/
│   ├── BasePage.ts
│   ├── CartPage.ts                      # random search-term product add + minCartTotal helper
│   ├── LoginPage.ts                     # Kinde email/pw + Google SSO
│   ├── RegisterPage.ts
│   ├── CheckoutPage.ts                  # 3-step flow, random 3-char address search, CNC auto-pick
│   ├── PaymentPage.ts                   # 4 methods + promo + gift card
│   └── OrderConfirmationPage.ts         # expectSuccess + captureScreenshot
├── flows/
│   └── CheckoutFlow.ts                  # parameterized (userType × shipping × region × payment)
├── fixtures/
│   ├── auth.ts
│   ├── testData.ts                      # kitchen search terms, countries, GIFT_CARD_MAX_AUD
│   └── index.ts                         # merged `test` with page-object fixtures
├── reporters/
│   └── ui-reporter.ts                   # emits __UI__:{json} lines for the runner dashboard
├── utils/
│   ├── giftCards.ts                     # fetches sheet CSV, picks first unused code
│   ├── runTimestamp.ts                  # `18/07/2026` display + `18-07-2026` filename helpers
│   └── testCards.ts                     # Cybersource sandbox card catalog
├── .auth/                               # storageState (gitignored)
├── auth.setup.ts                        # signs into Google → then KWH via Kinde
├── globalTeardown.ts                    # writes dated regression MD report

runner/                                  # React operator dashboard (see runner/README.md)
├── server/index.ts                      # Express + SSE + spawn/kill Playwright child
└── src/                                 # Vite + React + Tailwind

.claude/agents/                          # playwright-specialist, payments-qa, test-report-reviewer
.github/workflows/playwright.yml         # CI matrix per browser
screenshots/                             # per-test-id folders + dated MD report (gitignored)
playwright.config.ts
CLAUDE.md
```

---

## What makes each spec run

- **Product** — random kitchen search term (`napkins`, `pans`, `wolstead`, `casserole`, …) → site search → random result. Test 6.2 keeps adding until cart total > 220 AUD (gift card caps at 200).
- **Address** — random 3-char string (letters or digits) typed into the site's address autocomplete, scoped to the country select. First suggestion is picked. Retries up to 3 times if no results.
- **CNC store** — auto-picks the first store showing "In Stock".
- **Gift card** — fetches the KWH gift-card Google Sheet at run time, returns the first row where `Status` is empty. Falls back to `GIFT_CARD_NUMBER` env var if the sheet is private.
- **Auth** — `tests/auth.setup.ts` signs into Google (`accounts.google.com`) first, then KWH via Kinde, and saves one combined `storageState`. Every browser project loads it, so **Google Pay tests don't need per-test credentials** — the browser is already signed into the Google account.
- **Screenshots** — every successful order-confirmation is captured to `screenshots/<test-id>/<browser>-order-confirmation.png`. A single dated markdown file is written at run end: `screenshots/Final regression testing document for payments - DD-MM-YYYY.md`, laid out in the exact section order of the source Google Doc.

---

## Environment variables

Full list in `.env.example`. Highlights:

| Var                                     | Purpose                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `STAGING_URL`                           | Base URL (`https://staging.kitchenwarehouse.com.au`)               |
| `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`| Google account (used by Kinde direct login + Google SSO + GPay)    |
| `GUEST_EXISTING_EMAIL`                  | Registered email used in guest-checkout specs                      |
| `TEST_CARD_*`                           | Cybersource sandbox card (holder not needed)                       |
| `PAYPAL_SANDBOX_*`                      | PayPal sandbox buyer                                               |
| `AFTERPAY_SANDBOX_*`                    | Afterpay sandbox buyer                                             |
| `APPLEPAY_EMAIL` / `APPLEPAY_PASSWORD`  | Apple Pay test buyer                                               |
| `PROMO_CODE`                            | Promo used in spec 6.1                                             |
| `GIFT_CARD_SHEET_ID` / `_GID`           | Source sheet (defaults set)                                        |
| `GIFT_CARD_NUMBER` / `GIFT_CARD_PIN`    | Fallback if sheet fetch fails                                      |
| `KITCHEN_SEARCH_TERMS`                  | Optional comma-separated pool override                             |
| `PRODUCT_LISTING_PATH`                  | Fallback listing (`/clearance`)                                    |
| `BASE_TIMEOUT_MS`                       | Global timeout (default 60000)                                     |

Vars **removed** because they're now auto-derived: `TEST_CARD_HOLDER`, `TEST_PRODUCT_SLUG`, `TEST_PRODUCT_SEARCH_TERM`, `CNC_STORE_NAME`, `GPAY_TEST_EMAIL`, `GPAY_TEST_PASSWORD`, `AU/NZ/SG_ADDRESS_SEARCH`, `AU/NZ/SG_ADDRESS_POSTCODE`.

---

## Browser matrix

Four Playwright projects in `playwright.config.ts`:

| Project           | Playwright engine       | Represents                    |
| ----------------- | ----------------------- | ----------------------------- |
| `chromium-desktop`| Chromium                | Windows Chrome, desktop Chrome |
| `safari-desktop`  | WebKit                  | Safari on macOS                |
| `mobile-safari`   | WebKit (iPhone 14)      | iOS Safari                     |
| `android-chrome`  | Chromium (Pixel 7)      | Android Chrome                 |

Playwright uses the **WebKit** and **Chromium** engines — not the real Safari or Chrome binaries. Fine for CI regression, but confirm real-Safari and real-Chrome-on-Windows bugs on actual devices. Google Pay's full flow requires real Chrome + real device; CI asserts the pay sheet surfaces.

Every project depends on the `setup` project (`auth.setup.ts`) and loads `tests/.auth/user.json` as `storageState`.

---

## Test-case taxonomy (Credit Card reference)

Mirrors the source regression doc 1:1. When adding PayPal / Afterpay / GPay / Apple Pay suites, mirror this shape and reuse `CheckoutFlow`.

| Group             | User types                                     | Test IDs |
| ----------------- | ---------------------------------------------- | -------- |
| AU Standard       | logged-in, new-user, guest-existing-email      | 1.1–1.3  |
| AU Express        | logged-in, new-user, guest-existing-email      | 2.1–2.3  |
| International NZ  | logged-in, new-user, guest-existing-email      | 3.1–3.3  |
| International SG  | logged-in, new-user, guest-existing-email      | 4.1–4.3  |
| Click & Collect   | logged-in, new-user, guest-existing-email      | 5.1–5.3  |
| Discounts         | promo code / gift-card + CC failover           | 6.1–6.2  |
| Cross-payment     | CC fails → retry with GPay / PayPal / Afterpay | 7.1–7.3  |
| Riskified         | Block Dispatch Order API, verify reversal, retry | 8.1    |

---

## Screenshot capture

Every successful order-confirmation triggers `OrderConfirmationPage.captureScreenshot()` which saves to:

```
screenshots/
├── 1.1-cc-au-standard-logged-in/
│   ├── chromium-desktop-order-confirmation.png
│   ├── safari-desktop-order-confirmation.png
│   ├── mobile-safari-order-confirmation.png
│   └── android-chrome-order-confirmation.png
├── 1.2-cc-au-standard-new-user/
│   └── …
└── Final regression testing document for payments - 18-07-2026.md
```

The markdown file is generated by `tests/globalTeardown.ts` at the end of every run. Its H1 is `Final regression testing document for payments - 18/07/2026` (slashes preserved for display; filename uses hyphens because macOS treats `/` as a path separator). Sections match the exact order of the source Google Doc — paste screenshots row-by-row and the format stays intact. Re-running on the same day overwrites.

---

## CI

`.github/workflows/playwright.yml` runs the four browser projects in parallel on push and pull_request. Configure GitHub secrets under **Settings → Secrets and variables → Actions**:

- `STAGING_URL`
- `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`
- `TEST_CARD_NUMBER`, `TEST_CARD_EXPIRY_MONTH`, `TEST_CARD_EXPIRY_YEAR`, `TEST_CARD_CVV`
- `PAYPAL_SANDBOX_EMAIL`, `PAYPAL_SANDBOX_PASSWORD`
- `AFTERPAY_SANDBOX_EMAIL`, `AFTERPAY_SANDBOX_PASSWORD`

Reports and traces are uploaded as artifacts (`playwright-report-<project>`, `test-results-<project>`) with 14-day retention.

---

## Working with Claude Code

Three subagents live in `.claude/agents/`:

- **playwright-specialist** — spec authoring, selector/wait tuning, iframe/popup handling, trace analysis.
- **payments-qa** — payment-domain edge cases (3DS, declines, sandbox quirks, refund flows).
- **test-report-reviewer** — triages failures from `test-results/` and `playwright-report/`.

`CLAUDE.md` at the repo root gives Claude the conventions and gotchas up front.

---

## Troubleshooting

- **Google sign-in blocked in `auth.setup.ts`** → Google detects automation. Sign in manually via `npx playwright codegen https://accounts.google.com/signin`, save the resulting storageState to `tests/.auth/user.json`, and re-run. For persistent CI, use `channel: 'chrome'` + a real user data dir.
- **Cybersource fields not found** → iframe `src`/`title` changed. Run `npx playwright codegen https://staging.kitchenwarehouse.com.au/checkout` and update `PaymentPage.cybersourceFrame()`.
- **Address suggestions never appear** → the random 3-char string may not resolve. `pickAddress()` retries up to 3 times; if you're seeing repeat failures, narrow the addressing input via a stable seed.
- **Gift card sheet returns HTML instead of CSV** → the sheet isn't shared publicly. Set the sheet to "Anyone with the link — Viewer" or set `GIFT_CARD_NUMBER` as fallback.
- **Cart total never exceeds 220 AUD in 6.2** → the random search pool returned only cheap items. Override with `KITCHEN_SEARCH_TERMS=kettle,wok,appliances,wolstead` or point `PRODUCT_LISTING_PATH` at a higher-value listing.
- **PayPal popup closes too fast** → sandbox is slow (30–45s). Timeouts are generous — retry the run.
- **Afterpay "amount exceeds plan"** → sandbox plan cap is ~AUD 2000.
- **Google Pay fails on WebKit** → expected. The gpay spec skips WebKit automatically.
- **Runner UI shows no events** → check the Express server logs. The `__UI__:` prefix must survive Playwright's stdout formatting; if a custom Playwright plugin munges output, the reporter's lines can get dropped.

---

## License

Private — internal QA tooling.
