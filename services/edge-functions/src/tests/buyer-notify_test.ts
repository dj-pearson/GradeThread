// US-1803: buyer notification delivery — fan-out, per-channel gating,
// idempotency, and plan-capped digest cadence. Deps are injected so this runs
// without a DB, APNs, or email.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const { notifyBuyer, inQuietHours, emailAllowed } = await import("../lib/buyer-notify.ts");
import type { BuyerDeliveryContext, BuyerNotifyDeps } from "../lib/buyer-notify.ts";
import type { NotifyInput } from "../lib/notify.ts";

interface Recorder {
  inApp: NotifyInput[];
  push: number;
  email: string[];
  deps: BuyerNotifyDeps;
}

function ctx(over: Partial<BuyerDeliveryContext> = {}): BuyerDeliveryContext {
  return {
    prefs: null,
    email: "buyer@example.com",
    digestFrequency: "immediate",
    quietStart: null,
    quietEnd: null,
    alertFrequency: "instant",
    ...over,
  };
}

function harness(context: BuyerDeliveryContext, nowHourUtc = 12): Recorder {
  const seen = new Set<string>();
  const rec: Recorder = {
    inApp: [],
    push: 0,
    email: [],
    deps: {
      claim: (userId, _c, dedupeKey) => {
        const k = `${userId}:${dedupeKey}`;
        if (seen.has(k)) return Promise.resolve(false);
        seen.add(k);
        return Promise.resolve(true);
      },
      loadContext: () => Promise.resolve(context),
      notify: (_u, input) => {
        rec.inApp.push(input);
        return Promise.resolve();
      },
      push: () => {
        rec.push += 1;
        return Promise.resolve(undefined);
      },
      sendEmail: (to) => {
        rec.email.push(to);
        return Promise.resolve(undefined);
      },
      now: () => new Date(Date.UTC(2026, 0, 1, nowHourUtc, 0, 0)),
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

Deno.test("notifyBuyer: immediate mode delivers in-app + push + email, maps category to type", async () => {
  const h = harness(ctx());
  assertEquals(await notifyBuyer("u1", input, h.deps), true);
  assertEquals(h.inApp.length, 1);
  assertEquals(h.inApp[0].type, "buyer_condition_alert");
  assertEquals(h.push, 1);
  assertEquals(h.email, ["buyer@example.com"]);
});

Deno.test("notifyBuyer: idempotent — a repeat dedupeKey delivers nothing", async () => {
  const h = harness(ctx());
  assertEquals(await notifyBuyer("u1", input, h.deps), true);
  assertEquals(await notifyBuyer("u1", input, h.deps), false);
  assertEquals(h.inApp.length, 1);
  assertEquals(h.push, 1);
  assertEquals(h.email.length, 1);
});

Deno.test("notifyBuyer: digest mode delivers in-app only (push/email deferred to the cron)", async () => {
  const h = harness(ctx({ digestFrequency: "daily" }));
  assertEquals(await notifyBuyer("u1", input, h.deps), true);
  assertEquals(h.inApp.length, 1);
  assertEquals(h.push, 0);
  assertEquals(h.email.length, 0);
});

Deno.test("notifyBuyer: a Free-plan buyer who chose immediate is capped to daily (no push/email)", async () => {
  // effectiveDigestMode('immediate', 'daily' cap) => 'daily'.
  const h = harness(ctx({ digestFrequency: "immediate", alertFrequency: "daily" }));
  assertEquals(await notifyBuyer("u1", input, h.deps), true);
  assertEquals(h.inApp.length, 1);
  assertEquals(h.push, 0);
  assertEquals(h.email.length, 0);
});

Deno.test("notifyBuyer: push suppressed off-pref + in quiet hours; email still sends", async () => {
  // Push pref off → no push regardless of hour.
  const offPref = harness(ctx({ prefs: { buyer_alerts: { push: false } } }));
  await notifyBuyer("u1", input, offPref.deps);
  assertEquals(offPref.push, 0);
  assertEquals(offPref.email.length, 1);

  // Quiet hours 22–07, current 02:00 UTC → push suppressed, email still sends.
  const quiet = harness(ctx({ quietStart: 22, quietEnd: 7 }), 2);
  await notifyBuyer("u1", input, quiet.deps);
  assertEquals(quiet.push, 0);
  assertEquals(quiet.email.length, 1);
});

Deno.test("notifyBuyer: email suppressed when the category's email pref is off", async () => {
  const h = harness(ctx({ prefs: { buyer_alerts: { email: false } } }));
  await notifyBuyer("u1", input, h.deps);
  assertEquals(h.email.length, 0);
  assertEquals(h.push, 1); // push unaffected
});

Deno.test("inQuietHours: same-day + wrap-around windows", () => {
  assertEquals(inQuietHours(3, 22, 7), true); // wrap: 3am inside 22→7
  assertEquals(inQuietHours(12, 22, 7), false); // noon outside
  assertEquals(inQuietHours(14, 9, 17), true); // same-day inside
  assertEquals(inQuietHours(8, 9, 17), false); // before window
  assertEquals(inQuietHours(5, null, null), false); // disabled
});

Deno.test("emailAllowed: default on, explicit false suppresses", () => {
  assertEquals(emailAllowed(null, "buyer_alerts"), true);
  assertEquals(emailAllowed({ buyer_alerts: { email: false } }, "buyer_alerts"), false);
  assertEquals(emailAllowed({ buyer_alerts: { email: true } }, "buyer_alerts"), true);
});
