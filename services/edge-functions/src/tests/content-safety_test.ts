// Unit tests for the pure parts of the US-486 pre-publish safety gate —
// verdict parsing (fail-closed normalization) and HTML→text stripping.
// No Supabase / Anthropic / Deno.env — runs standalone:
//   deno test src/tests/content-safety_test.ts

import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  htmlToReviewText,
  parseSafetyVerdict,
} from "../lib/content-safety.ts";

Deno.test("parseSafetyVerdict: clean pass", () => {
  const r = parseSafetyVerdict('{"verdict": "pass", "reasons": []}');
  assertEquals(r.verdict, "pass");
  assertEquals(r.reasons, []);
});

Deno.test("parseSafetyVerdict: pass inside a code fence", () => {
  const r = parseSafetyVerdict('```json\n{"verdict":"pass","reasons":[]}\n```');
  assertEquals(r.verdict, "pass");
});

Deno.test("parseSafetyVerdict: hold with reasons", () => {
  const r = parseSafetyVerdict(
    '{"verdict": "hold", "reasons": ["fabricated statistic: 87% of resellers"]}',
  );
  assertEquals(r.verdict, "hold");
  assertEquals(r.reasons, ["fabricated statistic: 87% of resellers"]);
});

Deno.test("parseSafetyVerdict: invalid JSON fails closed", () => {
  const r = parseSafetyVerdict("Sure! The content looks fine to me.");
  assertEquals(r.verdict, "hold");
  assertEquals(r.reasons.length > 0, true);
});

Deno.test("parseSafetyVerdict: unknown verdict value fails closed", () => {
  const r = parseSafetyVerdict('{"verdict": "approve", "reasons": []}');
  assertEquals(r.verdict, "hold");
  // A hold without model-supplied reasons gets a default explanation.
  assertEquals(r.reasons.length > 0, true);
});

Deno.test("parseSafetyVerdict: non-object fails closed", () => {
  assertEquals(parseSafetyVerdict('"pass"').verdict, "hold");
  assertEquals(parseSafetyVerdict("null").verdict, "hold");
});

Deno.test("parseSafetyVerdict: verdict casing is normalized", () => {
  assertEquals(parseSafetyVerdict('{"verdict":" PASS "}').verdict, "pass");
});

Deno.test("parseSafetyVerdict: non-string reasons are dropped, capped at 10", () => {
  const reasons = Array.from({ length: 15 }, (_, i) => `r${i}`);
  const r = parseSafetyVerdict(
    JSON.stringify({ verdict: "hold", reasons: [42, null, ...reasons] }),
  );
  assertEquals(r.verdict, "hold");
  assertEquals(r.reasons.length, 10);
  assertEquals(r.reasons[0], "r0");
});

Deno.test("htmlToReviewText: strips tags, scripts, and entities", () => {
  const text = htmlToReviewText(
    "<h1>Title</h1><script>alert(1)</script><p>Hello&nbsp;&amp; <b>world</b></p>",
  );
  assertEquals(text.includes("alert"), false);
  assertEquals(text.includes("<"), false);
  assertEquals(text.includes("Title"), true);
  assertEquals(text.includes("Hello"), true);
  assertEquals(text.includes("world"), true);
});

Deno.test("htmlToReviewText: collapses whitespace", () => {
  assertEquals(htmlToReviewText("<p>a</p>\n\n  <p>b</p>"), "a b");
});
