// Sync source-of-truth precedence regression suite (US-1085).
//
// Locks in the provenance model from SYNC_SOURCE_OF_TRUTH.md so that a future
// change to the pull/import pipeline cannot silently reintroduce data loss.
// Pure module — no env, no network.  Mirrors the ebay-catalog-merge test
// pattern.
//
// Contract under test:
//   1. Inbound eBay pull: listing_origin='ebay'  → overwrites EBAY_OWNED_LISTING_FIELDS.
//      listing_origin='gradethread' → only LISTING_READONLY_SIGNALS (no price/title).
//   2. GradeThread-owned item fields (grade/condition/cost/sku) are never included
//      in any pull patch for any listing_origin.
//   3. CSV import fills only blank fields on existing rows; never overwrites populated.
//   4. Server guard (US-1080): validateEbayOriginEdit rejects writes to locked
//      eBay-owned fields for eBay-originated listings.
//   5. Listing provenance + Google Sheets carve-out (US-1083): deriveListingOrigin
//      classifies provenance from existing signals; isSheetEditLockedByEbay locks
//      eBay-owned cells on eBay-originated listings (field-scoped).

import { assert, assertEquals } from "@std/assert";
import {
  buildCsvFillPatch,
  buildListingPullPatch,
  deriveListingOrigin,
  ebayOriginWriteLock,
  EBAY_OWNED_FIELDS,
  EBAY_OWNED_ITEM_SPECIFIC_FIELDS,
  EBAY_OWNED_LISTING_FIELDS,
  GRADETHREAD_OWNED_ITEM_FIELDS,
  isBlank,
  isEbayOwned,
  isEbayOwnedListingField,
  isGradeThreadOwned,
  isSheetEditLockedByEbay,
  LISTING_READONLY_SIGNALS,
  validateEbayOriginEdit,
} from "../lib/sync-precedence.ts";

// ── Inbound pull — listing_origin='ebay' ───────────────────────────────────

Deno.test("pull ebay: all present eBay-owned fields are written into the patch", () => {
  const data = {
    listing_title: "Nike Tee",
    listing_price: 29.99,
    listing_status: "active",
    is_active: true,
    quantity: 1,
    listing_description: "Great condition",
    listed_at: "2026-06-01T00:00:00Z",
    platform_category_id: "11111",
    platform_listing_id: "123456789",
    platform_offer_id: "offer-1",
    listing_url: "https://ebay.com/itm/123456789",
  };
  const patch = buildListingPullPatch("ebay", data);
  assertEquals(patch.listing_title, "Nike Tee");
  assertEquals(patch.listing_price, 29.99);
  assertEquals(patch.listing_status, "active");
  assertEquals(patch.is_active, true);
  assertEquals(patch.quantity, 1);
  assertEquals(patch.listing_description, "Great condition");
  assertEquals(patch.platform_listing_id, "123456789");
  assertEquals(patch.platform_offer_id, "offer-1");
  assertEquals(patch.listing_url, "https://ebay.com/itm/123456789");
});

Deno.test("pull ebay: only present keys appear in patch (sparse eBay data)", () => {
  // eBay API didn't return a description — it must not appear in the patch.
  const patch = buildListingPullPatch("ebay", {
    listing_title: "Levi Jeans",
    listing_price: 45,
    is_active: true,
    listing_status: "active",
  });
  assert("listing_title" in patch, "title present in eBay data → must be in patch");
  assert(!("listing_description" in patch), "description not in eBay data → absent from patch");
  assert(!("quantity" in patch), "quantity not in eBay data → absent from patch");
});

// ── Inbound pull — listing_origin='gradethread' ────────────────────────────

Deno.test("pull gradethread: price/title/description/quantity are NOT written", () => {
  const data = {
    listing_title: "eBay edit that we must ignore",
    listing_price: 9.99, // eBay undercut our price
    listing_description: "eBay edited description",
    quantity: 5,
    listing_status: "active",
    is_active: true,
    platform_listing_id: "EBY-001",
  };
  const patch = buildListingPullPatch("gradethread", data);
  assert(!("listing_title" in patch), "GT-originated: title must NOT be pulled from eBay");
  assert(!("listing_price" in patch), "GT-originated: price must NOT be pulled from eBay");
  assert(!("listing_description" in patch), "GT-originated: description must NOT be pulled");
  assert(!("quantity" in patch), "GT-originated: quantity must NOT be pulled");
  assert(!("platform_listing_id" in patch), "GT-originated: platform_listing_id must NOT be pulled");
});

Deno.test("pull gradethread: only LISTING_READONLY_SIGNALS (sold/ended state) flow in", () => {
  const data = {
    listing_title: "Irrelevant eBay title",
    listing_price: 9.99,
    listing_status: "ended", // eBay ended the listing → we must know
    is_active: false,
  };
  const patch = buildListingPullPatch("gradethread", data);
  // Read-only signals must be present.
  assertEquals(patch.listing_status, "ended", "listing_status is a read-only signal");
  assertEquals(patch.is_active, false, "is_active is a read-only signal");
  // Editable fields must not appear.
  assert(!("listing_price" in patch));
  assert(!("listing_title" in patch));
});

Deno.test("pull gradethread: empty eBay data produces empty patch", () => {
  const patch = buildListingPullPatch("gradethread", {});
  assertEquals(Object.keys(patch).length, 0);
});

Deno.test("pull gradethread: partial signals — only present ones written", () => {
  // Only is_active present (no listing_status) — patch has exactly one key.
  const patch = buildListingPullPatch("gradethread", { is_active: true });
  assert("is_active" in patch, "is_active present in data → must appear in patch");
  assert(!("listing_status" in patch), "listing_status not in data → absent from patch");
  assertEquals(Object.keys(patch).length, 1);
});

// ── LISTING_READONLY_SIGNALS is a subset of EBAY_OWNED_LISTING_FIELDS ──────

Deno.test("LISTING_READONLY_SIGNALS is a strict subset of EBAY_OWNED_LISTING_FIELDS", () => {
  const owned = new Set<string>(EBAY_OWNED_LISTING_FIELDS);
  for (const sig of LISTING_READONLY_SIGNALS) {
    assert(owned.has(sig), `${sig} in LISTING_READONLY_SIGNALS must also be in EBAY_OWNED_LISTING_FIELDS`);
  }
  // Verify the subset is strict (some EBAY_OWNED fields are NOT read-only signals).
  assert(
    LISTING_READONLY_SIGNALS.length < EBAY_OWNED_LISTING_FIELDS.length,
    "LISTING_READONLY_SIGNALS must be a STRICT subset (fewer than EBAY_OWNED_LISTING_FIELDS)",
  );
  // listing_price and listing_title are eBay-owned but NOT read-only signals.
  assert(
    !(LISTING_READONLY_SIGNALS as ReadonlyArray<string>).includes("listing_price"),
    "listing_price must NOT be a read-only signal",
  );
  assert(
    !(LISTING_READONLY_SIGNALS as ReadonlyArray<string>).includes("listing_title"),
    "listing_title must NOT be a read-only signal",
  );
});

// ── GradeThread-owned item fields never written by any pull ────────────────

Deno.test("GRADETHREAD_OWNED_ITEM_FIELDS never appear in any pull patch (ebay origin)", () => {
  // Construct an eBay payload that happens to include GT-owned field names —
  // these should never make it into a pull patch (they're not even valid
  // EbayOwnedListingFields, so buildListingPullPatch ignores them by design).
  const gtFields = GRADETHREAD_OWNED_ITEM_FIELDS;
  const fakeEbayData: Record<string, unknown> = {};
  for (const f of gtFields) fakeEbayData[f] = "tampered";
  const patch = buildListingPullPatch("ebay", fakeEbayData as never);
  for (const field of gtFields) {
    assert(
      !Object.prototype.hasOwnProperty.call(patch, field),
      `GT-owned field '${field}' must NEVER appear in a pull patch (ebay origin)`,
    );
  }
});

Deno.test("GRADETHREAD_OWNED_ITEM_FIELDS never appear in any pull patch (gradethread origin)", () => {
  const gtFields = GRADETHREAD_OWNED_ITEM_FIELDS;
  const fakeEbayData: Record<string, unknown> = {};
  for (const f of gtFields) fakeEbayData[f] = "tampered";
  const patch = buildListingPullPatch("gradethread", fakeEbayData as never);
  for (const field of gtFields) {
    assert(
      !Object.prototype.hasOwnProperty.call(patch, field),
      `GT-owned field '${field}' must NEVER appear in a pull patch (gradethread origin)`,
    );
  }
});

Deno.test("GRADETHREAD_OWNED_ITEM_FIELDS includes grade/condition/cost/sku sentinels", () => {
  const owned = new Set<string>(GRADETHREAD_OWNED_ITEM_FIELDS);
  for (const required of ["grade_value", "condition_notes", "acquired_price", "sku"]) {
    assert(owned.has(required), `${required} must be in GRADETHREAD_OWNED_ITEM_FIELDS`);
  }
});

// ── CSV fill-only import ───────────────────────────────────────────────────

Deno.test("CSV fill: blank fields are filled from the incoming row", () => {
  const existing = { brand: null, size: null, title: "Vintage Tee" };
  const incoming = { brand: "Nike", size: "M", title: "Different Title" };
  const patch = buildCsvFillPatch(existing, incoming);
  assertEquals(patch.brand, "Nike", "blank brand should be filled");
  assertEquals(patch.size, "M", "blank size should be filled");
  // title is populated → must NOT be overwritten
  assert(!("title" in patch), "populated title must not be overwritten");
});

Deno.test("CSV fill: whitespace-only value counts as blank and is replaced", () => {
  const existing = { color: "   " }; // whitespace = blank
  const incoming = { color: "Red" };
  const patch = buildCsvFillPatch(existing, incoming);
  assertEquals(patch.color, "Red");
});

Deno.test("CSV fill: empty-string existing is blank", () => {
  const existing = { style: "" };
  const incoming = { style: "Crewneck" };
  const patch = buildCsvFillPatch(existing, incoming);
  assertEquals(patch.style, "Crewneck");
});

Deno.test("CSV fill: blank incoming value is never written (skip)", () => {
  const existing = { brand: null };
  const incoming = { brand: null }; // incoming is also blank → nothing to write
  const patch = buildCsvFillPatch(existing, incoming);
  assert(!("brand" in patch), "blank incoming value must not produce a write");
});

Deno.test("CSV fill: all fields populated → empty patch (no-op)", () => {
  const existing = { brand: "Nike", size: "L", title: "T", color: "Blue" };
  const incoming = { brand: "Adidas", size: "M", title: "Different", color: "Red" };
  const patch = buildCsvFillPatch(existing, incoming);
  assertEquals(Object.keys(patch).length, 0, "all fields populated → no writes");
});

Deno.test("CSV fill: mixed — some blank, some populated", () => {
  const existing = {
    brand: "Nike", // set
    size: null,    // blank
    color: null,   // blank
    style: "Crew", // set
    material: "",  // blank (empty string)
  };
  const incoming = {
    brand: "Adidas",
    size: "M",
    color: "Red",
    style: "Zip",
    material: "Cotton",
  };
  const patch = buildCsvFillPatch(existing, incoming);
  assert(!("brand" in patch), "brand already set — no overwrite");
  assertEquals(patch.size, "M");
  assertEquals(patch.color, "Red");
  assert(!("style" in patch), "style already set — no overwrite");
  assertEquals(patch.material, "Cotton");
});

Deno.test("CSV fill: GRADETHREAD_OWNED_ITEM_FIELDS are never written even if blank", () => {
  // sku, grade_value, condition_notes, acquired_price must be off-limits.
  const existing = {
    sku: null,
    grade_value: null,
    condition_notes: null,
    acquired_price: null,
    brand: null, // non-GT-owned, should be fillable
  };
  const incoming = {
    sku: "NEW-SKU",
    grade_value: 9.5,
    condition_notes: "Pristine",
    acquired_price: 12,
    brand: "Nike",
  };
  const patch = buildCsvFillPatch(existing, incoming);
  assert(!("sku" in patch), "sku is GT-owned → never written by CSV import");
  assert(!("grade_value" in patch), "grade_value is GT-owned → never written by CSV import");
  assert(!("condition_notes" in patch), "condition_notes is GT-owned → never written by CSV import");
  assert(!("acquired_price" in patch), "acquired_price is GT-owned → never written by CSV import");
  assertEquals(patch.brand, "Nike", "non-GT-owned blank field should be filled");
});

// ── US-1080 server guard: validateEbayOriginEdit ───────────────────────────

Deno.test("guard ebay: eBay-owned fields are locked for listing_origin='ebay'", () => {
  const result = validateEbayOriginEdit("ebay", [
    "listing_price",
    "listing_title",
    "listing_status",
    "quantity",
    "listing_description",
  ]);
  assert(result.locked.includes("listing_price"), "listing_price must be locked for ebay origin");
  assert(result.locked.includes("listing_title"), "listing_title must be locked for ebay origin");
  assert(result.locked.includes("listing_status"), "listing_status must be locked for ebay origin");
  assert(result.locked.includes("quantity"), "quantity must be locked for ebay origin");
  assertEquals(result.allowed.length, 0, "no eBay-owned field is allowed for ebay origin");
});

Deno.test("guard ebay: non-eBay-owned fields (grade/condition) pass through for ebay origin", () => {
  const result = validateEbayOriginEdit("ebay", [
    "grade_value",
    "condition_notes",
    "internal_notes",
  ]);
  assertEquals(result.locked.length, 0, "non-eBay fields are not locked");
  assertEquals(result.other, ["grade_value", "condition_notes", "internal_notes"]);
});

Deno.test("guard gradethread: all fields allowed — nothing locked for gradethread origin", () => {
  const result = validateEbayOriginEdit("gradethread", [
    "listing_price",
    "listing_title",
    "listing_description",
    "quantity",
  ]);
  assertEquals(result.locked.length, 0, "no fields locked for gradethread origin");
  assert(
    result.allowed.includes("listing_price"),
    "listing_price is allowed on GT-originated listing",
  );
  assert(
    result.allowed.includes("listing_title"),
    "listing_title is allowed on GT-originated listing",
  );
});

Deno.test("guard: empty field list → empty result for any origin", () => {
  const ebay = validateEbayOriginEdit("ebay", []);
  assertEquals(ebay.locked.length, 0);
  assertEquals(ebay.allowed.length, 0);
  assertEquals(ebay.other.length, 0);

  const gt = validateEbayOriginEdit("gradethread", []);
  assertEquals(gt.locked.length, 0);
  assertEquals(gt.allowed.length, 0);
  assertEquals(gt.other.length, 0);
});

Deno.test("guard ebay: mixed eBay-owned and non-owned fields in one request", () => {
  const result = validateEbayOriginEdit("ebay", [
    "listing_price",    // eBay-owned → locked
    "grade_value",      // GT-owned → other (allowed)
    "listing_title",    // eBay-owned → locked
    "internal_note",    // arbitrary → other (allowed)
  ]);
  assertEquals(result.locked.sort(), ["listing_price", "listing_title"].sort());
  assertEquals(result.other.sort(), ["grade_value", "internal_note"].sort());
  assertEquals(result.allowed.length, 0);
});

// ── US-1076 ownership helpers + shared isBlank ─────────────────────────────

Deno.test("isEbayOwned: true for listing fields, item specifics, condition, policies", () => {
  for (const f of EBAY_OWNED_LISTING_FIELDS) {
    assert(isEbayOwned(f), `${f} (listing field) must be eBay-owned`);
  }
  for (const f of EBAY_OWNED_ITEM_SPECIFIC_FIELDS) {
    assert(isEbayOwned(f), `${f} (item specific) must be eBay-owned`);
  }
  for (
    const f of ["ebay_condition", "shipping_policy_id", "payment_policy_id", "return_policy_id"]
  ) {
    assert(isEbayOwned(f), `${f} must be eBay-owned`);
  }
  // GradeThread-owned + arbitrary fields are NOT eBay-owned.
  for (const f of ["grade_value", "sku", "measurements", "internal_note"]) {
    assert(!isEbayOwned(f), `${f} must NOT be eBay-owned`);
  }
});

Deno.test("isEbayOwned matches EBAY_OWNED_FIELDS membership exactly", () => {
  for (const f of EBAY_OWNED_FIELDS) assert(isEbayOwned(f), `${f} must be eBay-owned`);
});

Deno.test("isGradeThreadOwned: true for grade/condition/measurements/cost/sku", () => {
  for (const f of GRADETHREAD_OWNED_ITEM_FIELDS) {
    assert(isGradeThreadOwned(f), `${f} must be GradeThread-owned`);
  }
  for (const f of ["measurements", "grade_value", "sku"]) {
    assert(isGradeThreadOwned(f), `${f} must be GradeThread-owned`);
  }
  // eBay-owned + arbitrary fields are NOT GradeThread-owned.
  for (const f of ["listing_price", "brand", "ebay_condition", "watchers"]) {
    assert(!isGradeThreadOwned(f), `${f} must NOT be GradeThread-owned`);
  }
});

Deno.test("ownership is mutually exclusive (no field is both eBay- and GT-owned)", () => {
  for (const f of EBAY_OWNED_FIELDS) {
    assert(!isGradeThreadOwned(f), `${f} must not be both eBay- and GT-owned`);
  }
  for (const f of GRADETHREAD_OWNED_ITEM_FIELDS) {
    assert(!isEbayOwned(f), `${f} must not be both eBay- and GT-owned`);
  }
});

Deno.test("isBlank: null/undefined/empty-or-whitespace string are blank", () => {
  assert(isBlank(null));
  assert(isBlank(undefined));
  assert(isBlank(""));
  assert(isBlank("   "));
});

Deno.test("isBlank: 0, false, empty array, and objects count as SET", () => {
  assert(!isBlank(0), "0 is a set value, not blank");
  assert(!isBlank(false), "false is a set value, not blank");
  assert(!isBlank([]), "empty array is a set value, not blank");
  assert(!isBlank({}), "object/placeholder is a set value, not blank");
  assert(!isBlank("x"), "non-empty string is set");
});

// ── Listing provenance + Google Sheets carve-out (US-1083) ─────────────────

Deno.test("isEbayOwnedListingField matches the registry, rejects others", () => {
  for (const f of EBAY_OWNED_LISTING_FIELDS) {
    assert(isEbayOwnedListingField(f), `${f} must be eBay-owned`);
  }
  for (const f of ["grade_value", "condition_notes", "platform", "watchers", "views"]) {
    assert(!isEbayOwnedListingField(f), `${f} must NOT be eBay-owned`);
  }
});

Deno.test("deriveListingOrigin: stored marker wins outright", () => {
  // Even with eBay signals, an explicit stored marker is authoritative.
  assertEquals(
    deriveListingOrigin({ listing_origin: "ebay", batch_id: "b1" }),
    "ebay",
  );
  assertEquals(
    deriveListingOrigin({ listing_origin: "gradethread", platform: "ebay", platform_listing_id: "1" }),
    "gradethread",
  );
});

Deno.test("deriveListingOrigin: FlipDesk publish signals → gradethread", () => {
  // batch_id OR synced_to_ebay_at means WE created/published it.
  assertEquals(deriveListingOrigin({ batch_id: "batch-1" }), "gradethread");
  assertEquals(
    deriveListingOrigin({ synced_to_ebay_at: "2026-06-01T00:00:00Z" }),
    "gradethread",
  );
  // A GT-originated listing we pushed up to eBay still has an eBay id — publish
  // signals must take precedence over the eBay-id heuristic.
  assertEquals(
    deriveListingOrigin({
      platform: "ebay",
      platform_listing_id: "999",
      synced_to_ebay_at: "2026-06-01T00:00:00Z",
    }),
    "gradethread",
  );
});

Deno.test("deriveListingOrigin: eBay-imported (id, never published) → ebay", () => {
  assertEquals(
    deriveListingOrigin({ platform: "ebay", platform_listing_id: "EBY-1" }),
    "ebay",
  );
  // Case-insensitive platform.
  assertEquals(
    deriveListingOrigin({ platform: "eBay", platform_listing_id: "EBY-2" }),
    "ebay",
  );
});

Deno.test("deriveListingOrigin: ambiguous → gradethread (safe default keeps bidirectional)", () => {
  assertEquals(deriveListingOrigin({}), "gradethread");
  // An eBay platform but no listing id yet (draft) is not eBay-originated.
  assertEquals(deriveListingOrigin({ platform: "ebay" }), "gradethread");
  // A non-eBay platform with an id is not eBay-originated.
  assertEquals(
    deriveListingOrigin({ platform: "poshmark", platform_listing_id: "P-1" }),
    "gradethread",
  );
});

Deno.test("isSheetEditLockedByEbay: eBay-owned field on eBay-originated listing is locked", () => {
  // Divergent edit to a locked field → skipped.
  assert(isSheetEditLockedByEbay("ebay", "listing_price", "55", "49.99"));
  assert(isSheetEditLockedByEbay("ebay", "listing_title", "New Title", "Old Title"));
  assert(isSheetEditLockedByEbay("ebay", "listing_status", "ended", "active"));
});

Deno.test("isSheetEditLockedByEbay: field-scoped — non-eBay-owned cells still sync", () => {
  // watchers/views/platform aren't eBay-owned → not locked even on eBay origin.
  assert(!isSheetEditLockedByEbay("ebay", "watchers", "10", "5"));
  assert(!isSheetEditLockedByEbay("ebay", "platform", "etsy", "ebay"));
});

Deno.test("isSheetEditLockedByEbay: GradeThread-originated listings are never locked", () => {
  assert(!isSheetEditLockedByEbay("gradethread", "listing_price", "55", "49.99"));
  assert(!isSheetEditLockedByEbay("gradethread", "listing_title", "New", "Old"));
});

Deno.test("isSheetEditLockedByEbay: no edit (equal) or emptied cell is not a skip", () => {
  // Equal values → nothing changed, nothing to skip.
  assert(!isSheetEditLockedByEbay("ebay", "listing_price", "49.99", "49.99"));
  // An emptied cell is just rewritten from the DB, not reported as a skip.
  assert(!isSheetEditLockedByEbay("ebay", "listing_price", "", "49.99"));
});

// ── Pull patches never include GT-owned item fields (contract invariant) ────

Deno.test("buildListingPullPatch never produces GT-owned item field keys", () => {
  // Belt-and-suspenders: even if someone passes GradeThread-owned field names
  // inside InboundEbayListing (which isn't valid, but TypeScript allows casts),
  // the function must not output them.
  const gtOwned = GRADETHREAD_OWNED_ITEM_FIELDS as ReadonlyArray<string>;
  for (const origin of ["ebay", "gradethread"] as const) {
    const data: Record<string, unknown> = {};
    for (const f of gtOwned) data[f] = "injected";
    const patch = buildListingPullPatch(origin, data as never);
    for (const field of gtOwned) {
      assert(
        !Object.prototype.hasOwnProperty.call(patch, field),
        `buildListingPullPatch(${origin}) must not write GT-owned field '${field}'`,
      );
    }
  }
});

// ── US-1976: ebayOriginWriteLock (end/reprice/revise lifecycle gate) ─────────

Deno.test("ebayOriginWriteLock: reprice on an eBay-imported listing is locked", () => {
  const lock = ebayOriginWriteLock(
    { platform: "ebay", platform_listing_id: "EBY-1" },
    ["listing_price"],
  );
  assert(lock.locked);
  assertEquals(lock.lockedFields, ["listing_price"]);
});

Deno.test("ebayOriginWriteLock: end (listing_status/is_active) on an eBay-imported listing is locked", () => {
  const lock = ebayOriginWriteLock(
    { platform: "ebay", platform_listing_id: "EBY-2" },
    ["listing_status", "is_active"],
  );
  assert(lock.locked);
  assertEquals(lock.lockedFields, ["listing_status", "is_active"]);
});

Deno.test("ebayOriginWriteLock: AC3 — an eBay-origin row that CARRIES an offer id is still locked", () => {
  // The whole point of the origin gate: provenance does NOT depend on
  // platform_offer_id, so an eBay-imported mirror that happens to have an offer
  // id (from the sync) must NOT slip past the reprice/end gate as if editable.
  const signals = {
    platform: "ebay",
    platform_listing_id: "EBY-3",
    // no batch_id / synced_to_ebay_at → eBay-originated
  };
  assertEquals(deriveListingOrigin(signals), "ebay");
  assert(ebayOriginWriteLock(signals, ["listing_price"]).locked);
  assert(ebayOriginWriteLock(signals, ["listing_status", "is_active"]).locked);
});

Deno.test("ebayOriginWriteLock: a persisted listing_origin='ebay' locks even without eBay signals", () => {
  const lock = ebayOriginWriteLock(
    { listing_origin: "ebay" },
    ["listing_price"],
  );
  assert(lock.locked);
  assertEquals(lock.lockedFields, ["listing_price"]);
});

Deno.test("ebayOriginWriteLock: GradeThread-originated listings are never locked", () => {
  // Published from FlipDesk (batch_id) → GT owns it, even for eBay-owned fields.
  const gtBatch = ebayOriginWriteLock(
    { platform: "ebay", platform_listing_id: "999", batch_id: "batch-1" },
    ["listing_price", "listing_status", "is_active"],
  );
  assertEquals(gtBatch.locked, false);
  assertEquals(gtBatch.lockedFields, []);

  // Ambiguous (no signals) defaults to gradethread → not locked.
  assertEquals(ebayOriginWriteLock({}, ["listing_price"]).locked, false);

  // A persisted gradethread marker wins even with an eBay id present.
  assertEquals(
    ebayOriginWriteLock(
      { listing_origin: "gradethread", platform: "ebay", platform_listing_id: "1" },
      ["listing_status"],
    ).locked,
    false,
  );
});

Deno.test("ebayOriginWriteLock: non-eBay-owned fields never lock, even on eBay origin", () => {
  // grade_value/condition_notes are GradeThread-owned; requesting them alone
  // yields no locked fields (they fall into `other` in validateEbayOriginEdit).
  const lock = ebayOriginWriteLock(
    { platform: "ebay", platform_listing_id: "EBY-4" },
    ["grade_value", "condition_notes"],
  );
  assertEquals(lock.locked, false);
  assertEquals(lock.lockedFields, []);
});
