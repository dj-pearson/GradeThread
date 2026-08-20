// US-2714: the in-code decoder specs and the seeded ones must not drift.
//
// decodeTagCode uses the pack's DB specs INSTEAD of DEFAULT_DECODER_SPECS
// whenever the brand has any seeded — not as well as. So a pattern fixed in one
// place and not the other leaves the fix depending on which path ran, and the
// unit tests (which exercise the in-code defaults) go green either way.
//
// That has now happened twice: US-2689 widening the Lululemon style number for
// the 2017 generation, and US-2714 widening it again for the L prefix and the
// full printed string. Twice is a pattern, so this is a guard rather than a
// third resolution to be careful.
import { assert, assertEquals } from "@std/assert";
import { DEFAULT_DECODER_SPECS } from "../lib/brand-decoders.ts";

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);

/**
 * Every `brand_style_codes` tuple across the migrations, LAST definition wins —
 * which is what the database ends up with, since each of these migrations
 * carries `on conflict (brand_key, decoder_kind) do update`.
 *
 * The tuple shape is `('<brand>', '<kind>', '<description>', '<pattern>', $j$…`.
 * SQL doubles an embedded single quote; none of these patterns contain one.
 */
async function seededPatterns(): Promise<Map<string, string>> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
  }
  files.sort();

  const seeded = new Map<string, string>();
  const tuple =
    /\('([a-z0-9_]+)',\s*'([a-z0-9_]+)',\s*'(?:[^']|'')*',\s*'((?:[^']|'')*)'/g;
  for (const name of files) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS_DIR));
    if (!sql.includes("insert into public.brand_style_codes")) continue;
    // Only the brand_style_codes statement, so a brand_styles or
    // brand_colorways tuple in the same file cannot be mistaken for one.
    const start = sql.indexOf("insert into public.brand_style_codes");
    const block = sql.slice(start, sql.indexOf(";", start));
    for (const m of block.matchAll(tuple)) {
      seeded.set(`${m[1]}|${m[2]}`, m[3]!.replace(/''/g, "'"));
    }
  }
  return seeded;
}

Deno.test("US-2714: every in-code decoder spec is seeded with the SAME pattern", async () => {
  const seeded = await seededPatterns();
  // A guard that parsed nothing would pass silently, which is the failure mode
  // this whole file exists to prevent.
  assert(seeded.size > 0, "parsed no brand_style_codes tuples from the migrations");

  const mismatches: string[] = [];
  for (const spec of DEFAULT_DECODER_SPECS) {
    const key = `${spec.brandKey}|${spec.decoderKind}`;
    const dbPattern = seeded.get(key);
    if (dbPattern === undefined) {
      mismatches.push(
        `${key}: in DEFAULT_DECODER_SPECS but never seeded — decodeTagCode ` +
          `would use the DB's specs for this brand and never see it`,
      );
      continue;
    }
    if (dbPattern !== spec.pattern) {
      mismatches.push(
        `${key}: seeded pattern differs\n    code: ${spec.pattern}\n    db:   ${dbPattern}`,
      );
    }
  }
  assertEquals(mismatches, [], `\n${mismatches.join("\n")}\n`);
});

Deno.test("US-2714: every seeded decoder for an in-code brand exists in code", async () => {
  // The other direction. A brand with in-code defaults must have the two lists
  // agree BOTH ways, or the local fallback silently decodes less than
  // production does — which reads as "works on my machine" in reverse.
  const seeded = await seededPatterns();
  const codeBrands = new Set(DEFAULT_DECODER_SPECS.map((s) => s.brandKey));
  const codeKeys = new Set(
    DEFAULT_DECODER_SPECS.map((s) => `${s.brandKey}|${s.decoderKind}`),
  );

  const missing: string[] = [];
  for (const key of seeded.keys()) {
    const brand = key.split("|")[0]!;
    if (!codeBrands.has(brand)) continue; // brands with no in-code fallback are fine
    if (!codeKeys.has(key)) missing.push(key);
  }
  assertEquals(
    missing,
    [],
    `seeded but absent from DEFAULT_DECODER_SPECS: ${missing.join(", ")}`,
  );
});
