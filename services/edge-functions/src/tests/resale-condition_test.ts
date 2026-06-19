// US-976: unit tests for the public "State of Resale Condition" aggregation.
//
// buildResaleConditionReport is pure. resale-condition.ts imports the
// service-role supabase client at load, so set dummy env BEFORE the dynamic
// import (mirrors calibration_test.ts).
//
//   deno test --allow-env src/tests/resale-condition_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildResaleConditionReport, bandForGrade } = await import(
  "../lib/resale-condition.ts"
);
type Row = Parameters<typeof buildResaleConditionReport>[0][number];

function row(p: Partial<Row>): Row {
  return {
    grade_value: null,
    sale_status: null,
    sale_date: null,
    sold_at_raw: null,
    list_date: null,
    days_to_sell: null,
    sale_price: null,
    ...p,
  };
}

Deno.test("bandForGrade buckets the 1.0–10.0 scale", () => {
  assertEquals(bandForGrade(null), "ungraded");
  assertEquals(bandForGrade(3), "low");
  assertEquals(bandForGrade(6), "low");
  assertEquals(bandForGrade(6.5), "mid");
  assertEquals(bandForGrade(8), "mid");
  assertEquals(bandForGrade(8.5), "high");
  assertEquals(bandForGrade(10), "high");
});

Deno.test("empty input → zeroed bands, all rates null", () => {
  const r = buildResaleConditionReport([], 25);
  assertEquals(r.sample.fulfilled_sales, 0);
  assertEquals(r.bands.length, 4);
  for (const b of r.bands) {
    assertEquals(b.return_rate, null);
    assertEquals(b.sell_through, null);
    assertEquals(b.median_sale_price, null);
  }
  assertEquals(r.return_rollup.overall.return_rate, null);
  assertEquals(r.coverage.sales_from, null);
});

Deno.test("rates are sample-gated below the minimum", () => {
  // 5 high-grade fulfilled sales, 1 refunded — below a min sample of 10.
  const rows = [
    ...Array.from({ length: 4 }, () => row({ grade_value: 9, sale_status: "completed" })),
    row({ grade_value: 9, sale_status: "refunded" }),
  ];
  const gated = buildResaleConditionReport(rows, 10);
  const high = gated.bands.find((b) => b.key === "high")!;
  assertEquals(high.fulfilled_sales, 5);
  assertEquals(high.returns, 1);
  assertEquals(high.return_rate, null); // 5 < 10 → withheld

  const open = buildResaleConditionReport(rows, 5);
  assertEquals(open.bands.find((b) => b.key === "high")!.return_rate, 1 / 5);
});

Deno.test("return rate + value computed per band; rollups reconcile", () => {
  const rows: Row[] = [];
  // 10 high-grade fulfilled, 1 refunded; priced + sold for value/sell-through.
  for (let i = 0; i < 10; i++) {
    rows.push(
      row({
        grade_value: 9,
        sale_status: i === 0 ? "refunded" : "completed",
        sale_date: "2026-03-01",
        list_date: "2026-02-01",
        days_to_sell: 10 + i,
        sale_price: 100 + i,
      }),
    );
  }
  // 10 ungraded fulfilled, 4 refunded (higher return rate, lower value).
  for (let i = 0; i < 10; i++) {
    rows.push(
      row({
        grade_value: null,
        sale_status: i < 4 ? "refunded" : "completed",
        sale_date: "2026-04-01",
        list_date: "2026-01-15",
        days_to_sell: 30 + i,
        sale_price: 40 + i,
      }),
    );
  }

  const r = buildResaleConditionReport(rows, 5);
  const high = r.bands.find((b) => b.key === "high")!;
  const ungraded = r.bands.find((b) => b.key === "ungraded")!;

  assertEquals(high.return_rate, 1 / 10);
  assertEquals(ungraded.return_rate, 4 / 10);
  // Lower-condition items return MORE often — the headline finding.
  assert((ungraded.return_rate ?? 0) > (high.return_rate ?? 0));
  // Higher-condition items sell for MORE.
  assert((high.median_sale_price ?? 0) > (ungraded.median_sale_price ?? 0));
  assertEquals(high.sell_through, 1); // all 10 listed + sold

  // Rollups reconcile with the bands.
  assertEquals(r.return_rollup.graded.fulfilled_sales, 10);
  assertEquals(r.return_rollup.ungraded.fulfilled_sales, 10);
  assertEquals(r.return_rollup.overall.fulfilled_sales, 20);
  assertEquals(r.return_rollup.overall.returns, 5);

  // Coverage spans every recorded sale/listing date.
  assertEquals(r.coverage.sales_from, "2026-03-01");
  assertEquals(r.coverage.sales_to, "2026-04-01");
  assertEquals(r.coverage.listings_from, "2026-01-15");
});
