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
  return { deps, fired };
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
