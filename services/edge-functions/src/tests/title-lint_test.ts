// US-1890: eBay title policy/quality lint + the trim-at-publish guard.
// Pure logic — no eBay/DB calls — so it runs offline in CI.
import { assert, assertEquals } from "@std/assert";
import { lintTitle } from "../lib/title-lint.ts";
import { trimTitleWithReport } from "../lib/title-trim.ts";

// ── trim-at-publish (the >80 preflight guard) ────────────────────────
Deno.test("US-1890: an over-80 title trims on a word boundary to a legal length", () => {
  const long =
    "Vintage Levis 501 Original Fit Straight Leg Button Fly Denim Jeans Mens Size 34x32 Dark Wash USA Made";
  const r = trimTitleWithReport(long);
  assert(r.trimmed, "should report a trim");
  assert(r.title.length <= 80, `expected <=80, got ${r.title.length}`);
  assert(!/\s$/.test(r.title), "no trailing whitespace");
  assert(long.startsWith(r.title.split(" ").slice(0, 3).join(" ")), "keeps leading keywords");
});

Deno.test("US-1890: a clean title <=80 is not trimmed and lints clean", () => {
  const t = "Nike Air Max 90 Mens Size 10 Running Shoes White NWT";
  assertEquals(trimTitleWithReport(t).trimmed, false);
  const lint = lintTitle(t);
  assertEquals(lint.policyViolations, []);
  assertEquals(lint.warnings, []);
});

// ── policy violations (publish BLOCKERS) ─────────────────────────────
Deno.test("US-1890: unrelated-brand comparison phrases are policy violations", () => {
  for (const t of [
    "Vintage Denim Jacket similar to Levis Size L",
    "Cute Floral Dress style of Reformation Midi",
    "Wool Blend Coat inspired by Max Mara Camel",
    "Chunky Knit Sweater compared to Aritzia Oversized",
  ]) {
    assert(
      lintTitle(t).policyViolations.length > 0,
      `expected a policy violation for: ${t}`,
    );
  }
});

Deno.test("US-1890: benign 'fits like a glove/dream' is NOT a policy violation", () => {
  assertEquals(lintTitle("Wool Coat fits like a glove Warm Winter Camel").policyViolations, []);
  assertEquals(lintTitle("Soft Sweater fits like a dream Cozy Oversized").policyViolations, []);
});

// ── warnings (non-blocking) ──────────────────────────────────────────
Deno.test("US-1890: promotional filler is a warning, not a blocker", () => {
  const r = lintTitle("L@@K Gucci Belt WOW Genuine Leather");
  assertEquals(r.policyViolations, []);
  assert(r.warnings.some((w) => /filler/i.test(w)), "expected a filler warning");
});

Deno.test("US-1890: duplicate keyword tokens warn (case-insensitive)", () => {
  const r = lintTitle("Nike Nike Air Shoes SHOES Size 10");
  assert(r.warnings.some((w) => /duplicate/i.test(w)), "expected a duplicate-token warning");
});

// ── ALL-CAPS shouting + brand-acronym / size allowlist ───────────────
Deno.test("US-1890: ALL-CAPS words warn but the acronym/size allowlist is exempt", () => {
  // Exempt: condition tags, sizes, known brand acronyms.
  assertEquals(lintTitle("Coach Tote Bag Brown Leather NWT USA XL").warnings, []);
  assertEquals(lintTitle("DKNY Wrap Dress Black Size M NWOT").warnings, []);
  // Not exempt: a brand shouted in caps.
  const r = lintTitle("GUCCI Marmont Shoulder Bag Black Leather");
  assert(r.warnings.some((w) => /ALL-CAPS/i.test(w)), "expected an ALL-CAPS warning for GUCCI");
});

Deno.test("US-1890: empty/whitespace title yields no findings", () => {
  assertEquals(lintTitle(""), { policyViolations: [], warnings: [] });
  assertEquals(lintTitle("   "), { policyViolations: [], warnings: [] });
});
