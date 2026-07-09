// US-1800: buyer entitlement resolution — the fail-safe gating contract.
// Pure (no DB): resolveBuyerEntitlements + buyerFeatureEnabled.
import { assert, assertEquals } from "@std/assert";
import {
  buyerFeatureEnabled,
  resolveBuyerEntitlements,
} from "../lib/buyer-entitlements.ts";
import { effectiveDigestMode } from "../lib/buyer-plans.ts";

// US-1803: the plan alertFrequency cap floors the buyer's chosen digest cadence.
Deno.test("effectiveDigestMode: plan cap floors the chosen cadence", () => {
  // Instant/hourly plans honor 'immediate'.
  assertEquals(effectiveDigestMode("immediate", "instant"), "immediate");
  assertEquals(effectiveDigestMode("immediate", "hourly"), "immediate");
  // A daily-capped (Free) plan batches 'immediate' down to 'daily'.
  assertEquals(effectiveDigestMode("immediate", "daily"), "daily");
  // Explicit daily/weekly choices pass through regardless of cap.
  assertEquals(effectiveDigestMode("daily", "instant"), "daily");
  assertEquals(effectiveDigestMode("weekly", "daily"), "weekly");
});

Deno.test("buyer allowances carry alertFrequency per tier", () => {
  assertEquals(resolveBuyerEntitlements("free", "none").allowances.alertFrequency, "daily");
  assertEquals(resolveBuyerEntitlements("guard", "active").allowances.alertFrequency, "hourly");
  assertEquals(resolveBuyerEntitlements("connoisseur", "active").allowances.alertFrequency, "instant");
});

Deno.test("resolveBuyerEntitlements: active paid plan grants its flags", () => {
  const guard = resolveBuyerEntitlements("guard", "active");
  assertEquals(guard.plan, "guard");
  assert(buyerFeatureEnabled(guard, "discrepancyScoring"));
  assert(buyerFeatureEnabled(guard, "purchaseGuarantee"));
  // Guard stops short of the Connoisseur-only surfaces.
  assertEquals(buyerFeatureEnabled(guard, "demandBoard"), false);
  assertEquals(guard.allowances.extensionChecksPerMonth, -1); // unlimited

  const con = resolveBuyerEntitlements("connoisseur", "trialing");
  assertEquals(con.plan, "connoisseur");
  assert(buyerFeatureEnabled(con, "demandBoard"));
  assert(buyerFeatureEnabled(con, "prioritySupport"));
});

Deno.test("resolveBuyerEntitlements: fails safe to Free for unknown/lapsed", () => {
  // Unknown plan string.
  assertEquals(resolveBuyerEntitlements("enterprise", "active").plan, "free");
  // Null / undefined.
  assertEquals(resolveBuyerEntitlements(null, null).plan, "free");
  assertEquals(resolveBuyerEntitlements(undefined, undefined).plan, "free");
  // A paid plan whose subscription is NOT active/trialing → deny paid caps.
  for (const status of ["past_due", "paused", "canceled", "none", ""]) {
    const ent = resolveBuyerEntitlements("guard", status);
    assertEquals(ent.plan, "free", `status=${status} must fall back to free`);
    assertEquals(buyerFeatureEnabled(ent, "discrepancyScoring"), false);
  }
});

Deno.test("resolveBuyerEntitlements: Free plan resolves regardless of status", () => {
  // Free never depends on a subscription being active.
  const free = resolveBuyerEntitlements("free", "none");
  assertEquals(free.plan, "free");
  // Free still carries its acquisition-tier flags.
  assert(buyerFeatureEnabled(free, "extensionSecondOpinion"));
  assert(buyerFeatureEnabled(free, "rewards"));
  assertEquals(buyerFeatureEnabled(free, "fitPrediction"), false);
  assertEquals(free.allowances.extensionChecksPerMonth, 10);
});

// US-1887: seller (FlipDesk) plans bundle tier-matched buyer functions.
Deno.test("resolveBuyerEntitlements: seller plan grants a tier-matched buyer plan", () => {
  // No buyer subscription — the seller plan alone drives the buyer tier.
  const noSub = { flipdeskPlan: null as string | null, flipdeskStatus: "none" as string | null };
  assertEquals(resolveBuyerEntitlements(null, null, { flipdeskPlan: "business", flipdeskStatus: "active" }).plan, "connoisseur");
  assertEquals(resolveBuyerEntitlements(null, null, { flipdeskPlan: "pro", flipdeskStatus: "active" }).plan, "guard");
  assertEquals(resolveBuyerEntitlements(null, null, { flipdeskPlan: "starter", flipdeskStatus: "active" }).plan, "guard");
  assertEquals(resolveBuyerEntitlements(null, null, { flipdeskPlan: "free", flipdeskStatus: "none" }).plan, "free");
  // Even a Free seller gets the extension (a Free buyer flag).
  assert(buyerFeatureEnabled(resolveBuyerEntitlements(null, null, noSub), "extensionSecondOpinion"));
});

Deno.test("resolveBuyerEntitlements: effective plan is the HIGHER of buyer sub and seller tier", () => {
  // Buyer sub beats a weaker seller tier.
  assertEquals(
    resolveBuyerEntitlements("connoisseur", "active", { flipdeskPlan: "starter", flipdeskStatus: "active" }).plan,
    "connoisseur",
  );
  // Seller tier beats a weaker buyer sub.
  assertEquals(
    resolveBuyerEntitlements("guard", "active", { flipdeskPlan: "business", flipdeskStatus: "active" }).plan,
    "connoisseur",
  );
  // Neither active → free.
  assertEquals(
    resolveBuyerEntitlements("guard", "canceled", { flipdeskPlan: "business", flipdeskStatus: "canceled" }).plan,
    "free",
  );
});

Deno.test("resolveBuyerEntitlements: a lapsed seller loses the seller-derived bump", () => {
  // Paused seller → no bump; falls back to the buyer sub (here none → free).
  assertEquals(
    resolveBuyerEntitlements(null, null, { flipdeskPlan: "business", flipdeskStatus: "paused" }).plan,
    "free",
  );
  // But a buyer subscription still stands on its own when the seller lapses.
  assertEquals(
    resolveBuyerEntitlements("guard", "active", { flipdeskPlan: "business", flipdeskStatus: "canceled" }).plan,
    "guard",
  );
});
