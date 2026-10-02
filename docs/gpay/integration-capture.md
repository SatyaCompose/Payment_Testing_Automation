# How Kitchen Warehouse staging integrates Google Pay

**Measured:** 2026-10-02, against `staging.kitchenwarehouse.com.au`, logged-in AU standard
checkout, via `npm run gpay:capture`. Raw dumps alongside this file:
`capture-2026-10-02.json` (stealth, plain) and
`capture-2026-10-02-no-payment-request.json`.

This file exists because the question "can Google Pay be automated?" had been answered in
the repo twice, in opposite directions, with no evidence either way
(`tests/payments/gpay/MANUAL.md` said no, `tests/fixtures/index.ts` said yes). It is now
measured.

## Conclusion

**The Google Pay sheet cannot be driven by any browser-automation tool on this
integration.** Not by Playwright, Cypress or Selenium. This is a property of how the site
integrates Google Pay, **not** of automation detection — the previous explanation in
`MANUAL.md` ("Google's SDK detects the automated environment and silently declines to
populate the sheet") was wrong about the cause, which is why no workaround was ever found.

Everything *up to* the sheet is automatable and already automated, and everything the site
sends Google is observable and assertable.

## The integration

| | |
|---|---|
| Component | `@google-pay/button-react` 3.2.1 (Google's official React wrapper) |
| Script | `https://pay.google.com/gp/p/js/pay.js` — requested, HTTP 200 |
| **Environment** | **`TEST`** |
| Merchant | `BCR2DN4TZKJM3J2A` — "Kitchen Warehouse Pty Ltd" |
| Gateway | `cybersource`, `gatewayMerchantId: realstores` |
| Card networks | MASTERCARD, VISA |
| Auth methods | PAN_ONLY, CRYPTOGRAM_3DS |
| Callbacks | `onPaymentDataChanged`, `onPaymentAuthorized` |
| `isReadyToPay()` | `{ result: true }` |
| `transactionInfo` | `{ totalPrice: "2850.20", currencyCode: "AUD" }` (that cart) |

**`environment: TEST` matters.** No real money moves on staging, and Google returns a
dummy token even when a human clicks Pay — so a manual run was never exercising a real
payment credential either.

## Why the sheet is unreachable

Clicking the Google Pay button calls `loadPaymentData()`, which delegates to the browser's
`PaymentRequest` API. Chrome then draws the sheet **itself**, as browser UI outside the
page. There is no DOM for an automation tool to query or click.

Measured in the stealth run: `PaymentRequest` constructed 3×, `show()` called, **0 popups**.
Two `pay.google.com` frames were present, and neither is the sheet:

- `/gp/p/generate_gpay_btn_img?…` — the button's **image**, 240×40, sitting at the button.
- `/gp/p/ui/payframe?…` — a helper frame: `display:none`, `visibility:hidden`, 0×0.

## The fallback was tested, and it is closed

Google's SDK historically rendered its sheet inside the `payframe` iframe on browsers
without `PaymentRequest` — which would have been DOM, and driveable. That hypothesis was
tested directly (`--mode=no-payment-request`, which deletes `window.PaymentRequest` via
`addInitScript` before any page script runs).

The removal was clean and the experiment therefore valid: `'PaymentRequest' in window`
false, `typeof` undefined, 0 constructed, `show()` never called.

Result: **the SDK does not fall back.** `loadPaymentData()` was still called, then
**hung** — `pending-at-end-of-window`, neither resolved nor rejected. The payframe stayed
`display:none`, 0×0, with no card number, no masked tail, no "Pay", no "Continue" and
0 buttons. No new popups or frames appeared.

## What this leaves

- **Automatable:** everything to the point of the sheet — tile selection, the button
  mounting, `isReadyToPay`, and the full `PaymentDataRequest` the site builds, including
  `transactionInfo.totalPrice`. That last one is the piece KWH owns and can regress: the
  wrong amount reaching the gateway after a promo, a gift card, international shipping or
  a Click & Collect order.
- **Not automatable:** the click on Google's sheet, and therefore an end-to-end order
  placed through a real Google token.
- **Open option:** supply the token directly and let the rest of the flow run for real.
  Because the environment is `TEST`, that substitutes a dummy token for a dummy token;
  the KWH → Cybersource → Riskified → order path is exercised unchanged. Not yet built.

## Notes on the raw dumps

- `capture-2026-10-02.json`, stealth run: its `surface.verdict` reads
  `"dom-surface (frame) but EMPTY"` with `"automatable": true`. **That verdict is wrong**
  and is superseded by this file. It was produced by an earlier version of the script that
  treated the presence of any `pay.google.com` frame as a driveable DOM surface, before we
  knew the frames were the button image and a hidden helper. The script's verdict logic has
  since been corrected to check `PaymentRequest.show()` first and to require a surface to
  be actually rendered. The *measurements* in that file are accurate; only the derived
  verdict was wrong.
- The `plain` (no-stealth) run failed before reaching the payment step, so stealth-vs-plain
  is not yet a controlled comparison. It does not change the conclusion: the native path is
  not a detection artefact, so stealth is not the variable that matters.
- No Dispatch Order request was captured — these runs place no payment — so the placeholder
  regex in `tests/payments/credit-card/08-riskified.spec.ts` and
  `tests/payments/gpay/08-riskified.spec.ts` is still unvalidated.

## Redaction

The capture script redacts at the write site: the payment token is reduced to its length,
`protocolVersion` and signature shape; billing/shipping addresses, emails and phone numbers
are stripped; network records keep URLs, methods, statuses and request-body **key names**
only, never values. Screenshots go to the gitignored `screenshots/gpay-capture/`, not here,
because a sheet can show a card tail.
