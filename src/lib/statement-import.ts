import { toCents } from "@/lib/ledger-math";

// US-2994 — bank and card CSV import.
//
// Everything in the top half is PURE: parsing a CSV, guessing its columns,
// fingerprinting a row. That is deliberate. Every bank exports a differently
// shaped file, the failure modes are all in the parsing, and none of them need
// a database to reproduce.

export interface ColumnMap {
  date: string;
  amount: string;
  description: string;
  /**
   * How the file expresses money leaving.
   *
   * Banks disagree, and getting it backwards turns every purchase into a
   * deposit -- which shows up as an empty import rather than a wrong one,
   * because deposits are not expense candidates.
   */
  sign: "negative_is_spend" | "positive_is_spend" | "separate_columns";
  /** Only for `separate_columns`: the header that carries money leaving. */
  debitColumn?: string;
  creditColumn?: string;
}

export interface ParsedRow {
  posted_on: string;
  /** Signed cents, negative when money left. */
  amount_cents: number;
  description: string;
  row_fingerprint: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Lines that could not be read, with the reason and the raw text. */
  skipped: { line: number; reason: string; raw: string }[];
  headers: string[];
}

/**
 * Split one CSV line, honouring quotes.
 *
 * Bank descriptions contain commas constantly ("AMZN Mktp US*2K4L1, Seattle"),
 * so a naive `split(",")` shifts every later column by one and silently reads
 * the amount out of the wrong field. Doubled quotes inside a quoted field are
 * the standard escape.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * A money cell to signed cents.
 *
 * Handles the shapes banks actually emit: `-24.99`, `(24.99)` for a negative,
 * `$24.99`, `1,234.56`. Returns null for anything else, and the row is skipped
 * with a reason rather than imported as zero.
 */
export function parseMoney(cell: string): number | null {
  let s = cell.trim();
  if (s === "") return null;
  let negative = false;
  // Accounting notation: (24.99) means -24.99.
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$\s,]/g, "");
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  // DELEGATED to the ledger's converter rather than `Math.round(n * 100)`.
  // The float version is wrong on exactly the values that look safest:
  // `1.005 * 100` is 100.49999999999999 in IEEE 754, so it rounds DOWN to 100
  // and loses a cent. I wrote toCents() in US-2984 to avoid that and then
  // reintroduced it here; the test caught it. One converter, not three.
  const cents = toCents(s);
  if (cents === null || !Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * A date cell to yyyy-mm-dd.
 *
 * Accepts ISO and the two US forms banks use. AMBIGUITY IS RESOLVED AS US
 * MONTH-FIRST, because this is a US tax product -- but a day above 12 in the
 * first position is unambiguous and is read as day-first rather than rejected,
 * since that is a European export and reading it as a month would be nonsense.
 */
export function parseStatementDate(cell: string): string | null {
  const s = cell.trim();
  if (s === "") return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (slash) {
    let a = Number(slash[1]);
    let b = Number(slash[2]);
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    // First field above 12 can only be a day.
    if (a > 12 && b <= 12) {
      const t = a;
      a = b;
      b = t;
    }
    if (a < 1 || a > 12 || b < 1 || b > 31) return null;
    return `${year}-${String(a).padStart(2, "0")}-${String(b).padStart(2, "0")}`;
  }
  return null;
}

/**
 * A stable identity for one statement line (AC3).
 *
 * Date, amount and description -- the three things that do not change between
 * two exports of the same period. NOT the line number, which shifts the moment
 * the bank reorders or the seller widens the range, and NOT the import run,
 * which would duplicate every overlapping row.
 *
 * The description is normalised because banks pad and re-case them between
 * exports of the same transaction.
 */
export function fingerprint(
  postedOn: string,
  amountCents: number,
  description: string,
): string {
  const norm = description.toLowerCase().replace(/\s+/g, " ").trim();
  return `${postedOn}|${amountCents}|${norm}`;
}

/** Header guesses, so the first import is one click rather than four. */
const DATE_HINTS = ["date", "posted", "transaction date", "post date"];
const AMOUNT_HINTS = ["amount", "debit", "withdrawal", "value"];
const DESC_HINTS = ["description", "payee", "merchant", "name", "memo", "details"];

function bestHeader(headers: string[], hints: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase());
  for (const hint of hints) {
    const exact = lower.indexOf(hint);
    if (exact >= 0) return headers[exact] ?? null;
  }
  for (const hint of hints) {
    const partial = lower.findIndex((h) => h.includes(hint));
    if (partial >= 0) return headers[partial] ?? null;
  }
  return null;
}

export function guessColumnMap(headers: string[]): Partial<ColumnMap> {
  const date = bestHeader(headers, DATE_HINTS);
  const amount = bestHeader(headers, AMOUNT_HINTS);
  const description = bestHeader(headers, DESC_HINTS);
  const guess: Partial<ColumnMap> = {};
  if (date) guess.date = date;
  if (amount) guess.amount = amount;
  if (description) guess.description = description;

  // A file with both a Debit and a Credit column is the separate-columns shape,
  // and reading only one of them silently halves the import.
  const lower = headers.map((h) => h.toLowerCase());
  const debitAt = lower.findIndex((h) => h.includes("debit"));
  const creditAt = lower.findIndex((h) => h.includes("credit"));
  if (debitAt >= 0 && creditAt >= 0) {
    guess.sign = "separate_columns";
    guess.debitColumn = headers[debitAt];
    guess.creditColumn = headers[creditAt];
  } else {
    guess.sign = "negative_is_spend";
  }
  return guess;
}

/**
 * Parse a whole file.
 *
 * A malformed line is SKIPPED WITH A REASON rather than dropped or imported as
 * zero. A silent drop is how an import quietly misses the one transaction the
 * seller was looking for, and they have no way to know.
 */
export function parseStatementCsv(
  text: string,
  map: ColumnMap,
): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], skipped: [], headers: [] };

  const headers = splitCsvLine(lines[0] as string);
  const idx = (name: string | undefined) =>
    name === undefined ? -1 : headers.indexOf(name);

  const dateAt = idx(map.date);
  const descAt = idx(map.description);
  const amountAt = idx(map.amount);
  const debitAt = idx(map.debitColumn);
  const creditAt = idx(map.creditColumn);

  const rows: ParsedRow[] = [];
  const skipped: ParseResult["skipped"] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i] as string;
    const cells = splitCsvLine(raw);

    const postedOn = parseStatementDate(cells[dateAt] ?? "");
    if (!postedOn) {
      skipped.push({ line: i + 1, reason: "no readable date", raw });
      continue;
    }

    let amountCents: number | null = null;
    if (map.sign === "separate_columns") {
      const debit = parseMoney(cells[debitAt] ?? "");
      const credit = parseMoney(cells[creditAt] ?? "");
      if (debit !== null && debit !== 0) amountCents = -Math.abs(debit);
      else if (credit !== null && credit !== 0) amountCents = Math.abs(credit);
    } else {
      const v = parseMoney(cells[amountAt] ?? "");
      if (v !== null) {
        amountCents = map.sign === "positive_is_spend" ? -v : v;
      }
    }

    if (amountCents === null) {
      skipped.push({ line: i + 1, reason: "no readable amount", raw });
      continue;
    }
    if (amountCents === 0) {
      // A zero-value line is an authorisation hold or a header repeat. Not an
      // error, and not a transaction either.
      skipped.push({ line: i + 1, reason: "zero amount", raw });
      continue;
    }

    const description = (cells[descAt] ?? "").slice(0, 300);
    const fp = fingerprint(postedOn, amountCents, description);

    // A file can contain the same line twice -- some banks repeat a pending and
    // a posted row identically. The database would reject the second on the
    // unique index anyway; catching it here keeps the reported counts honest.
    if (seen.has(fp)) {
      skipped.push({ line: i + 1, reason: "duplicate of an earlier line", raw });
      continue;
    }
    seen.add(fp);

    rows.push({
      posted_on: postedOn,
      amount_cents: amountCents,
      description,
      row_fingerprint: fp,
    });
  }

  return { rows, skipped, headers };
}

/** Only money LEAVING is a candidate expense. A deposit is a refund or a payment. */
export function spendRows(rows: readonly ParsedRow[]): ParsedRow[] {
  return rows.filter((r) => r.amount_cents < 0);
}
