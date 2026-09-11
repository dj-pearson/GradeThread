// US-3345: grading writes a prompt-cache entry on every per-image call and can
// never read one back, because the per-image calls are all in flight at once.
//
// An Anthropic cache entry becomes readable only once the request that WRITES
// it has begun streaming. grading-pipeline.ts fans every photo out together, so
// photos 1..N of one submission each pay the 1.25x write premium on the same
// 5,565-character system prompt and none of them reads it. The composite call
// is a single call, so it has nothing to read either.
//
// This file pins three things, all on the request body the grading path really
// handed the SDK (the lesson of grading-schema-system-block_test.ts's header:
// a test that calls the prompt HELPERS stays green whether the request carries
// cache_control or not):
//
//   1. The premise. Two per-image calls for the SAME garment send a
//      byte-identical system prefix, which is what makes the concurrent fan-out
//      N duplicate writes rather than N distinct prefixes.
//   2. The default is unchanged. With GRADING_ENABLE_CACHING unset, every
//      grading system block still carries cache_control, exactly as shipped.
//   3. GRADING_ENABLE_CACHING is a BILLING switch, not a prompt change. Off,
//      the cache_control markers go and the block TEXT and the reported
//      prompt_version are byte-identical - which is why flipping it does not
//      ride the shadow -> eval-gate -> canary lane in .claude/skills/
//      grading-engine, and gets no prompt_version suffix.
//
// Plus one WIRING scan (mode 0 of guards-that-do-not-guard: scans are right for
// where things are wired and wrong for logic): both per-image fan-outs in
// grading-pipeline.ts still issue their calls concurrently. If anyone staggers
// them, this fails and sends them back to US-3345's latency decision instead of
// letting the cost comment rot into a false statement.
//
//   deno test --allow-all src/tests/grading-cache-premium_test.ts

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
  compositeGrade,
  type GarmentInfo,
} from "../lib/ai-grading.ts";

const GRADING_GATE = "GRADING_ENABLE_CACHING";
const GLOBAL_GATE = "AI_ENABLE_CACHING";
const SCHEMA_GATE = "GRADING_SCHEMA_IN_SYSTEM";

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

const GARMENT: GarmentInfo = {
  garment_type: "tops",
  garment_category: "hoodie",
  brand: null,
  title: "",
  description: null,
};

type Body = Record<string, unknown>;
type Block = Record<string, unknown>;

function setEnv(key: string, value: string | undefined): string | undefined {
  const before = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  return before;
}

interface CallOpts {
  /** undefined = the shipped default (the switch is not set at all). */
  grading?: string;
  /** undefined = the shipped default for AI_ENABLE_CACHING too. */
  global?: string;
  schemaGate?: boolean;
}

/**
 * Run one real grading call against a stubbed SDK and return BOTH the request
 * body and whatever the grading path returned.
 *
 * The stub captures first and answers second; the caller swallows anything the
 * post-parse path throws, because the subject here is what was SENT plus the
 * version that was stamped, not whether a one-pixel PNG survives scoring.
 */
async function callGrading(
  run: () => Promise<unknown>,
  opts: CallOpts & { replyJson: string },
): Promise<{ body: Body; result: unknown }> {
  const beforeGrading = setEnv(GRADING_GATE, opts.grading);
  const beforeGlobal = setEnv(GLOBAL_GATE, opts.global);
  const beforeSchema = setEnv(SCHEMA_GATE, opts.schemaGate ? "1" : undefined);
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
  let result: unknown = null;
  try {
    result = await run();
  } catch {
    // Post-send failures are not this file's subject - the body is already held.
  } finally {
    surface.create = original;
    setEnv(GRADING_GATE, beforeGrading);
    setEnv(GLOBAL_GATE, beforeGlobal);
    setEnv(SCHEMA_GATE, beforeSchema);
  }
  const body = captured as Body | null;
  if (!body) throw new Error("the grading path never called messages.create");
  return { body, result };
}

function perImageCall(
  opts: CallOpts & { imageType?: string } = {},
): Promise<{ body: Body; result: unknown }> {
  return callGrading(
    () =>
      analyzeImage(
        TINY_PNG,
        opts.imageType ?? "front",
        "tops",
        "hoodie",
      ),
    { ...opts, replyJson: PER_IMAGE_JSON },
  );
}

function compositeCall(
  opts: CallOpts = {},
): Promise<{ body: Body; result: unknown }> {
  return callGrading(
    () => compositeGrade([], GARMENT),
    { ...opts, replyJson: COMPOSITE_JSON },
  );
}

function systemBlocks(body: Body): Block[] {
  const system = body.system;
  assert(
    Array.isArray(system),
    "system must be a block array - a bare string carries no cache_control",
  );
  return system as Block[];
}

/** The `cache_control` value of each system block, in order. */
function cacheMarkers(body: Body): Array<unknown> {
  return systemBlocks(body).map((b) => b.cache_control ?? null);
}

/** The TEXT of each system block, in order - the thing the model actually reads. */
function systemTexts(body: Body): string[] {
  return systemBlocks(body).map((b) => String(b.text ?? ""));
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

// -- 1. The premise: N photos, one identical prefix, N writes -----------------

Deno.test("US-3345: two photos of one garment send a BYTE-IDENTICAL cached prefix", async () => {
  const front = await perImageCall({ imageType: "front" });
  const back = await perImageCall({ imageType: "back" });

  assertEquals(
    systemTexts(front.body),
    systemTexts(back.body),
    "the per-image system prefix must not vary by image type - if it did, the " +
      "concurrent fan-out would be writing N DIFFERENT entries and US-3345's " +
      "premise (N duplicate writes of one entry) would not hold",
  );
  // And the calls really are distinct calls, not the same one captured twice.
  assertNotEquals(
    userText(front.body),
    userText(back.body),
    "front and back must differ somewhere, or this test compared one call to itself",
  );
  // Every block of that identical prefix is marked for caching by default, so
  // every photo pays the write premium on all of it.
  for (const marker of cacheMarkers(front.body)) {
    assertEquals(
      marker,
      { type: "ephemeral" },
      "a grading system block is unmarked - US-3345's arithmetic assumes all of them are",
    );
  }
});

// -- 2. The shipped default is unchanged -------------------------------------

Deno.test("US-3345: with GRADING_ENABLE_CACHING unset, per-image caching is ON (unchanged)", async () => {
  const { body } = await perImageCall();
  assertEquals(cacheMarkers(body), [{ type: "ephemeral" }]);
});

Deno.test("US-3345: with GRADING_ENABLE_CACHING unset, BOTH per-image blocks stay cached under the US-3150 gate", async () => {
  const { body } = await perImageCall({ schemaGate: true });
  assertEquals(cacheMarkers(body), [{ type: "ephemeral" }, { type: "ephemeral" }]);
});

Deno.test("US-3345: with GRADING_ENABLE_CACHING unset, composite caching is ON (unchanged)", async () => {
  const { body } = await compositeCall();
  assertEquals(cacheMarkers(body), [{ type: "ephemeral" }]);
});

Deno.test("US-3345: with GRADING_ENABLE_CACHING unset, BOTH composite blocks stay cached under the US-3150 gate", async () => {
  const { body } = await compositeCall({ schemaGate: true });
  assertEquals(cacheMarkers(body), [{ type: "ephemeral" }, { type: "ephemeral" }]);
});

Deno.test("US-3345: an EMPTY GRADING_ENABLE_CACHING inherits rather than reading as off", async () => {
  const { body } = await perImageCall({ grading: "   " });
  assertEquals(
    cacheMarkers(body),
    [{ type: "ephemeral" }],
    "a blank value in a hosting panel must mean 'not set', not 'caching off'",
  );
});

// -- 3. Off is a BILLING change and nothing else ------------------------------

Deno.test("US-3345 AC6: GRADING_ENABLE_CACHING=0 drops cache_control from every grading block", async () => {
  for (const schemaGate of [false, true]) {
    const perImage = await perImageCall({ grading: "0", schemaGate });
    for (const marker of cacheMarkers(perImage.body)) {
      assertEquals(marker, null, `per-image block still cached (gate=${schemaGate})`);
    }
    const composite = await compositeCall({ grading: "0", schemaGate });
    for (const marker of cacheMarkers(composite.body)) {
      assertEquals(marker, null, `composite block still cached (gate=${schemaGate})`);
    }
  }
});

Deno.test("US-3345 AC6: turning caching off changes no byte the MODEL reads", async () => {
  const on = await perImageCall();
  const off = await perImageCall({ grading: "0" });

  assertEquals(
    systemTexts(off.body),
    systemTexts(on.body),
    "the system text moved - cache_control is a billing directive and must not " +
      "touch prompt content, or this switch would owe the shadow/eval/canary lane",
  );
  assertEquals(userText(off.body), userText(on.body), "the user turn moved");

  const versionOf = (r: unknown) =>
    (r as { prompt_version?: string } | null)?.prompt_version ?? null;
  assertEquals(
    versionOf(off.result),
    versionOf(on.result),
    "the reported prompt_version moved - a BILLING flag must earn no version suffix",
  );
  assert(
    versionOf(on.result) !== null,
    "prompt_version was never stamped, so the comparison above proved nothing",
  );

  const compositeOn = await compositeCall();
  const compositeOff = await compositeCall({ grading: "0" });
  assertEquals(
    systemTexts(compositeOff.body),
    systemTexts(compositeOn.body),
    "the composite system text moved",
  );
});

Deno.test("US-3345: the switch overrides AI_ENABLE_CACHING in BOTH directions", async () => {
  // Grading off while the rest of the app caches: the case the story is about.
  const gradingOff = await perImageCall({ grading: "0", global: "1" });
  assertEquals(cacheMarkers(gradingOff.body), [null]);

  // Grading on while the global flag is off: grading is no longer hostage to a
  // flag ten other features share.
  const gradingOn = await perImageCall({ grading: "1", global: "0" });
  assertEquals(cacheMarkers(gradingOn.body), [{ type: "ephemeral" }]);

  // And with neither set for grading, the global flag still decides.
  const inherited = await perImageCall({ global: "0" });
  assertEquals(cacheMarkers(inherited.body), [null]);
});

// -- 4. Wiring: the fan-out that makes the write unreadable --------------------

const PIPELINE_PATH = new URL("../lib/grading-pipeline.ts", import.meta.url);

/**
 * Comment-stripped source. Mode 1/1b of guards-that-do-not-guard: the fan-out
 * now carries a long comment ABOUT awaiting and about Promise.allSettled, so a
 * scan over raw source would be reading its own explanation.
 */
function pipelineCode(): string {
  const raw = Deno.readTextFileSync(PIPELINE_PATH);
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

/** Each fan-out region: from the promise array to the allSettled that drains it. */
function fanOutRegions(code: string): string[] {
  const regions: string[] = [];
  const opener = "const perImagePromises = imageData.map(";
  const closer = "Promise.allSettled(perImagePromises)";
  let from = 0;
  for (;;) {
    const start = code.indexOf(opener, from);
    if (start === -1) break;
    const end = code.indexOf(closer, start);
    assert(end !== -1, "a perImagePromises fan-out is never drained by allSettled");
    regions.push(code.slice(start, end + closer.length));
    from = end + closer.length;
  }
  return regions;
}

Deno.test("US-3345 AC3: both per-image fan-outs are still CONCURRENT", () => {
  const code = pipelineCode();
  const regions = fanOutRegions(code);
  assertEquals(
    regions.length,
    2,
    "expected the live fan-out and the escalation re-grade's fan-out; if this " +
      "count changed, find the new one and decide whether it is concurrent too",
  );
  for (const region of regions) {
    assert(
      !/\bawait\s+analyzeImage\s*\(/.test(region),
      "a per-image call inside the fan-out is now awaited. That is the STAGGER " +
        "US-3345 deliberately did not ship: it makes the prompt cache readable " +
        "but costs a whole non-streaming vision call of the seller's wait. If " +
        "this is intended, it needs the latency measurement AC2 asked for, and " +
        "the cost comments in grading-pipeline.ts and ai-config.ts stop being true.",
    );
  }
});

Deno.test("US-3345 AC2: the per-call latency instrument is still wired", () => {
  const code = pipelineCode();
  assert(
    code.includes("perImageMs[perImageIndex] = Date.now() - callStartedAt"),
    "the per-image stopwatch is gone - AC2's measurement cannot be taken without it",
  );
  assert(
    code.includes("per_call_ms=[") && code.includes("stagger_ms="),
    "the per-image fan-out no longer LOGS its per-call timings, so the number " +
      "the stagger decision turns on stops reaching the container logs",
  );
});
