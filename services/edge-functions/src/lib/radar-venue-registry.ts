// US-1862: the IMPURE half of Thrift Radar venue resolution — the reads, the
// candidate insert, the observation bump and the merge writes.
//
// Every decision this module makes is made for it by the pure functions in
// `radar-venues.ts`; what lives here is only the trip to the database. The
// division is the same one US-1861 used for the privacy primitives, and for the
// same reason: a resolver whose thresholds can only be exercised through a live
// Postgres is a resolver whose thresholds are not tested.
//
// Two properties worth stating up front:
//
//   • THE RAW FIX NEVER REACHES AN INSERT. `resolveScanVenue` takes a fix and a
//     cell; the fix is used to measure distance to venues that already exist,
//     and the only thing a NEW venue is built from is the cell. There is no
//     code path from a contributor coordinate to a stored one.
//   • NOTHING HERE MAY BE FATAL. Resolution runs inside the fire-and-forget
//     contribution path (rule 8), so every failure returns "unresolved" and the
//     event falls back to its geohash cell — which is a state the schema
//     already allows, not a degraded one.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { captureException } from "./observability.ts";
import {
  candidateVenueDraft,
  cellNeighbors,
  DEFAULT_CONFIRM_MIN_OBSERVATIONS,
  DEFAULT_MATCH_RADIUS_METERS,
  DEFAULT_MERGE_RADIUS_METERS,
  type LatLng,
  planVenueMerges,
  type RadarVenue,
  type RadarVenueChain,
  resolveNearestVenue,
  type VenueMergePlan,
} from "./radar-venues.ts";

export interface RadarVenueConfig {
  resolution_enabled: boolean;
  match_radius_meters: number;
  merge_radius_meters: number;
  confirm_min_observations: number;
}

export const RADAR_VENUE_DEFAULTS: RadarVenueConfig = {
  resolution_enabled: true,
  match_radius_meters: DEFAULT_MATCH_RADIUS_METERS,
  merge_radius_meters: DEFAULT_MERGE_RADIUS_METERS,
  confirm_min_observations: DEFAULT_CONFIRM_MIN_OBSERVATIONS,
};

export function radarVenueConfig(): Promise<RadarVenueConfig> {
  return getSetting<RadarVenueConfig>("radar_venues", RADAR_VENUE_DEFAULTS);
}

/** Columns the resolver needs. Mirrors `RadarVenue` exactly. */
const VENUE_COLUMNS =
  "id, display_name, chain, lat, lng, geohash, status, merged_into_id, observation_count, created_at";

/**
 * Load every live venue in a cell and its eight neighbours.
 *
 * The neighbourhood, not the single cell: a store near a cell boundary would
 * otherwise be unreachable from a scan that landed just the other side of the
 * line, and each such scan would mint a duplicate candidate for the same shop.
 */
export async function loadVenuesNear(cell: string): Promise<RadarVenue[]> {
  const cells = cellNeighbors(cell);
  if (cells.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("radar_venues")
    .select(VENUE_COLUMNS)
    .in("geohash", cells)
    .neq("status", "merged")
    .limit(200);
  if (error) {
    captureException(error, { level: "warn", route: "radar.venues.load" });
    return [];
  }
  return (data ?? []) as unknown as RadarVenue[];
}

/**
 * Resolve a scan to a venue id, creating a candidate when nothing is near.
 *
 * Returns null when resolution is off, the cell is unusable, or the database
 * refused — never throws. A null result is the pre-US-1862 behaviour: the event
 * keeps its geohash cell and the venue layer simply has one fewer observation.
 */
export async function resolveScanVenue(
  fix: LatLng,
  cell: string,
  config?: RadarVenueConfig,
): Promise<string | null> {
  try {
    const cfg = config ?? await radarVenueConfig();
    if (cfg.resolution_enabled === false) return null;

    const nearby = await loadVenuesNear(cell);
    const match = resolveNearestVenue(fix, nearby, cfg.match_radius_meters);
    if (match) {
      await bumpVenueObservation(match.venue, cfg);
      return match.venue.id;
    }

    const created = await createCandidateVenue(cell);
    if (!created) return null;
    // A brand-new candidate is exactly when a near-duplicate is most likely —
    // two scans a few metres apart either side of a cell boundary. Cheap
    // (cell-scoped) and fire-and-forget, because a missed dedupe is a cosmetic
    // problem and a slow scan is not.
    void dedupeVenuesNear(cell, cfg).catch(() => {});
    return created;
  } catch (err) {
    captureException(err, { level: "warn", route: "radar.venues.resolve" });
    return null;
  }
}

/**
 * Match a scan to a venue that ALREADY EXISTS. Never creates one, never bumps an
 * observation count.
 *
 * US-1864: this is what the personal layer uses when the account has NOT opted
 * in to contributing. The reseller's own visit history is theirs and needs no
 * consent (rule 7), but minting a shared venue row — or advancing the counter
 * that promotes a candidate to confirmed — IS a contribution to the map, and
 * doing that off a non-contributor's coordinate is exactly the widening rule 3
 * refuses. So a non-contributor's scan may recognise a place the map already
 * knows and otherwise keeps only its cell.
 */
export async function matchScanVenue(
  fix: LatLng,
  cell: string,
  config?: RadarVenueConfig,
): Promise<string | null> {
  try {
    const cfg = config ?? await radarVenueConfig();
    if (cfg.resolution_enabled === false) return null;
    const nearby = await loadVenuesNear(cell);
    const match = resolveNearestVenue(fix, nearby, cfg.match_radius_meters);
    return match ? match.venue.id : null;
  } catch (err) {
    captureException(err, { level: "warn", route: "radar.venues.match" });
    return null;
  }
}

/**
 * Insert the candidate an unresolved scan creates, and return its id.
 *
 * The partial unique index on (geohash, chain) is what makes later scans
 * CONVERGE rather than each minting a row, and it is also what makes two
 * concurrent scans safe: the loser's insert conflicts, we re-read, and both
 * scans end up on the same venue.
 */
export async function createCandidateVenue(
  cell: string,
  chain: RadarVenueChain = "other",
): Promise<string | null> {
  const draft = candidateVenueDraft(cell, chain);
  if (!draft) return null;

  const { data, error } = await supabaseAdmin
    .from("radar_venues")
    .insert({ ...draft, observation_count: 1 } as never)
    .select("id")
    .maybeSingle();

  if (!error && data) return (data as { id: string }).id;

  // 23505 = the unique index fired, i.e. a concurrent scan won the race. Read
  // the winner and use it; anything else is a genuine failure.
  const existing = await supabaseAdmin
    .from("radar_venues")
    .select("id")
    .eq("geohash", cell)
    .eq("chain", chain)
    .neq("status", "merged")
    .maybeSingle();
  if (existing.data) return (existing.data as { id: string }).id;

  if (error) captureException(error, { level: "warn", route: "radar.venues.create" });
  return null;
}

/**
 * Record that one more contribution resolved here, and promote a candidate that
 * has cleared the interest threshold.
 *
 * `confirm_min_observations` is NOT the privacy floor. It says "enough scans
 * have happened here that this is a real place"; whether the aggregate may be
 * SHOWN is `radar_privacy.k_anonymity_floor`, computed from distinct
 * contributor keys on the events. Conflating them would let one enthusiastic
 * contributor promote a venue into visibility on their own.
 */
async function bumpVenueObservation(
  venue: RadarVenue,
  cfg: RadarVenueConfig,
): Promise<void> {
  const next = venue.observation_count + 1;
  const patch: Record<string, unknown> = {
    observation_count: next,
    last_seen_at: new Date().toISOString(),
  };
  if (
    venue.status === "candidate" &&
    next >= Math.max(1, cfg.confirm_min_observations)
  ) {
    patch.status = "confirmed";
  }
  const { error } = await supabaseAdmin
    .from("radar_venues")
    .update(patch as never)
    .eq("id", venue.id);
  if (error) captureException(error, { level: "warn", route: "radar.venues.bump" });
}

/**
 * Fold `mergeId` into `keepId`: reassign its events, widen the survivor, and
 * tombstone the loser.
 *
 * Order matters. Events move FIRST, so a crash between the two writes leaves
 * observations on a live venue rather than on a tombstone. The loser keeps its
 * row (status 'merged', `merged_into_id` set) rather than being deleted, so an
 * id already handed out can never dangle.
 */
export async function applyVenueMerge(plan: VenueMergePlan): Promise<boolean> {
  try {
    const events = await supabaseAdmin
      .from("radar_scan_events")
      .update({ venue_id: plan.keepId } as never)
      .eq("venue_id", plan.mergeId);
    if (events.error) {
      captureException(events.error, { level: "warn", route: "radar.venues.merge" });
      return false;
    }

    const survivor = await supabaseAdmin
      .from("radar_venues")
      .update({
        lat: plan.centroid.lat,
        lng: plan.centroid.lng,
        observation_count: plan.observationCount,
      } as never)
      .eq("id", plan.keepId);
    if (survivor.error) {
      captureException(survivor.error, { level: "warn", route: "radar.venues.merge" });
      return false;
    }

    const loser = await supabaseAdmin
      .from("radar_venues")
      .update({ status: "merged", merged_into_id: plan.keepId } as never)
      .eq("id", plan.mergeId);
    if (loser.error) {
      captureException(loser.error, { level: "warn", route: "radar.venues.merge" });
      return false;
    }
    return true;
  } catch (err) {
    captureException(err, { level: "warn", route: "radar.venues.merge" });
    return false;
  }
}

/**
 * Find and apply every near-duplicate merge in a cell's neighbourhood.
 *
 * Returns the number of merges applied. Never throws — this runs unawaited off
 * the contribution path.
 */
export async function dedupeVenuesNear(
  cell: string,
  config?: RadarVenueConfig,
): Promise<number> {
  try {
    const cfg = config ?? await radarVenueConfig();
    const venues = await loadVenuesNear(cell);
    if (venues.length < 2) return 0;
    const plans = planVenueMerges(venues, cfg.merge_radius_meters);
    let applied = 0;
    for (const plan of plans) {
      if (await applyVenueMerge(plan)) applied++;
    }
    return applied;
  } catch (err) {
    captureException(err, { level: "warn", route: "radar.venues.dedupe" });
    return 0;
  }
}
