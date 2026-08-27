// US-150 — price-drop/promo scheduler validation + evaluation math.
// automation-rules.ts is pure (no DB/network), imported directly.
import { assert, assertEquals } from "@std/assert";
import {
  type AutomationAction,
  AUTOMATION_MESSAGE_MAX,
  AUTOMATION_SETTABLE_STATUSES,
  type AutomationFacts,
  type AutomationTrigger,
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
    // Default to the pre-US-2155 world: no performance sync has ever run, so
    // no_views_in_days falls back to the cumulative `views` counter. Tests that
    // exercise the windowed path opt in by setting these two.
    metricsSyncedDaysAgo: null,
    recentViewWindows: [],
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

// US-2155: the trigger reads the listing_metrics window, not the lifetime
// counter. The bug these cover: a listing with plenty of historical traffic and
// none lately could never fire the rule.
Deno.test("no_views_in_days fires on lifetime views with none in the window", () => {
  const t = { type: "no_views_in_days", days: 14, cooldown_days: 7 } as const;
  // 500 lifetime views, synced yesterday, and eBay reported no engagement in
  // the window (so the sync wrote no rows) — this MUST fire.
  assert(
    triggerMatches(
      t,
      facts({
        ageDays: 60,
        views: 500,
        metricsSyncedDaysAgo: 1,
        recentViewWindows: [],
      }),
    ),
  );
});

Deno.test("no_views_in_days does not fire when a window reading is non-zero", () => {
  const t = { type: "no_views_in_days", days: 14, cooldown_days: 7 } as const;
  // Zero lifetime views recorded on the snapshot column, but the time-series
  // says the listing got traffic 3 days ago — the window wins.
  assert(
    !triggerMatches(
      t,
      facts({
        ageDays: 60,
        views: 0,
        metricsSyncedDaysAgo: 1,
        recentViewWindows: [{ daysAgo: 3, views: 4 }, { daysAgo: 9, views: 0 }],
      }),
    ),
  );
  // A reading OUTSIDE the window is ignored.
  assert(
    triggerMatches(
      t,
      facts({
        ageDays: 60,
        views: 0,
        metricsSyncedDaysAgo: 1,
        recentViewWindows: [{ daysAgo: 30, views: 12 }],
      }),
    ),
  );
});

Deno.test("no_views_in_days falls back to lifetime views without a recent sync", () => {
  const t = { type: "no_views_in_days", days: 14, cooldown_days: 7 } as const;
  // Never synced → unchanged pre-US-2155 behaviour.
  assert(triggerMatches(t, facts({ ageDays: 60, views: 0 })));
  assert(!triggerMatches(t, facts({ ageDays: 60, views: 9 })));
  // Synced, but the sync predates the window → we know nothing about the last
  // 14 days, so fall back rather than assume silence means zero.
  assert(
    !triggerMatches(
      t,
      facts({ ageDays: 60, views: 9, metricsSyncedDaysAgo: 40 }),
    ),
  );
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

// ── US-2156: the non-aging trigger/action vocabulary ─────────────────────────
//
// The point of this story is that a rule can react to the PIPELINE (offers,
// returns, compliance, grades, status, comps) and act with more than a price
// change. Two properties matter most and are asserted throughout:
//   1. A trigger whose evidence is ABSENT never fires. Every new fact is
//      optional on the wire, and "I can't see it" must mean "don't act", not
//      "act on a zero".
//   2. The existing three triggers and four actions are untouched.

const BASE_PLAN = {
  currentCents: 5000,
  costBasisDollars: null,
  currentPromoRatePct: null,
} as const;

function normTrigger(trigger_json: unknown) {
  return normalizeAutomationInput({
    name: "Rule",
    trigger_json,
    action_json: { type: "end_listing" },
  });
}

function normAction(action_json: unknown) {
  return normalizeAutomationInput({
    name: "Rule",
    trigger_json: { type: "days_listed_gt", days: 30 },
    action_json,
  });
}

// ── Validation ──────────────────────────────────────────────────────

Deno.test("US-2156: every new trigger normalizes and keeps the cooldown default", () => {
  const cases: Array<[unknown, AutomationTrigger]> = [
    [{ type: "offer_received", days: 7 }, {
      type: "offer_received",
      days: 7,
      cooldown_days: DEFAULT_COOLDOWN_DAYS,
    }],
    [{ type: "return_opened", days: 14 }, {
      type: "return_opened",
      days: 14,
      cooldown_days: DEFAULT_COOLDOWN_DAYS,
    }],
    // min_violations defaults to 1 — "any open violation" is what a seller means.
    [{ type: "compliance_violation" }, {
      type: "compliance_violation",
      min_violations: 1,
      cooldown_days: DEFAULT_COOLDOWN_DAYS,
    }],
    [{ type: "grade_completed", days: 3 }, {
      type: "grade_completed",
      days: 3,
      max_grade: null,
      cooldown_days: DEFAULT_COOLDOWN_DAYS,
    }],
    [{ type: "grade_completed", days: 3, max_grade: 6 }, {
      type: "grade_completed",
      days: 3,
      max_grade: 6,
      cooldown_days: DEFAULT_COOLDOWN_DAYS,
    }],
    [{ type: "item_status_changed", status: "returned", days: 2 }, {
      type: "item_status_changed",
      status: "returned",
      days: 2,
      cooldown_days: DEFAULT_COOLDOWN_DAYS,
    }],
    [{ type: "comp_price_moved", direction: "above", pct: 25 }, {
      type: "comp_price_moved",
      direction: "above",
      pct: 25,
      cooldown_days: DEFAULT_COOLDOWN_DAYS,
    }],
  ];
  for (const [raw, expected] of cases) {
    const r = normTrigger(raw);
    if (!r.ok) throw new Error(`${JSON.stringify(raw)} → ${r.error}`);
    assertEquals(r.value.trigger_json, expected);
  }
});

Deno.test("US-2156: new triggers reject nonsense input", () => {
  const bad: unknown[] = [
    { type: "offer_received" }, // no day count
    { type: "offer_received", days: 0 },
    { type: "return_opened", days: -1 },
    { type: "grade_completed", days: 7, max_grade: 11 }, // off the 1-10 scale
    { type: "grade_completed", days: 7, max_grade: 0 },
    { type: "item_status_changed", days: 3 }, // no status
    { type: "item_status_changed", status: "   ", days: 3 },
    { type: "comp_price_moved", pct: 20 }, // no direction
    { type: "comp_price_moved", direction: "sideways", pct: 20 },
    { type: "comp_price_moved", direction: "above", pct: 0 },
    { type: "comp_price_moved", direction: "above", pct: 500 },
  ];
  for (const raw of bad) {
    assertEquals(
      normTrigger(raw).ok,
      false,
      `${JSON.stringify(raw)} must be rejected`,
    );
  }
});

Deno.test("US-2156: every new action normalizes", () => {
  const cases: Array<[unknown, AutomationAction]> = [
    [{ type: "relist" }, { type: "relist" }],
    // Platform is lower-cased so a UI that sends "Etsy" doesn't mint an
    // unroutable action.
    [{ type: "crosslist_to", platform: "Etsy" }, {
      type: "crosslist_to",
      platform: "etsy",
    }],
    [{ type: "send_offer_to_watchers", discount_pct: 10 }, {
      type: "send_offer_to_watchers",
      discount_pct: 10,
    }],
    [{ type: "advance_status", status: "archived" }, {
      type: "advance_status",
      status: "archived",
    }],
    [{ type: "notify", message: "  Check this one  " }, {
      type: "notify",
      message: "Check this one",
    }],
  ];
  for (const [raw, expected] of cases) {
    const r = normAction(raw);
    if (!r.ok) throw new Error(`${JSON.stringify(raw)} → ${r.error}`);
    assertEquals(r.value.action_json, expected);
  }
});

Deno.test("US-2156: advance_status refuses the statuses an automation must not write", () => {
  // US-1484's rule, enforced here: 'grading' without a submission or a charge,
  // or 'sold' with no sale row, would be a fabricated state.
  for (const status of ["grading", "graded", "listed", "sold", "shipped", "completed", "bogus"]) {
    assertEquals(
      normAction({ type: "advance_status", status }).ok,
      false,
      `advance_status → ${status} must be rejected`,
    );
  }
  for (const status of AUTOMATION_SETTABLE_STATUSES) {
    assert(normAction({ type: "advance_status", status }).ok, status);
  }
});

Deno.test("US-2156: crosslist/watcher-offer/notify bounds", () => {
  assertEquals(normAction({ type: "crosslist_to", platform: "craigslist" }).ok, false);
  assertEquals(normAction({ type: "crosslist_to" }).ok, false);
  for (const pct of [4, 61, 0, Number.NaN]) {
    assertEquals(
      normAction({ type: "send_offer_to_watchers", discount_pct: pct }).ok,
      false,
      `discount_pct=${pct}`,
    );
  }
  assert(normAction({ type: "send_offer_to_watchers", discount_pct: 5 }).ok);
  assert(normAction({ type: "send_offer_to_watchers", discount_pct: 60 }).ok);
  assertEquals(normAction({ type: "notify", message: "" }).ok, false);
  assertEquals(normAction({ type: "notify", message: "   " }).ok, false);
  assertEquals(
    normAction({ type: "notify", message: "x".repeat(AUTOMATION_MESSAGE_MAX + 1) }).ok,
    false,
  );
  assert(normAction({ type: "notify", message: "x".repeat(AUTOMATION_MESSAGE_MAX) }).ok);
});

Deno.test("US-2156: the pre-existing vocabulary still validates unchanged", () => {
  // AC6 — stored rules written before this story keep working verbatim.
  const legacy: AutomationTrigger[] = [
    { type: "days_listed_gt", days: 30, cooldown_days: 7 },
    { type: "no_views_in_days", days: 14, cooldown_days: 7 },
    { type: "watchers_lt_after_days", watchers: 2, days: 10, cooldown_days: 7 },
  ];
  const legacyActions: AutomationAction[] = [
    { type: "price_drop_pct", pct: 10, margin_floor_pct: 10 },
    { type: "set_promo_rate_pct", pct: 5 },
    { type: "create_coded_coupon", discount_pct: 15 },
    { type: "end_listing" },
  ];
  for (const t of legacy) {
    for (const a of legacyActions) {
      const r = normalizeAutomationInput({ name: "Legacy", trigger_json: t, action_json: a });
      if (!r.ok) throw new Error(`${t.type}/${a.type} → ${r.error}`);
      assertEquals(r.value.trigger_json, t);
      assertEquals(r.value.action_json, a);
    }
  }
});

// ── Trigger evaluation ──────────────────────────────────────────────

Deno.test("US-2156: offer_received / return_opened fire only inside the window", () => {
  const t: AutomationTrigger = { type: "offer_received", days: 7, cooldown_days: 7 };
  assert(triggerMatches(t, facts({ offerReceivedDaysAgo: 0 })));
  assert(triggerMatches(t, facts({ offerReceivedDaysAgo: 7 })));
  assert(!triggerMatches(t, facts({ offerReceivedDaysAgo: 8 })));
  // Absent evidence must NOT fire — this is the whole safety property.
  assert(!triggerMatches(t, facts({ offerReceivedDaysAgo: null })));
  assert(!triggerMatches(t, facts()));

  const r: AutomationTrigger = { type: "return_opened", days: 30, cooldown_days: 7 };
  assert(triggerMatches(r, facts({ returnOpenedDaysAgo: 3 })));
  assert(!triggerMatches(r, facts({ returnOpenedDaysAgo: 31 })));
  assert(!triggerMatches(r, facts()));
  // An offer must not satisfy a return rule, or vice versa.
  assert(!triggerMatches(r, facts({ offerReceivedDaysAgo: 1 })));
});

Deno.test("US-2156: compliance_violation counts open violations", () => {
  const t: AutomationTrigger = {
    type: "compliance_violation",
    min_violations: 2,
    cooldown_days: 7,
  };
  assert(!triggerMatches(t, facts({ complianceViolations: 1 })));
  assert(triggerMatches(t, facts({ complianceViolations: 2 })));
  assert(triggerMatches(t, facts({ complianceViolations: 9 })));
  assert(!triggerMatches(t, facts({ complianceViolations: 0 })));
  assert(!triggerMatches(t, facts()));
});

Deno.test("US-2156: grade_completed windows the grade, and max_grade needs a grade", () => {
  const any: AutomationTrigger = {
    type: "grade_completed",
    days: 5,
    max_grade: null,
    cooldown_days: 7,
  };
  assert(triggerMatches(any, facts({ gradeCompletedDaysAgo: 2 })));
  assert(!triggerMatches(any, facts({ gradeCompletedDaysAgo: 6 })));
  assert(!triggerMatches(any, facts()));

  const low: AutomationTrigger = {
    type: "grade_completed",
    days: 5,
    max_grade: 6,
    cooldown_days: 7,
  };
  assert(triggerMatches(low, facts({ gradeCompletedDaysAgo: 1, grade: 5.5 })));
  assert(triggerMatches(low, facts({ gradeCompletedDaysAgo: 1, grade: 6 })));
  assert(!triggerMatches(low, facts({ gradeCompletedDaysAgo: 1, grade: 8 })));
  // Graded recently but the grade itself is unknown — a threshold rule cannot
  // be evaluated, so it must not fire.
  assert(!triggerMatches(low, facts({ gradeCompletedDaysAgo: 1, grade: null })));
});

Deno.test("US-2156: item_status_changed needs BOTH the status and the recency", () => {
  const t: AutomationTrigger = {
    type: "item_status_changed",
    status: "returned",
    days: 3,
    cooldown_days: 7,
  };
  assert(triggerMatches(t, facts({ status: "returned", daysInStatus: 1 })));
  // Right status, but it landed there weeks ago — this is a "changed" trigger,
  // not a "is currently" trigger.
  assert(!triggerMatches(t, facts({ status: "returned", daysInStatus: 30 })));
  assert(!triggerMatches(t, facts({ status: "listed", daysInStatus: 1 })));
  assert(!triggerMatches(t, facts({ status: "returned", daysInStatus: null })));
});

Deno.test("US-2156: comp_price_moved compares price against the stored comp range", () => {
  const above: AutomationTrigger = {
    type: "comp_price_moved",
    direction: "above",
    pct: 20,
    cooldown_days: 7,
  };
  // p75 is $50; 20% above is $60. $61 fires, $60 does not (strictly greater).
  assert(triggerMatches(above, facts({ priceCents: 6100, compHighCents: 5000 })));
  assert(!triggerMatches(above, facts({ priceCents: 6000, compHighCents: 5000 })));
  assert(!triggerMatches(above, facts({ priceCents: 4000, compHighCents: 5000 })));

  const below: AutomationTrigger = {
    type: "comp_price_moved",
    direction: "below",
    pct: 20,
    cooldown_days: 7,
  };
  // p25 is $50; 20% below is $40. $39 fires, $40 does not.
  assert(triggerMatches(below, facts({ priceCents: 3900, compLowCents: 5000 })));
  assert(!triggerMatches(below, facts({ priceCents: 4000, compLowCents: 5000 })));

  // No comp data → never fires. Treating a missing p25 as 0 would mark every
  // uncomped listing as wildly overpriced and mass-drop prices on absent
  // evidence.
  assert(!triggerMatches(above, facts({ priceCents: 9999 })));
  assert(!triggerMatches(below, facts({ priceCents: 1 })));
  assert(!triggerMatches(above, facts({ priceCents: 9999, compHighCents: 0 })));
  assert(!triggerMatches(above, facts({ compHighCents: 5000 })));
});

// ── Action planning ─────────────────────────────────────────────────

Deno.test("US-2156: relist and notify always plan", () => {
  assertEquals(planAction({ type: "relist" }, BASE_PLAN), { kind: "relist" });
  assertEquals(planAction({ type: "notify", message: "Look at this" }, BASE_PLAN), {
    kind: "notify",
    message: "Look at this",
  });
});

Deno.test("US-2156: advance_status no-ops when the item is already there", () => {
  assertEquals(
    planAction({ type: "advance_status", status: "archived" }, {
      ...BASE_PLAN,
      currentStatus: "archived",
    }),
    null,
  );
  assertEquals(
    planAction({ type: "advance_status", status: "archived" }, {
      ...BASE_PLAN,
      currentStatus: "listed",
    }),
    { kind: "advance_status", status: "archived" },
  );
});

Deno.test("US-2156: crosslist_to no-ops for a platform the group already has", () => {
  // Without this an hourly rule would mint a fresh sibling row every pass.
  assertEquals(
    planAction({ type: "crosslist_to", platform: "etsy" }, {
      ...BASE_PLAN,
      existingPlatforms: ["ebay", "etsy"],
    }),
    null,
  );
  assertEquals(
    planAction({ type: "crosslist_to", platform: "etsy" }, {
      ...BASE_PLAN,
      existingPlatforms: ["ebay"],
    }),
    { kind: "crosslist", platform: "etsy" },
  );
});

Deno.test("US-2156: send_offer_to_watchers plans nothing without the negotiation scope", () => {
  // US-1967: the scope is unlicensed on the production keyset, so the seller
  // must see NO action rather than a run of guaranteed 403s.
  const action: AutomationAction = { type: "send_offer_to_watchers", discount_pct: 10 };
  assertEquals(planAction(action, BASE_PLAN), null);
  assertEquals(
    planAction(action, { ...BASE_PLAN, watcherOffersAvailable: false }),
    null,
  );
  assertEquals(
    planAction(action, { ...BASE_PLAN, watcherOffersAvailable: true }),
    { kind: "send_watcher_offer", discountPct: 10 },
  );
});

Deno.test("US-2156: the pre-existing actions plan exactly as before", () => {
  // AC6 — the new PlanInput fields are all optional and change nothing.
  assertEquals(
    planAction({ type: "price_drop_pct", pct: 10, margin_floor_pct: 0 }, BASE_PLAN),
    { kind: "price_drop", newCents: 4500, floored: false },
  );
  assertEquals(planAction({ type: "set_promo_rate_pct", pct: 4 }, BASE_PLAN), {
    kind: "set_promo_rate",
    newRatePct: 4,
  });
  assertEquals(planAction({ type: "end_listing" }, BASE_PLAN), { kind: "end_listing" });
});

// ── US-2236: the offer_threshold trigger's engine wiring ────────────
//
// The rule lives in the same table and passes through the same validator as
// every listing rule, but it is executed by a DIFFERENT runner. These cases pin
// the two halves of that: it validates like a first-class trigger, and the
// listing planner refuses it unconditionally.

Deno.test("US-2236: the listing planner NEVER matches an offer_threshold rule", () => {
  // The single most important case here. If triggerMatches ever returned true
  // for this shape, the price-drop engine would start answering Best Offers —
  // it would plan a markdown against a listing because an offer rule matched.
  const t: AutomationTrigger = {
    type: "offer_threshold",
    accept_at_pct: 90,
    decline_below_pct: 40,
    margin_floor_pct: 10,
    cooldown_days: 7,
  };
  assertEquals(triggerMatches(t, facts({ ageDays: 999 })), false);
  assertEquals(triggerMatches(t, facts()), false);
});

Deno.test("US-2236: a rule with no threshold at all is refused at save time", () => {
  // An inert rule sitting in the seller's list, doing nothing, is worse than a
  // validation error they can act on immediately.
  const r = normalizeAutomationInput({
    name: "Answer offers",
    trigger_json: { type: "offer_threshold" },
    action_json: { type: "notify", message: "hi" },
  });
  assert(!r.ok);
});

Deno.test("US-2236: an accept threshold at or below the decline threshold is refused", () => {
  // Some offer would qualify for both. Caught at configuration time rather than
  // silently skipped every hour.
  for (const [accept, decline] of [[40, 60], [50, 50]]) {
    const r = normalizeAutomationInput({
      name: "Answer offers",
      trigger_json: {
        type: "offer_threshold",
        accept_at_pct: accept,
        decline_below_pct: decline,
      },
      action_json: { type: "notify", message: "hi" },
    });
    assert(!r.ok, `accept ${accept} / decline ${decline} should be refused`);
  }
});

Deno.test("US-2236: a valid rule normalizes, clamps and defaults the margin floor", () => {
  const r = normalizeAutomationInput({
    name: "Answer offers",
    trigger_json: {
      type: "offer_threshold",
      accept_at_pct: 250, // clamps to 100
      decline_below_pct: 0, // clamps to 1
    },
    action_json: { type: "notify", message: "hi" },
  });
  assert(r.ok);
  assertEquals(r.value.trigger_json, {
    type: "offer_threshold",
    accept_at_pct: 100,
    decline_below_pct: 1,
    // US-2940: absent means null, which is the pre-counter behaviour exactly.
    // Every rule stored before the counter existed keeps parsing, and none of
    // them starts countering.
    counter_at_pct: null,
    // Defaulted, not required — every rule gets the safety net even from a
    // seller who never thinks about it.
    margin_floor_pct: 10,
    cooldown_days: DEFAULT_COOLDOWN_DAYS,
  });
});

Deno.test("US-2236: one threshold alone is a valid rule", () => {
  const acceptOnly = normalizeAutomationInput({
    name: "Take the good ones",
    trigger_json: { type: "offer_threshold", accept_at_pct: 90 },
    action_json: { type: "notify", message: "hi" },
  });
  assert(acceptOnly.ok);
  assertEquals(
    (acceptOnly.value.trigger_json as { decline_below_pct: number | null })
      .decline_below_pct,
    null,
  );

  const declineOnly = normalizeAutomationInput({
    name: "Bin the lowballs",
    trigger_json: { type: "offer_threshold", decline_below_pct: 40 },
    action_json: { type: "notify", message: "hi" },
  });
  assert(declineOnly.ok);
});
