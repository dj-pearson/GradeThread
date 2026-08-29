import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SYSTEM_ACCOUNTS,
  CATEGORY_DEFAULT_ACCOUNT,
  accountByCode,
  resolveExpenseAccount,
  scheduleCTag,
  EXPENSE_ACCOUNTS,
  type LedgerAccount,
} from "./chart-of-accounts";
import { EXPENSE_CATEGORIES } from "@/lib/constants";

// US-2983.
//
// The database seeds the chart; this file mirrors it so a picker can show the
// IRS line without a round trip. A mirror with no guard is a second source of
// truth pretending to be a cache, so the first block here parses the migration
// and compares the two, field by field.
//
// fileURLToPath, not new URL(...).pathname — the latter is absolute on Windows
// and RELATIVE on Linux, which is a green-here red-in-CI trap this repo has
// been bitten by before.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "00684_ledger_accounts.sql",
);

/**
 * Pull the seeded rows out of the migration's INSERT ... VALUES block.
 *
 * Deliberately a real parse rather than a regex over the whole file: several
 * of the labels contain commas and parentheses ("Insurance (other than
 * health)"), and a naive split on those silently produces fewer columns, which
 * would make this guard pass against a chart it never actually compared.
 */
function parseSeededAccounts(sql: string): LedgerAccount[] {
  const start = sql.indexOf("INSERT INTO public.ledger_accounts");
  expect(start, "seed block not found in the migration").toBeGreaterThan(-1);
  const valuesAt = sql.indexOf("VALUES", start);
  const endAt = sql.indexOf("ON CONFLICT", valuesAt);
  expect(endAt, "seed block has no ON CONFLICT terminator").toBeGreaterThan(
    valuesAt,
  );
  const body = sql.slice(valuesAt + "VALUES".length, endAt);

  const rows: string[][] = [];
  let cols: string[] = [];
  let cur = "";
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (inStr) {
      // '' is an escaped quote inside a Postgres string literal.
      if (ch === "'" && body[i + 1] === "'") {
        cur += "'";
        i++;
        continue;
      }
      if (ch === "'") {
        inStr = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "-" && body[i + 1] === "-") {
      // A line comment. Skip to the newline; comments sit between rows.
      while (i < body.length && body[i] !== "\n") i++;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (depth === 1) {
        cols = [];
        cur = "";
        continue;
      }
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        cols.push(cur.trim());
        rows.push(cols);
        cur = "";
        continue;
      }
    }
    if (ch === "," && depth === 1) {
      cols.push(cur.trim());
      cur = "";
      continue;
    }
    if (depth >= 1) cur += ch;
  }

  const nullable = (v: string) => (v === "NULL" ? null : v);
  return rows.map((r) => ({
    code: r[0] as string,
    name: r[1] as string,
    flow: r[2] as LedgerAccount["flow"],
    schedule_c_part: nullable(r[3] as string),
    schedule_c_line: nullable(r[4] as string),
    schedule_c_label: nullable(r[5] as string),
    no_line_reason: nullable(r[6] as string),
    // r[7] is is_system, always true for the seed.
    sort_order: Number(r[8]),
  }));
}

describe("the TypeScript chart matches the seeded one", () => {
  const seeded = parseSeededAccounts(readFileSync(MIGRATION, "utf8"));

  it("parses a plausible number of rows, so a broken parse cannot pass quietly", () => {
    // The failure mode this guards: a parser that returns [] compares two empty
    // sets and reports agreement.
    expect(seeded.length).toBeGreaterThan(25);
    expect(seeded.length).toBe(SYSTEM_ACCOUNTS.length);
  });

  it("holds the same codes, in the same order", () => {
    expect(seeded.map((a) => a.code)).toEqual(
      SYSTEM_ACCOUNTS.map((a) => a.code),
    );
  });

  it("agrees field for field", () => {
    for (const sqlRow of seeded) {
      const tsRow = accountByCode(sqlRow.code);
      expect(tsRow, `${sqlRow.code} missing from the TS chart`).toBeDefined();
      expect({ ...sqlRow }).toEqual({ ...(tsRow as LedgerAccount) });
    }
  });

  it("agrees on the category defaults with the SQL function", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const fn = sql.slice(sql.indexOf("default_account_for_category"));
    for (const [category, code] of Object.entries(CATEGORY_DEFAULT_ACCOUNT)) {
      expect(
        fn,
        `default_account_for_category is missing ${category} -> ${code}`,
      ).toMatch(new RegExp(`'${category}'\\s*\\n?\\s*THEN\\s*'${code}'`));
    }
  });
});

describe("the chart itself", () => {
  it("gives every account a line or an explicit reason it has none", () => {
    // AC6. An unmapped account with no explanation is indistinguishable from a
    // forgotten one.
    for (const a of SYSTEM_ACCOUNTS) {
      if (a.schedule_c_line) continue;
      expect(
        a.no_line_reason,
        `${a.code} has no Schedule C line and no reason`,
      ).toBeTruthy();
      expect((a.no_line_reason as string).length).toBeGreaterThan(30);
    }
  });

  it("has unique codes", () => {
    const codes = SYSTEM_ACCOUNTS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives every line-bearing account the IRS wording, not only a number", () => {
    for (const a of SYSTEM_ACCOUNTS) {
      if (!a.schedule_c_line) continue;
      expect(a.schedule_c_part, `${a.code} has a line but no part`).toBeTruthy();
      expect(a.schedule_c_label, `${a.code} has a line but no label`).toBeTruthy();
    }
  });

  it("covers Schedule C Part III end to end, because COGS is where resellers lose money", () => {
    const cogsLines = SYSTEM_ACCOUNTS.filter((a) => a.flow === "cogs").map(
      (a) => a.schedule_c_line,
    );
    for (const line of ["35", "36", "37", "38", "39", "41"]) {
      expect(cogsLines, `Part III line ${line} has no account`).toContain(line);
    }
  });

  it("books facilitator sales tax as excluded, on no line at all", () => {
    const tax = accountByCode("sales_tax_collected");
    expect(tax?.flow).toBe("excluded");
    expect(tax?.schedule_c_line).toBeNull();
    // It has to say WHY, because a seller looking for it on their return needs
    // to know it was handled rather than lost.
    expect(tax?.no_line_reason).toMatch(/1099-K/);
  });
});

describe("resolving an expense to an account", () => {
  it("maps all eight existing categories to a real account", () => {
    for (const c of EXPENSE_CATEGORIES) {
      const account = resolveExpenseAccount(c, null);
      expect(account, `${c} resolves to nothing`).toBeDefined();
    }
  });

  it("sends 'other' somewhere with no line, rather than quietly onto 27a", () => {
    // AC3. An uncategorised dollar is what an accountant charges to sort out.
    const account = resolveExpenseAccount("other", null);
    expect(account?.code).toBe("uncategorised");
    expect(scheduleCTag(account)).toBeNull();
  });

  it("prefers the seller's explicit choice over the category default", () => {
    // The point of the override: one 'equipment' purchase small enough to
    // expense outright rather than depreciate.
    expect(resolveExpenseAccount("equipment", null)?.code).toBe("depreciation");
    expect(resolveExpenseAccount("equipment", "supplies")?.code).toBe("supplies");
  });

  it("falls back to undefined on an unknown code rather than inventing an account", () => {
    expect(resolveExpenseAccount("supplies" as never, "no_such_code")).toBeUndefined();
  });
});

describe("scheduleCTag", () => {
  it("reads the way the form does", () => {
    expect(scheduleCTag(accountByCode("platform_fees"))).toBe(
      "Line 10 (Commissions and fees)",
    );
    expect(scheduleCTag(accountByCode("rent_property"))).toBe(
      "Line 20b (Rent or lease -- other business property)",
    );
  });

  it("is null for an account with no line, and for nothing at all", () => {
    expect(scheduleCTag(accountByCode("uncategorised"))).toBeNull();
    expect(scheduleCTag(undefined)).toBeNull();
  });
});

describe("EXPENSE_ACCOUNTS", () => {
  it("offers expenses and vehicle, never income or COGS", () => {
    for (const a of EXPENSE_ACCOUNTS) {
      expect(["expense", "vehicle"]).toContain(a.flow);
    }
    expect(EXPENSE_ACCOUNTS.map((a) => a.code)).not.toContain("sales_revenue");
    expect(EXPENSE_ACCOUNTS.map((a) => a.code)).not.toContain("purchases");
  });

  it("stays in form order, so the picker reads down the Schedule C", () => {
    const orders = EXPENSE_ACCOUNTS.map((a) => a.sort_order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});
