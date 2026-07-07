// US-1711: brand-knowledge resolver — pure assembly/budget + DB-first fallback.
//
// brand-knowledge.ts imports the service-role supabase client at module init,
// so set env BEFORE the dynamic import. We point SUPABASE_URL at a dead host so
// every DB read fails fast and the resolver deterministically exercises the
// in-code FALLBACK path (independent of whether a local stack is running).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

const {
  assembleBrandKnowledgePack,
  resolveBrandKnowledgePack,
  clearBrandKnowledgeCache,
} = await import("../lib/brand-knowledge.ts");
import type { AssembleInput } from "../lib/brand-knowledge.ts";
import type { SizingChart } from "../lib/sizing-charts.ts";

// ── fixtures ────────────────────────────────────────────────────────────────
function chart(
  department: string,
  garment: string,
  cats: string[],
): SizingChart {
  return {
    brand: "Lululemon",
    brandMatch: ["lululemon", "lulu"],
    department,
    garment,
    categoryMatch: cats,
    rows: [{ size: "M", measurements: { waist: "30" } }],
  };
}

function baseInput(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    canonical: "Lululemon",
    key: "lululemon",
    known: true,
    category: null,
    brandRow: null,
    styleRows: [],
    decoderRows: [],
    colorwayRows: [],
    dbCharts: [],
    fallbackCharts: [],
    ...over,
  };
}

// ── pure assembly: budget caps ──────────────────────────────────────────────
Deno.test("assemble caps styles at 8, colorways at 8, charts at 3", () => {
  const styleRows = Array.from({ length: 20 }, (_, i) => ({
    style_name: `Style ${i}`,
    aliases: null,
    product_line: null,
    department: null,
    category: null,
    visual_fingerprint: null,
    fabric_tech: null,
    era: null,
    msrp_band: null,
    keywords: null,
  }));
  const colorwayRows = Array.from({ length: 20 }, (_, i) => ({
    color_name: `Color ${i}`,
    aliases: null,
    hex: null,
    years: null,
  }));
  const dbCharts = Array.from(
    { length: 10 },
    (_, i) => chart("Women", `Chart ${i}`, ["x"]),
  );

  const pack = assembleBrandKnowledgePack(
    baseInput({ styleRows, colorwayRows, dbCharts }),
  );
  assertEquals(pack.styles.length, 8);
  assertEquals(pack.colorways.length, 8);
  assertEquals(pack.sizingCharts.length, 3);
  assertEquals(pack.source, "db");
});

// ── pure assembly: category ranks matching styles first ─────────────────────
Deno.test("assemble ranks category-matching styles ahead of others", () => {
  const styleRows = [
    {
      style_name: "Metal Vent Tech",
      aliases: null,
      product_line: null,
      department: "Men",
      category: "top",
      visual_fingerprint: null,
      fabric_tech: null,
      era: null,
      msrp_band: null,
      keywords: ["tee", "top"],
    },
    {
      style_name: "ABC Pant",
      aliases: null,
      product_line: null,
      department: "Men",
      category: "pant",
      visual_fingerprint: null,
      fabric_tech: null,
      era: null,
      msrp_band: null,
      keywords: ["abc", "pant", "trouser"],
    },
  ];
  const pack = assembleBrandKnowledgePack(
    baseInput({ styleRows, category: "pant" }),
  );
  assertEquals(pack.styles[0].styleName, "ABC Pant");
});

// ── pure assembly: source classification ────────────────────────────────────
Deno.test("assemble source: fallback / mixed / db", () => {
  // no DB rows, only fallback charts → fallback
  const fb = assembleBrandKnowledgePack(
    baseInput({ fallbackCharts: [chart("Women", "Bottoms", ["pant"])] }),
  );
  assertEquals(fb.source, "fallback");
  assertEquals(fb.sizingCharts.length, 1);

  // DB style rows present but charts fell back → mixed
  const mixed = assembleBrandKnowledgePack(baseInput({
    styleRows: [{
      style_name: "Align",
      aliases: null,
      product_line: null,
      department: "Women",
      category: "legging",
      visual_fingerprint: null,
      fabric_tech: null,
      era: null,
      msrp_band: null,
      keywords: null,
    }],
    fallbackCharts: [chart("Women", "Bottoms", ["pant"])],
  }));
  assertEquals(mixed.source, "mixed");

  // DB charts present → db
  const db = assembleBrandKnowledgePack(
    baseInput({ dbCharts: [chart("Women", "Bottoms", ["pant"])] }),
  );
  assertEquals(db.source, "db");
});

// ── pure assembly: category narrows charts, else whole pool ─────────────────
Deno.test("assemble narrows charts by category, keeps pool when no match", () => {
  const charts = [
    chart("Women", "Bottoms", ["pant", "legging"]),
    chart("Women", "Tops", ["top", "bra"]),
  ];
  const narrowed = assembleBrandKnowledgePack(
    baseInput({ dbCharts: charts, category: "legging" }),
  );
  assertEquals(narrowed.sizingCharts.length, 1);
  assertEquals(narrowed.sizingCharts[0].garment, "Bottoms");

  const noMatch = assembleBrandKnowledgePack(
    baseInput({ dbCharts: charts, category: "hat" }),
  );
  assertEquals(noMatch.sizingCharts.length, 2); // whole pool
});

// ── resolver: blank brand → null ────────────────────────────────────────────
Deno.test("resolve returns null for blank brand", async () => {
  clearBrandKnowledgeCache();
  assertEquals(await resolveBrandKnowledgePack(""), null);
  assertEquals(await resolveBrandKnowledgePack(null), null);
  assertEquals(await resolveBrandKnowledgePack("   "), null);
});

// ── resolver: DB unreachable → fallback pack (no regression) ─────────────────
Deno.test("resolve degrades to in-code fallback when DB is unreachable", async () => {
  clearBrandKnowledgeCache();
  // Lululemon is a known brand with seeded charts; with the DB dead, the pack
  // must still carry the canonical brand + the in-code sizing charts.
  const pack = await resolveBrandKnowledgePack("lululemon", {
    category: "legging",
  });
  assert(pack !== null);
  assertEquals(pack!.brand, "Lululemon");
  assertEquals(pack!.key, "lululemon");
  assertEquals(pack!.known, true);
  assertEquals(pack!.source, "fallback");
  assert(pack!.sizingCharts.length > 0, "fallback charts should be present");
  // No DB → no styles/decoders/colorways (these have no in-code seed).
  assertEquals(pack!.styles.length, 0);
  assertEquals(pack!.decoders.length, 0);
});

// ── resolver: unknown brand still resolves (passthrough), just no known flag ─
Deno.test("resolve passes through an unknown brand", async () => {
  clearBrandKnowledgeCache();
  const pack = await resolveBrandKnowledgePack("Some Obscure Label");
  assert(pack !== null);
  assertEquals(pack!.brand, "Some Obscure Label");
  assertEquals(pack!.known, false);
});

// ── resolver: cache returns the same instance until cleared ─────────────────
Deno.test("resolve caches the pack per (brand, category)", async () => {
  clearBrandKnowledgeCache();
  const a = await resolveBrandKnowledgePack("lululemon", {
    category: "legging",
  });
  const b = await resolveBrandKnowledgePack("lululemon", {
    category: "legging",
  });
  assert(a === b, "second call should hit the cache (same object)");
  const c = await resolveBrandKnowledgePack("lululemon", {
    category: "legging",
    noCache: true,
  });
  assert(c !== a, "noCache should bypass the cache");
});
