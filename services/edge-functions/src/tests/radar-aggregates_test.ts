// US-1863: Thrift Radar aggregation — the math, the k-anonymity floor, and the
// retention rollup.
//
// Everything under test is in the PURE lib/radar-aggregates.ts, which imports
// nothing that touches lib/supabase.ts, so this file needs no env dance and can
// be run on its own.
//
// The case that matters most is "a below-floor venue returns nothing" — and it
// is asserted three ways, because the interesting failure is not "the floor is
// off by one", it is "the floor was applied but something still came out": the
// group produces no aggregate row, the serving DTO is null, and the venue is
// absent from the servable set rather than present-and-empty.

import { assert, assertEquals } from "@std/assert";
import {
  aggregateScanEvents,
  ALL_BRANDS_KEY,
  BAND_MIDPOINT,
  brandKey,
  clampKFloor,
  clampRetentionDays,
  DAYS_IN_WEEK,
  DEFAULT_K_ANONYMITY_FLOOR,
  historyPlaceKey,
  MAX_RADAR_WINDOW_DAYS,
  mergeHistoryRow,
  MIN_K_ANONYMITY_FLOOR,
  monthStart,
  normalizeDowCounts,
  offsetMinutesForLongitude,
  type RadarAggregateRow,
  type RadarScanEvent,
  retentionCutoff,
  rollupExpiredEvents,
  servableAggregates,
  toVenueNetworkDto,
} from "../lib/radar-aggregates.ts";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;
const VENUE_A = "11111111-1111-4111-8111-111111111111";
const VENUE_B = "22222222-2222-4222-8222-222222222222";

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

function event(over: Partial<RadarScanEvent> = {}): RadarScanEvent {
  return {
    id: crypto.randomUUID(),
    contributor_key: "k1",
    venue_id: VENUE_A,
    geohash: "u33dc0",
    brand: "Nike",
    grade_band: "mid",
    verdict: "buy",
    scanned_at: daysAgo(1),
    ...over,
  };
}

function find(
  rows: readonly RadarAggregateRow[],
  venue: string,
  windowKey: string,
  brand: string,
): RadarAggregateRow | undefined {
  return rows.find(
    (r) => r.venue_id === venue && r.window_key === windowKey && r.brand_key === brand,
  );
}

// ── Aggregation math ────────────────────────────────────────────────────────

Deno.test("aggregation counts scans, distinct contributors, bands and buy rate", () => {
  const events: RadarScanEvent[] = [
    event({ contributor_key: "a", grade_band: "high", verdict: "buy" }),
    event({ contributor_key: "a", grade_band: "low", verdict: "skip" }),
    event({ contributor_key: "b", grade_band: "mid", verdict: "buy" }),
    // 'unknown' means the scan produced no comps. It counts as a scan and is
    // excluded from the buy-rate denominator rather than counted as a pass.
    event({ contributor_key: "c", grade_band: "ungraded", verdict: "unknown" }),
  ];

  const rows = aggregateScanEvents(events, { now: NOW });
  const total = find(rows, VENUE_A, "7d", ALL_BRANDS_KEY);
  assert(total, "expected an all-brands row for the 7d window");

  assertEquals(total.scan_count, 4);
  assertEquals(total.contributor_count, 3, "a scanned twice and counts once");
  assertEquals(total.high_count, 1);
  assertEquals(total.mid_count, 1);
  assertEquals(total.low_count, 1);
  assertEquals(total.ungraded_count, 1);
  assertEquals(total.verdict_count, 3);
  assertEquals(total.buy_count, 2);
  assertEquals(total.buy_rate, 0.667);
  // Band midpoints, ungraded excluded: (9 + 7 + 5) / 3.
  assertEquals(
    total.avg_grade,
    (BAND_MIDPOINT.high + BAND_MIDPOINT.mid + BAND_MIDPOINT.low) / 3,
  );
});

Deno.test("a venue total is computed directly, never by summing its brand rows", () => {
  // One contributor, two brands. Summing brand rows would report 2 contributors
  // at the venue — which would push a single person's afternoon over a floor of 2.
  const events: RadarScanEvent[] = [
    event({ contributor_key: "solo", brand: "Nike" }),
    event({ contributor_key: "solo", brand: "Patagonia" }),
  ];
  const rows = aggregateScanEvents(events, { now: NOW });
  const total = find(rows, VENUE_A, "7d", ALL_BRANDS_KEY);
  assert(total);
  assertEquals(total.contributor_count, 1);
  assertEquals(find(rows, VENUE_A, "7d", "nike")?.contributor_count, 1);
  assertEquals(find(rows, VENUE_A, "7d", "patagonia")?.contributor_count, 1);
});

Deno.test("windows are independent and freshness is the latest scan inside one", () => {
  const events: RadarScanEvent[] = [
    event({ contributor_key: "a", scanned_at: daysAgo(2) }),
    event({ contributor_key: "b", scanned_at: daysAgo(2) }),
    event({ contributor_key: "a", scanned_at: daysAgo(45) }),
    event({ contributor_key: "b", scanned_at: daysAgo(45) }),
  ];
  const rows = aggregateScanEvents(events, { now: NOW });

  assertEquals(find(rows, VENUE_A, "7d", ALL_BRANDS_KEY)?.scan_count, 2);
  assertEquals(find(rows, VENUE_A, "30d", ALL_BRANDS_KEY)?.scan_count, 2);
  assertEquals(find(rows, VENUE_A, "90d", ALL_BRANDS_KEY)?.scan_count, 4);
  assertEquals(
    find(rows, VENUE_A, "90d", ALL_BRANDS_KEY)?.last_activity_at,
    daysAgo(2),
  );
});

Deno.test("events with no resolved venue produce no aggregate", () => {
  const rows = aggregateScanEvents(
    [
      event({ contributor_key: "a", venue_id: null }),
      event({ contributor_key: "b", venue_id: null }),
      event({ contributor_key: "c", venue_id: null }),
    ],
    { now: NOW },
  );
  assertEquals(rows, []);
});

Deno.test("a brand that normalizes to nothing gets no brand row but still counts", () => {
  const rows = aggregateScanEvents(
    [
      event({ contributor_key: "a", brand: null }),
      event({ contributor_key: "b", brand: "   " }),
      // The all-brands sentinel is not a brand anyone can claim.
      event({ contributor_key: "c", brand: ALL_BRANDS_KEY }),
    ],
    { now: NOW },
  );
  const brandRows = rows.filter((r) => r.brand_key !== ALL_BRANDS_KEY);
  assertEquals(brandRows, []);
  assertEquals(find(rows, VENUE_A, "7d", ALL_BRANDS_KEY)?.scan_count, 3);
  assertEquals(brandKey(ALL_BRANDS_KEY), null);
  assertEquals(brandKey("  Nike  "), "nike");
});

// ── The k-anonymity floor ───────────────────────────────────────────────────

Deno.test("a below-floor venue is served NOTHING — no row, no DTO, no entry", () => {
  // Venue A: three distinct contributors — clears the default floor of 3.
  // Venue B: two scans by ONE person — does not.
  const events: RadarScanEvent[] = [
    event({ contributor_key: "a" }),
    event({ contributor_key: "b" }),
    event({ contributor_key: "c" }),
    event({ contributor_key: "solo", venue_id: VENUE_B }),
    event({ contributor_key: "solo", venue_id: VENUE_B, scanned_at: daysAgo(2) }),
  ];

  const computed = aggregateScanEvents(events, { now: NOW });
  // The candidate row exists before the floor — that is what makes the filter
  // the load-bearing step rather than an accident of the data.
  assert(find(computed, VENUE_B, "7d", ALL_BRANDS_KEY));

  const servable = servableAggregates(computed, DEFAULT_K_ANONYMITY_FLOOR);

  // 1. No row at all for the below-floor venue.
  assertEquals(servable.filter((r) => r.venue_id === VENUE_B), []);
  // 2. And nothing "suppressed"-shaped either: the venue is simply absent.
  assert(!servable.some((r) => r.venue_id === VENUE_B));
  // 3. The above-floor venue is unaffected.
  assertEquals(find(servable, VENUE_A, "7d", ALL_BRANDS_KEY)?.contributor_count, 3);

  // 4. Even handed the raw row, the serving DTO refuses it.
  const below = find(computed, VENUE_B, "7d", ALL_BRANDS_KEY)!;
  assertEquals(toVenueNetworkDto(below, DEFAULT_K_ANONYMITY_FLOOR, NOW), null);
});

Deno.test("a brand row below the floor is dropped even when the venue clears it", () => {
  const events: RadarScanEvent[] = [
    event({ contributor_key: "a", brand: "Nike" }),
    event({ contributor_key: "b", brand: "Nike" }),
    event({ contributor_key: "c", brand: "Nike" }),
    // One person, one obscure brand: the venue total clears, this row must not.
    event({ contributor_key: "a", brand: "Vintage Levis 501 Big E" }),
  ];
  const servable = servableAggregates(
    aggregateScanEvents(events, { now: NOW }),
    DEFAULT_K_ANONYMITY_FLOOR,
  );
  assert(find(servable, VENUE_A, "7d", ALL_BRANDS_KEY));
  assert(find(servable, VENUE_A, "7d", "nike"));
  assertEquals(find(servable, VENUE_A, "7d", "vintage levis 501 big e"), undefined);
});

Deno.test("the floor may be raised but never lowered below MIN_K_ANONYMITY_FLOOR", () => {
  assertEquals(clampKFloor(undefined), DEFAULT_K_ANONYMITY_FLOOR);
  assertEquals(clampKFloor("three"), DEFAULT_K_ANONYMITY_FLOOR);
  assertEquals(clampKFloor(10), 10);
  // The values an operator could reach for to switch the guarantee off.
  assertEquals(clampKFloor(1), MIN_K_ANONYMITY_FLOOR);
  assertEquals(clampKFloor(0), MIN_K_ANONYMITY_FLOOR);
  assertEquals(clampKFloor(-5), MIN_K_ANONYMITY_FLOOR);

  const events = [
    event({ contributor_key: "solo" }),
    event({ contributor_key: "solo", scanned_at: daysAgo(2) }),
  ];
  const computed = aggregateScanEvents(events, { now: NOW });
  // Config says 1; a single contributor still gets nothing.
  assertEquals(servableAggregates(computed, 1), []);
});

Deno.test("the served DTO carries counts and freshness, never a contributor", () => {
  const row = find(
    aggregateScanEvents(
      [
        event({ contributor_key: "a", scanned_at: daysAgo(3) }),
        event({ contributor_key: "b", scanned_at: daysAgo(3) }),
        event({ contributor_key: "c", scanned_at: daysAgo(3) }),
      ],
      { now: NOW },
    ),
    VENUE_A,
    "7d",
    ALL_BRANDS_KEY,
  )!;

  const dto = toVenueNetworkDto(row, DEFAULT_K_ANONYMITY_FLOOR, NOW)!;
  assert(dto);
  assertEquals(dto.days_since_activity, 3);
  assertEquals(dto.brand, null, "the all-brands sentinel is not shown as a brand");
  // The KEY SET, not the absence of one field: adding a contributor-identifying
  // field to the DTO has to fail here rather than pass unnoticed (the same
  // assertion shape US-1861 used on the event row).
  assertEquals(Object.keys(dto).sort(), [
    "activity_by_day",
    "avg_grade",
    "brand",
    "buy_rate",
    "contributor_count",
    "days_since_activity",
    "grade_mix",
    "last_activity_at",
    "scan_count",
    "venue_id",
    "window",
  ]);
});

// ── US-1865: the weekly activity pattern ────────────────────────────────────

Deno.test("US-1865: the weekly histogram sums to the scan count", () => {
  const row = find(
    aggregateScanEvents(
      [
        event({ contributor_key: "a", scanned_at: daysAgo(1) }),
        event({ contributor_key: "b", scanned_at: daysAgo(2) }),
        event({ contributor_key: "c", scanned_at: daysAgo(2) }),
        event({ contributor_key: "d", scanned_at: daysAgo(5) }),
      ],
      { now: NOW },
    ),
    VENUE_A,
    "7d",
    ALL_BRANDS_KEY,
  )!;
  assertEquals(row.dow_counts.length, DAYS_IN_WEEK);
  assertEquals(row.dow_counts.reduce((a, b) => a + b, 0), row.scan_count);
  // NOW is a Friday; daysAgo(2) is a Wednesday and two scans landed there.
  assertEquals(row.dow_counts[3], 2);
});

Deno.test("US-1865: the day is the VENUE's local day, not UTC", () => {
  // 02:00Z on a Saturday is Friday evening in Los Angeles. A shop at -118 must
  // read that as a Friday, or every evening scan in the Americas is smeared onto
  // the next day — a systematic error, not noise.
  const saturdayEarlyUtc = "2026-08-01T02:00:00.000Z";
  assertEquals(new Date(saturdayEarlyUtc).getUTCDay(), 6, "sanity: Saturday in UTC");

  const events = ["a", "b", "c"].map((k) =>
    event({ contributor_key: k, scanned_at: saturdayEarlyUtc })
  );
  const opts = {
    now: new Date("2026-08-03T12:00:00.000Z"),
    venueOffsetMinutes: new Map([[VENUE_A, offsetMinutesForLongitude(-118.24)]]),
  };
  const local = find(aggregateScanEvents(events, opts), VENUE_A, "7d", ALL_BRANDS_KEY)!;
  assertEquals(local.dow_counts[5], 3, "Friday, locally");
  assertEquals(local.dow_counts[6], 0);

  // Without an offset the same events fall on Saturday — which is exactly the
  // behaviour the map must not ship.
  const utc = find(
    aggregateScanEvents(events, { now: opts.now }),
    VENUE_A,
    "7d",
    ALL_BRANDS_KEY,
  )!;
  assertEquals(utc.dow_counts[6], 3);
});

Deno.test("US-1865: longitude → offset is solar time, clamped and total", () => {
  assertEquals(offsetMinutesForLongitude(0), 0);
  assertEquals(offsetMinutesForLongitude(-118.24), -8 * 60);
  assertEquals(offsetMinutesForLongitude(139.7), 9 * 60);
  // A venue with no usable longitude buckets in UTC rather than throwing.
  assertEquals(offsetMinutesForLongitude(null), 0);
  assertEquals(offsetMinutesForLongitude(Number.NaN), 0);
  assertEquals(offsetMinutesForLongitude(9999), 12 * 60);
});

Deno.test("US-1865: a ragged or absent stored week reads back as a clean zero week", () => {
  // The column defaults to seven zeros, but a row written before it existed —
  // or by anything that skipped it — must not hand the UI an array it has to
  // length-check. Normalizing on read is what makes `activity_by_day[i]` safe.
  assertEquals(normalizeDowCounts(undefined), [0, 0, 0, 0, 0, 0, 0]);
  assertEquals(normalizeDowCounts([1, 2]), [1, 2, 0, 0, 0, 0, 0]);
  assertEquals(normalizeDowCounts([1, 2, 3, 4, 5, 6, 7, 8]).length, DAYS_IN_WEEK);
  assertEquals(normalizeDowCounts(["3", -4, null, 2.4, 0, 0, 0]), [
    3,
    0,
    0,
    2,
    0,
    0,
    0,
  ]);
});

Deno.test("US-1865: the weekly pattern is withheld with the row it rides on", () => {
  // The histogram has no gate of its own, and that is the point: it is a field
  // of an aggregate that already cleared the floor, so there is no path that
  // publishes one venue's weekly rhythm while withholding its counts.
  const below = find(
    aggregateScanEvents(
      [event({ contributor_key: "solo" }), event({ contributor_key: "solo" })],
      { now: NOW },
    ),
    VENUE_A,
    "7d",
    ALL_BRANDS_KEY,
  )!;
  assertEquals(below.contributor_count, 1);
  assert(below.dow_counts.some((n) => n > 0), "the row itself carries a pattern");
  assertEquals(
    toVenueNetworkDto(below, DEFAULT_K_ANONYMITY_FLOOR, NOW),
    null,
    "and nothing can serve it",
  );
});

// ── Retention ───────────────────────────────────────────────────────────────

Deno.test("the prune boundary snaps to a whole expired month", () => {
  const cutoff = retentionCutoff(NOW, 180);
  // 2026-08-07 minus 180 days lands in February 2026; the boundary is the 1st.
  assertEquals(cutoff.toISOString(), "2026-02-01T00:00:00.000Z");
  assertEquals(monthStart(cutoff), "2026-02-01");
});

Deno.test("retention can be lengthened but never shortened into a live window", () => {
  assertEquals(clampRetentionDays(365), 365);
  assertEquals(clampRetentionDays(undefined), 180);
  // A retention shorter than the widest window would delete the raw events an
  // aggregate is still being computed from.
  assertEquals(clampRetentionDays(1), MAX_RADAR_WINDOW_DAYS + 1);
  assertEquals(clampRetentionDays(0), MAX_RADAR_WINDOW_DAYS + 1);
});

Deno.test("expired events roll up per place and month before they are pruned", () => {
  const cutoff = retentionCutoff(NOW, 180);
  const events: RadarScanEvent[] = [
    // Two venue-resolved events in the same expired month.
    event({
      contributor_key: "a",
      scanned_at: "2025-11-03T10:00:00.000Z",
      grade_band: "high",
      verdict: "buy",
    }),
    event({
      contributor_key: "b",
      scanned_at: "2025-11-20T10:00:00.000Z",
      grade_band: "low",
      verdict: "skip",
    }),
    // A different month at the same venue.
    event({ contributor_key: "a", scanned_at: "2025-12-02T10:00:00.000Z" }),
    // Unresolved: archived under its CELL, so pruning is not the moment the
    // record that anything happened there disappears.
    event({
      contributor_key: "c",
      venue_id: null,
      geohash: "u33dc0",
      scanned_at: "2025-11-09T10:00:00.000Z",
    }),
    // Inside retention — must NOT be rolled up (nor, therefore, deleted).
    event({ contributor_key: "d", scanned_at: daysAgo(5) }),
  ];

  const rows = rollupExpiredEvents(events, cutoff);
  assertEquals(rows.length, 3);

  const nov = rows.find(
    (r) => r.venue_id === VENUE_A && r.month_start === "2025-11-01",
  )!;
  assert(nov);
  assertEquals(nov.scan_count, 2);
  assertEquals(nov.contributor_count, 2);
  assertEquals(nov.buy_count, 1);
  assertEquals(nov.verdict_count, 2);
  assertEquals(nov.avg_grade, (BAND_MIDPOINT.high + BAND_MIDPOINT.low) / 2);
  assertEquals(nov.last_activity_at, "2025-11-20T10:00:00.000Z");

  const cell = rows.find((r) => r.venue_id === null)!;
  assert(cell, "an unresolved event is archived under its cell");
  assertEquals(cell.geohash, "u33dc0");
  assertEquals(historyPlaceKey(cell), "cell:u33dc0");
  assertEquals(historyPlaceKey(nov), VENUE_A);

  // Nothing inside retention leaked into the archive.
  assert(!rows.some((r) => r.month_start >= "2026-02-01"));
});

Deno.test("re-archiving after a partial prune cannot erode a month", () => {
  const cutoff = retentionCutoff(NOW, 180);
  const full = rollupExpiredEvents(
    [
      event({ contributor_key: "a", scanned_at: "2025-11-03T10:00:00.000Z" }),
      event({ contributor_key: "b", scanned_at: "2025-11-04T10:00:00.000Z" }),
      event({ contributor_key: "c", scanned_at: "2025-11-05T10:00:00.000Z" }),
    ],
    cutoff,
  )[0];
  const partial = rollupExpiredEvents(
    [event({ contributor_key: "c", scanned_at: "2025-11-05T10:00:00.000Z" })],
    cutoff,
  )[0];

  // A re-run that sees only the survivors must not replace the complete month.
  assertEquals(mergeHistoryRow(full, partial), full);
  // A first write, or a more complete recomputation, wins.
  assertEquals(mergeHistoryRow(undefined, partial), partial);
  assertEquals(mergeHistoryRow(partial, full), full);
});
