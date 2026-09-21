/**
 * Crop confirmation screenshots down to the receipt.
 *
 *   node tests/scripts/crop-confirmation-screenshots.mjs [file...]
 *
 * With no arguments it rewrites every PNG under `screenshots/`. The
 * confirmation renders on a 1920px canvas with ~420px gutters either
 * side, a logo row on top and a help/payment-icon footer at the bottom,
 * so a fullPage shot is mostly blank. This measures the ink instead:
 * rows carrying any non-white pixel are grouped into bands, the site
 * chrome bands are dropped, and the image is re-cut to what is left plus
 * a 24px margin. Every desktop shot lands on the same 1044px width, so
 * the regression doc's cells line up.
 *
 * `OrderConfirmationPage.captureScreenshot` already clips this way at
 * capture time; this script is for shots taken before that landed, or
 * when a DOM measurement misses.
 *
 * Plain .mjs on purpose — running it through tsx makes esbuild inject a
 * `__name` helper into the page.evaluate body, which throws in-browser.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const PAD = 24;

/** Every PNG under `screenshots/`, when no explicit files were passed. */
const collect = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collect(full);
    return entry.name.toLowerCase().endsWith('.png') ? [full] : [];
  });

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : collect(path.resolve('screenshots'));

if (!files.length) {
  console.log('No screenshots found.');
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 400 } });

for (const rel of files) {
  const file = path.resolve(rel);
  const url = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  await page.setContent(`<img id="i" src="${url}">`);
  await page.waitForFunction(() => {
    const i = document.getElementById('i');
    return i.complete && i.naturalWidth > 0;
  });

  const out = await page.evaluate((padding) => {
    const img = document.getElementById('i');
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    const inked = (x, y) => {
      const i = (y * w + x) * 4;
      return d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245;
    };

    // Horizontal ink bands: runs of rows carrying any ink, merged across
    // white gaps under 25px (normal paragraph spacing).
    const raw = [];
    let start = -1;
    for (let y = 0; y < h; y++) {
      let ink = false;
      for (let x = 0; x < w && !ink; x++) ink = inked(x, y);
      if (ink && start === -1) start = y;
      if (!ink && start !== -1) {
        raw.push({ top: start, bottom: y - 1 });
        start = -1;
      }
    }
    if (start !== -1) raw.push({ top: start, bottom: h - 1 });
    const bands = [];
    for (const b of raw) {
      const last = bands.at(-1);
      if (last && b.top - last.bottom <= 25) last.bottom = b.bottom;
      else bands.push({ ...b });
    }
    if (!bands.length) return null;

    // Drop the site chrome: a short leading band in the top 12% of the
    // page is the logo row, a short trailing band below 80% is the help
    // line / payment-icon footer. Everything between is the receipt, so
    // multi-band receipts keep all their parts.
    const dropped = [];
    while (bands.length > 1) {
      const first = bands[0];
      if (first.bottom < h * 0.12 && first.bottom - first.top < h * 0.1) {
        dropped.push({ role: 'header', ...bands.shift() });
      } else break;
    }
    while (bands.length > 1) {
      const last = bands.at(-1);
      if (last.top > h * 0.8 && last.bottom - last.top < h * 0.15) {
        dropped.push({ role: 'footer', ...bands.pop() });
      } else break;
    }

    const top = bands[0].top;
    const bottom = bands.at(-1).bottom;
    let minX = w;
    let maxX = 0;
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < w; x++) {
        if (!inked(x, y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    if (minX > maxX) return null;

    const x = Math.max(0, minX - padding);
    const y = Math.max(0, top - padding);
    const width = Math.min(w - x, maxX - minX + 1 + padding * 2);
    const height = Math.min(h - y, bottom - top + 1 + padding * 2);

    const crop = document.createElement('canvas');
    crop.width = width;
    crop.height = height;
    const cctx = crop.getContext('2d');
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, width, height);
    cctx.drawImage(c, x, y, width, height, 0, 0, width, height);
    return {
      rect: { x, y, width, height },
      original: { w, h },
      dropped,
      kept: bands.length,
      dataUrl: crop.toDataURL('image/png'),
    };
  }, PAD);

  if (!out) {
    console.log(`${rel}: SKIPPED (no ink measured)`);
    continue;
  }
  fs.writeFileSync(file, Buffer.from(out.dataUrl.split(',')[1], 'base64'));
  const chrome = out.dropped.map((b) => `${b.role} ${b.top}-${b.bottom}`).join(', ') || 'none';
  console.log(
    `${rel}: ${out.original.w}x${out.original.h} -> ${out.rect.width}x${out.rect.height} @ (${out.rect.x},${out.rect.y}) | bands kept ${out.kept}, dropped: ${chrome}`,
  );
}

await browser.close();
