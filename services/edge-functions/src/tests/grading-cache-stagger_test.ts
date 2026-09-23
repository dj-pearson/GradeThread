// US-3345: the staggered per-image fan-out, driven for real.
//
// A prompt-cache entry is readable once the request that writes it has begun
// streaming. With GRADING_CACHE_STAGGER on, photo 1 streams and photos 2..N are
// released at its first token, so they read the entry instead of each paying
// the 1.25x write. This pins the ORDERING (the property a later refactor would
// undo silently), the degrade paths, the flag's dependency on grading caching,
// the provider's streamed path, and that the stream carries the same request
// body the non-streamed call does.
//
// It also pins the prefix claim the cache economics rest on: the per-image
// system prefix is identical across garment types and categories, so the
// cross-submission read is available to every grade on one serving version.
//
//   deno test --allow-net --allow-env --allow-read src/tests/grading-cache-stagger_test.ts

import "./_env.ts";

if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals } from "@std/assert";
import { getAnthropicClient } from "../lib/ai-config.ts";
import { analyzeImage } from "../lib/ai-grading.ts";
import {
  gradingCacheStaggerEnabled,
  staggerFirstCall,
} from "../lib/grading-cache-stagger.ts";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const REPLY = JSON.stringify({
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

type Body = Record<string, unknown>;

function setEnv(key: string, value: string | undefined): string | undefined {
  const before = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  return before;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// -- 1. The ordering ---------------------------------------------------------

Deno.test("staggered: 2..N wait for photo 1's FIRST TOKEN, then start together, before photo 1 finishes", async () => {
  const started: number[] = [];
  const first = deferred<string>();
  let releaseFirstToken: (() => void) | undefined;
  const fan = staggerFirstCall(
    ["front", "back", "label", "detail"],
    (item, i, onFirstToken) => {
      started.push(i);
      if (i === 0) {
        releaseFirstToken = onFirstToken;
        return first.promise;
      }
      assertEquals(onFirstToken, undefined, "only photo 1 streams");
      return Promise.resolve(item);
    },
    true,
  );
  await tick();
  assertEquals(started, [0], "photos 2..N must not start before photo 1's first token");
  assert(releaseFirstToken, "photo 1 was handed the first-token callback");
  releaseFirstToken!();
  await tick();
  assertEquals(started, [0, 1, 2, 3], "all of 2..N are released at once");
  first.resolve("front");
  const settled = await Promise.allSettled(fan.promises);
  assertEquals(settled.map((s) => s.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  assert((await fan.gateMs) >= 0);
});

Deno.test("staggered: a photo 1 that never streams still releases the rest when it settles", async () => {
  const started: number[] = [];
  const first = deferred<string>();
  const fan = staggerFirstCall(
    ["a", "b", "c"],
    (item, i) => {
      started.push(i);
      return i === 0 ? first.promise : Promise.resolve(item);
    },
    true,
  );
  await tick();
  assertEquals(started, [0]);
  first.reject(new Error("photo 1 failed"));
  const settled = await Promise.allSettled(fan.promises);
  assertEquals(started, [0, 1, 2], "a failed photo 1 must not strand the rest");
  assertEquals(settled.map((s) => s.status), ["rejected", "fulfilled", "fulfilled"]);
});

Deno.test("staggered: calling onFirstToken twice starts each of 2..N once", async () => {
  const started: number[] = [];
  let tokenFn: (() => void) | undefined;
  const fan = staggerFirstCall(
    [0, 1, 2],
    (item, i, onFirstToken) => {
      started.push(i);
      if (i === 0) tokenFn = onFirstToken;
      return Promise.resolve(item);
    },
    true,
  );
  tokenFn!();
  tokenFn!();
  await Promise.allSettled(fan.promises);
  assertEquals(started, [0, 1, 2]);
});

Deno.test("off, or a single photo: every call starts immediately, exactly like a bare .map()", async () => {
  for (const [items, enabled] of [[["a", "b", "c"], false], [["a"], true]] as const) {
    const started: number[] = [];
    const tokens: Array<(() => void) | undefined> = [];
    const fan = staggerFirstCall(
      items,
      (_item, i, onFirstToken) => {
        started.push(i);
        tokens.push(onFirstToken);
        return new Promise<string>(() => {}); // never settles
      },
      enabled,
    );
    assertEquals(started, items.map((_, i) => i), "all started synchronously");
    assert(tokens.every((t) => t === undefined), "nothing streams when not staggered");
    assertEquals(await fan.gateMs, 0);
  }
});

Deno.test("the flag is inert unless grading caching is on: nothing to read, nothing to wait for", () => {
  const s = setEnv("GRADING_CACHE_STAGGER", "1");
  const g = setEnv("GRADING_ENABLE_CACHING", "0");
  try {
    assertEquals(gradingCacheStaggerEnabled(), false);
    Deno.env.set("GRADING_ENABLE_CACHING", "1");
    assertEquals(gradingCacheStaggerEnabled(), true);
    Deno.env.delete("GRADING_CACHE_STAGGER");
    assertEquals(gradingCacheStaggerEnabled(), false, "default OFF");
  } finally {
    setEnv("GRADING_CACHE_STAGGER", s);
    setEnv("GRADING_ENABLE_CACHING", g);
  }
});

// -- 2. The provider's streamed path, on the real analyzeImage -----------------

interface Sent {
  via: "create" | "stream";
  body: Body;
}

/** Stub BOTH SDK entry points and record which one analyzeImage used. */
async function sendOne(
  onFirstToken: (() => void) | undefined,
  garment: [string, string] = ["tops", "hoodie"],
): Promise<Sent> {
  const surface = getAnthropicClient().messages as unknown as {
    create: (...args: unknown[]) => unknown;
    stream: (...args: unknown[]) => unknown;
  };
  const originalCreate = surface.create;
  const originalStream = surface.stream;
  let sent: Sent | null = null;
  const reply = (body: Body) => ({
    content: [{ type: "text", text: REPLY }],
    model: body.model,
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  surface.create = (body: unknown) => {
    sent ??= { via: "create", body: body as Body };
    return Promise.resolve(reply(body as Body));
  };
  surface.stream = (body: unknown) => {
    sent ??= { via: "stream", body: body as Body };
    const listeners: Array<() => void> = [];
    return {
      on(event: string, listener: () => void) {
        if (event === "streamEvent") listeners.push(listener);
        return this;
      },
      async finalMessage() {
        // message_start, content_block_start, a delta: three events, one signal.
        for (let i = 0; i < 3; i++) listeners.forEach((l) => l());
        await tick();
        return reply(body as Body);
      },
    };
  };
  try {
    await analyzeImage(
      TINY_PNG,
      "front",
      garment[0],
      garment[1],
      [],
      undefined,
      undefined,
      undefined,
      "",
      undefined,
      undefined,
      onFirstToken,
    );
  } catch {
    // The request is the subject; a post-parse failure does not change it.
  } finally {
    surface.create = originalCreate;
    surface.stream = originalStream;
  }
  if (!sent) throw new Error("analyzeImage sent nothing");
  return sent;
}

Deno.test("with onFirstToken the call STREAMS and signals exactly once; without it, the plain create", async () => {
  let fired = 0;
  const streamed = await sendOne(() => fired++);
  assertEquals(streamed.via, "stream");
  assertEquals(fired, 1, "three stream events, one release");
  const plain = await sendOne(undefined);
  assertEquals(plain.via, "create", "the default path is untouched");
});

Deno.test("the streamed call sends the SAME body: transport, not a prompt change", async () => {
  const streamed = await sendOne(() => {});
  const plain = await sendOne(undefined);
  assertEquals(JSON.stringify(streamed.body), JSON.stringify(plain.body));
  assert(!("stream" in streamed.body), "the SDK's .stream() adds stream:true itself");
});

// -- 3. The cacheable prefix ---------------------------------------------------

Deno.test("the per-image cached prefix is identical across garment types and categories", async () => {
  const a = await sendOne(undefined, ["tops", "hoodie"]);
  const b = await sendOne(undefined, ["bottoms", "jeans"]);
  const c = await sendOne(undefined, ["outerwear", "coat"]);
  const sys = (s: Sent) => JSON.stringify(s.body.system);
  assertEquals(sys(a), sys(b), "garment type/category leaked into the cached system prefix");
  assertEquals(sys(a), sys(c));
  // What varies stays AFTER the breakpoint, in the user turn.
  assert(JSON.stringify(a.body.messages) !== JSON.stringify(b.body.messages));
});

Deno.test("the per-image cached prefix clears the 1,024-token minimum on the serving model with margin", async () => {
  const s = await sendOne(undefined);
  const system = s.body.system as Array<{ text: string; cache_control?: unknown }>;
  assert(system[0].cache_control, "block 0 carries the breakpoint");
  const chars = system[0].text.length;
  // Estimate only (count_tokens needs a key): 4.5 chars per token is on the
  // pessimistic side for English prose, so passing here means real headroom.
  // The serving default is claude-sonnet-5, minimum 1,024. Haiku 4.5 (the
  // US-1066 cascade's first pass, off by default) needs 4,096 and does NOT
  // clear it on block 0 alone.
  assert(chars / 4.5 >= 1024, `block 0 is ${chars} chars, ~${Math.round(chars / 4.5)} tokens`);
});
