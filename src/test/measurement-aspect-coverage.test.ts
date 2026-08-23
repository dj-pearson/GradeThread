import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEASUREMENT_SPECS } from "@/lib/measurements";
import { MEASUREMENT_TEMPLATES } from "@/lib/measurement-templates";

// US-2813: the form asks for 24 measurements and the aspect map covers 16.
//
// A seller measures a bag's depth, a belt's hole span or a hat's inside
// circumference, the value lands on inventory_items.measurements, and
// resolveMeasurementAspects has nothing to match it to. It never reaches a
// listing. Silent in both directions: nothing errors, and the seller sees the
// number they typed sitting on the item.
//
// WHY THIS FILE EXISTS RATHER THAN THE MAPPING ITSELF. The mapping needs real
// eBay Taxonomy data for the bag, belt and hat categories, and the story is
// explicit that guessing is worse than the gap: an aspect NAME candidate is
// inert if the category does not expose it, but a wrong mapping publishes a
// VALUE under a name that means something else. So the gap stays, named, and
// this makes it visible on every platform instead of one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT WAS ACTUALLY UNGUARDED, measured 2026-08-23 rather than assumed
//
// Three copies of this mapping exist and all three agreed by luck:
//   web    MEASUREMENT_SPECS in src/lib/measurements.ts
//   edge   the same block in services/edge-functions/src/lib/measurements.ts,
//          byte-identical, in files that are otherwise different sizes
//   phone  MeasurementCatalog.aspectCandidates in the Android catalog
//
// Only ONE thing in the repo noticed the gap at all: MeasurementCatalogTest.kt's
// `noAspectYet`, which is shrink-only on Android. So mapping a key on the web
// and not on Android, or the reverse, would have gone unnoticed, and the web
// could gain a 25th unmapped template key with nothing to say so.
//
// iOS has no aspect table by design and is not checked here. Its prefill is
// server-driven (see the aspect-registry header) so there is nothing to drift.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n?/g, "\n");

const EDGE_MEASUREMENTS = "services/edge-functions/src/lib/measurements.ts";
const ANDROID_CATALOG =
  "android/app/src/main/java/com/gradethread/app/inventory/MeasurementCatalog.kt";
const ANDROID_TEST =
  "android/app/src/test/java/com/gradethread/app/inventory/MeasurementCatalogTest.kt";

/**
 * The eight keys the form asks for that no eBay aspect is known for.
 *
 * SHRINK-ONLY. An entry that gains a mapping must be REMOVED here, or the list
 * becomes the place unmapped keys go to be forgotten. The companion case below
 * fails on an entry that starts resolving, exactly like the Android one.
 */
const NO_ASPECT_YET = [
  "brim_length",
  "circumference",
  "crown_height",
  "depth",
  "handle_drop",
  "height",
  "hole_span",
  "strap_drop",
] as const;

/** `{ "key" to listOf("A", "B") }` out of the Kotlin catalog. */
function androidAspectCandidates(): Map<string, string[]> {
  const src = read(ANDROID_CATALOG);
  const start = src.indexOf("val aspectCandidates");
  expect(start, "aspectCandidates is gone from the Android catalog").toBeGreaterThan(-1);
  const end = src.indexOf("\n    )", start);
  const block = src.slice(start, end);
  const out = new Map<string, string[]>();
  for (const m of block.matchAll(/"([a-z_]+)"\s+to\s+listOf\(([^)]*)\)/g)) {
    out.set(m[1]!, [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
  }
  return out;
}

/** The braced MEASUREMENT_SPECS object literal out of a measurements.ts. */
function specsBlock(src: string): string {
  const i = src.indexOf("export const MEASUREMENT_SPECS");
  expect(i, "MEASUREMENT_SPECS declaration not found").toBeGreaterThan(-1);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  throw new Error("MEASUREMENT_SPECS literal never closed");
}

describe("US-2813: every measurement the form asks for reaches an aspect, or is named", () => {
  const templateKeys = [
    ...new Set(Object.values(MEASUREMENT_TEMPLATES).flat().map((f) => f.key)),
  ].sort();

  it("the form asks for more than the aspect map covers, and by exactly this list", () => {
    // Guards the guard: if the templates ever parse to almost nothing, the
    // "unmapped" set below is empty for the wrong reason and everything passes.
    expect(templateKeys.length).toBeGreaterThan(20);
    expect(Object.keys(MEASUREMENT_SPECS).length).toBeGreaterThan(10);

    const unmapped = templateKeys
      .filter((k) => (MEASUREMENT_SPECS[k]?.aspects?.length ?? 0) === 0)
      .sort();
    expect(
      unmapped,
      "a measurement the form asks for reaches no eBay aspect and is not named in " +
        "NO_ASPECT_YET. Either map it in MEASUREMENT_SPECS (both copies) and in the " +
        "Android catalog, or add it here with the reason. A key in neither place is " +
        "collected from the seller and silently dropped at publish.",
    ).toEqual([...NO_ASPECT_YET]);
  });

  it("the exemption can only shrink", () => {
    // An entry that starts resolving must be removed, so the list cannot
    // quietly become a dumping ground. Mirrors the Android case exactly.
    const nowMapped = NO_ASPECT_YET.filter(
      (k) => (MEASUREMENT_SPECS[k]?.aspects?.length ?? 0) > 0,
    );
    expect(
      nowMapped,
      `mapped now, so remove from NO_ASPECT_YET: ${nowMapped.join(", ")}`,
    ).toEqual([]);
  });

  it("every exempt key is one the form actually asks for", () => {
    // The other direction: an entry for a key no template offers is dead weight
    // that makes the gap look larger than it is.
    const notAsked = NO_ASPECT_YET.filter((k) => !templateKeys.includes(k));
    expect(notAsked, `exempt but never asked for: ${notAsked.join(", ")}`).toEqual([]);
  });

  it("the web and Android agree about which keys are exempt", () => {
    // THE HOLE THIS FILE WAS WRITTEN FOR. Android's noAspectYet was the only
    // thing tracking the gap, so mapping a key on one platform and not the
    // other left two lists disagreeing with nothing to say so.
    const src = read(ANDROID_TEST);
    const start = src.indexOf("private val noAspectYet");
    expect(start, "noAspectYet is gone from MeasurementCatalogTest.kt").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf(")", start));
    const androidExempt = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();

    expect(
      androidExempt,
      "the Android exemption list and the web one have diverged. They describe " +
        "the same gap in the same eight measurements, so a key mapped on one " +
        "platform and not the other is a listing that fills a specific on a phone " +
        "and not on the web.",
    ).toEqual([...NO_ASPECT_YET]);
  });
});

describe("US-2813: the three copies of the aspect map agree", () => {
  it("the web and edge MEASUREMENT_SPECS blocks are identical", () => {
    // The FILES differ (14.7KB vs 18.8KB) and the block does not. Nothing
    // checked that, and the edge copy is the one that fills aspects at publish
    // while the web copy is what the composer shows the seller.
    const web = specsBlock(read("src/lib/measurements.ts"));
    const edge = specsBlock(read(EDGE_MEASUREMENTS));
    expect(web.length).toBeGreaterThan(500);
    expect(
      edge,
      "MEASUREMENT_SPECS has drifted between the web and the edge. The edge copy " +
        "decides what a publish actually fills; the web copy decides what the " +
        "composer tells the seller it will fill.",
    ).toBe(web);
  });

  it("the Android catalog carries the same keys and the same aspect names, in order", () => {
    const android = androidAspectCandidates();
    expect(android.size).toBeGreaterThan(10);

    const web = new Map(
      Object.entries(MEASUREMENT_SPECS).map(([k, s]) => [k, s.aspects]),
    );
    expect([...android.keys()].sort(), "Android maps a different set of keys").toEqual(
      [...web.keys()].sort(),
    );

    for (const [key, aspects] of web) {
      expect(
        android.get(key),
        `${key}: Android offers different aspect candidates than the web. Order is ` +
          `preference order, so a reordering is a real difference in which specific ` +
          `gets filled first.`,
      ).toEqual(aspects);
    }
  });
});
