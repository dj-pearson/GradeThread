// US-1807: buyer condition-alerts MATCHING ENGINE.
//
// Continuously evaluates buyers' saved searches (US-1806) against newly-PUBLIC
// certificates and emits a condition_alert notification (US-1803) the moment a
// well-graded item matching their criteria appears.
//
// UNIVERSE (product decision, user 2026-07-09): PUBLIC CERTIFICATES ONLY —
// grade_reports with a certificate_id, finalized (review_status approved/
// modified), not withheld. That is already-public data, so a buyer being
// alerted about another account's cert leaks nothing (unlike matching against a
// seller's private inventory/listing feed, which was explicitly NOT chosen).
//
// DURABILITY: this is a cheap, IDEMPOTENT sweep (DB reads + notification inserts,
// no per-item AI), so it uses the light guardrail-cron contract — the same shape
// as handleConditionIndexRefreshCron (US-1749), NOT the heavyweight batch/jobs
// machinery (flipdesk-autolister), which exists for expensive per-item work that
// needs per-item reclaim. Here: acquireJobLock prevents overlap (claim +
// lease-heartbeat); notifyBuyer's (userId, dedupeKey) idempotency means a re-run
// never double-alerts; and the fixed schedule self-heals a crashed run on the
// next tick (reclaim). Config-driven kill-switch + per-run budget bound the cost.
//
// ENTITLEMENT (US-1805): a buyer's plan caps how many saved searches may be
// ACTIVE at once (activeAlertsCap — Free 3 / Guard 25 / Connoisseur unlimited).
// This engine is where that cap is ENFORCED, because saved searches are written
// client-side under RLS and there is no route in between. See entitledSearchIds.
//
// PRICE FAIRNESS (AC): a saved search's max_price is compared to the Value Index
// FAIR price for the item's (brand, grade) — a public cert has no live sale
// price, so "at/below fair for this grade" is the meaningful ceiling. Best-effort:
// when no confident curve resolves, the price gate is skipped (never wrongly
// suppress a match) and the alert carries no fair-price context.

import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";
import { acquireJobLock } from "./job-lock.ts";
import { resolveBuyerEntitlements } from "./buyer-entitlements.ts";
import { isCertificateWithheld } from "./certificate-visibility.ts";
import { captureException, logEvent } from "./observability.ts";
import { getSetting } from "./system-settings.ts";
import { notifyBuyer } from "./buyer-notify.ts";
import {
  getValueHub,
  nearestPointForGrade,
  slugify,
  type ValueHubItem,
} from "./value-index.ts";
import { getIndexCurveBySlug } from "./condition-index.ts";

// ── Config (system_settings key `buyer_condition_alerts`; getSetting falls back
//    to these defaults when unset — no migration needed) ────────────────────
export interface AlertsConfig {
  /** Master kill-switch — false stops all matching. */
  enabled: boolean;
  /** Per-run budget: how many saved searches to evaluate (oldest-checked first). */
  maxSearchesPerRun: number;
  /** Only certs finalized within this window are "new" enough to alert on. */
  lookbackDays: number;
  /** Cap alerts emitted per search per run (a brand-new broad search can't spam). */
  maxMatchesPerSearch: number;
  /** Ceiling on the public-cert candidate pool loaded per run. */
  maxCandidatePool: number;
}

/**
 * US-2317: ceiling on the saved-search read.
 *
 * Deliberately far above maxSearchesPerRun (50 by default) — this is a bound
 * against unbounded growth, not a second budget. Because the read is ordered
 * stalest-first, anything beyond this cap is by definition more recently
 * checked than everything inside it, so the cap can only ever drop searches
 * that were not due this run anyway.
 */
export const SAVED_SEARCH_SCAN_CAP = 20_000;

export const DEFAULT_ALERTS_CONFIG: AlertsConfig = {
  enabled: true,
  maxSearchesPerRun: 50,
  lookbackDays: 3,
  maxMatchesPerSearch: 10,
  maxCandidatePool: 500,
};

// ── Data shapes ──────────────────────────────────────────────────────────────
/** The saved_searches columns the engine reads (mirror of 00416). */
export interface AlertSearch {
  id: string;
  user_id: string;
  label: string;
  brands: string[];
  categories: string[];
  keywords: string[];
  min_grade: number | null;
  max_price_cents: number | null;
  last_matched_at: string | null;
  /** US-1805: creation order decides which searches fit under the plan cap. */
  created_at: string;
}

/** A public certificate projected to just what matching needs. */
export interface CandidateCert {
  certificateId: string;
  brand: string | null;
  title: string;
  category: string | null;
  grade: number;
}

// ── Pure matching (unit-tested without a DB) ─────────────────────────────────

const lc = (s: string) => s.trim().toLowerCase();

/**
 * Does a public cert satisfy a search's NON-price criteria? An empty criterion
 * array is a wildcard (the buyer didn't constrain that dimension). Sizes are not
 * matched in the public-cert universe (a cert doesn't carry a declared size).
 */
export function matchesSearch(
  cert: CandidateCert,
  search: AlertSearch,
): boolean {
  if (search.brands.length > 0) {
    const b = cert.brand ? lc(cert.brand) : "";
    if (!b || !search.brands.some((x) => lc(x) === b)) return false;
  }
  if (search.categories.length > 0) {
    const cat = cert.category ? lc(cert.category) : "";
    if (!cat || !search.categories.some((x) => lc(x) === cat)) return false;
  }
  if (search.min_grade != null && cert.grade < search.min_grade) return false;
  if (search.keywords.length > 0) {
    const hay = `${lc(cert.title)} ${cert.brand ? lc(cert.brand) : ""}`;
    if (!search.keywords.some((k) => k.trim() && hay.includes(lc(k)))) {
      return false;
    }
  }
  return true;
}

/**
 * Pick the Value Index curve slug that best describes a cert, or null when we
 * can't be confident. PURE (takes the hub) so it's unit-tested. Rules, in order:
 *  1. Among curves for the cert's brand, one whose itemSlug matches the cert's
 *     category slug, or appears as a token in the cert's title → use it.
 *  2. Else, if the brand has exactly ONE curve → use it (brand-level fairness).
 *  3. Else ambiguous → null (skip the price gate rather than guess).
 */
export function pickCurveSlugForCert(
  cert: CandidateCert,
  hub: ValueHubItem[],
): string | null {
  if (!cert.brand) return null;
  const brandSlug = slugify(cert.brand);
  if (!brandSlug) return null;
  const forBrand = hub.filter((h) => h.brandSlug === brandSlug);
  if (forBrand.length === 0) return null;

  const catSlug = cert.category ? slugify(cert.category) : "";
  const titleSlug = slugify(cert.title);
  const exact = forBrand.filter(
    (h) =>
      (catSlug && h.itemSlug === catSlug) ||
      (h.itemSlug && titleSlug.includes(h.itemSlug)),
  );
  if (exact.length === 1) return exact[0].slug;
  if (exact.length === 0 && forBrand.length === 1) return forBrand[0].slug;
  return null;
}

// ── Due-search selection (pure, budget-capped, oldest-checked first) ─────────
export interface SearchSelection {
  batch: AlertSearch[];
  dueCount: number;
  budgetCapped: boolean;
}

/**
 * Order active searches oldest-checked first (never-matched = most stale) and
 * truncate to the per-run budget, so the budget rotates fairly across searches.
 * PURE (nowMs unused today but kept for parity + future interval tiers).
 */
export function selectDueSearches(
  searches: AlertSearch[],
  config: AlertsConfig,
  _nowMs: number,
): SearchSelection {
  const sorted = [...searches].sort((a, b) => {
    const am = a.last_matched_at ? Date.parse(a.last_matched_at) : 0; // null → 0 = most stale
    const bm = b.last_matched_at ? Date.parse(b.last_matched_at) : 0;
    return am - bm;
  });
  const cap = Math.max(0, Math.trunc(config.maxSearchesPerRun));
  const batch = sorted.slice(0, cap);
  return {
    batch,
    dueCount: searches.length,
    budgetCapped: searches.length > batch.length,
  };
}

// ── Per-buyer entitlement cap (US-1805) ─────────────────────────────────────
//
// `activeAlertsCap` (Free 3 / Guard 25 / Connoisseur unlimited) was advertised on
// both halves of the plan matrix and parity-tested, but NOTHING read it — saved
// searches are written client-side straight to Supabase under RLS, so there was
// no route to gate and the cap was decoration. The buyer-facing UI now shows and
// respects it, but the UI is not the enforcement: this is, because the engine is
// the only place a saved search turns into the thing being sold (an alert).
//
// A search is entitled when its plan unlocks conditionAlerts AND it is among the
// buyer's `cap` OLDEST active searches. Oldest-first is deliberate: it is stable
// across runs (so a buyer over the cap does not get a different random subset
// alerted each sweep), and it keeps the searches the buyer has relied on longest
// rather than silencing them in favour of a search made this morning.

/**
 * The subset of ONE buyer's active searches the plan entitles. PURE.
 *
 * `cap` < 0 means unlimited; `featureEnabled` false means none at all (a plan
 * that does not include alerts). Ties on `created_at` break on `id` so the
 * result is deterministic for rows written in the same transaction.
 */
export function entitledSearchIds(
  searchesForUser: ReadonlyArray<{ id: string; created_at: string }>,
  cap: number,
  featureEnabled: boolean,
): Set<string> {
  if (!featureEnabled) return new Set();
  if (cap < 0) return new Set(searchesForUser.map((s) => s.id));
  const limit = Math.max(0, Math.trunc(cap));
  if (limit === 0) return new Set();
  const ordered = [...searchesForUser].sort((a, b) => {
    const at = Date.parse(a.created_at) || 0;
    const bt = Date.parse(b.created_at) || 0;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return new Set(ordered.slice(0, limit).map((s) => s.id));
}

interface BuyerPlanRow {
  id: string;
  buyer_plan?: string | null;
  buyer_subscription_status?: string | null;
  flipdesk_plan?: string | null;
  subscription_status?: string | null;
  trial_ends_at?: string | null;
  past_due_since?: string | null;
}

/**
 * Resolve the alert entitlement (feature flag + cap) for a set of buyers in one
 * read. FAIL-SAFE TO FREE, matching getBuyerEntitlements: a missing row or a
 * failed read resolves to the Free floor (3 alerts, feature on) rather than to
 * "deny everything" — a transient DB hiccup must not silence every buyer's
 * alerts, and it must not hand anyone a paid cap either.
 */
async function loadAlertCaps(
  userIds: string[],
): Promise<Map<string, { cap: number; enabled: boolean }>> {
  const out = new Map<string, { cap: number; enabled: boolean }>();
  const free = resolveBuyerEntitlements(null, null);
  const freeEntry = {
    cap: free.allowances.activeAlertsCap,
    enabled: free.gateFlags.conditionAlerts,
  };
  for (const id of userIds) out.set(id, freeEntry);
  if (userIds.length === 0) return out;

  // Chunked so a raised maxSearchesPerRun can't build an unbounded `in(...)`.
  for (let i = 0; i < userIds.length; i += 200) {
    const chunk = userIds.slice(i, i + 200);
    const { data, error } = await supabaseAdmin
      .from("users")
      .select(
        "id, buyer_plan, buyer_subscription_status, flipdesk_plan, subscription_status, trial_ends_at, past_due_since",
      )
      .in("id", chunk);
    if (error) {
      captureException(new Error(`condition-alerts cap load failed: ${error.message}`), {
        level: "warn",
        route: "condition-alerts.caps",
      });
      continue; // leave this chunk on the Free floor
    }
    for (const row of (data ?? []) as BuyerPlanRow[]) {
      // US-1887: the seller plan folds in, so a Business seller is a
      // Connoisseur buyer without a second subscription — same rule as every
      // other buyer gate, resolved by the same function.
      const ent = resolveBuyerEntitlements(row.buyer_plan, row.buyer_subscription_status, {
        flipdeskPlan: row.flipdesk_plan,
        flipdeskStatus: row.subscription_status,
        trialEndsAt: row.trial_ends_at ?? null,
        pastDueSince: row.past_due_since ?? null,
      });
      out.set(row.id, {
        cap: ent.allowances.activeAlertsCap,
        enabled: ent.gateFlags.conditionAlerts,
      });
    }
  }
  return out;
}

// ── DB-touching orchestration ────────────────────────────────────────────────

interface CandidateRow {
  certificate_id: string | null;
  overall_score: number | string | null;
  created_at: string;
  submissions:
    | {
      title: string | null;
      brand: string | null;
      garment_category: string | null;
      flagged: boolean | null;
      moderation_status: string | null;
    }
    | Array<
      {
        title: string | null;
        brand: string | null;
        garment_category: string | null;
        flagged: boolean | null;
        moderation_status: string | null;
      }
    >
    | null;
}

/** Load the recent PUBLIC-certificate pool once per run (bounded). Reuses the
 *  citable-cert predicate from condition-index (certificate_id set + finalized +
 *  not withheld). */
async function loadCandidateCerts(
  config: AlertsConfig,
  nowMs: number,
): Promise<CandidateCert[]> {
  const since = new Date(nowMs - config.lookbackDays * 86_400_000)
    .toISOString();
  const { data, error } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "certificate_id, overall_score, created_at, submissions!inner(title, brand, garment_category, flagged, moderation_status, status)",
    )
    .not("certificate_id", "is", null)
    .in("review_status", ["approved", "modified"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.trunc(config.maxCandidatePool)));
  if (error) {
    throw new Error(`condition-alerts candidate load failed: ${error.message}`);
  }

  const out: CandidateCert[] = [];
  for (const r of (data ?? []) as CandidateRow[]) {
    if (!r.certificate_id) continue;
    const sub = Array.isArray(r.submissions) ? r.submissions[0] : r.submissions;
    if (!sub || isCertificateWithheld(sub)) continue; // never alert on a suspect grade
    out.push({
      certificateId: r.certificate_id,
      brand: sub.brand,
      title: sub.title ?? "Graded garment",
      category: sub.garment_category,
      grade: Number(r.overall_score ?? 0),
    });
  }
  return out;
}

/** Resolve the fair (median) price in cents for a cert via the Value Index, or
 *  null when no confident curve resolves. */
async function fairPriceCentsForCert(
  cert: CandidateCert,
  hub: ValueHubItem[],
): Promise<number | null> {
  const slug = pickCurveSlugForCert(cert, hub);
  if (!slug) return null;
  const curve = await getIndexCurveBySlug(slug);
  if (!curve) return null;
  const point = nearestPointForGrade(curve.points, cert.grade);
  return point?.medianCents ?? null;
}

export interface AlertsRunResult {
  searchesEvaluated: number;
  matchesEmitted: number;
  candidatePool: number;
  budgetCapped: boolean;
  /** US-1805: searches skipped because their owner is over their plan's cap. */
  overCapSkipped: number;
  disabled?: boolean;
  /**
   * US-2315: searches whose matching pass THREW. Named `failed` because
   * cron-run-outcome.ts (US-2312) reads that key out of the response body, so a
   * run where every search throws records as an error rather than answering 200
   * with a plausible-looking zero-match summary.
   */
  failed?: number;
}

/**
 * Rotate a search to the back of the staleness queue. US-2315: called on BOTH
 * the success and the failure path — never throws, because a stamp that fails
 * re-creates the starvation it exists to prevent.
 */
async function stampSearch(
  search: { id: string; user_id: string },
  nowMs: number,
): Promise<void> {
  try {
    await supabaseAdmin
      .from("saved_searches")
      .update({ last_matched_at: new Date(nowMs).toISOString() } as never)
      .eq("id", search.id)
      .eq("user_id", search.user_id);
  } catch {
    // Best effort. A failed stamp leaves the search stale and it will be picked
    // again — the pre-existing behaviour, and still better than aborting the
    // rest of the batch.
  }
}

/**
 * One matching pass. Deterministic in (DB state, nowMs) modulo already-sent
 * dedupe. Loads active searches + the recent public-cert pool, matches in
 * memory, emits deduped condition_alert notifications, and stamps
 * last_matched_at so the budget rotates fairly.
 */
export async function runConditionAlerts(
  nowMs = Date.now(),
): Promise<AlertsRunResult> {
  const config = await getSetting<AlertsConfig>(
    "buyer_condition_alerts",
    DEFAULT_ALERTS_CONFIG,
  );
  if (!config.enabled) {
    logEvent("info", "condition-alerts.disabled", {});
    return {
      searchesEvaluated: 0,
      matchesEmitted: 0,
      candidatePool: 0,
      budgetCapped: false,
      overCapSkipped: 0,
      disabled: true,
    };
  }

  // US-2317: bounded, and ordered STALEST-FIRST at the database rather than
  // only in memory.
  //
  // This read had no limit: every active saved search across every buyer was
  // materialized, then selectDueSearches sorted it and kept maxSearchesPerRun.
  // So the per-run budget bounded the WORK but not the READ, and the read is
  // what grows with the buyer base.
  //
  // The ordering is the part that makes the cap safe. Sorting by
  // last_matched_at ascending (nulls first — never-matched is most stale) means
  // the rows the cap keeps are exactly the rows selectDueSearches would have
  // chosen anyway. A bare .limit() with no order would have silently changed
  // WHICH buyers get evaluated, and changed it differently on every run.
  const { data: searchData, error: sErr } = await supabaseAdmin
    .from("saved_searches")
    .select(
      "id, user_id, label, brands, categories, keywords, min_grade, max_price_cents, last_matched_at, created_at",
    )
    .eq("is_active", true)
    .order("last_matched_at", { ascending: true, nullsFirst: true })
    .limit(SAVED_SEARCH_SCAN_CAP);
  if (sErr) {
    throw new Error(`condition-alerts search load failed: ${sErr.message}`);
  }
  const searches = (searchData ?? []) as AlertSearch[];
  if (searches.length === 0) {
    return {
      searchesEvaluated: 0,
      matchesEmitted: 0,
      candidatePool: 0,
      budgetCapped: false,
      overCapSkipped: 0,
    };
  }

  const sel = selectDueSearches(searches, config, nowMs);

  // US-1805: resolve the entitled subset for every buyer represented in this
  // batch. The RANKING uses the buyer's FULL active set (from the read above),
  // not just their rows in the batch — "your 3 oldest" is only meaningful
  // against all of them. Only the batch's owners are looked up, so this is one
  // bounded read per run, not one per search.
  const batchUserIds = [...new Set(sel.batch.map((s) => s.user_id))];
  const caps = await loadAlertCaps(batchUserIds);
  const entitled = new Set<string>();
  for (const userId of batchUserIds) {
    const plan = caps.get(userId);
    const mine = searches.filter((s) => s.user_id === userId);
    for (const id of entitledSearchIds(mine, plan?.cap ?? 0, plan?.enabled ?? false)) {
      entitled.add(id);
    }
  }

  const candidates = await loadCandidateCerts(config, nowMs);
  const hub = candidates.length > 0 ? await getValueHub() : [];

  let matchesEmitted = 0;
  let failed = 0;
  let overCapSkipped = 0;
  for (const search of sel.batch) {
    try {
      if (!entitled.has(search.id)) {
        // Over the plan's activeAlertsCap (or on a plan without alerts at all).
        // STAMPED, not merely skipped: an unstamped row stays the stalest
        // forever and is re-picked at the head of every run — the US-2315
        // starvation shape. Stamping costs one write and lets it rotate, so an
        // over-cap search consumes only its fair share of the budget.
        overCapSkipped += 1;
        await stampSearch(search, nowMs);
        continue;
      }
      let emittedForSearch = 0;
      for (const cert of candidates) {
        if (emittedForSearch >= config.maxMatchesPerSearch) break;
        if (!matchesSearch(cert, search)) continue;

        // Price fairness: only suppress when we can CONFIDENTLY price the item and
        // its fair price exceeds the buyer's ceiling. Unknown fair price = include.
        let fairCents: number | null = null;
        if (search.max_price_cents != null) {
          fairCents = await fairPriceCentsForCert(cert, hub);
          if (fairCents != null && fairCents > search.max_price_cents) continue;
        }

        const delivered = await notifyBuyer(search.user_id, {
          category: "condition_alert",
          title: "A graded match just appeared",
          body: buildAlertBody(cert, fairCents),
          link: `/cert/${cert.certificateId}`,
          // One alert per (search, cert) — idempotent across re-runs.
          dedupeKey: `condition-alert:${search.id}:${cert.certificateId}`,
          data: { certificateId: cert.certificateId, searchId: search.id },
        });
        if (delivered) {
          matchesEmitted += 1;
          emittedForSearch += 1;
        }
      }

      // Stamp regardless of matches so the budget rotates to less-recently-checked
      // searches next run. Scoped by BOTH id and user_id (US-268).
      await stampSearch(search, nowMs);
    } catch (err) {
      // US-2315: head-of-line starvation. selectDueSearches orders MOST STALE
      // FIRST (a null last_matched_at coerces to 0), and the stamp above only
      // ran after the whole per-cert inner loop. So a search that threw in
      // fairPriceCentsForCert or notifyBuyer kept its old stamp, stayed the
      // stalest, and was picked first on every subsequent run — starving every
      // other buyer's alerts behind it. Stamping on the failure path is what
      // breaks that: the search rotates to the back and is retried next cycle.
      failed += 1;
      await stampSearch(search, nowMs);
      captureException(err, {
        level: "warn",
        route: "condition-alerts.search",
        extra: { searchId: search.id },
      });
    }
  }

  logEvent("info", "condition-alerts.run", {
    // Honest count: searches actually matched against the candidate pool. An
    // over-cap search consumed a budget slot but was never evaluated.
    searchesEvaluated: sel.batch.length - overCapSkipped,
    matchesEmitted,
    candidatePool: candidates.length,
    budgetCapped: sel.budgetCapped,
    overCapSkipped,
    failed,
  });
  return {
    // Honest count: searches actually matched against the candidate pool. An
    // over-cap search consumed a budget slot but was never evaluated.
    searchesEvaluated: sel.batch.length - overCapSkipped,
    matchesEmitted,
    candidatePool: candidates.length,
    budgetCapped: sel.budgetCapped,
    overCapSkipped,
    failed,
  };
}

/** Human-readable alert body, with fair-price context when we have it. Pure. */
export function buildAlertBody(
  cert: CandidateCert,
  fairCents: number | null,
): string {
  const who = cert.brand ? `${cert.brand} ${cert.title}` : cert.title;
  const grade = `graded ${cert.grade.toFixed(1)}/10`;
  if (fairCents != null) {
    return `${who} — ${grade}. Fair value ≈ $${
      (fairCents / 100).toFixed(0)
    } for this grade.`;
  }
  return `${who} — ${grade} — matches your watch.`;
}

export async function handleConditionAlertsCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("condition-alerts", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await runConditionAlerts();
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "condition-alerts.cron" });
    return c.json({ error: "condition-alerts failed" }, 500);
  } finally {
    await lock.release();
  }
}
