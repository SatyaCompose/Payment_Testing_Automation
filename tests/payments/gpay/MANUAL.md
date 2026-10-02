# Google Pay — gating and manual verification

## How Google Pay tests are gated

All 18 Google Pay tests (15 matrix rows in sections 1-5, plus 6.1, 6.2 and
8.1) are controlled by one environment variable, `GPAY_MODE`:

| Value            | Behaviour                                                                 |
| ---------------- | ------------------------------------------------------------------------- |
| `off` (default)  | Every Google Pay test skips, reason shown in the report and runner feed.  |
| `manual`         | The test drives checkout up to Google's popup, then waits for a human to click **Pay**. |
| `auto`           | Reserved. No automated Pay click exists, so it behaves exactly like `manual`. |

`GPAY_MANUAL_TIMEOUT_MS` (default 180000) is how long `manual` waits for the
Pay click. If it passes with no navigation away from checkout and no
confirmation text, the test fails with a message saying the manual click did
not complete.

Set them in `.env` (see `.env.example`), e.g. `GPAY_MODE=manual`.

Where the gate lives: `tests/payments/gpay/guard.ts` is the single
definition. The matrix specs reach it through `skipReason` on the `gpay`
entry in `tests/payments/matrix.ts`; `06-gift-cards.spec.ts` and
`08-riskified.spec.ts` call `requireGpayMode()` directly. WebKit projects
skip Google Pay separately (`skipBrowsers` in `matrix.ts`, and a per-test
check in the two bespoke specs).

## Open question: does Google's sheet render under automation?

Not settled either way. An earlier version of this file claimed the sheet
never renders under Playwright; nothing in the repository supports that
claim, and it predates removing the stealth `user-agent-override` evasion
(see `tests/fixtures/index.ts`), so it would describe a different
configuration anyway. Treat it as **open, pending a capture**. Any future
claim must record: measurement date, Chrome build, and stealth
configuration.

## Manual checklist

Run these with `GPAY_MODE=manual` (click Pay yourself) or entirely by hand in
a real browser against `staging.kitchenwarehouse.com.au`:

## Section 1 — AU Standard shipping

- [ ] 1.1 Logged-in checkout with Google Pay (Standard)
- [ ] 1.2 Newly-registered user checkout with Google Pay (Standard)
- [ ] 1.3 Guest (existing email) checkout with Google Pay (Standard)

## Section 2 — AU Express shipping

- [ ] 2.1 Logged-in checkout with Google Pay (Express)
- [ ] 2.2 Newly-registered user checkout with Google Pay (Express)
- [ ] 2.3 Guest (existing email) checkout with Google Pay (Express)

## Section 3 — International (New Zealand)

- [ ] 3.1 Logged-in checkout with Google Pay (NZ)
- [ ] 3.2 Newly-registered user checkout with Google Pay (NZ)
- [ ] 3.3 Guest (existing email) checkout with Google Pay (NZ)

## Section 4 — International (Singapore)

- [ ] 4.1 Logged-in checkout with Google Pay (SG)
- [ ] 4.2 Newly-registered user checkout with Google Pay (SG)
- [ ] 4.3 Guest (existing email) checkout with Google Pay (SG)

## Section 5 — Click & Collect

- [ ] 5.1 Logged-in checkout with Google Pay (CNC)
- [ ] 5.2 Newly-registered user checkout with Google Pay (CNC)
- [ ] 5.3 Guest (existing email) checkout with Google Pay (CNC)

## Section 6 — Discounts

- [ ] 6.1 Apply promo code, pay with Google Pay
- [ ] 6.2 Apply gift card, pay remainder with Google Pay

## Section 8 — Riskified

- [ ] 8.1 Blocking Dispatch Order fails GPay, unblock and retry succeeds
      (needs a manual block of the Dispatch endpoint in a browser proxy
      like Charles/Fiddler — or a coordinated backend flag)

## Per-scenario steps

For each scenario:

1. Open a **real** Chrome / Safari window signed into a Google account
   with a test card in Google Pay.
2. Sign in to KWH (or start guest / new-user flow per the scenario).
3. Add products matching the section's requirements (Express filter for
   section 2, NZ/SG shipping address for 3/4, etc.).
4. Proceed to checkout → shipping → payment.
5. Select **Google Pay** tile.
6. Click **Place order** (the GPay overlay button fires the SDK sheet).
7. In the pay.google.com sheet: confirm the card + address, click
   **Pay**.
8. Verify order confirmation page renders with a valid order number.
9. Capture a screenshot into `screenshots/<test-id>-gp-<section>/`
   matching the folder pattern the automated tests use, so the run
   report picks it up.

## What the automated code covers

Only what the code actually does, in `manual` mode:

- Drives login/cart/checkout/shipping via `CheckoutFlow`, selects the
  Google Pay tile, and clicks Google's `.gpay-button.buy` button.
- Waits for the human Pay click, then asserts order confirmation and
  captures the screenshot.

It does **not** assert that the `.gpay-button` overlay appears, nor tile
rendering, cart totals or routing as separate checks; those are only
implicitly exercised by the flow reaching the payment step.
