// The refine call's cache prefix is big enough to cache at all (US-3047 AC3).
//
// AC3 asks an OPERATOR to run a 30-item batch and read median cache_read_tokens
// off the ledger. Before anybody spends that batch, there is a cheaper question
// that has to be yes: is the cached prefix even ABOVE Anthropic's per-model
// minimum? Below it a breakpoint is silently ignored — no error, no warning,
// just cache_read_tokens: 0 forever — which reads exactly like a breakpoint in
// the wrong place and would send the next reader back to move it again.
//
// The minimums are 1,024 tokens for Sonnet and 2,048 for Haiku, and the split
// matters here specifically: US-545 routes the COMMON apparel categories to
// Haiku, so the model with the higher bar takes the bulk of AutoLister volume.
//
// Measured 2026-09-05: a typical 25-aspect apparel schema is ~17.6 KB, roughly
// 4,200-5,500 tokens. Comfortably over both. So the per-model minimum is NOT
// why the ledger reads zero, and the next suspect is the 5-minute ephemeral TTL
// against the gap between two drafts of the SAME category.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { aspectCacheBreakpoints, buildAspectTool } from "../lib/ai-extract.ts";
import { MAX_AI_ASPECTS } from "../lib/aspect-priority.ts";

/**
 * Bytes to tokens, as a RANGE rather than a constant.
 *
 * A single chars-per-token figure is a guess dressed as a measurement. JSON
 * with repeated keys and short enum strings runs denser than prose, so the
 * bound that matters is the pessimistic one: if even 4.2 chars/token clears the
 * minimum, the prefix is cacheable on any plausible tokenizer.
 */
function tokenRange(json: string): { low: number; high: number } {
  return {
    low: Math.round(json.length / 4.2),
    high: Math.round(json.length / 3.2),
  };
}

const SONNET_MIN = 1024;
const HAIKU_MIN = 2048;

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
  const { low } = tokenRange(JSON.stringify(tool));

  // The pessimistic bound clears the higher minimum, so the conclusion does not
  // depend on which tokenizer estimate you believe.
  assert(
    low >= HAIKU_MIN,
    `the refine prefix is ~${low} tokens at the pessimistic bound, under Haiku's ` +
      `${HAIKU_MIN}-token minimum — the breakpoint would be silently ignored and ` +
      `cache_read_tokens would read 0 no matter where it is placed`,
  );
  assert(low >= SONNET_MIN);
});

Deno.test("⚠ a LEAN category is the one that cannot cache on Haiku", () => {
  // Eight aspects is a real shape for a narrow category, and it lands between
  // the two minimums. Recorded rather than asserted away: if the ledger ever
  // shows cache reads on Sonnet categories and zeroes on Haiku ones, this is
  // where to look first. US-545 routes the COMMON apparel categories to Haiku,
  // so the model with the higher bar carries the bulk of the volume.
  const { tool } = buildAspectTool(TYPICAL_APPAREL.slice(0, 8) as never);
  const { low, high } = tokenRange(JSON.stringify(tool));
  assert(low >= SONNET_MIN, "even a lean category clears Sonnet's minimum");
  assert(
    high >= SONNET_MIN,
    "a lean category fell under Sonnet's minimum too — the schema shrank",
  );
  // No assertion about Haiku: this fixture straddles that line, and pinning it
  // either way would be pinning the estimate rather than the behaviour.
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
  const { low } = tokenRange(JSON.stringify(buildAspectTool(big as never).tool));
  assert(low > HAIKU_MIN * 2, `ceiling schema only ~${low} tokens`);
});
