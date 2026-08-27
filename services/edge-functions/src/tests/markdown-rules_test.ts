// US-2950: the aged-stock markdown rule.
//
// The two "wrong direction" decisions are what these pin, because both look
// like bugs until you read why:
//
//   • An item with NO recorded cost is INCLUDED. That is the opposite of the
//     offer rules, and deliberately so: an offer rule sells at a price and an
//     unknown cost risks selling under water; a markdown only makes an item
//     cheaper to buy, and a seller running a clearance who found half their
//     stock silently excluded for a missing purchase price would conclude the
//     feature was broken.
//   • An UNGRADED item is INCLUDED, for the same reason.
//
// And the floor EXCLUDES rather than clamping, because a markdown sale is one
// percentage across a set — there is no per-item number to clamp to.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { describeExclusion, selectMarkdownItems } = await import("../lib/markdown-rules.ts");
import type { MarkdownCandidate, MarkdownRuleConfig } from "../lib/markdown-rules.ts";

const CFG: MarkdownRuleConfig = {
  minDaysListed: 45,
  markdownPct: 20,
  marginFloorPct: 10,
  minGrade: null,
};

const item = (over: Partial<MarkdownCandidate> & { listingId: string }): MarkdownCandidate => ({
  title: over.listingId,
  priceCents: 10_000,
  costCents: 4_000,
  daysListed: 90,
  grade: 8,
  ...over,
});

Deno.test("an aged item that clears the floor is included", () => {
  const out = selectMarkdownItems(CFG, [item({ listingId: "a" })]);
  assertEquals(out.included.map((i) => i.listingId), ["a"]);
  // 20% of $100 across one item.
  assertEquals(out.exposureCents, 2_000);
});

Deno.test("a too-new item is excluded, and says so", () => {
  const out = selectMarkdownItems(CFG, [item({ listingId: "new", daysListed: 10 })]);
  assertEquals(out.included.length, 0);
  assertEquals(out.excluded[0]!.reason, "too_new");
});

Deno.test("the floor EXCLUDES rather than clamping the discount", () => {
  // $100 listed, cost $85, floor 10% = $93.50. A 20% markdown lands at $80.
  // The item is left OUT — it is not discounted to $93.50 instead, because a
  // markdown sale applies one percentage across the whole set.
  const out = selectMarkdownItems(CFG, [
    item({ listingId: "thin", priceCents: 10_000, costCents: 8_500 }),
  ]);
  assertEquals(out.included.length, 0);
  assertEquals(out.excluded[0]!.reason, "below_margin_floor");
});

Deno.test("an item with NO cost is INCLUDED, unlike the offer rules", () => {
  const out = selectMarkdownItems(CFG, [item({ listingId: "unknown", costCents: null })]);
  assertEquals(out.included.map((i) => i.listingId), ["unknown"]);
});

Deno.test("a minimum grade keeps the good stuff out of a clearance", () => {
  const cfg = { ...CFG, minGrade: 8 };
  const out = selectMarkdownItems(cfg, [
    item({ listingId: "rough", grade: 6 }),
    item({ listingId: "good", grade: 9 }),
  ]);
  assertEquals(out.included.map((i) => i.listingId), ["good"]);
  assertEquals(out.excluded[0]!.reason, "below_min_grade");
});

Deno.test("an UNGRADED item passes the grade check", () => {
  const out = selectMarkdownItems({ ...CFG, minGrade: 8 }, [
    item({ listingId: "ungraded", grade: null }),
  ]);
  assertEquals(out.included.map((i) => i.listingId), ["ungraded"]);
});

Deno.test("an item with no price is excluded first, with its own reason", () => {
  // Cheapest check first, so the reason reported is the one a seller would give.
  const out = selectMarkdownItems(CFG, [
    item({ listingId: "priceless", priceCents: null, daysListed: 2 }),
  ]);
  assertEquals(out.excluded[0]!.reason, "no_price");
});

Deno.test("exposure is the worst case across the INCLUDED set only", () => {
  const out = selectMarkdownItems(CFG, [
    item({ listingId: "in", priceCents: 10_000 }),
    item({ listingId: "out", daysListed: 1, priceCents: 50_000 }),
  ]);
  assertEquals(out.exposureCents, 2_000);
});

Deno.test("every exclusion reason has copy a seller can read", () => {
  for (const reason of ["no_price", "too_new", "below_min_grade", "below_margin_floor"] as const) {
    assert(describeExclusion(reason).length > 0);
  }
});
