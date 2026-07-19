// US-1650 / C6: Google Play Real-time Developer Notifications (RTDN) — the pure
// decode + routing core. Google delivers RTDNs over Cloud Pub/Sub PUSH: the POST
// body is `{ message: { data: base64(DeveloperNotification JSON), messageId,
// publishTime }, subscription }`. This module decodes that envelope and maps a
// DeveloperNotification to a single reconciliation ACTION. Both functions are
// pure (no I/O) so the routing is unit-tested without the Play API or a DB; the
// route glue (routes/google-play-rtdn.ts) does the verify → resolve → write.
//
// notificationType enum (subscriptionNotification), per the Play docs:
//   1 RECOVERED · 2 RENEWED · 3 CANCELED · 4 PURCHASED · 5 ON_HOLD ·
//   6 IN_GRACE_PERIOD · 7 RESTARTED · 8 PRICE_CHANGE_CONFIRMED · 9 DEFERRED ·
//   10 PAUSED · 11 PAUSE_SCHEDULE_CHANGED · 12 REVOKED · 13 EXPIRED.

/** Play notificationType 8 — the user CONFIRMED a price change (US-2124). */
const SUB_PRICE_CHANGE_CONFIRMED = 8;

export interface SubscriptionNotification {
  version?: string;
  notificationType?: number;
  purchaseToken?: string;
  subscriptionId?: string;
}

export interface VoidedPurchaseNotification {
  purchaseToken?: string;
  orderId?: string;
  /** 1 = subscription, 2 = one-time product. */
  productType?: number;
  /** 1 = full refund, 2 = partial. */
  refundType?: number;
}

export interface DeveloperNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: SubscriptionNotification;
  oneTimeProductNotification?: {
    version?: string;
    notificationType?: number;
    purchaseToken?: string;
    sku?: string;
  };
  voidedPurchaseNotification?: VoidedPurchaseNotification;
  testNotification?: { version?: string };
}

export interface PubSubPushEnvelope {
  message?: { data?: unknown; messageId?: unknown; message_id?: unknown; publishTime?: unknown };
  subscription?: unknown;
}

// A subscription notification that ENDS entitlement now — the real-time analog
// of the expiry-sweep lapse. REVOKED (12, refund/chargeback) and EXPIRED (13).
const SUB_LAPSE_TYPES = new Set([12, 13]);
// A subscription notification to RE-VERIFY against the Play API and re-apply the
// resulting state. Includes CANCELED (3): a cancel only turns auto-renew off —
// entitlement continues until expiry, so we re-verify (which reflects the
// cancel + keeps access until the period ends) rather than lapse early.
const SUB_REVERIFY_TYPES = new Set([1, 2, 3, 4, 6, 7]);

export type RtdnAction =
  | { kind: "sub_reverify"; purchaseToken: string; subscriptionId: string }
  | { kind: "sub_lapse"; purchaseToken: string; subscriptionId: string }
  | { kind: "void"; purchaseToken: string; productType: number }
  // US-2124: a platform-side change we RECORD without moving entitlement.
  // PRICE_CHANGE_CONFIRMED is the sharpest case — it means the user ACCEPTED a
  // new price, i.e. it is a consent artifact, and dropping it lost the only
  // server-side evidence that the acceptance happened. Mirrors the Apple
  // router's `record_only`, which had the identical gap.
  | {
    kind: "record_only";
    purchaseToken: string;
    subscriptionId: string;
    notificationType: number;
  }
  | { kind: "test" }
  | { kind: "ignore"; reason: string };

/** Read the Pub/Sub messageId (idempotency key). Tolerates camel/snake case. */
export function pubSubMessageId(body: PubSubPushEnvelope): string | null {
  const m = body?.message;
  const id = (m?.messageId ?? m?.message_id);
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Base64-decode message.data → DeveloperNotification, or null if unparseable. */
export function decodeDeveloperNotification(
  body: PubSubPushEnvelope,
): DeveloperNotification | null {
  const data = body?.message?.data;
  if (typeof data !== "string" || data.length === 0) return null;
  try {
    // atob handles standard base64; Pub/Sub uses standard base64 for data.
    const json = atob(data);
    const parsed = JSON.parse(json);
    return (parsed && typeof parsed === "object") ? parsed as DeveloperNotification : null;
  } catch {
    return null;
  }
}

/** Map a DeveloperNotification to exactly one reconciliation action. */
export function classifyRtdn(n: DeveloperNotification): RtdnAction {
  if (n.testNotification) return { kind: "test" };

  const v = n.voidedPurchaseNotification;
  if (v?.purchaseToken) {
    return { kind: "void", purchaseToken: v.purchaseToken, productType: v.productType ?? 0 };
  }

  const s = n.subscriptionNotification;
  if (s?.purchaseToken && typeof s.notificationType === "number") {
    const subId = s.subscriptionId ?? "";
    if (SUB_LAPSE_TYPES.has(s.notificationType)) {
      return { kind: "sub_lapse", purchaseToken: s.purchaseToken, subscriptionId: subId };
    }
    if (SUB_REVERIFY_TYPES.has(s.notificationType)) {
      return { kind: "sub_reverify", purchaseToken: s.purchaseToken, subscriptionId: subId };
    }
    // US-2124: PRICE_CHANGE_CONFIRMED (8) is RECORDED, not ignored. It carries
    // no entitlement change — the next renewal RTDN settles the amount — but it
    // is the user CONSENTING to a new price, which is precisely the artifact
    // subscription_agreements (US-2117) exists to hold. Dropping it meant the
    // only server-side evidence of that consent was the eventual renewal amount,
    // which is an inference rather than a record.
    if (s.notificationType === SUB_PRICE_CHANGE_CONFIRMED) {
      return {
        kind: "record_only",
        purchaseToken: s.purchaseToken,
        subscriptionId: subId,
        notificationType: s.notificationType,
      };
    }
    // Deferred / paused / pause-schedule — no entitlement change we need to
    // reconcile server-side; the next renewal RTDN or a client re-verify
    // settles it.
    return { kind: "ignore", reason: `sub_type_${s.notificationType}` };
  }

  // A one-time-product notification (non-void) or an unrecognized shape.
  return { kind: "ignore", reason: "unhandled_notification" };
}

/**
 * Constant-time-ish shared-secret check for the Pub/Sub push. Google Pub/Sub
 * push subscriptions can carry a `?token=<secret>` query param (or an
 * Authorization header); we accept either and compare to GOOGLE_RTDN_WEBHOOK_SECRET.
 * Pure so the route can pass the presented value + the expected secret.
 */
export function rtdnSecretOk(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected) return false; // not configured → reject (fail closed)
  if (!presented) return false;
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
