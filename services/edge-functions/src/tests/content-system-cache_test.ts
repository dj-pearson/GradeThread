// US-3149: the content system prompt is split so it can be cached at all.
//
// The bug was not a missing cache_control. It was that `historyContext` sat in
// the MIDDLE of one joined string, so no single breakpoint could both cover the
// voice rules and exclude the part that changes when a post publishes. These
// tests pin the three properties that make the split worth having: the stable
// half is byte-stable, the volatile half is isolated, and the breakpoint is on
// the stable half only.

import { assert, assertEquals } from "@std/assert";
import {
  buildStreamSystemPrompt,
  buildSystemPrompt,
  contentSystemBlocks,
  joinContentSystem,
} from "../lib/content-ai-prompts.ts";

const KNOWLEDGE = {
  brandVoice: "Plain, concrete, non-hypey English. Teach first, sell second.",
  surfaceStyle: "Blog: 1,200-1,800 words, H2 sections, one table where it earns it.",
  pillarMap: "Condition grading | Reselling operations | eBay mechanics | Sourcing",
};

Deno.test("the stable half does not move when history does", () => {
  // The whole point. Two calls a week apart share a knowledge pack but not a
  // history index; if the history leaked into `stable` the prefix would change
  // on every publish and the cache would never be read.
  const a = buildSystemPrompt({
    ...KNOWLEDGE,
    historyContext: "- How to grade a hoodie\n- Five eBay title mistakes",
    task: "write-blog-article",
  });
  const b = buildSystemPrompt({
    ...KNOWLEDGE,
    historyContext: "- How to grade a hoodie\n- Five eBay title mistakes\n- New post",
    task: "write-blog-article",
  });
  assertEquals(a.stable, b.stable);
  assert(a.volatile !== b.volatile, "the history must land in the volatile half");
  assert(
    !a.stable.includes("How to grade a hoodie"),
    "no history text may appear in the cached prefix",
  );
});

Deno.test("a different task IS a different prefix, and should be", () => {
  // The task header is genuinely part of the stable half: a blog run and a
  // research run are different prompts and must not share a cache entry. This
  // is a cost the split accepts, not a leak it missed.
  const blog = buildSystemPrompt({
    ...KNOWLEDGE,
    historyContext: "x",
    task: "write-blog-article",
  });
  const research = buildSystemPrompt({
    ...KNOWLEDGE,
    historyContext: "x",
    task: "research-topics",
  });
  assert(blog.stable !== research.stable);
  assertEquals(blog.volatile, research.volatile);
});

Deno.test("the breakpoint is on the stable block and nowhere else", () => {
  const prompt = buildSystemPrompt({
    ...KNOWLEDGE,
    historyContext: "- a prior post",
    task: "write-blog-article",
  });
  const blocks = contentSystemBlocks(prompt, true);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].text, prompt.stable);
  assertEquals(blocks[0].cache_control, { type: "ephemeral" });
  assertEquals(blocks[1].text, prompt.volatile);
  // A breakpoint here would write an entry on every call that no later call can
  // read, because the text defining it has changed by then. Worse than none.
  assertEquals(blocks[1].cache_control, undefined);
});

Deno.test("caching off changes what is billed and nothing else", () => {
  const prompt = buildSystemPrompt({
    ...KNOWLEDGE,
    historyContext: "- a prior post",
    task: "write-blog-article",
  });
  const on = contentSystemBlocks(prompt, true);
  const off = contentSystemBlocks(prompt, false);
  assertEquals(off.length, on.length);
  assertEquals(off.map((b) => b.text), on.map((b) => b.text));
  assertEquals(off[0].cache_control, undefined);
});

Deno.test("an empty volatile half is dropped, not sent as an empty block", () => {
  // The API rejects an empty text block. The streaming prompts carry no history
  // at all, so this is their normal shape rather than an edge case.
  const stream = buildStreamSystemPrompt({ ...KNOWLEDGE, task: "compose-article" });
  assertEquals(stream.volatile, "");
  const blocks = contentSystemBlocks(stream, true);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].cache_control, { type: "ephemeral" });
  assert(blocks[0].text.length > 0);
});

Deno.test("joinContentSystem round-trips both halves", () => {
  const prompt = buildSystemPrompt({
    ...KNOWLEDGE,
    historyContext: "- a prior post",
    task: "write-social-post",
  });
  const joined = joinContentSystem(prompt);
  assert(joined.includes(prompt.stable));
  assert(joined.includes(prompt.volatile));
  // No trailing separator when there is nothing to separate.
  const stream = buildStreamSystemPrompt({ ...KNOWLEDGE, task: "compose-article" });
  assertEquals(joinContentSystem(stream), stream.stable);
});

Deno.test("the output rules stay in the prompt, above the breakpoint", () => {
  // They moved from after the history to before it. They are stable, and
  // anything after the breakpoint is billed in full on every call - but they
  // must still actually be there, which is the half of that trade that a
  // reordering can silently drop.
  const prompt = buildSystemPrompt({
    ...KNOWLEDGE,
    historyContext: "- a prior post",
    task: "write-blog-article",
  });
  assert(prompt.stable.includes("# Output rules"));
  // US-3151 deleted the "ONLY valid JSON" and "no markdown fences" rules that
  // used to be asserted here - output_config.format enforces the shape now, and
  // asking in prose for what the API guarantees is what failed for three weeks
  // of production runs. The rule below is the one a schema CANNOT express, so
  // it is the one that has to survive the move.
  assert(!prompt.stable.includes("ONLY valid JSON"));
  assert(prompt.stable.includes("never omit the key"));
  assert(!prompt.volatile.includes("# Output rules"));
});

Deno.test("the stable half stays big enough to be cacheable at all", () => {
  // US-3149 AC5, and the failure it guards is SILENT. Below the per-model
  // minimum a cache_control breakpoint is ignored outright - no error, no
  // warning, just cache_read_tokens of 0 forever, indistinguishable from a
  // breakpoint in the wrong place (US-3047 lost a day to exactly this).
  //
  // THE REAL PREFIX WAS COUNTED, NOT ESTIMATED. Against Anthropic's own
  // tokenizer on 2026-09-08, with the live content_knowledge rows:
  //   blog.gradethread / blog.flipdesk / social on sonnet-5: 2,502-2,585 tok
  //     against a 1,024 minimum - all cache.
  //   social on haiku-4-5: 1,908 tok against a 2,048 minimum - IGNORED.
  // The numbers and the reason social is left that way are in the
  // contentSystemBlocks doc comment.
  //
  // A unit test cannot re-run that: the knowledge docs live in the DB. What it
  // CAN do is catch the regression that would invalidate it - somebody moving a
  // large stable section into the volatile half, or out of the prompt, and
  // taking the prefix under even the Sonnet bar. So it asserts against a
  // deliberately SMALL knowledge pack: if the scaffolding alone plus 1 KB of
  // voice still clears 1,024 tokens, the real 6.5 KB pack cannot have fallen
  // under it through a layout change.
  const prompt = buildSystemPrompt({
    brandVoice: "v".repeat(1500),
    surfaceStyle: "s".repeat(1500),
    pillarMap: "p".repeat(1500),
    historyContext: "- a prior post",
    task: "write-blog-article",
  });
  const SONNET_MIN_TOKENS = 1024;
  const pessimisticTokens = prompt.stable.length / 4;
  assert(
    pessimisticTokens > SONNET_MIN_TOKENS,
    `stable half is ~${Math.round(pessimisticTokens)} tokens on a small pack, ` +
      `under the ${SONNET_MIN_TOKENS}-token Sonnet minimum - a breakpoint there ` +
      `would be silently ignored`,
  );
  // And the volatile half must stay small, or the split bought nothing.
  assert(
    prompt.volatile.length < prompt.stable.length / 10,
    "the volatile half should be a fraction of the cached one",
  );
});
