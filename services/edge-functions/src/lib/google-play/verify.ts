// Google Play purchase verification + the idempotent grant orchestration — the
// Android counterpart to lib/appstore/verify.ts + the appstore verify route's
// glue. Validates a Play purchase token against the Google Play Developer API
// (using the shared service-account OAuth helper) and flips the SAME plan/credit
// state. No-ops cleanly when unconfigured (mirrors apns/fcm/appstore).
//
// Pattern: verify (impure, DI) → classify/compute (pure, tested) → write
// (impure, DI). The orchestration `processGooglePlayPurchase` is fully
// dependency-injected so it's unit-testable without a DB or the live Play API.
//
// Config (optional — verify throws a clean error when unset; the route maps it
// to a 503):
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON  the Play Developer service-account key
//   GOOGLE_PLAY_PACKAGE_NAME          e.g. com.gradethread.app

import {
  getAccessToken,
  parseServiceAccount,
  type ServiceAccount,
} from "../google-service-account.ts";
import {
  classifyAndroidProduct,
  computeGoogleUserUpdate,
  type GoogleUsersBillingUpdate,
} from "./products.ts";
import {
  appstoreSubscriptionActive,
  decideAppstorePrecedence,
} from "../appstore/precedence.ts";
import {
  type BillingEnvironment,
  resolvePlayEnvironment,
} from "../billing-environment.ts";

const ANDROIDPUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

function playConfig(): { sa: ServiceAccount; packageName: string } | null {
  const sa = parseServiceAccount(Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"));
  if (!sa) return null;
  const packageName = (Deno.env.get("GOOGLE_PLAY_PACKAGE_NAME") ?? "").trim();
  if (!packageName) return null;
  return { sa, packageName };
}

export function isGooglePlayConfigured(): boolean {
  return playConfig() !== null;
}

/** Normalized result of validating a purchase token. */
export interface PlayPurchaseInfo {
  /** The purchase is in a state that entitles the user (purchased / active). */
  valid: boolean;
  orderId: string | null;
  /** Subscription expiry (epoch ms), or null for consumables. */
  expiryMillis: number | null;
  /** Subscriptions: whether auto-renew is on (false = cancelled, access to end). */
  autoRenewing: boolean;
  /**
   * The obfuscatedExternalAccountId the Android client stamped on the purchase
   * (BillingFlowParams.setObfuscatedAccountId = the GradeThread userId), echoed
   * back by the Play Developer API. Used to bind a purchase to exactly one
   * account so a shared token can't entitle N accounts (US-1614). null when the
   * client didn't set it (older builds) — the binding falls back to the
   * per-token uniqueness claim on users.google_purchase_token.
   */
  obfuscatedExternalAccountId: string | null;
  /**
   * US-2285: the product(s) Google says were ACTUALLY bought, off the verified
   * response — `lineItems[].productId` on subscriptionsv2.
   *
   * This exists because the two verify paths are not equally safe. A consumable
   * is fetched at /purchases/products/{productId}/tokens/{token}: the productId
   * is IN THE PATH, so Google itself refuses a token that doesn't belong to it.
   * A subscription is fetched at /purchases/subscriptionsv2/tokens/{token} —
   * TOKEN ONLY. The client's productId never reaches Google on that path, so
   * the tier has to be checked against what comes back instead.
   *
   * Empty for consumables (the path already bound it) and for a response with
   * no lineItems, which is why the caller treats empty as "nothing to check"
   * rather than as a mismatch.
   */
  productIds: string[];
  /**
   * US-2286: whether Google says this was a licence-tester purchase.
   *
   * Both parsers were dropping the signal at parse time — the structural views
   * simply did not declare the field, so a test purchase arrived indexed as an
   * ordinary one and granted a real plan that revenue reporting then counted.
   * Like the Apple half this MARKS rather than refuses: a Play licence tester
   * is a legitimate pre-release flow and refusing it would break the same
   * review cycle Apple's sandbox fallback exists for.
   */
  environment: BillingEnvironment;
}

// ── Response parsing (pure, exported for tests) ─────────────────────

const ACTIVE_SUBSCRIPTION_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
]);

/** Parse a Play Developer API subscriptionsv2 purchase response. */
export function parseSubscriptionV2(json: unknown): PlayPurchaseInfo {
  const o = (json ?? {}) as {
    subscriptionState?: string;
    latestOrderId?: string;
    externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
    // US-2286: present (as an empty object) only when a licence tester made the
    // purchase. Absent on a real one — so its PRESENCE is the signal and the
    // field must be declared here or the whole signal is lost at parse.
    testPurchase?: unknown;
    lineItems?: Array<{
      productId?: string;
      expiryTime?: string;
      autoRenewingPlan?: { autoRenewEnabled?: boolean };
    }>;
  };
  const valid = ACTIVE_SUBSCRIPTION_STATES.has(o.subscriptionState ?? "");
  const line = o.lineItems?.[0];
  const expiryMillis = line?.expiryTime ? Date.parse(line.expiryTime) : null;
  return {
    valid,
    orderId: o.latestOrderId ?? null,
    expiryMillis: Number.isFinite(expiryMillis) ? (expiryMillis as number) : null,
    autoRenewing: line?.autoRenewingPlan?.autoRenewEnabled === true,
    obfuscatedExternalAccountId:
      o.externalAccountIdentifiers?.obfuscatedExternalAccountId?.trim() || null,
    // EVERY line item, not lineItems[0]: a multi-line subscription genuinely
    // entitles all of them, so checking only the first would refuse a purchase
    // the buyer really made.
    productIds: (o.lineItems ?? [])
      .map((l) => l.productId?.trim())
      .filter((p): p is string => Boolean(p)),
    environment: resolvePlayEnvironment({ testPurchase: o.testPurchase }),
  };
}

/** Parse a Play Developer API products purchase response. purchaseState 0 =
 * Purchased, 1 = Canceled, 2 = Pending. */
export function parseProductPurchase(json: unknown): PlayPurchaseInfo {
  const o = (json ?? {}) as {
    purchaseState?: number;
    orderId?: string;
    obfuscatedExternalAccountId?: string;
    // US-2286: 0 = Test, 1 = Promo, 2 = Rewarded. ABSENT on an ordinary paid
    // purchase, which is why only an explicit 0 classifies as sandbox.
    purchaseType?: number;
  };
  return {
    valid: o.purchaseState === 0,
    orderId: o.orderId ?? null,
    expiryMillis: null,
    autoRenewing: false,
    obfuscatedExternalAccountId: o.obfuscatedExternalAccountId?.trim() || null,
    // Empty by design: this response is fetched from a URL with the productId in
    // the path, so Google has already bound the token to the product.
    productIds: [],
    environment: resolvePlayEnvironment({ purchaseType: o.purchaseType ?? null }),
  };
}

/**
 * Validate a purchase token against the Google Play Developer API. `fetchFn` is
 * injectable for tests. Throws when unconfigured or on a non-OK API response.
 */
export async function verifyGooglePlayPurchase(
  productId: string,
  purchaseToken: string,
  kind: "subscription" | "consumable",
  fetchFn: typeof fetch = fetch,
): Promise<PlayPurchaseInfo> {
  const cfg = playConfig();
  if (!cfg) {
    throw new Error(
      "Google Play not configured (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON / GOOGLE_PLAY_PACKAGE_NAME)",
    );
  }
  const token = await getAccessToken(cfg.sa, ANDROIDPUBLISHER_SCOPE);
  const base =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${
      encodeURIComponent(cfg.packageName)
    }`;
  const url = kind === "subscription"
    ? `${base}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`
    : `${base}/purchases/products/${encodeURIComponent(productId)}/tokens/${
      encodeURIComponent(purchaseToken)
    }`;
  const res = await fetchFn(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Play Developer API ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  return kind === "subscription" ? parseSubscriptionV2(json) : parseProductPurchase(json);
}

// ── Grant orchestration (dependency-injected) ───────────────────────

export interface GooglePlayContext {
  userId: string;
  productId: string;
  purchaseToken: string;
}

export interface GooglePlayBillingUser {
  flipdesk_plan: string | null;
  subscription_status: string | null;
  billing_source: string | null;
  grade_credit_balance: number | null;
  // US-1618 / C5: the primary "has an entitling Stripe subscription" signal for
  // the double-billing gate (mirrors the App Store precedence, which is
  // null-tolerant on billing_source and keys off the subscription id).
  flipdesk_subscription_id?: string | null;
}

export interface GooglePlayResult {
  ok: boolean;
  kind: "subscription" | "consumable" | null;
  plan?: string;
  interval?: string | null;
  status?: string;
  creditsBalance?: number;
  reason?:
    | "unknown_product"
    | "user_not_found"
    | "invalid_purchase"
    | "already_processed"
    | "blocked_active_stripe"
    // US-2126: an active App Store subscription owns the plan — route the user
    // to manage it in the iOS app rather than double-charge via Google Play.
    | "blocked_active_appstore"
    // The purchase is bound to a different account — either its
    // obfuscatedExternalAccountId names another user, or the token is already
    // claimed on another user's row. Never entitles the caller (US-1614).
    | "account_mismatch"
    // US-2285: the client asked to be granted a product Google's verified
    // response does not list. Buy the cheapest subscription, replay the token
    // claiming the business tier — every other check passed, because the tier
    // was the one thing never checked against Google.
    | "product_mismatch";
  /**
   * US-2285: on `product_mismatch`, what Google actually said was bought. The
   * caller logs it; it never reaches the client, which already knows what it
   * claimed and does not need telling what it does not own.
   */
  verifiedProductIds?: string[];
}

export interface GooglePlayDeps {
  verifyPurchase(
    productId: string,
    purchaseToken: string,
    kind: "subscription" | "consumable",
  ): Promise<PlayPurchaseInfo>;
  loadBillingUser(userId: string): Promise<GooglePlayBillingUser | null>;
  /**
   * Return the userId that currently holds this subscription purchase token on
   * their users row (users.google_purchase_token), or null if unbound. Used to
   * reject a token that's already claimed by another account before we attempt
   * the (uniquely-indexed) write (US-1614).
   */
  findSubscriptionTokenOwner(purchaseToken: string): Promise<string | null>;
  applySubscription(userId: string, update: GoogleUsersBillingUpdate): Promise<void>;
  /**
   * Idempotency gate: INSERT into google_processed_purchases ON CONFLICT
   * (purchase_token) DO NOTHING. Returns true if WE inserted it (own the grant),
   * false if the purchase was already processed.
   */
  claimConsumable(
    userId: string,
    productId: string,
    purchaseToken: string,
    credits: number,
    orderId: string | null,
    /** US-2286: credits bought by a licence tester are as unreal as a tester's
     * subscription, so the ledger row carries the marker too. */
    environment: BillingEnvironment,
  ): Promise<boolean>;
  grantCredits(userId: string, credits: number, purchaseToken: string): Promise<number | null>;
  recordEvent(
    userId: string,
    eventId: string,
    fromPlan: string | null,
    toPlan: string | null,
    raw: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Verify a Google Play purchase and flip the corresponding plan/credit state.
 * Idempotent: subscriptions are an upsert of the users row; consumables gate on
 * the google_processed_purchases ledger so a replayed purchase grants once.
 */
export async function processGooglePlayPurchase(
  ctx: GooglePlayContext,
  deps: GooglePlayDeps,
  now: number,
): Promise<GooglePlayResult> {
  const mapping = classifyAndroidProduct(ctx.productId);
  if (!mapping) return { ok: false, kind: null, reason: "unknown_product" };

  const user = await deps.loadBillingUser(ctx.userId);
  if (!user) return { ok: false, kind: mapping.kind, reason: "user_not_found" };

  // Precedence: an active Stripe subscription owns the plan — route the user to
  // cancel web billing first rather than double-charge. US-1618 / C5: reuse the
  // SAME (processor-agnostic) predicate the App Store path uses so the two gates
  // can't drift — it's null-tolerant on billing_source and keys off
  // flipdesk_subscription_id + an entitling status (active/trialing/past_due),
  // where the old exact billing_source==='stripe' && status==='active' check
  // silently never fired (billing_source was never stamped 'stripe').
  if (decideAppstorePrecedence(user, mapping.kind) === "block_active_stripe") {
    return { ok: false, kind: "subscription", reason: "blocked_active_stripe" };
  }
  // US-2126: same precedence, other mobile store. Block a Google Play
  // subscription when an App Store subscription already entitles the user
  // (consumables are additive and never blocked).
  if (mapping.kind === "subscription" && appstoreSubscriptionActive(user)) {
    return { ok: false, kind: "subscription", reason: "blocked_active_appstore" };
  }

  const info = await deps.verifyPurchase(ctx.productId, ctx.purchaseToken, mapping.kind);
  if (!info.valid) return { ok: false, kind: mapping.kind, reason: "invalid_purchase" };

  // Account binding (US-1614): a purchase entitles exactly ONE account. If the
  // Android client stamped an obfuscatedExternalAccountId (= the purchaser's
  // userId), it MUST match the caller — otherwise a shared purchaseToken would
  // let anyone re-verify and get entitled. Older clients omit it; those fall
  // back to the per-token uniqueness claim below (subscriptions) / the
  // consumable ledger.
  if (
    info.obfuscatedExternalAccountId &&
    info.obfuscatedExternalAccountId !== ctx.userId
  ) {
    return { ok: false, kind: mapping.kind, reason: "account_mismatch" };
  }

  // US-2285: the TIER must come from Google, not from the request body. The
  // subscriptionsv2 endpoint is keyed on the token alone, so ctx.productId has
  // never been checked against anything up to this point — a valid token for
  // the cheapest plan, replayed with the business productId, satisfies every
  // gate above it. Empty productIds means there was nothing to check (a
  // consumable, whose URL already bound the product, or a response with no
  // lineItems) and is deliberately not a mismatch: refusing there would break
  // real purchases to defend a path Google already defends.
  if (info.productIds.length > 0 && !info.productIds.includes(ctx.productId)) {
    return {
      ok: false,
      kind: mapping.kind,
      reason: "product_mismatch",
      verifiedProductIds: info.productIds,
    };
  }

  if (mapping.kind === "subscription") {
    // Uniqueness claim: if this token is already bound to a different user's
    // row, refuse rather than move the entitlement (or throw on the unique
    // index). Same-user re-verify (owner === caller) is the normal renewal path.
    const owner = await deps.findSubscriptionTokenOwner(ctx.purchaseToken);
    if (owner && owner !== ctx.userId) {
      return { ok: false, kind: "subscription", reason: "account_mismatch" };
    }

    const update = computeGoogleUserUpdate({
      mapping,
      productId: ctx.productId,
      purchaseToken: ctx.purchaseToken,
      expiryMillis: info.expiryMillis,
      autoRenewing: info.autoRenewing,
      now,
      // US-2286: carried from the verified response, so a licence-tester
      // purchase is marked rather than counted as revenue.
      environment: info.environment,
    });
    await deps.applySubscription(ctx.userId, update);
    await deps.recordEvent(
      ctx.userId,
      ctx.purchaseToken,
      user.flipdesk_plan,
      update.flipdesk_plan,
      { product_id: ctx.productId },
    );
    return {
      ok: true,
      kind: "subscription",
      plan: update.flipdesk_plan,
      interval: update.flipdesk_interval,
      status: update.subscription_status,
      creditsBalance: user.grade_credit_balance ?? 0,
    };
  }

  // Consumable (US-1920): GRANT FIRST, then record the ledger claim.
  //
  // grant_grade_credits is idempotent on the `googleplay:<token>` key, so
  // (re-)granting a replayed purchase is safe and returns the same balance.
  // Recording the google_processed_purchases dedup row only AFTER a successful
  // grant means a grant failure leaves NO orphaned ledger row: the earlier
  // claim-first ordering wrote the dedup row before granting, so if grantCredits
  // threw, the client's retry saw claim === already-processed and short-circuited
  // to a stale balance — the buyer paid and never received the credits. With
  // grant-first, a failed grant throws (→ 400, nothing recorded) and the retry
  // re-attempts the idempotent grant. On a genuine replay the grant is a no-op
  // and the claim returns false, which we surface as `already_processed` with the
  // TRUE post-grant balance.
  const balance = await deps.grantCredits(ctx.userId, mapping.credits, ctx.purchaseToken);
  const firstClaim = await deps.claimConsumable(
    ctx.userId,
    ctx.productId,
    ctx.purchaseToken,
    mapping.credits,
    info.orderId,
    info.environment,
  );
  return {
    ok: true,
    kind: "consumable",
    plan: user.flipdesk_plan ?? "free",
    status: user.subscription_status ?? "none",
    creditsBalance: balance ?? user.grade_credit_balance ?? 0,
    ...(firstClaim ? {} : { reason: "already_processed" as const }),
  };
}
