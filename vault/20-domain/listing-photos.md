---
title: Listing photos — order, required set, and how edits reach eBay
aliases: [required photos, cover photo, photo sync, thumbnail]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/constants.ts
  - services/edge-functions/src/lib/photo-profiles.ts
  - src/components/flipdesk/photo-manager.tsx
  - src/lib/images.ts
  - src/lib/item-photo-url.ts
  - services/edge-functions/src/lib/item-photo-storage.ts
reviewed: 2026-08-08
tags: [flipdesk, photos, listings, ebay, contract]
summary: Two independent levers (canonical order and required set) duplicated across ~7 surfaces, plus the separate path photo edits take to reach eBay.
---

# Listing photos — order, required set, and how edits reach eBay

## Two levers, each duplicated across surfaces

They are independent. Changing one does not change the other, and each lives in
several places that must move together.

**Canonical order** — index 0 is the cover, which is eBay's main image, and the
index drives `sort_order`:

- `src/lib/constants.ts` → `FLIPDESK_PHOTO_TYPES`; its **index is the rank**
  (see `src/lib/photo-order.ts`).
- `services/edge-functions/src/lib/photo-profiles.ts` → per-category `roles[]`,
  server-authoritative; clients fetch `GET /api/flipdesk/photo-profiles`.
- iOS `PhotoSlotType.swift` → **the enum declaration order *is* the order**,
  because `PhotoUploadService.enqueueAll` derives `sort_order` from
  `allCases.firstIndex(of:)`. Reordering the enum silently reorders listings.

**Required set** — blocks the "photographed" status and grading:

- `src/lib/constants.ts` → `REQUIRED_PHOTO_TYPES`
- `photo-profiles.ts` CLOTHING `required:` + its web mirror
  (`src/lib/photo-profiles.ts` CLOTHING_FALLBACK)
- `flipdesk-grading.ts` → `REQUIRED_GRADING_PHOTO_TYPES`, a **separate** gate
- the **DB view** `items_full.has_required_photos`, recomputed in SQL — changing
  it needs a `CREATE OR REPLACE VIEW` reproducing the whole definition (columns
  cannot be reordered or dropped) and therefore a prod migration
- iOS `PhotoSlotType.required` / `isRequired`, and `ItemWorkflow.hasRequiredPhotos`

Since migration `00306`: **required = front + back only**; order is
Front → Back → Tag → Detail → measurements → defect → extras → universal roles.
iOS deliberately splits `defaultSlots` (four visible) from `required` (two
blocking) — visible and required are not the same list.

## Photo edits do not travel with the Save button

Reorder, retag, rotate and delete **persist immediately** and reach the live eBay
listing through a separate, coalesced path — not through the editor's Save.

- **Web:** `PhotoManager` sets a dirty ref on each edit and pushes the net change
  to eBay **once, on unmount** (closing the editor).
- **iOS:** `PhotoManagerView` sets `photosChanged` and `syncOnCloseIfNeeded()`
  revises on sheet close. Reorder and delete also bump `item.updatedAt`.

> **The iOS Save button is metadata-only.** `ItemCanvasState.isDirty` compares
> `ItemDraft`, which has no photo fields, so photo edits never enable it. Do not
> read a disabled Save as "the photo edit was not registered".

A rotate-only edit once failed to signal the item as changed at all, so it was
the one edit type Save-and-sync ignored. The fix was to make rotate set the same
dirty signal the other three already did — on both platforms.

**Who owns the dirty flag matters.** `PhotoManager` takes an optional `dirtyRef`
so the page can share the signal: the page pushes photos as part of its own
save, then clears the ref so the unmount does not push the same gallery again.
The composer owns it and clears it after a successful resubmit — which always
sends `photos: true`.

> [!note] This was orphaned for a while (fixed 2026-08-01, US-2381)
> The ref used to live on `item-canvas.tsx`, deleted in `a3f4d77d`. Nothing took
> it over, so `PhotoManager` silently fell back to its internal ref and every
> resubmit was followed by a second, redundant push on unmount. A new surface
> that renders `PhotoManager` **and** sends `photos: true` must pass the ref, or
> it reintroduces exactly this.

## Rotation is baked into pixels, which is why thumbnails went stale

Rotation is a canvas re-encode producing a new JPEG — **not** a
`rotation_degrees` column or a CSS transform. The save handlers upload the
rotated blob over `storage_path` and cache-bust `photo_url`.

`thumbnail_url` is generated **once at upload** and is not regenerated. Since
`itemPhotoThumb()` (`src/lib/images.ts`) prefers `thumbnail_url` and only falls
back to `photo_url` when it is null, every thumbnail surface — the manager grid,
the uploader tile, the listings cover, the eBay preview strip — served the
**pre-rotation** image, while zoom and the actual eBay export (both `photo_url`)
were correct. A photo that looks right where you check it and wrong everywhere
else is the signature.

The fix nulls `thumbnail_url` and `thumbnail_storage_path` on edit-save and
best-effort deletes the orphaned object, so the thumb falls back to the
cache-busted full image. The trade is that edited photos load full-res in
galleries — acceptable because it only affects edited photos. Regenerating the
thumbnail from the rotated blob is the better fix if that ever matters.

## Which bucket a photo is in is a fact about the bytes, not about its type

Item photos live in two buckets. Sensitive close-ups (`tag`, `tag_2`,
`certificate` — they can carry names, addresses, serials) go to the PRIVATE
`submission-images`; everything else to the public `item-photos`. The **type**
picks the bucket **at upload time only**, when there are no bytes yet.

Afterwards, the only trustworthy signal is the row's shape:

> **Empty `photo_url` + a `storage_path` ⇒ the bytes are in the private bucket.**
> A populated `photo_url` ⇒ they are public, whatever the type says.

It holds because every writer that puts an object in `item-photos` stores its
public URL on the row in the same insert — web uploader, iOS `PhotoUploadService`,
remove-bg, defect annotations, disclosure, measure overlays, reconcile. Only the
private uploads store `""`. The reverse (a public object with no stored URL) is
not a shape this codebase produces.

Three implementations mirror the rule and must stay in step:
`needsSignedDisplayUrl` / `bucketForItemPhotoRow` (web),
`readBucketForItemPhoto` (edge), `PhotoStorageBucket.readBucket` (iOS).

**Consulting the type instead is the recurring bug (US-2407).** The photo-type
dropdown is the seller's, and a retag rewrites `photo_type` alone — no object
moves. While the readers keyed on the type, retagging a phone-captured Garment
Tag to "Front" made every one of them look in the public bucket for bytes that
had never been there: the tile blanked out mid-edit, AI passes silently dropped
the most informative photo of the garment, and the marketplace resolver handed
eBay a URL that 404s. The seller was only retagging because the pencil was
greyed out — the block and the breakage were the same root cause.

Consequences worth knowing:

- **A private photo is editable**, and the edit is written back to the bucket it
  came from, leaving `photo_url` `""`. That empty column is what keeps it out of
  every marketplace and export payload, so nothing is republished. iOS has done
  this since US-979 (`PhotoRotateService`); the web caught up in US-2407.
- **A private photo never publishes**, however it is tagged. Retagging one to
  "Front" does not promote it — the UI says so once, at the retag.
- **A same-path overwrite needs an explicit client-side bust** (`bumpItemPhotoUrl`)
  because nothing on the row changes: no new `photo_url`, no new path. Public
  photos get this free from their `?v=` cache-buster.

## Related

- [[sync-source-of-truth]] — who owns a field once it is synced
- [[image-intake]] — what the uploaded bytes are allowed to be
- [[grade-authority-on-listings]] — why nothing is ever burned into these photos
- [[INDEX]]
