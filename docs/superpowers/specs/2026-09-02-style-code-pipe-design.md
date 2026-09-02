# The style-code pipe: tag to listing

Date: 2026-09-02. Status: approved in chat (pipe first, read-tags-only backfill, no full regenerate).

## Why

Prod on 2026-09-02: 230 brands, 763 styles and 32 decoders in the brand knowledge base; 1,001 inventory items; zero carry a `Style Code` aspect; the 71 Lululemon items have generic titles with no product name. The knowledge exists and none of it reaches a listing. Four breaks, all in the AutoLister path (`services/edge-functions/src/lib/ai-listing.ts`, `generateListing`):

1. Tag OCR (`extractTagGroundTruth`) only sees photos typed `tag`/`tag_2`. It ran on 11 of ~300 generations. 150 items have a tag-typed photo; most tags sit under `detail`.
2. The OCR'd code is handed to `resolveStyleCode`, the sneaker-only resolver. For every apparel brand it returns null, so `styleCodeRaw` is null and mined product names are dropped ("no style code to file them under"). The brand decoders (`decodeTagCode`, `enrichExtractionWithBrandKnowledge`) never run in this path; they only run in the Composer path (`ai-extract.ts`).
3. Nothing in the listing path reads `style_code_names`. The only consumer (`enrichWithLearnedStyle`) is Composer-only and writes `suggestions.style`, not a title fact or aspect.
4. The RN the OCR reads is passed to the prompt and discarded. No registry check, no sighting.

Today's commit `293008ffb` added the `Style Code`/`Style Number`/`Model Number` names to the `mpn` registry entry and `tagAttributeFill` writes `attributes.mpn`. That is the landing pad; the four breaks above starve it.

## What changes

All in the edge service. No migration. No frontend. One new script.

### A. Find the tag (ai-listing.ts, step 2b)

- `loadItemPhotoUrls` also returns each photo's `id`.
- New pure helper `selectTagOcrPhotos(photos)` in `ai-tag-ocr.ts`: tag-typed first (`tag`, `tag_2`), then `interior` and `marking` as label-like fallbacks, capped at `MAX_TAG_OCR_PHOTOS` (4). `internal` is excluded: US-1549 says it is seller-reference only (price tags, receipts) and `filterListablePhotos` already drops it.
- When that set is EMPTY and the item has at least two listable photos, run `classifyPhotoRoles` (existing `ai-photo-roles.ts` holistic pass) over the listable photos and take the ones it calls `tag`. Persist `photo_type = 'tag'` back to `item_photos` only where the current type is `detail` (same guard as `flipdesk-ai.ts:2140`, never clobber a seller choice). Cost is one vision call, only when no tag is typed, metered under the existing `photo_roles` feature.
- Then OCR runs as today.

### B. Decode the code (ai-listing.ts, after OCR)

- New pure helper `decodeListingStyleCode({ ocrStyleCode, ocrMpn, brand, pack })` in a new `lib/listing-style-code.ts`. It resolves the brand pack, runs `decodeTagCode` over the OCR'd `style_code` then `mpn` with `decoderSpecsFromPack`, and returns `{ styleCodeRaw, styleCodeCanonical, decoded: DecodeResult | null, brandConfirmed, size, gender }`.
- `styleCodeRaw` precedence: OCR style code (confidence >= 0.4) > OCR mpn > `item.attributes.mpn` > the sneaker resolver's `styleCode`. The sneaker resolver keeps its brand/comp-query role for sneakers; it no longer decides whether apparel has a code.
- Canonical spelling: `canonicalStyleCode(brandKey, raw)` from `style-code-observations.ts` (US-2714 re-keying) is what lands in `attributes.mpn` and therefore in the `Style Code`/MPN aspect. `tagAttributeFill` gains an optional `canonicalMpn` override.
- Decoder size fills `knownFields.size` when the OCR read no size (decoder wins over the later size estimate, which then does not run). A decoder size that disagrees with a confident OCR size is logged, not applied; the OCR read the printed size directly.
- Decoder brand confirmation raises nothing by itself (the brand already selected the pack) but is logged on the existing `[brand-knowledge-metric]` line.

### C. Name the product (ai-listing.ts, before generation)

- `lookupLearnedStyle(brandKey, styleCodeRaw)` runs once, in parallel with the size estimate. A RESOLVED name (`resolvedName` set, which `pickStyleCodeName` already gates to official/admin/seller/consensus or a corroborated public row) becomes:
  - `decodedStyleName` for `corroborateMinedStyleNames` (so mined names corroborate against it, and unconfirmed ones are FILED under the code instead of dropped);
  - a known fact in the prompt: `knownFields.style` when the item has no seller-typed style, and a line in the tag ground-truth block (`style name (from the style-code index): ...`) so the title leads with it;
  - the `Model` aspect through `registryItem.attributes.model` (new `model` registry entry, `source: "attribute"`, aspects `["Model", "Model Name", "Style Name"]`), fill-only.
- An observation-only fallback (raw listing title trimmed by `styleNameFromTitle`) is offered as a visual candidate through the existing `UNVERIFIED EXTERNAL GUESS` block, never written as a fact.

### D. Use the RN (ai-listing.ts, after OCR)

- New pure helper `assessListingRegisteredNumber({ rn, declaredBrand, index, registrants })` wraps `assessRegisteredNumber` and maps the outcome:
  - `corroborates`: log; add `attributes.rn` and `attributes.rn_registrant` (fill-only).
  - `ambiguous`: same as corroborates (consistent, cannot distinguish).
  - `contradicts`: add a `needs_review` reason `rn_contradicts_brand` with the note; never change the brand.
  - `no_reference`: `recordRegisteredNumberSighting` (fire-and-forget), store `attributes.rn`.
  - `unparsed`: nothing.
- The RN is never projected to an eBay aspect. There is no registry entry for it and none is added.
- `needs_review` on the listing already exists (`ai-listing.ts:3038`); the reason list gains one string.

### E. Backfill script (scripts/backfill-tag-reads.ts)

- Selects, tenant by tenant, `inventory_items` that have at least one `tag`/`tag_2` photo and no `attributes.mpn` and no `attributes.rn`. `--limit N`, `--owner <uuid>`, `--dry-run` (default), `--apply`.
- Per item: `extractTagGroundTruth` over `selectTagOcrPhotos` (no classifier call in the backfill; it only reads items that already have a typed tag), then B, C, D. Writes ONLY: `attributes.mpn`, `attributes.rn`, `attributes.rn_registrant`, `attributes.model`, and the `Style Code`/MPN and `Model` aspects on `ebay_aspects` when the item's leaf exposes them (`resolveItemAspects` against `getCategoryAspects(ebay_category_id)`), with `ebay_aspect_sources` marked `inventory_derived`. Title, description, size, brand, listings rows: untouched. A published eBay listing changes only when the seller republishes.
- The backfill does not run the visual pass and writes nothing to the style-code index. Our own listings are excluded evidence by contract, so the only index traffic is a READ for a resolved name. Sightings are the one exception: an RN with no reference is recorded the same way generation records it, because a sighting is OCR evidence off a real tag, not a listing claim.
- Metered: one `ai_usage_events` row per item under feature `tag_ocr`, phase `backfill`, with the item's `user_id`. Does not consume the seller's monthly AI-action quota (operator-run, like the seeder).
- Summary line: items scanned, read (>=1 field at >=0.4), code read, decoded, named, RN parsed, RN corroborates / contradicts / no_reference, aspects written, cost.
- Pure decision half in `src/lib/tag-read-backfill.ts` (`planBackfillWrite(item, ocrFields, decodeResult, learned, rnAssessment)` returns the exact patch), tested without a DB.

### F. Measure

- `[brand-knowledge-metric]` line gains `code=<raw|none> decoded=<0|1> named=<0|1> rn=<outcome>` in `generateListing`.
- `scripts/aspect-fill-report.ts` (US-3044) reads `attributes.mpn` and `attributes.model` and prints Style Code and Model fill as `filled/total`.

## Contracts kept

- Identification precedence (`vault/20-domain/identification-precedence.md`): decoded style code is row 1, tag wordmark row 2, visual row 3. The learned name enters as a KNOWN fact only when resolved; observation-only names enter as an unverified candidate.
- Style-code evidence (`vault/20-domain/style-code-index-evidence.md`): titles never create a name; our own listings are excluded; the backfill writes nothing to the index.
- Decoder bar (`vault/20-domain/brands/brand-kb-decoder-bar.md`): decoders run inside the pack the tag's brand selected. A style-code hit re-confirms that brand; it cannot spell a brand onto a foreign tag.
- RN (`vault/40-growth/rn-lookup.md`): an RN names a company, never a brand; `contradicts` is review, never a change; `no_reference` is not a negative signal.
- US-346: OCR reads are server-derived and enter the prompt as ground truth; seller text stays fenced.
- Tenant isolation: every write is `.eq("user_id", ownerId)`. The backfill iterates owners and scopes each write.
- Edge style: no `deno fmt` on existing files.

## Tests (TDD, deno)

- `ai-tag-ocr_test.ts`: `selectTagOcrPhotos` ordering, cap, `internal` excluded; `tagAttributeFill` canonical override.
- `listing-style-code_test.ts`: precedence of `styleCodeRaw`; decoder size fill vs OCR size; Lululemon `LW3CWDS` decodes, canonicalises the four spellings; unknown brand yields raw code and no decode.
- `listing-registered-number_test.ts`: five outcomes to five actions; contradiction adds the review reason and leaves brand alone; sighting writer called only on `no_reference`.
- `tag-read-backfill_test.ts`: patch shape; never touches title/size/brand; aspect written only when leaf exposes it; dry-run writes nothing.
- `aspect-registry_test.ts`: `model` entry projects to `Model` on a leaf that has it, fill-only.
- Existing suites stay green: `deno test` in `services/edge-functions`, `deno lint`, `deno check`.

## Rollout

- One story, US-3081, closed with the operator note.
- One push. Edge-only, manual redeploy on Coolify, named before pushing.
- After redeploy: run the backfill `--dry-run --limit 10`, read the output, then `--apply` for the 150.
- Vault: `identification-precedence.md` gains a dated section naming the AutoLister call sites, and `rn-lookup.md` gains the AutoLister sighting source. Same commit.
