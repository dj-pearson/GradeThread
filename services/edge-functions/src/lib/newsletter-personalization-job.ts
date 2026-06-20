// US-921: Per-recipient personalization RESOLVER — DB-touching.
//
// Computes the per-recipient activity snapshot (newsletter-personalization.ts)
// for a whole send batch in a fixed, small number of BATCHED queries — never one
// query per recipient (AC1: no N+1). Every query is scoped by user id, so a
// recipient only ever sees their OWN numbers (AC3: no cross-tenant leak).
//
// Pure block-building / token substitution lives in newsletter-personalization.ts;
// this module only loads the raw signals and assembles the per-user map.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { captureException } from "./observability.ts";
import { emptyActivity, type RecipientActivity } from "./newsletter-personalization.ts";

// Inventory statuses that mean "not graded yet" — the "you have N ungraded items"
// CTA counts these. (Post-grade statuses: graded, comped, drafted, listed, sold, …)
const PRE_GRADE_STATUSES = ["sourced", "acquired", "cataloged", "measured", "photographed"];

// Chunk `.in(user_id, …)` lists so a 1000-recipient batch never builds an
// oversized PostgREST URL. A handful of queries per chunk ⇒ O(chunks), not O(recipients).
const IN_CHUNK = 200;
// Defensive row cap per query so a power-user batch can't pull unbounded rows.
const ROW_CAP = 20_000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface ResolveActivityOptions {
  /** Active listings older than this many days count as slow-movers. */
  slowMoverDays?: number;
}

/**
 * Resolve the activity snapshot for every given user id at `nowMs`. Unknown ids
 * map to an empty (all-zero) snapshot. Failures degrade to empty snapshots rather
 * than throwing — a personalization hiccup must never block a send.
 */
export async function resolveActivityBatch(
  userIds: string[],
  nowMs: number,
  opts: ResolveActivityOptions = {},
): Promise<Map<string, RecipientActivity>> {
  const map = new Map<string, RecipientActivity>();
  const ids = [...new Set(userIds.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (ids.length === 0) return map;
  for (const id of ids) map.set(id, emptyActivity());

  const weekAgo = new Date(nowMs - 7 * 86_400_000).toISOString();
  const slowDays = opts.slowMoverDays && opts.slowMoverDays > 0 ? opts.slowMoverDays : 30;
  const slowCutoff = new Date(nowMs - slowDays * 86_400_000).toISOString();

  const bump = (uid: string | null | undefined, key: keyof RecipientActivity, by = 1): void => {
    if (!uid) return;
    const a = map.get(uid);
    if (!a) return;
    const cur = a[key];
    if (typeof cur === "number") (a[key] as number) = cur + by;
  };

  for (const part of chunk(ids, IN_CHUNK)) {
    // 1. users — credits + trial clock (one row per user).
    try {
      const { data, error } = await supabaseAdmin
        .from("users")
        .select("id, grade_credit_balance, trial_ends_at, subscription_status")
        .in("id", part);
      if (error) throw error;
      for (const u of (data ?? []) as Array<{
        id: string;
        grade_credit_balance: number | null;
        trial_ends_at: string | null;
        subscription_status: string | null;
      }>) {
        const a = map.get(u.id);
        if (!a) continue;
        a.creditsBalance = typeof u.grade_credit_balance === "number" ? u.grade_credit_balance : null;
        a.trialDaysLeft = trialDaysLeft(u.subscription_status, u.trial_ends_at, nowMs);
      }
    } catch (err) {
      captureException(err, { tags: { area: "newsletter-personalization.users" } });
    }

    // 2. grades this week — submissions created in the last 7 days.
    try {
      const { data, error } = await supabaseAdmin
        .from("submissions")
        .select("user_id")
        .in("user_id", part)
        .gte("created_at", weekAgo)
        .limit(ROW_CAP);
      if (error) throw error;
      for (const r of (data ?? []) as Array<{ user_id: string | null }>) bump(r.user_id, "gradesThisWeek");
    } catch (err) {
      captureException(err, { tags: { area: "newsletter-personalization.grades" } });
    }

    // 3a. items listed this week — listings created in the last 7 days.
    try {
      const { data, error } = await supabaseAdmin
        .from("listings")
        .select("user_id")
        .in("user_id", part)
        .gte("created_at", weekAgo)
        .limit(ROW_CAP);
      if (error) throw error;
      for (const r of (data ?? []) as Array<{ user_id: string | null }>) bump(r.user_id, "itemsListedThisWeek");
    } catch (err) {
      captureException(err, { tags: { area: "newsletter-personalization.listed" } });
    }

    // 3b. slow-movers — active listings older than the slow-mover window.
    try {
      const { data, error } = await supabaseAdmin
        .from("listings")
        .select("user_id")
        .in("user_id", part)
        .eq("listing_status", "active")
        .lt("created_at", slowCutoff)
        .limit(ROW_CAP);
      if (error) throw error;
      for (const r of (data ?? []) as Array<{ user_id: string | null }>) bump(r.user_id, "slowMovers");
    } catch (err) {
      captureException(err, { tags: { area: "newsletter-personalization.slow" } });
    }

    // 4. sales this week — sales recorded in the last 7 days.
    try {
      const { data, error } = await supabaseAdmin
        .from("sales")
        .select("user_id")
        .in("user_id", part)
        .gte("sale_date", weekAgo)
        .limit(ROW_CAP);
      if (error) throw error;
      for (const r of (data ?? []) as Array<{ user_id: string | null }>) bump(r.user_id, "salesThisWeek");
    } catch (err) {
      captureException(err, { tags: { area: "newsletter-personalization.sales" } });
    }

    // 5. ungraded items — inventory still in a pre-grade status.
    try {
      const { data, error } = await supabaseAdmin
        .from("inventory_items")
        .select("user_id")
        .in("user_id", part)
        .in("status", PRE_GRADE_STATUSES)
        .limit(ROW_CAP);
      if (error) throw error;
      for (const r of (data ?? []) as Array<{ user_id: string | null }>) bump(r.user_id, "ungradedItems");
    } catch (err) {
      captureException(err, { tags: { area: "newsletter-personalization.ungraded" } });
    }
  }

  return map;
}

/** Days left on the trial clock, or null when the user is not trialing / has no clock. */
function trialDaysLeft(
  subscriptionStatus: string | null,
  trialEndsAt: string | null,
  nowMs: number,
): number | null {
  if (subscriptionStatus !== "trialing" || !trialEndsAt) return null;
  const end = Date.parse(trialEndsAt);
  if (!Number.isFinite(end)) return null;
  const days = Math.ceil((end - nowMs) / 86_400_000);
  return days < 0 ? 0 : days;
}

// ── Send-batch convenience ────────────────────────────────────────────────────

/**
 * Resolve the personalization context for a send batch. Returns an empty map when
 * personalization is disabled for this issue so the caller can branch cheaply.
 * `enabled` already folds the per-issue toggle AND the global setting.
 */
export async function resolvePersonalizationForBatch(
  recipients: Array<{ user_id: string | null }>,
  enabled: boolean,
  nowMs: number,
): Promise<{ enabled: boolean; activity: Map<string, RecipientActivity>; trialSoonDays: number; siteUrl: string }> {
  const [globalOn, slowMoverDays, trialSoonDays, siteUrl] = await Promise.all([
    getSetting<boolean>("newsletter_personalization_enabled", true),
    getSetting<number>("newsletter_personalization_slow_mover_days", 30),
    getSetting<number>("newsletter_personalization_trial_soon_days", 3),
    Promise.resolve(Deno.env.get("SITE_URL")?.trim() || "https://gradethread.com"),
  ]);
  const on = enabled && Boolean(globalOn);
  if (!on) {
    return { enabled: false, activity: new Map(), trialSoonDays: Number(trialSoonDays) || 3, siteUrl };
  }
  const ids = recipients.map((r) => r.user_id).filter((x): x is string => !!x);
  const activity = await resolveActivityBatch(ids, nowMs, { slowMoverDays: Number(slowMoverDays) || 30 });
  return { enabled: true, activity, trialSoonDays: Number(trialSoonDays) || 3, siteUrl };
}
