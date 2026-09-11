// US-3346 AC5: the whole story rests on a field eBay does not send.
//
// `relevanceIndicator.searchCount` is eBay's 30-day buyer-search volume for an
// aspect in a category. prioritizeByDemand() ranks on it, recommendedAspectCoverage()
// ranks the seller-facing missing-specifics list on it, and the product used to
// tell sellers that list was "eBay's most-searched, in order".
//
// Measured 2026-09-11 (US-3044, re-measured for US-3346 on the RAW response
// bytes): eBay sends the field on NONE of the 8,748 aspect rows of all 457 leaf
// categories under 11450 on EBAY_US. 98.8 MB of raw response body contained the
// substring "relevanceIndicator" zero times. So every rank ties at zero and the
// list a seller reads is alphabetical.
//
// If eBay ever starts sending it, this story's premise dies and the copy
// (src/lib/aspect-coverage-copy.ts) should go back to naming demand. Nothing
// would announce that. This test does: it fails the moment a refreshed capture
// carries a single search count.
//
// WHAT THIS IS NOT. It is not a source scan and it does not pin a sentence. It
// reads the census capture as DATA and counts. Three ways it could have failed
// open, each closed below:
//   - a renamed or re-dated capture leaving it reading nothing (it globs the
//     family and asserts at least one matched);
//   - a capture that shrank to empty passing trivially (it asserts the census
//     is still the size the finding was measured on);
//   - the column moving (it resolves "searchCount" out of `columns` and fails
//     loudly if that name is gone, rather than reading cell 4 on faith).
// The last block is the positive control: the same checker, run over a capture
// that DOES carry a count, must report it. A guard nobody has seen fire is a
// guard nobody knows works.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE_DIR = path.resolve(__dirname, "../../scripts/fixtures");
/** Every census capture aspect-demand-cut.mjs writes, whatever it is dated. */
const FIXTURE_PREFIX = "aspect-demand-cut-";

interface Capture {
  marketplaceId?: string;
  rootCategoryId?: string;
  capturedAt?: string;
  columns?: string[];
  aspectNames?: string[];
  leaves?: Array<{ id: string; path: string; aspects: unknown[][] }>;
}

interface DemandReading {
  leaves: number;
  rows: number;
  /** Rows whose search-count cell is not null. Zero is the finding. */
  rowsWithSearchCount: number;
  /** The first few, named, so a failure says WHICH aspects gained demand. */
  examples: string[];
  /** True when the raw bytes carry eBay's nested object rather than the column. */
  rawMentionsRelevanceIndicator: boolean;
}

/**
 * Count the aspect rows that carry a search count.
 *
 * `columns` names the tuple, so the index is resolved rather than remembered.
 * A capture that no longer declares a "searchCount" column throws: reading the
 * wrong cell and reporting zero is the failure this guard exists to prevent.
 */
function readDemand(text: string, capture: Capture): DemandReading {
  const columns = capture.columns ?? [];
  const idx = columns.indexOf("searchCount");
  if (idx < 0) {
    throw new Error(
      `capture declares columns [${columns.join(", ")}] with no "searchCount"; ` +
        "the capture format changed and this guard is reading the wrong cell",
    );
  }
  const names = capture.aspectNames ?? [];
  const nameIdx = columns.indexOf("nameIndex");
  let rows = 0;
  let rowsWithSearchCount = 0;
  const examples: string[] = [];
  for (const leaf of capture.leaves ?? []) {
    for (const row of leaf.aspects ?? []) {
      rows++;
      const cell = row[idx];
      if (cell === null || cell === undefined) continue;
      rowsWithSearchCount++;
      if (examples.length < 5) {
        const name = nameIdx >= 0 ? names[Number(row[nameIdx])] : "?";
        examples.push(`${leaf.id} ${name} = ${String(cell)}`);
      }
    }
  }
  return {
    leaves: (capture.leaves ?? []).length,
    rows,
    rowsWithSearchCount,
    examples,
    // The columnar format flattens relevanceIndicator into a cell, so this is
    // belt and braces against a future capture that keeps eBay's nested shape.
    // The positive control below proves it is not a check that can never match.
    rawMentionsRelevanceIndicator: text.includes("relevanceIndicator"),
  };
}

function fixtureFiles(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.startsWith(FIXTURE_PREFIX) && f.endsWith(".json"))
    .map((f) => path.join(FIXTURE_DIR, f));
}

describe("eBay sends no aspect demand on the US apparel tree", () => {
  it("finds the census capture at all", () => {
    // A glob that matches nothing passes every assertion under it.
    expect(fixtureFiles().map((f) => path.basename(f))).not.toHaveLength(0);
  });

  it.each(fixtureFiles().map((f) => [path.basename(f), f] as const))(
    "%s carries no relevanceIndicator.searchCount on any aspect row",
    (_name, file) => {
      const text = fs.readFileSync(file, "utf8");
      const capture = JSON.parse(text) as Capture;
      const reading = readDemand(text, capture);

      // A capture that shrank to nothing would satisfy the count below without
      // measuring anything. 457 leaves / 8,748 rows is what US-3044 measured
      // and US-3346 re-measured; the floors sit well under those so an ordinary
      // eBay taxonomy edit does not turn this red.
      expect(reading.leaves, `${_name}: census is too small to conclude from`).toBeGreaterThan(300);
      expect(reading.rows, `${_name}: census is too small to conclude from`).toBeGreaterThan(5000);

      expect(
        reading.rowsWithSearchCount,
        `${_name} (${capture.marketplaceId} / ${capture.rootCategoryId}, captured ${capture.capturedAt}): ` +
          `${reading.rowsWithSearchCount} of ${reading.rows} aspect rows now carry a search count ` +
          `(${reading.examples.join("; ")}). eBay has started publishing aspect demand on this tree, ` +
          "so US-3346's premise is dead: prioritizeByDemand really does rank by demand again, and the " +
          "seller-facing copy in src/lib/aspect-coverage-copy.ts should say so instead of saying A to Z.",
      ).toBe(0);

      expect(
        reading.rawMentionsRelevanceIndicator,
        `${_name}: the raw capture bytes mention relevanceIndicator`,
      ).toBe(false);
    },
  );

  it("reports a search count when one is present (the guard can fire)", () => {
    const capture: Capture = {
      marketplaceId: "EBAY_US",
      rootCategoryId: "11450",
      columns: ["nameIndex", "required", "usage", "mode", "searchCount", "valueCount"],
      aspectNames: ["Theme", "Color"],
      leaves: [
        {
          id: "L1",
          path: "test > L1",
          aspects: [
            [0, 0, "RECOMMENDED", "FREE_TEXT", 4200, 5],
            [1, 0, "RECOMMENDED", "FREE_TEXT", null, 5],
          ],
        },
      ],
    };
    const text = JSON.stringify({ ...capture, note: "relevanceIndicator" });
    const reading = readDemand(text, capture);
    expect(reading.rows).toBe(2);
    expect(reading.rowsWithSearchCount).toBe(1);
    expect(reading.examples).toEqual(["L1 Theme = 4200"]);
    expect(reading.rawMentionsRelevanceIndicator).toBe(true);
  });

  it("refuses to read a capture that no longer declares the column", () => {
    // Silently reading cell 4 of a reshaped tuple is how a guard reports zero
    // forever. See mode 8 in guards-that-do-not-guard.
    expect(() =>
      readDemand("{}", { columns: ["nameIndex", "required", "usage"], leaves: [] }),
    ).toThrow(/no "searchCount"/);
  });
});
