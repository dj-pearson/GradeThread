import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  ALL_BRANDS,
  bboxParam,
  type BoundingBox,
  type BrandWeight,
  type VenueActivity,
} from "@/lib/radar-map";

// US-1865: the NETWORK half of Thrift Radar, read from the browser.
//
// Two endpoints, both Pro+ and both k-floored server-side:
//   GET /api/flipdesk/radar/venues?bbox=…&window=…&brand=…
//   GET /api/flipdesk/radar/venues/:id?window=…
//
// Nothing here re-implements the k-anonymity floor, and that is deliberate: the
// floor is a property of the response (a below-floor venue is simply ABSENT, not
// flagged), so there is no suppressed payload for this layer to be trusted to
// hide. What the UI owns is the honest empty state that follows from the
// silence — see vault/20-domain/thrift-radar.md rule 6.
//
// The plan gate is likewise the endpoint's, not this hook's. `enabled` here only
// avoids firing a request we already know will 402 and pop the upgrade modal on
// page open; a caller that forgets it gets the gate anyway.

export type RadarWindowKey = "7d" | "30d" | "90d";

export const RADAR_WINDOWS: { key: RadarWindowKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
];

/**
 * The same windows as a phrase, for prose rather than a control (US-1867).
 *
 * The route planner splices the window into each stop's rationale, and "strong
 * Nike density Last 30 days" is not a sentence. Kept beside the labels so the two
 * cannot drift into naming different periods.
 */
export const RADAR_WINDOW_PHRASES: Record<RadarWindowKey, string> = {
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  "90d": "in the last 90 days",
};

export interface RadarNetworkStats {
  venue_id: string;
  window: RadarWindowKey;
  brand: string | null;
  scan_count: number;
  contributor_count: number;
  avg_grade: number | null;
  buy_rate: number | null;
  grade_mix: { high: number; mid: number; low: number; ungraded: number };
  activity_by_day: number[];
  last_activity_at: string;
  days_since_activity: number | null;
}

export interface RadarVenue {
  id: string;
  display_name: string;
  chain: string | null;
  lat: number;
  lng: number;
  status: string;
  network: RadarNetworkStats;
}

export interface RadarVenuesPayload {
  window: RadarWindowKey;
  brand: string | null;
  k_floor: number;
  venues: RadarVenue[];
}

export interface RadarVenueDetail {
  window: RadarWindowKey;
  k_floor: number;
  venue: {
    id: string;
    display_name: string;
    chain: string | null;
    lat: number;
    lng: number;
    status: string;
  };
  network: RadarNetworkStats;
  brands: RadarNetworkStats[];
}

async function fetchVenues(
  bbox: string,
  window: RadarWindowKey,
  brand: string | null,
): Promise<RadarVenuesPayload> {
  const params = new URLSearchParams({ bbox, window });
  if (brand) params.set("brand", brand);
  const res = await edgeFetch(`/api/flipdesk/radar/venues?${params.toString()}`);
  const data = (await res.json().catch(() => ({}))) as
    & Partial<RadarVenuesPayload>
    & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Failed to load the Radar map");
  return {
    window: data.window ?? window,
    brand: data.brand ?? brand,
    k_floor: data.k_floor ?? 0,
    venues: data.venues ?? [],
  };
}

export interface RadarMapData {
  /** Every venue with a servable all-brands aggregate in view. */
  venues: RadarVenue[];
  /** venue id → the inputs {@link VenueActivity} wants, brand rows folded in. */
  activity: Map<string, VenueActivity>;
  /** The floor the server applied, for the honest empty state. */
  kFloor: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

/**
 * The map layer: one query for the venue totals, plus one per weighted brand.
 *
 * The brand queries are what make the map personal. `/venues` answers for ONE
 * brand key at a time, so weighting toward a reseller's own top brands means
 * asking for those brands' rows too and folding them into the score — rather
 * than adding a multi-brand parameter whose response would be a per-venue brand
 * profile nobody asked for. Each is its own cache entry, so switching window or
 * panning re-uses whatever has not changed.
 *
 * A brand row that did not clear the floor is simply missing from its response,
 * which lands as a zero in `brandScans`. That is the correct reading: not "no
 * Nike here", but "nothing we can say about Nike here".
 */
export function useRadarMap(opts: {
  bbox: BoundingBox | null;
  window: RadarWindowKey;
  weights: readonly BrandWeight[];
  enabled: boolean;
}): RadarMapData {
  const { bbox, window: windowKey, weights, enabled } = opts;
  const param = bbox ? bboxParam(bbox) : null;
  const brands = useMemo(() => weights.map((w) => w.brand), [weights]);

  return useQueries({
    queries: [ALL_BRANDS, ...brands].map((brand) => ({
      queryKey: ["radar_venues", param, windowKey, brand],
      queryFn: () => fetchVenues(param!, windowKey, brand === ALL_BRANDS ? null : brand),
      enabled: enabled && param != null,
      staleTime: 5 * 60 * 1000,
    })),
    // `combine` rather than a useMemo over the results array: TanStack caches
    // the folded value, so the map does not get a brand-new `activity` Map on
    // every render of the page around it.
    combine: (results): RadarMapData => {
      const [total, ...brandResults] = results;
      const venues = total?.data?.venues ?? [];

      const activity = new Map<string, VenueActivity>();
      for (const venue of venues) {
        activity.set(venue.id, {
          allScans: venue.network.scan_count,
          brandScans: {},
          daysSince: venue.network.days_since_activity,
        });
      }
      brandResults.forEach((result, i) => {
        const brand = brands[i];
        if (!brand) return;
        for (const venue of result?.data?.venues ?? []) {
          const entry = activity.get(venue.id);
          if (!entry) continue;
          entry.brandScans = { ...entry.brandScans, [brand]: venue.network.scan_count };
        }
      });

      const failed = results.find((r) => r.isError);
      return {
        venues,
        activity,
        kFloor: total?.data?.k_floor ?? 0,
        // Only the totals query blocks the map — a slow brand query refines the
        // colouring, it does not decide whether there is a map to colour.
        isLoading: enabled && param != null && (total?.isLoading ?? false),
        isError: Boolean(total?.isError),
        error: (failed?.error as Error | undefined) ?? null,
      };
    },
  });
}

export function useRadarVenueDetail(
  venueId: string | null,
  windowKey: RadarWindowKey,
  enabled: boolean,
) {
  return useQuery<RadarVenueDetail>({
    queryKey: ["radar_venue_detail", venueId, windowKey],
    enabled: enabled && Boolean(venueId),
    queryFn: async () => {
      const res = await edgeFetch(
        `/api/flipdesk/radar/venues/${encodeURIComponent(venueId!)}?window=${windowKey}`,
      );
      const data = (await res.json().catch(() => ({}))) as
        & Partial<RadarVenueDetail>
        & { error?: string };
      // A 404 here is the floor doing its job OR an id that never existed — the
      // endpoint returns the identical body for both on purpose, so the message
      // must not guess which.
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? "Not enough data here yet"
            : data.error ?? "Failed to load this store",
        );
      }
      return data as RadarVenueDetail;
    },
  });
}
