// PS-05: the partial-refund route's ownership check on a multi-item order.
//
// It used `.maybeSingle()` on platform_order_id, and a two-item eBay order has
// two sales rows, so the check errored and the route answered 500. These pin
// that two rows sharing an order id pass as owned, a foreign order still reads
// as not found, and the connection comes from whichever row names one.
import { assert, assertEquals } from "@std/assert";
import { fakeOutcomeDb } from "./_fake-outcome-db.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { resolveOrderOwnership, saleConnectionId } = await import("../lib/order-refund-owner.ts");

const OWNER = "owner-1";

function world() {
  return fakeOutcomeDb({
    sales: [
      { id: "s1", user_id: OWNER, platform_order_id: "O-MULTI", listings: null },
      { id: "s2", user_id: OWNER, platform_order_id: "O-MULTI", listings: { marketplace_connection_id: "conn-2" } },
      { id: "s9", user_id: "someone-else", platform_order_id: "O-FOREIGN", listings: null },
    ],
  });
}

Deno.test("two sales rows sharing an order id are owned, not an error", async () => {
  const w = world();
  const r = await resolveOrderOwnership(OWNER, "O-MULTI", w.db);
  assert(r.ok);
  assert(r.owned);
  if (r.ok && r.owned) {
    assertEquals(r.lineCount, 2);
    assertEquals(r.connectionId, "conn-2");
  }
});

Deno.test("another tenant's order reads as not owned", async () => {
  const w = world();
  const r = await resolveOrderOwnership(OWNER, "O-FOREIGN", w.db);
  assertEquals(r, { ok: true, owned: false });
  const read = w.calls.find((c) => c.table === "sales")!;
  assertEquals(read.eq.user_id, OWNER);
});

Deno.test("saleConnectionId reads the embed as an object or an array", () => {
  assertEquals(saleConnectionId({ listings: { marketplace_connection_id: "a" } }), "a");
  assertEquals(saleConnectionId({ listings: [{ marketplace_connection_id: "b" }] }), "b");
  assertEquals(saleConnectionId({ listings: null }), undefined);
});
