# Style-Code Pipe Implementation Plan

> **Executed 2026-09-02.** Two departures from the text below, recorded rather
> than rewritten: (1) Task 3's decoder-derived size was dropped. The size-dot
> decoder is region-scoped and off by default (`REGION_SCOPED_DECODER_KINDS`),
> nothing isolates the dot yet, and a bare "8" the OCR called a style code is a
> size, not a code; `resolveListingStyleCode` now applies the index's
> `MIN_STYLE_CODE_LENGTH` instead. (2) The story landed as US-3085, not
> US-3081: another session filed four stories in the same working tree first.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tag OCR, the brand decoders, the style-code index and the RN registry reach the AutoLister's listing, and backfill the 150 prod items that already have a tag photo.

**Architecture:** Every change is inside the Deno/Hono edge service (`services/edge-functions/`). `generateListing` in `lib/ai-listing.ts` gains four wiring steps, each backed by a PURE helper in its own small file so the rule is unit-testable without a DB or Anthropic. A read-only-ish operator script reuses the same helpers for the backfill. No migration, no frontend.

**Tech Stack:** Deno 2, TypeScript strict, `@std/assert` tests (`deno test`), supabase-js service-role client, Anthropic SDK (only through existing wrappers).

**Spec:** `docs/superpowers/specs/2026-09-02-style-code-pipe-design.md`

## Global Constraints

- Edge tests run from `services/edge-functions/`: `deno test --allow-env --allow-read --allow-net src/tests/<file>` for one file; `deno lint` and `deno check src/main.ts` must stay clean. NEVER run `deno fmt` on an existing file (it reformats the whole file). Match the local style by hand.
- Tests that import a module which touches `supabase.ts` must set dummy env BEFORE a dynamic import (copy the header from `src/tests/ai-tag-ocr_test.ts`).
- Tenant isolation (US-268): every `inventory_items` / `item_photos` write carries `.eq("user_id", ownerId)` or `.eq("inventory_item_id", itemId)` on an owner-verified item.
- Never overwrite a seller value: all attribute writes are fill-only; `photo_type` writes only replace `detail`.
- `internal` photos are seller-reference only (US-1549) and must never be sent to a model.
- An RN can corroborate or lower confidence; it never changes `brand`. `no_reference` is not a negative signal.
- Commit messages: imperative, what and why, ending with one blank line then `Co-Authored-By: Claude <noreply@anthropic.com>`. Nothing else after it.
- Plain ASCII in code and commit subjects.

---

### Task 1: `selectTagOcrPhotos` and photo ids in `loadItemPhotoUrls`

**Files:**
- Modify: `services/edge-functions/src/lib/ai-tag-ocr.ts:20-35` (add the helper next to `TAG_PHOTO_TYPES`)
- Modify: `services/edge-functions/src/lib/ai-listing.ts:265-270` (`ListingGenPhoto` gains `id?`), `:2049-2070` (`loadItemPhotoUrls` selects and returns `id`), `:2223-2225` (use the helper)
- Test: `services/edge-functions/src/tests/ai-tag-ocr_test.ts`

**Interfaces:**
- Produces: `export const TAG_OCR_FALLBACK_TYPES: ReadonlySet<string>` = `{"interior","marking"}`; `export function selectTagOcrPhotos<T extends { type?: string | null }>(photos: T[], max = 4): T[]`; `ListingGenPhoto.id?: string`.

- [x] **Step 1: Write the failing tests** (append to `src/tests/ai-tag-ocr_test.ts`; add `selectTagOcrPhotos, TAG_OCR_FALLBACK_TYPES` to the destructured import)

```ts
Deno.test("selectTagOcrPhotos: tag-typed first, label-like fallbacks after, capped", () => {
  const photos = [
    { id: "d1", type: "detail" },
    { id: "m1", type: "marking" },
    { id: "t2", type: "tag_2" },
    { id: "i1", type: "interior" },
    { id: "t1", type: "tag" },
    { id: "x", type: "internal" },
    { id: "f", type: "front" },
  ];
  const picked = selectTagOcrPhotos(photos).map((p) => p.id);
  // tag types keep their input order, then the fallbacks in input order.
  assertEquals(picked, ["t2", "t1", "m1", "i1"]);
});

Deno.test("selectTagOcrPhotos: never picks internal, and honours the cap", () => {
  const photos = [
    { id: "x", type: "internal" },
    { id: "a", type: "tag" },
    { id: "b", type: "tag" },
    { id: "c", type: "tag_2" },
    { id: "d", type: "interior" },
    { id: "e", type: "marking" },
  ];
  assertEquals(selectTagOcrPhotos(photos, 2).map((p) => p.id), ["a", "b"]);
  assertEquals(selectTagOcrPhotos(photos).map((p) => p.id), ["a", "b", "c", "d"]);
  assertEquals(TAG_OCR_FALLBACK_TYPES.has("internal"), false);
});

Deno.test("selectTagOcrPhotos: empty when nothing label-like exists", () => {
  assertEquals(selectTagOcrPhotos([{ type: "front" }, { type: "detail" }]), []);
});
```

- [x] **Step 2: Run to verify it fails**

Run: `cd services/edge-functions && deno test --allow-env --allow-read src/tests/ai-tag-ocr_test.ts`
Expected: FAIL, `selectTagOcrPhotos is not a function`.

- [x] **Step 3: Implement** in `ai-tag-ocr.ts` right after the `GRADING_TAG_PHOTO_TYPES` declaration:

```ts
// 2026-09-02: label-like types that are worth an OCR look when no photo is
// typed tag. `interior` is the inside of a garment (where the woven label is)
// and `marking` is an explicit maker's mark. `internal` is deliberately NOT
// here: US-1549 makes it seller-reference only (price tags, receipts) and
// filterListablePhotos already drops it before any model sees it.
export const TAG_OCR_FALLBACK_TYPES: ReadonlySet<string> = new Set([
  "interior",
  "marking",
]);

/**
 * The photos the tag-OCR pass should read, in priority order: every tag-typed
 * photo first (input order kept), then the label-like fallbacks, capped. Pure.
 */
export function selectTagOcrPhotos<T extends { type?: string | null }>(
  photos: T[],
  max = 4,
): T[] {
  const tags = photos.filter((p) => p.type && TAG_PHOTO_TYPES.has(p.type));
  const fallbacks = photos.filter(
    (p) => p.type && TAG_OCR_FALLBACK_TYPES.has(p.type),
  );
  return [...tags, ...fallbacks].slice(0, max);
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read src/tests/ai-tag-ocr_test.ts`
Expected: PASS (all, including the three new ones).

- [x] **Step 5: Wire `id` through `loadItemPhotoUrls` and use the helper in `generateListing`**

In `ai-listing.ts`:

```ts
export interface ListingGenPhoto {
  url: string;
  // flipdesk_photo_type hint, e.g. front | back | tag | tag_2 | detail |
  // detail_2..4 | interior | defect | flatlay | on_model | measurement_*
  type?: string;
  /** item_photos.id, when the photo came off the item (generation path). */
  id?: string;
}
```

`loadItemPhotoUrls`: change the select to `"id, photo_type, photo_role, storage_path, sort_order, photo_url"`, type the rows as `(ItemPhotoUrlRow & { id: string })[]`, and return `{ url, type: row.photo_type ?? "", id: row.id }`.

At `:2223`, replace

```ts
  const tagPhotos = photos
    .filter((p) => p.type && TAG_PHOTO_TYPES.has(p.type))
    .slice(0, MAX_TAG_OCR_PHOTOS);
```

with

```ts
  let tagPhotos = selectTagOcrPhotos(photos, MAX_TAG_OCR_PHOTOS);
```

(`let` because Task 2 reassigns it.) Update the `ai-tag-ocr.ts` import block to import `selectTagOcrPhotos` instead of `TAG_PHOTO_TYPES` if nothing else in the file uses `TAG_PHOTO_TYPES` (grep first; keep it if it does).

- [x] **Step 6: Type-check and run the listing budget tests**

Run: `deno check src/main.ts && deno test --allow-env --allow-read src/tests/listing-photo-budget_test.ts src/tests/ai-tag-ocr_test.ts`
Expected: clean check, PASS.

- [x] **Step 7: Commit**

```bash
git add services/edge-functions/src/lib/ai-tag-ocr.ts services/edge-functions/src/lib/ai-listing.ts services/edge-functions/src/tests/ai-tag-ocr_test.ts
git commit -m "AutoLister: read interior and marking photos as tag-OCR fallbacks

Tag OCR only looked at photos typed tag/tag_2 and ran on 11 of ~300
generations on prod. selectTagOcrPhotos keeps tags first and adds the
two label-like types, still capped at four. internal stays excluded
(US-1549). loadItemPhotoUrls now returns the photo id so the next step
can write a role back.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Server-side tag finding when no photo is typed tag

**Files:**
- Modify: `services/edge-functions/src/lib/ai-tag-ocr.ts` (add `planTagRoleWriteback`)
- Modify: `services/edge-functions/src/lib/ai-listing.ts:2226` (before `if (tagPhotos.length > 0)`)
- Test: `services/edge-functions/src/tests/ai-tag-ocr_test.ts`

**Interfaces:**
- Consumes: `classifyPhotoRoles(photos: {id,url}[]): Promise<{ coverId, roles: Record<string, "front"|"back"|"tag"|"detail"|"defect">, model, tokensIn, tokensOut }>` from `lib/ai-photo-roles.ts`.
- Produces: `export function planTagRoleWriteback<T extends { id?: string; type?: string | null }>(photos: T[], roles: Record<string, string>): { tagPhotos: T[]; writeback: string[] }` — `tagPhotos` are the photos the classifier called `tag`; `writeback` is the subset of their ids whose current type is `detail` or empty (the only ones we may relabel).

- [x] **Step 1: Write the failing tests** (append; add `planTagRoleWriteback` to the import)

```ts
Deno.test("planTagRoleWriteback: classifier tags become OCR photos; only detail rows are relabelled", () => {
  const photos = [
    { id: "a", type: "front" },
    { id: "b", type: "detail" },
    { id: "c", type: "" },
    { id: "d", type: "back" },
  ];
  const { tagPhotos, writeback } = planTagRoleWriteback(photos, {
    a: "front",
    b: "tag",
    c: "tag",
    d: "tag", // seller typed it back; the classifier does not get to change that
  });
  assertEquals(tagPhotos.map((p) => p.id), ["b", "c", "d"]);
  assertEquals(writeback, ["b", "c"]);
});

Deno.test("planTagRoleWriteback: no tag in the roles yields nothing", () => {
  const { tagPhotos, writeback } = planTagRoleWriteback(
    [{ id: "a", type: "detail" }],
    { a: "detail" },
  );
  assertEquals(tagPhotos, []);
  assertEquals(writeback, []);
});
```

- [x] **Step 2: Run to verify it fails**

Run: `deno test --allow-env --allow-read src/tests/ai-tag-ocr_test.ts`
Expected: FAIL, `planTagRoleWriteback is not a function`.

- [x] **Step 3: Implement** in `ai-tag-ocr.ts` after `selectTagOcrPhotos`:

```ts
/**
 * 2026-09-02: what to do with a holistic role pass when nothing was typed tag.
 * The photos the classifier called `tag` are read by OCR whatever their stored
 * type; only rows still on the generic `detail` default (or untyped) are
 * relabelled, so a seller's own choice is never clobbered (same guard as the
 * per-photo classifier in flipdesk-ai.ts). Pure.
 */
export function planTagRoleWriteback<
  T extends { id?: string; type?: string | null },
>(photos: T[], roles: Record<string, string>): { tagPhotos: T[]; writeback: string[] } {
  const tagPhotos = photos.filter((p) => p.id && roles[p.id] === "tag");
  const writeback = tagPhotos
    .filter((p) => !p.type || p.type === "detail")
    .map((p) => p.id as string);
  return { tagPhotos, writeback };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read src/tests/ai-tag-ocr_test.ts`
Expected: PASS.

- [x] **Step 5: Wire into `generateListing`** just before `if (tagPhotos.length > 0) {` (after Task 1's `let tagPhotos = ...`):

```ts
  // 2026-09-02: on prod, 150 of 1001 items had a tag-typed photo and OCR ran
  // on 11 of ~300 generations - the label was usually sitting under `detail`.
  // When nothing is typed tag, ask the holistic role pass (US-533) which photo
  // is the label, read THAT, and relabel only rows still on the detail
  // default. One vision call, only on this branch, metered as photo_roles.
  if (tagPhotos.length === 0 && photos.length >= 2) {
    const candidates = photos.filter((p): p is ListingGenPhoto & { id: string } =>
      !!p.id
    );
    if (candidates.length >= 2) {
      try {
        const rolePass = await classifyPhotoRoles(
          candidates.map((p) => ({ id: p.id, url: p.url })),
        );
        const plan = planTagRoleWriteback(candidates, rolePass.roles);
        tagPhotos = plan.tagPhotos.slice(0, MAX_TAG_OCR_PHOTOS);
        if (plan.writeback.length > 0) {
          const { error } = await supabaseAdmin
            .from("item_photos")
            .update({ photo_type: "tag" })
            .in("id", plan.writeback)
            .eq("inventory_item_id", itemId);
          if (error) console.warn("[AI Listing] tag role writeback failed:", error.message);
        }
        console.log(
          `[AI Listing] tag search on item ${itemId}: ${tagPhotos.length} label photo(s) found by role pass`,
        );
      } catch (err) {
        console.error("[AI Listing] tag role pass failed (non-fatal):", err);
      }
    }
  }
```

Add `import { classifyPhotoRoles } from "./ai-photo-roles.ts";` and `planTagRoleWriteback` to the `ai-tag-ocr.ts` import block. `itemId` is the owner-verified item loaded in step 1 of `generateListing`, so the `item_photos` write is tenant-scoped through it.

- [x] **Step 6: Type-check**

Run: `deno check src/main.ts && deno lint src/lib/ai-listing.ts src/lib/ai-tag-ocr.ts`
Expected: clean.

- [x] **Step 7: Commit**

```bash
git add services/edge-functions/src/lib/ai-tag-ocr.ts services/edge-functions/src/lib/ai-listing.ts services/edge-functions/src/tests/ai-tag-ocr_test.ts
git commit -m "AutoLister: find the label with the role pass when no photo is typed tag

Bulk uploads rarely type a photo as tag, so the OCR pass had nothing to
read. When the item has no tag-typed photo, run the existing holistic
role classifier, OCR the photos it calls tag, and relabel only rows still
on the detail default.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `lib/listing-style-code.ts`: the code's precedence, decode and canonical spelling

**Files:**
- Create: `services/edge-functions/src/lib/listing-style-code.ts`
- Test: `services/edge-functions/src/tests/listing-style-code_test.ts`
- Modify: `services/edge-functions/src/lib/ai-listing.ts:2296-2304` and `:2369-2375`, plus the `tagAttributes` assignment at `:2234`

**Interfaces:**
- Consumes: `decodeTagCode(brandKey, raw, dbSpecs)` and `DecodeResult` from `lib/brand-decoders.ts`; `decoderSpecsFromPack(pack)`, `BrandKnowledgePack` from `lib/brand-knowledge.ts`; `canonicalStyleCode(brandKey, raw)` from `lib/style-code-observations.ts`; `TagGroundTruth`, `TAG_GROUND_TRUTH_MIN_CONFIDENCE` from `lib/ai-tag-ocr.ts`; `brandKey(raw)` from `lib/brand-normalize.ts`.
- Produces:

```ts
export interface ListingStyleCode {
  /** The code exactly as it will be filed and searched, or null. */
  styleCodeRaw: string | null;
  /** canonicalStyleCode() of the above under the brand key ("" when none). */
  styleCodeNorm: string;
  /** Where styleCodeRaw came from. */
  source: "tag_ocr" | "tag_ocr_mpn" | "item_attribute" | "sneaker_resolver" | null;
  /** Decoder hit inside the brand's pack, when one fired. */
  decoded: DecodeResult | null;
  /** A size the decoder derived (size dot), only when OCR read no size. */
  sizeFromDecoder: string | null;
}
export function resolveListingStyleCode(args: {
  ocr: TagGroundTruth | null;
  itemAttributes: Record<string, unknown> | null | undefined;
  sneakerStyleCode: string | null;
  brand: string | null;
  pack: BrandKnowledgePack | null;
  minConfidence?: number;
}): ListingStyleCode;
```

- [x] **Step 1: Write the failing tests** in `src/tests/listing-style-code_test.ts`

```ts
// 2026-09-02: which style code a listing files under, and what the brand
// decoders make of it. Pure; dummy env because brand-knowledge imports supabase.
//   deno test --allow-env --allow-read src/tests/listing-style-code_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { resolveListingStyleCode } = await import("../lib/listing-style-code.ts");
const { assembleBrandKnowledgePack } = await import("../lib/brand-knowledge.ts");

// A Lululemon pack with NO db decoder rows, so decodeTagCode falls back to the
// in-code DEFAULT_DECODER_SPECS (style_number + size_dot).
const lulu = assembleBrandKnowledgePack({
  rawBrand: "Lululemon",
  brandRow: null,
  styleRows: [],
  codeRows: [],
  colorwayRows: [],
  chartRows: [],
  fallbackCharts: [],
  category: null,
});

Deno.test("OCR style code outranks the item attribute and the sneaker resolver", () => {
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "LW3CWDS", confidence: 0.9 } },
    itemAttributes: { mpn: "OLD-1" },
    sneakerStyleCode: "DD1391-100",
    brand: "Lululemon",
    pack: lulu,
  });
  assertEquals(r.styleCodeRaw, "LW3CWDS");
  assertEquals(r.source, "tag_ocr");
  assertEquals(r.styleCodeNorm, "LW3CWDS");
});

Deno.test("a low-confidence OCR read is skipped in favour of the stored mpn", () => {
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "LW3CWDS", confidence: 0.2 } },
    itemAttributes: { mpn: "LW7DVCS" },
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack: lulu,
  });
  assertEquals(r.styleCodeRaw, "LW7DVCS");
  assertEquals(r.source, "item_attribute");
});

Deno.test("the sneaker resolver is the last resort", () => {
  const r = resolveListingStyleCode({
    ocr: null,
    itemAttributes: null,
    sneakerStyleCode: "DD1391-100",
    brand: "Nike",
    pack: null,
  });
  assertEquals(r.styleCodeRaw, "DD1391-100");
  assertEquals(r.source, "sneaker_resolver");
  assertEquals(r.decoded, null);
});

Deno.test("a Lululemon 2019+ code decodes inside its pack and the dot spelling canonicalises", () => {
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "LW6AMYSP60417", confidence: 0.85 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack: lulu,
  });
  assert(r.decoded, "expected a decoder hit");
  // US-2714: the dot's long form files under the six-character style number.
  assertEquals(r.styleCodeNorm, "W6AMYS");
});

Deno.test("decoder size fills only when OCR read no size", () => {
  // The Lululemon size dot: a bare number printed in the pocket circle.
  const withSize = resolveListingStyleCode({
    ocr: { style_code: { value: "8", confidence: 0.9 }, size: { value: "6", confidence: 0.9 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack: lulu,
  });
  assertEquals(withSize.sizeFromDecoder, null);
  const noSize = resolveListingStyleCode({
    ocr: { style_code: { value: "8", confidence: 0.9 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Lululemon",
    pack: lulu,
  });
  assertEquals(noSize.sizeFromDecoder, "8");
  // A bare size-dot number is not a style code to file under.
  assertEquals(noSize.styleCodeRaw, null);
});

Deno.test("no brand pack: the raw code is kept, nothing decodes", () => {
  const r = resolveListingStyleCode({
    ocr: { style_code: { value: "ABC-123", confidence: 0.9 } },
    itemAttributes: null,
    sneakerStyleCode: null,
    brand: "Some Brand",
    pack: null,
  });
  assertEquals(r.styleCodeRaw, "ABC-123");
  assertEquals(r.decoded, null);
  assertEquals(r.styleCodeNorm, "ABC123");
});
```

Before writing the pack fixture, open `lib/brand-knowledge.ts:234` and copy `assembleBrandKnowledgePack`'s real parameter shape; the object above is the intended shape and must match the actual signature. If the function takes positional arguments, adapt the fixture, not the function.

- [x] **Step 2: Run to verify it fails**

Run: `deno test --allow-env --allow-read src/tests/listing-style-code_test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Implement** `src/lib/listing-style-code.ts`

```ts
// 2026-09-02: which style code a listing files under, and what the brand
// decoders make of it.
//
// generateListing used to hand the OCR'd code to resolveStyleCode, which is
// the SNEAKER resolver (Nike/Jordan/adidas/New Balance shapes). For every
// apparel brand it returned null, so styleCodeRaw was null, the Style Code
// aspect stayed empty, and every mined product name was dropped with "no style
// code to file them under". Prod on 2026-09-02: 1001 items, 0 Style Code
// aspects, 71 Lululemon items with no product name in the title.
//
// PRECEDENCE, strongest first: the label the OCR just read; the label's MPN
// field; what an earlier pass stored on attributes.mpn; the sneaker resolver.
// The sneaker resolver keeps its comp-query and brand role for sneakers; it no
// longer decides whether apparel has a code.
//
// A decoder runs INSIDE the pack the tag's brand selected (decoder bar,
// vault/20-domain/brands/brand-kb-decoder-bar.md). A hit cannot spell a brand
// onto a foreign tag; it can canonicalise the spelling (US-2714) and recover a
// size from a size dot. Pure.

import { decodeTagCode, type DecodeResult } from "./brand-decoders.ts";
import { type BrandKnowledgePack, decoderSpecsFromPack } from "./brand-knowledge.ts";
import { brandKey as toBrandKey } from "./brand-normalize.ts";
import { canonicalStyleCode } from "./style-code-observations.ts";
import { TAG_GROUND_TRUTH_MIN_CONFIDENCE, type TagGroundTruth } from "./ai-tag-ocr.ts";

export interface ListingStyleCode {
  /** The code exactly as it will be filed and searched, or null. */
  styleCodeRaw: string | null;
  /** canonicalStyleCode() of the above under the brand key ("" when none). */
  styleCodeNorm: string;
  /** Where styleCodeRaw came from. */
  source: "tag_ocr" | "tag_ocr_mpn" | "item_attribute" | "sneaker_resolver" | null;
  /** Decoder hit inside the brand's pack, when one fired. */
  decoded: DecodeResult | null;
  /** A size the decoder derived (size dot), only when OCR read no size. */
  sizeFromDecoder: string | null;
}

function confident(
  field: { value: string; confidence: number } | undefined,
  min: number,
): string | null {
  if (!field) return null;
  const v = field.value.trim();
  return v !== "" && field.confidence >= min ? v : null;
}

function storedString(attrs: Record<string, unknown> | null | undefined, key: string): string | null {
  const raw = attrs?.[key];
  const s = Array.isArray(raw) ? raw[0] : raw;
  return typeof s === "string" && s.trim() !== "" ? s.trim() : null;
}

export function resolveListingStyleCode(args: {
  ocr: TagGroundTruth | null;
  itemAttributes: Record<string, unknown> | null | undefined;
  sneakerStyleCode: string | null;
  brand: string | null;
  pack: BrandKnowledgePack | null;
  minConfidence?: number;
}): ListingStyleCode {
  const min = args.minConfidence ?? TAG_GROUND_TRUTH_MIN_CONFIDENCE;
  const key = args.pack?.key ?? (args.brand ? toBrandKey(args.brand) : "");
  const specs = args.pack ? decoderSpecsFromPack(args.pack) : [];
  const ocrSize = confident(args.ocr?.size, min);

  // Candidates in precedence order. Each is decoded on its own so a size-dot
  // number (which decodes but names no style) does not shadow a real code.
  const candidates: Array<{ code: string; source: ListingStyleCode["source"] }> = [];
  const ocrCode = confident(args.ocr?.style_code, min);
  if (ocrCode) candidates.push({ code: ocrCode, source: "tag_ocr" });
  const ocrMpn = storedString(
    args.ocr as Record<string, unknown> | null,
    "mpn",
  );
  if (ocrMpn) candidates.push({ code: ocrMpn, source: "tag_ocr_mpn" });
  const stored = storedString(args.itemAttributes, "mpn");
  if (stored) candidates.push({ code: stored, source: "item_attribute" });
  if (args.sneakerStyleCode?.trim()) {
    candidates.push({ code: args.sneakerStyleCode.trim(), source: "sneaker_resolver" });
  }

  let sizeFromDecoder: string | null = null;
  for (const c of candidates) {
    const hit = key && specs !== undefined ? decodeTagCode(key, c.code, specs) : null;
    if (hit?.size && !ocrSize && !sizeFromDecoder) sizeFromDecoder = hit.size;
    // A hit that names no style (a bare size dot) is not a code to file under.
    if (hit && !hit.styleCode && hit.size) continue;
    return {
      styleCodeRaw: c.code,
      styleCodeNorm: canonicalStyleCode(key, c.code),
      source: c.source,
      decoded: hit,
      sizeFromDecoder,
    };
  }
  return {
    styleCodeRaw: null,
    styleCodeNorm: "",
    source: null,
    decoded: null,
    sizeFromDecoder,
  };
}
```

Note: `TagGroundTruth` has no `mpn` field today; the `ocrMpn` read is defensive against a future OCR field and the cast keeps the type honest. If `deno check` rejects the cast, drop the `tag_ocr_mpn` candidate and its enum member.

- [x] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read src/tests/listing-style-code_test.ts`
Expected: PASS. If the `LW6AMYSP60417` case fails on `styleCodeNorm`, read `canonicalStyleCode` and the `style_number_full` default spec in `brand-decoders.ts` and adjust the EXPECTED value to what US-2714 actually files (`canonicalCode` of the hit); do not loosen the assertion to "truthy".

- [x] **Step 5: Wire into `generateListing`**

Keep a handle on the OCR fields: at `:2228` change `const ocr = await extractTagGroundTruth(...)` so the fields survive the block. Declare `let tagOcrFields: TagGroundTruth | null = null;` next to `tagOcrModel` and set `tagOcrFields = ocr.fields;` after the merge. Import `type TagGroundTruth` from `./ai-tag-ocr.ts`.

At `:2296-2304`, after `const styleResolution = resolveStyleCode(rawStyle, canonicalBrand);` add:

```ts
  // 2026-09-02: the code the LISTING files under, decoded inside the brand's
  // own pack (lib/listing-style-code.ts). resolveStyleCode above is the sneaker
  // resolver and returns null for every apparel brand; it used to be the only
  // source, which is why prod had zero Style Code aspects.
  let brandPack: BrandKnowledgePack | null = null;
  try {
    brandPack = await resolveBrandKnowledgePack(normalizedBrand, {
      category: item.garment_type ?? item.garment_category ?? null,
    });
  } catch (err) {
    console.error("[AI Listing] brand pack read failed (non-fatal):", err);
  }
  const listingCode = resolveListingStyleCode({
    ocr: tagOcrFields,
    itemAttributes: item.attributes as Record<string, unknown> | null,
    sneakerStyleCode: styleResolution?.styleCode ?? null,
    brand: normalizedBrand,
    pack: brandPack,
  });
  if (listingCode.styleCodeRaw) {
    // The canonical spelling is what lands on attributes.mpn and therefore on
    // the Style Code / MPN aspect (US-2714: one spelling per garment).
    tagAttributes = { ...tagAttributes, mpn: listingCode.styleCodeNorm || listingCode.styleCodeRaw };
    if (typeof knownFields.style !== "string" || knownFields.style === listingCode.styleCodeRaw) {
      knownFields.style_code = listingCode.styleCodeRaw;
    }
  }
  if (listingCode.sizeFromDecoder && String(knownFields.size ?? "").trim() === "") {
    knownFields.size = listingCode.sizeFromDecoder;
  }
```

`resolveBrandKnowledgePack` is already imported; add `import type { BrandKnowledgePack } from "./brand-knowledge.ts";` and `import { resolveListingStyleCode } from "./listing-style-code.ts";`.

Then MOVE the size-estimate block (`2b-ii`, `:2244-2284`) so it runs AFTER this step: cut the whole `let sizeTokensIn ... }` block and paste it directly after the code above. The estimate only fires when `knownFields.size` is still blank, so a decoder size now suppresses it (spec B).

At `:2369-2375` change the two lines:

```ts
    decodedStyleName: styleResolution?.aspects.Model?.[0] ?? null,
    styleCodeRaw: listingCode.styleCodeRaw,
```

(Task 4 replaces `decodedStyleName` again.)

- [x] **Step 6: Type-check, lint, run the affected suites**

Run: `deno check src/main.ts && deno lint src/lib && deno test --allow-env --allow-read --allow-net src/tests/listing-style-code_test.ts src/tests/ai-tag-ocr_test.ts src/tests/listing-gen-blocks_test.ts src/tests/brand-enrich_test.ts`
Expected: clean, PASS.

- [x] **Step 7: Commit**

```bash
git add services/edge-functions/src/lib/listing-style-code.ts services/edge-functions/src/tests/listing-style-code_test.ts services/edge-functions/src/lib/ai-listing.ts
git commit -m "AutoLister: file the listing under the OCR'd style code, decoded in its brand pack

resolveStyleCode is the sneaker resolver and returned null for every
apparel brand, so styleCodeRaw was null, the Style Code aspect never
filled and mined product names were dropped. resolveListingStyleCode
orders the sources (label read, stored mpn, sneaker resolver), decodes
inside the brand's pack, canonicalises the spelling (US-2714) and lets a
size-dot decode stand in for a missing size before the estimate pass.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: The product name from the style-code index, into title facts and the Model aspect

**Files:**
- Modify: `services/edge-functions/src/lib/listing-style-code.ts` (add `applyLearnedStyleToListing`)
- Modify: `services/edge-functions/src/lib/aspect-registry.ts:244` (add a `model` entry before `mpn`; bump `version` 5 to 6)
- Modify: `services/edge-functions/src/lib/ai-listing.ts` (call site after Task 3's block)
- Test: `services/edge-functions/src/tests/listing-style-code_test.ts`, `services/edge-functions/src/tests/aspect-registry_test.ts` (find the existing registry test file with `ls src/tests | grep aspect-registry`; if none, create `aspect-registry-model_test.ts`)

**Interfaces:**
- Consumes: `lookupLearnedStyle(brandKey, styleCodeRaw): Promise<LearnedStyle | null>` where `LearnedStyle = { productTitle, seenCount, confidence, evidenceUrl, resolvedName?, resolvedSource? }`; `styleNameFromTitle(title, brand, code): string | null`; both from `lib/style-code-observations.ts`. `VisualCandidate` from `lib/visual-candidates.ts` (read its shape at the top of that file: `{ field, value, source, support?, evidence? }` or similar, and copy the exact fields used by `corroborateMinedStyleNames` at `ai-listing.ts:1214`).
- Produces:

```ts
export interface LearnedStyleForListing {
  /** A RESOLVED product name (official/admin/seller/consensus/corroborated public). */
  resolvedName: string | null;
  resolvedSource: string | null;
  /** An observation-only guess (trimmed listing title), never a fact. */
  candidateName: string | null;
  confidence: number;
}
export function learnedStyleForListing(learned: LearnedStyle | null, brand: string | null, code: string | null): LearnedStyleForListing;
export function applyLearnedStyleToListing(args: {
  learned: LearnedStyleForListing;
  knownFields: Record<string, unknown>;
  tagGroundTruth: Record<string, string> | undefined;
  tagAttributes: Record<string, string>;
  sellerTypedStyle: string | null;
}): { knownFields: Record<string, unknown>; tagGroundTruth: Record<string, string> | undefined; tagAttributes: Record<string, string> };
```

- [x] **Step 1: Write the failing tests** (append to `listing-style-code_test.ts`; add the two functions to the import)

```ts
Deno.test("learnedStyleForListing: a resolved name is a fact, an observation is only a candidate", () => {
  const resolved = learnedStyleForListing(
    { productTitle: "Scuba Oversized Half-Zip", seenCount: 4, confidence: 0.8, evidenceUrl: null, resolvedName: "Scuba Oversized Half-Zip", resolvedSource: "consensus" },
    "Lululemon",
    "LW3CWDS",
  );
  assertEquals(resolved.resolvedName, "Scuba Oversized Half-Zip");
  assertEquals(resolved.candidateName, null);

  const observed = learnedStyleForListing(
    { productTitle: "Lululemon Scuba Oversized Half Zip LW3CWDS Womens Size 6 Black EUC", seenCount: 2, confidence: 0.5, evidenceUrl: null },
    "Lululemon",
    "LW3CWDS",
  );
  assertEquals(observed.resolvedName, null);
  assert(observed.candidateName && observed.candidateName.toLowerCase().includes("scuba"));

  assertEquals(learnedStyleForListing(null, "Lululemon", "LW3CWDS").resolvedName, null);
});

Deno.test("applyLearnedStyleToListing: fills style, the ground-truth block and attributes.model, fill-only", () => {
  const out = applyLearnedStyleToListing({
    learned: { resolvedName: "Scuba Oversized Half-Zip", resolvedSource: "consensus", candidateName: null, confidence: 0.8 },
    knownFields: { brand: "Lululemon", style: "LW3CWDS" },
    tagGroundTruth: { brand: "Lululemon" },
    tagAttributes: { mpn: "LW3CWDS" },
    sellerTypedStyle: null,
  });
  assertEquals(out.knownFields.style, "Scuba Oversized Half-Zip");
  assertEquals(out.tagGroundTruth?.style_name, "Scuba Oversized Half-Zip");
  assertEquals(out.tagAttributes.model, "Scuba Oversized Half-Zip");
  assertEquals(out.tagAttributes.mpn, "LW3CWDS");
});

Deno.test("applyLearnedStyleToListing: a seller-typed style is never replaced; a candidate writes nothing", () => {
  const typed = applyLearnedStyleToListing({
    learned: { resolvedName: "Scuba Oversized Half-Zip", resolvedSource: "consensus", candidateName: null, confidence: 0.8 },
    knownFields: { style: "Hooded Scuba" },
    tagGroundTruth: undefined,
    tagAttributes: {},
    sellerTypedStyle: "Hooded Scuba",
  });
  assertEquals(typed.knownFields.style, "Hooded Scuba");
  assertEquals(typed.tagGroundTruth?.style_name, "Scuba Oversized Half-Zip");
  assertEquals(typed.tagAttributes.model, "Scuba Oversized Half-Zip");

  const guess = applyLearnedStyleToListing({
    learned: { resolvedName: null, resolvedSource: null, candidateName: "Scuba Oversized Half Zip", confidence: 0.5 },
    knownFields: {},
    tagGroundTruth: undefined,
    tagAttributes: {},
    sellerTypedStyle: null,
  });
  assertEquals(guess.knownFields.style, undefined);
  assertEquals(guess.tagGroundTruth, undefined);
  assertEquals(guess.tagAttributes.model, undefined);
});
```

And the registry test (new file `src/tests/aspect-registry-model_test.ts`):

```ts
// 2026-09-02: attributes.model projects onto the leaf's Model aspect, fill-only.
//   deno test --allow-env src/tests/aspect-registry-model_test.ts
import { assertEquals } from "@std/assert";
import { ASPECT_REGISTRY, resolveItemAspects } from "../lib/aspect-registry.ts";

const aspects = [
  { name: "Model", mode: "FREE_TEXT" as const, multi: false, allowedValues: [] as string[] },
  { name: "Style Code", mode: "FREE_TEXT" as const, multi: false, allowedValues: [] as string[] },
];

Deno.test("attributes.model fills Model; attributes.mpn fills Style Code", () => {
  const out = resolveItemAspects(
    { item_category: "clothing", attributes: { model: "Scuba Oversized Half-Zip", mpn: "LW3CWDS" } },
    aspects,
    {},
  );
  assertEquals(out.Model, ["Scuba Oversized Half-Zip"]);
  assertEquals(out["Style Code"], ["LW3CWDS"]);
});

Deno.test("Model is never overwritten when already set", () => {
  const out = resolveItemAspects(
    { item_category: "clothing", attributes: { model: "Scuba" } },
    aspects,
    { Model: ["Define Jacket"] },
  );
  assertEquals(out.Model, undefined);
});

Deno.test("registry version bumped for the model entry", () => {
  assertEquals(ASPECT_REGISTRY.entries.some((e) => e.key === "model"), true);
  assertEquals(ASPECT_REGISTRY.version >= 6, true);
});
```

Check `RegistryAspect`'s `mode` union in `aspect-registry.ts` and use its real member (it may be `"FREE_TEXT" | "SELECTION_ONLY"`); adapt the fixture's `mode` literal to it.

- [x] **Step 2: Run to verify it fails**

Run: `deno test --allow-env --allow-read src/tests/listing-style-code_test.ts src/tests/aspect-registry-model_test.ts`
Expected: FAIL (functions missing; `Model` undefined; no `model` entry).

- [x] **Step 3: Implement**

`aspect-registry.ts`: bump `version: 5` to `version: 6` and add, immediately BEFORE the `mpn` entry:

```ts
    {
      key: "model",
      source: "attribute",
      attribute: "model",
      multi: false,
      // 2026-09-02: the PRODUCT NAME a style code resolved to in the
      // style-code index ("Scuba Oversized Half-Zip"). Written by the listing
      // path only when the index has a resolved name (never an observation),
      // so a Model aspect here is a name a source in a position to know gave
      // it (vault/20-domain/style-code-index-evidence.md).
      aspects: ["Model", "Model Name", "Style Name"],
    },
```

`listing-style-code.ts`: append

```ts
import { type LearnedStyle, styleNameFromTitle } from "./style-code-observations.ts";

export interface LearnedStyleForListing {
  /** A RESOLVED product name (official/admin/seller/consensus/corroborated public). */
  resolvedName: string | null;
  resolvedSource: string | null;
  /** An observation-only guess (trimmed listing title), never a fact. */
  candidateName: string | null;
  confidence: number;
}

/**
 * Split what the index knows into a fact and a guess. lookupLearnedStyle
 * returns a resolved 00628 name when any source has answered (already gated
 * by pickStyleCodeName: a public submission needs corroboration), else the
 * most-seen listing title. Only the former may be written; the latter is
 * offered to the model under the UNVERIFIED EXTERNAL GUESS block. Pure.
 */
export function learnedStyleForListing(
  learned: LearnedStyle | null,
  brand: string | null,
  code: string | null,
): LearnedStyleForListing {
  if (!learned) return { resolvedName: null, resolvedSource: null, candidateName: null, confidence: 0 };
  if (learned.resolvedName && learned.resolvedName.trim() !== "") {
    return {
      resolvedName: learned.resolvedName.trim(),
      resolvedSource: learned.resolvedSource ?? null,
      candidateName: null,
      confidence: learned.confidence,
    };
  }
  return {
    resolvedName: null,
    resolvedSource: null,
    candidateName: styleNameFromTitle(learned.productTitle, brand, code ?? ""),
    confidence: learned.confidence,
  };
}

/**
 * Put a RESOLVED name where the listing reads facts from: knownFields.style
 * (unless the seller typed a style), the tag ground-truth block as
 * `style_name` (so the title leads with it), and attributes.model (so the
 * registry projects it onto the leaf's Model aspect, fill-only). A candidate
 * writes nothing here. Pure.
 */
export function applyLearnedStyleToListing(args: {
  learned: LearnedStyleForListing;
  knownFields: Record<string, unknown>;
  tagGroundTruth: Record<string, string> | undefined;
  tagAttributes: Record<string, string>;
  sellerTypedStyle: string | null;
}): {
  knownFields: Record<string, unknown>;
  tagGroundTruth: Record<string, string> | undefined;
  tagAttributes: Record<string, string>;
} {
  const name = args.learned.resolvedName;
  if (!name) {
    return { knownFields: args.knownFields, tagGroundTruth: args.tagGroundTruth, tagAttributes: args.tagAttributes };
  }
  const knownFields = { ...args.knownFields };
  if (!args.sellerTypedStyle || args.sellerTypedStyle.trim() === "") knownFields.style = name;
  const tagGroundTruth = { ...(args.tagGroundTruth ?? {}), style_name: name };
  const tagAttributes = { ...args.tagAttributes };
  if (!tagAttributes.model) tagAttributes.model = name;
  return { knownFields, tagGroundTruth, tagAttributes };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read src/tests/listing-style-code_test.ts src/tests/aspect-registry-model_test.ts`
Expected: PASS.

- [x] **Step 5: Wire into `generateListing`** directly after Task 3's block (before the moved size-estimate block):

```ts
  // 2026-09-02: what the style-code index knows this code to be. A resolved
  // name (a source in a position to know) becomes a title fact and the Model
  // aspect; an observation-only name is offered to the model as an unverified
  // candidate and written nowhere.
  let learnedForListing: LearnedStyleForListing = {
    resolvedName: null, resolvedSource: null, candidateName: null, confidence: 0,
  };
  if (listingCode.styleCodeRaw && (brandPack?.key || normalizedBrand)) {
    try {
      const learned = await lookupLearnedStyle(
        brandPack?.key ?? brandKey(normalizedBrand as string),
        listingCode.styleCodeRaw,
      );
      learnedForListing = learnedStyleForListing(learned, normalizedBrand, listingCode.styleCodeRaw);
      const applied = applyLearnedStyleToListing({
        learned: learnedForListing,
        knownFields,
        tagGroundTruth,
        tagAttributes,
        sellerTypedStyle: item.style ?? null,
      });
      Object.assign(knownFields, applied.knownFields);
      tagGroundTruth = applied.tagGroundTruth;
      tagAttributes = applied.tagAttributes;
    } catch (err) {
      console.error("[AI Listing] learned style lookup failed (non-fatal):", err);
    }
  }
```

Imports: `lookupLearnedStyle` from `./style-code-observations.ts` (extend the existing import), `brandKey` from `./brand-normalize.ts` (check whether `ai-listing.ts` already imports something from it and extend that line), `learnedStyleForListing, applyLearnedStyleToListing, type LearnedStyleForListing` from `./listing-style-code.ts`.

Then at the `corroborateMinedStyleNames` call (`:2369`) set `decodedStyleName: learnedForListing.resolvedName ?? styleResolution?.aspects.Model?.[0] ?? null,`.

And in the `generateListingFields` call, append the candidate when there is one. Read `corroborateMinedStyleNames`'s `offered.push({ field: "style", ... })` at `:1214-1225` and build the same shape:

```ts
  const learnedCandidate: VisualCandidate[] = learnedForListing.candidateName
    ? [{ ...copy the exact fields used at :1214, with value: learnedForListing.candidateName, source: "style_code_index" ... }]
    : [];
```

and pass `visualCandidates: [...visual.candidates, ...styleFromVisual, ...learnedCandidate]`. If `VisualCandidate.source` is a closed union without a fitting member, use the same source `corroborateMinedStyleNames` uses and put "style-code index observation" in its evidence text.

- [x] **Step 6: Type-check, lint, run suites**

Run: `deno check src/main.ts && deno lint src/lib && deno test --allow-env --allow-read --allow-net src/tests/listing-style-code_test.ts src/tests/aspect-registry-model_test.ts src/tests/listing-gen-blocks_test.ts src/tests/aspect-reconcile_test.ts`
Expected: clean, PASS. If a test asserts `ASPECT_REGISTRY.version === 5` or an entry count, update that assertion (the bump is intentional).

- [x] **Step 7: Commit**

```bash
git add services/edge-functions/src/lib/listing-style-code.ts services/edge-functions/src/lib/aspect-registry.ts services/edge-functions/src/lib/ai-listing.ts services/edge-functions/src/tests/listing-style-code_test.ts services/edge-functions/src/tests/aspect-registry-model_test.ts
git commit -m "AutoLister: name the product from the style-code index

The listing path never read style_code_names, so a Lululemon item with a
legible code still titled itself 'Pullover'. A resolved name now becomes
knownFields.style, a style_name line in the tag ground-truth block and
attributes.model, which the registry projects onto the leaf's Model
aspect. Observation-only names are offered as an unverified candidate
and written nowhere.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: The RN: corroborate, lower confidence on contradiction, record a sighting

**Files:**
- Create: `services/edge-functions/src/lib/listing-registered-number.ts`
- Test: `services/edge-functions/src/tests/listing-registered-number_test.ts`
- Modify: `services/edge-functions/src/lib/ai-listing.ts` (after Task 4's block; and where `fieldConfidence` is declared at `:2531`)

**Interfaces:**
- Consumes: `assessRegisteredNumber(raw, declaredBrand, index, registrants?) : { outcome: "unparsed"|"no_reference"|"corroborates"|"ambiguous"|"contradicts", normalized, owners, registrant, note }`, `getRegisteredNumberContext(): Promise<{ index, registrants? , ... }>` (read its return type at `registered-numbers.ts:409`), `recordRegisteredNumberSighting(assessment, declaredBrand)` from `lib/registered-numbers.ts`.
- Produces:

```ts
export const RN_CONTRADICTION_BRAND_CONFIDENCE = 0.5;
export interface ListingRnPlan {
  outcome: RegisteredNumberAssessment["outcome"];
  note: string;
  /** Fill-only attribute writes. */
  attributes: Record<string, string>;
  /** brand confidence to apply (min with existing) when the RN contradicts. */
  brandConfidenceCap: number | null;
  /** True when the number should be recorded as a sighting. */
  recordSighting: boolean;
}
export function planListingRegisteredNumber(args: {
  rn: string | null;
  declaredBrand: string | null;
  existingAttributes: Record<string, unknown> | null | undefined;
  assessment: RegisteredNumberAssessment;
}): ListingRnPlan;
```

- [x] **Step 1: Write the failing tests** `src/tests/listing-registered-number_test.ts`

```ts
// 2026-09-02: what the AutoLister does with the RN the tag OCR reads.
//   deno test --allow-env --allow-read src/tests/listing-registered-number_test.ts
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { planListingRegisteredNumber, RN_CONTRADICTION_BRAND_CONFIDENCE } = await import(
  "../lib/listing-registered-number.ts"
);
const { assessRegisteredNumber } = await import("../lib/registered-numbers.ts");

const index = new Map([
  ["RN:106259", [{ brandKey: "lululemon", canonicalBrand: "Lululemon" }]],
  ["RN:66170", [
    { brandKey: "urbanoutfitters", canonicalBrand: "Urban Outfitters" },
    { brandKey: "freepeople", canonicalBrand: "Free People" },
  ]],
]);
const registrants = new Map([["RN:106259", "lululemon athletica canada inc."]]);

function plan(rn: string | null, brand: string | null, existing: Record<string, unknown> = {}) {
  return planListingRegisteredNumber({
    rn,
    declaredBrand: brand,
    existingAttributes: existing,
    assessment: assessRegisteredNumber(rn, brand, index, registrants),
  });
}

Deno.test("corroborates: stores the number and registrant, no cap, no sighting", () => {
  const p = plan("RN 106259", "Lululemon");
  assertEquals(p.outcome, "corroborates");
  assertEquals(p.attributes, { rn: "RN 106259", rn_registrant: "lululemon athletica canada inc." });
  assertEquals(p.brandConfidenceCap, null);
  assertEquals(p.recordSighting, false);
});

Deno.test("ambiguous (shared registrant): consistent, stored, no cap", () => {
  const p = plan("66170", "Free People");
  assertEquals(p.outcome, "ambiguous");
  assertEquals(p.attributes.rn, "66170");
  assertEquals(p.brandConfidenceCap, null);
});

Deno.test("contradicts: caps brand confidence for review, never writes a brand, still stores the number", () => {
  const p = plan("RN 106259", "Nike");
  assertEquals(p.outcome, "contradicts");
  assertEquals(p.brandConfidenceCap, RN_CONTRADICTION_BRAND_CONFIDENCE);
  assertEquals(p.attributes.rn, "RN 106259");
  assertEquals("brand" in p.attributes, false);
  assertEquals(p.recordSighting, false);
});

Deno.test("no_reference: stores the number and asks for a sighting; never a cap", () => {
  const p = plan("RN 999999", "Nike");
  assertEquals(p.outcome, "no_reference");
  assertEquals(p.recordSighting, true);
  assertEquals(p.brandConfidenceCap, null);
  assertEquals(p.attributes, { rn: "RN 999999" });
});

Deno.test("unparsed or empty: nothing", () => {
  assertEquals(plan("LW3CWDS", "Lululemon").attributes, {});
  assertEquals(plan(null, "Lululemon").recordSighting, false);
});

Deno.test("fill-only: an rn the seller already stored is kept", () => {
  const p = plan("RN 106259", "Lululemon", { rn: "RN 12345" });
  assertEquals("rn" in p.attributes, false);
});
```

Confirm the owner object shape (`{ brandKey, canonicalBrand }`) against `RegisteredNumberOwner` in `registered-numbers.ts` before running; adjust the fixture, not the code under test.

- [x] **Step 2: Run to verify it fails**

Run: `deno test --allow-env --allow-read src/tests/listing-registered-number_test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Implement** `src/lib/listing-registered-number.ts`

```ts
// 2026-09-02: what the AutoLister does with the RN the tag OCR reads.
//
// Until now the number reached the prompt as knownFields.rn_number and was
// then dropped: no registry check, no sighting, nothing stored. The grading
// pipeline has done the cross-check since US-2211; this is the same rule on
// the listing side, and the same three refusals
// (vault/40-growth/rn-lookup.md):
//   - an RN names the COMPANY, never the brand, so it corroborates or lowers
//     confidence and never writes `brand`;
//   - `no_reference` is the normal case and is not a negative signal;
//   - a contradiction is review, never a conclusion.
//
// Pure. The caller does the two side effects (fieldConfidence cap, sighting).

import type { RegisteredNumberAssessment } from "./registered-numbers.ts";

/** Below LISTING_REVIEW_CONFIDENCE (0.7), so the draft lands in review. */
export const RN_CONTRADICTION_BRAND_CONFIDENCE = 0.5;

export interface ListingRnPlan {
  outcome: RegisteredNumberAssessment["outcome"];
  note: string;
  /** Fill-only attribute writes. */
  attributes: Record<string, string>;
  /** brand confidence to apply (min with existing) when the RN contradicts. */
  brandConfidenceCap: number | null;
  /** True when the number should be recorded as a sighting. */
  recordSighting: boolean;
}

function has(attrs: Record<string, unknown> | null | undefined, key: string): boolean {
  const v = attrs?.[key];
  return typeof v === "string" ? v.trim() !== "" : Array.isArray(v) ? v.length > 0 : v != null;
}

export function planListingRegisteredNumber(args: {
  rn: string | null;
  declaredBrand: string | null;
  existingAttributes: Record<string, unknown> | null | undefined;
  assessment: RegisteredNumberAssessment;
}): ListingRnPlan {
  const a = args.assessment;
  const base: ListingRnPlan = {
    outcome: a.outcome,
    note: a.note,
    attributes: {},
    brandConfidenceCap: null,
    recordSighting: false,
  };
  const rn = (args.rn ?? "").trim();
  if (a.outcome === "unparsed" || rn === "") return base;

  const attributes: Record<string, string> = {};
  if (!has(args.existingAttributes, "rn")) attributes.rn = rn;
  if (a.registrant && !has(args.existingAttributes, "rn_registrant")) {
    attributes.rn_registrant = a.registrant;
  }
  return {
    ...base,
    attributes,
    brandConfidenceCap: a.outcome === "contradicts" ? RN_CONTRADICTION_BRAND_CONFIDENCE : null,
    recordSighting: a.outcome === "no_reference",
  };
}
```

Check that `RegisteredNumberAssessment` is exported from `registered-numbers.ts` (grep `export interface RegisteredNumberAssessment`); export it if it is not.

- [x] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read src/tests/listing-registered-number_test.ts`
Expected: PASS.

- [x] **Step 5: Wire into `generateListing`**

`fieldConfidence` is declared at `:2531`, AFTER the point where this runs. Hoist it: move `const fieldConfidence: Record<string, number> = {};` up to just before the Task 3 block (search the file for other declarations of the same name first; there is exactly one). Then, after Task 4's block:

```ts
  // 2026-09-02: the RN off the label, checked against the registry. Read on
  // every item since US-543 and discarded until now.
  let rnOutcome = "none";
  const rnRead = typeof knownFields.rn_number === "string" ? knownFields.rn_number : null;
  if (rnRead) {
    try {
      const ctx = await getRegisteredNumberContext();
      const assessment = assessRegisteredNumber(rnRead, normalizedBrand, ctx.index, ctx.registrants);
      const rnPlan = planListingRegisteredNumber({
        rn: rnRead,
        declaredBrand: normalizedBrand,
        existingAttributes: item.attributes as Record<string, unknown> | null,
        assessment,
      });
      rnOutcome = rnPlan.outcome;
      tagAttributes = { ...tagAttributes, ...rnPlan.attributes };
      if (rnPlan.brandConfidenceCap != null) {
        fieldConfidence.brand = Math.min(fieldConfidence.brand ?? 1, rnPlan.brandConfidenceCap);
        console.warn(`[AI Listing] RN contradicts brand on item ${itemId}: ${rnPlan.note}`);
      }
      if (rnPlan.recordSighting) void recordRegisteredNumberSighting(assessment, normalizedBrand);
    } catch (err) {
      console.error("[AI Listing] RN cross-check failed (non-fatal):", err);
    }
  }
```

Read `getRegisteredNumberContext`'s return type; if the registrants map is under another name, use that. Imports: `assessRegisteredNumber, getRegisteredNumberContext, recordRegisteredNumberSighting` from `./registered-numbers.ts`; `planListingRegisteredNumber` from `./listing-registered-number.ts`.

Verify that the later line `fieldConfidence[name] = sug.confidence` (`:2594`) and `Object.assign(fieldConfidence, applied.confidence)` do not RAISE `brand` back above the cap: after the refine loop, add

```ts
  if (rnOutcome === "contradicts") {
    fieldConfidence.brand = Math.min(fieldConfidence.brand ?? 1, RN_CONTRADICTION_BRAND_CONFIDENCE);
  }
```

right before `const needsReview =` (`:2987`), importing the constant.

- [x] **Step 6: Type-check, lint, run suites**

Run: `deno check src/main.ts && deno lint src/lib && deno test --allow-env --allow-read --allow-net src/tests/listing-registered-number_test.ts src/tests/registered-numbers_test.ts src/tests/listing-confidence_test.ts`
Expected: clean, PASS.

- [x] **Step 7: Commit**

```bash
git add services/edge-functions/src/lib/listing-registered-number.ts services/edge-functions/src/tests/listing-registered-number_test.ts services/edge-functions/src/lib/ai-listing.ts
git commit -m "AutoLister: check the label's RN against the registry and record sightings

The OCR read the RN on every item and dropped it. A match now stores the
number and registrant on the item, a contradiction caps brand confidence
so the draft lands in review (never changes the brand), and an unknown
number is recorded as a sighting for the seeder queue and the public
page count.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: One metric line, and the vault notes

**Files:**
- Modify: `services/edge-functions/src/lib/ai-listing.ts` (after Task 5's block)
- Modify: `vault/20-domain/identification-precedence.md`, `vault/40-growth/rn-lookup.md`, `vault/20-domain/style-code-index-evidence.md`

- [x] **Step 1: Add the metric line** after the RN block:

```ts
  console.log(
    `[listing-tag-metric] item=${itemId} brand=${JSON.stringify(normalizedBrand)} ` +
      `tag_photos=${tagPhotos.length} code=${JSON.stringify(listingCode.styleCodeRaw)} ` +
      `code_source=${listingCode.source ?? "none"} decoded=${listingCode.decoded ? 1 : 0} ` +
      `named=${learnedForListing.resolvedName ? 1 : 0} rn=${rnOutcome}`,
  );
```

- [x] **Step 2: Vault** (load the `vault` skill first; it owns the same-commit rule and the note schema). Add to `identification-precedence.md` a dated section "The AutoLister call sites (2026-09-02)" listing `lib/listing-style-code.ts` and `lib/listing-registered-number.ts` in `code_refs`, stating: the decoded style code (row 1) now reaches the listing through `resolveListingStyleCode`; a resolved index name is a known fact, an observation-only name is a candidate; the RN corroborates or caps, never writes brand. Add `services/edge-functions/src/lib/listing-registered-number.ts` to `rn-lookup.md`'s `code_refs` with one paragraph under "The tag reader, and the count it earns" saying the AutoLister now records sightings on `no_reference` through the same RPC. Add one paragraph to `style-code-index-evidence.md` under "Two directions fill the index": the listing path now files mined names under the OCR'd code (was: the sneaker resolver's null), and reads a resolved name back for the title; the backfill script reads and never writes the index. Then run `npm run vault:index && npm run vault:lint` from the repo root.

- [x] **Step 3: Type-check and lint**

Run: `deno check src/main.ts && deno lint src/lib/ai-listing.ts` (in `services/edge-functions`) and `npm run vault:lint` (repo root).
Expected: clean.

- [x] **Step 4: Commit**

```bash
git add services/edge-functions/src/lib/ai-listing.ts vault/
git commit -m "AutoLister: log the tag-to-listing chain per item; record the contract in the vault

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: The backfill: `lib/tag-read-backfill.ts` + `scripts/backfill-tag-reads.ts`

**Files:**
- Create: `services/edge-functions/src/lib/tag-read-backfill.ts`
- Create: `services/edge-functions/scripts/backfill-tag-reads.ts`
- Test: `services/edge-functions/src/tests/tag-read-backfill_test.ts`

**Interfaces:**
- Consumes: `extractTagGroundTruth(photos: {url,type}[]): Promise<TagOcrResult>`, `tagAttributeFill`, `selectTagOcrPhotos` (Task 1) from `lib/ai-tag-ocr.ts`; `resolveListingStyleCode`, `learnedStyleForListing`, `applyLearnedStyleToListing` (Tasks 3/4); `planListingRegisteredNumber` (Task 5); `resolveBrandKnowledgePack`; `lookupLearnedStyle`; `getRegisteredNumberContext`, `assessRegisteredNumber`, `recordRegisteredNumberSighting`; `getCategoryAspects(categoryId)` from `lib/ebay-client.ts`; `deriveInventoryAspects(item, specs, existing)` and `buildAspectSources`? No: read `buildAspectSources` at `ai-listing.ts:1832` and use `mergeSources`-style fill: the script sets `ebay_aspect_sources[name] = "inventory_derived"` only for names it added (copy the literal the generation path writes; grep `inventory_derived` in `ai-listing.ts`). `itemPhotoAiUrls`, `filterListablePhotos` from `lib/item-photo-storage.ts`. `withAiFeature` from `lib/ai-feature-context.ts`.
- Produces:

```ts
export interface BackfillItem {
  id: string;
  user_id: string;
  brand: string | null;
  style: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  title: string | null;
  item_category: string | null;
  garment_type: string | null;
  garment_category: string | null;
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  ebay_aspect_sources: Record<string, string> | null;
  attributes: Record<string, unknown> | null;
}
export interface BackfillPatch {
  attributes: Record<string, unknown> | null;      // full merged map, or null when nothing to write
  ebay_aspects: Record<string, string[]> | null;   // full merged map, or null
  ebay_aspect_sources: Record<string, string> | null;
  addedAttributes: string[];
  addedAspects: string[];
}
export function planBackfillPatch(args: {
  item: BackfillItem;
  tagAttributes: Record<string, string>;   // from tagAttributeFill + code + model + rn
  aspectSpecs: EbayAspectSpec[];            // [] when the item has no leaf
}): BackfillPatch;
export function backfillEligible(item: BackfillItem): boolean;
```

- [x] **Step 1: Write the failing tests** `src/tests/tag-read-backfill_test.ts`

```ts
// 2026-09-02: the read-tags-only backfill writes code, name and RN fields and
// the two aspects, and nothing else.
//   deno test --allow-env --allow-read src/tests/tag-read-backfill_test.ts
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { planBackfillPatch, backfillEligible } = await import("../lib/tag-read-backfill.ts");

const item = {
  id: "i1", user_id: "u1", brand: "Lululemon", style: "Pullover", size: "6", color: "Black",
  material: null, title: "Lululemon Pullover", item_category: "clothing", garment_type: null,
  garment_category: null, ebay_category_id: "53159",
  ebay_aspects: { Brand: ["Lululemon"], Size: ["6"] },
  ebay_aspect_sources: { Brand: "ai_extracted", Size: "ai_extracted" },
  attributes: { garment_care: "Machine wash cold" },
};
const specs = [
  { name: "Style Code", mode: "FREE_TEXT", cardinality: "SINGLE", allowedValues: [], required: false, usage: "RECOMMENDED" },
  { name: "Model", mode: "FREE_TEXT", cardinality: "SINGLE", allowedValues: [], required: false, usage: "RECOMMENDED" },
  { name: "Brand", mode: "FREE_TEXT", cardinality: "SINGLE", allowedValues: [], required: true, usage: "REQUIRED" },
];

Deno.test("writes the code, model and rn attributes and the two aspects; leaves everything else", () => {
  const patch = planBackfillPatch({
    item,
    tagAttributes: { mpn: "LW3CWDS", model: "Scuba Oversized Half-Zip", rn: "RN 106259", rn_registrant: "lululemon athletica" },
    aspectSpecs: specs as never,
  });
  assertEquals(patch.attributes, {
    garment_care: "Machine wash cold",
    mpn: "LW3CWDS",
    model: "Scuba Oversized Half-Zip",
    rn: "RN 106259",
    rn_registrant: "lululemon athletica",
  });
  assertEquals(patch.ebay_aspects, {
    Brand: ["Lululemon"], Size: ["6"],
    "Style Code": ["LW3CWDS"], Model: ["Scuba Oversized Half-Zip"],
  });
  assertEquals(patch.ebay_aspect_sources?.["Style Code"], "inventory_derived");
  assertEquals(patch.ebay_aspect_sources?.Model, "inventory_derived");
  assertEquals(patch.ebay_aspect_sources?.Brand, "ai_extracted");
  assertEquals(patch.addedAspects.sort(), ["Model", "Style Code"]);
});

Deno.test("no leaf: attributes only, aspects untouched", () => {
  const patch = planBackfillPatch({
    item: { ...item, ebay_category_id: null },
    tagAttributes: { mpn: "LW3CWDS" },
    aspectSpecs: [],
  });
  assertEquals(patch.attributes?.mpn, "LW3CWDS");
  assertEquals(patch.ebay_aspects, null);
  assertEquals(patch.addedAspects, []);
});

Deno.test("nothing read: nothing written", () => {
  const patch = planBackfillPatch({ item, tagAttributes: {}, aspectSpecs: specs as never });
  assertEquals(patch.attributes, null);
  assertEquals(patch.ebay_aspects, null);
});

Deno.test("an aspect the seller already set is never replaced", () => {
  const patch = planBackfillPatch({
    item: { ...item, ebay_aspects: { "Style Code": ["TYPED"] } },
    tagAttributes: { mpn: "LW3CWDS" },
    aspectSpecs: specs as never,
  });
  assertEquals(patch.ebay_aspects, null);
  assertEquals(patch.addedAspects, []);
});

Deno.test("eligible only when no code and no rn is stored yet", () => {
  assertEquals(backfillEligible(item), true);
  assertEquals(backfillEligible({ ...item, attributes: { mpn: "X" } }), false);
  assertEquals(backfillEligible({ ...item, attributes: { rn: "RN 1" } }), false);
});
```

Copy the real `EbayAspectSpec` field names from `lib/ebay-client.ts` (grep `export interface EbayAspectSpec`) into the fixture; the `as never` cast is there only so a missing optional field does not fail typing.

- [x] **Step 2: Run to verify it fails**

Run: `deno test --allow-env --allow-read src/tests/tag-read-backfill_test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Implement** `src/lib/tag-read-backfill.ts`

```ts
// 2026-09-02: the pure half of scripts/backfill-tag-reads.ts.
//
// 1001 items on prod were generated before the Style Code aspect could land
// (aspect-registry mpn entry, 293008ffb) and before the listing path decoded
// codes at all. 150 of them already have a tag-typed photo. This plans the
// ONLY writes the backfill may make: attributes.mpn / .model / .rn /
// .rn_registrant and the Style Code (or MPN) and Model aspects when the
// item's leaf exposes them. Title, description, size, brand and every
// listings row are out of scope; a live eBay listing changes only when the
// seller republishes. Fill-only throughout.

import type { EbayAspectSpec } from "./ebay-client.ts";
import { deriveInventoryAspects } from "./ai-listing.ts";
import type { RegistryItem } from "./aspect-registry.ts";

export interface BackfillItem {
  id: string;
  user_id: string;
  brand: string | null;
  style: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  title: string | null;
  item_category: string | null;
  garment_type: string | null;
  garment_category: string | null;
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  ebay_aspect_sources: Record<string, string> | null;
  attributes: Record<string, unknown> | null;
}

export interface BackfillPatch {
  attributes: Record<string, unknown> | null;
  ebay_aspects: Record<string, string[]> | null;
  ebay_aspect_sources: Record<string, string> | null;
  addedAttributes: string[];
  addedAspects: string[];
}

/** The keys the backfill is allowed to add. Anything else in tagAttributes is dropped. */
export const BACKFILL_ATTRIBUTE_KEYS = ["mpn", "model", "rn", "rn_registrant"] as const;

/** The aspect names the backfill is allowed to add (the mpn + model registry entries). */
export const BACKFILL_ASPECT_NAMES = new Set([
  "MPN", "Manufacturer Part Number", "Style Code", "Style Number", "Model Number",
  "Model", "Model Name", "Style Name",
]);

/** Same literal the generation path writes for registry-derived aspects. */
export const INVENTORY_DERIVED = "inventory_derived";

function filled(v: unknown): boolean {
  return typeof v === "string" ? v.trim() !== "" : Array.isArray(v) ? v.length > 0 : v != null;
}

export function backfillEligible(item: BackfillItem): boolean {
  return !filled(item.attributes?.mpn) && !filled(item.attributes?.rn);
}

export function planBackfillPatch(args: {
  item: BackfillItem;
  tagAttributes: Record<string, string>;
  aspectSpecs: EbayAspectSpec[];
}): BackfillPatch {
  const existing = args.item.attributes ?? {};
  const addedAttributes: string[] = [];
  const attributes: Record<string, unknown> = { ...existing };
  for (const key of BACKFILL_ATTRIBUTE_KEYS) {
    const v = args.tagAttributes[key];
    if (!v || v.trim() === "" || filled(existing[key])) continue;
    attributes[key] = v.trim();
    addedAttributes.push(key);
  }
  if (addedAttributes.length === 0) {
    return { attributes: null, ebay_aspects: null, ebay_aspect_sources: null, addedAttributes, addedAspects: [] };
  }

  let ebay_aspects: Record<string, string[]> | null = null;
  let ebay_aspect_sources: Record<string, string> | null = null;
  const addedAspects: string[] = [];
  if (args.aspectSpecs.length > 0) {
    const registryItem: RegistryItem = {
      item_category: args.item.item_category,
      brand: args.item.brand,
      size: args.item.size,
      color: args.item.color,
      material: args.item.material,
      style: args.item.style,
      title: args.item.title,
      attributes: attributes as Record<string, string | string[]>,
    };
    const current = args.item.ebay_aspects ?? {};
    const derived = deriveInventoryAspects(registryItem, args.aspectSpecs, current);
    for (const [name, values] of Object.entries(derived)) {
      if (!BACKFILL_ASPECT_NAMES.has(name)) continue;
      if (filled(current[name])) continue;
      ebay_aspects ??= { ...current };
      ebay_aspects[name] = values;
      ebay_aspect_sources ??= { ...(args.item.ebay_aspect_sources ?? {}) };
      ebay_aspect_sources[name] = INVENTORY_DERIVED;
      addedAspects.push(name);
    }
  }
  return { attributes, ebay_aspects, ebay_aspect_sources, addedAttributes, addedAspects };
}
```

Check the exact provenance literal: `grep -n "inventory_derived" services/edge-functions/src/lib/*.ts`. If the generation path uses a different string or an enum, use that.

- [x] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-env --allow-read src/tests/tag-read-backfill_test.ts`
Expected: PASS. If `deriveInventoryAspects` does not fill `Model` because `resolveItemAspects`'s registry entry ordering puts `style` (column) before `model` and the `Style Name` alias collides, remove `"Style Name"` from the `model` entry's aspects list in Task 4 and from `BACKFILL_ASPECT_NAMES` here.

- [x] **Step 5: Write the script** `scripts/backfill-tag-reads.ts`

```ts
// 2026-09-02: read the tag on every item that has one and no style code yet.
//
// WHY. 1001 items on prod were generated before the listing path could land a
// Style Code aspect. 150 have a tag-typed photo. Regenerating them would cost
// about $120 and rewrite titles the seller may have edited; reading the tag
// costs about $0.03 an item and writes four attributes and two aspects.
//
// WHAT IT WRITES, and nothing else: attributes.mpn / .model / .rn /
// .rn_registrant, plus the Style Code (or MPN) and Model aspects when the
// leaf exposes them, with inventory_derived provenance. No title, no
// description, no size, no brand, no listings row. A live eBay listing changes
// only when the seller republishes.
//
// It READS the style-code index for a resolved name and never writes it; our
// own listings are excluded evidence (vault/20-domain/style-code-index-evidence.md).
// It DOES record an RN sighting on no_reference, because a sighting is OCR
// evidence off a real tag, which is what this is.
//
// Metered under tag_ocr with the item's owner, the same as generation. Does not
// consume the seller's monthly AI-action quota: this is operator-run.
//
//   deno run --allow-net --allow-env scripts/backfill-tag-reads.ts               # dry run
//   deno run --allow-net --allow-env scripts/backfill-tag-reads.ts --limit 10
//   deno run --allow-net --allow-env scripts/backfill-tag-reads.ts --owner <uuid>
//   deno run --allow-net --allow-env scripts/backfill-tag-reads.ts --apply
//
// --dry-run is the default. A dry run still pays for the OCR (that is the
// point of --limit); it writes nothing, sightings included.

import { supabaseAdmin } from "../src/lib/supabase.ts";
import {
  extractTagGroundTruth,
  selectTagOcrPhotos,
  tagAttributeFill,
} from "../src/lib/ai-tag-ocr.ts";
import { withAiFeature } from "../src/lib/ai-feature-context.ts";
import {
  filterListablePhotos,
  itemPhotoAiUrls,
  type ItemPhotoUrlRow,
} from "../src/lib/item-photo-storage.ts";
import { resolveBrandKnowledgePack } from "../src/lib/brand-knowledge.ts";
import { brandKey, canonicalizeBrand } from "../src/lib/brand-normalize.ts";
import { lookupLearnedStyle } from "../src/lib/style-code-observations.ts";
import {
  applyLearnedStyleToListing,
  learnedStyleForListing,
  resolveListingStyleCode,
} from "../src/lib/listing-style-code.ts";
import {
  assessRegisteredNumber,
  getRegisteredNumberContext,
  recordRegisteredNumberSighting,
} from "../src/lib/registered-numbers.ts";
import { planListingRegisteredNumber } from "../src/lib/listing-registered-number.ts";
import { getCategoryAspects, type EbayAspectSpec } from "../src/lib/ebay-client.ts";
import {
  type BackfillItem,
  backfillEligible,
  planBackfillPatch,
} from "../src/lib/tag-read-backfill.ts";

const apply = Deno.args.includes("--apply");
const limitIdx = Deno.args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(Deno.args[limitIdx + 1]) : Infinity;
const ownerIdx = Deno.args.indexOf("--owner");
const owner = ownerIdx >= 0 ? Deno.args[ownerIdx + 1] ?? null : null;

const ITEM_COLUMNS =
  "id, user_id, brand, style, size, color, material, title, item_category, garment_type, garment_category, ebay_category_id, ebay_aspects, ebay_aspect_sources, attributes";

const stats = {
  scanned: 0, skipped: 0, read: 0, code: 0, decoded: 0, named: 0,
  rnParsed: 0, rnCorroborates: 0, rnContradicts: 0, rnNoReference: 0,
  attributesWritten: 0, aspectsWritten: 0, failed: 0,
};

const specCache = new Map<string, EbayAspectSpec[]>();
async function specsFor(categoryId: string | null): Promise<EbayAspectSpec[]> {
  if (!categoryId) return [];
  const hit = specCache.get(categoryId);
  if (hit) return hit;
  try {
    const specs = await getCategoryAspects(categoryId);
    specCache.set(categoryId, specs);
    return specs;
  } catch (err) {
    console.warn(`  aspects for ${categoryId} unavailable: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

async function main() {
  console.log(`backfill-tag-reads: ${apply ? "APPLY" : "dry run"}${owner ? ` owner=${owner}` : ""}`);

  // Items with at least one tag-typed photo. The photo join is what makes the
  // set 150 rather than 1001; ids only, then each item is loaded scoped to
  // its owner so every write is tenant-scoped (CLAUDE.md US-268).
  let q = supabaseAdmin
    .from("item_photos")
    .select("inventory_item_id, inventory_items!inner(user_id)")
    .in("photo_type", ["tag", "tag_2"]);
  if (owner) q = q.eq("inventory_items.user_id", owner);
  const { data: tagRows, error: tagErr } = await q;
  if (tagErr) throw tagErr;
  const itemIds = [...new Set((tagRows ?? []).map((r) => r.inventory_item_id as string))];
  console.log(`${itemIds.length} item(s) carry a tag-typed photo`);

  const rnCtx = await getRegisteredNumberContext();

  for (const id of itemIds) {
    if (stats.scanned >= limit) break;
    const { data: row, error } = await supabaseAdmin
      .from("inventory_items")
      .select(ITEM_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error || !row) { stats.failed++; continue; }
    const item = row as unknown as BackfillItem;
    stats.scanned++;
    if (!backfillEligible(item)) { stats.skipped++; continue; }

    try {
      const { data: photoRows } = await supabaseAdmin
        .from("item_photos")
        .select("id, photo_type, photo_role, storage_path, sort_order, photo_url")
        .eq("inventory_item_id", item.id)
        .order("sort_order", { ascending: true });
      const listable = filterListablePhotos((photoRows ?? []) as ItemPhotoUrlRow[]);
      const resolved = await itemPhotoAiUrls(listable);
      const photos = resolved.map(({ row, url }) => ({ url, type: row.photo_type ?? "" }));
      const tagPhotos = selectTagOcrPhotos(photos);
      if (tagPhotos.length === 0) { stats.skipped++; continue; }

      const ocr = await withAiFeature("tag_ocr", item.user_id, () =>
        extractTagGroundTruth(tagPhotos.map((p) => ({ url: p.url, type: p.type })))
      );
      if (Object.keys(ocr.fields).length > 0) stats.read++;

      const brand = canonicalizeBrand(
        ocr.fields.brand && ocr.fields.brand.confidence >= 0.4 ? ocr.fields.brand.value : item.brand,
      );
      const pack = brand ? await resolveBrandKnowledgePack(brand) : null;
      let tagAttributes = tagAttributeFill(ocr.fields, item.attributes);

      const code = resolveListingStyleCode({
        ocr: ocr.fields, itemAttributes: item.attributes, sneakerStyleCode: null, brand, pack,
      });
      if (code.styleCodeRaw) {
        stats.code++;
        if (code.decoded) stats.decoded++;
        tagAttributes = { ...tagAttributes, mpn: code.styleCodeNorm || code.styleCodeRaw };
        const key = pack?.key ?? (brand ? brandKey(brand) : "");
        if (key) {
          const learned = learnedStyleForListing(
            await lookupLearnedStyle(key, code.styleCodeRaw), brand, code.styleCodeRaw,
          );
          if (learned.resolvedName) {
            stats.named++;
            tagAttributes = applyLearnedStyleToListing({
              learned, knownFields: {}, tagGroundTruth: undefined, tagAttributes, sellerTypedStyle: item.style,
            }).tagAttributes;
          }
        }
      }

      const rn = ocr.fields.rn_number && ocr.fields.rn_number.confidence >= 0.4
        ? ocr.fields.rn_number.value : null;
      let sighting: (() => Promise<void>) | null = null;
      if (rn) {
        const assessment = assessRegisteredNumber(rn, brand, rnCtx.index, rnCtx.registrants);
        const plan = planListingRegisteredNumber({
          rn, declaredBrand: brand, existingAttributes: item.attributes, assessment,
        });
        if (plan.outcome !== "unparsed") stats.rnParsed++;
        if (plan.outcome === "corroborates" || plan.outcome === "ambiguous") stats.rnCorroborates++;
        if (plan.outcome === "contradicts") stats.rnContradicts++;
        if (plan.outcome === "no_reference") stats.rnNoReference++;
        tagAttributes = { ...tagAttributes, ...plan.attributes };
        if (plan.recordSighting) sighting = () => recordRegisteredNumberSighting(assessment, brand);
      }

      const patch = planBackfillPatch({
        item, tagAttributes, aspectSpecs: await specsFor(item.ebay_category_id),
      });
      console.log(
        `${item.id} ${brand ?? "?"}: code=${code.styleCodeRaw ?? "-"} ` +
          `name=${tagAttributes.model ?? "-"} rn=${rn ?? "-"} ` +
          `attrs=[${patch.addedAttributes.join(",")}] aspects=[${patch.addedAspects.join(",")}]`,
      );
      if (!apply || !patch.attributes) continue;

      const update: Record<string, unknown> = { attributes: patch.attributes };
      if (patch.ebay_aspects) update.ebay_aspects = patch.ebay_aspects;
      if (patch.ebay_aspect_sources) update.ebay_aspect_sources = patch.ebay_aspect_sources;
      const { error: upErr } = await supabaseAdmin
        .from("inventory_items")
        .update(update)
        .eq("id", item.id)
        .eq("user_id", item.user_id);
      if (upErr) { stats.failed++; console.error(`  write failed: ${upErr.message}`); continue; }
      stats.attributesWritten += patch.addedAttributes.length;
      stats.aspectsWritten += patch.addedAspects.length;
      if (sighting) await sighting();
    } catch (err) {
      stats.failed++;
      console.error(`  ${item.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(JSON.stringify(stats));
}

await main();
```

Verify three things against the real code before running: `withAiFeature`'s parameter order (`ai-feature-context.ts:37`), whether `item_photos` can be joined to `inventory_items` with `!inner` on this PostgREST (if not, select `inventory_item_id` only and filter owners after loading each item), and the field name the registrants map has on `getRegisteredNumberContext()`'s return.

- [x] **Step 6: Lint and type-check the script**

Run: `deno lint scripts/backfill-tag-reads.ts src/lib/tag-read-backfill.ts && deno check scripts/backfill-tag-reads.ts`
Expected: clean.

- [x] **Step 7: Commit**

```bash
git add services/edge-functions/src/lib/tag-read-backfill.ts services/edge-functions/src/tests/tag-read-backfill_test.ts services/edge-functions/scripts/backfill-tag-reads.ts
git commit -m "Backfill: read the tag on every item that has one and no style code

Reads the tag, decodes the code, looks up the product name and checks
the RN on the 150 prod items with a tag-typed photo, and writes only the
code, model and RN attributes plus the Style Code and Model aspects.
Titles, sizes, brands and listings rows are untouched. Dry run by default.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Story, full verification, push

**Files:**
- Modify: `prd.json` (via `scripts/prd-story.mjs new`)
- Modify: `docs/superpowers/plans/2026-09-02-style-code-pipe.md` (tick boxes)

- [x] **Step 1: File the story** from the repo root (US-3081 is `nextId`; the script bumps it):

```bash
node scripts/prd-story.mjs new --title "AutoLister: the tag's style code, product name and RN reach the listing" \
  --description "As a seller, I want the code printed on the label to become the Style Code aspect, the product name from the style-code index to lead the title and fill Model, and the RN to corroborate the brand, so that a Lululemon draft says Scuba Oversized Half-Zip LW3CWDS instead of Pullover. Prod 2026-09-02: 1001 items, 0 Style Code aspects, tag OCR ran on 11 of ~300 generations, the OCR'd code went to the sneaker-only resolver, style_code_names was never read by the listing path, the RN was read and dropped. Spec: docs/superpowers/specs/2026-09-02-style-code-pipe-design.md." \
  --ac "generateListing reads tag, tag_2, interior and marking photos for OCR (cap 4, internal excluded) and, when none is typed tag, runs classifyPhotoRoles server-side and relabels only detail rows the classifier calls tag (tested: selectTagOcrPhotos, planTagRoleWriteback)" \
  --ac "resolveListingStyleCode (lib/listing-style-code.ts) orders the code sources tag_ocr > item attribute > sneaker resolver, decodes inside the brand pack, canonicalises the spelling and fills a size-dot size only when OCR read no size; the canonical code lands on attributes.mpn and the Style Code / MPN aspect" \
  --ac "A resolved style_code_names name becomes knownFields.style (unless seller-typed), a style_name tag ground-truth line and attributes.model, projected to the Model aspect by a new registry entry (version 6); observation-only names are offered as an unverified candidate and written nowhere; mined names are filed under the OCR'd code instead of dropped" \
  --ac "The OCR'd RN is assessed against the registry: corroborates/ambiguous store rn and rn_registrant; contradicts caps brand confidence at 0.5 so the draft lands in review and never changes brand; no_reference records a sighting; the RN is never an eBay aspect" \
  --ac "scripts/backfill-tag-reads.ts (dry-run default, --apply, --limit, --owner) reads tags on items with a tag-typed photo and no attributes.mpn/rn and writes only mpn, model, rn, rn_registrant and the Style Code and Model aspects with inventory_derived provenance; titles, sizes, brands and listings rows untouched (tested: planBackfillPatch)" \
  --ac "A [listing-tag-metric] log line per generation records tag_photos, code, code_source, decoded, named and rn outcome; vault notes identification-precedence, rn-lookup and style-code-index-evidence record the call sites in the same commit" \
  --ac "OPERATOR: after the edge redeploy, run the backfill --dry-run --limit 10, read the lines, then --apply for the full set and paste the summary JSON into this story's note" \
  --priority 10
```

- [x] **Step 2: Full local verification** from the repo root:

```bash
npm run verify:edge
```

Expected: `deno lint`, `deno check`, `deno test` all green (the suite was 8311 passed / 0 failed on 2026-08-22; a red edge suite is a regression, not sandbox noise). Fix anything red before continuing.

- [x] **Step 3: Commit the story and the ticked plan**

```bash
git add prd.json docs/superpowers/plans/2026-09-02-style-code-pipe.md
git commit -m "Story US-3081: the tag's style code, product name and RN reach the listing

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [x] **Step 4: Report before pushing.** Per the batch-push rule, tell the owner in one message what the push contains (edge-only: five wiring changes in ai-listing.ts, three new libs, one script, one registry version bump; no migration; manual Coolify redeploy needed) and push once with `git push`. The pre-push hook runs `npm run verify`.
