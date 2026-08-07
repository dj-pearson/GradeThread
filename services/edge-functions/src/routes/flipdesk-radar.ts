// US-1863: Thrift Radar — the read-only network layer.
// US-1864 adds the PERSONAL layer to the same router; see the second block of
// endpoints at the bottom, and note that they are gated differently on purpose.
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
// Tenancy (US-268): the two NETWORK routes read no tenant-owned table.
// Aggregates belong to the map, not to an account — there is no id from the
// request body, and nothing scoped by user. The tenant boundary that matters on
// that surface is the plan gate above and the k-floor below.
//
// The PERSONAL routes (US-1864, at the bottom) are the opposite case: they read
// and write the caller's own rows, so every query is explicitly scoped with
// `.eq("user_id", c.get("workspaceOwnerId") ?? c.get("userId"))` in
// `radar-personal-history.ts`, and the link write confirms ownership of the
// named source BEFORE updating it. Cases in tenant-isolation_test.ts.

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
import {
  DEFAULT_PERSONAL_STORE_SORT,
  isPersonalStoreSort,
} from "../lib/radar-personal.ts";
import {
  linkSourceToVenue,
  loadPersonalStores,
} from "../lib/radar-personal-history.ts";

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

// ─── US-1864: the PERSONAL layer ────────────────────────────────────────────
//
// Everything above serves the shared map. Everything below serves one reseller
// their own sourcing history, and the differences are all deliberate:
//
//   • NO PLAN GATE. `requireFlipdesk` is absent, and its absence is the feature
//     (rule 7): the personal layer is free on every plan. It is the cold-start
//     answer — a Radar that is blank until strangers show up never gets the
//     strangers — so putting it behind the same paywall as the network layer
//     would remove the only reason to open Radar on day one.
//   • NO CONTRIBUTION CONSENT. These rows are the caller's own data. Requiring
//     `users.radar_contribute` to see your own store history would make a
//     privacy toggle into a feature paywall, which is how a consent stops being
//     a consent.
//   • NO K-ANONYMITY FLOOR. The floor stops one person's activity being inferred
//     from a shared number; this surface IS one person's activity, shown to that
//     person, where n=1 is the normal case.
//   • TENANT SCOPING IS THEREFORE THE ONLY BOUNDARY LEFT (US-268), and it lives
//     in `radar-personal-history.ts` — every owner-scoped read carries an
//     explicit `.eq("user_id", …)`, and the link write confirms ownership before
//     it and repeats the predicate in it.

const MAX_LINK_ID_LENGTH = 64;

/**
 * GET /my-stores — "your best stores", ranked.
 *
 * Works with zero network data and at n=1: a single item bought from a single
 * named source produces a row. A reseller with no items and no scans gets an
 * empty list and an honest count of what could not be attributed, not an error.
 */
flipdeskRadarRoutes.get("/my-stores", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  const raw = c.req.query("sort");
  const sort = isPersonalStoreSort(raw) ? raw : DEFAULT_PERSONAL_STORE_SORT;

  try {
    const payload = await loadPersonalStores(userId, sort);
    return c.json(payload);
  } catch (err) {
    console.error(
      "[flipdesk-radar] my-stores read:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Failed to load your store history" }, 500);
  }
});

/**
 * POST /my-stores/link — say that one of your sources IS a place on the map.
 *
 * This is the join that makes the personal layer whole: money lives on a source
 * (items, spend, sales) and visits live on a venue, and until somebody says they
 * are the same shop the two halves cannot meet. Send `venue_id: null` to unlink.
 *
 * A caller may only ever name their OWN source; the venue is shared, so naming
 * one discloses nothing they did not already have.
 */
flipdeskRadarRoutes.post("/my-stores/link", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { source_id?: unknown; venue_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const sourceId = typeof body.source_id === "string" ? body.source_id.trim() : "";
  if (!sourceId || sourceId.length > MAX_LINK_ID_LENGTH) {
    return c.json({ error: "source_id is required" }, 400);
  }

  // Absent and explicit null both mean "unlink" — a client clearing the select
  // should not have to know which one this endpoint prefers.
  let venueId: string | null = null;
  if (typeof body.venue_id === "string") {
    const trimmed = body.venue_id.trim();
    if (trimmed.length > MAX_LINK_ID_LENGTH) {
      return c.json({ error: "venue_id is not a valid id" }, 400);
    }
    venueId = trimmed.length > 0 ? trimmed : null;
  } else if (body.venue_id != null) {
    return c.json({ error: "venue_id must be a string or null" }, 400);
  }

  const result = await linkSourceToVenue(userId, sourceId, venueId);
  if (result.ok) return c.json({ ok: true, venue_id: result.venue_id });

  switch (result.reason) {
    case "unknown_source":
      // The SAME body a source that does not exist would get. A caller must not
      // be able to tell "not yours" from "not real" — that difference is a way
      // to enumerate other tenants' source ids.
      return c.json({ error: "Source not found" }, 404);
    case "unknown_venue":
      return c.json({ error: "Venue not found" }, 404);
    default:
      return c.json({ error: "Failed to link that store" }, 500);
  }
});
