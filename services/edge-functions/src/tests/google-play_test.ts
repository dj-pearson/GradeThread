// Google Play Billing verification: product classification, Play API response
// parsing, the pure subscription→users-update, and the idempotent grant
// orchestration (dependency-injected, so no DB / live Play API needed).
import { assert, assertEquals } from "@std/assert";
import {
  classifyAndroidProduct,
  computeGoogleUserUpdate,
} from "../lib/google-play/products.ts";
import {
  type GooglePlayBillingUser,
  type GooglePlayDeps,
  parseProductPurchase,
  parseSubscriptionV2,
  type PlayPurchaseInfo,
  processGooglePlayPurchase,
} from "../lib/google-play/verify.ts";

// ── Catalog ─────────────────────────────────────────────────────────

Deno.test("classifyAndroidProduct maps subs + consumables; unknown → null", () => {
  assertEquals(classifyAndroidProduct("flipdesk_pro_monthly"), {
    kind: "subscription",
    plan: "pro",
    interval: "monthly",
  });
  assertEquals(classifyAndroidProduct("credits_25"), { kind: "consumable", credits: 25 });
  assertEquals(classifyAndroidProduct("com.gradethread.sub.pro.monthly"), null); // iOS id
  assertEquals(classifyAndroidProduct("nope"), null);
});

// ── Play API response parsing ───────────────────────────────────────

Deno.test("parseSubscriptionV2: active → valid with expiry + auto-renew", () => {
  const r = parseSubscriptionV2({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    latestOrderId: "GPA.1",
    lineItems: [
      { expiryTime: "2026-08-01T00:00:00Z", autoRenewingPlan: { autoRenewEnabled: true } },
    ],
  });
  assert(r.valid);
  assertEquals(r.orderId, "GPA.1");
  assertEquals(r.expiryMillis, Date.parse("2026-08-01T00:00:00Z"));
  assert(r.autoRenewing);
});

Deno.test("parseSubscriptionV2: canceled/expired state → invalid", () => {
  const r = parseSubscriptionV2({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", lineItems: [] });
  assert(!r.valid);
});

Deno.test("parseProductPurchase: purchaseState 0 → valid; 1 → invalid", () => {
  assert(parseProductPurchase({ purchaseState: 0, orderId: "GPA.2" }).valid);
  assert(!parseProductPurchase({ purchaseState: 1 }).valid);
  assertEquals(parseProductPurchase({ purchaseState: 0, orderId: "GPA.2" }).orderId, "GPA.2");
});

// ── Pure subscription → users update ────────────────────────────────

Deno.test("computeGoogleUserUpdate: active future expiry → plan set", () => {
  const now = 1_700_000_000_000;
  const u = computeGoogleUserUpdate({
    mapping: { kind: "subscription", plan: "starter", interval: "yearly" },
    productId: "flipdesk_starter_yearly",
    purchaseToken: "tok",
    expiryMillis: now + 86_400_000,
    autoRenewing: true,
    now,
  });
  assertEquals(u.flipdesk_plan, "starter");
  assertEquals(u.flipdesk_interval, "yearly");
  assertEquals(u.subscription_status, "active");
  assertEquals(u.billing_source, "googleplay");
  assertEquals(u.google_purchase_token, "tok");
  assertEquals(u.flipdesk_cancel_at_period_end, false);
});

Deno.test("computeGoogleUserUpdate: past expiry → free/canceled; auto-renew off → cancel_at_period_end", () => {
  const now = 1_700_000_000_000;
  const expired = computeGoogleUserUpdate({
    mapping: { kind: "subscription", plan: "pro", interval: "monthly" },
    productId: "flipdesk_pro_monthly",
    purchaseToken: "tok",
    expiryMillis: now - 1,
    autoRenewing: false,
    now,
  });
  assertEquals(expired.flipdesk_plan, "free");
  assertEquals(expired.subscription_status, "canceled");
  assertEquals(expired.flipdesk_cancel_at_period_end, true);
});

// ── Orchestration (DI) ──────────────────────────────────────────────

interface Rec {
  applied: unknown[];
  claims: number;
  grants: Array<{ credits: number; token: string }>;
  events: number;
}

function fakeDeps(opts: {
  user?: GooglePlayBillingUser | null;
  info?: PlayPurchaseInfo;
  alreadyProcessed?: boolean;
}): { deps: GooglePlayDeps; rec: Rec } {
  const rec: Rec = { applied: [], claims: 0, grants: [], events: 0 };
  const deps: GooglePlayDeps = {
    verifyPurchase: () =>
      Promise.resolve(
        opts.info ?? { valid: true, orderId: "GPA.x", expiryMillis: null, autoRenewing: false },
      ),
    loadBillingUser: () =>
      Promise.resolve(
        opts.user === undefined
          ? { flipdesk_plan: "free", subscription_status: "none", billing_source: null, grade_credit_balance: 5 }
          : opts.user,
      ),
    applySubscription: (_u, update) => {
      rec.applied.push(update);
      return Promise.resolve();
    },
    claimConsumable: () => {
      rec.claims += 1;
      return Promise.resolve(!opts.alreadyProcessed);
    },
    grantCredits: (_u, credits, token) => {
      rec.grants.push({ credits, token });
      return Promise.resolve(100);
    },
    recordEvent: () => {
      rec.events += 1;
      return Promise.resolve();
    },
  };
  return { deps, rec };
}

const NOW = 1_700_000_000_000;

Deno.test("orchestration: unknown product → rejected, no side effects", async () => {
  const { deps, rec } = fakeDeps({});
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "bogus", purchaseToken: "t" },
    deps,
    NOW,
  );
  assert(!r.ok);
  assertEquals(r.reason, "unknown_product");
  assertEquals(rec.grants.length, 0);
});

Deno.test("orchestration: user not found → rejected", async () => {
  const { deps } = fakeDeps({ user: null });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "credits_10", purchaseToken: "t" },
    deps,
    NOW,
  );
  assert(!r.ok);
  assertEquals(r.reason, "user_not_found");
});

Deno.test("orchestration: active Stripe sub blocks a Play subscription", async () => {
  const { deps } = fakeDeps({
    user: { flipdesk_plan: "pro", subscription_status: "active", billing_source: "stripe", grade_credit_balance: 0 },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_pro_monthly", purchaseToken: "t" },
    deps,
    NOW,
  );
  assert(!r.ok);
  assertEquals(r.reason, "blocked_active_stripe");
});

Deno.test("orchestration: invalid purchase → rejected, nothing granted", async () => {
  const { deps, rec } = fakeDeps({
    info: { valid: false, orderId: null, expiryMillis: null, autoRenewing: false },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "credits_10", purchaseToken: "t" },
    deps,
    NOW,
  );
  assert(!r.ok);
  assertEquals(r.reason, "invalid_purchase");
  assertEquals(rec.grants.length, 0);
});

Deno.test("orchestration: valid subscription → plan applied + event recorded", async () => {
  const { deps, rec } = fakeDeps({
    info: { valid: true, orderId: "GPA.s", expiryMillis: NOW + 86_400_000, autoRenewing: true },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_business_yearly", purchaseToken: "tok" },
    deps,
    NOW,
  );
  assert(r.ok);
  assertEquals(r.kind, "subscription");
  assertEquals(r.plan, "business");
  assertEquals(r.interval, "yearly");
  assertEquals(rec.applied.length, 1);
  assertEquals(rec.events, 1);
});

Deno.test("orchestration: valid consumable (new) → credits granted exactly once", async () => {
  const { deps, rec } = fakeDeps({});
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "credits_50", purchaseToken: "tok" },
    deps,
    NOW,
  );
  assert(r.ok);
  assertEquals(r.kind, "consumable");
  assertEquals(rec.claims, 1);
  assertEquals(rec.grants.length, 1);
  assertEquals(rec.grants[0]!.credits, 50);
  assertEquals(r.creditsBalance, 100);
});

Deno.test("orchestration: replayed consumable → idempotent (no second grant)", async () => {
  const { deps, rec } = fakeDeps({ alreadyProcessed: true });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "credits_50", purchaseToken: "tok" },
    deps,
    NOW,
  );
  assert(r.ok);
  assertEquals(r.reason, "already_processed");
  assertEquals(rec.claims, 1); // gate consulted...
  assertEquals(rec.grants.length, 0); // ...but no credits granted
});
