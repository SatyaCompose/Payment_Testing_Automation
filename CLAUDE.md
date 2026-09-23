# KWH Payments Staging — Claude guide

Playwright + TypeScript end-to-end suite for `staging.kitchenwarehouse.com.au` (Next.js). Exercises the checkout across four payment methods (Credit Card via Cybersource, PayPal, Afterpay, Google Pay) plus Apple Pay smoke, across four browser projects (desktop Chrome, desktop Safari, mobile Safari, Android Chrome).

## Test taxonomy

Every payment method should eventually cover this matrix. **Credit Card is the reference implementation** — see `tests/payments/credit-card/`. When adding PayPal / Afterpay / GPay / Apple Pay suites, mirror this structure and reuse `CheckoutFlow`.

| Group             | User types                                       | Test IDs |
| ----------------- | ------------------------------------------------ | -------- |
| AU Standard       | logged-in, new-user, guest-existing-email        | 1.1–1.3  |
| AU Express        | logged-in, new-user, guest-existing-email        | 2.1–2.3  |
| International NZ  | logged-in, new-user, guest-existing-email        | 3.1–3.3  |
| International SG  | logged-in, new-user, guest-existing-email        | 4.1–4.3  |
| Click & Collect   | logged-in, new-user, guest-existing-email        | 5.1–5.3  |
| Discounts         | promo code / gift card + CC failover             | 6.1–6.2  |
| Cross-payment     | CC fails → retry with GPay / PayPal / Afterpay   | 7.1–7.3  |
| Riskified         | Block Dispatch Order API, verify reversal, retry | 8.1      |

## Repo layout

```
tests/
  payments/
    credit-card/          # reference implementation — 8 spec files, 21 tests
    paypal/               # (TBD — mirror credit-card/)
    afterpay/             # (TBD)
    gpay/                 # (TBD)
    applepay/             # (TBD)
  pages/                  # Page Object Model
  flows/CheckoutFlow.ts   # composed cart → checkout → shipping → payment helper
  fixtures/               # merged test, buyer/address data
  utils/testCards.ts      # Cybersource sandbox cards
  .auth/                  # storageState (gitignored)
  auth.setup.ts           # unused — testIgnore'd, never runs (see Auth)
playwright.config.ts      # 4 browser projects
.github/workflows/        # CI matrix per browser
.claude/agents/           # playwright-specialist, payments-qa, test-report-reviewer
```

## Auth

**Kinde** handles login. Kinde's own email route is one-time-code only —
submitting the email address goes straight to "enter the code we just sent
you", never a password field — so there is no email/password login on Kinde.
`TEST_USER_EMAIL` / `TEST_USER_PASSWORD` are the Google account used for:
- Google SSO — handled by the saved session's Google cookies from `npm run auth:setup`; no scripted login runs during tests (`loginWithGoogle()` in `LoginPage` is dead code)
- Safari SSO
- **Google Pay** — the buyer account is the same

Sign-in (`npm run auth:setup`) is a manual step — a real Chrome window opens and you complete it yourself; it is not scripted. The session is saved only once sign-in genuinely completes — a failed or abandoned attempt leaves any previously saved session untouched, and a run will fail closed with a clear message rather than silently testing as a guest.

**Sign into Google *inside the window the script opens*.** The script keeps its
own session in `tests/.auth/user.json` and never reads your everyday Chrome
profile, so signing into Google normally has no effect on it. The saved Google
cookies can be present and years from expiry while Google still reports the
account as *signed out* — the account chooser then shows it greyed out, Step 2's
"Continue with Google" click parks on that chooser, and the run times out. Step 1
exists precisely to re-establish that Google session; do not skip it unless you
know Google is live in the script's own window.

Provider-specific creds (PayPal, Afterpay, Apple Pay) live in their own env vars. See `.env.example`.

## Addresses

Do not hardcode addresses in specs. The staging site has an address-finder autocomplete API — `CheckoutPage.pickAddress(region, search, postcode)` types the search string, waits for the suggestion list, and clicks the first result. Search strings live in `.env` under `AU_ADDRESS_SEARCH`, `NZ_ADDRESS_SEARCH`, `SG_ADDRESS_SEARCH`.

## `CheckoutFlow`

`tests/flows/CheckoutFlow.ts` composes the full path parameterized by:

```ts
{
  userType: 'logged-in' | 'new-user' | 'guest-existing-email',
  shipping: 'standard' | 'express' | 'international' | 'cnc',
  region:   'AU' | 'NZ' | 'SG',
  payment:  'credit-card' | 'paypal' | 'afterpay' | 'gpay' | 'applepay',
  cncStoreName?: string,
  promoCode?: string,
  giftCard?: { number: string; pin?: string },
}
```

Specs stay declarative — the flow handles login, cart, checkout steps, and payment. Only override to assert intermediate state (e.g. the gift-card failover test in `gift-cards.spec.ts`).

## Screenshot capture — per-test-id folders + dated report file

Screenshots land in `screenshots/<test-id>/<browser>-order-confirmation.png`. No dated subfolder — each test id has one folder that's overwritten by the latest run per browser.

At the end of every run, `tests/globalTeardown.ts` writes:

```
screenshots/Final regression testing document for payments - DD-MM-YYYY.md
```

Inside, the H1 is `Final regression testing document for payments - DD/MM/YYYY` (slashes preserved in the display title — the filename uses hyphens because macOS treats `/` as a path separator). Sections are laid out **in the exact section order of the source Google Doc**. Paste each cell's image into the matching row and rename the Google Doc to match the file's date.

Re-running on the same date overwrites the file. `screenshots/` is gitignored.

## Riskified (test 8.1)

`page.route()` intercepts the Dispatch Order API and returns 500 on the first attempt, then releases. The URL pattern is a stubbed regex — **update to the actual URL** once observed in the network tab. Riskified beacon calls are captured via `page.on('request')` and asserted non-empty.

## Running

```bash
npm install
npx playwright install --with-deps
cp .env.example .env    # fill in creds + product slug + gift/promo codes
npm run auth:setup      # required once — opens Chrome, you sign in by hand (see Auth)

npm test                          # all browsers, all specs
npm run test:chromium             # single browser
npm run test:cc                   # all CC tests
npm run test:ui                   # interactive iteration
npx playwright codegen https://staging.kitchenwarehouse.com.au/checkout
                                  # record real selectors — refine PaymentPage/CheckoutPage
```

## Selector policy

Best-guess accessible locators are in place today. **Run codegen against the real checkout** and tighten selectors in `tests/pages/*.ts` when you have a valid cart and can reach the shipping + payment steps. Do NOT loosen locators (add extra `.or(...)` chains) to make failing tests pass — fix the selector in the page object.

## Locator hierarchy

1. `getByRole` with an accessible name
2. `getByLabel` for form fields
3. `getByTestId` where the app ships `data-testid`
4. `getByText` for static unique content
5. CSS — last resort, no indexes
6. XPath — never

## Waits

- Never `page.waitForTimeout(ms)`.
- Prefer `expect(locator).toBeVisible()` — auto-retry.
- Use `page.waitForURL(regex)` for redirects.
- `waitForLoadState('networkidle')` is expensive on Next.js — avoid unless needed.

## Iframes & popups

- Cybersource + Google Pay live in iframes → `frameLocator` by `src*=` / `title`.
- PayPal opens a popup → `page.waitForEvent('popup')`.
- Afterpay redirects → `page.waitForURL(/afterpay|clearpay/i)`.

## Runner UI (React + Express)

`runner/` is a self-contained React dashboard that spawns the Playwright suite, streams live test events into a browser via Server-Sent Events, and exposes a Stop button that immediately kills the child process.

Key pieces:
- `runner/server/index.ts` — Express server on port 3001. `POST /api/start` spawns `npx playwright test` with `UI_REPORTER=1`. `POST /api/stop` sends SIGTERM (SIGKILL after 3s). `GET /events` is an SSE stream.
- `runner/src/App.tsx` — swaps between `DesktopView` and `MobileView` based on `useIsMobile()` (viewport width + UA sniff).
- `tests/reporters/ui-reporter.ts` — custom Playwright reporter that emits `__UI__:{json}` lines on stdout for the server to parse. Only active when `UI_REPORTER=1`; regular `npm test` runs are unaffected.

Boot with:
```bash
npm run runner:install   # one-time
npm run runner:dev       # Vite on 5173 + Express on 3001
```

Open `http://localhost:5173`, click Start, watch the feed. Stop is sticky at the bottom on mobile and lives in the sidebar on desktop.

## Claude subagents

Invoke via `Task` tool with `subagent_type`:

- **playwright-specialist** — selector/wait tuning, iframe & popup handling, trace analysis.
- **payments-qa** — decline codes, 3DS, sandbox quirks, refund flow reasoning.
- **test-report-reviewer** — triage `test-results/` and `playwright-report/`.

## Don't

- Add sleeps to fix flakiness — find the real signal.
- Put selectors in spec files — they belong in `tests/pages/`.
- Commit `.env`, `tests/.auth/`, or real credentials.
- Fully drive Google Pay / Apple Pay end-to-end in CI — assert the sheet surfaces.
- Loosen a failing test's selector without checking codegen — the site probably changed and the page object needs an update.
