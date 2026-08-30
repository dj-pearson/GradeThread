import { describe, it, expect } from "vitest";
import {
  splitCsvLine,
  parseMoney,
  parseStatementDate,
  fingerprint,
  guessColumnMap,
  parseStatementCsv,
  spendRows,
  type ColumnMap,
} from "./statement-import";

// US-2994. Every bank exports a differently shaped file and all the failure
// modes are in the parsing, so all of it is pure and none of it needs a
// database to reproduce.

const CHASE: ColumnMap = {
  date: "Transaction Date",
  amount: "Amount",
  description: "Description",
  sign: "negative_is_spend",
};

describe("splitCsvLine", () => {
  it("honours quotes, because bank descriptions are full of commas", () => {
    // A naive split(",") shifts every later column by one and reads the amount
    // out of the wrong field -- silently, with a plausible-looking number.
    expect(
      splitCsvLine('03/04/2026,"AMZN Mktp US*2K4L1, Seattle, WA",-24.99'),
    ).toEqual(["03/04/2026", "AMZN Mktp US*2K4L1, Seattle, WA", "-24.99"]);
  });

  it("handles a doubled quote inside a quoted field", () => {
    expect(splitCsvLine('a,"He said ""hi""",b')).toEqual([
      "a",
      'He said "hi"',
      "b",
    ]);
  });

  it("keeps empty cells rather than collapsing them", () => {
    // A dropped empty cell shifts every column after it.
    expect(splitCsvLine("a,,c")).toEqual(["a", "", "c"]);
    expect(splitCsvLine("a,b,")).toEqual(["a", "b", ""]);
  });
});

describe("parseMoney", () => {
  it("reads the shapes banks actually emit", () => {
    expect(parseMoney("-24.99")).toBe(-2499);
    expect(parseMoney("24.99")).toBe(2499);
    expect(parseMoney("$1,234.56")).toBe(123456);
    expect(parseMoney(" -1,000.00 ")).toBe(-100000);
  });

  it("reads accounting notation as negative", () => {
    // (24.99) is a debit on plenty of exports, and reading it as positive turns
    // a purchase into a deposit.
    expect(parseMoney("(24.99)")).toBe(-2499);
    expect(parseMoney("($1,234.56)")).toBe(-123456);
  });

  it("returns null rather than zero for anything unreadable", () => {
    // A zero would import as a real transaction worth nothing.
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("pending")).toBeNull();
    expect(parseMoney("--5")).toBeNull();
    expect(parseMoney(".")).toBeNull();
  });

  it("is exact on the cent", () => {
    for (const [text, cents] of [["0.07", 7], ["19.99", 1999], ["1.005", 101]] as const) {
      expect(parseMoney(text)).toBe(cents);
    }
  });
});

describe("parseStatementDate", () => {
  it("reads ISO", () => {
    expect(parseStatementDate("2026-03-04")).toBe("2026-03-04");
    expect(parseStatementDate("2026-03-04T10:00:00Z")).toBe("2026-03-04");
  });

  it("reads US month-first, which is the default for a US tax product", () => {
    expect(parseStatementDate("03/04/2026")).toBe("2026-03-04");
    expect(parseStatementDate("3/4/26")).toBe("2026-03-04");
  });

  it("reads an unambiguous day-first date rather than rejecting it", () => {
    // 25 cannot be a month. A European export is readable and refusing it
    // would drop the whole file.
    expect(parseStatementDate("25/03/2026")).toBe("2026-03-25");
  });

  it("returns null on nonsense rather than guessing", () => {
    expect(parseStatementDate("")).toBeNull();
    expect(parseStatementDate("Mar 4")).toBeNull();
    expect(parseStatementDate("13/13/2026")).toBeNull();
  });
});

describe("fingerprint", () => {
  it("is stable across two exports of the same transaction", () => {
    // Banks pad and re-case descriptions between exports of the same row.
    expect(fingerprint("2026-03-04", -2499, "AMZN  Mktp US")).toBe(
      fingerprint("2026-03-04", -2499, "amzn mktp us"),
    );
  });

  it("separates transactions that differ in any of the three", () => {
    const base = fingerprint("2026-03-04", -2499, "Uline");
    expect(fingerprint("2026-03-05", -2499, "Uline")).not.toBe(base);
    expect(fingerprint("2026-03-04", -2500, "Uline")).not.toBe(base);
    expect(fingerprint("2026-03-04", -2499, "Staples")).not.toBe(base);
  });
});

describe("guessColumnMap", () => {
  it("guesses a Chase-shaped header row", () => {
    const g = guessColumnMap([
      "Transaction Date",
      "Post Date",
      "Description",
      "Category",
      "Type",
      "Amount",
    ]);
    expect(g.date).toBe("Transaction Date");
    expect(g.description).toBe("Description");
    expect(g.amount).toBe("Amount");
    expect(g.sign).toBe("negative_is_spend");
  });

  it("detects the separate debit and credit shape", () => {
    // Reading only one of the two columns silently halves the import.
    const g = guessColumnMap(["Date", "Payee", "Debit", "Credit"]);
    expect(g.sign).toBe("separate_columns");
    expect(g.debitColumn).toBe("Debit");
    expect(g.creditColumn).toBe("Credit");
  });

  it("returns what it could not guess as absent, not as a wrong guess", () => {
    const g = guessColumnMap(["col1", "col2", "col3"]);
    expect(g.date).toBeUndefined();
    expect(g.amount).toBeUndefined();
  });
});

describe("parseStatementCsv", () => {
  const csv = [
    "Transaction Date,Description,Amount",
    '03/04/2026,"Uline, Pleasant Prairie",-124.99',
    "03/06/2026,GOODWILL #142,-47.83",
    "03/07/2026,PAYMENT THANK YOU,500.00",
  ].join("\n");

  it("reads every row and signs them from the statement", () => {
    const r = parseStatementCsv(csv, CHASE);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]?.amount_cents).toBe(-12499);
    expect(r.rows[0]?.description).toBe("Uline, Pleasant Prairie");
    // A deposit stays positive rather than being flattened -- a refund on a
    // card statement is a real row and making it look like a purchase is wrong.
    expect(r.rows[2]?.amount_cents).toBe(50000);
  });

  it("SKIPS a bad line with a reason rather than dropping it", () => {
    // A silent drop is how an import misses the one transaction the seller was
    // looking for, with no way for them to know.
    const bad = csv + "\nnot-a-date,SOMETHING,-10.00\n03/09/2026,NO AMOUNT,pending";
    const r = parseStatementCsv(bad, CHASE);
    expect(r.rows).toHaveLength(3);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0]?.reason).toBe("no readable date");
    expect(r.skipped[1]?.reason).toBe("no readable amount");
    // The raw line comes back, so the seller can see what was skipped.
    expect(r.skipped[0]?.raw).toContain("SOMETHING");
  });

  it("skips a zero-value line as neither an error nor a transaction", () => {
    const r = parseStatementCsv(csv + "\n03/08/2026,AUTH HOLD,0.00", CHASE);
    expect(r.skipped.some((s) => s.reason === "zero amount")).toBe(true);
  });

  it("catches a line repeated inside one file", () => {
    // Some banks emit a pending and a posted row identically. The unique index
    // would reject the second anyway; catching it here keeps the counts honest.
    const dupe = csv + "\n03/06/2026,GOODWILL #142,-47.83";
    const r = parseStatementCsv(dupe, CHASE);
    expect(r.rows).toHaveLength(3);
    expect(r.skipped.some((s) => s.reason === "duplicate of an earlier line")).toBe(
      true,
    );
  });

  it("produces the SAME fingerprints on a re-import, which is what AC3 turns on", () => {
    // Re-exporting an overlapping range is the normal case: sellers widen the
    // range to catch something they missed.
    const first = parseStatementCsv(csv, CHASE);
    const overlapping = [
      "Transaction Date,Description,Amount",
      "03/06/2026,GOODWILL #142,-47.83",
      "03/07/2026,PAYMENT THANK YOU,500.00",
      "03/11/2026,NEW ROW,-9.99",
    ].join("\n");
    const second = parseStatementCsv(overlapping, CHASE);

    const firstFps = new Set(first.rows.map((r) => r.row_fingerprint));
    const repeats = second.rows.filter((r) => firstFps.has(r.row_fingerprint));
    expect(repeats).toHaveLength(2);
    // And the genuinely new row is not one of them.
    expect(second.rows.filter((r) => !firstFps.has(r.row_fingerprint))).toHaveLength(1);
  });

  it("handles the separate debit and credit shape", () => {
    const map: ColumnMap = {
      date: "Date",
      amount: "",
      description: "Payee",
      sign: "separate_columns",
      debitColumn: "Debit",
      creditColumn: "Credit",
    };
    const r = parseStatementCsv(
      ["Date,Payee,Debit,Credit", "03/04/2026,Uline,124.99,", "03/07/2026,Refund,,50.00"].join("\n"),
      map,
    );
    expect(r.rows[0]?.amount_cents).toBe(-12499);
    // 50.00 is fifty dollars. A credit column stays positive.
    expect(r.rows[1]?.amount_cents).toBe(5000);
  });

  it("survives an empty file and a header-only file", () => {
    expect(parseStatementCsv("", CHASE).rows).toEqual([]);
    expect(parseStatementCsv("Transaction Date,Description,Amount", CHASE).rows).toEqual([]);
  });

  it("tolerates CRLF, which is what a Windows export has", () => {
    const crlf = csv.replace(/\n/g, "\r\n");
    expect(parseStatementCsv(crlf, CHASE).rows).toHaveLength(3);
  });
});

describe("spendRows", () => {
  it("keeps only money leaving", () => {
    const r = parseStatementCsv(
      [
        "Transaction Date,Description,Amount",
        "03/04/2026,Uline,-124.99",
        "03/07/2026,PAYMENT THANK YOU,500.00",
      ].join("\n"),
      CHASE,
    );
    const spend = spendRows(r.rows);
    expect(spend).toHaveLength(1);
    expect(spend[0]?.description).toBe("Uline");
  });
});
