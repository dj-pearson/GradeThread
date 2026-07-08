// US-1712: deterministic decoder engine + Lululemon decoders.
import { assert, assertEquals } from "@std/assert";
import {
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
  assertEquals(decodeTagCode("lululemon", "WABCD"), null); // no dot/season
  assertEquals(decodeTagCode("lululemon", "XA1234B.0322"), null); // bad gender
  assertEquals(decodeTagCode("lululemon", "WA1234B.0522"), null); // season 05 invalid
  assertEquals(decodeTagCode("lululemon", ""), null);
});

// ── size dot (printed number) ───────────────────────────────────────────────
Deno.test("lululemon size dot reads the printed size, lone-number only", () => {
  assertEquals(decodeTagCode("lululemon", "6")!.size, "6");
  assertEquals(decodeTagCode("lululemon", "  8 ")!.size, "8");
  assertEquals(decodeTagCode("lululemon", "12")!.decoderKind, "size_dot");
  // not a lone number → no match (caller must isolate the dot region)
  assertEquals(decodeTagCode("lululemon", "size 6"), null);
  assertEquals(decodeTagCode("lululemon", "abc"), null);
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
