// US-2970: derive which FlipDesk pipeline stages an item PROVABLY reached.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS DERIVED AND NOT EMITTED.
//
// Every other rewardable act in the system calls grantReward at its source: a
// grade finishes, a badge is served, a marketplace connects. The pipeline can't
// work that way. 252 lines across services/edge-functions/src/routes/flipdesk-*.ts
// write inventory_items.status, there is no choke point to wrap, and any hook
// set assembled by hand would be incomplete on the day it shipped and would rot
// as routes were added. A missing hook is invisible: it looks exactly like a
// seller who did not do the work.
//
// So the marks are read off durable state instead. The sweep (US-2971) grants
// whatever is missing, keyed on "<item id>:<stage>", and 00417's UNIQUE index
// uq_reputation_event_ref makes a repeat grant impossible at the database level.
// One consequence worth stating plainly: this same function IS the backfill.
// There is no separate one-time script to write, test and throw away.
//
// ⚠ inventory_items.status is deliberately NOT an input. Items move backward —
// returned, relisted, archived — and a single enum value cannot say which
// earlier stages actually happened. Only evidence that survives counts.
//
// ⚠ Comps that predate migration 00679 cannot be recovered. The comp stage left
// no reliable mark: repricing_suggestions.listing_id is NOT NULL, so a comp run
// before the item had a listing wrote no row at all, and comped_at did not
// exist. Those items lose item_comped (3 XP) and keep every other stage. This
// is a known, permanent gap, not a bug to go hunting for.
//
// Design: docs/superpowers/specs/2026-08-28-pipeline-xp-rewards-design.md
// ─────────────────────────────────────────────────────────────────────────────

/** The seven pipeline stages, in the order a seller works them. */
export type PipelineStage =
  | "item_cataloged"
  | "item_measured"
  | "item_photographed"
  | "item_comped"
  | "item_drafted"
  | "item_listed"
  | "item_sold";

export interface PipelineMark {
  stage: PipelineStage;
  /** ISO timestamp the stage actually happened — becomes the event's occurred_at. */
  occurredAt: string;
}

// The row shapes below are the COLUMNS THIS FUNCTION READS, not the full tables.
// Narrow on purpose: the sweep selects exactly these, and a reader can see the
// entire evidence surface without opening a migration.

export interface PipelineItem {
  id: string;
  brand: string | null;
  garment_type: string | null;
  measurements: unknown | null;
  comped_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelinePhoto {
  created_at: string;
}

export interface PipelineListing {
  /** Non-empty only once the listing is really live on a marketplace. */
  platform_listing_id: string | null;
  listed_at: string | null;
  created_at: string;
}

export interface PipelineSale {
  sale_price: number | string | null;
  sold_at: string | null;
  sale_date: string;
}

export interface PipelineRepricing {
  created_at: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A text column that is present and not just whitespace. */
function filled(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * True when `measurements` holds anything. The column is jsonb, so an
 * abandoned measure screen leaves `{}` and an array is legal too — neither is
 * a measurement.
 */
function hasMeasurements(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return false;
}

/** A sale row counts only when money actually changed hands. */
function hasPrice(value: number | string | null | undefined): boolean {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * The earliest parseable timestamp in `candidates`, falling back to `fallback`.
 *
 * Backfill reads real production rows written across years by a dozen code
 * paths, so a null or a junk date is expected rather than exceptional. It must
 * not write a junk occurred_at into an append-only log and must not throw
 * mid-sweep, which is why every stage's date goes through here.
 */
function parseable(value: string | null | undefined): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * The row's own best date: its preferred column, else its backup column.
 *
 * This is a PREFERENCE and not `earliest` of the two. A listing's created_at is
 * usually before its listed_at, so taking the earlier of the pair would date
 * every publication to the moment its draft was written and quietly erase the
 * gap between drafting and going live.
 */
function preferred(
  first: string | null | undefined,
  second: string | null | undefined,
): string | null {
  return parseable(first) ?? parseable(second);
}

function earliest(candidates: Array<string | null | undefined>, fallback: string): string {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const ms = Date.parse(c);
    if (!Number.isFinite(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = c;
    }
  }
  return best ?? fallback;
}

// ── the derivation ───────────────────────────────────────────────────────────

/**
 * Which stages this item provably reached, in pipeline order.
 *
 * Pure: no database, no clock, no environment. Everything the sweep needs to
 * decide is an argument, so the whole reward policy for the pipeline is
 * testable as plain data.
 *
 * Each stage pays at most once per item however many listings, photos or comp
 * runs it accumulated — cross-posting one item to four marketplaces is still
 * one item's work.
 */
export function pipelineMarksForItem(
  item: PipelineItem,
  photos: PipelinePhoto[],
  listings: PipelineListing[],
  sales: PipelineSale[],
  repricing: PipelineRepricing[],
): PipelineMark[] {
  const marks: PipelineMark[] = [];
  // Every fallback lands on the item's own creation date: it is the one
  // timestamp guaranteed to exist and to precede everything else about the item.
  const fallback = item.created_at;
  const add = (stage: PipelineStage, occurredAt: string) => marks.push({ stage, occurredAt });

  // Cataloged: someone typed something identifying. Deliberately NOT title —
  // title is NOT NULL, so every row would qualify and the stage would be free.
  if (filled(item.brand) || filled(item.garment_type)) {
    add("item_cataloged", earliest([item.created_at], fallback));
  }

  if (hasMeasurements(item.measurements)) {
    add("item_measured", earliest([item.updated_at], fallback));
  }

  if (photos.length > 0) {
    add("item_photographed", earliest(photos.map((p) => p.created_at), fallback));
  }

  // Comped: either evidence will do, and the earliest one wins.
  if (repricing.length > 0 || filled(item.comped_at)) {
    add(
      "item_comped",
      earliest([...repricing.map((r) => r.created_at), item.comped_at], fallback),
    );
  }

  // Drafted: any listing row at all. Listed: a listing that really went live.
  //
  // listings.listed_at is NOT NULL DEFAULT now(), so it is populated on drafts
  // too and cannot be the published marker. platform_listing_id is the only
  // column that means the marketplace accepted it.
  if (listings.length > 0) {
    add("item_drafted", earliest(listings.map((l) => l.created_at), fallback));

    const published = listings.filter((l) => filled(l.platform_listing_id));
    if (published.length > 0) {
      add(
        "item_listed",
        earliest(published.map((l) => preferred(l.listed_at, l.created_at)), fallback),
      );
    }
  }

  const paidSales = sales.filter((s) => hasPrice(s.sale_price));
  if (paidSales.length > 0) {
    add(
      "item_sold",
      earliest(paidSales.map((s) => preferred(s.sold_at, s.sale_date)), fallback),
    );
  }

  return marks;
}

/** The dedupe key for one mark. 00417's UNIQUE index makes this idempotent. */
export function pipelineReferenceId(itemId: string, stage: PipelineStage): string {
  return `${itemId}:${stage}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// US-2971: the sweep.
//
// WHY THE SWEEP DOES NOT CALL grantReward PER MARK.
//
// grantReward is the right primitive for a single act: it emits one event, then
// recomputes the user's whole reward state, re-awards badges and re-evaluates
// tangible milestones. That tail is fine once. A backfill for a seller with 300
// items produces up to 1,800 marks, and 1,800 full recomputes of the same log is
// not a slow sweep, it is a sweep that never finishes.
//
// So the sweep does what grantReward does, in bulk and in the same order: check
// the kill-switch ONCE, emit the events, recompute ONCE, award badges ONCE,
// evaluate tangible rewards ONCE against the state that resulted. The semantics
// are identical; only the number of recomputes changes.
//
// Idempotency is not this code being careful. reputation_events carries a UNIQUE
// index on (user_id, event_type, reference_id) from 00417, and the emit upserts
// with ignoreDuplicates, so a re-run is a no-op at the database level.
// ─────────────────────────────────────────────────────────────────────────────

import { emitReputationEvent } from "./buyer-trust-score.ts";
import { awardBadges } from "./rewards-badges.ts";
import { disabledMechanics } from "./rewards-mechanic-switch.ts";
import {
  readRewardState,
  recomputeRewardState,
  REWARD_XP_CATALOG,
  type RewardEventType,
} from "./rewards-engine.ts";
import { grantTangibleRewards } from "./rewards-tangible.ts";
import { getSetting } from "./system-settings.ts";
import { supabaseAdmin } from "./supabase.ts";
import { logEvent } from "./observability.ts";

/** The seven stages, in pipeline order. Also the event-type filter for reads. */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  "item_cataloged",
  "item_measured",
  "item_photographed",
  "item_comped",
  "item_drafted",
  "item_listed",
  "item_sold",
];

// ── the daily cap ────────────────────────────────────────────────────────────

export const PIPELINE_DAILY_XP_CAP_KEY = "rewards.pipeline_daily_xp_cap";
export const DEFAULT_PIPELINE_DAILY_XP_CAP = 300;

/**
 * Coerce the operator-editable setting into a usable ceiling.
 *
 * Same shape and same reasoning as normalizeDisabledMechanics: this is jsonb
 * with no schema behind it, read inside the grant path, so a string, an object
 * or a typo has to degrade to the default rather than throw. Fractions floor;
 * zero and negatives are not a ceiling of zero (that would silently switch the
 * whole mechanic off) but a misconfiguration, so they take the default too.
 */
export function normalizePipelineDailyCap(raw: unknown): number {
  const n = typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PIPELINE_DAILY_XP_CAP;
  return Math.floor(n);
}

async function pipelineDailyCap(): Promise<number> {
  const raw = await getSetting<unknown>(
    PIPELINE_DAILY_XP_CAP_KEY,
    DEFAULT_PIPELINE_DAILY_XP_CAP,
  );
  return normalizePipelineDailyCap(raw);
}

/**
 * The calendar day a mark counts against, in UTC.
 *
 * The cap is applied per OCCURRED_AT date rather than per wall-clock day, and
 * that one choice is what makes the backfill work without a special case: a
 * seller's months of history spread across months of dates and barely touch the
 * ceiling, while 500 items imported and dated today hit it immediately.
 */
export function utcDateKey(iso: string): string {
  return iso.slice(0, 10);
}

export interface PipelineCandidate {
  itemId: string;
  stage: PipelineStage;
  occurredAt: string;
}

export interface PlannedGrant extends PipelineCandidate {
  xp: number;
  referenceId: string;
}

/**
 * Decide which candidate marks fit under the per-date ceiling. Pure.
 *
 * Candidates are planned oldest-first so that on a day at its limit the seller's
 * EARLIEST work is what earns. Planning in query order would mean an old
 * backfilled day was filled by whichever rows the database happened to return.
 */
export function planPipelineGrants(
  candidates: PipelineCandidate[],
  spentByDate: Map<string, number>,
  cap: number,
): { granted: PlannedGrant[]; cappedOut: number } {
  const spent = new Map(spentByDate);
  const granted: PlannedGrant[] = [];
  let cappedOut = 0;

  const ordered = [...candidates].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (const c of ordered) {
    const xp = REWARD_XP_CATALOG[c.stage as RewardEventType] ?? 0;
    const key = utcDateKey(c.occurredAt);
    const already = spent.get(key) ?? 0;
    if (already + xp > cap) {
      cappedOut++;
      continue;
    }
    spent.set(key, already + xp);
    granted.push({ ...c, xp, referenceId: pipelineReferenceId(c.itemId, c.stage) });
  }
  return { granted, cappedOut };
}

// ── the sweep ────────────────────────────────────────────────────────────────

export interface PipelineSweepSummary {
  marksGranted: number;
  xpAdded: number;
  levelBefore: number;
  levelAfter: number;
  /** Marks that existed but did not fit under their date's ceiling. */
  cappedOut: number;
}

const PAGE = 500;

/** Load every row of a child table for these parent items, paged. */
async function loadForItems<T>(
  table: string,
  columns: string,
  itemIds: string[],
): Promise<Map<string, T[]>> {
  const byItem = new Map<string, T[]>();
  for (let i = 0; i < itemIds.length; i += PAGE) {
    const slice = itemIds.slice(i, i + PAGE);
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("inventory_item_id, " + columns)
      .in("inventory_item_id", slice);
    if (error) throw new Error("sweep: " + table + " read failed: " + error.message);
    // The table name is a variable here, so supabase-js cannot infer a row type
    // and widens `data` to its error shape. The cast goes through `unknown`
    // deliberately; the columns are named two lines up in the same call.
    const rows = (data ?? []) as unknown as Array<{ inventory_item_id: string }>;
    for (const row of rows) {
      const list = byItem.get(row.inventory_item_id) ?? [];
      list.push(row as unknown as T);
      byItem.set(row.inventory_item_id, list);
    }
  }
  return byItem;
}

/**
 * Grant every pipeline stage this owner's items reached but never earned.
 *
 * US-268: items are read with an explicit `.eq("user_id", userId)`; every child
 * table is then read by `inventory_item_id` restricted to that already-verified
 * set, never by an id taken from a request. The service-role client bypasses
 * RLS, so this scoping is the only thing standing between two tenants.
 *
 * ⚠ `userId`, NOT `workspaceOwnerId ?? userId`. XP is a PERSONAL standing,
 * not a workspace resource — the same call routes/rewards.ts makes, and for the
 * same reason: a level belongs to the human who earned it, not to whichever
 * tenant they are currently acting inside. Passing a workspace owner's id here
 * would credit the owner for a member's session, and passing a member's id
 * would credit them with the owner's inventory. The id that owns the items is
 * the id that earns the XP.
 */
export async function sweepPipelineRewards(userId: string): Promise<PipelineSweepSummary> {
  const before = await readRewardState(userId);
  const empty: PipelineSweepSummary = {
    marksGranted: 0,
    xpAdded: 0,
    levelBefore: before?.level ?? 0,
    levelAfter: before?.level ?? 0,
    cappedOut: 0,
  };

  // The kill-switch, checked ONCE for the whole sweep rather than per mark. A
  // disabled mechanic is a no-op and never an error, exactly as in grantReward.
  const disabled = await disabledMechanics();
  const enabled = PIPELINE_STAGES.filter((s) => !disabled.has(s));
  if (enabled.length === 0) {
    logEvent("info", "reward.pipeline_sweep_all_disabled", {});
    await markSweepAttempted(userId);
    return empty;
  }

  // 1. The owner's items. This is the ONLY place a tenant filter is applied,
  //    and everything below hangs off the ids it returns.
  const items: PipelineItem[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("inventory_items")
      .select("id, brand, garment_type, measurements, comped_at, created_at, updated_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error("sweep: inventory_items read failed: " + error.message);
    const page = (data ?? []) as unknown as PipelineItem[];
    items.push(...page);
    if (page.length < PAGE) break;
  }
  if (items.length === 0) {
    await markSweepAttempted(userId);
    return empty;
  }

  const itemIds = items.map((i) => i.id);
  const photos = await loadForItems<PipelinePhoto>("item_photos", "created_at", itemIds);
  const listings = await loadForItems<PipelineListing>(
    "listings",
    "platform_listing_id, listed_at, created_at",
    itemIds,
  );
  const sales = await loadForItems<PipelineSale>(
    "sales",
    "sale_price, sold_at, sale_date",
    itemIds,
  );
  const repricing = await loadForItems<PipelineRepricing>(
    "repricing_suggestions",
    "created_at",
    itemIds,
  );

  // 2. What this owner has already earned, so the plan neither double-grants nor
  //    ignores XP that already counts against a date's ceiling.
  const { granted: existing, spentByDate } = await loadExistingPipelineXp(userId);

  // 3. Derive, drop what is already granted or disabled, and plan under the cap.
  const candidates: PipelineCandidate[] = [];
  for (const item of items) {
    const marks = pipelineMarksForItem(
      item,
      photos.get(item.id) ?? [],
      listings.get(item.id) ?? [],
      sales.get(item.id) ?? [],
      repricing.get(item.id) ?? [],
    );
    for (const mark of marks) {
      if (!enabled.includes(mark.stage)) continue;
      if (existing.has(pipelineReferenceId(item.id, mark.stage))) continue;
      candidates.push({ itemId: item.id, stage: mark.stage, occurredAt: mark.occurredAt });
    }
  }
  if (candidates.length === 0) {
    await markSweepAttempted(userId);
    return empty;
  }

  const cap = await pipelineDailyCap();
  const { granted, cappedOut } = planPipelineGrants(candidates, spentByDate, cap);
  if (granted.length === 0) {
    await markSweepAttempted(userId);
    return { ...empty, cappedOut };
  }

  // 4. Emit. The unique index makes a concurrent sweep's duplicate a no-op.
  for (const g of granted) {
    await emitReputationEvent(userId, {
      eventType: g.stage,
      verified: true,
      referenceId: g.referenceId,
      metadata: { paid: false, item_id: g.itemId },
      source: "rewards-pipeline",
      occurredAt: g.occurredAt,
    });
  }

  // 5. The grantReward tail, once for the whole sweep.
  const state = await recomputeRewardState(userId);
  try {
    await awardBadges(userId);
  } catch (err) {
    console.error(
      "[rewards-pipeline] badge award failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (state) await grantTangibleRewards(userId, state.xpTotal);
  await markSweepAttempted(userId);

  return {
    marksGranted: granted.length,
    xpAdded: granted.reduce((sum, g) => sum + g.xp, 0),
    levelBefore: before?.level ?? 0,
    levelAfter: state?.level ?? before?.level ?? 0,
    cappedOut,
  };
}

/** Reference ids already granted, plus pipeline XP already spent per date. */
async function loadExistingPipelineXp(
  userId: string,
): Promise<{ granted: Set<string>; spentByDate: Map<string, number> }> {
  const granted = new Set<string>();
  const spentByDate = new Map<string, number>();
  for (let from = 0;; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("reputation_events")
      .select("event_type, reference_id, occurred_at")
      .eq("user_id", userId)
      .in("event_type", PIPELINE_STAGES as unknown as string[])
      .order("occurred_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error("sweep: reputation_events read failed: " + error.message);
    const page = (data ?? []) as Array<
      { event_type: string; reference_id: string; occurred_at: string }
    >;
    for (const row of page) {
      granted.add(row.reference_id);
      const key = utcDateKey(row.occurred_at);
      const xp = REWARD_XP_CATALOG[row.event_type as RewardEventType] ?? 0;
      spentByDate.set(key, (spentByDate.get(key) ?? 0) + xp);
    }
    if (page.length < PAGE) break;
  }
  return { granted, spentByDate };
}

/**
 * Stamp the throttle marker. Written on every sweep ATTEMPT, including one that
 * grants nothing, so a seller with no new marks cannot re-sweep on every page
 * load. Best-effort: a failure here must never fail the sweep that just worked.
 */
export async function markSweepAttempted(userId: string): Promise<void> {
  // UPSERT, not update. A seller with items but no rewardable act yet has no
  // user_reward_state row, and an update would silently match nothing — which
  // would leave them permanently at the head of the nightly queue, swept over
  // and over while everyone behind them waited.
  const { error } = await supabaseAdmin
    .from("user_reward_state")
    .upsert(
      { user_id: userId, last_pipeline_sweep_at: new Date().toISOString() } as never,
      { onConflict: "user_id" },
    );
  if (error) {
    console.error("[rewards-pipeline] sweep timestamp failed:", error.message);
  }
}

/**
 * How long an on-demand sweep is suppressed after the last attempt.
 *
 * Short enough that finishing an item and glancing at the rewards card feels
 * live; long enough that a seller clicking between FlipDesk tabs does not run a
 * full derivation on every navigation.
 */
export const SWEEP_THROTTLE_MS = 5 * 60_000;

/** Is this seller due an on-demand sweep, given when one was last ATTEMPTED? */
export function sweepIsDue(lastAttemptIso: string | null | undefined, nowMs: number): boolean {
  const last = parseable(lastAttemptIso ?? null);
  if (!last) return true;
  return nowMs - Date.parse(last) >= SWEEP_THROTTLE_MS;
}

/**
 * Run a sweep for this seller unless one ran inside the throttle window.
 *
 * Best-effort by contract. This rides on the back of the rewards screen load,
 * and a sweep problem must never take that screen down — the same reasoning
 * that makes a disabled mechanic a no-op rather than an error in grantReward.
 * Returns the summary when a sweep ran, or null when it was throttled or failed.
 */
export async function sweepOnDemand(
  userId: string,
  nowMs: number = Date.now(),
): Promise<PipelineSweepSummary | null> {
  try {
    const { data } = await supabaseAdmin
      .from("user_reward_state")
      .select("last_pipeline_sweep_at")
      .eq("user_id", userId)
      .maybeSingle();
    const last = (data as { last_pipeline_sweep_at: string | null } | null)
      ?.last_pipeline_sweep_at ?? null;
    if (!sweepIsDue(last, nowMs)) return null;
    return await sweepPipelineRewards(userId);
  } catch (err) {
    console.error(
      "[rewards-pipeline] on-demand sweep failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Stamp the attempt anyway: a seller whose sweep throws must not re-throw it
    // on every single page load.
    await markSweepAttempted(userId);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// US-2973: the arrival moment.
//
// The design for this story assumed a backfill would fire a level-up
// notification per level crossed, and that the job was to SUPPRESS fourteen of
// them. Reading the code first says otherwise, in two ways that matter:
//
//   1. There are NO server-side level-up notifications or emails. Celebrations
//      are computed entirely client-side by src/lib/reward-celebrations.ts,
//      which diffs two snapshots and emits ONE `level:<n>` event however many
//      levels were crossed. Nothing to suppress.
//   2. detectCelebrations returns [] when the previous snapshot is null, and
//      that snapshot lives in localStorage. A seller who has never opened the
//      rewards page therefore gets NOTHING for their backfill — and "has never
//      opened the rewards page" describes almost exactly the population this
//      whole feature exists for.
//
// So the real risk was never noise. It was silence. The arrival moment has to be
// driven by the SERVER, from state that survives a fresh browser, which is what
// user_reward_state.arrival_seen_level is for.
//
// It fires once, at level >= 2, for a seller who has never acknowledged one.
// Migration 00681 baselines everyone who already earned through the normal UI,
// so nobody is congratulated for a level they have been looking at for weeks.
// ─────────────────────────────────────────────────────────────────────────────

/** A level jump has to be at least this big to be an arrival rather than a level-up. */
export const ARRIVAL_MIN_LEVEL = 2;

export interface ArrivalState {
  /** The level to celebrate. */
  level: number;
  /** Badges the seller holds, shown together rather than as N separate cards. */
  badgeCount: number;
}

/**
 * Should this seller see the one-time arrival moment? Pure.
 *
 * `seenLevel` is `user_reward_state.arrival_seen_level`: NULL means never shown.
 * A seller who has acknowledged any arrival never sees another — subsequent
 * level-ups are ordinary celebrations, handled by the client-side diff.
 */
export function arrivalIsDue(seenLevel: number | null | undefined, level: number): boolean {
  if (seenLevel !== null && seenLevel !== undefined) return false;
  return level >= ARRIVAL_MIN_LEVEL;
}

/** The arrival payload for the rewards screen, or null when none is due. */
export async function loadArrival(
  userId: string,
  level: number,
  badgeCount: number,
): Promise<ArrivalState | null> {
  try {
    const { data } = await supabaseAdmin
      .from("user_reward_state")
      .select("arrival_seen_level")
      .eq("user_id", userId)
      .maybeSingle();
    const seen = (data as { arrival_seen_level: number | null } | null)?.arrival_seen_level ??
      null;
    if (!arrivalIsDue(seen, level)) return null;
    return { level, badgeCount };
  } catch (err) {
    // Best-effort, like everything else riding the rewards read: a missing
    // celebration is a disappointment, a broken rewards screen is a bug.
    console.error(
      "[rewards-pipeline] arrival read failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Record that the seller has seen their arrival. Idempotent and monotonic: it
 * only ever moves the acknowledged level UP, so a stale request from a second
 * tab cannot re-arm the moment.
 */
export async function acknowledgeArrival(userId: string, level: number): Promise<void> {
  const target = Math.max(0, Math.floor(level));

  // ⚠ Two sequential conditional updates, NOT one `.or(...)`. US-1552: the
  // self-hosted prod PostgREST rejects logical operators on a mutation with a
  // 42703 naming the update-CTE alias, while the newer local-stack PostgREST
  // accepts them — so an `.or()` here passes every test on this machine and
  // fails only in production.
  const first = await supabaseAdmin
    .from("user_reward_state")
    .update({ arrival_seen_level: target })
    .eq("user_id", userId)
    .is("arrival_seen_level", null)
    .select("user_id");
  if (first.error) {
    console.error("[rewards-pipeline] arrival ack failed:", first.error.message);
    return;
  }
  if ((first.data ?? []).length > 0) return; // the NULL case, which is the usual one

  // Already acknowledged something: only ever move the level UP, so a stale
  // request from a second tab cannot re-arm the moment.
  const second = await supabaseAdmin
    .from("user_reward_state")
    .update({ arrival_seen_level: target })
    .eq("user_id", userId)
    .lt("arrival_seen_level", target);
  if (second.error) {
    console.error("[rewards-pipeline] arrival ack failed:", second.error.message);
  }
}
