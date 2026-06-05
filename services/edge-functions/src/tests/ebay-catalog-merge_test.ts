// eBay → FlipDesk catalog merge: title overwrite-if-different, brand/size/etc.
// fill-if-blank. Pure module — no env needed.
import { assert, assertEquals } from "@std/assert";
import {
  buildCatalogPatch,
  flattenAspects,
  type LocalCatalog,
  pickAspect,
} from "../lib/ebay-catalog-merge.ts";

const EMPTY: LocalCatalog = {
  title: null,
  brand: null,
  size: null,
  color: null,
  style: null,
  material: null,
};

Deno.test("title: overwrites when eBay differs", () => {
  const patch = buildCatalogPatch(
    { ...EMPTY, title: "Old Title" },
    { title: "New eBay Title", specifics: {} },
  );
  assertEquals(patch.title, "New eBay Title");
});

Deno.test("title: no-op when identical (ignoring whitespace)", () => {
  const patch = buildCatalogPatch(
    { ...EMPTY, title: "Nike Tee" },
    { title: "  Nike Tee  ", specifics: {} },
  );
  assertEquals(patch.title, undefined);
});

Deno.test("title: never blanked when eBay title is empty/missing", () => {
  const patch = buildCatalogPatch(
    { ...EMPTY, title: "Keep Me" },
    { title: "", specifics: {} },
  );
  assertEquals(patch.title, undefined);
  assertEquals("title" in patch, false);
});

Deno.test("fill-if-blank: fills only empty cells, never overwrites set ones", () => {
  const local: LocalCatalog = {
    title: "T",
    brand: "Nike", // already set — must NOT be overwritten
    size: null, // blank — should fill
    color: "   ", // whitespace = blank — should fill
    style: null,
    material: null,
  };
  const patch = buildCatalogPatch(local, {
    title: "T",
    specifics: {
      Brand: "Adidas",
      Size: "M",
      Color: "Red",
      Style: "Crewneck",
      Material: "Cotton",
    },
  });
  assertEquals(patch.brand, undefined); // preserved
  assertEquals(patch.size, "M");
  assertEquals(patch.color, "Red");
  assertEquals(patch.style, "Crewneck");
  assertEquals(patch.material, "Cotton");
  assertEquals(patch.title, undefined);
});

Deno.test("no-op when everything is populated and title matches", () => {
  const local: LocalCatalog = {
    title: "T",
    brand: "Nike",
    size: "M",
    color: "Red",
    style: "Crew",
    material: "Cotton",
  };
  const patch = buildCatalogPatch(local, {
    title: "T",
    specifics: { Brand: "X", Size: "X", Color: "X", Style: "X", Material: "X" },
  });
  assertEquals(Object.keys(patch).length, 0);
});

Deno.test("pickAspect: case-insensitive + variant fallbacks", () => {
  assertEquals(pickAspect({ BRAND: "Levi's" }, "brand"), "Levi's");
  assertEquals(pickAspect({ Colour: "Blue" }, "color"), "Blue");
  assertEquals(pickAspect({ "Fabric Type": "Denim" }, "material"), "Denim");
  assertEquals(pickAspect({ "Women's Size": "8" }, "size"), "8");
});

Deno.test("pickAspect: 'Size Type' must not satisfy size", () => {
  // Only "Size Type" present — it's Regular/Plus/Petite, not the numeric size.
  assertEquals(pickAspect({ "Size Type": "Regular" }, "size"), null);
  // But when both exist, the real Size wins.
  assertEquals(
    pickAspect({ "Size Type": "Regular", Size: "10" }, "size"),
    "10",
  );
});

Deno.test("pickAspect: blank specific value returns null", () => {
  assertEquals(pickAspect({ Brand: "   " }, "brand"), null);
  assertEquals(pickAspect({}, "brand"), null);
});

Deno.test("flattenAspects: first non-empty value per name", () => {
  const flat = flattenAspects({
    Brand: ["Nike"],
    Color: ["", "Red"],
    Size: [],
    Material: ["  Cotton  "],
  });
  assertEquals(flat.Brand, "Nike");
  assertEquals(flat.Color, "Red");
  assertEquals("Size" in flat, false);
  assertEquals(flat.Material, "Cotton");
  assert(!("Size" in flat));
});
