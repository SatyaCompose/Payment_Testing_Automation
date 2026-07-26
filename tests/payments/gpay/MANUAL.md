# Google Pay — manual verification

Google Pay's SDK refuses to render its payment sheet under Playwright
automation, even with the `playwright-extra` stealth plugin and
`--disable-blink-features=AutomationControlled`. The `pay.google.com/gp/p/ui/payframe`
iframe loads with `buttonCount: 0` — Google's SDK detects the automated
environment and silently declines to populate the sheet. This is
intentional anti-fraud behaviour on Google's side and is outside our
control.

**All GPay tests are marked `test.skip` in the runner** (see
`checkoutMatrixSpec.ts` for sections 1–5, and `describe.skip` in
`06-gift-cards.spec.ts` / `08-riskified.spec.ts`). The spec code stays
intact to document intent and provide a starting point if Google's
posture ever changes.

Run these manually against `staging.kitchenwarehouse.com.au` with a real
browser session:

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

Even though the sheet doesn't render under automation, the code in
`tests/payments/gpay/*.spec.ts` still exercises the full KWH-side
integration up to (but not including) the SDK sheet:

- Correct rendering of the Google Pay tile.
- Tile selection state (the `.gpay-button` overlay appearing over Place
  Order when GPay is chosen).
- Cart totals reflecting shipping method, promo, gift card.
- Continue-to-payment routing.

Re-enable the tests by removing the `test.skip` in
`checkoutMatrixSpec.ts` and `describe.skip` in the two bespoke files, if
a future Google update stops blocking automated sheet rendering.
