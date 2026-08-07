import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AFFILIATE_ACQUISITION_SOURCE,
  BUYER_FUNNEL_STEPS,
  BUYER_TRACKED_FEATURES,
  buyerAcquisitionProps,
  buyerFunnelEventName,
  buyerFunnelStepIndex,
  buyerMrrCents,
  DIRECT_ACQUISITION_SOURCE,
  trackBuyerFeature,
} from "../buyer-analytics";
import { acceptAll, rejectAll } from "../analytics";
import { BUYER_PLANS } from "../constants";
import type { StoredUtm } from "../ad-attribution";

function utm(first: Record<string, string>, last = first): StoredUtm {
  return {
    first: { ...first, landingAt: "2026-01-01T00:00:00.000Z" },
    last: { ...last, landingAt: "2026-02-01T00:00:00.000Z" },
    persisted: false,
  };
}

describe("buyer funnel vocabulary", () => {
  it("keeps the shipped US-1843 event names intact", () => {
    // Renaming either orphans its PostHog history.
    expect(buyerFunnelEventName("cta")).toBe("buyer_funnel_cta");
    expect(buyerFunnelEventName("claimed")).toBe("buyer_funnel_claimed");
    expect(buyerFunnelEventName("claim_dismissed")).toBe("buyer_funnel_claim_dismissed");
  });

  it("orders the steps and puts exits outside the order", () => {
    expect(buyerFunnelStepIndex("tool_result")).toBe(0);
    expect(buyerFunnelStepIndex("signup")).toBeGreaterThan(buyerFunnelStepIndex("cta"));
    expect(buyerFunnelStepIndex("subscribed")).toBeGreaterThan(
      buyerFunnelStepIndex("subscribe_start"),
    );
    // An exit must never read as progress.
    expect(buyerFunnelStepIndex("claim_dismissed")).toBe(-1);
  });

  it("has no duplicate step names", () => {
    expect(new Set(BUYER_FUNNEL_STEPS).size).toBe(BUYER_FUNNEL_STEPS.length);
  });
});

describe("acquisition attribution", () => {
  it("buckets on FIRST touch, not last", () => {
    const props = buyerAcquisitionProps(
      utm({ utm_source: "newsletter", utm_medium: "email" }, { utm_source: "twitter" }),
      null,
    );
    expect(props.acquisition_source).toBe("newsletter");
    expect(props.acquisition_medium).toBe("email");
    expect(props.acquisition_last_source).toBe("twitter");
  });

  it("falls back to the earned link when there is no UTM", () => {
    const props = buyerAcquisitionProps(null, "REF123");
    expect(props.acquisition_source).toBe(AFFILIATE_ACQUISITION_SOURCE);
    expect(props.affiliate_ref).toBe("REF123");
  });

  it("falls back to direct when there is neither", () => {
    expect(buyerAcquisitionProps(null, null).acquisition_source).toBe(
      DIRECT_ACQUISITION_SOURCE,
    );
  });

  it("prefers the UTM over the ref, and still carries the ref", () => {
    const props = buyerAcquisitionProps(utm({ utm_source: "google" }), "REF123");
    expect(props.acquisition_source).toBe("google");
    expect(props.affiliate_ref).toBe("REF123");
  });
});

describe("buyerMrrCents", () => {
  it("counts a yearly subscription at a twelfth of its yearly price", () => {
    const cents = buyerMrrCents([
      { plan: "guard", interval: "yearly", users: 12, status: "active" },
    ]);
    expect(cents).toBe(BUYER_PLANS.guard.priceYearlyCents);
  });

  it("counts monthly at face value and sums across tiers", () => {
    const cents = buyerMrrCents([
      { plan: "guard", interval: "monthly", users: 2, status: "active" },
      { plan: "connoisseur", interval: "monthly", users: 1, status: "trialing" },
    ]);
    expect(cents).toBe(
      BUYER_PLANS.guard.priceMonthlyCents * 2 + BUYER_PLANS.connoisseur.priceMonthlyCents,
    );
  });

  it("ignores lapsed subscriptions and the free tier", () => {
    const cents = buyerMrrCents([
      { plan: "guard", interval: "monthly", users: 5, status: "canceled" },
      { plan: "guard", interval: "monthly", users: 5, status: "past_due" },
      { plan: "free", interval: "none", users: 500, status: "active" },
    ]);
    expect(cents).toBe(0);
  });

  it("counts rows with no status (already filtered to live subs)", () => {
    expect(buyerMrrCents([{ plan: "guard", interval: "monthly", users: 1 }])).toBe(
      BUYER_PLANS.guard.priceMonthlyCents,
    );
  });

  it("ignores an unknown plan key rather than throwing", () => {
    expect(buyerMrrCents([{ plan: "platinum", interval: "monthly", users: 3 }])).toBe(0);
  });
});

describe("consent gating", () => {
  const capture = vi.fn();

  beforeEach(() => {
    capture.mockClear();
    localStorage.clear();
    sessionStorage.clear();
    (window as unknown as { posthog?: unknown }).posthog = { capture };
  });

  it("stores no activation marker when analytics is declined", () => {
    // The capture gate itself is posthog never being INITIALIZED without
    // consent (analytics.ts). What this module owns is not writing storage on
    // a declined visitor, which is what the marker would be.
    rejectAll();
    trackBuyerFeature("alerts", "created");
    expect(sessionStorage.getItem("gt_buyer_activated")).toBeNull();
  });

  it("derives `activated` from the FIRST feature use of a session only", () => {
    acceptAll();
    trackBuyerFeature("alerts", "created");
    trackBuyerFeature("portfolio", "item_added");
    const names = capture.mock.calls.map((c) => c[0] as string);
    expect(names.filter((n) => n === "buyer_funnel_activated")).toHaveLength(1);
    expect(names.filter((n) => n === "buyer_feature_used")).toHaveLength(2);
  });

  it("does not derive `activated` when analytics is declined", () => {
    rejectAll();
    trackBuyerFeature("alerts", "created");
    const names = capture.mock.calls.map((c) => c[0] as string);
    expect(names).not.toContain("buyer_funnel_activated");
  });

  it("attaches the feature key and acquisition source to every feature event", () => {
    acceptAll();
    trackBuyerFeature("wants", "created", { matched: 2 });
    const call = capture.mock.calls.find((c) => c[0] === "buyer_feature_used");
    expect(call?.[1]).toMatchObject({
      feature: "wants",
      action: "created",
      matched: 2,
      acquisition_source: DIRECT_ACQUISITION_SOURCE,
    });
  });

  it("names every tracked feature exactly once", () => {
    expect(new Set(BUYER_TRACKED_FEATURES).size).toBe(BUYER_TRACKED_FEATURES.length);
  });
});

describe("web ↔ edge feature-key parity", () => {
  // The edge captures the server-observed half of the same feature stream. A key
  // that exists on one side only is a feature whose PostHog series and whose
  // admin adoption tile count different things — and nothing else compares them,
  // because the two lists are separate declarations across a project boundary.
  it("declares the same feature keys, in the same order", () => {
    const edge = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/buyer-analytics.ts"),
      "utf8",
    );
    const block = edge.match(/BUYER_TRACKED_FEATURES = \[([\s\S]*?)\] as const;/);
    if (!block) throw new Error("BUYER_TRACKED_FEATURES not found in the edge module");
    const edgeKeys = [...(block[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(edgeKeys).toEqual([...BUYER_TRACKED_FEATURES]);
  });
});
