// US-2235 AC1: filtering must not become the way k-anonymity gets broken.
//
// Narrowing a cohort until one person is left, then reading their numbers off
// the "aggregate", is the textbook attack on an anonymized benchmark. 00569
// defends against it structurally rather than with a new check: the filters
// apply to the BASE row set, so every existing `sellers >= min_sellers` guard
// re-evaluates against the filtered cohort and returns nulls.
//
// That defence is invisible in the SQL unless you know to look for it, and it
// is one WHERE-clause move away from being gone — a filter pushed down into the
// output projection would leave all fifteen guards counting the unfiltered
// population, and the function would hand back a cohort of one while still
// looking correct. Nothing else in this repo would notice: the RPC returns
// well-formed JSON either way, and the DB verify lane only proves the SQL
// applies.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = join(
  process.cwd(),
  "supabase",
  "migrations",
  "00569_community_benchmarks_filters.sql",
);
const sql = readFileSync(MIGRATION, "utf8").split("\r\n").join("\n");

const FILTER_PARAMS = ["p_brand", "p_category", "p_size", "p_price_min", "p_price_max"];

describe("US-2235: community_benchmarks filters cannot weaken k-anonymity", () => {
  it("applies every filter inside the base CTE, before any aggregate", () => {
    const baseStart = sql.indexOf("base as (");
    const hitsStart = sql.indexOf("hits as (");
    expect(baseStart, "the base CTE moved or was renamed").toBeGreaterThan(-1);
    expect(hitsStart).toBeGreaterThan(baseStart);
    const base = sql.slice(baseStart, hitsStart);

    for (const p of FILTER_PARAMS) {
      expect(
        base.includes(p),
        `${p} must be applied in the base CTE. Applied anywhere later, the ` +
          `sellers >= min_sellers guards would count the UNFILTERED population ` +
          `and a filter isolating one seller would return their numbers.`,
      ).toBe(true);
    }
  });

  it("uses no filter parameter after the base CTE", () => {
    // A second use downstream is the shape that quietly re-widens or re-narrows
    // one branch only. The filters have exactly one home, plus the meta echo.
    const baseEnd = sql.indexOf("hits as (");
    const metaEcho = sql.indexOf("'filters', jsonb_build_object");
    expect(metaEcho).toBeGreaterThan(baseEnd);

    const middle = sql.slice(baseEnd, metaEcho);
    for (const p of FILTER_PARAMS) {
      expect(
        middle.includes(p),
        `${p} is used between the base CTE and the meta echo — the filters must ` +
          `narrow the row set once and never again.`,
      ).toBe(false);
    }
  });

  it("keeps the hard-clamped floor of 5", () => {
    // An operator may RAISE the threshold through system_settings; the SQL
    // clamp is what stops a misconfiguration lowering it below the published
    // guarantee. Losing the greatest(5, …) would make the setting a foot-gun.
    expect(sql).toMatch(/greatest\(\s*\n?\s*5,/);
  });

  it("nulls a coverage count that is itself below the floor", () => {
    // Publishing "3 sellers" next to a screen full of nulls leaks the one fact
    // the nulls exist to withhold.
    const coverage = sql.slice(sql.indexOf("'coverage', ("), sql.indexOf("'topBrands'"));
    expect(coverage).toContain("cohort_sellers >= (select min_sellers from cfg)");
    expect(coverage).toContain("total_sellers >= (select min_sellers from cfg)");
  });

  it("drops the old one-argument signature instead of overloading it", () => {
    // Two functions both accepting a single named p_period_start would make
    // every existing PostgREST call ambiguous — at runtime, in production.
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.community_benchmarks(date);");
    const createCount =
      sql.match(/create or replace function public\.community_benchmarks\(/g)?.length ?? 0;
    expect(createCount, "exactly one function should be created").toBe(1);
  });

  it("grants execute on the NEW signature, to authenticated and service_role only", () => {
    // A grant left on the dropped arity grants nothing, and the new function
    // would then be callable by nobody. anon must never appear.
    const sig = "public.community_benchmarks(date, text, text, text, numeric, numeric)";
    expect(sql).toContain(`grant execute on function\n  ${sig}\n  to authenticated;`);
    expect(sql).toContain(`grant execute on function\n  ${sig}\n  to service_role;`);
    expect(sql).not.toMatch(/to anon\b/);
  });
});
