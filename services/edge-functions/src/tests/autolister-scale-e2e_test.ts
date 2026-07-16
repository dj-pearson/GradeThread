// US-1910: AutoLister at scale v2 — the generation half of the end-to-end AC.
//
// The web-side legs (grouping → propose → verify → triage → reload/resume) live
// in src/lib/autolister-scale-e2e.test.ts. This file closes the last clause of
// AC1: a draft generated from a scale-session group must see the available
// DEFECT and TAG shots. That guarantee is a composition of two steps that live
// in different modules and so is untested as a whole:
//
//   loadItemPhotoUrls  → filterListablePhotos (drop internal/measurement)
//   generateListing    → selectListingPhotos  (role-diverse cap of 6)
//
// The US-1552 regression this locks down: loadItemPhotoUrls used to pre-slice
// the gallery to the first 8 photos BY sort_order before selectListingPhotos
// ever ran. Sellers shoot (and drag) defect/tag shots late, so on a real
// AutoLister group those are exactly the photos the slice threw away — the
// model then wrote condition_notes having never seen the flaw.

import { assertEquals } from "@std/assert";

// Both modules chain into lib/supabase.ts, which throws at import time unless
// the env is already set (item-photo-storage.ts directly; listing-photo-budget
// .ts via ai-extract.ts → ai-feature-context.ts). A static import would be
// hoisted above these lines, so the imports below are dynamic — that keeps the
// file runnable ALONE, rather than depending on some alphabetically-earlier
// test file having set the env in the shared suite process.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const { selectListingPhotos } = await import("../lib/listing-photo-budget.ts");
const { filterListablePhotos } = await import("../lib/item-photo-storage.ts");

interface PhotoRow {
  photo_type: string;
  storage_path: string;
  sort_order: number;
}

/**
 * One item's gallery as it comes out of a 600-photo AutoLister session: the
 * hero shots lead, the seller's own price-tag reference and the measurement
 * shots sit mid-roll, and the tag + defect close-ups are shot LAST.
 */
function galleryRows(): PhotoRow[] {
  const types = [
    "front",
    "back",
    "flatlay",
    "on_model",
    "detail",
    "detail_2",
    "internal", // seller's price tag — must never reach the model
    "measurement_chest", // structured data, not listing signal
    "detail_3",
    "defect", // ← late in sort_order
    "tag", // ← late in sort_order
    "tag_2",
  ];
  return types.map((photo_type, i) => ({
    photo_type,
    storage_path: `user/item/${photo_type}.jpg`,
    sort_order: i,
  }));
}

/** The real funnel: filter non-listable, then role-diverse select. */
function visionPhotos(rows: PhotoRow[], preSlice?: number) {
  const listable = filterListablePhotos(rows)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r) => ({ url: `https://cdn.test/${r.storage_path}`, type: r.photo_type }));
  // preSlice models the removed US-1552 pre-slice, for the contrast assertion.
  return selectListingPhotos(preSlice ? listable.slice(0, preSlice) : listable);
}

const rolesOf = (photos: Array<{ type?: string }>) => photos.map((p) => p.type ?? "");

Deno.test("vision input always includes the available defect + tag shots", () => {
  const chosen = visionPhotos(galleryRows());
  const roles = rolesOf(chosen);

  // AC1's guarantee: the flaw and the label reach the model, even though both
  // are late in the gallery's sort_order.
  assertEquals(roles.includes("defect"), true);
  assertEquals(roles.includes("tag"), true);
  // Cost discipline still holds — 6 role-diverse photos, not the whole roll.
  assertEquals(chosen.length, 6);
});

Deno.test("seller-reference and measurement shots never reach the model", () => {
  const roles = rolesOf(visionPhotos(galleryRows()));
  assertEquals(roles.includes("internal"), false);
  assertEquals(roles.includes("measurement_chest"), false);
});

Deno.test("the removed US-1552 pre-slice would have hidden both shots", () => {
  // Guards the funnel ORDER: select from the FULL set, never from a prefix.
  // With the old first-8-by-sort_order slice, neither shot survives.
  const roles = rolesOf(visionPhotos(galleryRows(), 8));
  assertEquals(roles.includes("defect"), false);
  assertEquals(roles.includes("tag"), false);
});

Deno.test("a manual workbench reorder cannot starve the model of a defect shot", () => {
  // A seller dragging the flatlay to the front rewrites sort_order; selection
  // is by ROLE, so the outcome is unchanged.
  const reordered = galleryRows()
    .map((r) => ({
      ...r,
      sort_order: r.photo_type === "flatlay" ? -1 : r.sort_order,
    }));
  const roles = rolesOf(visionPhotos(reordered));
  assertEquals(roles.includes("defect"), true);
  assertEquals(roles.includes("tag"), true);
});

Deno.test("an item shot without a defect still generates (no shot, no stall)", () => {
  // Not every garment has a flaw — the funnel must degrade, not fail.
  const rows = galleryRows().filter((r) => r.photo_type !== "defect");
  const chosen = visionPhotos(rows);
  assertEquals(rolesOf(chosen).includes("tag"), true);
  assertEquals(chosen.length, 6);
});
