import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

// Admin abuse / fraud dashboard (US-591). Moderation (admin-moderation.ts) acts
// one-flagged-submission-at-a-time; this gives operators the AGGREGATE,
// cross-account view needed to act on repeat offenders and chargebacks
// proactively. It is READ-ONLY — every actionable signal links back to the
// per-user surface (/admin/users/:id, which already hosts the audited
// suspend / credit / impersonate actions) so this complements, rather than
// duplicates, per-submission moderation.
//
// Mounted at /api/admin/fraud, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. Reads cross-tenant
// by design — the legitimate admin use the service-role client exists for.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminFraudRoutes = new Hono<AdminEnv>();

// Hard caps so a single query can never pull an unbounded result set off a busy
// platform. Each abuse signal works off a small, targeted slice (flagged /
// rejected submissions, active rate-limit buckets, payment-linked users), so
// these are generous headroom rather than expected truncation points; when a
// cap bites we say so in `truncated` instead of silently under-reporting.
const FLAGGED_CAP = 5000;
const VELOCITY_WINDOW_CAP = 2000;
const PAYMENT_USERS_CAP = 10000;
const RATE_BUCKET_CAP = 2000;

// A bucket is only interesting once it's been hit a lot inside its window.
const RATE_LIMIT_THRESHOLD = 30;
// A single account creating this many submissions in 24h is a velocity signal.
const SUBMISSION_BURST_THRESHOLD = 8;

// US-2398: the tier shown beside a fraud signal is `flipdesk_plan`. The legacy
// `users.plan` has not moved since the 00039 backfill, so a console sourced from
// it labelled every account created since as 'free' — which is the single field
// a reviewer uses to judge whether a suspension costs us a paying customer.
interface UserLite {
  id: string;
  email: string | null;
  full_name: string | null;
  flipdesk_plan: string | null;
  suspended: boolean | null;
  stripe_customer_id: string | null;
  created_at: string | null;
}

// Resolve a set of user ids to lightweight profiles in one round trip.
async function loadUsers(ids: string[]): Promise<Map<string, UserLite>> {
  const map = new Map<string, UserLite>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return map;
  const { data } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name, flipdesk_plan, suspended, stripe_customer_id, created_at")
    .in("id", unique);
  for (const u of (data ?? []) as UserLite[]) map.set(u.id, u);
  return map;
}

// GET /overview — one aggregate payload powering the whole dashboard.
adminFraudRoutes.get("/overview", async (c: Context<AdminEnv>) => {
  const nowMs = Date.now();
  const since24h = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const truncated: string[] = [];

  // ── 1. Repeat offenders ────────────────────────────────────────────
  // The abuse subset of submissions only: anything flagged or rejected by
  // moderation. This is small relative to total volume, so per-user counts are
  // accurate without a full table scan.
  const { data: abuseSubsRaw } = await supabaseAdmin
    .from("submissions")
    .select("user_id, flagged, flag_reason, moderation_status, created_at")
    .or("flagged.eq.true,moderation_status.eq.rejected")
    .order("created_at", { ascending: false })
    .limit(FLAGGED_CAP);
  const abuseSubs = (abuseSubsRaw ?? []) as Array<{
    user_id: string;
    flagged: boolean | null;
    flag_reason: string | null;
    moderation_status: string | null;
    created_at: string | null;
  }>;
  if (abuseSubs.length >= FLAGGED_CAP) truncated.push("flagged_submissions");

  interface OffenderAgg {
    userId: string;
    flaggedCount: number;
    rejectedCount: number;
    chargebackCount: number;
    lastFlagAt: string | null;
  }
  const offenders = new Map<string, OffenderAgg>();
  function offender(userId: string): OffenderAgg {
    let o = offenders.get(userId);
    if (!o) {
      o = { userId, flaggedCount: 0, rejectedCount: 0, chargebackCount: 0, lastFlagAt: null };
      offenders.set(userId, o);
    }
    return o;
  }
  for (const s of abuseSubs) {
    if (!s.user_id) continue;
    const o = offender(s.user_id);
    if (s.flagged) o.flaggedCount += 1;
    if (s.moderation_status === "rejected") o.rejectedCount += 1;
    if (s.flag_reason === "payment_disputed") o.chargebackCount += 1;
    if (s.created_at && (!o.lastFlagAt || s.created_at > o.lastFlagAt)) {
      o.lastFlagAt = s.created_at;
    }
  }

  // ── 2. Chargebacks ─────────────────────────────────────────────────
  // Stripe disputes are recorded as flipdesk_subscription_events rows
  // (handleChargeDisputeCreated in webhooks.ts) and, for per-grade charges,
  // also flagged on the submission (flag_reason=payment_disputed, already folded
  // into the offender counts above).
  const { data: disputeEventsRaw } = await supabaseAdmin
    .from("flipdesk_subscription_events")
    .select("user_id, event_type, raw_payload, created_at")
    .ilike("event_type", "%dispute%")
    .order("created_at", { ascending: false })
    .limit(500);
  const disputeEvents = (disputeEventsRaw ?? []) as Array<{
    user_id: string;
    event_type: string;
    raw_payload: Record<string, unknown> | null;
    created_at: string | null;
  }>;
  for (const ev of disputeEvents) {
    if (ev.user_id) offender(ev.user_id).chargebackCount += 1;
  }

  // ── 3. Velocity: submission bursts in the last 24h ─────────────────
  const { data: recentSubsRaw } = await supabaseAdmin
    .from("submissions")
    .select("user_id, created_at")
    .gte("created_at", since24h)
    .order("created_at", { ascending: false })
    .limit(VELOCITY_WINDOW_CAP);
  const recentSubs = (recentSubsRaw ?? []) as Array<{ user_id: string; created_at: string }>;
  if (recentSubs.length >= VELOCITY_WINDOW_CAP) truncated.push("recent_submissions");
  const burstByUser = new Map<string, number>();
  for (const s of recentSubs) {
    if (!s.user_id) continue;
    burstByUser.set(s.user_id, (burstByUser.get(s.user_id) ?? 0) + 1);
  }
  const submissionBursts = [...burstByUser.entries()]
    .filter(([, count]) => count >= SUBMISSION_BURST_THRESHOLD)
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count);

  // ── 4. Velocity: rate-limit buckets over threshold ─────────────────
  // bucket_key is "<scope>|<subject>" where subject is user:<uuid> / ip:<addr> /
  // apikey:<id> (see middleware/rate-limit.ts). The table is pruned to ~1 row
  // per active bucket, so a row over threshold means a live offender.
  const { data: bucketsRaw } = await supabaseAdmin
    .from("rate_limit_counters")
    .select("bucket_key, count, window_start")
    .gte("count", RATE_LIMIT_THRESHOLD)
    .order("count", { ascending: false })
    .limit(RATE_BUCKET_CAP);
  const buckets = (bucketsRaw ?? []) as Array<{
    bucket_key: string;
    count: number;
    window_start: string;
  }>;
  const rateLimitHotspots = buckets.map((b) => {
    const sep = b.bucket_key.indexOf("|");
    const scope = sep === -1 ? "default" : b.bucket_key.slice(0, sep);
    const subject = sep === -1 ? b.bucket_key : b.bucket_key.slice(sep + 1);
    const colon = subject.indexOf(":");
    const subjectType = colon === -1 ? "unknown" : subject.slice(0, colon);
    const subjectId = colon === -1 ? subject : subject.slice(colon + 1);
    return {
      scope,
      subjectType, // "user" | "ip" | "apikey" | "unknown"
      subjectId,
      userId: subjectType === "user" ? subjectId : null,
      count: b.count,
      windowStart: b.window_start,
    };
  });

  // ── 5. Duplicate accounts / shared payment ─────────────────────────
  // Distinct user rows sharing one Stripe customer id = the strongest
  // shared-payment / sock-puppet signal we can derive without IP history.
  const { data: payingUsersRaw } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name, flipdesk_plan, suspended, stripe_customer_id, created_at")
    .not("stripe_customer_id", "is", null)
    .limit(PAYMENT_USERS_CAP);
  const payingUsers = (payingUsersRaw ?? []) as UserLite[];
  if (payingUsers.length >= PAYMENT_USERS_CAP) truncated.push("paying_users");
  const byCustomer = new Map<string, UserLite[]>();
  for (const u of payingUsers) {
    const cid = u.stripe_customer_id;
    if (!cid) continue;
    const list = byCustomer.get(cid) ?? [];
    list.push(u);
    byCustomer.set(cid, list);
  }
  const duplicateAccounts = [...byCustomer.entries()]
    .filter(([, users]) => users.length > 1)
    .map(([stripeCustomerId, users]) => ({
      stripeCustomerId,
      accounts: users
        .map((u) => ({
          userId: u.id,
          email: u.email,
          fullName: u.full_name,
          suspended: !!u.suspended,
          createdAt: u.created_at,
        }))
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
    }))
    .sort((a, b) => b.accounts.length - a.accounts.length);

  // ── Resolve user profiles for every signal that references one ─────
  const referencedIds = [
    ...offenders.keys(),
    ...submissionBursts.map((b) => b.userId),
    ...disputeEvents.map((e) => e.user_id),
    ...rateLimitHotspots.map((h) => h.userId).filter((id): id is string => !!id),
  ];
  const users = await loadUsers(referencedIds);

  function decorate(userId: string) {
    const u = users.get(userId);
    return {
      userId,
      email: u?.email ?? null,
      fullName: u?.full_name ?? null,
      plan: u?.flipdesk_plan ?? null,
      suspended: !!u?.suspended,
    };
  }

  // A repeat offender is anyone with >=2 flagged items, a rejection, or a
  // chargeback — i.e. a pattern, not a single bad submission. Sort the worst
  // first by a simple weighted score (chargebacks hurt most).
  const repeatOffenders = [...offenders.values()]
    .filter((o) => o.flaggedCount >= 2 || o.rejectedCount >= 1 || o.chargebackCount >= 1)
    .map((o) => ({
      ...decorate(o.userId),
      flaggedCount: o.flaggedCount,
      rejectedCount: o.rejectedCount,
      chargebackCount: o.chargebackCount,
      lastFlagAt: o.lastFlagAt,
      score: o.chargebackCount * 5 + o.rejectedCount * 3 + o.flaggedCount,
    }))
    .sort((a, b) => b.score - a.score);

  const velocitySubmissions = submissionBursts.map((b) => ({
    ...decorate(b.userId),
    count24h: b.count,
  }));

  const chargebacks = disputeEvents.map((ev) => {
    const payload = ev.raw_payload ?? {};
    return {
      ...decorate(ev.user_id),
      eventType: ev.event_type,
      reason: typeof payload.reason === "string" ? payload.reason : null,
      submissionId:
        typeof payload.submission_id === "string" ? payload.submission_id : null,
      at: ev.created_at,
    };
  });

  // Decorate rate-limit hotspots that map to a known user.
  const velocityRateLimits = rateLimitHotspots.map((h) => ({
    ...h,
    user: h.userId ? decorate(h.userId) : null,
  }));

  const suspendedCount = [...users.values()].filter((u) => u.suspended).length;

  return c.json({
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      repeatOffenders: repeatOffenders.length,
      velocityAlerts: velocitySubmissions.length + velocityRateLimits.length,
      duplicateAccounts: duplicateAccounts.length,
      chargebacks: chargebacks.length,
      suspendedAccountsInView: suspendedCount,
    },
    repeatOffenders,
    velocitySubmissions,
    velocityRateLimits,
    duplicateAccounts,
    chargebacks,
    truncated,
  });
});
