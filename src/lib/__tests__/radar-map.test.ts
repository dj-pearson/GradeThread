import { describe, expect, it } from "vitest";
import {
  bboxParam,
  brandWeights,
  BRAND_BOOST,
  busiestDayLabel,
  clampBoundingBox,
  dayBars,
  fitPoints,
  freshnessFactor,
  freshnessLabel,
  fromScreen,
  hotnessLevel,
  hotnessScore,
  MAX_BBOX_DEGREES,
  MAX_WEIGHTED_BRANDS,
  MAX_ZOOM,
  MIN_ZOOM,
  markerRadius,
  panViewport,
  projectMercator,
  quantizeBoundingBox,
  toScreen,
  unprojectMercator,
  viewportBounds,
  weightedActivity,
  zoomViewport,
  type MapViewport,
} from "@/lib/radar-map";

// US-1865: the Radar map's arithmetic, tested without a DOM.
//
// The properties worth pinning here are the ones a rendered map would hide:
// that a viewport can never ask the endpoint for a box it will refuse, that
// hotness is relative to what is in view, and that an empty week reads as "no
// pattern" rather than as seven quiet days.

const SIZE = { width: 900, height: 520 };
const NYC: MapViewport = { centerLat: 40.7128, centerLng: -74.006, zoom: 12 };

describe("projection", () => {
  it("round-trips a coordinate through Web Mercator", () => {
    const point = { lat: 40.7128, lng: -74.006 };
    const back = unprojectMercator(projectMercator(point));
    expect(back.lat).toBeCloseTo(point.lat, 6);
    expect(back.lng).toBeCloseTo(point.lng, 6);
  });

  it("puts the viewport centre in the middle of the canvas", () => {
    const screen = toScreen(
      { lat: NYC.centerLat, lng: NYC.centerLng },
      NYC,
      SIZE,
    );
    expect(screen.x).toBeCloseTo(SIZE.width / 2, 6);
    expect(screen.y).toBeCloseTo(SIZE.height / 2, 6);
  });

  it("round-trips a pixel back to the coordinate under it", () => {
    const pixel = { x: 210, y: 380 };
    const screen = toScreen(fromScreen(pixel, NYC, SIZE), NYC, SIZE);
    expect(screen.x).toBeCloseTo(pixel.x, 4);
    expect(screen.y).toBeCloseTo(pixel.y, 4);
  });

  it("north is up and east is right", () => {
    const north = toScreen({ lat: 41, lng: -74.006 }, NYC, SIZE);
    const east = toScreen({ lat: 40.7128, lng: -73 }, NYC, SIZE);
    expect(north.y).toBeLessThan(SIZE.height / 2);
    expect(east.x).toBeGreaterThan(SIZE.width / 2);
  });
});

describe("viewport", () => {
  it("panning right moves the centre west", () => {
    const panned = panViewport(NYC, 100, 0, SIZE);
    expect(panned.centerLng).toBeLessThan(NYC.centerLng);
    expect(panned.centerLat).toBeCloseTo(NYC.centerLat, 6);
  });

  it("clamps zoom to the range the endpoint and the data support", () => {
    expect(zoomViewport(NYC, 99).zoom).toBe(MAX_ZOOM);
    expect(zoomViewport(NYC, -99).zoom).toBe(MIN_ZOOM);
  });

  it("never asks for a bbox the endpoint would refuse", () => {
    // The route 400s on anything over MAX_BBOX_DEGREES a side, and the minimum
    // zoom alone is not a guarantee — a very wide window at MIN_ZOOM would sail
    // past it. The bounds themselves have to be clamped.
    const wide: MapViewport = { centerLat: 40, centerLng: -74, zoom: MIN_ZOOM };
    const bounds = viewportBounds(wide, { width: 4000, height: 3000 });
    expect(bounds.maxLat - bounds.minLat).toBeLessThanOrEqual(MAX_BBOX_DEGREES);
    expect(bounds.maxLng - bounds.minLng).toBeLessThanOrEqual(MAX_BBOX_DEGREES);
  });

  it("shrinks an oversized box around its own centre", () => {
    const clamped = clampBoundingBox(
      { minLat: 0, minLng: 0, maxLat: 20, maxLng: 20 },
      MAX_BBOX_DEGREES,
    );
    expect(clamped.minLat).toBeCloseTo(10 - MAX_BBOX_DEGREES / 2, 6);
    expect(clamped.maxLat).toBeCloseTo(10 + MAX_BBOX_DEGREES / 2, 6);
  });

  it("quantizes the bbox so a small drag re-uses the cached answer", () => {
    const a = quantizeBoundingBox({
      minLat: 40.7001,
      minLng: -74.0009,
      maxLat: 40.8001,
      maxLng: -73.9009,
    });
    const b = quantizeBoundingBox({
      minLat: 40.7008,
      minLng: -74.0002,
      maxLat: 40.8008,
      maxLng: -73.9002,
    });
    expect(bboxParam(a)).toBe(bboxParam(b));
  });

  it("emits the ordered four-number param the route parses", () => {
    expect(bboxParam({ minLat: 1.23456, minLng: -2.5, maxLat: 3, maxLng: 4 }))
      .toBe("1.2346,-2.5,3,4");
  });

  it("fits a single point at the default zoom and a spread within bounds", () => {
    const one = fitPoints([{ lat: 40, lng: -74 }], SIZE);
    expect(one?.centerLat).toBeCloseTo(40, 6);

    const many = fitPoints(
      [
        { lat: 40, lng: -74 },
        { lat: 40.4, lng: -73.6 },
      ],
      SIZE,
    );
    expect(many!.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(many!.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    expect(many!.centerLat).toBeCloseTo(40.2, 6);
  });

  it("has nothing to fit when the reseller has no placed stores", () => {
    expect(fitPoints([], SIZE)).toBeNull();
  });
});

describe("brand weighting", () => {
  const stores = [
    {
      top_brands: [
        { brand: "Nike", items: 6, realized_profit_cents: 1000 },
        { brand: "Carhartt", items: 2, realized_profit_cents: 9000 },
      ],
    },
    {
      top_brands: [
        { brand: "nike", items: 3, realized_profit_cents: 500 },
        { brand: "Levi's", items: 1, realized_profit_cents: 100 },
        { brand: "Patagonia", items: 1, realized_profit_cents: 50 },
      ],
    },
  ];

  it("ranks by how often a brand turns up, not by one outsized flip", () => {
    const weights = brandWeights(stores);
    expect(weights[0]?.brand).toBe("nike");
    // Carhartt made 9x the money on 2 items; frequency still wins, because the
    // question is "is a store full of this worth the drive".
    expect(weights[1]?.brand).toBe("carhartt");
  });

  it("folds the same brand across stores and cases into one weight", () => {
    const weights = brandWeights(stores);
    expect(weights.filter((w) => w.brand === "nike")).toHaveLength(1);
  });

  it("normalizes to a total of one and caps the list", () => {
    const weights = brandWeights(stores);
    expect(weights.length).toBeLessThanOrEqual(MAX_WEIGHTED_BRANDS);
    const total = weights.reduce((sum, w) => sum + w.weight, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("has no weights for a reseller with no history — the cold-start case", () => {
    expect(brandWeights([])).toEqual([]);
    expect(brandWeights([{ top_brands: [] }])).toEqual([]);
  });
});

describe("hotness", () => {
  const fresh = { allScans: 10, brandScans: {}, daysSince: 1 };

  it("weights a matched brand above an unmatched scan without hiding either", () => {
    const weights = [{ brand: "nike", weight: 1 }];
    const matched = weightedActivity(
      { allScans: 10, brandScans: { nike: 10 }, daysSince: 1 },
      weights,
    );
    const unmatched = weightedActivity(fresh, weights);
    expect(matched).toBeGreaterThan(unmatched);
    expect(matched).toBeCloseTo(10 + 10 * BRAND_BOOST, 6);
    // The unmatched venue still scores — weighting, not filtering.
    expect(unmatched).toBeGreaterThan(0);
  });

  it("decays with staleness and treats an unknown last scan as old", () => {
    expect(freshnessFactor(0)).toBe(1);
    expect(freshnessFactor(5)).toBeLessThan(freshnessFactor(2));
    expect(freshnessFactor(60)).toBeLessThan(freshnessFactor(10));
    expect(freshnessFactor(null)).toBe(freshnessFactor(60));
  });

  it("scores relative to the hottest venue in view", () => {
    const peak = weightedActivity({ allScans: 40, brandScans: {}, daysSince: 1 }, []);
    expect(hotnessScore({ allScans: 40, brandScans: {}, daysSince: 1 }, [], peak)).toBe(1);
    expect(hotnessScore(fresh, [], peak)).toBeCloseTo(0.25, 6);
    // An empty view has no peak to be relative to, and must not divide by zero.
    expect(hotnessScore(fresh, [], 0)).toBe(0);
  });

  it("bins a score into four flat levels and a redundant radius", () => {
    expect(hotnessLevel(0.9)).toBe("peak");
    expect(hotnessLevel(0.5)).toBe("hot");
    expect(hotnessLevel(0.3)).toBe("warm");
    expect(hotnessLevel(0)).toBe("quiet");
    expect(markerRadius(1)).toBeGreaterThan(markerRadius(0));
  });

  it("names freshness in plain words", () => {
    expect(freshnessLabel(0)).toBe("Scanned today");
    expect(freshnessLabel(1)).toBe("Scanned yesterday");
    expect(freshnessLabel(null)).toBe("No recent activity");
    expect(freshnessLabel(90)).toMatch(/over a month/);
  });
});

describe("weekly pattern", () => {
  it("scales bars against the busiest day and flags it", () => {
    const bars = dayBars([0, 2, 4, 0, 0, 8, 1])!;
    expect(bars).toHaveLength(7);
    expect(bars[5]?.busiest).toBe(true);
    expect(bars[5]?.share).toBe(1);
    expect(bars[2]?.share).toBeCloseTo(0.5, 6);
    expect(busiestDayLabel([0, 2, 4, 0, 0, 8, 1])).toBe("Fri");
  });

  it("reports no pattern rather than seven dead days", () => {
    // An all-zero week is a row the job has not rewritten since the column
    // existed — not a finding about the store. Seven empty bars would read as
    // one, which is the whole reason this returns null.
    expect(dayBars([0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(dayBars(undefined)).toBeNull();
    expect(busiestDayLabel([0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it("refuses to name a busiest day when every day is level", () => {
    expect(busiestDayLabel([3, 3, 3, 3, 3, 3, 3])).toBeNull();
    expect(busiestDayLabel([3, 3, 3, 1, 1, 1, 1])).toBeNull();
    expect(busiestDayLabel([5, 5, 1, 1, 1, 1, 1])).toBe("Sun and Mon");
  });

  it("tolerates a short or ragged week from the wire", () => {
    const bars = dayBars([4, 1])!;
    expect(bars).toHaveLength(7);
    expect(bars[6]?.count).toBe(0);
  });
});
