import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * US-2904: a mirrored table that no screen reads is generated dead code, and
 * every guard around it passes.
 *
 * scripts/generate-swift-mirrors.mjs writes four tables out of TypeScript into
 * Swift, and `--check` runs in `npm run verify` AND in CI so they cannot drift.
 * That machinery says nothing about whether anything READS them. Measured
 * 2026-08-30: three of the four types were mentioned in no file but their own.
 * The parity checks were green the whole time, which is the point - a mirror is
 * exactly as useful as its reader, and the drift check cannot tell the
 * difference between a table in use and a table nobody opens.
 *
 * This is the same failure check-ios-orphans.mjs exists for, one level up, and
 * that check cannot see it: its rule is "declared and never mentioned ANYWHERE,
 * not even in its own file", chosen deliberately because the looser rule cries
 * wolf on every sheet a view presents inline. A generated table is mentioned by
 * its own generated entries, so it clears that bar while being just as dead.
 *
 * ⚠ A REFERENCE IS NOT REACHABILITY. HelpSlug is read by HelpSheet, so it
 * passes here - and HelpSheet is opened by HelpButton, which check-ios-orphans
 * lists as unreachable. This test proves a table has a reader, not that a user
 * can get to it. Do not read a pass as "the feature works".
 */

const ROOT = process.cwd();
const IOS = join(ROOT, "ios", "GradeThread");

/**
 * Mirror id -> the Swift type its table fills.
 *
 * Hand-listed against MIRRORS in scripts/generate-swift-mirrors.mjs, and the
 * count is asserted below so a fifth mirror cannot arrive without a decision
 * about who reads it.
 */
const MIRRORED_TYPES: Record<string, string> = {
  surfaces: "ProductSurface",
  "product-terms": "ProductTerm",
  "activation-events": "ActivationEvent",
  "help-slugs": "HelpSlug",
};

/**
 * Mirrors that no screen reads yet, each with the reason and the story.
 *
 * SHRINK-ONLY, like ALLOWED in check-ios-orphans.mjs: an entry that stops
 * matching fails this test, so ground gained cannot be given back quietly.
 * Adding an entry means writing down that a table is generated, parity-checked
 * on every push, and read by nothing.
 */
const NO_READER_YET: Record<string, string> = {
  ProductSurface:
    "UNREACHABLE (US-2865). The product-surface list the iOS Tools screen was " +
    "to be built from. The table landed; the screen did not.",
  ProductTerm:
    "UNREACHABLE (US-2864 AC6 / US-2904). The in-app glossary. Every definition " +
    "is generated and parity-checked, and no view presents one, so the words " +
    "GradeThread invented are still taught on iOS by being clicked. Note this " +
    "is NOT caught by check-ios-orphans: the type is mentioned by its own " +
    "generated entries, which clears that check's single-mention bar.",
  ActivationEvent:
    "UNREACHABLE (US-2884). The activation funnel's event names. Telemetry.event " +
    "takes a raw String on iOS, and no call site uses this enum - which is the " +
    "exact typo risk the mirror was built to remove, still live.",
};

function swiftFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) swiftFiles(p, out);
    else if (entry.endsWith(".swift")) out.push(p);
  }
  return out;
}

/** Files, other than the one that declares it, that name this type. */
function readersOf(type: string): string[] {
  const pattern = new RegExp(`\\b${type}\\b`);
  const declares = new RegExp(`\\b(struct|class|enum)\\s+${type}\\b`);
  const readers: string[] = [];
  for (const file of swiftFiles(IOS)) {
    const text = readFileSync(file, "utf8");
    if (declares.test(text)) continue;
    if (pattern.test(text)) readers.push(relative(ROOT, file));
  }
  return readers;
}

describe("every mirrored table has a reader (US-2904)", () => {
  it("covers every mirror the generator declares", () => {
    const generator = readFileSync(
      join(ROOT, "scripts", "generate-swift-mirrors.mjs"),
      "utf8",
    );
    const ids = [...generator.matchAll(/^\s{4}id: "([^"]+)",$/gm)].map(
      (m) => m[1],
    );
    expect(
      ids.sort(),
      "a mirror was added to the generator and not to MIRRORED_TYPES, so " +
        "nothing asks whether anything reads it - which is the whole failure " +
        "this test exists for",
    ).toEqual(Object.keys(MIRRORED_TYPES).sort());
  });

  for (const [id, type] of Object.entries(MIRRORED_TYPES)) {
    it(`${id} -> ${type}`, () => {
      const readers = readersOf(type);
      if (NO_READER_YET[type]) {
        expect(
          readers,
          `${type} is listed as having no reader, and now ${readers.join(", ")} ` +
            "reads it. Delete the NO_READER_YET entry in the same commit that " +
            "wired it up - a stale reason is worse than none, because the next " +
            "reader believes it.",
        ).toEqual([]);
        return;
      }
      expect(
        readers.length,
        `${type} is generated from TypeScript and parity-checked on every push, ` +
          "and no Swift file outside its own declaration mentions it. That is " +
          "dead code with a green guard around it. Wire it to a screen, or add " +
          "it to NO_READER_YET with the reason and the story.",
      ).toBeGreaterThan(0);
    });
  }
});
