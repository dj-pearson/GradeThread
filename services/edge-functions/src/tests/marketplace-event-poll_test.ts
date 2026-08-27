// US-1055: marketplace-event poll — idempotency (dedup) + per-source isolation.
//
// The poll re-reads the SAME open offers/returns/disputes each tick, so it must
// notify each exactly once. We inject a Set-backed `claim` that models the DB's
// unique constraint (first claim wins, repeats are duplicates) plus fake
// fetchers, and prove a second poll of identical data fires zero new
// notifications.
//
// The lib pulls in the service-role supabase client at init via its real deps,
// so set dummy env BEFORE the dynamic import (per the LEARNINGS playbook).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { pollMarketplaceEventsForUser } = await import("../lib/marketplace-event-poll.ts");
import type { MarketplacePollDeps } from "../lib/marketplace-event-poll.ts";

// A claim backed by an in-memory Set: returns true the first time a key is seen
// (insert succeeds) and false thereafter (unique-violation) — exactly the DB
// semantics, so re-polling identical data dedups.
function makeDeps(over: Partial<MarketplacePollDeps> = {}) {
  const seen = new Set<string>();
  const fired = { offer: 0, return: 0, dispute: 0, cancellation: 0, inquiry: 0, case: 0 };
  const deps: MarketplacePollDeps = {
    fetchOffers: () =>
      Promise.resolve([
        {
          bestOfferId: "o1",
          itemId: "i1",
          itemTitle: "Tee",
          buyerUsername: "b",
          price: 10,
          currency: "USD",
          quantity: 1,
          status: "Active",
          message: null,
          expiresAt: null,
        },
      ]),
    fetchReturns: () =>
      Promise.resolve([
        {
          returnId: "r1",
          state: "RETURN_REQUESTED",
          orderId: "ord1",
          itemId: "i1",
          reason: "X",
          creationDate: null,
          respondBy: "2026-09-03T00:00:00.000Z",
          buyerUsername: "b",
        },
      ]),
    fetchDisputes: () =>
      Promise.resolve([
        {
          paymentDisputeId: "d1",
          orderId: "ord1",
          status: "OPEN",
          reason: "ITEM_NOT_RECEIVED",
          amount: 50,
          currency: "USD",
          openedDate: null,
          respondByDate: "2026-07-01",
          buyerUsername: "b",
        },
      ]),
    // US-2560: a buyer-requested cancellation in an OPEN state — the case that
    // notified nobody, because no poll source read searchCancellations().
    fetchCancellations: () =>
      Promise.resolve([
        {
          cancelId: "c1",
          state: "CANCEL_REQUESTED",
          orderId: "ord1",
          reason: "BUYER_CANCEL_ORDER",
          requestorType: "BUYER",
          creationDate: null,
        },
      ]),
    // US-2928: an open INR inquiry, so the default fixture exercises the source
    // that used to be missing rather than only the four that existed.
    fetchInquiries: () =>
      Promise.resolve([
        {
          inquiryId: "q1",
          state: "INQUIRY_OPEN",
          orderId: "ord1",
          itemId: "i1",
          reason: "ITEM_NOT_RECEIVED",
          buyerUsername: "b",
          respondBy: "2026-09-01T00:00:00.000Z",
          creationDate: null,
        },
      ]),
    // US-2929: an open escalated case, so the defect-bearing source is in the
    // default fixture too.
    fetchCases: () =>
      Promise.resolve([
        {
          caseId: "k1",
          state: "CS_OPEN",
          orderId: "ord1",
          itemId: "i1",
          reason: "ITEM_NOT_AS_DESCRIBED",
          buyerUsername: "b",
          respondBy: "2026-09-02T00:00:00.000Z",
          creationDate: null,
          escalatedFrom: "r1",
          amountCents: 2500,
          currency: "USD",
        },
      ]),
    claim: (userId, kind, externalId, status) => {
      const key = `${userId}|${kind}|${externalId}|${status}`;
      if (seen.has(key)) return Promise.resolve(false);
      seen.add(key);
      return Promise.resolve(true);
    },
    // The DELETE half of the same table. Modelling it here matters: without a
    // release the Set only grows, so a test could never tell "the claim was
    // handed back" from "the claim was never taken".
    release: (userId, kind, externalId, status) => {
      seen.delete(`${userId}|${kind}|${externalId}|${status}`);
      return Promise.resolve();
    },
    notifyOffer: () => {
      fired.offer++;
      return Promise.resolve();
    },
    notifyReturn: () => {
      fired.return++;
      return Promise.resolve();
    },
    notifyDispute: () => {
      fired.dispute++;
      return Promise.resolve();
    },
    notifyCancellation: () => {
      fired.cancellation++;
      return Promise.resolve();
    },
    notifyInquiry: () => {
      fired.inquiry++;
      return Promise.resolve();
    },
    notifyCase: () => {
      fired.case++;
      return Promise.resolve();
    },
    ...over,
  };
  return { deps, fired, seen };
}

Deno.test("first poll notifies once per source", async () => {
  const { deps, fired } = makeDeps();
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r, { offers: 1, returns: 1, disputes: 1, cancellations: 1, inquiries: 1, cases: 1, reminders: 0, linked: 0, snadSignals: 0, digests: 0, errors: [] });
  assertEquals(fired, { offer: 1, return: 1, dispute: 1, cancellation: 1, inquiry: 1, case: 1 });
});

Deno.test("re-polling identical data fires NO new notifications (idempotent)", async () => {
  const { deps, fired } = makeDeps();
  await pollMarketplaceEventsForUser("u1", deps);
  const r2 = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r2, { offers: 0, returns: 0, disputes: 0, cancellations: 0, inquiries: 0, cases: 0, reminders: 0, linked: 0, snadSignals: 0, digests: 0, errors: [] });
  // Still only one of each across BOTH polls.
  assertEquals(fired, { offer: 1, return: 1, dispute: 1, cancellation: 1, inquiry: 1, case: 1 });
});

Deno.test("a CLOSED dispute is not notified", async () => {
  const { deps, fired } = makeDeps({
    fetchDisputes: () =>
      Promise.resolve([
        {
          paymentDisputeId: "d2",
          orderId: "ord2",
          status: "CLOSED",
          reason: "ITEM_NOT_RECEIVED",
          amount: 50,
          currency: "USD",
          openedDate: null,
          respondByDate: null,
          buyerUsername: null,
        },
      ]),
  });
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r.disputes, 0);
  assertEquals(fired.dispute, 0);
});

Deno.test("one source throwing does not block the others", async () => {
  const { deps, fired } = makeDeps({
    fetchReturns: () => Promise.reject(new Error("token expired")),
  });
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r.offers, 1);
  assertEquals(r.disputes, 1);
  assertEquals(r.returns, 0);
  assert(r.errors.some((e) => e.startsWith("returns:")));
  assertEquals(fired, { offer: 1, return: 0, dispute: 1, cancellation: 1, inquiry: 1, case: 1 });
});

// ── US-2319 AC3: claim → work → RELEASE ON FAILURE ─────────────────────────
//
// The claim's job is to stop two runs notifying the same offer at once. It was
// also stopping the same run from ever retrying: the row went in BEFORE the
// notification was sent, so a send that threw left the claim standing, and the
// next poll read 23505 as "already notified".
//
// What that costs is specific. A best offer expires in 48 hours, so an offer
// the seller was never told about expires unanswered — and nothing reports it.
// The poll returns a clean result and the claim row is indistinguishable from
// one written by a notification that worked.

Deno.test("US-2319: a failed offer notification releases its claim", async () => {
  let attempts = 0;
  const { deps, seen } = makeDeps({
    notifyOffer: () => {
      attempts++;
      return Promise.reject(new Error("smtp down"));
    },
  });

  const r1 = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r1.offers, 0, "a failed send must not be counted as notified");
  assert(
    r1.errors.some((e) => e.includes("offer o1")),
    "the failure is reported per event, not swallowed",
  );
  // The claim is GONE, which is the whole fix.
  assert(
    !seen.has("u1|offer|o1|received"),
    "the claim survived a failed send — the next poll will skip this offer forever",
  );

  // And the next poll actually retries it.
  const r2 = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(attempts, 2, "the second poll did not retry the failed offer");
  assertEquals(r2.offers, 0);
});

Deno.test("US-2319: the retry succeeds and then stops retrying", async () => {
  // The point of releasing is a LATER success, not an endless loop. Once the
  // send works the claim stays and the event goes quiet.
  let attempts = 0;
  const { deps } = makeDeps({
    notifyOffer: () => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error("transient"))
        : Promise.resolve();
    },
  });

  await pollMarketplaceEventsForUser("u1", deps);
  const r2 = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r2.offers, 1, "the retry did not deliver");

  const r3 = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r3.offers, 0, "a delivered offer notified twice");
  assertEquals(attempts, 2, "the poll kept re-sending after a success");
});

Deno.test("US-2319: one failing event does not abort the rest of its batch", async () => {
  // Second live defect in the same lines. The notify call sat directly in the
  // for-loop with only a per-SOURCE try/catch around it, so a throw unwound
  // past every remaining offer. Those were never claimed and never notified on
  // that pass — one bad event silently shortened the batch.
  const offers = ["o1", "o2", "o3"].map((id) => ({
    bestOfferId: id,
    itemId: "i1",
    itemTitle: "Tee",
    buyerUsername: "b",
    price: 10,
    currency: "USD",
    quantity: 1,
    status: "Active",
    message: null,
    expiresAt: null,
  }));
  const { deps } = makeDeps({
    fetchOffers: () => Promise.resolve(offers),
    notifyOffer: (ev) =>
      ev.bestOfferId === "o2"
        ? Promise.reject(new Error("one bad egg"))
        : Promise.resolve(),
  });

  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r.offers, 2, "the offers after the failing one were dropped");
  assertEquals(r.errors.length, 1);
  assert(r.errors[0]!.includes("offer o2"));
});

Deno.test("US-2319: releasing is optional, and its absence is the OLD behaviour", async () => {
  // The seam defaults safe. A fake without `release` must not crash the poll —
  // it just does not retry, which is exactly where this started.
  const { deps } = makeDeps({
    release: undefined,
    notifyOffer: () => Promise.reject(new Error("smtp down")),
  });
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r.offers, 0);
  assert(r.errors.some((e) => e.includes("offer o1")));
});

// ── US-2560: the cancellation source ───────────────────────────────────────
//
// searchCancellations() existed and no poll source called it, so a buyer asking
// to cancel notified nobody. These pin the three decisions that made adding the
// source non-obvious: the dedupe (the AC's own requirement), the state filter
// agreeing with what the Post-sale page calls open, and the requestor check.

Deno.test("US-2560: re-polling the same cancellation fires no second notification", async () => {
  const { deps, fired } = makeDeps();
  const r1 = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r1.cancellations, 1);

  const r2 = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r2.cancellations, 0, "the same cancellation notified twice");
  assertEquals(fired.cancellation, 1, "the emitter ran again across two polls");

  // A third, because a dedupe that only holds for one repeat is not a dedupe.
  await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(fired.cancellation, 1);
});

Deno.test("US-2560: a CLOSED cancellation is not notified", async () => {
  // CANCEL_CLOSED contains the terminal marker CLOSED. The check has to match
  // the STATE, not the word "cancel" — every one of these states contains that.
  const { deps, fired } = makeDeps({
    fetchCancellations: () =>
      Promise.resolve([
        {
          cancelId: "c2",
          state: "CANCEL_CLOSED",
          orderId: "ord2",
          reason: "BUYER_CANCEL_ORDER",
          requestorType: "BUYER",
          creationDate: null,
        },
      ]),
  });
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r.cancellations, 0);
  assertEquals(fired.cancellation, 0);
});

Deno.test("US-2560: a SELLER-initiated cancellation does not notify the seller", async () => {
  // Otherwise every Approve pressed on the Post-sale page mails the seller to
  // tell them what they just did.
  const { deps, fired } = makeDeps({
    fetchCancellations: () =>
      Promise.resolve([
        {
          cancelId: "c3",
          state: "CANCEL_REQUESTED",
          orderId: "ord3",
          reason: "OUT_OF_STOCK_OR_CANNOT_FULFILL",
          requestorType: "SELLER",
          creationDate: null,
        },
      ]),
  });
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r.cancellations, 0);
  assertEquals(fired.cancellation, 0);
});

Deno.test("US-2560: an UNKNOWN requestor still notifies", async () => {
  // Same asymmetry as the state rule. A missed cancellation costs the seller an
  // order they never got to decide about; a spurious one costs a glance.
  const { deps } = makeDeps({
    fetchCancellations: () =>
      Promise.resolve([
        {
          cancelId: "c4",
          state: "CANCEL_REQUESTED",
          orderId: "ord4",
          reason: null,
          requestorType: null,
          creationDate: null,
        },
      ]),
  });
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r.cancellations, 1);
});

Deno.test("US-2560: a failed cancellation notification releases its claim", async () => {
  let attempts = 0;
  const { deps, seen } = makeDeps({
    notifyCancellation: () => {
      attempts++;
      return Promise.reject(new Error("smtp down"));
    },
  });

  const r1 = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r1.cancellations, 0);
  assert(r1.errors.some((e) => e.includes("cancellation c1")));
  assert(
    !seen.has("u1|cancellation|c1|requested"),
    "the claim survived a failed send — this cancellation is never retried",
  );

  await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(attempts, 2, "the second poll did not retry the failed cancellation");
});

Deno.test("US-2560: the cancellation source is isolated like the other three", async () => {
  const { deps, fired } = makeDeps({
    fetchCancellations: () => Promise.reject(new Error("token expired")),
  });
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r.offers, 1);
  assertEquals(r.returns, 1);
  assertEquals(r.disputes, 1);
  assertEquals(r.cancellations, 0);
  assert(r.errors.some((e) => e.startsWith("cancellations:")));
  assertEquals(fired.cancellation, 0);
});

Deno.test("US-2560: an omitted cancellation fetcher is a no-op, not a crash", async () => {
  // The seam defaults safe, same as `release`. Every fake written before this
  // story omits both new deps and must keep working.
  const { deps } = makeDeps({ fetchCancellations: undefined });
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r.cancellations, 0);
  assertEquals(r.errors.filter((e) => e.startsWith("cancellations:")).length, 0);
});

// ── US-2927: the poll is also the writer ────────────────────────────

Deno.test("the poll records every fetched case, and records AGAIN on a re-poll", async () => {
  // The distinction that matters: notification is once-per-case (the claim
  // dedupes it) but RECORDING is once-per-poll. If recording lived inside the
  // notify loop it would sit behind the claim's `continue`, so a case would be
  // stored on the tick it opened and never updated again — its state frozen at
  // "requested" forever while eBay moved it on.
  const recorded: Array<{ ownerId: string; types: string[] }> = [];
  const { deps, fired } = makeDeps({
    record: (ownerId, inputs) => {
      recorded.push({ ownerId, types: inputs.map((i) => i.caseType) });
      return Promise.resolve(inputs.length);
    },
  });

  await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(recorded.length, 5, "each source records exactly once per poll");
  assertEquals(recorded.map((r) => r.types.join(",")), [
    "return",
    "cancellation",
    "inquiry",
    "case",
    "payment_dispute",
  ]);
  assert(recorded.every((r) => r.ownerId === "u1"));

  await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(recorded.length, 10, "a second poll records again even though it notifies nothing");
  assertEquals(fired, { offer: 1, return: 1, dispute: 1, cancellation: 1, inquiry: 1, case: 1 });
});

Deno.test("a SELLER-initiated cancellation is still recorded, only not notified", async () => {
  // The notify path skips it (the seller does not need telling what they just
  // did) but it is a real case with a real outcome, so the record must have it
  // or the analytics undercount cancellations by every one the seller started.
  const recorded: string[] = [];
  const { deps, fired } = makeDeps({
    fetchCancellations: () =>
      Promise.resolve([
        {
          cancelId: "c-seller",
          state: "CANCEL_REQUESTED",
          orderId: "ord9",
          reason: "OUT_OF_STOCK",
          requestorType: "SELLER",
          creationDate: null,
        },
      ]),
    record: (_ownerId, inputs) => {
      for (const i of inputs) recorded.push(`${i.caseType}:${i.externalId}`);
      return Promise.resolve(inputs.length);
    },
  });
  await pollMarketplaceEventsForUser("u1", deps);
  assert(recorded.includes("cancellation:c-seller"));
  assertEquals(fired.cancellation, 0);
});
