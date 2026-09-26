// US-3517: what analyzeImage and compositeGrade actually SEND with
// GRADING_IMAGE_TEXT_GUARD off and on. Modelled on
// label-legibility-request_test.ts: it reads the request body handed to the
// SDK, because a helper test stays green even if the grading path never calls
// the helper (US-3148).
//
// Original header of the file this harness was copied from:
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
  applyImageTextGuard,
  IMAGE_TEXT_GUARD,
} from "../lib/image-text-guard.ts";

const FLAG = "GRADING_IMAGE_TEXT_GUARD";
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
    const res = await analyzeImage(
      TINY_PNG,
      "label",
      "tops",
      "hoodie",
      [],
    ) as unknown as {
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

async function composite(
  flag: string | undefined,
  perImageVersions: string[],
): Promise<{ system: string; version: string }> {
  const before = setEnv(FLAG, flag);
  let captured: Body | null = null;
  const surface = getAnthropicClient().messages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
  const original = surface.create;
  surface.create = (body: unknown) => {
    captured ??= body as Body;
    return Promise.resolve({
      content: [{ type: "text", text: COMPOSITE_REPLY }],
      model: (body as Body).model,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  try {
    const results = perImageVersions.map((v) => ({
      ...(JSON.parse(REPLY) as object),
      image_type: "label",
      prompt_version: v,
    })) as unknown as PerImageAnalysis[];
    const out = await compositeGrade(results, GARMENT) as unknown as {
      prompt_version: string;
    };
    const system =
      ((captured as Body | null)?.system as Array<{ text?: string }> ?? [])
        .map((b) => b.text ?? "").join("\n");
    return { system, version: out.prompt_version };
  } finally {
    surface.create = original;
    setEnv(FLAG, before);
  }
}

/** Every byte the model reads: system blocks plus user-turn text. */
function modelText(body: Body): string {
  const system = (body.system as Array<{ text?: string }>).map((b) =>
    b.text ?? ""
  );
  const messages = body.messages as {
    content: Array<{ type: string; text?: string }>;
  }[];
  const user = messages.flatMap((m) => m.content).filter((b) =>
    b.type === "text"
  )
    .map((b) => b.text ?? "");
  return [...system, ...user].join("\n");
}

Deno.test("US-3517 per-image, flag off: byte-identical to no flag, no clause, no stamp", async () => {
  const unset = await run(undefined);
  const off = await run("0");
  assertEquals(JSON.stringify(off.body), JSON.stringify(unset.body));
  assert(!modelText(off.body).includes(IMAGE_TEXT_GUARD));
  assert(!(off.version ?? "").includes("+imgtext"));
});

Deno.test("US-3517 per-image, flag on: the clause reaches the system prompt, once, and the read is stamped", async () => {
  const on = await run("1");
  const text = modelText(on.body);
  assertEquals(text.split(IMAGE_TEXT_GUARD).length - 1, 1);
  assert(text.includes("UNTRUSTED INPUT"), "the US-346 guard is still there");
  assert(on.version?.endsWith("+imgtext"), `stamp: ${on.version}`);
});

Deno.test("US-3517 composite: off sends no clause; on sends it and the grade carries +imgtext", async () => {
  const off = await composite(undefined, ["per_image_v5"]);
  assert(!off.system.includes(IMAGE_TEXT_GUARD));
  assert(!off.version.includes("+imgtext"), off.version);
  const on = await composite("1", ["per_image_v5"]);
  assert(on.system.includes(IMAGE_TEXT_GUARD));
  assert(on.version.endsWith("+imgtext"), on.version);
});

Deno.test("US-3517: a prompt without the anchor is left alone and not stamped", () => {
  assertEquals(applyImageTextGuard("no guard here", "UNTRUSTED INPUT", true), {
    text: "no guard here",
    applied: false,
  });
  assertEquals(
    applyImageTextGuard("A UNTRUSTED INPUT B", "UNTRUSTED INPUT", false),
    {
      text: "A UNTRUSTED INPUT B",
      applied: false,
    },
  );
});

Deno.test("US-3517: +imgtext is appended last in the grade suffix chain", () => {
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
    legible2: true,
  };
  assertEquals(
    promptVersionSuffix({ ...all, imageTextGuard: true }),
    promptVersionSuffix(all) + "+imgtext",
  );
  assertEquals(
    promptVersionSuffix({ ...all, imageTextGuard: false }),
    promptVersionSuffix(all),
  );
});
