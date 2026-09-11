// US-3332: size a flaw from a coin, a bank card or a MeasureCard beside it.
//
//   deno test --allow-net --allow-env --allow-read src/tests/scale-reference_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  applyScaleReferenceWording,
  ID1_CARD_MM,
  MEASURE_CARD_MM,
  SCALE_V1_PHRASE,
  SCALE_V2_PHRASE,
  US_QUARTER_MM,
} from "../lib/scale-reference.ts";

Deno.test("the reference sizes are the published standards", () => {
  assertEquals(US_QUARTER_MM, 24.26); // US Mint quarter diameter
  assertEquals(ID1_CARD_MM, { long: 85.6, short: 53.98 }); // ISO/IEC 7810 ID-1
  // MeasureCard trim, 7.5 x 5.5 in (vault/20-domain/measurement-card-spec.md).
  assertEquals(MEASURE_CARD_MM, { long: 7.5 * 25.4, short: 5.5 * 25.4 });
});

Deno.test("the web copy states the same sizes", () => {
  const web = Deno.readTextFileSync(
    new URL("../../../../src/lib/scale-reference.ts", import.meta.url),
  );
  assert(web.includes(`US_QUARTER_MM = ${US_QUARTER_MM};`));
  assert(web.includes(`ID1_CARD_MM = { long: ${ID1_CARD_MM.long}, short: ${ID1_CARD_MM.short} }`));
  assert(web.includes(`MEASURE_CARD_MM = { long: ${MEASURE_CARD_MM.long}, short: ${MEASURE_CARD_MM.short} }`));
});

Deno.test("flag off: byte-identical", () => {
  const text = `before ${SCALE_V1_PHRASE} after`;
  assertEquals(applyScaleReferenceWording(text, false), { text, applied: false });
});

Deno.test("flag on: the phrase gains the three sizes and the do-not-flag-the-coin rule", () => {
  const r = applyScaleReferenceWording(`x ${SCALE_V1_PHRASE} y`, true);
  assertEquals(r.applied, true);
  assert(r.text.includes(SCALE_V2_PHRASE));
  for (const n of [US_QUARTER_MM, ID1_CARD_MM.long, ID1_CARD_MM.short, MEASURE_CARD_MM.long]) {
    assert(r.text.includes(String(n)), `missing ${n}`);
  }
  assert(/never record the object itself as a flaw/.test(r.text));
});

Deno.test("a prompt without the v1 phrase is not mislabelled as the +scale era", () => {
  assertEquals(applyScaleReferenceWording("custom operator prompt", true).applied, false);
});

Deno.test("the v1 phrase still occurs in the per-image system prompt it targets", () => {
  // If DEFECT_TAXONOMY_AND_SIZING is reworded, the flag must not become a
  // silent no-op.
  const src = Deno.readTextFileSync(new URL("../lib/ai-grading.ts", import.meta.url));
  const block = src.slice(src.indexOf("const DEFECT_TAXONOMY_AND_SIZING ="));
  assert(block.slice(0, 4000).includes(SCALE_V1_PHRASE));
});
