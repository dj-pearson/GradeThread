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
  type BrowseComp,
  searchBrowseCompsByImage,
  type BrowseCompsResult,
} from "./ebay-client.ts";
import {
  ebayImageSearchEnabled,
  roleCanIdentify,
} from "./scout-identify.ts";
import {
  MAX_VISUAL_PHOTOS,
  pickVisualImageIndices,
} from "./prospect-identify.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";
import {
  gatherVisualAspectEvidence,
  type VisualAspectEvidence,
} from "./visual-aspect-consensus.ts";
import type { VisualCandidate } from "./visual-candidates.ts";
import { type MinedStyleName, mineStyleNames } from "./visual-style-names.ts";
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
  /**
   * Further angles of the SAME garment, already role-gated (US-2780).
   *
   * Optional, and an empty list is the US-2778 behaviour exactly. Roles are not
   * re-checked here: startVisualPass picked these through
   * pickVisualImageIndices, and a caller assembling the list by hand is
   * asserting it did the same.
   */
  extraImagesBase64?: string[];
  /**
   * Our own eBay listing ids, so we cannot corroborate ourselves.
   *
   * May be a PROMISE (US-2778). The set is not needed until the search returns,
   * so a caller that has to read it from the database hands the pending read
   * over rather than putting a round trip in front of a call that has not
   * started. A rejected promise degrades to the empty set: failing to exclude
   * our own listings makes the evidence weaker, and failing the whole
   * identification over it would make it absent.
   */
  ownItemIds?: ReadonlySet<string> | Promise<ReadonlySet<string>>;
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
  /**
   * Style names mined from the matched listings' TITLES (US-2781).
   *
   * NOT CANDIDATES. A title may generate a name and may never confirm one, so
   * these are handed back unconfirmed and the caller runs corroborateStyleName
   * against sources this module cannot see - the tag's decoded style code and
   * the brand knowledge base. Anything that survives is appended to
   * `candidates` by the caller; anything that does not never reaches a listing.
   */
  styleNameCandidates: MinedStyleName[];
  /**
   * Product names the matched listings DECLARED as item specifics.
   *
   * The one corroborating source this module can supply itself, because a
   * filled-in Model field is a specific rather than marketing text.
   */
  aspectProductNames: string[];
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
  styleNameCandidates: [],
  aspectProductNames: [],
  declined,
});

/**
 * How many matches to ask for. Above what gets an aspect read on purpose: the
 * category vote is free (it rides on the search response) and gets sharper with
 * more listings, while each aspect read costs a call.
 */
export const VISUAL_SEARCH_LIMIT = 12;

/**
 * Settle the own-listing set, however it arrived (US-2778).
 *
 * A failed read is the empty set and NOT an error. Losing the exclusion means
 * our own listings get counted as independent corroboration, which is a
 * weaker identification; losing the identification means no identification at
 * all. The first is the better failure and the count is logged so a silent
 * empty set stays visible.
 */
async function resolveOwnItemIds(
  pending: ReadonlySet<string> | Promise<ReadonlySet<string>> | undefined,
): Promise<ReadonlySet<string>> {
  if (!pending) return new Set();
  try {
    return await pending;
  } catch (err) {
    console.error("[visual-pass] own-listing read failed:", err);
    return new Set();
  }
}

/**
 * Fold several photos' searches into one ranked comp list (US-2780).
 *
 * RANKED BY HOW MANY PHOTOS FOUND IT, because that ordering decides which
 * listings get one of the scarce aspect reads. A listing three angles all
 * surfaced is the best thing to spend a read on; eBay's own order breaks ties,
 * which is what makes the single-photo case behave exactly as it did.
 *
 * `photosWithResults` counts photos that returned SOMETHING, not photos that
 * were searched. A search that timed out is not a photo that disagreed, and
 * reporting "1 of 3" when two calls failed would read as a weak candidate when
 * it is really a thin sample.
 */
export function mergeSearches(
  results: ReadonlyArray<BrowseCompsResult | null>,
): {
  comps: BrowseComp[];
  photosByItemId: Map<string, Set<number>>;
  photosWithResults: number;
  leafCategoryVotes: BrowseCompCategoryVote[];
} {
  const photosByItemId = new Map<string, Set<number>>();
  const firstSeen = new Map<string, { comp: BrowseComp; rank: number }>();
  const votes = new Map<string, BrowseCompCategoryVote>();
  let photosWithResults = 0;

  results.forEach((res, photoIndex) => {
    if (!res || res.items.length === 0) return;
    photosWithResults++;
    res.items.forEach((comp, rank) => {
      if (!comp.itemId) return;
      let seen = photosByItemId.get(comp.itemId);
      if (!seen) {
        seen = new Set();
        photosByItemId.set(comp.itemId, seen);
      }
      seen.add(photoIndex);
      const existing = firstSeen.get(comp.itemId);
      if (!existing || rank < existing.rank) {
        firstSeen.set(comp.itemId, { comp, rank });
      }
    });
    for (const vote of res.leafCategoryVotes) {
      const prev = votes.get(vote.categoryId);
      // Votes ADD across photos: the category tally is free (it rides on the
      // search response) and gets sharper with more listings behind it.
      votes.set(
        vote.categoryId,
        prev ? { ...prev, count: prev.count + vote.count } : { ...vote },
      );
    }
  });

  const comps = [...firstSeen.entries()]
    .sort((a, b) => {
      const byPhotos = (photosByItemId.get(b[0])?.size ?? 0) -
        (photosByItemId.get(a[0])?.size ?? 0);
      return byPhotos || a[1].rank - b[1].rank;
    })
    .map(([, v]) => v.comp);

  return {
    comps,
    photosByItemId,
    photosWithResults,
    leafCategoryVotes: [...votes.values()].sort((a, b) => b.count - a.count),
  };
}

/** Distinct photos that surfaced at least one of the listings backing a value. */
function countAgreeingPhotos(
  winningListingIds: readonly string[],
  photosByItemId: ReadonlyMap<string, Set<number>>,
): number {
  const photos = new Set<number>();
  for (const id of winningListingIds) {
    for (const p of photosByItemId.get(id) ?? []) photos.add(p);
  }
  return photos.size;
}

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
    const photos = input.extraImagesBase64?.length
      ? [input.imageBase64, ...input.extraImagesBase64]
      : [input.imageBase64];

    // US-2780: concurrent, because they are independent and a seller is
    // waiting. Median measured latency at 1600px/q75 is 935ms, so three in
    // parallel cost about what one costs; three in series would not.
    const settled = await Promise.all(
      photos.map(async (base64) => {
        try {
          return await search({ imageBase64: base64, limit: VISUAL_SEARCH_LIMIT });
        } catch (err) {
          // One angle failing costs that angle's vote, not the identification.
          console.error("[visual-pass] one photo's search failed:", err);
          return null;
        }
      }),
    );

    const merged = mergeSearches(settled);
    if (merged.comps.length === 0) {
      // EVERY search failing is an OUTAGE, not a coverage finding. Reporting it
      // as no_matches would put an eBay incident in the "nothing looks like
      // this garment" bucket on the US-2779 report, which is the one place an
      // operator goes to decide whether the provider is worth its latency.
      const allFailed = settled.every((r) => r === null);
      return EMPTY(allFailed ? "error" : "no_matches");
    }

    const gather = input.gatherAspects ?? gatherVisualAspectEvidence;
    const evidence = await gather({
      // MERGED, and read ONCE. The aspect reads are the expensive half - one
      // extra Browse call each, because item_summary carries no
      // localizedAspects - so MAX_ASPECT_READS is a total across all photos,
      // not a per-photo budget. Tripling it to sharpen a vote the first few
      // already decide is the trade this module explicitly refused.
      comps: merged.comps,
      ownItemIds: await resolveOwnItemIds(input.ownItemIds),
    });

    const photosSearched = merged.photosWithResults;
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
        photosAgreeing: countAgreeingPhotos(
          consensus.winningListingIds ?? [],
          merged.photosByItemId,
        ),
        photosSearched,
      });
    }

    // US-2781: the style line. Mined from titles, and therefore NOT offered
    // from here - see visual-style-names.ts for why that distinction is the
    // whole mechanism.
    const styleNameCandidates = mineStyleNames({
      listings: merged.comps.map((c) => ({ itemId: c.itemId, title: c.title })),
      brand: evidence.aspects.Brand?.value ?? null,
      ownItemIds: await resolveOwnItemIds(input.ownItemIds),
    });

    return {
      candidates,
      leafCategoryVotes: merged.leafCategoryVotes,
      evidence,
      styleNameCandidates,
      aspectProductNames: [
        evidence.aspects.Model?.value,
        evidence.aspects["Product Line"]?.value,
      ].filter((v): v is string => typeof v === "string" && v.trim() !== ""),
      declined: null,
    };
  } catch (err) {
    console.error("[visual-pass] failed:", err);
    return EMPTY("error");
  }
}

/**
 * Download ONE photo as base64, or null.
 *
 * THE DUPLICATE FETCH IS DELIBERATE. buildPhotoContent downloads these same
 * photos for the model a moment later. Sharing the bytes would mean threading
 * a cache through two modules to save bandwidth on a request that is already
 * downloading several megabytes of images - and because this runs CONCURRENTLY
 * with that download, the second fetch costs no wall clock at all.
 */
async function fetchPhotoBase64(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const maxBytes = opts.maxBytes ?? 5_000_000;
  try {
    // fetchWithTimeout, never a bare fetch. Its deadline stays armed through
    // the BODY stream, which a hand-rolled AbortController cleared on headers -
    // a host that answers 200 and then stalls the bytes would otherwise hang
    // this call forever while looking perfectly healthy (US-2323).
    const res = await fetchWithTimeout(url, {}, timeoutMs);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    // eBay rejects oversized payloads, and a photo this large is a sign the
    // client skipped compression rather than a photo worth searching on.
    if (buf.byteLength === 0 || buf.byteLength > maxBytes) return null;
    let binary = "";
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
    return btoa(binary);
  } catch {
    return null;
  }
}

/**
 * Fetch the one photo worth searching on, as base64.
 *
 * Kept as the single-photo entry point (US-2762/2768). fetchIdentifyingPhotos
 * is the US-2780 generalisation; this delegates so the two cannot come to
 * different conclusions about the same rule.
 *
 * Returns null on anything at all going wrong. The caller treats null exactly
 * as "no candidates", which is today's behaviour.
 */
export async function fetchIdentifyingPhoto(
  photos: readonly { url: string; type?: string }[],
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ base64: string; role: string } | null> {
  const got = await fetchIdentifyingPhotos(photos, { ...opts, max: 1 });
  return got[0] ?? null;
}

/**
 * Fetch up to `max` distinct angles of the garment, as base64 (US-2780).
 *
 * Selection is pickVisualImageIndices', so Scout and the listing path cannot
 * disagree about which photo answers which question. An empty result is a
 * DECLINE, never a fallback to index 0.
 *
 * Downloads run concurrently and are DEDUPLICATED BY URL: two roles pointing at
 * one file is one download, and searching the same bytes twice would
 * manufacture agreement out of nothing.
 *
 * A photo that fails to download is dropped rather than failing the set. Two
 * angles are worth more than none.
 */
export async function fetchIdentifyingPhotos(
  photos: readonly { url: string; type?: string }[],
  opts: { timeoutMs?: number; maxBytes?: number; max?: number } = {},
): Promise<Array<{ base64: string; role: string }>> {
  const indices = pickVisualImageIndices(
    photos.map((p) => p.type),
    opts.max ?? MAX_VISUAL_PHOTOS,
  );
  if (indices.length === 0) return [];

  const seenUrls = new Set<string>();
  const wanted = indices
    .map((i) => photos[i]!)
    .filter((p) => {
      if (seenUrls.has(p.url)) return false;
      seenUrls.add(p.url);
      return true;
    });

  const settled = await Promise.all(
    wanted.map(async (p) => {
      const base64 = await fetchPhotoBase64(p.url, opts);
      return base64 ? { base64, role: p.type ?? "" } : null;
    }),
  );
  return settled.filter((v): v is { base64: string; role: string } => v !== null);
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
  opts: {
    ownItemIds?: ReadonlySet<string> | Promise<ReadonlySet<string>>;
    enabled?: () => boolean;
  } = {},
): Promise<VisualPassResult> {
  const enabled = opts.enabled ?? ebayImageSearchEnabled;
  // Check the flag BEFORE fetching anything: a disabled experiment must cost
  // nothing at all, not one wasted image download per extraction.
  if (!enabled()) return Promise.resolve(EMPTY("disabled"));

  return (async () => {
    // US-2780: up to MAX_VISUAL_PHOTOS angles, fetched concurrently.
    const got = await fetchIdentifyingPhotos(photos);
    const first = got[0];
    if (!first) return EMPTY(photos.length === 0 ? "no_image" : "role_not_identifying");
    return runVisualPass({
      imageBase64: first.base64,
      imageRole: first.role,
      extraImagesBase64: got.slice(1).map((p) => p.base64),
      ownItemIds: opts.ownItemIds,
      enabled,
    });
  })();
}
