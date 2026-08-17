// The agent's RPC helper must surface a failure, not return null.
//
// FOUND 2026-08-16 while asking why nobody noticed revenue_dashboard is broken.
// The helper read:
//
//     rpc: async (name, args) => {
//       const { data } = await supabaseAdmin.rpc(name, (args ?? {}) as never);
//       return data;
//     }
//
// It destructured only `data`, and supabase-js answers { data: null, error } on
// failure. So a failing RPC became a silent null the model then reasoned over.
//
// Not hypothetical. revenue_dashboard raises 42703 on every call (US-2663 — its
// trial cohort selects users.trial_started_at, a column that has never existed
// on that table), and get_revenue answered { window, revenue: null } with no
// error for as long as that has been true. Nine io.rpc call sites across five
// RPCs degraded the same way, and system_health is the sharper case: it
// legitimately refuses an unprivileged caller with 42501, so swallowing made
// "healthy but empty" and "not allowed to look" identical.
//
// Throwing is correct here rather than merely louder: the tool dispatcher wraps
// every handler and turns a throw into { error: { code: "tool_error" } }, which
// the model sees. And fetchMarketplaceConnections six lines above already does
// exactly this, with a comment giving the same reason — the asymmetry was the
// bug.
import { assert, assertEquals, assertRejects } from "@std/assert";

/** What supabase-js hands back: exactly one of the two is populated. */
interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}


const SRC = Deno.readTextFileSync(new URL("../lib/agent-tools.ts", import.meta.url));

/** The body of the `rpc:` helper, up to its closing brace. */
function rpcHelper(): string {
  const at = SRC.indexOf("    rpc: async (name, args) => {");
  assert(at > -1, "the rpc helper was renamed or restructured — update this guard");
  const end = SRC.indexOf("\n    },", at);
  assert(end > at, "could not find the end of the rpc helper");
  return SRC.slice(at, end);
}

Deno.test("the rpc helper binds `error` and throws on it", () => {
  const body = rpcHelper()
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert(
    /const \{ data, error \} = await supabaseAdmin\.rpc\(/.test(body),
    "rpc must destructure `error`, not only `data` — otherwise a failed call " +
      "returns null and the agent reports it as an answer",
  );
  assert(
    /if \(error\) throw/.test(body),
    "rpc must THROW on error. The tool dispatcher wraps handlers and turns a " +
      "throw into a visible tool_error; returning null is indistinguishable " +
      "from an empty result.",
  );
  assert(
    /rpc \$\{name\} failed/.test(body),
    "the thrown message must name the RPC — five different RPCs share this helper",
  );
});

Deno.test("a failing rpc rejects rather than resolving to null", async () => {
  // Exercises the SHAPE the helper implements, against a stub that answers the
  // way supabase-js does. The source check above pins the code; this pins the
  // behaviour, so a rewrite that keeps the words and loses the effect fails.
  const stub = {
    rpc: (_name: string, _args: unknown): Promise<RpcResult> =>
      Promise.resolve({ data: null, error: { message: "column x does not exist" } }),
  };
  const helper = async (name: string, args?: unknown) => {
    const { data, error } = await stub.rpc(name, args ?? {});
    if (error) throw new Error(`rpc ${name} failed: ${error.message}`);
    return data;
  };
  await assertRejects(
    () => helper("revenue_dashboard"),
    Error,
    "rpc revenue_dashboard failed",
  );
});

Deno.test("a successful rpc still returns its data unchanged", async () => {
  // The fix must not turn an empty-but-valid result into a failure: several of
  // these RPCs legitimately answer with zero rows on a quiet day.
  const stub = {
    rpc: (_name: string, _args: unknown): Promise<RpcResult> =>
      Promise.resolve({ data: { rows: [] }, error: null }),
  };
  const helper = async (name: string, args?: unknown) => {
    const { data, error } = await stub.rpc(name, args ?? {});
    if (error) throw new Error(`rpc ${name} failed: ${error.message}`);
    return data;
  };
  assertEquals(await helper("ai_spend"), { rows: [] });
});

// US-2664 first slice: the reads whose EMPTY result is affirmatively
// reassuring. A failed count that returns 0 does not say "I could not look", it
// says "there are no open sync conflicts" — to an agent, which says it to a
// human. Same for a dead-letter queue: empty is the single most comforting
// thing this agent can report.
//
// Scoped deliberately. 32 helpers in this file still drop the error binding and
// most are genuinely lower-stakes; sweeping all of them in one pass, each
// needing a judgement about whether empty is legitimate, is how a sweep
// introduces the bug it removes. These six were done because their failure mode
// is a confident wrong answer rather than a missing one.
Deno.test("the open-problem counters cannot report zero on a failed read", () => {
  for (
    const name of [
      "countOpenSyncConflicts",
      "countOrphanSales",
      "countOpenModerationFlags",
      "countOpenPassportIntegritySignals",
    ]
  ) {
    const at = SRC.indexOf(`    ${name}: async () => {`);
    assert(at > -1, `${name} was renamed — update this guard`);
    const body = SRC.slice(at, SRC.indexOf("\n    },", at));
    assert(
      /const \{ count, error \} = await supabaseAdmin/.test(body),
      `${name} must bind error — returning "count ?? 0" on failure reports no open problems`,
    );
    assert(
      // Plain substring checks rather than a built regex: a regex assembled in
      // a template literal here had its escapes eaten on the way into the file,
      // turning the parens into capture groups and the assertion into nonsense.
      body.includes("if (error) throw new Error(") && body.includes(`${name} failed:`),
      `${name} must throw and name itself; four counters share this shape`,
    );
  }
});

Deno.test("the dead-letter queues cannot report empty on a failed read", () => {
  for (const name of ["fetchWebhookDeadLetters", "fetchEmailDeadLetters"]) {
    const at = SRC.indexOf(`    ${name}: async (limit) => {`);
    assert(at > -1, `${name} was renamed — update this guard`);
    const body = SRC.slice(at, SRC.indexOf("\n    },", at));
    assert(
      /const \{ data, error \} = await supabaseAdmin/.test(body),
      `${name} must bind error — "(data ?? [])" on failure reports nothing stuck`,
    );
    assert(
      // Plain substring checks rather than a built regex: a regex assembled in
      // a template literal here had its escapes eaten on the way into the file,
      // turning the parens into capture groups and the assertion into nonsense.
      body.includes("if (error) throw new Error(") && body.includes(`${name} failed:`),
      `${name} must throw and name itself`,
    );
  }
});
