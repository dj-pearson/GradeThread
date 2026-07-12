// US-1924 regression guard: user-facing default date fields in the FlipDesk
// record-entry surfaces must default via todayLocalDate() (local calendar day),
// never `new Date().toISOString().slice(0,10)` / `.split("T")[0]` (UTC date).
//
// The bug: a sale/purchase/expense entered at, say, 23:00 local on Dec 31 in a
// timezone west of UTC gets a UTC date of Jan 1 next year, so the Tax-P&L export
// (which filters on the LOCAL `${year}-01-01..${year}-12-31`) buckets it into the
// wrong tax year and drops it from that year's reconciliation. See US-1636 /
// src/lib/local-date.ts.
//
// This scans only the record-entry files (not CSV filenames or analytics date
// ranges, which legitimately use UTC-derived strings) so it can't false-positive.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Files whose date-field defaults feed persisted records and must be local-date.
const RECORD_ENTRY_FILES = [
  "src/components/flipdesk/record-sale-dialog.tsx",
  "src/components/flipdesk/mark-listed-dialog.tsx",
  "src/components/flipdesk/bulk-intake.tsx",
  "src/components/flipdesk/snap-catalog.tsx",
  "src/pages/flipdesk/intake.tsx",
  "src/pages/flipdesk/expenses.tsx",
];

// UTC-date derivations that must not be used as a default record date.
const FORBIDDEN = /\.toISOString\(\)\s*\.\s*(?:slice\(\s*0\s*,\s*10\s*\)|split\(\s*["']T["']\s*\)\s*\[\s*0\s*\])/;

describe("FlipDesk record-entry date defaults are local-date (US-1924)", () => {
  for (const rel of RECORD_ENTRY_FILES) {
    it(`${rel} uses no UTC toISOString() date default`, () => {
      const src = readFileSync(path.join(root, rel), "utf8");
      expect(
        FORBIDDEN.test(src),
        `${rel}: use todayLocalDate() from @/lib/local-date for the default date, ` +
          `not new Date().toISOString().slice(0,10) (UTC) — mis-buckets the tax year.`,
      ).toBe(false);
    });
  }
});
