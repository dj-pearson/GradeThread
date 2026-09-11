// The refine call's cache prefix is big enough to cache at all (US-3047 AC3).
//
// AC3 asks an OPERATOR to run a 30-item batch and read median cache_read_tokens
// off the ledger. Before anybody spends that batch, there is a cheaper question
// that has to be yes: is the cached prefix even ABOVE Anthropic's per-model
// minimum? Below it a breakpoint is silently ignored — no error, no warning,
// just cache_read_tokens: 0 forever — which reads exactly like a breakpoint in
// the wrong place and would send the next reader back to move it again.
//
// WARNING - CORRECTED 2026-09-11. This header used to say "1,024 tokens for Sonnet and
// 2,048 for Haiku". Sonnet 5 is right; HAIKU 4.5 IS 4,096, twice what was
// written, and the whole point of this file is the comparison against that
// number. The minimums are not monotonic across generations - 512 on Opus 5,
// 1,024 on Sonnet 5, 4,096 on Haiku 4.5 - so there is no way to reason one out,
// only to look it up. Source: Anthropic's prompt-caching reference, API
// minimum-cacheable-prefix table.
//
// The split matters here specifically: US-545 routes the COMMON apparel
// categories to Haiku (getHaikuModel -> the lightweight tier), so the model with
// the HIGHER bar takes the bulk of AutoLister volume.
//
// Measured 2026-09-11: a typical 25-aspect apparel schema is 17,643 chars,
// ~7,330 tokens. Clears 4,096 with room. So the per-model minimum is NOT why the
// ledger reads zero, and the leading suspect stays the batch ORDERING described
// in this story's notes.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { aspectCacheBreakpoints, buildAspectTool } from "../lib/ai-extract.ts";
import { MAX_AI_ASPECTS } from "../lib/aspect-priority.ts";

/**
 * Characters to tokens for a request that carries `tools`.
 *
 * WARNING: the plain chars/N ratios are WRONG for a tools-bearing request, and wrong in
 * the direction that gets a working breakpoint deleted. Fitted 2026-09-11
 * against fifteen real count_tokens results (US-3148):
 *
 *     tokens = chars / 2.514 + 312        (max residual 69 tokens)
 *
 * The ~312 constant is the tool-use system block Anthropic prepends whenever
 * `tools` is present. count_tokens sees it; a character count cannot. The
 * earlier version of this file used chars/4.2 as a "pessimistic bound", which
 * put a typical apparel schema at 4,201 tokens - 105 over Haiku's real 4,096,
 * i.e. it would have read as barely-passing on a bar it had already got wrong.
 *
 * `withoutToolBlock` is the same fit with the constant dropped, for the case
 * where the tool-use block turns out NOT to sit inside the tools prefix. Both
 * bounds are reported because which one applies is not something this box can
 * settle without an API call, and the conclusion happens not to depend on it.
 */
function estimateTokens(json: string): { fitted: number; withoutToolBlock: number } {
  return {
    fitted: Math.round(json.length / 2.514 + 312),
    withoutToolBlock: Math.round(json.length / 2.514),
  };
}

/** Anthropic's minimum cacheable prefix. Below it a breakpoint is IGNORED. */
const SONNET_MIN = 1024; // claude-sonnet-5
const HAIKU_MIN = 4096; // claude-haiku-4-5

function aspect(
  name: string,
  values: number,
  opts: Partial<{ required: boolean; mode: string; cardinality: string }> = {},
) {
  return {
    name,
    required: opts.required ?? false,
    cardinality: (opts.cardinality ?? "SINGLE") as "SINGLE" | "MULTI",
    mode: (opts.mode ?? "SELECTION_ONLY") as
      | "SELECTION_ONLY"
      | "SUGGESTED"
      | "FREE_TEXT",
    allowedValues: Array.from({ length: values }, (_, i) => `Value ${i + 1}`),
    usage: "RECOMMENDED",
    dataType: "STRING",
  };
}

/**
 * A women's-tops-shaped category: the aspect count and per-aspect value counts
 * eBay actually returns for common apparel, NOT the MAX_AI_ASPECTS (45) and
 * MAX_ALLOWED_VALUES_PER_ASPECT (300) ceilings. Sizing the fixture at the
 * ceilings would prove the schema is large when it is large, which is not the
 * question — the question is whether a TYPICAL call caches.
 */
const TYPICAL_APPAREL = [
  aspect("Department", 4, { required: true }),
  aspect("Type", 40, { required: true }),
  aspect("Size Type", 6, { required: true }),
  aspect("Size", 60, { required: true }),
  aspect("Color", 25, { required: true }),
  aspect("Brand", 200, { required: true }),
  aspect("Style", 60),
  aspect("Material", 40),
  aspect("Sleeve Length", 8),
  aspect("Neckline", 20),
  aspect("Pattern", 25),
  aspect("Occasion", 15),
  aspect("Season", 5),
  aspect("Fit", 8),
  aspect("Closure", 12),
  aspect("Features", 20, { cardinality: "MULTI" }),
  aspect("Garment Care", 12),
  aspect("Country/Region of Manufacture", 100),
  aspect("Theme", 30),
  aspect("Product Line", 0, { mode: "FREE_TEXT" }),
  aspect("Vintage", 2),
  aspect("Character", 50),
  aspect("Fabric Type", 30),
  aspect("Accents", 20),
  aspect("Lining Material", 15),
];

Deno.test("a typical apparel schema clears BOTH per-model cache minimums", () => {
  const { tool } = buildAspectTool(TYPICAL_APPAREL as never);
  const json = JSON.stringify(tool);
  const { fitted, withoutToolBlock } = estimateTokens(json);

  // Both bounds clear the higher minimum, so the conclusion does not depend on
  // whether the prepended tool-use block counts inside the tools prefix.
  assert(
    withoutToolBlock >= HAIKU_MIN,
    `the refine prefix is ${json.length} chars, ~${withoutToolBlock}-${fitted} ` +
      `tokens, under Haiku 4.5's ${HAIKU_MIN}-token minimum - the breakpoint ` +
      `would be silently ignored and cache_read_tokens would read 0 no matter ` +
      `where it is placed`,
  );
  assert(withoutToolBlock >= SONNET_MIN);
});

Deno.test("WARNING: a LEAN category cannot cache on Haiku, and that is recorded not fixed", () => {
  // Eight aspects is a real shape for a narrow category, and at ~3,000-3,300
  // tokens it sits UNDER Haiku 4.5's 4,096 and over Sonnet 5's 1,024. The
  // earlier version of this test called that "between the two minimums" against
  // a Haiku bar of 2,048 and declined to assert either way; with the real bar it
  // is a one-sided answer and worth pinning.
  //
  // It is not a live hole today: isEasyAspectCategory (the only thing that routes
  // a refine call to Haiku) matches t-shirt/jean/dress/sneaker-shaped leaves, and
  // those are exactly the categories eBay returns 20-30 aspects for. The risk is
  // a future signal added to that list for a narrow category. If the ledger ever
  // shows cache reads on Sonnet categories and zeroes on Haiku ones, start here.
  const { tool } = buildAspectTool(TYPICAL_APPAREL.slice(0, 8) as never);
  const { fitted, withoutToolBlock } = estimateTokens(JSON.stringify(tool));
  assert(withoutToolBlock >= SONNET_MIN, "even a lean category clears Sonnet's minimum");
  assert(
    fitted < HAIKU_MIN,
    `a lean eight-aspect schema now estimates at ${fitted} tokens, at or over ` +
      `Haiku's ${HAIKU_MIN} - if the schema really did grow that much, this ` +
      `caveat is obsolete and should be deleted rather than loosened`,
  );
});

Deno.test("the breakpoints sit on the tool AND the system block", () => {
  const { tool } = buildAspectTool(TYPICAL_APPAREL as never);
  const out = aspectCacheBreakpoints(tool, "SYSTEM", true);
  assertEquals(
    (out.tool as { cache_control?: unknown }).cache_control,
    { type: "ephemeral" },
  );
  assertEquals(out.system.cache_control, { type: "ephemeral" });

  // And neither when caching is off, so a disabled deployment sends no
  // cache_control at all rather than paying the write cost for nothing.
  const off = aspectCacheBreakpoints(tool, "SYSTEM", false);
  assertEquals((off.tool as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(off.system.cache_control, undefined);
});

Deno.test("the schema is byte-stable across calls for the same category", () => {
  // The other suspect AC3's note names. Two drafts in one category must produce
  // an identical prefix or every call is a cache WRITE and none is a read.
  // buildAspectTool walks the spec array in order and disambiguates keys
  // through an insertion-ordered Set, so the only way this drifts is if the
  // INPUT order drifts — which is why the assertion is on the built JSON rather
  // than on the builder.
  const a = JSON.stringify(buildAspectTool(TYPICAL_APPAREL as never).tool);
  const b = JSON.stringify(buildAspectTool(TYPICAL_APPAREL as never).tool);
  assertEquals(a, b);

  // And a reordered input is a DIFFERENT prefix, which is the thing to be
  // afraid of: if eBay's cached aspect array ever comes back in another order,
  // the cache misses silently and this is why.
  const shuffled = [TYPICAL_APPAREL[1], TYPICAL_APPAREL[0], ...TYPICAL_APPAREL.slice(2)];
  const c = JSON.stringify(buildAspectTool(shuffled as never).tool);
  assert(
    a !== c,
    "reordering the aspects produced an identical prefix — if that is now true " +
      "the cache is safe from input reordering, and this comment is wrong",
  );
});

Deno.test("the ceiling case is nowhere near the minimums", () => {
  const big = [...TYPICAL_APPAREL, ...TYPICAL_APPAREL].slice(0, MAX_AI_ASPECTS);
  const { withoutToolBlock } = estimateTokens(
    JSON.stringify(buildAspectTool(big as never).tool),
  );
  assert(
    withoutToolBlock > HAIKU_MIN * 2,
    `ceiling schema only ~${withoutToolBlock} tokens`,
  );
});
