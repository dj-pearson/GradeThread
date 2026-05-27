// Parser for the eBay Seller Hub "Payouts" CSV
// (Payments → Payouts → Download report). The export has a few banner rows
// before the table and column names drift slightly between account types,
// so we locate the header row by content and resolve columns by alias.

import { parseCsv, normalizeHeader } from "./csv-parse.ts";

export interface ParsedPayoutRow {
  payoutId: string;
  payoutDate: string; // YYYY-MM-DD
  amount: number; // net amount paid out
  currency: string;
  status: string | null;
  raw: Record<string, string>;
}

export interface PayoutsCsvResult {
  headerFound: boolean;
  payouts: ParsedPayoutRow[];
  /** Rows after the header that didn't carry the required fields. */
  skipped: number;
}

// Each canonical field → list of normalized header aliases. First match wins.
// Covers the common eBay variants: "Payout ID", "Payment ID",
// "Net amount", "Total amount", "Date initiated", "Payout date", etc.
const COLUMN_ALIASES = {
  payoutId: ["payoutid", "paymentid", "transactionid", "reference"],
  payoutDate: [
    "payoutdate",
    "dateinitiated",
    "datecompleted",
    "completiondate",
    "initiateddate",
    "date",
  ],
  amount: [
    "netamount",
    "totalamount",
    "amount",
    "amountusd",
    "payoutamount",
    "netpayout",
  ],
  currency: ["currency", "currencycode"],
  status: ["status", "payoutstatus"],
} as const;

function parseMoney(v: string | undefined): number | null {
  if (!v) return null;
  // Strip currency symbols, commas, spaces, parentheses (negative). Keep -.
  const negative = /\(.*\)/.test(v);
  const cleaned = v.replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function parseDate(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function parseEbayPayoutsCsv(input: string): PayoutsCsvResult {
  const rows = parseCsv(input);

  // Find the header row: first row whose normalized cells contain at least
  // one match for `payoutId` AND one match for `amount`. eBay sometimes
  // ships 1–4 banner rows before the actual table.
  const aliasSet = (group: readonly string[]) => new Set(group);
  const idAliases = aliasSet(COLUMN_ALIASES.payoutId);
  const amtAliases = aliasSet(COLUMN_ALIASES.amount);

  let headerIdx = -1;
  for (let i = 0; i < rows.length && i < 25; i++) {
    const cells = rows[i] ?? [];
    const norms = cells.map(normalizeHeader);
    if (
      norms.some((n) => idAliases.has(n)) &&
      norms.some((n) => amtAliases.has(n))
    ) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    return { headerFound: false, payouts: [], skipped: 0 };
  }

  const headerCells = (rows[headerIdx] ?? []).map(normalizeHeader);

  // Resolve each canonical field to its column index.
  const colIndex: Record<keyof typeof COLUMN_ALIASES, number> = {
    payoutId: -1,
    payoutDate: -1,
    amount: -1,
    currency: -1,
    status: -1,
  };
  (Object.keys(COLUMN_ALIASES) as Array<keyof typeof COLUMN_ALIASES>).forEach(
    (key) => {
      const aliases = COLUMN_ALIASES[key];
      for (let i = 0; i < headerCells.length; i++) {
        if (aliases.includes(headerCells[i] as never)) {
          colIndex[key] = i;
          break;
        }
      }
    },
  );

  const payouts: ParsedPayoutRow[] = [];
  let skipped = 0;

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    // Skip entirely empty rows (eBay footers occasionally trail blank lines).
    if (cells.every((c) => !c.trim())) continue;

    const get = (idx: number): string =>
      idx >= 0 && idx < cells.length ? cells[idx]!.trim() : "";

    const payoutId = get(colIndex.payoutId);
    const amount = parseMoney(get(colIndex.amount));
    const payoutDate = parseDate(get(colIndex.payoutDate));

    // Hard requirements: id, amount, date. Without them the row is useless
    // for matching; counted as skipped so the caller can surface it.
    if (!payoutId || amount == null || !payoutDate) {
      skipped++;
      continue;
    }

    const raw: Record<string, string> = {};
    for (let c = 0; c < headerCells.length; c++) {
      const key = headerCells[c] || `col${c}`;
      raw[key] = get(c);
    }

    payouts.push({
      payoutId,
      payoutDate,
      amount,
      currency: get(colIndex.currency) || "USD",
      status: get(colIndex.status) || null,
      raw,
    });
  }

  return { headerFound: true, payouts, skipped };
}
