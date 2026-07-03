// US-150 — price-drop/promo scheduler validation + evaluation math.
// automation-rules.ts is pure (no DB/network), imported directly.
import { assert, assertEquals } from "@std/assert";
import {
  type AutomationFacts,
  computeFloorCents,
  DEFAULT_COOLDOWN_DAYS,
  DEFAULT_MARGIN_FLOOR_PCT,
  isCooledDown,
  normalizeAutomationInput,
  planAction,
  scopeMatches,
  triggerMatches,
} from "../lib/automation-rules.ts";

function facts(overrides: Partial<AutomationFacts> = {}): AutomationFacts {
  return {
    ageDays: 0,
    views: 0,
    watchers: 0,
    brand: null,
    category: null,
    size: null,
    sourceName: null,
    cost: null,
    targetPrice: null,
    status: null,
    grade: null,
    daysInStatus: null,
    ...overrides,
  };
}

// ── normalizeAutomationInput ────────────────────────────────────────

Deno.test("normalize requires a name and a valid trigger + action", () => {
  assert(!normalizeAutomationInput({}).ok);
  assert(
    !normalizeAutomationInput({
      name: "Drop",
      trigger_json: { type: "bogus" },
      action_json: { type: "price_drop_pct", pct: 10 },
    }).ok,
  );
  assert(
    !normalizeAutomationInput({
      name: "Drop",
      trigger_json: { type: "days_listed_gt", days: 30 },
      action_json: { type: "price_drop_pct", pct: 0 },
    }).ok,
  );
});

Deno.test("normalize fills trigger/action defaults", () => {
  const r = normalizeAutomationInput({
    name: "Stale markdown",
    trigger_json: { type: "days_listed_gt", days: 30 },
    action_json: { type: "price_drop_pct", pct: 10 },
  });
  assert(r.ok);
  assertEquals(r.value.trigger_json, {
    type: "days_listed_gt",
    days: 30,
    cooldown_days: DEFAULT_COOLDOWN_DAYS,
  });
  assertEquals(r.value.action_json, {
    type: "price_drop_pct",
    pct: 10,
    margin_floor_pct: DEFAULT_MARGIN_FLOOR_PCT,
  });
  assertEquals(r.value.scope_json, { type: "all" });
  assertEquals(r.value.is_active, true);
});

Deno.test("normalize rejects bad scope fields/ops, accepts a filter scope", () => {
  const base = {
    name: "Scoped",
    trigger_json: { type: "days_listed_gt", days: 30 },
    action_json: { type: "end_listing" },
  };
  assert(
    !normalizeAutomationInput({
      ...base,
      scope_json: { type: "filter", combinator: "and", rules: [{ field: "nope", op: "eq", value: "x" }] },
    }).ok,
  );
  const ok = normalizeAutomationInput({
    ...base,
    scope_json: {
      type: "filter",
      combinator: "or",
      rules: [{ field: "brand", op: "eq", value: "Nike" }],
    },
  });
  assert(ok.ok);
  assertEquals(ok.value.scope_json.type, "filter");
});

Deno.test("normalize: empty filter rules collapse to scope all", () => {
  const r = normalizeAutomationInput({
    name: "Empty scope",
    trigger_json: { type: "no_views_in_days", days: 14 },
    action_json: { type: "set_promo_rate_pct", pct: 5 },
    scope_json: { type: "filter", combinator: "and", rules: [] },
  });
  assert(r.ok);
  assertEquals(r.value.scope_json, { type: "all" });
});

// ── triggerMatches ──────────────────────────────────────────────────

Deno.test("days_listed_gt fires strictly after N days", () => {
  const t = { type: "days_listed_gt", days: 30, cooldown_days: 7 } as const;
  assert(!triggerMatches(t, facts({ ageDays: 30 })));
  assert(triggerMatches(t, facts({ ageDays: 31 })));
});

Deno.test("no_views_in_days needs zero views AND the age", () => {
  const t = { type: "no_views_in_days", days: 14, cooldown_days: 7 } as const;
  assert(triggerMatches(t, facts({ ageDays: 15, views: 0 })));
  assert(!triggerMatches(t, facts({ ageDays: 15, views: 3 })));
  assert(!triggerMatches(t, facts({ ageDays: 10, views: 0 })));
});

Deno.test("watchers_lt_after_days", () => {
  const t = {
    type: "watchers_lt_after_days",
    watchers: 2,
    days: 10,
    cooldown_days: 7,
  } as const;
  assert(triggerMatches(t, facts({ ageDays: 10, watchers: 1 })));
  assert(!triggerMatches(t, facts({ ageDays: 10, watchers: 2 })));
  assert(!triggerMatches(t, facts({ ageDays: 9, watchers: 0 })));
});

// ── scopeMatches ────────────────────────────────────────────────────

Deno.test("scope all matches everything", () => {
  assert(scopeMatches({ type: "all" }, facts()));
});

Deno.test("scope filter and/or semantics match the web evaluator", () => {
  const f = facts({ brand: "Nike", cost: 12, ageDays: 40 });
  const brandRule = { field: "brand", op: "eq", value: "nike" } as const;
  const costRule = { field: "cost", op: "gt", value: "20" } as const;
  assert(
    scopeMatches(
      { type: "filter", combinator: "or", rules: [brandRule, costRule] },
      f,
    ),
  );
  assert(
    !scopeMatches(
      { type: "filter", combinator: "and", rules: [brandRule, costRule] },
      f,
    ),
  );
});

Deno.test("scope numeric ops ignore non-numeric values", () => {
  const f = facts({ cost: null });
  assert(
    !scopeMatches(
      {
        type: "filter",
        combinator: "and",
        rules: [{ field: "cost", op: "lt", value: "10" }],
      },
      f,
    ),
  );
});

// ── cooldown ────────────────────────────────────────────────────────

Deno.test("isCooledDown anchors to the last action", () => {
  const now = new Date("2026-06-11T00:00:00Z");
  assert(isCooledDown(null, 7, now));
  assert(isCooledDown("2026-06-01T00:00:00Z", 7, now));
  assert(!isCooledDown("2026-06-08T00:00:00Z", 7, now));
});

// ── floor + planAction ──────────────────────────────────────────────

Deno.test("computeFloorCents = cost basis + margin", () => {
  assertEquals(computeFloorCents(10, 10), 1100);
  assertEquals(computeFloorCents(null, 10), null);
  assertEquals(computeFloorCents(0, 10), null);
});

Deno.test("price drop clamps to the cost-basis floor and never raises", () => {
  // $20 listing, $15 cost, 10% margin → floor $16.50. 20% drop → $16 → clamped.
  const clamped = planAction(
    { type: "price_drop_pct", pct: 20, margin_floor_pct: 10 },
    { currentCents: 2000, costBasisDollars: 15, currentPromoRatePct: null },
  );
  assert(clamped && clamped.kind === "price_drop");
  assertEquals(clamped.newCents, 1650);
  assert(clamped.floored);

  // Already at the floor → no-op, never an increase.
  const noop = planAction(
    { type: "price_drop_pct", pct: 20, margin_floor_pct: 10 },
    { currentCents: 1650, costBasisDollars: 15, currentPromoRatePct: null },
  );
  assertEquals(noop, null);
});

Deno.test("price drop without a cost basis has no floor", () => {
  const p = planAction(
    { type: "price_drop_pct", pct: 10, margin_floor_pct: 10 },
    { currentCents: 2000, costBasisDollars: null, currentPromoRatePct: null },
  );
  assert(p && p.kind === "price_drop");
  assertEquals(p.newCents, 1800);
  assert(!p.floored);
});

Deno.test("set_promo_rate is a no-op when already at the rate", () => {
  const set = planAction(
    { type: "set_promo_rate_pct", pct: 5 },
    { currentCents: 2000, costBasisDollars: null, currentPromoRatePct: null },
  );
  assert(set && set.kind === "set_promo_rate" && set.newRatePct === 5);
  const noop = planAction(
    { type: "set_promo_rate_pct", pct: 5 },
    { currentCents: 2000, costBasisDollars: null, currentPromoRatePct: 5 },
  );
  assertEquals(noop, null);
});

Deno.test("end_listing always plans", () => {
  const p = planAction(
    { type: "end_listing" },
    { currentCents: 2000, costBasisDollars: null, currentPromoRatePct: null },
  );
  assert(p && p.kind === "end_listing");
});

// ── US-1448: create_coded_coupon action (aging → auto-coupon) ────────────────

Deno.test("US-1448: create_coded_coupon normalizes within the 5-70% bounds", () => {
  const ok = normalizeAutomationInput({
    name: "Coupon aged stock",
    is_active: true,
    trigger_json: { type: "days_listed_gt", days: 90, cooldown_days: 30 },
    action_json: { type: "create_coded_coupon", discount_pct: 15 },
    scope_json: { type: "all" },
  });
  if (!ok.ok) throw new Error(ok.error);
  assertEquals(ok.value.action_json, {
    type: "create_coded_coupon",
    discount_pct: 15,
  });

  for (const bad of [0, 4, 71, Number.NaN]) {
    const res = normalizeAutomationInput({
      name: "x",
      is_active: true,
      trigger_json: { type: "days_listed_gt", days: 90, cooldown_days: 30 },
      action_json: { type: "create_coded_coupon", discount_pct: bad },
      scope_json: { type: "all" },
    });
    assertEquals(res.ok, false, `discount_pct=${bad} must be rejected`);
  }
});

Deno.test("US-1448: planAction passes the coupon through (apply-time gating)", () => {
  const planned = planAction(
    { type: "create_coded_coupon", discount_pct: 20 },
    { currentCents: 5000, costBasisDollars: 10, currentPromoRatePct: null },
  );
  assertEquals(planned, { kind: "create_coupon", discountPct: 20 });
});
