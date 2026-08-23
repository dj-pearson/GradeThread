import { assertEquals } from "@std/assert";
import { resolveShoeSizeScale } from "../lib/shoe-size-scale.ts";
import { SIZING_CHARTS } from "../lib/sizing-charts.ts";
import {
  inferDepartment,
  resolveDepartment,
  resolveItemAspects,
  type RegistryAspect,
  type RegistryItem,
} from "../lib/aspect-registry.ts";
import { detectSizeSystem } from "../lib/size-systems.ts";
import { shoeSizeToUsMen } from "../lib/parcel-estimate.ts";

// US-2796 AC1 producer. The assertions below name brands on purpose: the whole
// value of this module is that it reads a CURATED answer, so a test of a made-up
// brand would prove only that the control flow runs.

Deno.test("US-2796: a US brand is answered by the item's department", () => {
  assertEquals(resolveShoeSizeScale("New Balance", "Men"), "us_men");
  assertEquals(resolveShoeSizeScale("New Balance", "Women"), "us_women");
  // 22 of 26 footwear brands look like this, which is why the department is a
  // parameter rather than something read off the chart.
  assertEquals(resolveShoeSizeScale("UGG", "Women"), "us_women");
  assertEquals(resolveShoeSizeScale("Brooks", "Men"), "us_men");
});

Deno.test("US-2796: a US brand with no department refuses rather than assuming men's", () => {
  // This is the failure the story exists to stop, so it must not be answered by
  // a default. Null puts the caller back on today's behaviour.
  assertEquals(resolveShoeSizeScale("New Balance", null), null);
  assertEquals(resolveShoeSizeScale("New Balance", "Unisex Adult"), null);
  assertEquals(resolveShoeSizeScale("New Balance", "Boys"), null);
  assertEquals(resolveShoeSizeScale("New Balance", "Kids"), null);
});

Deno.test("US-2796: a non-US stamping is answered by the brand, department or not", () => {
  // Dr. Martens stamps UK on the women's last too, so the department must NOT
  // move this answer.
  assertEquals(resolveShoeSizeScale("Dr. Martens", null), "uk");
  assertEquals(resolveShoeSizeScale("Dr. Martens", "Women"), "uk");
  assertEquals(resolveShoeSizeScale("Dr. Martens", "Men"), "uk");
  assertEquals(resolveShoeSizeScale("Birkenstock", null), "eu");
  assertEquals(resolveShoeSizeScale("Birkenstock", "Women"), "eu");
});

Deno.test("US-2796: a dual-stamped brand is refused, and that is the right answer", () => {
  // Crocs prints "M4 / W6" on the same shoe. There is no single scale, and the
  // chart's own scope line says "dual US M/W".
  assertEquals(resolveShoeSizeScale("Crocs", "Men"), null);
  assertEquals(resolveShoeSizeScale("Crocs", "Women"), null);

  const crocs = SIZING_CHARTS.find((c) => c.brandMatch.some((m) => m.includes("crocs")));
  assertEquals(detectSizeSystem(crocs!), null, "Crocs labels announce no single system");
});

Deno.test("US-2796: a brand with no footwear chart is refused, not guessed", () => {
  assertEquals(resolveShoeSizeScale("Levi's", "Men"), null);
  assertEquals(resolveShoeSizeScale("NoSuchBrandAtAll", "Men"), null);
  assertEquals(resolveShoeSizeScale("", "Men"), null);
  assertEquals(resolveShoeSizeScale(null, "Men"), null);
  assertEquals(resolveShoeSizeScale("   ", "Men"), null);
});

Deno.test("US-2796: an apparel chart never answers a shoe's scale", () => {
  // THE CASE ABOVE DOES NOT PROVE THIS, which is why this one exists. Levi's
  // jeans labels are "W30 L32", so detectSizeSystem returns null for them and
  // the function refuses one step later whether the footwear filter is there or
  // not. Deleting the filter left every assertion above green.
  //
  // These six brands are the ones where the filter is actually load-bearing:
  // each has an apparel chart written in a system detectSizeSystem DOES read,
  // and none of them has a footwear chart. Without the filter, a Zara shoe
  // would be told its stamped number is EU because Zara's dress chart is.
  const wouldAnswer: Array<[string, string]> = [
    ["Zara", "EU"],
    ["H&M", "EU"],
    ["BAPE", "JP"],
    ["Sweaty Betty", "UK"],
    ["Tory Burch", "US"],
    ["Reformation", "US"],
  ];
  const FOOT = /shoe|boot|sneaker|footwear|sandal|heel|loafer|clog/i;

  for (const [brand, system] of wouldAnswer) {
    const charts = SIZING_CHARTS.filter((c) =>
      c.brandMatch.some((m) => brand.toLowerCase().includes(m)),
    );
    // Guards the guard, twice over: the brand must still HAVE charts, they must
    // still be readable as a system, and none may be footwear. If any of those
    // stops holding, this case is no longer testing the filter and says so
    // rather than passing quietly.
    assertEquals(charts.length > 0, true, `${brand} has no charts at all any more`);
    assertEquals(
      charts.filter((c) => FOOT.test(c.garment) || c.categoryMatch.some((m) => FOOT.test(m))),
      [],
      `${brand} now has a footwear chart, so it is a real answer rather than a trap`,
    );
    const systems = new Set(charts.map((c) => detectSizeSystem(c)));
    assertEquals(
      [...systems],
      [system],
      `${brand}'s apparel charts no longer read as ${system}, so dropping the ` +
        `footwear filter would no longer be caught by this brand`,
    );

    for (const dep of ["Men", "Women", null]) {
      assertEquals(
        resolveShoeSizeScale(brand, dep),
        null,
        `${brand} answered a shoe scale from an apparel chart (dep=${dep})`,
      );
    }
  }
});

Deno.test("US-2796: no brand's footwear charts disagree today, and one day one might", () => {
  // resolveShoeSizeScale refuses when a brand's footwear charts read as more
  // than one system. NOTHING IN THE CORPUS EXERCISES THAT: all 26 footwear
  // brands are internally consistent, so the check can be deleted and every
  // other case stays green. Sabotage proved it.
  //
  // Asserted as the precondition instead. The day a brand's charts disagree,
  // this fails and the fix is to assert the refusal directly for that brand.
  const FOOT = /shoe|boot|sneaker|footwear|sandal|heel|loafer|clog/i;
  const byBrand = new Map<string, ReturnType<typeof detectSizeSystem>[]>();
  for (const c of SIZING_CHARTS) {
    if (c.brandMatch.length === 0) continue;
    if (!FOOT.test(c.garment) && !c.categoryMatch.some((m) => FOOT.test(m))) continue;
    const a = byBrand.get(c.brand) ?? [];
    a.push(detectSizeSystem(c));
    byBrand.set(c.brand, a);
  }
  assertEquals(byBrand.size > 20, true, `only ${byBrand.size} footwear brands parsed`);

  const disagreeing = [...byBrand]
    .filter(([, systems]) => new Set(systems).size > 1)
    .map(([b, systems]) => `${b}: ${[...new Set(systems)].join("/")}`);
  assertEquals(
    disagreeing,
    [],
    "a brand's footwear charts now read as two systems, which finally makes the " +
      "systems.size check in resolveShoeSizeScale load-bearing. Replace this " +
      "assertion with a direct one: that brand must resolve to null.",
  );
});

Deno.test("US-2796: the generic-chart fallback cannot leak, and will say when it can", () => {
  // findSizingCharts returns the GENERIC pool when a brand has none of its own,
  // and resolveShoeSizeScale drops it by requiring brandMatch.length > 0.
  //
  // THAT FILTER IS CURRENTLY UNTESTABLE, and the first version of this case
  // pretended otherwise: all three generic charts are apparel (women's tops &
  // dresses, men's tops, men's pants), so nothing reaches the footwear filter
  // whether the brand guard is there or not. A case asserting the refusal would
  // have passed with the guard deleted.
  //
  // So this asserts the PRECONDITION instead. The day someone adds a generic
  // footwear chart, this fails and points at the case below it, which is the
  // one that becomes real at that moment.
  const generic = SIZING_CHARTS.filter((c) => c.brandMatch.length === 0);
  assertEquals(generic.length > 0, true, "no generic charts at all; the fallback is gone");

  const FOOT = /shoe|boot|sneaker|footwear|sandal|heel|loafer|clog/i;
  const genericFootwear = generic.filter(
    (c) => FOOT.test(c.garment) || c.categoryMatch.some((m) => FOOT.test(m)),
  );
  assertEquals(
    genericFootwear.map((c) => c.garment),
    [],
    "a generic footwear chart now exists, so the brandMatch filter in " +
      "resolveShoeSizeScale is finally load-bearing. Delete this assertion and " +
      "assert the refusal directly: resolveShoeSizeScale('NoSuchBrand', 'Women') " +
      "must still be null.",
  );

  // True either way today, and worth keeping as the statement of intent.
  assertEquals(resolveShoeSizeScale("NoSuchBrandAtAll", "Women"), null);
});

Deno.test("US-2796: every brand this answers is answered consistently across its charts", () => {
  // A sweep rather than a sample: whatever the corpus grows to, a brand may not
  // start returning two different scales for the same department.
  const FOOT = /shoe|boot|sneaker|footwear|sandal|heel|loafer|clog/i;
  const brands = new Set(
    SIZING_CHARTS.filter(
      (c) =>
        c.brandMatch.length > 0 &&
        (FOOT.test(c.garment) || c.categoryMatch.some((m) => FOOT.test(m))),
    ).map((c) => c.brand),
  );
  assertEquals(brands.size > 20, true, `only ${brands.size} footwear brands parsed`);

  const answered: string[] = [];
  for (const b of brands) {
    for (const dep of ["Men", "Women", null]) {
      const scale = resolveShoeSizeScale(b, dep);
      if (scale === null) continue;
      answered.push(`${b}/${dep}`);
      assertEquals(
        ["us_men", "us_women", "uk", "eu", "jp"].includes(scale),
        true,
        `${b} returned ${scale}`,
      );
      // A department-free answer must be non-US, or the department was ignored.
      if (dep === null) {
        assertEquals(
          scale === "uk" || scale === "eu" || scale === "jp",
          true,
          `${b} answered ${scale} with no department, which means a US scale was assumed`,
        );
      }
    }
  }
  assertEquals(answered.length > 40, true, `only ${answered.length} brand/department answers`);
});

Deno.test("US-2796: the Dr. Martens half-size gap is real and is not silently widening", () => {
  // The module header says the generic table lands half a size low for
  // Dr. Martens. That claim is load-bearing (it is why "uk" is an improvement
  // and not a fix), so it is measured here rather than asserted in prose.
  const dm = SIZING_CHARTS.find((c) => c.brandMatch.some((m) => m.includes("martens")));
  assertEquals(dm !== undefined, true, "the Dr. Martens chart is gone");

  let rows = 0;
  for (const r of dm!.rows) {
    const uk = Number((r.size.match(/UK\s*([\d.]+)/) ?? [])[1]);
    const chartUsMen = Number((r.size.match(/US\s*M\s*([\d.]+)/) ?? [])[1]);
    if (!Number.isFinite(uk) || !Number.isFinite(chartUsMen)) continue;
    rows++;
    const generic = shoeSizeToUsMen(uk, "uk");
    assertEquals(
      chartUsMen - (generic ?? 0),
      0.5,
      `UK ${uk}: the chart says US M${chartUsMen}, the generic table says ${generic}. ` +
        `The gap was 0.5 on every row when this was written; if it moved, the header ` +
        `note and the choice of returning a scale instead of a number both need a look.`,
    );
  }
  assertEquals(rows, 10, `parsed ${rows} Dr. Martens rows, expected 10`);
});

// ───────────────────────────────────────────────────────────────────────────
// WIRING. A source scan is right for this and wrong for the logic above: the
// question is whether the one producer calls the resolver at all, and that is
// not reachable from a unit test - predictedParcel is private and needs a
// database row.

Deno.test("US-2796: the parcel route is the one producer, and it feeds the scale", async () => {
  const route = await Deno.readTextFile("src/routes/flipdesk-logistics.ts");

  assertEquals(
    route.includes(
      'import { resolveShoeSizeScale } from "../lib/shoe-size-scale.ts";',
    ),
    true,
    "flipdesk-logistics no longer imports the resolver",
  );
  assertEquals(
    /sizeScale: resolveShoeSizeScale\(/.test(route),
    true,
    "estimateParcel is called without a resolved sizeScale, which puts every " +
      "shoe back on the read-it-as-US-men's assumption",
  );
  assertEquals(
    /resolveDepartment\(/.test(route),
    true,
    "the department is no longer resolved, so 22 of 26 footwear brands resolve to null",
  );

  // THE SILENT FAILURE THIS EXISTS FOR. resolveShoeSizeScale returns null for a
  // null brand, so narrowing the select back to its old four columns would not
  // throw, would not fail a type check, and would turn the whole feature off
  // while every case above stayed green.
  const select = route.match(/\.select\(\s*\n?\s*"([^"]*brand[^"]*)"/);
  assertEquals(
    select !== null,
    true,
    "the inventory_items select in predictedParcel no longer names the brand " +
      "column. The resolver would be handed null forever and answer null forever.",
  );
  // `attributes` matters as much as `brand`: it is where the capture pass
  // writes a stated department, and resolveDepartment prefers it over the text.
  for (const column of [
    "brand",
    "title",
    "style",
    "description",
    "condition_notes",
    "attributes",
  ]) {
    assertEquals(
      select![1].includes(column),
      true,
      "the select dropped " + column + ", which inferDepartment reads",
    );
  }
});

Deno.test("US-2796: estimateParcel has exactly one edge caller", async () => {
  // Pins the claim the case above rests on. A second edge caller that forgets
  // the scale is how this regresses without either file being touched.
  const paths: string[] = [];
  for (const dir of ["src/routes", "src/lib"]) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".ts")) paths.push(dir + "/" + entry.name);
    }
  }
  assertEquals(paths.length > 50, true, "only " + paths.length + " edge sources scanned");

  const callers: string[] = [];
  for (const p of paths) {
    if (p.endsWith("parcel-estimate.ts")) continue; // its own definition
    const text = await Deno.readTextFile(p);
    if (/\bestimateParcel\(/.test(text)) callers.push(p);
  }
  assertEquals(
    callers,
    ["src/routes/flipdesk-logistics.ts"],
    "estimateParcel gained an edge caller. It must resolve a sizeScale too, or " +
      "it prices a UK-stamped boot as a US men's one.",
  );
});

Deno.test("US-2796: resolveDepartment matches what the aspect resolver fills", () => {
  // TWO PATHS TO ONE ANSWER, pinned together rather than trusted to stay in step.
  // resolveDepartment is canonicalValues' precedence for the department entry
  // lifted out; if the registry's precedence changes and this does not, the
  // parcel path starts disagreeing with the published eBay aspect about which
  // department the item is.
  const aspects: RegistryAspect[] = [
    { name: "Department", mode: "FREE_TEXT", multi: false },
  ];

  const cases: RegistryItem[] = [
    // Stated, and the text says nothing.
    { item_category: "shoes", attributes: { department: "Women" }, title: "New Balance 574" },
    // Stated, and the text DISAGREES. The stated value must win: this is the
    // case that made the change worth making.
    { item_category: "shoes", attributes: { department: "Women" }, title: "Men's New Balance 574" },
    // Nothing stated, inferred from the title.
    { item_category: "shoes", attributes: {}, title: "Women's UGG Classic" },
    // Nothing stated and nothing to infer.
    { item_category: "shoes", attributes: null, title: "New Balance 574" },
    // Stated but blank, which must fall through rather than answer with "".
    { item_category: "shoes", attributes: { department: "   " }, title: "Men's UGG" },
    // Stated as an array, the shape attributes columns actually take.
    { item_category: "shoes", attributes: { department: ["Men"] }, title: "UGG" },
  ];

  for (const item of cases) {
    const filled = resolveItemAspects(item, aspects, {})["Department"]?.[0] ?? null;
    assertEquals(
      resolveDepartment(item),
      filled,
      "resolveDepartment disagrees with the Department aspect for " +
        JSON.stringify(item.attributes) + " / " + item.title,
    );
  }

  // And the specific behaviour the parcel path depends on, asserted directly
  // rather than only through the agreement above - which would pass if BOTH
  // paths regressed the same way.
  assertEquals(
    resolveDepartment({ item_category: "shoes", attributes: { department: "Women" }, title: "Men's New Balance" }),
    "Women",
    "a stated department lost to the title text",
  );
  assertEquals(
    inferDepartment({ item_category: "shoes", title: "Men's New Balance" }),
    "Men",
    "guards the guard: the title above really does infer Men, so the case above is a real conflict",
  );

  // The scale that conflict produces, end to end.
  assertEquals(
    resolveShoeSizeScale(
      "New Balance",
      resolveDepartment({ item_category: "shoes", attributes: { department: "Women" }, title: "Men's New Balance 574" }),
    ),
    "us_women",
  );
});
