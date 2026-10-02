/**
 * Hand-run capture: how does the Kitchen Warehouse staging site actually
 * integrate Google Pay?
 *
 *   npm run gpay:capture                      # stealth ON, then stealth ON without PaymentRequest, then stealth OFF
 *   npm run gpay:capture -- --mode=stealth    # only stealth ON
 *   npm run gpay:capture -- --mode=plain      # only stealth OFF (plain Chromium)
 *   npm run gpay:capture -- --mode=no-payment-request
 *                                             # stealth ON, with window.PaymentRequest removed before any page script runs
 *
 * Standalone `tsx` script, same family as interactive-signin.ts: not a spec,
 * so it never runs in CI and is not touched by globalSetup or by the
 * screenshot-exists beforeEach in tests/fixtures/index.ts.
 *
 * What it answers (see the JSON it writes for the raw evidence):
 *   1. Which surface does the Google Pay sheet use after the button is clicked
 *      - a popup window, a pay.google.com iframe, or neither (which, if
 *      `PaymentRequest.show()` was called, points at Chrome's native sheet)?
 *   2. What SDK configuration does the site pass (environment, merchant,
 *      gateway, card networks, amount)?
 *   3. Which pay.google.com / cybersource.com requests happen, and which
 *      state-changing calls does the site make to its own backend?
 *   4. What does the button's DOM look like and what sits on top of it?
 *   5. What CSP header is served on the checkout document?
 *   6. Which URL is the real "Dispatch Order" endpoint (only if the run
 *      happens to see it - see the note printed in the summary)?
 *
 * SAFETY: this script never clicks Pay and never touches anything inside the
 * Google Pay surface except to read it. It clicks the Google Pay button once so
 * the sheet appears, records, and closes the browser.
 */
import { chromium, devices, expect } from '@playwright/test';
import type { Browser, BrowserContext, Frame, Page, Request as PwRequest } from '@playwright/test';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as readline from 'readline/promises';
import { AUTH_FILE } from '../fixtures/auth';
import { STAGING_ORIGIN, isSignedInFile } from '../fixtures/authState';
import { CheckoutFlow } from '../flows/CheckoutFlow';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

type Mode = 'stealth' | 'plain' | 'no-payment-request';

/** The default run, in execution order. */
const ALL_MODES: Mode[] = ['stealth', 'no-payment-request', 'plain'];

function modeLabel(mode: Mode): string {
  if (mode === 'stealth') return 'stealth ON';
  if (mode === 'plain') return 'stealth OFF (plain Chromium)';
  return 'stealth ON, window.PaymentRequest removed';
}

/** The pay.google.com document path the payment sheet iframe loads. */
const PAYFRAME_PATH = '/gp/p/ui/payframe';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'gpay');

/** Same selector tests/pages/payment/alternatePayments.ts and overlay.ts use. */
const GPAY_BUTTON_SELECTOR = '.gpay-button.buy';
/** Place order shares the button's rect (see tests/pages/payment/overlay.ts). */
const PLACE_ORDER_SELECTOR = '[data-testid="place-order-btn"]';

/** How long to watch for a sheet after the click. */
const SHEET_WINDOW_MS = Number(process.env.GPAY_CAPTURE_WINDOW_MS) > 0 ? Number(process.env.GPAY_CAPTURE_WINDOW_MS) : 20_000;

/** The placeholder both Riskified specs use today; reported against each harvested URL. */
const CURRENT_DISPATCH_PLACEHOLDER = /dispatch[-_]?order|api\/.*dispatch/i;

// ---------------------------------------------------------------------------
// In-page observer
// ---------------------------------------------------------------------------

/**
 * Installed with `context.addInitScript`, so it runs before any page script
 * (the same guarantee tests/pages/cart/insiderOverlay.ts relies on) and wins
 * the race against Google's pay.js. It OBSERVES AND PASSES THROUGH: every
 * wrapper calls the original with the original arguments and returns the
 * original return value; nothing is substituted.
 *
 * It is a string, not a function, on purpose: tsx compiles this file with
 * esbuild, which can rewrite nested helper functions into calls to a `__name`
 * helper that does not exist in the page. A string is shipped byte for byte.
 * (The first line also defines a harmless `__name` shim so that the
 * `evaluate` callbacks below survive the same transform on every page.)
 *
 * It deliberately does nothing on google.com hosts: Google's own pages are not
 * ours to modify. It only installs in the top frame.
 */
const OBSERVER_SCRIPT = `
(function () {
  try { if (!globalThis.__name) globalThis.__name = function (f) { return f; }; } catch (e) {}
  if (window !== window.top) return;
  var host = location.hostname || '';
  if (host === 'google.com' || host.endsWith('.google.com')) return;
  if (window.__GPAY_CAPTURE__) return;

  var cap = {
    installedAt: Date.now(),
    origin: location.origin,
    path: location.pathname,
    sdkAssigned: false,
    clientConstructed: [],
    calls: [],
    paymentRequest: { presentAtInstall: typeof window.PaymentRequest === 'function', constructed: [] },
    sdkShapeAtLoad: null,
    errors: []
  };
  window.__GPAY_CAPTURE__ = cap;

  function note(where, e) { try { cap.errors.push(where + ': ' + String(e && e.message ? e.message : e)); } catch (x) {} }

  // JSON-safe copy: functions and DOM nodes become labels, cycles and depth are cut.
  function safe(v, d, seen) {
    d = d || 0; seen = seen || [];
    if (v === null) return null;
    var t = typeof v;
    if (t === 'string') return v.length > 4000 ? v.slice(0, 4000) + '...[truncated]' : v;
    if (t === 'number' || t === 'boolean' || t === 'undefined') return v;
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (t !== 'object') return String(v);
    if (v instanceof Error) return { error: v.name, message: String(v.message), statusCode: v.statusCode, statusMessage: v.statusMessage };
    if (typeof Node !== 'undefined' && v instanceof Node) return '[Node ' + v.nodeName + ']';
    if (seen.indexOf(v) !== -1) return '[circular]';
    if (d > 8) return '[too deep]';
    seen.push(v);
    if (Array.isArray(v)) return v.map(function (x) { return safe(x, d + 1, seen); });
    var out = {};
    Object.keys(v).forEach(function (k) {
      try { out[k] = safe(v[k], d + 1, seen); } catch (e) { out[k] = '[unreadable]'; }
    });
    return out;
  }

  // Calls cb(value) now if obj[key] already exists and again on every later
  // assignment, while leaving the property readable/writable for the page.
  function watch(obj, key, cb) {
    try {
      var desc = Object.getOwnPropertyDescriptor(obj, key);
      if (desc && desc.configurable === false) { note('watch ' + key, 'not configurable'); return; }
      var value = obj[key];
      if (value !== undefined) { cb(value); value = obj[key]; }
      Object.defineProperty(obj, key, {
        configurable: true,
        enumerable: true,
        get: function () { return value; },
        set: function (v) { value = v; try { cb(v); } catch (e) { note('watch cb ' + key, e); } value = obj[key]; }
      });
    } catch (e) { note('watch ' + key, e); }
  }

  var wrappedCtors = [];
  var CLIENT_METHODS = ['isReadyToPay', 'createButton', 'loadPaymentData', 'prefetchPaymentData'];

  function wrapClientMethods(inst) {
    CLIENT_METHODS.forEach(function (m) {
      var orig = inst[m];
      if (typeof orig !== 'function') return;
      inst[m] = function () {
        var args = Array.prototype.slice.call(arguments);
        var entry = { method: m, at: Date.now(), args: safe(args) };
        cap.calls.push(entry);
        var ret;
        try { ret = orig.apply(this, args); } catch (e) { entry.threw = safe(e); throw e; }
        if (ret && typeof ret.then === 'function') {
          // A side branch only: the page still receives the original promise.
          ret.then(function (res) { entry.resolved = safe(res); }, function (err) { entry.rejected = safe(err); });
        } else if (m === 'createButton') {
          entry.returned = ret && ret.nodeName ? '[Node ' + ret.nodeName + ' class=' + (ret.getAttribute && ret.getAttribute('class')) + ']' : safe(ret);
        }
        return ret;
      };
    });
  }

  function onPaymentsClient(api) {
    return function (Orig) {
      if (typeof Orig !== 'function' || wrappedCtors.indexOf(Orig) !== -1) return;
      var Wrapped = function () {
        var args = Array.prototype.slice.call(arguments);
        cap.clientConstructed.push({ at: Date.now(), args: safe(args) });
        var inst = Reflect.construct(Orig, args, new.target || Wrapped);
        wrapClientMethods(inst);
        return inst;
      };
      Wrapped.prototype = Orig.prototype;
      try { Object.setPrototypeOf(Wrapped, Orig); } catch (e) { note('setPrototypeOf', e); }
      wrappedCtors.push(Wrapped);
      api.PaymentsClient = Wrapped;
    };
  }

  // pay.js builds window.google.payments.api.PaymentsClient piece by piece, so
  // each level is watched in turn instead of trusting the first assignment.
  watch(window, 'google', function (g) {
    if (!g || typeof g !== 'object') return;
    cap.sdkAssigned = true;
    watch(g, 'payments', function (p) {
      if (!p || typeof p !== 'object') return;
      watch(p, 'api', function (api) {
        if (!api || typeof api !== 'object') return;
        watch(api, 'PaymentsClient', onPaymentsClient(api));
      });
    });
  });

  // PaymentRequest: constructing it is the signal for Chrome's native sheet.
  // show() results are never read beyond the method name - the response
  // carries the payment credential.
  var OrigPR = window.PaymentRequest;
  if (typeof OrigPR === 'function') {
    var WrappedPR = function () {
      var args = Array.prototype.slice.call(arguments);
      var details = args[1] && typeof args[1] === 'object' ? args[1] : {};
      var entry = {
        at: Date.now(),
        methodData: safe(args[0]),
        total: safe(details.total),
        calls: []
      };
      cap.paymentRequest.constructed.push(entry);
      var inst = Reflect.construct(OrigPR, args, new.target || WrappedPR);
      ['show', 'canMakePayment', 'hasEnrolledInstrument', 'abort'].forEach(function (m) {
        var orig = inst[m];
        if (typeof orig !== 'function') return;
        inst[m] = function () {
          var call = { method: m, at: Date.now() };
          entry.calls.push(call);
          var ret;
          try { ret = orig.apply(this, arguments); } catch (e) { call.threw = safe(e); throw e; }
          if (ret && typeof ret.then === 'function') {
            ret.then(
              function (res) { call.resolved = true; if (m === 'show' && res && res.methodName) call.methodName = String(res.methodName); else if (m !== 'show') call.result = safe(res); },
              function (err) { call.rejected = safe(err); }
            );
          }
          return ret;
        };
      });
      return inst;
    };
    WrappedPR.prototype = OrigPR.prototype;
    try { Object.setPrototypeOf(WrappedPR, OrigPR); } catch (e) { note('PR setPrototypeOf', e); }
    try { Object.defineProperty(WrappedPR, 'name', { value: 'PaymentRequest' }); } catch (e) {}
    window.PaymentRequest = WrappedPR;
  }

  // If the SDK never went through the watched path, say so rather than
  // reporting an empty capture as "Google Pay is not configured".
  window.addEventListener('load', function () {
    try {
      var api = window.google && window.google.payments && window.google.payments.api;
      cap.sdkShapeAtLoad = api ? { keys: Object.keys(api), paymentsClientWrapped: wrappedCtors.indexOf(api.PaymentsClient) !== -1 } : null;
    } catch (e) { note('load check', e); }
  });
})();
`;

/**
 * Used only by the no-payment-request mode. Added with `context.addInitScript`
 * AFTER the observer, so the observer has already seen and wrapped the real
 * PaymentRequest; this then deletes the property so that
 * `window.PaymentRequest`, `'PaymentRequest' in window` and
 * `typeof PaymentRequest` all report it as unavailable to every script that
 * runs afterwards. If the delete does not take effect it falls back to a
 * getter that returns undefined, and records which of the two was used.
 *
 * Same scope as the observer: top frame only, and never on google.com hosts.
 * It is a string for the same reason OBSERVER_SCRIPT is.
 */
const REMOVE_PAYMENT_REQUEST_SCRIPT = `
(function () {
  if (window !== window.top) return;
  var host = location.hostname || '';
  if (host === 'google.com' || host.endsWith('.google.com')) return;
  var state = { removedAt: Date.now(), path: location.pathname, hadPaymentRequestBefore: 'PaymentRequest' in window, method: 'delete', stillInWindow: null, typeofAfter: null, errors: [] };
  window.__GPAY_PR_REMOVAL__ = state;
  try { delete window.PaymentRequest; } catch (e) { state.errors.push('delete: ' + String(e && e.message ? e.message : e)); }
  if ('PaymentRequest' in window) {
    state.method = 'getter-returning-undefined';
    try { Object.defineProperty(window, 'PaymentRequest', { get: function () { return undefined; }, configurable: true }); } catch (e) { state.errors.push('defineProperty: ' + String(e && e.message ? e.message : e)); }
  }
  state.stillInWindow = 'PaymentRequest' in window;
  state.typeofAfter = typeof window.PaymentRequest;
})();
`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}
function localDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
function isGooglePayHost(host: string): boolean {
  return host === 'pay.google.com' || host.endsWith('.pay.google.com') || host === 'payments.google.com' || host.endsWith('.payments.google.com');
}
function isCybersourceHost(host: string): boolean {
  return host === 'cybersource.com' || host.endsWith('.cybersource.com');
}
function isKwhBackendHost(host: string): boolean {
  return /(^|\.)kitchenwarehouse\.com(\.au)?$/.test(host) || /frontastic/.test(host);
}

/** Origin + path + query parameter NAMES; query values can carry tokens and are never kept. */
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const keys = [...new Set(u.searchParams.keys())];
    return `${u.origin}${u.pathname}${keys.length ? `?${keys.map((k) => `${k}=`).join('&')}` : ''}`;
  } catch {
    return url.split('?')[0].split('#')[0];
  }
}

/** Key names only (never values) of a request body, nested up to four levels. */
function postKeyNames(req: PwRequest): string[] {
  const body = req.postData();
  if (body === null) return [];
  const out = new Set<string>();
  const walk = (v: unknown, prefix: string, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(v)) {
      v.slice(0, 3).forEach((x) => walk(x, `${prefix}[]`, depth + 1));
      return;
    }
    const r = asRec(v);
    if (!r) return;
    for (const k of Object.keys(r)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      walk(r[k], p, depth + 1);
    }
  };
  try {
    walk(JSON.parse(body), '', 0);
    if (out.size) return [...out].sort();
  } catch {
    // not JSON - try form encoding below
  }
  if (/^[^=&\s]+=/.test(body)) {
    return [...new Set(new URLSearchParams(body).keys())].sort();
  }
  return [`[opaque body, ${body.length} chars]`];
}

// ---------------------------------------------------------------------------
// Network + CSP capture
// ---------------------------------------------------------------------------

interface NetRec {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  failure?: string;
  postKeys?: string[];
}

interface CspDoc {
  url: string;
  isMainFrame: boolean;
  isCheckout: boolean;
  status: number;
  csp: string | null;
  cspReportOnly: string | null;
}

interface NetworkCapture {
  payJs: NetRec[];
  googlePay: NetRec[];
  cybersource: NetRec[];
  kwhWrites: NetRec[];
  documents: CspDoc[];
  settle: () => Promise<void>;
}

function attachNetworkCapture(context: BrowserContext): NetworkCapture {
  const cap: NetworkCapture = { payJs: [], googlePay: [], cybersource: [], kwhWrites: [], documents: [], settle: async () => undefined };
  const byRequest = new Map<PwRequest, NetRec>();
  const pending: Promise<void>[] = [];
  const LIMIT = 400;

  context.on('request', (req) => {
    const url = req.url();
    const host = hostOf(url);
    if (!host) return;
    const method = req.method();
    const rec: NetRec = { url: sanitizeUrl(url), method, resourceType: req.resourceType() };
    let tracked = false;

    if (isGooglePayHost(host) && cap.googlePay.length < LIMIT) {
      cap.googlePay.push(rec);
      tracked = true;
      if (url.startsWith('https://pay.google.com/gp/p/js/pay.js')) cap.payJs.push(rec);
    }
    if (isCybersourceHost(host) && cap.cybersource.length < LIMIT) {
      cap.cybersource.push(rec);
      tracked = true;
    }
    if (isKwhBackendHost(host) && method !== 'GET' && cap.kwhWrites.length < LIMIT) {
      rec.postKeys = postKeyNames(req);
      cap.kwhWrites.push(rec);
      tracked = true;
    }
    if (tracked) byRequest.set(req, rec);
  });

  context.on('response', (res) => {
    const req = res.request();
    const rec = byRequest.get(req);
    if (rec) rec.status = res.status();

    // The CSP of every document the site serves - the response header, not a <meta> tag.
    if (req.resourceType() === 'document' && isKwhBackendHost(hostOf(res.url()))) {
      pending.push(
        res
          .allHeaders()
          .then((h) => {
            cap.documents.push({
              url: sanitizeUrl(res.url()),
              isMainFrame: req.frame().parentFrame() === null,
              isCheckout: /\/checkout/i.test(new URL(res.url()).pathname),
              status: res.status(),
              csp: h['content-security-policy'] ?? null,
              cspReportOnly: h['content-security-policy-report-only'] ?? null,
            });
          })
          .catch(() => undefined),
      );
    }
  });

  context.on('requestfailed', (req) => {
    const rec = byRequest.get(req);
    if (rec) rec.failure = req.failure()?.errorText ?? 'failed';
  });

  cap.settle = async () => {
    await Promise.all(pending);
  };
  return cap;
}

function parseCsp(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of header.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) out[tokens[0].toLowerCase()] = tokens.slice(1);
  }
  return out;
}

function summariseCsp(documents: CspDoc[]): Rec {
  const checkoutDocs = documents.filter((d) => d.isMainFrame && d.isCheckout);
  const chosen = checkoutDocs[checkoutDocs.length - 1] ?? [...documents].reverse().find((d) => d.isMainFrame);
  const unique = new Map<string, string[]>();
  for (const d of documents) {
    for (const value of [d.csp, d.cspReportOnly]) {
      if (!value) continue;
      const urls = unique.get(value) ?? [];
      if (!urls.includes(d.url)) urls.push(d.url);
      unique.set(value, urls);
    }
  }
  const directiveReport = (header: string | null): Rec | null => {
    if (!header) return null;
    const parsed = parseCsp(header);
    const report: Rec = {};
    for (const name of ['default-src', 'script-src', 'frame-src', 'child-src', 'connect-src', 'img-src']) {
      const tokens = parsed[name];
      report[name] = tokens
        ? { present: true, mentionsPayGoogle: tokens.some((t) => /(^|\/\/)(\*\.)?pay\.google\.com/i.test(t)), mentionsWildcardGoogle: tokens.some((t) => /\*\.google\.com/i.test(t)) }
        : { present: false };
    }
    return report;
  };
  return {
    note: 'Read from the HTTP response header of the document, not from a <meta> tag.',
    checkoutDocumentUrl: chosen?.url ?? null,
    checkoutDocumentIsCheckoutPath: chosen?.isCheckout ?? false,
    enforcedHeaderServed: Boolean(chosen?.csp),
    reportOnlyHeaderServed: Boolean(chosen?.cspReportOnly),
    enforcedDirectives: directiveReport(chosen?.csp ?? null),
    reportOnlyDirectives: directiveReport(chosen?.cspReportOnly ?? null),
    enforcedHeader: chosen?.csp ?? null,
    reportOnlyHeader: chosen?.cspReportOnly ?? null,
    distinctPoliciesAcrossAllDocuments: [...unique.entries()].map(([value, urls]) => ({ value, servedOn: urls })),
    documentsSeen: documents.length,
  };
}

// ---------------------------------------------------------------------------
// Sheet surface detection
// ---------------------------------------------------------------------------

interface SurfaceCollector {
  popups: Map<Page, string[]>;
  frames: Set<Frame>;
  /** Resolves as soon as any popup/new page/pay.google.com frame appears. */
  firstSurface: Promise<void>;
}

/** Must be called BEFORE the click so nothing that opens during it can be missed. */
function registerSurfaceListeners(page: Page, context: BrowserContext): SurfaceCollector {
  const popups = new Map<Page, string[]>();
  const frames = new Set<Frame>();
  let signal!: () => void;
  const firstSurface = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const addPopup = (p: Page, via: string) => {
    if (p === page) return;
    const vias = popups.get(p) ?? [];
    if (!vias.includes(via)) vias.push(via);
    popups.set(p, vias);
    signal();
  };
  const addFrame = (f: Frame) => {
    if (f === page.mainFrame() || !isGooglePayHost(hostOf(f.url()))) return;
    frames.add(f);
    signal();
  };
  page.on('popup', (p) => addPopup(p, "page.on('popup')"));
  context.on('page', (p) => addPopup(p, "context.on('page')"));
  page.on('frameattached', addFrame);
  page.on('framenavigated', addFrame);
  return { popups, frames, firstSurface };
}

async function measureContent(
  target: Page | Frame,
): Promise<{ title: string; bodyTextLength: number; visibleButtonCount: number; contentAppeared: boolean }> {
  // Wait (bounded) for any text to render: an empty surface is exactly the
  // "buttonCount: 0" claim this capture exists to confirm or refute.
  const contentAppeared = await target
    .waitForFunction(() => !!document.body && document.body.innerText.trim().length > 0, undefined, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const title = await target.title().catch(() => '');
  const bodyTextLength = await target.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => -1);
  // Role locators only match visible elements by default, so this is a visible-button count.
  const visibleButtonCount = await target.getByRole('button').count().catch(() => -1);
  return { title, bodyTextLength, visibleButtonCount, contentAppeared };
}

async function describePopup(p: Page, vias: string[], shotPath: string): Promise<Rec> {
  await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  const content = await measureContent(p);
  const shot = await p.screenshot({ path: shotPath }).then(() => path.relative(REPO_ROOT, shotPath), (e: unknown) => `screenshot failed: ${errMsg(e)}`);
  return { kind: 'popup', openedVia: vias, url: sanitizeUrl(p.url()), ...content, screenshot: shot };
}

async function describeFrame(f: Frame, shotPath: string): Promise<Rec> {
  const content = await measureContent(f);
  const element = await f.frameElement().catch(() => null);
  const box = element ? await element.boundingBox().catch(() => null) : null;
  const iframeStyle = element
    ? await element
        .evaluate((node) => {
          const el = node as Element;
          const cs = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            width: Math.round(r.width),
            height: Math.round(r.height),
            intersectsViewport: r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight,
          };
        })
        .catch(() => null)
    : null;

  // Only booleans and counts are kept: the text itself can hold a card tail or an email.
  const text = await f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
  const textSignals = {
    cardNumberShaped: /\b(?:\d[ -]?){13,19}\b/.test(text),
    maskedCardTail: /[•*·]{2,}\s*\d{4}/.test(text),
    containsPay: /\bpay\b/i.test(text),
    containsContinue: /\bcontinue\b/i.test(text),
    containsEmailShapedText: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text),
  };
  const payOrContinueButtonCount = await f.getByRole('button', { name: /pay|continue/i }).count().catch(() => -1);

  const shot = element
    ? await element.screenshot({ path: shotPath, timeout: 8_000 }).then(() => path.relative(REPO_ROOT, shotPath), (e: unknown) => `screenshot failed: ${errMsg(e)}`)
    : 'no frame element to screenshot';
  let fallbackShot: string | null = null;
  if (!shot.endsWith('.png')) {
    const fallbackPath = shotPath.replace(/\.png$/, '-viewport.png');
    fallbackShot = await f
      .page()
      .screenshot({ path: fallbackPath })
      .then(() => path.relative(REPO_ROOT, fallbackPath), (e: unknown) => `viewport screenshot failed: ${errMsg(e)}`);
  }
  return {
    kind: 'frame',
    url: sanitizeUrl(f.url()),
    isPayframe: new URL(f.url()).pathname.startsWith(PAYFRAME_PATH),
    iframeBox: box,
    iframeStyle,
    ...content,
    textSignals,
    payOrContinueButtonCount,
    screenshot: shot,
    fallbackViewportScreenshot: fallbackShot,
  };
}

async function askOperator(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY || process.env.GPAY_CAPTURE_NO_PROMPT === '1') return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question, { signal: AbortSignal.timeout(120_000) })).trim().toLowerCase();
    if (answer.startsWith('y')) return true;
    if (answer.startsWith('n')) return false;
    return null;
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// SDK extraction + redaction
// ---------------------------------------------------------------------------

interface ExtractedSdk {
  environment?: string;
  merchantInfo?: { merchantId?: string; merchantName?: string };
  allowedPaymentMethods: Array<{ type?: string; gateway?: string; gatewayMerchantId?: string }>;
  allowedCardNetworks: string[];
  allowedAuthMethods: string[];
  transactionInfo?: { totalPrice?: string; currencyCode?: string };
  isReadyToPay?: unknown;
  isReadyToPayRejected?: unknown;
  calls: string[];
}

function extractSdk(capture: Rec | null | undefined): ExtractedSdk {
  const out: ExtractedSdk = { allowedPaymentMethods: [], allowedCardNetworks: [], allowedAuthMethods: [], calls: [] };
  if (!capture) return out;
  const calls = asArr(capture.calls).map(asRec).filter((c): c is Rec => !!c);
  out.calls = calls.map((c) => String(c.method));

  const clientOpts = asRec(asArr(asRec(asArr(capture.clientConstructed)[0])?.args)[0]);
  out.environment = asStr(clientOpts?.environment);
  out.merchantInfo = pickMerchant(asRec(clientOpts?.merchantInfo));

  const nets = new Set<string>();
  const auths = new Set<string>();
  for (const call of calls) {
    const req = asRec(asArr(call.args)[0]);
    if (!req) continue;
    if (call.method === 'isReadyToPay') {
      out.isReadyToPay = call.resolved;
      out.isReadyToPayRejected = call.rejected;
    }
    out.merchantInfo ??= pickMerchant(asRec(req.merchantInfo));
    if (call.method === 'loadPaymentData') {
      out.merchantInfo = pickMerchant(asRec(req.merchantInfo)) ?? out.merchantInfo;
      const ti = asRec(req.transactionInfo);
      if (ti) out.transactionInfo = { totalPrice: asStr(ti.totalPrice), currencyCode: asStr(ti.currencyCode) };
    }
    if (call.method === 'loadPaymentData' || (call.method === 'isReadyToPay' && out.allowedPaymentMethods.length === 0)) {
      out.allowedPaymentMethods = [];
      for (const m of asArr(req.allowedPaymentMethods).map(asRec)) {
        if (!m) continue;
        const params = asRec(m.parameters);
        asArr(params?.allowedCardNetworks).forEach((n) => nets.add(String(n)));
        asArr(params?.allowedAuthMethods).forEach((n) => auths.add(String(n)));
        const tokenParams = asRec(asRec(m.tokenizationSpecification)?.parameters);
        out.allowedPaymentMethods.push({
          type: asStr(m.type),
          gateway: asStr(tokenParams?.gateway),
          gatewayMerchantId: asStr(tokenParams?.gatewayMerchantId),
        });
      }
    }
  }
  out.allowedCardNetworks = [...nets];
  out.allowedAuthMethods = [...auths];
  return out;
}

function pickMerchant(m: Rec | undefined): { merchantId?: string; merchantName?: string } | undefined {
  if (!m) return undefined;
  return { merchantId: asStr(m.merchantId), merchantName: asStr(m.merchantName) };
}

function summariseToken(token: unknown): Rec {
  if (typeof token !== 'string') return { redacted: true, length: null };
  const out: Rec = { redacted: true, length: token.length };
  const candidates = [token];
  try {
    candidates.push(Buffer.from(token, 'base64').toString('utf8'));
  } catch {
    // not base64
  }
  for (const text of candidates) {
    try {
      const parsed = asRec(JSON.parse(text));
      if (!parsed) continue;
      out.protocolVersion = asStr(parsed.protocolVersion) ?? null;
      out.signatureShape = Object.fromEntries(
        Object.keys(parsed)
          .sort()
          .map((k) => {
            const v = parsed[k];
            return [k, typeof v === 'string' ? `string(${v.length})` : Array.isArray(v) ? `array(${v.length})` : typeof v];
          }),
      );
      return out;
    } catch {
      // try the next candidate
    }
  }
  out.protocolVersion = null;
  out.signatureShape = 'not JSON';
  return out;
}

const WHOLESALE_REDACT_KEYS = new Set([
  'billingaddress',
  'shippingaddress',
  'email',
  'emailaddress',
  'phonenumber',
  'phone',
  'carddetails',
  'recipientname',
]);

/**
 * Applied to the whole capture at the write site. A resolved Google Pay
 * `PaymentData` carries a live, single-use payment credential
 * (`tokenizationData.token`) plus the buyer's billing address, email and phone.
 * This file is committed, so none of that may ever reach disk: the token is
 * reduced to its length / protocolVersion / signature shape, and address, email,
 * phone and card-tail fields are replaced wholesale. A final pass over every
 * string also masks anything shaped like an email address or equal to the test
 * account's own email, as a backstop for values under keys not listed above.
 */
function redact(value: unknown, ownEmail: string): unknown {
  const maskString = (s: string): string => {
    let r = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
    if (ownEmail) r = r.split(ownEmail).join('[redacted-email]');
    return r;
  };
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') return key.toLowerCase() === 'token' ? summariseToken(v) : maskString(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    const r = asRec(v);
    if (!r) return v;
    if (key.toLowerCase() === 'tokenizationdata') {
      return { ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'token').map(([k, x]) => [k, walk(x, k)])), token: summariseToken(r.token) };
    }
    return Object.fromEntries(
      Object.entries(r).map(([k, x]) => [k, WHOLESALE_REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : walk(x, k)]),
    );
  };
  return walk(value, '');
}

// ---------------------------------------------------------------------------
// One capture run
// ---------------------------------------------------------------------------

interface RunResult {
  mode: Mode;
  startedAt: string;
  completed: boolean;
  error?: string;
  environmentSignals?: unknown;
  paymentRequestRemoval?: unknown;
  consoleIssues?: Rec[];
  surface?: Rec;
  sdk?: { extracted: ExtractedSdk; rawCapture: Rec | null };
  network?: Rec;
  buttonDom?: unknown;
  csp?: Rec;
  dispatchOrder?: Rec;
  screenshots: string[];
}

async function launch(mode: Mode): Promise<Browser> {
  if (mode === 'plain') {
    // Plain Chromium: no stealth plugin and no anti-automation launch args, so
    // the only difference from the stealth run is the stealth treatment itself.
    return chromium.launch({ headless: false });
  }
  // Mirrors tests/fixtures/index.ts, including the `user-agent-override`
  // evasion being removed (see the long comment there for why).
  const stealth = StealthPlugin();
  stealth.enabledEvasions.delete('user-agent-override');
  chromiumExtra.use(stealth);
  return chromiumExtra.launch({
    headless: false,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

async function runCapture(mode: Mode, shotDir: string): Promise<RunResult> {
  const result: RunResult = { mode, startedAt: new Date().toISOString(), completed: false, screenshots: [] };
  const log = (m: string) => console.log(`[${mode}] ${m}`);
  const browser = await launch(mode);
  let page: Page | undefined;
  let net: NetworkCapture | undefined;
  let surfaceReport: Rec | undefined;
  let clicked = false;

  const collect = async (): Promise<void> => {
    if (net) {
      await net.settle();
      const writes = net.kwhWrites;
      result.network = {
        payJs: {
          requested: net.payJs.length > 0,
          requests: net.payJs.map((r) => ({ url: r.url, status: r.status ?? null, failure: r.failure ?? null })),
        },
        googlePayRequests: net.googlePay,
        cybersourceRequests: net.cybersource,
        kwhAndFrontasticNonGetRequests: writes,
      };
      result.dispatchOrder = {
        note:
          'No payment is placed by this script, so the real Dispatch Order call is only recorded if the site makes it before the Pay step. ' +
          'If candidates is empty, run the same observation (no request values, URL + method + status + key names) through a real order, or inspect kwhAndFrontasticNonGetRequests.',
        currentPlaceholder: String(CURRENT_DISPATCH_PLACEHOLDER),
        candidates: writes
          .filter((r) => /dispatch/i.test(r.url))
          .map((r) => ({ ...r, matchesCurrentPlaceholder: CURRENT_DISPATCH_PLACEHOLDER.test(r.url) })),
        placeholderMatchesAnyRecordedWrite: writes.filter((r) => CURRENT_DISPATCH_PLACEHOLDER.test(r.url)).map((r) => r.url),
      };
      result.csp = summariseCsp(net.documents);
    }
    if (page && !page.isClosed()) {
      const raw = await page
        .evaluate(() => (window as unknown as { __GPAY_CAPTURE__?: unknown }).__GPAY_CAPTURE__ ?? null)
        .catch(() => null);
      const rawRec = asRec(raw);
      result.sdk = { extracted: extractSdk(rawRec), rawCapture: rawRec ?? null };
      if (mode === 'no-payment-request') {
        result.paymentRequestRemoval = await page
          .evaluate(() => ({
            recordedByInitScript: (window as unknown as { __GPAY_PR_REMOVAL__?: unknown }).__GPAY_PR_REMOVAL__ ?? null,
            nowInWindow: 'PaymentRequest' in window,
            nowTypeof: typeof (window as unknown as { PaymentRequest?: unknown }).PaymentRequest,
            nowValueIsUndefined: (window as unknown as { PaymentRequest?: unknown }).PaymentRequest === undefined,
          }))
          .catch(() => null);
      }
    }
  };

  try {
    const chromeDesktop = devices['Desktop Chrome'];
    const context = await browser.newContext({
      baseURL: STAGING_ORIGIN,
      storageState: AUTH_FILE,
      viewport: { width: 1920, height: 1080 },
      userAgent: chromeDesktop.userAgent,
      deviceScaleFactor: chromeDesktop.deviceScaleFactor,
      isMobile: chromeDesktop.isMobile,
      hasTouch: chromeDesktop.hasTouch,
      ignoreHTTPSErrors: true,
    });
    // Same ceilings as playwright.config.ts (actionTimeout / navigationTimeout / expect).
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(45_000);
    expect.configure({ timeout: 15_000 });

    await context.addInitScript(OBSERVER_SCRIPT);
    // Init scripts run in the order they are added, so the observer sees the real PaymentRequest first.
    if (mode === 'no-payment-request') await context.addInitScript(REMOVE_PAYMENT_REQUEST_SCRIPT);
    net = attachNetworkCapture(context);
    page = await context.newPage();

    // Console errors and warnings from every frame of the page, kept verbatim,
    // plus any other console line that mentions PaymentRequest or Google Pay.
    const consoleIssues: Rec[] = [];
    result.consoleIssues = consoleIssues;
    const issueText = /PaymentRequest|google\s?pay|gpay|payments\.api|pay\.js/i;
    page.on('console', (msg) => {
      const text = msg.text();
      if (consoleIssues.length >= 100) return;
      if (msg.type() !== 'error' && msg.type() !== 'warning' && !issueText.test(text)) return;
      consoleIssues.push({
        phase: clicked ? 'after-click' : 'before-click',
        type: msg.type(),
        source: sanitizeUrl(msg.location().url || ''),
        text: text.length > 2000 ? `${text.slice(0, 2000)}...[truncated]` : text,
      });
    });
    page.on('pageerror', (err) => {
      if (consoleIssues.length >= 100) return;
      consoleIssues.push({ phase: clicked ? 'after-click' : 'before-click', type: 'pageerror', source: 'page', text: err.message.slice(0, 2000) });
    });

    log('driving the checkout up to the payment step (Google Pay selected)...');
    const flow = new CheckoutFlow(page);
    await flow.arriveAtPayment({ userType: 'logged-in', shipping: 'standard', region: 'AU', payment: 'gpay' });
    log('payment step reached.');

    result.environmentSignals = await page.evaluate(() => ({
      navigatorWebdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      paymentRequestAvailable: typeof window.PaymentRequest === 'function',
      paymentRequestInWindow: 'PaymentRequest' in window,
      paymentRequestTypeof: typeof (window as unknown as { PaymentRequest?: unknown }).PaymentRequest,
    }));

    const gpayButton = page.locator(GPAY_BUTTON_SELECTOR).filter({ visible: true }).first();
    await gpayButton.waitFor({ state: 'visible', timeout: 20_000 });

    // ---- 4. Button DOM (read before the click) ----
    const topAtButtonCentre = (): Promise<string> =>
      page!
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return 'no-gpay-button';
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!top) return 'nothing-at-point';
          return `${top.tagName.toLowerCase()}.${(top.getAttribute('class') || '').slice(0, 60)}`;
        }, GPAY_BUTTON_SELECTOR)
        .catch(() => 'evaluate-failed');

    const centreBeforeWait = await topAtButtonCentre();
    const buttonOnTop = await page
      .waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!top && (top === el || el.contains(top));
        },
        GPAY_BUTTON_SELECTOR,
        { timeout: 15_000, polling: 250 },
      )
      .then(() => true)
      .catch(() => false);
    let neutralisedPlaceOrder = false;
    if (!buttonOnTop) {
      // Same recovery payWithGooglePay uses: pointer-events only, nothing removed.
      await page
        .evaluate((sel) => {
          const po = document.querySelector(sel) as HTMLElement | null;
          if (po) po.style.pointerEvents = 'none';
        }, PLACE_ORDER_SELECTOR)
        .catch(() => undefined);
      neutralisedPlaceOrder = true;
    }
    const centreAfterWait = await topAtButtonCentre();

    const buttonDetails = await gpayButton.evaluate((el, placeOrderSel) => {
      const describe = (n: Element | null) =>
        n ? { tag: n.tagName.toLowerCase(), id: n.id || null, class: (n.getAttribute('class') || '').slice(0, 120), role: n.getAttribute('role'), ariaLabel: n.getAttribute('aria-label') } : null;
      const root = el.getRootNode();
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const ancestry: unknown[] = [];
      let n: Element | null = el.parentElement;
      for (let i = 0; n && i < 14; i += 1) {
        ancestry.push(describe(n));
        n = n.parentElement;
      }
      const hit = (x: number, y: number) => {
        const top = document.elementFromPoint(x, y);
        return { element: describe(top), isButtonOrDescendant: !!top && (top === el || el.contains(top)) };
      };
      const po = document.querySelector(placeOrderSel);
      const por = po ? po.getBoundingClientRect() : null;
      return {
        outerHTML: el.outerHTML.slice(0, 6000),
        tag: el.tagName.toLowerCase(),
        roleAttribute: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        ariaAttributes: Object.fromEntries(Array.from(el.attributes).filter((a) => a.name.startsWith('aria-')).map((a) => [a.name, a.value])),
        tabindex: el.getAttribute('tabindex'),
        insideShadowRoot: typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot,
        sameDocumentIsTopFrame: window === window.top,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        computed: { display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents, position: cs.position, zIndex: cs.zIndex },
        ancestry,
        elementFromPointAtButtonCentre: hit(r.left + r.width / 2, r.top + r.height / 2),
        placeOrder: po
          ? {
              pointerEvents: window.getComputedStyle(po).pointerEvents,
              rect: por ? { x: Math.round(por.x), y: Math.round(por.y), w: Math.round(por.width), h: Math.round(por.height) } : null,
              elementFromPointAtPlaceOrderCentre: por ? hit(por.left + por.width / 2, por.top + por.height / 2) : null,
            }
          : null,
      };
    }, PLACE_ORDER_SELECTOR);
    const ariaSnapshot = await gpayButton.ariaSnapshot().catch((e: unknown) => `unavailable: ${errMsg(e)}`);
    // A cross-origin iframe is invisible to the locator above, so ask each frame too.
    const framesWithButton: string[] = [];
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      if ((await f.locator(GPAY_BUTTON_SELECTOR).count().catch(() => 0)) > 0) framesWithButton.push(sanitizeUrl(f.url()));
    }
    result.buttonDom = {
      ...buttonDetails,
      accessibilitySnapshot: ariaSnapshot,
      foundInIframes: framesWithButton,
      hitTest: {
        topAtCentreBeforeWaiting: centreBeforeWait,
        buttonWasOnTopWithin15s: buttonOnTop,
        placeOrderPointerEventsNeutralisedByThisScript: neutralisedPlaceOrder,
        topAtCentreAfterWaiting: centreAfterWait,
      },
    };

    // ---- 1. Click, then observe which surface the sheet uses ----
    const collector = registerSurfaceListeners(page, context);
    log("clicking the Google Pay button once. Look at the browser window now. This script will NOT click Pay.");
    let clickError: string | undefined;
    clicked = true;
    await gpayButton.click({ timeout: 15_000 }).catch((e: unknown) => {
      clickError = errMsg(e);
      log(`click failed: ${clickError}`);
    });

    let timer: NodeJS.Timeout | undefined;
    const windowElapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHEET_WINDOW_MS);
    });
    // This mode always watches the full window, so a sheet that renders after the first frame event is still observed.
    await (mode === 'no-payment-request' ? windowElapsed : Promise.race([collector.firstSurface, windowElapsed]));
    if (timer) clearTimeout(timer);

    // Enumerate frames directly as well - a frame that attached without a navigation event still counts.
    for (const f of page.frames()) {
      if (f !== page.mainFrame() && isGooglePayHost(hostOf(f.url()))) collector.frames.add(f);
    }

    const surfaces: Rec[] = [];
    let i = 0;
    for (const [p, vias] of collector.popups) {
      i += 1;
      surfaces.push(await describePopup(p, vias, path.join(shotDir, `${mode}-popup-${i}.png`)));
    }
    i = 0;
    for (const f of collector.frames) {
      i += 1;
      surfaces.push(await describeFrame(f, path.join(shotDir, `${mode}-frame-${i}.png`)));
    }
    const pagePath = path.join(shotDir, `${mode}-checkout-page-after-click.png`);
    await page.screenshot({ path: pagePath }).then(() => result.screenshots.push(path.relative(REPO_ROOT, pagePath)), () => undefined);
    const fullPagePath = path.join(shotDir, `${mode}-checkout-page-after-click-fullpage.png`);
    await page.screenshot({ path: fullPagePath, fullPage: true }).then(() => result.screenshots.push(path.relative(REPO_ROOT, fullPagePath)), () => undefined);
    for (const s of surfaces) {
      for (const key of ['screenshot', 'fallbackViewportScreenshot']) {
        const v = s[key];
        if (typeof v === 'string' && v.endsWith('.png')) result.screenshots.push(v);
      }
    }
    const mainFrame = page.mainFrame();
    const allFramesAfterClick = page.frames().map((f) => ({ main: f === mainFrame, url: sanitizeUrl(f.url()) }));

    // Read the SDK capture now so PaymentRequest / loadPaymentData signals are known for the verdict.
    await collect();
    const pr = asRec(result.sdk?.rawCapture?.paymentRequest);
    const prConstructed = asArr(pr?.constructed).length;
    const prShowCalled = asArr(pr?.constructed).some((e) => asArr(asRec(e)?.calls).some((c) => asRec(c)?.method === 'show'));
    const loadPaymentDataCalled = result.sdk?.extracted.calls.includes('loadPaymentData') ?? false;
    const loadCall = asArr(result.sdk?.rawCapture?.calls)
      .map(asRec)
      .find((c) => c?.method === 'loadPaymentData');
    const loadPaymentDataOutcome = !loadCall
      ? 'not-called'
      : loadCall.threw !== undefined
        ? 'threw-synchronously'
        : loadCall.rejected !== undefined
          ? 'rejected'
          : loadCall.resolved !== undefined
            ? 'resolved'
            : 'pending-at-end-of-window';
    const payframeSurface = surfaces.find((s) => s.isPayframe === true);
    const hasContent = surfaces.some((s) => s.contentAppeared === true && Number(s.bodyTextLength) > 0);

    let operatorSawSheet: boolean | null = null;
    let verdict: string;
    let automatable: boolean | null;
    let explanation: string;
    // A pay.google.com frame EXISTING does not make the sheet automatable.
    // Measured 2026-10-02: a run with two such frames was still the native
    // path — one was `generate_gpay_btn_img` (the button's image, 240x40)
    // and the other the `payframe` helper at display:none, 0x0. The sheet
    // itself was drawn by Chrome. So PaymentRequest.show() is checked FIRST:
    // once the browser has drawn the sheet, whatever frames are also on the
    // page are helpers, not the surface. Then a DOM surface only counts as
    // driveable if it is actually rendered — content AND, for a frame, a
    // real box. An earlier version returned automatable:true on frame
    // presence alone and wrote that wrong verdict into docs/gpay/.
    const driveableSurface = surfaces.find((s) => {
      if (s.contentAppeared !== true || !(Number(s.bodyTextLength) > 0)) return false;
      if (s.kind !== 'frame') return true; // a popup Page is driveable as-is
      const box = s.iframeBox as { width?: number; height?: number } | null;
      return !!box && Number(box.width) > 0 && Number(box.height) > 0;
    });
    if (prShowCalled) {
      verdict = 'native-payment-request';
      automatable = false;
      explanation =
        surfaces.length > 0
          ? `The page called PaymentRequest.show(), so Chrome drew the sheet itself, outside the DOM. The ${surfaces.length} pay.google.com frame(s) present are the SDK's helpers (button image, hidden payframe), not the sheet - their presence does not make it driveable.`
          : 'No popup and no pay.google.com frame, but the page called PaymentRequest.show(): Chrome draws that sheet itself, outside the DOM.';
    } else if (driveableSurface) {
      verdict = `dom-surface (${String(driveableSurface.kind)}) with content`;
      automatable = true;
      explanation = 'A page/frame appeared, is actually rendered, and has content - so Playwright can read and drive it.';
    } else if (surfaces.length > 0) {
      const kinds = [...new Set(surfaces.map((s) => String(s.kind)))].join(' + ');
      verdict = `dom-surface (${kinds}) present but NOT driveable`;
      automatable = false;
      explanation = hasContent
        ? 'A page/frame appeared with content, but it is not rendered (hidden, or zero-sized), so there is nothing on screen to click.'
        : 'A page/frame appeared but rendered no text and is not displayed - a helper frame, not a sheet.';
    } else if (prShowCalled) {
      verdict = 'native-payment-request';
      automatable = false;
      explanation = 'No popup and no pay.google.com frame, but the page called PaymentRequest.show(): Chrome draws that sheet itself, outside the DOM.';
    } else {
      operatorSawSheet = await askOperator(
        '\nNo popup or pay.google.com frame appeared. Can you SEE a Google Pay sheet in the browser window? [y/n] ',
      );
      if (operatorSawSheet === true) {
        verdict = 'native-sheet-seen-by-operator';
        automatable = false;
        explanation = 'No DOM surface, but the operator saw a sheet: that is the browser-drawn (native) path, which no automation tool can click.';
      } else {
        verdict = loadPaymentDataCalled ? 'no-dom-surface-observed' : 'no-sheet-observed';
        automatable = null;
        explanation = loadPaymentDataCalled
          ? 'loadPaymentData was called but no popup, frame or PaymentRequest.show() was observed and no sheet was confirmed. Inconclusive.'
          : 'The click did not reach loadPaymentData, so the button never asked Google for a sheet.';
      }
    }
    if (mode === 'no-payment-request') {
      // The payframe is the only surface that counts here; the button-image frame always exists.
      const style = asRec(payframeSurface?.iframeStyle);
      const sized = Number(style?.width) > 0 && Number(style?.height) > 0 && style?.display !== 'none' && style?.visibility !== 'hidden';
      const signals = asRec(payframeSurface?.textSignals);
      const hasSheetSignals =
        Number(payframeSurface?.visibleButtonCount) > 0 ||
        Number(payframeSurface?.payOrContinueButtonCount) > 0 ||
        Object.values(signals ?? {}).some((v) => v === true);
      if (!payframeSurface) verdict = 'payframe-not-present';
      else if (sized && hasSheetSignals) verdict = 'payframe-sized-with-sheet-signals';
      else if (sized) verdict = 'payframe-sized-but-no-sheet-signals';
      else verdict = 'payframe-present-but-not-sized-or-hidden';
      explanation = `payframe present: ${Boolean(payframeSurface)}; sized and displayed: ${sized}; sheet signals in its text/buttons: ${hasSheetSignals}; PaymentRequest.show() called: ${prShowCalled}; loadPaymentData outcome: ${loadPaymentDataOutcome}.`;
      automatable = sized && hasSheetSignals ? true : null;
    }
    surfaceReport = {
      verdict,
      automatable,
      explanation,
      clickError: clickError ?? null,
      watchWindowMs: SHEET_WINDOW_MS,
      popupOrNewPageCount: collector.popups.size,
      googlePayFrameCount: collector.frames.size,
      surfaces,
      paymentRequestConstructedCount: prConstructed,
      paymentRequestShowCalled: prShowCalled,
      loadPaymentDataCalled,
      loadPaymentDataOutcome,
      loadPaymentDataDetail: loadCall ? { threw: loadCall.threw ?? null, rejected: loadCall.rejected ?? null } : null,
      payframe: payframeSurface ?? null,
      allFramesAfterClick,
      operatorSawSheet,
    };
    result.surface = surfaceReport;
    result.completed = true;
  } catch (err) {
    result.error = errMsg(err);
    log(`run failed: ${result.error}`);
    if (page && !page.isClosed()) {
      const p = path.join(shotDir, `${mode}-failure.png`);
      await page.screenshot({ path: p }).then(() => result.screenshots.push(path.relative(REPO_ROOT, p)), () => undefined);
    }
  } finally {
    if (!result.network) await collect().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSummary(r: RunResult): void {
  const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(34)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  console.log(`\n=== Run: ${modeLabel(r.mode)} ===`);
  if (r.error) console.log(`  RUN ERROR: ${r.error}`);
  if (r.environmentSignals) line('browser signals', r.environmentSignals);
  if (r.paymentRequestRemoval) line('PaymentRequest removal state', r.paymentRequestRemoval);
  const s = r.surface;
  if (s) {
    console.log('\n  [1] Sheet surface');
    line('verdict', String(s.verdict));
    line('automatable by Playwright', s.automatable === null ? 'unknown' : String(s.automatable));
    line('why', String(s.explanation));
    line('popups / new pages', String(s.popupOrNewPageCount));
    line('pay.google.com frames', String(s.googlePayFrameCount));
    line('PaymentRequest constructed', String(s.paymentRequestConstructedCount));
    line('PaymentRequest.show() called', String(s.paymentRequestShowCalled));
    line('loadPaymentData called', String(s.loadPaymentDataCalled));
    line('loadPaymentData outcome', String(s.loadPaymentDataOutcome));
    if (s.loadPaymentDataDetail) line('loadPaymentData detail', s.loadPaymentDataDetail);
    for (const surface of asArr(s.surfaces).map(asRec)) {
      if (!surface) continue;
      line(`  ${String(surface.kind)} content`, {
        url: surface.url,
        title: surface.title,
        bodyTextLength: surface.bodyTextLength,
        visibleButtonCount: surface.visibleButtonCount,
        contentAppeared: surface.contentAppeared,
      });
      if (surface.kind === 'frame') {
        line('    iframe box / style', { box: surface.iframeBox, style: surface.iframeStyle });
        line('    text signals', { ...asRec(surface.textSignals), payOrContinueButtons: surface.payOrContinueButtonCount });
        line('    screenshot', { element: surface.screenshot, viewportFallback: surface.fallbackViewportScreenshot });
      }
    }
    line('all frames after click', asArr(s.allFramesAfterClick));
    if (!asRec(s.payframe)) console.log(`  No frame under ${PAYFRAME_PATH} was found after the click.`);
  } else {
    console.log('\n  [1] Sheet surface: not reached (see run error).');
  }
  if (r.consoleIssues) {
    console.log('\n  Console errors / warnings / Google Pay mentions (verbatim)');
    if (r.consoleIssues.length === 0) console.log('  none');
    for (const c of r.consoleIssues) console.log(`  [${String(c.phase)}] ${String(c.type)} ${String(c.source)}: ${String(c.text)}`);
  }
  const sdk = r.sdk?.extracted;
  if (sdk) {
    console.log('\n  [2] SDK configuration (as passed by the site)');
    line('SDK calls observed', sdk.calls.length ? sdk.calls.join(', ') : 'none');
    line('environment', sdk.environment ?? 'not captured');
    line('merchantInfo', sdk.merchantInfo ?? 'not captured');
    line('gateway(s)', sdk.allowedPaymentMethods.length ? sdk.allowedPaymentMethods : 'not captured');
    line('allowedCardNetworks', sdk.allowedCardNetworks.length ? sdk.allowedCardNetworks : 'not captured');
    line('allowedAuthMethods', sdk.allowedAuthMethods.length ? sdk.allowedAuthMethods : 'not captured');
    line('transactionInfo', sdk.transactionInfo ?? 'not captured');
    line('isReadyToPay result', sdk.isReadyToPay ?? sdk.isReadyToPayRejected ?? 'not captured');
    const cap = r.sdk?.rawCapture;
    const errors = asArr(cap?.errors);
    if (errors.length) line('observer errors', errors);
    if (cap && !cap.sdkAssigned) console.log('  NOTE: window.google was never assigned on the page - the Google Pay SDK did not load.');
  }
  const net = r.network;
  if (net) {
    console.log('\n  [3] Network');
    const payJs = asRec(net.payJs);
    line('pay.js requested', payJs?.requested ? asArr(payJs.requests) : 'no');
    line('pay.google.com requests', asArr(net.googlePayRequests).length);
    line('cybersource.com requests', asArr(net.cybersourceRequests).length);
    line('KWH/Frontastic non-GET calls', asArr(net.kwhAndFrontasticNonGetRequests).length);
  }
  const b = asRec(r.buttonDom);
  if (b) {
    console.log('\n  [4] Button DOM');
    line('inside shadow root', String(b.insideShadowRoot));
    line('found in iframes', asArr(b.foundInIframes));
    line('role / aria-label', { role: b.roleAttribute, ariaLabel: b.ariaLabel });
    line('element at button centre', asRec(b.elementFromPointAtButtonCentre));
    line('hit test', asRec(b.hitTest));
  }
  const csp = r.csp;
  if (csp) {
    console.log('\n  [5] CSP (response header)');
    line('checkout document', String(csp.checkoutDocumentUrl));
    line('enforced header served', String(csp.enforcedHeaderServed));
    line('report-only header served', String(csp.reportOnlyHeaderServed));
    line('enforced directives', csp.enforcedDirectives);
  }
  const d = r.dispatchOrder;
  if (d) {
    console.log('\n  [6] Dispatch Order endpoint');
    const cands = asArr(d.candidates);
    if (cands.length) cands.forEach((c) => line('candidate', c));
    else console.log('  No request containing "dispatch" was seen (expected - no payment is placed). All non-GET KWH/Frontastic calls are in the JSON.');
  }
  if (r.screenshots.length) line('screenshots (gitignored)', r.screenshots);
}

function parseModes(): Mode[] {
  const arg = process.argv.find((a) => a.startsWith('--mode='));
  const value = arg?.slice('--mode='.length) ?? 'all';
  if (value === 'all' || value === 'both') return ALL_MODES;
  if (value === 'stealth' || value === 'plain' || value === 'no-payment-request') return [value];
  throw new Error(`Unknown --mode=${value}. Use stealth, plain, no-payment-request or all.`);
}

async function main(): Promise<void> {
  const modes = parseModes();
  console.log('\n=== KWH Payments - Google Pay integration capture ===');
  console.log(`Runs: ${modes.map(modeLabel).join('; ')}. A real browser window opens for each.`);
  console.log('The script clicks the Google Pay button once and NEVER clicks Pay. Nothing is purchased.\n');

  // Fail closed: without a genuinely signed-in session the flow would silently test as a guest.
  if (!isSignedInFile()) {
    throw new Error('No genuinely signed-in saved session found. Run `npm run auth:setup` first, then re-run this.');
  }
  if (!process.env.TEST_USER_EMAIL) {
    throw new Error('TEST_USER_EMAIL is not set in .env - the signed-in checkout needs it.');
  }

  const date = localDate();
  // Screenshots of the Google Pay surface can show the buyer's address and card
  // tail, so they go to the gitignored screenshots/ folder, never to docs/.
  const shotDir = path.join(REPO_ROOT, 'screenshots', 'gpay-capture', date);
  fs.mkdirSync(shotDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const runs: RunResult[] = [];
  for (const mode of modes) {
    console.log(`--- Starting run: ${modeLabel(mode)} ---`);
    const r = await runCapture(mode, shotDir);
    runs.push(r);
    printSummary(r);
  }

  const environments = runs.map((r) => r.sdk?.extracted.environment).filter((e): e is string => !!e);
  const production = environments.some((e) => e.toUpperCase() === 'PRODUCTION');
  if (production) {
    console.log(
      '\n' +
        '  ##################################################################\n' +
        '  #  WARNING: the site configured Google Pay with environment      #\n' +
        "  #  'PRODUCTION'. On staging that means REAL card authorisations, #\n" +
        '  #  so every manual Google Pay run to date may have charged a     #\n' +
        '  #  real card. Treat this as urgent.                              #\n' +
        '  ##################################################################\n',
    );
  }

  const comparison =
    runs.length > 1
      ? {
          note: 'Compare these verdicts across modes to see whether the sheet renders under automation.',
          verdicts: Object.fromEntries(runs.map((r) => [r.mode, asRec(r.surface)?.verdict ?? 'no verdict (run failed)'])),
        }
      : undefined;

  // Redaction happens here, at the write site, so no caller has to remember it.
  const output = redact(
    {
      capturedAt: new Date().toISOString(),
      stagingOrigin: STAGING_ORIGIN,
      flow: { userType: 'logged-in', shipping: 'standard', region: 'AU', payment: 'gpay' },
      productionEnvironmentDetected: production,
      comparison,
      runs,
    },
    process.env.TEST_USER_EMAIL ?? '',
  );
  const suffix = modes.length === ALL_MODES.length ? '' : `-${modes.join('-')}`;
  const file = path.join(OUTPUT_DIR, `capture-${date}${suffix}.json`);
  fs.writeFileSync(file, JSON.stringify(output, null, 2));
  console.log(`\nSaved (token, address, email and phone redacted): ${path.relative(REPO_ROOT, file)}`);
  if (comparison) console.log(`Verdicts: ${JSON.stringify(comparison.verdicts)}`);
  if (runs.some((r) => !r.completed)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nFAILED: ${errMsg(err)}`);
  process.exit(1);
});
