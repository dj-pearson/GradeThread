// US-3283: the readable projection of a size chart.
//
// The claims that matter are all about NOT LOSING and NOT INVENTING. A guide
// that drops a footwear chart's UK column has lost the only thing a UK buyer
// needed; a guide that rewrites "US 8 / UK 12" into "8" has invented a claim
// the brand never made. Both are silent failures — the table still renders.

import { assertEquals } from "@std/assert";
import { buildSizeGuide } from "../lib/size-guide.ts";
import type { SizingChart } from "../lib/sizing-charts.ts";

function chart(over: Partial<SizingChart> = {}): SizingChart {
  return {
    brand: "Lululemon",
    brandMatch: ["lululemon"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top"],
    rows: [
      { size: "S", measurements: { chest: "35-37", waist: "29-31" } },
      { size: "M", measurements: { chest: "38-40", waist: "32-34" } },
    ],
    ...over,
  };
}

Deno.test("columns come out in the order the chart introduces them", () => {
  const guide = buildSizeGuide(chart(), "brand");
  assertEquals(guide?.columns.map((c) => c.key), ["chest", "waist"]);
  assertEquals(guide?.columns.map((c) => c.label), ["Chest", "Waist"]);
});

Deno.test("cells are printed verbatim, never parsed", () => {
  const guide = buildSizeGuide(
    chart({
      rows: [{ size: "8", measurements: { us: "8", uk: "12", eu: "40 / 41" } }],
    }),
    "brand",
  );
  assertEquals(guide?.rows[0]?.values, { us: "8", uk: "12", eu: "40 / 41" });
});

Deno.test("a column the band table cannot use is still a column", () => {
  // The whole reason this module exists: buildSizeBands drops `us`, `uk` and
  // `footLength` is the only numeric it keeps, so a footwear chart projected
  // through the band table alone is an empty grid.
  const guide = buildSizeGuide(
    chart({
      garment: "Footwear (US/UK/EU)",
      rows: [{ size: "US 9", measurements: { us: "9", uk: "8", eu: "42.5", footLength: "10.6" } }],
    }),
    "brand",
  );
  assertEquals(guide?.columns.map((c) => c.key), ["us", "uk", "eu", "footLength"]);
  // Only real body measurements carry a band key; a US size is not one.
  assertEquals(guide?.columns.map((c) => c.bandKey), [null, null, null, null]);
});

Deno.test("chest and waist carry their band keys so the item can be placed", () => {
  const guide = buildSizeGuide(chart(), "brand");
  assertEquals(guide?.columns.map((c) => c.bandKey), ["chest", "waist"]);
});

Deno.test("a hip column normalises to the hip band key under either spelling", () => {
  const guide = buildSizeGuide(
    chart({ rows: [{ size: "M", measurements: { hips: "38-40" } }] }),
    "brand",
  );
  assertEquals(guide?.columns[0]?.bandKey, "hip");
  // The LABEL normalises too — "Hips" and "Hip" as two headers on one table
  // would read as two different measurements.
  assertEquals(guide?.columns[0]?.label, "Hip");
});

Deno.test("row prose becomes a footnote, not a column of sentences", () => {
  const guide = buildSizeGuide(
    chart({
      rows: [
        {
          size: "M",
          measurements: { chest: "38-40", note: "The run skips 35 and 37." },
        },
      ],
    }),
    "brand",
  );
  assertEquals(guide?.columns.map((c) => c.key), ["chest"]);
  assertEquals(guide?.rows[0]?.footnote, "The run skips 35 and 37.");
});

Deno.test("descriptive keys sort after the measurements", () => {
  const guide = buildSizeGuide(
    chart({
      rows: [
        { size: "One", measurements: { material: "Leather", width: "12", height: "8" } },
      ],
    }),
    "brand",
  );
  assertEquals(guide?.columns.map((c) => c.key), ["width", "height", "material"]);
});

Deno.test("an unknown key gets a readable label and keeps its unit", () => {
  const guide = buildSizeGuide(
    chart({ rows: [{ size: "One", measurements: { strap_drop_in: "21" } }] }),
    "brand",
  );
  assertEquals(guide?.columns[0]?.label, "Strap drop (in)");
});

Deno.test("a chart with nothing printable returns null rather than an empty grid", () => {
  assertEquals(buildSizeGuide(chart({ rows: [] }), "brand"), null);
  assertEquals(
    buildSizeGuide(chart({ rows: [{ size: "M", measurements: {} }] }), "brand"),
    null,
  );
});

Deno.test("basis and tier are carried through, and absent basis reads as body", () => {
  assertEquals(buildSizeGuide(chart(), "verified")?.tier, "verified");
  assertEquals(buildSizeGuide(chart(), "brand")?.measurementBasis, "body");
  assertEquals(
    buildSizeGuide(chart({ measurementBasis: "flat" }), "brand")?.measurementBasis,
    "flat",
  );
});
