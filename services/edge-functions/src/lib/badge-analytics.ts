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

// The ?s= sources that represent a genuine badge click (as opposed to a direct
// visit or an internal share). Kept tight so the funnel means "badge-driven".
// US-1844: `buyer` = a trust badge clicked inside a GradeThread buyer surface
// (extension overlay, alerts, watchlist, portfolio) — same attribution ledger.
export const BADGE_CLICK_SOURCES = new Set(["embed", "badge", "qr", "buyer"]);

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
}): Promise<{ recorded: boolean }> {
  try {
    const source = input.source.trim().toLowerCase();
    const targetId = input.targetId.trim();
    if (!targetId || !BADGE_CLICK_SOURCES.has(source)) return { recorded: false };

    const ownerUserId = await resolveOwner(input.targetType, targetId);
    if (!ownerUserId) return { recorded: false };

    const { error } = await supabaseAdmin.from("badge_click_events").insert({
      owner_user_id: ownerUserId,
      target_type: input.targetType,
      target_id: targetId.slice(0, 200),
      source,
    });
    return { recorded: !error };
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
