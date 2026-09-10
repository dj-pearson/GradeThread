// US-3299 — the sale resolver, edge copy.
//
// These vectors are duplicated verbatim from src/lib/__tests__/discounts.test.ts.
// The browser and the edge run separate implementations of the same arithmetic
// (one Vite-resolved, one Deno), so the vectors are the only thing stopping them
// from drifting into a discount the card shows and checkout refuses. Change one,
// change both.
import { assertEquals } from "@std/assert";
import {
  campaignMatches,
  type DiscountCampaign,
  discountedCents,
  formatDiscountLabel,
  isCampaignLive,
  liveCampaigns,
  resolveDiscount,
} from "../lib/discount-campaigns.ts";

const NOW = Date.parse("2026-09-15T12:00:00Z");

function campaign(over: Partial<DiscountCampaign> = {}): DiscountCampaign {
  return {
    id: "c1",
    name: "Fall sale",
    description: null,
    discount_type: "percent",
    percent_off: 20,
    amount_off_cents: null,
    starts_at: "2026-09-09T00:00:00Z",
    ends_at: "2026-10-31T23:59:59Z",
    enabled: true,
    targets: [],
    applies_to_all: true,
    stripe_coupon_id: "co_test",
    ...over,
  };
}

Deno.test("isCampaignLive: inside the window", () => {
  assertEquals(isCampaignLive(campaign(), NOW), true);
});

Deno.test("isCampaignLive: before the window", () => {
  assertEquals(isCampaignLive(campaign(), Date.parse("2026-09-08T23:59:59Z")), false);
});

Deno.test("isCampaignLive: half-open window, live at start and dead at end", () => {
  const c = campaign({ starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-20T00:00:00Z" });
  assertEquals(isCampaignLive(c, Date.parse("2026-11-01T00:00:00Z")), true);
  assertEquals(isCampaignLive(c, Date.parse("2026-11-20T00:00:00Z")), false);
});

Deno.test("isCampaignLive: disabled is never live", () => {
  assertEquals(isCampaignLive(campaign({ enabled: false }), NOW), false);
});

// The costliest failure this feature can have: a card advertising a discount
// Stripe then refuses at checkout.
Deno.test("isCampaignLive: an unsynced coupon is never live", () => {
  assertEquals(isCampaignLive(campaign({ stripe_coupon_id: null }), NOW), false);
});

Deno.test("isCampaignLive: an unparseable date is never live", () => {
  assertEquals(isCampaignLive(campaign({ ends_at: "not-a-date" }), NOW), false);
});

Deno.test("campaignMatches: applies_to_all covers every kind", () => {
  const c = campaign({ applies_to_all: true, targets: [] });
  assertEquals(campaignMatches(c, { kind: "grade_tier", key: "premium" }), true);
  assertEquals(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "yearly" }), true);
});

Deno.test("campaignMatches: kind and key both have to match", () => {
  const c = campaign({ applies_to_all: false, targets: [{ kind: "flipdesk_plan", key: "pro" }] });
  assertEquals(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "monthly" }), true);
  assertEquals(campaignMatches(c, { kind: "flipdesk_plan", key: "starter", interval: "monthly" }), false);
  assertEquals(campaignMatches(c, { kind: "buyer_plan", key: "pro", interval: "monthly" }), false);
});

Deno.test("campaignMatches: no interval on the target covers both", () => {
  const c = campaign({ applies_to_all: false, targets: [{ kind: "flipdesk_plan", key: "pro" }] });
  assertEquals(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "monthly" }), true);
  assertEquals(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "yearly" }), true);
});

Deno.test("campaignMatches: an interval on the target narrows to it", () => {
  const c = campaign({
    applies_to_all: false,
    targets: [{ kind: "flipdesk_plan", key: "pro", interval: "yearly" }],
  });
  assertEquals(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "yearly" }), true);
  assertEquals(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "monthly" }), false);
});

Deno.test("campaignMatches: keys compare as strings, so a pack size matches", () => {
  const c = campaign({ applies_to_all: false, targets: [{ kind: "credit_pack", key: "25" }] });
  assertEquals(campaignMatches(c, { kind: "credit_pack", key: "25" }), true);
});

Deno.test("discountedCents: 20% off $29.00", () => {
  assertEquals(discountedCents(campaign({ percent_off: 20 }), 2900), 2320);
});

Deno.test("discountedCents: rounds to the nearest cent", () => {
  assertEquals(discountedCents(campaign({ percent_off: 20 }), 299), 239);
  assertEquals(discountedCents(campaign({ percent_off: 15 }), 1299), 1104);
});

Deno.test("discountedCents: flat amount off", () => {
  const c = campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 500 });
  assertEquals(discountedCents(c, 2900), 2400);
});

Deno.test("discountedCents: floors at zero rather than going negative", () => {
  const c = campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 50_000 });
  assertEquals(discountedCents(c, 2900), 0);
  assertEquals(discountedCents(campaign({ percent_off: 100 }), 2900), 0);
});

Deno.test("discountedCents: leaves a zero price alone", () => {
  assertEquals(discountedCents(campaign({ percent_off: 20 }), 0), 0);
});

Deno.test("formatDiscountLabel: whole and fractional percent, whole and part dollars", () => {
  assertEquals(formatDiscountLabel(campaign({ percent_off: 20 })), "20% off");
  assertEquals(formatDiscountLabel(campaign({ percent_off: 12.5 })), "12.5% off");
  assertEquals(
    formatDiscountLabel(campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 500 })),
    "$5 off",
  );
  assertEquals(
    formatDiscountLabel(campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 250 })),
    "$2.50 off",
  );
});

Deno.test("resolveDiscount: null with no campaigns", () => {
  assertEquals(resolveDiscount([], { kind: "grade_tier", key: "standard" }, 299, NOW), null);
  assertEquals(resolveDiscount(null, { kind: "grade_tier", key: "standard" }, 299, NOW), null);
});

Deno.test("resolveDiscount: the brief's example, 20% off everything", () => {
  const got = resolveDiscount(
    [campaign()],
    { kind: "flipdesk_plan", key: "pro", interval: "monthly" },
    5900,
    NOW,
  );
  assertEquals(got?.finalCents, 4720);
  assertEquals(got?.savedCents, 1180);
  assertEquals(got?.label, "20% off");
});

// Owner decision 2026-09-09: no "20% off $0" badge on a free tier.
Deno.test("resolveDiscount: skips a zero price", () => {
  assertEquals(
    resolveDiscount([campaign()], { kind: "flipdesk_plan", key: "free", interval: "monthly" }, 0, NOW),
    null,
  );
});

Deno.test("resolveDiscount: skips a campaign that rounds away to nothing", () => {
  const c = campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 1 });
  assertEquals(resolveDiscount([c], { kind: "grade_tier", key: "standard" }, 299, NOW)?.savedCents, 1);
  const tiny = campaign({ percent_off: 0.01 });
  assertEquals(resolveDiscount([tiny], { kind: "grade_tier", key: "standard" }, 299, NOW), null);
});

Deno.test("resolveDiscount: sequential windows hand off cleanly", () => {
  const fall = campaign({
    id: "a",
    percent_off: 20,
    starts_at: "2026-09-09T00:00:00Z",
    ends_at: "2026-11-01T00:00:00Z",
  });
  const nov = campaign({
    id: "b",
    percent_off: 15,
    starts_at: "2026-11-01T00:00:00Z",
    ends_at: "2026-11-20T00:00:00Z",
  });
  const target = { kind: "flipdesk_plan" as const, key: "starter", interval: "monthly" as const };

  const during = resolveDiscount([fall, nov], target, 2900, Date.parse("2026-10-15T00:00:00Z"));
  assertEquals(during?.campaign.id, "a");
  assertEquals(during?.finalCents, 2320);

  const after = resolveDiscount([fall, nov], target, 2900, Date.parse("2026-11-05T00:00:00Z"));
  assertEquals(after?.campaign.id, "b");
  assertEquals(after?.finalCents, 2465);

  assertEquals(resolveDiscount([fall, nov], target, 2900, Date.parse("2026-12-01T00:00:00Z")), null);
});

Deno.test("resolveDiscount: on an overlap the biggest saving wins, whatever the order", () => {
  const small = campaign({ id: "a", percent_off: 10 });
  const big = campaign({ id: "b", percent_off: 30 });
  const target = { kind: "grade_tier" as const, key: "express" };
  assertEquals(resolveDiscount([small, big], target, 1299, NOW)?.campaign.id, "b");
  assertEquals(resolveDiscount([big, small], target, 1299, NOW)?.campaign.id, "b");
});

Deno.test("resolveDiscount: ties break on later start, then id, deterministically", () => {
  const older = campaign({ id: "zzz", percent_off: 20, starts_at: "2026-09-01T00:00:00Z" });
  const newer = campaign({ id: "aaa", percent_off: 20, starts_at: "2026-09-10T00:00:00Z" });
  const target = { kind: "grade_tier" as const, key: "standard" };
  assertEquals(resolveDiscount([older, newer], target, 299, NOW)?.campaign.id, "aaa");
  assertEquals(resolveDiscount([newer, older], target, 299, NOW)?.campaign.id, "aaa");

  const sameStart = campaign({ id: "bbb", percent_off: 20, starts_at: "2026-09-10T00:00:00Z" });
  assertEquals(resolveDiscount([sameStart, newer], target, 299, NOW)?.campaign.id, "aaa");
  assertEquals(resolveDiscount([newer, sameStart], target, 299, NOW)?.campaign.id, "aaa");
});

Deno.test("resolveDiscount: does not apply a campaign aimed elsewhere", () => {
  const c = campaign({ applies_to_all: false, targets: [{ kind: "grade_tier", key: "premium" }] });
  assertEquals(resolveDiscount([c], { kind: "grade_tier", key: "standard" }, 299, NOW), null);
  assertEquals(resolveDiscount([c], { kind: "grade_tier", key: "premium" }, 799, NOW)?.finalCents, 639);
});

Deno.test("liveCampaigns: only live rows, newest window first", () => {
  const a = campaign({ id: "a", starts_at: "2026-09-01T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" });
  const b = campaign({ id: "b", starts_at: "2026-09-10T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" });
  const dead = campaign({ id: "c", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-02-01T00:00:00Z" });
  assertEquals(liveCampaigns([a, dead, b], NOW).map((c) => c.id), ["b", "a"]);
  assertEquals(liveCampaigns([], NOW), []);
  assertEquals(liveCampaigns(null, NOW), []);
});
