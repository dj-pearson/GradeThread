// US-2315: one throwing item must not abort a payout sweep.
//
// Both sweeps iterate a set of ids and call a Stripe-touching processor per
// item. Before this the calls were bare `await`s, so a network blip on ONE item
// aborted the whole sweep and left every item after it unprocessed for that
// run — on the two jobs that move money.
//
// The three sites in this story share a SHAPE but not a fix, which is why they
// were not swept into one helper:
//   • email-retry      — advances next_attempt_at (its ordering column)
//   • condition-alerts — advances last_matched_at (its ordering column)
//   • the payout sweeps — have NO per-item ordering column. Selection is by
//     status alone, so "stops being selected" is a terminal state, not a moved
//     timestamp. For the affiliate RETRY phase that terminal state already
//     exists (isPayoutRetryable's age cap); the CREATE phase has none, which is
//     why isolation matters more there.
//
// These are source assertions plus a behavioural model of the loop. The real
// sweeps reach Stripe and Supabase at module scope, so the loop shape is what
// is worth pinning — the defect was an ABSENT try/catch, so there is no wrong
// value to catch.

import { assert, assertEquals } from "@std/assert";

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));

Deno.test("US-2315: the consignor sweep isolates each sale", async () => {
  const src = await read("../lib/consignor-payout.ts");
  const loop = src.slice(src.indexOf("for (const saleId of saleIds)"));
  assert(loop.includes("try {"), "the per-sale body must be wrapped");
  assert(
    loop.includes("processSaleConsignorPayout(saleId"),
    "the wrapped call is the per-sale processor",
  );
  assert(
    loop.includes("summary.failed += 1;"),
    "a thrown sale counts as failed rather than vanishing",
  );
  assert(
    loop.includes("consignor-payout.sweep"),
    "the throw is reported, not swallowed",
  );
});

Deno.test("US-2315: both affiliate phases isolate each item", async () => {
  const src = await read("../lib/affiliate-payout.ts");
  for (
    const [call, route] of [
      ["retryAffiliatePayout(p.id, stripe)", "affiliate-payout.retry"],
      ["processAffiliatePayout(id, { stripe })", "affiliate-payout.create"],
    ] as const
  ) {
    const at = src.indexOf(call);
    assert(at > 0, `expected call site not found: ${call}`);
    // The 400 chars around the call must contain its own try/catch.
    const window = src.slice(Math.max(0, at - 400), at + 400);
    assert(window.includes("try {"), `${call}: not wrapped`);
    assert(
      window.includes(route),
      `${call}: throw is not reported as ${route}`,
    );
  }
});

Deno.test("US-2315: a thrown item is counted, so the run is not a silent success", async () => {
  // `failed` is one of cron-run-outcome.ts's FAILURE_KEYS (US-2312), and both
  // sweeps already return it — so a sweep that throws on every item now records
  // the cron run as an error instead of answering 200 with {ok:true}.
  const outcome = await read("../lib/cron-run-outcome.ts");
  assert(
    outcome.includes('"failed"'),
    "failed must remain a recognised failure key",
  );
  for (
    const p of ["../lib/affiliate-payout.ts", "../lib/consignor-payout.ts"]
  ) {
    const src = await read(p);
    assert(
      src.includes("failed: number"),
      `${p}: summary must carry a failed count`,
    );
  }
});

// A model of the loop, so the guarantee itself is asserted and not only its
// syntax. If someone rewrites the sweeps, this is the property to preserve.
Deno.test("US-2315: the isolation pattern processes every item past a throw", async () => {
  const processed: string[] = [];
  let failed = 0;
  const items = ["a", "poison", "b", "c"];
  const process = (id: string) => {
    if (id === "poison") throw new Error("stripe exploded");
    processed.push(id);
    return Promise.resolve();
  };

  for (const id of items) {
    try {
      await process(id);
    } catch {
      failed += 1;
    }
  }

  assertEquals(processed, ["a", "b", "c"], "items after the throw still ran");
  assertEquals(failed, 1);
});
