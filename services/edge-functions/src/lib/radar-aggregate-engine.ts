// US-1863: the IMPURE half of Thrift Radar aggregation — the reads, the upsert,
// the sweep and the retention prune.
//
// Same split as US-1861/US-1862: every decision (window math, the k-anonymity
// floor, the archive merge rule, the prune boundary) lives in the pure
// `radar-aggregates.ts` and is unit-tested without a database. This module only
// moves rows.
//
// Two properties worth stating, because both are easy to lose in a refactor:
//
//   • THE ENGINE WRITES ONLY WHAT CLEARS THE FLOOR. `servableAggregates` sits
//     between the computation and the upsert, and there is no other path to the
//     table. A venue that drops below the floor between runs does not keep a
//     stale row either: every run stamps `computed_at` and then deletes
//     everything it did not rewrite.
//   • PRUNING NEVER OUTRUNS ARCHIVING. The events deleted are exactly the ids
//     that were read, rolled up and written to `radar_scan_history` in the same
//     pass — not a `WHERE scanned_at < cutoff` delete that could remove a row
//     the rollup never saw.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { logEvent } from "./observability.ts";
import { radarPrivacyConfig } from "./radar-events.ts";
import {
  aggregateScanEvents,
  clampKFloor,
  clampRetentionDays,
  historyPlaceKey,
  MAX_RADAR_WINDOW_DAYS,
  mergeHistoryRow,
  offsetMinutesForLongitude,
  type RadarAggregateRow,
  type RadarHistoryRow,
  type RadarScanEvent,
  retentionCutoff,
  rollupExpiredEvents,
  servableAggregates,
} from "./radar-aggregates.ts";

// ── Configuration ───────────────────────────────────────────────────────────

export interface RadarAggregationConfig {
  aggregation_enabled: boolean;
  retention_enabled: boolean;
  max_events_per_run: number;
  max_prune_events_per_run: number;
  bbox_venue_limit: number;
}

export const RADAR_AGGREGATION_DEFAULTS: RadarAggregationConfig = {
  aggregation_enabled: true,
  retention_enabled: true,
  max_events_per_run: 200_000,
  max_prune_events_per_run: 50_000,
  bbox_venue_limit: 200,
};

export function radarAggregationConfig(): Promise<RadarAggregationConfig> {
  return getSetting<RadarAggregationConfig>(
    "radar_aggregation",
    RADAR_AGGREGATION_DEFAULTS,
  );
}

const EVENT_COLUMNS =
  "id, contributor_key, venue_id, geohash, brand, grade_band, verdict, scanned_at";

const PAGE_SIZE = 1000;
const WRITE_CHUNK = 200;
const MS_PER_DAY = 86_400_000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface RadarAggregationResult {
  events: number;
  venues: number;
  aggregates: number;
  /** Groups computed but withheld because they did not clear the floor. */
  suppressed: number;
  removed: number;
  kFloor: number;
}

/**
 * Read every venue-resolved event inside the widest window.
 *
 * Paged, and bounded by `max_events_per_run`: a run that hits the cap produces
 * aggregates from the most RECENT events (the read is newest-first), which is
 * the half that matters for a freshness signal, rather than timing out and
 * producing none.
 */
async function loadRecentVenueEvents(
  now: Date,
  maxEvents: number,
): Promise<RadarScanEvent[]> {
  const since = new Date(now.getTime() - MAX_RADAR_WINDOW_DAYS * MS_PER_DAY)
    .toISOString();
  const events: RadarScanEvent[] = [];

  for (let offset = 0; offset < maxEvents; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, maxEvents - offset);
    const { data, error } = await supabaseAdmin
      .from("radar_scan_events")
      .select(EVENT_COLUMNS)
      .not("venue_id", "is", null)
      .gte("scanned_at", since)
      .order("scanned_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(`radar_scan_events read failed: ${error.message}`);
    const page = (data ?? []) as unknown as RadarScanEvent[];
    events.push(...page);
    if (page.length < limit) break;
  }
  return events;
}

/**
 * Approximate UTC offsets for the venues these events landed on.
 *
 * Only the day-of-week histogram uses this, and it reads ONE column beyond the
 * ids we already hold: `lng`, which for an auto-created venue is a geohash
 * cell's centre and for a placed one is where a human or Places put the shop.
 * Neither is a contributor's fix, so bucketing "which day is this store busy"
 * by the store's own solar time costs nothing under rule 4.
 */
async function loadVenueOffsets(
  venueIds: readonly string[],
): Promise<Map<string, number>> {
  const offsets = new Map<string, number>();
  for (const part of chunk(venueIds, WRITE_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from("radar_venues")
      .select("id, lng")
      .in("id", part);
    if (error) throw new Error(`radar_venues offset read failed: ${error.message}`);
    for (const row of (data ?? []) as unknown as { id: string; lng: number | null }[]) {
      offsets.set(row.id, offsetMinutesForLongitude(row.lng));
    }
  }
  return offsets;
}

async function writeAggregates(
  rows: readonly RadarAggregateRow[],
  computedAt: string,
): Promise<void> {
  for (const part of chunk(rows, WRITE_CHUNK)) {
    const { error } = await supabaseAdmin
      .from("radar_venue_aggregates")
      .upsert(
        part.map((r) => ({ ...r, computed_at: computedAt })) as never,
        { onConflict: "venue_id,window_key,brand_key" },
      );
    if (error) throw new Error(`radar_venue_aggregates upsert failed: ${error.message}`);
  }
}

/**
 * Recompute every venue x window x brand aggregate and publish the ones that
 * clear the k-anonymity floor.
 *
 * The sweep at the end is the half that keeps the floor honest OVER TIME: a
 * venue whose second contributor stops scanning falls below K, produces no row
 * this run, and therefore has last run's row deleted. Without it the endpoint
 * would keep serving an aggregate that no longer clears the floor, which is the
 * same disclosure arriving a week late.
 */
export async function computeRadarAggregates(
  now: Date = new Date(),
): Promise<RadarAggregationResult> {
  const [privacy, tuning] = await Promise.all([
    radarPrivacyConfig(),
    radarAggregationConfig(),
  ]);
  const kFloor = clampKFloor(privacy.k_anonymity_floor);

  if (tuning.aggregation_enabled === false) {
    return { events: 0, venues: 0, aggregates: 0, suppressed: 0, removed: 0, kFloor };
  }

  const maxEvents = Math.max(
    PAGE_SIZE,
    Math.round(tuning.max_events_per_run ?? RADAR_AGGREGATION_DEFAULTS.max_events_per_run),
  );
  const events = await loadRecentVenueEvents(now, maxEvents);

  const venueIds = [...new Set(events.map((e) => e.venue_id).filter((id): id is string => !!id))];
  const venueOffsetMinutes = await loadVenueOffsets(venueIds);

  const computed = aggregateScanEvents(events, { now, venueOffsetMinutes });
  const servable = servableAggregates(computed, kFloor);
  const computedAt = now.toISOString();

  await writeAggregates(servable, computedAt);

  // Anything this run did not rewrite is either aged out or has fallen below
  // the floor. Both mean the same thing to a reader: no network data here.
  const { count: removed, error: sweepError } = await supabaseAdmin
    .from("radar_venue_aggregates")
    .delete({ count: "exact" })
    .lt("computed_at", computedAt);
  if (sweepError) {
    throw new Error(`radar_venue_aggregates sweep failed: ${sweepError.message}`);
  }

  return {
    events: events.length,
    venues: new Set(servable.map((r) => r.venue_id)).size,
    aggregates: servable.length,
    suppressed: computed.length - servable.length,
    removed: removed ?? 0,
    kFloor,
  };
}

// ── Retention ───────────────────────────────────────────────────────────────

export interface RadarRetentionResult {
  cutoff: string;
  scanned: number;
  archived: number;
  pruned: number;
  retentionDays: number;
}

interface StoredHistoryRow {
  id: string;
  place_key: string;
  month_start: string;
  scan_count: number;
}

/**
 * Archive and delete raw events older than the retention window.
 *
 * Order matters and is not an implementation detail: the archive row is written
 * FIRST, and only the ids that produced it are deleted. A crash between the two
 * leaves a duplicate-looking archive row and the events still present, and the
 * next run recomputes the same totals — an over-count is impossible because the
 * merge rule replaces wholesale with the larger computation rather than adding
 * to it.
 */
export async function pruneRadarScanEvents(
  now: Date = new Date(),
): Promise<RadarRetentionResult> {
  const [privacy, tuning] = await Promise.all([
    radarPrivacyConfig(),
    radarAggregationConfig(),
  ]);
  const retentionDays = clampRetentionDays(privacy.raw_event_retention_days);
  const cutoff = retentionCutoff(now, retentionDays);
  const cutoffIso = cutoff.toISOString();

  if (tuning.retention_enabled === false) {
    return { cutoff: cutoffIso, scanned: 0, archived: 0, pruned: 0, retentionDays };
  }

  const maxPrune = Math.max(
    PAGE_SIZE,
    Math.round(
      tuning.max_prune_events_per_run ??
        RADAR_AGGREGATION_DEFAULTS.max_prune_events_per_run,
    ),
  );

  // Oldest first, and NEVER offset: rows are deleted as the loop goes, so the
  // next read's window already starts at the oldest surviving event. Paging by
  // offset over a shrinking table skips whatever slid into the gap.
  let scanned = 0;
  let archived = 0;
  while (scanned < maxPrune) {
    const limit = Math.min(PAGE_SIZE, maxPrune - scanned);
    const { data, error } = await supabaseAdmin
      .from("radar_scan_events")
      .select(EVENT_COLUMNS)
      .lt("scanned_at", cutoffIso)
      .order("scanned_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`radar_scan_events prune read failed: ${error.message}`);
    const page = (data ?? []) as unknown as RadarScanEvent[];
    if (page.length === 0) break;

    archived += await persistHistory(rollupExpiredEvents(page, cutoff));
    await deleteEvents(page);
    scanned += page.length;
    if (page.length < limit) break;
  }

  return {
    cutoff: cutoffIso,
    scanned,
    archived,
    pruned: scanned,
    retentionDays,
  };
}

/** Write archive rows, letting the more complete computation win. */
async function persistHistory(rows: readonly RadarHistoryRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const months = [...new Set(rows.map((r) => r.month_start))];
  const { data, error } = await supabaseAdmin
    .from("radar_scan_history")
    .select("id, place_key, month_start, scan_count")
    .in("month_start", months);
  if (error) throw new Error(`radar_scan_history read failed: ${error.message}`);

  const existing = new Map<string, StoredHistoryRow>();
  for (const row of (data ?? []) as unknown as StoredHistoryRow[]) {
    existing.set(`${row.place_key}|${row.month_start}`, row);
  }

  const inserts: RadarHistoryRow[] = [];
  const updates: Array<{ id: string; row: RadarHistoryRow }> = [];
  for (const row of rows) {
    const key = `${historyPlaceKey(row)}|${row.month_start}`;
    const stored = existing.get(key);
    if (!stored) {
      inserts.push(row);
      continue;
    }
    // Only scan_count decides which computation is the more complete one, so a
    // thin stand-in for the stored row is enough to ask the rule — and asking
    // the rule (rather than re-writing the comparison here) is what keeps the
    // engine and its test looking at the same decision.
    const winner = mergeHistoryRow({ ...row, scan_count: stored.scan_count }, row);
    if (winner === row) updates.push({ id: stored.id, row });
  }

  for (const part of chunk(inserts, WRITE_CHUNK)) {
    const { error: insertError } = await supabaseAdmin
      .from("radar_scan_history")
      .insert(part as never);
    if (insertError) {
      throw new Error(`radar_scan_history insert failed: ${insertError.message}`);
    }
  }
  for (const { id, row } of updates) {
    const { error: updateError } = await supabaseAdmin
      .from("radar_scan_history")
      .update(row as never)
      .eq("id", id);
    if (updateError) {
      throw new Error(`radar_scan_history update failed: ${updateError.message}`);
    }
  }
  return inserts.length + updates.length;
}

async function deleteEvents(events: readonly RadarScanEvent[]): Promise<void> {
  const ids = events.map((e) => e.id).filter((id): id is string => Boolean(id));
  for (const part of chunk(ids, WRITE_CHUNK)) {
    const { error } = await supabaseAdmin
      .from("radar_scan_events")
      .delete()
      .in("id", part);
    if (error) throw new Error(`radar_scan_events prune delete failed: ${error.message}`);
  }
}

// ── The job ─────────────────────────────────────────────────────────────────

export interface RadarAggregationSummary
  extends RadarAggregationResult, RadarRetentionResult {}

/**
 * One scheduled pass: recompute the served aggregates, then retire raw events
 * past the retention window.
 *
 * Aggregation runs FIRST. Both orders are correct (the prune boundary is always
 * outside the widest window), but recomputing before deleting means a run that
 * fails halfway has still refreshed what people read.
 */
export async function runRadarAggregation(
  now: Date = new Date(),
): Promise<RadarAggregationSummary> {
  const aggregation = await computeRadarAggregates(now);
  const retention = await pruneRadarScanEvents(now);
  logEvent("info", "radar.aggregation.complete", {
    events: aggregation.events,
    venues: aggregation.venues,
    aggregates: aggregation.aggregates,
    suppressed: aggregation.suppressed,
    pruned: retention.pruned,
  });
  return { ...aggregation, ...retention };
}
