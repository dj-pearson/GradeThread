// US-2345 AC1: the reserved-snap refund, and specifically its FAILURE branches.
//
// This is the path where a quick-grade fails after the snap has been reserved.
// The user is told the grade failed; what they must not ALSO get is a silently
// consumed snap.
//
// WHY IT HAD NO TESTS, which is the whole point of US-2345: it lived inline in
// routes/grade.ts and called the service-role client directly, so exercising
// the failure branch needed a database. The branch that matters most was the
// one nothing covered. It is now a function with two injected effects, and the
// default IO is exactly what the handler did before.
//
// The original was `.then(() => {}, () => {})` — both callbacks empty. A refund
// that never happened looked exactly like one that did, so the seller's balance
// was short and nobody could put it right, because nothing recorded it was
// wrong.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { refundReservedSnap, defaultSnapRefundIO } = await import(
  "../lib/grade-refund.ts"
);

/** Records what was reported, so "was it silent?" is an assertion. */
function spyIO(refund: (userId: string) => Promise<{ error: { message: string } | null }>) {
  const reported: Array<{ err: unknown; userId: string }> = [];
  const seen: string[] = [];
  return {
    reported,
    seen,
    io: {
      refund: (userId: string) => {
        seen.push(userId);
        return refund(userId);
      },
      report: (err: unknown, userId: string) => {
        reported.push({ err, userId });
      },
    },
  };
}

Deno.test("US-2345: a successful refund reports nothing and says it worked", () => {
  const { io, reported, seen } = spyIO(() => Promise.resolve({ error: null }));
  return refundReservedSnap("user-1", io).then((ok) => {
    assertEquals(ok, true);
    assertEquals(seen, ["user-1"]);
    assertEquals(reported.length, 0, "a working refund raised an alert");
  });
});

Deno.test("US-2345: an RPC ERROR is reported, not swallowed", async () => {
  // supabase-js RESOLVES with { error } for a refused write. The old empty
  // success callback consumed exactly this shape — the most likely failure and
  // the most invisible.
  const { io, reported } = spyIO(() =>
    Promise.resolve({ error: { message: "permission denied for function refund_snap" } })
  );
  const ok = await refundReservedSnap("user-1", io);
  assertEquals(ok, false, "a refused refund reported success");
  assertEquals(reported.length, 1, "the refused refund was silent");
  assertEquals(reported[0]!.userId, "user-1", "the report cannot name whose balance is wrong");
  assert(
    JSON.stringify(reported[0]!.err).includes("permission denied"),
    "the report lost the reason",
  );
});

Deno.test("US-2345: a THROWN refund is reported too", async () => {
  // The other half, and the one the empty REJECTION callback ate. supabase-js
  // resolves with { error } for a refused write but can still throw on a
  // transport failure, so both paths have to be covered or the quiet one wins.
  const { io, reported } = spyIO(() => Promise.reject(new Error("socket hang up")));
  const ok = await refundReservedSnap("user-1", io);
  assertEquals(ok, false);
  assertEquals(reported.length, 1, "a thrown refund was swallowed");
  assert(
    String((reported[0]!.err as Error).message).includes("socket hang up"),
    "the thrown reason was lost",
  );
});

Deno.test("US-2345: it NEVER rejects — the caller must not need a wrapper", async () => {
  // The contract that keeps the handler honest. The caller has already decided
  // to answer 502; if this could throw, the handler would need a try/catch, and
  // a wrapper someone forgets is precisely how `.then(() => {}, () => {})`
  // happened in the first place.
  const { io } = spyIO(() => {
    throw new Error("synchronous explosion");
  });
  // No assertRejects here on purpose: reaching the next line IS the assertion.
  const ok = await refundReservedSnap("user-1", io);
  assertEquals(ok, false);
});

Deno.test("US-2345: a non-Error rejection still reports something useful", async () => {
  // Clients reject with plain objects. A report that stringifies to "{}" tells
  // an operator a snap is missing and nothing about why.
  const { io, reported } = spyIO(() => Promise.reject({ code: "PGRST301" }));
  await refundReservedSnap("user-1", io);
  assertEquals(reported.length, 1);
  assert(
    JSON.stringify(reported[0]!.err).includes("PGRST301"),
    "a non-Error rejection lost its detail",
  );
});

Deno.test("US-2345: the DEFAULT io calls refund_snap with the user id", () => {
  // The injected cases above prove the decisions; this proves the default wires
  // to the right RPC. Read from source because the real one needs a database —
  // but without it, every test above could pass against an io that talks to
  // nothing the handler actually uses.
  const src = Deno.readTextFileSync(
    new URL("../lib/grade-refund.ts", import.meta.url),
  ).replace(/(^|\s)\/\/[^\n]*/g, "$1");
  assert(
    /rpc\("refund_snap", \{ p_user_id: userId \}\)/.test(src),
    "the default refund IO no longer calls refund_snap with the user id",
  );
  assertEquals(typeof defaultSnapRefundIO.refund, "function");
  assertEquals(typeof defaultSnapRefundIO.report, "function");
});

Deno.test("US-2345: the handler still refunds on a failed snap grade", () => {
  // The extraction must not have quietly dropped the call. Bounded to the catch
  // block that answers 502, so a refund somewhere else in the file cannot
  // satisfy it.
  const src = Deno.readTextFileSync(
    new URL("../routes/grade.ts", import.meta.url),
  );
  const at = src.indexOf('route: "grade.snap"');
  assert(at > -1, "the snap failure handler is gone or was renamed");
  const around = src.slice(Math.max(0, at - 1200), at);
  assert(
    /await refundReservedSnap\(ownerId\)/.test(around),
    "the failed snap no longer refunds the reserved snap",
  );
  // And the old swallow-everything shape must not come back.
  //
  // COMMENTS STRIPPED, and this case failed without it. The comment above the
  // fix QUOTES `.then(() => {}, () => {})` to explain what was wrong, so a raw
  // scan finds the defect inside its own post-mortem and reports a regression
  // that is actually documentation. Third time this session; the rule is that a
  // guard whose pattern appears in the prose explaining it must strip comments
  // first, or it accuses the explanation.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  assert(
    !/\.then\(\(\) => \{\}, \(\) => \{\}\)/.test(code),
    "a fire-and-forget with both callbacks empty is back in grade.ts",
  );
});
