// US-2345 AC1: the third money path — the included-grade claim.
//
// `runPaymentPrecedence` is THE charging chokepoint. The web flow, the FlipDesk
// bulk bridge, the batch worker and the public API all charge through it, so a
// bug here is a bug in every way the product takes money. It had no test file.
//
// What is testable without a database is the part that is actually subtle:
// `claimIncludedGrade`, the optimistic compare-and-swap on
// `users.grades_used_this_month`. It is already pure and injectable — US-782
// wrote it that way — so every branch of the race is reachable here.
//
// WHY THE RACE MATTERS, in money terms. Before US-782 the loser of a CAS fell
// straight through to credits or checkout. With a cap of 3 and two concurrent
// submissions: the winner claims 0→1, the loser had read 0, its CAS misses, and
// it PAYS — while two included grades sat unused. The user is charged for
// something they had already bought. That is the failure these cases pin, and it
// is invisible in production because the seller sees a normal charge.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { claimIncludedGrade, type IncludedClaimDeps } from "../lib/grade-billing.ts";
import { resolveIncludedCap } from "../lib/grade-pricing.ts";

/**
 * A fake counter that behaves like the column: the CAS succeeds only while the
 * caller's expectation still matches, and any other writer moves it underneath.
 */
function counter(start: number, opts: { rolledOver?: boolean } = {}) {
  const state = { used: start, rolledOver: opts.rolledOver ?? false };
  const calls = { cas: 0, reread: 0 };
  const deps: IncludedClaimDeps = {
    casClaim: (expectedDbUsed, rolledOver) => {
      calls.cas++;
      if (state.used !== expectedDbUsed) return Promise.resolve({ claimed: false });
      state.used = (rolledOver ? 0 : expectedDbUsed) + 1;
      state.rolledOver = false;
      return Promise.resolve({ claimed: true });
    },
    reread: () => {
      calls.reread++;
      return Promise.resolve({ dbUsed: state.used, rolledOver: state.rolledOver });
    },
  };
  return { state, calls, deps };
}

// ── The happy path ─────────────────────────────────────────────────────────

Deno.test("US-782: an uncontended claim takes the next included grade", async () => {
  const c = counter(0);
  const out = await claimIncludedGrade(0, false, 3, c.deps);
  assertEquals(out, { claimed: true, newUsed: 1 });
  assertEquals(c.state.used, 1);
  assertEquals(c.calls.cas, 1, "an uncontended claim should not retry");
  assertEquals(c.calls.reread, 0, "nothing to re-read when the first CAS wins");
});

Deno.test("US-782: the cap is a hard stop, checked BEFORE the CAS", async () => {
  // Checked first on purpose: attempting the write and letting the database
  // refuse it would burn a round-trip per over-cap submission, and every free
  // user hits this on their fourth grade of the month.
  const c = counter(3);
  const out = await claimIncludedGrade(3, false, 3, c.deps);
  assertEquals(out, { claimed: false, newUsed: 3 });
  assertEquals(c.calls.cas, 0, "a capped user still attempted the write");
});

Deno.test("US-782: a cap of zero never claims", async () => {
  // Free plans have configured zero before. A cap of 0 must not be read as
  // "unlimited" or as "one free one" by an off-by-one.
  const c = counter(0);
  const out = await claimIncludedGrade(0, false, 0, c.deps);
  assertEquals(out, { claimed: false, newUsed: 0 });
  assertEquals(c.calls.cas, 0);
});

// ── The race this function exists for ──────────────────────────────────────

Deno.test("US-782: the LOSER of a race still claims, instead of paying", async () => {
  // THE WHOLE POINT. Both submissions read used=0. The winner claims 0→1. The
  // loser's CAS misses, it re-reads 1, and claims 1→2 — because the cap is 3 and
  // two included grades were genuinely left. Before US-782 the loser fell
  // through to credits and the user was charged for a grade they owned.
  const c = counter(0);
  await claimIncludedGrade(0, false, 3, c.deps); // the winner
  const loser = await claimIncludedGrade(0, false, 3, c.deps); // stale read of 0
  assertEquals(loser, { claimed: true, newUsed: 2 });
  assertEquals(c.state.used, 2);
  assert(c.calls.reread >= 1, "the loser never re-read, so it cannot have retried");
});

Deno.test("US-782: a loser at the cap gives up rather than over-claiming", async () => {
  // The retry must not be able to exceed the cap. Two concurrent submissions on
  // a cap of 1: the winner takes it, the loser re-reads 1, sees 1 >= 1 and
  // stops. Over-claiming here hands out free grades nobody paid for, which is
  // the same bug in the opposite direction.
  const c = counter(0);
  await claimIncludedGrade(0, false, 1, c.deps);
  const loser = await claimIncludedGrade(0, false, 1, c.deps);
  assertEquals(loser, { claimed: false, newUsed: 1 });
  assertEquals(c.state.used, 1, "the counter went past the cap");
});

Deno.test("US-782: retries are BOUNDED — a counter that keeps moving gives up", async () => {
  // Livelock is the risk a naive retry loop introduces. Under permanent
  // contention this must return, not spin: the caller is holding an HTTP request
  // open, and a hung charge is worse than a charge that falls through to credits.
  let casCalls = 0;
  const deps: IncludedClaimDeps = {
    // Always misses: something else moves the counter between every read.
    casClaim: () => {
      casCalls++;
      return Promise.resolve({ claimed: false });
    },
    // And always re-reads a value below the cap, so the cap guard never stops it.
    reread: () => Promise.resolve({ dbUsed: 0, rolledOver: false }),
  };
  const out = await claimIncludedGrade(0, false, 3, deps, 3);
  assertEquals(out, { claimed: false, newUsed: 0 });
  assertEquals(casCalls, 4, "expected the initial attempt plus exactly 3 retries");
});

Deno.test("US-782: maxRetries 0 attempts exactly once", async () => {
  let casCalls = 0;
  const deps: IncludedClaimDeps = {
    casClaim: () => {
      casCalls++;
      return Promise.resolve({ claimed: false });
    },
    reread: () => Promise.resolve({ dbUsed: 0, rolledOver: false }),
  };
  const out = await claimIncludedGrade(0, false, 3, deps, 0);
  assertEquals(out.claimed, false);
  assertEquals(casCalls, 1);
});

Deno.test("US-782: a dropped re-read falls back to paying, not to claiming", async () => {
  // reread() returning null means the row could not be read. The safe direction
  // is to NOT claim: charging a user who had an included grade left is a refund;
  // granting one that was not there is revenue that never existed and a counter
  // that disagrees with the ledger.
  let casCalls = 0;
  const deps: IncludedClaimDeps = {
    casClaim: () => {
      casCalls++;
      return Promise.resolve({ claimed: false });
    },
    reread: () => Promise.resolve(null),
  };
  const out = await claimIncludedGrade(0, false, 3, deps);
  assertEquals(out, { claimed: false, newUsed: 0 });
  assertEquals(casCalls, 1, "it kept retrying after a failed re-read");
});

// ── Rollover ───────────────────────────────────────────────────────────────

Deno.test("US-782: a rolled-over period claims from zero, not from the stale column", async () => {
  // Free users have no invoice, so nothing resets their counter on a cycle —
  // the clock check is the only thing that does. A rolled-over user sitting at
  // used=3 on a cap of 3 must get their first grade of the new month, and the
  // column must land on 1 rather than 4.
  const c = counter(3, { rolledOver: true });
  const out = await claimIncludedGrade(3, true, 3, c.deps);
  assertEquals(out, { claimed: true, newUsed: 1 });
  assertEquals(c.state.used, 1, "the rollover added to the stale count instead of resetting");
});

Deno.test("US-782: rollover discovered on RE-READ is honoured", async () => {
  // The boundary can pass between the first read and the retry. If the retry
  // ignored the fresh rolledOver flag it would compare against the OLD count —
  // here 3 against a cap of 3 — and refuse a grade the user is now owed.
  let first = true;
  const deps: IncludedClaimDeps = {
    casClaim: (expected, rolledOver) => {
      if (first) {
        first = false;
        assertEquals(expected, 1);
        return Promise.resolve({ claimed: false });
      }
      // Second attempt: must arrive with rolledOver=true and the fresh count.
      assertEquals(rolledOver, true, "the retry lost the rollover flag");
      assertEquals(expected, 3);
      return Promise.resolve({ claimed: true });
    },
    reread: () => Promise.resolve({ dbUsed: 3, rolledOver: true }),
  };
  // Starts BELOW the cap so the first CAS actually runs — see the next test for
  // why that setup detail is load-bearing rather than incidental.
  const out = await claimIncludedGrade(1, false, 3, deps);
  assertEquals(out, { claimed: true, newUsed: 1 });
});

Deno.test("US-782: a STALE not-rolled-over read at the cap refuses without retrying", async () => {
  // Found by writing the previous test wrong, and worth keeping as a statement
  // of real behaviour rather than deleting.
  //
  // The cap check runs BEFORE the CAS. So a caller that arrives with
  // rolledOver=false and a count already at the cap returns immediately — it
  // never attempts a write, never re-reads, and therefore never DISCOVERS that
  // the period has since rolled over. The user is refused an included grade they
  // are owed and falls through to credits or checkout.
  //
  // That is not a live bug: `runPaymentPrecedence` computes rolledOver from
  // `grade_reset_at` in the same read that produced the count, and gates entry
  // on `includedUsed < includedCap`, so reaching here at all means the clock
  // said the period had not rolled. The window is between that read and this
  // call. It is pinned because the ordering is what makes it true — moving the
  // cap check after the first CAS would change this behaviour silently, and the
  // symptom (a seller charged in the first seconds of their new month) is one
  // nobody would ever reproduce.
  const c = counter(3);
  const out = await claimIncludedGrade(3, false, 3, c.deps);
  assertEquals(out, { claimed: false, newUsed: 3 });
  assertEquals(c.calls.cas, 0);
  assertEquals(c.calls.reread, 0);
});

// ── The per-period cap snapshot (US-885) ───────────────────────────────────

Deno.test("US-885: an admin cap edit never applies retroactively mid-period", () => {
  // The snapshot governs WITHIN a period. A seller who started the month on a
  // cap of 3 keeps 3 even if an operator lowers the plan to 1 today — otherwise
  // a pricing edit retroactively bills grades the seller was told were included.
  assertEquals(resolveIncludedCap(3, 1, false), 3);
  // And it cannot silently RAISE mid-period either.
  assertEquals(resolveIncludedCap(1, 10, false), 1);
});

Deno.test("US-885: the live cap takes over at the reset boundary", () => {
  assertEquals(resolveIncludedCap(3, 10, true), 10);
  assertEquals(resolveIncludedCap(3, 1, true), 1);
});

Deno.test("US-885: no snapshot falls back to the live cap, including zero", () => {
  assertEquals(resolveIncludedCap(null, 3, false), 3);
  assertEquals(resolveIncludedCap(undefined, 3, false), 3);
  // A snapshot of 0 is a REAL snapshot and must not be read as absent — `??`
  // rather than `||` is what makes that true, and it is a one-character bug.
  assertEquals(resolveIncludedCap(0, 3, false), 0);
});
