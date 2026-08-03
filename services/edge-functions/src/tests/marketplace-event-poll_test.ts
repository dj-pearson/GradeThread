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
  const fired = { offer: 0, return: 0, dispute: 0 };
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
        { returnId: "r1", state: "RETURN_REQUESTED", orderId: "ord1", itemId: "i1", reason: "X", creationDate: null },
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
    ...over,
  };
  return { deps, fired, seen };
}

Deno.test("first poll notifies once per source", async () => {
  const { deps, fired } = makeDeps();
  const r = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r, { offers: 1, returns: 1, disputes: 1, errors: [] });
  assertEquals(fired, { offer: 1, return: 1, dispute: 1 });
});

Deno.test("re-polling identical data fires NO new notifications (idempotent)", async () => {
  const { deps, fired } = makeDeps();
  await pollMarketplaceEventsForUser("u1", deps);
  const r2 = await pollMarketplaceEventsForUser("u1", deps);
  assertEquals(r2, { offers: 0, returns: 0, disputes: 0, errors: [] });
  // Still only one of each across BOTH polls.
  assertEquals(fired, { offer: 1, return: 1, dispute: 1 });
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
  assertEquals(fired, { offer: 1, return: 0, dispute: 1 });
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
