// US-3329: "Odor & Cleanliness" is described as visible cleanliness only,
// behind GRADING_CLEANLINESS_V2 (default OFF).
//
//   deno test --allow-net --allow-env --allow-read src/tests/cleanliness-wording_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const {
  applyCleanlinessWording,
  CLEANLINESS_WORDING,
  COMPOSITE_SYSTEM_PROMPT,
  promptVersionSuffix,
} = await import("../lib/ai-grading.ts");

const SRC = Deno.readTextFileSync(new URL("../lib/ai-grading.ts", import.meta.url))
  .replace(/\r\n/g, "\n");

function constBody(name: string): string {
  const start = SRC.indexOf(`const ${name} =`);
  assert(start >= 0, `${name} not found`);
  // A template/string const ends at the first line that closes it with ; at
  // column end. Good enough for these three single-expression constants.
  return SRC.slice(start, SRC.indexOf(";\n", start));
}

Deno.test("flag off: every prompt is byte-identical", () => {
  for (const text of [COMPOSITE_SYSTEM_PROMPT, constBody("SYSTEM_PROMPT"), constBody("COMPOSITE_FACTOR_WEIGHTS")]) {
    const r = applyCleanlinessWording(text, false);
    assertEquals(r.text, text);
    assertEquals(r.applied, false);
  }
});

Deno.test("each v1 phrase really occurs in the code default it targets", () => {
  // A phrase that stopped matching would make the flag a silent no-op.
  const [perImage, composite, weights] = CLEANLINESS_WORDING.map(([v1]) => v1);
  assert(constBody("SYSTEM_PROMPT").includes(perImage), "per-image factor line moved");
  assert(COMPOSITE_SYSTEM_PROMPT.includes(composite), "composite factor line moved");
  assert(constBody("COMPOSITE_FACTOR_WEIGHTS").includes(weights), "factor-weights sentence moved");
});

Deno.test("flag on: the model is told smell cannot be judged, and the old label is gone", () => {
  const r = applyCleanlinessWording(COMPOSITE_SYSTEM_PROMPT, true);
  assertEquals(r.applied, true);
  assert(r.text.includes("Smell cannot be seen in a photo"));
  assert(!r.text.includes("Odor & Cleanliness"));
  // The factor key the model returns in JSON is unchanged: only words moved.
  assertEquals(
    COMPOSITE_SYSTEM_PROMPT.split("odor_cleanliness").length,
    r.text.split("odor_cleanliness").length,
  );
});

Deno.test("a text without the v1 phrase is not mislabelled as the v2 era", () => {
  assertEquals(applyCleanlinessWording("an operator's custom prompt", true).applied, false);
});

Deno.test("+clean2 is appended last in the suffix chain", () => {
  const base = { baseline: true, fabric: true, visual: false, tag: false, categoryV2: true, roles: true };
  assertEquals(promptVersionSuffix(base), "+baseline+fabric+cat2+roles");
  assertEquals(promptVersionSuffix({ ...base, cleanliness: true }), "+baseline+fabric+cat2+roles+clean2");
  assertEquals(promptVersionSuffix({ ...base, cleanliness: false }), "+baseline+fabric+cat2+roles");
});

Deno.test("both stages actually send the cleaned text", () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(code.includes("const systemBlock: AiSystemBlock = { text: perImageClean.text,"));
  assert(code.includes('perImageClean.applied ? "+clean2" : ""'));
  assert(code.includes("let systemText = compositeClean.text;"));
  const composite = code.slice(code.indexOf("export async function compositeGrade("));
  assertEquals((composite.match(/tagBlock,\n\s+promptBlocksForUser,\n/g) ?? []).length, 2);
  assertEquals((composite.match(/tagBlock,\n\s+compositeBlocks,\n/g) ?? []).length, 0);
});
