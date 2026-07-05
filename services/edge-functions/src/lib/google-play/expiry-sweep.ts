// US-1619 / C6: Google Play subscription expiry sweep (scheduled backstop).
//
// The Android counterpart to appstore/expiry-sweep.ts. Google Play billed
// entitlement normally changes via a Real-time Developer Notification (RTDN)
// Pub/Sub webhook or a client re-verify (POST /api/payments/google/verify). Until
// the RTDN webhook ships (tracked separately), a cancelled/expired Play
// subscription had NO server-side lapse path at all — the entitlement was
// effectively perpetual. This backstop closes that: it finds users whose
// billing_source='googleplay' and subscription_status is still 'active'/
// 'trialing' but whose flipdesk_period_end elapsed more than a generous grace
// window ago, and lapses them to free/canceled.
//
// Reuses the generic, already-tested pure helpers (SweepCandidate/LapseUpdate/
// buildLapseUpdate) from the App Store sweep; only the billing_source scope, the
// audit event-id namespace, and the wiring are Play-specific.
//
// Stripe-billed users are NEVER touched: selection is scoped to
// billing_source='googleplay' in the query AND re-checked by the pure predicate.
//
// Idempotent: lapsing flips subscription_status off 'active'/'trialing' so the
// row no longer matches on the next run; the audit event id is derived from
// (user, period_end) so a re-run (or a late RTDN covering the same period)
// collides on the unique stripe_event_id and is ignored.
//
// Mounted in main.ts as POST /api/jobs/googleplay-expiry-sweep, gated by
// X-Internal-Job-Secret (same pattern as the App Store sweep).

import { supabaseAdmin } from "../supabase.ts";
import { requireJobSecret } from "../job-auth.ts";
import { acquireJobLock } from "../job-lock.ts";
import { captureException, logEvent, recordMetric } from "../observability.ts";
import {
  buildLapseUpdate,
  type LapseUpdate,
  type SweepCandidate,
  type SweepResult,
} from "../appstore/expiry-sweep.ts";

/** Default grace window past flipdesk_period_end before a lost-signal lapse. */
export const GOOGLEPLAY_SWEEP_GRACE_MS = 72 * 60 * 60 * 1000; // 72h

const BATCH_LIMIT = 500;

/** Subscription statuses that still grant entitlement and are sweep candidates. */
const ENTITLED_STATUSES = ["active", "trialing"] as const;

/**
 * Pure predicate: should this row be lapsed given `nowMs` and the grace window?
 * Only googleplay-billed rows still entitled ('active'/'trialing') with a
 * parseable flipdesk_period_end that elapsed more than `graceMs` ago qualify.
 * Stripe/appstore/null billing_source rows are always excluded.
 */
export function isGooglePlayLapseEligible(
  u: SweepCandidate,
  nowMs: number,
  graceMs: number,
): boolean {
  if (u.billing_source !== "googleplay") return false;
  if (!ENTITLED_STATUSES.includes(u.subscription_status as never)) return false;
  if (!u.flipdesk_period_end) return false;
  const end = Date.parse(u.flipdesk_period_end);
  if (!Number.isFinite(end)) return false;
  return end <= nowMs - graceMs;
}

/**
 * Deterministic audit-event id for a lapse. Derived from (user, period_end) so
 * a re-run — or a late RTDN covering the same period — collides on the unique
 * stripe_event_id and is ignored.
 */
export function googlePlaySweepEventId(userId: string, periodEnd: string | null): string {
  return `googleplay:sweep:${userId}:${periodEnd ?? "none"}`;
}

/** Injectable side-effects so the sweep is unit-testable without a database. */
export interface GooglePlaySweepDeps {
  now: () => number;
  graceMs: number;
  loadCandidates: (cutoffIso: string) => Promise<SweepCandidate[]>;
  lapseUser: (id: string, update: LapseUpdate) => Promise<boolean>;
  recordEvent: (u: SweepCandidate, eventId: string, nowIso: string) => Promise<void>;
}

/**
 * Core sweep, decoupled from Supabase. Loads candidates, re-verifies each with
 * the pure predicate, lapses the genuinely-stale ones, and records one audit
 * event per lapse.
 */
export async function sweepExpiredGooglePlaySubs(
  deps: GooglePlaySweepDeps,
): Promise<SweepResult> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoffIso = new Date(nowMs - deps.graceMs).toISOString();

  const candidates = await deps.loadCandidates(cutoffIso);
  let lapsed = 0;

  for (const u of candidates) {
    // Defensive re-check: never trust the query alone to keep other-source rows safe.
    if (!isGooglePlayLapseEligible(u, nowMs, deps.graceMs)) continue;

    const changed = await deps.lapseUser(u.id, buildLapseUpdate(nowIso));
    if (!changed) continue;

    lapsed++;
    await deps.recordEvent(u, googlePlaySweepEventId(u.id, u.flipdesk_period_end), nowIso);
    logEvent("warn", "googleplay.sweep.lapsed", {
      userId: u.id,
      fromPlan: u.flipdesk_plan,
      periodEnd: u.flipdesk_period_end,
    });
  }

  return { scanned: candidates.length, lapsed, cutoff: cutoffIso };
}

/** Build the production deps backed by the service-role Supabase client. */
function supabaseDeps(graceMs: number): GooglePlaySweepDeps {
  return {
    now: () => Date.now(),
    graceMs,
    loadCandidates: async (cutoffIso) => {
      const { data, error } = await supabaseAdmin
        .from("users")
        .select("id, billing_source, subscription_status, flipdesk_period_end, flipdesk_plan")
        .eq("billing_source", "googleplay")
        .in("subscription_status", [...ENTITLED_STATUSES])
        .lt("flipdesk_period_end", cutoffIso)
        .limit(BATCH_LIMIT);
      if (error) throw new Error(`googleplay-sweep scan failed: ${error.message}`);
      return (data ?? []) as SweepCandidate[];
    },
    lapseUser: async (id, update) => {
      // Re-assert the googleplay + entitled guard in the UPDATE so a concurrent
      // verify that just reactivated the user (or a Stripe switch) is not
      // clobbered — the row only flips if it still matches the stale criteria.
      const { data, error } = await supabaseAdmin
        .from("users")
        .update(update)
        .eq("id", id)
        .eq("billing_source", "googleplay")
        .in("subscription_status", [...ENTITLED_STATUSES])
        .select("id");
      if (error) {
        captureException(error, { route: "googleplay-sweep.lapse", tags: { userId: id } });
        return false;
      }
      return (data?.length ?? 0) > 0;
    },
    recordEvent: async (u, eventId, _nowIso) => {
      const { error } = await supabaseAdmin.from("flipdesk_subscription_events").insert({
        user_id: u.id,
        stripe_event_id: eventId,
        event_type: "googleplay.sweep.expired",
        from_plan: u.flipdesk_plan,
        to_plan: "free",
        raw_payload: {
          reason: "no_rtdn_backstop",
          period_end: u.flipdesk_period_end,
          grace_ms: graceMs,
        },
      });
      // 23505 = duplicate (already swept this period); anything else is logged.
      if (error && error.code !== "23505") {
        captureException(error, { route: "googleplay-sweep.audit", tags: { userId: u.id } });
      }
    },
  };
}

function graceMsFromEnv(): number {
  const raw = Number(Deno.env.get("GOOGLEPLAY_SWEEP_GRACE_HOURS"));
  return Number.isFinite(raw) && raw > 0 ? raw * 60 * 60 * 1000 : GOOGLEPLAY_SWEEP_GRACE_MS;
}

export async function handleGooglePlayExpirySweepCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("googleplay-expiry-sweep", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await sweepExpiredGooglePlaySubs(supabaseDeps(graceMsFromEnv()));
    if (result.lapsed > 0) {
      recordMetric("googleplay.sweep.lapsed", result.lapsed, {});
      console.warn(
        `[googleplay-sweep] lapsed ${result.lapsed} stale Google Play subscription(s) past grace`,
      );
    }
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "googleplay-expiry-sweep.cron" });
    return c.json({ error: "Google Play expiry sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
