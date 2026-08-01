// US-587: the admin pricing editor must validate every field before it touches
// the DB, and the loader's fallback matrix must stay aligned with the gate-flag
// shape the SPA + plan-gate expect. Pure imports only (validator + constants),
// so no DB fixture is needed.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { validateBody } from "../routes/admin-pricing.ts";
import { FALLBACK_MATRIX, GATE_FLAG_KEYS } from "../lib/pricing-config.ts";

const fullGateFlags = () =>
  Object.fromEntries(GATE_FLAG_KEYS.map((k) => [k, false]));

Deno.test("validateBody accepts a complete, well-formed plan edit", () => {
  const res = validateBody({
    name: "Pro",
    price_monthly_cents: 5900,
    price_yearly_cents: 59000,
    active_listing_cap: -1, // unlimited sentinel allowed
    ai_actions_per_month: 1000,
    marketplaces_cap: -1,
    included_standard_grades_per_month: 30,
    team_seat_cap: 0,
    features: ["a", "b"],
    gate_flags: { ...fullGateFlags(), bulkActions: true },
    stripe_price_monthly: "price_123",
    stripe_price_yearly: "",
  });
  assert(res.ok);
  if (res.ok) {
    assertEquals(res.value.update.price_monthly_cents, 5900);
    assertEquals((res.value.update.gate_flags as Record<string, boolean>).bulkActions, true);
  }
});

Deno.test("validateBody rejects negative price + bad caps + non-string features", () => {
  assert(!validateBody({ price_monthly_cents: -1 }).ok);
  // active_listing_cap < -1 is invalid.
  assert(!validateBody({ active_listing_cap: -2 }).ok);
  // included grades can't use the -1 sentinel.
  assert(!validateBody({ included_standard_grades_per_month: -1 }).ok);
  assert(!validateBody({ features: [1, 2, 3] }).ok);
  assert(!validateBody({ name: "" }).ok);
});

Deno.test("validateBody requires every gate flag to be a boolean", () => {
  // Missing one key.
  const partial = { ...fullGateFlags() } as Record<string, unknown>;
  delete partial.autolister;
  assert(!validateBody({ gate_flags: partial }).ok);
  // Non-boolean value.
  assert(!validateBody({ gate_flags: { ...fullGateFlags(), apiAccess: "yes" } }).ok);
});

Deno.test("validateBody rejects an empty edit (no fields)", () => {
  assert(!validateBody({}).ok);
});

Deno.test("FALLBACK_MATRIX covers all four tiers with the full gate-flag shape", () => {
  for (const plan of ["free", "starter", "pro", "business"] as const) {
    const cfg = FALLBACK_MATRIX[plan];
    for (const k of GATE_FLAG_KEYS) {
      assertEquals(typeof cfg.gateFlags[k], "boolean", `${plan}.${k} missing`);
    }
  }
  assertEquals(GATE_FLAG_KEYS.length, 9);
});
