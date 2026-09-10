// US-3299 — the sale resolver.
//
// These vectors are duplicated verbatim in
// services/edge-functions/src/tests/discount-campaigns_test.ts. The two
// implementations cannot share a file (browser vs Deno), so the vectors are what
// stops them drifting. Change one, change both.
import { describe, expect, it } from "vitest";
import {
  campaignMatches,
  discountedCents,
  formatDiscountLabel,
  isCampaignLive,
  liveCampaigns,
  resolveDiscount,
  type DiscountCampaign,
} from "@/lib/discounts";

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

describe("isCampaignLive", () => {
  it("is live inside the window", () => {
    expect(isCampaignLive(campaign(), NOW)).toBe(true);
  });

  it("is not live before the window", () => {
    expect(isCampaignLive(campaign(), Date.parse("2026-09-08T23:59:59Z"))).toBe(false);
  });

  it("is live exactly at starts_at and dead exactly at ends_at", () => {
    const c = campaign({ starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-20T00:00:00Z" });
    expect(isCampaignLive(c, Date.parse("2026-11-01T00:00:00Z"))).toBe(true);
    expect(isCampaignLive(c, Date.parse("2026-11-20T00:00:00Z"))).toBe(false);
  });

  it("is not live when disabled", () => {
    expect(isCampaignLive(campaign({ enabled: false }), NOW)).toBe(false);
  });

  // The single most costly failure this feature can have: a card advertising a
  // discount that Stripe then refuses at checkout.
  it("is not live without a synced Stripe coupon", () => {
    expect(isCampaignLive(campaign({ stripe_coupon_id: null }), NOW)).toBe(false);
  });

  it("is not live on an unparseable date", () => {
    expect(isCampaignLive(campaign({ ends_at: "not-a-date" }), NOW)).toBe(false);
  });
});

describe("campaignMatches", () => {
  it("applies_to_all matches every kind", () => {
    const c = campaign({ applies_to_all: true, targets: [] });
    expect(campaignMatches(c, { kind: "grade_tier", key: "premium" })).toBe(true);
    expect(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "yearly" })).toBe(true);
  });

  it("matches a listed kind and key", () => {
    const c = campaign({
      applies_to_all: false,
      targets: [{ kind: "flipdesk_plan", key: "pro" }],
    });
    expect(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "monthly" })).toBe(true);
    expect(campaignMatches(c, { kind: "flipdesk_plan", key: "starter", interval: "monthly" })).toBe(false);
    expect(campaignMatches(c, { kind: "buyer_plan", key: "pro", interval: "monthly" })).toBe(false);
  });

  it("a target with no interval covers both intervals", () => {
    const c = campaign({ applies_to_all: false, targets: [{ kind: "flipdesk_plan", key: "pro" }] });
    expect(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "monthly" })).toBe(true);
    expect(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "yearly" })).toBe(true);
  });

  it("a target WITH an interval covers only that interval", () => {
    const c = campaign({
      applies_to_all: false,
      targets: [{ kind: "flipdesk_plan", key: "pro", interval: "yearly" }],
    });
    expect(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "yearly" })).toBe(true);
    expect(campaignMatches(c, { kind: "flipdesk_plan", key: "pro", interval: "monthly" })).toBe(false);
  });

  it("compares keys as strings, so a numeric pack size still matches", () => {
    const c = campaign({
      applies_to_all: false,
      targets: [{ kind: "credit_pack", key: "25" }],
    });
    expect(campaignMatches(c, { kind: "credit_pack", key: "25" })).toBe(true);
  });
});

describe("discountedCents", () => {
  it("takes 20% off $29.00", () => {
    expect(discountedCents(campaign({ percent_off: 20 }), 2900)).toBe(2320);
  });

  it("rounds to the nearest cent", () => {
    // 299 * 0.8 = 239.2
    expect(discountedCents(campaign({ percent_off: 20 }), 299)).toBe(239);
    // 1299 * 0.85 = 1104.15
    expect(discountedCents(campaign({ percent_off: 15 }), 1299)).toBe(1104);
  });

  it("takes a flat amount off", () => {
    const c = campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 500 });
    expect(discountedCents(c, 2900)).toBe(2400);
  });

  it("floors at zero rather than going negative", () => {
    const c = campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 50_000 });
    expect(discountedCents(c, 2900)).toBe(0);
  });

  it("100% off is free, not negative", () => {
    expect(discountedCents(campaign({ percent_off: 100 }), 2900)).toBe(0);
  });

  it("leaves a zero price alone", () => {
    expect(discountedCents(campaign({ percent_off: 20 }), 0)).toBe(0);
  });
});

describe("formatDiscountLabel", () => {
  it("drops trailing zeros on a whole percent", () => {
    expect(formatDiscountLabel(campaign({ percent_off: 20 }))).toBe("20% off");
  });

  it("keeps a fractional percent", () => {
    expect(formatDiscountLabel(campaign({ percent_off: 12.5 }))).toBe("12.5% off");
  });

  it("formats whole dollars without cents", () => {
    const c = campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 500 });
    expect(formatDiscountLabel(c)).toBe("$5 off");
  });

  it("formats part-dollars with cents", () => {
    const c = campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 250 });
    expect(formatDiscountLabel(c)).toBe("$2.50 off");
  });
});

describe("resolveDiscount", () => {
  it("returns null with no campaigns", () => {
    expect(resolveDiscount([], { kind: "grade_tier", key: "standard" }, 299, NOW)).toBeNull();
    expect(resolveDiscount(null, { kind: "grade_tier", key: "standard" }, 299, NOW)).toBeNull();
  });

  it("prices the brief's example: 20% off everything", () => {
    const got = resolveDiscount([campaign()], { kind: "flipdesk_plan", key: "pro", interval: "monthly" }, 5900, NOW);
    expect(got).not.toBeNull();
    expect(got?.finalCents).toBe(4720);
    expect(got?.savedCents).toBe(1180);
    expect(got?.label).toBe("20% off");
  });

  // Owner decision 2026-09-09: no "20% off $0" badge on a free tier.
  it("skips a zero price", () => {
    expect(resolveDiscount([campaign()], { kind: "flipdesk_plan", key: "free", interval: "monthly" }, 0, NOW))
      .toBeNull();
  });

  it("skips a campaign that saves nothing", () => {
    const c = campaign({ discount_type: "amount", percent_off: null, amount_off_cents: 1 });
    // 1 cent off 299 saves 1 cent, so that DOES resolve; a 0-value one cannot
    // exist (check constraint), so the guard is about rounding to nothing.
    expect(resolveDiscount([c], { kind: "grade_tier", key: "standard" }, 299, NOW)?.savedCents).toBe(1);
    const tiny = campaign({ percent_off: 0.01 });
    // 299 * 0.9999 rounds back to 299 — no saving, so no badge.
    expect(resolveDiscount([tiny], { kind: "grade_tier", key: "standard" }, 299, NOW)).toBeNull();
  });

  it("ignores an expired campaign and picks the one that follows it", () => {
    const fall = campaign({ id: "a", percent_off: 20, starts_at: "2026-09-09T00:00:00Z", ends_at: "2026-11-01T00:00:00Z" });
    const nov = campaign({ id: "b", percent_off: 15, starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-20T00:00:00Z" });
    const target = { kind: "flipdesk_plan" as const, key: "starter", interval: "monthly" as const };

    const during = resolveDiscount([fall, nov], target, 2900, Date.parse("2026-10-15T00:00:00Z"));
    expect(during?.campaign.id).toBe("a");
    expect(during?.finalCents).toBe(2320);

    const after = resolveDiscount([fall, nov], target, 2900, Date.parse("2026-11-05T00:00:00Z"));
    expect(after?.campaign.id).toBe("b");
    expect(after?.finalCents).toBe(2465);

    const later = resolveDiscount([fall, nov], target, 2900, Date.parse("2026-12-01T00:00:00Z"));
    expect(later).toBeNull();
  });

  it("on an overlap the biggest saving wins, whatever the array order", () => {
    const small = campaign({ id: "a", percent_off: 10 });
    const big = campaign({ id: "b", percent_off: 30 });
    const target = { kind: "grade_tier" as const, key: "express" };
    expect(resolveDiscount([small, big], target, 1299, NOW)?.campaign.id).toBe("b");
    expect(resolveDiscount([big, small], target, 1299, NOW)?.campaign.id).toBe("b");
  });

  it("breaks a tie on the later start, then the id, deterministically", () => {
    const older = campaign({ id: "zzz", percent_off: 20, starts_at: "2026-09-01T00:00:00Z" });
    const newer = campaign({ id: "aaa", percent_off: 20, starts_at: "2026-09-10T00:00:00Z" });
    const target = { kind: "grade_tier" as const, key: "standard" };
    expect(resolveDiscount([older, newer], target, 299, NOW)?.campaign.id).toBe("aaa");
    expect(resolveDiscount([newer, older], target, 299, NOW)?.campaign.id).toBe("aaa");

    const sameStart = campaign({ id: "bbb", percent_off: 20, starts_at: "2026-09-10T00:00:00Z" });
    expect(resolveDiscount([sameStart, newer], target, 299, NOW)?.campaign.id).toBe("aaa");
    expect(resolveDiscount([newer, sameStart], target, 299, NOW)?.campaign.id).toBe("aaa");
  });

  it("does not apply a campaign aimed elsewhere", () => {
    const c = campaign({ applies_to_all: false, targets: [{ kind: "grade_tier", key: "premium" }] });
    expect(resolveDiscount([c], { kind: "grade_tier", key: "standard" }, 299, NOW)).toBeNull();
    expect(resolveDiscount([c], { kind: "grade_tier", key: "premium" }, 799, NOW)?.finalCents).toBe(639);
  });
});

describe("liveCampaigns", () => {
  it("returns only live rows, newest window first", () => {
    const a = campaign({ id: "a", starts_at: "2026-09-01T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" });
    const b = campaign({ id: "b", starts_at: "2026-09-10T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" });
    const dead = campaign({ id: "c", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-02-01T00:00:00Z" });
    expect(liveCampaigns([a, dead, b], NOW).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("is empty when nothing is running", () => {
    expect(liveCampaigns([], NOW)).toEqual([]);
    expect(liveCampaigns(null, NOW)).toEqual([]);
  });
});
