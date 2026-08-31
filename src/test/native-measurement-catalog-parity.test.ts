import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEASUREMENT_TEMPLATES } from "@/lib/measurement-templates";

// US-2812: the iOS and Android measurement catalogs against the web templates.
//
// NOTHING HELD THESE TOGETHER and they had drifted badly.
// `MeasurementCatalogTest.kt` asserts the Kotlin catalog's own hardcoded list
// back to itself, which is self-consistency rather than parity — it passes
// whatever the catalog says. `measurement-template-parity.test.ts` compares the
// web to the EDGE and says nothing about Swift or Kotlin.
//
// What that cost, found by an owner-requested listing dive:
//   bags        native offered length+width; the web asks for width, height,
//               depth and two drops, and marks the first three REQUIRED because
//               depth is what separates a tote from a clutch (US-2225).
//   accessories native dropped `hole_span`, the belt's first-to-last-hole span
//               and the third number a belt is sold on (US-2224).
//   headwear    NO BRANCH AT ALL, so a hat fell through to the clothing default
//               and was offered a chest, a sleeve and an inseam. Harmless until
//               US-2797 made `headwear` a producible item_category — before
//               that, no item could carry the value.
//
// Eight keys the web templates use were also absent from both native catalogs
// entirely, so even a server-sent value rendered with an auto-derived label:
// "Hole Span" instead of "First to last hole (belts)".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY CLOTHING IS NOT CHECKED, and it is a real asymmetry rather than a gap
//
// The web resolves clothing FIVE ways — top / bottom / dress / outerwear / suit
// — by ranking a GARMENT word off the row (`garmentDescriptorFor`). The native
// `suggestedKeys` takes only the coarse `item_category`, and `clothing` cannot
// tell a blazer from jeans. Offering the union of garment fields is the honest
// answer there, and a guard demanding the web's five groups would be demanding
// information the caller does not have. Asserted below as an explicit skip so
// the exemption is visible rather than silently absent.

const ROOT = process.cwd();
const IOS = "ios/GradeThread/Inventory/ItemCanvas/MeasurementCatalog.swift";
const ANDROID =
  "android/app/src/main/java/com/gradethread/app/inventory/MeasurementCatalog.kt";
const IOS_DRAFT = "ios/GradeThread/Inventory/ItemCanvas/ItemDraft.swift";
const ANDROID_DRAFT =
  "android/app/src/main/java/com/gradethread/app/inventory/ItemDraft.kt";

const read = (rel: string) =>
  readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n?/g, "\n");

/**
 * Just the measurement catalog out of a native file, which may hold other types
 * beside it. Everything from the file's start up to the next top-level type
 * declaration after `MeasurementCatalog` — that is the whole catalog and nothing
 * that merely lives next to it.
 */
function catalogSection(rel: string): string {
  const src = read(rel);
  const start = src.search(/\b(enum|object)\s+MeasurementCatalog\b/);
  if (start === -1) throw new Error(`${rel} no longer declares MeasurementCatalog`);
  const after = src.slice(start);
  // The next declaration that starts at column zero ends the catalog.
  const end = after.search(/\n(?:\/\/\/[^\n]*\n)*(?:enum|struct|final class|class|object|extension|internal object)\s+\w/);
  return end === -1 ? after : after.slice(0, end);
}

/**
 * item_category → the web MEASUREMENT_TEMPLATES group it must match.
 *
 * Only the categories where the mapping is 1:1. `clothing` is deliberately
 * absent (see the header) and `other` maps to `generic`, which the native
 * catalogs spell as length+width.
 */
const CATEGORY_TO_GROUP: Record<string, keyof typeof MEASUREMENT_TEMPLATES> = {
  shoes: "shoes",
  watches: "watch",
  bags: "bag",
  accessories: "accessory",
  headwear: "headwear",
  other: "generic",
};

/** Keys the native switch returns for one `case "<category>"`. */
function nativeKeys(src: string, category: string, lang: "swift" | "kotlin"): string[] {
  const re = lang === "swift"
    ? new RegExp(`case[^\\n]*"${category}"[^\\n]*:\\s*\\n\\s*return \\[([^\\]]*)\\]`)
    : new RegExp(`"${category}"[^\\n]*->\\s*listOf\\(([^)]*)\\)`);
  const m = re.exec(src);
  const body = m?.[1];
  if (!body) return [];
  return [...body.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
}

/** Every key the native catalog defines a Spec for. */
function nativeSpecKeys(src: string, lang: "swift" | "kotlin"): Set<string> {
  const re = lang === "swift"
    ? /Spec\(key: "([a-z_]+)"/g
    : /Spec\("([a-z_]+)"/g;
  return new Set([...src.matchAll(re)].map((m) => m[1]!));
}

/** Every native Spec, with the label and unit it actually renders. */
function nativeSpecs(
  src: string,
  lang: "swift" | "kotlin",
): Map<string, { label: string; unit: string }> {
  // US-2976 (e0253a37b) split the Android label into a wire value and a
  // localized display resource, so the Kotlin Spec gained a third argument:
  //   Spec("chest", "Chest (pit to pit)", R.string.measurement_chest, Kind.LENGTH)
  // The `label` this file compares against the web is still the SECOND
  // argument, which is the English wire value both platforms key on. The
  // `R.string` reference is what a Spanish reader actually sees and is checked
  // by the Android localization guards, not here.
  const re =
    lang === "swift"
      ? /Spec\(key: "([a-z_]+)", label: "([^"]*)", kind: \.([a-z]+)\)/g
      : /Spec\("([a-z_]+)", "([^"]*)", R\.string\.[a-z_]+, Kind\.([A-Z]+)\)/g;
  return new Map(
    [...src.matchAll(re)].map((m) => [m[1]!, { label: m[2]!, unit: m[3]!.toLowerCase() }]),
  );
}

describe("US-2812: the native measurement catalogs match the web templates", () => {
  const cases: Array<[string, string, "swift" | "kotlin"]> = [
    ["iOS", IOS, "swift"],
    ["Android", ANDROID, "kotlin"],
  ];

  it.each(cases)("%s offers the right keys per category", (_name, rel, lang) => {
    const src = read(rel);

    // Guards the guard: a renamed switch or Spec constructor would make every
    // assertion below vacuous by returning empty arrays that "match" nothing.
    expect(nativeSpecKeys(src, lang).size, "no Spec entries parsed").toBeGreaterThan(10);
    expect(nativeKeys(src, "shoes", lang), "the shoes branch did not parse").toEqual([
      "size_us",
      "insole",
    ]);

    for (const [category, group] of Object.entries(CATEGORY_TO_GROUP)) {
      const want = MEASUREMENT_TEMPLATES[group].map((f) => f.key);
      const got = nativeKeys(src, category, lang);
      expect(
        got,
        `${category}: the web '${group}' template has [${want.join(", ")}] and this ` +
          `catalog offers [${got.join(", ")}]. Mirror the web list — these are the ` +
          `fields a buyer asks for, and a category with no branch falls through to ` +
          `the clothing default, which is how a hat came to be offered an inseam.`,
      ).toEqual(want);
    }
  });

  it.each(cases)("%s defines a Spec for every key it offers", (_name, rel, lang) => {
    // A key with no Spec still renders — label() de-underscores and kind()
    // defaults to length — so this never crashes and never looks broken. It
    // just loses the curated label, and "Hole Span" does not tell a seller what
    // to measure the way "First to last hole (belts)" does.
    const src = read(rel);
    const specs = nativeSpecKeys(src, lang);
    const offered = new Set(
      Object.keys(CATEGORY_TO_GROUP).flatMap((c) => nativeKeys(src, c, lang)),
    );
    const missing = [...offered].filter((k) => !specs.has(k));
    expect(missing, `offered with no Spec entry: ${missing.join(", ")}`).toEqual([]);
  });

// The label is the entire reason the Spec table exists, and the test above
  // only proves an entry is PRESENT. A Spec reading "Cap height" where the web
  // reads "Crown height" satisfies every assertion up to this point.
  //
  // Scoped to the six routed categories, and within them exactly ONE key is
  // ambiguous: the web calls a bag's `width` "Width (base)" and an accessory's
  // plain "Width". The native table is keyed by key ALONE and structurally
  // cannot hold both, so it is named here rather than skipped quietly.
  const ROUTED_LABEL_EXCEPTIONS = ["width"];

  it.each(cases)("%s uses the web's exact label for every unambiguous key", (_n, rel, lang) => {
    const specs = nativeSpecs(read(rel), lang);
    expect(specs.size, "no Spec entries parsed").toBeGreaterThan(10);

    const byKey = new Map<string, Set<string>>();
    for (const group of Object.values(CATEGORY_TO_GROUP)) {
      for (const f of MEASUREMENT_TEMPLATES[group]) {
        const labels = byKey.get(f.key) ?? new Set<string>();
        labels.add(f.label);
        byKey.set(f.key, labels);
      }
    }

    expect(
      [...byKey].filter(([, l]) => l.size > 1).map(([k]) => k).sort(),
      "a routed key gained a second web label. The native table is keyed by key " +
        "alone and cannot hold two, so decide which wording the phones show " +
        "before adding it to ROUTED_LABEL_EXCEPTIONS.",
    ).toEqual(ROUTED_LABEL_EXCEPTIONS);

    for (const [key, labels] of byKey) {
      if (ROUTED_LABEL_EXCEPTIONS.includes(key)) continue;
      const want = [...labels][0]!;
      expect(
        specs.get(key)?.label,
        `${key}: the web renders "${want}". A near-miss here is invisible in ` +
          `review and wrong in the seller's hand.`,
      ).toBe(want);
    }
  });

  it.each(cases)("%s uses the web's unit for every key it defines", (_n, rel, lang) => {
    // Unit is unambiguous per key across EVERY group, routed or not, so this
    // reaches the clothing Specs the label check has to leave alone.
    const specs = nativeSpecs(read(rel), lang);
    const webUnit = new Map<string, string>();
    for (const fields of Object.values(MEASUREMENT_TEMPLATES)) {
      for (const f of fields) webUnit.set(f.key, f.unit);
    }

    const wrong = [...specs]
      .filter(([k]) => webUnit.has(k))
      .filter(([k, s]) => s.unit !== webUnit.get(k))
      .map(([k, s]) => `${k}: native ${s.unit}, web ${webUnit.get(k)}`);
    expect(
      wrong,
      `unit drift picks the wrong input control (a millimetre field asking for ` +
        `inches): ${wrong.join("; ")}`,
    ).toEqual([]);
  });

  it("required-ness is web-only, and the phones lose it", () => {
    // The web marks a bag's width, height and depth REQUIRED because depth is
    // what separates a tote from a clutch (US-2225). Neither native Spec
    // carries a required flag, so both phones offer all three as equally
    // optional and a seller can skip the one that matters.
    //
    // Asserted rather than commented so it cannot rot: if someone adds the
    // flag natively this fails, and the fix is to extend the parity check
    // above to cover it, not to delete this case.
    expect(MEASUREMENT_TEMPLATES.bag.filter((f) => f.required).map((f) => f.key)).toEqual([
      "width",
      "height",
      "depth",
    ]);
    for (const rel of [IOS, ANDROID]) {
      // Scoped to the CATALOG, not the whole file. US-2920 added a SizeCheck
      // type alongside the catalog in both native files, and its prose uses the
      // ordinary English word ("the steps needed before a note fires"), which a
      // whole-file scan read as the catalog growing a required flag. The
      // property this case owns is about the measurement Spec, so it looks at
      // the Spec — a guard that fires on a comment three hundred lines away is
      // a guard people learn to route around.
      expect(catalogSection(rel), `${rel} now knows about required fields`)
        .not.toMatch(/required/i);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // EVERY MEASUREMENT MUST BE A NUMBER, and this is a data-loss guard rather
  // than a style rule.
  //
  // US-2796 AC1 asks the shoes template to capture a size SCALE alongside
  // size_us — US men's, US women's, UK, EU or JP. A scale is a STRING, and
  // both phones store measurements as a numeric map. Measured 2026-08-23:
  //
  //   Android  ItemDraft.measurements is Map<String, Double>, and
  //            MeasurementCatalog.decode keeps a key only when
  //            jsonPrimitive.doubleOrNull is non-null and > 0. A string value
  //            is DROPPED. encode then writes back only what survived, so a
  //            round trip through the phone DELETES the field.
  //   iOS      worse, and not by a little. ItemDraft.measurements is
  //            [String: Double] and decodeMeasurements is
  //            `try? JSONDecoder().decode([String: Double].self, …)`. One
  //            non-numeric value makes the WHOLE decode throw, `try?` turns
  //            that into nil, and `?? [:]` leaves an EMPTY map — so a single
  //            string scale makes every other measurement on the item vanish
  //            from the canvas.
  //
  // So the field US-2796 AC1 describes cannot live in `measurements` as
  // written. It is not a missing picker; it is silent deletion on one client
  // and total loss on the other. The scale belongs in
  // inventory_items.attributes, beside shoe_width and shoe_shaft_height,
  // which are already canonical shoe attributes with eBay aspect mappings and
  // no numeric coupling.
  //
  // This case exists so that constraint is enforced rather than remembered.
  // The parity guard above REQUIRES the natives to mirror every template key,
  // so without this a new string field would be dutifully copied into both
  // numeric catalogs and the loss would ship looking like parity.

  /**
   * The units a phone can actually store, READ OFF THE PHONE.
   *
   * ⚠ NOT A HAND-WRITTEN LIST, and the first draft was one. Sabotage widening
   * it to ["length","shoe","mm","scale"] and adding a scale field would have
   * turned the guard green and shipped the loss — the allowlist was the easiest
   * thing to change when the guard complained, which is the wrong incentive to
   * leave lying around.
   *
   * Parsed from the Kotlin `enum class Kind(val unit: String)`, which is the
   * thing that imposes the constraint. Widening it now means widening the
   * phone's own catalog, which is exactly the conversation this should force.
   */
  const NUMERIC_UNITS = (() => {
    const kt = read(ANDROID);
    const block = kt.slice(kt.indexOf("enum class Kind"), kt.indexOf("data class Spec"));
    const members = [...block.matchAll(/^\s*([A-Z_]+)\("([^"]*)"\)/gm)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(members.length, "the Kotlin Kind enum did not parse").toBeGreaterThan(2);
    return members;
  })();

  it("the derived unit list matches the web's own union type", () => {
    // Both sides of the mirror, so a unit added to one and not the other is a
    // failure here rather than a silent mismatch at runtime.
    const web = read("src/lib/measurement-templates.ts");
    const union = /export type MeasurementUnit =([^;]+);/.exec(web)?.[1] ?? "";
    const webUnits = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(
      webUnits.slice().sort(),
      "MeasurementUnit and the Kotlin Kind enum disagree about what a " +
        "measurement can be. Adding a unit to the web without a matching Kind " +
        "means the phones cannot render or store it.",
    ).toEqual(NUMERIC_UNITS.slice().sort());
  });

  it("no template field asks for a value the phones cannot store", () => {
    const offenders = Object.entries(MEASUREMENT_TEMPLATES).flatMap(([group, fields]) =>
      fields
        .filter((f) => !NUMERIC_UNITS.includes(f.unit))
        .map((f) => `${group}.${f.key} (unit: ${f.unit})`),
    );
    expect(
      offenders,
      "a measurement template field uses a non-numeric unit. Both phones store " +
        "measurements as a numeric map: Android DROPS the key on decode and " +
        "writes back without it, and iOS fails the whole decode and shows an " +
        "EMPTY measurement set. Put the value in inventory_items.attributes " +
        "instead, where shoe_width and shoe_shaft_height already live.",
    ).toEqual([]);
  });

  it("the phones really do still store measurements as numbers", () => {
    // Guards the guard. The case above is only worth having while the native
    // maps are numeric; if someone widens them, this fails and points at the
    // rule to revisit rather than leaving a stale prohibition in place.
    // The STORED PROPERTY, not any occurrence of the type. ItemDraft.swift
    // also names it in the memberwise initialiser's default, so a check for
    // the bare string passed while the property itself had changed.
    expect(
      /\bvar measurements:\s*\[String:\s*Double\]/.test(read(IOS_DRAFT)),
      "the iOS draft no longer STORES measurements as [String: Double]",
    ).toBe(true);
    expect(
      read(ANDROID_DRAFT),
      "the Android draft no longer stores measurements as Map<String, Double>",
    ).toContain("val measurements: Map<String, Double>");
  });

  it("clothing is exempt on purpose, not by omission", () => {
    // If someone adds a clothing branch to CATEGORY_TO_GROUP, this fails and
    // makes them read the header first. The web's five clothing groups need a
    // garment word; suggestedKeys only has the coarse item_category.
    expect(Object.keys(CATEGORY_TO_GROUP)).not.toContain("clothing");
    expect(Object.keys(MEASUREMENT_TEMPLATES)).toEqual(
      expect.arrayContaining(["top", "bottom", "dress", "outerwear", "suit"]),
    );
  });
});
