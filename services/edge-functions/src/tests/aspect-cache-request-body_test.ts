// US-3047 AC2, asserted on the REQUEST BODY, not on the helper that builds part
// of it.
//
// aspect-cache-breakpoints_test.ts pins the pure helper and
// aspect-cache-prefix_test.ts pins the prefix SIZE. Neither answers the question
// that decides whether this change is safe to ship: `cache_control` is a BILLING
// directive, and it must change no byte the model reads. A comment saying so is
// worth nothing. The thing to compare is the two bodies, one with caching on and
// one with it off.
//
// So this file swaps the Anthropic client's `messages.create` for a recorder,
// runs extractEbayAspects twice, and keeps both bodies. Two claims come out:
//
//   1. With AI_ENABLE_CACHING=false the body carries no `cache_control` at all,
//      anywhere - a disabled deployment pays no 1.25x cache-write premium for a
//      breakpoint it will never read back.
//   2. With caching on, deleting every `cache_control` key yields a body
//      DEEP-EQUAL to the disabled one. Same model, same system text, same tools,
//      same tool_choice, same messages, same max_tokens. Nothing the model reads
//      moved, which is why this rides no prompt-version lifecycle.
//
// The recorder replaces `create` rather than stubbing global fetch on purpose:
// the SDK binds its fetch at CLIENT CONSTRUCTION, and the client here is a
// process-wide singleton, so whichever test file happens to build it first would
// own the stub for the whole run. That is a cross-file ordering dependency, and
// this file would then pass or fail depending on what ran before it.
//
//   deno test --allow-env --allow-read --allow-net src/tests/aspect-cache-request-body_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "ANTHROPIC_API_KEY",
  Deno.env.get("ANTHROPIC_API_KEY") ?? "sk-test-not-a-real-key",
);

const { extractEbayAspects, getHaikuModel, getSonnetModel } = await import(
  "../lib/ai-extract.ts"
);
const { getAnthropicClient } = await import("../lib/ai-config.ts");
const { isEasyAspectCategory } = await import("../lib/listing-photo-budget.ts");
const { CURRENT_MODELS } = await import("../lib/ai-model-registry.ts");

const SPECS = [
  { name: "Brand", required: true, cardinality: "SINGLE", mode: "FREE_TEXT" },
  {
    name: "Sleeve Length",
    required: false,
    cardinality: "SINGLE",
    mode: "SELECTION_ONLY",
    allowedValues: ["Short Sleeve", "Long Sleeve", "Sleeveless"],
    usage: "RECOMMENDED",
  },
  {
    name: "Features",
    required: false,
    cardinality: "MULTI",
    mode: "SELECTION_ONLY",
    allowedValues: ["Breathable", "Lightweight", "Quick Dry"],
  },
] as never;

const FAKE_RESPONSE = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "test",
  content: [
    {
      type: "tool_use",
      id: "toolu_test",
      name: "extract_ebay_aspects",
      input: { Brand: { values: ["Nike"], confidence: 0.9, source: "text" } },
    },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5 },
};

/** Run one refine call against a recorder and return the body it was handed. */
async function captureRefineBody(
  caching: boolean,
): Promise<Record<string, unknown>> {
  const previousCaching = Deno.env.get("AI_ENABLE_CACHING");
  const messages = getAnthropicClient().messages as unknown as {
    create: (...args: unknown[]) => unknown;
  };
  const realCreate = messages.create;
  let captured: Record<string, unknown> | null = null;

  messages.create = (...args: unknown[]) => {
    captured = args[0] as Record<string, unknown>;
    return Promise.resolve(structuredClone(FAKE_RESPONSE));
  };
  Deno.env.set("AI_ENABLE_CACHING", caching ? "true" : "false");
  try {
    await extractEbayAspects({
      text: "Nike tee",
      aspects: SPECS,
      categoryPath: "Clothing > Men > Shirts > T-Shirts",
      feature: "autolister_refine",
    });
  } finally {
    messages.create = realCreate;
    if (previousCaching === undefined) {
      Deno.env.delete("AI_ENABLE_CACHING");
    } else {
      Deno.env.set("AI_ENABLE_CACHING", previousCaching);
    }
  }
  assert(captured !== null, "no Anthropic request body was captured");
  // Round-trip through JSON: what is compared is what would go on the wire.
  return JSON.parse(JSON.stringify(captured)) as Record<string, unknown>;
}

/** Every `cache_control` key removed, at any depth. */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "cache_control") continue;
      out[k] = withoutCacheControl(v);
    }
    return out;
  }
  return value;
}

function countCacheControl(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((n: number, v) => n + countCacheControl(v), 0);
  }
  if (value && typeof value === "object") {
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "cache_control") n++;
      n += countCacheControl(v);
    }
    return n;
  }
  return 0;
}

Deno.test("caching OFF: the refine request body carries no cache_control anywhere", async () => {
  const body = await captureRefineBody(false);
  assertEquals(
    countCacheControl(body),
    0,
    "a disabled deployment must send no breakpoint at all - otherwise it pays " +
      "the 1.25x cache-write premium on every refine call and never reads one back",
  );
  // And it is still the real body: the whole per-category schema is in it.
  const tools = body.tools as Array<{ name: string; input_schema: unknown }>;
  assertEquals(tools.length, 1);
  assertEquals(tools[0]?.name, "extract_ebay_aspects");
  const props =
    (tools[0]?.input_schema as { properties: Record<string, unknown> }).properties;
  assert("Brand" in props && "Sleeve_Length" in props && "Features" in props);
});

Deno.test("cache_control is a BILLING directive: the two bodies differ by nothing else", async () => {
  const off = await captureRefineBody(false);
  const on = await captureRefineBody(true);

  // Two breakpoints, and they are where AC2 says: the last (here: only) tool,
  // and the system block.
  assertEquals(countCacheControl(on), 2);
  assertEquals(
    (on.tools as Array<{ cache_control?: unknown }>)[0]?.cache_control,
    { type: "ephemeral" },
  );
  assertEquals(
    (on.system as Array<{ cache_control?: unknown }>)[0]?.cache_control,
    { type: "ephemeral" },
  );

  // The claim that matters. Strip the directive and the request is the same
  // request - same model, system text, tools, tool_choice, messages, max_tokens.
  // Nothing the model reads moved, so this change rides no prompt-version
  // lifecycle.
  assertEquals(
    withoutCacheControl(on),
    off,
    "enabling the cache changed something the MODEL reads, not just what " +
      "Anthropic bills - that would be a prompt change and would need a version bump",
  );
});

Deno.test("the refine call runs on Haiku for the common apparel categories", () => {
  // AC2's prefix has to clear the minimum for the model the call ACTUALLY uses,
  // and those are two different models with two different bars. US-545 routes
  // the easy categories to the lightweight tier - Haiku 4.5, the higher
  // 4,096-token minimum - and everything else stays on the default, Sonnet 5 at
  // 1,024. aspect-cache-prefix_test.ts is where the prefix is measured against
  // them.
  assert(isEasyAspectCategory("Clothing > Men > Shirts > T-Shirts"));
  assert(isEasyAspectCategory("Women's Blouses"));
  assert(!isEasyAspectCategory("Vintage designer handbag"));
  assertEquals(getHaikuModel(), CURRENT_MODELS.lightweight);
  assertEquals(getSonnetModel(), CURRENT_MODELS.default);
});
