// US-3193: the three cost columns migration 00770 added had no write path.
//
// The migration landed, sourcing-target.ts read the columns, and US-3194's
// offers page read them too — but nothing in the product could SET them. Every
// seller was therefore on the hardcoded DEFAULT_SOURCING_*_CENTS, and the
// story's promise that the figures are "stored on flipdesk_settings, not
// hardcoded in the ceiling" was true for nobody.
//
// This guards the write path itself, not just the arithmetic: the parser that
// turns a typed dollars string into the cents the column stores, the mirror of
// the edge's own defaults, and the fact that the settings component actually
// names all three columns in its select and its upsert. A component that saves
// two of the three would pass any test of the parser alone.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_SOURCING_COST_CENTS,
  MAX_SOURCING_COST_CENTS,
  SOURCING_COST_COLUMNS,
  SOURCING_COST_FIELDS,
  centsToCostInput,
  parseCostInput,
} from "@/components/flipdesk/sourcing-cost-fields";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("parseCostInput", () => {
  it("reads blank as null, which means 'use the default'", () => {
    // Blank is a real choice, the same one the target field already allows.
    // Coercing it to 0 would tell the ceiling this seller pays no postage.
    expect(parseCostInput("")).toEqual({ ok: true, cents: null });
    expect(parseCostInput("   ")).toEqual({ ok: true, cents: null });
  });

  it("reads dollars into whole cents", () => {
    expect(parseCostInput("8.30")).toEqual({ ok: true, cents: 830 });
    expect(parseCostInput("$10.60")).toEqual({ ok: true, cents: 1060 });
    expect(parseCostInput("2")).toEqual({ ok: true, cents: 200 });
  });

  it("honours a literal zero rather than treating it as unset", () => {
    // A seller who does not grade everything they source types 0 and must be
    // believed — sourcingCostsTotalCents honours it on the edge side too.
    expect(parseCostInput("0")).toEqual({ ok: true, cents: 0 });
  });

  it("rejects what the column's CHECK would reject", () => {
    // Migration 00770 bounds each column at 0..100000 cents. Letting the write
    // through would surface as a raw Postgres 23514 in a toast.
    expect(parseCostInput("-1").ok).toBe(false);
    expect(parseCostInput("1000.01").ok).toBe(false);
    expect(parseCostInput("eight dollars").ok).toBe(false);
    expect(parseCostInput("1e9").ok).toBe(false);
  });

  it("round-trips through the input string", () => {
    for (const cents of [0, 35, 200, 830, 1060, MAX_SOURCING_COST_CENTS]) {
      expect(parseCostInput(centsToCostInput(cents))).toEqual({ ok: true, cents });
    }
    expect(centsToCostInput(null)).toBe("");
  });
});

describe("the defaults shown on screen are the edge's own", () => {
  // The placeholder tells the seller what leaving a field blank buys them. If
  // it drifts from DEFAULT_SOURCING_*_CENTS the screen is describing a ceiling
  // nobody is getting.
  it("mirrors DEFAULT_SOURCING_*_CENTS in scout-decision.ts", () => {
    const src = read("services/edge-functions/src/lib/scout-decision.ts");
    const edge = (name: string): number => {
      const m = new RegExp(`export const ${name} = (\\d+);`).exec(src);
      if (!m) throw new Error(`${name} not found in scout-decision.ts`);
      return Number(m[1]);
    };
    expect(DEFAULT_SOURCING_COST_CENTS.shipping).toBe(
      edge("DEFAULT_SOURCING_SHIPPING_CENTS"),
    );
    expect(DEFAULT_SOURCING_COST_CENTS.supplies).toBe(
      edge("DEFAULT_SOURCING_SUPPLIES_CENTS"),
    );
    expect(DEFAULT_SOURCING_COST_CENTS.grading).toBe(
      edge("DEFAULT_SOURCING_GRADING_CENTS"),
    );
  });

  it("names the columns migration 00770 actually added", () => {
    const sql = read("supabase/migrations/00770_sourcing_cost_defaults.sql");
    for (const column of Object.values(SOURCING_COST_COLUMNS)) {
      expect(sql, `${column} must exist in 00770`).toContain(column);
    }
  });
});

describe("the settings component writes every column", () => {
  const src = read("src/components/flipdesk/sourcing-target-setting.tsx");

  it("selects and upserts all three cost columns", () => {
    for (const column of Object.values(SOURCING_COST_COLUMNS)) {
      expect(src, `${column} must be readable`).toContain(column);
    }
    // One upsert carrying every field, not three round trips: the row is one
    // row and a partial failure would leave the seller's costs half-saved.
    const upserts = src.match(/\.upsert\(/g) ?? [];
    expect(upserts.length).toBe(1);
  });

  it("renders its inputs from the shared field table", () => {
    // Rendered by mapping SOURCING_COST_FIELDS rather than by three hand-written
    // blocks, so adding a fourth cost line cannot leave one field unrendered.
    expect(src).toContain("SOURCING_COST_FIELDS");
    expect(src).toContain("parseCostInput");
    expect(src).toContain("centsToCostInput");
  });
});

describe("the field table itself", () => {
  it("covers every column with a unique input id and label", () => {
    expect(SOURCING_COST_FIELDS.map((f) => f.key).sort()).toEqual([
      "grading",
      "shipping",
      "supplies",
    ]);
    for (const field of SOURCING_COST_FIELDS) {
      expect(field.column).toBe(SOURCING_COST_COLUMNS[field.key]);
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.help.length).toBeGreaterThan(0);
    }
    expect(new Set(SOURCING_COST_FIELDS.map((f) => f.inputId)).size).toBe(3);
    expect(new Set(SOURCING_COST_FIELDS.map((f) => f.label)).size).toBe(3);
  });
});

describe("the settings card and the scan page share one cache key", () => {
  // Found 2026-09-10 while closing US-3193. scout.tsx read the standing target
  // under ["sourcing-target", id] while sourcing-target-setting.tsx reads AND
  // invalidates ["sourcing_target", id] — a hyphen against an underscore. So
  // saving a new target refreshed the card and left the scan page showing the
  // old number until a full reload, which is the worst shape of this bug: the
  // seller changed the figure, watched it save, and got priced off the one
  // they replaced.
  //
  // Pinned as source text because the two keys live in a component and a page
  // that cannot be rendered together in a unit test without a Supabase client.
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const KEY = /queryKey:\s*\["([a-z_-]*sourcing[a-z_-]*)",/g;

  it("uses the same string in both files", () => {
    const keys = new Set<string>();
    for (
      const file of [
        "src/pages/flipdesk/scout.tsx",
        "src/components/flipdesk/sourcing-target-setting.tsx",
      ]
    ) {
      const src = read(file);
      const found = [...src.matchAll(KEY)].map((m) => m[1]);
      expect(found.length, `no sourcing query key found in ${file}`)
        .toBeGreaterThan(0);
      for (const k of found) keys.add(k!);
    }
    expect([...keys]).toEqual(["sourcing_target"]);
  });

  it("invalidates the key it reads", () => {
    const src = read("src/components/flipdesk/sourcing-target-setting.tsx");
    const invalidated = [
      ...src.matchAll(/invalidateQueries\(\{\s*queryKey:\s*\["([a-z_-]*sourcing[a-z_-]*)",/g),
    ].map((m) => m[1]);
    expect(invalidated).toContain("sourcing_target");
  });
});
