// US-782: included-grade CAS claim with bounded retries.
//
// grade-billing.ts imports the service-role supabase client at init; set dummy
// env BEFORE the dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { claimIncludedGrade } = await import("../lib/grade-billing.ts");
import type { IncludedClaimDeps } from "../lib/grade-billing.ts";

// A shared atomic counter modelling users.grades_used_this_month. casClaim is the
// optimistic CAS (succeeds only when the column still equals expectedDbUsed);
// reread returns the live value. Single-threaded JS makes each call atomic, so
// running claimers in sequence faithfully models the interleaving of a race.
function sharedCounter(start = 0) {
  const state = { counter: start };
  const deps: IncludedClaimDeps = {
    casClaim: (expectedDbUsed, rolledOver) => {
      if (state.counter === expectedDbUsed) {
        state.counter = (rolledOver ? 0 : expectedDbUsed) + 1;
        return Promise.resolve({ claimed: true });
      }
      return Promise.resolve({ claimed: false });
    },
    reread: () => Promise.resolve({ dbUsed: state.counter, rolledOver: false }),
  };
  return { state, deps };
}

// (a) A CAS miss followed by a successful retry → uses an included grade.
Deno.test("retry succeeds and claims an included grade after a CAS miss", async () => {
  const { state, deps } = sharedCounter(1); // a concurrent submit already took slot 0
  // This claimer read a STALE used=0, so its first CAS(0) misses (counter=1),
  // then it re-reads 1 and claims slot 1.
  const r = await claimIncludedGrade(0, false, 3, deps);
  assert(r.claimed);
  assertEquals(r.newUsed, 2);
  assertEquals(state.counter, 2);
});

// (b) Retries exhausted at the TRUE cap → not claimed (falls back to credits).
Deno.test("at the true cap, retries don't over-consume — claim fails", async () => {
  const { state, deps } = sharedCounter(2); // cap reached by concurrent submits
  const r = await claimIncludedGrade(0, false, 2, deps); // stale read of 0, cap=2
  assertEquals(r.claimed, false);
  assertEquals(r.newUsed, 2); // re-read found used==cap
  assertEquals(state.counter, 2); // untouched — no double-consume past the cap
});

// (c) A batch of concurrent submissions consumes EXACTLY the remaining included
// count — no double-consume, no under-consume.
Deno.test("concurrent batch consumes exactly the remaining included count", async () => {
  const cap = 3;
  const { state, deps } = sharedCounter(0);
  let claimedCount = 0;
  // 5 claimers all start from a stale used=0 read against the one shared counter.
  for (let i = 0; i < 5; i++) {
    const r = await claimIncludedGrade(0, false, cap, deps);
    if (r.claimed) claimedCount += 1;
  }
  assertEquals(claimedCount, 3); // exactly the cap
  assertEquals(state.counter, 3); // counter never exceeds the cap
});

// No livelock: even if CAS keeps missing (counter advancing but below cap), the
// loop is bounded by maxRetries and returns deterministically.
Deno.test("bounded retries — never livelocks on persistent CAS misses", async () => {
  let calls = 0;
  const deps: IncludedClaimDeps = {
    // Always miss.
    casClaim: () => {
      calls += 1;
      return Promise.resolve({ claimed: false });
    },
    // Re-read keeps returning a value below cap so the cap guard never short-
    // circuits — only the maxRetries bound stops the loop.
    reread: () => Promise.resolve({ dbUsed: 1, rolledOver: false }),
  };
  const r = await claimIncludedGrade(0, false, 10, deps, 3);
  assertEquals(r.claimed, false);
  // attempts: 0,1,2,3 → 4 casClaim calls (maxRetries=3 → maxRetries+1 attempts).
  assertEquals(calls, 4);
});

// Rollover: a stale pre-reset read still claims slot 0 of the new window.
Deno.test("rollover — claims the first slot of a freshly-reset window", async () => {
  // The DB column still holds the OLD non-zero value (reset not yet persisted),
  // but rolledOver=true means the logical used is 0. casClaim must CAS against
  // the old column value and set it to 1.
  const oldDbValue = 7;
  const state = { counter: oldDbValue };
  const deps: IncludedClaimDeps = {
    casClaim: (expectedDbUsed, rolledOver) => {
      if (state.counter === expectedDbUsed) {
        state.counter = (rolledOver ? 0 : expectedDbUsed) + 1;
        return Promise.resolve({ claimed: true });
      }
      return Promise.resolve({ claimed: false });
    },
    reread: () => Promise.resolve({ dbUsed: state.counter, rolledOver: false }),
  };
  const r = await claimIncludedGrade(oldDbValue, true, 3, deps);
  assert(r.claimed);
  assertEquals(r.newUsed, 1); // first included grade of the new month
  assertEquals(state.counter, 1);
});
