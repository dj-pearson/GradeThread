// US-1100: eBay sale → pseudonymous sold-to node + claim offer (Layer 4).
//
// recordEbaySale runs on the RLS-bypassing service-role client, so its tenant
// wall is resolveGarment's `.eq(user_id)` scoping (US-268). These tests drive it
// against an injected fake DB + resolver — no live database — and assert:
//   • tenant scoping: a wrong-owner item resolves to no garment → no writes.
//   • the sold-to node carries the SALTED HASH of the buyer (never raw PII).
//   • a 'sold' garment_event is appended (PII-free payload).
//   • a claim token (hash only) is minted → a claim offer URL is returned.
//   • idempotency: a re-synced sale (sold-to node already owns the garment) is
//     a no-op (no duplicate node/event/token).

import { assert, assertEquals } from "@std/assert";
import { minimizeLinkageRef } from "../lib/garment-passport.ts";
import { recordEbaySale, type SaleDb } from "../lib/passport-sale.ts";

// Env the salted hash uses (explicit so the digest is deterministic in CI).
Deno.env.set("PASSPORT_LINKAGE_SALT", "test-salt");
Deno.env.set("PUBLIC_SITE_URL", "https://gradethread.com");

interface Insert {
  table: string;
  row: Record<string, unknown>;
}

// A tiny fake matching the slice of the Supabase builder recordEbaySale uses:
// select/eq/in/maybeSingle (reads), insert(...).select().single(), update().eq().
function makeFakeDb(opts: {
  currentOwnerNodeId?: string | null;
  currentNodeLinkageHash?: string | null;
  priorTransferCount?: number;
}): { db: SaleDb; inserts: Insert[] } {
  const inserts: Insert[] = [];
  function builder(table: string) {
    let pendingInsert: Record<string, unknown> | null = null;
    // deno-lint-ignore no-explicit-any
    const q: any = {
      select: () => q,
      eq: () => q,
      in: () => q,
      insert: (row: Record<string, unknown>) => {
        pendingInsert = row;
        inserts.push({ table, row });
        return q;
      },
      update: () => q,
      single: () => Promise.resolve({ data: { id: `${table}-new-id` }, error: null }),
      maybeSingle: () => {
        if (table === "garments") {
          return Promise.resolve({
            data: { current_owner_node_id: opts.currentOwnerNodeId ?? null },
            error: null,
          });
        }
        if (table === "owner_nodes") {
          return Promise.resolve({
            data: { linkage_hash: opts.currentNodeLinkageHash ?? null },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // count head query for garment_events (and awaited inserts)
      then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        Promise.resolve({
          data: pendingInsert ? null : [],
          count: table === "garment_events" ? opts.priorTransferCount ?? 0 : 0,
          error: null,
        }).then(onF, onR),
    };
    return q;
  }
  return { db: { from: builder }, inserts };
}

const okResolver = (garmentId: string) => () =>
  Promise.resolve({ garmentId, slug: "slug-x" });

Deno.test("tenant scoping: a non-owned item (resolver → null) writes nothing", async () => {
  const { db, inserts } = makeFakeDb({});
  const out = await recordEbaySale(
    { inventoryItemId: "item-A", ownerId: "attacker-B", buyerIdentifier: "buyer1" },
    { db, resolveGarment: () => Promise.resolve(null) },
  );
  assertEquals(out, null);
  assertEquals(inserts.length, 0, "no node/event/token may be written for a non-owned item");
});

Deno.test("records a 'sold' event + salted-hash sold-to node + claim offer", async () => {
  const { db, inserts } = makeFakeDb({ priorTransferCount: 0 });
  const out = await recordEbaySale(
    { inventoryItemId: "item-A", ownerId: "owner-A", buyerIdentifier: "SomeBuyer", platform: "ebay" },
    { db, resolveGarment: okResolver("garment-1") },
  );
  assert(out, "expected a result");
  assertEquals(out!.garmentId, "garment-1");
  assert(out!.claimUrl && out!.claimUrl.startsWith("https://gradethread.com/claim/"));

  // The sold-to node stores the SALTED HASH, never the raw buyer identifier.
  const expectedHash = await minimizeLinkageRef("SomeBuyer", "test-salt");
  const nodeInsert = inserts.find((i) => i.table === "owner_nodes");
  assert(nodeInsert, "a sold-to node must be inserted");
  assertEquals(nodeInsert!.row.kind, "buyer");
  assertEquals(nodeInsert!.row.linkage_hash, expectedHash);
  assertEquals(nodeInsert!.row.pseudonymous_label, "Buyer B"); // seq 1 → chain "B"
  // No raw PII anywhere on the node row.
  assert(
    !JSON.stringify(nodeInsert!.row).toLowerCase().includes("somebuyer"),
    "raw buyer identifier must never be stored",
  );

  // A deterministic 'sold' event with a PII-free payload.
  const evInsert = inserts.find((i) => i.table === "garment_events");
  assert(evInsert, "a 'sold' event must be appended");
  assertEquals(evInsert!.row.event_type, "sold");
  assertEquals(evInsert!.row.confidence, "deterministic");
  assertEquals((evInsert!.row.payload as { platform: string }).platform, "ebay");

  // A claim token (hash only — never the raw token) is minted.
  const tokInsert = inserts.find((i) => i.table === "passport_claim_tokens");
  assert(tokInsert, "a claim token must be minted");
  assert(typeof tokInsert!.row.token_hash === "string" && (tokInsert!.row.token_hash as string).length === 64);
  assertEquals(tokInsert!.row.created_by, "owner-A");
  assert(!("token" in tokInsert!.row), "the raw token must never be stored");
});

Deno.test("a missing buyer identifier yields a null linkage hash (no PII fabricated)", async () => {
  const { db, inserts } = makeFakeDb({ priorTransferCount: 2 });
  const out = await recordEbaySale(
    { inventoryItemId: "item-A", ownerId: "owner-A", buyerIdentifier: null },
    { db, resolveGarment: okResolver("garment-1") },
  );
  assert(out);
  const nodeInsert = inserts.find((i) => i.table === "owner_nodes");
  assertEquals(nodeInsert!.row.linkage_hash, null);
  assertEquals(nodeInsert!.row.pseudonymous_label, "Buyer D"); // seq = 2 prior + 1 → "D"
});

Deno.test("idempotency: re-synced sale (sold-to node already owns garment) is a no-op", async () => {
  const buyerHash = await minimizeLinkageRef("SomeBuyer", "test-salt");
  const { db, inserts } = makeFakeDb({
    currentOwnerNodeId: "node-existing",
    currentNodeLinkageHash: buyerHash,
  });
  const out = await recordEbaySale(
    { inventoryItemId: "item-A", ownerId: "owner-A", buyerIdentifier: "SomeBuyer" },
    { db, resolveGarment: okResolver("garment-1") },
  );
  assert(out);
  assertEquals(out!.soldToNodeId, "node-existing");
  assertEquals(inserts.length, 0, "a re-synced sale must not write a second node/event/token");
});
