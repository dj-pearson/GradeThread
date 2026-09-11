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
  buildEmailIssueSystemPrompt,
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

// ──────────────────────────────────────────────────────────
// THE EMAIL ISSUE PROMPT (US-3149 AC2, finished late)
// ──────────────────────────────────────────────────────────
// AC2 names content-ai-email.ts alongside the blog/social/research/refresh
// callers, and it was the one left on the old shape: buildEmailIssueSystemPrompt
// returned a single joined string with the history index AND the whole per-issue
// grounding block (topic, changelog, KB tip) sitting in the middle of it, and
// the grounding + output rules — which never change — after them. That is the
// same layout the story was filed about, in the file the story listed.

const EMAIL_KNOWLEDGE = {
  emailVoice: "Plain English, short sentences. Teach first, sell second.",
  emailStructure: "Subject → intro → what's new → teach → tip → CTA → sign-off.",
  valueProps: "Standardized 1.0-10.0 condition grades; shareable certificates.",
  productFocus: "both" as const,
};

const EMAIL_TOPIC = {
  label: "How to grade fading on dark denim",
  pillar: "grading",
  angle: "fabric-condition",
};

Deno.test("the email prompt's stable half does not move when the issue does", () => {
  const a = buildEmailIssueSystemPrompt({
    ...EMAIL_KNOWLEDGE,
    historyContext: "- prior issue about zippers",
    topic: EMAIL_TOPIC,
    changelogLines: ['2026-06-10 "New AI comp engine"'],
    kbTip: "Always shoot tags in natural light.",
  });
  const b = buildEmailIssueSystemPrompt({
    ...EMAIL_KNOWLEDGE,
    historyContext: "- prior issue about zippers\n- last week on pilling",
    topic: { label: "Reading a care label", pillar: "grading", angle: "tags" },
    changelogLines: ['2026-06-17 "Bulk relist"'],
    kbTip: "Shoot the defect close, then wide.",
  });

  assertEquals(
    typeof a.stable,
    "string",
    "buildEmailIssueSystemPrompt must return a split prompt, not one joined string",
  );
  assertEquals(a.stable, b.stable);
  assert(a.volatile !== b.volatile, "the per-issue inputs must land in the volatile half");
  assert(
    !a.stable.includes("prior issue about zippers"),
    "no history text may appear in the stable half",
  );
  assert(
    !a.stable.includes("New AI comp engine"),
    "no changelog line may appear in the stable half",
  );
  assert(
    !a.stable.includes(EMAIL_TOPIC.label),
    "the issue topic may not appear in the stable half",
  );
});

Deno.test("the email grounding and output rules ride above the breakpoint", () => {
  // They used to sit after the per-issue inputs. They never change, so keeping
  // them below the split would bill them in full on every call — and a
  // reordering is exactly the edit that silently drops text.
  const prompt = buildEmailIssueSystemPrompt({
    ...EMAIL_KNOWLEDGE,
    historyContext: "- prior issue",
    topic: EMAIL_TOPIC,
    changelogLines: [],
  });
  assert(prompt.stable.includes("# Grounding rules"));
  assert(prompt.stable.includes("# Output rules"));
  assert(prompt.stable.includes("Do NOT invent"));
  assert(prompt.stable.includes("never omit the key"));
  assert(!prompt.volatile.includes("# Output rules"));
  // The grounding rules point AT the issue inputs, and the inputs now come
  // after them. The wording has to say so, or the model is told to ground in
  // something it has not read yet.
  assert(
    !prompt.stable.includes("inputs above"),
    "the grounding rules must not point backwards at inputs that now follow them",
  );
});

Deno.test("joinContentSystem keeps the whole email prompt", () => {
  const prompt = buildEmailIssueSystemPrompt({
    ...EMAIL_KNOWLEDGE,
    historyContext: "- prior issue about zippers",
    topic: EMAIL_TOPIC,
    changelogLines: ['2026-06-10 "New AI comp engine"'],
    kbTip: "Always shoot tags in natural light.",
  });
  const joined = joinContentSystem(prompt);
  assert(joined.includes("Plain English, short sentences"));
  assert(joined.includes("prior issue about zippers"));
  assert(joined.includes("New AI comp engine"));
  assert(joined.includes("Always shoot tags in natural light"));
  assert(joined.includes(EMAIL_TOPIC.label));
});

Deno.test("the email generator sends the split prompt, and no breakpoint", () => {
  // Two halves of one decision, and asserting either alone would rot. The call
  // site must send the BLOCK LIST (so the layout reaches the API at all), and
  // the flag must stay false with its reasoning attached: newsletter issues are
  // weekly, an ephemeral entry lives five minutes, so a breakpoint here could
  // only ever pay the 1.25x write premium and never be read. That is the one
  // case worse than no breakpoint at all.
  const src = Deno.readTextFileSync(
    new URL("../lib/content-ai-email.ts", import.meta.url),
  );
  assert(
    src.includes("system: contentSystemBlocks(systemPrompt, EMAIL_PREFIX_CACHEABLE)"),
    "content-ai-email.ts must send the split prompt as a block list",
  );
  assert(
    /const EMAIL_PREFIX_CACHEABLE = false;/.test(src),
    "EMAIL_PREFIX_CACHEABLE flipped to true - COUNT the prefix with " +
      "count_tokens and check the generation cadence before that is right",
  );
  // The measurement that backs the decision has to survive with it. A number
  // deleted from the comment is a decision nobody can re-check.
  assert(src.includes("3,210 chars"), "the measured prefix size must stay recorded");
});
