// US-1712: deterministic decoder engine + Lululemon decoders.
import { assert, assertEquals } from "@std/assert";
import {
  crossCheckDecodeResult,
  DEFAULT_DECODER_SPECS,
  type DecodeResult,
  type DecoderSpec,
  decodeTagCode,
  runDecoderSpec,
} from "../lib/brand-decoders.ts";

// ── Lululemon style number ──────────────────────────────────────────────────
Deno.test("lululemon style number decodes gender / code / color / season / year", () => {
  const r = decodeTagCode("lululemon", "WA1234B.0322");
  assert(r !== null);
  assertEquals(r!.brand, "Lululemon");
  assertEquals(r!.decoderKind, "style_number");
  assertEquals(r!.gender, "Women");
  assertEquals(r!.styleCode, "A1234");
  assertEquals(r!.colorInitial, "B");
  assertEquals(r!.season, "Fall"); // 03
  assertEquals(r!.year, "2022"); // 22
  assertEquals(r!.confidence, 0.9);
});

Deno.test("lululemon style number handles men's + all seasons + short code", () => {
  assertEquals(decodeTagCode("lululemon", "MABCR.0121")!.gender, "Men");
  assertEquals(decodeTagCode("lululemon", "MABCR.0121")!.season, "Spring");
  assertEquals(decodeTagCode("lululemon", "WABCG.0224")!.season, "Summer");
  assertEquals(decodeTagCode("lululemon", "WABCG.0424")!.season, "Winter");
  // 4-char code before the color letter
  assertEquals(decodeTagCode("lululemon", "WQ12X.0323")!.styleCode, "Q12");
});

Deno.test("lululemon style number is case-insensitive and normalizes color", () => {
  const r = decodeTagCode("lululemon", "wa1234b.0322");
  assert(r !== null);
  assertEquals(r!.gender, "Women");
  assertEquals(r!.colorInitial, "B"); // upper-normalized
});

// ── never a false positive ──────────────────────────────────────────────────
Deno.test("malformed style numbers return no match", () => {
  assertEquals(decodeTagCode("lululemon", "WABCD"), null); // 5 chars: neither generation
  assertEquals(decodeTagCode("lululemon", "XA1234B.0322"), null); // bad gender
  assertEquals(decodeTagCode("lululemon", "WA1234B.0522"), null); // season 05 invalid
  assertEquals(decodeTagCode("lululemon", ""), null);
});

// ── US-2689: Jan 2017 - Jan 2019 style numbers (no season/year suffix) ──────
Deno.test("US-2689: a 2017-generation code decodes gender and the raw code", () => {
  const r = decodeTagCode("lululemon", "M7A83S");
  assert(r !== null);
  assertEquals(r!.brand, "Lululemon");
  assertEquals(r!.decoderKind, "style_number_2017");
  assertEquals(r!.gender, "Men");
  assertEquals(r!.styleCode, "7A83");
  assertEquals(r!.colorInitial, "S");
  // The suffix is what carried season/year; without it they must stay absent
  // rather than be guessed.
  assertEquals(r!.season, undefined);
  assertEquals(r!.year, undefined);
});

Deno.test("US-2689: 2017 codes are case-insensitive and women's decode too", () => {
  assertEquals(decodeTagCode("lululemon", "w6avbs")!.gender, "Women");
  assertEquals(decodeTagCode("lululemon", "w6avbs")!.colorInitial, "S");
});

Deno.test("US-2689: the 2019+ spec still wins for codes carrying the suffix", () => {
  // Anchored to different lengths, so the two decoders never compete.
  assertEquals(
    decodeTagCode("lululemon", "WA1234B.0322")!.decoderKind,
    "style_number",
  );
  assertEquals(decodeTagCode("lululemon", "WA1234B.0322")!.year, "2022");
});

Deno.test("US-2689: the 2017 spec stays anchored to exactly six characters", () => {
  assertEquals(decodeTagCode("lululemon", "M7A83"), null); // 5
  assertEquals(decodeTagCode("lululemon", "M7A83SX"), null); // 7
  assertEquals(decodeTagCode("lululemon", "M7A835"), null); // colour slot is a letter
  assertEquals(decodeTagCode("lululemon", "X7A83S"), null); // bad gender
});

// ── US-2714: one garment, four spellings, one answer ────────────────────────
// The size dot carries a longer string than the style number. A model told to
// transcribe a code VERBATIM produces the whole thing, and until now that was
// the one reading no decoder matched.

Deno.test("US-2714: every spelling of one garment decodes to the same style", () => {
  // Bare style number, with lululemon's L prefix, and the full printed string
  // with the colour letter and the manufacture date.
  const spellings = ["W6AMYS", "LW6AMYS", "W6AMYSP60417", "LW6AMYSP60417"];
  const decoded = spellings.map((c) => decodeTagCode("lululemon", c));
  for (const [i, r] of decoded.entries()) {
    assert(r !== null, `${spellings[i]} decoded to nothing`);
    assertEquals(r!.gender, "Women");
    // The decoded styleCode is identical across all four, which is what makes
    // it the natural join key for the learned index.
    assertEquals(r!.styleCode, "6AMY");
  }
});

Deno.test("US-2714: the full printed string is its own decoder kind", () => {
  assertEquals(
    decodeTagCode("lululemon", "LW6AMYSP60417")!.decoderKind,
    "style_number_full",
  );
  // It grounds exactly what the 2017 spec grounds — the trailing block is a
  // MANUFACTURE date, not the season/year the 2019+ suffix carries, so nothing
  // is invented from it.
  const full = decodeTagCode("lululemon", "LW6AMYSP60417")!;
  assertEquals(full.season, undefined);
  assertEquals(full.year, undefined);
  assertEquals(full.confidence, 0.85);
});

Deno.test("US-2714: the L is optional on the 2019+ spec too, season intact", () => {
  const withL = decodeTagCode("lululemon", "LWA1234B.0322")!;
  const without = decodeTagCode("lululemon", "WA1234B.0322")!;
  assertEquals(withL.decoderKind, "style_number");
  assertEquals(withL.styleCode, without.styleCode);
  assertEquals(withL.year, "2022");
  assertEquals(withL.season, "Fall");
});

Deno.test("US-2714: four spellings collapse to ONE canonical code", () => {
  // Decoding the same is not enough. The learned index files a code under what
  // was transcribed, so without a shared key these are four rows that never
  // meet — and a consensus needing three agreeing titles can leave every
  // fragment under the threshold.
  const spellings = ["W6AMYS", "LW6AMYS", "W6AMYSP60417", "LW6AMYSP60417"];
  const canonical = spellings.map((c) =>
    decodeTagCode("lululemon", c)!.canonicalCode
  );
  assertEquals(canonical, ["W6AMYS", "W6AMYS", "W6AMYS", "W6AMYS"]);
});

Deno.test("US-2714: the canonical code is a CODE, not the transformed fields", () => {
  const r = decodeTagCode("lululemon", "wa1234b.0322")!;
  // gender reads "Women" but the canonical keeps the letter, and case is
  // normalized so a lowercase transcription keys the same bucket.
  assertEquals(r.gender, "Women");
  assertEquals(r.canonicalCode, "WA1234B");
  // The season suffix is dropped on purpose: the same style in two seasons is
  // the same product, which is the question the index answers.
  assertEquals(decodeTagCode("lululemon", "WA1234B.0119")!.canonicalCode, "WA1234B");
});

Deno.test("US-2714: a spec with no canonicalFrom yields no canonical code", () => {
  // Every other brand in the corpus, unchanged.
  const spec: DecoderSpec = {
    brandKey: "levis",
    decoderKind: "lot_number",
    pattern: "^(?<style>50[0-9])$",
    fieldMap: { style: "styleCode" },
    confidence: 0.8,
  };
  assertEquals(decodeTagCode("levis", "501", [spec])!.canonicalCode, undefined);
});

Deno.test("US-2714: an incomplete canonicalFrom yields NOTHING, not a short code", () => {
  // A shorter code would silently key a DIFFERENT bucket, which is worse than
  // having no canonical code at all.
  const spec: DecoderSpec = {
    brandKey: "lululemon",
    decoderKind: "broken",
    pattern: "^(?<gender>[WM])(?<style>[A-Z0-9]{4})$",
    fieldMap: { style: "styleCode" },
    canonicalFrom: ["gender", "style", "color"], // `color` is never captured
    confidence: 0.5,
  };
  assertEquals(decodeTagCode("lululemon", "W6AMY", [spec])!.canonicalCode, undefined);
});

Deno.test("US-2714: the DB path carries canonicalFrom, and it is the one prod uses", () => {
  // decodeTagCode ignores DEFAULT_DECODER_SPECS entirely once a brand has
  // seeded specs, so a canonical code that only works from the in-code copy
  // would do nothing in production.
  const dbSpecs = DEFAULT_DECODER_SPECS.filter((s) => s.brandKey === "lululemon");
  assertEquals(
    decodeTagCode("lululemon", "LW6AMYSP60417", dbSpecs)!.canonicalCode,
    "W6AMYS",
  );
});

Deno.test("US-2714: widening the shapes did not loosen the anchors", () => {
  // The full form needs BOTH the colour letter and the date block; the decoder
  // bar's third test is about format, and a substring hunt would fail it.
  assertEquals(decodeTagCode("lululemon", "M7A83SX"), null); // letter, no date
  assertEquals(decodeTagCode("lululemon", "M7A83S60417"), null); // date, no colour
  assertEquals(decodeTagCode("lululemon", "M7A83SP604"), null); // date too short
  assertEquals(decodeTagCode("lululemon", "M7A83SP6041777"), null); // too long
  assertEquals(decodeTagCode("lululemon", "LLW6AMYS"), null); // two prefixes
  assertEquals(decodeTagCode("lululemon", "XW6AMYS"), null); // wrong prefix letter
  assertEquals(decodeTagCode("lululemon", "buy my LW6AMYS now"), null); // not a substring hunt
});

// ── size dot (printed number) ───────────────────────────────────────────────
// REGION-SCOPED: the caller must say it has isolated the dot, because the
// pattern is a lone number and will otherwise read a stray OCR fragment as a
// size. See REGION_SCOPED_DECODER_KINDS.
const DOT = { includeRegionScoped: true };

Deno.test("lululemon size dot reads the printed size, lone-number only", () => {
  assertEquals(decodeTagCode("lululemon", "6", [], DOT)!.size, "6");
  assertEquals(decodeTagCode("lululemon", "  8 ", [], DOT)!.size, "8");
  assertEquals(decodeTagCode("lululemon", "12", [], DOT)!.decoderKind, "size_dot");
  // not a lone number → no match even with the region isolated
  assertEquals(decodeTagCode("lululemon", "size 6", [], DOT), null);
  assertEquals(decodeTagCode("lululemon", "abc", [], DOT), null);
});

Deno.test("a bare number NEVER decodes as a size without an isolated region", () => {
  // The live defect this guards: the only strings any caller passes are the
  // style_code / mpn attributes, so a stray two-digit fragment transcribed into
  // either one used to decode as a SIZE and override the garment's real size at
  // 0.85 confidence — silently, in the field that decides what a buyer gets.
  assertEquals(decodeTagCode("lululemon", "6"), null);
  assertEquals(decodeTagCode("lululemon", "12"), null);
  assertEquals(decodeTagCode("lululemon", "  8 "), null);
  // The style-number decoders are unaffected: they read a whole code, not a
  // region, so they still fire from the ordinary path.
  assertEquals(decodeTagCode("lululemon", "M7A83S")!.decoderKind, "style_number_2017");
  assertEquals(decodeTagCode("lululemon", "WA1234B.0322")!.decoderKind, "style_number");
});

Deno.test("region-scoping survives DB-seeded specs, not just the in-code defaults", () => {
  // decodeTagCode ignores the in-code defaults entirely when the pack supplies
  // specs, so the filter has to apply to the DB path too or the guard is a
  // no-op in production.
  const dbSpecs = DEFAULT_DECODER_SPECS.filter((s) => s.brandKey === "lululemon");
  assertEquals(decodeTagCode("lululemon", "6", dbSpecs), null);
  assertEquals(decodeTagCode("lululemon", "6", dbSpecs, DOT)!.size, "6");
});

// ── unknown brand → no in-code decoder → null ───────────────────────────────
Deno.test("a brand with no decoder returns null", () => {
  assertEquals(decodeTagCode("somerandombrand", "WA1234B.0322"), null);
});

// ── DB specs take precedence over the in-code defaults ──────────────────────
Deno.test("DB-supplied specs are used before the in-code defaults", () => {
  const dbSpec: DecoderSpec = {
    brandKey: "levis",
    decoderKind: "lot_number",
    pattern: "^(?<style>50[0-9])$",
    fieldMap: { style: "styleCode" },
    confidence: 0.8,
  };
  const r = decodeTagCode("levis", "501", [dbSpec]);
  assert(r !== null);
  assertEquals(r!.styleCode, "501");
  assertEquals(r!.decoderKind, "lot_number");
  assertEquals(r!.confidence, 0.8);
});

// ── runDecoderSpec: defensive against a malformed regex ─────────────────────
Deno.test("a malformed spec regex never throws, just no-matches", () => {
  const bad: DecoderSpec = {
    brandKey: "x",
    decoderKind: "broken",
    pattern: "(?<unclosed", // invalid regex
    fieldMap: {},
    confidence: 0.5,
  };
  assertEquals(runDecoderSpec(bad, "anything"), null);
});

// ── Cross-checks (US-1768 AC2) ──────────────────────────────────────────────
function baseResult(over: Partial<DecodeResult> = {}): DecodeResult {
  return { brand: "Louis Vuitton", decoderKind: "date_code", raw: "SD1024", confidence: 0.8, ...over };
}

Deno.test("crossCheck: a future production year is flagged", () => {
  const flags = crossCheckDecodeResult(baseResult({ year: "2030" }), { currentYear: 2026 });
  assert(flags.some((f) => f.code === "date_in_future" && f.severity === "flag"));
});

Deno.test("crossCheck: a year before the brand's founding is flagged", () => {
  const flags = crossCheckDecodeResult(baseResult({ year: "1850" }), {
    currentYear: 2026,
    brandFoundedYear: 1854,
  });
  assert(flags.some((f) => f.code === "date_before_brand"));
});

Deno.test("crossCheck: claim mismatches are warnings, not flags", () => {
  const flags = crossCheckDecodeResult(
    baseResult({ year: "2018", gender: "Women", styleCode: "A1234" }),
    { currentYear: 2026, claimedYear: 2019, claimedGender: "Men", claimedStyleCode: "B9999" },
  );
  const codes = flags.map((f) => f.code);
  assert(codes.includes("year_mismatch"));
  assert(codes.includes("gender_mismatch"));
  assert(codes.includes("style_code_mismatch"));
  assert(flags.every((f) => f.severity === "warn"));
});

Deno.test("crossCheck: a consistent decode yields no inconsistencies", () => {
  const flags = crossCheckDecodeResult(
    baseResult({ year: "2018", gender: "Women", styleCode: "A1234" }),
    { currentYear: 2026, claimedYear: 2018, claimedGender: "Women", claimedStyleCode: "a1234" },
  );
  assertEquals(flags.length, 0);
});

Deno.test("crossCheck: flags sort before warns", () => {
  const flags = crossCheckDecodeResult(
    baseResult({ year: "2030" }),
    { currentYear: 2026, claimedYear: 2031 },
  );
  assertEquals(flags[0].severity, "flag", "the future-date flag ranks above the year-mismatch warn");
});
