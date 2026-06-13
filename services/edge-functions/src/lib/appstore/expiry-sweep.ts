// US-811: App Store subscription expiry sweep (scheduled backstop).
//
// Apple-billed entitlement state normally changes via POST /api/webhooks/appstore
// (App Store Server Notifications V2) or the client /appstore/verify call. If
// BOTH are missed after a subscription expires — a lost/dropped notification and
// no client re-verify — the user would stay on a paid plan indefinitely.
//
// This job is the backstop: it finds users whose billing_source='appstore' and
// subscription_status is still 'active'/'trialing' but whose flipdesk_period_end
// elapsed more than a generous grace window ago (default 72h, env-tunable), and
// lapses them to free/canceled, writing an 'appstore:sweep:' audit row.
//
// Apple retries notifications for days, so the grace window is intentionally
// generous and we log loudly whenever the sweep actually lapses someone — a
// non-zero result means a notification was genuinely lost, not just slow.
//
// Stripe-billed users are NEVER touched: the selection is scoped to
// billing_source='appstore' in the query AND re-checked by isLapseEligible().
//
// Idempotent: lapsing flips subscription_status off 'active'/'trialing' so the
// row no longer matches on the next run, and the audit event id is derived from
// (user, period_end) so a re-run can't write a duplicate.
//
// Mounted in main.ts as POST /api/jobs/appstore-expiry-sweep, OUTSIDE the /api/*
// JWT groups, gated by X-Internal-Job-Secret (same pattern as the other crons).

import { supabaseAdmin } from "../supabase.ts";
import { requireJobSecret } from "../job-auth.ts";
import { acquireJobLock } from "../job-lock.ts";
import { captureException, logEvent, recordMetric } from "../observability.ts";

/** Default grace window past flipdesk_period_end before a lost-notification lapse. */
export const APPSTORE_SWEEP_GRACE_MS = 72 * 60 * 60 * 1000; // 72h

const BATCH_LIMIT = 500;

/** Subscription statuses that still grant entitlement and are sweep candidates. */
const ENTITLED_STATUSES = ["active", "trialing"] as const;

/** The subset of a users row the sweep reasons about. */
export interface SweepCandidate {
  id: string;
  billing_source: string | null;
  subscription_status: string | null;
  flipdesk_period_end: string | null;
  flipdesk_plan: string | null;
}

/** Columns written when a stale appstore subscription is lapsed to free. */
export interface LapseUpdate {
  flipdesk_plan: "free";
  flipdesk_interval: null;
  subscription_status: "canceled";
  flipdesk_cancel_at_period_end: false;
  updated_at: string;
}

/**
 * Pure predicate: should this row be lapsed given `nowMs` and the grace window?
 *
 * Only appstore-billed rows that are still entitled ('active'/'trialing') with a
 * parseable flipdesk_period_end that elapsed more than `graceMs` ago qualify.
 * Stripe-billed (or null billing_source) rows and rows with no/unparseable
 * period end are always excluded.
 */
export function isLapseEligible(
  u: SweepCandidate,
  nowMs: number,
  graceMs: number,
): boolean {
  if (u.billing_source !== "appstore") return false;
  if (!ENTITLED_STATUSES.includes(u.subscription_status as never)) return false;
  if (!u.flipdesk_period_end) return false;
  const end = Date.parse(u.flipdesk_period_end);
  if (!Number.isFinite(end)) return false;
  return end <= nowMs - graceMs;
}

/** Pure: the users-row patch for a lapse at `nowIso`. */
export function buildLapseUpdate(nowIso: string): LapseUpdate {
  return {
    flipdesk_plan: "free",
    flipdesk_interval: null,
    subscription_status: "canceled",
    flipdesk_cancel_at_period_end: false,
    updated_at: nowIso,
  };
}

/**
 * Deterministic audit-event id for a lapse. Derived from (user, period_end) so
 * re-running the sweep — or a late Apple notification covering the same period —
 * collides on the unique stripe_event_id and is ignored, keeping the audit trail
 * free of duplicate sweep rows.
 */
export function sweepEventId(userId: string, periodEnd: string | null): string {
  return `appstore:sweep:${userId}:${periodEnd ?? "none"}`;
}

export interface SweepResult {
  scanned: number;
  lapsed: number;
  cutoff: string;
}

/** Injectable side-effects so the sweep is unit-testable without a database. */
export interface SweepDeps {
  now: () => number;
  graceMs: number;
  /** Candidate rows already filtered to billing_source='appstore' + entitled + stale. */
  loadCandidates: (cutoffIso: string) => Promise<SweepCandidate[]>;
  /** Apply the lapse patch; return true if a row was actually updated. */
  lapseUser: (id: string, update: LapseUpdate) => Promise<boolean>;
  /** Best-effort audit write (idempotent on sweepEventId). */
  recordEvent: (u: SweepCandidate, eventId: string, nowIso: string) => Promise<void>;
}

/**
 * Core sweep, decoupled from Supabase. Loads candidates, re-verifies each with
 * the pure predicate, lapses the genuinely-stale ones, and records one audit
 * event per lapse. Re-running after a sweep finds no candidates (the rows are no
 * longer entitled) and so produces no further changes or events.
 */
export async function sweepExpiredAppstoreSubs(deps: SweepDeps): Promise<SweepResult> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoffIso = new Date(nowMs - deps.graceMs).toISOString();

  const candidates = await deps.loadCandidates(cutoffIso);
  let lapsed = 0;

  for (const u of candidates) {
    // Defensive re-check: never trust the query alone to keep Stripe rows safe.
    if (!isLapseEligible(u, nowMs, deps.graceMs)) continue;

    const changed = await deps.lapseUser(u.id, buildLapseUpdate(nowIso));
    if (!changed) continue;

    lapsed++;
    await deps.recordEvent(u, sweepEventId(u.id, u.flipdesk_period_end), nowIso);
    logEvent("warn", "appstore.sweep.lapsed", {
      userId: u.id,
      fromPlan: u.flipdesk_plan,
      periodEnd: u.flipdesk_period_end,
    });
  }

  return { scanned: candidates.length, lapsed, cutoff: cutoffIso };
}

/** Build the production deps backed by the service-role Supabase client. */
function supabaseDeps(graceMs: number): SweepDeps {
  return {
    now: () => Date.now(),
    graceMs,
    loadCandidates: async (cutoffIso) => {
      const { data, error } = await supabaseAdmin
        .from("users")
        .select("id, billing_source, subscription_status, flipdesk_period_end, flipdesk_plan")
        .eq("billing_source", "appstore")
        .in("subscription_status", [...ENTITLED_STATUSES])
        .lt("flipdesk_period_end", cutoffIso)
        .limit(BATCH_LIMIT);
      if (error) throw new Error(`appstore-sweep scan failed: ${error.message}`);
      return (data ?? []) as SweepCandidate[];
    },
    lapseUser: async (id, update) => {
      // Re-assert the appstore + entitled guard in the UPDATE so a concurrent
      // webhook that just reactivated the user (or a Stripe switch) is not
      // clobbered — the row only flips if it still matches the stale criteria.
      const { data, error } = await supabaseAdmin
        .from("users")
        .update(update)
        .eq("id", id)
        .eq("billing_source", "appstore")
        .in("subscription_status", [...ENTITLED_STATUSES])
        .select("id");
      if (error) {
        captureException(error, { route: "appstore-sweep.lapse", tags: { userId: id } });
        return false;
      }
      return (data?.length ?? 0) > 0;
    },
    recordEvent: async (u, eventId, _nowIso) => {
      const { error } = await supabaseAdmin.from("flipdesk_subscription_events").insert({
        user_id: u.id,
        stripe_event_id: eventId,
        event_type: "appstore.sweep.expired",
        from_plan: u.flipdesk_plan,
        to_plan: "free",
        raw_payload: {
          reason: "lost_notification_backstop",
          period_end: u.flipdesk_period_end,
          grace_ms: graceMs,
        },
      });
      // 23505 = duplicate (already swept this period); anything else is logged.
      if (error && error.code !== "23505") {
        captureException(error, { route: "appstore-sweep.audit", tags: { userId: u.id } });
      }
    },
  };
}

function graceMsFromEnv(): number {
  const raw = Number(Deno.env.get("APPSTORE_SWEEP_GRACE_HOURS"));
  return Number.isFinite(raw) && raw > 0 ? raw * 60 * 60 * 1000 : APPSTORE_SWEEP_GRACE_MS;
}

export async function handleAppstoreExpirySweepCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("appstore-expiry-sweep", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await sweepExpiredAppstoreSubs(supabaseDeps(graceMsFromEnv()));
    if (result.lapsed > 0) {
      recordMetric("appstore.sweep.lapsed", result.lapsed, {});
      console.warn(
        `[appstore-sweep] lapsed ${result.lapsed} stale appstore subscription(s) past grace`,
      );
    }
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "appstore-expiry-sweep.cron" });
    return c.json({ error: "App Store expiry sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}
