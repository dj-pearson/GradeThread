// US-3399: which three size charts reach the grading prompt is a DECISION now,
// not whatever physical order Postgres returned.
//
// Three things are under test and they are separate:
//   1. the read carries a TOTAL order (CHART_ORDER + applyChartOrder),
//   2. the no-category-match branch is ordered by garment FAMILY, because
//      ordering alone made that branch worse,
//   3. the budget spends one slot per department before a second.
//
// The live case at the bottom drives the real assembler over a REAL read. It
// has its OWN env vars on purpose: brand-knowledge_test.ts calls
// Deno.env.set("SUPABASE_URL") at module load, one process shares one env, and
// `ignore` is evaluated at registration, so a live case gated on SUPABASE_URL
// arms or disarms itself depending on which other file loaded first.
import { assert, assertEquals } from "@std/assert";

if (!Deno.env.get("SUPABASE_URL")) {
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
}

const {
  CHART_ORDER,
  applyChartOrder,
  assembleBrandKnowledgePack,
  balanceChartsByDepartment,
  categoryFamily,
  demoteSpecialisedCharts,
  garmentFamilies,
  isSpecialisedChart,
} = await import("../lib/brand-knowledge.ts");
import type { AssembleInput } from "../lib/brand-knowledge.ts";
import type { SizingChart } from "../lib/sizing-charts.ts";

function chart(
  department: string,
  garment: string,
  cats: string[] = [],
  sizeClass?: string,
): SizingChart {
  return {
    brand: "Acme",
    brandMatch: ["acme"],
    department,
    garment,
    categoryMatch: cats,
    rows: [{ size: "M", measurements: { chest: "40" } }],
    ...(sizeClass ? { sizeClass } : {}),
  } as SizingChart;
}

function input(dbCharts: SizingChart[], category: string | null): AssembleInput {
  return {
    canonical: "Acme",
    key: "acme",
    known: true,
    category,
    brandRow: null,
    styleRows: [],
    decoderRows: [],
    colorwayRows: [],
    dbCharts,
    fallbackCharts: [],
  };
}

const chosen = (charts: SizingChart[], category: string | null) =>
  assembleBrandKnowledgePack(input(charts, category)).sizingCharts
    .map((c) => `${c.department}|${c.garment}`);

// ── 1. the read carries a TOTAL order ───────────────────────────────────────

Deno.test("the brand_size_charts read carries a TOTAL order", () => {
  // The last two keys are the point: brand_size_charts_key_idx is UNIQUE on
  // (brand_key, department, garment) and brand_key is pinned by the resolver's
  // .eq, so department + garment cannot tie and the result can never fall back
  // to the heap. Drop either and the order is partial again.
  const columns = CHART_ORDER.map((k) => k.column);
  assertEquals(columns, ["created_at", "verified", "department", "garment"]);
  assertEquals(columns.slice(-2), ["department", "garment"]);
  assertEquals(CHART_ORDER.map((k) => k.ascending), [
    false,
    false,
    true,
    true,
  ]);
});

Deno.test("applyChartOrder emits every key, leftmost first", () => {
  const calls: string[] = [];
  const builder = {
    order(column: string, opts: { ascending: boolean }) {
      calls.push(`${column}:${opts.ascending ? "asc" : "desc"}`);
      return this;
    },
  };
  const out = applyChartOrder(builder);
  assertEquals(out, builder);
  assertEquals(calls, [
    "created_at:desc",
    "verified:desc",
    "department:asc",
    "garment:asc",
  ]);
});

Deno.test("the resolver's brand_size_charts read goes through applyChartOrder", async () => {
  // CHART_ORDER being right buys nothing if the read stops applying it, and the
  // cases above would all stay green. Scoped to the bytes just before the read
  // rather than grepping the file, because applyChartOrder is named in the
  // comments and in its own definition: a whole-file search stays green with
  // the call deleted.
  const src = await Deno.readTextFile(
    new URL("../lib/brand-knowledge.ts", import.meta.url),
  );
  const read = src.indexOf('.from("brand_size_charts")');
  assert(read > 0, "the brand_size_charts read moved or was renamed");
  const call = src.slice(0, read).lastIndexOf("applyChartOrder(");
  assert(
    call > 0 && read - call < 200,
    "the brand_size_charts read is not wrapped in applyChartOrder",
  );
});

// ── 2. family order in the no-category-match branch ─────────────────────────

Deno.test("garmentFamilies reads a garment string, and a chart can be in two", () => {
  assertEquals([...garmentFamilies("Tops (alpha)")], ["tops"]);
  assertEquals([...garmentFamilies("Jeans (waist x inseam)")], ["bottoms"]);
  const both = garmentFamilies("Tops & outerwear (body inches)");
  assert(both.has("tops"));
  assert(both.has("outerwear"));
});

Deno.test("categoryFamily maps the grading categories, and skirt is not shirt", () => {
  assertEquals(categoryFamily("t-shirt"), "tops");
  assertEquals(categoryFamily("hoodie"), "tops");
  assertEquals(categoryFamily("jacket"), "outerwear");
  assertEquals(categoryFamily("jeans"), "bottoms");
  assertEquals(categoryFamily("skirt"), "bottoms");
  assertEquals(categoryFamily("dress"), "dresses");
  assertEquals(categoryFamily("boots"), "footwear");
  // Not a family we hold charts for: the pool must be left alone rather than
  // reordered against a guess.
  assertEquals(categoryFamily("bag"), null);
  assertEquals(categoryFamily(null), null);
});

Deno.test("no category match: the wrong family is DROPPED, not just demoted", () => {
  // Arc'teryx shape: no chart's category_match says "shirt", so the whole pool
  // falls through. Measured before US-3399: two of three slots went to bottoms
  // charts for a shirt. US-3399 sorted them to the back, which still spent the
  // third slot on one; US-3405 removes them, so asserting the WHOLE result is
  // what separates the two.
  const charts = [
    chart("Men", "Bottoms, alpha (body inches)", ["bottom"]),
    chart("Women", "Bottoms, alpha (body inches)", ["bottom"]),
    chart("Men", "Tops", ["top"]),
    chart("Women", "Tops", ["top"]),
  ];
  assertEquals(chosen(charts, "shirt"), ["Men|Tops", "Women|Tops"]);
});

Deno.test("a chart in two families survives both asks", () => {
  // "Tops & outerwear" is the single most common multi-family garment scope in
  // the corpus. Filtering on one family must not drop it from the other.
  const charts = [
    chart("Men", "Tops & outerwear (body inches)", ["top"]),
    chart("Men", "Bottoms (body inches)", ["bottom"]),
  ];
  assertEquals(chosen(charts, "sweater"), ["Men|Tops & outerwear (body inches)"]);
  assertEquals(chosen(charts, "coat"), ["Men|Tops & outerwear (body inches)"]);
  assertEquals(chosen(charts, "skirt"), ["Men|Bottoms (body inches)"]);
});

Deno.test("US-3405 AC3: a brand with nothing in the family still gets the pool", () => {
  // The fallback's whole purpose. A brand that publishes only bottoms charts
  // and is asked about a sweater must still send something: a loosely-matched
  // chart beats an empty answer. Measured over the corpus, zero pools return
  // nothing under the filter.
  const charts = [
    chart("Men", "Bottoms (body inches)", ["bottom"]),
    chart("Women", "Bottoms (body inches)", ["bottom"]),
  ];
  assertEquals(chosen(charts, "sweater"), [
    "Men|Bottoms (body inches)",
    "Women|Bottoms (body inches)",
  ]);
});

Deno.test("no category match and no family: the pool is left exactly as read", () => {
  const charts = [
    chart("Men", "Bottoms", ["bottom"]),
    chart("Women", "Tops", ["top"]),
    chart("Men", "Tops", ["top"]),
    chart("Women", "Bottoms", ["bottom"]),
  ];
  // "bag" is a GARMENT_CATEGORIES value with no chart family. Reordering here
  // would be answering from no evidence.
  assertEquals(chosen(charts, "bag"), [
    "Men|Bottoms",
    "Women|Tops",
    "Men|Tops",
  ]);
});

Deno.test("a category MATCH is not family-sorted: the read order stands", () => {
  const charts = [
    chart("Women", "Bottoms (leggings)", ["short"]),
    chart("Men", "Bottoms (shorts)", ["short"]),
    chart("Men", "Tops", ["top"]),
  ];
  // Both bottoms charts match "shorts", so the category step already answered.
  assertEquals(chosen(charts, "shorts"), [
    "Women|Bottoms (leggings)",
    "Men|Bottoms (shorts)",
  ]);
});

// ── 3. one slot per department before a second ──────────────────────────────

Deno.test("the budget spends one slot per department before a second", () => {
  const charts = [
    chart("Women", "Tops (alpha)"),
    chart("Women", "Tops (numeric)"),
    chart("Women", "Tops, plus"),
    chart("Men", "Tops (alpha)"),
  ];
  assertEquals(balanceChartsByDepartment(charts, 3).map((c) =>
    `${c.department}|${c.garment}`
  ), [
    "Women|Tops (alpha)",
    "Men|Tops (alpha)",
    "Women|Tops (numeric)",
  ]);
});

Deno.test("balancing preserves the read order inside the tail", () => {
  const charts = [
    chart("Women", "A"),
    chart("Women", "B"),
    chart("Women", "C"),
    chart("Men", "D"),
  ];
  assertEquals(balanceChartsByDepartment(charts, 4).map((c) => c.garment), [
    "A",
    "D",
    "B",
    "C",
  ]);
});

Deno.test("balancing is a no-op when nothing is being cut", () => {
  const charts = [chart("Women", "A"), chart("Men", "B")];
  assertEquals(balanceChartsByDepartment(charts, 3).map((c) => c.garment), [
    "A",
    "B",
  ]);
});

Deno.test("every reachable department is represented", () => {
  // Two Men charts FIRST on purpose. A flat slice of the same order reaches
  // Men and Unisex only; that is the case the balance exists for, and a fixture
  // where both answers agree would prove nothing.
  //
  // No Kids chart here, deliberately: US-3406 demotes those, and a fixture
  // mixing the two rules would stop telling you which one failed.
  const charts = [
    chart("Men", "Bottoms (numeric waist)", ["pant", "bottom"]),
    chart("Men", "Bottoms (alpha)", ["pant", "bottom"]),
    chart("Unisex", "Bottoms (body inches)", ["pant", "bottom"]),
    chart("Women", "Bottoms (alpha + US numeric)", ["pant", "bottom"]),
  ];
  assertEquals(chosen(charts, "pants"), [
    "Men|Bottoms (numeric waist)",
    "Unisex|Bottoms (body inches)",
    "Women|Bottoms (alpha + US numeric)",
  ]);
});

// ── US-3406: a narrower population must not LEAD ────────────────────────────

Deno.test("US-3406: a plus chart does not lead, and is not dropped either", () => {
  // Tommy Hilfiger shape. The Curve chart is the most recently sourced row in
  // its pool, so the recency order (US-3399) put it first for an unqualified
  // shirt. It is still in the prompt, labelled, just not leading it.
  const charts = [
    chart("Women", "Curve, tops & bottoms (body inches)", ["top"], "plus"),
    chart("Men", "Tops (alpha)", ["top"]),
    chart("Women", "Tops (alpha/numeric)", ["top"]),
  ];
  assertEquals(chosen(charts, "shirt"), [
    "Men|Tops (alpha)",
    "Women|Tops (alpha/numeric)",
    "Women|Curve, tops & bottoms (body inches)",
  ]);
});

Deno.test("US-3406: a Kids chart does not lead for an adult garment", () => {
  // Johnnie-O shape, and the half no size_class check could catch: "kids" is
  // not a size_class value at all, it is a DEPARTMENT.
  const charts = [
    chart("Kids", "Boys' bottoms (numeric 4-16)", ["bottom"]),
    chart("Men", "Bottoms (numeric waist)", ["bottom"]),
    chart("Women", "Bottoms (alpha)", ["bottom"]),
  ];
  assertEquals(chosen(charts, "pants"), [
    "Men|Bottoms (numeric waist)",
    "Women|Bottoms (alpha)",
    "Kids|Boys' bottoms (numeric 4-16)",
  ]);
});

Deno.test("US-3406: a kids-only brand still leads with its Kids chart", () => {
  // The demotion is not a filter, and this is why it cannot be one: the
  // submission carries no department, so a brand that only makes kidswear must
  // still send what it has. Measured over the corpus, 120 pools are still led
  // by a specialised chart and in all 120 every chart in the set is one.
  const charts = [
    chart("Kids", "Toddler & Kids (2T-5T)", ["top"]),
    chart("Baby", "Baby (MONTHS)", ["top"]),
  ];
  assertEquals(chosen(charts, "shirt"), [
    "Kids|Toddler & Kids (2T-5T)",
    "Baby|Baby (MONTHS)",
  ]);
});

Deno.test("US-3406: an AMBIGUOUS class is not a specialised one", () => {
  // The Talbots chart's scope reads "Misses (US numeric 2-18) / Petite (0P-16P)
  // / Plus (14W-26W)", so detectSizeClass returns null: more than one class.
  // That chart covers the ordinary range too, and demoting it would take the
  // standard sizes down with the plus ones.
  const talbots = chart(
    "Women",
    "Misses (US numeric 2-18) / Petite (0P-16P) / Plus (14W-26W)",
    ["top"],
  );
  assertEquals(isSpecialisedChart(talbots), false);
  assertEquals(isSpecialisedChart(chart("Women", "Tops, plus", ["top"])), true);
  assertEquals(isSpecialisedChart(chart("Kids", "Tops", ["top"])), true);
  assertEquals(isSpecialisedChart(chart("Men", "Tops", ["top"])), false);
});

Deno.test("US-3406: the STORED class wins over the derived one", () => {
  // The whole point of the column. "Curve" is read by the widened patterns now,
  // but a row carrying a class must be believed even when the garment text says
  // nothing a pattern can see.
  const opaque = chart("Women", "Line 7 (body inches)", ["top"], "plus");
  assertEquals(isSpecialisedChart(opaque), true);
  assertEquals(isSpecialisedChart(chart("Women", "Line 7 (body inches)", ["top"])), false);
});

Deno.test("US-3406: demoting is stable, so the read order survives inside each group", () => {
  const charts = [
    chart("Women", "Tops, plus", ["top"], "plus"),
    chart("Men", "Tops A", ["top"]),
    chart("Kids", "Tops", ["top"]),
    chart("Women", "Tops B", ["top"]),
  ];
  assertEquals(demoteSpecialisedCharts(charts).map((c) => c.garment), [
    "Tops A",
    "Tops B",
    "Tops, plus",
    "Tops",
  ]);
});

// ── the SECOND narrower, which had the same defect ──────────────────────────

Deno.test("US-3405: findSizingCharts falls back to the family, not the pool", async () => {
  // brand-knowledge is not the only narrower. ai-size-estimate calls
  // findSizingCharts directly whenever its caller passes no charts, and that
  // feeds the grading size pass, so fixing one and not the other leaves the
  // defect live on a real path.
  const { findSizingCharts } = await import("../lib/sizing-charts.ts");
  const shirt = findSizingCharts("Levi's", "blouse");
  assert(shirt.length > 0, "the fallback must still send something");
  assertEquals(
    shirt.filter((c) => !garmentFamilies(c.garment).has("tops")).map((c) =>
      `${c.department}|${c.garment}`
    ),
    [],
    "a non-tops chart reached a blouse ask",
  );
  // And the other direction, so this is not passing because Levi's is all tops.
  const jeans = findSizingCharts("Levi's", "skirt");
  assert(jeans.length > 0);
  assertEquals(
    jeans.filter((c) => !garmentFamilies(c.garment).has("bottoms")).map((c) =>
      c.garment
    ),
    [],
  );
});

// ── the live case ───────────────────────────────────────────────────────────

const LIVE_URL = Deno.env.get("BRAND_CHART_ORDER_LIVE_URL");
const LIVE_KEY = Deno.env.get("BRAND_CHART_ORDER_LIVE_KEY");

Deno.test({
  name: "LIVE: the ordered read decides which charts reach the prompt",
  ignore: !LIVE_URL || !LIVE_KEY,
  async fn() {
    const { createClient } = await import("@supabase/supabase-js");
    // Its own client, not the module's: see the header note about one process
    // sharing one SUPABASE_URL.
    const db = createClient(LIVE_URL!, LIVE_KEY!);
    const probe = async (brandKey: string, category: string) => {
      const { data, error } = await applyChartOrder(
        db
          .from("brand_size_charts")
          .select(
            "brand_label, brand_match, department, garment, category_match, rows, note, source_url, verified, measurement_basis, size_class",
          )
          .eq("brand_key", brandKey),
      );
      assert(!error, `read failed: ${error?.message}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      assert(rows.length > 3, `${brandKey} must be over budget to test a cut`);
      const dbCharts = rows.map((r): SizingChart => ({
        brand: String(r.brand_label),
        brandMatch: (r.brand_match as string[]) ?? [],
        department: String(r.department),
        garment: String(r.garment),
        categoryMatch: (r.category_match as string[]) ?? [],
        rows: (r.rows as SizingChart["rows"]) ?? [],
        sourceUrl: (r.source_url as string | null) ?? null,
        verified: r.verified === true,
        measurementBasis: r.measurement_basis === "flat" ? "flat" : "body",
        sizeClass: (r.size_class as string | null) ?? undefined,
      }));
      return assembleBrandKnowledgePack(input(dbCharts, category)).sizingCharts;
    };

    // Tommy Hilfiger jeans used to CUT the men's bottoms chart entirely.
    const th = await probe("tommyhilfiger", "jeans");
    assertEquals(th.length, 3);
    assert(
      th.some((c) => c.department === "Men" && /bottom/i.test(c.garment)),
      `men's bottoms chart was cut: ${th.map((c) => c.garment).join(" / ")}`,
    );

    // Arc'teryx has no chart whose category_match says "shirt", so this is the
    // fallback branch: two of three slots used to go to bottoms charts.
    const arc = await probe("arcteryx", "shirt");
    assert(arc.length > 0, "the fallback must still send something");
    assertEquals(
      arc.filter((c) => !garmentFamilies(c.garment).has("tops")).map((c) =>
        c.garment
      ),
      [],
      "US-3405: a bottoms chart reached a shirt ask",
    );

    // Johnnie-O has five charts across three departments and "pants" matches
    // four of them, so this is the MATCHED branch and the only live shape the
    // department balance changes: a flat slice of the same order reaches Kids
    // and Men only.
    const jo = await probe("johnnieo", "pants");
    assertEquals(jo.length, 3);
    assertEquals(new Set(jo.map((c) => c.department)).size, 3);
    // US-3406: and the Kids chart must not be the one it leads with.
    assertEquals(jo[0].department, "Men");

    // US-3406's other measured case. This one needs 00809 applied: without it
    // the row's size_class is NULL and the derivation has to read "Curve".
    const thShirt = await probe("tommyhilfiger", "shirt");
    assert(thShirt.length > 0);
    assert(
      !/curve/i.test(thShirt[0].garment),
      `a plus-size chart led an unqualified shirt: ${thShirt[0].garment}`,
    );
  },
});
