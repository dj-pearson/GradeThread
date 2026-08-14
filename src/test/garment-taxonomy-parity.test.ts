// US-2571: the garment taxonomy is copied into six files and drifted in five.
//
// src/lib/constants.ts is the SOURCE. The edge is a separate Deno project and
// genuinely cannot import it, so the copies are legitimate — but US-2224 added
// `neckwear` and `gloves` to the source (migration 00570) and to nothing else.
// In ai-extract.ts that list is the JSON-schema enum for the model's answer, so
// the extractor was FORBIDDEN from returning either value and a tie came back
// as "other".
//
// This guard DISCOVERS the copies rather than listing them: any file under src/
// or services/edge-functions/src/ that declares a `GARMENT_CATEGORIES` or
// `GARMENT_TYPES` array literal is compared to the source. A seventh copy added
// tomorrow is caught the day it is written, which listing the six known ones
// would not do.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { GARMENT_CATEGORIES, GARMENT_TYPES } from "@/lib/constants";

const ROOT = process.cwd();
const SCAN_ROOTS = ["src", join("services", "edge-functions", "src")];

// The source of truth, and this file, are not copies of themselves.
const NOT_A_COPY = ["src/lib/constants.ts", "src/test/garment-taxonomy-parity.test.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments carry example lists and old values; a guard that reads them lies. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

interface Copy {
  file: string;
  name: "GARMENT_CATEGORIES" | "GARMENT_TYPES";
  values: string[];
}

function findCopies(): Copy[] {
  const copies: Copy[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(join(ROOT, scanRoot))) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (NOT_A_COPY.includes(rel)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      const decl =
        /const (GARMENT_CATEGORIES|GARMENT_TYPES)\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g;
      for (const match of source.matchAll(decl)) {
        const values = [...(match[2] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
        copies.push({ file: rel, name: match[1] as Copy["name"], values });
      }
    }
  }
  return copies;
}

const COPIES = findCopies();

describe("garment taxonomy parity (US-2571)", () => {
  it("finds the copies it is meant to be guarding", () => {
    // If a refactor deletes every copy this test passes vacuously, which is the
    // one way a parity guard can rot without anyone noticing.
    const files = [...new Set(COPIES.map((c) => c.file))];
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain("services/edge-functions/src/lib/ai-extract.ts");
  });

  it("every copy of GARMENT_CATEGORIES matches src/lib/constants.ts", () => {
    const drifted = COPIES.filter((c) => c.name === "GARMENT_CATEGORIES").flatMap((c) =>
      JSON.stringify(c.values) === JSON.stringify([...GARMENT_CATEGORIES])
        ? []
        : [
            `${c.file}: missing [${GARMENT_CATEGORIES.filter(
              (v) => !c.values.includes(v),
            ).join(", ")}] extra [${c.values
              .filter((v) => !(GARMENT_CATEGORIES as readonly string[]).includes(v))
              .join(", ")}]`,
          ],
    );
    expect(
      drifted,
      "These files carry a stale copy of the garment taxonomy. In ai-extract.ts " +
        "the list is the model's JSON-schema enum, so a missing value is a value " +
        "the extractor is forbidden to return.",
    ).toEqual([]);
  });

  it("every copy of GARMENT_TYPES matches src/lib/constants.ts", () => {
    const drifted = COPIES.filter((c) => c.name === "GARMENT_TYPES")
      .filter((c) => JSON.stringify(c.values) !== JSON.stringify([...GARMENT_TYPES]))
      .map((c) => c.file);
    expect(drifted).toEqual([]);
  });

  it("the GarmentCategory database type covers the same values", () => {
    const union = readFileSync(join(ROOT, "src/types/database.ts"), "utf8");
    const body = stripComments(union).match(
      /export type GarmentCategory\s*=([\s\S]*?);/,
    )?.[1];
    expect(body, "GarmentCategory union not found in src/types/database.ts").toBeTruthy();
    const values = [...body!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect([...values].sort()).toEqual([...GARMENT_CATEGORIES].sort());
  });

  it("the submission form's type groups offer every category exactly once", () => {
    // The picker narrows categories by garment type, so a category missing from
    // every group is unreachable in the UI even though the enum accepts it —
    // the same defect as the extractor enum, one layer up.
    const form = stripComments(
      readFileSync(join(ROOT, "src/components/submission/garment-info-form.tsx"), "utf8"),
    );
    const map = form.match(/CATEGORY_BY_TYPE[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1];
    expect(map, "CATEGORY_BY_TYPE not found").toBeTruthy();
    const offered = [...map!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    const missing = GARMENT_CATEGORIES.filter((c) => !offered.includes(c));
    expect(
      missing,
      "These categories exist in the taxonomy but no garment type offers them, " +
        "so a seller cannot pick one.",
    ).toEqual([]);
    // Each group is also a partition: a category in two groups means the picker
    // shows it twice and the two paths can disagree about what it means.
    expect(offered.length).toBe(new Set(offered).size);
  });
});
