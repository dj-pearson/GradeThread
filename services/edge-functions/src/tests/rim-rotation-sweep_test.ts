// US-3086: the rim decode must not depend on where the OCR started reading.
//
// A size dot's rim is a CIRCLE, so a transcription is a ROTATION of the true
// reading and every rotation is equally true. The unit tests in
// listing-style-code_test.ts pin hand-picked strings against the IN-CODE
// DEFAULT_DECODER_SPECS. Production does not use those: decodeTagCode uses a
// brand's SEEDED specs INSTEAD of the in-code ones the moment the brand has
// any, which is the same gap decoder-seed-parity_test.ts was written for.
//
// So this file sweeps the REAL table. It parses every brand_style_codes tuple
// out of the migrations, builds a pack per brand exactly as assembleBrandKnow-
// ledgePack does from DB rows, and drives resolveListingStyleCode - the whole
// production path, not the decoder underneath it.
//
// The property, in one line: for any string, every rotation of it must produce
// the SAME answer, and "refuse" is an answer.
//
//   deno test --allow-env --allow-read src/tests/rim-rotation-sweep_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { resolveListingStyleCode, decodeRim, rimDecoderSpecs } = await import(
  "../lib/listing-style-code.ts"
);
const { assembleBrandKnowledgePack, decoderSpecsFromPack } = await import(
  "../lib/brand-knowledge.ts"
);

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);

interface SeededRow {
  brandKey: string;
  decoderKind: string;
  description: string | null;
  pattern: string;
  extractionRules: unknown;
  examples: unknown;
}

/**
 * Every `brand_style_codes` tuple across the migrations, LAST definition wins,
 * which is what the database ends up with (each of these migrations carries an
 * `on conflict (brand_key, decoder_kind)` clause).
 *
 * The tuple is `('<brand>', '<kind>', '<desc>', '<pattern>', $j$rules$j$::jsonb,
 * $j$examples$j$::jsonb`. SQL doubles an embedded single quote; none of these
 * patterns contain one. Same parse as decoder-seed-parity_test.ts, carried far
 * enough to reach the examples, which are the readings this file sweeps.
 */
async function seededRows(): Promise<SeededRow[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
  }
  files.sort();

  const rows = new Map<string, SeededRow>();
  const tuple =
    /\('([a-z0-9_]+)',\s*'([a-z0-9_]+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\s*,\s*\$j\$([\s\S]*?)\$j\$::jsonb\s*,\s*\$j\$([\s\S]*?)\$j\$::jsonb/g;
  for (const name of files) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS_DIR));
    if (!sql.includes("insert into public.brand_style_codes")) continue;
    const start = sql.indexOf("insert into public.brand_style_codes");
    const block = sql.slice(start, sql.indexOf(";", start));
    for (const m of block.matchAll(tuple)) {
      let rules: unknown = null;
      let examples: unknown = null;
      try {
        rules = JSON.parse(m[5]!);
        examples = JSON.parse(m[6]!);
      } catch {
        continue;
      }
      rows.set(`${m[1]}|${m[2]}`, {
        brandKey: m[1]!,
        decoderKind: m[2]!,
        description: m[3]!.replace(/''/g, "'"),
        pattern: m[4]!.replace(/''/g, "'"),
        extractionRules: rules,
        examples,
      });
    }
  }
  return [...rows.values()];
}

/** A pack built from the SEEDED rows, which is what production decodes with. */
function packFor(brandKey: string, rows: SeededRow[]) {
  return assembleBrandKnowledgePack({
    canonical: brandKey,
    key: brandKey,
    known: true,
    category: null,
    brandRow: null,
    styleRows: [],
    decoderRows: rows.map((r) => ({
      decoder_kind: r.decoderKind,
      description: r.description,
      pattern: r.pattern,
      extraction_rules: r.extractionRules,
      examples: r.examples,
    })),
    colorwayRows: [],
    dbCharts: [],
    fallbackCharts: [],
  });
}

/** Every distinct rotation of a string, the string itself first. */
function rotations(s: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < s.length; i++) out.add(s.slice(i) + s.slice(0, i));
  return [...out];
}

/**
 * What production concludes about one transcription, flattened to a single
 * comparable token: the code it would file under, or the refusal it reached.
 * Two rotations of one rim must produce the same token or the decode depends on
 * where the camera happened to start.
 */
function answerFor(
  brand: string,
  pack: ReturnType<typeof packFor> | null,
  code: string,
): string {
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: code, confidence: 0.9 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand,
    pack,
  });
  if (r.decoded) return `decoded:${r.styleCodeNorm}`;
  return `refused:${r.rimOutcome ?? "null"}`;
}

function exampleCodes(rows: SeededRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.examples)) continue;
    for (const ex of r.examples) {
      const code = (ex as { code?: unknown } | null)?.code;
      if (typeof code === "string" && code.trim() !== "") out.push(code.trim());
    }
  }
  return out;
}

Deno.test("US-3086: every rotation of a seeded reading gives the SAME answer", async () => {
  const rows = await seededRows();
  // A parser that matched nothing would sweep nothing and pass, which is the
  // failure mode this whole file exists to prevent.
  assert(rows.length > 0, "parsed no brand_style_codes tuples from the migrations");
  const brands = [...new Set(rows.map((r) => r.brandKey))].sort();
  assert(
    brands.includes("lululemon"),
    `the brand this story is about is not in the parsed table: ${brands.join(",")}`,
  );

  let readings = 0;
  let sweptRotations = 0;
  const unstable: string[] = [];
  // The ONE licensed way a rotation may name a different garment: the rotation
  // is itself a complete legal code as transcribed, so nothing ever treated it
  // as a rim. That happens when the brand's shape is closed under rotation
  // (a bare run of digits). The licence is only good if the RIM search still
  // refuses the string, which is the check that keeps this from being a hole.
  const licensed: string[] = [];
  for (const brand of brands) {
    const brandRows = rows.filter((r) => r.brandKey === brand);
    const pack = packFor(brand, brandRows);
    const specs = decoderSpecsFromPack(pack);
    const rimSpecs = rimDecoderSpecs(brand, specs);
    // Only the examples that decode as transcribed are readings with a known
    // identity; anything else has nothing to be invariant ABOUT.
    for (const code of exampleCodes(brandRows)) {
      const base = answerFor(brand, pack, code);
      if (!base.startsWith("decoded:")) continue;
      readings++;
      for (const rot of rotations(code)) {
        sweptRotations++;
        const got = answerFor(brand, pack, rot);
        // A rotation may REFUSE where the transcribed string decoded - a rim
        // read from the wrong start point genuinely carries less evidence. What
        // it may never do is decode to a DIFFERENT garment off the rim search.
        if (!got.startsWith("decoded:") || got === base) continue;
        const rim = decodeRim(brand, rot, rimSpecs, specs);
        if (rim.outcome === "ambiguous" && rim.code === null) {
          licensed.push(`${brand}: "${code}" -> "${rot}" (${got}), rim refuses`);
          continue;
        }
        unstable.push(
          `${brand}: "${code}" (${base}) rotated to "${rot}" -> ${got}` +
            ` [rim said ${rim.outcome}, code ${rim.code}]`,
        );
      }
    }
  }

  // Floors, so a parse that silently narrowed cannot read as a clean sweep.
  assert(readings >= 30, `only ${readings} readings swept; the table has more`);
  assert(sweptRotations >= 200, `only ${sweptRotations} rotations swept`);
  assertEquals(
    unstable,
    [],
    `a rotation decoded to a different garment off the rim search:\n  ` +
      unstable.join("\n  "),
  );
  // Measured 2026-09-11: 39 readings, 309 rotations, 9 licensed (Gucci's six
  // bare digits and Patagonia's five). The number is printed rather than pinned
  // so a new seeded brand does not read as a regression.
  console.log(
    `[US-3086] ${readings} readings, ${sweptRotations} rotations, ` +
      `${licensed.length} licensed by a rotation-closed shape, 0 unstable`,
  );
});

Deno.test("US-3086: a rotation-degenerate shape REFUSES rather than picking", async () => {
  // Some seeded shapes are closed under rotation - measured 2026-09-11, Gucci's
  // bare six digits and Patagonia's bare five, 2 of the 39 readings. Every
  // rotation of such a code is itself a legal code of the same brand and a
  // DIFFERENT garment, so a rim search over one has nothing to choose with and
  // must refuse. This is the case that would break first if the ambiguity rule
  // were ever "simplified" back to first-hit-wins, and it would break silently,
  // onto the MPN aspect a buyer searches.
  //
  // The shapes are read from the migrations rather than retyped, so this cannot
  // end up asserting a pattern the database stopped holding.
  const rows = await seededRows();
  assert(rows.length > 0, "parsed no brand_style_codes tuples from the migrations");

  const degenerate: string[] = [];
  for (const brand of [...new Set(rows.map((r) => r.brandKey))].sort()) {
    const brandRows = rows.filter((r) => r.brandKey === brand);
    const pack = packFor(brand, brandRows);
    const specs = decoderSpecsFromPack(pack);
    const rimSpecs = rimDecoderSpecs(brand, specs);
    for (const code of exampleCodes(brandRows)) {
      // Closed under rotation means every other rotation also decodes whole,
      // each to a different code. That is a property of the SHAPE; read it off
      // the shape rather than naming the brands.
      const others = rotations(code).filter((r) => r !== code);
      if (others.length === 0) continue;
      const allLegal = others.every((r) =>
        answerFor(brand, pack, r).startsWith("decoded:") &&
        answerFor(brand, pack, r) !== answerFor(brand, pack, code)
      );
      if (!allLegal) continue;
      degenerate.push(`${brand}:${code}`);
      const rim = decodeRim(brand, code, rimSpecs, specs);
      assertEquals(
        rim.outcome,
        "ambiguous",
        `${brand} "${code}" is closed under rotation, so the rim search must refuse it`,
      );
      assertEquals(rim.code, null, `${brand} "${code}" must file nothing`);
      assert(
        rim.contenders.length >= 2,
        `${brand} "${code}" refused without naming what it declined to choose between`,
      );
    }
  }
  // If the seed table ever loses every rotation-degenerate shape this assertion
  // goes red rather than the test quietly checking nothing. Retiring it is then
  // a decision someone makes, not a silence.
  assert(
    degenerate.length > 0,
    "no rotation-degenerate seeded shape found; this guard verified nothing",
  );
});

Deno.test("US-3086: the rim is read ONE WAY ROUND, and a reversed one is not recovered", () => {
  // A rim can be photographed so that the text runs the other way, and the
  // obvious kindness is to try the reversed string too. Measured over the
  // seeded table on 2026-09-11: doing that gives 16 of the 39 readings at least
  // one FOREIGN identity they do not have now - including every Lululemon one,
  // where "LW6AMYS" reversed spells the perfectly legal M A 6 W L S. Those 16
  // would become refusals under the ambiguity rule, so accepting both
  // directions decodes STRICTLY LESS than accepting one. One direction it is.
  //
  // The guard is therefore that a reversed transcription does NOT recover the
  // garment: it is a different string and it is treated as one.
  const lulu = assembleBrandKnowledgePack({
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
  });
  const specs = decoderSpecsFromPack(lulu);
  const rimSpecs = rimDecoderSpecs("lululemon", specs);
  for (const [forward, identity] of [
    ["LW3DUTS224000011302", "W3DUTS"],
    ["LW6AMYSP60417", "W6AMYS"],
    ["LW5EGTS253", "W5EGTS"],
  ] as const) {
    const reversed = [...forward].reverse().join("");
    const got = decodeRim("lululemon", reversed, rimSpecs, specs);
    assert(
      !got.contenders.includes(identity),
      `reversing "${forward}" recovered ${identity}; the search must read one way round`,
    );
  }
});

Deno.test("US-3086: the ten prod rims from US-3085 decode the same from every start point", () => {
  // The story's own evidence, swept rather than spot-checked. These are the
  // strings the 2026-09-02 backfill actually stored, plus the two longer
  // spellings the same dot produces. 148 rotations; every one of them must
  // reach the same conclusion, because a circle has no first character.
  const lulu = assembleBrandKnowledgePack({
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
  });
  const expected: Record<string, string> = {
    // The five that decoded on 2026-09-02.
    M3BF7S: "decoded:M3BF7S",
    M5609S: "decoded:M5609S",
    M7AK1S: "decoded:M7AK1S",
    M7BA0S: "decoded:M7BA0S",
    W5DLXS: "decoded:W5DLXS",
    // The three the rotation search recovered (US-3086 AC1).
    LW3DUTS224000011302: "decoded:W3DUTS",
    LW5EGTS253: "decoded:W5EGTS",
    "0000F80000DLW5B0303": "decoded:W5B03O",
    // The two that cannot decode and must not be forced. Both are no_match
    // rather than ambiguous: no rotation fits any shape, which is a different
    // diagnosis and a different remedy (re-photograph, not adjudicate).
    S7502T9LM4C847: "refused:no_match",
    ERNSFD78042289140204: "refused:no_match",
    // The whole printed rim, which decodes without the rotation search at all.
    LW6AMYSP60417: "decoded:W6AMYS",
    "LM5609S.0419.000054.000": "decoded:M5609S",
  };

  let swept = 0;
  const drift: string[] = [];
  for (const [code, want] of Object.entries(expected)) {
    assertEquals(answerFor("Lululemon", lulu, code), want, `as transcribed: ${code}`);
    for (const rot of rotations(code)) {
      swept++;
      const got = answerFor("Lululemon", lulu, rot);
      if (got !== want) drift.push(`"${code}" rotated to "${rot}": ${got}, wanted ${want}`);
    }
  }
  assertEquals(swept, 148, "the rotation sweep did not cover what it claims to");
  assertEquals(drift, [], `the answer moved with the start point:\n  ${drift.join("\n  ")}`);
});
