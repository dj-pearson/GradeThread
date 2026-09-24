// Pricing plan P8: one eligibility guard for every automated price change.
// The two rule engines read each other's cuts, a hand-set price is left alone
// unless a rule says otherwise, an opted-out garment is out of both engines,
// and the markdown sale honours the seller's floor on the garment.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { installFakePostgrest, type Row } from "./_fake-postgrest.ts";
import { evaluateRules } from "../routes/flipdesk-automations.ts";
import { pricingEbay, runRulesForOwner } from "../routes/flipdesk-pricing.ts";
import { planAction } from "../lib/automation-rules.ts";
import { selectMarkdownItems } from "../lib/markdown-rules.ts";
import { loadMarkdownCandidates } from "../lib/markdown-candidates.ts";

const db = installFakePostgrest();

const OWNER = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const LISTING = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let pushes = 0;
pricingEbay.isEbayConfigured = () => false;
pricingEbay.updateOfferPrice = (() => {
  pushes++;
  return Promise.resolve();
}) as typeof pricingEbay.updateOfferPrice;

function item(over: Partial<Row> = {}): Row {
  return {
    id: ITEM,
    user_id: OWNER,
    title: "Filson Mackinaw",
    brand: "Filson",
    size: "L",
    item_category: "outerwear",
    garment_category: null,
    acquired_price: null,
    target_price: null,
    floor_price: null,
    status: "listed",
    grade_value: 8,
    updated_at: ago(40),
    exclude_from_automations: false,
    ebay_category_id: "57988",
    sources: null,
    ...over,
  };
}

function listing(over: Partial<Row> = {}): Row {
  return {
    id: LISTING,
    user_id: OWNER,
    inventory_item_id: ITEM,
    platform: "ebay",
    listing_status: "active",
    listing_title: "Filson Mackinaw",
    listing_price: 100,
    price_set_by: null,
    listed_at: ago(60),
    watchers: 0,
    views: 0,
    last_metrics_synced_at: null,
    platform_offer_id: null,
    platform_listing_id: null,
    platform_category_id: null,
    platform_fields: null,
    promo_rate_pct: null,
    compliance_violation_count: 0,
    price_range_low_cents: null,
    price_range_high_cents: null,
    draft_id: null,
    marketplace_connection_id: null,
    ...over,
  };
}

// The Automations side: a 10%-every-7-days price drop on anything listed 30+ days.
function automationRule(action: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    name: "Age out",
    trigger_json: { type: "days_listed_gt", days: 30, cooldown_days: 7 },
    action_json: { type: "price_drop_pct", pct: 10, margin_floor_pct: 10, ...action },
    scope_json: { type: "all", combinator: "and", rules: [] },
    is_active: true,
    last_run_at: null,
    created_at: ago(90),
  };
}

// The Repricing side: the same shape in the other tab.
const REPRICE_RULE: Row = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  user_id: OWNER,
  name: "Weekly cut",
  enabled: true,
  inventory_item_id: null,
  filter_brand: null,
  filter_category_id: null,
  min_age_days: 0,
  drop_pct: 10,
  interval_days: 7,
  floor_price_cents: null,
  auto_accept_confidence: null,
  override_manual: false,
  last_run_at: null,
  created_at: ago(90),
};

async function automationMatches(
  seed: Record<string, Row[]>,
  action: Record<string, unknown> = {},
) {
  db.reset({ inventory_items: [item()], ...seed });
  const listings = (db.tables.listings ?? []).map((l) => ({
    ...l,
    inventory_items: db.tables.inventory_items.find((i) => i.id === l.inventory_item_id),
  }));
  // deno-lint-ignore no-explicit-any
  return await evaluateRules(OWNER, [automationRule(action)] as any, listings as any);
}

Deno.test("P8: an Automations drop is due when nothing has touched the price", async () => {
  const m = await automationMatches({ listings: [listing()] });
  assertEquals(m.length, 1);
});

Deno.test("P8: a repricing-rule cut yesterday holds off a 7-day Automations drop today", async () => {
  const m = await automationMatches({
    listings: [listing()],
    repricing_actions: [{
      user_id: OWNER,
      rule_id: REPRICE_RULE.id,
      listing_id: LISTING,
      created_at: ago(1),
      reason: "scheduled_markdown",
    }],
  });
  assertEquals(m.length, 0);
});

Deno.test("P8: a seller's own Apply yesterday is not an automated anchor", async () => {
  const m = await automationMatches({
    listings: [listing()],
    repricing_actions: [{
      user_id: OWNER,
      rule_id: null,
      listing_id: LISTING,
      created_at: ago(1),
      reason: "nudge_apply",
    }],
  });
  assertEquals(m.length, 1);
});

Deno.test("P8: an Automations cut yesterday holds off the repricing rule today", async () => {
  pushes = 0;
  db.reset({
    inventory_items: [item()],
    listings: [listing()],
    repricing_rules: [REPRICE_RULE],
    flipdesk_automation_actions: [{
      rule_id: "aaaaaaaa-0000-4000-8000-000000000001",
      user_id: OWNER,
      listing_id: LISTING,
      action_type: "price_drop_pct",
      created_at: ago(1),
    }],
  });
  const r = await runRulesForOwner(OWNER);
  assertEquals(r.applied, 0);
  assertEquals(db.tables.listings[0].listing_price, 100);
});

Deno.test("P8: with nothing in the way the repricing rule cuts, and stamps 'rule'", async () => {
  db.reset({
    inventory_items: [item()],
    listings: [listing()],
    repricing_rules: [REPRICE_RULE],
  });
  const r = await runRulesForOwner(OWNER);
  assertEquals(r.applied, 1);
  assertEquals(db.tables.listings[0].listing_price, 90);
  assertEquals(db.tables.listings[0].price_set_by, "rule");
});

Deno.test("P8: a hand-set price is skipped by price_drop_pct unless override_manual", async () => {
  const seller = { listings: [listing({ price_set_by: "seller" })] };
  assertEquals((await automationMatches(seller)).length, 0);
  assertEquals((await automationMatches(seller, { override_manual: true })).length, 1);

  const base = { currentCents: 10_000, costBasisDollars: null, currentPromoRatePct: null };
  assertEquals(
    planAction({ type: "price_drop_pct", pct: 10, margin_floor_pct: 10 }, {
      ...base,
      priceSetBy: "seller",
    }),
    null,
  );
  assert(
    planAction({ type: "price_drop_pct", pct: 10, margin_floor_pct: 10 }, {
      ...base,
      priceSetBy: "rule",
    }) !== null,
  );
});

Deno.test("P8: an opted-out garment is left out of the repricing run", async () => {
  db.reset({
    inventory_items: [item({ exclude_from_automations: true })],
    listings: [listing()],
    repricing_rules: [REPRICE_RULE],
  });
  const r = await runRulesForOwner(OWNER);
  assertEquals(r.listings_scanned, 0);
  assertEquals(r.applied, 0);
  assertEquals(db.tables.listings[0].listing_price, 100);
});

Deno.test("P8: an opted-out garment is left out of the markdown sale", async () => {
  db.reset({
    inventory_items: [item({ exclude_from_automations: true })],
    listings: [listing()],
  });
  assertEquals(await loadMarkdownCandidates(OWNER), []);
});

Deno.test("P8: a markdown that would fall under floor_price leaves the item out", async () => {
  db.reset({
    inventory_items: [item({ floor_price: 80 })],
    listings: [listing()],
  });
  const candidates = await loadMarkdownCandidates(OWNER);
  assertEquals(candidates[0].itemFloorCents, 8000);
  const cfg = { minDaysListed: 30, markdownPct: 30, marginFloorPct: 10, minGrade: null };
  const out = selectMarkdownItems(cfg, candidates);
  assertEquals(out.included.length, 0);
  assertEquals(out.excluded[0].reason, "below_margin_floor");
  // 10% off stays above an $80 floor.
  assertEquals(selectMarkdownItems({ ...cfg, markdownPct: 10 }, candidates).included.length, 1);
});

Deno.test("P8: override_manual survives normalization only when it is on", async () => {
  const { normalizeAutomationInput } = await import("../lib/automation-rules.ts");
  const on = normalizeAutomationInput({
    name: "x",
    trigger_json: { type: "days_listed_gt", days: 30 },
    action_json: { type: "price_drop_pct", pct: 10, override_manual: true },
  });
  assert(on.ok);
  assertEquals((on.value.action_json as { override_manual?: boolean }).override_manual, true);
  const off = normalizeAutomationInput({
    name: "x",
    trigger_json: { type: "days_listed_gt", days: 30 },
    action_json: { type: "price_drop_pct", pct: 10, override_manual: "yes" },
  });
  assert(off.ok);
  assertEquals("override_manual" in off.value.action_json, false);
});
