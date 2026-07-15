// US-1054: selling-activity notifications — content builders, push preference
// gating, and that each real event emitter actually fires the in-app notify
// (and a preference-gated push for sale_recorded / payout_imported).
//
// selling-activity-notify.ts imports transactional-push.ts / notify.ts, which
// pull in the service-role supabase client at init, so set dummy env BEFORE the
// dynamic import (per the LEARNINGS playbook).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  buildSaleRecorded,
  buildListingLive,
  buildListingEnded,
  buildPayoutImported,
  pushAllowed,
  notifySaleRecorded,
  notifyListingLive,
  notifyListingEnded,
  notifyPayoutImported,
} = await import("../lib/selling-activity-notify.ts");
import type { SellingActivityDeps } from "../lib/selling-activity-notify.ts";
import type { NotifyInput } from "../lib/notify.ts";

// ── Pure content builders ───────────────────────────────────────────

Deno.test("buildSaleRecorded names the item + amount and links to the item", () => {
  const input = buildSaleRecorded({ itemTitle: "Wool coat", price: 42, itemId: "i1" });
  assertEquals(input.type, "sale_recorded");
  assert(input.message.includes("Wool coat"));
  assert(input.message.includes("$42.00"));
  assertEquals(input.link, "/dashboard/flipdesk/items/i1");
});

Deno.test("buildSaleRecorded falls back without a title or price", () => {
  const input = buildSaleRecorded({ itemTitle: null, price: null, itemId: "i1" });
  assert(input.message.startsWith("An item sold"));
  assert(!input.message.includes("$"));
});

Deno.test("buildListingLive / buildListingEnded carry the right type + link", () => {
  const live = buildListingLive({ itemTitle: "Tee", itemId: "i2" });
  assertEquals(live.type, "listing_live");
  assert(live.message.includes("Tee"));
  assertEquals(live.link, "/dashboard/flipdesk/items/i2");

  const ended = buildListingEnded({ itemTitle: null, itemId: "i3" });
  assertEquals(ended.type, "item_status_change");
  assert(ended.message.includes("Your item"));
  assert(ended.message.toLowerCase().includes("drafts"));
  assertEquals(ended.link, "/dashboard/flipdesk/items/i3");
});

Deno.test("buildPayoutImported is precise for a single payout, count-based for a batch", () => {
  const one = buildPayoutImported({ count: 1, currency: "USD", amount: 25 });
  assertEquals(one.type, "payout_imported");
  assert(one.message.includes("USD 25"));
  assertEquals(one.link, "/dashboard/flipdesk/reconciliation");

  const many = buildPayoutImported({ count: 3 });
  assert(many.message.includes("3 payouts"));
});

// ── Preference gating (pure) ────────────────────────────────────────

Deno.test("pushAllowed defaults ON and only an explicit false suppresses", () => {
  assertEquals(pushAllowed(null, "selling_activity"), true);
  assertEquals(pushAllowed({ selling_activity: {} }, "selling_activity"), true);
  assertEquals(pushAllowed({ selling_activity: { push: false } }, "selling_activity"), false);
  assertEquals(pushAllowed({ payouts: { push: false } }, "payouts"), false);
  // A null prefKey (always-on type) always allows.
  assertEquals(pushAllowed({ payouts: { push: false } }, null), true);
});

// ── Cross-channel delivery (with injected deps) ─────────────────────

function spyDeps(prefs: Record<string, { push?: boolean }> | null) {
  const calls = { inApp: [] as NotifyInput[], push: 0 };
  const deps: SellingActivityDeps = {
    loadPrefs: () => Promise.resolve(prefs),
    notify: (_uid, input: NotifyInput) => {
      calls.inApp.push(input);
      return Promise.resolve();
    },
    onPush: () => {
      calls.push++;
    },
  };
  return { calls, deps };
}

Deno.test("notifySaleRecorded fires in-app + push by default", async () => {
  const { calls, deps } = spyDeps(null);
  await notifySaleRecorded("u1", { itemTitle: "Tee", price: 10, itemId: "i1" }, deps);
  assertEquals(calls.inApp.length, 1);
  assertEquals(calls.inApp[0].type, "sale_recorded");
  assertEquals(calls.push, 1);
});

Deno.test("notifySaleRecorded suppresses push when selling_activity.push is false (in-app still fires)", async () => {
  const { calls, deps } = spyDeps({ selling_activity: { push: false } });
  await notifySaleRecorded("u1", { itemTitle: "Tee", price: 10, itemId: "i1" }, deps);
  assertEquals(calls.inApp.length, 1); // in-app gating is delegated to notifyUser
  assertEquals(calls.push, 0);
});

Deno.test("notifyPayoutImported fires in-app + push, gated by the payouts category", async () => {
  const on = spyDeps(null);
  await notifyPayoutImported("u1", { count: 1, currency: "USD", amount: 25 }, on.deps);
  assertEquals(on.calls.inApp[0].type, "payout_imported");
  assertEquals(on.calls.push, 1);

  const off = spyDeps({ payouts: { push: false } });
  await notifyPayoutImported("u1", { count: 1, currency: "USD", amount: 25 }, off.deps);
  assertEquals(off.calls.inApp.length, 1);
  assertEquals(off.calls.push, 0);
});

Deno.test("listing-live delivers in-app only (no iOS category → no push channel)", async () => {
  const live = spyDeps(null);
  await notifyListingLive("u1", { itemTitle: "Tee", itemId: "i1" }, live.deps);
  assertEquals(live.calls.inApp[0].type, "listing_live");
  assertEquals(live.calls.push, 0);
});

Deno.test("US-1977: notifyListingEnded fires in-app + push, gated by selling_activity", async () => {
  const on = spyDeps(null);
  await notifyListingEnded("u1", { itemTitle: "Tee", itemId: "i1" }, on.deps);
  assertEquals(on.calls.inApp[0].type, "item_status_change");
  assertEquals(on.calls.push, 1);

  // Same category as the other selling-activity events — an explicit opt-out
  // suppresses the push while the in-app leg still fires.
  const off = spyDeps({ selling_activity: { push: false } });
  await notifyListingEnded("u1", { itemTitle: "Tee", itemId: "i1" }, off.deps);
  assertEquals(off.calls.inApp.length, 1);
  assertEquals(off.calls.push, 0);
});

Deno.test("a missing userId is a no-op (tenant-safe guard)", async () => {
  const { calls, deps } = spyDeps(null);
  await notifySaleRecorded("", { itemTitle: "Tee", price: 10, itemId: "i1" }, deps);
  assertEquals(calls.inApp.length, 0);
  assertEquals(calls.push, 0);
});
