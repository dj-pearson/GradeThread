// Money and Reconcile reads name the workspace on screen.
//
// RLS lets a workspace member read EVERY workspace they belong to, so a read on
// a multi-tenant table with no owner filter quietly mixes businesses: payouts
// from one matched against sales from another, one company's expenses summed
// into another's overhead, a photo cluster linked onto another tenant's item.
// RLS cannot catch it because every row returned is one the member may see.
//
// This scan finds every READ (a from() whose chain starts with select) of the
// listed tables in the listed files and requires `.eq("user_id"` in the same
// statement. A read that scopes some other way is declared below with the
// token that proves it, so a new unscoped read fails here until its author
// says how it is scoped.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

const FILES = [
  "src/pages/flipdesk/reconciliation.tsx",
  "src/hooks/use-payouts.ts",
  "src/components/flipdesk/ebay-sku-match.tsx",
  "src/pages/flipdesk/reconcile.tsx",
  "src/hooks/use-reconcile-commit.ts",
  "src/pages/flipdesk/expenses.tsx",
  "src/lib/finances-overhead.ts",
  "src/components/finances/month-close-checklist.tsx",
] as const;

const TABLES = [
  "sales",
  "payout_imports",
  "flipdesk_ebay_listings",
  "flipdesk_expenses",
  "items_full",
] as const;

/** Reads scoped by a check after the read rather than a filter in it. */
const DECLARED: Record<string, { token: string; why: string }> = {
  "src/hooks/use-reconcile-commit.ts:items_full": {
    token: "row.user_id !== workspaceOwnerId",
    why: "resolveItemId reads one item by id and refuses it by name when it belongs to another workspace",
  },
};

interface Read {
  file: string;
  table: string;
  statement: string;
}

function findReads(file: string, src: string): Read[] {
  const reads: Read[] = [];
  for (const table of TABLES) {
    const needle = `from("${table}")`;
    let at = src.indexOf(needle);
    while (at !== -1) {
      const rest = src.slice(at + needle.length);
      const end = rest.indexOf(";");
      const statement = end === -1 ? rest : rest.slice(0, end);
      if (/^\s*\.select\(/.test(statement)) reads.push({ file, table, statement });
      at = src.indexOf(needle, at + needle.length);
    }
  }
  return reads;
}

function isScoped(read: Read, src: string): boolean {
  if (read.statement.includes('.eq("user_id"')) return true;
  const declared = DECLARED[`${read.file}:${read.table}`];
  return !!declared && src.includes(declared.token);
}

describe("Money and Reconcile reads are scoped to the active workspace owner", () => {
  const all = FILES.map((file) => ({
    file,
    src: readFileSync(resolve(ROOT, file), "utf8"),
  }));

  it("finds the reads it was written against", () => {
    const count = all.flatMap(({ file, src }) => findReads(file, src)).length;
    // Seven reads across the seven files when this was written. A drop means
    // the scan stopped seeing them, not that they went away.
    expect(count).toBeGreaterThanOrEqual(7);
  });

  for (const file of FILES) {
    it(`${file}: every read carries an owner filter`, () => {
      const src = all.find((f) => f.file === file)!.src;
      const unscoped = findReads(file, src)
        .filter((r) => !isScoped(r, src))
        .map((r) => `${r.table}: ${r.statement.slice(0, 120)}`);
      expect(unscoped).toEqual([]);
    });
  }

  it("fails when an owner filter is removed", () => {
    const file = "src/pages/flipdesk/reconciliation.tsx";
    const src = all.find((f) => f.file === file)!.src;
    const sabotaged = src.replace('.eq("user_id", ownerId ?? "")', "");
    expect(sabotaged).not.toBe(src);
    const unscoped = findReads(file, sabotaged).filter((r) => !isScoped(r, sabotaged));
    expect(unscoped.length).toBe(1);
  });

  it("every declared exemption still matches its file", () => {
    for (const [key, { token }] of Object.entries(DECLARED)) {
      const file = key.slice(0, key.lastIndexOf(":"));
      expect(readFileSync(resolve(ROOT, file), "utf8"), key).toContain(token);
    }
  });
});
