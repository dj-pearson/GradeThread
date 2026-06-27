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
    lineItems?: Array<{
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
  };
}

/** Parse a Play Developer API products purchase response. purchaseState 0 =
 * Purchased, 1 = Canceled, 2 = Pending. */
export function parseProductPurchase(json: unknown): PlayPurchaseInfo {
  const o = (json ?? {}) as { purchaseState?: number; orderId?: string };
  return {
    valid: o.purchaseState === 0,
    orderId: o.orderId ?? null,
    expiryMillis: null,
    autoRenewing: false,
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
    | "blocked_active_stripe";
}

export interface GooglePlayDeps {
  verifyPurchase(
    productId: string,
    purchaseToken: string,
    kind: "subscription" | "consumable",
  ): Promise<PlayPurchaseInfo>;
  loadBillingUser(userId: string): Promise<GooglePlayBillingUser | null>;
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
  // cancel web billing first rather than double-charge (mirrors the App Store
  // precedence rule).
  if (
    mapping.kind === "subscription" &&
    user.billing_source === "stripe" &&
    user.subscription_status === "active"
  ) {
    return { ok: false, kind: "subscription", reason: "blocked_active_stripe" };
  }

  const info = await deps.verifyPurchase(ctx.productId, ctx.purchaseToken, mapping.kind);
  if (!info.valid) return { ok: false, kind: mapping.kind, reason: "invalid_purchase" };

  if (mapping.kind === "subscription") {
    const update = computeGoogleUserUpdate({
      mapping,
      productId: ctx.productId,
      purchaseToken: ctx.purchaseToken,
      expiryMillis: info.expiryMillis,
      autoRenewing: info.autoRenewing,
      now,
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

  // Consumable: claim the ledger row before granting (exactly-once).
  const owned = await deps.claimConsumable(
    ctx.userId,
    ctx.productId,
    ctx.purchaseToken,
    mapping.credits,
    info.orderId,
  );
  if (!owned) {
    return {
      ok: true,
      kind: "consumable",
      plan: user.flipdesk_plan ?? "free",
      status: user.subscription_status ?? "none",
      creditsBalance: user.grade_credit_balance ?? 0,
      reason: "already_processed",
    };
  }
  const balance = await deps.grantCredits(ctx.userId, mapping.credits, ctx.purchaseToken);
  return {
    ok: true,
    kind: "consumable",
    plan: user.flipdesk_plan ?? "free",
    status: user.subscription_status ?? "none",
    creditsBalance: balance ?? user.grade_credit_balance ?? 0,
  };
}
