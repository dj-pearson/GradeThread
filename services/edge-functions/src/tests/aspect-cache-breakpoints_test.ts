// US-3047: where the aspect-refine call's prompt-cache breakpoints go.
//
// The 2026-09-02 ledger read (US-3044) showed this pass recording ZERO
// cache_read_tokens on every call. The cause was not that caching was off: the
// only breakpoint sat on ASPECT_SYSTEM_PROMPT, which is a few hundred tokens
// and under the per-model cache minimum, while the thing that is actually big
// and actually repeats — the per-category tool schema, up to MAX_AI_ASPECTS
// aspects each with up to MAX_ALLOWED_VALUES_PER_ASPECT enum values — carried
// none. Anthropic caches tools BEFORE system, so a breakpoint on the last tool
// makes the schema a cacheable prefix in its own right.
//
//   deno test --allow-env --allow-read --allow-net src/tests/aspect-cache-breakpoints_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  aspectCacheBreakpoints,
  buildAspectTool,
  type EbayAspectSpec,
} from "../lib/ai-extract.ts";

const SPECS: EbayAspectSpec[] = [
  { name: "Brand", required: true, cardinality: "SINGLE", mode: "FREE_TEXT" },
  {
    name: "Theme",
    required: false,
    cardinality: "SINGLE",
    mode: "SELECTION_ONLY",
    allowedValues: ["Sports", "Casual"],
  },
];

const SYSTEM = "You extract eBay item-specifics.";

Deno.test("caching on: the breakpoint is on the tool AND on the system block", () => {
  const { tool } = buildAspectTool(SPECS);
  const out = aspectCacheBreakpoints(tool, SYSTEM, true);

  assertEquals(
    (out.tool as { cache_control?: { type: string } }).cache_control,
    { type: "ephemeral" },
    "the per-category tool schema must be under a breakpoint of its own",
  );
  assertEquals(out.system.cache_control, { type: "ephemeral" });
  assertEquals(out.system.text, SYSTEM);
});

Deno.test("the cached tool still carries the whole per-category schema", () => {
  const { tool } = buildAspectTool(SPECS);
  const { tool: cached } = aspectCacheBreakpoints(tool, SYSTEM, true);

  // Caching must not be bought by shrinking what is sent: same name, same
  // schema object, only the breakpoint added.
  assertEquals(cached.name, tool.name);
  assertEquals(
    (cached as { input_schema?: unknown }).input_schema,
    tool.input_schema,
  );
  const props = (tool.input_schema as { properties: Record<string, unknown> })
    .properties;
  assert("Brand" in props && "Theme" in props);
});

Deno.test("caching off: no breakpoint anywhere, and the tool is untouched", () => {
  const { tool } = buildAspectTool(SPECS);
  const out = aspectCacheBreakpoints(tool, SYSTEM, false);

  assertEquals(
    (out.tool as { cache_control?: unknown }).cache_control,
    undefined,
  );
  assertEquals(out.system.cache_control, undefined);
  assertEquals(out.system, { type: "text", text: SYSTEM });
  // Same object, not a copy: nothing is added on the disabled path.
  assert(out.tool === tool);
});
