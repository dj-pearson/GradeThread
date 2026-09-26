// US-3538 AC2: each core photo is asked whether it shows the view it was
// uploaded as. Inert behind GRADING_VIEW_CHECK; reads the request body handed
// to the SDK, like image-text-guard-request_test.ts, because a helper test
// stays green even if the grading path never calls the helper (US-3148).

import "./_env.ts";

if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals } from "@std/assert";
import { getAnthropicClient } from "../lib/ai-config.ts";
import { analyzeImage, promptVersionSuffix } from "../lib/ai-grading.ts";
import { evaluateImageQuality } from "../lib/image-quality.ts";
import {
  applyViewCheckWording,
  outputSchemaWithViewCheck,
  VIEW_CHECK_RULE,
  viewMismatchSlots,
} from "../lib/view-check.ts";

const FLAG = "GRADING_VIEW_CHECK";
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function reply(extra: Record<string, unknown>) {
  return JSON.stringify({
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
    ...extra,
  });
}

type Body = Record<string, unknown>;

async function run(flag: string | undefined, extra: Record<string, unknown> = {}) {
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
      content: [{ type: "text", text: reply(extra) }],
      model: (body as Body).model,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  let result: { prompt_version?: string; matches_declared_view?: boolean | null } | null = null;
  try {
    result = await analyzeImage(TINY_PNG, "front", "tops", "hoodie", []) as never;
  } finally {
    surface.create = original;
    if (before === undefined) Deno.env.delete(FLAG);
    else Deno.env.set(FLAG, before);
  }
  if (!captured) throw new Error("analyzeImage never called messages.create");
  return { body: JSON.stringify(captured), result };
}

Deno.test("US-3538: off, the request is byte-identical and nothing is stamped", async () => {
  const unset = await run(undefined);
  const off = await run("0");
  assertEquals(off.body, unset.body);
  assert(!unset.body.includes("matches_declared_view"));
  assert(!unset.result?.prompt_version?.includes("+view"));
  assertEquals("matches_declared_view" in (unset.result ?? {}), false);
});

Deno.test("US-3538: on, the schema, rules and stamp all carry the question", async () => {
  const on = await run("1", { matches_declared_view: false });
  assert(on.body.includes('\\"matches_declared_view\\": true | false'), "schema text");
  assert(on.body.includes("matches_declared_view: this photo was uploaded"), "rules text");
  assert(on.result?.prompt_version?.endsWith("+view"), on.result?.prompt_version);
  assertEquals(on.result?.matches_declared_view, false);
});

Deno.test("US-3538: the wording needs both anchors or does nothing", () => {
  const r = applyViewCheckWording("no anchor", "\n- Be precise and objective.", true);
  assertEquals(r.applied, false);
  const ok = applyViewCheckWording('{\n  "quality": {', "x\n- Be precise and objective.", true);
  assert(ok.applied && ok.rulesText.includes(VIEW_CHECK_RULE));
});

Deno.test("US-3538: the structured schema requires the field and leaves the original alone", () => {
  const base = { type: "object", properties: { a: {} }, required: ["a"] };
  const out = outputSchemaWithViewCheck(base);
  assertEquals((out.required as string[]).at(-1), "matches_declared_view");
  assertEquals(base.required, ["a"]);
});

Deno.test("US-3538: a wrong core view blocks; detail shots and unasked reads never do", () => {
  assertEquals(
    viewMismatchSlots([
      { image_type: "front", matches_declared_view: false },
      { image_type: "detail_1", matches_declared_view: false },
      { image_type: "back", matches_declared_view: null },
      { image_type: "label" },
    ]),
    ["front"],
  );
  const gate = evaluateImageQuality([
    { image_type: "front", matches_declared_view: false },
    { image_type: "back" },
    { image_type: "label" },
    { image_type: "detail_1" },
  ]);
  assert(gate.abstain);
  assert(gate.photo_requests.some((m) => m.includes("front of the same item")));
  const clean = evaluateImageQuality([
    { image_type: "front" },
    { image_type: "back" },
    { image_type: "label" },
    { image_type: "detail_1" },
  ]);
  assertEquals(clean.abstain, false);
});

Deno.test("US-3538: +view is appended last in the grade suffix", () => {
  assertEquals(promptVersionSuffix({
    baseline: false,
    fabric: false,
    visual: false,
    tag: false,
    noMeasure: true,
    viewCheck: true,
  }), "+nomeasure+view");
});
