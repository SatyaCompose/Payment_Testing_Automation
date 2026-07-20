import { request } from '@playwright/test';

const DEFAULT_SHEET_ID = '1sPqMhQpgJMIEyWKHVoIShyt35MufE_KCC8XS1pnhwbo';
const DEFAULT_SHEET_GID = '114523460';

interface Row {
  code: string;
  status: string;
}

/**
 * Fetches the KWH gift-card sheet as CSV and returns the first row whose
 * Status column is empty. Requires the sheet to be shared "Anyone with the
 * link" so the export URL is anon-fetchable. Override the sheet target via
 * `GIFT_CARD_SHEET_ID` / `GIFT_CARD_SHEET_GID`.
 *
 * If the fetch fails (sheet private, no network), falls back to the
 * `GIFT_CARD_NUMBER` env var so tests still have an escape hatch.
 */
export async function getFirstAvailableGiftCard(): Promise<string> {
  const sheetId = process.env.GIFT_CARD_SHEET_ID ?? DEFAULT_SHEET_ID;
  const gid = process.env.GIFT_CARD_SHEET_GID ?? DEFAULT_SHEET_GID;
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

  try {
    const ctx = await request.newContext();
    const res = await ctx.get(url, { timeout: 15_000 });
    if (!res.ok()) {
      throw new Error(`Sheet fetch returned ${res.status()}`);
    }
    const csv = await res.text();
    await ctx.dispose();

    const rows = parseCsv(csv);
    const firstAvailable = rows.find((r) => r.code && !r.status);
    if (!firstAvailable) {
      throw new Error('No gift card with an empty Status column found in the sheet');
    }
    return firstAvailable.code;
  } catch (err) {
    const fallback = process.env.GIFT_CARD_NUMBER;
    if (fallback) return fallback;
    throw new Error(
      `Could not fetch gift card from sheet and GIFT_CARD_NUMBER is not set. Original: ${(err as Error).message}`,
    );
  }
}

function parseCsv(csv: string): Row[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  const rows: Row[] = [];
  let seenHeader = false;
  for (const line of lines) {
    const cells = splitCsvLine(line).map((c) => c.trim());
    // Header row: "Gift Certificate Code,Amount,Amount Available,Status"
    if (!seenHeader && /gift certificate|code/i.test(cells[0] ?? '')) {
      seenHeader = true;
      continue;
    }
    if (!seenHeader) continue;
    const code = cells[0] ?? '';
    const status = cells[3] ?? '';
    if (!code) continue;
    rows.push({ code, status });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
