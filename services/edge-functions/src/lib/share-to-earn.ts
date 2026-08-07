// US-1854: the share-to-earn loop — share a graded find, get paid when real
// people follow it back.
//
// THE ONE DECISION THIS FILE ENCODES: pressing "share" is TRACKED but pays
// nothing. The XP lands on the verified click-through, and it escalates as a
// find's verified reach grows. A button that pays on press is a button to mash,
// and there is no cost to mashing it — the sharer controls both ends.
//
//   press share      → share_events row (tracked, 0 XP, rate-limited)
//   1st real click   → `verified_share` (20 XP, badge-analytics, once per find)
//   3 / 10 / 25 uniq → `share_milestone` (25 / 60 / 150 XP, once each per find)
//   a signup         → `share_milestone` (signup, 150 XP) + the existing
//                      referral credits, which are the "credit" half of AC1
//
// Everything above the DB-helpers divider is PURE and unit-tested without a
// database. Contract: vault/20-domain/reward-ledger.md.

import { supabaseAdmin } from "./supabase.ts";
import { captureException } from "./observability.ts";
import { grantReward } from "./rewards-engine.ts";

export type ShareTargetType = "cert";

export function isShareTargetType(v: unknown): v is ShareTargetType {
  return v === "cert";
}

/**
 * The channels the certificate share sheet can emit (cert-share-actions.tsx).
 * An allow-list rather than free text: the channel is stored, aggregated and
 * shown back, so an unbounded string is an unbounded label.
 */
export const SHARE_CHANNELS = new Set([
  "native",
  "clipboard",
  "x",
  "facebook",
  "pinterest",
  "whatsapp",
  "reddit",
  "email",
]);

/** Normalise a caller-supplied channel, or null when it isn't one of ours. */
export function normalizeShareChannel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toLowerCase();
  return SHARE_CHANNELS.has(c) ? c : null;
}

/** The `?s=` sources that count as "someone followed the shared link back". */
export const SHARE_CLICK_SOURCES = new Set(["share"]);

// ─── The escalating ladder (AC3) ─────────────────────────────────────────────

export interface ShareMilestone {
  key: string;
  /** Distinct, non-self verified click-throughs the find must have earned. */
  clicks: number;
  xp: number;
  label: string;
}

/**
 * Escalating, not linear: the second real person to follow a find back is
 * ordinary, the twenty-fifth is a find that genuinely travelled. Each rung pays
 * ONCE per find (the dedupe key is `share:<target>:<rung>`), so the ladder is
 * finite — a single find can earn at most 20 + 25 + 60 + 150 XP no matter how
 * many times its link is opened.
 */
export const SHARE_MILESTONES: readonly ShareMilestone[] = [
  { key: "spark", clicks: 3, xp: 25, label: "3 people opened your find" },
  { key: "buzz", clicks: 10, xp: 60, label: "10 people opened your find" },
  { key: "viral", clicks: 25, xp: 150, label: "25 people opened your find" },
];

/**
 * A signup is the strongest verification a share can produce — a real person
 * made an account off it — so it pays the top rung outright rather than waiting
 * for the click count to get there. Same one-per-find dedupe as the rest.
 */
export const SHARE_SIGNUP_MILESTONE: ShareMilestone = {
  key: "signup",
  clicks: 0,
  xp: 150,
  label: "Someone joined GradeThread from your find",
};

/** The rungs a click count has reached. Pure. */
export function milestonesForClicks(clicks: number): ShareMilestone[] {
  if (!Number.isFinite(clicks)) return [];
  return SHARE_MILESTONES.filter((m) => clicks >= m.clicks);
}

/** The next rung to aim for, or null once the ladder is topped out. Pure. */
export function nextShareMilestone(clicks: number): ShareMilestone | null {
  const n = Number.isFinite(clicks) ? clicks : 0;
  return SHARE_MILESTONES.find((m) => n < m.clicks) ?? null;
}

/**
 * The rungs that make a find "viral" for the `viral_find` medal (US-1850).
 * Deliberately the TOP click rung or a signup — the medal says a single find
 * travelled, so it must not be earnable by sharing many finds once each.
 */
export function isViralShareMilestone(key: string): boolean {
  return key === "viral" || key === SHARE_SIGNUP_MILESTONE.key;
}

// ─── Fraud gates (AC2) ───────────────────────────────────────────────────────

// Crawlers, previews and link-unfurlers. Every social channel fetches a shared
// URL to build its card, so without this the act of posting a link would
// manufacture its own "verified" clicks — the exact farming path AC2 names.
const BOT_UA_MARKERS = [
  "bot",
  "crawler",
  "spider",
  "slurp",
  "preview",
  "fetcher",
  "monitor",
  "curl/",
  "wget",
  "python-requests",
  "headlesschrome",
  "facebookexternalhit",
  "whatsapp",
  "telegrambot",
  "discordbot",
  "slackbot",
  "embedly",
  "quora link preview",
  "pinterest",
  "redditbot",
  "linkedinbot",
  "skypeuripreview",
  "vkshare",
  "applebot",
  "google-inspectiontool",
];

/**
 * True when a User-Agent is (or looks like) an automated fetcher. Pure.
 *
 * Fails CLOSED on a MISSING agent: a real browser always sends one, an unfurler
 * often does not, and this predicate guards an XP faucet — so "no evidence of a
 * human" must mean "no reward", not "assume human".
 */
export function isLikelyBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return true;
  const s = ua.toLowerCase();
  if (s.length < 12) return true;
  return BOT_UA_MARKERS.some((m) => s.includes(m));
}

/**
 * A pseudonymous visitor handle: salted SHA-256 over (ip, user-agent),
 * truncated. This is NOT an identity and is deliberately not reversible to one —
 * it exists to answer two questions and no others: "is this the same visitor as
 * the last click?" and "is this the seller clicking their own link?".
 *
 * Returns null when there is no trustworthy IP (the caller passes
 * `clientIp(c)`, which is null unless the request provably transited
 * Cloudflare). No trustworthy fingerprint ⇒ the click is recorded for the
 * funnel but earns nothing — fail-closed, because a spoofable handle would make
 * "unique clicks" mean "however many times the header was rotated".
 */
export async function visitorFingerprint(
  ip: string | null | undefined,
  userAgent: string | null | undefined,
): Promise<string | null> {
  if (!ip) return null;
  const salt = Deno.env.get("SHARE_FINGERPRINT_SALT") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "";
  if (!salt) return null;
  const data = new TextEncoder().encode(`${salt}|${ip}|${userAgent ?? ""}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // 128 bits is far more than enough to distinguish visitors and keeps the
  // stored value small.
  return hex.slice(0, 32);
}

// ─── Rate limits (AC2) ───────────────────────────────────────────────────────

/** Tracked shares one seller may record per day. Generous — this is an abuse
 *  ceiling on a free action, not a product limit. */
export const SHARE_RECORD_DAILY_CAP = 100;

/** Milestone grants one seller may earn per day, across all their finds. The
 *  per-find ladder is already finite, so this bounds the OTHER farming shape:
 *  many finds, each pushed over a rung by manufactured clicks. */
export const SHARE_MILESTONE_DAILY_CAP = 25;

const DAY_MS = 86_400_000;

/** UTC day floor as an ISO string — the fixed window for the counters above. */
export function dayWindowStart(nowMs: number): string {
  return new Date(Math.floor(nowMs / DAY_MS) * DAY_MS).toISOString();
}

/**
 * Increment a daily counter and report whether the caller is still under `cap`.
 * Uses the SHARED rate_limit_counters store (00045) so the ceiling holds across
 * replicas. Fails OPEN on a store error — a counter outage must not silently
 * stop paying people who earned it.
 */
async function underDailyCap(
  bucketKey: string,
  cap: number,
  nowMs: number,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("increment_rate_limit", {
    p_bucket_key: bucketKey,
    p_window_start: dayWindowStart(nowMs),
  });
  if (error || typeof data !== "number") return true;
  return data <= cap;
}

// ─── DB helpers (service-role; scope every query by owner — US-268) ──────────

/**
 * Resolve the seller who owns a certificate, or null. Server-side ONLY — the
 * caller never gets to say whose find it is.
 */
async function resolveCertOwner(certificateId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("grade_reports")
    .select("submissions!inner(user_id)")
    .eq("certificate_id", certificateId)
    .not("certificate_id", "is", null)
    .maybeSingle();
  const sub = (data as
    | { submissions?: { user_id?: string } | Array<{ user_id?: string }> }
    | null)?.submissions;
  const row = Array.isArray(sub) ? sub[0] : sub;
  return row?.user_id ?? null;
}

export type RecordShareResult =
  | { ok: true }
  | { ok: false; reason: "not_owner" | "rate_limited" | "error" };

/**
 * Record a tracked share (AC1). Pays NOTHING — see the file header.
 *
 * Tenant isolation (US-268): the certificate's owner is resolved server-side and
 * must equal the authenticated caller, so a caller cannot attach a share to
 * someone else's find (which would poison that seller's self-click hash and let
 * an attacker suppress their rewards).
 */
export async function recordShare(input: {
  userId: string;
  targetType: ShareTargetType;
  targetId: string;
  channel: string;
  sharerHash: string | null;
  nowMs?: number;
}): Promise<RecordShareResult> {
  const targetId = input.targetId.trim();
  if (!targetId || targetId.length > 200) return { ok: false, reason: "not_owner" };

  try {
    const owner = await resolveCertOwner(targetId);
    if (!owner || owner !== input.userId) return { ok: false, reason: "not_owner" };

    const nowMs = input.nowMs ?? Date.now();
    if (!(await underDailyCap(`share_record:${input.userId}`, SHARE_RECORD_DAILY_CAP, nowMs))) {
      return { ok: false, reason: "rate_limited" };
    }

    const { error } = await supabaseAdmin.from("share_events").insert({
      owner_user_id: input.userId,
      target_type: input.targetType,
      target_id: targetId,
      channel: input.channel,
      sharer_hash: input.sharerHash,
    } as never);
    if (error) return { ok: false, reason: "error" };
    return { ok: true };
  } catch (err) {
    captureException(err, { level: "warn", route: "share-to-earn.record" });
    return { ok: false, reason: "error" };
  }
}

/** True when this find has at least one tracked share by its owner. */
async function hasTrackedShare(
  ownerUserId: string,
  targetType: ShareTargetType,
  targetId: string,
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("share_events")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/** Every fingerprint this owner used when sharing this find. */
async function sharerHashesFor(
  ownerUserId: string,
  targetType: ShareTargetType,
  targetId: string,
): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from("share_events")
    .select("sharer_hash")
    .eq("owner_user_id", ownerUserId)
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .limit(500);
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ sharer_hash: string | null }>) {
    if (r.sharer_hash) out.add(r.sharer_hash);
  }
  return out;
}

// One find's click history is bounded so a hot certificate can't pull an
// unbounded result set. Well above the top rung, so the count stays honest.
const CLICK_SCAN_CAP = 5_000;

/**
 * Distinct, non-self, fingerprinted verified click-throughs on one find.
 * Owner-scoped (US-268). Best-effort: a read error reports 0.
 */
export async function verifiedClickCount(
  ownerUserId: string,
  targetType: ShareTargetType,
  targetId: string,
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("badge_click_events")
    .select("visitor_hash")
    .eq("owner_user_id", ownerUserId)
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    // Read from the SAME set the recorder gates on, so widening the share
    // sources can never leave the counter reading a narrower one.
    .in("source", [...SHARE_CLICK_SOURCES])
    .eq("self_click", false)
    .not("visitor_hash", "is", null)
    .limit(CLICK_SCAN_CAP);
  if (error) return 0;
  const seen = new Set<string>();
  for (const r of (data ?? []) as Array<{ visitor_hash: string | null }>) {
    if (r.visitor_hash) seen.add(r.visitor_hash);
  }
  return seen.size;
}

/** The ledger dedupe key for one rung on one find. */
function milestoneReference(
  targetType: ShareTargetType,
  targetId: string,
  key: string,
): string {
  return `share:${targetType}:${targetId}:${key}`;
}

/**
 * The rung keys this find has ALREADY been paid for. Read before granting so a
 * replayed click doesn't burn the daily milestone cap on rungs that are
 * idempotent no-ops. Best-effort: on a read error nothing is treated as paid and
 * the dedupe key still prevents a double award.
 */
async function paidMilestoneKeys(
  ownerUserId: string,
  targetType: ShareTargetType,
  targetId: string,
): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from("reputation_events")
    .select("reference_id")
    .eq("user_id", ownerUserId)
    .eq("event_type", "share_milestone")
    .like("reference_id", `${milestoneReference(targetType, targetId, "")}%`)
    .limit(50);
  const out = new Set<string>();
  const prefix = milestoneReference(targetType, targetId, "");
  for (const r of (data ?? []) as Array<{ reference_id: string }>) {
    if (r.reference_id?.startsWith(prefix)) out.add(r.reference_id.slice(prefix.length));
  }
  return out;
}

/**
 * Grant one milestone. Idempotent by construction — `grantReward`'s dedupe key
 * is `share:<type>:<id>:<rung>`, so a rung pays once per find no matter how many
 * clicks re-trigger the evaluation.
 */
async function grantShareMilestone(
  ownerUserId: string,
  targetType: ShareTargetType,
  targetId: string,
  milestone: ShareMilestone,
): Promise<void> {
  await grantReward(ownerUserId, "share_milestone", {
    referenceId: milestoneReference(targetType, targetId, milestone.key),
    source: "share_to_earn",
    metadata: {
      award_xp: milestone.xp,
      milestone: milestone.key,
      target_type: targetType,
    },
  });
}

/**
 * Evaluate a find's escalating rewards after a verified click (AC3). Called from
 * the click recorder; best-effort by construction — it must never fail the
 * public page that pinged us.
 *
 * Gates, in order: the find must actually have been shared through us; the daily
 * milestone cap must not be exhausted; and only rungs the DISTINCT non-self
 * click count has genuinely reached are granted.
 */
export async function evaluateShareMilestones(
  ownerUserId: string,
  targetType: ShareTargetType,
  targetId: string,
  nowMs: number = Date.now(),
): Promise<string[]> {
  try {
    if (!(await hasTrackedShare(ownerUserId, targetType, targetId))) return [];

    const clicks = await verifiedClickCount(ownerUserId, targetType, targetId);
    const alreadyPaid = await paidMilestoneKeys(ownerUserId, targetType, targetId);
    const reached = milestonesForClicks(clicks).filter((m) => !alreadyPaid.has(m.key));
    if (reached.length === 0) return [];

    const granted: string[] = [];
    for (const m of reached) {
      if (!(await underDailyCap(`share_milestone:${ownerUserId}`, SHARE_MILESTONE_DAILY_CAP, nowMs))) {
        break;
      }
      await grantShareMilestone(ownerUserId, targetType, targetId, m);
      granted.push(m.key);
    }
    return granted;
  } catch (err) {
    captureException(err, { level: "warn", route: "share-to-earn.milestones" });
    return [];
  }
}

/**
 * A signup landed on a shared find (AC3's "or a signup"). Pays the top rung.
 *
 * The CREDIT half of AC1 is not minted here: a signup through a baked referral
 * link already pays the sharer grade credits through the referral reward loop
 * (referrals.ts). A second credit faucet on the same event would pay twice for
 * one act — this adds the XP the referral loop does not.
 */
export async function recordShareSignup(
  ownerUserId: string,
  targetType: ShareTargetType,
  targetId: string,
): Promise<boolean> {
  try {
    if (!(await hasTrackedShare(ownerUserId, targetType, targetId))) return false;
    await grantShareMilestone(ownerUserId, targetType, targetId, SHARE_SIGNUP_MILESTONE);
    return true;
  } catch (err) {
    captureException(err, { level: "warn", route: "share-to-earn.signup" });
    return false;
  }
}

/**
 * The certificate id a landing path points at, or null. Pure.
 *
 * A referral signup is stamped onto the affiliate click it converted, and that
 * click's `landing_path` is the only record of WHICH find brought the visitor.
 */
export function certIdFromLandingPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const m = /^\/cert\/([A-Za-z0-9_-]{1,200})\/?$/.exec(path.split("?")[0]!.trim());
  return m ? m[1]! : null;
}

// ─── Seller-facing summary ───────────────────────────────────────────────────

export interface ShareLoopStats {
  shares: number;
  verified_clicks: number;
  milestones_earned: string[];
  next_milestone: { key: string; clicks: number; xp: number; label: string } | null;
}

/**
 * What one find has earned from being shared — the numbers the share panel
 * shows its owner. Owner-scoped (US-268): the caller's id IS the scope, so this
 * cannot report someone else's find even if handed their certificate id.
 */
export async function shareLoopStats(
  ownerUserId: string,
  targetType: ShareTargetType,
  targetId: string,
): Promise<ShareLoopStats> {
  const { count } = await supabaseAdmin
    .from("share_events")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", ownerUserId)
    .eq("target_type", targetType)
    .eq("target_id", targetId);

  const shares = count ?? 0;
  const verified = shares > 0
    ? await verifiedClickCount(ownerUserId, targetType, targetId)
    : 0;

  return {
    shares,
    verified_clicks: verified,
    milestones_earned: milestonesForClicks(verified).map((m) => m.key),
    next_milestone: nextShareMilestone(verified),
  };
}

/** Sharer-hash lookup used by the click recorder to spot a self-click. */
export async function isSelfClick(
  ownerUserId: string,
  targetType: ShareTargetType,
  targetId: string,
  visitorHash: string | null,
): Promise<boolean> {
  if (!visitorHash) return false;
  const hashes = await sharerHashesFor(ownerUserId, targetType, targetId);
  return hashes.has(visitorHash);
}
