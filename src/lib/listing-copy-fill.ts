// US-2442: adapt POST /api/flipdesk/ai/listing-copy into the shape AiFillPanel
// reviews.
//
// The composer has exactly one confirmation surface for AI text: AiFillPanel,
// which reads the /extract response shape (per-field suggestion + confidence +
// source, editable, with acceptance logged against log_id). /rewrite was
// deliberately built server-side to answer in that shape so it could reuse the
// panel. /listing-copy predates that decision and answers in its own:
// { title, description, model, log_id, actions_remaining }.
//
// It is also the only AI text route that runs on NOTHING: it writes a title and
// a description from the item's columns and photos, where all three /rewrite
// title actions 400 with "Add a title before rewriting it." So it can't simply
// be dropped in favour of rewrite, and translating it here is what keeps a
// generated draft on the same review-then-accept path as a rewritten one
// instead of landing straight in the seller's fields.
//
// Pure and web-only on purpose: useListingCopy() stays a faithful mirror of the
// route (iOS consumes the same endpoint), and the reshaping, which is a
// presentation choice this page makes, is unit-testable without React.

import type {
  AiExtractResponse,
  ListingCopyResponse,
} from "@/hooks/use-ai-extract";

// Mirrors the `ai:${action}` provenance string /rewrite sends, which is the text
// the panel prints under each suggestion row.
export const LISTING_COPY_SOURCE = "ai:listing_copy";

// The route returns no confidence at all: the write_listing_copy tool schema
// requires only { title, description } (edge lib/ai-extract.ts), so unlike
// /rewrite there is no model self-score to pass through. The panel badges every
// row High/Med/Low, so a number has to be supplied. This takes the bottom of
// the Med band rather than inventing a high one. Freshly generated prose is
// exactly the case the seller must read before accepting, and a "High" badge on
// copy nothing scored would be a claim the server never made.
export const LISTING_COPY_CONFIDENCE = 0.5;

/**
 * Turn a listing-copy response into an AiExtractResponse the panel can render.
 * Blank fields are dropped rather than offered as empty rows: the panel would
 * skip them at Apply anyway, and a row you cannot accept is just noise.
 */
export function listingCopyToFill(res: ListingCopyResponse): AiExtractResponse {
  const suggestions: AiExtractResponse["suggestions"] = {};
  const title = typeof res.title === "string" ? res.title.trim() : "";
  const description =
    typeof res.description === "string" ? res.description.trim() : "";
  if (title) {
    suggestions.title = {
      value: title,
      confidence: LISTING_COPY_CONFIDENCE,
      source: LISTING_COPY_SOURCE,
    };
  }
  if (description) {
    suggestions.description = {
      value: description,
      confidence: LISTING_COPY_CONFIDENCE,
      source: LISTING_COPY_SOURCE,
    };
  }
  return {
    suggestions,
    // Nothing this route produces maps to the rest of the extract payload: it
    // reads one item and writes copy, so there is no second source to conflict
    // with, no condition read, and no measurement inference.
    condition_summary: null,
    conflicts: [],
    measurements: null,
    model: res.model,
    // Carried through so the panel's acceptance PATCH lands on the row the
    // route logged. That is how per-field acceptance stays measurable for
    // generated copy the same way it is for a rewrite.
    log_id: res.log_id,
    actions_remaining: res.actions_remaining,
    ebay: null,
  };
}
