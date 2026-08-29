---
title: Listing photos — order, required set, and how edits reach eBay
aliases: [required photos, cover photo, photo sync, thumbnail]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/constants.ts
  - src/lib/photo-roles.ts
  - services/edge-functions/src/lib/photo-profiles.ts
  - src/components/flipdesk/photo-manager.tsx
  - src/components/flipdesk/photo-uploader.tsx
  - services/edge-functions/src/lib/publish-preflight.ts
  - src/lib/images.ts
  - src/lib/item-photo-url.ts
  - services/edge-functions/src/lib/item-photo-storage.ts
  - services/edge-functions/src/lib/thumbnail.ts
  - services/edge-functions/src/routes/jobs-thumbnail-backfill.ts
  - supabase/migrations/00587_item_photo_role_qualifier.sql
  - supabase/migrations/00589_submission_image_role.sql
  - services/edge-functions/src/routes/flipdesk-grading.ts
reviewed: 2026-08-28
tags: [flipdesk, photos, listings, ebay, contract]
summary: Two independent levers (canonical order and required set) duplicated across ~7 surfaces, plus the separate path photo edits take to reach eBay.
---

# Listing photos — order, required set, and how edits reach eBay

## A tag is a TYPE plus a ROLE (US-2462, migration 00587)

The stored tag has two parts, and knowing which part carries the meaning is the
difference between reading this system and fighting it.

- **`photo_type`** — the `flipdesk_photo_type` enum. Small, stable, and the
  thing everything downstream switches on. Postgres cannot remove an enum value,
  so this list only ever grows and every addition is permanent.
- **`photo_role`** — `item_photos.photo_role`, plain text with **no CHECK
  constraint, deliberately**. It says what the photo actually shows: `fabric` on
  a detail, `size` on a tag, `inseam` on a measurement. The vocabulary lives in
  `src/lib/photo-roles.ts` (mirrored to the edge, pinned by
  `src/test/photo-roles-parity.test.ts`), so **a new role costs no migration**.

Before this split the type carried both jobs, which is where `tag_2`,
`detail_2..4` and the five fixed `measurement_*` values came from. That capped a
two-piece suit at two tag slots, put six near-identical entries in a 28-item
picker, and made "add a shoulder measurement slot" a schema change.

> **The profiles were already doing this informally.** `photo-profiles.ts`
> labels `detail_2` as "Handles & Straps" for bags and "Ends & Edges" for
> accessories, and `interior` as "Sweatband" for headwear. The meaning was
> always per-category; it just had nowhere to live, so retagging one of those in
> the web picker showed "Detail 2".

**Retired, not removed.** `tag_2`, `detail_2/3/4` and `measurement_*` are still
legal enum values and always will be. 00587 rewrites existing rows onto
`(type, role)` and the pickers stop offering them —
`RETIRED_PHOTO_TYPES` in `photo-roles.ts` is the map, and it is shared by the
migration and the UI so the two cannot disagree about what `measurement_chest`
meant.

> [!note] "Not listable" and "not listable ON EBAY" are two different sets (US-2625)
> `NON_LISTABLE_PHOTO_TYPES` means *never publish anywhere* — the MeasureCard
> frame, a branded foreign object. `EBAY_INELIGIBLE_PHOTO_TYPES`
> (`src/lib/photo-roles.ts`, added 2026-08-16) is narrower and per-marketplace:
> eBay's picture policy bans added text, graphics and borders, and
> `measurement_overlay` is nothing but added graphics — measurement lines and
> inch labels burned into the pixels. Sellers were finding out as a publish
> rejection, which is the worst place to find out.
>
> It is deliberately NOT folded into the broader set: a measurements graphic is
> welcome on Poshmark, Depop and Mercari, where it is close to expected. So the
> render stays listable everywhere else, and the exclusion is a property of the
> destination rather than of the photo.

> [!warning] `measurement` + NULL role is not the same photo as `measurement` + a role
> `measurement` is on `NON_LISTABLE_PHOTO_TYPES` because it means the MeasureCard
> calibration frame — a branded foreign object that must never publish. But
> `measurement_chest` was a tape close-up, and those **are** listable and sellers
> publish them on purpose. Since 00587 folds the second into the first, the rule
> is role-aware: **NULL role ⇒ card frame ⇒ never lists; any role ⇒ tape photo ⇒
> lists.** Pre-00587 rows have a NULL role, so history is preserved exactly.
>
> The trap: `photo_role` missing from a `select()` reads as `undefined`, which is
> indistinguishable from NULL, which means "card frame". A query that forgets the
> column silently drops the seller's tape photos from their listing and reports
> nothing. Every call site feeding `filterListablePhotos` selects it; there is a
> guard test for the shape in `item-photo-storage_test.ts`.

## The same trap fired again on the GRADING side (US-2471, migration 00589)

The warning above was written about listability and was correct there. Nobody
applied it to grading, and grading had the identical shape: `flipdesk-grading.ts`
`mapPhotoTypeForGrading` took the type ALONE, so once 00587 folded
`measurement_chest` into (`measurement`, `chest`), every tape-measure photo
resolved to `null` — the "not useful for grading" answer that is correct only for
the card frame. The photos kept uploading, kept showing in the gallery, and
stopped reaching the grader. Nothing reported it.

The fix is the same rule in the same words: **NULL role ⇒ card frame ⇒ never
grades; a role ⇒ tape photo ⇒ grades.** Two further points that are easy to get
wrong here:

- `submission_images.image_type` is a **different enum** from
  `flipdesk_photo_type` (`00001`, grown by `00103`) and has no bare `measurement`
  value. A measurement role only reaches the grader when the role is one of the
  five that already have an `image_type` — chest, waist, length, sleeve, inseam.
  Any other dimension resolves to `null` deliberately, because inventing an enum
  value is the growth this epic ended.
- The role travels in `submission_images.image_role` (00589), NOT folded into
  `image_type`. Historical rows are never rewritten: they are the evidence behind
  grades already issued and are served by the public API v1 contract.

> [!note] The role reaching the grader and the grader USING it are two switches
> 00589 plus the threading make the role *available* at the prompt site. Whether
> the per-image prompt SAYS anything about it is gated by `GRADING_PHOTO_ROLES`,
> default off, because a grading prompt only changes through shadow → eval gate →
> canary. With the gate off the assembled prompt is byte-identical
> (`photo-role-prompts_test.ts`). `ai-extract` is not a versioned grading prompt
> and its role captions are live.

## Which garment, not just which category (US-2465)

Photo profiles are keyed by `item_category` (clothing, shoes, bags…), which is
too coarse for clothing: one flat CLOTHING profile offered a t-shirt an inseam
slot and never offered a blazer a shoulder. For `clothing`, the profile now
sub-selects by `measurementGroupFor(item.category)` — the same free-text garment
mapping the measurement FORM has always used (`src/lib/measurement-templates.ts`),
so the photo slots and the measurement fields agree by construction rather than
by somebody remembering both.

Measurement roles are **derived** from `MEASUREMENT_TEMPLATES`, never hand
listed. Adding a measurement field gets it a photo slot for free, in every
client.

> [!warning] A profile is only reachable if something can EMIT its key.
> The `headwear` profile existed, matched a `headwear` rubric, and matched the
> `item_category` enum value migration 00570 applied on 2026-08-09 — and never
> served a single seller, because `ai-extract.ts` kept its own copy of the
> category list, that copy never learned the value, and its prompt instructed
> the model that a hat is `accessories` (US-2797). Adding a profile is three
> links, not two: the key must exist here, in `RUBRICS`, **and** in every list
> a classifier or importer picks from. `src/test/garment-taxonomy-copies.test.ts`
> pins all of them now. See [[shipped-but-unwired]].

## A tag is not a slot with room for one photo (US-2501)

Nothing anywhere caps a tag at one photo, and **every photo sharing a tag
publishes**. Four defect shots, three fabric macros and both sleeves all reach
eBay, Depop, Etsy and Shopify. The exclusions above are judged **per row**, not
per tag: a receipt tagged `internal` is dropped and the item's other photos are
untouched, and a seller with four receipts loses exactly four.

The only collapsing in the publish path is `dedupeAndCapImages`
(`publish-preflight.ts`), and it keys on the **image URL** — two rows pointing at
one file, which is eBay error 25601 waiting to happen. It has never keyed on the
tag. The DB agrees: `00120`'s unique index is
`(inventory_item_id, storage_path)`.

This is written down because "one photo per tag" is a plausible-sounding thing to
optimise toward, and doing it would silently delete photos from live listings.
`item-photo-storage_test.ts` pins the whole composition
(`filterListablePhotos` → `publicItemPhotoUrl` → `dedupeAndCapImages`) against a
same-tag set.

> [!note] The composer has no per-tag slot grid
> `PhotoUploader` renders one tile per expected tag, and each tile shows only
> `photos[0]` plus a `×N` — fine as a shoot-time checklist, wrong as a gallery.
> In the composer it sat directly above `PhotoManager`, which lists every photo,
> so the same set had two views and the lossy one came first. Since US-2501 the
> composer passes `showSlots={false}`: header, bulk **Add photos**, and one grid
> where tagging, reordering and editing happen. Prep, Snap Catalog and the
> AutoLister queue keep the grids — that is where the photos do not exist yet.

## Two levers, each duplicated across surfaces

They are independent. Changing one does not change the other, and each lives in
several places that must move together.

**US-2681 gave the cover slot a second input.** Role order still decides it, but
a photo carrying a `cover_` QA issue (garment too small, more than one garment,
busy ground, a prop in frame) yields index 0 to a clean one — and only to a
photo already ELIGIBLE to be a cover, meaning `front`, `flatlay`, `on_model` or
`back`. The reason for that restriction is the part worth remembering: cover
flags are only ever set against slot 1, so a tag shot carrying no flag means
nothing was checked rather than that it is a good cover, and promoting it would
manufacture the exact situation the reorder nudge exists to complain about. An
unassessed photo (`undefined`, not `false`) never displaces a flagged one.

**Canonical order** — index 0 is the cover, which is eBay's main image, and the
index drives `sort_order`:

- `src/lib/constants.ts` → `FLIPDESK_PHOTO_TYPES`; its **index is the rank**
  (see `src/lib/photo-order.ts`).
- `services/edge-functions/src/lib/photo-profiles.ts` → per-category `roles[]`,
  server-authoritative; clients fetch `GET /api/flipdesk/photo-profiles`.
- iOS: **the resolved profile's `roles[]` order is the order** (US-2470).
  `PhotoIntakeStore.orderedCaptures` ranks each capture by
  `PhotoProfile.sortIndex(of:)` and `PhotoUploadService.enqueueAll` takes that
  order as given.

  It used to be the `PhotoSlotType` enum's DECLARATION order, via
  `allCases.firstIndex(of:)` — one global ordering for every category, so a
  watch's dial and caseback sorted by where they sat in a Swift enum. That is
  gone; reordering the enum no longer reorders listings. What the enum still
  owns is the SF Symbol, the storage bucket and the sensitivity rule. A slot is
  now a `CaptureSlot` — the `(photo_type, photo_role)` pair — and anything the
  profile does not list (defects, slots carried over from an earlier profile)
  sorts after everything it does, never into the cover position.

**Required set** — blocks the "photographed" status and grading:

- `src/lib/constants.ts` → `REQUIRED_PHOTO_TYPES`
- `photo-profiles.ts` CLOTHING `required:` + its web mirror
  (`src/lib/photo-profiles.ts` CLOTHING_FALLBACK)
- `flipdesk-grading.ts` → `REQUIRED_GRADING_PHOTO_TYPES`, a **separate** gate
- the **DB view** `items_full.has_required_photos`, recomputed in SQL — changing
  it needs a `CREATE OR REPLACE VIEW` reproducing the whole definition (columns
  cannot be reordered or dropped) and therefore a prod migration
- iOS `PhotoSlotType.required` / `isRequired`, and `ItemWorkflow.hasRequiredPhotos`

Since migration `00306`: **required = front + back only** — for CLOTHING and
for the DB view. That qualifier matters and this line lacked it (found 2026-08-09
while adding bag slots): `photo-profiles.ts` is PER CATEGORY, and `bags` has
required `marking` (the brand stamp) on top of front + back. So "front + back
only" describes the clothing default and the `items_full.has_required_photos`
column, not every category. Read `requiredPhotoTypesFor(category)` rather than
this sentence when the answer has to be right.

Order is Front → Back → Tag → Detail → measurements → defect → extras →
universal roles for clothing; a category profile sets its own (US-2225 put the
bag condition shots — corners, handles, hardware, base — ahead of the interior
and the date code, keeping `front` at index 0 so no cover image moved).
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

`itemPhotoThumb()` (`src/lib/images.ts`) prefers `thumbnail_url` and only falls
back to `photo_url` when it is null. So when the thumbnail held pre-rotation
pixels, every thumbnail surface (the manager grid, the uploader tile, the
listings cover, the eBay preview strip) served the **pre-rotation** image, while
zoom and the actual eBay export, both `photo_url`, were correct. **A photo that
looks right where you check it and wrong everywhere else is the signature**, and
it has now shown up twice for two different reasons.

**US-2093 (the first one).** `thumbnail_url` was written once at upload and never
regenerated, so an edit left it pointing at the old object. `persistPhotoEdit`
nulls `thumbnail_url` and `thumbnail_storage_path` on save and best-effort
deletes the orphan, so the thumb falls back to the cache-busted full image.

**US-2836 (the same signature, one layer down).** "Never regenerated" stopped
being true when US-1518 added the thumbnail-backfill cron
(`routes/jobs-thumbnail-backfill.ts`), which picks up exactly the rows
`persistPhotoEdit` just nulled and rebuilds them from the current bytes. That
part is correct. What was not: `thumbnailStoragePath()` is **deterministic**, so
the rebuilt object lands on the same key and the cron wrote back a byte-identical
public URL. Supabase serves public objects with `cache-control: max-age=14400`,
so for four hours the browser and the Cloudflare edge kept handing out the
pre-edit thumbnail from cache while the row and the object were both correct.

> **A writer that changes an object's bytes must change its URL.** The cron now
> appends `?v=<ms>` via `bustedThumbnailUrl()` (`lib/thumbnail.ts`), the same
> convention `persistPhotoEdit` already used for `photo_url` and iOS
> `PhotoRotateService` already used for both. Rows written before the fix are not
> repaired; they correct themselves when the 4h max-age expires.

> **Re-reviewed 2026-08-28.** Drift flagged `jobs-thumbnail-backfill.ts`. The
> change was US-2836 AC3, which added no behaviour: it writes the no-repair
> decision above into the job's own header, where someone reading a four-hour-old
> complaint will find it. This note already said it and stays correct. The
> alternative it now records at the source - a one-off sweep appending `?v=` to
> every existing `thumbnail_url` - was rejected because it writes every photo row
> in the product to fix a display that fixes itself, and invalidates every
> correctly-cached thumbnail on the way, making the median seller slower to fix
> the tail.

Between the save and the next cron tick an edited photo loads full-res in
galleries. That is the deliberate trade, and it is bounded by the cron interval
rather than permanent.

### A rotation now carries the MeasureCard calibration with it (US-2888)

Because rotation replaces the pixels, everything stored in that photo's pixel
coordinates was silently invalidated by it. `item_photos.measure_calibration`
is exactly that: a homography mapping pixels to card-plane inches, plus the
endpoints of every measurement line. Nothing rewrote either one, so after a
quarter turn the homography measured along the old axis and an endpoint at
x=3000 in a photo now 2000 wide drew past the edge of the SVG -- still saved,
still counted in the inches, and unreachable, because dragging an endpoint was
the only gesture that could move one.

A quarter turn is a rigid motion, so inches are preserved and no card has to be
detected again: the endpoints go through the same map the editor's canvas
performs and the homography is post-multiplied by that map's inverse. The turn
that matters is the DIFFERENCE between the old rotation recipe and the new one,
not the new one alone, because recipes are absolute against the preserved
original.

**Any future writer of pixel-space data on `item_photos` inherits this.** If
you add a column whose values are image coordinates, the rotate path has to
transform it or the rotate path has to refuse.

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
