// US-1803: buyer notification delivery — fan-out, per-channel gating, and
// idempotency. Deps are injected so this runs without a DB or APNs.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const { notifyBuyer } = await import("../lib/buyer-notify.ts");
import type { BuyerNotifyDeps } from "../lib/buyer-notify.ts";
import type { NotifyInput } from "../lib/notify.ts";

interface Recorder {
  inApp: NotifyInput[];
  push: string[];
  claims: string[];
  deps: BuyerNotifyDeps;
}

// A deps harness: claim succeeds once per dedupe_key (in-memory), prefs default
// on unless overridden, and push/in-app record what fired.
function harness(opts?: { prefs?: Record<string, { push?: boolean }> }): Recorder {
  const seen = new Set<string>();
  const rec: Recorder = {
    inApp: [],
    push: [],
    claims: [],
    deps: {
      claim: (userId, _category, dedupeKey) => {
        const k = `${userId}:${dedupeKey}`;
        rec.claims.push(k);
        if (seen.has(k)) return Promise.resolve(false);
        seen.add(k);
        return Promise.resolve(true);
      },
      loadPrefs: () => Promise.resolve(opts?.prefs ?? null),
      notify: (_userId, input) => {
        rec.inApp.push(input);
        return Promise.resolve();
      },
      push: () => Promise.resolve(undefined),
      onPush: (userId) => {
        rec.push.push(userId);
      },
    },
  };
  return rec;
}

const input = {
  category: "condition_alert" as const,
  title: "Match found",
  body: "A graded Patagonia jacket just listed.",
  link: "/buyer/alerts",
  dedupeKey: "alert:1:listing-9",
};

Deno.test("notifyBuyer: delivers in-app + push on first call, maps category to type", async () => {
  const h = harness();
  const delivered = await notifyBuyer("user-1", input, h.deps);
  assertEquals(delivered, true);
  assertEquals(h.inApp.length, 1);
  assertEquals(h.inApp[0].type, "buyer_condition_alert");
  assertEquals(h.inApp[0].title, "Match found");
  assertEquals(h.inApp[0].link, "/buyer/alerts");
  assertEquals(h.push.length, 1);
});

Deno.test("notifyBuyer: idempotent — a repeat dedupeKey delivers nothing", async () => {
  const h = harness();
  assertEquals(await notifyBuyer("user-1", input, h.deps), true);
  assertEquals(await notifyBuyer("user-1", input, h.deps), false);
  assertEquals(await notifyBuyer("user-1", input, h.deps), false);
  // In-app + push fired exactly once despite three calls.
  assertEquals(h.inApp.length, 1);
  assertEquals(h.push.length, 1);
  assertEquals(h.claims.length, 3);
});

Deno.test("notifyBuyer: a different user with the same key still delivers (scoped by user)", async () => {
  const h = harness();
  await notifyBuyer("user-1", input, h.deps);
  await notifyBuyer("user-2", input, h.deps);
  assertEquals(h.inApp.length, 2);
  assertEquals(h.push.length, 2);
});

Deno.test("notifyBuyer: push suppressed when the category's push pref is off (in-app still delivers)", async () => {
  const h = harness({ prefs: { buyer_alerts: { push: false } } });
  const delivered = await notifyBuyer("user-1", input, h.deps);
  assertEquals(delivered, true);
  assertEquals(h.inApp.length, 1); // in-app unaffected
  assertEquals(h.push.length, 0); // push gated off
});

Deno.test("notifyBuyer: empty userId is a no-op", async () => {
  const h = harness();
  assertEquals(await notifyBuyer("", input, h.deps), false);
  assertEquals(h.inApp.length, 0);
  assertEquals(h.push.length, 0);
});
