// US-3148: prompt caching for the two agentic tool loops.
//
// A tool loop re-sends everything on every step. agent-kernel runs up to
// DEFAULT_MAX_STEPS (24), and each step was paying full price for the tool
// schemas, the charter, and every turn that came before it. Nothing on that
// call carried a cache_control at all.
//
// TWO BREAKPOINTS, EACH ANSWERING A DIFFERENT QUESTION:
//
//   1. THE PREFIX (tools + system). Identical on every step of a run AND on
//      every run of the same agent. Anthropic renders tools first, then system,
//      then messages, so one breakpoint on the last system block covers both.
//      This is the one that also pays off ACROSS runs inside the 5-minute
//      window.
//
//   2. THE HISTORY TAIL. Step N re-sends steps 1..N-1 verbatim. A breakpoint on
//      the final content block of the final message means step N+1 reads all of
//      that instead of re-billing it. The breakpoint has to MOVE as the
//      conversation grows, which is why this is a per-request transform rather
//      than something set once.
//
// ⚠ MEASURED BEFORE SHIPPING, because the failure is silent. Below the
// per-model minimum cacheable prefix a breakpoint is IGNORED - no error, no
// warning, cache_read_tokens just stays 0, exactly as if it were in the wrong
// place (US-3047 lost a day to that). Counted with Anthropic's own tokenizer on
// 2026-09-08, tools + charter for all 15 agents on claude-sonnet-5, against the
// 1,024-token minimum:
//
//   sentinel 2145   support-triage 1650   integrations-watchdog 1631
//   finance 1569    marketing-portfolio 1527   marketplace-ops 1426
//   grading-quality 1402   user-lifecycle 1399   experiments-governor 1360
//   cron-governance 1304   pricing 1203   trust-safety 1147   growth 1111
//   release 1074    ceo-brief 1064
//
// All fifteen cache. The last two clear the bar by roughly 40 tokens, so a
// charter edit that trims a paragraph could silently drop them under it -
// src/tests/loop-cache_test.ts keeps a floor on charter size for that reason,
// and the ledger's cacheHitShare per agent phase is the real detector.

import type Anthropic from "@anthropic-ai/sdk";

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * The system prompt as a cached block.
 *
 * Tools render BEFORE system, so a breakpoint here covers the tool schemas too
 * - which is most of the prefix for an agent with a short charter.
 */
export function cachedSystem(
  systemPrompt: string,
  caching: boolean,
): Anthropic.TextBlockParam[] {
  return [
    caching
      ? { type: "text", text: systemPrompt, cache_control: EPHEMERAL }
      : { type: "text", text: systemPrompt },
  ];
}

/**
 * A copy of `messages` with a cache breakpoint on the last content block.
 *
 * PURE, AND IT COPIES. The loop owns the messages array and keeps appending to
 * it; mutating a block in place would leave a stale breakpoint buried in the
 * history on the next step, and breakpoints are capped at 4 per request. So the
 * transform is applied to a shallow copy at send time and thrown away.
 *
 * Returns the input unchanged when caching is off, when there is nothing to
 * cache, or when the last message is too short to be worth a breakpoint - the
 * `minBlocks` guard below.
 *
 * ⚠ A STRING `content` IS LEFT ALONE. cache_control lives on a content BLOCK,
 * and a message whose content is a bare string has none. Converting it would
 * change the request shape for no gain on the first turn, which is the only
 * turn where it happens here.
 */
export function withCachedTail(
  messages: readonly Anthropic.MessageParam[],
  caching: boolean,
  opts: { minMessages?: number } = {},
): Anthropic.MessageParam[] {
  const out = [...messages];
  if (!caching || out.length === 0) return out;

  // One turn of history is not worth a breakpoint: there is nothing before it
  // to read, and writing a cache entry costs 1.25x. The loop only starts paying
  // off once it has a past.
  const minMessages = opts.minMessages ?? 3;
  if (out.length < minMessages) return out;

  const lastIndex = out.length - 1;
  const last = out[lastIndex]!;
  if (typeof last.content === "string") return out;
  const blocks = [...(last.content as Anthropic.ContentBlockParam[])];
  if (blocks.length === 0) return out;

  const tailIndex = blocks.length - 1;
  const tail = blocks[tailIndex]!;
  // Only block kinds that accept cache_control. A thinking block does not.
  if (
    tail.type !== "text" && tail.type !== "tool_result" &&
    tail.type !== "tool_use" && tail.type !== "image" &&
    tail.type !== "document"
  ) {
    return out;
  }
  blocks[tailIndex] = { ...tail, cache_control: EPHEMERAL } as Anthropic.ContentBlockParam;
  out[lastIndex] = { ...last, content: blocks };
  return out;
}
