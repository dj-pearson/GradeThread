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

// US-2664 AC4: the WRITE helpers, decided explicitly rather than swept.
//
// A failed write is worse than a failed read, and in a specific way: the agent
// does not merely lack an answer, it reports an ACTION it did not take. Two of
// these are on paths that touch customers.
//
// The value each one returns is the reason it needed fixing, not a detail:
//   persistReleaseState / persistMarketplaceOpsBacklog  return NOTHING, so the
//     only evidence of success was that nothing threw — and nothing could.
//   setMarketingFrequencyCap  returns the new cap unconditionally, so a failed
//     write reported the cap as applied while sends kept the old one.
//   insertAdminTask  .single() always yields a row on success, so null was only
//     ever failure, inferred from an absence.
//   requeueEmailDeadLetter / addMarketingTopic  have a LEGITIMATE false — "not
//     in dead_letter", "duplicate ignored" — which is exactly why it must not
//     double as the error signal.
//   enrollCohort  is the sharpest: a failed cohort read says "nobody's trial is
//     expiring", and a failed DEDUPE read re-enrolls people who are already
//     enrolled. That one is a duplicate marketing send, not a missing number.
Deno.test("the write helpers cannot report success on a failed write", () => {
  for (
    const name of [
      "persistReleaseState",
      "persistMarketplaceOpsBacklog",
      "setMarketingFrequencyCap",
      "insertAdminTask",
      "requeueEmailDeadLetter",
      "addMarketingTopic",
      "enrollCohort",
    ]
  ) {
    const at = SRC.indexOf(`    ${name}: async `);
    assert(at > -1, `${name} was renamed — update this guard`);
    const body = SRC.slice(at, SRC.indexOf("\n    },", at));
    assert(
      /const \{[^}]*\berror\b[^}]*\} = await supabaseAdmin/.test(body) ||
        /const \{[^}]*\bError:[^}]*\} = await supabaseAdmin/.test(body),
      `${name} must bind the error from at least one supabaseAdmin call`,
    );
    assert(
      body.includes("throw new Error(") && body.includes(`${name} failed:`),
      `${name} must throw and name itself — several helpers share this shape ` +
        `and a bare message would not say which write was lost`,
    );
  }
});

Deno.test("every query in a write helper is guarded, not just one of them", () => {
  // ⚠ THIS CASE EXISTS BECAUSE THE FIRST VERSION OF THE ONE ABOVE MISSED A
  // SABOTAGE. Deleting the UPDATE guard from requeueEmailDeadLetter left the
  // suite green, because the helper still contained a throw — from its READ
  // guard, three lines earlier. "Throws somewhere" is not the property; "no
  // unchecked query" is.
  //
  // It matters most exactly where it is least visible: a SELECT sitting in the
  // middle of a write path. enrollCohort's dedupe read is the case in point —
  // unguarded, it comes back empty and everyone already enrolled is enrolled
  // AGAIN, which is a duplicate marketing send rather than a missing number.
  for (
    const name of [
      "requeueEmailDeadLetter",
      "addMarketingTopic",
      "enrollCohort",
    ]
  ) {
    const at = SRC.indexOf(`    ${name}: async `);
    assert(at > -1, `${name} was renamed — update this guard`);
    const body = SRC.slice(at, SRC.indexOf("\n    },", at));
    const queries = (body.match(/await supabaseAdmin/g) ?? []).length;
    const throws = (body.match(new RegExp(`throw new Error\\(\`${name} failed:`, "g")) ?? [])
      .length;
    assert(queries > 1, `${name} should have several queries; got ${queries}`);
    assertEquals(
      throws,
      queries,
      `${name} makes ${queries} queries but guards only ${throws}. An unguarded ` +
        `one is the whole defect: its empty result flows on as if it were real.`,
    );
  }
});

/**
 * US-2664 AC5: the ratchet. No NEW io helper may drop the error binding.
 *
 * Every helper that runs a supabaseAdmin query must either surface the failure
 * or appear below with a reason. The list may only shrink: an entry that stops
 * matching fails too, so a helper that gets fixed cannot leave a stale excuse
 * behind (the KNOWN_GAPS idiom from migrations-lint).
 *
 * This is the case that makes the other five durable. The count went 2 → 8 → 15
 * → 42 over three passes, and without a ratchet the next helper someone adds
 * starts it drifting back.
 */
const TOLERATED_SWALLOW = new Map([
  [
    "persistTicketTriage",
    "Triages MANY tickets in a loop and counts only the ones that changed, so a " +
      "failed row is already excluded from the answer rather than hidden in it. " +
      "Throwing would abandon every ticket after the one that failed.",
  ],
]);

Deno.test("no io helper swallows a database error without a recorded reason", () => {
  // ` {4}` rather than four literal spaces: deno's no-regex-spaces rejects
  // consecutive spaces in a pattern, and the run-length form says the intent
  // (the io helpers' indentation) instead of relying on someone counting.
  const helpers = [...SRC.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9_]*): async \(/gm)]
    .filter((m) => m[1] !== "handler");
  assert(helpers.length > 30, `expected the io helper block; found ${helpers.length}`);

  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const m of helpers) {
    const name = m[1]!;
    const body = SRC.slice(m.index!, SRC.indexOf("\n    },", m.index!));
    if (!body.includes("await supabaseAdmin")) continue; // no query to guard
    if (TOLERATED_SWALLOW.has(name)) {
      seen.add(name);
      continue;
    }
    // Surfacing means: binds the error AND throws on it. Either alone is not
    // enough — binding and then only logging was one of the sabotages.
    const binds = /\berror(?::\s*[a-zA-Z0-9_]+)?\s*[,}]/.test(body);
    if (!binds || !body.includes("throw new Error(")) offenders.push(name);
  }

  assertEquals(
    offenders,
    [],
    `these io helpers swallow a database error:\n  ${offenders.join("\n  ")}\n` +
      `Bind it and throw, naming the helper — the dispatcher turns a throw into ` +
      `a visible tool_error. If an empty result is genuinely legitimate there, ` +
      `add it to TOLERATED_SWALLOW with the reason.`,
  );

  const stale = [...TOLERATED_SWALLOW.keys()].filter((n) => !seen.has(n));
  assertEquals(
    stale,
    [],
    `TOLERATED_SWALLOW names helper(s) that no longer match: ${stale.join(", ")}. ` +
      `Remove them — the list may only shrink.`,
  );
});

Deno.test("every tolerated swallow carries a real reason", () => {
  for (const [name, why] of TOLERATED_SWALLOW) {
    assert(why.length > 40, `${name} needs a reason, not a label`);
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
