// Minimal RFC 4180 CSV reader. Handles quoted fields with embedded
// commas, escaped quotes (""), and CRLF/LF line endings. eBay's exports
// are well-formed but include occasional UTF-8 BOMs which we strip.

export function parseCsv(input: string): string[][] {
  // Strip BOM
  let text = input.startsWith("﻿") ? input.slice(1) : input;
  // Normalize line endings — we still emit one row per logical line, so
  // newlines INSIDE quoted fields are preserved by the state machine below.
  text = text.replace(/\r\n/g, "\n");

  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      cell = "";
      row = [];
      continue;
    }
    cell += ch;
  }

  // Trailing cell (no terminal newline).
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

// Normalize a header cell to a comparable key: lowercase, alphanumeric only.
// Stable across capitalization, spaces, punctuation drift between eBay account
// types and export versions.
export function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
