// US-2345: the money paths, and the three defects the audit found in them.
//
// grade.ts, admin-billing.ts and affiliate-payout.ts are where a bug costs real
// money. Two of the three findings were real; the third was true as written and
// wrong in what it implied, and saying which is the useful part.
//
// ── AC4, REAL AND THE WORST OF THE THREE ────────────────────────────────────
// The payout sweep caps each phase at 500 rows. Phase (a) ordered its select;
// phases (b) and (c) did not. Postgres with no ORDER BY returns an arbitrary
// set — and an arbitrary set from a STABLE PLAN is the same 500 rows on every
// run. So past the cap an affiliate is not delayed, they are permanently
// starved, and nothing reports it. Phase (c) is the worse of the two because it
// has no age cap to eventually flush a row.
//
// ── AC2, REAL ───────────────────────────────────────────────────────────────
// grade.ts refunded a reserved snap with `.then(() => {}, () => {})` — both
// callbacks empty, so a refund that never happened looked exactly like one that
// did. The user is already being told the grade failed; what they must not also
// get is a silently consumed snap that nobody hears about.
//
// ── AC3, TRUE AS WRITTEN, WRONG IN WHAT IT IMPLIES ──────────────────────────
// "affiliate-payout.ts marks commissions paid BEFORE the Stripe transfer fires"
// is literally accurate. But the AC offers "or uses a two-phase record", and
// that is exactly what this is: `affiliate_payouts` is the idempotency unit,
// created `pending`; claiming commissions into it moves them off `accrued`; the
// transfer then flips the PAYOUT row to paid or failed. A failed transfer keeps
// the commissions attached so the sweep retries the SAME idempotency key, and
// deliberately never releases them — releasing would risk double-paying a
// transfer that actually went through on a network blip.
//
// So no fix was applied, and the properties that make it safe are pinned below
// instead. The one genuine hazard is that `affiliate_commissions.status` says
// "paid" when it means "claimed into a payout" — anything summing that column
// as money-out-the-door would be wrong.

import { assert } from "@std/assert";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));
const PAYOUT = read("../lib/affiliate-payout.ts");
const GRADE = read("../routes/grade.ts");

/** The `sweepAffiliatePayouts` body — where all three phases live. */
function sweep(): string {
  const at = PAYOUT.indexOf("(a) ");
  assert(at > -1, "the sweep phases were restructured");
  return PAYOUT.slice(at);
}

Deno.test("US-2345 AC4: every capped sweep select is ordered", () => {
  // Checked as "a .limit(SWEEP_LIMIT) with no .order() above it", not as three
  // hand-written cases — a fourth phase added later is the one that would slip.
  const body = sweep();
  const unordered: string[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(".limit(SWEEP_LIMIT)", from);
    if (at === -1) break;
    // The select statement this limit belongs to, back to the previous `.from(`.
    const start = body.lastIndexOf(".from(", at);
    const stmt = body.slice(start, at);
    if (!stmt.includes(".order(")) {
      unordered.push(stmt.split("\n")[0]!.trim());
    }
    from = at + 1;
  }
  assert(
    unordered.length === 0,
    `these capped selects have no ORDER BY, so past ${"500"} rows the same set ` +
      `is re-read every run and everyone beyond it is starved: ${unordered.join(", ")}`,
  );
});

Deno.test("US-2345 AC4: the scan found the caps at all", () => {
  // Guards the guard. If SWEEP_LIMIT is renamed the case above passes by
  // finding nothing, which is the quietest way for it to stop working.
  const body = sweep();
  const caps = body.split(".limit(SWEEP_LIMIT)").length - 1;
  assert(caps >= 3, `expected the three capped phases, found ${caps}`);
});

Deno.test("US-2345 AC4: the two fixed phases order by the right column", () => {
  // Oldest-first in both, and that is a fairness decision rather than a default:
  // a payout failing for a week outranks one that failed a minute ago, and the
  // affiliate who has waited longest gets paid first.
  const body = sweep();
  assert(
    /\.in\("status", \["pending", "failed"\]\)[\s\S]{0,600}?\.order\("created_at", \{ ascending: true \}\)/
      .test(body),
    "the retry phase no longer takes the oldest open payout first",
  );
  assert(
    /\.lte\("hold_until", nowIso\)[\s\S]{0,600}?\.order\("hold_until", \{ ascending: true \}\)/
      .test(body),
    "the create phase no longer takes the longest-waiting commission first",
  );
});

Deno.test("US-2345 AC2: the snap refund reports a failure", () => {
  // US-2345 AC1 moved this out of grade.ts into lib/grade-refund.ts so the
  // failure branch could be tested at all, so this guard now FOLLOWS THE
  // INDIRECTION rather than reading the handler's catch block.
  //
  // Both halves are asserted, and that is the point rather than thoroughness:
  // either one alone can hold while the property is gone — a handler that no
  // longer calls the refund, or a refund that no longer reports. Weakening this
  // to match the new shape (just "does grade.ts mention refundReservedSnap")
  // would have been the easy move and would have checked nothing.
  const REFUND = Deno.readTextFileSync(
    new URL("../lib/grade-refund.ts", import.meta.url),
  );

  // (1) the handler still asks for the refund, in the branch that answers 502.
  const at = GRADE.indexOf('route: "grade.snap"');
  assert(at > -1, "the snap failure handler is gone or was renamed");
  assert(
    /await refundReservedSnap\(ownerId\)/.test(GRADE.slice(Math.max(0, at - 1200), at)),
    "the failed snap no longer refunds the reserved snap",
  );

  // (2) the refund still reports BOTH failure shapes. Comments stripped: the
  // explanation in that file quotes the old `.then(() => {}, () => {})` to say
  // what was wrong, so a raw scan finds the defect inside its own post-mortem.
  const code = REFUND
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  assert(
    /if \(error\)[\s\S]{0,120}io\.report\(error, userId\)/.test(code),
    "a REFUSED refund is no longer reported — supabase-js resolves with " +
      "{ error } for a refused write, so this is the likeliest failure and the " +
      "most invisible",
  );
  assert(
    /catch \(err\)[\s\S]{0,200}io\.report\(err, userId\)/.test(code),
    "a THROWN refund is no longer reported, so a transport failure leaves a " +
      "silently consumed snap nobody hears about",
  );
  assert(
    !/\.then\(\(\) => \{\}, \(\) => \{\}\)/.test(
      GRADE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1"),
    ),
    "the refund swallows both outcomes again — a refund that never happened " +
      "looks exactly like one that did",
  );
});

Deno.test("US-2345 AC3: the payout record really is two-phase", () => {
  // Not a fix — a pin. These four properties are what make "mark claimed before
  // transferring" safe, and losing any one of them turns it into the bug the
  // story thought it was.
  assert(
    /\.from\("affiliate_payouts"\)\s*\n\s*\.insert\(\{[\s\S]{0,200}status: "pending"/.test(PAYOUT),
    "the payout row is no longer created pending — there is no phase to fail into",
  );
  assert(
    /\.update\(\{ status: "paid", payout_id: payoutId \}\)/.test(PAYOUT),
    "commissions are no longer CLAIMED into a payout id",
  );
  assert(
    /idempotencyKey: `affiliate_payout_\$\{payoutId\}`/.test(PAYOUT),
    "the transfer lost its idempotency key, so a retry can double-pay",
  );
  // US-2345 AC1 made the two writes injectable, so this now follows ONE level of
  // indirection instead of reading the catch block directly. Both halves are
  // asserted, because either alone can be satisfied while the property is gone:
  // the catch could call a markFailed that no longer writes `failed`, or the
  // default IO could be correct and never called.
  const fail = PAYOUT.slice(PAYOUT.indexOf("} catch (err) {", PAYOUT.indexOf("async function fireTransfer")));
  assert(
    /io\.markFailed\(/.test(fail.slice(0, 600)),
    "a failed transfer no longer marks the payout failed, so the retry phase " +
      "cannot find it",
  );
  const defaultIO = PAYOUT.slice(
    PAYOUT.indexOf("const defaultTransferIO"),
    PAYOUT.indexOf("export async function fireTransfer"),
  );
  assert(
    /markFailed\([\s\S]{0,400}status: "failed"/.test(defaultIO),
    "the default markFailed no longer writes status:'failed' — the indirection " +
      "is correct and the write behind it is not",
  );
  // And the commissions must NOT be released on failure — checked in the catch
  // AND in the IO it delegates to, since the release could now live in either.
  for (const [where, src] of [["catch", fail.slice(0, 800)], ["default IO", defaultIO]] as const) {
    assert(
      !/status: "accrued"[\s\S]{0,200}payout_id: null/.test(src),
      `a failed transfer releases the commissions in the ${where} — that risks ` +
        "double-paying a transfer that actually went through on a network blip",
    );
  }
});

Deno.test("US-2345 AC3: nothing sums commissions.status='paid' as money sent", () => {
  // The residual hazard the two-phase design creates: that column says "paid"
  // and means "claimed into a payout". Money actually leaving is
  // affiliate_payouts.status = 'paid' plus a stripe_transfer_id.
  const libs = new URL("../lib/", import.meta.url);
  const routes = new URL("../routes/", import.meta.url);
  const offenders: string[] = [];
  for (const dir of [libs, routes]) {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.isFile || !e.name.endsWith(".ts")) continue;
      const src = Deno.readTextFileSync(new URL(e.name, dir));
      for (const m of src.matchAll(/from\("affiliate_commissions"\)([\s\S]{0,400}?);/g)) {
        if (/\.eq\("status", "paid"\)/.test(m[0]) && /sum|total|amount/i.test(m[0])) {
          offenders.push(e.name);
        }
      }
    }
  }
  assert(
    offenders.length === 0,
    `these total commissions by status='paid', which counts money that has not ` +
      `left Stripe: ${offenders.join(", ")}. Use affiliate_payouts.status.`,
  );
});

// ── US-2298: the read-then-act debit race on POST /pay/:id ──────────────────
//
// /pay reads `payment_status !== "unpaid"` and returns early, then debits. Two
// concurrent calls can both pass the read before either writes, and both
// charge. Narrow window, real money — the worst combination, because it fires
// too rarely to be noticed and reproduced, and each time it does a customer
// paid twice for one grade.
//
// A TRUE TWO-CALLER RACE TEST NEEDS THE LOCAL SUPABASE STACK. The dedupe is
// enforced in SQL (a keyed pre-check under the users-row lock, backstopped by
// the partial unique index from 00216), so nothing in this suite can execute
// it. What is pinned here is the half that lives in TypeScript: the key is
// passed, it is DERIVED so a retry reproduces it, and the RPC still forwards
// it. Those are the three ways this regresses silently.

Deno.test("US-2298: EVERY charge site in grade.ts passes a derived key", () => {
  // Enumerated, not "find the call and check it". The first version of this
  // case did exactly that and asserted against `indexOf`, which found the
  // CREATE path at :715 rather than the /pay retry it was written for — there
  // are two charge sites in this file and the story names only one. It failed
  // for the right reason and pointed at a second site that also had no key.
  const calls = [...GRADE.matchAll(/runPaymentPrecedence\(/g)];
  assert(
    calls.length >= 2,
    `expected both grade.ts charge sites, found ${calls.length} — if a charge ` +
      "path was removed, this guard is now checking less than it claims",
  );

  for (const m of calls) {
    const call = GRADE.slice(m.index!, m.index! + 300);
    // Matched to the CLOSING BACKTICK, and that is the whole assertion rather
    // than a stylistic detail. The key must be derived and NOTHING else: a key
    // of `grade_pay:${submissionId}:${crypto.randomUUID()}` is fresh on every
    // attempt, so it dedupes nothing while reading as idempotent in review —
    // strictly worse than passing no key, because it stops anyone looking.
    //
    // A separate "is it random?" assertion was written here and then removed:
    // pinning the exact form already rejects every appended-entropy variant, so
    // that case could not fail on any mutation and only implied coverage it did
    // not have. Negative verification is what surfaced it.
    assert(
      /`grade_pay:\$\{submissionId\}`/.test(call),
      "a charge site in grade.ts passes no idempotency key (or a key that is " +
        "not exactly the derived one), so two concurrent calls can both pass " +
        "the unpaid check and both debit real money",
    );
  }
});

Deno.test("US-2298: the key reaches the RPC, and the DB half still checks it", () => {
  const BILLING = read("../lib/grade-billing.ts");
  assert(
    /p_idempotency_key: idempotencyKey \?\? null/.test(BILLING),
    "runPaymentPrecedence no longer forwards the key to debit_grade_credits — " +
      "callers would pass one and it would be dropped on the floor",
  );

  // The SQL side, read from the migration that owns it. Comments stripped: the
  // migration explains the mechanism at length and names these very
  // identifiers, so a raw scan would pass on prose alone.
  const sql = Deno.readTextFileSync(
    new URL(
      "../../../../supabase/migrations/00516_debit_grade_credits_idempotency.sql",
      import.meta.url,
    ),
  ).replace(/--[^\n]*/g, "");
  assert(
    /IF p_idempotency_key IS NOT NULL THEN[\s\S]{0,400}RETURN v_balance;/.test(sql),
    "debit_grade_credits no longer short-circuits on a key it has already " +
      "seen, so the key is accepted and ignored",
  );
  // The check must sit BEFORE the insufficient-balance test and the insert, or
  // a repeat of an already-paid debit can fail as INSUFFICIENT_CREDITS and
  // push the caller into a checkout it does not need.
  assert(
    sql.indexOf("IF p_idempotency_key IS NOT NULL THEN") <
      sql.indexOf("INSUFFICIENT_CREDITS"),
    "the dedupe check moved after the balance test — a paid-for retry can now " +
      "be refused for want of credits it does not need to spend",
  );
});

Deno.test("US-2298: the row lock is NOT mistaken for the dedupe", () => {
  // debit_grade_credits takes `SELECT … FOR UPDATE` on the users row, so it
  // LOOKS safe and the idempotency key looks redundant. FOR UPDATE serialises
  // the two debits; it does not deduplicate them — both take the lock in turn,
  // both find sufficient balance, both write a ledger row. The result is a
  // double charge in tidy sequential order rather than a torn one.
  //
  // The lock protects the balance ARITHMETIC (US-207). Nothing protects the
  // DECISION to charge. This case exists so that reasoning is attached to the
  // code rather than living only in a story note.
  const sql = Deno.readTextFileSync(
    new URL(
      "../../../../supabase/migrations/00516_debit_grade_credits_idempotency.sql",
      import.meta.url,
    ),
  );
  assert(/FOR UPDATE/.test(sql), "the balance row lock is gone");
  assert(
    /idempotency_key/.test(sql.replace(/--[^\n]*/g, "")),
    "the key was removed as redundant with the lock — it is not",
  );
});
