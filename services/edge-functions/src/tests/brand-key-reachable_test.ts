// US-3400: a seeded brand_key that no canonicalizer can produce is invisible.
//
// THE MECHANISM. resolveBrandKnowledgePack reads brand_size_charts with exactly
// one predicate: `.eq("brand_key", brandKey(canonicalizeBrand(rawBrand)))`. The
// brand_match array is NOT a fallback for that read -- it only steers the
// in-code corpus. So a row is readable in production if and only if some seller
// input canonicalizes to its key, and a key outside that image is dead weight:
// never read, never competing, never wrong, and invisible to every guard that
// starts from the table.
//
// TWO WAYS A KEY LEAVES THE IMAGE.
//
//   1. ALIAS-SHADOWED. canonicalizeBrand is an exact lookup on BRAND_ALIASES.
//      If a key K is itself an alias key, then typing K returns the CANONICAL
//      spelling instead, and the key becomes brandKey(canonical). 463 of the 691
//      alias keys redirect that way (measured 2026-09-11), so any of those 463
//      used as a brand_key can never be reached. `fjallraven` is one: this
//      corpus strips accents, so canonicalizeBrand("Fjallraven") returns
//      "Fjallraven" WITH the umlauts and brandKey strips them to `fjllrven`.
//      00498 seeded the charts under `fjllrven`; 00472 also wrote them under
//      the plain `fjallraven`, and nothing can ever ask for that.
//
//   2. LABEL MISMATCH. A hand-written row can be filed under a key its own
//      brand_label does not produce -- a synthetic bucket name, or a typo. The
//      row then answers to a string nobody would type as a brand.
//
// THE CENSUS (2026-09-11, over the migration-derived model, 182 keys seeded and
// 181 surviving the deletes):
//
//   * alias-shadowed: 2 keys / 4 rows -- `fjallraven` and `kuhl`, both from
//     00472, both exact duplicates of the `fjllrven` / `khl` rows 00498 seeded.
//   * label mismatch: 3 keys / 5 rows -- `golfshoewidth`, `westernbootwidth`,
//     `tailoringmenswear`, the deliberate CONVENTION buckets 00581/00582/00583
//     seeded under a synthetic key rather than a house.
//   * the in-code corpus is clean: 415 charts, 171 distinct brands, 0 whose
//     generated key (brandKey(chart.brand), what gen-sizing-chart-seed.mjs
//     writes) differs from the key the lookup derives.
//
// Both classes are REGISTERED below rather than deleted. Four dead duplicate
// rows cost a seller nothing, and the convention buckets are a documented
// decision with the 00389 `genericmensalpha` precedent behind them. What was
// worth buying is the guard: the next hand-written pack that files a chart
// under an unreachable key fails here instead of sitting unread for a year.
//
//   deno test --allow-read --allow-env src/tests/brand-key-reachable_test.ts
//
// NOT COVERED, DELIBERATELY. `genericmensalpha`, `genericwomensalpha` and
// `genericmenspants` (00389) pass both checks -- brandKeyForRaw("Generic men's
// alpha") really is `genericmensalpha` -- while being just as unread in
// practice, because no seller types that phrase into a brand field. That is a
// seeding decision, not a canonicalizer defect, and a guard cannot tell "a
// brand nobody has heard of" from "a phrase nobody would type". The line this
// file draws is the one it can derive: the key is outside canonicalizeBrand's
// image, or the row's own label does not produce it.

import { assert, assertEquals } from "@std/assert";

const { brandKey, brandKeyForRaw, canonicalizeBrand, isKnownBrand } =
  await import("../lib/brand-normalize.ts");
const { SIZING_CHARTS } = await import("../lib/sizing-charts.ts");

const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);
const BRAND_NORMALIZE = new URL("../lib/brand-normalize.ts", import.meta.url);

// -- the alias table ---------------------------------------------------------
//
// BRAND_ALIASES is module-private and brand-normalize.ts is not this story's to
// edit, so the table is read by importing a COPY of the module with the one
// declaration re-exported. The copy is checked against the real module below:
// every key it claims must canonicalize, through the real canonicalizeBrand, to
// the value it claims. A stale patch string throws rather than yielding {}.

const DECL = "const BRAND_ALIASES: Record<string, string> = {";
const normalizeSrc = await Deno.readTextFile(BRAND_NORMALIZE);
if (!normalizeSrc.includes(DECL)) {
  throw new Error(
    "brand-normalize.ts no longer declares BRAND_ALIASES as `" + DECL + "`. " +
      "This guard reads the alias table by re-exporting that declaration from " +
      "a copy of the module; fix the string rather than deleting the check.",
  );
}
const aliasModule = await import(
  "data:text/typescript;charset=utf-8," +
    encodeURIComponent(normalizeSrc.replace(DECL, "export " + DECL))
) as { BRAND_ALIASES: Record<string, string> };
const BRAND_ALIASES = aliasModule.BRAND_ALIASES;

/** Keys that appear on the LEFT of the alias table: typing one redirects. */
const aliasKeys = new Set(Object.keys(BRAND_ALIASES));
/** Keys the table can actually MINT: the key of every canonical value. */
const producibleKeys = new Set(Object.values(BRAND_ALIASES).map(brandKey));

/**
 * True when no seller input can produce this key. An alias key is only
 * reachable if some canonical brand normalizes back onto it; a key that is not
 * an alias key at all is reachable by passthrough (typing it verbatim).
 */
const aliasShadowed = (key: string) =>
  aliasKeys.has(key) && !producibleKeys.has(key);

// -- the model: brand_size_charts as the migrations leave it ------------------
//
// Parsers lifted from sizing-chart-orphans_test.ts (US-3387), where both traps
// are already paid for: an insert regex that stops at `on conflict` rather than
// running to EOF (otherwise the brand_styles and brand_colorways tuples that
// share the shape invent charts), and a quote-aware tuple splitter for the
// deletes (eleven of 00782's garment names contain a parenthesis).

const ROW_RE =
  /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,\s*ARRAY\[([^\]]*)\]::text\[\]\s*,\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/g;
const INSERT_RE =
  /insert\s+into\s+public\.brand_size_charts\s*\([^)]*\)\s*values\s*([\s\S]*?)\n\s*on\s+conflict/gi;
const DELETE_RE =
  /delete\s+from\s+public\.brand_size_charts\b[\s\S]*?using\s*\(\s*values\s*([\s\S]*?)\)\s*as\s+v\s*\(([^)]*)\)/gi;
const LITERAL_RE = /'((?:[^']|'')*)'/g;

const unquote = (s: string) => s.replace(/''/g, "'");

/** Top-level parenthesised tuples out of a VALUES list, quote-aware. */
function tuplesOf(values: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = "";
  for (let i = 0; i < values.length; i++) {
    const ch = values[i]!;
    if (inQuote) {
      current += ch;
      if (ch === "'") {
        if (values[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inQuote = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (depth === 1) {
        current = "";
        continue;
      }
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        out.push(current);
        current = "";
        continue;
      }
    }
    if (depth > 0) current += ch;
  }
  return out;
}

interface SeededChart {
  key: string;
  label: string;
  department: string;
  garment: string;
  where: string;
}

const live = new Map<string, SeededChart>();
/** Every key any migration ever seeded, deletes included -- history, not state. */
const everSeeded = new Map<string, string>();
let deleteFiles = 0;
let deletesParsed = 0;

const files: string[] = [];
for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
  if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
}
files.sort(); // NNNNN order, so the last writer wins

for (const name of files) {
  const sql = await Deno.readTextFile(new URL(name, MIGRATIONS_DIR));
  INSERT_RE.lastIndex = 0;
  let ins: RegExpExecArray | null;
  while ((ins = INSERT_RE.exec(sql))) {
    ROW_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROW_RE.exec(ins[1]!))) {
      const chart: SeededChart = {
        key: unquote(m[1]!),
        label: unquote(m[2]!),
        department: unquote(m[4]!),
        garment: unquote(m[5]!),
        where: name,
      };
      live.set(
        [chart.key, chart.department, chart.garment].join("|").toLowerCase(),
        chart,
      );
      if (!everSeeded.has(chart.key)) everSeeded.set(chart.key, name);
    }
  }

  if (/delete\s+from\s+public\.brand_size_charts\b/i.test(sql)) deleteFiles++;
  DELETE_RE.lastIndex = 0;
  let d: RegExpExecArray | null;
  while ((d = DELETE_RE.exec(sql))) {
    const columns = d[2]!.split(",").map((c) => c.trim().toLowerCase());
    const ki = columns.indexOf("brand_key");
    const di = columns.indexOf("department");
    const gi = columns.indexOf("garment");
    if (ki === -1 || di === -1 || gi === -1) continue;
    for (const tuple of tuplesOf(d[1]!)) {
      const values = [...tuple.matchAll(LITERAL_RE)].map((x) => unquote(x[1]!));
      if (values.length !== columns.length) continue;
      const id = [values[ki], values[di], values[gi]].join("|").toLowerCase();
      if (live.delete(id)) deletesParsed++;
    }
  }
}

/** Distinct surviving key -> the rows filed under it. */
const seededKeys = new Map<string, SeededChart[]>();
for (const chart of live.values()) {
  const bucket = seededKeys.get(chart.key) ?? [];
  bucket.push(chart);
  seededKeys.set(chart.key, bucket);
}

// -- the registries ----------------------------------------------------------
//
// Like knownNoise in check-ui-antipatterns.mjs and DB_ONLY in
// sizing-chart-orphans_test.ts, an entry that stops matching also fails, so
// both lists can only shrink.

/**
 * Keys outside canonicalizeBrand's image. Every entry here is dead weight that
 * the owner has chosen not to spend a migration on.
 */
const ALIAS_SHADOWED_ACCEPTED: Record<string, string> = {
  fjallraven:
    "00472. canonicalizeBrand('Fjallraven') returns the umlauted spelling, " +
    "whose brandKey strips to 'fjllrven' -- the key 00498 seeded with the " +
    "SAME two charts. Nothing can ask for 'fjallraven', so these 2 rows are " +
    "never read. US-3387 registered them, US-3400 proved the class is only " +
    "these two and left the deletion to an owner-gated migration: four dead " +
    "duplicate rows cost a seller nothing.",
  kuhl:
    "00472, the same shape. canonicalizeBrand('Kuhl') returns 'Kuhl' with the " +
    "umlaut, whose brandKey is 'khl', and 00498 holds that key with the same " +
    "two charts.",
};

/**
 * Keys whose own brand_label does not produce them. Each is a deliberate
 * CONVENTION bucket, seeded under a synthetic key rather than a house because
 * the table describes an industry convention. The 00389 precedent is
 * `genericmensalpha` / `genericwomensalpha` / `genericmenspants`.
 */
const SYNTHETIC_KEYS_ACCEPTED: Record<string, string> = {
  golfshoewidth:
    "00583. 'Golf shoe widths (FootJoy convention)' is a letter axis shared " +
    "across golf footwear, not FootJoy's own table. Reachable only by a " +
    "direct lookup on the key.",
  tailoringmenswear:
    "00581, which argues the case in the migration: the chest run and the " +
    "drop arithmetic are an industry convention rather than any house's " +
    "label, so a brand-specific chart overrides this one rather than " +
    "competing with it.",
  westernbootwidth:
    "00582, the same call as the golf widths: a US boot-width letter axis " +
    "that belongs to no single maker.",
};

// -- the guards --------------------------------------------------------------

Deno.test("US-3400: the census read both sides (guards the guard)", () => {
  // FAIL-CLOSED. Every assertion below reads as a pass on an empty parse, so
  // each input is proved non-empty and live first.
  assert(
    aliasKeys.size > 600,
    "only " + aliasKeys.size + " alias keys parsed out of brand-normalize.ts",
  );
  assert(
    producibleKeys.size > 200,
    "only " + producibleKeys.size + " canonical brands parsed",
  );
  assert(
    live.size > 300,
    "only " + live.size + " migration-seeded charts parsed",
  );
  assert(
    seededKeys.size > 150,
    "only " + seededKeys.size + " distinct seeded brand_keys parsed",
  );
  assert(
    SIZING_CHARTS.length > 300,
    "only " + SIZING_CHARTS.length + " in-code charts parsed",
  );
  assert(
    deleteFiles === 0 || deletesParsed > 0,
    deleteFiles + " migration(s) delete from brand_size_charts but the delete " +
      "parser matched no row this model holds, which would make the census " +
      "report on rows production no longer has",
  );

  // The COPY of the alias table is the real one: every pair it claims has to
  // survive the real canonicalizeBrand.
  const infidelity: string[] = [];
  for (const [key, canonical] of Object.entries(BRAND_ALIASES)) {
    if (canonicalizeBrand(key) !== canonical) infidelity.push(key);
    else if (!isKnownBrand(key)) infidelity.push(key + " (not a known brand)");
  }
  assertEquals(
    infidelity,
    [],
    "the re-exported copy of BRAND_ALIASES disagrees with the real module",
  );

  // The shadowing rule itself is live: this is the finding the story is about,
  // stated as an executable fact rather than a comment.
  assertEquals(brandKeyForRaw("Fjallraven"), "fjllrven");
  assert(
    aliasShadowed("fjallraven"),
    "'fjallraven' is no longer alias-shadowed -- if canonicalizeBrand stopped " +
      "stripping accents, this whole guard is measuring the wrong thing",
  );
  assert(
    !aliasShadowed("levis"),
    "'levis' must stay reachable: it is an alias key AND the key of its own " +
      "canonical, which is the normal, healthy case",
  );

  console.log(
    `[US-3400] ${live.size} seeded charts / ${seededKeys.size} distinct ` +
      `brand_keys checked against ${aliasKeys.size} alias keys and ` +
      `${producibleKeys.size} canonical brands; ${SIZING_CHARTS.length} ` +
      `in-code charts across ${
        new Set(SIZING_CHARTS.map((c) => brandKey(c.brand))).size
      } keys.`,
  );
});

Deno.test("US-3400: no seeded brand_key is shadowed by an alias", () => {
  const shadowed = [...seededKeys.keys()]
    .filter((key) => aliasShadowed(key))
    .filter((key) => !(key in ALIAS_SHADOWED_ACCEPTED))
    .sort();

  assertEquals(
    shadowed,
    [],
    "A brand_size_charts row is filed under a key that is itself an alias key, " +
      "so canonicalizeBrand redirects every input that would reach it and the " +
      "row is never read. File it under brandKeyForRaw(<the brand>) instead, " +
      "or register it in ALIAS_SHADOWED_ACCEPTED with the reason it stays.",
  );
});

Deno.test("US-3400: every seeded brand_key is the one its own label produces", () => {
  const mismatched = [...seededKeys.entries()]
    .filter(([key]) => !(key in SYNTHETIC_KEYS_ACCEPTED))
    .filter(([key]) => !(key in ALIAS_SHADOWED_ACCEPTED))
    .map(([key, rows]) => ({ key, label: rows[0]!.label, where: rows[0]!.where }))
    .filter(({ key, label }) => brandKeyForRaw(label) !== key)
    .map(({ key, label, where }) =>
      `${key} != brandKeyForRaw("${label}") = ${brandKeyForRaw(label)} (${where})`
    )
    .sort();

  assertEquals(
    mismatched,
    [],
    "A brand_size_charts row's key is not what the production lookup derives " +
      "from the row's own brand_label, so the only string that reaches it is " +
      "the key itself. Re-key the row, or register it in " +
      "SYNTHETIC_KEYS_ACCEPTED with the reason it is a convention bucket.",
  );
});

Deno.test("US-3400: the in-code corpus cannot generate an unreachable key", () => {
  // gen-sizing-chart-seed.mjs writes brand_key = brandKey(chart.brand), while
  // the lookup derives brandKey(canonicalizeBrand(rawBrand)). When a chart's
  // brand is an alias spelling rather than the canonical one, those two differ
  // and the regenerated 00498 seeds a key nothing reads. Measured 2026-09-11:
  // 0 of 171 corpus brands.
  const wrong = [...new Set(SIZING_CHARTS.map((c) => c.brand))]
    .filter((brand) => brandKey(brand) !== brandKeyForRaw(brand))
    .map((brand) =>
      `"${brand}": seed writes ${brandKey(brand)}, lookup asks for ${
        brandKeyForRaw(brand)
      }`
    )
    .sort();

  assertEquals(
    wrong,
    [],
    "sizing-charts.ts names a brand whose generated seed key is not the key " +
      "the resolver looks up. Use the canonical spelling as the chart's brand.",
  );
});

Deno.test("US-3400: every registry entry still matches a seeded key", () => {
  // The lists can only shrink. An entry that stops matching is a rule that has
  // quietly stopped being enforced -- or a row somebody already retired.
  assertEquals(
    Object.keys(ALIAS_SHADOWED_ACCEPTED)
      .filter((key) => !seededKeys.has(key) || !aliasShadowed(key))
      .sort(),
    [],
    "an ALIAS_SHADOWED_ACCEPTED entry is no longer a shadowed seeded key; " +
      "delete the entry",
  );
  assertEquals(
    Object.keys(SYNTHETIC_KEYS_ACCEPTED)
      .filter((key) => {
        const rows = seededKeys.get(key);
        return !rows || brandKeyForRaw(rows[0]!.label) === key;
      })
      .sort(),
    [],
    "a SYNTHETIC_KEYS_ACCEPTED entry is no longer a seeded key whose label " +
      "disagrees with it; delete the entry",
  );
});
