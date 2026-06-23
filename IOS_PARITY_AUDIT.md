# iOS ⇄ Web / Edge Contract Audit

> Started 2026-06-23 after a cluster of FlipDesk bugs surfaced from the iOS
> inventory canvas (eBay specifics not syncing, read-only measurements, grading
> photo-copy failure). All three were **cross-boundary contract bugs** — each
> component was internally correct, but the *seam* between two of them was
> untested. This doc tracks the audit across the three bug classes and the
> remaining work.

## Why unit tests missed these

| Bug | Class | Seam |
|---|---|---|
| Title/brand → eBay specifics didn't sync | Data-mirror contract | item columns ⇄ `ebay_aspects` |
| Measurements read-only on iOS | Web↔iOS parity | web editor vs iOS view |
| Grading photo copy "object not found" | Storage contract | iOS upload bucket vs edge read bucket |

The durable defense is **seam coverage** (integration tests + source-guards),
not more per-component unit tests.

## Class A — Storage contract ✅ closed

Sensitive item photos (`tag`, `tag_2`, `certificate`) upload to the PRIVATE
`submission-images` bucket on iOS but the public `item-photos` bucket on web
(US-979). Any edge code that downloaded from a single hardcoded bucket failed
for the other client's photos.

- **Fixed:** new `services/edge-functions/src/lib/item-photo-storage.ts`
  (`downloadItemPhoto` tries the photo_type's bucket then falls back). Applied
  to `flipdesk-grading` (the original bug), `flipdesk-images` `/process` (was a
  hard error) and `/archive`, and `relist-detect`. `flipdesk-ebay` now imports
  the canonical sensitive-types set instead of duplicating it.
- **Guard:** `item-photo-storage_test.ts` fails CI if any shipping file calls
  `.from("item-photos").download(...)` directly again.

## Class B — Web↔iOS parity (item canvas)

Fields the web item-canvas can edit, checked against the iOS canvas.

| Field | Status |
|---|---|
| garment_type / garment_category | ✅ added (grading blockers — `flipdesk-grading` validate hard-blocks without them) |
| measurements | ✅ added (now editable; was read-only) |
| description | ✅ added ("Listing description" section) |
| style | ✅ added |
| sourced_by | ✅ added |
| **acquired_date** | ⏳ **deferred** — needs an optional date-picker + date-only ("YYYY-MM-DD") (de)serialization through the sync layer. Analytics-only; low risk to ship later. |
| **comp_set (manual entry)** | ⏳ **deferred** — iOS can fetch eBay comps + "use median" but can't hand-curate the `comp_set` array like the web `CompEditor`. Larger UI feature; medium value. |
| container | ⚠️ intentionally skipped — overlaps iOS `location_bin`; confirm whether they're distinct before adding to avoid two competing "where is it" fields. |

Side fix: `ItemDraft` never seeded `category` from `item_category` (stale
comment), so the picker showed "—" and a save could **null the category**. Now
seeded + round-tripped; also drives the clothing-only garment pickers.

## Class C — Data-mirror sync

- **item fields → `ebay_aspects`** ✅ — editing brand/size/color/material now
  re-derives the auto-sourced eBay specifics (`InventoryAspectSync`), preserving
  user/AI-set aspects.
- **measurements → eBay measurement aspects** — ℹ️ no action needed. This
  mapping (`resolveMeasurementAspects`) runs at **listing-generation/publish
  time** (`ai-listing.ts`), not via the specifics editor, so a measurement edit
  is reflected when the listing is (re)generated.
- **listing ⇄ eBay** — ℹ️ server-enforced per `SYNC_SOURCE_OF_TRUTH.md`
  (`buildListingPullPatch` / `validateEbayOriginEdit`); no client precedence
  logic. Out of scope for this audit; flagged as reviewed, no gap found.

## Testing / CI recommendations

Current iOS CI (`ios-ci.yml`) runs **unit tests only** on PRs. The seam bugs
above live above the unit layer. Recommended, in priority order:

1. **Source-guards for contracts** (cheap, deterministic) — done for Class A.
   Consider a similar guard asserting the iOS sync `itemColumns` select stays in
   sync with the columns the canvas writes.
2. **XCUITest smoke target wired into `ios-ci.yml`** — the real "Playwright for
   iOS". A `GradeThreadUITests` folder already exists (used only by the
   screenshots workflow today) but is **not** a CI test target. To make the 3
   critical flows (edit field → eBay specifics; edit measurement; submit a
   tagged item for grading) testable it needs **either** a seeded test backend /
   test account **or** a mockable network layer (launch-arg that swaps the
   Supabase/edge clients for fixtures). Not added here because an unverified new
   build target / a backend-dependent UI test would be flaky and could break CI
   for everyone — this needs a small infra decision first.

## Open follow-ups (quick list)

- [ ] iOS: `acquired_date` editor (Class B).
- [ ] iOS: manual `comp_set` editor (Class B).
- [ ] Decide `container` vs `location_bin` (Class B).
- [ ] iOS UITest smoke target + test-backend/mock decision (CI).
