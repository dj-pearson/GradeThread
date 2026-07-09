// US-1775: State of Secondhand Durability report — pure ranking logic.
// durability-report.ts imports supabase at load, so prime env + dynamic-import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const { buildDurabilityReport } = await import("../lib/durability-report.ts");

function row(over: Record<string, unknown> = {}) {
  return {
    brand: "Brand",
    garment_count: 10,
    regraded_count: 4,
    avg_retention: 0.9,
    avg_overall_decay: 0.5,
    per_factor_decay: { fabric_condition_score: 0.6, structural_integrity_score: 0.2 },
    sufficient: true,
    ...over,
  };
}

Deno.test("report: ranks brands by retention, most + least durable", () => {
  const rows = [
    row({ brand: "Alpha", avg_retention: 0.95, avg_overall_decay: 0.3 }),
    row({ brand: "Beta", avg_retention: 0.7, avg_overall_decay: 1.5 }),
    row({ brand: "Gamma", avg_retention: 0.85, avg_overall_decay: 0.8 }),
  ];
  const r = buildDurabilityReport(rows, "2026-07-09T00:00:00Z");
  assertEquals(r.most_durable[0].brand, "Alpha");
  assertEquals(r.most_durable[0].retentionPct, 95);
  assertEquals(r.least_durable[0].brand, "Beta", "worst retention leads least_durable");
  assertEquals(r.sample.brands, 3);
});

Deno.test("report: insufficient cohorts are excluded from findings + brand count", () => {
  const rows = [
    row({ brand: "Solid", sufficient: true }),
    row({ brand: "Thin", sufficient: false, avg_retention: 0.99 }),
  ];
  const r = buildDurabilityReport(rows, "2026-07-09T00:00:00Z");
  assertEquals(r.sample.brands, 1);
  assertEquals(r.most_durable.length, 1);
  assertEquals(r.most_durable[0].brand, "Solid");
  assertEquals(r.sample.sufficient_cohorts, 1);
  assertEquals(r.sample.total_cohorts, 2);
});

Deno.test("report: weakest factors ranked by average decay, labeled", () => {
  const rows = [
    row({ per_factor_decay: { fabric_condition_score: 1.0, structural_integrity_score: 0.2 } }),
    row({ per_factor_decay: { fabric_condition_score: 0.8, structural_integrity_score: 0.4 } }),
  ];
  const r = buildDurabilityReport(rows, "2026-07-09T00:00:00Z");
  assertEquals(r.weakest_factors[0].factor, "fabric_condition_score", "fabric decays most");
  assertEquals(r.weakest_factors[0].avgDecay, 0.9); // mean(1.0, 0.8)
  assertEquals(r.weakest_factors[0].label, "Fabric");
});

Deno.test("report: empty data → empty findings, zero sample", () => {
  const r = buildDurabilityReport([], "2026-07-09T00:00:00Z");
  assertEquals(r.most_durable.length, 0);
  assertEquals(r.weakest_factors.length, 0);
  assertEquals(r.sample.brands, 0);
  assert(r.generated_at.length > 0);
});
