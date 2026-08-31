// US-9029: the FTC public RN search, parsed.
//
// Fixtures are real responses captured 2026-08-31 and trimmed to the results
// table verbatim. NOTHING here touches the network: the seeder is the only
// thing that fetches, and it takes the fetcher as an argument so this file can
// prove every rule without a request.
//
//   deno test --allow-read src/tests/ftc-rn-search_test.ts

import { assertEquals } from "@std/assert";
import { decideSeedRow, ftcSearchUrl, parseFtcResults } from "../lib/ftc-rn-search.ts";

const read = (name: string) =>
  Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

const nike = await read("ftc-rn-56323.html");
const vuori = await read("ftc-rn-vuori.html");
const empty = await read("ftc-rn-empty.html");

Deno.test("parses a single RN record from a number search", () => {
  const rows = parseFtcResults(nike);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].kind, "RN");
  assertEquals(rows[0].digits, "56323");
  assertEquals(rows[0].legalName, "NIKE, INC.");
});

Deno.test("reads every product line as its own entry", () => {
  const rows = parseFtcResults(vuori);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].digits, "156509");
  assertEquals(rows[0].legalName, "Vuori, Inc.");
  // Two <h3 class="term-title"> elements in one cell, not one string to split.
  assertEquals(rows[0].productLines.length, 2);
  assertEquals(rows[0].productLines[0].endsWith("s apparel"), true);
});

Deno.test("a product line with no entries is an empty list, not a blank string", () => {
  assertEquals(parseFtcResults(nike)[0].productLines, []);
});

Deno.test("no match is an empty list, never a throw", () => {
  assertEquals(parseFtcResults(empty), []);
});

Deno.test("markup we do not recognise is an empty list, never a throw", () => {
  // The seeder walks ~180 brands in one run. A single unexpected page must not
  // kill the run: an empty list reads as "no match", which is already the
  // common and correct outcome.
  for (const junk of ["", "<html><body>down for maintenance</body></html>", "<table></table>"]) {
    assertEquals(parseFtcResults(junk), []);
  }
});

Deno.test("the header row is not mistaken for a record", () => {
  // The <thead> carries the same four columns; only a row whose first cell is
  // RN or CA is a record.
  assertEquals(parseFtcResults(nike).every((r) => r.kind === "RN" || r.kind === "CA"), true);
});

Deno.test("search url encodes the term", () => {
  assertEquals(
    ftcSearchUrl("Free People"),
    "https://www.ftc.gov/rn-database/search?search=Free%20People",
  );
  assertEquals(
    ftcSearchUrl("56323"),
    "https://www.ftc.gov/rn-database/search?search=56323",
  );
});

// ── The seeding decision (US-9029) ──────────────────────────────────────────

const rec = (digits: string, legalName: string) => ({
  kind: "RN" as const,
  digits,
  legalName,
  productLines: [] as string[],
  sourceUrl: "https://www.ftc.gov/rn-database/search?search=x",
});

Deno.test("exactly one match writes", () => {
  const d = decideSeedRow("Vuori", [rec("156509", "Vuori, Inc.")]);
  assertEquals(d.action, "write");
  if (d.action === "write") assertEquals(d.record.digits, "156509");
});

Deno.test("no match skips, and skipping is the normal outcome", () => {
  const d = decideSeedRow("Some Small Label", []);
  assertEquals(d.action, "skip");
});

Deno.test("several matches go to review and NEVER pick one", () => {
  // Measured against the live registry 2026-08-31: "Patagonia" returns both of
  // these, and nothing on the page says which one labels a given fleece.
  const d = decideSeedRow("Patagonia", [
    rec("51884", "PATAGONIA INC."),
    rec("76119", "PATAGONIA TRADING CO."),
  ]);
  assertEquals(d.action, "review");
  if (d.action === "review") assertEquals(d.candidates.length, 2);
});
