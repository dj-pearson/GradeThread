import { assertEquals } from "@std/assert";
import {
  MAX_BULK_EDIT_ITEMS,
  normalizeBulkEdit,
  normalizeBulkEditItems,
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

// ── US-2172: the per-row shape that makes a bulk edit undoable ─────────────
//
// Undoing a bulk edit is not another bulk edit. Every listing must go back to
// ITS OWN former price / condition / policy, and one shared patch cannot say
// that — so the request grew an `items: [{ listing_id, edit }]` shape and the
// response hands back each row's prior values.

Deno.test("normalizeBulkEditItems parses a per-row batch", () => {
  const out = normalizeBulkEditItems([
    { listing_id: "a", edit: { price: 10 } },
    { listing_id: "b", edit: { price: 20, quantity: 3 } },
  ]);
  assertEquals(out?.ids, ["a", "b"]);
  assertEquals(out?.patchById.get("a"), { listing_price: 10 });
  assertEquals(out?.patchById.get("b"), { listing_price: 20, quantity: 3 });
});

Deno.test("normalizeBulkEditItems rejects a non-array or an all-invalid batch", () => {
  assertEquals(normalizeBulkEditItems({}), null);
  assertEquals(normalizeBulkEditItems(null), null);
  // price 0 is not a valid listing price, so this row normalizes to nothing.
  assertEquals(normalizeBulkEditItems([{ listing_id: "a", edit: { price: 0 } }]), null);
});

Deno.test("normalizeBulkEditItems drops junk rows and keeps the usable ones", () => {
  const out = normalizeBulkEditItems([
    null,
    "nope",
    { listing_id: 42, edit: { price: 5 } },
    { listing_id: "", edit: { price: 5 } },
    { listing_id: "ok", edit: { price: 5 } },
  ]);
  assertEquals(out?.ids, ["ok"]);
});

Deno.test("normalizeBulkEditItems keeps the LAST patch for a duplicated id", () => {
  // Sending one listing twice is a client bug; quietly applying the first of
  // two conflicting edits is the wrong half to keep.
  const out = normalizeBulkEditItems([
    { listing_id: "a", edit: { price: 10 } },
    { listing_id: "a", edit: { price: 99 } },
  ]);
  assertEquals(out?.ids, ["a"]);
  assertEquals(out?.patchById.get("a"), { listing_price: 99 });
});

Deno.test("processBulkEdit accepts per-row field names", async () => {
  const fields: Record<string, string[]> = {
    a: ["listing_price"],
    b: ["quantity"],
  };
  const seen: Record<string, string[]> = {};
  const results = await processBulkEdit(
    ["a", "b"],
    (id) => fields[id] ?? [],
    (id): LoadedListing => ({ id, origin: "gradethread" }),
    (listing, applyFields) => {
      seen[listing.id] = applyFields;
      return Promise.resolve({ ok: true });
    },
  );
  assertEquals(seen, { a: ["listing_price"], b: ["quantity"] });
  assertEquals(summarizeBulkEdit(results), { ok: 2, blocked: 0, error: 0 });
});

Deno.test("processBulkEdit carries previous values onto an ok result only", async () => {
  const ok = await processBulkEdit(
    ["a"],
    ["listing_price"],
    (id): LoadedListing => ({ id, origin: "gradethread" }),
    () => Promise.resolve({ ok: true, previous: { listing_price: 42 } }),
  );
  assertEquals(ok[0]?.previous, { listing_price: 42 });

  // A row the marketplace refused never changed, so restoring it would push a
  // value nobody asked for — the same rule the price-undo path applies.
  const failed = await processBulkEdit(
    ["a"],
    ["listing_price"],
    (id): LoadedListing => ({ id, origin: "gradethread" }),
    () => Promise.resolve({ ok: false, error: "nope", previous: { listing_price: 42 } }),
  );
  assertEquals(failed[0]?.status, "error");
  assertEquals(failed[0]?.previous, undefined);
});

Deno.test("processBulkEdit errors a per-row entry with no usable fields", async () => {
  // Counting it ok would tell the seller a listing was updated when no column
  // was touched.
  const results = await processBulkEdit(
    ["a"],
    () => [],
    (id): LoadedListing => ({ id, origin: "gradethread" }),
    () => Promise.reject(new Error("apply must not run")),
  );
  assertEquals(results[0]?.status, "error");
  assertEquals(results[0]?.error, "No valid fields to edit");
});
