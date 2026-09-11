// US-3332: what analyzeImage actually SENDS with GRADING_SCALE_REFERENCE off
// and on. scale-reference_test.ts proves the swap on a string; this stubs
// client.messages.create and reads the request body, because a helper test
// stays green even if the grading path never calls the helper (US-3148).
//
//   deno test --allow-net --allow-env --allow-read src/tests/scale-reference-request_test.ts

import "./_env.ts";

if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals } from "@std/assert";
import { getAnthropicClient } from "../lib/ai-config.ts";
import {
  analyzeImage,
  compositeGrade,
  type GarmentInfo,
  type PerImageAnalysis,
  promptVersionSuffix,
} from "../lib/ai-grading.ts";
import { SCALE_V1_PHRASE, US_QUARTER_MM } from "../lib/scale-reference.ts";

const FLAG = "GRADING_SCALE_REFERENCE";
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const REPLY = JSON.stringify({
  detected_issues: [],
  style_attributes: [],
  condition_signals: [],
  estimated_scores: {
    fabric_condition: 8,
    structural_integrity: 8,
    cosmetic_appearance: 8,
    functional_elements: 8,
    odor_cleanliness: 8,
  },
  unassessable_factors: [],
  fiber_content: [],
});

type Body = Record<string, unknown>;

async function run(flag: string | undefined): Promise<{ body: Body; version: string | null }> {
  const before = Deno.env.get(FLAG);
  if (flag === undefined) Deno.env.delete(FLAG);
  else Deno.env.set(FLAG, flag);
  const surface = getAnthropicClient().messages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
  const original = surface.create;
  let captured: Body | null = null;
  surface.create = (body: unknown) => {
    captured ??= body as Body;
    return Promise.resolve({
      content: [{ type: "text", text: REPLY }],
      model: (body as Body).model,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  let version: string | null = null;
  try {
    const res = await analyzeImage(TINY_PNG, "defect", "tops", "hoodie", []) as unknown as {
      prompt_version?: string;
    };
    version = res?.prompt_version ?? null;
  } catch {
    // What was sent is the subject; a post-parse failure does not change it.
  } finally {
    surface.create = original;
    if (before === undefined) Deno.env.delete(FLAG);
    else Deno.env.set(FLAG, before);
  }
  if (!captured) throw new Error("analyzeImage never called messages.create");
  return { body: captured, version };
}

function systemText(body: Body): string {
  const system = body.system;
  if (typeof system === "string") return system;
  return (system as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n");
}

Deno.test("flag off: the request is byte-identical to no flag at all, and no +scale stamp", async () => {
  const unset = await run(undefined);
  const off = await run("0");
  assertEquals(JSON.stringify(off.body.system), JSON.stringify(unset.body.system));
  assertEquals(JSON.stringify(off.body.messages), JSON.stringify(unset.body.messages));
  assert(systemText(off.body).includes(SCALE_V1_PHRASE), "the sizing phrase is in the per-image prompt");
  assert(!(off.version ?? "").includes("+scale"));
});

Deno.test("flag on: the grader is told the three sizes, and the analysis says so", async () => {
  const on = await run("1");
  const text = systemText(on.body);
  assert(text.includes(`${US_QUARTER_MM} mm`), "the quarter's size reached the model");
  assert(!text.includes(SCALE_V1_PHRASE), "the old phrase was replaced, not left beside the new one");
  assert(on.version, "analyzeImage returned a prompt_version");
  assert(on.version!.includes("+scale"), `stamp: ${on.version}`);
  assert(!on.version!.endsWith("+scale+scale"));
});

// ── the grade-level stamp ───────────────────────────────────────────────────

Deno.test("+scale is appended last in the grade suffix chain, and absent means absent", () => {
  const all = { baseline: true, fabric: true, visual: true, tag: true, categoryV2: true, roles: true, cleanliness: true, schemaSystem: true };
  assertEquals(promptVersionSuffix(all), "+baseline+fabric+visual+tag+cat2+roles+clean2+sysschema");
  assertEquals(promptVersionSuffix({ ...all, scale: true }), "+baseline+fabric+visual+tag+cat2+roles+clean2+sysschema+scale");
  assertEquals(promptVersionSuffix({ ...all, scale: false }), promptVersionSuffix(all));
});

const COMPOSITE_REPLY = JSON.stringify({
  overall_score: 8,
  grade_tier: "Excellent",
  factor_scores: {
    fabric_condition: 8,
    structural_integrity: 8,
    cosmetic_appearance: 8,
    functional_elements: 8,
    odor_cleanliness: 8,
  },
  ai_summary: "ok",
  buyer_writeup: "ok",
  defects_found: [],
  style_attributes: [],
  confidence_score: 0.9,
  image_validity: { is_clothing: true, reason: "" },
});
const GARMENT: GarmentInfo = { garment_type: "tops", garment_category: "hoodie", brand: null, title: "", description: null };

async function compositeVersion(perImageVersions: string[]): Promise<string> {
  const surface = getAnthropicClient().messages as unknown as { create: (...args: unknown[]) => unknown };
  const original = surface.create;
  surface.create = (body: unknown) =>
    Promise.resolve({
      content: [{ type: "text", text: COMPOSITE_REPLY }],
      model: (body as Body).model,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  try {
    const results = perImageVersions.map((v) => ({
      ...(JSON.parse(REPLY) as object),
      image_type: "defect",
      prompt_version: v,
    })) as unknown as PerImageAnalysis[];
    const out = await compositeGrade(results, GARMENT) as unknown as { prompt_version: string };
    return out.prompt_version;
  } finally {
    surface.create = original;
  }
}

Deno.test("the grade says +scale only when a photo read actually ran the scale wording", async () => {
  assert((await compositeVersion(["per_image_v2+scale", "per_image_v2"])).endsWith("+scale"));
  assert((await compositeVersion(["per_image_v2+sysschema+scale"])).endsWith("+scale"));
  assert(!(await compositeVersion(["per_image_v2", "per_image_v2+clean2"])).includes("+scale"));
  // A look-alike is not the stamp.
  assert(!(await compositeVersion(["per_image_v2+scalex"])).includes("+scale"));
});
