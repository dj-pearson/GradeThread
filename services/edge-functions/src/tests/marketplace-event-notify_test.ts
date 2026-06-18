// US-1055: marketplace offer/return/dispute notifications — content builders +
// cross-channel preference gating.
//
// marketplace-event-notify.ts imports email.ts / transactional-push.ts /
// notify.ts, which pull in the service-role supabase client at init, so set
// dummy env BEFORE the dynamic import (per the LEARNINGS playbook).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  buildOfferReceived,
  buildOfferResponded,
  buildReturnOpened,
  buildDisputeOpened,
  channelAllows,
  formatMoney,
  notifyOfferReceived,
} = await import("../lib/marketplace-event-notify.ts");
import type { MarketplaceNotifyDeps } from "../lib/marketplace-event-notify.ts";
import type { NotifyInput } from "../lib/notify.ts";

// ── Pure content builders ───────────────────────────────────────────

Deno.test("buildOfferReceived names the buyer, amount, and item + links to offers", () => {
  const input = buildOfferReceived({
    userId: "u1",
    bestOfferId: "o1",
    itemTitle: "Blue denim jacket",
    price: 42,
    currency: "USD",
    buyerUsername: "thrifty_tom",
    expiresAt: null,
  });
  assertEquals(input.type, "offer_received");
  assert(input.message.includes("thrifty_tom"));
  assert(input.message.includes("$42.00"));
  assert(input.message.includes("Blue denim jacket"));
  assertEquals(input.link, "/dashboard/flipdesk/offers");
});

Deno.test("buildOfferReceived falls back gracefully without buyer/price/title", () => {
  const input = buildOfferReceived({
    userId: "u1",
    bestOfferId: "o1",
    itemTitle: null,
    price: null,
    currency: null,
    buyerUsername: null,
    expiresAt: null,
  });
  assert(input.message.startsWith("A buyer sent an offer"));
  assert(input.message.includes("your listing"));
});

Deno.test("buildOfferResponded reflects the action", () => {
  for (const action of ["accepted", "declined", "countered"] as const) {
    const input = buildOfferResponded("Wool coat", action);
    assertEquals(input.type, "offer_responded");
    assert(input.title.toLowerCase().includes(action));
    assert(input.message.includes(action));
  }
});

Deno.test("buildReturnOpened carries the reason + post-sale link", () => {
  const input = buildReturnOpened({
    userId: "u1",
    returnId: "r1",
    itemLabel: "order-123",
    reason: "DOESNT_FIT",
  });
  assertEquals(input.type, "return_opened");
  assert(input.message.includes("order-123"));
  assert(input.message.includes("DOESNT_FIT"));
  assertEquals(input.link, "/dashboard/flipdesk/post-sale");
});

Deno.test("buildDisputeOpened surfaces the respond-by DEADLINE + amount", () => {
  const input = buildDisputeOpened({
    userId: "u1",
    disputeId: "d1",
    orderLabel: "12-3456",
    reason: "ITEM_NOT_RECEIVED",
    amount: 80,
    currency: "USD",
    respondByDate: "2026-07-01T00:00:00.000Z",
  });
  assertEquals(input.type, "dispute_opened");
  assert(input.message.includes("$80.00"));
  assert(input.message.includes("12-3456"));
  // The deadline eBay provides must be surfaced (AC1).
  assert(input.message.includes("2026-07-01"));
  assert(input.message.toLowerCase().includes("respond by"));
});

Deno.test("formatMoney handles USD symbol, other currencies, and nulls", () => {
  assertEquals(formatMoney(42, "USD"), "$42.00");
  assertEquals(formatMoney(10, "EUR"), "EUR 10.00");
  assertEquals(formatMoney(null, "USD"), null);
  assertEquals(formatMoney(Number.NaN, "USD"), null);
});

// ── Preference gating (pure) ────────────────────────────────────────

Deno.test("channelAllows defaults ON and only an explicit false suppresses", () => {
  assertEquals(channelAllows(null, "offers"), { email: true, push: true });
  assertEquals(channelAllows({ offers: {} }, "offers"), { email: true, push: true });
  assertEquals(
    channelAllows({ offers: { email: false } }, "offers"),
    { email: false, push: true },
  );
  assertEquals(
    channelAllows({ offers: { push: false } }, "offers"),
    { email: true, push: false },
  );
  // A null prefKey (always-on type) allows both.
  assertEquals(channelAllows({ offers: { email: false } }, null), { email: true, push: true });
});

// ── Cross-channel delivery gating (with injected deps) ──────────────

function spyDeps(
  prefs: Record<string, { email?: boolean; push?: boolean }> | null,
  email: string | null = "seller@example.com",
) {
  const calls = { inApp: [] as NotifyInput[], email: 0, push: 0 };
  const deps: MarketplaceNotifyDeps = {
    loadContact: () =>
      Promise.resolve({ email, fullName: "Sam", prefs }),
    notify: (_uid, input: NotifyInput) => {
      calls.inApp.push(input);
      return Promise.resolve();
    },
    onEmail: () => {
      calls.email++;
    },
    onPush: () => {
      calls.push++;
    },
  };
  return { calls, deps };
}

const offerEv = {
  userId: "u1",
  bestOfferId: "o1",
  itemTitle: "Tee",
  price: 12,
  currency: "USD",
  buyerUsername: "b",
  expiresAt: null,
};

Deno.test("delivery fans out to all three channels by default", async () => {
  const { calls, deps } = spyDeps(null);
  await notifyOfferReceived(offerEv, deps);
  assertEquals(calls.inApp.length, 1);
  assertEquals(calls.inApp[0].type, "offer_received");
  assertEquals(calls.email, 1);
  assertEquals(calls.push, 1);
});

Deno.test("delivery suppresses email when the category email pref is false", async () => {
  const { calls, deps } = spyDeps({ offers: { email: false } });
  await notifyOfferReceived(offerEv, deps);
  // In-app is gated separately (inside notifyUser) and push stays on.
  assertEquals(calls.email, 0);
  assertEquals(calls.push, 1);
});

Deno.test("delivery suppresses push when the category push pref is false", async () => {
  const { calls, deps } = spyDeps({ offers: { push: false } });
  await notifyOfferReceived(offerEv, deps);
  assertEquals(calls.email, 1);
  assertEquals(calls.push, 0);
});

Deno.test("delivery skips email when the user has no address but still pushes", async () => {
  const { calls, deps } = spyDeps(null, null);
  await notifyOfferReceived(offerEv, deps);
  assertEquals(calls.email, 0);
  assertEquals(calls.push, 1);
});
