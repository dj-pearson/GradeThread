// US-1619 / C6: Google Play expiry sweep — selection predicate + idempotency.

// expiry-sweep.ts imports supabase.ts, which throws at module init without env,
// so set dummy creds first and dynamically import.
import { assert, assertEquals, assertFalse } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  GOOGLEPLAY_SWEEP_GRACE_MS,
  googlePlaySweepEventId,
  isGooglePlayLapseEligible,
  sweepExpiredGooglePlaySubs,
} = await import("../lib/google-play/expiry-sweep.ts");
type SweepCandidate = import("../lib/appstore/expiry-sweep.ts").SweepCandidate;
type GooglePlaySweepDeps = import("../lib/google-play/expiry-sweep.ts").GooglePlaySweepDeps;

const NOW = 1_800_000_000_000; // epoch ms
const GRACE = GOOGLEPLAY_SWEEP_GRACE_MS;
const STALE = new Date(NOW - GRACE - 60_000).toISOString(); // just past grace
const FRESH = new Date(NOW - GRACE + 60_000).toISOString(); // still within grace
const FUTURE = new Date(NOW + 86_400_000).toISOString();

function row(overrides: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    id: "user-1",
    billing_source: "googleplay",
    subscription_status: "active",
    flipdesk_period_end: STALE,
    flipdesk_plan: "pro",
    ...overrides,
  };
}

// ── selection predicate ──────────────────────────────────────────

Deno.test("lapses googleplay 'active' past the grace window", () => {
  assert(isGooglePlayLapseEligible(row(), NOW, GRACE));
});

Deno.test("lapses googleplay 'trialing' past the grace window", () => {
  assert(isGooglePlayLapseEligible(row({ subscription_status: "trialing" }), NOW, GRACE));
});

Deno.test("never touches Stripe- or Apple-billed users", () => {
  assertFalse(isGooglePlayLapseEligible(row({ billing_source: "stripe" }), NOW, GRACE));
  assertFalse(isGooglePlayLapseEligible(row({ billing_source: "appstore" }), NOW, GRACE));
  assertFalse(isGooglePlayLapseEligible(row({ billing_source: null }), NOW, GRACE));
});

Deno.test("ignores already-canceled / non-entitled statuses", () => {
  assertFalse(isGooglePlayLapseEligible(row({ subscription_status: "canceled" }), NOW, GRACE));
  assertFalse(isGooglePlayLapseEligible(row({ subscription_status: "none" }), NOW, GRACE));
});

Deno.test("respects the grace window (fresh + future period ends are spared)", () => {
  assertFalse(isGooglePlayLapseEligible(row({ flipdesk_period_end: FRESH }), NOW, GRACE));
  assertFalse(isGooglePlayLapseEligible(row({ flipdesk_period_end: FUTURE }), NOW, GRACE));
});

Deno.test("missing / unparseable period end is never lapsed", () => {
  assertFalse(isGooglePlayLapseEligible(row({ flipdesk_period_end: null }), NOW, GRACE));
  assertFalse(isGooglePlayLapseEligible(row({ flipdesk_period_end: "not-a-date" }), NOW, GRACE));
});

Deno.test("event id is deterministic per (user, period_end)", () => {
  assertEquals(googlePlaySweepEventId("u", STALE), `googleplay:sweep:u:${STALE}`);
  assertEquals(googlePlaySweepEventId("u", null), "googleplay:sweep:u:none");
});

// ── idempotency over an in-memory store ──────────────────────────

function makeDeps(store: SweepCandidate[]) {
  const events = new Set<string>();
  let duplicateAttempts = 0;
  const deps: GooglePlaySweepDeps = {
    now: () => NOW,
    graceMs: GRACE,
    loadCandidates: (cutoffIso) =>
      Promise.resolve(
        store.filter(
          (u) =>
            u.billing_source === "googleplay" &&
            (u.subscription_status === "active" || u.subscription_status === "trialing") &&
            u.flipdesk_period_end != null &&
            u.flipdesk_period_end < cutoffIso,
        ),
      ),
    lapseUser: (id, update) => {
      const u = store.find((r) => r.id === id);
      // Mirror the conditional UPDATE: only flips a still-entitled googleplay row.
      if (
        !u ||
        u.billing_source !== "googleplay" ||
        (u.subscription_status !== "active" && u.subscription_status !== "trialing")
      ) {
        return Promise.resolve(false);
      }
      u.subscription_status = update.subscription_status;
      u.flipdesk_plan = update.flipdesk_plan;
      return Promise.resolve(true);
    },
    recordEvent: (_u, eventId) => {
      if (events.has(eventId)) duplicateAttempts++;
      events.add(eventId);
      return Promise.resolve();
    },
  };
  return { deps, events, dupes: () => duplicateAttempts };
}

Deno.test("sweep lapses stale googleplay rows and spares the rest", async () => {
  const store: SweepCandidate[] = [
    row({ id: "stale-active" }),
    row({ id: "stale-trialing", subscription_status: "trialing" }),
    row({ id: "stripe", billing_source: "stripe" }),
    row({ id: "appstore", billing_source: "appstore" }),
    row({ id: "fresh", flipdesk_period_end: FRESH }),
  ];
  const { deps, events } = makeDeps(store);

  const r1 = await sweepExpiredGooglePlaySubs(deps);
  assertEquals(r1.lapsed, 2);
  assertEquals(events.size, 2);
  assertEquals(store.find((u) => u.id === "stripe")?.subscription_status, "active");
  assertEquals(store.find((u) => u.id === "appstore")?.subscription_status, "active");
  assertEquals(store.find((u) => u.id === "fresh")?.subscription_status, "active");
  assertEquals(store.find((u) => u.id === "stale-active")?.flipdesk_plan, "free");
});

Deno.test("re-running the sweep is a no-op (idempotent)", async () => {
  const store: SweepCandidate[] = [row({ id: "stale-active" })];
  const { deps, events, dupes } = makeDeps(store);

  const r1 = await sweepExpiredGooglePlaySubs(deps);
  assertEquals(r1.lapsed, 1);

  const r2 = await sweepExpiredGooglePlaySubs(deps);
  assertEquals(r2.scanned, 0);
  assertEquals(r2.lapsed, 0);
  assertEquals(events.size, 1);
  assertEquals(dupes(), 0);
});
