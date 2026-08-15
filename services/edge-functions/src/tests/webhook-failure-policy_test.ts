// US-2326 AC3: which webhooks fail CLOSED, and why the two answers differ.
//
// The acceptance criterion asked for the marketplace dedupe to fail closed on a
// database error. The owner decided against it on 2026-08-15, and this pins the
// decision at both call sites — because "fail open" reads like an oversight to
// anyone who finds it without the reasoning, and the AC's own wording invites
// someone to "fix" it.
//
// THE RULE IS NOT "FAIL OPEN". It is: fail CLOSED where the provider
// REDELIVERS, OPEN where it does not.
//
//   Stripe redelivers on a 500, and its events move money and entitlement. A
//   dropped one would be a real loss, and asking for a retry costs nothing.
//
//   A marketplace does not reliably redeliver. Failing closed there drops a
//   real sale on a transient blip, to prevent a double-process the idempotent
//   ingest already prevents — trading a benign duplicate for permanent loss.
//
// Both are observable rather than silent, which is what makes either defensible.
import { assert } from "@std/assert";

const STRIPE = await Deno.readTextFile(
  new URL("../routes/webhooks.ts", import.meta.url),
);
const MARKETPLACE = await Deno.readTextFile(
  new URL("../routes/flipdesk-webhooks.ts", import.meta.url),
);

Deno.test("US-2326: the Stripe path fails CLOSED and asks for a redelivery", () => {
  assert(
    /webhook\.fail_closed/.test(STRIPE),
    "the Stripe claim-failure path must record fail_closed",
  );
  assert(
    /re-?deliver|retry/i.test(STRIPE),
    "and must say that the 500 is asking Stripe to try again",
  );
});

Deno.test("US-2326: the marketplace path fails OPEN, observably", () => {
  assert(
    /webhook\.fail_open/.test(MARKETPLACE),
    "a silent fail-open is the version of this that is actually wrong",
  );
  assert(
    /captureException/.test(MARKETPLACE),
    "the metric alone is not enough — the exception is what names the topic",
  );
});

Deno.test("US-2326 AC3: the decision survives next to the code", () => {
  // The load-bearing case. A future reader hitting `claim === "error"` with no
  // explanation implements the AC as written and turns a duplicate into a lost
  // sale. The reasoning has to be there, not only in prd.json.
  assert(
    /US-2326 AC3/.test(MARKETPLACE),
    "the fail-open branch must cite the decision",
  );
  assert(
    /fail closed where the provider\s*\n?\s*\/\/\s*REDELIVERS|REDELIVERS/i.test(MARKETPLACE),
    "and must state the rule, so the Stripe difference does not read as an inconsistency",
  );
  assert(
    /durable retry or parking path/i.test(MARKETPLACE),
    "and must name the precondition for ever revisiting it",
  );
});
