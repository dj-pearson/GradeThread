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
  const at = GRADE.indexOf('rpc("refund_snap"');
  assert(at > -1, "the snap refund is gone");
  const around = GRADE.slice(Math.max(0, at - 200), at + 400);
  assert(
    !/\.then\(\(\) => \{\}, \(\) => \{\}\)/.test(around),
    "the refund swallows both outcomes again — a refund that never happened " +
      "looks exactly like one that did",
  );
  assert(
    /const \{ error: refundErr \}/.test(around),
    "the refund result is discarded again",
  );
  assert(
    /captureException\(refundErr/.test(around),
    "a failed refund is no longer reported, so a silently consumed snap is " +
      "invisible to everyone including the person who paid for it",
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
  const fail = PAYOUT.slice(PAYOUT.indexOf("} catch (err) {", PAYOUT.indexOf("async function fireTransfer")));
  assert(
    /status: "failed"/.test(fail.slice(0, 600)),
    "a failed transfer no longer marks the payout failed, so the retry phase " +
      "cannot find it",
  );
  // And the commissions must NOT be released on failure.
  assert(
    !/status: "accrued"[\s\S]{0,200}payout_id: null/.test(fail.slice(0, 800)),
    "a failed transfer releases the commissions — that risks double-paying a " +
      "transfer that actually went through on a network blip",
  );
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
