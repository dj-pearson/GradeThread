// US-1650: Google Play RTDN — pure decode/classify + the reconcile dispatch.
import { assert, assertEquals } from "@std/assert";
import {
  classifyRtdn,
  decodeDeveloperNotification,
  type DeveloperNotification,
  pubSubMessageId,
  rtdnSecretOk,
} from "../lib/google-play/rtdn.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
const { reconcileRtdn } = await import("../routes/google-play-rtdn.ts");

function envelope(note: DeveloperNotification, messageId = "m1"): unknown {
  return { message: { data: btoa(JSON.stringify(note)), messageId }, subscription: "sub" };
}

// ── decode + message id ──────────────────────────────────────────────────────
Deno.test("decodeDeveloperNotification round-trips a base64 message", () => {
  const note: DeveloperNotification = {
    subscriptionNotification: { notificationType: 13, purchaseToken: "tok", subscriptionId: "flipdesk_pro_monthly" },
  };
  const decoded = decodeDeveloperNotification(envelope(note) as never);
  assertEquals(decoded?.subscriptionNotification?.notificationType, 13);
});

Deno.test("decodeDeveloperNotification returns null for missing/garbage data", () => {
  assertEquals(decodeDeveloperNotification({ message: {} } as never), null);
  assertEquals(decodeDeveloperNotification({ message: { data: "!!!notb64" } } as never), null);
});

Deno.test("pubSubMessageId reads camel or snake case", () => {
  assertEquals(pubSubMessageId({ message: { messageId: "a" } }), "a");
  assertEquals(pubSubMessageId({ message: { message_id: "b" } }), "b");
  assertEquals(pubSubMessageId({ message: {} }), null);
});

// ── classify ─────────────────────────────────────────────────────────────────
Deno.test("EXPIRED (13) and REVOKED (12) → sub_lapse", () => {
  for (const t of [12, 13]) {
    const a = classifyRtdn({ subscriptionNotification: { notificationType: t, purchaseToken: "tok", subscriptionId: "s" } });
    assertEquals(a.kind, "sub_lapse");
  }
});

Deno.test("RENEWED/RECOVERED/CANCELED/PURCHASED → sub_reverify (cancel keeps access to expiry)", () => {
  for (const t of [1, 2, 3, 4, 6, 7]) {
    const a = classifyRtdn({ subscriptionNotification: { notificationType: t, purchaseToken: "tok", subscriptionId: "s" } });
    assertEquals(a.kind, "sub_reverify", `type ${t}`);
  }
});

Deno.test("deferred/paused/pause-schedule → ignore", () => {
  // 8 (PRICE_CHANGE_CONFIRMED) was in this list until US-2124 — see below. The
  // rest genuinely need no server action: the next renewal RTDN or a client
  // re-verify settles them.
  for (const t of [9, 10, 11]) {
    assertEquals(classifyRtdn({ subscriptionNotification: { notificationType: t, purchaseToken: "tok" } }).kind, "ignore");
  }
});

// US-2124: PRICE_CHANGE_CONFIRMED is the one type in that group that is NOT
// merely "nothing to reconcile" — it means the user ACCEPTED a new price, which
// is a consent artifact. It still moves no entitlement (the next renewal RTDN
// settles the amount), but it must leave a server-side record that the
// acceptance happened; otherwise the only evidence is the eventual renewal
// amount, which is an inference rather than a record.
Deno.test("US-2124: PRICE_CHANGE_CONFIRMED is RECORDED, not ignored", () => {
  const a = classifyRtdn({
    subscriptionNotification: { notificationType: 8, purchaseToken: "tok", subscriptionId: "s" },
  });
  assertEquals(a.kind, "record_only");
  if (a.kind === "record_only") {
    assertEquals(a.purchaseToken, "tok");
    assertEquals(a.subscriptionId, "s");
    assertEquals(a.notificationType, 8);
  }
});

Deno.test("US-2124: record_only is not an entitlement action", () => {
  const a = classifyRtdn({
    subscriptionNotification: { notificationType: 8, purchaseToken: "tok", subscriptionId: "s" },
  });
  // Acting here would pre-empt Google, which owns the consent UI.
  assertEquals(a.kind === "sub_lapse", false);
  assertEquals(a.kind === "sub_reverify", false);
});

Deno.test("voidedPurchaseNotification → void with productType", () => {
  const a = classifyRtdn({ voidedPurchaseNotification: { purchaseToken: "tok", productType: 2 } });
  assertEquals(a.kind, "void");
  if (a.kind === "void") assertEquals(a.productType, 2);
});

Deno.test("testNotification → test", () => {
  assertEquals(classifyRtdn({ testNotification: { version: "1.0" } }).kind, "test");
});

// ── secret ───────────────────────────────────────────────────────────────────
Deno.test("rtdnSecretOk: exact match only; unconfigured/empty rejected", () => {
  assert(rtdnSecretOk("s3cret", "s3cret"));
  assert(!rtdnSecretOk("s3cret", "other"));
  assert(!rtdnSecretOk("s3cret", ""));
  assert(!rtdnSecretOk("s3cret", undefined));
  assert(!rtdnSecretOk(null, "s3cret"));
  assert(!rtdnSecretOk("short", "longer-secret"));
});

// ── reconcile dispatch (fake deps) ───────────────────────────────────────────
function fakeDeps(over: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = {
    lapseUser: [], applySubscriptionUpdate: [], clawbackConsumable: [], recordEvent: [],
  };
  const deps = {
    resolveSubscriptionUser: (_t: string) => Promise.resolve({ userId: "u1", fromPlan: "pro" }),
    resolveConsumablePurchase: (_t: string) => Promise.resolve({ userId: "u2", credits: 25 }),
    verifySubscription: (_s: string, _t: string) =>
      Promise.resolve({ valid: true, orderId: "o", expiryMillis: Date.now() + 1e9, autoRenewing: true, obfuscatedExternalAccountId: null }),
    applySubscriptionUpdate: (u: string, up: unknown) => { calls.applySubscriptionUpdate.push([u, up]); return Promise.resolve(); },
    lapseUser: (u: string) => { calls.lapseUser.push([u]); return Promise.resolve(); },
    clawbackConsumable: (u: string, t: string, c: number) => { calls.clawbackConsumable.push([u, t, c]); return Promise.resolve(); },
    recordEvent: (...args: unknown[]) => { calls.recordEvent.push(args); return Promise.resolve(); },
    ...over,
  };
  return { deps: deps as never, calls };
}

const NOW = 1_800_000_000_000;

Deno.test("sub_lapse lapses the bound user", async () => {
  const { deps, calls } = fakeDeps();
  const r = await reconcileRtdn({ kind: "sub_lapse", purchaseToken: "tok", subscriptionId: "flipdesk_pro_monthly" }, "e1", deps, NOW);
  assertEquals(r.outcome, "lapsed");
  assertEquals(calls.lapseUser.length, 1);
});

Deno.test("sub_reverify with a valid token applies the subscription update", async () => {
  const { deps, calls } = fakeDeps();
  const r = await reconcileRtdn({ kind: "sub_reverify", purchaseToken: "tok", subscriptionId: "flipdesk_pro_monthly" }, "e2", deps, NOW);
  assertEquals(r.outcome, "reverified");
  assertEquals(calls.applySubscriptionUpdate.length, 1);
  assertEquals(calls.lapseUser.length, 0);
});

Deno.test("sub_reverify with an invalid token lapses instead", async () => {
  const { deps, calls } = fakeDeps({
    verifySubscription: () => Promise.resolve({ valid: false, orderId: null, expiryMillis: null, autoRenewing: false, obfuscatedExternalAccountId: null }),
  });
  const r = await reconcileRtdn({ kind: "sub_reverify", purchaseToken: "tok", subscriptionId: "flipdesk_pro_monthly" }, "e3", deps, NOW);
  assertEquals(r.outcome, "lapsed");
  assertEquals(calls.lapseUser.length, 1);
});

Deno.test("void of a one-time product claws back the credits", async () => {
  const { deps, calls } = fakeDeps();
  const r = await reconcileRtdn({ kind: "void", purchaseToken: "tok", productType: 2 }, "e4", deps, NOW);
  assertEquals(r.outcome, "clawed_back");
  assertEquals(calls.clawbackConsumable[0], ["u2", "tok", 25]);
});

Deno.test("void of a subscription lapses the entitlement", async () => {
  const { deps, calls } = fakeDeps();
  const r = await reconcileRtdn({ kind: "void", purchaseToken: "tok", productType: 1 }, "e5", deps, NOW);
  assertEquals(r.outcome, "lapsed");
  assertEquals(calls.lapseUser.length, 1);
});

Deno.test("a token bound to no user is ignored (no writes)", async () => {
  const { deps, calls } = fakeDeps({ resolveSubscriptionUser: () => Promise.resolve(null) });
  const r = await reconcileRtdn({ kind: "sub_lapse", purchaseToken: "tok", subscriptionId: "s" }, "e6", deps, NOW);
  assertEquals(r.outcome, "ignored");
  assertEquals(calls.lapseUser.length, 0);
});

Deno.test("test and ignore actions are no-ops", async () => {
  const { deps, calls } = fakeDeps();
  assertEquals((await reconcileRtdn({ kind: "test" }, "e7", deps, NOW)).outcome, "ignored");
  assertEquals((await reconcileRtdn({ kind: "ignore", reason: "x" }, "e8", deps, NOW)).outcome, "ignored");
  assertEquals(calls.recordEvent.length, 0);
});
