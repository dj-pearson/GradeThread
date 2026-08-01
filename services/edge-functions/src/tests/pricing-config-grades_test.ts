// US-885: grading-tier + credit-pack pricing moved into the DB (pricing_config).
//
// These tests assert (1) the migration's seeded rows EXACTLY match the legacy
// compiled constants — so nothing changes on launch (AC#2 parity), (2) the
// per-period included-cap resolver is non-retroactive (AC#5), (3) the credit-pack
// upsell picker, and (4) the admin pricing validator. Pure + file reads only (the
// deno test task runs with --allow-read), no DB fixture.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  CREDIT_PACKS,
  GRADE_TIERS,
  resolveIncludedCap,
  suggestPackFrom,
  TIER_CREDIT_COST,
  TIER_PRICE_CENTS,
  TIER_SLA_HOURS,
} from "../lib/grade-pricing.ts";
import { validatePricingBody } from "../routes/admin-config.ts";

// ── AC#2: seed parity — the SQL seed must equal the legacy constants ──

// Parse the `insert into public.pricing_config ... values (...)` rows out of the
// migration so a future edit to the seed that drifts from the constants fails CI.
function readSeedRows(): string[][] {
  const sql = Deno.readTextFileSync(
    new URL("../../../../supabase/migrations/00209_pricing_config.sql", import.meta.url),
  );
  const start = sql.indexOf("insert into public.pricing_config");
  assert(start >= 0, "seed insert not found in migration");
  const valuesIdx = sql.indexOf("values", start);
  const end = sql.indexOf("on conflict", valuesIdx);
  const block = sql.slice(valuesIdx + "values".length, end);
  // Each row is a (...) tuple. Split on "),\n" boundaries, strip parens.
  return block
    .split(/\)\s*,/)
    .map((chunk) => chunk.replace(/[()]/g, "").trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) =>
      chunk
        .split(",")
        .map((cell) => cell.trim().replace(/^'|'$/g, ""))
    );
}

// Column order in the seed:
// id, kind, sort_order, label, price_cents, tier_key, credit_cost, sla_hours, credits, stripe_price_ref
Deno.test("pricing_config seed matches legacy grade-tier constants", () => {
  const rows = readSeedRows();
  const tierRows = rows.filter((r) => r[1] === "grade_tier");
  assertEquals(tierRows.length, GRADE_TIERS.length, "one seed row per grade tier");

  for (const r of tierRows) {
    const tier = r[5] as (typeof GRADE_TIERS)[number];
    assert(GRADE_TIERS.includes(tier), `unknown tier_key ${tier}`);
    assertEquals(Number(r[4]), TIER_PRICE_CENTS[tier], `${tier} price_cents`);
    assertEquals(Number(r[6]), TIER_CREDIT_COST[tier], `${tier} credit_cost`);
    assertEquals(Number(r[7]), TIER_SLA_HOURS[tier], `${tier} sla_hours`);
  }
});

Deno.test("pricing_config seed matches legacy credit-pack constants", () => {
  const rows = readSeedRows();
  const packRows = rows
    .filter((r) => r[1] === "credit_pack")
    .map((r) => ({ credits: Number(r[8]), priceCents: Number(r[4]) }))
    .sort((a, b) => a.credits - b.credits);

  const expected = [...CREDIT_PACKS].sort((a, b) => a.credits - b.credits);
  assertEquals(packRows.length, expected.length, "one seed row per credit pack");
  packRows.forEach((p, i) => {
    assertEquals(p.credits, expected[i].credits, `pack ${i} credits`);
    assertEquals(p.priceCents, expected[i].priceCents, `pack ${i} price_cents`);
  });
});

// ── AC#5: included-cap resolution is non-retroactive ──

Deno.test("resolveIncludedCap: within a period the snapshot governs (raise is not retroactive)", () => {
  // Period started at cap 3; admin RAISED the live cap to 5 mid-cycle. The user
  // keeps 3 for the current period.
  assertEquals(resolveIncludedCap(3, 5, false), 3);
  // Admin LOWERED the live cap to 2 mid-cycle — still 3 this period.
  assertEquals(resolveIncludedCap(3, 2, false), 3);
});

Deno.test("resolveIncludedCap: a new period (rollover) adopts the live cap", () => {
  assertEquals(resolveIncludedCap(3, 5, true), 5);
  assertEquals(resolveIncludedCap(3, 2, true), 2);
});

Deno.test("resolveIncludedCap: a null snapshot falls back to the live cap", () => {
  assertEquals(resolveIncludedCap(null, 7, false), 7);
  assertEquals(resolveIncludedCap(undefined, 7, false), 7);
});

// ── credit-pack upsell picker ──

Deno.test("suggestPackFrom picks the smallest pack that covers the credit cost", () => {
  const packs = [...CREDIT_PACKS];
  assertEquals(suggestPackFrom(packs, 1)?.credits, 10);
  assertEquals(suggestPackFrom(packs, 10)?.credits, 10);
  assertEquals(suggestPackFrom(packs, 11)?.credits, 25);
  assertEquals(suggestPackFrom(packs, 60)?.credits, 100);
  // Beyond the largest → falls back to the largest pack.
  assertEquals(suggestPackFrom(packs, 1000)?.credits, 100);
  // Empty list → null.
  assertEquals(suggestPackFrom([], 5), null);
});

// ── admin pricing validator ──

Deno.test("validatePricingBody accepts a well-formed grade-tier edit", () => {
  const res = validatePricingBody("grade_tier", {
    label: "Standard",
    price_cents: 349,
    credit_cost: 1,
    sla_hours: 36,
  });
  assert(res.ok);
  if (res.ok) {
    assertEquals(res.value.price_cents, 349);
    assertEquals(res.value.sla_hours, 36);
  }
});

Deno.test("validatePricingBody accepts a well-formed credit-pack edit", () => {
  const res = validatePricingBody("credit_pack", { credits: 30, price_cents: 6999 });
  assert(res.ok);
  if (res.ok) assertEquals(res.value.credits, 30);
});

Deno.test("validatePricingBody rejects bad values + empty edits", () => {
  assert(!validatePricingBody("grade_tier", { price_cents: -1 }).ok);
  assert(!validatePricingBody("grade_tier", { credit_cost: -1 }).ok);
  assert(!validatePricingBody("credit_pack", { credits: 0 }).ok);
  assert(!validatePricingBody("grade_tier", {}).ok);
  // Pack edits ignore tier-only fields (no credit_cost path) — an edit with only
  // a tier field on a pack is therefore empty → rejected.
  assert(!validatePricingBody("credit_pack", { credit_cost: 3 }).ok);
});
