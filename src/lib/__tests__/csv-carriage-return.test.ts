import { describe, it, expect } from "vitest";
import { escapeCsvCell } from "@/lib/items-csv";

// US-3253. escapeCsvCell quoted on a comma, a double quote and a newline, and
// not on a carriage return.
//
// A Windows-pasted value carries CRLF and was already caught, because CRLF
// contains a newline. A LONE CR was not: the cell went out unquoted with a raw
// CR inside it, and Excel treats a bare CR as a row terminator. The row split
// at that point and every column after it shifted by one for the rest of the
// file.
//
// This escaper is behind the inventory export, the sales and financials export
// used for bookkeeping, and the Schedule C tax packet, and the values it
// handles are marketplace titles, buyer usernames and free-text notes -- which
// is exactly where a stray CR arrives from.

const CR = "\r";
const LF = "\n";

describe("a line break inside a cell cannot split the row (US-3253)", () => {
  it("quotes a lone carriage return", () => {
    const out = escapeCsvCell(`Nike Tee${CR}Size L`);
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    expect(out).toContain(CR);
  });

  it("still quotes CRLF, which already worked", () => {
    // The regression risk in this change: CRLF was caught via the newline, and
    // must stay caught.
    const out = escapeCsvCell(`Nike Tee${CR}${LF}Size L`);
    expect(out.startsWith('"')).toBe(true);
  });

  it("still quotes a lone newline", () => {
    expect(escapeCsvCell(`a${LF}b`).startsWith('"')).toBe(true);
  });

  it("leaves a clean value unquoted", () => {
    // The un-quoted path is deliberate -- it keeps the file readable when
    // opened in Excel -- so the fix must not widen into quoting everything.
    expect(escapeCsvCell("Nike Tee Size L")).toBe("Nike Tee Size L");
    expect(escapeCsvCell(42)).toBe("42");
  });

  it("still quotes and doubles an embedded quote", () => {
    expect(escapeCsvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("still neutralizes a formula without breaking the CR rule", () => {
    // Formula injection (US-1636) and this quoting rule are separate passes and
    // both have to survive a value that trips both.
    const out = escapeCsvCell(`=cmd|calc${CR}x`);
    expect(out).toContain("'=cmd");
    expect(out.startsWith('"')).toBe(true);
  });
});
