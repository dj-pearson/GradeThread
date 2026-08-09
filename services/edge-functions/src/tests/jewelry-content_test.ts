// US-2221: verify the jewelry content (migration 00576).
//
// Pandora, Tiffany & Co., David Yurman and James Avery. What this file protects
// is the two things this group forced the corpus to say out loud:
//
//   1. A MARK CAN BE STAMPED, PERFECTLY REGULAR, AND IDENTIFY NOBODY. The metal
//      purity hallmark (925 / 585 / 750 / 950) is struck into almost all fine
//      jewelry, so a pattern over it would mint a brand from the one mark
//      guaranteed to be present and guaranteed to be meaningless as attribution.
//      Third instance of the shape: eyewear's size triplet (00575) was the
//      second. Asserted here as a REFUSAL, not as prose.
//   2. A MAKER'S MARK IS NOT A DECODER, and the reason is structural rather than
//      research-limited. ALE, T&CO., D.Y. and JAMES AVERY are all genuinely
//      brand-unique and genuinely struck into metal — but decodeTagCode runs
//      INSIDE AN ALREADY-RESOLVED PACK, so a mark whose entire payload is the
//      brand has nothing left to contribute by the time a spec could run.
//
// And the rule that governs the whole pack: NEVER AUTO-AUTHENTICATE (00460). A
// hallmark is a few characters struck into soft metal and is the first thing a
// counterfeiter copies, so every tell must read as NECESSARY AND NOT SUFFICIENT.
// That is asserted here, because it is the claim most likely to be softened by a
// later edit that wants the KB to sound more useful than it is.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);

const SQL = await Deno.readTextFile(
  new URL(
    "../../../../supabase/migrations/00576_jewelry_brand_knowledge.sql",
    import.meta.url,
  ),
);

/**
 * The migration's PROSE: comment markers stripped, whitespace collapsed.
 *
 * ⚠ PHRASE assertions read THIS; only statement shapes (`insert into …`) read
 * raw `SQL`. Migration headers hard-wrap at ~79 columns, so any phrase worth
 * asserting is one edit away from being split across two `--` lines — which
 * broke a content test three times in one day, every time on a migration that
 * was correct. Rewrapping a comment to satisfy a matcher makes the migration's
 * formatting load-bearing; normalising here makes the test read what a human
 * reads. PROSE is a superset of SQL, so this can only ever be more permissive.
 */
// ⚠ The `''` step unescapes SQL's doubled apostrophe: inside a string literal
// `STORY''S` is `STORY'S` in the database, so a matcher reading the raw file
// sees neither form. Same class as the line-wrap problem — the file's ENCODING
// is not its content. PROSE stays a superset of SQL, so this is only ever more
// permissive.
const PROSE = SQL
  .replace(/^\s*--\s?/gm, " ")
  .replace(/''/g, "'")
  .replace(/\s+/g, " ");


Deno.test("US-2221: the jewelry aliases canonicalize", () => {
  for (const brand of ["Pandora", "Tiffany & Co.", "David Yurman", "James Avery"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  // brandKey strips the ampersand and the period, and a spelled-out "and" is a
  // DIFFERENT key — the Dooney & Bourke lesson from 00468 — so both are mapped.
  for (const spelling of ["Tiffany", "tiffany & co", "Tiffany and Co", "TIFFANY & CO."]) {
    assertEquals(canonicalizeBrand(spelling), "Tiffany & Co.", `${spelling} resolves`);
  }
  assertEquals(canonicalizeBrand("yurman"), "David Yurman");
  assertEquals(canonicalizeBrand("James Avery Craftsman"), "James Avery");
  assertEquals(canonicalizeBrand("pandora jewellery"), "Pandora");
});

Deno.test("US-2221: the jewelry alias refusals hold", () => {
  // Given names and surnames that are half a brand.
  for (const partial of ["avery", "james", "david"]) {
    assert(!isKnownBrand(partial), `a bare '${partial}' must not resolve`);
  }
  // THE PURITY STAMPS ARE NOT BRANDS. This is the pack's headline refusal, and
  // a brand field of literally "925" is a real thing sellers type.
  for (const purity of ["925", "585", "750", "950", "sterling", "14K"]) {
    assert(!isKnownBrand(purity), `${purity} is a metal fact, not a brand`);
  }
  // Nor is the Pandora maker's mark a brand STRING a seller should be handed —
  // it identifies the maker, but "ALE" in a brand field is not a canonical.
  assert(!isKnownBrand("ALE"), "a bare 'ALE' is a hallmark, not a brand field value");
});

Deno.test("US-2221: neither a decoder nor a size chart is seeded", () => {
  // Both absences are decisions. A maker's mark carries the brand and no model,
  // and decodeTagCode only ever runs once the brand is known — so there is
  // nothing for a spec to extract. A ring size is a US standard rather than a
  // brand's label, so a chart would be invented.
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "no decoder — a maker's mark has no payload left once the pack is resolved",
  );
  assert(
    !/insert\s+into\s+public\.brand_size_charts/i.test(SQL),
    "no size chart — a ring size is a standard, not a brand's label",
  );
  assert(
    PROSE.includes("ALREADY-RESOLVED PACK"),
    "the migration records WHY a maker's mark cannot be a decoder",
  );
});

Deno.test("US-2221: the purity-stamp refusal is stated, not implied", () => {
  // The third instance of "stamped, regular, identifies nobody". Writing it down
  // is what turns an incident into a rule the next pack can apply.
  assert(
    PROSE.includes("IDENTIFY NOBODY"),
    "the migration names the shape rather than just declining to seed",
  );
  for (const purity of ["925", "585", "750", "950"]) {
    assert(PROSE.includes(purity), `the refusal enumerates ${purity}`);
  }
});

Deno.test("US-2221: no tell claims a hallmark authenticates", () => {
  // THE 00460 RULE, and jewelry is where it matters most. A hallmark is a few
  // characters struck into soft metal. The honest asymmetry is that a wrong mark
  // is evidence AGAINST and a right one is not evidence FOR, so every tell has
  // to carry that qualifier — and a later edit that makes the KB sound more
  // useful is exactly how it would be lost.
  const tells = [...SQL.matchAll(/\{"tell":"([^"]*)","detail":"([^"]*)"\}/g)];
  assert(tells.length >= 8, `expected the pack's tells to be found, saw ${tells.length}`);

  const FORBIDDEN = /\b(is authentic|proves authentic|guarantees authenticity|confirms it is real)\b/i;
  for (const [, tell, detail] of tells) {
    assert(
      !FORBIDDEN.test(detail),
      `a tell must never claim a verdict: "${tell}"`,
    );
  }

  // And the pack states the rule itself, once, where a reader will hit it.
  assert(
    PROSE.includes("NEVER AUTO-AUTHENTICATE"),
    "the pack carries the never-auto-authenticate rule explicitly",
  );
  assert(
    PROSE.includes("NECESSARY, NOT SUFFICIENT"),
    "at least one tell is explicitly qualified as necessary-not-sufficient",
  );
});

Deno.test("US-2221: the low-confidence dating claims stay low-confidence", () => {
  // James Avery's two eras come from buyer guides, not the maker. US-2212 makes
  // an uncited era invention; a WEAKLY cited one is not invention but it is not
  // publishable either, so the confidence has to stay below the bar rather than
  // drifting up to match the rest of the pack.
  const eras = [...SQL.matchAll(/\{"era":[^}]*\}/g)].map((m) => m[0]);
  assert(eras.length >= 2, `expected the seeded eras, saw ${eras.length}`);
  for (const era of eras) {
    const conf = Number(/"confidence":([\d.]+)/.exec(era)?.[1] ?? "1");
    assert(
      conf <= 0.5,
      `a buyer-guide dating claim must stay at or below 0.5, saw ${conf}`,
    );
    assert(
      /"source_url":"https?:\/\//.test(era),
      "and it must still cite the source it does have",
    );
  }
});

Deno.test("US-2221: prose detection is unchanged for the jewelry brands", () => {
  // None of the four is excluded from free-text detection, and each was checked
  // rather than assumed — see the comment block in brand-normalize.ts. Pinned so
  // a later exclusion is a deliberate act with a reason.
  assertEquals(detectBrandInText("Pandora Moments charm bracelet, sterling"), "Pandora");
  assertEquals(detectBrandInText("Tiffany & Co. sterling heart tag"), "Tiffany & Co.");
  assertEquals(detectBrandInText("David Yurman cable cuff, 925"), "David Yurman");
  // ⚠ "Tiffany blue" is a live colour term and a common given name. It is safe
  // WITHOUT an exclusion only because the canonical is the full "Tiffany & Co.",
  // which neither collision contains. Pinned, because shortening the canonical
  // would silently break it.
  assertEquals(
    detectBrandInText("Nike hoodie in tiffany blue, size M"),
    "Nike",
    "'tiffany blue' must not mint the jeweler",
  );
});
