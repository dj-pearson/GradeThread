import { describe, expect, it } from "vitest";
import {
  appleMapsRouteUrl,
  AVERAGE_SPEED_KMH,
  brandShare,
  dayFactor,
  formatCents,
  formatMinutes,
  googleMapsRouteUrl,
  haversineKm,
  legMinutes,
  MAX_ROUTE_STOPS,
  measuredItemsPerVisit,
  networkFactor,
  personalValuePerVisit,
  personalWeight,
  planCircuit,
  portfolioValuePerVisit,
  prefersAppleMaps,
  scoreCandidate,
  stopReasons,
  type RouteCandidate,
  type RouteNetworkFacts,
  type RoutePersonalFacts,
} from "@/lib/radar-route";
import type { BrandWeight } from "@/lib/radar-map";

// US-1867: the circuit planner.
//
// Everything here is a function of its arguments, so the ordering rule, the
// budget arithmetic and the rationale strings are asserted directly rather than
// through a rendered plan. Two properties get the most attention, because they
// are the ones a later change would break silently:
//
//   • TRAVEL IS INSIDE THE COMPARISON. A slightly better store far away must
//     lose to a slightly worse store next door, or "expected $/hour" is just
//     "expected $" with a clock drawn on it.
//   • THE SPARSE CASE IS A FIRST-CLASS ANSWER. With no network data the plan is
//     still a plan, and it has to SAY it is personal-only — that sentence is the
//     acceptance criterion, not a nicety.

function personal(over: Partial<RoutePersonalFacts> = {}): RoutePersonalFacts {
  return {
    visits: 0,
    itemsSourced: 0,
    spendCents: 0,
    realizedProfitCents: 0,
    expectedProfitCents: 0,
    roiPct: null,
    ...over,
  };
}

function network(over: Partial<RouteNetworkFacts> = {}): RouteNetworkFacts {
  return {
    scanCount: 20,
    contributorCount: 4,
    buyRate: 0.5,
    daysSince: 1,
    activityByDay: [3, 2, 2, 3, 3, 3, 4],
    brandScans: {},
    ...over,
  };
}

function candidate(over: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    id: "a",
    name: "Store A",
    lat: 40,
    lng: -75,
    personal: null,
    network: null,
    ...over,
  };
}

const WINDOW = "in the last 30 days";
const START = { lat: 40, lng: -75 };

describe("geometry", () => {
  it("measures a known distance", () => {
    // One degree of latitude is ~111 km anywhere on the globe.
    expect(haversineKm({ lat: 40, lng: -75 }, { lat: 41, lng: -75 })).toBeCloseTo(
      111.19,
      1,
    );
  });

  it("charges driving time with a detour factor, never less than the parking", () => {
    const km = haversineKm(START, { lat: 40.2, lng: -75 });
    const straight = (km / AVERAGE_SPEED_KMH) * 60;
    const charged = legMinutes(START, { lat: 40.2, lng: -75 });
    expect(charged).toBeGreaterThan(straight);
    // Same building: still costs you the walk from the car.
    expect(legMinutes(START, { lat: 40.0001, lng: -75.0001 })).toBe(2);
  });
});

describe("personal value per visit", () => {
  it("divides total profit by recorded visits", () => {
    const value = personalValuePerVisit(
      personal({ visits: 4, itemsSourced: 12, realizedProfitCents: 10_000, expectedProfitCents: 3600 }),
      null,
    );
    expect(value).toEqual({ cents: 3400, basis: "visits", evidence: 4 });
  });

  it("bridges from items when no visit was ever recorded", () => {
    // 10 items, $200 profit ⇒ $20/item; their own books say 5 items a trip.
    const value = personalValuePerVisit(
      personal({ itemsSourced: 10, realizedProfitCents: 20_000 }),
      5,
    );
    expect(value).toEqual({ cents: 10_000, basis: "items", evidence: 10 });
  });

  it("prices nothing when there is nothing to price", () => {
    expect(personalValuePerVisit(null, 4)).toBeNull();
    expect(personalValuePerVisit(personal(), 4)).toBeNull();
    // Items but no measured items-per-visit: a bridge with no far bank.
    expect(personalValuePerVisit(personal({ itemsSourced: 3 }), null)).toBeNull();
  });

  it("measures items per visit only from stores that have both", () => {
    const stores = [
      candidate({ id: "a", personal: personal({ visits: 2, itemsSourced: 10 }) }),
      candidate({ id: "b", personal: personal({ visits: 0, itemsSourced: 99 }) }),
      candidate({ id: "c", personal: personal({ visits: 8, itemsSourced: 0 }) }),
    ];
    expect(measuredItemsPerVisit(stores)).toBe(5);
    expect(measuredItemsPerVisit([candidate()])).toBeNull();
  });

  it("averages the portfolio over the stores it can price", () => {
    const stores = [
      candidate({ id: "a", personal: personal({ visits: 1, realizedProfitCents: 4000 }) }),
      candidate({ id: "b", personal: personal({ visits: 1, realizedProfitCents: 2000 }) }),
      candidate({ id: "c" }),
    ];
    expect(portfolioValuePerVisit(stores, null)).toBe(3000);
    expect(portfolioValuePerVisit([candidate()], null)).toBe(0);
  });
});

describe("the network signal", () => {
  it("reads a level week as a normal day", () => {
    expect(dayFactor([2, 2, 2, 2, 2, 2, 2], 3)).toBe(1);
    expect(dayFactor(undefined, 3)).toBe(1);
    expect(dayFactor([0, 0, 0, 0, 0, 0, 0], 3)).toBe(1);
  });

  it("clamps a one-day sample instead of letting it own the route", () => {
    // All seven scans on Saturday would be a factor of 7 unclamped.
    expect(dayFactor([0, 0, 0, 0, 0, 0, 7], 6)).toBe(1.75);
    expect(dayFactor([0, 0, 0, 0, 0, 0, 7], 1)).toBe(0.5);
  });

  it("weights brand density by what the reseller actually flips", () => {
    const weights: BrandWeight[] = [
      { brand: "nike", weight: 0.6 },
      { brand: "lululemon", weight: 0.4 },
    ];
    const net = network({ scanCount: 10, brandScans: { nike: 5, lululemon: 5 } });
    expect(brandShare(net, weights)).toBeCloseTo(0.5, 5);
    expect(brandShare(network({ scanCount: 0 }), weights)).toBe(0);
    expect(brandShare(net, [])).toBe(0);
  });

  it("multiplies day, brand, buy-rate and freshness into one bounded factor", () => {
    const weights: BrandWeight[] = [{ brand: "nike", weight: 1 }];
    const hot = networkFactor(
      network({
        activityByDay: [1, 1, 1, 1, 1, 1, 8],
        brandScans: { nike: 20 },
        buyRate: 1,
        daysSince: 0,
      }),
      6,
      weights,
    );
    const cold = networkFactor(
      network({ activityByDay: [8, 1, 1, 1, 1, 1, 1], brandScans: {}, buyRate: 0, daysSince: 90 }),
      6,
      weights,
    );
    expect(hot).toBeGreaterThan(cold);
    expect(hot).toBeLessThanOrEqual(3);
    expect(cold).toBeGreaterThanOrEqual(0.2);
  });

  it("shrinks toward the network when the personal sample is thin", () => {
    expect(personalWeight(0)).toBe(0);
    expect(personalWeight(1)).toBeCloseTo(0.25, 5);
    expect(personalWeight(9)).toBeCloseTo(0.75, 5);
    // Never certain: the network is how you learn a good store went quiet.
    expect(personalWeight(1000)).toBeLessThan(1);
  });
});

describe("scoring", () => {
  const ctx = {
    day: 6,
    weights: [] as BrandWeight[],
    itemsPerVisit: null,
    baselineCents: 3000,
    moneyBasis: true,
  };

  it("prices an unknown store at the portfolio average times the network factor", () => {
    const score = scoreCandidate(candidate({ network: network() }), ctx);
    expect(score.personal).toBeNull();
    expect(score.value).toBeCloseTo(3000 * (score.networkFactor ?? 0), 5);
  });

  it("lets a well-evidenced personal number dominate", () => {
    const score = scoreCandidate(
      candidate({
        personal: personal({ visits: 30, realizedProfitCents: 300_000 }),
        network: network({ daysSince: 60, buyRate: 0 }),
      }),
      ctx,
    );
    // $100/visit measured over 30 visits: the stale network cannot talk it down
    // to the portfolio's $30.
    expect(score.value).toBeGreaterThan(8000);
  });

  it("ranks on activity, without money, when nothing has ever sold", () => {
    const noMoney = { ...ctx, baselineCents: 0, moneyBasis: false };
    const busy = scoreCandidate(
      candidate({ network: network({ daysSince: 0, buyRate: 1 }) }),
      noMoney,
    );
    const stale = scoreCandidate(
      candidate({ id: "b", network: network({ daysSince: 90, buyRate: 0 }) }),
      noMoney,
    );
    expect(busy.value).toBeGreaterThan(stale.value);
  });
});

describe("planCircuit", () => {
  const weights: BrandWeight[] = [{ brand: "nike", weight: 1 }];

  function plan(candidates: RouteCandidate[], over: Partial<Parameters<typeof planCircuit>[0]> = {}) {
    return planCircuit({
      start: START,
      day: 6,
      timeBudgetMinutes: 240,
      candidates,
      weights,
      windowLabel: WINDOW,
      ...over,
    });
  }

  it("prefers the near store when the far one is only slightly better", () => {
    const near = candidate({
      id: "near",
      name: "Near",
      lat: 40.02,
      lng: -75,
      personal: personal({ visits: 10, realizedProfitCents: 40_000 }),
    });
    const far = candidate({
      id: "far",
      name: "Far",
      lat: 40.3,
      lng: -75,
      personal: personal({ visits: 10, realizedProfitCents: 44_000 }),
    });
    const result = plan([far, near]);
    expect(result.stops.map((s) => s.id)).toEqual(["near", "far"]);
  });

  it("keeps the whole circuit inside the time budget", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      candidate({
        id: `s${i}`,
        name: `Store ${i}`,
        lat: 40 + i * 0.05,
        lng: -75,
        personal: personal({ visits: 3, realizedProfitCents: 9000 }),
      }));
    const result = plan(many, { timeBudgetMinutes: 120 });
    expect(result.totalMinutes).toBeLessThanOrEqual(120);
    expect(result.stops.length).toBeGreaterThan(0);
    expect(result.skipped).toBe(12 - result.stops.length);
    // Arrival offsets are cumulative and land before the budget runs out.
    let running = 0;
    for (const stop of result.stops) {
      running += stop.travelMinutes;
      expect(stop.arriveAfterMinutes).toBe(running);
      running += stop.dwellMinutes;
    }
    expect(running).toBe(result.totalMinutes);
  });

  it("never plans more stops than a maps link can carry", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      candidate({
        id: `s${i}`,
        name: `Store ${i}`,
        lat: 40 + i * 0.001,
        lng: -75,
        personal: personal({ visits: 2, realizedProfitCents: 6000 }),
      }));
    const result = plan(many, { timeBudgetMinutes: 480 });
    expect(result.stops).toHaveLength(MAX_ROUTE_STOPS);
    expect(result.notes.join(" ")).toContain("Capped at");
  });

  it("falls back to personal-only ranking, and says so", () => {
    const result = plan([
      candidate({
        id: "mine",
        name: "My spot",
        lat: 40.01,
        lng: -75,
        personal: personal({ visits: 5, realizedProfitCents: 25_000 }),
      }),
    ]);
    expect(result.mode).toBe("personal_only");
    expect(result.stops).toHaveLength(1);
    expect(result.notes.join(" ")).toContain("ranked from your own history alone");
  });

  it("is blended as soon as one stop carries network data", () => {
    const result = plan([
      candidate({ id: "n", name: "Networked", lat: 40.01, lng: -75, network: network() }),
      candidate({
        id: "m",
        name: "Mine",
        lat: 40.02,
        lng: -75,
        personal: personal({ visits: 5, realizedProfitCents: 25_000 }),
      }),
    ]);
    expect(result.mode).toBe("blended");
  });

  it("withholds dollars when the reseller has no profit history", () => {
    const result = plan([
      candidate({ id: "n", name: "Networked", lat: 40.01, lng: -75, network: network() }),
    ]);
    expect(result.moneyBasis).toBe(false);
    expect(result.totalValueCents).toBeNull();
    expect(result.stops[0]!.expectedValueCents).toBeNull();
    expect(result.stops[0]!.valuePerHourCents).toBeNull();
    expect(result.notes.join(" ")).toContain("ranked by activity rather than priced");
  });

  it("prices the day when there is a money basis", () => {
    const result = plan([
      candidate({
        id: "m",
        name: "Mine",
        lat: 40.01,
        lng: -75,
        personal: personal({ visits: 4, realizedProfitCents: 20_000 }),
        network: network(),
      }),
    ]);
    expect(result.moneyBasis).toBe(true);
    expect(result.stops[0]!.valuePerHourCents).toBeGreaterThan(0);
    expect(result.totalValueCents).toBe(result.stops[0]!.expectedValueCents);
  });

  it("has an honest empty plan rather than an error", () => {
    const empty = plan([]);
    expect(empty.stops).toEqual([]);
    expect(empty.notes[0]).toContain("No stores to plan from yet");

    const tooTight = plan(
      [candidate({ id: "x", lat: 41, lng: -75, personal: personal({ visits: 1 }) })],
      { timeBudgetMinutes: 20 },
    );
    expect(tooTight.stops).toEqual([]);
    expect(tooTight.notes[0]).toContain("Nothing fits in 20m");
  });

  it("drops duplicate and unplaceable candidates", () => {
    const result = plan([
      candidate({ id: "dup", lat: 40.01, lng: -75, personal: personal({ visits: 1 }) }),
      candidate({ id: "dup", lat: 40.02, lng: -75, personal: personal({ visits: 1 }) }),
      candidate({ id: "nan", lat: Number.NaN, lng: -75 }),
    ]);
    expect(result.stops).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });
});

describe("rationale", () => {
  const weights: BrandWeight[] = [{ brand: "lululemon", weight: 1 }];

  function reasonsFor(c: RouteCandidate, moneyBasis = true) {
    const score = scoreCandidate(c, {
      day: 6,
      weights,
      itemsPerVisit: null,
      baselineCents: moneyBasis ? 3000 : 0,
      moneyBasis,
    });
    return stopReasons(c, score, { day: 6, windowLabel: WINDOW, weights, moneyBasis });
  }

  it("blends a network clause with a personal one, as the story asks", () => {
    const reasons = reasonsFor(
      candidate({
        network: network({
          scanCount: 20,
          brandScans: { lululemon: 12 },
          activityByDay: [1, 1, 1, 1, 1, 1, 9],
        }),
        personal: personal({ visits: 5, realizedProfitCents: 17_000 }),
      }),
    );
    expect(reasons[0]).toBe("strong Lululemon density in the last 30 days");
    expect(reasons).toContain("Saturday is one of its busiest days");
    expect(reasons[reasons.length - 1]).toBe("you average $34 profit per visit here");
    expect(reasons.length).toBeLessThanOrEqual(3);
  });

  it("says a quiet day is quiet", () => {
    const reasons = reasonsFor(
      candidate({ network: network({ activityByDay: [9, 1, 1, 1, 1, 1, 0] }) }),
    );
    expect(reasons).toContain("Saturday is usually quiet here");
  });

  it("falls back to raw volume when nothing else stands out", () => {
    const reasons = reasonsFor(candidate({ network: network({ activityByDay: [] }) }));
    expect(reasons[0]).toBe("20 scans by 4 people in the last 30 days");
    expect(reasons).toContain("you have never sourced here");
  });

  it("does not quote a profit it cannot stand behind", () => {
    const reasons = reasonsFor(
      candidate({ personal: personal({ visits: 3, itemsSourced: 2 }) }),
    );
    expect(reasons.join(" ")).toContain("no profit booked yet");
    expect(reasons.join(" ")).not.toContain("$");
  });

  it("says so when a store is entirely unknown", () => {
    expect(reasonsFor(candidate())[0]).toContain("a cold stop");
  });
});

describe("formatting", () => {
  it("reads money the way a person says it", () => {
    expect(formatCents(3400)).toBe("$34");
    expect(formatCents(999)).toBe("$9.99");
    expect(formatCents(-2500)).toBe("-$25");
    expect(formatCents(123_456)).toBe("$1,235");
  });

  it("reads a duration the way a person says it", () => {
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(205)).toBe("3h 25m");
  });
});

describe("maps hand-off", () => {
  const stops = [
    { lat: 40.1, lng: -75.1 },
    { lat: 40.2, lng: -75.2 },
    { lat: 40.3, lng: -75.3 },
  ];

  it("builds a Google Maps route with the last stop as the destination", () => {
    const url = googleMapsRouteUrl(START, stops)!;
    expect(url).toContain("origin=40.00000%2C-75.00000");
    expect(url).toContain("destination=40.30000%2C-75.30000");
    expect(decodeURIComponent(url)).toContain(
      "waypoints=40.10000,-75.10000|40.20000,-75.20000",
    );
    expect(url).toContain("travelmode=driving");
  });

  it("omits the waypoint list for a single stop", () => {
    expect(googleMapsRouteUrl(START, stops.slice(0, 1))).not.toContain("waypoints");
  });

  it("chains Apple Maps stops with +to: and leaves the separators intact", () => {
    const url = appleMapsRouteUrl(START, stops)!;
    expect(url).toBe(
      "https://maps.apple.com/?saddr=40.00000,-75.00000&daddr=40.10000,-75.10000+to:40.20000,-75.20000+to:40.30000,-75.30000&dirflg=d",
    );
  });

  it("has no route to offer with no stops", () => {
    expect(googleMapsRouteUrl(START, [])).toBeNull();
    expect(appleMapsRouteUrl(START, [])).toBeNull();
  });

  it("picks the platform's own maps app", () => {
    expect(prefersAppleMaps("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe(true);
    expect(prefersAppleMaps("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
    expect(prefersAppleMaps(undefined)).toBe(false);
  });
});
