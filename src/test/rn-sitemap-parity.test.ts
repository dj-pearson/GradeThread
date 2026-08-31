// US-9032: the sitemap and the page must decide indexability the same way.
//
// A URL listed in a sitemap that renders noindex is the specific contradiction
// that gets a whole section ignored — US-2748 learned that on the style codes,
// and this family copies both the shape and the guard. Neither half can be
// checked by reading it alone, so both are driven from one fixture set here.

import { describe, expect, it } from "vitest";
import {
  indexableNumbers,
  publicRegisteredNumber,
} from "../../services/edge-functions/src/lib/public-registered-number";

const rows = [
  {
    registry_key: "RN:56323",
    kind: "RN",
    digits: "56323",
    company_name: "NIKE, INC.",
    updated_at: "2026-08-31T00:00:00Z",
  },
  {
    registry_key: "RN:999999",
    kind: "RN",
    digits: "999999",
    company_name: null,
    updated_at: "2026-08-31T00:00:00Z",
  },
  {
    registry_key: "RN:1234",
    kind: "RN",
    digits: "1234",
    company_name: "   ",
    updated_at: null,
  },
  {
    registry_key: "CA:32054",
    kind: "CA",
    digits: "32054",
    company_name: "A Canadian Co.",
    updated_at: null,
  },
];

describe("rn sitemap parity", () => {
  it("lists only the numbers a page would index", () => {
    expect(indexableNumbers(rows).map((r) => r.digits)).toEqual(["56323"]);
  });

  it("agrees with the page on every row, from one fixture set", () => {
    const listed = new Set(indexableNumbers(rows).map((r) => r.digits));
    for (const row of rows) {
      const page = publicRegisteredNumber({
        requested: row.digits,
        registry: { ...row, kind: row.kind as "RN" | "CA" },
        sightings: null,
      })!;
      // CA is the one deliberate asymmetry: it renders and indexes as a page,
      // and is still kept out of the sitemap for want of measured demand.
      if (row.kind === "CA") {
        expect(page.indexable).toBe(true);
        expect(listed.has(row.digits)).toBe(false);
        continue;
      }
      expect(page.indexable, row.digits).toBe(listed.has(row.digits));
    }
  });

  it("keeps the newest lastmod per number", () => {
    const dupes = [
      { registry_key: "RN:7", kind: "RN", digits: "7", company_name: "A Co.", updated_at: "2026-01-01" },
      { registry_key: "RN:7", kind: "RN", digits: "7", company_name: "A Co.", updated_at: "2026-08-31" },
    ];
    expect(indexableNumbers(dupes)).toEqual([{ digits: "7", updated_at: "2026-08-31" }]);
  });
});
