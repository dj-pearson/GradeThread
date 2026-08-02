// US-2381 AC5 — a projection helper must never lose its last caller quietly.
//
// THE DEFECT THIS EXISTS FOR. Two projection helpers had exactly one caller,
// `item-canvas.tsx`. When that component was deleted they kept their full unit
// test coverage and went on passing, so nothing anywhere reported that the
// behaviour they implement — a blanked column clearing its eBay specific — had
// stopped happening on web. They were replaced by the spec-aware projection and
// deleted on 2026-08-01; this guard is what makes the NEXT one loud instead.
// A second orphan from the same deletion (PhotoManager's `dirtyRef`) went
// unnoticed the same way, and no check here could have caught it: an optional
// prop nobody passes is not a broken anything.
//
// WHY THIS GUARD IS NARROW. A repo-wide "exported but uncalled" check produces
// mostly legitimate hits — public API, test seams, deliberate re-exports — and
// a check that cries wolf gets an allowlist entry per failure until it means
// nothing. Compare `scripts/audit-unwired-exports.mjs`, which is deliberately a
// REPORT and not a gate for exactly that reason. This one covers a single
// module's aspect-projection helpers, where "no caller" is genuinely a defect.
//
// WHY THE ALLOWLIST HAS TO CARRY A REASON. An entry is a claim someone made on
// purpose, and the reason is what makes it reviewable later. Silently skipping
// would make this one more guard that passes for the wrong reason — see
// vault/70-agent/guards-that-cannot-fail.md.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const MODULE = "src/lib/ebay-prefill.ts";

/** Production sources: no tests, and not the defining module itself. */
function productionFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.tsx?$/.test(p))
    .filter((p) => !p.startsWith("test") && !p.includes("__tests__"))
    .map((p) => `src/${p.split("\\").join("/")}`)
    .filter((p) => p !== MODULE);
}

/**
 * Helpers that only earn their keep by being CALLED from a real surface.
 * Every one of these writes or rewrites an aspect map that gets persisted, so
 * an uncalled one is a behaviour the product silently stopped having.
 */
const PROJECTION_EXPORTS = [
  "projectColumnAspectsForSpec",
  "reverseProjectAspectColumns",
] as const;

/**
 * Deliberately uncalled, with the reason. An entry here is a decision, not a
 * silencer — if the reason has stopped being true, delete the export instead of
 * the failure.
 */
const ALLOWED_WITHOUT_CALLER: Partial<
  Record<(typeof PROJECTION_EXPORTS)[number], string>
> = {
  // Empty on purpose. The two helpers that were allow-listed here —
  // projectColumnAspects and projectAttributeAspects — were DELETED on
  // 2026-08-01 rather than left dormant, once the owner's rule was clear:
  // superseded code goes, unless another platform depends on it at runtime.
  // Neither did; iOS and Android carry their own copies of the spec-less shape.
  // An empty allowlist is the healthy state, and adding an entry should feel
  // like a decision rather than a formality.
};

describe("aspect-projection helpers keep a production caller (US-2381 AC5)", () => {
  const files = productionFiles();
  const sources = files.map((p) => ({
    path: p,
    text: readFileSync(resolve(process.cwd(), p), "utf8"),
  }));

  for (const name of PROJECTION_EXPORTS) {
    it(`${name} is called from production code, or allow-listed with a reason`, () => {
      const callers = sources
        .filter((f) => new RegExp(`\\b${name}\\s*\\(`).test(f.text))
        .map((f) => f.path);
      const reason = ALLOWED_WITHOUT_CALLER[name];

      if (reason) {
        // An allow-listed helper that regained a caller means the entry is
        // stale. Failing here is the point: the note must come back out.
        expect(
          callers,
          `${name} is allow-listed as uncalled but IS called by ${callers.join(", ")}. ` +
            `Remove its ALLOWED_WITHOUT_CALLER entry.`,
        ).toEqual([]);
        expect(reason.length).toBeGreaterThan(80);
        return;
      }

      expect(
        callers.length,
        `${name} is exported from ${MODULE} and nothing in src/ calls it. ` +
          `Either wire it up, delete it, or add an ALLOWED_WITHOUT_CALLER entry ` +
          `saying why it is deliberately dormant.`,
      ).toBeGreaterThan(0);
    });
  }

  it("the allowlist only names helpers this guard actually checks", () => {
    // Otherwise a renamed export leaves a stale entry behind that reads as
    // coverage while covering nothing.
    for (const key of Object.keys(ALLOWED_WITHOUT_CALLER)) {
      expect(PROJECTION_EXPORTS).toContain(key);
    }
  });

  it("every checked name is still exported by the module", () => {
    // A rename would otherwise turn every check into a vacuous pass.
    const text = readFileSync(resolve(process.cwd(), MODULE), "utf8");
    for (const name of PROJECTION_EXPORTS) {
      expect(text, `${MODULE} no longer exports ${name}`).toContain(
        `export function ${name}`,
      );
    }
  });
});
