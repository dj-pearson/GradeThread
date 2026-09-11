// US-3148 AC4: the breakpoints are asserted on the BODY the kernel actually
// sends, not on the helpers that build it.
//
// WHY THIS FILE EXISTS SEPARATELY FROM loop-cache_test.ts. That file proves
// cachedSystem() and withCachedTail() are correct. It proves nothing about
// whether agent-kernel still CALLS them. Delete the two call sites at
// agent-kernel.ts:878/880 and every assertion over there stays green - a guard
// that passes against the broken code it was written to catch. So this file
// stubs client.messages.create and reads the request object the kernel handed
// it: system block array, cache_control, the tool schemas that share the
// prefix, and the moving tail.
//
// It also pins AC4's second half, which is the part a helper test cannot reach:
// AI_ENABLE_CACHING=0 removes the breakpoints and changes NOTHING ELSE about
// the body.
//
//   deno test --allow-all src/tests/agent-kernel-cache_test.ts

import "./_env.ts";

// getAnthropicClient() throws when no key is set and memoizes the client on the
// first call, so this has to happen before any import that might construct it.
// Deliberately not key-shaped: a realistic fixture trips gitleaks on entropy.
if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../lib/ai-config.ts";
import { AGENT_TOOLS } from "../lib/agent-tools.ts";
import { type AgentRow, prodKernelDeps } from "../lib/agent-kernel.ts";

const EPH = { type: "ephemeral" } as const;

const READ_TOOLS = AGENT_TOOLS.filter((t) => t.class === "read").map((t) => t.name);

// ⚠ THE TRAP US-3148's FIRST MEASUREMENT FELL INTO. anthropicTools() filters
// TOOL_LIST by the agent's OWN allowlist, so a synthetic agent with an empty
// config reports ZERO tools - and the tool schemas are most of the cached
// prefix. A fixture built that way measures and asserts against a prefix
// production never sends. Build the allowlist from the real tool list.
function agentRow(tools: string[] = READ_TOOLS): AgentRow {
  return {
    id: "agent-fixture",
    key: "sentinel",
    name: "Sentinel",
    module_letter: "A",
    status: "enabled",
    autonomy: {},
    config: { tools },
  };
}

// The shape the kernel really builds: messages[0] is a bare STRING (the
// "System context: ..." preamble), then alternating assistant tool_use /
// user tool_result turns. The tail breakpoint lands on a tool_result block,
// not on the text block a synthetic conversation would end with.
function loopMessages(steps: number): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [
    { role: "user", content: 'System context: charter\n\nBegin your run for trigger "cron".' },
  ];
  for (let i = 0; i < steps; i++) {
    out.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `call_${i}`, name: READ_TOOLS[0] ?? "noop", input: {} }],
    });
    out.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: "{}" }],
    });
  }
  return out;
}

const FAKE_RESPONSE = {
  content: [{ type: "text", text: '{"summary":"ok","findings":[],"proposals":[]}' }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

type Body = Record<string, unknown>;

/** Run one kernel step against a stubbed client and return the request body. */
async function bodySentBy(
  caching: boolean,
  messages: Anthropic.MessageParam[],
  agent: AgentRow = agentRow(),
): Promise<Body> {
  const previous = Deno.env.get("AI_ENABLE_CACHING");
  Deno.env.set("AI_ENABLE_CACHING", caching ? "1" : "0");
  const client = getAnthropicClient();
  const surface = client.messages as unknown as { create: (...args: unknown[]) => unknown };
  const original = surface.create;
  let captured: Body | null = null;
  surface.create = (body: unknown) => {
    captured = body as Body;
    return Promise.resolve(FAKE_RESPONSE);
  };
  try {
    // makeStep reads isCachingEnabled() once, when the step builder is made -
    // so the env has to be set before this line, not before the send.
    await prodKernelDeps().makeStep(agent, "claude-sonnet-5", 2048)(messages);
  } finally {
    surface.create = original;
    if (previous === undefined) Deno.env.delete("AI_ENABLE_CACHING");
    else Deno.env.set("AI_ENABLE_CACHING", previous);
  }
  const body = captured as Body | null;
  if (!body) throw new Error("makeStep never called client.messages.create");
  return body;
}

function breakpointsIn(messages: unknown): number {
  let n = 0;
  for (const m of (messages as Anthropic.MessageParam[]) ?? []) {
    if (typeof m.content === "string") continue;
    for (const b of m.content as unknown as Record<string, unknown>[]) {
      if (b.cache_control) n++;
    }
  }
  return n;
}

// deno-lint-ignore no-explicit-any
function withoutCacheControl(value: any): any {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value && typeof value === "object") {
    // deno-lint-ignore no-explicit-any
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "cache_control") continue;
      out[k] = withoutCacheControl(v);
    }
    return out;
  }
  return value;
}

Deno.test("the kernel sends system as a cached BLOCK ARRAY, with the tools inside that prefix", async () => {
  const body = await bodySentBy(true, loopMessages(3));

  const system = body.system as Anthropic.TextBlockParam[];
  assert(
    Array.isArray(system),
    "system must be a block array - a bare string cannot carry cache_control, which is the bug US-3148 fixed",
  );
  assertEquals(system.length, 1);
  assertEquals(system[0]!.type, "text");
  assert(system[0]!.text.length > 0, "an empty charter would not reach the cacheable minimum");
  assertEquals(system[0]!.cache_control, EPH);

  const tools = body.tools as Anthropic.Tool[];
  assert(
    Array.isArray(tools) && tools.length > 0,
    "no tools means a prefix nothing like production's - see the allowlist trap above",
  );
  // Anthropic renders tools BEFORE system, so the one system breakpoint already
  // closes over every schema. A cache_control on a tool would be a second,
  // redundant breakpoint against a cap of four.
  for (const t of tools) {
    assertEquals(
      (t as unknown as Record<string, unknown>).cache_control,
      undefined,
      `tool ${t.name}`,
    );
  }
});

Deno.test("the history tail carries exactly one breakpoint, and it moves with the loop", async () => {
  const short = await bodySentBy(true, loopMessages(1));
  const long = await bodySentBy(true, loopMessages(6));

  assertEquals(breakpointsIn(short.messages), 1);
  assertEquals(breakpointsIn(long.messages), 1, "a breakpoint per step would 400 at the cap of four");

  for (const body of [short, long]) {
    const messages = body.messages as Anthropic.MessageParam[];
    const last = messages[messages.length - 1]!;
    const blocks = last.content as unknown as Record<string, unknown>[];
    assertEquals(
      blocks[blocks.length - 1]!.cache_control,
      EPH,
      "the breakpoint belongs on the final block of the final turn, or step N+1 re-bills steps 1..N",
    );
  }
});

Deno.test("the kernel's own messages array is never mutated by the send", async () => {
  // The loop keeps appending to the array it owns. A breakpoint written in
  // place would still be there on the next step, buried in the history.
  const messages = loopMessages(3);
  const snapshot = JSON.stringify(messages);
  await bodySentBy(true, messages);
  assertEquals(JSON.stringify(messages), snapshot);
});

Deno.test("AI_ENABLE_CACHING=0 removes every breakpoint and changes nothing else about the body", async () => {
  const messages = loopMessages(4);
  const on = await bodySentBy(true, messages);
  const off = await bodySentBy(false, messages);

  assertEquals(breakpointsIn(off.messages), 0);
  assertEquals(
    (off.system as Record<string, unknown>[])[0]!.cache_control,
    undefined,
  );
  // Still a block array with the same text - caching off changes what is
  // BILLED, not what the model is asked.
  assertEquals(
    JSON.stringify(withoutCacheControl(on)),
    JSON.stringify(withoutCacheControl(off)),
    "turning caching off changed something other than the breakpoints",
  );
});

Deno.test("nothing above the breakpoint varies between two runs of the same agent", async () => {
  // AC5's invalidator check, executed rather than asserted in prose. A
  // timestamp, run id or non-deterministic serialization anywhere in
  // tools + system silently costs a cache write on every single step.
  const a = await bodySentBy(true, loopMessages(3));
  await new Promise((r) => setTimeout(r, 5));
  const b = await bodySentBy(true, loopMessages(3));

  const prefixOf = (body: Body) =>
    JSON.stringify({ model: body.model, tools: body.tools, system: body.system });
  assertEquals(prefixOf(a), prefixOf(b), "the cached prefix differs between two identical calls");

  const prefix = prefixOf(a);
  assert(
    !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(prefix),
    "an ISO timestamp in the cached prefix invalidates it on every call",
  );
  assert(
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(prefix),
    "a uuid in the cached prefix invalidates it on every call",
  );
});

Deno.test("the tool schemas do not reorder when the allowlist does", async () => {
  // Tools render at position 0. Reordering them invalidates system AND the
  // whole history behind it, on every step, with no error to read.
  const forward = await bodySentBy(true, loopMessages(2), agentRow(READ_TOOLS));
  const reversed = await bodySentBy(true, loopMessages(2), agentRow([...READ_TOOLS].reverse()));
  assertEquals(
    JSON.stringify(forward.tools),
    JSON.stringify(reversed.tools),
    "tool order must come from the registry, not from the agent's allowlist order",
  );
});
