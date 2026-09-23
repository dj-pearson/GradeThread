// US-3321: what analyzeImage actually SENDS with GRADING_LEGIBLE_V2 off and on.
//
// The v1 Rules clause defined legible as "the brand/size/care text is
// readable", so a sharp photo of a Lululemon size dot or a heat-transfer neck
// print scored legible=false and picked up ILLEGIBLE_LABEL_CONFIDENCE_CAP. The
// v2 clause is prompt text, so it ships inert behind a flag and rides the
// shadow -> eval -> canary lane. This file reads the request body handed to the
// SDK, not a helper's return value, because a helper test stays green even if
// the grading path never calls the helper (US-3148).
//
//   deno test --allow-net --allow-env --allow-read src/tests/label-legibility-request_test.ts

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
import {
  applyLegibleWording,
  LEGIBLE_V1_PHRASE,
  LEGIBLE_V2_PHRASE,
} from "../lib/label-legibility.ts";

const FLAG = "GRADING_LEGIBLE_V2";
const SCHEMA_GATE = "GRADING_SCHEMA_IN_SYSTEM";
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

function setEnv(key: string, value: string | undefined): string | undefined {
  const before = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  return before;
}

async function run(
  flag: string | undefined,
  schemaInSystem = false,
): Promise<{ body: Body; version: string | null }> {
  const before = setEnv(FLAG, flag);
  const beforeSchema = setEnv(SCHEMA_GATE, schemaInSystem ? "1" : undefined);
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
    const res = await analyzeImage(TINY_PNG, "label", "tops", "hoodie", []) as unknown as {
      prompt_version?: string;
    };
    version = res?.prompt_version ?? null;
  } catch {
    // What was sent is the subject; a post-parse failure does not change it.
  } finally {
    surface.create = original;
    setEnv(FLAG, before);
    setEnv(SCHEMA_GATE, beforeSchema);
  }
  if (!captured) throw new Error("analyzeImage never called messages.create");
  return { body: captured, version };
}

/** Every byte the model reads: system blocks plus user-turn text. */
function modelText(body: Body): string {
  const system = (body.system as Array<{ text?: string }>).map((b) => b.text ?? "");
  const messages = body.messages as { content: Array<{ type: string; text?: string }> }[];
  const user = messages.flatMap((m) => m.content).filter((b) => b.type === "text")
    .map((b) => b.text ?? "");
  return [...system, ...user].join("\n");
}

Deno.test("the v1 clause is really in the shipped Rules block, so the flag is not a silent no-op", async () => {
  const off = await run(undefined);
  assert(modelText(off.body).includes(LEGIBLE_V1_PHRASE));
});

Deno.test("flag off: the request is byte-identical to no flag at all, and no +legible2 stamp", async () => {
  const unset = await run(undefined);
  const off = await run("0");
  assertEquals(JSON.stringify(off.body), JSON.stringify(unset.body));
  assert(!(off.version ?? "").includes("+legible2"));
});

Deno.test("flag on: the tagless definition reaches the model, the v1 clause is gone, and the read says so", async () => {
  const on = await run("1");
  const text = modelText(on.body);
  assert(text.includes(LEGIBLE_V2_PHRASE), "the v2 definition reached the model");
  assert(text.includes("silicone size dot"), "the tagless cases are named");
  assert(!text.includes(LEGIBLE_V1_PHRASE), "the old clause was replaced, not left beside the new one");
  assert(on.version?.endsWith("+legible2"), `stamp: ${on.version}`);
  // No block override resolved, so the swap must not masquerade as one.
  assert(!on.version!.includes("+blocks("), `stamp: ${on.version}`);
});

Deno.test("flag on with the schema in the system block: the v2 clause lands in the cached tail", async () => {
  const on = await run("1", true);
  const blocks = (on.body.system as Array<{ text?: string }>).map((b) => b.text ?? "");
  assertEquals(blocks.length, 2);
  assert(blocks[1].includes(LEGIBLE_V2_PHRASE));
  assert(!blocks[1].includes(LEGIBLE_V1_PHRASE));
  assert(on.version?.endsWith("+sysschema+legible2"), `stamp: ${on.version}`);
});

Deno.test("a rules text without the v1 clause is left alone and not stamped", () => {
  assertEquals(applyLegibleWording("Rules:\n- something else", true), {
    text: "Rules:\n- something else",
    applied: false,
  });
});

// -- the grade-level stamp -------------------------------------------------

Deno.test("+legible2 is appended last in the grade suffix chain, and absent means absent", () => {
  const all = {
    baseline: true,
    fabric: true,
    visual: true,
    tag: true,
    categoryV2: true,
    roles: true,
    cleanliness: true,
    schemaSystem: true,
    scale: true,
    anchors: true,
    fabricZoom: true,
  };
  assertEquals(promptVersionSuffix({ ...all, legible2: true }), promptVersionSuffix(all) + "+legible2");
  assertEquals(promptVersionSuffix({ ...all, legible2: false }), promptVersionSuffix(all));
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
const GARMENT: GarmentInfo = {
  garment_type: "tops",
  garment_category: "hoodie",
  brand: null,
  title: "",
  description: null,
};

async function compositeVersion(perImageVersions: string[]): Promise<string> {
  const surface = getAnthropicClient().messages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
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
      image_type: "label",
      prompt_version: v,
    })) as unknown as PerImageAnalysis[];
    const out = await compositeGrade(results, GARMENT) as unknown as { prompt_version: string };
    return out.prompt_version;
  } finally {
    surface.create = original;
  }
}

Deno.test("the grade says +legible2 only when a photo read actually ran the v2 clause", async () => {
  assert((await compositeVersion(["per_image_v5+legible2", "per_image_v5"])).endsWith("+legible2"));
  assert(!(await compositeVersion(["per_image_v5", "per_image_v5+scale"])).includes("+legible2"));
  assert(!(await compositeVersion(["per_image_v5+legible2x"])).includes("+legible2"));
});
