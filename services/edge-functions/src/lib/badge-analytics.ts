// Badge click attribution + funnel (US-1760).
//
// Records a click on an off-platform GradeThread badge (a per-item certificate
// badge or a verified-seller storefront badge) tagged with its ?s= source, and
// aggregates the seller's clicks-by-source alongside their referral conversions.
// The owner (the seller whose badge it is) is resolved SERVER-SIDE from the cert
// or handle — a caller can never attribute a click to someone else. No buyer PII
// is stored. Reads are owner-scoped (seller funnel) or platform-wide (admin).

import { supabaseAdmin } from "./supabase.ts";
import { captureException } from "./observability.ts";
import { grantReward } from "./rewards-engine.ts";
import {
  evaluateShareMilestones,
  isLikelyBotUserAgent,
  isSelfClick,
  SHARE_CLICK_SOURCES,
} from "./share-to-earn.ts";

// The ?s= sources that represent a genuine click-through to a seller's grade
// (as opposed to a direct visit). Kept tight so the funnel stays meaningful.
// US-1844: `buyer` = a trust badge clicked inside a GradeThread buyer surface
// (extension overlay, alerts, watchlist, portfolio) — same attribution ledger.
// US-1854: `share` = someone followed a link the seller shared from the cert
// share sheet. It is the same question the other four answer — "did a real
// person come back to this grade because of it?" — so it rides the same ledger
// rather than a parallel one, and the funnel gains a `share` bucket.
export const BADGE_CLICK_SOURCES = new Set([
  "embed",
  "badge",
  "qr",
  "buyer",
  "share",
]);

export type BadgeTargetType = "cert" | "seller";

export function isBadgeTargetType(v: unknown): v is BadgeTargetType {
  return v === "cert" || v === "seller";
}

/** Resolve the seller who owns a clicked badge target, or null. */
async function resolveOwner(targetType: BadgeTargetType, targetId: string): Promise<string | null> {
  if (targetType === "cert") {
    const { data } = await supabaseAdmin
      .from("grade_reports")
      .select("submissions!inner(user_id)")
      .eq("certificate_id", targetId)
      .not("certificate_id", "is", null)
      .maybeSingle();
    const sub = (data as { submissions?: { user_id?: string } | Array<{ user_id?: string }> } | null)
      ?.submissions;
    const row = Array.isArray(sub) ? sub[0] : sub;
    return row?.user_id ?? null;
  }
  // seller: resolve the verified handle to its (enabled) owner.
  const { data } = await supabaseAdmin
    .from("users")
    .select("id")
    .ilike("verified_handle", targetId)
    .eq("verified_enabled", true)
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * Record a badge click. Best-effort: resolves the owner, and inserts the event
 * only for a known badge source with a resolvable owner. Never throws — a bad
 * id / DB hiccup must not fail the (public) page that pinged it.
 */
export async function recordBadgeClick(input: {
  targetType: BadgeTargetType;
  targetId: string;
  source: string;
  /** US-1854: salted visitor fingerprint (share sources only). Null when the
   *  request carried no trustworthy IP — see visitorFingerprint. */
  visitorHash?: string | null;
  /** US-1854: raw User-Agent, used only for the bot gate on share clicks. */
  userAgent?: string | null;
}): Promise<{ recorded: boolean }> {
  try {
    const source = input.source.trim().toLowerCase();
    // Clipped once, up front: the stored id, the reward dedupe key and the
    // share-ladder lookups must all key on the SAME string or a long id would
    // silently split into two finds.
    const targetId = input.targetId.trim().slice(0, 200);
    if (!targetId || !BADGE_CLICK_SOURCES.has(source)) return { recorded: false };

    // US-1854 anti-gaming, applied to the SHARE loop only so the pre-existing
    // badge funnel keeps behaving exactly as it did. Every social network
    // fetches a posted URL to build its unfurl card, so without this the act of
    // posting a link would manufacture its own "verified" clicks.
    const isShareClick = SHARE_CLICK_SOURCES.has(source);
    if (isShareClick && isLikelyBotUserAgent(input.userAgent)) {
      return { recorded: false };
    }

    const ownerUserId = await resolveOwner(input.targetType, targetId);
    if (!ownerUserId) return { recorded: false };

    const shareTargetType = input.targetType === "cert" ? "cert" : null;
    const visitorHash = isShareClick ? input.visitorHash ?? null : null;
    // The seller opening their own shared link. Recorded (the funnel should
    // still see it) but never rewarded.
    const selfClick = isShareClick && shareTargetType
      ? await isSelfClick(ownerUserId, shareTargetType, targetId, visitorHash)
      : false;

    const { error } = await supabaseAdmin.from("badge_click_events").insert({
      owner_user_id: ownerUserId,
      target_type: input.targetType,
      target_id: targetId,
      source,
      visitor_hash: visitorHash,
      self_click: selfClick,
    });
    if (error) return { recorded: false };

    // A share click with no trustworthy fingerprint, or the sharer's own, is a
    // recorded click that earns nothing. Fail-closed: an unspoofable handle is
    // the whole basis of "unique verified click", so no handle means no reward
    // rather than a reward we cannot defend.
    if (isShareClick && (selfClick || !visitorHash)) return { recorded: true };

    // US-1848: this click closes the epic's core loop — a grade was shared, a
    // real person followed it back, and the seller earns for it. It is the only
    // share signal worth rewarding: the owner is resolved server-side from the
    // cert (never trusted from the caller) and pressing "share" earns nothing on
    // its own, so there is no button to mash.
    //
    // Anti-farming is structural rather than a rate limit: the reward is
    // idempotent on (target, source), so ONE badge target earns ONE award ever
    // — clicking your own link a thousand times pays exactly what clicking it
    // once does. US-1854 layers the escalating click-threshold bonuses on top,
    // which is where velocity and self-click detection belong.
    try {
      await grantReward(ownerUserId, "verified_share", {
        referenceId: `${input.targetType}:${targetId}:${source}`,
        source: "badge_click",
        metadata: { target_type: input.targetType, click_source: source },
      });
    } catch (err) {
      // A reward problem must never break the public page that pinged us.
      captureException(err, { level: "warn", route: "badge-analytics.reward" });
    }

    // US-1854: the escalating half. Only a share click can move the ladder, and
    // evaluateShareMilestones re-derives the DISTINCT non-self click count from
    // the ledger rather than trusting this one request — so a rung is paid on
    // reach that actually happened. Best-effort, like the grant above.
    if (isShareClick && shareTargetType) {
      await evaluateShareMilestones(ownerUserId, shareTargetType, targetId);
    }
    return { recorded: true };
  } catch (err) {
    captureException(err, { level: "warn", route: "badge-analytics.record" });
    return { recorded: false };
  }
}

export interface BadgeFunnel {
  clicksBySource: Record<string, number>;
  totalClicks: number;
  /** Referral signups attributed to this seller (their downstream conversions). */
  conversions: number;
  windowDays: number;
}

/** Aggregate raw click rows into a by-source count + total. Pure. */
export function aggregateClicksBySource(
  rows: Array<{ source: string }>,
): { clicksBySource: Record<string, number>; totalClicks: number } {
  const clicksBySource: Record<string, number> = {};
  for (const r of rows) {
    const s = r.source || "unknown";
    clicksBySource[s] = (clicksBySource[s] ?? 0) + 1;
  }
  return { clicksBySource, totalClicks: rows.length };
}

function sinceIso(windowDays: number): string {
  return new Date(Date.now() - windowDays * 86_400_000).toISOString();
}

/** The badge funnel for ONE seller — owner-scoped (US-268). */
export async function sellerBadgeFunnel(ownerUserId: string, windowDays = 30): Promise<BadgeFunnel> {
  const since = sinceIso(windowDays);
  const { data: clickRows } = await supabaseAdmin
    .from("badge_click_events")
    .select("source")
    .eq("owner_user_id", ownerUserId)
    .gte("created_at", since);
  const { clicksBySource, totalClicks } = aggregateClicksBySource(
    (clickRows ?? []) as Array<{ source: string }>,
  );

  // Conversions = referral signups this seller drove (reuses the referral ledger).
  const { count } = await supabaseAdmin
    .from("referral_events")
    .select("referred_user_id", { count: "exact", head: true })
    .eq("referrer_user_id", ownerUserId)
    .gte("created_at", since);

  return { clicksBySource, totalClicks, conversions: count ?? 0, windowDays };
}

export interface PlatformBadgeFunnel extends BadgeFunnel {
  /** Distinct sellers with at least one badge click in the window. */
  activeSellers: number;
}

/** Platform-wide badge funnel for the admin dashboard. */
export async function platformBadgeFunnel(windowDays = 30): Promise<PlatformBadgeFunnel> {
  const since = sinceIso(windowDays);
  const { data: clickRows } = await supabaseAdmin
    .from("badge_click_events")
    .select("source, owner_user_id")
    .gte("created_at", since)
    .limit(50_000);
  const rows = (clickRows ?? []) as Array<{ source: string; owner_user_id: string }>;
  const { clicksBySource, totalClicks } = aggregateClicksBySource(rows);
  const activeSellers = new Set(rows.map((r) => r.owner_user_id)).size;

  const { count } = await supabaseAdmin
    .from("referral_events")
    .select("referred_user_id", { count: "exact", head: true })
    .gte("created_at", since);

  return { clicksBySource, totalClicks, conversions: count ?? 0, activeSellers, windowDays };
}
