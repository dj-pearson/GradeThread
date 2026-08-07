// US-1863: Thrift Radar — the read-only network layer.
//
// Two endpoints, both serving the aggregates the cron publishes:
//   GET /venues?bbox=minLat,minLng,maxLat,maxLng[&window=30d][&brand=]
//   GET /venues/:id[?window=30d]
//
// Three properties this file exists to hold, all of them from
// vault/20-domain/thrift-radar.md:
//
//   • NO PER-CONTRIBUTOR DATA LEAVES. The responses are built from
//     `toVenueNetworkDto`, which carries counts and rates and nothing that
//     could name, key or order a contributor. `radar_scan_events` is not read
//     here at all.
//   • THE K-FLOOR IS RE-APPLIED ON READ (rule 6). The aggregates table already
//     holds only rows above the floor — the engine filters, and a CHECK refuses
//     a single-contributor row — and this route checks AGAIN, because the case
//     a stored guarantee misses is exactly the row that got there some other
//     way. A venue with nothing servable is OMITTED from the list and 404s on
//     detail, with the SAME body an unknown id gets: "below the floor" is
//     itself a disclosure that somebody scanned there.
//   • THE NETWORK LAYER IS PRO+ (rule 7), gated here rather than only in the
//     UI, on the same `compPulls` flag the Prospect scan that feeds it uses.
//     The PERSONAL layer is a separate, free surface and is not served here.
//
// Tenancy (US-268): these routes read NO tenant-owned table. Aggregates belong
// to the map, not to an account — there is no id from the request body, and
// nothing scoped by user. The tenant boundary that matters on this surface is
// the plan gate above and the k-floor below.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { radarPrivacyConfig } from "../lib/radar-events.ts";
import { radarAggregationConfig } from "../lib/radar-aggregate-engine.ts";
import {
  ALL_BRANDS_KEY,
  brandKey,
  clampKFloor,
  DEFAULT_RADAR_WINDOW,
  isRadarWindowKey,
  type RadarAggregateRow,
  type RadarWindowKey,
  toVenueNetworkDto,
} from "../lib/radar-aggregates.ts";
import type { RadarVenueChain, RadarVenueStatus } from "../lib/radar-venues.ts";

export const flipdeskRadarRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

/** How large a viewport may be. Bigger asks are a scrape, not a map. */
const MAX_BBOX_DEGREES = 5;
const DEFAULT_VENUE_LIMIT = 200;
const HARD_VENUE_LIMIT = 500;

const AGGREGATE_COLUMNS =
  "venue_id, window_key, brand_key, window_start, window_end, scan_count, " +
  "contributor_count, avg_grade, high_count, mid_count, low_count, " +
  "ungraded_count, buy_count, verdict_count, buy_rate, last_activity_at";

interface VenueRow {
  id: string;
  display_name: string;
  chain: RadarVenueChain;
  lat: number;
  lng: number;
  status: RadarVenueStatus;
}

interface BoundingBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** Parse `minLat,minLng,maxLat,maxLng`. Null for anything unusable or oversized. */
export function parseBoundingBox(raw: string | undefined): BoundingBox | null {
  if (!raw) return null;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLat, minLng, maxLat, maxLng] = parts;
  if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) return null;
  if (minLat >= maxLat || minLng >= maxLng) return null;
  if (maxLat - minLat > MAX_BBOX_DEGREES || maxLng - minLng > MAX_BBOX_DEGREES) {
    return null;
  }
  return { minLat, minLng, maxLat, maxLng };
}

function resolveWindow(raw: string | undefined): RadarWindowKey {
  return isRadarWindowKey(raw) ? raw : DEFAULT_RADAR_WINDOW;
}

/**
 * GET /venues — the map viewport.
 *
 * Venues with no servable aggregate are left OUT ENTIRELY, not returned with an
 * empty payload. A candidate venue exists because somebody scanned in its cell,
 * so listing one that has not cleared the floor would publish the very thing
 * the floor withholds.
 */
flipdeskRadarRoutes.get("/venues", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const gate = await requireFlipdesk(c, { feature: "compPulls", userId });
  if (gate) return gate;

  const bbox = parseBoundingBox(c.req.query("bbox"));
  if (!bbox) {
    return c.json({
      error:
        `bbox must be "minLat,minLng,maxLat,maxLng", ordered, in range, and no larger than ${MAX_BBOX_DEGREES} degrees a side`,
    }, 400);
  }

  const windowKey = resolveWindow(c.req.query("window"));
  const brand = brandKey(c.req.query("brand") ?? null);
  const key = brand ?? ALL_BRANDS_KEY;

  const [privacy, tuning] = await Promise.all([
    radarPrivacyConfig(),
    radarAggregationConfig(),
  ]);
  const kFloor = clampKFloor(privacy.k_anonymity_floor);
  const limit = Math.min(
    HARD_VENUE_LIMIT,
    Math.max(1, Math.round(tuning.bbox_venue_limit ?? DEFAULT_VENUE_LIMIT)),
  );

  const { data: venueData, error: venueError } = await supabaseAdmin
    .from("radar_venues")
    .select("id, display_name, chain, lat, lng, status")
    .neq("status", "merged")
    .gte("lat", bbox.minLat)
    .lte("lat", bbox.maxLat)
    .gte("lng", bbox.minLng)
    .lte("lng", bbox.maxLng)
    .limit(limit);
  if (venueError) {
    console.error("[flipdesk-radar] venue read:", venueError.message);
    return c.json({ error: "Failed to load Radar venues" }, 500);
  }

  const venues = (venueData ?? []) as unknown as VenueRow[];
  if (venues.length === 0) {
    return c.json({ window: windowKey, brand, k_floor: kFloor, venues: [] });
  }

  const { data: aggData, error: aggError } = await supabaseAdmin
    .from("radar_venue_aggregates")
    .select(AGGREGATE_COLUMNS)
    .in("venue_id", venues.map((v) => v.id))
    .eq("window_key", windowKey)
    .eq("brand_key", key);
  if (aggError) {
    console.error("[flipdesk-radar] aggregate read:", aggError.message);
    return c.json({ error: "Failed to load Radar aggregates" }, 500);
  }

  const now = new Date();
  const byVenue = new Map<string, RadarAggregateRow>();
  for (const row of (aggData ?? []) as unknown as RadarAggregateRow[]) {
    byVenue.set(row.venue_id, row);
  }

  const out = [];
  for (const venue of venues) {
    const agg = byVenue.get(venue.id);
    if (!agg) continue;
    const network = toVenueNetworkDto(agg, kFloor, now);
    if (!network) continue;
    out.push({
      id: venue.id,
      display_name: venue.display_name,
      chain: venue.chain,
      lat: venue.lat,
      lng: venue.lng,
      status: venue.status,
      network,
    });
  }

  return c.json({ window: windowKey, brand, k_floor: kFloor, venues: out });
});

/**
 * GET /venues/:id — venue detail plus the per-brand breakdown.
 *
 * A venue below the floor and a venue that does not exist return the IDENTICAL
 * 404. Distinguishing them would answer "did anyone scan here?", which is the
 * question the floor exists to refuse.
 */
flipdeskRadarRoutes.get("/venues/:id", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const gate = await requireFlipdesk(c, { feature: "compPulls", userId });
  if (gate) return gate;

  const venueId = c.req.param("id");
  const windowKey = resolveWindow(c.req.query("window"));
  const notFound = () => c.json({ error: "Venue not found" }, 404);

  const privacy = await radarPrivacyConfig();
  const kFloor = clampKFloor(privacy.k_anonymity_floor);

  const { data: venueData, error: venueError } = await supabaseAdmin
    .from("radar_venues")
    .select("id, display_name, chain, lat, lng, status")
    .eq("id", venueId)
    .neq("status", "merged")
    .maybeSingle();
  if (venueError) {
    console.error("[flipdesk-radar] venue detail read:", venueError.message);
    return c.json({ error: "Failed to load Radar venue" }, 500);
  }
  const venue = venueData as unknown as VenueRow | null;
  if (!venue) return notFound();

  const { data: aggData, error: aggError } = await supabaseAdmin
    .from("radar_venue_aggregates")
    .select(AGGREGATE_COLUMNS)
    .eq("venue_id", venueId)
    .eq("window_key", windowKey);
  if (aggError) {
    console.error("[flipdesk-radar] venue detail aggregates:", aggError.message);
    return c.json({ error: "Failed to load Radar aggregates" }, 500);
  }

  const now = new Date();
  const rows = (aggData ?? []) as unknown as RadarAggregateRow[];
  const total = rows.find((r) => r.brand_key === ALL_BRANDS_KEY);
  const network = total ? toVenueNetworkDto(total, kFloor, now) : null;
  // No servable venue total means no venue, as far as this endpoint is
  // concerned — including the venue's name and location would already say that
  // scanning happened here.
  if (!network) return notFound();

  const brands = rows
    .filter((r) => r.brand_key !== ALL_BRANDS_KEY)
    .map((r) => toVenueNetworkDto(r, kFloor, now))
    .filter((dto): dto is NonNullable<typeof dto> => dto !== null)
    .sort((a, b) => b.scan_count - a.scan_count);

  return c.json({
    window: windowKey,
    k_floor: kFloor,
    venue: {
      id: venue.id,
      display_name: venue.display_name,
      chain: venue.chain,
      lat: venue.lat,
      lng: venue.lng,
      status: venue.status,
    },
    network,
    brands,
  });
});
