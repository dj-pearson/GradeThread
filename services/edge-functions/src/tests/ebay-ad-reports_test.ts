// US-2683: eBay's own buyer search terms.
//
// Everything else FlipDesk knows about buyer language is inferred. US-2675
// improved demand-term mining by ranking sold titles over active ones, but both
// are still SELLER writing weighted by outcome. A Promoted Listings search-query
// report is what buyers actually TYPED against this seller's items — the only
// non-inferred source on the platform, which is why it outranks the rest rather
// than being blended into them.
//
// Pure: fixture report bodies in, rows out. No eBay, no database, no clock.

import "./_env.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  AD_REPORT_TYPES,
  AdReportShapeError,
  MIN_TERM_IMPRESSIONS,
  parseAdReportTsv,
  type SearchTermRow,
  termVerdict,
} from "../lib/ebay-ad-reports.ts";
import { type DemandTerm, preferSellerSearchTerms } from "../lib/demand-terms.ts";

const HEADER = "Search Query\tImpressions\tClicks\tAttributed Sales";

function report(rows: string[][], header = HEADER): string {
  return [header, ...rows.map((r) => r.join("\t"))].join("\n");
}

// ── parsing ────────────────────────────────────────────────────────────────

Deno.test("parses a plain report into rolled-up rows", () => {
  const out = parseAdReportTsv(report([
    ["carhartt detroit jacket", "1200", "48", "3"],
    ["blanket lined jacket", "800", "40", "2"],
  ]));
  assertEquals(out, [
    { term: "carhartt detroit jacket", impressions: 1200, clicks: 48, attributedSales: 3 },
    { term: "blanket lined jacket", impressions: 800, clicks: 40, attributedSales: 2 },
  ]);
});

Deno.test("the same query on two listings is ONE term, summed", () => {
  // A keyword report has a row per listing the query matched. A seller wants
  // "how often did anyone type this", not one row per item.
  const out = parseAdReportTsv(report([
    ["carhartt jacket", "500", "20", "1"],
    ["carhartt jacket", "300", "10", "1"],
  ]));
  assertEquals(out.length, 1);
  assertEquals(out[0], {
    term: "carhartt jacket",
    impressions: 800,
    clicks: 30,
    attributedSales: 2,
  });
});

Deno.test("COLUMNS ARE READ BY NAME, so a reordered report still parses", () => {
  // The reason this matters: eBay adds columns to these reports between
  // releases, and a positional parser silently reads impressions out of
  // whichever column moved into slot 3. This is the exact case.
  const out = parseAdReportTsv(report(
    [["12", "carhartt jacket", "3", "900"]],
    "Clicks\tSearch Query\tAttributed Sales\tImpressions",
  ));
  assertEquals(out[0], {
    term: "carhartt jacket",
    impressions: 900,
    clicks: 12,
    attributedSales: 3,
  });
});

Deno.test("a keyword report's own column name is accepted too", () => {
  const out = parseAdReportTsv(report(
    [["vintage carhartt", "400", "10", "0"]],
    "Keyword Text\tImpressions\tClicks\tAttributed Sales",
  ));
  assertEquals(out[0]!.term, "vintage carhartt");
});

Deno.test("metadata lines above the header are skipped", () => {
  // eBay prefixes these files with report name, account and date-range lines.
  const body = [
    "Report: Search Query Performance",
    "Account: 1234567",
    "Date range: 2026-07-19 to 2026-08-18",
    "",
    HEADER,
    ["carhartt jacket", "900", "30", "2"].join("\t"),
  ].join("\n");
  assertEquals(parseAdReportTsv(body)[0]!.impressions, 900);
});

Deno.test("A REPORT WE CANNOT READ THROWS, it does not return nothing", () => {
  // An empty list means "this seller got no impressions". A report whose shape
  // changed must never be able to say that — the seller would read a silent
  // zero as "nobody searched for my items".
  assertThrows(
    () => parseAdReportTsv("Some Column\tAnother Column\n1\t2"),
    AdReportShapeError,
  );
  assertThrows(() => parseAdReportTsv(""), AdReportShapeError);
});

Deno.test("a header with a term column but no impressions column also throws", () => {
  assertThrows(
    () => parseAdReportTsv("Search Query\tClicks\ncarhartt\t4"),
    AdReportShapeError,
  );
});

Deno.test("thousands separators and stray symbols are read as numbers", () => {
  const out = parseAdReportTsv(report([["carhartt jacket", "1,200", "48", "$3"]]));
  assertEquals(out[0]!.impressions, 1200);
  assertEquals(out[0]!.attributedSales, 3);
});

Deno.test("terms are lowercased and whitespace-collapsed, so they join", () => {
  const out = parseAdReportTsv(report([
    ["Carhartt   Detroit", "500", "10", "1"],
    ["carhartt detroit", "300", "5", "0"],
  ]));
  assertEquals(out.length, 1, "the same query in two casings stayed two terms");
  assertEquals(out[0]!.term, "carhartt detroit");
});

Deno.test("a blank query row is dropped rather than becoming an empty term", () => {
  const out = parseAdReportTsv(report([
    ["", "900", "30", "2"],
    ["carhartt jacket", "100", "4", "0"],
  ]));
  assertEquals(out.map((r) => r.term), ["carhartt jacket"]);
});

Deno.test("rows are ranked by impressions", () => {
  const out = parseAdReportTsv(report([
    ["low", "10", "1", "0"],
    ["high", "900", "2", "0"],
  ]));
  assertEquals(out.map((r) => r.term), ["high", "low"]);
});

// ── AC6: the terms to remove ───────────────────────────────────────────────

function row(over: Partial<SearchTermRow> = {}): SearchTermRow {
  return { term: "carhartt jacket", impressions: 500, clicks: 20, attributedSales: 1, ...over };
}

Deno.test("AC6: impressions with NO clicks is a term to REMOVE", () => {
  // Not neutral. Buyers are being shown this listing for that query and
  // rejecting it at the thumbnail, so the word pulls the wrong traffic and
  // carrying it costs characters AND dilutes the listing's relevance.
  assertEquals(termVerdict(row({ clicks: 0 })), "remove");
});

Deno.test("AC6: impressions WITH clicks is a term to add", () => {
  assertEquals(termVerdict(row({ clicks: 20 })), "add");
});

Deno.test("AC6: too few impressions is not-enough-data, not remove", () => {
  // A term shown twice and not clicked has told you nothing, and calling it
  // "remove" would have a seller stripping words on no evidence.
  assertEquals(termVerdict(row({ impressions: MIN_TERM_IMPRESSIONS - 1, clicks: 0 })), "not_enough_data");
});

Deno.test("AC6: exactly at the floor counts, so the constant means what it says", () => {
  assertEquals(termVerdict(row({ impressions: MIN_TERM_IMPRESSIONS, clicks: 0 })), "remove");
});

// ── AC4: the pool prefers the seller's own terms ───────────────────────────

const MINED: DemandTerm[] = [
  { term: "blanket lined", count: 9, source: "sold" },
  { term: "chore coat", count: 7, source: "active" },
];

Deno.test("AC4: a seller's own eBay terms lead the pool", () => {
  const out = preferSellerSearchTerms([row({ term: "detroit jacket" })], MINED, { max: 12 });
  assertEquals(out[0]!.term, "detroit jacket");
  assertEquals(out[0]!.source, "ebay_search");
  // And the mined pool still fills the rest.
  assertEquals(out.map((t) => t.term), ["detroit jacket", "blanket lined", "chore coat"]);
});

Deno.test("AC4: with no eBay terms the mined pool is returned untouched", () => {
  // The no-Priority-campaign case, which is most sellers. Nothing changes and
  // nothing complains.
  assertEquals(preferSellerSearchTerms([], MINED, { max: 12 }), MINED);
});

Deno.test("AC4: a term in BOTH keeps its eBay provenance and is not repeated", () => {
  const out = preferSellerSearchTerms([row({ term: "blanket lined" })], MINED, { max: 12 });
  assertEquals(out.filter((t) => t.term === "blanket lined").length, 1);
  assertEquals(out[0]!.source, "ebay_search");
});

Deno.test("AC6 + AC4: a REMOVE term is never suggested", () => {
  const out = preferSellerSearchTerms([row({ term: "designer coat", clicks: 0 })], MINED, {
    max: 12,
  });
  assertEquals(out.some((t) => t.term === "designer coat"), false);
});

Deno.test("a term with too little exposure is not suggested either", () => {
  // Suggesting it would be inventing evidence: nobody has seen it enough for
  // the number to mean anything in either direction.
  const out = preferSellerSearchTerms(
    [row({ term: "rare colourway", impressions: 3, clicks: 1 })],
    MINED,
    { max: 12 },
  );
  assertEquals(out.some((t) => t.term === "rare colourway"), false);
});

Deno.test("the cap is respected, and eBay terms get first claim on it", () => {
  const many = Array.from({ length: 10 }, (_, i) => row({ term: `q${i}` }));
  const out = preferSellerSearchTerms(many, MINED, { max: 3 });
  assertEquals(out.length, 3);
  assert(out.every((t) => t.source === "ebay_search"));
});

Deno.test("both report types are declared, and they are distinct", () => {
  assertEquals(AD_REPORT_TYPES.length, 2);
  assertEquals(new Set(AD_REPORT_TYPES).size, 2);
});
