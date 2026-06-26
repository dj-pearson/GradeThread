import { assertEquals } from "@std/assert";
import {
  MAX_BULK_EDIT_ITEMS,
  normalizeBulkEdit,
  planListingEdit,
  processBulkEdit,
  summarizeBulkEdit,
  type LoadedListing,
} from "../lib/bulk-listing-edit.ts";

Deno.test("normalizeBulkEdit maps + validates fields, drops invalid", () => {
  const patch = normalizeBulkEdit({
    price: 24.5,
    quantity: 2,
    shipping_policy_id: " ship-1 ",
    return_policy_id: "",
    ebay_condition: "USED_EXCELLENT",
  });
  assertEquals(patch, {
    listing_price: 24.5,
    quantity: 2,
    shipping_policy_id: "ship-1",
    ebay_condition: "USED_EXCELLENT",
  });
});

Deno.test("normalizeBulkEdit rejects non-positive price + non-integer qty", () => {
  assertEquals(normalizeBulkEdit({ price: 0, quantity: 1.5 }), null);
  assertEquals(normalizeBulkEdit({ price: -5 }), null);
  assertEquals(normalizeBulkEdit({}), null);
  assertEquals(normalizeBulkEdit(null), null);
});

Deno.test("planListingEdit applies all fields for a GradeThread-originated listing", () => {
  const plan = planListingEdit("gradethread", ["listing_price", "shipping_policy_id"]);
  assertEquals(plan.status, "apply");
  assertEquals(plan.apply, ["listing_price", "shipping_policy_id"]);
  assertEquals(plan.locked, []);
});

Deno.test("planListingEdit blocks eBay-owned fields on an eBay-originated listing", () => {
  const plan = planListingEdit("ebay", ["listing_price", "ebay_condition", "return_policy_id"]);
  assertEquals(plan.status, "blocked");
  assertEquals(plan.apply, []);
  assertEquals(plan.locked, ["listing_price", "ebay_condition", "return_policy_id"]);
});

Deno.test("MAX_BULK_EDIT_ITEMS is a sane positive cap", () => {
  assertEquals(MAX_BULK_EDIT_ITEMS, 100);
});

// AC4: a partial-failure batch reports per-item outcomes (ok | blocked | error).
Deno.test("processBulkEdit reports per-item ok/blocked/error in a partial-failure batch", async () => {
  const loaded: Record<string, LoadedListing> = {
    "gt-ok": { id: "gt-ok", origin: "gradethread" },
    "gt-fail": { id: "gt-fail", origin: "gradethread" },
    "ebay-locked": { id: "ebay-locked", origin: "ebay" },
    // "missing" is intentionally absent → resolve returns null.
  };
  const requested = ["gt-ok", "gt-fail", "ebay-locked", "missing"];

  const applied: string[] = [];
  const results = await processBulkEdit(
    requested,
    ["listing_price"],
    (id) => loaded[id] ?? null,
    (listing) => {
      applied.push(listing.id);
      if (listing.id === "gt-fail") {
        return Promise.resolve({ ok: false, error: "eBay rejected the update." });
      }
      return Promise.resolve({ ok: true });
    },
  );

  // Order preserved, one outcome per requested id.
  assertEquals(results.map((r) => r.listing_id), requested);
  assertEquals(results[0], { listing_id: "gt-ok", status: "ok" });
  assertEquals(results[1], {
    listing_id: "gt-fail",
    status: "error",
    error: "eBay rejected the update.",
  });
  assertEquals(results[2], {
    listing_id: "ebay-locked",
    status: "blocked",
    locked: ["listing_price"],
  });
  assertEquals(results[3], {
    listing_id: "missing",
    status: "error",
    error: "Listing not found",
  });

  // A blocked listing never reaches the side-effecting apply step.
  assertEquals(applied, ["gt-ok", "gt-fail"]);
  assertEquals(summarizeBulkEdit(results), { ok: 1, blocked: 1, error: 2 });
});

Deno.test("processBulkEdit catches a thrown apply and reports it as error", async () => {
  const results = await processBulkEdit(
    ["x"],
    ["listing_price"],
    () => ({ id: "x", origin: "gradethread" }),
    () => {
      throw new Error("network down");
    },
  );
  assertEquals(results[0], { listing_id: "x", status: "error", error: "network down" });
});
