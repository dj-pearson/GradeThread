// The Inventory advanced filter's field set.
//
// Two failures this pins, both of which look like nothing on a screenshot:
//
//   1. A field in the type and the evaluator but NOT in FILTER_FIELDS is a
//      working feature nobody can reach — the builder renders its dropdown from
//      that list alone. It used to live inside filter-builder.tsx where no test
//      could see it (US-3122 moved it).
//   2. A field the client evaluates and `flipdesk_filter_matches` does not is
//      worse than missing: the SQL falls through its CASE, the value reads NULL,
//      and an `eq` rule quietly matches zero rows. So every field named here
//      must also be named in the migration, which the case list below states
//      out loud and src/test/listing-page-sql-parity.test.ts proves against a
//      real database.

import { describe, it, expect } from "vitest";
import {
  FIELD_LABELS,
  FILTER_FIELDS,
  evalQuery,
  opsForField,
  type FilterField,
  type FilterOp,
  type FilterQuery,
} from "@/lib/item-filter";
import type { ItemListRow } from "@/lib/item-list-columns";

const rule = (field: FilterField, op: FilterOp, value: string): FilterQuery => ({
  combinator: "and",
  rules: [{ id: "r1", field, op, value }],
});

/** Only the columns the rules below read; the rest never reaches evalRule. */
function row(sourcedBy: string | null): ItemListRow {
  return { id: "i1", sourced_by: sourcedBy } as unknown as ItemListRow;
}

describe("FILTER_FIELDS", () => {
  it("offers every field the filter knows about", () => {
    const labelled = Object.keys(FIELD_LABELS) as FilterField[];
    expect([...FILTER_FIELDS].sort()).toEqual([...labelled].sort());
  });

  it("names no field twice", () => {
    expect(new Set(FILTER_FIELDS).size).toBe(FILTER_FIELDS.length);
  });

  it("keeps 'Sourced by' next to 'Source', since the words collide", () => {
    const i = FILTER_FIELDS.indexOf("source");
    expect(FILTER_FIELDS[i + 1]).toBe("sourced_by");
    expect(FIELD_LABELS.source).toBe("Source");
    expect(FIELD_LABELS.sourced_by).toBe("Sourced by");
  });
});

describe("filtering by who sourced the item (US-3122)", () => {
  it("is a text field, so it takes the text operators", () => {
    expect(opsForField("sourced_by")).toEqual([
      "eq",
      "neq",
      "contains",
      "in",
      "nin",
      "isnull",
      "notnull",
    ]);
  });

  it("matches the name, ignoring case", () => {
    expect(evalQuery(row("Dan"), rule("sourced_by", "eq", "dan"))).toBe(true);
    expect(evalQuery(row("Dan"), rule("sourced_by", "eq", "sam"))).toBe(false);
    expect(evalQuery(row("Dan"), rule("sourced_by", "neq", "sam"))).toBe(true);
  });

  it("reads a list, which is how a seller asks for two people at once", () => {
    const q = rule("sourced_by", "in", "dan, sam");
    expect(evalQuery(row("Sam"), q)).toBe(true);
    expect(evalQuery(row("Alex"), q)).toBe(false);
    // A row with nobody recorded is "not in" the list — the same asymmetry
    // every other text field has, stated here so it is not read as a bug.
    expect(evalQuery(row(null), rule("sourced_by", "nin", "dan"))).toBe(true);
  });

  it("finds the items nobody is credited with", () => {
    expect(evalQuery(row(null), rule("sourced_by", "isnull", ""))).toBe(true);
    expect(evalQuery(row(""), rule("sourced_by", "isnull", ""))).toBe(true);
    expect(evalQuery(row("Dan"), rule("sourced_by", "isnull", ""))).toBe(false);
    expect(evalQuery(row("Dan"), rule("sourced_by", "notnull", ""))).toBe(true);
  });

  it("does not answer with the SOURCE — they are different questions", () => {
    const it = {
      id: "i1",
      sourced_by: "Dan",
      source_name: "Goodwill Bins",
    } as unknown as ItemListRow;
    expect(evalQuery(it, rule("source", "eq", "Dan"))).toBe(false);
    expect(evalQuery(it, rule("sourced_by", "eq", "Goodwill Bins"))).toBe(false);
    expect(evalQuery(it, rule("source", "eq", "goodwill bins"))).toBe(true);
  });
});
