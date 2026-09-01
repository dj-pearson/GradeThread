// US-672 — repricing-rule validation + evaluation math. repricing-rules.ts is
// pure (no DB/network), imported directly.
import { assert, assertEquals } from "@std/assert";
import {
  computeMarkdownCents,
  decideNewPriceCents,
  isDue,
  normalizeRuleInput,
  ruleMatchesListing,
  ruleMayReprice,
} from "../lib/repricing-rules.ts";

// ── normalizeRuleInput ──────────────────────────────────────────────

Deno.test("normalize requires a name", () => {
  assert(!normalizeRuleInput({ drop_pct: 10 }).ok);
  assert(!normalizeRuleInput({ name: "  ", drop_pct: 10 }).ok);
});

Deno.test("normalize requires an effect (drop% or auto-accept)", () => {
  const r = normalizeRuleInput({ name: "Noop" });
  assert(!r.ok);
});

Deno.test("normalize clamps drop% and confidence, defaults interval", () => {
  const r = normalizeRuleInput({
    name: "Markdown",
    drop_pct: 150,
    auto_accept_confidence: 2,
    interval_days: 0,
    min_age_days: -4,
    floor_price_cents: 999,
  });
  assert(r.ok);
  assertEquals(r.value.drop_pct, 90); // clamped to MAX_DROP_PCT
  assertEquals(r.value.auto_accept_confidence, 1); // clamped to 1
  assertEquals(r.value.interval_days, 1); // min 1
  assertEquals(r.value.min_age_days, 0); // min 0
  assertEquals(r.value.floor_price_cents, 999);
  assertEquals(r.value.enabled, true);
});

Deno.test("normalize trims scope filters to null when blank", () => {
  const r = normalizeRuleInput({ name: "R", drop_pct: 5, filter_brand: "  ", filter_category_id: "11450" });
  assert(r.ok);
  assertEquals(r.value.filter_brand, null);
  assertEquals(r.value.filter_category_id, "11450");
});

// ── computeMarkdownCents ────────────────────────────────────────────

Deno.test("markdown drops by pct and floors at the floor", () => {
  assertEquals(computeMarkdownCents(10_00, 10, null), 9_00);
  assertEquals(computeMarkdownCents(10_00, 10, 9_50), 9_50); // floor wins
  assertEquals(computeMarkdownCents(10_00, 100, null), 0); // never below 0
});

// ── isDue ───────────────────────────────────────────────────────────

Deno.test("isDue uses last action, else listed date, else true", () => {
  const now = new Date("2024-01-20T00:00:00Z");
  assertEquals(isDue("2024-01-10T00:00:00Z", null, 7, now), true); // 10d >= 7
  assertEquals(isDue("2024-01-18T00:00:00Z", null, 7, now), false); // 2d < 7
  assertEquals(isDue(null, "2024-01-01T00:00:00Z", 7, now), true); // falls back to listed
  assertEquals(isDue(null, null, 7, now), true); // unknown → eligible
});

// ── ruleMatchesListing ──────────────────────────────────────────────

const facts = {
  inventoryItemId: "i1",
  brand: "Nike",
  categoryId: "11450",
  ageDays: 30,
};

Deno.test("scope matches on item, brand, category, and min age", () => {
  assert(ruleMatchesListing(
    { inventory_item_id: null, filter_brand: null, filter_category_id: null, min_age_days: 0 },
    facts,
  ));
  assert(ruleMatchesListing(
    { inventory_item_id: "i1", filter_brand: "nike", filter_category_id: "11450", min_age_days: 14 },
    facts,
  ));
  // wrong item
  assert(!ruleMatchesListing(
    { inventory_item_id: "other", filter_brand: null, filter_category_id: null, min_age_days: 0 },
    facts,
  ));
  // wrong brand
  assert(!ruleMatchesListing(
    { inventory_item_id: null, filter_brand: "Adidas", filter_category_id: null, min_age_days: 0 },
    facts,
  ));
  // too young
  assert(!ruleMatchesListing(
    { inventory_item_id: null, filter_brand: null, filter_category_id: null, min_age_days: 45 },
    facts,
  ));
});

// ── decideNewPriceCents ─────────────────────────────────────────────

Deno.test("decision: flat markdown when it's a cut", () => {
  const d = decideNewPriceCents({ currentCents: 10_00, dropPct: 10, floorCents: null, autoAcceptConfidence: null });
  assertEquals(d, { newCents: 9_00, reason: "scheduled_markdown" });
});

Deno.test("decision: no-op when markdown hits the floor at/above current", () => {
  const d = decideNewPriceCents({ currentCents: 10_00, dropPct: 10, floorCents: 10_00, autoAcceptConfidence: null });
  assertEquals(d, null);
});

Deno.test("decision: auto-accept a high-confidence cut over the flat drop", () => {
  const d = decideNewPriceCents({
    currentCents: 10_00,
    dropPct: 10,
    floorCents: null,
    autoAcceptConfidence: 0.8,
    suggestion: { suggestedPriceCents: 8_50, confidence: 0.9 },
  });
  assertEquals(d, { newCents: 8_50, reason: "auto_accept" });
});

Deno.test("decision: ignore low-confidence or raising suggestions", () => {
  // confidence below threshold → falls back to markdown
  assertEquals(
    decideNewPriceCents({
      currentCents: 10_00, dropPct: 10, floorCents: null, autoAcceptConfidence: 0.8,
      suggestion: { suggestedPriceCents: 8_50, confidence: 0.5 },
    }),
    { newCents: 9_00, reason: "scheduled_markdown" },
  );
  // suggestion would RAISE → never auto-applied; markdown still applies
  assertEquals(
    decideNewPriceCents({
      currentCents: 10_00, dropPct: 10, floorCents: null, autoAcceptConfidence: 0.8,
      suggestion: { suggestedPriceCents: 12_00, confidence: 0.99 },
    }),
    { newCents: 9_00, reason: "scheduled_markdown" },
  );
});

Deno.test("decision: auto-accept clamped to floor, no-op if not a cut", () => {
  assertEquals(
    decideNewPriceCents({
      currentCents: 10_00, dropPct: 0, floorCents: 9_75, autoAcceptConfidence: 0.5,
      suggestion: { suggestedPriceCents: 8_00, confidence: 0.9 },
    }),
    { newCents: 9_75, reason: "auto_accept" },
  );
});

// ── US-9205: manual prices are protected unless the rule says otherwise ──

Deno.test("normalize defaults override_manual to false and only true turns it on", () => {
  const off = normalizeRuleInput({ name: "Markdown", drop_pct: 10 });
  assert(off.ok && off.value.override_manual === false);
  const truthy = normalizeRuleInput({ name: "Markdown", drop_pct: 10, override_manual: "yes" });
  assert(truthy.ok && truthy.value.override_manual === false, "a string is not consent");
  const on = normalizeRuleInput({ name: "Markdown", drop_pct: 10, override_manual: true });
  assert(on.ok && on.value.override_manual === true);
});

Deno.test("a rule never moves a seller-set price unless it may", () => {
  assertEquals(ruleMayReprice({ override_manual: false }, { price_set_by: "seller" }), false);
  assertEquals(ruleMayReprice({ override_manual: true }, { price_set_by: "seller" }), true);
  for (const by of ["graded", "comp_median", "rule", null, undefined]) {
    assertEquals(ruleMayReprice({ override_manual: false }, { price_set_by: by }), true, String(by));
  }
});
