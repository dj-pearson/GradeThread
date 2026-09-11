// US-3150: the per-image schema + rules (6,251 chars) move out of the USER turn
// and into a SECOND cached system block, behind GRADING_SCHEMA_IN_SYSTEM.
//
// WHY THIS FILE ASSERTS ON THE REQUEST BODY AND NOT ON buildUserPrompt().
// US-3148's cache test passed with the feature deleted, because it exercised the
// helpers and never the body. prompt-blocks_test.ts has the same blind spot by
// construction: it calls buildUserPrompt/buildCompositeUserPrompt directly, so
// every assertion there stays green whether analyzeImage sends the tail in the
// user turn, in a system block, or twice. So this file stubs
// client.messages.create and reads what the grading path actually handed the
// SDK - system block array, cache_control on each block, and the text of the
// user turn.
//
//   deno test --allow-all src/tests/grading-schema-system-block_test.ts

import "./_env.ts";

// getAnthropicClient() throws with no key and memoizes on first call, so this
// has to run before any import that might construct it. Deliberately not
// key-shaped: a realistic fixture trips gitleaks on entropy alone.
if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { getAnthropicClient } from "../lib/ai-config.ts";
import {
  analyzeImage,
  buildCompositeUserPrompt,
  buildUserPrompt,
  compositeGrade,
  compositeTailText,
  type GarmentInfo,
  perImageTailText,
  schemaInSystemEnabled,
  unversionedPromptSurface,
  unversionedPromptSurfaceHash,
} from "../lib/ai-grading.ts";

const EPH = { type: "ephemeral" } as const;
const GATE = "GRADING_SCHEMA_IN_SYSTEM";

// Strings unique to each half of the moved text. The schema opener also appears
// in ai-authenticity.ts, but that module is not in this request path; the rules
// opener is pinned on its own distinctive first bullet so a match cannot come
// from the composite tail or from a criteria block.
const PER_IMAGE_SCHEMA_MARK = '"detected_issues"';
const PER_IMAGE_RULES_MARK = "- detected_issues: List every visible issue.";
const COMPOSITE_SCHEMA_MARK = '"buyer_writeup"';
const COMPOSITE_RULES_MARK =
  "- overall_score must be the weighted average of factor scores";
const WEIGHTS_MARK = "Apply the factor weights (Fabric 30%";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PER_IMAGE_JSON = JSON.stringify({
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

const COMPOSITE_JSON = JSON.stringify({
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

type Body = Record<string, unknown>;
type Block = Record<string, unknown>;

const GARMENT: GarmentInfo = {
  garment_type: "tops",
  garment_category: "hoodie",
  brand: null,
  title: "",
  description: null,
};

function setEnv(key: string, value: string | undefined): string | undefined {
  const before = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  return before;
}

/**
 * Run one grading call against a stubbed SDK and return the request body.
 *
 * The stub CAPTURES first and answers second, and the caller swallows anything
 * the pipeline throws afterwards: the property under test is what was sent, and
 * a fixture that has to keep the whole post-parse path happy is a fixture that
 * rots into a source scan.
 */
async function bodySentBy(
  run: () => Promise<unknown>,
  opts: { gate: boolean; caching?: boolean; replyJson: string },
): Promise<Body> {
  const beforeGate = setEnv(GATE, opts.gate ? "1" : undefined);
  const beforeCaching = setEnv(
    "AI_ENABLE_CACHING",
    opts.caching === false ? "0" : "1",
  );
  const client = getAnthropicClient();
  const surface = client.messages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
  const original = surface.create;
  let captured: Body | null = null;
  surface.create = (body: unknown) => {
    if (!captured) captured = body as Body;
    return Promise.resolve({
      content: [{ type: "text", text: opts.replyJson }],
      model: (body as Body).model,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  try {
    await run();
  } catch {
    // Post-send failures are not this file's subject - the body is already held.
  } finally {
    surface.create = original;
    setEnv(GATE, beforeGate);
    setEnv("AI_ENABLE_CACHING", beforeCaching);
  }
  const body = captured as Body | null;
  if (!body) throw new Error("the grading path never called messages.create");
  return body;
}

function perImageBody(
  opts: {
    gate: boolean;
    caching?: boolean;
    blockOverride?: Record<string, { text: string; versionName: string }>;
  },
): Promise<Body> {
  return bodySentBy(
    () =>
      analyzeImage(
        TINY_PNG,
        "front",
        "tops",
        "hoodie",
        [],
        undefined,
        undefined,
        undefined,
        "",
        opts.blockOverride as never,
      ),
    { gate: opts.gate, caching: opts.caching, replyJson: PER_IMAGE_JSON },
  );
}

function compositeBody(opts: { gate: boolean; caching?: boolean }): Promise<Body> {
  return bodySentBy(
    () => compositeGrade([], GARMENT),
    { gate: opts.gate, caching: opts.caching, replyJson: COMPOSITE_JSON },
  );
}

function systemBlocks(body: Body): Block[] {
  const system = body.system;
  assert(
    Array.isArray(system),
    "system must be a block array - a bare string cannot carry a second breakpoint",
  );
  return system as Block[];
}

function userText(body: Body): string {
  const messages = body.messages as { role: string; content: Block[] }[];
  const user = messages.find((m) => m.role === "user");
  assert(user, "no user message in the request body");
  return (user!.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => String(b.text))
    .join("\n");
}

// ── AC1: the per-image tail rides in a second cached system block ────────────

Deno.test("US-3150 AC1: the per-image schema+rules are sent as a SECOND cached system block", async () => {
  const body = await perImageBody({ gate: true });
  const blocks = systemBlocks(body);

  assertEquals(
    blocks.length,
    2,
    "the per-image request still sends ONE system block, so the 6,251 chars of " +
      "schema and rules are still being re-billed in the user turn on every photo",
  );

  // Order is load-bearing: prompt first, schema+rules second, so an edit to the
  // tail leaves the prompt half of the prefix shared (AC1).
  assert(
    String(blocks[0]!.text).includes("expert clothing condition assessor"),
    "block 0 is not the per-image system prompt - the two blocks are the wrong " +
      "way round, and a tail edit would now invalidate the prompt half too",
  );
  assert(
    String(blocks[1]!.text).includes(PER_IMAGE_SCHEMA_MARK) &&
      String(blocks[1]!.text).includes(PER_IMAGE_RULES_MARK),
    "block 1 does not carry both the response schema and the rules",
  );
  assert(
    String(blocks[1]!.text).indexOf(PER_IMAGE_SCHEMA_MARK) <
      String(blocks[1]!.text).indexOf(PER_IMAGE_RULES_MARK),
    "the tail was reordered - the rules qualify the schema, so they follow it",
  );

  // Both breakpoints present: the second one is what the moved text is cached at.
  assertEquals(blocks[0]!.cache_control, EPH);
  assertEquals(blocks[1]!.cache_control, EPH);

  // And the user turn must no longer carry it. This is the whole saving.
  const text = userText(body);
  assert(
    !text.includes(PER_IMAGE_SCHEMA_MARK),
    "the response schema is STILL in the user turn - moving it into the system " +
      "block without removing it from the user message sends it twice, which " +
      "costs more than the bug did",
  );
  assert(
    !text.includes(PER_IMAGE_RULES_MARK),
    "the rules block is still in the user turn",
  );
  assert(
    text.includes("IMAGE CONTEXT:") && text.includes("GARMENT-TYPE CRITERIA:"),
    "the per-image head did not survive the split",
  );
});

Deno.test("US-3150: with the gate OFF the body is the one that shipped", async () => {
  const body = await perImageBody({ gate: false });
  const blocks = systemBlocks(body);
  assertEquals(
    blocks.length,
    1,
    "the gate is OFF and the request already carries a second system block. " +
      "This change must be inert until the prompt-version lane has run it.",
  );
  const text = userText(body);
  assert(text.includes(PER_IMAGE_SCHEMA_MARK), "schema left the user turn while off");
  assert(text.includes(PER_IMAGE_RULES_MARK), "rules left the user turn while off");
  assertEquals(schemaInSystemEnabled(), false);
});

Deno.test("US-3150: no bytes are added or lost by the split", () => {
  // The move is a relocation, not a rewrite. head + "\n\n" + tail must be the
  // exact string the user turn used to be, or the shadow compare is measuring a
  // text edit it was never told about.
  const joined = buildUserPrompt("front", "tops", "hoodie", [], "");
  const head = buildUserPrompt("front", "tops", "hoodie", [], "", {}, undefined, true);
  assertEquals(`${head}\n\n${perImageTailText()}`, joined);

  const compositeJoined = buildCompositeUserPrompt([], GARMENT);
  const compositeHead = buildCompositeUserPrompt([], GARMENT, "", "", "", {}, true);
  assertEquals(
    `${compositeHead}\n\n${compositeTailText()}`,
    compositeJoined,
  );
});

// ── AC2: the composite tail gets the same treatment ─────────────────────────

Deno.test("US-3150 AC2: the composite schema+rules ride in a second cached system block", async () => {
  const body = await compositeBody({ gate: true });
  const blocks = systemBlocks(body);
  assertEquals(blocks.length, 2, "the composite call still sends one system block");
  assert(
    String(blocks[0]!.text).includes("expert clothing condition grading specialist"),
    "block 0 is not the composite system prompt",
  );
  assert(
    String(blocks[1]!.text).includes(COMPOSITE_SCHEMA_MARK) &&
      String(blocks[1]!.text).includes(COMPOSITE_RULES_MARK),
    "block 1 does not carry the composite schema and rules",
  );
  assertEquals(blocks[1]!.cache_control, EPH);

  const text = userText(body);
  assert(!text.includes(COMPOSITE_SCHEMA_MARK), "composite schema still in the user turn");
  assert(!text.includes(COMPOSITE_RULES_MARK), "composite rules still in the user turn");
  // The factor-weights sentence deliberately STAYS in the user turn: it is one
  // line, it is the block an operator overrides per garment scope, and it is the
  // grading contract restated. Moving it would put the contract behind a
  // breakpoint that a scope override then has to invalidate.
  assert(
    text.includes(WEIGHTS_MARK),
    "the factor-weights sentence left the user turn - it is not in scope for this move",
  );
});

Deno.test("US-3150: the composite body with the gate OFF is unchanged", async () => {
  const body = await compositeBody({ gate: false });
  assertEquals(systemBlocks(body).length, 1);
  const text = userText(body);
  assert(text.includes(COMPOSITE_SCHEMA_MARK));
  assert(text.includes(COMPOSITE_RULES_MARK));
});

// ── AC3: a block override still wins, and lands in the block it named ───────

Deno.test("US-3150 AC3: a per-image block override changes the SYSTEM block, not the user turn", async () => {
  const body = await perImageBody({
    gate: true,
    blockOverride: {
      per_image_response_schema: { text: "PI SCHEMA OVERRIDE", versionName: "pis_v2" },
      per_image_rules: { text: "PI RULES OVERRIDE", versionName: "pir_v2" },
    },
  });
  const blocks = systemBlocks(body);
  const tail = String(blocks[1]!.text);
  assert(
    tail.includes("PI SCHEMA OVERRIDE") && tail.includes("PI RULES OVERRIDE"),
    "an ai_prompt_versions block override no longer reaches the prompt at all - " +
      "US-2438's registry was silently disconnected by the move",
  );
  assert(
    !tail.includes(PER_IMAGE_SCHEMA_MARK),
    "the code default survived alongside the override - two response schemas in " +
      "one prompt reads as working until the model picks the wrong one",
  );
  assertEquals(
    userText(body).includes("PI SCHEMA OVERRIDE"),
    false,
    "the override landed in the user turn, so an operator override forfeits the " +
      "caching this story exists to gain",
  );
});

Deno.test("US-3150 AC3: an override of ONE key leaves the other at its code default", () => {
  const rulesOnly = perImageTailText({
    per_image_rules: { text: "ONLY RULES", versionName: "r_v2" },
  });
  assert(rulesOnly.includes("ONLY RULES"));
  assert(
    rulesOnly.includes(PER_IMAGE_SCHEMA_MARK),
    "overriding the rules also replaced the schema, so the two can no longer be " +
      "versioned or reviewed apart",
  );

  const schemaOnly = compositeTailText({
    composite_response_schema: { text: "ONLY SCHEMA", versionName: "s_v2" },
  });
  assert(schemaOnly.includes("ONLY SCHEMA"));
  assert(
    schemaOnly.includes(COMPOSITE_RULES_MARK),
    "overriding the composite schema also replaced the composite rules",
  );
});

// ── AC4: the unversioned surface hash still covers the moved text ───────────

Deno.test("US-3150 AC4: the surface still digests the moved text, in both gate states", () => {
  for (const on of [false, true]) {
    const before = setEnv(GATE, on ? "1" : undefined);
    try {
      const surface = unversionedPromptSurface();
      assert(
        surface.includes(PER_IMAGE_SCHEMA_MARK),
        `the per-image response schema left the probed surface (gate=${on}), so ` +
          "an edit to it would no longer move the hash",
      );
      assert(
        surface.includes(PER_IMAGE_RULES_MARK),
        `the per-image rules left the probed surface (gate=${on})`,
      );
      assert(
        surface.includes(COMPOSITE_RULES_MARK),
        `the composite rules left the probed surface (gate=${on})`,
      );
    } finally {
      setEnv(GATE, before);
    }
  }
});

Deno.test("US-3150 AC4: flipping the gate MOVES the hash, and OFF is the pre-change hash", () => {
  const off = (() => {
    const b = setEnv(GATE, undefined);
    try {
      return unversionedPromptSurfaceHash();
    } finally {
      setEnv(GATE, b);
    }
  })();
  const on = (() => {
    const b = setEnv(GATE, "1");
    try {
      return unversionedPromptSurfaceHash();
    } finally {
      setEnv(GATE, b);
    }
  })();
  assertNotEquals(
    off,
    on,
    "the surface hash does not move when the schema and rules change ROLE. Two " +
      "grades on opposite sides of the flip would read as comparable when they " +
      "are not - which is the one question this fingerprint exists to answer.",
  );
  // The OFF surface must be the exact string the pre-change code produced, so an
  // eval run recorded before this commit stays comparable with one recorded
  // after it while the gate is off. Pinned as the concatenation, not as a magic
  // hex value, so a legitimate prompt edit reddens the eval gate and not this.
  const b = setEnv(GATE, undefined);
  try {
    const surface = unversionedPromptSurface();
    assert(
      surface.includes(
        `${
          buildUserPrompt("front", "tops", "", [], "", {}, undefined, true)
        }\n\n${perImageTailText()}`,
      ),
      "the gate-OFF surface is no longer the joined user prompt, so every hash " +
        "recorded before this commit has silently changed meaning",
    );
  } finally {
    setEnv(GATE, b);
  }
});

// ── AI_ENABLE_CACHING=0 removes both breakpoints and nothing else ───────────

Deno.test("US-3150: caching off removes both breakpoints and leaves the text alone", async () => {
  const on = await perImageBody({ gate: true, caching: true });
  const off = await perImageBody({ gate: true, caching: false });
  const onBlocks = systemBlocks(on);
  const offBlocks = systemBlocks(off);
  assertEquals(offBlocks.length, onBlocks.length);
  for (const b of offBlocks) {
    assertEquals(
      b.cache_control,
      undefined,
      "AI_ENABLE_CACHING=0 left a breakpoint on a grading system block",
    );
  }
  assertEquals(
    offBlocks.map((b) => b.text),
    onBlocks.map((b) => b.text),
    "turning caching off changed the TEXT, not just the breakpoints",
  );
  assertEquals(userText(off), userText(on));
});
