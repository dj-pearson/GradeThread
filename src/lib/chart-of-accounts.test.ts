import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
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
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/**
 * EVERY migration that seeds the chart, in apply order.
 *
 * Not a fixed filename. 00684 seeded the chart and 00691 added an account to it
 * -- 00684 is applied in production and therefore immutable, so extending the
 * chart means a later migration, and the seed is an upsert keyed on `code`
 * precisely so that works. A guard pinned to one filename would have kept
 * passing while silently covering less of the chart with every addition, which
 * is the failure mode where a guard becomes decoration.
 */
function chartMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f))
    .filter((p) =>
      readFileSync(p, "utf8").includes("INSERT INTO public.ledger_accounts"),
    );
}

/** The chart as the migrations leave it: later rows upsert over earlier ones. */
function seededChart(): LedgerAccount[] {
  const byCode = new Map<string, LedgerAccount>();
  for (const file of chartMigrations()) {
    for (const row of parseSeededAccounts(readFileSync(file, "utf8"))) {
      byCode.set(row.code, row);
    }
  }
  // The database orders by sort_order; so does SYSTEM_ACCOUNTS.
  return [...byCode.values()].sort((a, b) => a.sort_order - b.sort_order);
}

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

/**
 * Drift between the two charts that a HELD migration already fixes.
 *
 * US-3256. The same shape as `KNOWN_GAPS` in scripts/migrations-lint.mjs, and
 * for the same reason: a migration that is written and verified but parked on a
 * branch awaiting an owner apply is a THIRD state, neither "agrees" nor "has
 * drifted". Without somewhere to say so there are only two moves, and both are
 * wrong -- leave the guard red, which is how it stops being read, or spell the
 * TypeScript side the way the bad seed does, which is what commit e321bdae4
 * did and which quietly made "Labour" the answer this repo stands behind.
 *
 * Each entry is checked in BOTH directions by the case below, so it cannot rot:
 * the drift it describes must still exist, and its migration must still be
 * absent. The branch that lands the migration deletes its own entry in the same
 * commit, exactly as the KNOWN_GAPS branches do.
 */
const HELD_SEED_CORRECTIONS = [
  {
    code: "cogs_labor",
    field: "name" as const,
    seed: "Labour that went into the goods",
    ts: "Labor that went into the goods",
    migration: "00797",
    branch: "held-v2/us-3256-00797",
    why:
      "Schedule C Part III line 37 is \"Cost of labor\". 00684 seeded the " +
      "British spelling; 00797 upserts the row to the US one.",
  },
] as const;

/**
 * True only for the EXACT pair of values a held correction names.
 *
 * Deliberately not "skip this field for this code": that would blind the guard
 * to any FUTURE drift on the same field, which is how an allowance turns into a
 * hole. A third value on either side is still reported.
 */
function isHeldCorrection(
  code: string,
  field: keyof LedgerAccount,
  seedValue: unknown,
  tsValue: unknown,
): boolean {
  return HELD_SEED_CORRECTIONS.some(
    (c) =>
      c.code === code &&
      c.field === field &&
      seedValue === c.seed &&
      tsValue === c.ts,
  );
}

describe("the TypeScript chart matches the seeded one", () => {
  const seeded = seededChart();

  it("reads every migration that seeds the chart, not just the first", () => {
    // 00684 seeds it and 00691 extends it. If this ever drops back to one file,
    // the guard is covering less of the chart than it claims to.
    const files = chartMigrations().map((p) => basename(p));
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files[0]).toMatch(/^00684_/);
  });

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

  it("agrees field for field, on every row and every field", () => {
    // US-3256. This used to `expect(...).toEqual(...)` INSIDE the loop, so the
    // first disagreeing row threw and every row behind it went uncompared.
    // `cogs_labor` sits at sort_order 220, the 8th of 33 system rows, so for as
    // long as it was red this guard reported nothing whatsoever about the other
    // 25. Collect every disagreement and assert the collection is empty, so one
    // bad row can never again hide the rest.
    const fields: (keyof LedgerAccount)[] = [
      "code",
      "name",
      "flow",
      "schedule_c_part",
      "schedule_c_line",
      "schedule_c_label",
      "no_line_reason",
      "sort_order",
    ];
    const drift: string[] = [];
    for (const sqlRow of seeded) {
      const tsRow = accountByCode(sqlRow.code);
      if (!tsRow) {
        drift.push(`${sqlRow.code}: missing from the TS chart`);
        continue;
      }
      for (const f of fields) {
        if (sqlRow[f] === tsRow[f]) continue;
        if (isHeldCorrection(sqlRow.code, f, sqlRow[f], tsRow[f])) continue;
        drift.push(
          `${sqlRow.code}.${f}: SQL ${JSON.stringify(sqlRow[f])} !== TS ${JSON.stringify(tsRow[f])}`,
        );
      }
    }
    expect(
      drift,
      `${drift.length} field(s) drifted:\n${drift.join("\n")}`,
    ).toEqual([]);
  });

  it("allows a held correction only while its migration is still held", () => {
    // Both directions, so the list cannot go stale either way.
    const files = readdirSync(MIGRATIONS_DIR);
    for (const c of HELD_SEED_CORRECTIONS) {
      // 1. The migration must still be ABSENT. When `${c.branch}` merges, this
      //    goes red and forces the entry out in the same commit.
      const landed = files.filter((f) => f.startsWith(`${c.migration}_`));
      expect(
        landed,
        `${c.migration} has landed (${landed.join(", ")}), so the ` +
          `HELD_SEED_CORRECTIONS entry for ${c.code}.${c.field} is stale and ` +
          `must be deleted -- the seed now says what the TS chart says.`,
      ).toEqual([]);

      // 2. The drift it describes must still be real. An entry excusing a
      //    disagreement that no longer exists is an allowance nothing needs.
      const sqlRow = seeded.find((r) => r.code === c.code);
      expect(sqlRow, `${c.code} is not in the seeded chart`).toBeDefined();
      expect(
        (sqlRow as LedgerAccount)[c.field],
        `${c.code}.${c.field} no longer reads ${JSON.stringify(c.seed)} in the seed`,
      ).toBe(c.seed);
      expect(
        accountByCode(c.code)?.[c.field],
        `${c.code}.${c.field} no longer reads ${JSON.stringify(c.ts)} in the TS chart`,
      ).toBe(c.ts);
    }
  });

  it("agrees on the category defaults with the SQL function", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, "00684_ledger_accounts.sql"), "utf8");
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
