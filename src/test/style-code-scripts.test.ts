// US-2694: the operator scripts behind the style-code index.
//
// Both are .mjs at scripts/ and both hold a rule that also exists in the Deno
// edge code. The interesting tests here are the two that stop those copies
// drifting, plus the validation that decides whether an `official` row — which
// outranks every other source — is allowed to exist.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  NAME_SOURCE_ORDER,
  winningSource,
  normalizeStyleCode as coverageNormalize,
} from "../../scripts/style-code-coverage.mjs";
import {
  normalizeStyleCode,
  tagCodeKeyedUrls,
  validateOfficialRow,
} from "../../scripts/seed-official-style-names.mjs";

const EDGE_LIB = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/style-code-names.ts",
);
const EDGE_OBS = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/style-code-observations.ts",
);

describe("US-2694: the scripts' copies of edge rules do not drift", () => {
  it("uses the same source precedence as the edge", () => {
    const src = readFileSync(EDGE_LIB, "utf8");
    const block = src.match(
      /export const NAME_SOURCE_ORDER = \[([\s\S]*?)\] as const;/,
    );
    // Fail LOUDLY on a rename rather than silently pass with nothing compared —
    // a drift guard that cannot find its target is not a guard.
    expect(block, `NAME_SOURCE_ORDER not found in ${EDGE_LIB}`).toBeTruthy();
    const edgeOrder = [...(block?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(edgeOrder.length).toBeGreaterThan(0);
    expect(NAME_SOURCE_ORDER).toEqual(edgeOrder);
  });

  it("normalizes a style code the same way the edge does", () => {
    const src = readFileSync(EDGE_OBS, "utf8");
    // The edge rule, verbatim: uppercase, then drop everything not A-Z0-9.
    expect(src).toContain('.toUpperCase().replace(/[^A-Z0-9]/g, "")');
    for (const raw of ["lw7d-vcs", "LW7D VCS", " m7a83s ", "Ab.12_34"]) {
      const expected = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
      expect(normalizeStyleCode(raw)).toBe(expected);
      expect(coverageNormalize(raw)).toBe(expected);
    }
    expect(normalizeStyleCode(null)).toBe("");
    expect(normalizeStyleCode(undefined)).toBe("");
  });
});

describe("US-2694: which source a code is counted under", () => {
  it("counts a code under its STRONGEST source, not each one", () => {
    expect(winningSource(["consensus", "official", "seller"])).toBe("official");
    expect(winningSource(["consensus", "seller"])).toBe("seller");
    expect(winningSource(["consensus"])).toBe("consensus");
  });

  it("returns null when nothing recognizable is present", () => {
    expect(winningSource([])).toBeNull();
    expect(winningSource(["scraped_from_somewhere"])).toBeNull();
  });
});

describe("US-2694: an official row has to earn its place", () => {
  const good = {
    styleCode: "LM7A83S",
    name: "Commission Short Relaxed Warpstreme",
    sourceUrl: "https://shop.lululemon.com/p/x",
  };

  it("accepts a complete row", () => {
    const result = validateOfficialRow(good, 1);
    expect(result.error).toBeUndefined();
    const row = result.row;
    if (!row) throw new Error("a complete row should have validated");
    expect(row.styleCodeNorm).toBe("LM7A83S");
    expect(row.colorway).toBeNull();
  });

  it("refuses a code too short to be an identity", () => {
    expect(validateOfficialRow({ ...good, styleCode: "AB" }, 1).error).toMatch(
      /too short/,
    );
  });

  it("refuses a one-word name, which is a category and not a product", () => {
    expect(validateOfficialRow({ ...good, name: "Cargo" }, 1).error).toMatch(
      /not a product name/,
    );
  });

  it("refuses a missing or non-http source", () => {
    // brand_styles carries CHECK (brand_fact_is_sourced(source_url, ...)), so
    // an official claim without a citation cannot be stored anyway.
    expect(validateOfficialRow({ ...good, sourceUrl: "" }, 1).error).toMatch(/http/);
    expect(validateOfficialRow({ ...good, sourceUrl: "not-a-url" }, 1).error).toMatch(
      /http/,
    );
  });

  it("refuses anything that is not an object", () => {
    expect(validateOfficialRow(null, 1).error).toMatch(/not an object/);
    expect(validateOfficialRow("LM7A83S", 1).error).toMatch(/not an object/);
  });
});

describe("US-2694: can the public catalogue key what the index needs?", () => {
  it("counts zero for product-id URLs, which is what lululemon publishes", () => {
    // Real shapes from Product_Sitemap_en_US.xml, 2026-08-19.
    const locs = [
      "https://shop.lululemon.com/p/women-tanks/Sculpt-Tank-Top/_/prod5020018",
      "https://shop.lululemon.com/p/men-joggers/License-to-Train-Textured-Jogger-Regular-MD/_/prod20000550",
      "https://shop.lululemon.com/p/fast-and-free-high-rise-tight-25-drawcord/e33xnt310o-md",
    ];
    expect(tagCodeKeyedUrls(locs)).toEqual([]);
  });

  it("would find them if the catalogue ever published them", () => {
    // The premise-changed branch of --fetch. If this ever fires against the
    // real sitemap, the story reopens.
    const locs = ["https://shop.lululemon.com/p/men-shorts/Commission/_/LM7A83S"];
    expect(tagCodeKeyedUrls(locs)).toEqual(["LM7A83S"]);
  });
});
