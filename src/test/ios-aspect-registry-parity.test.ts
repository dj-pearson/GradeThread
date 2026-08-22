// US-2274 AC6: the iOS column-to-aspect mapping cannot drift from the registry.
//
// THE AC'S PREMISE DOES NOT HOLD, AND THAT IS THE FINDING. It asks for a guard
// asserting the iOS mapping MATCHES `src/lib/ebay-aspect-registry.json`. There
// is no iOS mapping to match: `SpecificsEditorModel.applyColumnAuthority` takes
// `columnOwned` / `columnCleared` off the server's derive-aspects response, and
// its own doc comment says why - "the mapping stays in the shared registry
// (US-822) and no Swift table can drift from it".
//
// So the property worth pinning is the INVERSE of what the AC literally asks:
// not "the two tables agree" but "there is no second table". A guard comparing
// two copies would have to be rewritten the day someone added the copy, which
// is the wrong direction - it would make adding the drift the cheap path.
//
// What this catches: a future edit that hardcodes the five column-owned aspect
// names into Swift to avoid a round trip. That is a reasonable-looking
// optimisation and it is exactly how the registry stops being the source of
// truth. The registry supports per-category overrides (shoes map `size` to
// "US Shoe Size") that a hardcoded five-name list silently loses.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripSwift = (s: string) =>
  s.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

interface RegistryEntry {
  key: string;
  source: string;
  column?: string;
  aspects: string[];
  byCategory?: Record<string, string[]>;
}

const registry = JSON.parse(read("src/lib/ebay-aspect-registry.json")) as {
  version: number;
  entries: RegistryEntry[];
};

const columnEntries = registry.entries.filter((e) => e.source === "column");

/** Every aspect name the registry says a COLUMN owns, including overrides. */
const columnOwnedAspects = [
  ...new Set(
    columnEntries.flatMap((e) => [
      ...e.aspects,
      ...Object.values(e.byCategory ?? {}).flat(),
    ]),
  ),
];

const iosSources = [
  "ios/GradeThread/Marketplaces/Listing/SpecificsEditorModel.swift",
  "ios/GradeThread/Marketplaces/Listing/InventoryAspectSync.swift",
  "ios/GradeThread/Marketplaces/Listing/EbayAspectsTypes.swift",
].map((p) => ({ path: p, code: stripSwift(read(p)) }));

describe("US-2274 AC6: iOS keeps no second copy of the column-aspect mapping", () => {
  it("the registry was actually parsed", () => {
    // Without this every assertion below passes vacuously against an empty
    // list - the failure mode that has bitten this repo repeatedly.
    expect(columnEntries.length).toBeGreaterThanOrEqual(5);
    expect(columnOwnedAspects).toContain("Brand");
    expect(columnOwnedAspects).toContain("US Shoe Size");
    expect(iosSources.every((s) => s.code.length > 0)).toBe(true);
  });

  it("no iOS file hardcodes a column-owned aspect name", () => {
    // Comments stripped first. These files DESCRIBE the rule and name "Brand"
    // while explaining it, so a raw scan would match the documentation rather
    // than a table - the mistake this session has now made twice.
    const offenders: string[] = [];
    for (const { path, code } of iosSources) {
      for (const aspect of columnOwnedAspects) {
        if (code.includes(`"${aspect}"`)) offenders.push(`${path}: "${aspect}"`);
      }
    }
    expect(
      offenders,
      "an iOS file names a column-owned aspect as a literal. The registry is " +
        "the source of truth and the server sends columnOwned/columnCleared " +
        "for exactly this reason - a Swift table drifts the moment the " +
        "registry gains a category override, and shoes already have one.",
    ).toEqual([]);
  });

  it("iOS takes column authority from the server response", () => {
    const model = iosSources.find((s) => s.path.endsWith("SpecificsEditorModel.swift"))!;
    expect(
      model.code,
      "applyColumnAuthority no longer accepts the server's columnOwned, so " +
        "something else is deciding which aspects a column owns",
    ).toContain("columnOwned: [String]");
    expect(model.code).toContain("columnCleared: [String]");

    const sync = iosSources.find((s) => s.path.endsWith("InventoryAspectSync.swift"))!;
    expect(
      sync.code,
      "the sync no longer forwards the server's column authority",
    ).toContain("columnOwned: res.columnOwned");
  });
});
