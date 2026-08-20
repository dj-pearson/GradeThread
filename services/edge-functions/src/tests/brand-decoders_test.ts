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
