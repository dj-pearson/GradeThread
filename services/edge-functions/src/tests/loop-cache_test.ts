// US-3148: the two tool loops cache their prefix and their history tail.
//
// The properties that matter are not "a breakpoint exists". They are: it lands
// on a block the API accepts, it MOVES as the conversation grows, it does not
// leave stale copies behind, and turning caching off changes nothing else.

import "./_env.ts";

import { assert, assertEquals } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { cachedSystem, withCachedTail } from "../lib/loop-cache.ts";
import { charterFor } from "../agents/charters/index.ts";

const EPH = { type: "ephemeral" } as const;

function convo(n: number): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [
    { role: "user", content: [{ type: "text", text: "start" }] },
  ];
  for (let i = 1; i < n; i++) {
    out.push({
      role: i % 2 === 1 ? "assistant" : "user",
      content: [{ type: "text", text: `turn ${i}` }],
    });
  }
  return out;
}

// deno-lint-ignore no-explicit-any
const cc = (b: any) => b?.cache_control;

Deno.test("cachedSystem puts the breakpoint on, and off means off", () => {
  assertEquals(cachedSystem("charter", true), [
    { type: "text", text: "charter", cache_control: EPH },
  ]);
  assertEquals(cachedSystem("charter", false), [{ type: "text", text: "charter" }]);
});

Deno.test("the tail breakpoint moves with the conversation", () => {
  // This is the whole point. A breakpoint set once and left behind caches turn
  // 3 forever while turns 4..24 are re-billed at full price.
  const five = withCachedTail(convo(5), true);
  const seven = withCachedTail(convo(7), true);
  // deno-lint-ignore no-explicit-any
  assert(cc((five[4].content as any[])[0]), "breakpoint should be on the last message");
  // deno-lint-ignore no-explicit-any
  assert(cc((seven[6].content as any[])[0]), "and it should have moved to the new last");
  // deno-lint-ignore no-explicit-any
  assertEquals(cc((seven[4].content as any[])[0]), undefined, "no stale copy left behind");
});

Deno.test("exactly one tail breakpoint, ever", () => {
  // Breakpoints are capped at 4 per request, and the system block already uses
  // one. A transform that accumulated them would start 400ing at step 4.
  const out = withCachedTail(convo(10), true);
  let n = 0;
  for (const m of out) {
    if (typeof m.content === "string") continue;
    // deno-lint-ignore no-explicit-any
    for (const b of m.content as any[]) if (cc(b)) n++;
  }
  assertEquals(n, 1);
});

Deno.test("the input is never mutated", () => {
  // The loop keeps appending to its own array. Mutating a block in place would
  // bury a stale breakpoint in the history for every later step.
  const original = convo(5);
  const snapshot = JSON.stringify(original);
  withCachedTail(original, true);
  assertEquals(JSON.stringify(original), snapshot);
});

Deno.test("a short conversation gets no breakpoint", () => {
  // Nothing precedes turn one, so a cache WRITE there costs 1.25x and can never
  // be read. The loop has to have a past before caching it is worth anything.
  for (const n of [1, 2]) {
    const out = withCachedTail(convo(n), true);
    for (const m of out) {
      if (typeof m.content === "string") continue;
      // deno-lint-ignore no-explicit-any
      for (const b of m.content as any[]) assertEquals(cc(b), undefined);
    }
  }
  // deno-lint-ignore no-explicit-any
  assert(cc((withCachedTail(convo(3), true)[2].content as any[])[0]));
});

Deno.test("caching off returns the same conversation, unchanged", () => {
  const input = convo(6);
  assertEquals(JSON.stringify(withCachedTail(input, false)), JSON.stringify(input));
});

Deno.test("a string content and an empty block list are left alone", () => {
  // cache_control lives on a content BLOCK. Converting a bare string to a block
  // list to attach one would change the request shape for no gain.
  const stringy: Anthropic.MessageParam[] = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "text", text: "b" }] },
    { role: "user", content: "plain string" },
  ];
  assertEquals(withCachedTail(stringy, true)[2].content, "plain string");

  const empty: Anthropic.MessageParam[] = [
    ...convo(3).slice(0, 2),
    { role: "user", content: [] },
  ];
  assertEquals((withCachedTail(empty, true)[2].content as unknown[]).length, 0);
});

Deno.test("a tool_result tail is cacheable, which is the shape the loop makes", () => {
  // agent-kernel appends { role: "user", content: [tool_result, ...] } after
  // every step, so this is the block the breakpoint actually lands on in
  // production - not the text block the other tests use.
  const msgs: Anthropic.MessageParam[] = [
    ...convo(2),
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "one" },
        { type: "tool_result", tool_use_id: "b", content: "two" },
      ],
    },
  ];
  const out = withCachedTail(msgs, true);
  // deno-lint-ignore no-explicit-any
  const blocks = out[2].content as any[];
  assertEquals(cc(blocks[0]), undefined, "only the LAST block carries it");
  assertEquals(cc(blocks[1]), EPH);
});

Deno.test("no charter shrinks below what makes its prefix cacheable", () => {
  // MEASURED 2026-09-08 with count_tokens: tools + charter on claude-sonnet-5
  // ranged 1,064 (ceo-brief) to 2,145 (sentinel) against a 1,024 minimum. The
  // two smallest clear the bar by about 40 tokens, so trimming a paragraph
  // could silently drop them under it and the only symptom would be
  // cache_read_tokens quietly returning to 0.
  //
  // A unit test cannot call count_tokens, so it guards the input instead: the
  // smallest charter measured was 1,472 characters, and this floor sits just
  // below it. The real detector is cacheHitShare per agent:* phase in
  // scripts/ai-token-profile.ts.
  const FLOOR = 1400;
  const keys = [
    "sentinel",
    "ceo-brief",
    "growth",
    "finance",
    "pricing",
    "grading-quality",
    "integrations-watchdog",
    "marketplace-ops",
    "trust-safety",
    "cron-governance",
    "release",
  ];
  const thin: string[] = [];
  for (const k of keys) {
    const c = charterFor(k);
    if (!c) continue;
    if (c.systemPrompt.length < FLOOR) {
      thin.push(`${k}: ${c.systemPrompt.length} chars, under the ${FLOOR} floor`);
    }
  }
  assertEquals(thin, [], thin.join("\n"));
});
