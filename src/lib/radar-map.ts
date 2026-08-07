// US-1865: the pure half of the Thrift Radar map — projection, viewport math,
// and the hotness score. No React, no fetch, no DOM.
//
// Same split the edge side of Radar uses (radar-privacy / radar-venues /
// radar-aggregates are all pure with an impure partner): everything here is a
// function of its arguments, so the projection, the bbox clamp and the brand
// weighting are unit-tested directly rather than through a rendered map.
//
// ── Why there is no map library here ────────────────────────────────────────
//
// The story asked for "a lightweight map lib consistent with bundle budgets".
// The lightest one is none, and on THIS surface that is also the only correct
// answer, for a reason specific to Radar rather than to bundle size:
//
//   Every tile-based map fetches its background from somebody else's CDN, and
//   the tile URLs a viewport requests ARE the viewport. Panning a Leaflet or
//   MapLibre map over the user's neighbourhood streams their approximate
//   location to a third party on every drag — which is precisely the disclosure
//   rule 4 of vault/20-domain/thrift-radar.md exists to prevent, undone by the
//   page built to display the result. We would have spent a migration keeping a
//   coordinate out of our own database and then leaked a better one to a tile
//   host.
//
// So the map is drawn from data we already have: venues we serve, stores the
// user owns, and a graticule. It is a relative-position map, honest about being
// one (it carries a scale bar and a north-up graticule, and never pretends to
// show streets). Zero bytes added to the bundle, zero external requests, and it
// works identically on the authed dashboard and in a test.

/** Web Mercator tile size, in the conventional 256px units zoom levels assume. */
export const TILE_SIZE = 256;

/**
 * Zoom bounds.
 *
 * The floor is not a UI preference: `GET /api/flipdesk/radar/venues` refuses a
 * bbox larger than 5 degrees a side (a bigger ask is a scrape, not a map), so
 * zooming out past a continent would only ever produce a 400. The ceiling is
 * where a cell-centre centroid stops meaning anything — at street resolution the
 * marker would claim a precision the coordinate does not have.
 */
export const MIN_ZOOM = 6;
export const MAX_ZOOM = 15;
export const DEFAULT_ZOOM = 11;

/** Mirrors MAX_BBOX_DEGREES in services/edge-functions/src/routes/flipdesk-radar.ts. */
export const MAX_BBOX_DEGREES = 5;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface MapViewport {
  centerLat: number;
  centerLng: number;
  zoom: number;
}

export interface MapSize {
  width: number;
  height: number;
}

export interface BoundingBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Mercator's y blows up at the poles; this is the conventional cut-off. */
const MAX_MERCATOR_LAT = 85.05112878;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalized Web Mercator world coordinates, both in 0..1. */
export function projectMercator(point: LatLng): ScreenPoint {
  const lat = clamp(point.lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
  const lng = clamp(point.lng, -180, 180);
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

export function unprojectMercator(point: ScreenPoint): LatLng {
  const x = clamp(point.x, 0, 1);
  const y = clamp(point.y, 0, 1);
  const n = Math.PI * (1 - 2 * y);
  return {
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    lng: x * 360 - 180,
  };
}

/** World width in pixels at a zoom level. */
export function worldSize(zoom: number): number {
  return TILE_SIZE * Math.pow(2, zoom);
}

/** Project a coordinate into pixel space inside a map of the given size. */
export function toScreen(
  point: LatLng,
  viewport: MapViewport,
  size: MapSize,
): ScreenPoint {
  const scale = worldSize(viewport.zoom);
  const world = projectMercator(point);
  const centre = projectMercator({
    lat: viewport.centerLat,
    lng: viewport.centerLng,
  });
  return {
    x: size.width / 2 + (world.x - centre.x) * scale,
    y: size.height / 2 + (world.y - centre.y) * scale,
  };
}

/** The inverse: what coordinate is under this pixel? */
export function fromScreen(
  pixel: ScreenPoint,
  viewport: MapViewport,
  size: MapSize,
): LatLng {
  const scale = worldSize(viewport.zoom);
  const centre = projectMercator({
    lat: viewport.centerLat,
    lng: viewport.centerLng,
  });
  return unprojectMercator({
    x: centre.x + (pixel.x - size.width / 2) / scale,
    y: centre.y + (pixel.y - size.height / 2) / scale,
  });
}

/**
 * Shrink a box around its own centre until neither side exceeds `maxDegrees`.
 *
 * The endpoint's limit is a real 400, so a wide viewport must ask for less than
 * it can show rather than for nothing at all. Venues outside the asked-for slice
 * simply do not come back, which reads as an empty edge of the map — honest, and
 * better than an error toast on every pan.
 */
export function clampBoundingBox(
  bbox: BoundingBox,
  maxDegrees = MAX_BBOX_DEGREES,
): BoundingBox {
  const latSpan = Math.min(bbox.maxLat - bbox.minLat, maxDegrees);
  const lngSpan = Math.min(bbox.maxLng - bbox.minLng, maxDegrees);
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;
  return {
    minLat: clamp(midLat - latSpan / 2, -90, 90),
    maxLat: clamp(midLat + latSpan / 2, -90, 90),
    minLng: clamp(midLng - lngSpan / 2, -180, 180),
    maxLng: clamp(midLng + lngSpan / 2, -180, 180),
  };
}

/** What the visible rectangle covers, already clamped to what the API accepts. */
export function viewportBounds(
  viewport: MapViewport,
  size: MapSize,
): BoundingBox {
  const topLeft = fromScreen({ x: 0, y: 0 }, viewport, size);
  const bottomRight = fromScreen(
    { x: size.width, y: size.height },
    viewport,
    size,
  );
  return clampBoundingBox({
    minLat: Math.min(topLeft.lat, bottomRight.lat),
    maxLat: Math.max(topLeft.lat, bottomRight.lat),
    minLng: Math.min(topLeft.lng, bottomRight.lng),
    maxLng: Math.max(topLeft.lng, bottomRight.lng),
  });
}

/** `minLat,minLng,maxLat,maxLng`, rounded — the query param the endpoint parses. */
export function bboxParam(bbox: BoundingBox): string {
  const r = (n: number) => Number(n.toFixed(4));
  return [r(bbox.minLat), r(bbox.minLng), r(bbox.maxLat), r(bbox.maxLng)].join(
    ",",
  );
}

/**
 * A bbox rounded onto a coarse grid.
 *
 * Every pixel of a drag would otherwise be a distinct TanStack Query key and a
 * distinct request. Snapping the key to a grid means a small pan re-uses the
 * cached answer, and it also stops the request stream from being a fine-grained
 * trace of where the user is looking.
 */
export function quantizeBoundingBox(
  bbox: BoundingBox,
  step = 0.05,
): BoundingBox {
  const down = (n: number) => Math.floor(n / step) * step;
  const up = (n: number) => Math.ceil(n / step) * step;
  return {
    minLat: down(bbox.minLat),
    minLng: down(bbox.minLng),
    maxLat: up(bbox.maxLat),
    maxLng: up(bbox.maxLng),
  };
}

export function panViewport(
  viewport: MapViewport,
  dxPixels: number,
  dyPixels: number,
  size: MapSize,
): MapViewport {
  const centre = fromScreen(
    { x: size.width / 2 - dxPixels, y: size.height / 2 - dyPixels },
    viewport,
    size,
  );
  return { ...viewport, centerLat: centre.lat, centerLng: centre.lng };
}

export function zoomViewport(viewport: MapViewport, delta: number): MapViewport {
  return { ...viewport, zoom: clamp(viewport.zoom + delta, MIN_ZOOM, MAX_ZOOM) };
}

/**
 * A viewport that shows every point, or null when there are none.
 *
 * Used for the cold-start path: a reseller with no network data around them
 * still has their own stores, so the map opens on those rather than on a guess
 * or on nothing.
 */
export function fitPoints(
  points: readonly LatLng[],
  size: MapSize,
  padding = 48,
): MapViewport | null {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  if (points.length === 1) {
    return { centerLat, centerLng, zoom: DEFAULT_ZOOM };
  }

  const min = projectMercator({ lat: Math.max(...lats), lng: Math.min(...lngs) });
  const max = projectMercator({ lat: Math.min(...lats), lng: Math.max(...lngs) });
  const spanX = Math.max(max.x - min.x, 1e-9);
  const spanY = Math.max(max.y - min.y, 1e-9);
  const usableWidth = Math.max(size.width - padding * 2, 1);
  const usableHeight = Math.max(size.height - padding * 2, 1);
  const scale = Math.min(usableWidth / spanX, usableHeight / spanY);
  const zoom = Math.log2(scale / TILE_SIZE);
  return { centerLat, centerLng, zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) };
}

// ── Hotness ─────────────────────────────────────────────────────────────────

/**
 * How much a brand counts toward hotness, for one reseller.
 *
 * Derived from their OWN pipeline history — what they have actually bought and
 * sold — which is why this feature costs no AI spend and needs no new store of
 * preferences. A map that is hot where strangers are busy is a popularity
 * ranking; a map that is hot where the brands YOU flip keep turning up is a
 * sourcing tool.
 */
export interface BrandWeight {
  brand: string;
  /** 0..1, summing to 1 across the list. */
  weight: number;
}

/** How many brands the weighting considers. Each one costs a request. */
export const MAX_WEIGHTED_BRANDS = 3;

interface BrandCountable {
  top_brands: { brand: string; items: number; realized_profit_cents: number }[];
}

/**
 * Fold a reseller's per-store brand history into normalized weights.
 *
 * Ranked by items first and profit second, deliberately: how OFTEN a brand
 * turns up in their pipeline is what predicts whether a store full of it is
 * worth the drive. One outsized flip should not redirect the whole map.
 */
export function brandWeights(
  stores: readonly BrandCountable[],
  limit = MAX_WEIGHTED_BRANDS,
): BrandWeight[] {
  const totals = new Map<string, { items: number; profit: number }>();
  for (const store of stores) {
    for (const entry of store.top_brands ?? []) {
      const key = entry.brand?.trim();
      if (!key) continue;
      const row = totals.get(key.toLowerCase()) ?? { items: 0, profit: 0 };
      row.items += Math.max(0, entry.items ?? 0);
      row.profit += Math.max(0, entry.realized_profit_cents ?? 0);
      totals.set(key.toLowerCase(), row);
    }
  }

  const ranked = [...totals.entries()]
    .filter(([, v]) => v.items > 0 || v.profit > 0)
    .sort((a, b) =>
      b[1].items - a[1].items ||
      b[1].profit - a[1].profit ||
      a[0].localeCompare(b[0])
    )
    .slice(0, Math.max(0, limit));

  const total = ranked.reduce((sum, [, v]) => sum + Math.max(v.items, 1), 0);
  if (total === 0) return [];
  return ranked.map(([brand, v]) => ({
    brand,
    weight: Math.max(v.items, 1) / total,
  }));
}

/**
 * How much a brand-matched scan is worth relative to an unmatched one.
 *
 * Weighting, not filtering. A store nobody has scanned your brands at can still
 * be the busiest place in town, and hiding it would make the map lie about where
 * the supply is.
 */
export const BRAND_BOOST = 2;

/**
 * Query-key sentinel for the venue TOTAL.
 *
 * Deliberately not the server's `*` — that is the stored `brand_key`, and a
 * brand literally typed "*" is folded away before it can collide with it. This
 * one only ever names a cache entry, so it uses a shape no brand can be.
 */
export const ALL_BRANDS = "__all__";

export interface VenueActivity {
  /** scan_count from the all-brands (`*`) aggregate. */
  allScans: number;
  /** scan_count per weighted brand key, when that brand's row cleared the floor. */
  brandScans: Readonly<Record<string, number>>;
  /** From the all-brands aggregate; null when the row carries no timestamp. */
  daysSince: number | null;
}

/**
 * Freshness decay.
 *
 * Stepped rather than continuous, because the underlying number is a whole day
 * and a smooth curve would imply a resolution the data does not have. A venue
 * whose last scan is unknown is treated as the oldest bucket rather than as
 * fresh — an unknown is not a recommendation.
 */
export function freshnessFactor(daysSince: number | null): number {
  if (daysSince == null) return 0.3;
  if (daysSince <= 3) return 1;
  if (daysSince <= 7) return 0.75;
  if (daysSince <= 21) return 0.5;
  return 0.3;
}

export function freshnessLabel(daysSince: number | null): string {
  if (daysSince == null) return "No recent activity";
  if (daysSince === 0) return "Scanned today";
  if (daysSince === 1) return "Scanned yesterday";
  if (daysSince <= 7) return `Scanned ${daysSince} days ago`;
  if (daysSince <= 14) return "Scanned last week";
  if (daysSince <= 31) return "Scanned this month";
  return "Scanned over a month ago";
}

/** Unnormalized weight of one venue's activity for this reseller. */
export function weightedActivity(
  activity: VenueActivity,
  weights: readonly BrandWeight[],
): number {
  let score = Math.max(0, activity.allScans);
  for (const { brand, weight } of weights) {
    const scans = activity.brandScans[brand] ?? 0;
    score += Math.max(0, scans) * weight * BRAND_BOOST;
  }
  return score * freshnessFactor(activity.daysSince);
}

/**
 * 0..1 hotness, relative to the hottest venue currently in view.
 *
 * Relative on purpose: "hot" means "hotter than the rest of what you can see",
 * which is the comparison a reseller planning a route actually makes. An
 * absolute scale would paint a whole quiet region cold and tell them nothing
 * about which of its stores to try.
 */
export function hotnessScore(
  activity: VenueActivity,
  weights: readonly BrandWeight[],
  peak: number,
): number {
  if (peak <= 0) return 0;
  return clamp(weightedActivity(activity, weights) / peak, 0, 1);
}

export const HOTNESS_LEVELS = ["quiet", "warm", "hot", "peak"] as const;
export type HotnessLevel = (typeof HOTNESS_LEVELS)[number];

export function hotnessLevel(score: number): HotnessLevel {
  if (score >= 0.75) return "peak";
  if (score >= 0.45) return "hot";
  if (score >= 0.2) return "warm";
  return "quiet";
}

export const HOTNESS_LABELS: Record<HotnessLevel, string> = {
  quiet: "Quiet",
  warm: "Some activity",
  hot: "Busy",
  peak: "Busiest near you",
};

/**
 * Marker fill per level.
 *
 * A four-step sequential ramp, not a gradient: each level is one flat colour, so
 * a marker's meaning survives a screenshot, a colour-blind viewer reading the
 * radius instead, and the legend that names all four.
 */
export const HOTNESS_FILL: Record<HotnessLevel, string> = {
  quiet: "fill-slate-400",
  warm: "fill-amber-400",
  hot: "fill-orange-500",
  peak: "fill-brand-red",
};

/** Marker radius in pixels — the redundant encoding beside colour. */
export function markerRadius(score: number): number {
  return 6 + Math.round(clamp(score, 0, 1) * 8);
}

// ── Day-of-week ─────────────────────────────────────────────────────────────

/** Index 0 = Sunday, matching the served `activity_by_day` array. */
export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface DayBar {
  label: string;
  count: number;
  /** 0..1 against the busiest day, for the bar height. */
  share: number;
  busiest: boolean;
}

/**
 * Turn the served week into bars, or null when there is no pattern to show.
 *
 * An all-zero week is not "a store that is dead every day" — it is a row the
 * aggregation job has not rewritten since the column existed. Returning null
 * lets the panel say so instead of drawing seven empty bars that look like a
 * finding.
 */
export function dayBars(counts: readonly number[] | undefined): DayBar[] | null {
  if (!counts || counts.length === 0) return null;
  const week = DAY_LABELS.map((label, i) => ({
    label,
    count: Math.max(0, counts[i] ?? 0),
  }));
  const peak = Math.max(...week.map((d) => d.count));
  if (peak <= 0) return null;
  return week.map(({ label, count }) => ({
    label,
    count,
    share: count / peak,
    busiest: count === peak,
  }));
}

/** One-line summary of the weekly pattern, for the panel heading. */
export function busiestDayLabel(counts: readonly number[] | undefined): string | null {
  const bars = dayBars(counts);
  if (!bars) return null;
  const busiest = bars.filter((b) => b.busiest);
  // Every day equal is not a pattern; saying "busiest: Sunday" would invent one.
  if (busiest.length >= DAY_LABELS.length) return null;
  if (busiest.length > 2) return null;
  return busiest.map((b) => b.label).join(" and ");
}
