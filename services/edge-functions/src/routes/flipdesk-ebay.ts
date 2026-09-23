import { Hono } from "hono";
import type { EbayEnv } from "./flipdesk-ebay-shared.ts";
import { flipdeskEbayRoutes as oauthRoutes } from "./flipdesk-ebay-oauth.ts";
import { flipdeskEbayRoutes as syncRoutes } from "./flipdesk-ebay-sync.ts";
import { flipdeskEbayRoutes as complianceRoutes } from "./flipdesk-ebay-compliance.ts";
import { flipdeskEbayRoutes as financesRoutes } from "./flipdesk-ebay-finances.ts";
import { flipdeskEbayRoutes as catalogRoutes } from "./flipdesk-ebay-catalog.ts";
import { flipdeskEbayRoutes as policiesRoutes } from "./flipdesk-ebay-policies.ts";
import { flipdeskEbayRoutes as marketingRoutes } from "./flipdesk-ebay-marketing.ts";
import { flipdeskEbayRoutes as postSaleRoutes } from "./flipdesk-ebay-post-sale.ts";
import { flipdeskEbayRoutes as negotiationRoutes } from "./flipdesk-ebay-negotiation.ts";
import { flipdeskEbayRoutes as listingsRoutes } from "./flipdesk-ebay-listings.ts";
import { flipdeskEbayRoutes as publishRoutes } from "./flipdesk-ebay-publish.ts";
import { flipdeskEbayRoutes as publishDueRoutes } from "./flipdesk-ebay-publish-due.ts";

// eBay integration endpoints. Mounted at /api/flipdesk/ebay.
//
// Auth split:
//   - /oauth/start   → user-authed (initiates from inside the app)
//   - /oauth/callback → public (eBay redirects the browser here unauthed;
//                       state token from the oauth_states table identifies
//                       the user)
//   - /oauth/refresh → internal job secret (scheduled rotation)
//   - everything else → user-authed via main.ts middleware
//
// Required env: EBAY_APP_ID, EBAY_CERT_ID, EBAY_DEV_ID, EBAY_RU_NAME,
//               EBAY_REDIRECT_URI, EBAY_ENV, EDGE_ENCRYPTION_KEY.
//
// The routes live in flipdesk-ebay-*.ts, one file per concern, with the
// helpers more than one of them needs in flipdesk-ebay-shared.ts. This file
// only mounts them. Hono runs the first matching handler, so the mount order
// below keeps every pair of routes that can match the same request in the
// order they were registered in before the split; ebay-route-inventory_test.ts
// holds that, and the full method + path list, in place.

export const flipdeskEbayRoutes = new Hono<EbayEnv>();
flipdeskEbayRoutes.route("/", oauthRoutes);
flipdeskEbayRoutes.route("/", syncRoutes);
flipdeskEbayRoutes.route("/", complianceRoutes);
flipdeskEbayRoutes.route("/", financesRoutes);
flipdeskEbayRoutes.route("/", catalogRoutes);
flipdeskEbayRoutes.route("/", policiesRoutes);
flipdeskEbayRoutes.route("/", marketingRoutes);
flipdeskEbayRoutes.route("/", postSaleRoutes);
flipdeskEbayRoutes.route("/", negotiationRoutes);
flipdeskEbayRoutes.route("/", listingsRoutes);
flipdeskEbayRoutes.route("/", publishRoutes);
flipdeskEbayRoutes.route("/", publishDueRoutes);

// US-470: 501-stub classification. The eBay module is fully wired (OAuth, sync,
// publish, policies, comps, reconciliation) — the old "Still-stubbed (Week 2-3)"
// header here was stale; the helpers below ARE implemented. The only remaining
// 501s in the FlipDesk surface are DELIBERATE, not missing features:
//   • flipdesk-grading.ts POST /webhook → 501: same-process DB sync is used
//     instead (grading-pipeline.ts); the webhook receiver is reserved for the
//     Phase-2 split when FlipDesk consumes the GradeThread Public API.
//   • flipdesk-images.ts POST /process → 501: thumbnails + EXIF strip happen
//     client-side (PhotoUploader); /remove-bg is replaced by on-device @imgly
//     segmentation (US-535). Both carry explanatory error bodies.
// No accidental 501 hides unfinished reseller functionality.

// Everything this module exported before the split, so callers and tests that
// import from routes/flipdesk-ebay.ts keep working unchanged.
export {
  allowedAspectsFromSpec,
  applyGradeListingPromotion,
  normalizeVariations,
  stripCertLinks,
  variantSku,
} from "./flipdesk-ebay-shared.ts";
export type { ListingVariations } from "./flipdesk-ebay-shared.ts";
export {
  CATALOG_REFRESH_MS,
  IN_FILTER_CHAR_BUDGET,
  MAX_LOGGED_UNSTAMPED_SKUS,
  OFFER_RECHECK_MS,
  SPECIFICS_RECHECK_MS,
  buildEbaySkuIndex,
  chunkIdsForInFilter,
  offerCheckRowsForIndex,
  planOfferStamp,
  resolveSyncScope,
  routeRemoteOffer,
  selectSkusToSkip,
  triggerEbaySyncForUser,
  unstampedOfferCoverage,
} from "./flipdesk-ebay-sync.ts";
export type {
  EbaySyncScope,
  OfferRouting,
  OfferStampCoverage,
  OfferStampPlan,
  RoutableLocalListing,
  RoutableOffer,
  SkuIndexItem,
  SkuIndexListing,
} from "./flipdesk-ebay-sync.ts";
export { negotiationCapability, negotiationScope403Body } from "./flipdesk-ebay-negotiation.ts";
export type { NegotiationCapability } from "./flipdesk-ebay-negotiation.ts";
export {
  resolveEndStrategy,
  resolveReviseStrategy,
  resyncGradeToLiveListing,
} from "./flipdesk-ebay-listings.ts";
export type { EndStrategy, ReviseStrategy } from "./flipdesk-ebay-listings.ts";
export {
  assemblePublishContext,
  publishItemForOwner,
  relistOwnedListing,
  resolvePublishPrice,
} from "./flipdesk-ebay-publish.ts";
export type { PublishItemResult } from "./flipdesk-ebay-publish.ts";
export { publishBatchLimit } from "./flipdesk-ebay-publish-due.ts";
