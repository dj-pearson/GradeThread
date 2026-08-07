// US-1862: the PURE half of Thrift Radar venue resolution — chain
// normalization, geohash cell geometry, nearest-venue matching, candidate
// drafting and duplicate-merge planning.
//
// Same split as US-1861: nothing here touches Supabase or the environment, so
// every decision the resolver makes is unit-testable without a database. The
// impure half (reads, inserts, the merge writes) lives in
// `radar-venue-registry.ts`.
//
// The rule this file exists to keep true — full text in
// vault/20-domain/thrift-radar.md rule 4:
//
//   A coordinate is allowed to DECIDE which venue a scan belongs to, and is not
//   allowed to SURVIVE that decision. So `resolveNearestVenue` takes a raw fix
//   (transient, in-request) while `candidateVenueDraft` takes only a CELL — the
//   centroid a new venue is born with is the middle of a ~1.2 km x 0.6 km
//   geohash cell, identical for every scan in that cell, and therefore not a
//   record of where anybody stood.

import { clampPrecision, coarseCell, GEOHASH_BASE32 } from "./radar-privacy.ts";

// ── Chain identity ──────────────────────────────────────────────────────────

/** The chains Radar tracks by name. Mirrors the CHECK on radar_venues.chain. */
export const RADAR_VENUE_CHAINS = [
  "goodwill",
  "savers",
  "salvation_army",
  "value_village",
  "other",
] as const;

export type RadarVenueChain = typeof RADAR_VENUE_CHAINS[number];

export const RADAR_VENUE_STATUSES = ["candidate", "confirmed", "merged"] as const;
export type RadarVenueStatus = typeof RADAR_VENUE_STATUSES[number];

/**
 * Patterns that identify a chain from a free-typed store name. Ordered: the
 * first match wins, so anything that would otherwise be swallowed by a broader
 * pattern goes first.
 *
 * Deliberately conservative. A name we cannot place is 'other', which costs
 * nothing — chain is a grouping convenience, and mislabelling an independent
 * thrift store as a Goodwill would put it in a comparison it does not belong in.
 */
const CHAIN_PATTERNS: ReadonlyArray<readonly [RadarVenueChain, RegExp]> = [
  // Value Village and Savers are the same company, and both names are in use.
  // They stay DISTINCT tags because a shopper reads them as different stores.
  ["value_village", /\bvalue\s*village\b/],
  ["savers", /\bsavers\b/],
  ["salvation_army", /\bsalvation\s*army\b/],
  ["salvation_army", /\bsalvation\b/],
  // "Goodwill Industries", "Goodwill Store #123", "goodwill of michigan".
  ["goodwill", /\bgood\s*will\b/],
];

/**
 * Fold a store name to its chain tag.
 *
 * 'Goodwill Store #123' and 'Goodwill Industries of Michigan' both return
 * 'goodwill' — but they remain two SEPARATE venue rows. Chain is a shared label
 * on distinct places, never a reason to merge them.
 */
export function normalizeChain(name: string | null | undefined): RadarVenueChain {
  if (typeof name !== "string") return "other";
  // Fold punctuation and casing so "GOODWILL-STORE#123" reads like the rest.
  const hay = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!hay) return "other";
  for (const [chain, pattern] of CHAIN_PATTERNS) {
    if (pattern.test(hay)) return chain;
  }
  return "other";
}

/** True when `value` is one of the chain tags the schema will accept. */
export function isRadarVenueChain(value: unknown): value is RadarVenueChain {
  return typeof value === "string" &&
    (RADAR_VENUE_CHAINS as readonly string[]).includes(value);
}

// ── Cell geometry ───────────────────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

export interface CellBounds {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
}

/** Decode a geohash cell to its bounding box. Null for a malformed cell. */
export function cellBounds(geohash: string): CellBounds | null {
  if (typeof geohash !== "string" || geohash.length === 0) return null;
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let isLng = true;
  for (const ch of geohash.toLowerCase()) {
    const idx = GEOHASH_BASE32.indexOf(ch);
    if (idx < 0) return null;
    for (let b = 4; b >= 0; b--) {
      const bit = (idx >> b) & 1;
      if (isLng) {
        const mid = (lngMin + lngMax) / 2;
        if (bit) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid;
        else latMax = mid;
      }
      isLng = !isLng;
    }
  }
  return { latMin, latMax, lngMin, lngMax };
}

/**
 * The centre of a geohash cell — the ONLY coordinate an auto-created venue is
 * ever born with. Every scan inside the cell produces this identical pair, so
 * it says where the cell is and nothing about where a contributor was.
 */
export function cellCentre(geohash: string): LatLng | null {
  const b = cellBounds(geohash);
  if (!b) return null;
  return {
    lat: (b.latMin + b.latMax) / 2,
    lng: (b.lngMin + b.lngMax) / 2,
  };
}

/**
 * The cell plus its eight neighbours, at the cell's own precision.
 *
 * A store sitting near a cell boundary would otherwise be invisible to a scan
 * that landed one metre the other side of the line, and every such scan would
 * mint a second candidate for the same shop. Derived by stepping a whole cell
 * width/height off the centre and re-encoding — no border lookup tables to get
 * subtly wrong. Always includes `geohash` itself, first.
 */
export function cellNeighbors(geohash: string): string[] {
  const b = cellBounds(geohash);
  if (!b) return [];
  const precision = clampPrecision(geohash.length);
  const height = b.latMax - b.latMin;
  const width = b.lngMax - b.lngMin;
  const lat0 = (b.latMin + b.latMax) / 2;
  const lng0 = (b.lngMin + b.lngMax) / 2;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const dLat of [0, -1, 1]) {
    for (const dLng of [0, -1, 1]) {
      const lat = Math.min(90, Math.max(-90, lat0 + dLat * height));
      // Wrap across the antimeridian rather than clamping — clamping would fold
      // the two sides of the date line onto the same cell.
      let lng = lng0 + dLng * width;
      if (lng > 180) lng -= 360;
      if (lng < -180) lng += 360;
      const cell = coarseCell(lat, lng, precision);
      if (cell && !seen.has(cell)) {
        seen.add(cell);
        out.push(cell);
      }
    }
  }
  return out;
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** The venue fields resolution needs. A subset of the `radar_venues` row. */
export interface RadarVenue {
  id: string;
  display_name: string;
  chain: RadarVenueChain;
  lat: number;
  lng: number;
  geohash: string;
  status: RadarVenueStatus;
  merged_into_id: string | null;
  observation_count: number;
  created_at: string;
}

export interface VenueMatch {
  venue: RadarVenue;
  distanceMeters: number;
}

/** How close a scan must be to a known venue to resolve to it. */
export const DEFAULT_MATCH_RADIUS_METERS = 750;
/** How close two candidates must be before one is folded into the other. */
export const DEFAULT_MERGE_RADIUS_METERS = 250;
/** Resolved contributions that promote a candidate to confirmed. */
export const DEFAULT_CONFIRM_MIN_OBSERVATIONS = 8;

/**
 * Pick the venue a fix belongs to: the nearest LIVE venue inside the radius.
 *
 * Merged rows are skipped rather than followed — a merge rewrites the events
 * that pointed at the loser, so a live scan has no reason to land on one, and
 * silently redirecting would hide a caller that forgot to filter.
 *
 * A tie (identical distance, which cell-centre centroids make genuinely
 * possible) breaks toward the more-observed venue and then the older id, so the
 * same inputs always produce the same answer.
 */
export function resolveNearestVenue(
  fix: LatLng,
  venues: readonly RadarVenue[],
  maxMeters: number = DEFAULT_MATCH_RADIUS_METERS,
): VenueMatch | null {
  const radius = Number.isFinite(maxMeters) && maxMeters > 0
    ? maxMeters
    : DEFAULT_MATCH_RADIUS_METERS;
  let best: VenueMatch | null = null;
  for (const venue of venues) {
    if (venue.status === "merged") continue;
    const distanceMeters = haversineMeters(fix, { lat: venue.lat, lng: venue.lng });
    if (distanceMeters > radius) continue;
    if (best === null || betterMatch({ venue, distanceMeters }, best)) {
      best = { venue, distanceMeters };
    }
  }
  return best;
}

function betterMatch(a: VenueMatch, b: VenueMatch): boolean {
  if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters < b.distanceMeters;
  if (a.venue.observation_count !== b.venue.observation_count) {
    return a.venue.observation_count > b.venue.observation_count;
  }
  return a.venue.id < b.venue.id;
}

/** The insert a brand-new candidate venue is built from. */
export interface CandidateVenueDraft {
  display_name: string;
  chain: RadarVenueChain;
  lat: number;
  lng: number;
  centroid_source: "cell";
  geohash: string;
  status: "candidate";
}

/**
 * Draft the candidate an unresolved scan creates.
 *
 * Takes a CELL, not a fix — that is the whole privacy argument in the
 * signature. There is no coordinate parameter to accidentally pass through.
 * Later scans in the same cell converge onto this row via the partial unique
 * index on (geohash, chain).
 */
export function candidateVenueDraft(
  geohash: string,
  chain: RadarVenueChain = "other",
): CandidateVenueDraft | null {
  const centre = cellCentre(geohash);
  if (!centre) return null;
  if (!/^[0-9b-hjkmnp-z]{4,7}$/.test(geohash)) return null;
  return {
    display_name: `Unnamed venue ${geohash}`,
    chain,
    lat: centre.lat,
    lng: centre.lng,
    centroid_source: "cell",
    geohash,
    status: "candidate",
  };
}

/** True when a name has been supplied by a person rather than auto-derived. */
export function isPlaceholderVenueName(name: string | null | undefined): boolean {
  return typeof name === "string" && /^Unnamed venue [0-9b-hjkmnp-z]{4,7}$/.test(name.trim());
}

// ── Merge planning ──────────────────────────────────────────────────────────

export interface VenueMergePlan {
  /** The survivor. */
  keepId: string;
  /** Folded into the survivor: status → 'merged', events reassigned. */
  mergeId: string;
  distanceMeters: number;
  /** Observation-weighted centroid the survivor should end up with. */
  centroid: LatLng;
  observationCount: number;
}

/**
 * Which of two venues survives a merge.
 *
 * Confirmed beats candidate (a human said something about it); then a real name
 * beats a placeholder; then more observations; then the older row; then the
 * lower id purely so the answer is deterministic and a test can pin it.
 */
export function mergeSurvivor(a: RadarVenue, b: RadarVenue): RadarVenue {
  const rank = (v: RadarVenue) => (v.status === "confirmed" ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b;
  const named = (v: RadarVenue) => (isPlaceholderVenueName(v.display_name) ? 0 : 1);
  if (named(a) !== named(b)) return named(a) > named(b) ? a : b;
  if (a.observation_count !== b.observation_count) {
    return a.observation_count > b.observation_count ? a : b;
  }
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? a : b;
  return a.id < b.id ? a : b;
}

/**
 * Observation-weighted centroid of a merge.
 *
 * A venue with no observations yet contributes its centroid at weight 1 rather
 * than 0, so merging two empty candidates lands between them instead of
 * dividing by zero.
 */
export function mergedCentroid(keep: RadarVenue, drop: RadarVenue): LatLng {
  const wk = Math.max(1, keep.observation_count);
  const wd = Math.max(1, drop.observation_count);
  const total = wk + wd;
  return {
    lat: (keep.lat * wk + drop.lat * wd) / total,
    lng: (keep.lng * wk + drop.lng * wd) / total,
  };
}

/**
 * Plan every merge a set of near-duplicate venues needs.
 *
 * Two venues merge when they share a chain and sit within `mergeMeters`. Chain
 * matters: a Goodwill and a Savers in the same strip mall are two stores, and
 * folding them would destroy exactly the per-venue identity this registry
 * exists to create. Venues already merged are ignored, and a venue that has
 * lost one merge never survives another in the same plan — so applying the
 * plans in order can never leave a chain of merged-into-merged rows.
 */
export function planVenueMerges(
  venues: readonly RadarVenue[],
  mergeMeters: number = DEFAULT_MERGE_RADIUS_METERS,
): VenueMergePlan[] {
  const radius = Number.isFinite(mergeMeters) && mergeMeters > 0
    ? mergeMeters
    : DEFAULT_MERGE_RADIUS_METERS;
  // Deterministic order in, deterministic plan out.
  const live = venues
    .filter((v) => v.status !== "merged")
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const absorbed = new Set<string>();
  // Working copies so a second merge into the same survivor sees the centroid
  // and count the first one produced.
  const state = new Map<string, RadarVenue>(live.map((v) => [v.id, { ...v }]));
  const plans: VenueMergePlan[] = [];

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = state.get(live[i].id)!;
      const b = state.get(live[j].id)!;
      if (absorbed.has(a.id) || absorbed.has(b.id)) continue;
      if (a.chain !== b.chain) continue;
      const distanceMeters = haversineMeters(
        { lat: a.lat, lng: a.lng },
        { lat: b.lat, lng: b.lng },
      );
      if (distanceMeters > radius) continue;

      const keep = mergeSurvivor(a, b);
      const drop = keep.id === a.id ? b : a;
      const centroid = mergedCentroid(keep, drop);
      const observationCount = keep.observation_count + drop.observation_count;
      plans.push({
        keepId: keep.id,
        mergeId: drop.id,
        distanceMeters,
        centroid,
        observationCount,
      });
      absorbed.add(drop.id);
      state.set(keep.id, {
        ...keep,
        lat: centroid.lat,
        lng: centroid.lng,
        observation_count: observationCount,
      });
    }
  }
  return plans;
}
