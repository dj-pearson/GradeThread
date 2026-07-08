// US-1800: buyer entitlement resolution — the fail-safe gating contract.
// Pure (no DB): resolveBuyerEntitlements + buyerFeatureEnabled.
import { assert, assertEquals } from "@std/assert";
import {
  buyerFeatureEnabled,
  resolveBuyerEntitlements,
} from "../lib/buyer-entitlements.ts";

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
