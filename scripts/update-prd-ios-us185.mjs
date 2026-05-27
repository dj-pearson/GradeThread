// Mark US-185 passed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRD = path.join(ROOT, "prd.json");

const updates = {
  "US-185": {
    passes: true,
    notes:
      "Done 2026-05-27. ios/GradeThread/Marketplaces/Publish/ now mirrors the full web publish + manage surface. EbayPublishTypes.swift carries the wire shapes — ValidateResponse (ok / blockers / summary with title / description / price / condition / conditionDescription), PushResponse (snake-case listing_id / listing_url / offer_id / sku), PushBlockersResponse (422 payload), PriceUpdateResponse, EndListingResponse, EdgeErrorBody (detail preferred over error for messaging). PublishOutcome enum carries the typed result so callers switch on cases (.validated / .pushed / .priceUpdated / .ended / .blockers / .noOfferId / .failed) without sniffing HTTP codes. EbayPublishService rolls its own URLSession for the four calls (the typed outcome shape needs both status code + body simultaneously, which is awkward through generic EdgeAPI). validate(itemId) / push(itemId) / updatePrice(listingId, price) / endListing(listingId) all return PublishOutcome. 409 always maps to .noOfferId so the caller can fall back to local-only behavior; 422 deserializes into PushBlockersResponse → .blockers; 502 + 500 carry the EdgeErrorBody.message → .failed. PublishDialog is the publish flow shown as a sheet from ItemCanvasView. State machine: validating → readyToPush(summary) OR blocked(blockers) → pushing → succeeded(response) OR failed. Success card shows the eBay listing id (textSelection enabled), 'View on eBay' button opening SFSafariViewController (reuses SafariView from US-170), and Done that fires onPublished + dismisses. ItemCanvasView gains a Publish to eBay section button — visible only when item.status is in [photographed, graded, comped, drafted, measured]. On successful push the canvas optimistically flips item.status to 'listed' and posts .inventoryPullRequested so the inventory list rebuckets the row immediately. BulkActionExecutor's endListing + dropPrice stubs are now real: fetches the active eBay listing per selected item via a batched supabase-swift query (.in('inventory_item_id', values:).eq('platform','ebay').eq('listing_status','active')), then calls EbayPublishService.endListing / updatePrice per item, aggregating failures. dropPrice computes newPrice = max(1.0, currentPrice × (1 - percent/100)) with a $1 hard floor. .noOfferId surfaces as 'Listing isn't linked to an eBay offer' per item — matches the AC's 'Local only — connect eBay to push' messaging. Tests in EbayPublishTests cover all six wire-shape decodings (ValidateResponse with summary + with blockers, PushResponse snake-case, PushBlockersResponse, PriceUpdateResponse, EndListingResponse), EdgeErrorBody.message precedence (detail beats error, fallback when only error present, nil when both missing), and PublishOutcome equality.",
  },
};

const prd = JSON.parse(fs.readFileSync(PRD, "utf8"));
let touched = 0;
for (const story of prd.userStories) {
  const u = updates[story.id];
  if (!u) continue;
  story.passes = u.passes;
  story.notes = u.notes;
  touched++;
}

fs.writeFileSync(PRD, JSON.stringify(prd, null, 2) + "\n", "utf8");
console.log(`Updated ${touched} stories in prd.json`);
