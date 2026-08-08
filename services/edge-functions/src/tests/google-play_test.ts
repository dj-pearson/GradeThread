// Google Play Billing verification: product classification, Play API response
// parsing, the pure subscription→users-update, and the idempotent grant
// orchestration (dependency-injected, so no DB / live Play API needed).
import { assert, assertEquals, assertRejects } from "@std/assert";
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
  granted: Set<string>;
}

function fakeDeps(opts: {
  user?: GooglePlayBillingUser | null;
  info?: PlayPurchaseInfo;
  alreadyProcessed?: boolean;
  /** userId currently holding the subscription token (null = unbound). */
  tokenOwner?: string | null;
}): { deps: GooglePlayDeps; rec: Rec } {
  const rec: Rec = { applied: [], claims: 0, grants: [], events: 0, granted: new Set() };
  const deps: GooglePlayDeps = {
    verifyPurchase: () =>
      Promise.resolve(
        opts.info ??
          {
            valid: true,
            orderId: "GPA.x",
            expiryMillis: null,
            autoRenewing: false,
            obfuscatedExternalAccountId: null,
            productIds: [],
            environment: "production",
          },
      ),
    loadBillingUser: () =>
      Promise.resolve(
        opts.user === undefined
          ? { flipdesk_plan: "free", subscription_status: "none", billing_source: null, grade_credit_balance: 5 }
          : opts.user,
      ),
    findSubscriptionTokenOwner: () => Promise.resolve(opts.tokenOwner ?? null),
    applySubscription: (_u, update) => {
      rec.applied.push(update);
      return Promise.resolve();
    },
    claimConsumable: () => {
      rec.claims += 1;
      return Promise.resolve(!opts.alreadyProcessed);
    },
    grantCredits: (_u, credits, token) => {
      // Model grant_grade_credits idempotency on the googleplay:<token> key: a
      // repeat grant for an already-granted purchase does not add credits again,
      // it just returns the current balance. A purchase flagged alreadyProcessed
      // was granted in a prior request, so treat it as already-granted here.
      if (opts.alreadyProcessed || rec.granted.has(token)) {
        return Promise.resolve(100);
      }
      rec.granted.add(token);
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
    user: {
      flipdesk_plan: "pro",
      subscription_status: "active",
      billing_source: "stripe",
      grade_credit_balance: 0,
      flipdesk_subscription_id: "sub_123",
    },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_pro_monthly", purchaseToken: "t" },
    deps,
    NOW,
  );
  assert(!r.ok);
  assertEquals(r.reason, "blocked_active_stripe");
});

// US-1618 / C5: the gate is null-tolerant on billing_source (mirrors the App
// Store precedence) — an active Stripe sub identified by flipdesk_subscription_id
// blocks a Play purchase even before billing_source was ever stamped 'stripe'.
Deno.test("orchestration: active Stripe sub with null billing_source still blocks Play", async () => {
  const { deps } = fakeDeps({
    user: {
      flipdesk_plan: "pro",
      subscription_status: "active",
      billing_source: null,
      grade_credit_balance: 0,
      flipdesk_subscription_id: "sub_123",
    },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_pro_monthly", purchaseToken: "t" },
    deps,
    NOW,
  );
  assert(!r.ok);
  assertEquals(r.reason, "blocked_active_stripe");
});

// A Play purchase with NO Stripe subscription proceeds (no false block).
Deno.test("orchestration: no Stripe sub → Play subscription proceeds past the gate", async () => {
  const { deps } = fakeDeps({
    user: {
      flipdesk_plan: "free",
      subscription_status: "none",
      billing_source: null,
      grade_credit_balance: 0,
      flipdesk_subscription_id: null,
    },
    info: {
      valid: true,
      orderId: "GPA.s",
      expiryMillis: NOW + 86_400_000,
      autoRenewing: true,
      obfuscatedExternalAccountId: null,
      productIds: [],
      environment: "production",
    },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_pro_monthly", purchaseToken: "t" },
    deps,
    NOW,
  );
  assert(r.ok);
  assertEquals(r.plan, "pro");
});

Deno.test("orchestration: invalid purchase → rejected, nothing granted", async () => {
  const { deps, rec } = fakeDeps({
    info: {
      valid: false,
      orderId: null,
      expiryMillis: null,
      autoRenewing: false,
      obfuscatedExternalAccountId: null,
      productIds: [],
      environment: "production",
    },
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
    info: {
      valid: true,
      orderId: "GPA.s",
      expiryMillis: NOW + 86_400_000,
      autoRenewing: true,
      obfuscatedExternalAccountId: null,
      productIds: [],
      environment: "production",
    },
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

// ── Account binding (US-1614) ───────────────────────────────────────

Deno.test("parseSubscriptionV2 / parseProductPurchase surface obfuscatedExternalAccountId", () => {
  const sub = parseSubscriptionV2({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    externalAccountIdentifiers: { obfuscatedExternalAccountId: "user-abc" },
    lineItems: [{ expiryTime: "2026-08-01T00:00:00Z" }],
  });
  assertEquals(sub.obfuscatedExternalAccountId, "user-abc");
  const prod = parseProductPurchase({
    purchaseState: 0,
    orderId: "GPA.9",
    obfuscatedExternalAccountId: "user-xyz",
  });
  assertEquals(prod.obfuscatedExternalAccountId, "user-xyz");
  // Absent → null (older clients).
  assertEquals(parseProductPurchase({ purchaseState: 0 }).obfuscatedExternalAccountId, null);
});

Deno.test("binding: obfuscatedExternalAccountId for another user → account_mismatch, no grant", async () => {
  const { deps, rec } = fakeDeps({
    info: {
      valid: true,
      orderId: "GPA.s",
      expiryMillis: NOW + 86_400_000,
      autoRenewing: true,
      obfuscatedExternalAccountId: "someone-else",
      productIds: [],
      environment: "production",
    },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_pro_monthly", purchaseToken: "tok" },
    deps,
    NOW,
  );
  assert(!r.ok);
  assertEquals(r.reason, "account_mismatch");
  assertEquals(rec.applied.length, 0);
  assertEquals(rec.grants.length, 0);
});

Deno.test("binding: matching obfuscatedExternalAccountId → entitles the caller", async () => {
  const { deps, rec } = fakeDeps({
    info: {
      valid: true,
      orderId: "GPA.s",
      expiryMillis: NOW + 86_400_000,
      autoRenewing: true,
      obfuscatedExternalAccountId: "u1",
      productIds: [],
      environment: "production",
    },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_pro_monthly", purchaseToken: "tok" },
    deps,
    NOW,
  );
  assert(r.ok);
  assertEquals(r.plan, "pro");
  assertEquals(rec.applied.length, 1);
});

Deno.test("binding: subscription token already owned by another user → account_mismatch", async () => {
  const { deps, rec } = fakeDeps({ tokenOwner: "other-user" });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_pro_monthly", purchaseToken: "shared-tok" },
    deps,
    NOW,
  );
  assert(!r.ok);
  assertEquals(r.reason, "account_mismatch");
  assertEquals(rec.applied.length, 0);
});

Deno.test("binding: same-user re-verify (owner === caller) → renews normally", async () => {
  const { deps, rec } = fakeDeps({
    tokenOwner: "u1",
    info: {
      valid: true,
      orderId: "GPA.s",
      expiryMillis: NOW + 86_400_000,
      autoRenewing: true,
      obfuscatedExternalAccountId: null,
      productIds: [],
      environment: "production",
    },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_pro_monthly", purchaseToken: "tok" },
    deps,
    NOW,
  );
  assert(r.ok);
  assertEquals(rec.applied.length, 1);
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
  assertEquals(rec.grants.length, 0); // ...but no NET credits granted (idempotent)
});

// US-1920: a grant failure must leave the purchase reclaimable — no orphaned
// dedup row that would make the client's retry short-circuit to a stale balance
// with the credits never granted. Grant-first + idempotent grant means the
// buyer ends with exactly ONE net grant and the correct balance after retry.
Deno.test("orchestration: consumable grant throws once, succeeds on retry → exactly one grant", async () => {
  // Shared server-side state across the two verify calls (the real DB).
  const processed = new Set<string>(); // google_processed_purchases ledger
  const granted = new Map<string, number>(); // grant_grade_credits idempotency
  let balance = 5;
  let grantAttempts = 0;
  let failNextGrant = true;

  const deps: GooglePlayDeps = {
    verifyPurchase: () =>
      Promise.resolve({
        valid: true,
        orderId: "GPA.x",
        expiryMillis: null,
        autoRenewing: false,
        obfuscatedExternalAccountId: null,
        productIds: [],
        environment: "production",
      }),
    loadBillingUser: () =>
      Promise.resolve({
        flipdesk_plan: "free",
        subscription_status: "none",
        billing_source: null,
        grade_credit_balance: balance,
      }),
    findSubscriptionTokenOwner: () => Promise.resolve(null),
    applySubscription: () => Promise.resolve(),
    claimConsumable: (_u, _p, token) => {
      // ON CONFLICT DO NOTHING: true only if WE insert the dedup row.
      if (processed.has(token)) return Promise.resolve(false);
      processed.add(token);
      return Promise.resolve(true);
    },
    grantCredits: (_u, credits, token) => {
      grantAttempts += 1;
      if (failNextGrant) {
        failNextGrant = false;
        return Promise.reject(new Error("grant_grade_credits failed: transient"));
      }
      // Idempotent on the token: grant once, thereafter return the same balance.
      if (!granted.has(token)) {
        granted.set(token, credits);
        balance += credits;
      }
      return Promise.resolve(balance);
    },
    recordEvent: () => Promise.resolve(),
  };

  // First attempt: grant throws BEFORE the dedup row is written.
  await assertRejects(() =>
    processGooglePlayPurchase(
      { userId: "u1", productId: "credits_50", purchaseToken: "tok" },
      deps,
      NOW,
    )
  );
  assertEquals(processed.has("tok"), false); // no orphaned dedup row
  assertEquals(granted.size, 0); // nothing granted yet

  // Retry: grant succeeds, then the claim is recorded.
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "credits_50", purchaseToken: "tok" },
    deps,
    NOW,
  );
  assert(r.ok);
  assertEquals(r.kind, "consumable");
  assertEquals(grantAttempts, 2); // failed once, succeeded once
  assertEquals(granted.get("tok"), 50); // exactly one net grant
  assertEquals(r.creditsBalance, 55); // 5 + 50
  assertEquals(processed.has("tok"), true); // dedup row now recorded
});

// ── Tier comes from Google, not from the request body (US-2285) ──────
//
// The two verify paths are not equally safe, and the story's title understates
// which half is broken. A consumable is fetched from
// /purchases/products/{productId}/tokens/{token} — the productId is IN THE PATH,
// so Google refuses a token that isn't for that product. A subscription is
// fetched from /purchases/subscriptionsv2/tokens/{token}, TOKEN ONLY. The
// client's productId never reached Google, and parseSubscriptionV2 threw away
// the one field that said what was actually bought.
//
// So: buy flipdesk_starter_monthly, POST its purchaseToken with
// productId=flipdesk_business_yearly. Token valid, state active, obfuscated
// account id matches, token unclaimed — every gate passes and the server grants
// the business tier.

Deno.test("US-2285: parseSubscriptionV2 surfaces the productIds Google returned", () => {
  const r = parseSubscriptionV2({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    lineItems: [
      { productId: "flipdesk_starter_monthly", expiryTime: "2026-08-01T00:00:00Z" },
    ],
  });
  assertEquals(r.productIds, ["flipdesk_starter_monthly"]);
});

Deno.test("US-2285: every line item is surfaced, not just the first", () => {
  // A multi-line subscription genuinely entitles all of them; checking only
  // lineItems[0] would refuse a purchase the buyer really made.
  const r = parseSubscriptionV2({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    lineItems: [
      { productId: "flipdesk_starter_monthly" },
      { productId: "flipdesk_pro_monthly" },
    ],
  });
  assertEquals(r.productIds, ["flipdesk_starter_monthly", "flipdesk_pro_monthly"]);
});

Deno.test("US-2285: a consumable response has no productIds (the URL already bound it)", () => {
  assertEquals(parseProductPurchase({ purchaseState: 0, orderId: "GPA.2" }).productIds, []);
});

Deno.test("US-2285: THE ATTACK — cheap sub token replayed as the business tier is refused", async () => {
  const { deps, rec } = fakeDeps({
    info: {
      valid: true,
      orderId: "GPA.s",
      expiryMillis: NOW + 86_400_000,
      autoRenewing: true,
      obfuscatedExternalAccountId: "u1", // binding passes: it IS their purchase
      productIds: ["flipdesk_starter_monthly"], // ...of the cheapest plan
      environment: "production",
    },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_business_yearly", purchaseToken: "tok" },
    deps,
    NOW,
  );
  assert(!r.ok);
  assertEquals(r.reason, "product_mismatch");
  assertEquals(r.verifiedProductIds, ["flipdesk_starter_monthly"]);
  // Nothing was written: no plan applied, no event, no credits.
  assertEquals(rec.applied.length, 0);
  assertEquals(rec.events, 0);
  assertEquals(rec.grants.length, 0);
});

Deno.test("US-2285: the honest purchase still grants", async () => {
  const { deps, rec } = fakeDeps({
    info: {
      valid: true,
      orderId: "GPA.s",
      expiryMillis: NOW + 86_400_000,
      autoRenewing: true,
      obfuscatedExternalAccountId: null,
      productIds: ["flipdesk_business_yearly"],
      environment: "production",
    },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "flipdesk_business_yearly", purchaseToken: "tok" },
    deps,
    NOW,
  );
  assert(r.ok);
  assertEquals(r.plan, "business");
  assertEquals(rec.applied.length, 1);
});

Deno.test("US-2285: an empty productIds list is not a mismatch", async () => {
  // Consumables (URL-bound) and any response without lineItems land here.
  // Refusing on empty would break real purchases to defend a path Google
  // already defends — so the check is skipped, deliberately, not silently.
  const { deps, rec } = fakeDeps({
    info: {
      valid: true,
      orderId: "GPA.c",
      expiryMillis: null,
      autoRenewing: false,
      obfuscatedExternalAccountId: null,
      productIds: [],
      environment: "production",
    },
  });
  const r = await processGooglePlayPurchase(
    { userId: "u1", productId: "credits_10", purchaseToken: "tok-c" },
    deps,
    NOW,
  );
  assert(r.ok);
  assertEquals(rec.grants.length, 1);
});
