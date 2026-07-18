// US-1999 — the published SKU is identity and must survive an item.sku edit.
//
// The bug these tests pin: the eBay Inventory SKU was derived at three call
// sites from inventory_items.sku, which the seller can freely edit. After a
// rename, a revise addressed a key eBay had never seen — createOrReplace-
// InventoryItem quietly created a NEW orphan inventory item while the
// offer-id-keyed calls still hit the live offer. Nothing errored.

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  deriveInventorySku,
  resolveInventorySku,
} from "../lib/ebay-sku.ts";

const ITEM_ID = "0f3a1c2d-4e5f-6789-abcd-ef0123456789";

Deno.test("deriveInventorySku prefers the seller's own item number", () => {
  assertEquals(deriveInventorySku({ id: ITEM_ID, sku: "VTG-501-32" }), "VTG-501-32");
  assertEquals(deriveInventorySku({ id: ITEM_ID, sku: "  VTG-501-32  " }), "VTG-501-32");
});

Deno.test("deriveInventorySku falls back to a stable id-derived key", () => {
  // Must match the 00477 backfill's SQL: 'FD-' || left(i.id::text, 8).
  assertEquals(deriveInventorySku({ id: ITEM_ID, sku: null }), "FD-0f3a1c2d");
  assertEquals(deriveInventorySku({ id: ITEM_ID, sku: "" }), "FD-0f3a1c2d");
  assertEquals(deriveInventorySku({ id: ITEM_ID, sku: "   " }), "FD-0f3a1c2d");
  // Stable across calls — a fresh derive of the same item can never drift.
  assertEquals(
    deriveInventorySku({ id: ITEM_ID, sku: null }),
    deriveInventorySku({ id: ITEM_ID, sku: null }),
  );
});

Deno.test(
  "AC4: editing item.sku does NOT change what a later revise addresses",
  () => {
    // 1. Publish: item has SKU 'VTG-501-32'; that is what eBay now holds.
    const item = { id: ITEM_ID, sku: "VTG-501-32" };
    const publishedSku = deriveInventorySku(item);
    const listing = { inventory_sku: publishedSku };

    // 2. Seller renames the SKU in the item canvas.
    const renamed = { id: ITEM_ID, sku: "SHELF-B-014" };

    // 3. Every later Inventory call still addresses the PUBLISHED key.
    assertEquals(resolveInventorySku(listing, renamed), "VTG-501-32");

    // And explicitly: it does NOT follow the rename — the old behaviour.
    assertNotEquals(resolveInventorySku(listing, renamed), "SHELF-B-014");
    assertEquals(deriveInventorySku(renamed), "SHELF-B-014"); // the old bug's value
  },
);

Deno.test(
  "AC4 (reverse): an item published under the FD- fallback keeps it after a SKU is typed in",
  () => {
    // Published with no SKU → went live as FD-0f3a1c2d.
    const listing = { inventory_sku: deriveInventorySku({ id: ITEM_ID, sku: null }) };
    // Seller later fills in a real item number.
    assertEquals(
      resolveInventorySku(listing, { id: ITEM_ID, sku: "NOW-HAS-ONE" }),
      "FD-0f3a1c2d",
    );
  },
);

Deno.test("pre-00477 rows (no stored SKU) fall back to the derivation", () => {
  // Backfill covers published rows, but a draft — or a row the backfill skipped
  // — must still resolve to something publishable rather than throwing.
  assertEquals(
    resolveInventorySku({ inventory_sku: null }, { id: ITEM_ID, sku: "VTG-501-32" }),
    "VTG-501-32",
  );
  assertEquals(
    resolveInventorySku(null, { id: ITEM_ID, sku: null }),
    "FD-0f3a1c2d",
  );
  assertEquals(
    resolveInventorySku(undefined, { id: ITEM_ID, sku: null }),
    "FD-0f3a1c2d",
  );
});

Deno.test("a blank stored SKU is treated as absent, not as an empty key", () => {
  // Guards against ever addressing eBay with "" — which would 400 at best and
  // hit the wrong item at worst (cf. ebay-cleanup_test.ts's null-groupKey case).
  assertEquals(
    resolveInventorySku({ inventory_sku: "   " }, { id: ITEM_ID, sku: "REAL-SKU" }),
    "REAL-SKU",
  );
  assertNotEquals(
    resolveInventorySku({ inventory_sku: "" }, { id: ITEM_ID, sku: null }),
    "",
  );
});

Deno.test("a stored SKU is trimmed before it addresses eBay", () => {
  assertEquals(
    resolveInventorySku({ inventory_sku: " VTG-501-32 " }, { id: ITEM_ID, sku: null }),
    "VTG-501-32",
  );
});
