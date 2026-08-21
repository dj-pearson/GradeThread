// US-2768: the visual pass, as the listing path uses it.
//
// Scout has had eBay visual search since US-2756, behind a flag, and the
// listing path - the one that actually writes the listing - has never seen it.
// This is the bridge, and it reuses Scout's gate rather than inventing a
// second one.
//
// ── The gate is on the INPUT, and it is the highest-value part ────────────────
// The measured failure mode is not that visual search is bad. It is that it
// answers the question the photo asks, confidently, whatever that question is:
//
//   a tape measure across a hem  ->  mens dress pants
//   red fabric with two moth holes  ->  red fabric sold BY THE YARD
//   a care and composition label  ->  a midi dress, joggers, a mini skirt
//
// None of that looks like junk coming back. So a detail shot is not a degraded
// call to be filtered afterwards, it is a call whose ANSWER is misleading and
// which must not be made. roleCanIdentify owns that rule; unknown means no.
// Full measurements: vault/30-platform/ebay-visual-search.md.

import {
  searchBrowseCompsByImage,
  type BrowseCompsResult,
} from "./ebay-client.ts";
import {
  ebayImageSearchEnabled,
  roleCanIdentify,
} from "./scout-identify.ts";
import { pickVisualImageIndex } from "./prospect-identify.ts";
import {
  gatherVisualAspectEvidence,
  type VisualAspectEvidence,
} from "./visual-aspect-consensus.ts";
import type { VisualCandidate } from "./visual-candidates.ts";
import type { BrowseCompCategoryVote } from "./ebay-client.ts";

/** Aspect name as eBay spells it -> the field name our prompt uses. */
const ASPECT_TO_FIELD: Record<string, string> = {
  Brand: "brand",
  Type: "type",
  Model: "style",
  "Product Line": "product_line",
  Material: "material",
  Pattern: "pattern",
  Department: "department",
};

export interface VisualPassInput {
  /** The photo to search on, as a base64 payload (no data: prefix). */
  imageBase64: string | null;
  /** The photo's role. Unknown means the pass declines. */
  imageRole: string | null | undefined;
  /** Our own eBay listing ids, so we cannot corroborate ourselves. */
  ownItemIds?: ReadonlySet<string>;
  /** Injected for tests. */
  searchByImage?: (args: {
    imageBase64: string;
    limit?: number;
  }) => Promise<BrowseCompsResult>;
  gatherAspects?: typeof gatherVisualAspectEvidence;
  /** Injected for tests; defaults to reading the env flag per call. */
  enabled?: () => boolean;
}

export interface VisualPassResult {
  candidates: VisualCandidate[];
  leafCategoryVotes: BrowseCompCategoryVote[];
  evidence: VisualAspectEvidence | null;
  /** Why nothing came back, when nothing did. Null on success. */
  declined:
    | "disabled"
    | "no_image"
    | "role_not_identifying"
    | "no_matches"
    | "error"
    | null;
}

const EMPTY = (
  declined: VisualPassResult["declined"],
): VisualPassResult => ({
  candidates: [],
  leafCategoryVotes: [],
  evidence: null,
  declined,
});

/**
 * How many matches to ask for. Above what gets an aspect read on purpose: the
 * category vote is free (it rides on the search response) and gets sharper with
 * more listings, while each aspect read costs a call.
 */
export const VISUAL_SEARCH_LIMIT = 12;

/**
 * Run the visual pass, or decline.
 *
 * NEVER THROWS AND NEVER PARTIALLY APPLIES. Every failure path returns an empty
 * result whose only content is WHY, and an empty result leaves the extraction
 * byte-identical to what it does today. This is an unproven provider sitting in
 * front of the path that works; it gets to add, never to subtract.
 */
export async function runVisualPass(
  input: VisualPassInput,
): Promise<VisualPassResult> {
  const enabled = input.enabled ?? ebayImageSearchEnabled;
  if (!enabled()) return EMPTY("disabled");
  if (!input.imageBase64) return EMPTY("no_image");
  // Unknown role is NOT permission. A photo nobody labelled is likelier to be
  // a detail shot than a flatlay, and the cost of guessing wrong is not a miss
  // but a confident wrong answer that gets priced against.
  if (!roleCanIdentify(input.imageRole)) return EMPTY("role_not_identifying");

  try {
    const search = input.searchByImage ?? searchBrowseCompsByImage;
    const comps = await search({
      imageBase64: input.imageBase64,
      limit: VISUAL_SEARCH_LIMIT,
    });
    if (comps.items.length === 0) return EMPTY("no_matches");

    const gather = input.gatherAspects ?? gatherVisualAspectEvidence;
    const evidence = await gather({
      comps: comps.items,
      ownItemIds: input.ownItemIds ?? new Set(),
    });

    const candidates: VisualCandidate[] = [];
    for (const [aspectName, field] of Object.entries(ASPECT_TO_FIELD)) {
      const consensus = evidence.aspects[
        aspectName as keyof typeof evidence.aspects
      ];
      // No value means the listings disagreed. Offering the top candidate
      // anyway would hand the model a coin flip dressed as evidence.
      if (!consensus?.value) continue;
      candidates.push({
        field,
        value: consensus.value,
        support: consensus.support,
        outOf: consensus.declared,
      });
    }

    return {
      candidates,
      leafCategoryVotes: comps.leafCategoryVotes,
      evidence,
      declined: null,
    };
  } catch (err) {
    console.error("[visual-pass] failed:", err);
    return EMPTY("error");
  }
}

/**
 * Fetch the one photo worth searching on, as base64.
 *
 * Reuses pickVisualImageIndex (US-2762) rather than re-deriving "which photo",
 * so Scout and the listing path cannot come to different conclusions about the
 * same rule. -1 means no photo qualifies, and that is a decline, never a
 * fallback to index 0.
 *
 * THE DUPLICATE FETCH IS DELIBERATE. buildPhotoContent downloads these same
 * photos for the model a moment later. Sharing the bytes would mean threading
 * a cache through two modules to save bandwidth on a request that is already
 * downloading several megabytes of images - and because this runs CONCURRENTLY
 * with that download, the second fetch costs no wall clock at all.
 *
 * Returns null on anything at all going wrong. The caller treats null exactly
 * as "no candidates", which is today's behaviour.
 */
export async function fetchIdentifyingPhoto(
  photos: readonly { url: string; type?: string }[],
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ base64: string; role: string } | null> {
  const idx = pickVisualImageIndex(photos.map((p) => p.type));
  if (idx < 0) return null;
  const photo = photos[idx]!;

  const timeoutMs = opts.timeoutMs ?? 4_000;
  const maxBytes = opts.maxBytes ?? 5_000_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(photo.url, { signal: controller.signal });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    // eBay rejects oversized payloads, and a photo this large is a sign the
    // client skipped compression rather than a photo worth searching on.
    if (buf.byteLength === 0 || buf.byteLength > maxBytes) return null;
    let binary = "";
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
    return { base64: btoa(binary), role: photo.type ?? "" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the visual pass for a set of listing photos, without awaiting it.
 *
 * Returns a promise the caller hands to extractItemFields, which awaits it only
 * after the photos are inlined and the brand pack is loaded. That is where the
 * concurrency comes from: the pass overlaps the network-bound preparation
 * rather than being bolted on in front of it.
 */
export function startVisualPass(
  photos: readonly { url: string; type?: string }[],
  opts: { ownItemIds?: ReadonlySet<string>; enabled?: () => boolean } = {},
): Promise<VisualPassResult> {
  const enabled = opts.enabled ?? ebayImageSearchEnabled;
  // Check the flag BEFORE fetching anything: a disabled experiment must cost
  // nothing at all, not one wasted image download per extraction.
  if (!enabled()) return Promise.resolve(EMPTY("disabled"));

  return (async () => {
    const photo = await fetchIdentifyingPhoto(photos);
    if (!photo) return EMPTY(photos.length === 0 ? "no_image" : "role_not_identifying");
    return runVisualPass({
      imageBase64: photo.base64,
      imageRole: photo.role,
      ownItemIds: opts.ownItemIds,
      enabled,
    });
  })();
}
