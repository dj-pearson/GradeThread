// US-2835: the traffic parse that wrote 7,352 rows of zeros.
//
// ── WHAT HAPPENED, because the fixtures below only make sense against it ────
// Measured on production 2026-08-23: public.listing_metrics held 7,352 rows
// dating from 2026-07-12, and the count with impressions > 0 was ZERO. Same for
// views, watchers, and a non-null click_through_rate. listings.views_total > 0
// was 0 rows. The sync ran on schedule and matched listings correctly; the rows
// simply arrived empty, and the Listing Performance page showed a table of
// zeros for six weeks. Nobody could tell, because a listing with no traffic and
// a listing whose traffic was never parsed look identical.
//
// ── THE FINGERPRINT THAT NAMED THE BUG ──────────────────────────────────────
// Every CTR was NULL rather than 0. That is the tell, and it is the reason this
// could be diagnosed from data alone: the old code set clickThroughRate to null
// only when metricCols.has("CLICK_THROUGH_RATE") was FALSE. Had eBay genuinely
// reported zero traffic, the key would have been present and CTR would have
// been 0. Null CTR + zero counts, together, means the metric column map was
// EMPTY — nothing else in that function produces that pair.
//
// ── AND THE MAP WAS EMPTY BECAUSE THE FIELD NAME WAS WRONG ──────────────────
// eBay's Header type (sell/analytics, srl:Header) carries `dimensionKeys` and
// `metrics`. The code read `header.metricKeys`, which does not exist. Every
// field on the hand-written response interface was optional, so TypeScript
// never objected; `?? []` turned undefined into an empty array; and num()
// returned 0 for every key it could not find. A wrong field name became a
// plausible number.
//
// Pure: fixture bodies in, rows out. No eBay, no database, no clock.

import "./_env.ts";
import { assertEquals, assertThrows } from "@std/assert";
import {
  parseTrafficReport,
  TrafficReportShapeError,
} from "../lib/ebay-client.ts";

/** A response shaped the way eBay actually documents it. */
function ebayReport(
  records: Array<{ listingId: string; values: Array<string | null> }>,
  metricKeys = [
    "LISTING_IMPRESSION_TOTAL",
    "LISTING_VIEWS_TOTAL",
    "CLICK_THROUGH_RATE",
  ],
) {
  return {
    header: {
      dimensionKeys: [{ dataType: "STRING", key: "LISTING" }],
      // THE FIELD NAME THIS WHOLE FILE EXISTS FOR.
      metrics: metricKeys.map((k) => ({ dataType: "INTEGER", key: k })),
    },
    records: records.map((r) => ({
      dimensionValues: [{ value: r.listingId }],
      metricValues: r.values.map((v) => ({ applicable: v !== null, value: v })),
    })),
  };
}

Deno.test("parses a real eBay traffic report", () => {
  const rows = parseTrafficReport(
    ebayReport([{ listingId: "110512345678", values: ["1200", "48", "4.0"] }]),
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].listingId, "110512345678");
  assertEquals(rows[0].impressions, 1200);
  assertEquals(rows[0].views, 48);
  // eBay returns CTR as a percentage; we store a fraction.
  assertEquals(rows[0].clickThroughRate, 0.04);
});

Deno.test("does not depend on eBay echoing the requested metric order", () => {
  // The column map exists precisely so a reordered header still parses. Views
  // first here, impressions second — the reverse of what we asked for.
  const rows = parseTrafficReport(
    ebayReport([{ listingId: "L1", values: ["48", "1200", "4.0"] }], [
      "LISTING_VIEWS_TOTAL",
      "LISTING_IMPRESSION_TOTAL",
      "CLICK_THROUGH_RATE",
    ]),
  );
  assertEquals(rows[0].views, 48);
  assertEquals(rows[0].impressions, 1200);
});

Deno.test("a genuine zero is reported as zero, not dropped", () => {
  // The other half of the fingerprint: real zero traffic must still produce a
  // row, with CTR 0 rather than null, so it is distinguishable from a parse
  // failure for ever after.
  const rows = parseTrafficReport(
    ebayReport([{ listingId: "L1", values: ["0", "0", "0"] }]),
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].impressions, 0);
  assertEquals(rows[0].views, 0);
  assertEquals(rows[0].clickThroughRate, 0);
});

Deno.test("REFUSES a report whose metric header cannot be mapped", () => {
  // THE REGRESSION TEST FOR THE ACTUAL BUG. This is the exact body the old code
  // received and silently turned into zeros: records present, header carrying a
  // field name the parser does not know. Refusing is the whole point — a thrown
  // error reaches a log, and 7,352 rows of zeros did not.
  const body = {
    header: { someFutureFieldName: [{ key: "LISTING_VIEWS_TOTAL" }] },
    records: [{
      dimensionValues: [{ value: "L1" }],
      metricValues: [{ applicable: true, value: "48" }],
    }],
  };
  assertThrows(
    () => parseTrafficReport(body as never),
    TrafficReportShapeError,
  );
});

Deno.test("accepts the legacy metricKeys spelling if eBay ever sends it", () => {
  // Costs nothing and means a future shape change degrades to working rather
  // than to zeros. It is NOT what production sends.
  const rows = parseTrafficReport({
    header: {
      metricKeys: [
        { key: "LISTING_IMPRESSION_TOTAL" },
        { key: "LISTING_VIEWS_TOTAL" },
      ],
    },
    records: [{
      dimensionValues: [{ value: "L1" }],
      metricValues: [{ value: "10" }, { value: "2" }],
    }],
  });
  assertEquals(rows[0].impressions, 10);
  assertEquals(rows[0].views, 2);
});

Deno.test("an empty report is empty, not an error", () => {
  // A seller with no active listings, or a window with no data at all. There is
  // no header to map and nothing to map it for, so there is nothing wrong.
  assertEquals(parseTrafficReport({ header: {}, records: [] }).length, 0);
  assertEquals(parseTrafficReport({}).length, 0);
});

Deno.test("skips a record eBay marked not applicable on every metric", () => {
  // `applicable: false` is eBay saying the metric does not apply to this row.
  // Reading it as 0 is the same class of lie the original bug told.
  const rows = parseTrafficReport(
    ebayReport([
      { listingId: "L1", values: [null, null, null] },
      { listingId: "L2", values: ["5", "1", "2.0"] },
    ]),
  );
  assertEquals(rows.map((r) => r.listingId), ["L2"]);
});

Deno.test("skips a record with no listing id", () => {
  const rows = parseTrafficReport({
    header: { metrics: [{ key: "LISTING_VIEWS_TOTAL" }] },
    records: [
      { dimensionValues: [], metricValues: [{ value: "9" }] },
      { dimensionValues: [{ value: "L2" }], metricValues: [{ value: "9" }] },
    ],
  });
  assertEquals(rows.map((r) => r.listingId), ["L2"]);
});

Deno.test("a non-numeric value does not become zero", () => {
  // Garbage in one cell must not read as a real measurement of nothing.
  const rows = parseTrafficReport(
    ebayReport([{ listingId: "L1", values: ["n/a", "48", "4.0"] }]),
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].views, 48);
  assertEquals(rows[0].impressions, null);
});

Deno.test("CTR reported without counts still yields the CTR", () => {
  const rows = parseTrafficReport(
    ebayReport([{ listingId: "L1", values: [null, null, "2.5"] }]),
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].clickThroughRate, 0.025);
  assertEquals(rows[0].views, null);
  assertEquals(rows[0].impressions, null);
});
