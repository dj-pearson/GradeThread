import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { latestPublication, recordPublication } from "../lib/listing-publications.ts";
import {
  getReturnShipment,
  markReturnReceived,
  sendReturnMessage,
  submitReturnFiles,
  uploadReturnFile,
} from "../lib/ebay-postorder.ts";
import {
  cancellationToCaseInput,
  disputeToCaseInput,
  loadCachedSummaries,
  markPostSaleCaseClosed,
  mergePostSaleCaseRaw,
  recordPostSaleCases,
  returnToCaseInput,
  updatePostSaleCaseState,
} from "../lib/post-sale-store.ts";
import type {
  CancellationSummary,
  ReturnSummary,
} from "../lib/ebay-postorder.ts";
import type { PaymentDisputeSummary } from "../lib/ebay-disputes.ts";
import {
  closeInquiry,
  type InquirySummary,
  isInquiryAlreadySettled,
  issueInquiryRefund,
  provideInquiryShipmentInfo,
  searchInquiries,
} from "../lib/ebay-inquiries.ts";
import { caseToCaseInput, inquiryToCaseInput } from "../lib/post-sale-store.ts";
import {
  DEFAULT_OFFER_MARGIN_FLOOR_PCT,
  dryRunOfferRule,
  normalizeThresholdPct,
} from "../lib/offer-rules.ts";
import { summarizeOffers } from "../lib/offer-analytics.ts";
import { loadActiveOfferRule } from "../lib/offer-rule-lookup.ts";
import {
  OFFER_COOLDOWN_DAYS,
  totalDiscountExposureCents,
} from "../lib/offer-candidates.ts";
import { loadRankedOfferCandidates } from "../lib/offer-candidates-load.ts";
import {
  createKeyword,
  createNegativeKeyword,
  listKeywords,
  listNegativeKeywords,
  type MatchType,
  negativeKeywordCandidates,
  suggestKeywords,
  updateKeyword,
} from "../lib/ebay-keywords.ts";
import { ensureCpcCampaign, recommendationApiSupported } from "../lib/ebay-marketing.ts";
import { loadSearchTerms } from "../lib/ebay-ad-reports.ts";
import { computeLift, loadPromotions, recordPromotions } from "../lib/promotion-store.ts";
import { describeStack, evaluateStack } from "../lib/discount-stack.ts";
import { describeExclusion, selectMarkdownItems } from "../lib/markdown-rules.ts";
import { extractAdFees, reconcileMoneyLines } from "../lib/ad-spend.ts";
import {
  createEmailCampaign,
  emailCampaignReport,
  isStoreRequiredError,
  listEmailCampaigns,
  sendEmailCampaign,
} from "../lib/ebay-email-campaigns.ts";
import { loadMarkdownCandidates } from "../lib/markdown-candidates.ts";
import {
  type BulkAdResult,
  bulkCreateAdsByListingId,
  bulkUpdateAdRateByListingId,
  cloneCampaign,
  endCampaign,
  isCampaignAlreadyInState,
  pauseCampaign,
  resumeCampaign,
  suggestBids,
  suggestBudget,
  suggestItems,
} from "../lib/ebay-campaign-ops.ts";
import {
  incomingOfferToInput,
  loadBuyerHistory,
  loadOffers,
  loadListPricesByItemId,
  recordOfferResponse,
  recordOffers,
} from "../lib/offer-store.ts";
import {
  appealCase,
  type CaseSummary,
  closeCase,
  isCaseAlreadySettled,
  issueCaseRefund,
  provideCaseShipmentInfo,
  searchCases,
  submitCaseFiles,
  uploadCaseFile,
} from "../lib/ebay-cases.ts";
import { cleanEvidenceFiles, evidenceRefusalFor } from "../lib/evidence-send.ts";
import { MIN_SALES_FOR_RATE, summarizeReturns } from "../lib/post-sale-analytics.ts";
import { loadReturnAnalyticsInputs } from "../lib/post-sale-analytics-load.ts";
import {
  dryRunReturnRule,
  normalizeThresholdCents as normalizeReturnThresholdCents,
} from "../lib/return-rules.ts";
import { matchComplaint, type ReportedDefect } from "../lib/complaint-match.ts";
import { compositeReturnEvidenceSheet } from "../lib/defect-annotations.ts";
import type { EvidenceStamp } from "../lib/evidence-pack.ts";
import {
  buildEvidencePlan,
  type EvidencePlan,
  type PublicationSnapshot,
} from "../lib/dispute-evidence.ts";

/**
 * US-2706: how many images a return-evidence pack may carry.
 *
 * Not an eBay limit we have measured — a judgement. A pack that is mostly
 * filler argues worse than one that is only the flaw and the disclosure, and
 * the seller has already chosen what goes in it.
 */
const MAX_RETURN_EVIDENCE_FILES = 6;

/**
 * US-2706 / US-2707: the evidence verdict for one eBay order's item, or null.
 *
 * ONE planner for both case types. A return and a payment dispute are different
 * eBay surfaces asking the same question - does the grade report back this
 * seller - and two planners would be two answers, with the rarer path holding
 * the one nobody re-checked.
 *
 * Null means "could not decide", never "nothing to worry about". Every lookup
 * here is tenant-scoped by ownerId, and the chain is
 * sale -> inventory item -> grading submission -> grade report, plus the
 * listing's most recent publication snapshot.
 */
interface EvidenceContext {
  plan: EvidencePlan;
  /** US-2706 AC6: false means the pack can only argue from the grade report. */
  hasSnapshot: boolean;
  stamp: EvidenceStamp;
  gradedAt: string | null;
  defectCount: number;
}

async function planEvidence(
  ownerId: string,
  orderId: string,
  complaint: string,
): Promise<EvidenceContext | null> {
  try {
    const { data: sale } = await supabaseAdmin
      .from("sales")
      .select("inventory_item_id, listing_id")
      .eq("user_id", ownerId)
      .eq("platform_order_id", orderId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const itemId = (sale as { inventory_item_id?: string } | null)?.inventory_item_id;
    if (!itemId) return null;

    const { data: grading } = await supabaseAdmin
      .from("flipdesk_grading_submissions")
      .select("submission_id")
      .eq("inventory_item_id", itemId)
      .not("submission_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const submissionId = (grading as { submission_id?: string } | null)?.submission_id;
    if (!submissionId) return null;

    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("defects_found, certificate_id, overall_score, grade_tier, created_at")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = report as
      | {
        defects_found?: unknown;
        certificate_id?: string | null;
        overall_score?: number | string | null;
        grade_tier?: string | null;
        created_at?: string | null;
      }
      | null;
    const defects = (row?.defects_found ?? []) as ReportedDefect[];
    if (!Array.isArray(defects) || defects.length === 0) return null;

    const listingId = (sale as { listing_id?: string } | null)?.listing_id ?? null;
    // Through the funnel module, not straight at the table. US-2704's coverage
    // guard caught the direct read here and was right to: one module owning the
    // table is what keeps `published_at DESC` from being re-derived by a reader
    // who would hand a dispute pack the wrong revision.
    let snapshot: PublicationSnapshot | null = null;
    if (listingId) {
      const row = await latestPublication(supabaseAdmin, listingId, ownerId);
      if (row) {
        snapshot = {
          description: row.description,
          aspects: row.aspects,
          publishedAt: row.published_at,
          lastConfirmedAt: row.last_confirmed_at,
        };
      }
    }

    const { matches } = matchComplaint(complaint, defects);
    const plan = buildEvidencePlan({ defects, snapshot, matches });
    return {
      plan,
      hasSnapshot: snapshot !== null,
      // The facts the evidence sheet burns in. Carried out of here because this
      // is the only place that already loaded the report — a second read would
      // be a second chance to pick a different revision of it.
      stamp: {
        certificateNumber: row?.certificate_id ?? null,
        overallScore: Number(row?.overall_score ?? Number.NaN),
        gradeTier: String(row?.grade_tier ?? ""),
      },
      gradedAt: row?.created_at ?? null,
      defectCount: defects.length,
    };
  } catch (err) {
    console.error(
      "[ebay.returns.evidence] could not build the plan:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
import { trimTitleToLimit, trimTitleWithReport } from "../lib/title-trim.ts";
import { lintTitle } from "../lib/title-lint.ts";
// US-2677: near-duplicate titles across the seller's own live listings. A
// WARNING and never a blocker -- two genuinely different garments can carry
// similar titles, and only the seller can tell.
import { duplicateTitleWarningsFor } from "../lib/title-similarity.ts";
// US-2678: the price component scores against REALIZED sales, never against
// active asking prices, which are by definition the ones nobody bought.
import { getRealizedComps } from "../lib/sold-comps.ts";
import { captureException } from "../lib/observability.ts";
import { planComplianceSync } from "../lib/ebay-compliance-plan.ts";
import { roleAtLeast } from "../lib/workspace-roles.ts";
import {
  filterEbayPhotos,
  publicItemPhotoUrl,
} from "../lib/item-photo-storage.ts";
import {
  maybeFireImmediateConsignorPayout,
  reverseConsignorPayoutsForSales,
} from "../lib/consignor-payout.ts";
import { sanitizeRelativePath } from "../lib/oauth-redirect.ts";
import {
  applyColumnAspects,
  columnAspectProjection,
  columnBackedAspectMap,
  columnBackedAspectNames,
  resolveItemAspects,
  reverseColumnAspects,
} from "../lib/aspect-registry.ts";
import type { RegistryAspect, RegistryItem } from "../lib/aspect-registry.ts";
import {
  applyMeasurementsBlock,
  hasCalibratedMeasurements,
  type Measurements,
  resolveMeasurementAspects,
} from "../lib/measurements.ts";
import { resolveShoeSizeScaleForItem } from "../lib/shoe-size-scale.ts";
import type { ShoeSizeScale } from "../lib/parcel-estimate.ts";

/**
 * US-2796 AC3: which scale this item's stamped shoe number is on.
 *
 * The rows reaching the publish and revise paths are read with wide selects and
 * typed loosely, so this narrows once instead of at each call site. Every field
 * is optional and the resolver returns null when it cannot tell - which is
 * exactly today's behaviour, so a row that happens to be missing a column loses
 * nothing that was working.
 */
function shoeScaleOf(item: unknown): ShoeSizeScale | null {
  const row = (item ?? {}) as {
    brand?: string | null;
    attributes?: Record<string, string | string[]> | null;
    item_category?: string | null;
    size?: string | null;
    style?: string | null;
    title?: string | null;
    description?: string | null;
    condition_notes?: string | null;
  };
  return resolveShoeSizeScaleForItem({
    brand: row.brand,
    attributes: row.attributes,
    item_category: row.item_category ?? null,
    size: row.size,
    style: row.style,
    title: row.title,
    description: row.description,
    condition_notes: row.condition_notes,
  });
}
import {
  type AspectCoverage,
  type AspectSourceMap,
  mergeSources,
  recommendedAspectCoverage,
  requiredMissingAspects,
  sourcesFor,
} from "../lib/aspect-provenance.ts";
import {
  normalizeAspectMap,
  type PublishAspectDiagnostic,
  reconcilePublishAspects,
  type ReconcileSpec,
} from "../lib/aspect-reconcile.ts";
import {
  buildConsentUrl,
  createInventoryLocation,
  createOffer,
  bulkMigrateListing,
  createOrReplaceInventoryItem,
  createShippingFulfillment,
  debugSnapshot,
  ebayListingUrl,
  exchangeCodeForTokens,
  categoryHasCachedLeafAspects,
  fetchCategoryLeafStatus,
  getCategoryAspects,
  getCategoryName,
  getItemConditionPolicies,
  getCatalogProduct,
  getCustomerServiceMetric,
  getListingViolations,
  getListingViolationsSummary,
  getPayouts,
  searchCatalogProducts,
  getMarketplaceId,
  getSellerStandardsProfile,
  getTrafficReport,
  TrafficReportShapeError,
  getUserAccessToken,
  isAnalyticsAccessDenied,
  getUserIdentityFromToken,
  isEbayConfigured,
  isNegotiationScopeAvailable,
  isOfferAlreadyExistsError,
  isOfferBoundToDeadListing,
  listAllOffers,
  listOffersForSku,
  getOffer,
  getPublishedListingId,
  getInventoryItemAspects,
  listRecentOrders,
  listRecentTransactions,
  publishOrAdoptOffer,
  createOrReplaceInventoryItemGroup,
  publishItemGroupOrAdopt,
  publishOfferByInventoryItemGroup,
  resolveCachedDefaults,
  revokeEbayUserToken,
  setDefaultPolicies,
  suggestCategories,
  syncBusinessPolicies,
  syncExistingOffer,
  updateOfferFields,
  bulkUpdatePriceQuantity,
  EBAY_BULK_MAX,
  upsertConnection,
  withdrawOffer,
  withdrawByInventoryItemGroup,
  getOptedInPrograms,
  optInToProgram,
  optOutOfProgram,
  isAlreadyInProgramStateError,
  type EbaySellerProgram,
  deleteOffer,
  deleteInventoryItem,
  isAlreadyDeletedError,
  issueOrderRefund,
  type IssueRefundInput,
  type IssueRefundResult,
  type RefundAmount,
  isOfferAlreadyEndedError,
  isNoEbayConnectionError,
  findEligibleNegotiationItems,
  getBrowseItemByLegacyId,
  sendOfferToInterestedBuyers,
  type BestOfferTerms,
  type PricingSummary,
  type PolicySet,
  type RemoteOffer,
  type RemoteOrder,
  type RemoteOrderLineItem,
  type RemoteTransaction,
} from "../lib/ebay-client.ts";
import {
  absentListingState,
  type EbayListingState,
  resolveEbayListingState,
  resolveOrderOutcome,
} from "../lib/ebay-listing-state.ts";
import { runOrderReport, shouldUseFeedForOrders } from "../lib/ebay-feed.ts";
import { type FailedOrder, planOrdersWatermark } from "../lib/sync-watermark.ts";
// US-713: the Depop connector shares this token-refresh cron (no separate
// Coolify task). The sweep is a no-op while DEPOP_ENABLED is off.
import { refreshExpiringDepopConnections } from "../lib/depop-client.ts";
import { refreshExpiringEtsyConnections } from "../lib/etsy-client.ts";
import { refreshExpiringWhatnotConnections } from "../lib/whatnot-client.ts";
import {
  centsToMoneyString,
  reconcileAutoAcceptWithRule,
  resolveBestOfferThresholds,
} from "../lib/best-offer.ts";
import { decryptToken } from "../lib/crypto-aes.ts";
import {
  enrichEligibleItems,
  type EligibleEnrichment,
} from "../lib/negotiation-enrich.ts";
import { finalizePublishedListing } from "../lib/ebay-publish-finalize.ts";
import { emitEvent, firstOccurrenceKey } from "../lib/user-events.ts";
import { autoEndCrossListings } from "../lib/cross-listings.ts";
import { recordEbaySale } from "../lib/passport-sale.ts";
import {
  recordSourceObservations,
  type SourceObservation,
} from "../lib/sync-conflicts.ts";
import { fetchWithTimeout } from "../lib/circuit-breaker.ts";
import { ensureCertificateNumber } from "../lib/cert-number.ts";
import {
  formatGtGrade,
  GT_GRADE_FIELD_NAME,
  GT_GRADE_ITEM_SPECIFIC,
} from "../lib/gt-grade-standard.ts";
import {
  captureListingAcceptance,
  markListingPromptSold,
} from "../lib/listing-acceptance.ts";
import {
  type ExistingSaleRow,
  normalizeUnitCount,
  pickSaleRowForLine,
} from "../lib/ebay-order-lines.ts";
import {
  checkImageReachability,
  dedupeAndCapImages,
  EBAY_MAX_IMAGES as PREFLIGHT_MAX_IMAGES,
  imageCapBlocker,
  reachabilityBlocker,
  validateConditionForCategory,
  resolveEbayCondition,
  mapGradeToBaseCondition,
  conditionOptionsForCategory,
  resolveCategoryLeafStatus,
  leafCategoryBlocker,
  photoStandardsPreflight,
  conditionDescriptionConsistency,
  type LeafCategorySuggestion,
} from "../lib/publish-preflight.ts";
// US-1897: Listing Quality Score (validate surface only — see buildQualityScore).
import {
  computeListingQualityScore,
  type ListingQualityScore,
} from "../lib/listing-quality-score.ts";
import { loadFulfillmentSignals } from "../lib/business-policy-signals.ts";
import {
  getAllActiveEbaySelling,
  getItemSpecifics,
  getBestOffers,
  respondToBestOffer,
  getMemberMessages,
  replyToMemberMessage,
  leaveFeedback,
  getOrderLegacyLineItems,
  type BestOfferAction,
  type LegacyEbayListing,
} from "../lib/ebay-trading.ts";
import {
  buildCatalogPatch,
  type CatalogPatch,
  FILL_IF_BLANK_FIELDS,
  flattenAspects,
  type LocalCatalog,
} from "../lib/ebay-catalog-merge.ts";
import { parseEbayPayoutsCsv } from "../lib/ebay-payouts-csv.ts";
import { ingestPayoutsForUser } from "../lib/ebay-payout-dedup.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { claimSyncRun, failSyncRun } from "../lib/sync-run-lock.ts";
import {
  EBAY_PUBLISH_GENERIC_FIX,
  ebayFailureDetail,
  resolveEbayFix,
} from "../lib/ebay-error-map.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog, writeSystemAuditLog } from "../lib/audit-log.ts";
import { getSetting } from "../lib/system-settings.ts";
import {
  COMP_MIN_RESULTS_SETTING_KEY,
  DEFAULT_MIN_COMP_RESULTS,
  searchCompsWithLadder,
} from "../lib/comps-ladder.ts";
import { markComped } from "../lib/rewards-pipeline.ts";
import {
  deriveListingOrigin,
  ebayOriginWriteLock,
  EBAY_OWNED_LISTING_FIELDS,
  LISTING_PULL_ALLOWED_ON_GT_ORIGIN,
  validateEbayOriginEdit,
} from "../lib/sync-precedence.ts";
// US-2166: the shared platform-agnostic lifecycle core.
import { applyListingPrice } from "../lib/listing-lifecycle.ts";
// US-2166 (AC5): the bulk-edit handler now lives with the other
// platform-agnostic listing operations; this file only forwards to it.
import { bulkEditListingsHandler } from "./flipdesk-listings.ts";
import {
  itemHasActiveListing,
  resyncItemListedStatus,
} from "../lib/active-listings.ts";
import {
  buildPriceQtyRequest,
  chunk,
  normalizeBulkEntry,
  type PriceQtyUpdate,
} from "../lib/ebay-bulk.ts";
// US-1999: one derivation rule, and the published SKU wins over item.sku.
import { resolveInventorySku } from "../lib/ebay-sku.ts";
// US-1968: existing-listing migration (pure response parsing + eBay's 5/call cap).
import { chunkForMigrate, parseMigrateResponse } from "../lib/ebay-migrate.ts";

// US-1968: how many listings one migrate REQUEST may carry. eBay's own cap is 5
// per CALL (chunkForMigrate enforces that); this is the separate cap on how many
// calls one HTTP request will fan out to, so a single request can't sit there
// making 40 sequential eBay calls and time out. The UI migrates in pages.
const MIGRATE_MAX_PER_REQUEST = 50;

// US-2387: ceiling on the fleet-wide connection scans (token refresh,
// performance sync, leave-feedback). A growth bound, not a budget — each scan
// fans out per connection and its cron re-runs on a schedule.
const EBAY_CONNECTION_SCAN_CAP = 5_000;
import {
  approveCancellation,
  decideReturn,
  issueReturnRefund,
  outcomeToSaleStatus,
  rejectCancellation,
  searchCancellations,
  searchReturns,
} from "../lib/ebay-postorder.ts";
import {
  acceptPaymentDispute,
  addDisputeEvidence,
  contestPaymentDispute,
  disputeOutcomeToSaleStatus,
  getPaymentDispute,
  getPaymentDisputeActivity,
  isDisputeActionable,
  type PaymentDisputeDetail,
  searchPaymentDisputes,
  uploadDisputeEvidenceFile,
} from "../lib/ebay-disputes.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { registerEbayPublisher } from "../lib/ebay-publish-port.ts";
import { capacityAllowedForUser } from "../lib/plan-gate.ts";
import { pushTokenExpiring } from "../lib/transactional-push.ts";
import {
  notifyListingEnded,
  notifyListingLive,
  notifyPayoutImported,
  notifySaleRecorded,
} from "../lib/selling-activity-notify.ts";
import {
  claimMarketplaceEvent,
  notifyOfferResponded,
  type OfferAction,
} from "../lib/marketplace-event-notify.ts";
import {
  getLowStockThreshold,
  notifyStockLevel,
  type StockEvent,
} from "../lib/inventory-monitor.ts";
import {
  attachPromotionAtPublish,
  clampMarkdownPct,
  createAdForListing,
  createMarkdownSale,
  endMarkdownSale,
  ensureAdCampaign,
  getAdForListing,
  getItemPromotions,
  getItemPromotion,
  buildItemPromotionBody,
  createItemPromotion,
  updateItemPromotion,
  deleteItemPromotion,
  type ItemPromotionInput,
  type PromotedListingRow,
  removeAdForListing,
  resolvePublishAdRate,
  suggestedAdRateForCategory,
  fetchTrendingAdRates,
  summarizePromotedListings,
  syncPromotedListingsForOwner,
  updateMarkdownSale,
  updateAdRateForListing,
} from "../lib/ebay-marketing.ts";
import { refuseWhileImpersonating } from "../lib/destructive-guard.ts";

// US-1447: listings.promo_mode ('cps' default | 'cpc' | 'smart') → the
// attachPromotionAtPublish mode. Unknown/legacy values fall back to CPS.
function promoModeFor(raw: string | null | undefined): "cps" | "cpc" | "smart" {
  return raw === "cpc" || raw === "smart" ? raw : "cps";
}

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

type EbayEnv = {
  Variables: {
    userId: string;
    // Workspace owner — marketplace connections, listings, and payouts all
    // live on the workspace owner since they hold the OAuth tokens.
    workspaceOwnerId: string;
    workspaceRole:
      | "viewer"
      | "member"
      | "listing_manager"
      | "admin"
      | "owner";
  };
};

export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// ── Diagnostics ────────────────────────────────────────────────────
// GET /oauth/debug — returns a sanitized snapshot of how the edge service
// resolved the eBay env vars. No secrets. Use this to spot sandbox/prod
// mismatches and whitespace problems without grepping Coolify settings.
// When a JWT is present we also include this user's account_handle status
// so US-315 backfill can be verified at a glance.
flipdeskEbayRoutes.get("/oauth/debug", async (c) => {
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as string | undefined;
  return c.json(await debugSnapshot(userId));
});

// ── OAuth: start ───────────────────────────────────────────────────
// Returns { consent_url } for the SPA to window.location to. The state
// token is persisted server-side so the callback can verify+identify.
flipdeskEbayRoutes.get("/oauth/start", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const redirectTo = sanitizeRelativePath(c.req.query("redirect_to"));

  // US-382: enforce the marketplace-connection cap server-side. A reconnect of
  // an existing eBay connection must NOT be blocked (it updates the same row,
  // not a new marketplace), so only count +1 when there's no active eBay
  // connection yet.
  const { count: activeEbay } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true);
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "marketplaces", delta: (activeEbay ?? 0) > 0 ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  const state = generateState();
  const { error } = await supabaseAdmin.from("oauth_states").insert({
    state,
    user_id: userId,
    marketplace: "ebay",
    redirect_to: redirectTo,
    // Tighten the lifetime to 10 min (overrides the 15-min table default). (US-274)
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) {
    console.error("[flipdesk-ebay] failed to persist oauth state:", error);
    return c.json({ error: "Could not start eBay sign-in." }, 500);
  }

  let consentUrl: string;
  try {
    consentUrl = buildConsentUrl(state);
  } catch (err) {
    console.error("[flipdesk-ebay] could not build consent URL:", err);
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  // Log the (non-secret) host the browser is about to hit — makes
  // sandbox/production mismatches obvious in Coolify logs.
  console.log(
    `[flipdesk-ebay] consent URL built: host=${new URL(consentUrl).host}`
  );
  return c.json({ consent_url: consentUrl });
});

// ── OAuth: callback (PUBLIC) ───────────────────────────────────────
// eBay redirects the browser here. We verify the state token, exchange the
// code for tokens, store them encrypted, then redirect the user back into
// the app (or to /dashboard/flipdesk/marketplaces by default).
flipdeskEbayRoutes.get("/oauth/callback", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const ebayError = c.req.query("error");
  const ebayErrorDesc = c.req.query("error_description");

  // Resolve the bounce-back destination up front. The web flow has no
  // redirect_to and falls back to the dashboard; the iOS app (US-661) passes
  // an https Universal Link under `/app/oauth/ebay` (with its client_state
  // nonce already in the query) so ASWebAuthenticationSession.Callback.https
  // completes the in-app session deterministically. We read + delete the
  // single-use state row here (when present) so a replay can't reuse it, and
  // so EVERY exit path — including errors — bounces back to the SAME claimed
  // destination (otherwise the iOS web-auth session would hang on an
  // unclaimed https URL on cancel/exchange failures).
  let redirectTo: string | null = null;
  let stateUserId: string | null = null;
  let stateFound = false;
  let stateExpired = false;
  if (state) {
    const { data: stateRow } = await supabaseAdmin
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .eq("marketplace", "ebay")
      .select("user_id, redirect_to, expires_at")
      .maybeSingle();
    if (stateRow) {
      stateFound = true;
      // Defense-in-depth: redirect_to was sanitized at /oauth/start, but
      // re-check here so a legacy/oddly-stored row can't drive an open
      // redirect. (US-274)
      redirectTo = sanitizeRelativePath(stateRow.redirect_to);
      stateUserId = stateRow.user_id;
      stateExpired = new Date(stateRow.expires_at).getTime() < Date.now();
    }
  }

  // Append the `?ebay=<status>` discriminator to whichever destination we
  // bounce to, preserving any query the caller already passed (e.g. the iOS
  // client_state nonce) — `&` when a query already exists, `?` otherwise.
  const finish = (status: string) => {
    const base = redirectTo ?? "/dashboard/flipdesk/marketplaces";
    const sep = base.includes("?") ? "&" : "?";
    return c.redirect(appUrl(`${base}${sep}ebay=${encodeURIComponent(status)}`));
  };

  // eBay sends `error=access_denied` when the user cancels at the consent
  // screen. Other error codes (e.g. unauthorized_client) signal config bugs
  // — log the description so the operator can see it without having to dig
  // through eBay's redirect URL.
  if (ebayError) {
    console.error(
      `[flipdesk-ebay] consent error: ${ebayError} — ${ebayErrorDesc ?? "(no description)"}`
    );
    return finish(ebayError === "access_denied" ? "cancelled" : ebayError);
  }
  if (!code || !state) {
    return finish("cancelled");
  }
  if (!stateFound || !stateUserId) {
    return finish("invalid_state");
  }
  if (stateExpired) {
    return finish("state_expired");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    // US-315: capture the seller's eBay username at connect time so webhooks
    // and admin views know which account a listing publishes under. Identity
    // lookup is non-fatal — a 4xx/network blip should not block connect; the
    // refresh path will backfill on the next token rotation.
    const identity = await getUserIdentityFromToken(tokens.access_token);
    await upsertConnection({
      userId: stateUserId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresInSeconds: tokens.expires_in,
      accountHandle: identity?.username ?? null,
      // US-364: stable id powers verified account-deletion matching.
      externalAccountId: identity?.externalAccountId ?? null,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] OAuth exchange failed:", err);
    return finish("exchange_failed");
  }

  return finish("connected");
});

// ── Disconnect ─────────────────────────────────────────────────────
// User-initiated removal of an eBay connection. US-364: before we drop the
// stored tokens we attempt to REVOKE the grant upstream at eBay (where the
// keyset supports it) so the long-lived refresh token isn't left valid after
// the seller disconnects. Revocation is best-effort — we always deactivate +
// null the local tokens regardless of the upstream result.
//
// Tenant-scoped: only the workspace owner's (or the user's own) ebay rows are
// touched — never an id from the request body.
flipdeskEbayRoutes.post("/disconnect", async (c) => {
  // US-2351 AC3: an impersonating admin must not sever a seller's
  // marketplace link — the disconnect would read as the seller's own.
  const blocked = await refuseWhileImpersonating(c, "Disconnecting a marketplace");
  if (blocked) return blocked;
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  // US-1616 / C3: disconnecting the marketplace is an integration teardown that
  // affects the whole workspace — require admin, not a read-only viewer.
  if (!roleAtLeast(c.get("workspaceRole") ?? "owner", "admin")) {
    return c.json({ error: "This action requires admin access or higher" }, 403);
  }

  // US-1507: a specific connection to disconnect. iOS (multi-account) sends this
  // so it disconnects only the tapped account; when absent, disconnect ALL the
  // user's active eBay connections (the historical single-account behavior). Both
  // paths stay tenant-scoped by user_id.
  let connectionId: string | undefined;
  try {
    const body = (await c.req.json()) as { connection_id?: unknown } | null;
    if (body && typeof body.connection_id === "string" && body.connection_id) {
      connectionId = body.connection_id;
    }
  } catch {
    // No/invalid body → disconnect all (backward compatible).
  }

  let loadQuery = supabaseAdmin
    .from("marketplace_connections")
    .select("id, refresh_token_encrypted, access_token_encrypted")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true);
  if (connectionId) loadQuery = loadQuery.eq("id", connectionId);
  const { data: rows, error: loadErr } = await loadQuery;
  if (loadErr) {
    return c.json({ error: "Could not load eBay connection." }, 500);
  }
  if (!rows || rows.length === 0) {
    // Already disconnected — idempotent success.
    return c.json({ ok: true, revoked: false });
  }

  // Best-effort upstream revoke per connection. Revoking the refresh token
  // invalidates the whole grant; fall back to the access token if that's all
  // we have. Decryption uses the owning user_id as AAD (US-352).
  let revoked = false;
  for (const row of rows) {
    const enc = (row.refresh_token_encrypted ?? row.access_token_encrypted) as
      | string
      | null;
    if (!enc) continue;
    try {
      const token = await decryptToken(enc, { aad: userId });
      const result = await revokeEbayUserToken(
        token,
        row.refresh_token_encrypted ? "refresh_token" : "access_token",
      );
      if (result === "revoked") revoked = true;
    } catch (err) {
      // Never block local deactivation on a decrypt/revoke failure.
      console.warn(
        "[flipdesk-ebay] disconnect revoke failed (continuing):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  let deactQuery = supabaseAdmin
    .from("marketplace_connections")
    .update({
      is_active: false,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      token_expires_at: null,
      refresh_error: "disconnected",
    })
    .eq("user_id", userId)
    .eq("marketplace", "ebay");
  // US-1507: scope the deactivation to the requested connection when given.
  if (connectionId) deactQuery = deactQuery.eq("id", connectionId);
  const { error: deactErr } = await deactQuery;
  if (deactErr) {
    return c.json({ error: "Could not disconnect eBay." }, 500);
  }
  return c.json({ ok: true, revoked });
});

// ── OAuth: refresh ─────────────────────────────────────────────────
// Scheduled job entrypoint. Authenticated via FLIPDESK_INTERNAL_JOB_SECRET
// header so the cron worker can hit it without a user Bearer token. Rotates
// any token expiring in the next 24 hours.
flipdeskEbayRoutes.post("/oauth/refresh", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const horizon = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const { data: expiring, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .lt("token_expires_at", horizon)
    // US-2387: bounded, and ordered by URGENCY — same shape as the depop, etsy
    // and whatnot refresh scans. The cap only drops connections expiring LATEST,
    // which the next tick picks up; an unordered cap would let a soon-expiring
    // token fall through an arbitrary subset repeatedly, and an expired eBay
    // token is a seller's listings going stale.
    .order("token_expires_at", { ascending: true })
    .limit(EBAY_CONNECTION_SCAN_CAP);

  if (error) {
    console.error("[flipdesk-ebay] refresh scan failed:", error);
    return c.json({ error: "Refresh scan failed" }, 500);
  }

  const userIds = Array.from(
    new Set(((expiring ?? []) as { user_id: string }[]).map((r) => r.user_id))
  );

  let refreshed = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      // getUserAccessToken refreshes inline when expiry is near.
      await getUserAccessToken(userId);
      refreshed += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[flipdesk-ebay] refresh failed for user ${userId}:`,
        err instanceof Error ? err.message : err
      );
      // US-626: auto-refresh couldn't renew — nudge the user (iOS) to reconnect.
      void pushTokenExpiring(userId);
    }
  }
  // US-713: same cron run also sweeps Depop connections nearing expiry (shared
  // token-refresh worker alongside eBay). No-op while the connector is disabled.
  const depop = await refreshExpiringDepopConnections();
  // US-1659: and Etsy connections (access tokens expire hourly). No-op while off.
  const etsy = await refreshExpiringEtsyConnections();
  // US-1661: and Whatnot connections. No-op while the connector is disabled.
  const whatnot = await refreshExpiringWhatnotConnections();
  return c.json({ scanned: userIds.length, refreshed, failed, depop, etsy, whatnot });
});

// ── US-151: listing-performance sync (views / watchers / impressions) ──
//
// POST /api/flipdesk/ebay/sync/performance — internal cron (every 6h via
// US-131 scheduler). Pulls Sell Analytics getTrafficReport per active eBay
// connection and writes engagement metrics onto that seller's active listings.
//
// Sell Analytics is a separate grant; sellers on a pre-scope token get a 403.
// We treat that as "access not granted" (flag the connection, skip) rather than
// a failure so one un-upgraded seller never fails the whole batch. The UI reads
// marketplace_connections.analytics_access_denied to prompt a reconnect.

interface PerfListingRow {
  id: string;
  platform_listing_id: string | null;
  watchers: number;
  views_total: number;
  view_trend_7d: Array<{ date: string; views: number }> | null;
}

/** Pull metrics for one seller and write them onto their active eBay listings.
 *  Returns the per-user outcome for the batch summary. */
async function syncListingPerformanceForUser(
  userId: string,
): Promise<{ updated: number; accessDenied: boolean }> {
  let traffic;
  try {
    traffic = await getTrafficReport(userId);
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) {
      await supabaseAdmin
        .from("marketplace_connections")
        .update({ analytics_access_denied: true })
        .eq("user_id", userId)
        .eq("marketplace", "ebay");
      return { updated: 0, accessDenied: true };
    }
    // US-2835: a response we cannot parse is now LOUD and is not fatal to the
    // batch. It must not take down every other seller's sync, and it must not
    // be swallowed either — the whole point of the story is that this failure
    // mode previously produced plausible zeros and no signal at all.
    if (err instanceof TrafficReportShapeError) {
      console.error(
        "[flipdesk-ebay] traffic_report shape not understood for user",
        userId,
        "-",
        err.message,
      );
      return { updated: 0, accessDenied: false };
    }
    throw err;
  }

  // Access worked — clear any stale denial flag.
  await supabaseAdmin
    .from("marketplace_connections")
    .update({ analytics_access_denied: false })
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("analytics_access_denied", true);

  const byListingId = new Map(traffic.map((t) => [t.listingId, t]));

  // This seller's active eBay listings (tenant-scoped via inventory_items —
  // listings has no user_id of its own, US-268).
  const { data: listingRows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_listing_id, watchers, views_total, view_trend_7d, inventory_items!inner(user_id)",
    )
    .eq("platform", "ebay")
    .eq("listing_status", "active")
    .eq("inventory_items.user_id", userId)
    .not("platform_listing_id", "is", null);

  const rows = (listingRows ?? []) as unknown as PerfListingRow[];
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  let updated = 0;

  // US-565: per-day time-series rows behind the listings snapshot columns. One
  // row per (listing, today); upsert so a re-run within the day overwrites.
  const metricRows: Array<{
    listing_id: string;
    user_id: string;
    metric_date: string;
    impressions: number;
    views: number;
    watchers: number;
    click_through_rate: number | null;
  }> = [];

  for (const row of rows) {
    const metrics = row.platform_listing_id
      ? byListingId.get(row.platform_listing_id)
      : undefined;

    // watchers_count mirrors the watcher total kept fresh by the listings pull
    // (getTrafficReport doesn't return watchers) so the analytics columns are
    // self-contained. Stamp every active listing; layer traffic on when eBay
    // reported engagement for it.
    const patch: Record<string, unknown> = {
      watchers_count: row.watchers ?? 0,
      last_metrics_synced_at: nowIso,
    };

    // US-2835: views/impressions are now `number | null`, where null means eBay
    // did not report the metric rather than reported it as nothing. A listing
    // with neither is skipped entirely: writing it as 0/0 is what produced
    // 7,352 rows of zeros that read exactly like six weeks of no traffic.
    //
    // ⚠ THE REMAINING `?? 0` IS A KNOWN, BOUNDED COMPROMISE. listing_metrics
    // and the listings snapshot columns are `integer NOT NULL DEFAULT 0`
    // (00136/00159), so a half-reported record cannot store its missing half
    // honestly without a migration to make them nullable. That case is only
    // reachable when eBay sends one metric and withholds another, which the
    // all-null skip above already excludes the common form of. Making those
    // columns nullable is the proper fix and is deliberately not smuggled into
    // a bug fix.
    if (metrics && (metrics.views != null || metrics.impressions != null)) {
      // Rolling 7-day sparkline series: one point per day, latest snapshot
      // wins, keep the most recent 7.
      const prev = Array.isArray(row.view_trend_7d) ? row.view_trend_7d : [];
      const trend = prev.filter((p) => p && p.date !== today);
      trend.push({ date: today, views: metrics.views ?? 0 });
      patch.views_total = metrics.views ?? 0;
      patch.impressions_7d = metrics.impressions ?? 0;
      patch.click_through_rate = metrics.clickThroughRate;
      patch.view_trend_7d = trend.slice(-7);

      metricRows.push({
        listing_id: row.id,
        user_id: userId,
        metric_date: today,
        impressions: metrics.impressions ?? 0,
        views: metrics.views ?? 0,
        watchers: row.watchers ?? 0,
        click_through_rate: metrics.clickThroughRate,
      });
    }

    const { error } = await supabaseAdmin
      .from("listings")
      .update(patch)
      .eq("id", row.id);
    if (!error) updated += 1;
  }

  // Persist the day's time-series rows in one upsert (US-565). Best-effort: a
  // metrics-history write must never fail the snapshot sync above.
  if (metricRows.length > 0) {
    const { error: metricsErr } = await supabaseAdmin
      .from("listing_metrics")
      .upsert(metricRows, { onConflict: "listing_id,metric_date" });
    if (metricsErr) {
      console.error(
        "[flipdesk-ebay] listing_metrics upsert failed:",
        metricsErr.message,
      );
    }
  }

  return { updated, accessDenied: false };
}

flipdeskEbayRoutes.post("/sync/performance", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  const { data: conns, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("user_id")
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-2387: bounded, and ordered so the scanned set is STABLE run to run. An
    // unordered cap would sync a different arbitrary subset each tick, which is
    // worse than syncing fewer — a seller could go unscanned indefinitely.
    .order("user_id", { ascending: true })
    .limit(EBAY_CONNECTION_SCAN_CAP);
  if (error) {
    console.error("[flipdesk-ebay] performance scan failed:", error);
    return c.json({ error: "Performance scan failed" }, 500);
  }

  const userIds = Array.from(
    new Set(((conns ?? []) as { user_id: string }[]).map((r) => r.user_id)),
  );

  let updated = 0;
  let accessDenied = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      const r = await syncListingPerformanceForUser(userId);
      updated += r.updated;
      if (r.accessDenied) accessDenied += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[flipdesk-ebay] performance sync failed for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return c.json({ scanned: userIds.length, updated, accessDenied, failed });
});

// POST /api/flipdesk/ebay/sync/performance/me — user-facing "Sync now" (US-2233).
// The 6h cron above is job-secret only; this lets a seller refresh their OWN
// listing metrics on demand instead of waiting. Tenant-scoped: it only ever
// touches the caller's listings — syncListingPerformanceForUser writes are keyed
// on ownerId's active listings (via inventory_items, US-268), and the id comes
// from the auth context, never the request body.
flipdeskEbayRoutes.post("/sync/performance/me", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const { updated, accessDenied } = await syncListingPerformanceForUser(ownerId);
    return c.json({ updated, accessDenied });
  } catch (err) {
    console.error(
      `[flipdesk-ebay] on-demand performance sync failed for ${ownerId}:`,
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: "Performance sync failed" }, 500);
  }
});

// ── US-314: business policies + merchant location ────────────────────
//
// GET  /policies          → list cached policies + locations (syncs if empty);
//                           tenant-scoped to the workspace owner.
// PUT  /policies/default  → set the default policy of each kind (and merchant
//                           location key) — written to business_policies and
//                           marketplace_connections respectively.
// POST /policies/sync     → force a fresh pull from eBay (UI "Re-sync" button).

interface BusinessPolicyRow {
  policy_id: string;
  policy_type: "fulfillment" | "payment" | "return";
  policy_name: string;
  is_default: boolean;
  synced_from_ebay_at: string | null;
}

async function listCachedPolicies(userId: string) {
  const { data } = await supabaseAdmin
    .from("business_policies")
    .select("policy_id, policy_type, policy_name, is_default, synced_from_ebay_at")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .order("policy_type", { ascending: true })
    .order("policy_name", { ascending: true });
  return (data ?? []) as BusinessPolicyRow[];
}

async function loadMerchantLocationKey(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("marketplace_connections")
    .select("merchant_location_key")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: read the selected (primary) connection's ship-from location.
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { merchant_location_key: string | null } | null)
    ?.merchant_location_key ?? null;
}

// US-1473: account-level eBay health — Seller Standards (current + projected)
// + the customer-service defect metrics. Read-only; a seller who hasn't granted
// Sell Analytics (or whose account lacks it) gets a graceful { access: false }
// rather than an error, mirroring the traffic-sync's analytics-access handling.
flipdeskEbayRoutes.get("/analytics/account-health", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const [current, projected, inad, inr] = await Promise.all([
      getSellerStandardsProfile(ownerId, "CURRENT"),
      getSellerStandardsProfile(ownerId, "PROJECTED"),
      getCustomerServiceMetric(ownerId, "ITEM_NOT_AS_DESCRIBED", "CURRENT"),
      getCustomerServiceMetric(ownerId, "ITEM_NOT_RECEIVED", "CURRENT"),
    ]);
    // US-1473: surface the actionable alert the AC asks for — a projected drop
    // to Below Standard means fee surcharges + search demotion.
    const projectedBelowStandard =
      projected.standardsLevel === "BELOW_STANDARD";
    return c.json({
      access: true,
      standards: { current, projected },
      customer_service: [inad, inr],
      projected_below_standard: projectedBelowStandard,
    });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) {
      // Not an error: the seller simply hasn't granted Sell Analytics. The UI
      // shows a "reconnect to see account health" affordance.
      return c.json({ access: false });
    }
    console.error("[flipdesk-ebay] /analytics/account-health failed:", err);
    return c.json({ error: "Could not load eBay account health." }, 502);
  }
});

// US-1422: Listing Health — the Sell Compliance violation summary (+ optional
// per-type detail with corrective aspect recommendations for a future one-click
// revise). Read-only; tenant-scoped; a no-access 403 returns { access:false }.
flipdeskEbayRoutes.get("/compliance/summary", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const summaries = await getListingViolationsSummary(ownerId);
    const total = summaries.reduce((n, s) => n + s.listingCount, 0);
    return c.json({ access: true, summaries, total });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /compliance/summary failed:", err);
    return c.json({ error: "Could not load eBay listing health." }, 502);
  }
});

flipdeskEbayRoutes.get("/compliance/violations", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  // ASPECTS_ADOPTION is the most common/actionable type; callers may pass others.
  const complianceType = c.req.query("type") ?? "ASPECTS_ADOPTION";
  try {
    const violations = await getListingViolations(ownerId, complianceType);
    return c.json({ access: true, complianceType, violations });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /compliance/violations failed:", err);
    return c.json({ error: "Could not load eBay listing violations." }, 502);
  }
});

// How many `platform_listing_id`s go into one clearing UPDATE. Bounded because
// the ids land in a PostgREST `in.(…)` list, which becomes a URL — an unbounded
// list is a request that fails on length rather than on anything meaningful.
const COMPLIANCE_CLEAR_CHUNK = 100;

// US-1422 chunk 2: persist per-listing compliance so the pipeline can flag
// unhealthy listings without a live API call. Matched by platform_listing_id,
// writes only to OUR DB (no eBay mutation), tenant-scoped (US-268).
//
// US-2329: it plans the whole write before making any of it, so a listing that
// is still violating is never momentarily recorded as compliant.
flipdeskEbayRoutes.post("/compliance/sync", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const summaries = await getListingViolationsSummary(ownerId);
    // Aggregate open violations per eBay listing id (across compliance types).
    const byListing = new Map<string, { count: number; types: Set<string> }>();
    for (const s of summaries) {
      if (s.listingCount <= 0) continue;
      const details = await getListingViolations(ownerId, s.complianceType);
      for (const v of details) {
        if (!v.listingId) continue;
        const e = byListing.get(v.listingId) ?? {
          count: 0,
          types: new Set<string>(),
        };
        e.count += 1;
        e.types.add(v.complianceType);
        byListing.set(v.listingId, e);
      }
    }

    const nowIso = new Date().toISOString();

    // US-2329 AC1: plan, then write. This used to zero every flagged listing in
    // one statement and re-flag row by row, so between the two — no transaction,
    // so the window is real — every listing with an open eBay policy violation
    // read as compliant.
    const { data: flaggedRows, error: readErr } = await supabaseAdmin
      .from("listings")
      .select("platform_listing_id")
      .eq("user_id", ownerId)
      .gt("compliance_violation_count", 0);
    if (readErr) {
      // Without this list the clear side cannot be a diff, and falling back to
      // "clear everything" is the defect. Fail instead.
      throw new Error(`compliance sync could not read current flags: ${readErr.message}`);
    }
    const plan = planComplianceSync(
      ((flaggedRows ?? []) as Array<{ platform_listing_id: string | null }>).map(
        (r) => r.platform_listing_id,
      ),
      byListing,
    );

    // AC2: an update that fails is a listing whose health is now WRONG in our
    // DB. It used to be counted away — `if (!upErr) flagged += 1` — which
    // reported a smaller success number and no error at all.
    const errors: string[] = [];
    let flagged = 0;
    let cleared = 0;

    // Violators first. A listing that is violating now and was violating before
    // is rewritten in place and never passes through zero.
    for (const t of plan.toFlag) {
      const { error: upErr } = await supabaseAdmin
        .from("listings")
        .update({
          compliance_violation_count: t.count,
          compliance_types: t.types,
          compliance_checked_at: nowIso,
        } as never)
        .eq("user_id", ownerId)
        .eq("platform_listing_id", t.platformListingId);
      if (upErr) errors.push(`flag ${t.platformListingId}: ${upErr.message}`);
      else flagged += 1;
    }

    // Then, and only then, the listings that have genuinely become clean.
    for (let i = 0; i < plan.toClear.length; i += COMPLIANCE_CLEAR_CHUNK) {
      const chunk = plan.toClear.slice(i, i + COMPLIANCE_CLEAR_CHUNK);
      const { error: clearErr } = await supabaseAdmin
        .from("listings")
        .update({
          compliance_violation_count: 0,
          compliance_types: null,
          compliance_checked_at: nowIso,
        } as never)
        .eq("user_id", ownerId)
        .in("platform_listing_id", chunk);
      if (clearErr) errors.push(`clear ${chunk.length} listing(s): ${clearErr.message}`);
      else cleared += chunk.length;
    }

    if (errors.length > 0) {
      // AC2 + AC3: the failure reaches the seller who asked for it, and an
      // operator, in the same breath. `ok:false` is the machine-readable half —
      // a caller that only reads `flagged` would otherwise see a plausible
      // number for a sync that left listings mislabelled.
      console.error("[flipdesk-ebay] /compliance/sync partial failure:", errors);
      captureException(
        new Error(`compliance sync wrote ${errors.length} bad update(s)`),
        { route: "flipdesk.ebay.compliance-sync", userId: ownerId },
      );
      return c.json(
        {
          ok: false,
          access: true,
          flagged,
          cleared,
          failed: errors.length,
          errors: errors.slice(0, 20),
          error: "Some listings could not be updated. Listing health may be out of date.",
        },
        502,
      );
    }

    return c.json({ ok: true, access: true, flagged, cleared });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /compliance/sync failed:", err);
    return c.json({ error: "Could not sync eBay listing health." }, 502);
  }
});

// US-1422 chunk 3 (AC3): apply eBay's corrective aspect recommendations for a
// listing's ASPECTS_ADOPTION violations into its item_specifics_override
// (ADD-ONLY — never overwrite an existing aspect or fabricate a value). This
// writes only to OUR DB; the client then calls the EXISTING revise endpoint with
// resync_ebay_fields:true to push the merged specifics to the live eBay offer,
// so the risky eBay mutation reuses the proven path rather than new code.
flipdeskEbayRoutes.post("/compliance/apply-recommendations/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const listingId = c.req.param("id");
  try {
    // Ownership-scoped load (US-268).
    const { data: listingRow, error: loadErr } = await supabaseAdmin
      .from("listings")
      .select("id, platform_listing_id, item_specifics_override")
      .eq("id", listingId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (loadErr) throw loadErr;
    const row = listingRow as
      | {
          id: string;
          platform_listing_id: string | null;
          item_specifics_override: Record<string, string[]> | null;
        }
      | null;
    if (!row) return c.json({ error: "Listing not found." }, 404);
    if (!row.platform_listing_id) {
      return c.json({ error: "Listing isn't published to eBay yet." }, 409);
    }

    const violations = await getListingViolations(ownerId, "ASPECTS_ADOPTION");
    const match = violations.find(
      (v) => v.listingId === row.platform_listing_id,
    );
    const recs = match?.aspectRecommendations ?? [];

    // US-1505: coerce any legacy string-valued row to string[] so the merged
    // map we re-persist (and later re-PUT to eBay) is uniformly typed.
    const aspects: Record<string, string[]> = normalizeAspectMap(
      row.item_specifics_override as Record<string, unknown> | null,
    );
    const added: string[] = [];
    for (const rec of recs) {
      const name = rec.name.trim();
      const values = rec.values.map((v) => v.trim()).filter((v) => v.length > 0);
      // Add-only: never overwrite a value the seller already set, never invent
      // a name with no recommended values.
      if (!name || values.length === 0) continue;
      if (aspects[name] && aspects[name].length > 0) continue;
      aspects[name] = values;
      added.push(name);
    }

    if (added.length > 0) {
      const { error: upErr } = await supabaseAdmin
        .from("listings")
        .update({ item_specifics_override: aspects } as never)
        .eq("id", row.id)
        .eq("user_id", ownerId);
      if (upErr) throw upErr;
    }

    // The client pushes to eBay via POST /listings/:id/revise { resync_ebay_fields }.
    return c.json({ applied: added.length, aspects: added });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /compliance/apply-recommendations failed:", err);
    return c.json({ error: "Could not apply eBay recommendations." }, 502);
  }
});

// US-1446 chunk 1: recent eBay payouts (the bank deposits) — resellers reconcile
// against the lump-sum payout, not individual transactions. Read-only; tenant-
// scoped; a no-access 403 (stale sell.finances grant) returns { access:false }.
flipdeskEbayRoutes.get("/finances/payouts", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
    const payouts = await getPayouts(ownerId, since);
    // US-1446 chunk 2: persist keyed by (user_id, payout_id) so reconciliation
    // has a stable record and can dedupe against the CSV payout_imports path.
    if (payouts.length > 0) {
      const rows = payouts.map((p) => ({
        user_id: ownerId,
        payout_id: p.payoutId,
        amount_cents: p.amount
          ? Math.round(Number(p.amount.value) * 100)
          : null,
        currency: p.amount?.currency ?? null,
        status: p.payoutStatus || null,
        payout_date: p.payoutDate,
        transaction_count: p.transactionCount,
      }));
      await supabaseAdmin
        .from("ebay_payouts")
        .upsert(rows as never, { onConflict: "user_id,payout_id" });
    }
    return c.json({ access: true, payouts });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /finances/payouts failed:", err);
    return c.json({ error: "Could not load eBay payouts." }, 502);
  }
});

// US-1446 AC2: a payout's constituent sales (linked via sales.payout_reference =
// eBay payoutId) + the net. Tenant-scoped read; the UI expands a payout into
// this list so payout -> transactions -> net is visible.
flipdeskEbayRoutes.get("/finances/payouts/:payoutId/sales", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  const payoutId = c.req.param("payoutId");
  try {
    const { data, error } = await supabaseAdmin
      .from("sales")
      .select(
        "id, inventory_item_id, sale_price, platform_fees, payout_amount, sold_at",
      )
      .eq("user_id", ownerId)
      .eq("payout_reference", payoutId);
    if (error) throw error;
    const sales = (data ?? []) as Array<{
      id: string;
      inventory_item_id: string | null;
      sale_price: number | null;
      platform_fees: number | null;
      payout_amount: number | null;
      sold_at: string | null;
    }>;
    // Net = eBay's reported per-sale payout when present, else sale − fees.
    const net = sales.reduce(
      (sum, s) =>
        sum +
        (s.payout_amount ?? (s.sale_price ?? 0) - (s.platform_fees ?? 0)),
      0,
    );
    return c.json({ sales, net: Math.round(net * 100) / 100 });
  } catch (err) {
    console.error("[flipdesk-ebay] /finances/payouts/:id/sales failed:", err);
    return c.json({ error: "Could not load payout details." }, 502);
  }
});

// US-1475 chunk 1: find eBay catalog product (EPID) candidates for an inventory
// item (by GTIN in the SKU / brand+style/keywords). Read-only, tenant-scoped;
// returns candidates + the top product's authoritative aspects for preview.
flipdeskEbayRoutes.get("/catalog/match", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const itemId = c.req.query("item_id");
  if (!itemId) return c.json({ error: "item_id is required" }, 400);
  try {
    const { data: item, error } = await supabaseAdmin
      .from("inventory_items")
      .select("id, title, brand, style, sku")
      .eq("id", itemId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (error) throw error;
    const it = item as
      | { title?: string; brand?: string | null; style?: string | null; sku?: string | null }
      | null;
    if (!it) return c.json({ error: "Item not found." }, 404);
    // A SKU that's all digits (8–14) is very likely a scanned UPC/EAN (US-598).
    const gtin =
      it.sku && /^\d{8,14}$/.test(it.sku.trim()) ? it.sku.trim() : null;
    const candidates = await searchCatalogProducts({
      gtin,
      brand: it.brand ?? null,
      mpn: it.style ?? null,
      keywords: it.title ?? null,
    });
    // Enrich the top candidate with its catalog aspects so the UI can preview /
    // adopt them (US-1475 chunk 2).
    const top = candidates[0]
      ? await getCatalogProduct(candidates[0].epid)
      : null;
    return c.json({ candidates, top });
  } catch (err) {
    console.error("[flipdesk-ebay] /catalog/match failed:", err);
    return c.json({ error: "Could not search the eBay catalog." }, 502);
  }
});

// US-1475 chunk 2 (AC1-adopt + AC2): adopt an eBay catalog product for an item —
// persist its EPID + merge the catalog's authoritative aspects into ebay_aspects.
// Catalog PREFERRED over AI (overwrites ai_extracted values + fills gaps) but a
// MANUAL (user-set) aspect is never clobbered. Tenant-scoped; OUR-DB write only
// (the EPID reaches eBay at publish via the inventory-item product block).
flipdeskEbayRoutes.post("/catalog/adopt", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  let body: { item_id?: string; epid?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = body.item_id;
  const epid = body.epid;
  if (!itemId || !epid) {
    return c.json({ error: "item_id and epid are required" }, 400);
  }
  try {
    const { data: item, error } = await supabaseAdmin
      .from("inventory_items")
      .select("id, ebay_aspects, ebay_aspect_sources")
      .eq("id", itemId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (error) throw error;
    const it = item as
      | {
          ebay_aspects: Record<string, string[]> | null;
          ebay_aspect_sources: Record<string, string> | null;
        }
      | null;
    if (!it) return c.json({ error: "Item not found." }, 404);

    const product = await getCatalogProduct(epid);
    if (!product) {
      return c.json({ error: "That eBay catalog product no longer exists." }, 404);
    }

    const aspects: Record<string, string[]> = { ...(it.ebay_aspects ?? {}) };
    const sources: Record<string, string> = { ...(it.ebay_aspect_sources ?? {}) };
    let applied = 0;
    for (const [name, values] of Object.entries(product.aspects)) {
      const vals = (values ?? []).filter((v) => v && v.trim());
      if (vals.length === 0) continue;
      // Keep a value the user set by hand; otherwise the catalog wins over AI
      // and fills gaps.
      if (sources[name] === "manual") continue;
      aspects[name] = vals;
      sources[name] = "catalog";
      applied += 1;
    }

    const { error: upErr } = await supabaseAdmin
      .from("inventory_items")
      .update({
        ebay_epid: epid,
        ebay_aspects: aspects,
        ebay_aspect_sources: sources,
      } as never)
      .eq("id", itemId)
      .eq("user_id", ownerId);
    if (upErr) throw upErr;

    return c.json({ epid, applied });
  } catch (err) {
    console.error("[flipdesk-ebay] /catalog/adopt failed:", err);
    return c.json({ error: "Could not adopt the eBay catalog product." }, 502);
  }
});

// US-1448 chunk 1: list the seller's eBay Promotions Manager item promotions
// (order discounts, volume discounts, coupons, sale events) so FlipDesk surfaces
// them. Read-only, tenant-scoped; no-access 403 → { access:false }.
flipdeskEbayRoutes.get("/promotions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const promotions = await getItemPromotions(ownerId);
    return c.json({ access: true, promotions });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /promotions failed:", err);
    return c.json({ error: "Could not load eBay promotions." }, 502);
  }
});

// US-1979 (AC2): item_promotion CRUD.
//
// updateItemPromotion and deleteItemPromotion had ZERO route references — built,
// tested, and unreachable. createItemPromotion existed but only as an automation
// side-effect (flipdesk-automations.ts), never as something a seller could drive.
// So a seller could not create an order/volume/coupon promo on purpose, and could
// never edit or end one they had.
//
// TENANT MODEL — worth stating, because it differs from the refund route next door
// and the difference is not laziness. A refund has a LOCAL mirror (sales), so that
// route proves ownership against our own DB before calling eBay. An item promotion
// has NO local mirror: it exists only on eBay, under the seller's own account,
// reachable only through that seller's own token. There is nothing to check it
// against, and the token-scoping is a real boundary (eBay will not let this
// seller's token touch another seller's promotion), not an assumption about an
// external system's error codes. That is the same posture as the GET above.
//
// Validation is delegated to buildItemPromotionBody, which already enforces eBay's
// per-type rules (ORDER_DISCOUNT needs minSpend + an image, VOLUME_DISCOUNT needs
// buyQuantity, CODED_COUPON needs an 8-15 alphanumeric code) and throws. Those
// throws are the seller's mistake, so they surface as 400, not 502 — re-deriving
// the same rules here would be a second copy to drift.
const ITEM_PROMOTION_TYPES = new Set(["ORDER_DISCOUNT", "VOLUME_DISCOUNT", "CODED_COUPON"]);

function parseItemPromotionInput(raw: unknown): ItemPromotionInput | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "A promotion body is required." };
  const b = raw as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type.toUpperCase() : "";
  if (!ITEM_PROMOTION_TYPES.has(type)) {
    return { error: "type must be ORDER_DISCOUNT, VOLUME_DISCOUNT or CODED_COUPON." };
  }
  const listingIds = Array.isArray(b.listing_ids)
    ? b.listing_ids.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const percentOff = Number(b.percent_off);
  if (!Number.isFinite(percentOff)) return { error: "percent_off must be a number." };

  const input: ItemPromotionInput = {
    type: type as ItemPromotionInput["type"],
    name: typeof b.name === "string" ? b.name : "",
    listingIds,
    percentOff,
  };
  if (b.min_spend && typeof b.min_spend === "object") {
    const m = b.min_spend as { value?: unknown; currency?: unknown };
    if (typeof m.value === "string" && typeof m.currency === "string") {
      input.minSpend = { value: m.value, currency: m.currency };
    }
  }
  if (Number.isFinite(Number(b.buy_quantity))) input.buyQuantity = Number(b.buy_quantity);
  if (typeof b.promotion_image_url === "string") input.promotionImageUrl = b.promotion_image_url;
  if (typeof b.coupon_code === "string") input.couponCode = b.coupon_code;
  if (typeof b.start_date === "string") input.startDate = b.start_date;
  if (typeof b.end_date === "string") input.endDate = b.end_date;
  if (typeof b.priority === "string") input.priority = b.priority;
  return input;
}

// US-1979 (AC2): GET /promotions/:promotionId — the FULL promotion.
//
// The list endpoint above returns summaries only (id/name/type/status/dates). An
// edit UI must read the whole promotion first, because updateItemPromotion is a PUT
// that REPLACES it: prefilling an edit form from the list shape would send back a
// body with no listings, no percent, no minSpend and no coupon code, silently
// wiping the promotion's targeting and discount while it keeps its id and looks
// like it saved. This is the read that makes the PUT safe.
flipdeskEbayRoutes.get("/promotions/:promotionId", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const promotion = await getItemPromotion(ownerId, c.req.param("promotionId"));
    return c.json({ promotion });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false }, 403);
    return failSafe(c, 502, "Couldn't load that promotion.", err, "ebay.promotions.get_one");
  }
});

flipdeskEbayRoutes.post("/promotions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  let raw: unknown;
  try { raw = await c.req.json(); } catch { raw = null; }
  const parsed = parseItemPromotionInput(raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const invalid = validateItemPromotion(parsed);
  if (invalid) return c.json({ error: invalid }, 400);

  let promotionId: string | null;
  try {
    promotionId = await createItemPromotion(ownerId, parsed);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the promotion.", err, "ebay.promotions.create");
  }
  await writeAuditLog(c, {
    action: "ebay.promotion.create",
    targetType: "ebay_promotion",
    targetId: promotionId ?? "unknown",
    details: { type: parsed.type, listings: parsed.listingIds.length, percent_off: parsed.percentOff },
  });
  return c.json({ ok: true, promotion_id: promotionId });
});

flipdeskEbayRoutes.put("/promotions/:promotionId", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const promotionId = c.req.param("promotionId");
  let raw: unknown;
  try { raw = await c.req.json(); } catch { raw = null; }
  const parsed = parseItemPromotionInput(raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const invalid = validateItemPromotion(parsed);
  if (invalid) return c.json({ error: invalid }, 400);

  try {
    // eBay's PUT replaces the whole promotion but keeps the id, so watchers stay
    // attached — hence a full body here rather than a patch.
    await updateItemPromotion(ownerId, promotionId, parsed);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the promotion update.", err, "ebay.promotions.update");
  }
  await writeAuditLog(c, {
    action: "ebay.promotion.update",
    targetType: "ebay_promotion",
    targetId: promotionId,
    details: { type: parsed.type, listings: parsed.listingIds.length, percent_off: parsed.percentOff },
  });
  return c.json({ ok: true, promotion_id: promotionId });
});

flipdeskEbayRoutes.delete("/promotions/:promotionId", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const promotionId = c.req.param("promotionId");
  try {
    await deleteItemPromotion(ownerId, promotionId);
  } catch (err) {
    // Already gone is the desired end state — reconcile rather than error.
    if (!isAlreadyDeletedError(err) && !/\b404\b/.test(String(err))) {
      return failSafe(c, 502, "eBay rejected the promotion delete.", err, "ebay.promotions.delete");
    }
  }
  await writeAuditLog(c, {
    action: "ebay.promotion.delete",
    targetType: "ebay_promotion",
    targetId: promotionId,
    details: {},
  });
  return c.json({ ok: true });
});

// Validate by RUNNING the real builder rather than by re-deriving its rules or
// pattern-matching its error text.
//
// buildItemPromotionBody already encodes eBay's per-type requirements
// (ORDER_DISCOUNT needs minSpend + an image, CODED_COUPON needs an 8-15
// alphanumeric code, ...) and throws on violation. Calling it up front means a
// throw is DEFINITIONALLY the seller's input problem → 400, with the builder's own
// message. The alternative — letting it throw inside createItemPromotion and
// sniffing the message to tell "bad input" from "eBay said no" — was the first cut
// here and is wrong twice over: it couples the route to error-string wording, and
// a rule added to the builder later silently starts 502-ing instead of 400-ing.
// The builder is pure, so running it twice costs nothing.
function validateItemPromotion(input: ItemPromotionInput): string | null {
  try {
    buildItemPromotionBody(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid promotion.";
  }
}

flipdeskEbayRoutes.get("/policies", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    let policies = await listCachedPolicies(ownerId);
    let merchantLocationKey = await loadMerchantLocationKey(ownerId);

    // Empty cache → sync once so the UI has something to render.
    if (policies.length === 0) {
      await syncBusinessPolicies(ownerId);
      policies = await listCachedPolicies(ownerId);
      merchantLocationKey = await loadMerchantLocationKey(ownerId);
    }

    const defaults = {
      fulfillment_policy_id:
        policies.find((p) => p.policy_type === "fulfillment" && p.is_default)?.policy_id ?? null,
      payment_policy_id:
        policies.find((p) => p.policy_type === "payment" && p.is_default)?.policy_id ?? null,
      return_policy_id:
        policies.find((p) => p.policy_type === "return" && p.is_default)?.policy_id ?? null,
      merchant_location_key: merchantLocationKey,
    };
    return c.json({ policies, defaults });
  } catch (err) {
    console.error("[flipdesk-ebay] /policies failed:", err);
    return c.json({ error: "Could not load eBay policies." }, 502);
  }
});

flipdeskEbayRoutes.post("/policies/sync", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const result = await syncBusinessPolicies(ownerId);
    return c.json({
      synced: result.policies.length,
      merchant_location_key: result.merchantLocationKey,
      missing: result.missing,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] /policies/sync failed:", err);
    return c.json({ error: "Could not sync eBay policies." }, 502);
  }
});

flipdeskEbayRoutes.put("/policies/default", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: {
    fulfillment_policy_id?: unknown;
    payment_policy_id?: unknown;
    return_policy_id?: unknown;
    merchant_location_key?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate each id by checking it exists in this workspace's cached
  // policies — prevents writing a stale or foreign id as default. Tenant
  // isolation: ownership is implicit in the user_id-scoped lookup.
  const cached = await listCachedPolicies(ownerId);
  const idsByKind = new Map<string, Set<string>>();
  for (const row of cached) {
    if (!idsByKind.has(row.policy_type)) idsByKind.set(row.policy_type, new Set());
    idsByKind.get(row.policy_type)!.add(row.policy_id);
  }

  const selection: {
    fulfillment_policy_id?: string;
    payment_policy_id?: string;
    return_policy_id?: string;
    merchant_location_key?: string;
  } = {};
  if (typeof body.fulfillment_policy_id === "string") {
    if (!idsByKind.get("fulfillment")?.has(body.fulfillment_policy_id)) {
      return c.json({ error: "Unknown fulfillment policy id" }, 400);
    }
    selection.fulfillment_policy_id = body.fulfillment_policy_id;
  }
  if (typeof body.payment_policy_id === "string") {
    if (!idsByKind.get("payment")?.has(body.payment_policy_id)) {
      return c.json({ error: "Unknown payment policy id" }, 400);
    }
    selection.payment_policy_id = body.payment_policy_id;
  }
  if (typeof body.return_policy_id === "string") {
    if (!idsByKind.get("return")?.has(body.return_policy_id)) {
      return c.json({ error: "Unknown return policy id" }, 400);
    }
    selection.return_policy_id = body.return_policy_id;
  }
  if (typeof body.merchant_location_key === "string" && body.merchant_location_key.trim()) {
    selection.merchant_location_key = body.merchant_location_key.trim();
  }

  await setDefaultPolicies(ownerId, selection);

  const next = await listCachedPolicies(ownerId);
  const nextLocation = await loadMerchantLocationKey(ownerId);
  return c.json({
    policies: next,
    defaults: {
      fulfillment_policy_id:
        next.find((p) => p.policy_type === "fulfillment" && p.is_default)?.policy_id ?? null,
      payment_policy_id:
        next.find((p) => p.policy_type === "payment" && p.is_default)?.policy_id ?? null,
      return_policy_id:
        next.find((p) => p.policy_type === "return" && p.is_default)?.policy_id ?? null,
      merchant_location_key: nextLocation,
    },
  });
});

// POST /policies/location → create a default eBay inventory (merchant)
// location from a ZIP/address the seller confirms once. eBay requires an
// ENABLED location on every offer, and there's no Seller Hub UI to make one,
// so this fills the most common publish blocker ("merchant location").
flipdeskEbayRoutes.post("/policies/location", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }

  let body: {
    postal_code?: unknown;
    country?: unknown;
    address_line1?: unknown;
    city?: unknown;
    state?: unknown;
    name?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const country =
    typeof body.country === "string" && body.country.trim()
      ? body.country.trim().toUpperCase()
      : "US";
  const postalCode =
    typeof body.postal_code === "string" ? body.postal_code.trim() : "";
  // eBay needs a postal code to calculate shipping; enforce a valid US ZIP
  // when country is US (the only marketplace FlipDesk supports today).
  if (country === "US" && !/^\d{5}(-\d{4})?$/.test(postalCode)) {
    return c.json({ error: "A valid US ZIP code is required." }, 400);
  }

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;

  try {
    const result = await createInventoryLocation(ownerId, {
      name: str(body.name),
      address: {
        addressLine1: str(body.address_line1),
        city: str(body.city),
        stateOrProvince: str(body.state),
        postalCode: postalCode || undefined,
        country,
      },
    });
    return c.json({ ok: true, merchant_location_key: result.merchantLocationKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] /policies/location failed:", msg);
    return c.json(
      { error: "Could not create your eBay ship-from location.", detail: msg.slice(0, 300) },
      502,
    );
  }
});

// ── Taxonomy ───────────────────────────────────────────────────────
// These run on the app-level (client_credentials) token — no seller OAuth
// required. Cheap to call, but rate-limited by eBay; the aspects endpoint
// is read-through cached in public.ebay_category_aspects.

flipdeskEbayRoutes.get("/category/suggest", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const q = c.req.query("q")?.trim();
  if (!q) {
    return c.json({ error: "q is required" }, 400);
  }
  try {
    const suggestions = await suggestCategories(q);
    return c.json({ suggestions });
  } catch (err) {
    // US-1559: eBay's Taxonomy API intermittently 500s (errorId 62000,
    // "internal system or process"). Suggestions are advisory — degrade to an
    // empty list instead of a 502 that TanStack Query retries into (and that
    // an upstream proxy can strip CORS headers from, masking the real error).
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] category suggest failed:", msg);
    if (msg.includes("(500)") || msg.includes("62000")) {
      return c.json({ suggestions: [], degraded: true });
    }
    return c.json({ error: "Category suggest failed" }, 502);
  }
});

flipdeskEbayRoutes.get("/category/:id/aspects", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const categoryId = c.req.param("id");
  if (!categoryId) {
    return c.json({ error: "category id is required" }, 400);
  }
  try {
    const result = await getCategoryAspects(categoryId);
    // Which of this category's aspects are already editable as MAIN-PAGE item
    // fields (Brand/Size/Color/Material/Style). A client rendering the
    // specifics inline on the item page uses this to skip those rows rather
    // than show the same value in two inputs — they share one column and one
    // write-authority, so two inputs is just the double-entry confusion.
    const rawAspects = (result.aspects as Record<string, unknown> | undefined)
      ?.aspects;
    const registryAspects = toRegistryAspects(
      Array.isArray(rawAspects) ? rawAspects as AspectSpecRaw[] : [],
    );
    const columnBacked = columnBackedAspectNames(registryAspects);
    // US-2839: the same answer keyed BY COLUMN, so a client can render the
    // item's own Style/Color/Material input from eBay's allowed values instead
    // of only knowing to hide the duplicate row. `?category=` is the item's
    // vertical (clothing / shoes / headwear) when the caller knows it, which is
    // what picks "US Shoe Size" over the generic "Size" on a shoe item.
    const vertical = (c.req.query("category") ?? "").trim().toLowerCase() || null;
    const columnBackedMap = columnBackedAspectMap(registryAspects, vertical);
    return c.json({
      ...result,
      columnBackedAspectNames: columnBacked,
      columnBackedAspects: columnBackedMap,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] category aspects failed:", err);
    return c.json({ error: "Category aspects fetch failed" }, 502);
  }
});

// Category-aware CONDITION options for the composer. Many apparel leaves accept
// only {1000,1500,1750,2990,3000,3010} and reject the legacy USED_* tiers, so a
// fixed dropdown offers conditions eBay then rejects at publish. This returns the
// SELECTABLE conditions for the leaf (best→worst, only ones we can emit) plus the
// full allowed-label list. `restricted:false` (unrestricted / unknown category)
// tells the client to fall back to its full static option list.
// App-token metadata (read-through cached in ebay_category_condition_policies) —
// no seller OAuth or tenant data involved.
flipdeskEbayRoutes.get("/category/:id/conditions", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const categoryId = c.req.param("id");
  if (!categoryId) {
    return c.json({ error: "category id is required" }, 400);
  }
  try {
    const { conditionIds, cached } = await getItemConditionPolicies(categoryId);
    const { options, allowedLabels } = conditionOptionsForCategory(conditionIds);
    return c.json({
      categoryId,
      restricted: conditionIds.length > 0,
      conditionIds,
      options,
      allowedLabels,
      cached,
    });
  } catch (err) {
    // Advisory — never block the composer on a policy-fetch hiccup. The client
    // falls back to the full static option list on any non-200.
    console.error("[flipdesk-ebay] category conditions failed:", err);
    return c.json({ error: "Category conditions fetch failed" }, 502);
  }
});

// US-824: deterministic, NO-AI aspect refill for a category change. Given an
// item + a (possibly new) eBay category, returns the aspects we can fill from
// the item's columns + US-821 canonical attributes — mapped through the shared
// registry (US-822) and normalized to eBay's allowed values (US-823) — plus the
// new category's valid aspect names so the client can classify keep/drop. The
// client calls this when the seller switches category so still-valid values are
// kept and gaps are refilled WITHOUT an AI pass (mirrors the web composer's
// remapAspectsForCategory). `knownAspects` are passed through as `existing` and
// are NEVER overwritten (user-set / still-valid values win).
//
// Tenant-scoped (US-268): the item is loaded by id AND user_id — an item id in
// the body alone never grants access to another tenant's row.
// POST /aspects/write-back — fold specifics-editor edits back into the item's
// structured columns (Brand/Size/Color/Material/Style), so those five stay
// SINGLE-ENTRY no matter which screen the seller typed them on.
//
// The web composer does this inline on save (aspectWriteBackPatch →
// reverseProjectAspectColumns). iOS had no equivalent, so an aspect typed in
// the specifics editor never reached its column — and since the column is the
// write-authority at publish/revise, the seller's entry was silently clobbered
// on the next item save and they had to type it in BOTH places. This endpoint
// gives every non-web client the same close-the-loop write off the SHARED
// registry, rather than a second mapping table that can drift.
flipdeskEbayRoutes.post("/aspects/write-back", async (c) => {
  // US-268: service-role client bypasses RLS — scope the item read AND the
  // update to the caller's workspace, and never trust the body's item id alone.
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  let body: {
    itemId?: string;
    aspects?: Record<string, string[]>;
    sources?: Record<string, string>;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = (body.itemId ?? "").trim();
  if (!itemId) return c.json({ error: "itemId is required" }, 400);
  const aspects = body.aspects ?? {};
  const sources = body.sources ?? {};

  const { data: item, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id, item_category, brand, size, color, material, style")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (itemErr) return c.json({ error: "Could not load item." }, 500);
  if (!item) return c.json({ error: "Item not found." }, 404);

  const patch = reverseColumnAspects(
    item as unknown as RegistryItem,
    aspects,
    sources,
  );
  if (Object.keys(patch).length === 0) return c.json({ updated: {} });

  const { error: upErr } = await supabaseAdmin
    .from("inventory_items")
    .update(patch as never)
    .eq("id", itemId)
    .eq("user_id", userId);
  if (upErr) return c.json({ error: "Could not update item." }, 500);
  return c.json({ updated: patch });
});

flipdeskEbayRoutes.post("/category/:id/derive-aspects", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = (c.get("workspaceOwnerId") ?? c.get("userId")) as
    | string
    | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const categoryId = c.req.param("id");
  if (!categoryId) return c.json({ error: "category id is required" }, 400);

  let body: { itemId?: string; knownAspects?: Record<string, string[]> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = (body.itemId ?? "").trim();
  if (!itemId) return c.json({ error: "itemId is required" }, 400);
  const known = body.knownAspects ?? {};

  const { data: item, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, size, description, condition_notes, item_category, color, material, style, attributes, measurements",
    )
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (itemErr) return c.json({ error: "Could not load item." }, 500);
  if (!item) return c.json({ error: "Item not found." }, 404);

  try {
    const aspectsResp = await getCategoryAspects(categoryId);
    const raw = (aspectsResp.aspects as Record<string, unknown>).aspects;
    const list = Array.isArray(raw) ? (raw as AspectSpecRaw[]) : [];
    const validAspectNames = list
      .map((a) => (a.localizedAspectName ?? "").trim())
      .filter((n) => n.length > 0);
    const derived = deriveAspectsFromItem(
      item as unknown as PublishItem,
      list,
      known,
    );
    // US-1503: fold captured measurements onto the category's free-text
    // measurement aspects (Inseam, Chest Size, …) — the SAME registry mapping
    // AutoLister uses (measurements.ts) — so a measurement edit reaches the
    // composer/publish/revise, not just the initial AI generation. Never
    // overwrites a known/derived value.
    const meas = (item as { measurements?: Measurements }).measurements;
    if (meas && Object.keys(meas).length > 0) {
      const measAspects = resolveMeasurementAspects(
        meas,
        allowedAspectsFromSpec(list),
        { ...known, ...derived },
        "in",
        // US-2796 AC3: a UK or EU number must not fill "US Shoe Size". Absent
        // scale = today's behaviour, so nothing changes for a US shoe.
        shoeScaleOf(item),
      );
      for (const [k, v] of Object.entries(measAspects)) derived[k] = v;
    }
    // The five COLUMN-owned aspects (Brand/Size/Color/Material/Style) are not
    // gap-fills — the main-page column is their write-authority, exactly as the
    // web composer treats them (projectColumnAspects in src/lib/ebay-prefill.ts,
    // and applyColumnAspects on the publish path). `derived` above only fills
    // BLANKS, so an aspect the AI had already written stayed put and a seller who
    // fixed Brand on the item page still had to retype it in the specifics
    // editor. Force the projection here and name the aspects the client must
    // overwrite regardless of their current provenance — that is the whole
    // difference between the desktop and iOS behaviour.
    const registryAspects = toRegistryAspects(list);
    const projection = columnAspectProjection(
      item as unknown as RegistryItem,
      registryAspects,
    );
    for (const [name, values] of Object.entries(projection.set)) {
      derived[name] = values;
    }
    // US-825: tell the client these gap-fills are inventory_derived so its
    // provenance badges and the source map it persists stay accurate.
    const sources = sourcesFor(Object.keys(derived), "inventory_derived");
    return c.json({
      categoryId,
      derived,
      sources,
      validAspectNames,
      // Overwrite these even if they are currently marked manual/AI.
      columnOwned: Object.keys(projection.set),
      // The backing column was blanked — drop these instead of keeping a stale
      // value the seller believes they deleted.
      columnCleared: projection.clear,
    });
  } catch (err) {
    console.error("[flipdesk-ebay] derive-aspects failed:", err);
    return c.json({ error: "Aspect derivation failed" }, 502);
  }
});

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

// ── eBay sync helpers ──────────────────────────────────────────────

// Pulls every offer for the connected seller from the Sell Inventory API.
// Each offer's SKU is matched to inventory_items.sku for THIS user:
//   • match → upsert into `listings` (and forward inventory_items.status to 'listed' when active)
//   • no match → snapshot into `flipdesk_ebay_listings` so the user can see
//     orphaned eBay listings on the Reconciliation page.
// ── Background sync helper ─────────────────────────────────────────
// One row per sync run, written to flipdesk_sync_runs (migration 00073) so the
// Reconciliation page can show a history of what each pull did. Best-effort:
// a logging failure here must never break the sync that already ran.
interface SyncRunStats {
  startedAt: string;
  since: string | null;
  status: "success" | "partial" | "failed";
  total: number;
  matched: number;
  unmatched: number;
  skipped: number;
  legacyMatched: number;
  legacyUnmatched: number;
  legacyDuplicates: number;
  salesNew: number;
  salesUpdated: number;
  salesSkipped: number;
  salesEnriched: number;
  // US-459: cancelled/refunded sale line items handled this run.
  salesReversed: number;
  errors: string[];
}

// Finalize a run. When `runId` is present (the normal path) this UPDATES the
// `running` row claimed by claimSyncRun; otherwise it falls back to an INSERT.
async function recordSyncRun(
  userId: string,
  s: SyncRunStats,
  runId: string | null = null,
): Promise<void> {
  const fields = {
    status: s.status,
    listings_total: s.total,
    listings_matched: s.matched,
    listings_unmatched: s.unmatched,
    listings_skipped: s.skipped,
    legacy_matched: s.legacyMatched,
    legacy_unmatched: s.legacyUnmatched,
    legacy_duplicates: s.legacyDuplicates,
    sales_new: s.salesNew,
    sales_updated: s.salesUpdated,
    sales_skipped: s.salesSkipped,
    sales_enriched: s.salesEnriched,
    sales_reversed: s.salesReversed,
    error_count: s.errors.length,
    errors: s.errors.slice(0, 50),
    since: s.since,
    started_at: s.startedAt,
    finished_at: new Date().toISOString(),
  };
  try {
    if (runId) {
      await supabaseAdmin
        .from("flipdesk_sync_runs")
        .update(fields)
        .eq("id", runId);
    } else {
      await supabaseAdmin
        .from("flipdesk_sync_runs")
        .insert({ user_id: userId, marketplace: "ebay", ...fields });
    }
  } catch (err) {
    console.error("[flipdesk-ebay] failed to record sync run:", err);
  }
}

// Snapshot a sale we pulled from eBay but couldn't match to a FlipDesk
// inventory_item (no SKU match, no eBay item-id match). Without this the sale
// was silently dropped, understating Sold totals and making a "full sales"
// backfill lossy. Upsert is idempotent under retries via the unique
// (user_id, platform_order_id, line_item_id) key.
async function snapshotOrphanSale(
  userId: string,
  order: RemoteOrder,
  li: RemoteOrderLineItem,
): Promise<void> {
  try {
    await supabaseAdmin.from("flipdesk_ebay_orphan_sales").upsert(
      {
        user_id: userId,
        platform_order_id: order.orderId,
        line_item_id: li.lineItemId ?? "",
        ebay_item_id: li.legacyItemId,
        sku: li.sku,
        title: li.title,
        quantity: normalizeUnitCount(li.quantity),
        // li.itemCost is the EXTENDED line total (unit price × quantity); store
        // it as-is — it is already the line revenue, not a per-unit figure.
        sale_price: li.itemCost ? Number(li.itemCost.value) : null,
        shipping_collected: li.shippingCost
          ? Number(li.shippingCost.value)
          : null,
        tax: li.taxes ? Number(li.taxes.value) : null,
        buyer_username: order.buyerUsername,
        sold_at: order.creationDate,
        currency: li.itemCost?.currency ?? "USD",
        raw: { orderPaymentStatus: order.orderPaymentStatus },
        match_status: "unmatched",
        imported_at: new Date().toISOString(),
      },
      { onConflict: "user_id,platform_order_id,line_item_id" },
    );
  } catch (err) {
    console.error("[flipdesk-ebay] failed to snapshot orphan sale:", err);
  }
}

// Extracted from the /listings/pull handler so we can fire it as a
// detached promise and return 202 immediately.  The sync typically takes
// 60-120s (N eBay API calls + Supabase writes) which exceeds Cloudflare's
// 100s proxy timeout.  Returning 202 prevents the 524 → CORS-error cycle
// the browser would otherwise see.
async function doListingsPull(
  userId: string,
  connId: string,
  lastSyncedAt: string | null,
  backfill = false,
  // US-456: the 'running' lock row is claimed by the /listings/pull handler
  // (claimSyncRun) BEFORE this fires, so overlapping pulls are rejected. Both
  // finalizers below update it via runId; the handler's .catch fails it on an
  // unexpected throw. null only on the best-effort path where the claim errored.
  runId: string | null = null,
): Promise<void> {
  const startedAt = new Date().toISOString();
  // US-466: collects truncation warnings from the paginated eBay fetches (and,
  // below, per-item errors). Declared up here so the offers/inventory fetch can
  // record a ceiling hit; a non-empty list flips the run to "partial".
  const errors: string[] = [];
  let offers: RemoteOffer[];
  try {
    offers = await listAllOffers(userId, errors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] listings/pull fetch failed:", msg);
    // Can't surface this to the client (we already returned 202), but
    // log it clearly so it shows up in Coolify's container logs — and record
    // a failed run so the user sees the attempt in the sync history.
    await recordSyncRun(userId, {
      startedAt,
      since: lastSyncedAt,
      status: "failed",
      total: 0,
      matched: 0,
      unmatched: 0,
      skipped: 0,
      legacyMatched: 0,
      legacyUnmatched: 0,
      legacyDuplicates: 0,
      salesNew: 0,
      salesUpdated: 0,
      salesSkipped: 0,
      salesEnriched: 0,
      salesReversed: 0,
      errors: [`fetch offers: ${msg.slice(0, 200)}`],
    }, runId);
    return;
  }

  // Pre-load this user's SKU → inventory_item mapping so we can do the
  // join in memory rather than N+1 queries against Supabase. Catalog fields
  // come along so the sync can make eBay the source of truth (title overwrite,
  // brand/size/color/style/material fill-if-blank) without a per-item read.
  type ItemRow = { id: string; sku: string } & LocalCatalog;
  const { data: itemsBySku } = await supabaseAdmin
    .from("inventory_items")
    .select("id, sku, title, brand, size, color, style, material")
    .eq("user_id", userId)
    .not("sku", "is", null);
  const skuToItemId = new Map<string, string>();
  const itemBySku = new Map<string, ItemRow>();
  for (const r of (itemsBySku ?? []) as ItemRow[]) {
    if (r.sku) {
      skuToItemId.set(r.sku, r.id);
      itemBySku.set(r.sku, r);
    }
  }

  // ── US-405: batched-write accumulators ──────────────────────────────
  // The offers + legacy passes below used to do a per-row SELECT, then an
  // INSERT/UPDATE, then a status flip — thousands of sequential PostgREST
  // round-trips on a large seller. Instead we pre-load existing listings into a
  // map (like the SKU map), accumulate every write in memory, and flush them as
  // a handful of bulk calls before the orders pass. This takes a 1,000-offer
  // sync from minutes to seconds.
  type ExistingListingRow = {
    id: string;
    inventory_item_id: string;
    platform_listing_id: string | null;
    platform_offer_id: string | null;
    listing_url: string | null;
    listing_price: number | null;
    listing_status: string | null;
    listing_title: string | null;
    is_active: boolean | null;
    quantity: number | null;
    listed_at: string | null;
    listing_description: string | null;
    platform_category_id: string | null;
    // US-1081: provenance signals + drift marker. batch_id/synced_to_ebay_at
    // decide whether this listing is GradeThread-originated (GT is the source of
    // truth → inbound pull must NOT overwrite eBay-owned editable fields; it only
    // records that eBay drifted in platform_fields.sync_drift).
    batch_id: string | null;
    synced_to_ebay_at: string | null;
    platform_fields: Record<string, unknown> | null;
    // US-1077: persisted provenance marker. Preserved on matched rows so a pull
    // can't relabel a GradeThread-originated listing as eBay-originated.
    listing_origin: string | null;
  };
  // Every column the offers/legacy passes may write to `listings`. Building a
  // FULL row for every insert AND edit (seeded from the pre-loaded snapshot,
  // then patched) keeps the upsert array uniform — and supplies all the
  // NOT NULL columns — so a single .upsert() on the primary key handles new
  // rows and updates in one round-trip.
  type ListingWrite = {
    id: string;
    inventory_item_id: string;
    platform: "ebay";
    platform_listing_id: string | null;
    platform_offer_id: string | null;
    listing_url: string | null;
    listing_price: number;
    listing_status: string | null;
    is_active: boolean;
    quantity: number | null;
    listed_at: string;
    listing_description: string | null;
    platform_category_id: string | null;
    listing_title: string | null;
    // US-1077: stamped on every flushed row — 'ebay' for new imports, preserved
    // for matched rows (a GradeThread-originated listing stays 'gradethread').
    listing_origin: "ebay" | "gradethread";
  };
  type OrphanWrite = {
    user_id: string;
    ebay_item_id: string;
    custom_label: string | null;
    title: string | null;
    current_price: number | null;
    available_quantity: number | null;
    listing_url: string | null;
    listing_format: string | null;
    start_date: string | null;
    raw: Record<string, unknown>;
    imported_at: string;
  };

  // Inventory statuses a "now listed on eBay" flip is allowed to advance FROM
  // (forward-only — never regress a sold/shipped item).
  const PREP_STATUSES = [
    "sourced",
    "acquired",
    "cataloged",
    "measured",
    "photographed",
    "comped",
    "drafted",
  ];

  // Pre-load this user's existing eBay listings (most-recent per item) so the
  // loops below join in memory instead of a per-row SELECT. Tenant-scoped via
  // the inner join on inventory_items.user_id (listings has no user_id — US-268).
  const existingListingByItem = new Map<string, ExistingListingRow>();
  {
    const { data: rows } = await supabaseAdmin
      .from("listings")
      .select(
        "id, inventory_item_id, platform_listing_id, platform_offer_id, listing_url, listing_price, listing_status, listing_title, is_active, quantity, listed_at, listing_description, platform_category_id, batch_id, synced_to_ebay_at, platform_fields, listing_origin, created_at, inventory_items!inner(user_id)",
      )
      .eq("platform", "ebay")
      .eq("inventory_items.user_id", userId)
      .order("created_at", { ascending: false });
    for (const r of (rows ?? []) as unknown as ExistingListingRow[]) {
      // created_at desc → the first row seen for an item is the most recent.
      if (r.inventory_item_id && !existingListingByItem.has(r.inventory_item_id)) {
        existingListingByItem.set(r.inventory_item_id, r);
      }
    }
  }

  // Accumulators flushed in one bulk call each after both listing passes.
  const pendingListing = new Map<string, ListingWrite>();
  const orphanByEbayId = new Map<string, OrphanWrite>();
  // Items eBay reports as ACTIVE → flip to 'listed'. The notify set (modern
  // offers) emits the "listing is live" notification on the real transition;
  // the silent set (legacy listings) flips without notifying, matching the
  // prior behavior where only the modern pass notified.
  const listedNotifyItemIds = new Set<string>();
  const listedSilentItemIds = new Set<string>();

  // Seed (or fetch) the pending write row for an item — from the pre-loaded
  // snapshot when one exists, otherwise a fresh row with a client-generated id
  // so a later pass (and the flush) addresses the same row instead of inserting
  // a duplicate.
  function ensurePendingListing(itemId: string): ListingWrite {
    const cached = pendingListing.get(itemId);
    if (cached) return cached;
    const ex = existingListingByItem.get(itemId);
    const w: ListingWrite = ex
      ? {
          id: ex.id,
          inventory_item_id: itemId,
          platform: "ebay",
          platform_listing_id: ex.platform_listing_id ?? null,
          platform_offer_id: ex.platform_offer_id ?? null,
          listing_url: ex.listing_url ?? null,
          listing_price: ex.listing_price ?? 0,
          listing_status: ex.listing_status ?? null,
          is_active: ex.is_active ?? false,
          quantity: ex.quantity ?? null,
          listed_at: ex.listed_at ?? new Date().toISOString(),
          listing_description: ex.listing_description ?? null,
          platform_category_id: ex.platform_category_id ?? null,
          listing_title: ex.listing_title ?? null,
          // Preserve the stored provenance (deriveListingOrigin returns the
          // persisted marker when valid, else derives from the same signals).
          listing_origin: deriveListingOrigin({
            listing_origin: ex.listing_origin,
            platform: "ebay",
            platform_listing_id: ex.platform_listing_id,
            batch_id: ex.batch_id,
            synced_to_ebay_at: ex.synced_to_ebay_at,
          }),
        }
      : {
          id: crypto.randomUUID(),
          inventory_item_id: itemId,
          platform: "ebay",
          platform_listing_id: null,
          platform_offer_id: null,
          listing_url: null,
          listing_price: 0,
          listing_status: null,
          is_active: false,
          quantity: null,
          listed_at: new Date().toISOString(),
          listing_description: null,
          platform_category_id: null,
          listing_title: null,
          // A brand-new row from the eBay pull is eBay-originated.
          listing_origin: "ebay",
        };
    pendingListing.set(itemId, w);
    return w;
  }

  // Copy the defined keys of a (pin-filtered) patch onto a pending write row.
  // `undefined` means "leave the existing value" — exactly the semantics the
  // per-row update/insert relied on.
  function applyListingPatch(
    w: ListingWrite,
    patch: Record<string, unknown>,
  ): void {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (w as Record<string, unknown>)[k] = v;
    }
  }

  // US-2656: what eBay said about each matched item's listing THIS run, keyed by
  // inventory_item_id. Collected during the offer passes and consumed after the
  // orders pass, because whether a seller needs to be told anything depends on
  // something the offer loop cannot know yet: an item that stopped being active
  // because it SOLD needs no explanation, while the same eBay status on an item
  // with no sale is the thing the seller has been given a hardcoded guess about.
  const ebayStateByItem = new Map<string, EbayListingState>();

  // Catalog-backfill bookkeeping. GetItem (legacy specifics) is gated to items
  // still missing a field and capped per run, so first-sync cost tapers to ~0.
  const MAX_SPECIFICS_FETCH_PER_SYNC = 300;
  let catalogUpdated = 0;
  let specificsFetched = 0;
  let specificsCapped = false;

  // Apply an eBay-sourced catalog patch to a matched inventory_item, keeping
  // our in-memory ItemRow in sync so the orders pass below sees fresh values.
  // Kept as a per-row UPDATE (not folded into the bulk upsert): inventory_items
  // has NOT NULL columns we don't carry here (status, etc.), and the INSERT arm
  // of an upsert would either violate them or clobber a live status. Patches are
  // gated (fill-if-blank / title-change) so steady-state syncs issue ~0 of these.
  async function applyCatalogPatch(
    itemId: string,
    row: ItemRow,
    patch: CatalogPatch,
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    // Tenant-safe: itemId came from this user's itemBySku map (US-268).
    const { error } = await supabaseAdmin
      .from("inventory_items")
      .update(patch)
      .eq("id", itemId);
    if (error) {
      errors.push(`catalog ${itemId}: ${error.message.slice(0, 120)}`);
      return;
    }
    Object.assign(row, patch);
    catalogUpdated += 1;
  }

  let matched = 0;
  let unmatched = 0;
  let skipped = 0;
  // Tracks every eBay listingId we've already upserted in this pass — used
  // by the legacy Trading API pass below to skip listings already covered
  // by the modern Sell Inventory loop.
  const processedListingIds = new Set<string>();
  // Items whose eBay listing came back ended/inactive this sync. After the
  // orders pass marks genuine sales as 'sold', anything left here that's still
  // 'listed' ended WITHOUT a sale → auto-move it back to Drafts so the seller
  // can edit + relist it (Path A).
  const endedItemIds = new Set<string>();
  // US-148: what eBay said about each matched listing, captured BEFORE the
  // eBay-wins overwrite below, so cross-source conflicts keep FlipDesk's
  // original value. Recorded in one batch after the orders pass (status
  // observations for listings that ended via a genuine sale are dropped —
  // "sold vs ended" isn't a disagreement worth flagging).
  const ebayObservations: (SourceObservation & { itemId?: string })[] = [];
  // Statuses where an eBay-vs-FlipDesk status diff is meaningful; sold /
  // relisted are FlipDesk-richer states eBay can't express.
  const COMPARABLE_STATUSES = new Set(["active", "ended", "draft"]);

  // US-1081: per-listing platform_fields writes for drift bookkeeping on
  // GradeThread-originated listings (keyed by listing id). Flushed after the
  // loop. Separate from the bulk listing upsert — that upsert never carries
  // platform_fields, so these writes aren't clobbered.
  // Staged platform_fields edits, keyed by listings.id. The drift marker and the
  // US-2656 eBay-state record BOTH live in this one JSON column, so they share
  // one staging map: two writers each doing their own read-modify-write would
  // let whichever flushed last erase the other's key.
  const driftFieldWrites = new Map<string, Record<string, unknown>>();
  const stagePlatformFields = (
    listingId: string,
    prevPf: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> => {
    let cur = driftFieldWrites.get(listingId);
    if (!cur) {
      cur = { ...(prevPf ?? {}) };
      driftFieldWrites.set(listingId, cur);
    }
    return cur;
  };

  // US-1056: low-stock / stockout events observed this pull, keyed by listing id
  // (last write wins) so a listing touched by both the modern + legacy passes
  // only notifies once. Collected only for eBay-source-of-truth listings (eBay
  // owns the quantity there) and flushed AFTER the listings upsert commits, so a
  // failed write never produces a phantom alert.
  const lowStockEvents = new Map<string, StockEvent>();

  // US-1078: provenance-aware inbound merge, shared by the modern-offers and
  // legacy (Trading API) passes. Authority follows listing provenance now —
  // this RETIRES the US-148 per-field source_of_truth pin (`pinnedAgainstEbay`),
  // which is no longer read from the pull (listings.source_of_truth is
  // deprecated for the eBay↔FlipDesk axis; see vault/20-domain/sync-source-of-truth.md).
  //
  // • listing_origin='ebay'        — eBay is the source of truth: the patch is
  //   left untouched (full mirror — every eBay-owned field flows through).
  // • listing_origin='gradethread' — GradeThread is the source of truth: the
  //   eBay-owned editable fields (title/price/description/quantity/category) are
  //   deleted from the patch so the pull never clobbers a FlipDesk edit. The
  //   read-only signals (listing_status/is_active) already in the patch still
  //   flow in. Any eBay drift is recorded in platform_fields.sync_drift so the
  //   editor can offer a non-blocking "Re-push to eBay" re-assert.
  //
  // Origin is derived from the same signals US-1077 backfills from, so the
  // behavior is forward-compatible once the listing_origin column is persisted.
  const applyProvenanceMerge = (
    existing: ExistingListingRow | null,
    patch: Record<string, unknown>,
    fromEbay: {
      title?: string | null;
      price?: number | null;
      description?: string | null;
    },
  ): "ebay" | "gradethread" => {
    const origin = existing
      ? deriveListingOrigin({
          platform: "ebay",
          platform_listing_id: existing.platform_listing_id,
          batch_id: existing.batch_id,
          synced_to_ebay_at: existing.synced_to_ebay_at,
        })
      : "ebay";
    if (!existing || origin !== "gradethread") return origin;

    const drifted: string[] = [];
    const ebaySnapshot: Record<string, unknown> = {};
    const title = fromEbay.title?.trim();
    if (
      title &&
      existing.listing_title != null &&
      title !== existing.listing_title.trim()
    ) {
      drifted.push("title");
      ebaySnapshot.title = title;
    }
    if (
      fromEbay.price != null &&
      existing.listing_price != null &&
      Math.abs(fromEbay.price - existing.listing_price) > 0.005
    ) {
      drifted.push("price");
      ebaySnapshot.price = fromEbay.price;
    }
    const description = fromEbay.description?.trim();
    if (
      description &&
      existing.listing_description != null &&
      description !== existing.listing_description.trim()
    ) {
      drifted.push("description");
      ebaySnapshot.description = description;
    }

    // Keep GradeThread's values — never let eBay win on a GT-originated listing.
    //
    // US-1994: the locked set is DERIVED from sync-precedence.ts rather than
    // hand-listed here. This block used to enumerate five deletes, which drifted
    // from the module documenting the same contract — and because the module had
    // the tests and no callers, its green suite read as proof of a rule only it
    // enforced. Now there is one registry: anything eBay owns that is not in
    // LISTING_PULL_ALLOWED_ON_GT_ORIGIN (state signals + eBay-ASSIGNED identity)
    // is dropped, so adding a field to EBAY_OWNED_LISTING_FIELDS locks it here
    // automatically instead of silently leaking through.
    for (const field of EBAY_OWNED_LISTING_FIELDS) {
      if (!LISTING_PULL_ALLOWED_ON_GT_ORIGIN.includes(field)) {
        delete (patch as Record<string, unknown>)[field];
      }
    }

    // Record (or clear) the drift marker; informational only — we never pull
    // eBay's drifted value into GradeThread. Skip the write unless the marker
    // actually changes so a steady-state sync stays free.
    const prevPf = (existing.platform_fields ?? {}) as Record<string, unknown>;
    const hadDrift = !!(prevPf as { sync_drift?: unknown }).sync_drift;
    if (drifted.length > 0) {
      stagePlatformFields(existing.id, prevPf).sync_drift = {
        fields: drifted,
        ebay: ebaySnapshot,
        detected_at: new Date().toISOString(),
      };
    } else if (hadDrift) {
      delete (stagePlatformFields(existing.id, prevPf) as { sync_drift?: unknown })
        .sync_drift;
    }
    return origin;
  };

  for (const o of offers) {
    try {
      // No live listingId on this offer. Normally that's a genuine draft
      // (unpublished offer) — skip. BUT if we still hold a LIVE local listing
      // for this SKU, eBay just told us it's no longer live: the listing ended,
      // sold out, or was REMOVED BY EBAY for a policy issue (eBay drops a
      // policy-removed listing out of the active feed, so it returns with no
      // listingId). Reconcile it to ended so Path A (below) drops the item back
      // to Drafts and it becomes relistable, instead of leaving it stuck
      // "active" forever. Gate on an existing ACTIVE local row so a legitimately
      // unpublished draft is never touched.
      if (!o.listingId) {
        const goneItemId = o.sku ? skuToItemId.get(o.sku) ?? null : null;
        const goneExisting = goneItemId
          ? existingListingByItem.get(goneItemId) ?? null
          : null;
        if (
          goneItemId &&
          goneExisting &&
          (goneExisting.is_active === true ||
            goneExisting.listing_status === "active")
        ) {
          // US-2656: absence is its own fact, distinct from any status eBay
          // could have sent, so it carries its own reason onto the row.
          const gone = absentListingState();
          applyListingPatch(ensurePendingListing(goneItemId), {
            listing_status: gone.status,
            is_active: gone.isActive,
          });
          ebayStateByItem.set(goneItemId, gone);
          endedItemIds.add(goneItemId);
        }
        skipped += 1;
        continue;
      }
      const sku = o.sku;
      const itemId = sku ? skuToItemId.get(sku) ?? null : null;
      const priceNum = o.price ? Number(o.price.value) : null;
      // US-2656: every non-ACTIVE answer used to become "ended" right here, in a
      // single ternary, and the reason eBay gave was dropped on the floor. The
      // resolver keeps eBay's own word and what it means; OUT_OF_STOCK in
      // particular resolves to ACTIVE, because that listing is still on eBay and
      // relisting it would mint a duplicate.
      // US-2684: the quantity rides along because eBay answers "is this
      // buyable" there far more reliably than it does in listingStatus. A
      // cancelled order leaves availableQuantity at 0 with the status still
      // reading ACTIVE, and that listing is live, holding its item id, and
      // unbuyable — which is exactly the state nothing here could name.
      const ebayState = resolveEbayListingState(o.listingStatus, o.availableQuantity);
      const isActive = ebayState.isActive;

      if (itemId) {
        // US-405: the existing listing comes from the pre-loaded map, not a
        // per-row SELECT.
        const existing = existingListingByItem.get(itemId) ?? null;

        // US-148: capture eBay-vs-FlipDesk disagreements before the overwrite.
        if (existing) {
          const ebayStatus = ebayState.status;
          if (priceNum != null) {
            ebayObservations.push({
              listingId: existing.id,
              field: "price",
              flipdeskValue: existing.listing_price,
              observedValue: priceNum,
            });
          }
          // Quantity only once FlipDesk has an opinion (column seeded below).
          if (existing.quantity != null && o.availableQuantity != null) {
            ebayObservations.push({
              listingId: existing.id,
              field: "quantity",
              flipdeskValue: existing.quantity,
              observedValue: o.availableQuantity,
            });
          }
          if (
            existing.listing_status &&
            COMPARABLE_STATUSES.has(existing.listing_status)
          ) {
            ebayObservations.push({
              listingId: existing.id,
              field: "listing_status",
              flipdeskValue: existing.listing_status,
              observedValue: ebayStatus,
              itemId,
            });
          }
          if (o.title && o.title.trim()) {
            ebayObservations.push({
              listingId: existing.id,
              field: "title",
              flipdeskValue: existing.listing_title,
              observedValue: o.title,
            });
          }
        }

        const patch: Record<string, unknown> = {
          platform_listing_id: o.listingId,
          platform_offer_id: o.offerId,
          listing_url: ebayListingUrl(o.listingId),
          listing_price: priceNum ?? undefined,
          listing_status: ebayState.status,
          is_active: ebayState.isActive,
          quantity: o.availableQuantity ?? undefined,
        };
        // eBay's own listing start date is authoritative — write it through so
        // the "List Date" column is populated even on sync-discovered listings
        // (we never set listed_at on insert below otherwise). Only overwrite
        // when eBay actually returned a date.
        if (o.listingStartDate) {
          patch.listed_at = o.listingStartDate;
        }
        // Pull description back from eBay so manual Seller Hub edits don't
        // leave FlipDesk's copy stale. Skip empty strings — those usually
        // mean "API didn't return a body", not "user blanked it".
        if (o.listingDescription && o.listingDescription.trim()) {
          patch.listing_description = o.listingDescription;
        }
        if (o.categoryId) {
          patch.platform_category_id = o.categoryId;
        }

        // US-1078: provenance-aware inbound merge (shared with the legacy pass).
        // GT-originated → keep GradeThread's editable fields + record drift;
        // eBay-originated → full mirror (patch untouched). Supersedes the US-148
        // source_of_truth pin.
        const origin = applyProvenanceMerge(existing, patch, {
          title: o.title,
          price: priceNum,
          description: o.listingDescription,
        });
        // US-1056: on an eBay-source-of-truth listing, eBay's reported available
        // quantity is authoritative — record a low-stock crossing as units sell.
        // (GT-origin listings keep their own quantity, so eBay's number there is
        // drift, not real stock; skip them.)
        if (existing && origin === "ebay" && o.availableQuantity != null) {
          lowStockEvents.set(existing.id, {
            userId,
            listingId: existing.id,
            itemId,
            title: existing.listing_title,
            prevQty: existing.quantity,
            newQty: o.availableQuantity,
          });
        }
        // US-405: accumulate the write — flushed as one bulk upsert after both
        // listing passes. ensurePendingListing seeds a full row from the
        // pre-loaded snapshot (or a fresh client-id'd row), then the patch is
        // merged on top.
        applyListingPatch(ensurePendingListing(itemId), patch);
        ebayStateByItem.set(itemId, ebayState);
        // US-2656: persist eBay's OWN verdict next to ours, so the reason a
        // listing is not selling survives the collapse into two local statuses
        // and the UI can say "eBay marked this inactive" rather than "ended".
        //
        // Written only on a CHANGE. A steady-state sync of an ACTIVE listing must
        // stay free of writes (the drift marker next door is careful about the
        // same thing), and re-stamping an unchanged verdict every 30 minutes
        // would also make observed_at meaningless — its value is that it dates
        // the TRANSITION.
        if (existing) {
          const prevPf = (existing.platform_fields ?? {}) as {
            ebay_state?: { status?: string; reason?: string };
          };
          const prev = prevPf.ebay_state;
          if (
            prev?.status !== ebayState.status ||
            prev?.reason !== ebayState.reason
          ) {
            stagePlatformFields(
              existing.id,
              existing.platform_fields as Record<string, unknown> | null,
            ).ebay_state = {
              status: ebayState.status,
              reason: ebayState.reason,
              ebay_status: ebayState.ebayStatus,
              message: ebayState.message,
              observed_at: new Date().toISOString(),
            };
          }
        }
        // Forward-only status — don't regress sold/shipped items. The flip is
        // batched after the loop; the modern pass notifies on the real
        // transition (notify set), the legacy pass flips silently.
        if (isActive) {
          listedNotifyItemIds.add(itemId);
        } else {
          // eBay reports this offer's listing as ended/inactive. Remember it so
          // the post-orders reconciliation can move it back to Drafts if it
          // ended without a sale (Path A — relist of ended listings).
          endedItemIds.add(itemId);
        }
        // eBay as source of truth: title overwrite, specifics fill-if-blank.
        // Modern offers carry title + aspects (from listAllOffers) — free.
        // US-1081: for GradeThread-originated listings GradeThread owns the
        // title, so skip eBay's title overwrite (specifics still fill-if-blank).
        const localRow = sku ? itemBySku.get(sku) : undefined;
        if (localRow) {
          await applyCatalogPatch(
            itemId,
            localRow,
            buildCatalogPatch(localRow, {
              title: origin === "gradethread" ? null : o.title,
              specifics: flattenAspects(o.aspects),
            }),
          );
        }
        matched += 1;
      } else {
        // Snapshot orphan eBay listings — surfaced on the Reconciliation page.
        // US-405: collected into a map and bulk-upserted after the loop. Keyed
        // by ebay_item_id so a duplicate id within the run can't make the bulk
        // upsert "affect a row a second time".
        orphanByEbayId.set(o.listingId, {
          user_id: userId,
          ebay_item_id: o.listingId,
          custom_label: sku ?? null,
          title: null,
          current_price: priceNum,
          available_quantity: o.availableQuantity ?? null,
          listing_url: ebayListingUrl(o.listingId),
          listing_format: o.format ?? null,
          start_date: null,
          raw: {
            offerId: o.offerId,
            listingStatus: o.listingStatus,
            categoryId: o.categoryId,
            price: o.price,
          },
          // US-465 AC2: do NOT write match_status here. Omitting it means a
          // brand-new orphan gets the column default ('unmatched') on INSERT,
          // while an existing row's match_status (and matched_item_id, also
          // omitted) is PRESERVED on conflict — so a manually-linked orphan is
          // never resurrected as unmatched by a later re-sync.
          imported_at: new Date().toISOString(),
        });
        unmatched += 1;
      }
      processedListingIds.add(o.listingId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg.slice(0, 200));
    }
  }

  // ── Legacy listings (Trading API) ───────────────────────────────
  // Pulls every active listing from GetMyeBaySelling — covers items
  // created in Seller Hub or via the legacy ListItem call that never
  // became inventory_items on the new REST surface. We dedupe against
  // listingIds already processed above so an item that exists on both
  // surfaces isn't double-counted.
  let legacyMatched = 0;
  let legacyUnmatched = 0;
  let legacyDuplicates = 0;
  try {
    const legacy: LegacyEbayListing[] = await getAllActiveEbaySelling(userId);
    for (const l of legacy) {
      try {
        if (processedListingIds.has(l.ebayItemId)) {
          legacyDuplicates += 1;
          continue;
        }
        const sku = l.sku;
        const itemId = sku ? skuToItemId.get(sku) ?? null : null;

        if (itemId) {
          // Same write path as the modern flow — but no platform_offer_id
          // because legacy listings don't have a Sell Inventory offer.
          // US-405: existing listing from the pre-loaded map (may already hold
          // an in-memory write from the modern pass for this same item).
          const existing = existingListingByItem.get(itemId) ?? null;

          // US-148: GetMyeBaySelling only returns ACTIVE listings.
          if (existing) {
            const legacyQty = l.quantityAvailable ?? l.quantity;
            if (l.currentPrice != null) {
              ebayObservations.push({
                listingId: existing.id,
                field: "price",
                flipdeskValue: existing.listing_price,
                observedValue: l.currentPrice,
              });
            }
            if (existing.quantity != null && legacyQty != null) {
              ebayObservations.push({
                listingId: existing.id,
                field: "quantity",
                flipdeskValue: existing.quantity,
                observedValue: legacyQty,
              });
            }
            if (
              existing.listing_status &&
              COMPARABLE_STATUSES.has(existing.listing_status)
            ) {
              ebayObservations.push({
                listingId: existing.id,
                field: "listing_status",
                flipdeskValue: existing.listing_status,
                observedValue: "active",
                itemId,
              });
            }
            if (l.title && l.title.trim()) {
              ebayObservations.push({
                listingId: existing.id,
                field: "title",
                flipdeskValue: existing.listing_title,
                observedValue: l.title,
              });
            }
          }

          const patch: Record<string, unknown> = {
            platform_listing_id: l.ebayItemId,
            listing_url: l.listingUrl ?? ebayListingUrl(l.ebayItemId),
            listing_price: l.currentPrice ?? undefined,
            listing_status: "active",
            is_active: true,
            quantity: l.quantityAvailable ?? l.quantity ?? undefined,
          };
          // Trading API gives us ListingDetails.StartTime — write it through to
          // listed_at so the "List Date" column reflects eBay's record.
          if (l.startTime) patch.listed_at = l.startTime;
          if (l.title && l.title.trim()) patch.listing_title = l.title;
          if (l.primaryCategoryId) patch.platform_category_id = l.primaryCategoryId;
          // US-1078: provenance-aware inbound merge (shared with the modern
          // pass). GT-originated → keep GradeThread's editable fields (title/
          // price/quantity/category) + record drift; eBay-originated → full
          // mirror. GetMyeBaySelling returns no body, so no description signal.
          const origin = applyProvenanceMerge(existing, patch, {
            title: l.title,
            price: l.currentPrice ?? null,
            description: null,
          });
          // US-1056: low-stock crossing on an eBay-source-of-truth listing (see
          // the modern pass for the GT-origin caveat). Re-resolve the eBay
          // quantity here (the earlier `legacyQty` is scoped to the if-existing
          // block above).
          const newQty = l.quantityAvailable ?? l.quantity;
          if (existing && origin === "ebay" && newQty != null) {
            lowStockEvents.set(existing.id, {
              userId,
              listingId: existing.id,
              itemId,
              title: existing.listing_title,
              prevQty: existing.quantity,
              newQty,
            });
          }
          // US-405: accumulate the write (merging onto any row the modern pass
          // already seeded for this item) and the silent status flip.
          applyListingPatch(ensurePendingListing(itemId), patch);
          listedSilentItemIds.add(itemId);
          // eBay as source of truth. Legacy (GetMyeBaySelling) gives us the
          // title for free, but NOT item specifics — fetch those via GetItem
          // ONLY when this item still has a blank target field, and only while
          // under the per-sync cap (so the first backfill is bounded and later
          // syncs cost ~0 calls). Title still syncs even when the cap is hit.
          const localRow = sku ? itemBySku.get(sku) : undefined;
          if (localRow) {
            const needsSpecifics = FILL_IF_BLANK_FIELDS.some(
              (f) => !localRow[f] || !localRow[f]!.trim(),
            );
            let specifics: Record<string, string> = {};
            if (needsSpecifics) {
              if (specificsFetched < MAX_SPECIFICS_FETCH_PER_SYNC) {
                specificsFetched += 1;
                specifics = await getItemSpecifics(userId, l.ebayItemId);
              } else {
                specificsCapped = true;
              }
            }
            await applyCatalogPatch(
              itemId,
              localRow,
              // US-1078: GradeThread owns the title on GT-originated listings —
              // skip eBay's title overwrite (specifics still fill-if-blank).
              buildCatalogPatch(localRow, {
                title: origin === "gradethread" ? null : l.title,
                specifics,
              }),
            );
          }
          legacyMatched += 1;
        } else {
          // Orphan: most legacy Seller-Hub listings have no Custom Label.
          // Snapshot with the title so the Reconciliation page can show it
          // and let the user link it to a FlipDesk SKU. US-405: bulk-upserted
          // after the loop (keyed by ebay_item_id).
          orphanByEbayId.set(l.ebayItemId, {
            user_id: userId,
            ebay_item_id: l.ebayItemId,
            custom_label: sku ?? null,
            title: l.title ?? null,
            current_price: l.currentPrice ?? null,
            available_quantity: l.quantityAvailable ?? l.quantity ?? null,
            listing_url: l.listingUrl ?? null,
            listing_format: l.listingType ?? null,
            start_date: l.startTime ? l.startTime.slice(0, 10) : null,
            raw: {
              source: "trading_api",
              watchCount: l.watchCount,
              endTime: l.endTime,
            },
            // US-465 AC2: omit match_status so a manual link survives re-sync
            // (default 'unmatched' applies only to brand-new rows; existing
            // match_status + matched_item_id are preserved on conflict).
            imported_at: new Date().toISOString(),
          });
          legacyUnmatched += 1;
        }
        processedListingIds.add(l.ebayItemId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`legacy ${l.ebayItemId}: ${msg.slice(0, 160)}`);
      }
    }
  } catch (err) {
    // Trading API failure shouldn't fail the whole pull. Common cause:
    // legacy seller account that's been migrated to Sell Inventory only.
    console.error("[flipdesk-ebay] Trading API pass failed:", err);
    errors.push(
      `trading api: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── US-405: flush the batched writes from the offers + legacy passes ─────
  // A handful of bulk calls replaces the thousands of per-row round-trips the
  // loops above used to make. This runs BEFORE the ebayItemIdToItemId rebuild
  // and the orders pass below, both of which read `listings` fresh from the DB.
  if (pendingListing.size > 0) {
    // Every row is a full ListingWrite (all NOT NULL columns present), so a
    // single upsert on the primary key inserts new rows and updates existing
    // ones in one round-trip.
    const { error } = await supabaseAdmin
      .from("listings")
      .upsert(Array.from(pendingListing.values()), { onConflict: "id" });
    if (error) errors.push(`listings upsert: ${error.message.slice(0, 160)}`);
  }
  // US-1056: now that the new quantities are committed, fire low-stock /
  // stockout notifications for any listing that crossed down this pull. Read the
  // threshold once and reuse it. Best-effort: notifyStockLevel self-filters
  // (only a downward crossing alerts) and never throws.
  if (lowStockEvents.size > 0) {
    const threshold = await getLowStockThreshold();
    for (const ev of lowStockEvents.values()) {
      void notifyStockLevel(ev, threshold);
    }
  }
  // US-1081: write the drift markers for GradeThread-originated listings. These
  // touch only `platform_fields` (which the bulk upsert above never carries, so
  // they aren't clobbered) and only fire when a marker changed, so a normal
  // in-agreement sync issues none.
  for (const [listingId, platformFields] of driftFieldWrites) {
    const { error } = await supabaseAdmin
      .from("listings")
      .update({ platform_fields: platformFields } as never)
      .eq("id", listingId);
    if (error) {
      errors.push(`drift marker ${listingId}: ${error.message.slice(0, 120)}`);
    }
  }
  if (orphanByEbayId.size > 0) {
    const { error } = await supabaseAdmin
      .from("flipdesk_ebay_listings")
      .upsert(Array.from(orphanByEbayId.values()), {
        onConflict: "user_id,ebay_item_id",
      });
    if (error) errors.push(`orphan upsert: ${error.message.slice(0, 160)}`);
  }
  // Status flips — one .in('id',[...]) update per transition. The prep-status
  // filter keeps the flip forward-only; .select() returns only the rows that
  // actually advanced, so the "listing is live" notification fires once on the
  // real transition. Run the notify flip FIRST so an item that is active on
  // BOTH the modern and legacy surfaces still notifies (the silent flip then
  // finds it already 'listed' and no-ops).
  if (listedNotifyItemIds.size > 0) {
    const { data: flipped } = await supabaseAdmin
      .from("inventory_items")
      .update({ status: "listed" })
      .eq("user_id", userId)
      .in("id", Array.from(listedNotifyItemIds))
      .in("status", PREP_STATUSES)
      .select("id, title");
    for (const r of (flipped ?? []) as Array<{
      id: string;
      title: string | null;
    }>) {
      // US-737 / US-1054: item went live on a marketplace (in-app).
      void notifyListingLive(userId, { itemTitle: r.title, itemId: r.id });
    }
  }
  if (listedSilentItemIds.size > 0) {
    await supabaseAdmin
      .from("inventory_items")
      .update({ status: "listed" })
      .eq("user_id", userId)
      .in("id", Array.from(listedSilentItemIds))
      .in("status", PREP_STATUSES);
  }

  // eBay item-id → inventory_item map, built AFTER the listing passes above so
  // it includes any listing rows just upserted this run. Used as a fallback
  // for matching order line items that carry no Custom Label (SKU) — common
  // for legacy Seller-Hub listings. Tenant-scoped via the inner join on
  // inventory_items.user_id (listings has no user_id column of its own —
  // US-268).
  const ebayItemIdToItemId = new Map<string, string>();
  try {
    const { data: ebayListingRows } = await supabaseAdmin
      .from("listings")
      .select("platform_listing_id, inventory_item_id, inventory_items!inner(user_id)")
      .eq("platform", "ebay")
      .eq("inventory_items.user_id", userId)
      .not("platform_listing_id", "is", null);
    for (const r of (ebayListingRows ?? []) as Array<{
      platform_listing_id: string | null;
      inventory_item_id: string | null;
    }>) {
      if (r.platform_listing_id && r.inventory_item_id) {
        ebayItemIdToItemId.set(r.platform_listing_id, r.inventory_item_id);
      }
    }
  } catch (err) {
    console.error("[flipdesk-ebay] failed to build ebay item-id map:", err);
  }

  // ── Orders sync (sold-state detection) ──────────────────────────
  // Pulls orders modified since last_synced_at (or 90 days on first sync;
  // ~24 months on an explicit backfill). Each line item is matched to an
  // inventory_item by SKU, then by eBay item id; unmatched sales are
  // snapshotted (not dropped).
  // Each line item's SKU is matched to inventory_items.sku; matches turn
  // into a sales row + flip inventory_items.status='sold'.
  // Normal syncs are incremental (orders modified since last_synced_at, or a
  // 90-day seed on first connect). A backfill ignores last_synced_at and
  // reaches back to eBay's practical retention limit (~24 months) so sales
  // that predate the FlipDesk connection get imported. This window applies to
  // BOTH the orders sync and the Finances fee/payout enrichment below.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
  // eBay's getOrders + getTransactions reject any start date that is 2 years or
  // older (errorId 30830: "Start date must be within '2' years from present
  // date"). A 730-day window sits exactly on that boundary and gets rejected,
  // which threw the whole orders sync — so NO sales were imported even though
  // the listings pull returned 202 and the UI toasted success. Use a ~23-month
  // backfill window to stay comfortably under the cap, and clamp whatever
  // `since` we send (a stale last_synced_at could otherwise trip the same
  // limit). This floor applies to BOTH the orders sync and the Finances
  // enrichment below, since they share sinceISO.
  const ebayLookbackFloor = new Date(Date.now() - 700 * 24 * 60 * 60_000);
  const requestedSince = backfill
    ? ebayLookbackFloor.toISOString()
    : (lastSyncedAt ?? ninetyDaysAgo);
  const sinceISO =
    new Date(requestedSince).getTime() < ebayLookbackFloor.getTime()
      ? ebayLookbackFloor.toISOString()
      : requestedSince;

  let salesNew = 0;
  let salesUpdated = 0;
  let salesSkipped = 0;
  let salesReversed = 0; // US-459: cancelled/refunded line items handled.
  // US-2320: what the cursor is allowed to move to depends on these two.
  // `ordersFetchComplete` false means we do not know what we did not see;
  // `failedOrders` are orders we DID see and did not fully persist, so the
  // cursor can rewind to the earliest of them instead of freezing.
  let ordersFetchComplete = true;
  const failedOrders: FailedOrder[] = [];
  try {
    // US-1474: high-volume sellers (large catalog) can pull orders via the Feed
    // API report instead of paging, when EBAY_FEED_SYNC is enabled AND the
    // catalog is above the threshold. Default OFF → always the paged path. A
    // Feed failure falls back to paging so a report hiccup never breaks the
    // sales sync. `offers.length` is the catalog-size proxy (fetched above).
    let orders: RemoteOrder[];
    if (shouldUseFeedForOrders(offers.length)) {
      try {
        // The Feed report is all-or-nothing: it throws unless the whole report
        // downloaded and parsed, so reaching here means a complete read.
        orders = await runOrderReport(userId, sinceISO);
      } catch (feedErr) {
        errors.push(
          `Feed order report failed; fell back to paged order sync: ${
            feedErr instanceof Error ? feedErr.message : String(feedErr)
          }`,
        );
        const paged = await listRecentOrders(userId, sinceISO, errors);
        orders = paged.orders;
        ordersFetchComplete = paged.complete;
      }
    } else {
      const paged = await listRecentOrders(userId, sinceISO, errors);
      orders = paged.orders;
      ordersFetchComplete = paged.complete;
    }
    for (const order of orders) {
      // Failed-payment orders shouldn't flip an item to sold.
      const paid =
        order.orderPaymentStatus === "PAID" ||
        order.orderPaymentStatus === "PARTIALLY_REFUNDED" ||
        order.orderPaymentStatus === "FULLY_REFUNDED";
      if (!paid) {
        salesSkipped += order.lineItems.length;
        continue;
      }

      // Lifecycle for this order's sale rows. A cancelled order (or a fully
      // refunded one) must NOT count toward revenue/profit/sold totals, so we
      // persist it with a non-'completed' status that every metric excludes.
      // US-2656: the same classification now also answers WHERE THE GARMENT IS,
      // which a reversal alone does not tell you. A cancel before shipping left
      // it on the shelf; a refund on an order eBay records as FULFILLED means the
      // buyer had it and sent it back. The sync used to treat both as the first
      // case and put the item to `listed`, while the in-app return path
      // (US-1451) wrote `returned` — the same physical event getting two
      // different answers depending on which code noticed it first.
      const outcome = resolveOrderOutcome(order);
      const saleStatus: "completed" | "cancelled" | "refunded" = outcome.saleStatus;
      const cancelledAt =
        saleStatus === "completed"
          ? null
          : order.lastModifiedDate ?? order.creationDate ?? null;

      for (const li of order.lineItems) {
        try {
          const sku = li.sku;
          let itemId = sku ? skuToItemId.get(sku) ?? null : null;
          // Fallback: match by eBay item id when there's no Custom Label match
          // (legacy listings often have no SKU on the order line item).
          if (!itemId && li.legacyItemId) {
            itemId = ebayItemIdToItemId.get(li.legacyItemId) ?? null;
          }
          if (!itemId) {
            // Don't silently drop it — snapshot the orphan sale so Sold totals
            // stay complete and the user can link it on Reconciliation.
            await snapshotOrphanSale(userId, order, li);
            salesSkipped += 1;
            continue;
          }
          // Look up the most recent listing row for this item so we can
          // link the sale (sales.listing_id is nullable but useful).
          const { data: lst } = await supabaseAdmin
            .from("listings")
            .select("id, listing_url")
            .eq("inventory_item_id", itemId)
            .eq("platform", "ebay")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const lstRow = lst as { id: string; listing_url: string | null } | null;
          let listingId = lstRow?.id ?? null;
          const existingUrl = lstRow?.listing_url ?? null;

          // li.itemCost is eBay's lineItemCost — the EXTENDED line total (unit
          // price × quantity), NOT a per-unit price (verified vs the Fulfillment
          // API docs). So this IS the line revenue; never multiply by quantity.
          const itemCost = li.itemCost ? Number(li.itemCost.value) : 0;
          const quantity = normalizeUnitCount(li.quantity);
          const shippingCollected = li.shippingCost
            ? Number(li.shippingCost.value)
            : 0;
          const tax = li.taxes ? Number(li.taxes.value) : 0;

          // Backfill the listings row's eBay link from the order's listingId.
          // The active-listing passes above (listAllOffers / GetMyeBaySelling)
          // only return ACTIVE listings, so a listing that already sold/ended
          // never gets a listings row carrying a URL — which is why sold items
          // showed a blank "Link" in the export even though the order tells us
          // the eBay item id. Fill it here. We only WRITE the URL when it's
          // currently blank so we don't clobber the nicer slug URL the Trading
          // API gives active listings; platform_listing_id is always set.
          if (li.legacyItemId) {
            const hasUrl = !!existingUrl && existingUrl.trim() !== "";
            const urlPatch = hasUrl
              ? {}
              : { listing_url: ebayListingUrl(li.legacyItemId) };
            // A completed sale means the listing is no longer live.
            //
            // US-2656: a reversal now clears that, and the gap it closes was a
            // row that contradicted itself. `{}` meant a sale that completed and
            // was LATER cancelled kept listing_status = 'sold' forever, while the
            // item went back to 'listed' — the listing insisting it sold, the item
            // insisting it is for sale, and nothing to reconcile them. `ended` is
            // the honest word for both reversal kinds: the listing is not live
            // (the sale took it down) and it did not sell.
            //
            // US-2684: "ended" is only honest when the listing really is gone.
            // Under eBay's out-of-stock control a cancelled order leaves the
            // listing UP at quantity 0, and the offers pull earlier in this same
            // run already read it back as live — so writing ended here undid a
            // verdict taken from eBay minutes ago, and the next sync wrote it
            // back. The row flipped between "ended" and "active" every 30
            // minutes and neither word was the true one, which is
            // "live, but nobody can buy it". Trust the pull when it saw the
            // listing; fall back to ended when it did not (no eBay connection,
            // a partial pull, or an offer genuinely absent from the feed).
            const pulledState = ebayStateByItem.get(itemId) ?? null;
            const stillLiveOnEbay = pulledState?.isActive === true;
            const lifecyclePatch =
              saleStatus === "completed"
                ? { listing_status: "sold", is_active: false }
                : stillLiveOnEbay
                  ? { listing_status: pulledState!.status, is_active: true }
                  : { listing_status: "ended", is_active: false };
            if (listingId) {
              await supabaseAdmin
                .from("listings")
                .update({
                  platform_listing_id: li.legacyItemId,
                  ...urlPatch,
                  ...lifecyclePatch,
                })
                .eq("id", listingId);
              // US-547: a completed sale is the sell-through signal for the
              // listing_gen prompt that produced this draft.
              if (saleStatus === "completed") {
                await markListingPromptSold(listingId);
              }
            } else {
              // No listings row at all (sold before we ever synced the live
              // listing) — create one so the item carries its eBay link.
              const { data: created } = await supabaseAdmin
                .from("listings")
                .insert({
                  inventory_item_id: itemId,
                  platform: "ebay",
                  // US-1077: a sale we discovered with no local listings row —
                  // it lived on eBay and we never published it → eBay-originated.
                  listing_origin: "ebay",
                  platform_listing_id: li.legacyItemId,
                  listing_url: ebayListingUrl(li.legacyItemId),
                  listing_price: itemCost,
                  listing_status:
                    saleStatus === "completed" ? "sold" : "ended",
                  is_active: false,
                })
                .select("id")
                .maybeSingle();
              listingId = (created as { id: string } | null)?.id ?? null;
            }
          }

          // US-149: a completed sale ends this listing's cross-listed
          // siblings (rows sharing draft_id), honoring the per-user
          // flipdesk_settings.auto_end_cross_listings toggle. Best-effort —
          // never fails the sync.
          if (saleStatus === "completed" && listingId) {
            await autoEndCrossListings(userId, listingId);
          }

          // US-468: dedupe key is (inventory_item_id, platform_order_id,
          // line_item_id) — migration 00130 adds line_item_id to the unique
          // index so two line items of the SAME item in one order don't collapse
          // onto one row. Fetch every existing row for this item+order and let
          // pickSaleRowForLine choose the right one (adopting a legacy null-id
          // row once on the first post-migration re-sync).
          const { data: existingRows } = await supabaseAdmin
            .from("sales")
            .select("id, line_item_id")
            .eq("inventory_item_id", itemId)
            .eq("platform_order_id", order.orderId);
          const existing = pickSaleRowForLine(
            (existingRows ?? []) as ExistingSaleRow[],
            li.lineItemId,
          );

          const salePayload = {
            inventory_item_id: itemId,
            listing_id: listingId,
            platform_order_id: order.orderId,
            line_item_id: li.lineItemId ?? "",
            quantity,
            sale_price: itemCost,
            sale_date: order.creationDate?.slice(0, 10) ?? null,
            sold_at: order.creationDate ?? null,
            buyer_username: order.buyerUsername,
            buyer_id: order.buyerUsername,
            shipping_collected: shippingCollected,
            tax,
            status: saleStatus,
            cancelled_at: cancelledAt,
            // US-2031: record what eBay actually told us instead of discarding
            // it. The orphan-sales path already kept this (:1958); the main
            // sales row dropped it, which is why the USD assumption was
            // invisible. NULL when unreported — treated as USD downstream.
            currency: li.itemCost?.currency ?? null,
          };

          if (existing) {
            const existingSaleId = (existing as { id: string }).id;
            // US-2320: the error used to be discarded and the counter bumped
            // regardless, so a failed write was reported as a synced sale — and
            // the cursor then moved past it. Throw instead: the per-order catch
            // above records it as a failed order, which is what rewinds the
            // cursor to re-pull it.
            const { error: updErr } = await supabaseAdmin
              .from("sales")
              .update(salePayload)
              .eq("id", existingSaleId);
            if (updErr) throw new Error(`sale update failed: ${updErr.message}`);
            salesUpdated += 1;
            // US-2022: this sweep is the OTHER way a sale reverses — an order
            // previously synced as completed comes back CANCELED or
            // FULLY_REFUNDED. Without this, only the Post-Order route reversed
            // payouts and a refund discovered by the sweep silently kept the
            // consignor's cut paid out. Idempotent, so overlapping with the
            // Post-Order path cannot double-reverse.
            if (saleStatus !== "completed") {
              void reverseConsignorPayoutsForSales([existingSaleId], userId, {
                reason: `ebay order sync: ${saleStatus}`,
              }).catch((err) => {
                console.error("[ebay.sync] consignor payout reversal failed:", err);
              });
            }
          } else {
            const { data: insertedSale, error: insErr } = await supabaseAdmin
              .from("sales")
              .insert(salePayload)
              .select("id")
              .maybeSingle();
            // US-2320: same defect on the insert side, and worse — a failed
            // insert left `insertedSale` null, so the consignor payout and the
            // sale notification below were skipped too, while salesNew still
            // counted the sale as imported.
            if (insErr) throw new Error(`sale insert failed: ${insErr.message}`);
            salesNew += 1;
            // US-626: a brand-new sale → celebrate it on iOS (best-effort).
            // Only for genuine completed sales, never a cancelled/refunded one.
            if (saleStatus === "completed") {
              // US-1112: a consigned item just sold → fire the consignor's
              // payout immediately when the config flag is 'immediate' (no-op
              // otherwise; the consignor-payouts cron is the catch-all).
              // Best-effort — never fails the sync.
              const newSaleId = (insertedSale as { id: string } | null)?.id;
              if (newSaleId) {
                void maybeFireImmediateConsignorPayout(newSaleId, userId);
              }
              // US-737 / US-1054: a genuinely NEW completed sale (the `existing`
              // dedup guard above) → in-app + push, fired once per sale (never on
              // re-sync), push preference-gated. Best-effort.
              void notifySaleRecorded(userId, {
                itemTitle: li.title,
                price: itemCost,
                itemId,
              });
              // US-932: feed the internal event stream (drip trigger substrate).
              void emitEvent(userId, "sale_recorded", {
                properties: { inventory_item_id: itemId, sale_price: itemCost },
              });
              // US-1100: capture "who it sold to" on the Garment Passport —
              // a 'sold' event + a pseudonymous sold-to node keyed by a salted
              // hash of the buyer (no PII) + a buyer claim offer. Best-effort;
              // no-op when the item has no passport. Once per NEW sale (this
              // is the dedup-guarded new-insert branch), so it never doubles.
              void recordEbaySale({
                inventoryItemId: itemId,
                ownerId: userId,
                buyerIdentifier: order.buyerUsername ?? null,
                platform: "ebay",
              });
            }
          }

          if (saleStatus === "completed") {
            // Flip the item to sold. resolveStatus-equivalent: 'sold' is a
            // terminal non-prep status so it dominates anything we'd have
            // bumped to via the offer loop above ('listed').
            await supabaseAdmin
              .from("inventory_items")
              .update({ status: "sold" })
              .eq("id", itemId)
              .not("status", "in", "(shipped,completed,returned)");
          } else if (outcome.reversal === "returned") {
            // US-2656: the buyer had it and sent it back. `returned` is the
            // relist loop's entry point and is exactly what the in-app return
            // path writes, so a return the seller handles in eBay's Seller Hub
            // now lands in the same place as one they handle here. Before this
            // it never arrived at all: the in-app path only runs from our own
            // buttons, so an eBay-side refund left the item sitting as sold.
            //
            // Allowed to move a shipped/completed item, unlike the cancel arm
            // below — a return is precisely the case where real fulfilment is
            // undone, and refusing to touch those states is what stranded it.
            await supabaseAdmin
              .from("inventory_items")
              .update({ status: "returned" })
              .eq("id", itemId)
              .in("status", ["sold", "shipped", "completed"]);
            salesReversed += 1;
          } else {
            // Cancelled before it shipped: the item never left, so it is still
            // the seller's and nothing about its condition changed. If a prior
            // sync already flipped it to 'sold', put it back. Don't touch
            // shipped/completed/returned — those represent real fulfilment, and
            // a cancel that reaches them is classified as a return above.
            await supabaseAdmin
              .from("inventory_items")
              .update({ status: "listed" })
              .eq("id", itemId)
              .eq("status", "sold");
            // The eBay listing is almost never live after a sale ended it, so
            // 'listed' can be a lie. resyncItemListedStatus is the existing
            // arbiter: it drops the item to 'drafted' unless a live listing
            // really does exist on some marketplace, so the item lands in Drafts
            // where it can be relisted instead of hiding in a Listed tab with
            // nothing behind it.
            await resyncItemListedStatus(itemId, userId);
            // US-459: report how many cancellations/returns this run handled.
            salesReversed += 1;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`order ${order.orderId}: ${msg.slice(0, 160)}`);
          // US-2320: this order was fetched and not persisted. Recording it is
          // what lets the cursor rewind to it rather than skipping past it.
          failedOrders.push({
            orderId: order.orderId,
            lastModifiedDate: order.lastModifiedDate ?? null,
          });
        }
      }
    }
  } catch (err) {
    // Orders sync failure shouldn't fail the whole pull — listings sync
    // is the more critical of the two. Log + carry on.
    console.error("[flipdesk-ebay] orders sync failed:", err);
    errors.push(
      `orders sync: ${err instanceof Error ? err.message : String(err)}`
    );
    // US-2320: carrying on is fine; carrying on AND stamping the cursor is not.
    // A throw here can happen mid-page, so we do not know which orders we never
    // saw — the only safe cursor is the one we started with.
    ordersFetchComplete = false;
  }

  // ── Finances enrichment (fees + payout) ─────────────────────────
  // For each SALE transaction we find via the Finances API, find the
  // matching sales row by platform_order_id and write through:
  //   platform_fees, payout_amount, payout_reference, net_profit
  // This is what flips the Sold tab badge from "Pending" to "Cleared".
  let salesEnriched = 0;
  try {
    const txns: RemoteTransaction[] = await listRecentTransactions(
      userId,
      sinceISO,
      errors,
    );
    // Build a quick orderId → aggregate map. SALE transactions carry gross
    // + fees; SHIPPING_LABEL transactions carry what the SELLER paid for
    // the eBay shipping label (deducted from the payout). Refunds reduce
    // gross. We sum each per-order so multi-line orders compose cleanly.
    interface OrderAgg {
      gross: number;
      fees: number;
      shippingLabelCost: number;
      payoutId: string | null;
      currency: string;
    }
    const byOrder = new Map<string, OrderAgg>();
    const upsertAgg = (orderId: string): OrderAgg => {
      const existing = byOrder.get(orderId);
      if (existing) return existing;
      const fresh: OrderAgg = {
        gross: 0,
        fees: 0,
        shippingLabelCost: 0,
        payoutId: null,
        currency: "USD",
      };
      byOrder.set(orderId, fresh);
      return fresh;
    };
    for (const t of txns) {
      if (!t.orderId) continue;
      const agg = upsertAgg(t.orderId);
      const amt = t.amount ? Number(t.amount.value) : 0;
      if (t.amount?.currency) agg.currency = t.amount.currency;
      if (t.payoutId && !agg.payoutId) agg.payoutId = t.payoutId;

      switch (t.transactionType) {
        case "SALE":
          agg.gross += amt;
          if (t.totalFeeAmount) {
            agg.fees += Number(t.totalFeeAmount.value);
          }
          break;
        case "SHIPPING_LABEL":
          // Seller-paid label. amount is positive but it's a DEBIT (deducted
          // from the payout). Sum the absolute value either way.
          agg.shippingLabelCost += Math.abs(amt);
          break;
        case "REFUND":
          // Refund issued to buyer — comes out of the seller's payout.
          // Treat as a negative adjustment to gross.
          agg.gross -= Math.abs(amt);
          break;
        // Other types (DISPUTE, CREDIT, NON_SALE_CHARGE) intentionally
        // ignored for now — they're rare and would need per-case handling.
      }
    }

    // Pull every sale this user has with a matching platform_order_id so we
    // can update + compute net_profit (needs cost_basis from inventory_items).
    const orderIds = Array.from(byOrder.keys());
    if (orderIds.length > 0) {
      const { data: salesRows } = await supabaseAdmin
        .from("sales")
        .select(
          "id, inventory_item_id, sale_price, shipping_collected, shipping_cost, grading_cost, other_costs, status, platform_order_id, inventory_items!inner(user_id, acquired_price)"
        )
        .in("platform_order_id", orderIds);

      for (const row of (salesRows ?? []) as unknown as Array<{
        id: string;
        inventory_item_id: string;
        sale_price: number | null;
        shipping_collected: number | null;
        shipping_cost: number | null;
        grading_cost: number | null;
        other_costs: number | null;
        status: string | null;
        platform_order_id: string | null;
        inventory_items: { user_id: string; acquired_price: number | null };
      }>) {
        if (row.inventory_items.user_id !== userId) continue;
        const agg = row.platform_order_id
          ? byOrder.get(row.platform_order_id)
          : null;
        if (!agg) continue;

        const fees = agg.fees;
        // Use eBay's label cost when present, otherwise keep whatever the
        // user manually entered (a USPS direct label, etc.).
        const shippingCost = agg.shippingLabelCost > 0
          ? agg.shippingLabelCost
          : row.shipping_cost ?? 0;
        // Payout = what actually hit the seller's bank: gross - fees - labels.
        // This is the cleared-funds amount, not net profit.
        const payoutAmount = Math.max(
          0,
          agg.gross - fees - agg.shippingLabelCost,
        );

        const salePrice = row.sale_price ?? 0;
        const shippingCollected = row.shipping_collected ?? 0;
        const gradingCost = row.grading_cost ?? 0;
        const otherCosts = row.other_costs ?? 0;
        const costBasis = row.inventory_items.acquired_price ?? 0;
        // US-459: net_profit must REVERSE revenue on a cancelled/refunded sale,
        // not just fee-adjust it. For those, the buyer got their money back and
        // (for a return) the item came back into inventory — so the only thing
        // left on the books is the cash the seller actually ate: the
        // refund-netted gross minus fees minus the shipping label they paid
        // (`agg.gross` already subtracts REFUND transactions). Cost basis is NOT
        // subtracted (the item is retained), and the original sale revenue is
        // NOT counted (it was refunded). This goes negative when the seller ate
        // a label/fee, which is correct.
        const reversed = row.status === "cancelled" || row.status === "refunded";
        const netProfit = reversed
          ? agg.gross - fees - agg.shippingLabelCost
          : // Completed sale: revenue - fees - your costs. Revenue is
            // sale_price + shipping_collected (tax flows to government, not the
            // seller); your costs are cost basis, shipping, grading, other.
            salePrice +
            shippingCollected -
            fees -
            shippingCost -
            gradingCost -
            otherCosts -
            costBasis;

        await supabaseAdmin
          .from("sales")
          .update({
            platform_fees: fees,
            shipping_cost: shippingCost,
            payout_amount: payoutAmount,
            payout_reference: agg.payoutId,
            net_profit: Math.round(netProfit * 100) / 100,
          })
          .eq("id", row.id);
        salesEnriched += 1;
      }
    }
  } catch (err) {
    console.error("[flipdesk-ebay] finances enrichment failed:", err);
    errors.push(
      `finances: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── Ended-without-sale → Drafts (Path A) ────────────────────────────
  // eBay reported these listings as ended/inactive this sync. The orders pass
  // above already flipped genuine sales to 'sold', so anything still in 'listed'
  // here ended without selling (expired, ended on Seller Hub, out of stock with
  // no order, etc.). Move those back to 'drafted' so they surface in the Drafts
  // tab where the seller can edit and relist them, and notify once per item.
  let endedToDraft = 0;
  // US-148: ended listings whose item has a completed sale — their
  // "ended vs active" status observation is a sale, not a conflict.
  const soldEndedItemIds = new Set<string>();
  for (const itemId of endedItemIds) {
    try {
      // Defensive: never regress an item that has a completed sale on record,
      // even if its status drifted (the 'listed'-only guard below already
      // covers the common case).
      const { data: sale } = await supabaseAdmin
        .from("sales")
        .select("id")
        .eq("inventory_item_id", itemId)
        .eq("status", "completed")
        .limit(1)
        .maybeSingle();
      if (sale) {
        soldEndedItemIds.add(itemId);
        continue;
      }

      // US-2179: the eBay listing ended, but a cross-listed item may still be
      // live on another marketplace. Regressing it to 'drafted' then would free
      // an activeListings cap slot the seller is still using and hide a live
      // listing in the Drafts tab. The eBay row is already is_active=false by
      // here (the pendingListing upsert above flushed it), so this check sees
      // only the OTHER platforms.
      if (await itemHasActiveListing(itemId, userId)) continue;

      // Forward-safe: only regress an item that's still sitting in 'listed'.
      // .select() returns the row only when the update actually applied, so the
      // notification fires once on the real transition, not on every re-sync.
      const { data: moved } = await supabaseAdmin
        .from("inventory_items")
        .update({ status: "drafted" })
        .eq("id", itemId)
        .eq("user_id", userId)
        .eq("status", "listed")
        .select("id, title");
      const row = (moved ?? [])[0] as
        | { id: string; title: string | null }
        | undefined;
      if (row) {
        endedToDraft += 1;
        // Record a seller-facing reason on the listing so the Drafts surface can
        // explain WHY it reappeared and prompt the right next step. Stored in
        // publish_error (no schema change); cleared automatically on the next
        // successful publish. Scoped to this owner's ebay listing for the item —
        // and we don't stomp a more specific publish-failure message already on
        // the row.
        //
        // US-2656: this sentence used to be a constant, and it guessed three
        // ways in one breath — "it may have ended, sold out, or been removed by
        // eBay (e.g. a policy issue)". Those need OPPOSITE actions: an ended
        // listing wants a relist, and one eBay took down wants the seller to
        // read their Seller Hub messages first, because relisting the same
        // content gets it taken down again. eBay told us which; now we say so,
        // and fall back to the old disjunction only when it genuinely didn't.
        const state = ebayStateByItem.get(itemId) ?? absentListingState();
        await supabaseAdmin
          .from("listings")
          .update({
            publish_error: (state.message ?? absentListingState().message)!.slice(0, 1000),
            publish_failed_at: new Date().toISOString(),
          })
          .eq("inventory_item_id", itemId)
          .eq("platform", "ebay")
          .is("publish_error", null);
        // US-737 / US-1054: real status transition (listed → drafted), fires once
        // (the .select() above returns the row only when the update applied).
        void notifyListingEnded(userId, { itemTitle: row.title, itemId });
      }
    } catch (err) {
      errors.push(
        `relist-reconcile ${itemId}: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          160,
        ),
      );
    }
  }

  // ── Cross-source conflict detection (US-148) ────────────────────────
  // Runs after the orders pass so status observations for genuinely-sold
  // listings can be dropped instead of flagged.
  let conflictsRecorded = 0;
  let conflictsResolved = 0;
  try {
    const toRecord = ebayObservations.filter(
      (obs) =>
        !(
          obs.field === "listing_status" &&
          obs.itemId &&
          soldEndedItemIds.has(obs.itemId)
        ),
    );
    const res = await recordSourceObservations(userId, "ebay", toRecord);
    conflictsRecorded = res.recorded;
    conflictsResolved = res.resolved;
    errors.push(...res.errors.map((e) => `conflicts: ${e.slice(0, 160)}`));
  } catch (err) {
    errors.push(
      `conflicts: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    );
  }

  // Stamp last_synced_at so the UI can show "Synced 2m ago" + the next
  // /listings/pull picks up where this one left off.
  //
  // US-2320: this column is the ORDERS CURSOR, not a "the job ran" ping —
  // doListingsPull reads it back as `since` for the next incremental pull. It
  // used to be stamped unconditionally, so any orders failure moved the cursor
  // past orders that were never written and nothing ever asked for them again.
  const watermark = planOrdersWatermark({
    fetchComplete: ordersFetchComplete,
    failedOrders,
    now: new Date().toISOString(),
  });
  if (watermark.advance) {
    await supabaseAdmin
      .from("marketplace_connections")
      .update({ last_synced_at: watermark.to })
      .eq("id", connId);
    if (watermark.reason === "rewound") {
      console.warn(
        `[flipdesk-ebay] ${failedOrders.length} order(s) failed to persist; ` +
          `cursor rewound to ${watermark.to} so they re-pull next sync`,
      );
      errors.push(
        `orders: ${failedOrders.length} order(s) not saved — sync cursor held at ` +
          `${watermark.to} so they are re-pulled. This sync is PARTIAL.`,
      );
    }
  } else {
    // The cursor stays where it was, so the next pull re-asks for the same
    // window. The UI's completion poll watches this column, so leaving it alone
    // is also what stops "Synced just now" from claiming a sync that lost data.
    console.error(
      `[flipdesk-ebay] orders pass incomplete (${watermark.reason}); ` +
        `last_synced_at NOT advanced — the next sync re-pulls this window`,
    );
    errors.push(
      `orders: sync cursor NOT advanced (${watermark.reason}). This sync is ` +
        `PARTIAL — the missing orders will be re-pulled on the next sync.`,
    );
  }

  console.log(
    `[flipdesk-ebay] pull complete: matched=${matched} unmatched=${unmatched} ` +
      `skipped=${skipped} legacy_matched=${legacyMatched} ` +
      `legacy_unmatched=${legacyUnmatched} legacy_duplicates=${legacyDuplicates} ` +
      `sales_new=${salesNew} sales_updated=${salesUpdated} ` +
      `sales_skipped=${salesSkipped} sales_enriched=${salesEnriched} ` +
      `catalog_updated=${catalogUpdated} specifics_fetched=${specificsFetched}` +
      `${specificsCapped ? ` (capped at ${MAX_SPECIFICS_FETCH_PER_SYNC}; remaining items backfill next sync)` : ""} ` +
      `ended_to_draft=${endedToDraft} ` +
      `conflicts_recorded=${conflictsRecorded} conflicts_resolved=${conflictsResolved} ` +
      `errors=${errors.length}`,
  );

  // Persist the run so the Reconciliation page can show its stats. Per-phase
  // failures were collected in `errors` without aborting the pull, so a run
  // that finished with any errors is "partial", otherwise "success".
  await recordSyncRun(userId, {
    startedAt,
    since: sinceISO,
    status: errors.length > 0 ? "partial" : "success",
    total: offers.length,
    matched,
    unmatched,
    skipped,
    legacyMatched,
    legacyUnmatched,
    legacyDuplicates,
    salesNew,
    salesUpdated,
    salesSkipped,
    salesEnriched,
    salesReversed,
    errors,
  }, runId);
}

// /listings/pull — validates the connection then fires the heavy sync as a
// detached background task, returning 202 immediately.  The actual work is
// done by doListingsPull() above; the frontend polls last_synced_at to know
// when it is done.
flipdeskEbayRoutes.post("/listings/pull", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  // Validate that the user has an active connection before firing the job.
  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, last_synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: sync the selected (primary) connection.
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) {
    return c.json({ error: "Connect your eBay account first." }, 400);
  }
  const connId = (conn as { id: string; last_synced_at: string | null }).id;
  const lastSyncedAt =
    (conn as { id: string; last_synced_at: string | null }).last_synced_at ?? null;

  // ?full=true forces a one-time historical backfill: the orders + Finances
  // sync reaches back ~24 months instead of the incremental window, so sales
  // that predate the FlipDesk connection get imported.
  const backfill = c.req.query("full") === "true";

  // US-456: claim the in-flight lock BEFORE firing. A concurrent pull for the
  // same tenant is rejected (409) instead of racing writes; a dead run is reaped
  // inside claimSyncRun so a crash can't lock the tenant out permanently.
  const claim = await claimSyncRun(userId, "ebay");
  if (claim.status === "already_running") {
    return c.json(
      { error: "A sync is already running for this account.", alreadyRunning: true },
      409,
    );
  }
  const runId = claim.status === "claimed" ? claim.runId : null;

  // Fire-and-forget — do NOT await this. Returning 202 before the work starts
  // means the HTTP connection closes immediately, safely below Cloudflare's
  // 100s proxy timeout. The frontend polls last_synced_at to detect completion.
  // The .catch finalizes the lock as failed on an unexpected throw (the success
  // /partial and early fetch-failure paths finalize themselves via runId), so
  // the run never stays stuck in 'running'.
  void doListingsPull(userId, connId, lastSyncedAt, backfill, runId).catch(
    async (err) => {
      console.error("[flipdesk-ebay] background sync crashed:", err);
      if (runId) {
        await failSyncRun(runId, err instanceof Error ? err.message : String(err));
      }
    },
  );

  return c.json({ ok: true, message: "Sync started in background." }, 202);
});

// US-471: targeted incremental sync used by the eBay Notification webhook when
// an order/sale/return topic arrives, so sold/returned state updates in
// near-real-time instead of waiting for the next manual or scheduled pull.
// Mirrors the /listings/pull handler (validate connection → claim the in-flight
// lock → fire doListingsPull incrementally) but takes no Context: it's invoked
// from processEbayWebhookEvent after the seller has been resolved from the
// verified payload. Always incremental (never a backfill) and best-effort —
// returns a status string instead of throwing so a webhook ack is never blocked.
export async function triggerEbaySyncForUser(
  userId: string,
): Promise<"started" | "already_running" | "no_connection" | "not_configured"> {
  if (!isEbayConfigured()) return "not_configured";

  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, last_synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) return "no_connection";

  const connId = (conn as { id: string; last_synced_at: string | null }).id;
  const lastSyncedAt =
    (conn as { id: string; last_synced_at: string | null }).last_synced_at ?? null;

  // Reuse the same per-tenant lock the manual pull uses: if a sync is already
  // running (manual, scheduled, or a prior webhook), don't race — the in-flight
  // run will pick up the just-changed order. claimSyncRun reaps dead runs.
  const claim = await claimSyncRun(userId, "ebay");
  if (claim.status === "already_running") return "already_running";
  const runId = claim.status === "claimed" ? claim.runId : null;

  void doListingsPull(userId, connId, lastSyncedAt, false, runId).catch(
    async (err) => {
      console.error("[flipdesk-ebay] webhook-triggered sync crashed:", err);
      if (runId) {
        await failSyncRun(runId, err instanceof Error ? err.message : String(err));
      }
    },
  );
  return "started";
}

// GET /sync-runs — recent sync-run history for the Reconciliation page.
// Tenant-scoped to the workspace owner (the account the sync runs on behalf
// of). Returns the freshest runs first; default 20, capped at 50.
flipdeskEbayRoutes.get("/sync-runs", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(
    Math.max(Number(c.req.query("limit")) || 20, 1),
    50,
  );
  const { data, error } = await supabaseAdmin
    .from("flipdesk_sync_runs")
    .select("*")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) return failSafe(c, 500, "Couldn't load sync runs.", error, "ebay.sync-runs");
  return c.json({ runs: data ?? [] });
});

// ── Returns & cancellations management (US-1043, Post-Order API) ─────
//
// The seller's eBay token only ever sees that seller's own returns/cancels, so
// listing is inherently tenant-scoped to the workspace owner. After an action we
// best-effort update the matching local sale (tenant-scoped by user_id +
// platform_order_id) and always write an audit row. The action calls are
// idempotent at the eBay layer (a second decide on a resolved case is treated as
// success).

// Update the local sale's lifecycle after an eBay outcome (best-effort). Scoped
// to the owner; needs the eBay order id from the request (the UI has it).
async function applyOutcomeToSale(
  ownerId: string,
  orderId: unknown,
  outcome:
    | "return_refunded"
    | "return_declined"
    | "cancel_approved"
    | "cancel_rejected",
): Promise<void> {
  const status = outcomeToSaleStatus(outcome);
  if (!status || typeof orderId !== "string" || !orderId) return;
  const { data: updatedSales, error } = await supabaseAdmin
    .from("sales")
    .update({ status, cancelled_at: new Date().toISOString() })
    .eq("user_id", ownerId)
    .eq("platform_order_id", orderId)
    .select("id, inventory_item_id, listing_id");
  if (error) {
    console.error("[ebay.postorder] local sale update failed:", error.message);
    return;
  }

  // US-1451: a refunded return / approved cancellation means the item came back —
  // only flipping the sale to refunded/cancelled strands the item as sold/shipped
  // (outside the relist loop) and still counts it in Sold aggregates. Restore the
  // item to 'returned' (the relist-loop entry) and end its listing so it's no
  // longer shown live. Only refunded/cancelled reach here (declines/rejections
  // returned above), so both outcomes restore. Ids come from the tenant-scoped
  // sale rows we just updated, so the item/listing writes are provably owned.
  const rows = (updatedSales ?? []) as Array<{
    id: string;
    inventory_item_id: string | null;
    listing_id: string | null;
  }>;

  // US-2022: the item coming back means the consignor was paid for a sale that
  // no longer exists. Reverse (or cancel) their payout — without this the row
  // stays 'paid' forever and the seller silently eats the consignor's cut.
  // Best-effort and idempotent, like the item/listing restores below.
  await reverseConsignorPayoutsForSales(
    rows.map((r) => r.id),
    ownerId,
    { reason: `ebay ${outcome}` },
  ).catch((err) => {
    console.error("[ebay.postorder] consignor payout reversal failed:", err);
  });
  const itemIds = [...new Set(rows.map((r) => r.inventory_item_id).filter(Boolean))] as string[];
  const listingIds = [...new Set(rows.map((r) => r.listing_id).filter(Boolean))] as string[];

  if (itemIds.length > 0) {
    const { error: iErr } = await supabaseAdmin
      .from("inventory_items")
      .update({ status: "returned" })
      .eq("user_id", ownerId)
      .in("id", itemIds);
    if (iErr) {
      console.error("[ebay.postorder] item restore failed:", iErr.message);
    }
  }
  if (listingIds.length > 0) {
    const { error: lErr } = await supabaseAdmin
      .from("listings")
      .update({ listing_status: "ended", is_active: false })
      .in("id", listingIds);
    if (lErr) {
      console.error("[ebay.postorder] listing restore failed:", lErr.message);
    }
  }
}

// A 4xx whose body says the case is already resolved → treat the action as a
// successful no-op (idempotency) rather than surfacing an error to the user.
function isAlreadyResolved(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already (been )?(decided|closed|refunded|approved|rejected|processed)/i
    .test(msg);
}

// GET /returns — open returns for the seller.
flipdeskEbayRoutes.get("/returns", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  // US-2927: local first. A page reload inside the freshness window costs eBay
  // nothing; an empty cache is never treated as "no returns", because only eBay
  // can tell an empty cache from an empty account.
  const cached = await loadCachedSummaries<ReturnSummary>(ownerId, "return", { limit });
  if (cached.fresh) return c.json({ returns: cached.items, source: "cache" });
  try {
    const live = await searchReturns(ownerId, { limit });
    const nowIso = new Date().toISOString();
    await recordPostSaleCases(ownerId, live.map((r) => returnToCaseInput(r, nowIso)));
    return c.json({ returns: live, source: "ebay" });
  } catch (err) {
    // A live failure falls back to whatever we last stored rather than to an
    // error page — stale returns are more useful than none, and the response
    // says which it is so the UI can label it.
    if (cached.items.length > 0) {
      return c.json({ returns: cached.items, source: "cache_stale" });
    }
    return failSafe(c, 502, "Couldn't load eBay returns.", err, "ebay.returns.list");
  }
});

// POST /returns/:returnId/decide — body { decision: approve|decline, comments?, order_id? }
flipdeskEbayRoutes.post("/returns/:returnId/decide", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { decision?: unknown; comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const decision = String(body.decision ?? "").toLowerCase();
  if (decision !== "approve" && decision !== "decline") {
    return c.json({ error: "decision must be 'approve' or 'decline'." }, 400);
  }
  const comments = typeof body.comments === "string" ? body.comments : undefined;
  try {
    await decideReturn(
      ownerId,
      returnId,
      decision === "approve" ? "APPROVE" : "DECLINE",
      comments,
    );
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the return decision.", err, "ebay.returns.decide");
    }
  }
  if (decision === "decline") {
    await applyOutcomeToSale(ownerId, body.order_id, "return_declined");
    // US-2927: reflect the decision on the stored case now rather than waiting
    // for the next poll, so the page the seller acted from is not still showing
    // the return as needing them.
    await markPostSaleCaseClosed(ownerId, "return", returnId, "declined");
  } else {
    await updatePostSaleCaseState(ownerId, "return", returnId, { state: "RETURN_APPROVED" });
  }
  await writeAuditLog(c, {
    action: `ebay.return.${decision}`,
    targetType: "ebay_return",
    targetId: returnId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// POST /returns/:returnId/refund — body { comments?, order_id? }
flipdeskEbayRoutes.post("/returns/:returnId/refund", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const comments = typeof body.comments === "string" ? body.comments : undefined;
  try {
    await issueReturnRefund(ownerId, returnId, comments);
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the refund.", err, "ebay.returns.refund");
    }
  }
  await applyOutcomeToSale(ownerId, body.order_id, "return_refunded");
  await markPostSaleCaseClosed(ownerId, "return", returnId, "refunded");
  await writeAuditLog(c, {
    action: "ebay.return.refund",
    targetType: "ebay_return",
    targetId: returnId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// ── Item Not Received inquiries (US-2928, Post-Order v2) ────────────
//
// The first move a buyer makes when a parcel does not arrive. FlipDesk had no
// reader for it, so the webhook arrived, kicked off a poll with no inquiry
// source, and the seller learned nothing. Answered with tracking, an inquiry
// costs the seller nothing; ignored, it escalates into a case (US-2929) and a
// lost case is a defect.
//
// Every route resolves the owner the same way the rest of this file does, and
// eBay serves only that seller's own inquiries under their own token.

// GET /inquiries — open inquiries for the seller. Local-first like /returns.
flipdeskEbayRoutes.get("/inquiries", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const cached = await loadCachedSummaries<InquirySummary>(ownerId, "inquiry", { limit });
  if (cached.fresh) return c.json({ inquiries: cached.items, source: "cache" });
  try {
    const live = await searchInquiries(ownerId, { limit });
    const nowIso = new Date().toISOString();
    await recordPostSaleCases(ownerId, live.map((i) => inquiryToCaseInput(i, nowIso)));
    return c.json({ inquiries: live, source: "ebay" });
  } catch (err) {
    if (cached.items.length > 0) {
      return c.json({ inquiries: cached.items, source: "cache_stale" });
    }
    return failSafe(c, 502, "Couldn't load eBay inquiries.", err, "ebay.inquiries.list");
  }
});

// POST /inquiries/:inquiryId/shipment — body { carrier, tracking_number, shipped_date?, comments? }
//
// The action that settles most INR inquiries. Validated before the eBay call so
// a missing tracking number is a 400 here rather than an opaque 502 from eBay.
flipdeskEbayRoutes.post("/inquiries/:inquiryId/shipment", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const inquiryId = c.req.param("inquiryId");
  let body: {
    carrier?: unknown;
    tracking_number?: unknown;
    shipped_date?: unknown;
    comments?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : "";
  const trackingNumber = typeof body.tracking_number === "string"
    ? body.tracking_number.trim()
    : "";
  if (!carrier || !trackingNumber) {
    return c.json({ error: "carrier and tracking_number are both required." }, 400);
  }
  try {
    await provideInquiryShipmentInfo(ownerId, inquiryId, {
      carrier,
      trackingNumber,
      shippedDate: typeof body.shipped_date === "string" ? body.shipped_date : undefined,
      comments: typeof body.comments === "string" ? body.comments : undefined,
    });
  } catch (err) {
    if (!isInquiryAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the shipment details.", err, "ebay.inquiries.shipment");
    }
  }
  await updatePostSaleCaseState(ownerId, "inquiry", inquiryId, {
    state: "SHIPMENT_PROVIDED",
  });
  await writeAuditLog(c, {
    action: "ebay.inquiry.shipment",
    targetType: "ebay_inquiry",
    targetId: inquiryId,
    details: { carrier, tracking_number: trackingNumber },
  });
  return c.json({ ok: true });
});

// POST /inquiries/:inquiryId/refund — body { comments?, order_id? }
flipdeskEbayRoutes.post("/inquiries/:inquiryId/refund", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const inquiryId = c.req.param("inquiryId");
  let body: { comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await issueInquiryRefund(
      ownerId,
      inquiryId,
      typeof body.comments === "string" ? body.comments : undefined,
    );
  } catch (err) {
    if (!isInquiryAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the refund.", err, "ebay.inquiries.refund");
    }
  }
  await applyOutcomeToSale(ownerId, body.order_id, "return_refunded");
  await markPostSaleCaseClosed(ownerId, "inquiry", inquiryId, "refunded");
  await writeAuditLog(c, {
    action: "ebay.inquiry.refund",
    targetType: "ebay_inquiry",
    targetId: inquiryId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// POST /inquiries/:inquiryId/close — body { comments? }
flipdeskEbayRoutes.post("/inquiries/:inquiryId/close", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const inquiryId = c.req.param("inquiryId");
  let body: { comments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await closeInquiry(
      ownerId,
      inquiryId,
      typeof body.comments === "string" ? body.comments : undefined,
    );
  } catch (err) {
    if (!isInquiryAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected closing the inquiry.", err, "ebay.inquiries.close");
    }
  }
  await markPostSaleCaseClosed(ownerId, "inquiry", inquiryId, "closed");
  await writeAuditLog(c, {
    action: "ebay.inquiry.close",
    targetType: "ebay_inquiry",
    targetId: inquiryId,
    details: {},
  });
  return c.json({ ok: true });
});

// ── Escalated eBay cases (US-2929, Post-Order v2 case management) ───
//
// A case is a return or an inquiry the buyer escalated, and it is the only
// post-sale event that costs a seller defect. eBay decides it — there is no
// approve/decline — so the actions are: supply tracking, refund, appeal a
// decision, or close one settled privately.

// GET /cases — the seller's open cases. Local-first like the other three lists.
flipdeskEbayRoutes.get("/cases", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const cached = await loadCachedSummaries<CaseSummary>(ownerId, "case", { limit });
  if (cached.fresh) return c.json({ cases: cached.items, source: "cache" });
  try {
    const live = await searchCases(ownerId, { limit });
    const nowIso = new Date().toISOString();
    await recordPostSaleCases(ownerId, live.map((x) => caseToCaseInput(x, nowIso)));
    return c.json({ cases: live, source: "ebay" });
  } catch (err) {
    if (cached.items.length > 0) return c.json({ cases: cached.items, source: "cache_stale" });
    return failSafe(c, 502, "Couldn't load eBay cases.", err, "ebay.cases.list");
  }
});

// POST /cases/:caseId/shipment — body { carrier, tracking_number, shipped_date?, comments? }
flipdeskEbayRoutes.post("/cases/:caseId/shipment", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");
  let body: {
    carrier?: unknown;
    tracking_number?: unknown;
    shipped_date?: unknown;
    comments?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : "";
  const trackingNumber = typeof body.tracking_number === "string"
    ? body.tracking_number.trim()
    : "";
  if (!carrier || !trackingNumber) {
    return c.json({ error: "carrier and tracking_number are both required." }, 400);
  }
  try {
    await provideCaseShipmentInfo(ownerId, caseId, {
      carrier,
      trackingNumber,
      shippedDate: typeof body.shipped_date === "string" ? body.shipped_date : undefined,
      comments: typeof body.comments === "string" ? body.comments : undefined,
    });
  } catch (err) {
    if (!isCaseAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the shipment details.", err, "ebay.cases.shipment");
    }
  }
  await updatePostSaleCaseState(ownerId, "case", caseId, { state: "SHIPMENT_PROVIDED" });
  await writeAuditLog(c, {
    action: "ebay.case.shipment",
    targetType: "ebay_case",
    targetId: caseId,
    details: { carrier, tracking_number: trackingNumber },
  });
  return c.json({ ok: true });
});

// POST /cases/:caseId/refund — body { comments?, order_id? }
flipdeskEbayRoutes.post("/cases/:caseId/refund", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");
  let body: { comments?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await issueCaseRefund(
      ownerId,
      caseId,
      typeof body.comments === "string" ? body.comments : undefined,
    );
  } catch (err) {
    if (!isCaseAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the refund.", err, "ebay.cases.refund");
    }
  }
  await applyOutcomeToSale(ownerId, body.order_id, "return_refunded");
  await markPostSaleCaseClosed(ownerId, "case", caseId, "refunded");
  await writeAuditLog(c, {
    action: "ebay.case.refund",
    targetType: "ebay_case",
    targetId: caseId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// GET /negotiation/threshold-conflicts — US-2944.
//
// Which listings have an eBay auto-accept sitting BELOW the active rule's
// number. eBay wins the race, so each of these is a live hole: an offer in the
// gap gets taken at a price the rule would have refused, and the seller's
// margin floor never gets a vote.
//
// Reports both numbers. "There is a conflict" with no figures is a warning a
// seller cannot act on.
flipdeskEbayRoutes.get("/negotiation/threshold-conflicts", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const rule = await loadActiveOfferRule(ownerId);
    if (!rule || rule.acceptAtPct == null) {
      return c.json({ rule: null, conflicts: [] });
    }
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select(
        "id, listing_title, listing_price, best_offer_auto_accept_cents, platform_listing_id, " +
          "inventory_items!inner(user_id, acquired_price)",
      )
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .eq("best_offer_enabled", true)
      .not("best_offer_auto_accept_cents", "is", null)
      .eq("inventory_items.user_id", ownerId)
      .limit(500);
    if (error) throw new Error(error.message);

    const conflicts = ((data ?? []) as unknown as Array<{
      id: string;
      listing_title: string | null;
      listing_price: number | null;
      best_offer_auto_accept_cents: number | null;
      platform_listing_id: string | null;
      inventory_items:
        | { acquired_price: number | null }
        | { acquired_price: number | null }[]
        | null;
    }>)
      .map((row) => {
        const inv = Array.isArray(row.inventory_items)
          ? row.inventory_items[0]
          : row.inventory_items;
        const priceCents = row.listing_price != null
          ? Math.round(Number(row.listing_price) * 100)
          : 0;
        const reconciled = reconcileAutoAcceptWithRule({
          priceCents,
          sellerAcceptCents: row.best_offer_auto_accept_cents,
          ruleAcceptAtPct: rule.acceptAtPct,
          ruleMarginFloorPct: rule.marginFloorPct,
          itemCostCents: typeof inv?.acquired_price === "number"
            ? Math.round(inv.acquired_price * 100)
            : null,
        });
        return { row, reconciled };
      })
      // `matched` and `no_rule` are agreement, not conflict. Only a price the
      // reconciler actually moved is worth telling the seller about.
      .filter(({ reconciled }) =>
        reconciled.reason === "raised_to_rule" ||
        reconciled.reason === "raised_to_margin_floor" ||
        reconciled.reason === "dropped_no_valid_price"
      )
      .map(({ row, reconciled }) => ({
        listing_id: row.id,
        title: row.listing_title,
        platform_listing_id: row.platform_listing_id,
        stored_auto_accept_cents: row.best_offer_auto_accept_cents,
        rule_auto_accept_cents: reconciled.autoAcceptCents,
        reason: reconciled.reason,
      }));

    return c.json({
      rule: {
        id: rule.id,
        accept_at_pct: rule.acceptAtPct,
        margin_floor_pct: rule.marginFloorPct,
      },
      conflicts,
    });
  } catch (err) {
    return failSafe(
      c,
      500,
      "Couldn't check your offer thresholds.",
      err,
      "ebay.offers.threshold_conflicts",
    );
  }
});

// POST /negotiation/threshold-conflicts/reconcile — US-2944. One action.
//
// Writes the rule's number onto every conflicting listing locally. It does NOT
// push to eBay here: the next publish or revise carries it, and firing a bulk
// revise from a "fix this" button would be a large, slow, rate-limited side
// effect the seller did not ask for.
flipdeskEbayRoutes.post("/negotiation/threshold-conflicts/reconcile", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { listing_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const ids = Array.isArray(body.listing_ids)
    ? body.listing_ids.filter((x): x is string => typeof x === "string").slice(0, 500)
    : [];
  if (ids.length === 0) return c.json({ error: "listing_ids is required." }, 400);

  try {
    const rule = await loadActiveOfferRule(ownerId);
    if (!rule || rule.acceptAtPct == null) {
      return c.json({ error: "No active offer rule to reconcile against." }, 409);
    }
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select(
        "id, listing_price, best_offer_auto_accept_cents, " +
          "inventory_items!inner(user_id, acquired_price)",
      )
      // Owner-scoped BEFORE the id filter, so a listing id from another tenant
      // in the request body resolves to nothing rather than being updated.
      .eq("user_id", ownerId)
      .in("id", ids)
      .eq("inventory_items.user_id", ownerId);
    if (error) throw new Error(error.message);

    let updated = 0;
    for (
      const row of (data ?? []) as unknown as Array<{
        id: string;
        listing_price: number | null;
        best_offer_auto_accept_cents: number | null;
        inventory_items:
          | { acquired_price: number | null }
          | { acquired_price: number | null }[]
          | null;
      }>
    ) {
      const inv = Array.isArray(row.inventory_items)
        ? row.inventory_items[0]
        : row.inventory_items;
      const reconciled = reconcileAutoAcceptWithRule({
        priceCents: row.listing_price != null ? Math.round(Number(row.listing_price) * 100) : 0,
        sellerAcceptCents: row.best_offer_auto_accept_cents,
        ruleAcceptAtPct: rule.acceptAtPct,
        ruleMarginFloorPct: rule.marginFloorPct,
        itemCostCents: typeof inv?.acquired_price === "number"
          ? Math.round(inv.acquired_price * 100)
          : null,
      });
      if (reconciled.reason === "matched" || reconciled.reason === "no_rule") continue;
      const { error: writeError } = await supabaseAdmin
        .from("listings")
        .update({ best_offer_auto_accept_cents: reconciled.autoAcceptCents })
        .eq("id", row.id)
        .eq("user_id", ownerId);
      if (writeError) {
        console.error("[ebay.offers.reconcile] write:", writeError.message);
        continue;
      }
      updated++;
    }
    await writeAuditLog(c, {
      action: "ebay.offer_thresholds.reconcile",
      targetType: "flipdesk_automation_rule",
      targetId: rule.id,
      details: { requested: ids.length, updated },
    });
    return c.json({ ok: true, updated });
  } catch (err) {
    return failSafe(c, 500, "Couldn't reconcile the thresholds.", err, "ebay.offers.reconcile");
  }
});

// ── Store follower campaigns (US-2953) ──────────────────────────────
//
// A seller with an eBay Store has an audience they already own and pay nothing
// to reach, and FlipDesk could not send to it.
//
// A SEND IS ALWAYS A HUMAN ACTION. No automation rule reaches these routes and
// there is no scheduled sender — a mailing list is the one asset here that a
// mistake destroys permanently. A rule that emails followers weekly because a
// threshold drifted does not produce a bad campaign, it produces unfollows.

// GET /marketing/email-campaigns — the seller's campaigns and their results.
flipdeskEbayRoutes.get("/marketing/email-campaigns", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json({ available: true, campaigns: await listEmailCampaigns(ownerId) });
  } catch (err) {
    if (isStoreRequiredError(err)) {
      // Detected, not assumed. A seller who subscribes tomorrow sees the
      // feature appear with no code change.
      return c.json({
        available: false,
        detail: "Emailing your followers needs an eBay Store subscription.",
        campaigns: [],
      });
    }
    return failSafe(c, 502, "Couldn't load your eBay campaigns.", err, "ebay.email.list");
  }
});

// POST /marketing/email-campaigns — create a DRAFT. Sending is separate.
//
// body { name, subject, listing_ids }  (LOCAL listing ids)
flipdeskEbayRoutes.post("/marketing/email-campaigns", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { name?: unknown; subject?: unknown; listing_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!name || !subject) return c.json({ error: "name and subject are required." }, 400);
  const requested = Array.isArray(body.listing_ids)
    ? body.listing_ids.filter((x): x is string => typeof x === "string").slice(0, 200)
    : [];
  if (requested.length === 0) {
    return c.json({ error: "Pick at least one listing to feature." }, 400);
  }

  try {
    // LOCAL ids in, eBay ids out, owner-scoped — the same boundary the bulk ad
    // route uses, and for the same reason: an eBay item id is readable off any
    // public listing page.
    const { data: owned } = await supabaseAdmin
      .from("listings")
      .select("id, platform_listing_id")
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .in("id", requested);
    const platformIds = ((owned ?? []) as unknown as Array<{
      id: string;
      platform_listing_id: string | null;
    }>)
      .map((r) => r.platform_listing_id)
      .filter((id): id is string => !!id);
    if (platformIds.length === 0) {
      return c.json({ error: "None of those listings are live on eBay." }, 409);
    }

    const campaignId = await createEmailCampaign(ownerId, {
      name,
      subject,
      listingIds: platformIds,
    });
    await writeAuditLog(c, {
      action: "ebay.email_campaign.create",
      targetType: "ebay_email_campaign",
      targetId: campaignId,
      details: { name, listings: platformIds.length },
    });
    return c.json({ ok: true, campaign_id: campaignId, listings: platformIds.length });
  } catch (err) {
    if (isStoreRequiredError(err)) {
      return c.json({ error: "Emailing your followers needs an eBay Store subscription." }, 409);
    }
    return failSafe(c, 502, "eBay rejected the campaign.", err, "ebay.email.create");
  }
});

// POST /marketing/email-campaigns/:id/send — the explicit human action.
flipdeskEbayRoutes.post("/marketing/email-campaigns/:id/send", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const campaignId = c.req.param("id");
  try {
    await sendEmailCampaign(ownerId, campaignId);
    await writeAuditLog(c, {
      action: "ebay.email_campaign.send",
      targetType: "ebay_email_campaign",
      targetId: campaignId,
      details: {},
    });
    return c.json({ ok: true });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the send.", err, "ebay.email.send");
  }
});

// GET /marketing/email-campaigns/:id/report — opens and clicks, after the send.
flipdeskEbayRoutes.get("/marketing/email-campaigns/:id/report", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json(await emailCampaignReport(ownerId, c.req.param("id")));
  } catch (err) {
    // A campaign that has not gone out yet has no report, which is a state and
    // not a failure.
    console.warn("[ebay.email.report]", err instanceof Error ? err.message : String(err));
    return c.json({ opens: null, clicks: null, recipients: null });
  }
});

// GET /finances/ad-spend — US-2952. What advertising actually cost.
//
// Promoted-listing fees never reached the money view, so the profit figure a
// seller read was profit BEFORE advertising — higher than what they banked,
// every month they ran ads.
//
// The ad fee is billed as its own eBay transaction carrying the order id, and
// that link is kept: "this jacket cost $4.20 to sell" is the question a seller
// asks, and a single advertising total answers a different one.
//
// The response also carries the reconciled LINES and their total, computed
// together so the page cannot show a figure that disagrees with the rows above
// it.
flipdeskEbayRoutes.get("/finances/ad-spend", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const days = Math.min(Math.max(Number(c.req.query("days")) || 90, 1), 365);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const warnings: string[] = [];
    const transactions = await listRecentTransactions(ownerId, sinceIso, warnings);
    const adFees = extractAdFees(
      transactions.map((t) => ({
        transactionId: t.transactionId,
        transactionType: t.transactionType,
        transactionDate: t.transactionDate,
        orderId: t.orderId,
        amount: t.amount,
        // The Finances transaction shape carries the fee type under several
        // names across versions; the reader keeps whichever it finds, and the
        // matcher is loose on purpose — a type eBay adds tomorrow should land
        // in advertising rather than disappearing from the seller's costs.
        feeType: (t as unknown as { feeType?: string | null }).feeType ?? t.transactionType,
        bookingEntry: t.bookingEntry,
      })),
    );

    // The sales side of the same window, so the lines reconcile against
    // something rather than floating on their own.
    const { data: salesRows } = await supabaseAdmin
      .from("sales")
      .select("sale_price, platform_fees, platform_order_id, inventory_item_id")
      .eq("user_id", ownerId)
      .gte("sale_date", sinceIso)
      .limit(5000);
    const sales = ((salesRows ?? []) as unknown as Array<{
      sale_price: number | null;
      platform_fees: number | null;
      platform_order_id: string | null;
      inventory_item_id: string | null;
    }>);
    const revenueCents = sales.reduce(
      (sum, r) => sum + (r.sale_price != null ? Math.round(Number(r.sale_price) * 100) : 0),
      0,
    );
    const platformFeesCents = sales.reduce(
      (sum, r) => sum + (r.platform_fees != null ? Math.round(Number(r.platform_fees) * 100) : 0),
      0,
    );

    // Cost of goods, through the owner-verified parent.
    const itemIds = [...new Set(sales.map((r) => r.inventory_item_id).filter(Boolean))] as string[];
    let costOfGoodsCents = 0;
    if (itemIds.length > 0) {
      const { data: items } = await supabaseAdmin
        .from("inventory_items")
        .select("id, acquired_price")
        .eq("user_id", ownerId)
        .in("id", itemIds);
      const costById = new Map(
        ((items ?? []) as unknown as Array<{ id: string; acquired_price: number | null }>)
          .map((i) => [i.id, i.acquired_price]),
      );
      for (const r of sales) {
        const cost = r.inventory_item_id ? costById.get(r.inventory_item_id) : null;
        if (typeof cost === "number") costOfGoodsCents += Math.round(cost * 100);
      }
    }

    const adFeesCents = adFees.reduce((sum, f) => sum + f.cents, 0);
    // Attributed per order, so a seller can ask what one sale cost to advertise.
    const byOrder: Record<string, number> = {};
    for (const f of adFees) {
      if (!f.orderId) continue;
      byOrder[f.orderId] = (byOrder[f.orderId] ?? 0) + f.cents;
    }

    return c.json({
      days,
      ad_fees_cents: adFeesCents,
      ad_fees_by_order: byOrder,
      unattributed_ad_fees_cents: adFees
        .filter((f) => !f.orderId)
        .reduce((sum, f) => sum + f.cents, 0),
      // Promotion discounts are NOT in the transaction feed as a line — eBay
      // bills the reduced price, not the discount. Reported as zero and said so
      // in the UI rather than inferred from a difference nobody can check.
      ...reconcileMoneyLines({
        revenueCents,
        platformFeesCents,
        shippingCents: 0,
        costOfGoodsCents,
        adFeesCents,
        promotionDiscountCents: 0,
      }),
      warnings,
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't read your eBay ad spend.", err, "ebay.finances.ad_spend");
  }
});

// POST /promotions/markdown-dry-run — US-2950. What the rule WOULD discount.
//
// The rule marks items down without asking, so a seller who cannot see the item
// list and the total discount before enabling it is being asked to trust a
// number they typed against stock they have not looked at.
//
// Reads only. No eBay call, no write, no rule created. The EXCLUSIONS are
// returned with their reasons too — "why is this item not in my sale" is the
// question a seller asks second, and it is invisible if only the hits are listed.
//
// body { min_days_listed, markdown_pct, margin_floor_pct?, min_grade? }
flipdeskEbayRoutes.post("/promotions/markdown-dry-run", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    min_days_listed?: unknown;
    markdown_pct?: unknown;
    margin_floor_pct?: unknown;
    min_grade?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const markdownPct = Math.trunc(Number(body.markdown_pct) || 0);
  if (!(markdownPct > 0)) return c.json({ error: "Set a markdown percentage." }, 400);
  const cfg = {
    minDaysListed: Math.max(1, Math.trunc(Number(body.min_days_listed) || 45)),
    markdownPct,
    marginFloorPct: Math.max(
      0,
      Math.trunc(Number(body.margin_floor_pct) || DEFAULT_OFFER_MARGIN_FLOOR_PCT),
    ),
  };
  const minGradeRaw = body.min_grade;
  const minGrade = minGradeRaw == null || minGradeRaw === "" ? null : Number(minGradeRaw);
  if (minGrade != null && (!Number.isFinite(minGrade) || minGrade < 1 || minGrade > 10)) {
    return c.json({ error: "The minimum grade must be between 1 and 10." }, 400);
  }

  try {
    const candidates = await loadMarkdownCandidates(ownerId);
    const selection = selectMarkdownItems(
      {
        minDaysListed: cfg.minDaysListed,
        markdownPct: cfg.markdownPct,
        marginFloorPct: cfg.marginFloorPct,
        minGrade,
      },
      candidates,
    );
    return c.json({
      scanned: candidates.length,
      included: selection.included.map((i) => ({
        listing_id: i.listingId,
        title: i.title,
        price_cents: i.priceCents,
        days_listed: i.daysListed,
        grade: i.grade,
      })),
      excluded: selection.excluded.map((e) => ({
        listing_id: e.item.listingId,
        title: e.item.title,
        reason: e.reason,
        detail: describeExclusion(e.reason),
      })),
      exposure_cents: selection.exposureCents,
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't run the preview.", err, "ebay.promotions.markdown_dry_run");
  }
});

// GET /promotions/performance — US-2949. Did the sale actually sell more?
//
// "This sale made $840" is not a finding; the items would have sold something
// without it. What is reported is units and revenue DURING the promotion
// against the same window BEFORE it, and BOTH windows are returned so a seller
// can see what was compared rather than trust a lift figure with no denominator.
//
// A promotion too new or too short to have a comparable window reports no lift
// at all rather than a number driven entirely by which afternoon it ran.
//
// Local tables only — no eBay call on page load.
flipdeskEbayRoutes.get("/promotions/performance", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const promotions = await loadPromotions(ownerId, 50);
    if (promotions.length === 0) return c.json({ promotions: [] });

    // One sales read covering every promotion window, rather than one per
    // promotion. The oldest window start bounds it.
    const earliest = promotions
      .map((p) => (p.startsAt ? Date.parse(p.startsAt) : Number.NaN))
      .filter((t) => Number.isFinite(t))
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    const sinceMs = Number.isFinite(earliest)
      ? earliest - 90 * 86_400_000
      : Date.now() - 180 * 86_400_000;
    const { data: salesRows } = await supabaseAdmin
      .from("sales")
      .select("sale_date, sale_price")
      .eq("user_id", ownerId)
      .gte("sale_date", new Date(sinceMs).toISOString())
      .limit(5000);
    const sales = ((salesRows ?? []) as unknown as Array<{
      sale_date: string | null;
      sale_price: number | null;
    }>)
      .filter((r) => r.sale_date && r.sale_price != null)
      .map((r) => ({
        soldAt: r.sale_date!,
        priceCents: Math.round(Number(r.sale_price) * 100),
      }));

    return c.json({
      promotions: promotions.map((promo) => ({
        id: promo.id,
        external_promotion_id: promo.externalPromotionId,
        name: promo.name,
        promotion_type: promo.promotionType,
        status: promo.status,
        discount_pct: promo.discountPct,
        starts_at: promo.startsAt,
        ends_at: promo.endsAt,
        item_count: promo.itemCount,
        reported_units: promo.reportedUnits,
        reported_revenue_cents: promo.reportedRevenueCents,
        // NOT the seller's whole catalogue: this compares total sales in the
        // two windows, which is the honest available comparison when we do not
        // store which items were in the promotion. Said in the response so the
        // UI can say it too.
        comparison_basis: "all_sales_in_window",
        lift: computeLift(promo.startsAt, promo.endsAt, sales),
      })),
    });
  } catch (err) {
    return failSafe(
      c,
      500,
      "Couldn't work out how your promotions did.",
      err,
      "ebay.promotions.performance",
    );
  }
});

// POST /promotions/sync — US-2949. Pull the seller's promotions into the record.
flipdeskEbayRoutes.post("/promotions/sync", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const promos = await getItemPromotions(ownerId);
    const stored = await recordPromotions(
      ownerId,
      promos.map((p) => ({
        externalPromotionId: p.promotionId,
        promotionType: p.promotionType ?? null,
        name: p.name ?? null,
        status: p.promotionStatus ?? null,
        startsAt: p.startDate ?? null,
        endsAt: p.endDate ?? null,
        raw: p,
      })),
    );
    return c.json({ ok: true, stored });
  } catch (err) {
    return failSafe(c, 502, "Couldn't read your eBay promotions.", err, "ebay.promotions.sync");
  }
});

// GET /promotions/stack-check — US-2951. What an item leaves at once every
// discount stacks.
//
// A markdown sale, a coupon and an accepted offer can all apply to one garment
// and nothing added them up. This REPORTS; it removes nothing. Silently pulling
// an item out of a promotion the seller built is a bigger surprise than the
// discount was.
//
// An item with no recorded cost is reported as UNCHECKED, not as safe.
flipdeskEbayRoutes.get("/promotions/stack-check", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const marginFloorPct = Math.min(
    Math.max(Number(c.req.query("margin_floor_pct")) || DEFAULT_OFFER_MARGIN_FLOOR_PCT, 0),
    100,
  );
  try {
    // The active markdown percentage, if the seller is running one. eBay's
    // promotion object carries it; a seller in no sale simply has none.
    const promotions = await loadPromotions(ownerId, 50);
    const running = promotions.filter((p) => (p.status ?? "").toUpperCase() === "RUNNING");
    const markdownPct = running
      .filter((p) => (p.promotionType ?? "").toUpperCase().includes("MARKDOWN"))
      .map((p) => p.discountPct ?? 0)
      .reduce((a, b) => Math.max(a, b), 0) || null;
    const couponPct = running
      .filter((p) => (p.promotionType ?? "").toUpperCase().includes("COUPON"))
      .map((p) => p.discountPct ?? 0)
      .reduce((a, b) => Math.max(a, b), 0) || null;

    const { data: rows } = await supabaseAdmin
      .from("listings")
      .select(
        "id, listing_title, listing_price, best_offer_auto_accept_cents, " +
          "inventory_items!inner(user_id, acquired_price)",
      )
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .eq("listing_status", "active")
      .eq("inventory_items.user_id", ownerId)
      .limit(1000);

    const results = ((rows ?? []) as unknown as Array<{
      id: string;
      listing_title: string | null;
      listing_price: number | null;
      best_offer_auto_accept_cents: number | null;
      inventory_items:
        | { acquired_price: number | null }
        | { acquired_price: number | null }[]
        | null;
    }>).map((row) => {
      const inv = Array.isArray(row.inventory_items)
        ? row.inventory_items[0]
        : row.inventory_items;
      const verdict = evaluateStack({
        priceCents: row.listing_price != null ? Math.round(Number(row.listing_price) * 100) : null,
        costCents: typeof inv?.acquired_price === "number"
          ? Math.round(inv.acquired_price * 100)
          : null,
        // No per-listing postage exists: shipping_cost is on SALES (00008) and
        // is recorded after the fact, while a live listing carries only a
        // shipping POLICY id. Null UNDER-reports the stack, which is the safe
        // direction for a warning - it can miss a breach, never invent one.
        shippingCostCents: null,
        markdownPct,
        couponPct,
        autoAcceptCents: row.best_offer_auto_accept_cents,
        marginFloorPct,
      });
      return {
        listing_id: row.id,
        title: row.listing_title,
        worst_case_cents: verdict.worstCaseCents,
        floor_cents: verdict.floorCents,
        breaches: verdict.breaches,
        unchecked: verdict.unchecked,
        detail: describeStack(verdict),
      };
    });

    return c.json({
      margin_floor_pct: marginFloorPct,
      markdown_pct: markdownPct,
      coupon_pct: couponPct,
      breaching: results.filter((r) => r.breaches),
      // Reported separately and never folded into "safe": an item we could not
      // check is not an item we checked and cleared.
      unchecked: results.filter((r) => r.unchecked).length,
      checked: results.filter((r) => !r.unchecked).length,
    });
  } catch (err) {
    return failSafe(
      c,
      500,
      "Couldn't check your discounts.",
      err,
      "ebay.promotions.stack_check",
    );
  }
});

// ── Campaign suggestions, lifecycle and bulk ads (US-2946/47/48) ────
//
// FlipDesk could create a campaign and set one ad rate at a time. It could not
// ask eBay what to promote, could not stop what it had started, and could not
// change a hundred rates without a hundred calls — so a seller who started a
// campaign here had to finish it in Seller Hub.
//
// The campaign id is always resolved from the seller's own connection through
// ensureCpcCampaign; it is never taken from the request (US-268).

// GET /marketing/suggestions — eBay's view, joined to ours.
//
// Ranked by MARGIN AFTER THE AD FEE, not by eBay's own order, and the response
// says which ordering it used. eBay ranks by what it expects to sell; a seller
// cares what is left afterwards, and those are not the same list.
flipdeskEbayRoutes.get("/marketing/suggestions", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!recommendationApiSupported(getMarketplaceId())) {
    // Honest and specific: this marketplace has no suggestion API, which is not
    // the same as "you have nothing worth promoting".
    return c.json({
      supported: false,
      detail: "eBay does not offer promotion suggestions on this marketplace.",
      items: [],
    });
  }
  try {
    const { campaignId, adGroupId } = await ensureCpcCampaign(ownerId);
    const [items, budget, bids] = await Promise.all([
      suggestItems(ownerId, campaignId),
      suggestBudget(ownerId, campaignId).catch(() => ({
        dailyBudgetCents: null,
        currency: null,
      })),
      suggestBids(ownerId, campaignId, adGroupId).catch(() => []),
    ]);
    if (items.length === 0) {
      return c.json({ supported: true, ordering: "margin_after_ad_fee", items: [], budget, bids });
    }

    // The local economics. Scoped through the owner-verified parent item, the
    // loadListingOwned pattern.
    const listingIds = items.map((i) => i.listingId);
    const { data: rows } = await supabaseAdmin
      .from("listings")
      .select(
        "platform_listing_id, listing_title, listing_price, listed_at, " +
          "inventory_items!inner(user_id, acquired_price)",
      )
      .eq("platform", "ebay")
      .in("platform_listing_id", listingIds)
      .eq("inventory_items.user_id", ownerId);
    const localById = new Map(
      ((rows ?? []) as unknown as Array<{
        platform_listing_id: string | null;
        listing_title: string | null;
        listing_price: number | null;
        listed_at: string | null;
        inventory_items:
          | { acquired_price: number | null }
          | { acquired_price: number | null }[]
          | null;
      }>).filter((r) => r.platform_listing_id).map((r) => [r.platform_listing_id!, r]),
    );

    const nowMs = Date.now();
    const enriched = items.map((it) => {
      const local = localById.get(it.listingId);
      const inv = Array.isArray(local?.inventory_items)
        ? local?.inventory_items[0]
        : local?.inventory_items;
      const priceCents = local?.listing_price != null
        ? Math.round(Number(local.listing_price) * 100)
        : null;
      const costCents = typeof inv?.acquired_price === "number"
        ? Math.round(inv.acquired_price * 100)
        : null;
      const rate = it.suggestedBidPercentage;
      const adFeeCents = priceCents != null && rate != null
        ? Math.round(priceCents * (rate / 100))
        : null;
      // Null, not zero, when the cost is unknown — an item with no cost basis
      // has an unknown margin, and ranking it as if it were free puts the
      // things we know least about at the top of a spending list.
      const marginAfterAdFeeCents = priceCents != null && costCents != null && adFeeCents != null
        ? priceCents - costCents - adFeeCents
        : null;
      const listedAt = local?.listed_at ? Date.parse(local.listed_at) : Number.NaN;
      return {
        listing_id: it.listingId,
        title: local?.listing_title ?? null,
        suggested_bid_percentage: rate,
        price_cents: priceCents,
        cost_cents: costCents,
        ad_fee_cents: adFeeCents,
        margin_after_ad_fee_cents: marginAfterAdFeeCents,
        days_listed: Number.isFinite(listedAt)
          ? Math.floor((nowMs - listedAt) / 86_400_000)
          : null,
      };
    }).sort((a, b) => {
      const am = a.margin_after_ad_fee_cents;
      const bm = b.margin_after_ad_fee_cents;
      if (am == null && bm == null) return 0;
      if (am == null) return 1;
      if (bm == null) return -1;
      return bm - am;
    });

    return c.json({ supported: true, ordering: "margin_after_ad_fee", items: enriched, budget, bids });
  } catch (err) {
    return failSafe(
      c,
      502,
      "Couldn't load eBay's promotion suggestions.",
      err,
      "ebay.marketing.suggestions",
    );
  }
});

// POST /marketing/campaign/:action — pause | resume | end | clone.
//
// An already-in-that-state answer is success: a seller pressing Pause on a
// paused campaign should see it paused, not a 502.
flipdeskEbayRoutes.post("/marketing/campaign/:action", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const action = c.req.param("action");
  if (action !== "pause" && action !== "resume" && action !== "end" && action !== "clone") {
    return c.json({ error: "action must be pause, resume, end or clone." }, 400);
  }
  let body: { name?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    const { campaignId } = await ensureCpcCampaign(ownerId);
    let clonedId: string | null = null;
    try {
      if (action === "pause") await pauseCampaign(ownerId, campaignId);
      else if (action === "resume") await resumeCampaign(ownerId, campaignId);
      else if (action === "end") await endCampaign(ownerId, campaignId);
      else {
        clonedId = await cloneCampaign(
          ownerId,
          campaignId,
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : `FlipDesk ${new Date().toISOString().slice(0, 10)}`,
        );
      }
    } catch (err) {
      if (!isCampaignAlreadyInState(err)) throw err;
    }

    // ENDING CLEARS THE CACHED IDS. ensureCpcCampaign short-circuits on
    // marketplace_connections.ebay_cpc_campaign_id, so leaving a dead id there
    // means every later ad create is aimed at a campaign that no longer exists.
    if (action === "end") {
      const { error } = await supabaseAdmin
        .from("marketplace_connections")
        .update({ ebay_cpc_campaign_id: null, ebay_cpc_ad_group_id: null })
        .eq("user_id", ownerId)
        .eq("marketplace", "ebay");
      if (error) console.error("[ebay.marketing.campaign.end] cache clear:", error.message);
    }

    await writeAuditLog(c, {
      action: `ebay.marketing.campaign.${action}`,
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { cloned_campaign_id: clonedId },
    });
    return c.json({ ok: true, campaign_id: campaignId, cloned_campaign_id: clonedId });
  } catch (err) {
    return failSafe(
      c,
      502,
      "eBay rejected the campaign change.",
      err,
      `ebay.marketing.campaign.${action}`,
    );
  }
});

// POST /marketing/ads/bulk — body { listing_ids, bid_percentage, mode? }
//
// PER-LISTING RESULTS, never one aggregate ok. eBay's bulk endpoints return 200
// while rejecting half the batch, and reporting that as success is how a seller
// comes to believe a hundred items are promoted when forty are not.
flipdeskEbayRoutes.post("/marketing/ads/bulk", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { listing_ids?: unknown; bid_percentage?: unknown; mode?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const requested = Array.isArray(body.listing_ids)
    ? body.listing_ids.filter((x): x is string => typeof x === "string")
    : [];
  if (requested.length === 0) {
    return c.json({ error: "listing_ids must be a non-empty array." }, 400);
  }
  const bid = Number(body.bid_percentage);
  if (!Number.isFinite(bid) || bid <= 0 || bid > 100) {
    return c.json({ error: "bid_percentage must be between 0 and 100." }, 400);
  }
  const mode = body.mode === "update" ? "update" : "create";

  try {
    // TENANT SCOPE, and the reason the body carries LOCAL listing ids rather
    // than eBay ones: the local id resolves through a row we own, so an id
    // belonging to another seller resolves to NOTHING. Taking eBay's own item
    // id here would mean trusting an identifier the caller could have read off
    // any public listing page.
    //
    // A foreign or unpublished id is REJECTED BY NAME rather than silently
    // dropped — a silent drop reports a smaller success than the caller asked
    // for and says nothing about why.
    const { data: owned } = await supabaseAdmin
      .from("listings")
      .select("id, platform_listing_id")
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .in("id", requested);
    const platformById = new Map(
      ((owned ?? []) as unknown as Array<{ id: string; platform_listing_id: string | null }>)
        .filter((r) => r.platform_listing_id)
        .map((r) => [r.id, r.platform_listing_id!]),
    );
    const unresolved = requested.filter((id) => !platformById.has(id));
    if (unresolved.length > 0) {
      return c.json(
        {
          error: "Some listings can't be promoted.",
          detail:
            `${unresolved.length} of them either aren't yours or aren't live on eBay yet.`,
        },
        unresolved.length === requested.length ? 403 : 409,
      );
    }
    const platformIds = requested.map((id) => platformById.get(id)!);

    const { campaignId } = await ensureCpcCampaign(ownerId);
    const results: BulkAdResult[] = mode === "update"
      ? await bulkUpdateAdRateByListingId(ownerId, campaignId, platformIds, bid)
      : await bulkCreateAdsByListingId(ownerId, campaignId, platformIds, bid);
    const failed = results.filter((r) => !r.ok);
    await writeAuditLog(c, {
      action: `ebay.marketing.ads.bulk_${mode}`,
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { requested: requested.length, failed: failed.length, bid_percentage: bid },
    });
    return c.json({
      ok: failed.length === 0,
      campaign_id: campaignId,
      succeeded: results.length - failed.length,
      failed: failed.length,
      results,
    });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the bulk change.", err, "ebay.marketing.ads.bulk");
  }
});

// ── Promoted Listings Advanced keywords (US-2945) ───────────────────
//
// FlipDesk could create a CPC campaign and an ad group and then had no way to
// put a keyword in either. A bid you cannot aim is a bid you cannot control,
// and that aim is the only difference between Advanced and Standard.
//
// Every route resolves the seller's own campaign through ensureCpcCampaign, so
// a campaign id is never taken from the request (US-268).

// GET /marketing/keywords — the seller's keywords, plus the negative-keyword
// candidates their own reported search terms already prove.
flipdeskEbayRoutes.get("/marketing/keywords", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const { campaignId, adGroupId } = await ensureCpcCampaign(ownerId);
    const [keywords, negatives, terms] = await Promise.all([
      listKeywords(ownerId, campaignId, adGroupId),
      listNegativeKeywords(ownerId, campaignId),
      loadSearchTerms(ownerId, { limit: 500 }),
    ]);
    return c.json({
      campaignId,
      adGroupId,
      keywords,
      negatives,
      // Computed here rather than in the UI: it is the half a seller can act on
      // today, and the rule for what counts as waste is one number the page and
      // the test have to agree about.
      negativeCandidates: negativeKeywordCandidates(
        terms.map((t) => ({
          term: t.term,
          impressions: t.impressions,
          clicks: t.clicks,
          attributedSales: t.attributedSales,
        })),
        negatives.map((n) => n.text),
      ),
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load your eBay keywords.", err, "ebay.marketing.keywords");
  }
});

// GET /marketing/keywords/suggestions — eBay's own suggestions.
flipdeskEbayRoutes.get("/marketing/keywords/suggestions", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const { campaignId, adGroupId } = await ensureCpcCampaign(ownerId);
    return c.json({ suggestions: await suggestKeywords(ownerId, campaignId, adGroupId) });
  } catch (err) {
    // A marketplace or account without suggestions is a normal state, not an
    // outage: report none rather than an error the seller cannot act on.
    console.warn(
      "[ebay.marketing.keyword_suggestions]",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ suggestions: [] });
  }
});

// POST /marketing/keywords — body { text, match_type?, bid_cents? }
flipdeskEbayRoutes.post("/marketing/keywords", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { text?: unknown; match_type?: unknown; bid_cents?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required." }, 400);
  const matchType = normalizeMatchType(body.match_type);
  const bidCents = Number.isFinite(Number(body.bid_cents)) && Number(body.bid_cents) > 0
    ? Math.round(Number(body.bid_cents))
    : null;
  try {
    const { campaignId, adGroupId } = await ensureCpcCampaign(ownerId);
    const keywordId = await createKeyword(ownerId, campaignId, adGroupId, {
      text,
      matchType,
      bidCents,
    });
    await writeAuditLog(c, {
      action: "ebay.marketing.keyword.create",
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { keyword_id: keywordId, text, match_type: matchType, bid_cents: bidCents },
    });
    return c.json({ ok: true, keyword_id: keywordId });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the keyword.", err, "ebay.marketing.keyword.create");
  }
});

// PATCH /marketing/keywords/:keywordId — body { bid_cents?, status? }
flipdeskEbayRoutes.patch("/marketing/keywords/:keywordId", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const keywordId = c.req.param("keywordId");
  let body: { bid_cents?: unknown; status?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const bidCents = Number.isFinite(Number(body.bid_cents)) && Number(body.bid_cents) > 0
    ? Math.round(Number(body.bid_cents))
    : null;
  const status = body.status === "ACTIVE" || body.status === "PAUSED" ? body.status : undefined;
  if (bidCents == null && !status) {
    return c.json({ error: "Nothing to change — send bid_cents or status." }, 400);
  }
  try {
    const { campaignId } = await ensureCpcCampaign(ownerId);
    await updateKeyword(ownerId, campaignId, keywordId, { bidCents, status });
    await writeAuditLog(c, {
      action: "ebay.marketing.keyword.update",
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { keyword_id: keywordId, bid_cents: bidCents, status: status ?? null },
    });
    return c.json({ ok: true });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the change.", err, "ebay.marketing.keyword.update");
  }
});

// POST /marketing/negative-keywords — body { text, match_type? }
flipdeskEbayRoutes.post("/marketing/negative-keywords", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { text?: unknown; match_type?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required." }, 400);
  try {
    const { campaignId, adGroupId } = await ensureCpcCampaign(ownerId);
    const id = await createNegativeKeyword(
      ownerId,
      campaignId,
      adGroupId,
      text,
      normalizeMatchType(body.match_type),
    );
    await writeAuditLog(c, {
      action: "ebay.marketing.negative_keyword.create",
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { negative_keyword_id: id, text },
    });
    return c.json({ ok: true, negative_keyword_id: id });
  } catch (err) {
    return failSafe(
      c,
      502,
      "eBay rejected the negative keyword.",
      err,
      "ebay.marketing.negative_keyword.create",
    );
  }
});

// PHRASE by default: EXACT blocks one spelling and lets every variation through,
// which reads to a seller as "the negative keyword did nothing".
function normalizeMatchType(raw: unknown): MatchType {
  return raw === "EXACT" || raw === "BROAD" ? raw : "PHRASE";
}

// GET /negotiation/analytics — US-2942. What discount depth actually converts.
//
// Every reseller guesses at this. "Send 10% off" is folklore; nobody measures
// whether 10% converts worse than 20%, because nobody has the data. Once offers
// are stored it is arithmetic — and if 12% converts as well as 20%, every 20%
// offer that seller has ever sent gave away eight points for nothing.
//
// The two DIRECTIONS are reported separately and never pooled. An unprompted
// discount to a watcher and a counter to someone who already bid are different
// acts, and the counters' much higher accept rate would flatter the sends.
flipdeskEbayRoutes.get("/negotiation/analytics", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const days = Math.min(Math.max(Number(c.req.query("days")) || 180, 7), 730);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const [sent, counters] = await Promise.all([
      loadOffers(ownerId, { direction: "offer_sent", sinceIso, limit: 1000 }),
      loadOffers(ownerId, { direction: "counter_sent", sinceIso, limit: 1000 }),
    ]);
    const toAnalytics = (rows: Awaited<ReturnType<typeof loadOffers>>) =>
      rows.map((o) => ({
        amountCents: o.amountCents,
        listPriceCents: o.listPriceCents,
        response: o.response,
        createdAt: o.createdAt,
        respondedAt: o.respondedAt,
      }));
    return c.json({
      days,
      sentOffers: summarizeOffers(toAnalytics(sent)),
      counters: summarizeOffers(toAnalytics(counters)),
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't build the offer analytics.", err, "ebay.offers.analytics");
  }
});

// POST /negotiation/rule-dry-run — US-2940. What an offer rule WOULD have done.
//
// Reads the STORED offers, which is the only reason this is possible: before
// US-2939 there was no history to run a rule against, so a seller enabling an
// auto-counter was guessing. Reads only — no eBay call, no write, no rule
// created.
//
// body { accept_at_pct?, counter_at_pct?, decline_below_pct?, margin_floor_pct?, days? }
flipdeskEbayRoutes.post("/negotiation/rule-dry-run", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    accept_at_pct?: unknown;
    counter_at_pct?: unknown;
    decline_below_pct?: unknown;
    margin_floor_pct?: unknown;
    days?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const cfg = {
    acceptAtPct: normalizeThresholdPct(body.accept_at_pct),
    declineBelowPct: normalizeThresholdPct(body.decline_below_pct),
    counterAtPct: normalizeThresholdPct(body.counter_at_pct),
    marginFloorPct: normalizeThresholdPct(body.margin_floor_pct) ?? 10,
  };
  if (cfg.acceptAtPct == null && cfg.declineBelowPct == null && cfg.counterAtPct == null) {
    return c.json({ error: "Set an auto-accept, auto-counter or auto-decline threshold." }, 400);
  }
  const days = Math.min(Math.max(Number(body.days) || 30, 1), 180);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const stored = await loadOffers(ownerId, {
      direction: "received",
      sinceIso,
      limit: 300,
    });
    // The acquisition cost per item, so the preview applies the margin floor
    // the same way the runner does. Owner-scoped through the parent item.
    const itemIds = [...new Set(stored.map((o) => o.itemExternalId).filter(Boolean))] as string[];
    const costByItemId = new Map<string, number>();
    if (itemIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from("listings")
        .select("platform_listing_id, inventory_items!inner(user_id, acquired_price)")
        .eq("platform", "ebay")
        .in("platform_listing_id", itemIds)
        .eq("inventory_items.user_id", ownerId);
      for (
        const r of (rows ?? []) as unknown as Array<{
          platform_listing_id: string | null;
          inventory_items:
            | { acquired_price: number | null }
            | { acquired_price: number | null }[]
            | null;
        }>
      ) {
        const inv = Array.isArray(r.inventory_items) ? r.inventory_items[0] : r.inventory_items;
        if (r.platform_listing_id && typeof inv?.acquired_price === "number") {
          costByItemId.set(r.platform_listing_id, inv.acquired_price);
        }
      }
    }

    return c.json({
      days,
      ...dryRunOfferRule(
        cfg,
        stored.map((o) => ({
          externalOfferId: o.externalOfferId,
          offerPrice: o.amountCents == null ? null : o.amountCents / 100,
          // The SNAPSHOT price, not today's. Running the preview against the
          // current ask would score a rule on prices these offers never saw.
          listPrice: o.listPriceCents == null ? null : o.listPriceCents / 100,
          itemCost: o.itemExternalId ? (costByItemId.get(o.itemExternalId) ?? null) : null,
        })),
      ),
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't run the preview.", err, "ebay.offers.dry_run");
  }
});

// POST /returns/rule-dry-run — US-2938. What a return rule WOULD have done.
//
// Not a nicety. These rules refund buyers, and a seller who cannot see the item
// list before switching one on is being asked to trust a number they typed
// against data they have not looked at. Reads only: no eBay call, no write, and
// no rule is created here.
//
// body { approve_at_or_below_cents?, refund_without_return_at_or_below_cents?, days? }
flipdeskEbayRoutes.post("/returns/rule-dry-run", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    approve_at_or_below_cents?: unknown;
    refund_without_return_at_or_below_cents?: unknown;
    days?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const cfg = {
    approveAtOrBelowCents: normalizeReturnThresholdCents(body.approve_at_or_below_cents),
    refundWithoutReturnAtOrBelowCents: normalizeReturnThresholdCents(
      body.refund_without_return_at_or_below_cents,
    ),
  };
  if (cfg.approveAtOrBelowCents == null && cfg.refundWithoutReturnAtOrBelowCents == null) {
    return c.json({ error: "Set an auto-approve or a refund-without-return limit." }, 400);
  }
  const days = Math.min(Math.max(Number(body.days) || 30, 1), 180);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const { data, error } = await supabaseAdmin
      .from("marketplace_post_sale_cases")
      .select("external_id, reason, state, sale_id, opened_at")
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .eq("case_type", "return")
      .gte("opened_at", sinceIso)
      .order("opened_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as Array<{
      external_id: string;
      reason: string | null;
      state: string | null;
      sale_id: string | null;
    }>;

    // The order total comes through the linked sale. A return with no linked
    // sale has none, and the evaluator skips it rather than treating unknown as
    // zero — which the preview then shows as a skip with its reason.
    const saleIds = [...new Set(rows.map((r) => r.sale_id).filter(Boolean))] as string[];
    const totalBySale = new Map<string, number>();
    if (saleIds.length > 0) {
      const { data: sales } = await supabaseAdmin
        .from("sales")
        .select("id, sale_price")
        .eq("user_id", ownerId)
        .in("id", saleIds);
      for (
        const sale of (sales ?? []) as unknown as Array<{
          id: string;
          sale_price: number | null;
        }>
      ) {
        const n = sale.sale_price == null ? Number.NaN : Number(sale.sale_price);
        if (Number.isFinite(n)) totalBySale.set(sale.id, Math.round(n * 100));
      }
    }

    return c.json({
      days,
      ...dryRunReturnRule(
        cfg,
        rows.map((r) => ({
          externalId: r.external_id,
          reason: r.reason,
          state: r.state,
          orderTotalCents: r.sale_id ? (totalBySale.get(r.sale_id) ?? null) : null,
        })),
      ),
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't run the preview.", err, "ebay.returns.dry_run");
  }
});

// GET /post-sale/analytics — US-2936. Return outcomes against the grade.
//
// The analysis no other reseller tool can run: every marketplace shows a seller
// their return RATE, and none of them knows what condition the item was in when
// it went out, because none of them graded it.
//
// Local tables only. No eBay call on page load, which is also what makes a
// ninety-day window affordable.
flipdeskEbayRoutes.get("/post-sale/analytics", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const days = Math.min(Math.max(Number(c.req.query("days")) || 90, 7), 365);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const { sales, cases, truncated } = await loadReturnAnalyticsInputs(ownerId, sinceIso);
    return c.json({
      days,
      truncated,
      // Echoed so the UI can say why a slice reads "not enough sales yet"
      // instead of leaving the reader to guess the threshold.
      minSalesForRate: MIN_SALES_FOR_RATE,
      ...summarizeReturns(sales, cases),
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't build the return analytics.", err, "ebay.postsale.analytics");
  }
});

// POST /cases/:caseId/evidence — US-2935. The grade pack, on the surface that
// costs a defect.
//
// Multipart, exactly like the return route, and it shares that route's two
// rules through lib/evidence-send.ts: the sniff-then-strip pass, and the
// refusal when the grade report AGREES with the buyer. What differs is only the
// eBay upload API, which is the case surface's own.
//
// TENANT SCOPE (US-268): every eBay call runs under the OWNER's token, so a
// caseId belonging to another seller reaches eBay as this seller's case and
// comes back 404/403. There is no local query here that could read another
// tenant's row, and the audit entry is written against the same owner.
flipdeskEbayRoutes.post("/cases/:caseId/evidence", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data. Expected multipart/form-data." }, 400);
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  const cleanResult = await cleanEvidenceFiles(files, MAX_RETURN_EVIDENCE_FILES);
  if (!cleanResult.ok) return c.json({ error: cleanResult.error }, cleanResult.status);
  const cleaned = cleanResult.files;

  const complaint = String(form.get("complaint") ?? "").trim();
  const orderId = String(form.get("order_id") ?? "").trim();
  let context: EvidenceContext | null = null;
  if (complaint && orderId) {
    context = await planEvidence(ownerId, orderId, complaint);
    const refusal = evidenceRefusalFor(context?.plan);
    if (refusal) return c.json({ error: "refused", ...refusal }, 409);
  }

  // The sheet goes first so the reviewer reads what this is before they look at
  // a close-up of a cuff, and only for a CERTIFIED grade — a cover page reading
  // "Not certified" argues against the seller on the one asset that exists to
  // argue for them.
  if (context?.stamp.certificateNumber) {
    try {
      cleaned.unshift({
        bytes: await compositeReturnEvidenceSheet(
          context.stamp,
          context.defectCount,
          context.gradedAt,
        ),
        filename: "condition-report.jpg",
        contentType: "image/jpeg",
      });
    } catch (err) {
      console.error(
        "[ebay.cases.evidence] sheet render failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const fileIds: string[] = [];
  try {
    for (const file of cleaned) {
      fileIds.push(
        await uploadCaseFile(ownerId, caseId, {
          bytes: file.bytes,
          filename: file.filename,
          purpose: "ITEM_RELATED",
        }),
      );
    }
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the evidence upload.", err, "ebay.cases.evidence.upload");
  }

  let removedFileIds: string[] = [];
  try {
    ({ removedFileIds } = await submitCaseFiles(ownerId, caseId, "ITEM_RELATED"));
  } catch (err) {
    return failSafe(c, 502, "eBay accepted the files but would not activate them.", err, "ebay.cases.evidence.submit");
  }

  await writeAuditLog(c, {
    action: "ebay.case.evidence",
    targetType: "ebay_case",
    targetId: caseId,
    details: { files: fileIds.length, removed: removedFileIds.length },
  });

  return c.json({
    ok: true,
    attached: fileIds.length - removedFileIds.length,
    removed: removedFileIds.length,
  });
});

// POST /cases/:caseId/appeal — body { comments }
//
// eBay requires an argument; a bare appeal is rejected, so the 400 happens here
// rather than as an opaque 502 after the round trip.
flipdeskEbayRoutes.post("/cases/:caseId/appeal", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");
  let body: { comments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const comments = typeof body.comments === "string" ? body.comments.trim() : "";
  if (!comments) {
    return c.json({ error: "comments is required — eBay rejects an appeal with no argument." }, 400);
  }
  try {
    await appealCase(ownerId, caseId, comments);
  } catch (err) {
    if (!isCaseAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected the appeal.", err, "ebay.cases.appeal");
    }
  }
  await updatePostSaleCaseState(ownerId, "case", caseId, { state: "APPEALED" });
  await writeAuditLog(c, {
    action: "ebay.case.appeal",
    targetType: "ebay_case",
    targetId: caseId,
    details: {},
  });
  return c.json({ ok: true });
});

// POST /cases/:caseId/close — body { comments? }
flipdeskEbayRoutes.post("/cases/:caseId/close", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const caseId = c.req.param("caseId");
  let body: { comments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await closeCase(ownerId, caseId, typeof body.comments === "string" ? body.comments : undefined);
  } catch (err) {
    if (!isCaseAlreadySettled(err)) {
      return failSafe(c, 502, "eBay rejected closing the case.", err, "ebay.cases.close");
    }
  }
  await markPostSaleCaseClosed(ownerId, "case", caseId, "closed");
  await writeAuditLog(c, {
    action: "ebay.case.close",
    targetType: "ebay_case",
    targetId: caseId,
    details: {},
  });
  return c.json({ ok: true });
});

// POST /returns/:returnId/received — US-2930.
//
// The action whose absence costs money quietly: without it eBay's clock keeps
// running on an item already back in the seller's hands, and that clock ends in
// an automatic refund.
flipdeskEbayRoutes.post("/returns/:returnId/received", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { comments?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await markReturnReceived(
      ownerId,
      returnId,
      typeof body.comments === "string" ? body.comments : undefined,
    );
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected marking the return received.", err, "ebay.returns.received");
    }
  }
  // Reflect it now rather than at the next poll, so the page the seller acted
  // from stops offering the action they just took.
  await updatePostSaleCaseState(ownerId, "return", returnId, { state: "ITEM_RECEIVED" });
  await writeAuditLog(c, {
    action: "ebay.return.received",
    targetType: "ebay_return",
    targetId: returnId,
    details: {},
  });
  return c.json({ ok: true });
});

// POST /returns/:returnId/message — US-2932. The return-scoped conversation.
//
// Not the member-message inbox. eBay reads THIS thread when it decides a case,
// so a keep-it agreement reached in the other inbox is one eBay cannot see.
flipdeskEbayRoutes.post("/returns/:returnId/message", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  let body: { message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return c.json({ error: "message is required." }, 400);
  try {
    await sendReturnMessage(ownerId, returnId, message);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the message.", err, "ebay.returns.message");
  }
  await writeAuditLog(c, {
    action: "ebay.return.message",
    targetType: "ebay_return",
    targetId: returnId,
    details: { length: message.length },
  });
  return c.json({ ok: true });
});

// GET /returns/:returnId/label — US-2931. The buyer's return shipment.
//
// `{ label: null }` is a real answer, not an error: it means the buyer has not
// posted the item yet, which is exactly what a seller deciding whether to wait
// needs to know. Only a failed READ is a 502.
flipdeskEbayRoutes.get("/returns/:returnId/label", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");
  try {
    const label = await getReturnShipment(ownerId, returnId);
    // Store it on the case so the list carries it on the next read and a page
    // reload costs no second eBay call.
    if (label) await mergePostSaleCaseRaw(ownerId, "return", returnId, { label });
    return c.json({ label });
  } catch (err) {
    return failSafe(c, 502, "Couldn't read the return shipment.", err, "ebay.returns.label");
  }
});

// US-2706 AC5 / US-2707 AC4: POST /evidence/preview — what the pack WOULD say,
// without sending anything.
//
// Reads only. It touches no eBay endpoint and writes nothing, which is what
// lets the seller see the verdict, the citations and the sheet's own facts
// before they decide. The send is a separate call behind a separate click;
// there is no timer here and nothing auto-submits.
//
// NOT scoped to a return or a dispute, because the plan never depended on
// either: it is built from the ORDER's graded item and the listing text we
// published. Mounting a second copy under each case type would be two routes
// that must agree about a verdict, and the one that drifted would be the rarer
// path — which is the gap US-2707 exists to close.
//
// body { order_id, complaint }
flipdeskEbayRoutes.post("/evidence/preview", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { order_id?: unknown; complaint?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const orderId = String(body.order_id ?? "").trim();
  const complaint = String(body.complaint ?? "").trim();
  if (!orderId || !complaint) {
    return c.json({ error: "order_id and complaint are both required." }, 400);
  }

  const context = await planEvidence(ownerId, orderId, complaint);
  if (!context) {
    // No grade report, or nothing linking this order to a graded item. Said
    // plainly rather than dressed up as a verdict: there is no evidence here,
    // and the seller should know that before they plan around it.
    return c.json({ available: false });
  }

  return c.json({
    available: true,
    verdict: context.plan.verdict,
    reason: context.plan.reason,
    mayAutoAssemble: context.plan.mayAutoAssemble,
    citations: context.plan.citations,
    // US-2706 AC6: whether the published listing text is on file at all. The
    // surface labels a pack without one as the weaker case rather than showing
    // it as equivalent — it can only argue from the grade report.
    hasPublicationSnapshot: context.hasSnapshot,
    certificateNumber: context.stamp.certificateNumber,
    gradedAt: context.gradedAt,
    defectCount: context.defectCount,
    // A sheet is only composited for a CERTIFIED grade.
    includesConditionSheet: Boolean(context.stamp.certificateNumber),
  });
});

// US-2706: POST /returns/:returnId/evidence — attach the grade evidence to an
// item-not-as-described return.
//
// Multipart: one or more `file` parts (images). The seller has already reviewed
// the pack on the post-sale surface; this route sends it. There is no timer and
// no auto-submit, and there is no path here that fires without a request.
//
// TWO EBAY CALLS, and the second is what makes the evidence real. `file/upload`
// associates each image and returns a fileId; the files stay INERT until
// `file/submit` activates them. Reporting success after the uploads alone would
// tell a seller their evidence is on the case when eBay has not been shown it —
// the same silent-success shape as a photo attach that never landed.
//
// TENANT SCOPE (US-268): every eBay call runs under the OWNER's own token
// (`workspaceOwnerId ?? userId`), so a returnId belonging to another seller
// reaches eBay as this seller's return and comes back 404/403 — there is no
// query here that could read another tenant's row. The audit row is written
// against the same owner.
flipdeskEbayRoutes.post("/returns/:returnId/evidence", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const returnId = c.req.param("returnId");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data. Expected multipart/form-data." }, 400);
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  // US-2935: the sniff-then-strip pass is shared with the case and dispute
  // routes. It used to be copied per surface, and the copies had already
  // drifted on the file cap.
  const cleanResult = await cleanEvidenceFiles(files, MAX_RETURN_EVIDENCE_FILES);
  if (!cleanResult.ok) return c.json({ error: cleanResult.error }, cleanResult.status);
  const cleaned = cleanResult.files;

  // US-2706 + the epic's standing safety constraint (US-2703 AC5): REFUSE when
  // the grade report agrees with the buyer.
  //
  // The pack is assembled from the item's own grade report and the listing text
  // GradeThread published (US-2704). When the report documents a flaw the
  // listing did not disclose, sending this pack hands eBay a signed document
  // proving our own user sold an undisclosed flaw. That is not a weak case, it
  // is evidence for the other side, and the design says we do not send it.
  //
  // Best-effort in ONE direction only: if the report or the snapshot cannot be
  // loaded, the plan is not built and the send proceeds on the seller's own
  // judgement. A lookup failure must not silently become a refusal, and it must
  // never become an assembly either — which is why the refusal is keyed on a
  // verdict we actually computed rather than on the absence of one.
  const complaint = String(form.get("complaint") ?? "").trim();
  const orderId = String(form.get("order_id") ?? "").trim();
  let context: EvidenceContext | null = null;
  if (complaint && orderId) {
    context = await planEvidence(ownerId, orderId, complaint);
    const refusal = evidenceRefusalFor(context?.plan);
    if (refusal) return c.json({ error: "refused", ...refusal }, 409);
  }

  // US-2706 AC3: the sheet goes FIRST, so the reviewer opening the pack reads
  // what this is before they look at a close-up of a cuff. It is composited
  // here rather than uploaded by the client because the certificate number and
  // the grade date must come from the report, not from a form field a browser
  // could be persuaded to change.
  //
  // Only when the grade is CERTIFIED: an uncertified report has no number to
  // print, and a sheet whose certificate line reads "Not certified" argues
  // against the seller on the one asset that exists to argue for them.
  if (context?.stamp.certificateNumber) {
    try {
      cleaned.unshift({
        bytes: await compositeReturnEvidenceSheet(
          context.stamp,
          context.defectCount,
          context.gradedAt,
        ),
        filename: "condition-report.jpg",
        contentType: "image/jpeg",
      });
    } catch (err) {
      // The photographs are still the evidence. A failed sheet costs the pack
      // its cover page, not its argument.
      console.error(
        "[ebay.returns.evidence] sheet render failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const fileIds: string[] = [];
  try {
    for (const file of cleaned) {
      fileIds.push(
        await uploadReturnFile(ownerId, returnId, {
          bytes: file.bytes,
          filename: file.filename,
          purpose: "ITEM_RELATED",
        }),
      );
    }
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the evidence upload.", err, "ebay.returns.evidence.upload");
  }

  let removedFileIds: string[] = [];
  try {
    // Submit activates by PURPOSE, not by id, so the whole pack goes up first
    // and this runs once. A partial batch cannot be activated selectively.
    ({ removedFileIds } = await submitReturnFiles(ownerId, returnId, "ITEM_RELATED"));
  } catch (err) {
    return failSafe(c, 502, "eBay accepted the files but would not activate them.", err, "ebay.returns.evidence.submit");
  }

  await writeAuditLog(c, {
    action: "ebay.return.evidence",
    targetType: "ebay_return",
    targetId: returnId,
    details: { files: fileIds.length, removed: removedFileIds.length },
  });

  // `removed` is reported rather than swallowed: eBay accepted the upload and
  // then dropped the file at activation, so the pack on the case is smaller
  // than the one the seller reviewed. Saying "sent" over that is the lie this
  // route is here to avoid.
  return c.json({
    ok: true,
    attached: fileIds.length - removedFileIds.length,
    removed: removedFileIds.length,
  });
});

// US-1978 (AC3): POST /orders/:orderId/refund — a PROACTIVE or PARTIAL refund,
// outside any return case.
//
// body { reason, comment?, amount?: { currency, value }, line_items?: [{ line_item_id, currency, value }] }
//
// Distinct from /returns/:returnId/refund, which only exists once a buyer has
// opened a return and the seller approved it. Until now a seller who just wanted
// to make it right ("there's a mark I missed — keep it, here's $10 back") had to
// push the buyer into opening a return first: worse for both sides, and it drags
// the seller's return metrics.
//
// TENANT ISOLATION (US-268). orderId is attacker-controlled input, and this route
// MOVES MONEY, so eBay's own token scoping is not leaned on as the only check. We
// prove locally that a sales row for this order belongs to THIS tenant before
// calling eBay. Without that, the failure mode is a workspace member (or anyone
// who can reach the route) issuing refunds against an order id they guessed, and
// the only thing standing in the way would be eBay's 404 — i.e. an external
// system's behaviour, not our access control.
flipdeskEbayRoutes.post("/orders/:orderId/refund", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const orderId = c.req.param("orderId");

  let body: {
    reason?: unknown;
    comment?: unknown;
    amount?: unknown;
    line_items?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  // Ownership FIRST — before any eBay call, and before any parsing that could
  // leak the order's existence through a differently-shaped error.
  // PostgREST returns an embed as an object for a to-one relationship and an
  // array for a to-many, and which one you get depends on how it reads the FK.
  // Handling both is cheaper than being wrong about it in a route that a seller
  // only reaches while trying to refund somebody.
  const saleConnectionId = (row: unknown): string | undefined => {
    const l = (row as { listings?: unknown } | null)?.listings;
    const one = Array.isArray(l) ? l[0] : l;
    const id = (one as { marketplace_connection_id?: string | null } | null)
      ?.marketplace_connection_id;
    return id ?? undefined;
  };

  // US-2804: `sales` has NO marketplace_connection_id column — it lives on
  // `listings` (00338), and sales reaches it through listing_id. Selecting it
  // directly answered 42703, so this ownership check errored on every call and
  // the refund route returned 500 to every seller who tried it.
  //
  // It fails CLOSED, which is the one piece of luck here: the check errored
  // rather than passing, so no foreign order was ever reachable. The route was
  // dead, not open.
  const { data: sale, error: saleErr } = await supabaseAdmin
    .from("sales")
    .select("id, listings(marketplace_connection_id)")
    .eq("user_id", ownerId)
    .eq("platform_order_id", orderId)
    .maybeSingle();
  if (saleErr) {
    console.error("[ebay.orders.refund] sale lookup failed:", saleErr.message);
    return c.json({ error: "Couldn't look up that order." }, 500);
  }
  if (!sale) {
    // Deliberately the same 404 a nonexistent order gets: a foreign order must not
    // be distinguishable from one that isn't there.
    return c.json({ error: "Order not found." }, 404);
  }

  const reason = typeof body.reason === "string" && body.reason ? body.reason : "";
  if (!reason) {
    return c.json(
      { error: "A refund reason is required (e.g. SELLER_CANCEL, ITEM_NOT_AS_DESCRIBED, OTHER_CAUSE)." },
      400,
    );
  }

  const input: IssueRefundInput = { reasonForRefund: reason };
  if (typeof body.comment === "string" && body.comment) input.comment = body.comment;

  const amount = parseRefundAmount(body.amount);
  const lineItems = parseRefundLineItems(body.line_items);
  // eBay treats order-level and line-item refunds as different requests and
  // rejects both together. Refuse explicitly rather than silently dropping one —
  // guessing which the seller meant is not a call code should make about money.
  if (amount && lineItems) {
    return c.json(
      { error: "Refund either the whole order (amount) or specific line items — not both." },
      400,
    );
  }
  if (!amount && !lineItems) {
    return c.json(
      { error: "Provide a refund amount, or the line items to refund." },
      400,
    );
  }
  if (amount) input.orderLevelRefundAmount = amount;
  if (lineItems) input.refundItems = lineItems;

  let result: IssueRefundResult;
  try {
    result = await issueOrderRefund(
      ownerId,
      orderId,
      input,
      // Through the embed, since the column is on `listings`. A sale with no
      // linked listing yields undefined, which is the same fallback the old
      // (never-reached) expression had: use the default connection.
      saleConnectionId(sale),
    );
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the refund.", err, "ebay.orders.refund");
  }

  await writeAuditLog(c, {
    action: "ebay.order.refund",
    targetType: "ebay_order",
    targetId: orderId,
    details: {
      reason,
      // Log WHAT moved — a refund is the kind of action someone reconstructs later.
      order_level_amount: amount ? `${amount.value} ${amount.currency}` : null,
      line_item_count: lineItems ? lineItems.length : 0,
      refund_id: result.refundId ?? null,
    },
  });

  return c.json({
    ok: true,
    refund_id: result.refundId ?? null,
    refund_status: result.refundStatus ?? null,
  });
});

// Parse an order-level refund amount. Returns null when absent; a malformed
// amount is null too, which the caller turns into a 400 rather than guessing.
function parseRefundAmount(raw: unknown): RefundAmount | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { currency?: unknown; value?: unknown };
  const currency = typeof o.currency === "string" ? o.currency.trim().toUpperCase() : "";
  const value = typeof o.value === "string" ? o.value.trim() : "";
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  // eBay wants a plain decimal string. Reject anything else outright — a refund is
  // not the place to be permissive about what a number looks like.
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  if (Number(value) <= 0) return null;
  return { currency, value };
}

function parseRefundLineItems(
  raw: unknown,
): Array<{ lineItemId: string; refundAmount: RefundAmount }> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<{ lineItemId: string; refundAmount: RefundAmount }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as { line_item_id?: unknown };
    const lineItemId = typeof e.line_item_id === "string" ? e.line_item_id.trim() : "";
    if (!lineItemId) return null;
    const refundAmount = parseRefundAmount(entry);
    if (!refundAmount) return null;
    out.push({ lineItemId, refundAmount });
  }
  return out;
}

// US-1979 (AC3): seller program opt-in — GET /programs, POST /programs/:program,
// DELETE /programs/:program.
//
// The one that matters is OUT_OF_STOCK_CONTROL. eBay ENDS a multi-quantity listing
// the instant quantity hits 0; for evergreen clothing (the same tee in eight sizes,
// restocked continuously) that costs the item id, the watchers, the search standing
// and the sales history, and the seller relists from scratch. Opted in, the listing
// stays live at qty 0 and keeps all of it.
//
// It stays an explicit OPT-IN and this route never decides for the seller: for a
// single-quantity thrift item — most of FlipDesk — eBay's default is CORRECT, and
// a blanket opt-in would leave sold-out one-offs sitting live.
//
// These act on the seller's OWN eBay account via their own token, so there is no
// multi-tenant table to scope; the tenant IS the token (ownerId resolves the
// connection inside fetchAuthed). The access control that matters here is the
// authMiddleware whitelist entry in main.ts (US-1623) — without it the route 401s
// every signed-in seller.
const SELLER_PROGRAMS: Record<string, EbaySellerProgram> = {
  "out-of-stock": "OUT_OF_STOCK_CONTROL",
  "selling-policy-management": "SELLING_POLICY_MANAGEMENT",
};

flipdeskEbayRoutes.get("/programs", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const programs = await getOptedInPrograms(ownerId);
    return c.json({
      programs,
      out_of_stock: programs.includes("OUT_OF_STOCK_CONTROL"),
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't read your eBay programs.", err, "ebay.programs.get");
  }
});

flipdeskEbayRoutes.post("/programs/:program", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const program = SELLER_PROGRAMS[c.req.param("program")];
  if (!program) return c.json({ error: "Unknown eBay program." }, 400);
  try {
    await optInToProgram(ownerId, program);
  } catch (err) {
    // Already opted in = already in the state they asked for = success.
    if (!isAlreadyInProgramStateError(err)) {
      return failSafe(c, 502, "eBay rejected the opt-in.", err, "ebay.programs.opt_in");
    }
  }
  await writeAuditLog(c, {
    action: "ebay.program.opt_in",
    targetType: "ebay_program",
    targetId: program,
    details: {},
  });
  return c.json({ ok: true, program, opted_in: true });
});

flipdeskEbayRoutes.delete("/programs/:program", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const program = SELLER_PROGRAMS[c.req.param("program")];
  if (!program) return c.json({ error: "Unknown eBay program." }, 400);
  try {
    await optOutOfProgram(ownerId, program);
  } catch (err) {
    if (!isAlreadyInProgramStateError(err)) {
      return failSafe(c, 502, "eBay rejected the opt-out.", err, "ebay.programs.opt_out");
    }
  }
  await writeAuditLog(c, {
    action: "ebay.program.opt_out",
    targetType: "ebay_program",
    targetId: program,
    details: {},
  });
  return c.json({ ok: true, program, opted_in: false });
});

// US-1978 (AC2): DELETE /offers/:offerId — remove a STALE UNPUBLISHED offer.
//
// Abandoned drafts leave offer records behind on eBay. They are invisible to the
// seller, they block SKU reuse, and there was no way to clear them.
//
// THE GUARD IS THE STORY. deleteOffer is not withdrawOffer: withdraw ends a live
// listing and keeps the offer; DELETE destroys the record, and on a PUBLISHED
// offer eBay ends the live listing as a side effect. So a careless delete silently
// takes down a listing the seller is actively selling — with no undo and no
// "ended" reconciliation locally, which is strictly worse than the US-1506 oversell
// case (there the row was wrong; here the listing is gone).
//
// Hence: we ask eBay for the offer's CURRENT state and refuse if it is live. We do
// not trust our own listings row for this — it can be stale (that is the entire
// premise of the sync path), and "our DB thinks it's unpublished" is not evidence
// about what is live on eBay right now.
flipdeskEbayRoutes.delete("/offers/:offerId", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const offerId = c.req.param("offerId");

  // US-268: offerId is attacker-controlled. Prove this tenant owns the listing
  // carrying it before touching eBay; a foreign offer gets the same 404 as one
  // that doesn't exist.
  const { data: listing, error: lErr } = await supabaseAdmin
    .from("listings")
    .select("id, marketplace_connection_id, listing_status")
    .eq("user_id", ownerId)
    .eq("platform_offer_id", offerId)
    .maybeSingle();
  if (lErr) {
    console.error("[ebay.offers.delete] listing lookup failed:", lErr.message);
    return c.json({ error: "Couldn't look up that offer." }, 500);
  }
  if (!listing) return c.json({ error: "Offer not found." }, 404);

  const connectionId = listing.marketplace_connection_id ?? undefined;

  // Liveness check against eBay itself, not our row.
  let live = false;
  try {
    const remote = await getOffer(ownerId, offerId, connectionId);
    live = Boolean(remote?.listingId);
  } catch (err) {
    if (isAlreadyDeletedError(err)) {
      // Already gone on eBay — the desired end state. Reconcile, don't error.
      return c.json({ ok: true, already_gone: true });
    }
    return failSafe(c, 502, "Couldn't read that offer from eBay.", err, "ebay.offers.delete.read");
  }
  if (live) {
    return c.json(
      {
        error:
          "That offer is a LIVE listing. Deleting it would take the listing down " +
          "with no way back. End the listing first, then delete the offer.",
      },
      409,
    );
  }

  try {
    await deleteOffer(ownerId, offerId, connectionId);
  } catch (err) {
    if (!isAlreadyDeletedError(err)) {
      return failSafe(c, 502, "eBay rejected the offer delete.", err, "ebay.offers.delete");
    }
  }

  await writeAuditLog(c, {
    action: "ebay.offer.delete",
    targetType: "ebay_offer",
    targetId: offerId,
    details: { listing_id: listing.id, listing_status: listing.listing_status },
  });
  return c.json({ ok: true });
});

// US-1978 (AC2): DELETE /inventory-items/:sku — remove a STALE UNPUBLISHED SKU.
//
// Same hazard, one level up: an inventory item with a live offer must never be
// deleted. eBay's own behaviour here is not something to rely on (it may refuse,
// it may cascade), so we check for ANY live offer on the SKU and refuse first.
flipdeskEbayRoutes.delete("/inventory-items/:sku", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const sku = c.req.param("sku");

  // US-268: the SKU is attacker-controlled. It must belong to one of THIS tenant's
  // inventory items.
  const { data: item, error: iErr } = await supabaseAdmin
    .from("inventory_items")
    .select("id")
    .eq("user_id", ownerId)
    .eq("sku", sku)
    .maybeSingle();
  if (iErr) {
    console.error("[ebay.items.delete] item lookup failed:", iErr.message);
    return c.json({ error: "Couldn't look up that SKU." }, 500);
  }
  if (!item) return c.json({ error: "SKU not found." }, 404);

  let offers: Awaited<ReturnType<typeof listOffersForSku>>;
  try {
    offers = await listOffersForSku(ownerId, sku);
  } catch (err) {
    if (isAlreadyDeletedError(err)) {
      return c.json({ ok: true, already_gone: true });
    }
    return failSafe(c, 502, "Couldn't read that SKU's offers from eBay.", err, "ebay.items.delete.read");
  }

  const liveOffers = offers.filter((o) => o.listingId);
  if (liveOffers.length > 0) {
    return c.json(
      {
        error:
          `That SKU still has ${liveOffers.length} live listing(s) on eBay. ` +
          "End them first — deleting the SKU now would take them down with no way back.",
        live_listing_ids: liveOffers.map((o) => o.listingId),
      },
      409,
    );
  }

  // Unpublished offers must go before the SKU can — eBay rejects a delete on a SKU
  // that still has offers attached. Every one of these is proven non-live above.
  for (const offer of offers) {
    try {
      await deleteOffer(ownerId, offer.offerId);
    } catch (err) {
      if (!isAlreadyDeletedError(err)) {
        return failSafe(
          c, 502,
          "Couldn't clear that SKU's stale offers.", err, "ebay.items.delete.offers",
        );
      }
    }
  }

  try {
    await deleteInventoryItem(ownerId, sku);
  } catch (err) {
    if (!isAlreadyDeletedError(err)) {
      return failSafe(c, 502, "eBay rejected the SKU delete.", err, "ebay.items.delete");
    }
  }

  await writeAuditLog(c, {
    action: "ebay.inventory_item.delete",
    targetType: "ebay_sku",
    targetId: sku,
    details: { item_id: item.id, stale_offers_removed: offers.length },
  });
  return c.json({ ok: true, stale_offers_removed: offers.length });
});

// GET /cancellations — open cancellation requests for the seller.
flipdeskEbayRoutes.get("/cancellations", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const cached = await loadCachedSummaries<CancellationSummary>(ownerId, "cancellation", {
    limit,
  });
  if (cached.fresh) return c.json({ cancellations: cached.items, source: "cache" });
  try {
    const live = await searchCancellations(ownerId, { limit });
    const nowIso = new Date().toISOString();
    await recordPostSaleCases(ownerId, live.map((x) => cancellationToCaseInput(x, nowIso)));
    return c.json({ cancellations: live, source: "ebay" });
  } catch (err) {
    if (cached.items.length > 0) {
      return c.json({ cancellations: cached.items, source: "cache_stale" });
    }
    return failSafe(c, 502, "Couldn't load eBay cancellations.", err, "ebay.cancellations.list");
  }
});

// POST /cancellations/:cancelId/approve — body { order_id? }
flipdeskEbayRoutes.post("/cancellations/:cancelId/approve", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const cancelId = c.req.param("cancelId");
  let body: { order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await approveCancellation(ownerId, cancelId);
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the cancellation approval.", err, "ebay.cancel.approve");
    }
  }
  await applyOutcomeToSale(ownerId, body.order_id, "cancel_approved");
  await markPostSaleCaseClosed(ownerId, "cancellation", cancelId, "approved");
  await writeAuditLog(c, {
    action: "ebay.cancellation.approve",
    targetType: "ebay_cancellation",
    targetId: cancelId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// POST /cancellations/:cancelId/reject — body { order_id? }
flipdeskEbayRoutes.post("/cancellations/:cancelId/reject", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const cancelId = c.req.param("cancelId");
  let body: { order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await rejectCancellation(ownerId, cancelId);
  } catch (err) {
    if (!isAlreadyResolved(err)) {
      return failSafe(c, 502, "eBay rejected the cancellation rejection.", err, "ebay.cancel.reject");
    }
  }
  await markPostSaleCaseClosed(ownerId, "cancellation", cancelId, "rejected");
  await writeAuditLog(c, {
    action: "ebay.cancellation.reject",
    targetType: "ebay_cancellation",
    targetId: cancelId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

// ── Leave buyer feedback (US-1047, Trading API) ─────────────────────
// POST /feedback — body { buyer_username, comment?, order_line_item_id? OR
// item_id+transaction_id }. Sellers may only leave POSITIVE feedback for buyers.
// Idempotent: eBay rejects a duplicate, which we report as already_left rather
// than an error. Inherently tenant-scoped (the owner's token can only leave
// feedback on the owner's own transactions).
flipdeskEbayRoutes.post("/feedback", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    buyer_username?: unknown;
    comment?: unknown;
    item_id?: unknown;
    transaction_id?: unknown;
    order_line_item_id?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const bodyOrderId = typeof (body as { order_id?: unknown }).order_id === "string"
    ? ((body as { order_id?: string }).order_id as string)
    : undefined;
  const explicitUser = String(body.buyer_username ?? "").trim();
  const itemId = typeof body.item_id === "string" ? body.item_id : undefined;
  const transactionId = typeof body.transaction_id === "string"
    ? body.transaction_id
    : undefined;
  const orderLineItemId = typeof body.order_line_item_id === "string"
    ? body.order_line_item_id
    : undefined;
  const comment = typeof body.comment === "string" && body.comment.trim()
    ? body.comment.trim()
    : "Great buyer — fast payment, smooth transaction. Thank you!";

  // Build the list of transactions to leave feedback for. Either the caller
  // passed explicit legacy ids, or we resolve them from the order id via the
  // Trading GetOrders bridge (the modern lineItemId we store isn't a legacy id).
  type Target = { itemId?: string; transactionId?: string; orderLineItemId?: string; user: string };
  let targets: Target[] = [];
  if (orderLineItemId && explicitUser) {
    targets = [{ orderLineItemId, user: explicitUser }];
  } else if (itemId && transactionId && explicitUser) {
    targets = [{ itemId, transactionId, user: explicitUser }];
  } else if (bodyOrderId) {
    try {
      const lineItems = await getOrderLegacyLineItems(userId, bodyOrderId);
      targets = lineItems
        .filter((li) => li.buyerUsername || explicitUser)
        .map((li) => ({
          itemId: li.itemId,
          transactionId: li.transactionId,
          user: li.buyerUsername ?? explicitUser,
        }));
    } catch (err) {
      return failSafe(c, 502, "Couldn't resolve the order for feedback.", err, "ebay.feedback.resolve");
    }
    if (targets.length === 0) {
      return c.json({ error: "No completed transactions found for that order." }, 404);
    }
  } else {
    return c.json(
      { error: "Provide order_id, or buyer_username + (order_line_item_id OR item_id + transaction_id)." },
      400,
    );
  }

  try {
    let alreadyLeftAll = true;
    for (const t of targets) {
      const { alreadyLeft } = await leaveFeedback(userId, {
        itemId: t.itemId,
        transactionId: t.transactionId,
        orderLineItemId: t.orderLineItemId,
        targetUser: t.user,
        comment,
      });
      if (!alreadyLeft) alreadyLeftAll = false;
    }
    await writeAuditLog(c, {
      action: "ebay.feedback.leave",
      targetType: "ebay_feedback",
      targetId: bodyOrderId ?? orderLineItemId ?? `${itemId}:${transactionId}`,
      details: { count: targets.length, already_left: alreadyLeftAll },
    });
    return c.json({ ok: true, count: targets.length, already_left: alreadyLeftAll });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the feedback.", err, "ebay.feedback");
  }
});

// US-1047: scheduled auto-leave positive feedback on recently-completed orders.
// Gated by system_settings "feedback.auto_leave" (default off). Idempotent via an
// admin_audit_log marker per order (shared with manual leaves so neither repeats).
flipdeskEbayRoutes.post("/jobs/leave-feedback", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!(await getSetting<boolean>("feedback.auto_leave", false))) {
    return c.json({ skipped: true, reason: "disabled" });
  }
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const lock = await acquireJobLock("leave-feedback", 240);
  if (!lock.acquired) {
    return c.json({ skipped: true, reason: lock.reason });
  }
  try {
    const { data: conns } = await supabaseAdmin
      .from("marketplace_connections")
      .select("user_id")
      .eq("marketplace", "ebay")
      .eq("is_active", true)
      // US-2387: bounded, ordered so the swept set is stable run to run. This
      // job fans out per owner, so an unordered cap would sweep a different
      // arbitrary subset each tick and a seller could go unswept indefinitely.
      .order("user_id", { ascending: true })
      .limit(EBAY_CONNECTION_SCAN_CAP);
    const ownerIds = Array.from(
      new Set(((conns ?? []) as { user_id: string }[]).map((r) => r.user_id)),
    );
    // Leave a 2-day grace (payment settles) and look back 30 days.
    const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const windowEnd = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const PER_OWNER = 50;
    let left = 0;
    let skipped = 0;
    let errors = 0;

    for (const ownerId of ownerIds) {
      const { data: saleRows } = await supabaseAdmin
        .from("sales")
        .select("platform_order_id")
        .eq("user_id", ownerId)
        .eq("status", "completed")
        .not("platform_order_id", "is", null)
        .gte("sold_at", windowStart)
        .lte("sold_at", windowEnd)
        .limit(PER_OWNER);
      const orderIds = Array.from(
        new Set(
          ((saleRows ?? []) as { platform_order_id: string }[]).map(
            (r) => r.platform_order_id,
          ),
        ),
      );
      for (const orderId of orderIds) {
        // Idempotency: skip if feedback was already left for this order.
        const { data: prior } = await supabaseAdmin
          .from("admin_audit_log")
          .select("id")
          .eq("action", "ebay.feedback.leave")
          .eq("target_id", orderId)
          .limit(1)
          .maybeSingle();
        if (prior) {
          skipped += 1;
          continue;
        }
        try {
          const lineItems = await getOrderLegacyLineItems(ownerId, orderId);
          for (const li of lineItems) {
            if (!li.buyerUsername) continue;
            await leaveFeedback(ownerId, {
              itemId: li.itemId,
              transactionId: li.transactionId,
              targetUser: li.buyerUsername,
              comment: "Great buyer — fast payment, smooth transaction. Thank you!",
            });
          }
          await writeSystemAuditLog({
            action: "ebay.feedback.leave",
            targetType: "ebay_feedback",
            targetId: orderId,
            details: { auto: true, count: lineItems.length },
          });
          left += 1;
        } catch (err) {
          errors += 1;
          console.error(
            "[ebay.jobs.leave-feedback]",
            orderId,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    return c.json({ ok: true, owners: ownerIds.length, left, skipped, errors });
  } finally {
    await lock.release();
  }
});

// ── Payment disputes (US-1049, Fulfillment Payment Disputes API) ────
// Buyer-opened cases / chargebacks escalated to eBay. Seller must accept
// (refund) or contest before respondByDate. Listing is inherently tenant-scoped
// to the owner's token; accept best-effort marks the local sale refunded.

flipdeskEbayRoutes.get("/payment-disputes", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const status = c.req.query("status")?.trim() || undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  // A status filter is a different question from "all open disputes", and the
  // cache stores one set. Only the unfiltered call is served from it.
  const cached = status
    ? { items: [] as PaymentDisputeSummary[], fresh: false }
    : await loadCachedSummaries<PaymentDisputeSummary>(ownerId, "payment_dispute", { limit });
  if (cached.fresh) return c.json({ disputes: cached.items, source: "cache" });
  try {
    const live = await searchPaymentDisputes(ownerId, { status, limit });
    if (!status) {
      const nowIso = new Date().toISOString();
      await recordPostSaleCases(ownerId, live.map((d) => disputeToCaseInput(d, nowIso)));
    }
    return c.json({ disputes: live, source: "ebay" });
  } catch (err) {
    if (cached.items.length > 0) {
      return c.json({ disputes: cached.items, source: "cache_stale" });
    }
    return failSafe(c, 502, "Couldn't load eBay payment disputes.", err, "ebay.disputes.list");
  }
});

flipdeskEbayRoutes.get("/payment-disputes/:id", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json({ dispute: await getPaymentDispute(ownerId, c.req.param("id")) });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load the payment dispute.", err, "ebay.disputes.get");
  }
});

flipdeskEbayRoutes.post("/payment-disputes/:id/accept", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const disputeId = c.req.param("id");
  let body: { order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  // Idempotent: if the dispute is already resolved, don't re-POST to eBay.
  try {
    const detail = await getPaymentDispute(ownerId, disputeId);
    if (!isDisputeActionable(detail.status)) {
      await writeAuditLog(c, {
        action: "ebay.dispute.accept",
        targetType: "ebay_payment_dispute",
        targetId: disputeId,
        details: { already_resolved: true, status: detail.status },
      });
      return c.json({ ok: true, alreadyResolved: true });
    }
  } catch (err) {
    // Couldn't read the dispute — fall through and let the action attempt.
    console.warn(
      "[ebay.disputes.accept] status pre-check failed:",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    await acceptPaymentDispute(ownerId, disputeId);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected accepting the dispute.", err, "ebay.disputes.accept");
  }
  const status = disputeOutcomeToSaleStatus("accepted");
  if (status && typeof body.order_id === "string" && body.order_id) {
    const { error } = await supabaseAdmin
      .from("sales")
      .update({ status, cancelled_at: new Date().toISOString() } as never)
      .eq("user_id", ownerId)
      .eq("platform_order_id", body.order_id);
    if (error) console.error("[ebay.disputes.accept] sale update:", error.message);
  }
  await markPostSaleCaseClosed(ownerId, "payment_dispute", disputeId, "accepted");
  await writeAuditLog(c, {
    action: "ebay.dispute.accept",
    targetType: "ebay_payment_dispute",
    targetId: disputeId,
    details: { order_id: body.order_id ?? null },
  });
  return c.json({ ok: true });
});

flipdeskEbayRoutes.post("/payment-disputes/:id/contest", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const disputeId = c.req.param("id");
  let body: { note?: unknown; order_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const note = typeof body.note === "string" ? body.note : undefined;
  // Idempotent: skip the eBay POST if the dispute is already resolved.
  try {
    const detail = await getPaymentDispute(ownerId, disputeId);
    if (!isDisputeActionable(detail.status)) {
      await writeAuditLog(c, {
        action: "ebay.dispute.contest",
        targetType: "ebay_payment_dispute",
        targetId: disputeId,
        details: { already_resolved: true, status: detail.status },
      });
      return c.json({ ok: true, alreadyResolved: true });
    }
  } catch (err) {
    console.warn(
      "[ebay.disputes.contest] status pre-check failed:",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    await contestPaymentDispute(ownerId, disputeId, note);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected contesting the dispute.", err, "ebay.disputes.contest");
  }
  await writeAuditLog(c, {
    action: "ebay.dispute.contest",
    targetType: "ebay_payment_dispute",
    targetId: disputeId,
    details: { order_id: body.order_id ?? null, has_note: !!note },
  });
  return c.json({ ok: true });
});

// Dispute activity timeline (read-only). Tenant-scoped via the owner's token.
flipdeskEbayRoutes.get("/payment-disputes/:id/activity", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json({
      activity: await getPaymentDisputeActivity(ownerId, c.req.param("id")),
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load the dispute activity.", err, "ebay.disputes.activity");
  }
});

// Upload a supporting-evidence image and attach it to the dispute. Multipart:
// field `file` (image) + optional `evidence_type`. The line items + default
// evidence type are derived from the live dispute (eBay requires lineItems on
// add_evidence). Tenant-scoped: the dispute is read/written with the owner's
// own eBay token, so there is no cross-tenant surface.
flipdeskEbayRoutes.post("/payment-disputes/:id/evidence", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const disputeId = c.req.param("id");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data. Expected multipart/form-data." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ error: "Missing evidence file." }, 400);
  }

  const rawBytes = new Uint8Array(await file.arrayBuffer());
  // Sniff the magic bytes (don't trust the client MIME) and strip EXIF/GPS
  // before forwarding the buyer-facing image to eBay.
  const verdict = validateImageUpload(rawBytes, { allow: ["jpeg", "png"] });
  if (!verdict.ok) {
    return c.json({ error: `Invalid image: ${verdict.reason}` }, 400);
  }
  const { bytes: cleanBytes } = stripImageMetadata(rawBytes, verdict.format);

  // US-2707: FROM-PACK MODE. Present only when the caller sends order_id and
  // complaint; without them this route behaves exactly as it did — one file,
  // uploaded, attached. The rarer path must not be the one where the safety
  // rule is missing, so the SAME refusal applies here as on returns: when the
  // grade report documents a flaw the listing did not disclose, we do not hand
  // eBay a signed document proving our own user sold it undisclosed.
  const packOrderId = String(form.get("order_id") ?? "").trim();
  const packComplaint = String(form.get("complaint") ?? "").trim();
  let packContext: EvidenceContext | null = null;
  if (packOrderId && packComplaint) {
    packContext = await planEvidence(ownerId, packOrderId, packComplaint);
    // US-2935: the same arbiter the return and case routes use. Three surfaces,
    // one rule about whether to send at all.
    const refusal = evidenceRefusalFor(packContext?.plan);
    if (refusal) return c.json({ error: "refused", ...refusal }, 409);
  }

  let detail: PaymentDisputeDetail;
  try {
    detail = await getPaymentDispute(ownerId, disputeId);
  } catch (err) {
    return failSafe(c, 502, "Couldn't load the payment dispute.", err, "ebay.disputes.evidence.detail");
  }
  const request0 = detail.evidenceRequests[0];
  const evidenceType = (form.get("evidence_type") as string | null)?.trim() ||
    request0?.requestType || "PROOF_OF_DELIVERY";
  const lineItems = request0?.lineItems.length
    ? request0.lineItems
    : detail.lineItems;
  if (lineItems.length === 0) {
    return c.json(
      { error: "eBay has no line items on this dispute to attach evidence to." },
      422,
    );
  }

  try {
    const fileIds: string[] = [];
    // US-2707 AC3: the condition sheet joins the pack, and the evidence TYPE is
    // still whatever the live dispute asked for. eBay requested a category of
    // proof; sending it under a type of our choosing is answering a different
    // question from the one it asked.
    //
    // Only for a CERTIFIED grade, same rule as the return path: a cover page
    // reading "Not certified" argues against the seller on the one asset that
    // exists to argue for them.
    if (packContext?.stamp.certificateNumber) {
      try {
        const sheet = await compositeReturnEvidenceSheet(
          packContext.stamp,
          packContext.defectCount,
          packContext.gradedAt,
        );
        fileIds.push(
          await uploadDisputeEvidenceFile(ownerId, disputeId, {
            bytes: sheet,
            filename: "condition-report.jpg",
            contentType: "image/jpeg",
          }),
        );
      } catch (err) {
        // The photograph is still the evidence.
        console.error(
          "[ebay.disputes.evidence] sheet render failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    fileIds.push(
      await uploadDisputeEvidenceFile(ownerId, disputeId, {
        bytes: cleanBytes,
        filename: file.name || `evidence.${verdict.ext}`,
        contentType: verdict.contentType,
      }),
    );
    const evidenceId = await addDisputeEvidence(ownerId, disputeId, {
      evidenceType,
      fileIds,
      lineItems,
    });
    await writeAuditLog(c, {
      action: "ebay.dispute.evidence",
      targetType: "ebay_payment_dispute",
      targetId: disputeId,
      details: {
        evidence_type: evidenceType,
        evidence_id: evidenceId,
        files: fileIds.length,
        from_pack: packContext !== null,
      },
    });
    return c.json({ ok: true, evidenceId, attached: fileIds.length });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the evidence upload.", err, "ebay.disputes.evidence");
  }
});

// ── Publish flow (Week 3) ──────────────────────────────────────────
//
// /listings/validate runs every pre-flight check WITHOUT touching eBay.
// /listings/push runs the same check, then:
//   1. createOrReplaceInventoryItem  (PUT, idempotent)
//   2. createOffer                   (POST, returns offerId)
//   3. publishOffer                  (POST, returns listingId)
// On success the listings + inventory_items rows are updated to reflect the
// live state. createOffer is idempotent on SKU via listOffersForSku fallback.

// ── Manage live listings (Week 4) ──────────────────────────────────
// Update price (POST .../:id/price body: { price }) and end (DELETE
// .../:id) — both look up platform_offer_id from the local listings row
// and call the Sell API. If the local row has no platform_offer_id (e.g.
// the user manually marked an item "listed" via MarkListedDialog), the
// route returns 409 and the UI falls back to local-only.

// US-2166: this path now DELEGATES to the shared lifecycle core rather than
// keeping its own copy. It stays mounted because shipped iOS, Android and
// browser-extension builds call it and cannot be redeployed — but a second
// implementation of a money-touching operation is how a fix lands in one and
// not the other, and these two had already drifted: the shared core reports
// honestly when the marketplace accepted a price our copy then failed to save,
// while this route used to ignore that write error entirely.
//
// Behaviour the delegation IMPROVES for callers of this path, all additive:
//   • the origin gate reads the row's real platform instead of a hardcoded
//     "ebay" (a Shopify row was being told eBay owns its price),
//   • a never-published draft records its price instead of 409-ing on a missing
//     offer id,
//   • a marketplace-accepted-but-locally-unsaved write is reported, not hidden.
// The success body gains `pushed` and keeps every field it had, so an older
// client that ignores the new key is unaffected.
flipdeskEbayRoutes.post("/listings/:id/price", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  let body: { price?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return c.json({ error: "price must be a positive number" }, 400);
  }

  const res = await applyListingPrice(userId, listingId, price);
  if (!res.ok) {
    return c.json(
      res.lockedFields
        ? { error: res.error, locked_fields: res.lockedFields }
        : { error: res.error },
      res.status,
    );
  }
  return c.json({
    ok: true,
    listing_id: listingId,
    price: res.price,
    pushed: res.pushed,
  });
});

// ── Bulk price / quantity update (US-1046 clean surface) ────────────
// POST /listings/bulk-price-quantity — body { updates: [{ listing_id, price?,
// quantity? }] }. Updates up to 25 offers per eBay call (chunked), tenant-scoped,
// per-item success/failure reported, local listings rows updated for successes.
flipdeskEbayRoutes.post("/listings/bulk-price-quantity", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  // Bulk multi-listing actions are a Pro+ feature (US-208).
  const gate = await requireFlipdesk(c, { feature: "bulkActions", userId });
  if (gate) return gate;
  let body: { updates?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const rawUpdates = Array.isArray(body.updates) ? body.updates : [];
  if (rawUpdates.length === 0) return c.json({ error: "updates required" }, 400);
  if (rawUpdates.length > 500) {
    return c.json({ error: "Too many updates (max 500)." }, 400);
  }

  // Normalize + validate. price>0, quantity>=0 integer; at least one present.
  const wanted = new Map<string, { price?: number; quantity?: number }>();
  for (const u of rawUpdates as Array<Record<string, unknown>>) {
    if (!u || typeof u.listing_id !== "string") continue;
    const priceNum = Number(u.price);
    const qtyNum = Number(u.quantity);
    const price = u.price != null && Number.isFinite(priceNum) && priceNum > 0
      ? priceNum
      : undefined;
    const quantity = u.quantity != null && Number.isInteger(qtyNum) && qtyNum >= 0
      ? qtyNum
      : undefined;
    if (price === undefined && quantity === undefined) continue;
    wanted.set(u.listing_id, { price, quantity });
  }
  const listingIds = [...wanted.keys()];
  if (listingIds.length === 0) return c.json({ error: "No valid updates." }, 400);

  // Load owned listings with their SKU + offer id (tenant-scoped, US-268).
  const { data: rows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_offer_id, inventory_item_id, inventory_sku, inventory_items!inner(user_id, sku)",
    )
    .in("id", listingIds)
    .eq("inventory_items.user_id", userId);
  const owned = (rows ?? []) as unknown as Array<{
    id: string;
    platform_offer_id: string | null;
    inventory_item_id: string | null;
    inventory_sku: string | null;
    inventory_items: { user_id: string; sku: string | null };
  }>;

  const results: Array<{ listing_id: string; ok: boolean; error?: string }> = [];
  const items: Array<
    PriceQtyUpdate & { listingId: string; itemId: string | null }
  > = [];
  for (const lid of listingIds) {
    const row = owned.find((r) => r.id === lid);
    const want = wanted.get(lid)!;
    if (!row) {
      results.push({ listing_id: lid, ok: false, error: "Listing not found" });
      continue;
    }
    const offerId = row.platform_offer_id;
    // US-1999: bulk reprice addresses the Inventory API by SKU, so it uses the
    // PINNED publish-time value; the item's current sku is only a pre-00477
    // fallback. Both being null still means "no eBay SKU" (a draft).
    const sku = row.inventory_sku ?? row.inventory_items.sku;
    if (!offerId || !sku) {
      results.push({ listing_id: lid, ok: false, error: "Listing has no eBay offer/SKU" });
      continue;
    }
    items.push({
      listingId: lid,
      itemId: row.inventory_item_id,
      sku,
      offerId,
      priceValue: want.price,
      quantity: want.quantity,
    });
  }

  for (const batch of chunk(items, EBAY_BULK_MAX)) {
    let entries: Array<Record<string, unknown>>;
    try {
      entries = await bulkUpdatePriceQuantity(
        userId,
        batch.map((b) => buildPriceQtyRequest(b)),
      ) as unknown as Array<Record<string, unknown>>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const b of batch) {
        results.push({ listing_id: b.listingId, ok: false, error: msg.slice(0, 200) });
      }
      continue;
    }
    batch.forEach((b, i) => {
      const norm = normalizeBulkEntry({ offerId: b.offerId, ...(entries[i] ?? {}) }, b.offerId);
      results.push(
        norm.ok
          ? { listing_id: b.listingId, ok: true }
          : { listing_id: b.listingId, ok: false, error: norm.error },
      );
    });
  }

  // Persist local rows for the successes.
  const okIds = new Set(results.filter((r) => r.ok).map((r) => r.listing_id));
  for (const b of items) {
    if (!okIds.has(b.listingId)) continue;
    const patch: Record<string, unknown> = {};
    if (b.priceValue != null) patch.listing_price = b.priceValue;
    if (b.quantity != null) patch.quantity = b.quantity;
    if (Object.keys(patch).length > 0) {
      await supabaseAdmin.from("listings").update(patch as never).eq("id", b.listingId);
    }
    // US-1504: mirror a successful reprice onto the item's target_price so the
    // canvas "not pushed to eBay" badge stays truthful (see the single-price
    // handler). Only when the price actually changed.
    if (b.priceValue != null && b.itemId) {
      await supabaseAdmin
        .from("inventory_items")
        .update({ target_price: b.priceValue })
        .eq("id", b.itemId)
        .eq("user_id", userId);
    }
  }

  await writeAuditLog(c, {
    action: "ebay.bulk_price_quantity",
    targetType: "listings",
    details: { requested: listingIds.length, succeeded: okIds.size },
  });
  return c.json({ ok: true, results, succeeded: okIds.size, total: results.length });
});

// ── Bulk-edit live listings (US-1292) ───────────────────────────────
// US-2166 (AC5): the handler MOVED to routes/flipdesk-listings.ts. It was
// always adapter-driven and never eBay-specific — only its mount point was
// wrong, which is exactly what the story called out. This path stays registered
// because shipped iOS, Android and browser-extension builds call it and cannot
// be redeployed; it forwards rather than keeping a second copy.
flipdeskEbayRoutes.post("/listings/bulk-edit", (c) => bulkEditListingsHandler(c));


// ── Markdown / Sale events (US-1045) ────────────────────────────────
// POST /listings/:id/sale — start an eBay markdown Sale (strike-through price +
// watcher notification) instead of a silent price revise. DELETE ends it and
// restores the original price (markdown is an overlay). The promotion id is
// stored in listings.platform_fields so we can end/reconcile it later.

flipdeskEbayRoutes.post("/listings/:id/sale", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  let body: { percent_off?: unknown; end_date?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const percentOff = Number(body.percent_off);
  if (!Number.isFinite(percentOff) || percentOff <= 0) {
    return c.json({ error: "percent_off must be a positive number" }, 400);
  }
  const endDate = typeof body.end_date === "string" ? body.end_date : undefined;

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);
  if (!row.listing.platform_listing_id) {
    return c.json(
      { error: "This listing has no eBay listing id. Sync or republish first." },
      409,
    );
  }

  // If a Sale already exists on this listing, update it in place (PUT) so we
  // don't orphan the old promotion on eBay and watchers keep the same Sale;
  // otherwise create a fresh one.
  const { data: cur } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  const existingPf =
    ((cur as { platform_fields?: Record<string, unknown> } | null)
      ?.platform_fields) ?? {};
  const existingPromotionId =
    typeof existingPf.markdown_promotion_id === "string"
      ? existingPf.markdown_promotion_id
      : null;

  let promotionId: string | null;
  try {
    if (existingPromotionId) {
      await updateMarkdownSale(userId, existingPromotionId, {
        ebayListingId: row.listing.platform_listing_id,
        percentOff,
        endDate,
      });
      promotionId = existingPromotionId;
    } else {
      promotionId = await createMarkdownSale(userId, {
        ebayListingId: row.listing.platform_listing_id,
        percentOff,
        endDate,
      });
    }
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the Sale event.", err, "ebay.markdown.create");
  }

  const pf = {
    ...existingPf,
    markdown_promotion_id: promotionId,
    markdown_pct: clampMarkdownPct(percentOff),
  };
  await supabaseAdmin
    .from("listings")
    .update({ platform_fields: pf } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: existingPromotionId ? "ebay.markdown.update" : "ebay.markdown.start",
    targetType: "listing",
    targetId: listingId,
    details: { promotion_id: promotionId, percent_off: percentOff },
  });
  return c.json({
    ok: true,
    listing_id: listingId,
    promotion_id: promotionId,
    updated: Boolean(existingPromotionId),
  });
});

flipdeskEbayRoutes.delete("/listings/:id/sale", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);

  const { data: cur } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  const pf = ((cur as { platform_fields?: Record<string, unknown> } | null)
    ?.platform_fields) ?? {};
  const promotionId = typeof pf.markdown_promotion_id === "string"
    ? pf.markdown_promotion_id
    : null;
  if (!promotionId) {
    return c.json({ error: "No active Sale on this listing." }, 409);
  }

  try {
    await endMarkdownSale(userId, promotionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A 404 (already ended/deleted) is fine — fall through to clear local state.
    if (!/\(404\)|not found/i.test(msg)) {
      return failSafe(c, 502, "eBay rejected ending the Sale.", err, "ebay.markdown.end");
    }
  }

  delete pf.markdown_promotion_id;
  delete pf.markdown_pct;
  await supabaseAdmin
    .from("listings")
    .update({ platform_fields: pf } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.markdown.end",
    targetType: "listing",
    targetId: listingId,
    details: { promotion_id: promotionId },
  });
  return c.json({ ok: true, listing_id: listingId });
});

// ── Promoted Listings management (US-1044) ──────────────────────────
// GET status, POST to opt-in/set the ad rate, DELETE to opt out. The publish
// path already auto-attaches an ad; these give the seller explicit control.

interface PromoListingRow {
  platform_listing_id: string | null;
  platform_category_id: string | null;
  promo_opt_out: boolean | null;
  promote_override: boolean | null;
  promo_rate_pct: number | null;
  promo_ad_id: string | null;
  promo_status: string | null;
  platform_fields: { markdown_promotion_id?: unknown; markdown_pct?: unknown } | null;
}

async function loadPromoRow(
  listingId: string,
  userId: string,
): Promise<PromoListingRow | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "platform_listing_id, platform_category_id, promo_opt_out, promote_override, promo_rate_pct, promo_ad_id, promo_status, platform_fields, inventory_items!inner(user_id)",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as PromoListingRow & {
    inventory_items: { user_id: string };
  };
  if (row.inventory_items.user_id !== userId) return null;
  return row;
}

flipdeskEbayRoutes.get("/listings/:id/promotion", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  const row = await loadPromoRow(listingId, userId);
  if (!row) return c.json({ error: "Listing not found" }, 404);
  const saleActive = typeof row.platform_fields?.markdown_promotion_id === "string";
  // 00432: seller defaults, so the client can show the EFFECTIVE promotion state
  // (override ?? default) and seed the default rate from the seller's setting.
  const { data: ownerRow } = await supabaseAdmin
    .from("users")
    .select(
      "promote_listings_by_default, default_promo_rate_pct, default_promo_mode",
    )
    .eq("id", userId)
    .maybeSingle();
  const owner = ownerRow as {
    promote_listings_by_default: boolean | null;
    default_promo_rate_pct: number | null;
    default_promo_mode: string | null;
  } | null;

  // US-1979 (AC1): prefer eBay's trending rate for this listing over our
  // category heuristic. Only live listings have an id eBay can recommend against;
  // a draft keeps the heuristic. fetchTrendingAdRates swallows its own failures
  // and returns an empty map, so a suggestion outage degrades to the heuristic
  // rather than failing the whole promotion panel.
  let suggestedRate = suggestedAdRateForCategory(row.platform_category_id);
  let suggestedBasis: "ebay_trending" | "category_heuristic" = "category_heuristic";
  if (row.platform_listing_id) {
    const trending = await fetchTrendingAdRates(userId, [row.platform_listing_id]);
    const pct = trending.get(row.platform_listing_id);
    if (pct !== undefined) {
      suggestedRate = pct;
      suggestedBasis = "ebay_trending";
    }
  }

  const promoteByDefault = owner?.promote_listings_by_default ?? false;
  const effectivePromote = row.promote_override ?? promoteByDefault;
  return c.json({
    opt_out: row.promo_opt_out ?? false,
    // Tri-state per-listing override (null = inherit) + the resolved effective state.
    promote_override: row.promote_override,
    effective_promote: effectivePromote,
    promote_by_default: promoteByDefault,
    default_rate_pct: owner?.default_promo_rate_pct ?? null,
    default_mode: owner?.default_promo_mode ?? null,
    rate_pct: row.promo_rate_pct,
    ad_id: row.promo_ad_id,
    status: row.promo_status,
    // US-1979 (AC1): eBay's OWN trending rate for THIS listing when it has one —
    // the average ad rate of listings that recently SOLD in the same category —
    // falling back to our category heuristic. suggested_rate_basis tells the UI
    // which it got, so it can say "eBay's trending rate" rather than implying our
    // guess came from eBay.
    suggested_rate_pct: suggestedRate,
    suggested_rate_basis: suggestedBasis,
    sale_active: saleActive,
    sale_pct: typeof row.platform_fields?.markdown_pct === "number"
      ? row.platform_fields.markdown_pct
      : null,
  });
});

flipdeskEbayRoutes.post("/listings/:id/promotion", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  let body: { rate_pct?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const rate = Number(body.rate_pct);
  if (!Number.isFinite(rate) || rate <= 0) {
    return c.json({ error: "rate_pct must be a positive number" }, 400);
  }
  const row = await loadPromoRow(listingId, userId);
  if (!row) return c.json({ error: "Listing not found" }, 404);
  if (!row.platform_listing_id) {
    return c.json(
      { error: "This listing has no eBay listing id. Sync or republish first." },
      409,
    );
  }

  let appliedRate = rate;
  let adId = row.promo_ad_id;
  try {
    const campaignId = await ensureAdCampaign(userId);
    const existing = await getAdForListing(userId, campaignId, row.platform_listing_id);
    if (existing?.adId) {
      appliedRate = await updateAdRateForListing(
        userId,
        campaignId,
        row.platform_listing_id,
        rate,
      );
      adId = existing.adId;
    } else {
      const created = await createAdForListing(
        userId,
        campaignId,
        row.platform_listing_id,
        rate,
      );
      adId = created?.adId ?? null;
    }
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the promotion update.", err, "ebay.promotion.set");
  }

  await supabaseAdmin
    .from("listings")
    .update({
      promo_opt_out: false,
      // 00432: an explicit opt-in pins the tri-state override on, so it no longer
      // inherits the (off-by-default) seller default.
      promote_override: true,
      promo_rate_pct: appliedRate,
      promo_ad_id: adId,
      promo_status: "active",
    } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.promotion.set",
    targetType: "listing",
    targetId: listingId,
    details: { rate_pct: appliedRate, ad_id: adId },
  });
  return c.json({ ok: true, rate_pct: appliedRate, ad_id: adId });
});

flipdeskEbayRoutes.delete("/listings/:id/promotion", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  const row = await loadPromoRow(listingId, userId);
  if (!row) return c.json({ error: "Listing not found" }, 404);

  if (row.platform_listing_id) {
    try {
      const campaignId = await ensureAdCampaign(userId);
      await removeAdForListing(userId, campaignId, row.platform_listing_id);
    } catch (err) {
      return failSafe(c, 502, "eBay rejected removing the promotion.", err, "ebay.promotion.remove");
    }
  }

  await supabaseAdmin
    .from("listings")
    .update({
      promo_opt_out: true,
      // 00432: explicit opt-out pins the tri-state override off.
      promote_override: false,
      promo_ad_id: null,
      promo_status: null,
    } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.promotion.remove",
    targetType: "listing",
    targetId: listingId,
  });
  return c.json({ ok: true });
});

// US-1079: record a failed outbound push on the listing, reusing the publish
// path's publish_error/publish_failed_at columns so the UI can surface
// "last failed: X" on reload and offer a retry. Stores a short, user-facing
// message (mapped from eBay's structured error ids when available), never the
// raw eBay blob. Ownership of `listingId` is already verified by the caller
// (loadListingOwned), so updating by id here is tenant-safe.
async function persistReviseFailure(
  listingId: string,
  err: unknown,
): Promise<void> {
  try {
    const msg = resolveEbayFix(err, EBAY_PUBLISH_GENERIC_FIX).message;
    await supabaseAdmin
      .from("listings")
      .update({
        publish_error: msg.slice(0, 1000),
        publish_failed_at: new Date().toISOString(),
      })
      .eq("id", listingId);
  } catch (logErr) {
    console.error(
      "[flipdesk-ebay] could not persist revise failure:",
      logErr,
    );
  }
}

// US-1081/US-1079: a successful push re-asserts GradeThread's values onto eBay,
// so any recorded eBay-drift marker is resolved — clear it so the "eBay differs"
// indicator disappears without waiting for the next inbound sync. Also clears any
// prior push failure (publish_error/publish_failed_at) so the retry banner goes
// away once the push succeeds.
//
// Lifted out of the offer path in US-2395 so the group path clears the SAME
// state. A revise that succeeded through one mechanism and left the drift marker
// standing because it took the other branch would show "eBay differs" on a
// listing that no longer does.
//
// US-2684: `restocked` clears the out-of-stock marker too. The marker is written
// by the inbound pull and only ON A CHANGE, so nothing would have rewritten it
// until eBay's next differing answer — leaving the "nobody can buy this" banner
// standing over a listing the seller had just put back in stock, for up to the
// full sync interval. The banner is the whole mechanism here; one that lies
// after the fix is worse than no banner, because the seller stops believing the
// next one. Only the out-of-stock reason is cleared: an `inactive` verdict
// (eBay took the listing down) is not something a quantity push resolves.
async function clearReviseDrift(
  listingId: string,
  opts: { restocked?: boolean } = {},
): Promise<void> {
  const { data: cur } = await supabaseAdmin
    .from("listings")
    .select("platform_fields")
    .eq("id", listingId)
    .maybeSingle();
  const pf = ((cur as { platform_fields?: Record<string, unknown> } | null)
    ?.platform_fields) ?? {};
  const update: Record<string, unknown> = {
    publish_error: null,
    publish_failed_at: null,
  };
  if ((pf as { sync_drift?: unknown }).sync_drift) {
    delete (pf as { sync_drift?: unknown }).sync_drift;
    update.platform_fields = pf;
  }
  const state = (pf as { ebay_state?: { reason?: string } }).ebay_state;
  if (opts.restocked && state?.reason === "out_of_stock") {
    delete (pf as { ebay_state?: unknown }).ebay_state;
    update.platform_fields = pf;
  }
  await supabaseAdmin
    .from("listings")
    .update(update as never)
    .eq("id", listingId);
}

// Revises a live listing — title / description / price / quantity / photo order.
// Photos and aspects flow through the inventory_item PUT (which is sourced from
// current local state), so editing a photo via the photo manager and then
// hitting revise with `photos: true` syncs the new image set + order to eBay.
//
// IMPORTANT (US-310/eBay): listings created through the Sell Inventory API
// CANNOT be edited on eBay's own site ("Inventory-based listing management is
// not currently supported by this tool"). This endpoint is the supported way
// to push edits back — including a photo reorder with no other change.
// US-2404: the per-listing revise, extracted from POST /listings/:id/revise so
// the bulk route can run the SAME code rather than a second copy of it. A bulk
// action whose refusals drift from the single-item ones is how a seller ends up
// told 40 listings were pushed when eBay refused 12.
//
// It returns a { status, body } pair instead of a Response because it is called
// once per row by the bulk handler; the single-listing route hands the pair
// straight to c.json and is otherwise unchanged.
// US-2404: the per-request cap on a bulk resubmit. Lower than the 100 that
// /bulk-price allows, because a revise is several eBay API calls per listing
// rather than one, and the request has to finish inside a gateway timeout. The
// client chunks a larger selection into requests of this size and shows progress.
const MAX_BULK_REVISE_ITEMS = 25;

interface ReviseOnePatch {
  title?: string;
  description?: string;
  listingPrice?: number;
  quantity?: number;
  syncPhotos?: boolean;
  resyncFields?: boolean;
}

interface ReviseOneResult {
  status: 200 | 400 | 403 | 404 | 409 | 422 | 502 | 503;
  body: Record<string, unknown>;
}

function jsonResult(
  body: Record<string, unknown>,
  status: ReviseOneResult["status"] = 200,
): ReviseOneResult {
  return { body, status };
}

async function reviseOneListing(
  listingId: string,
  userId: string,
  patch: ReviseOnePatch,
): Promise<ReviseOneResult> {
  const nextTitle = patch.title;
  const nextDesc = patch.description;
  const nextPrice = patch.listingPrice;
  const nextQty = patch.quantity;
  const hasTitle = nextTitle !== undefined;
  const hasDesc = nextDesc !== undefined;
  const hasPrice = nextPrice !== undefined;
  const hasQty = nextQty !== undefined;
  const syncPhotos = patch.syncPhotos === true;
  const resyncFields = patch.resyncFields === true;

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return jsonResult(row.error, row.status);

  // US-2166 DECISION (owner's call, 2026-07-31): revise is an eBay OPERATOR, not
  // a platform-agnostic lifecycle step, so it deliberately stays here rather
  // than moving alongside price and end. What "revise" means on eBay — item
  // aspects, leaf categories, markdown Sale overlays, inventory_item vs offer
  // field split — has no counterpart on the marketplaces the adapter covers.
  // Forcing it into a shared shape would produce an operation that is eBay's
  // everywhere except in name. This matches AC3, which already said the
  // aspects/markdown pieces stay eBay-side; AC1 listing revise alongside price
  // and end is resolved in AC3's favour.
  //
  // Being the eBay operator means SAYING SO. loadListingOwned does not filter by
  // platform, so a Shopify or Etsy listing id can reach this handler; before
  // this it would have gone on to call eBay's inventory/offer APIs with that
  // row's ids. Refuse it plainly and point at the route that does handle it.
  if ((row.listing.platform ?? "ebay") !== "ebay") {
    return jsonResult(
      {
        error:
          `This is a ${row.listing.platform} listing, and revise is an eBay-only operation. ` +
          "Change its price with the listing price endpoint, or edit it on that marketplace.",
        code: "not_an_ebay_listing",
      },
      409,
    );
  }

  // US-1080: eBay-originated listings are a read-only mirror in GradeThread —
  // eBay owns title/description/price/photos. Revising those here would be
  // overwritten on the next inbound sync, so reject the write server-side
  // (defense in depth behind the locked UI). Origin is derived from existing
  // signals until US-1077 persists listing_origin. The request maps title →
  // listing_title, description → listing_description, listing_price, and
  // photos → product imagery — all EBAY_OWNED_LISTING_FIELDS.
  const origin = deriveListingOrigin({
    // US-1976: consult the persisted marker first (parity with the /price + end
    // gates), falling back to the provenance signals until it backfills.
    listing_origin: row.listing.listing_origin,
    // US-2166: the row's own platform, not a literal.
    platform: row.listing.platform,
    platform_listing_id: row.listing.platform_listing_id,
    batch_id: row.listing.batch_id,
    synced_to_ebay_at: row.listing.synced_to_ebay_at,
  });
  if (origin === "ebay") {
    const requested = [
      hasTitle && "listing_title",
      hasDesc && "listing_description",
      hasPrice && "listing_price",
      hasQty && "quantity",
    ].filter((f): f is string => typeof f === "string");
    const { locked } = validateEbayOriginEdit(origin, requested);
    // US-1490: category/condition/specifics are eBay-owned too, so a resync of
    // them on an eBay-originated listing is just as unsafe as a title/price edit.
    if (locked.length > 0 || syncPhotos || resyncFields) {
      const extra = [
        syncPhotos ? "photos" : null,
        resyncFields ? "specifics" : null,
      ].filter((f): f is string => f !== null);
      return jsonResult(
        {
          error:
            "This listing was created on eBay, so eBay owns its title, price, description, and photos. Edit it on eBay — changes here would be overwritten on the next sync.",
          locked_fields: [...locked, ...extra],
        },
        409
      );
    }
  }

  // US-2395 AC1/AC2: which mechanism pushes this revision. Group FIRST, and
  // keyed on the PINNED inventory_sku, so a SKU rename cannot aim the revise at
  // a group that no longer exists. A variation listing has no offer id and never
  // will — eBay publishes it by inventory_item_group — which is why an
  // offer-first read of the same row concluded "no mechanism" and 409'd.
  const reviseStrategy = resolveReviseStrategy({
    variations: row.listing.variations ?? null,
    itemSku: row.listing.inventory_sku ?? null,
    platformOfferId: row.listing.platform_offer_id ?? null,
  });

  if (reviseStrategy.kind === "none") {
    return jsonResult(
      {
        error:
          "This listing has no eBay offer id. Sync from eBay or republish to enable edits.",
      },
      409
    );
  }

  // Acted on AFTER the shared assembly below rather than here: the group push
  // needs the same title, description, aspects, photos and condition the offer
  // path spends the next two hundred lines building, and a second copy of that
  // assembly is how the two paths would start disagreeing about what a revision
  // contains.
  const groupRevise = reviseStrategy.kind === "group";
  const offerId = reviseStrategy.kind === "offer" ? reviseStrategy.offerId : "";
  const itemId = row.listing.inventory_item_id;

  // Update local state first so the inventory_item PUT below reads the
  // canonical (post-edit) values. Any eBay error rolls back via the
  // user re-syncing; we keep local as the source of truth.
  const localUpdates: Record<string, unknown> = {};
  if (hasTitle) localUpdates.listing_title = nextTitle;
  if (hasDesc) localUpdates.listing_description = nextDesc;
  if (hasPrice) localUpdates.listing_price = nextPrice;
  if (hasQty) localUpdates.quantity = nextQty;
  // A photos-only revise has nothing to write locally — skip the no-op update
  // (an empty PATCH would error on PostgREST).
  if (Object.keys(localUpdates).length > 0) {
    await supabaseAdmin.from("listings").update(localUpdates).eq("id", listingId);
  }

  // US-1490: resolved eBay leaf category, lifted so the offer-side PUT below can
  // re-assert it on the live offer when a resync was requested (the category
  // lives on the offer, not the inventory item). Set inside the re-PUT branch.
  let reviseCategoryId: string | null = null;
  // US-1502: when a resync (re)asserts the grade, the promoted description (with
  // the "Cert #…" line) is lifted here so the offer-side PUT pushes it as the
  // live listingDescription too — otherwise a stored offer description would
  // shadow the product.description we just updated.
  let reviseGradeDesc: string | null = null;

  // Re-PUT the inventory_item when product fields changed (title / desc), a photo
  // sync was requested, OR a structured-field resync was requested (US-1490 —
  // category/condition/specifics). We send full state — photos, aspects, brand —
  // so any drift from the photo manager / category picker also syncs here.
  //
  // US-2395: `|| groupRevise` is load-bearing rather than tidy. A price-only or
  // quantity-only revise satisfies none of the first four conditions, so this
  // block is skipped — and the GROUP branch lives inside it. Without this the
  // request would fall through to the offer-side push at the end and call
  // updateOfferFields with the empty offerId a group listing resolves to. The
  // extra item and group PUTs a price-only group revise now performs are the
  // same idempotent ones publish sends, and the group is being re-published in
  // that path anyway.
  if (hasTitle || hasDesc || syncPhotos || resyncFields || groupRevise) {
    const { data: itemRow } = await supabaseAdmin
      .from("inventory_items")
      .select(
        "id, user_id, title, brand, size, color, material, style, item_category, attributes, sku, description, condition_notes, grade_value, grade_label, certificate_url, ebay_aspects, ebay_aspect_sources, ebay_category_id, measurements, ai_field_sources"
      )
      .eq("id", itemId)
      .maybeSingle();
    if (!itemRow || (itemRow as { user_id: string }).user_id !== userId) {
      return jsonResult({ error: "Item not found" }, 404);
    }
    const item = itemRow as {
      id: string;
      user_id: string;
      title: string | null;
      brand: string | null;
      size: string | null;
      color: string | null;
      material: string | null;
      style: string | null;
      item_category: string | null;
      attributes: Record<string, string | string[]> | null;
      sku: string | null;
      description: string | null;
      condition_notes: string | null;
      grade_value: number | null;
      grade_label: string | null;
      certificate_url: string | null;
      ebay_aspects: Record<string, string[]> | null;
      ebay_aspect_sources: Record<string, string> | null;
      ebay_category_id: string | null;
      measurements: Measurements;
    };

    // US-2593: the item's own title follows the listing title. `listings` and
    // `inventory_items` each carry a title and only the listing one ever moved,
    // so the Inventory tab of a synced Google Sheet (which reads
    // inventory_items.title) kept the name the item was created with while eBay
    // showed the corrected one. Enforced HERE as well as in the web composer so
    // a revise from iOS or Android carries the same rule — this is the eBay
    // path, so a per-platform cross-listing title can never reach the column.
    const revisedTitle = hasTitle ? (nextTitle as string).trim() : "";
    if (revisedTitle && revisedTitle !== (item.title ?? "").trim()) {
      await supabaseAdmin
        .from("inventory_items")
        .update({ title: revisedTitle })
        .eq("id", item.id)
        .eq("user_id", userId);
      item.title = revisedTitle;
    }

    // US-1088+: the structured columns (Brand/Size/Color/Material/Style) are the
    // source of truth for their eBay item specifics. eBay shows these from item
    // specifics, not the title — so any edit on the main listing must propagate,
    // overwriting the previously-pushed value (which otherwise lingers and shows
    // as <UNKNOWN>/stale to buyers). Rebuild the aspect map from the columns on
    // every revise, then persist it so the composer + next publish stay in sync.
    const { data: listingRow } = await supabaseAdmin
      .from("listings")
      .select(
        "platform_category_id, item_specifics_override, item_specifics_sources, ebay_condition, ebay_condition_description",
      )
      .eq("id", listingId)
      .maybeSingle();
    reviseCategoryId =
      (listingRow as { platform_category_id?: string | null } | null)
        ?.platform_category_id ?? item.ebay_category_id ?? null;
    // US-1505: legacy rows may be string-valued; coerce to string[] before
    // forceColumnAspects / the eBay re-PUT (a bare string would 400 eBay).
    const baseAspects: Record<string, string[]> = normalizeAspectMap(
      (listingRow as
        | { item_specifics_override?: Record<string, unknown> | null }
        | null)?.item_specifics_override ??
        (item.ebay_aspects as Record<string, unknown> | null),
    );
    // Pull the category's real aspect spec (cached) so synonyms / SELECTION_ONLY
    // validation match; degrade gracefully to the default column names on error.
    let reviseAspectList: AspectSpecRaw[] | null = null;
    if (reviseCategoryId) {
      try {
        const resp = await getCategoryAspects(reviseCategoryId);
        const raw = (resp.aspects as Record<string, unknown>).aspects;
        if (Array.isArray(raw)) reviseAspectList = raw as AspectSpecRaw[];
      } catch (err) {
        console.error("[flipdesk-ebay] revise aspect spec fetch failed:", err);
      }
    }
    // Reverse column sync (mirrors assemblePublishContext): fold MANUAL
    // specifics edits back into their columns before the columns are
    // re-asserted below — otherwise a Brand typed in a specifics editor is
    // clobbered by the stale column on every revise.
    {
      const overrideSources = (listingRow as {
        item_specifics_override?: Record<string, unknown> | null;
        item_specifics_sources?: Record<string, string> | null;
      } | null);
      const aspectSources = ((overrideSources?.item_specifics_override != null
        ? overrideSources.item_specifics_sources
        : item.ebay_aspect_sources) ?? {}) as Record<string, string | undefined>;
      const writeBack = reverseColumnAspects(
        item as unknown as RegistryItem,
        baseAspects,
        aspectSources,
        reviseAspectList ? toRegistryAspects(reviseAspectList) : null,
      );
      if (Object.keys(writeBack).length > 0) {
        Object.assign(item, writeBack);
        const { error: wbErr } = await supabaseAdmin
          .from("inventory_items")
          .update(writeBack as never)
          .eq("id", itemId);
        if (wbErr) {
          console.error(
            `[flipdesk-ebay] revise column write-back failed for ${itemId}: ${wbErr.message}`,
          );
        }
      }
    }
    const aspects = forceColumnAspects(
      item as unknown as RegistryItem,
      reviseAspectList,
      baseAspects,
    );
    // Gap-fill the aspects the columns don't own the same way publish does.
    // forceColumnAspects only re-asserts Brand/Size/Color/Material/Style; the
    // attribute- and inference-backed required specifics (Department, Size Type,
    // …) came from deriveAspectsFromItem on the publish path and had no
    // equivalent here — so a listing whose stored override was missing one could
    // be published (publish filled it) yet fail EVERY later revise with eBay's
    // "The item specific X is missing". Same resolver, same never-overwrite rule.
    const reviseDerivedKeys: string[] = [];
    if (reviseAspectList && reviseAspectList.length > 0) {
      const derived = deriveAspectsFromItem(
        item as unknown as PublishItem,
        reviseAspectList,
        aspects,
      );
      for (const [k, v] of Object.entries(derived)) {
        aspects[k] = v;
        reviseDerivedKeys.push(k);
      }
    }

    // US-1502/US-1503: on a structured resync, fold the CURRENT measurements +
    // grade into the aspect map + description BEFORE we persist/PUT so the live
    // listing, the persisted override, and the composer all agree. Idempotent:
    // resolveMeasurementAspects only fills free-text measurement aspects the
    // category exposes (never clobbering set values); applyMeasurementsBlock
    // replaces its own block; applyGradeListingPromotion force-overwrites the
    // grade specific + de-dupes the cert line. Result (with the "Cert #…" line)
    // is lifted to reviseGradeDesc so the inventory PUT + offer both push it.
    if (resyncFields) {
      const meas = item.measurements;
      let desc = (
        (hasDesc ? (nextDesc as string) : null) ??
        row.listing.listing_description ??
        item.description ??
        item.title ??
        ""
      ).trim();
      if (meas && Object.keys(meas).length > 0) {
        const measAspects = resolveMeasurementAspects(
          meas,
          allowedAspectsFromSpec(reviseAspectList ?? []),
          aspects,
          "in",
          // US-2796 AC3, same rule on the revise path: a revise that re-derived
          // measurement aspects would otherwise put the US-named aspect back.
          shoeScaleOf(item),
        );
        for (const [k, v] of Object.entries(measAspects)) aspects[k] = v;
        desc = applyMeasurementsBlock(desc, meas, "in", {
          calibrated: hasCalibratedMeasurements(
            (item as { ai_field_sources?: Record<string, unknown> | null })
              .ai_field_sources,
          ),
        });
      }
      // Run unconditionally: for ungraded items this is a no-op past the
      // off-eBay link strip, and the strip must reach EVERY revise so a legacy
      // linked credential block in a stored description can't ride a revise
      // back onto the live listing.
      desc = await applyGradeListingPromotion(item, aspects, desc, {
        force: true,
      });
      reviseGradeDesc = desc;
    }

    // Resolve + auto-correct the condition the same way the publish path does:
    // the seller's stored ebay_condition wins over the grade-derived default,
    // then it's reconciled against the category's allow-list so a revise re-PUT
    // never sends a condition eBay rejects (error 25021). Best-effort — a policy
    // fetch failure leaves the resolved value untouched.
    const listingCondition = (
      listingRow as { ebay_condition?: string | null } | null
    )?.ebay_condition;
    let reviseCondition =
      listingCondition && listingCondition.trim()
        ? listingCondition.trim()
        : mapEbayCondition(item.grade_value, item.grade_label);
    if (reviseCategoryId) {
      try {
        const { conditionIds } = await getItemConditionPolicies(reviseCategoryId);
        // US-1894: apparel-aware resolve (2025 pre-loved bands on apparel leaves)
        // + allow-list remap; explicit editor value still wins.
        const remapped = resolveEbayCondition({
          explicit: listingCondition,
          grade: item.grade_value,
          label: item.grade_label,
          allowedConditionIds: conditionIds,
        });
        if (remapped !== null && remapped !== reviseCondition) {
          console.log(
            `[flipdesk-ebay] revise condition "${reviseCondition}" resolved to ` +
              `"${remapped}" for category ${reviseCategoryId}`,
          );
          reviseCondition = remapped;
        }
      } catch (err) {
        console.warn(
          "[flipdesk-ebay] revise condition-policy (non-blocking):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const reviseConditionDescription =
      (
        (listingRow as { ebay_condition_description?: string | null } | null)
          ?.ebay_condition_description ??
        item.condition_notes ??
        ""
      ).trim() || undefined;
    // Persist the rebuilt map so the in-app eBay specifics editor and the next
    // publish reflect the current columns (canonical = listing override; mirror
    // onto the item too for legacy/no-listing reads). US-1503: also persist the
    // resync-regenerated description (measurements block + grade line) so the
    // composer + next revise's fallback don't re-serve the publish-time snapshot.
    // US-825: anything the gap-fill just derived is attributed
    // `inventory_derived`, merged over the existing provenance so an AI- or
    // user-attributed aspect is never downgraded. Without this the next revise's
    // reverseColumnAspects would read a derived value as unattributed.
    const reviseSources =
      reviseDerivedKeys.length > 0
        ? mergeSources(
            (((listingRow as {
              item_specifics_sources?: AspectSourceMap | null;
            } | null)?.item_specifics_sources ??
              item.ebay_aspect_sources ??
              {}) as AspectSourceMap),
            sourcesFor(reviseDerivedKeys, "inventory_derived"),
            aspects,
          )
        : null;
    await supabaseAdmin
      .from("listings")
      .update({
        item_specifics_override: aspects,
        ...(reviseSources ? { item_specifics_sources: reviseSources } : {}),
        ...(reviseGradeDesc != null
          ? { listing_description: reviseGradeDesc }
          : {}),
      })
      .eq("id", listingId);
    await supabaseAdmin
      .from("inventory_items")
      .update({
        ebay_aspects: aspects,
        ...(reviseSources ? { ebay_aspect_sources: reviseSources } : {}),
      })
      .eq("id", itemId);
    // US-1999: address the SKU eBay actually holds this listing under. Deriving
    // from item.sku here is what let a post-publish SKU rename send the revise
    // to a key eBay never had — creating an orphan inventory item while the
    // offer-id-keyed calls below still hit the real offer.
    const sku = resolveInventorySku(row.listing, item);

    const { data: photoRows } = await supabaseAdmin
      .from("item_photos")
      .select("storage_path, photo_url, photo_type, photo_role, sort_order")
      .eq("inventory_item_id", itemId)
      .order("sort_order", { ascending: true });
    // US-1549: 'internal' photos (price tags, receipts) never go to eBay.
    const imageUrls = toEbayImageUrls(
      filterEbayPhotos(
        (photoRows ?? []) as Array<{
          storage_path: string | null;
          photo_url: string | null;
          photo_type: string | null;
        }>,
      ).map(ebayPublicPhotoUrl)
    );

    // When the caller didn't override title/desc (e.g. a photos-only sync),
    // fall back to the values that were actually PUBLISHED (the listing row),
    // then the inventory_items mirror — never let a photo reorder silently
    // revert the live title/description.
    // US-1890: the revise/grade-resync re-PUT is often automated (photos-only
    // sync, grade line refresh), so a stored over-length title can't be fixed by
    // a human here — trim it on a word boundary defensively so eBay never rejects
    // the revision for a >80-char title.
    const finalTitle = trimTitleToLimit(
      hasTitle
        ? (nextTitle as string)
        : (row.listing.listing_title ?? item.title ?? "").trim(),
    );
    const finalDesc = hasDesc
      ? (nextDesc as string)
      : (
          row.listing.listing_description ??
          item.description ??
          finalTitle
        ).trim() || finalTitle;

    // US-1502/US-1503: reviseGradeDesc was computed above (measurements block +
    // grade promotion) when a resync ran; otherwise use the plain finalDesc.
    const reviseDesc = reviseGradeDesc ?? finalDesc;

    // Same value-validation rule the publish path applies (US-828 + NUMBER-typed
    // aspects): the PERSISTED map above keeps the seller's value so they can fix
    // it in the composer, but what goes OVER THE WIRE is reconciled — one
    // unparseable specific must not fail the whole revision the way it fails a
    // publish (25002). No spec loaded ⇒ send the map as-is, as before.
    const reviseWireAspects = reviseAspectList
      ? (() => {
          const r = reconcilePublishAspects(
            aspects,
            reviseAspectList
              .map((a) => ({
                name: a.localizedAspectName ?? "",
                mode: a.aspectConstraint?.aspectMode ?? "FREE_TEXT",
                allowedValues: (a.aspectValues ?? [])
                  .map((v) => v.localizedValue ?? "")
                  .filter((v) => v.length > 0),
                dataType: a.aspectConstraint?.aspectDataType,
              }))
              .filter((s) => s.name.length > 0),
          );
          if (r.omitted.length > 0) {
            console.warn(
              `[flipdesk-ebay] revise omitted ${r.omitted.length} aspect value(s) ` +
                `for item ${itemId}: ${JSON.stringify(r.omitted)}`,
            );
          }
          return r.aspects;
        })()
      : aspects;

    // Pre-flight the SAME required-aspect rule publish enforces. eBay rejects a
    // revision whose specifics are missing a required aspect ("The item specific
    // Department is missing"), and relaying that raw text after a wasted round
    // trip left the seller with no idea where to fix it. Check the wire map (a
    // required aspect whose only value failed value-validation reads as missing,
    // which is what eBay will say too) and answer with the composer instruction.
    if (reviseAspectList && reviseAspectList.length > 0) {
      const missing = requiredMissingAspects(reviseAspectList, reviseWireAspects);
      if (missing.length > 0) {
        console.warn(
          `[flipdesk-ebay] revise blocked for item ${itemId} (category ` +
            `${reviseCategoryId}): required specifics unfilled: ${missing.join(", ")}`,
        );
        await persistReviseFailure(
          listingId,
          new Error(`Required eBay specifics missing: ${missing.join(", ")}`),
        );
        return jsonResult(
          {
            error: "Required eBay item specifics are missing.",
            detail:
              `eBay requires ${missing.slice(0, 4).join(", ")}` +
              (missing.length > 4 ? ` and ${missing.length - 4} more` : "") +
              " for this category. Open the item, fill " +
              (missing.length === 1 ? "it" : "them") +
              " in the eBay item specifics editor, then save again.",
            missing_aspects: missing,
          },
          422,
        );
      }
    }

    // Move the live listing's CATEGORY before the specifics that only fit the
    // new one. eBay judges an inventory_item PUT against the category the
    // listing is in right now, and judges an offer category change against the
    // aspects the inventory item holds right now — so the obvious order
    // (specifics, then category, which is what the offer PUT further down does)
    // deadlocks on a re-categorisation:
    //
    //   • specifics first → judged by the OLD category → "The item specific
    //     Dress Length is missing" (a Dresses aspect our Tops map correctly
    //     dropped), and the route returns before the category ever moves. Every
    //     retry fails identically, so the listing can never leave the wrong
    //     category from here.
    //   • category first  → judged by the OLD aspects → "The item specific Type
    //     is missing" (a Tops aspect the Dresses map never had).
    //
    // Neither end of the swap is legal on its own, so bridge it: PUT the UNION
    // of what eBay already holds and what we're about to send (satisfies BOTH
    // categories' required aspects), move the offer's category, and let the
    // normal PUT below drop the leftovers under the new category. Best-effort
    // throughout — if any step fails we fall through to the existing path and
    // its error handling, which is no worse than before this existed.
    //
    // The bridge is best-effort, but its failure is NOT invisible: whatever
    // goes wrong here is what the seller's next error is really about, and
    // swallowing it left a re-categorised listing that refused every push with
    // an error naming an aspect its category no longer has, while nothing
    // anywhere recorded which step actually broke. The reason is carried to
    // the inventory-PUT failure below and reported with it.
    let categoryBridgeError: string | null = null;
    // US-2395: the bridge reads the LIVE OFFER, and a group listing has none.
    // Its category is re-asserted per variant offer in the group branch below.
    if (resyncFields && reviseCategoryId && !groupRevise) {
      try {
        const liveOffer = await getOffer(
          userId,
          offerId,
          row.listing.marketplace_connection_id ?? undefined,
        );
        const liveCategoryId =
          typeof liveOffer.categoryId === "string" ? liveOffer.categoryId : null;
        // Bridge when the live category differs — and ALSO when eBay didn't
        // report one at all. A missing categoryId used to skip the bridge
        // entirely, which is the same silent no-op as never having it: we
        // cannot prove the categories match, and the cost of bridging when
        // they already do is one superset PUT that the normal re-PUT below
        // immediately narrows. "Unknown" belongs with "different", not with
        // "same".
        if (liveCategoryId !== reviseCategoryId) {
          console.warn(
            `[flipdesk-ebay] listing ${listingId}: eBay category ` +
              `${liveCategoryId} → ${reviseCategoryId}; bridging via a union PUT`,
          );
          const liveAspects = await getInventoryItemAspects(
            userId,
            sku,
            row.listing.marketplace_connection_id ?? undefined,
          );
          if (liveAspects && Object.keys(liveAspects).length > 0) {
            await createOrReplaceInventoryItem(
              userId,
              sku,
              {
                product: {
                  title: finalTitle,
                  description: reviseDesc,
                  aspects: { ...liveAspects, ...reviseWireAspects },
                  imageUrls,
                  brand:
                    typeof item.brand === "string" && item.brand.trim()
                      ? item.brand.trim()
                      : "Unbranded",
                  mpn: "Does Not Apply",
                },
                condition: reviseCondition,
                conditionDescription: reviseConditionDescription,
                availability: { shipToLocationAvailability: { quantity: 1 } },
              },
              row.listing.marketplace_connection_id ?? undefined,
            );
          }
          await updateOfferFields(
            userId,
            offerId,
            { categoryId: reviseCategoryId },
            row.listing.marketplace_connection_id ?? undefined,
          );
        }
      } catch (err) {
        categoryBridgeError = err instanceof Error ? err.message : String(err);
        console.error(
          `[flipdesk-ebay] category bridge failed for listing ${listingId} ` +
            `(falling through to the normal re-PUT):`,
          err,
        );
      }
    }

    // US-2395 AC1/AC3: the group branch. Everything it needs is now built, and
    // from here the single-offer path below is untouched — this returns before
    // reaching it. The blast radius is exactly the listings that answered 409
    // until now, which is why this can land without a real listing to test
    // against: it cannot make the common path worse than it is.
    if (groupRevise && reviseStrategy.kind === "group") {
      return await reviseVariationGroup({
        userId,
        listingId,
        groupKey: reviseStrategy.groupKey,
        variations: row.listing.variations as ListingVariations,
        title: finalTitle,
        description: reviseDesc,
        aspects: reviseWireAspects,
        imageUrls,
        condition: reviseCondition,
        conditionDescription: reviseConditionDescription,
        brand:
          typeof item.brand === "string" && item.brand.trim()
            ? item.brand.trim()
            : "Unbranded",
        price: hasPrice ? (nextPrice as number) : undefined,
        categoryId: resyncFields && reviseCategoryId ? reviseCategoryId : undefined,
        listingDescription: hasDesc ? (nextDesc as string) : (reviseGradeDesc ?? undefined),
        quantityRequested: hasQty,
        connectionId: row.listing.marketplace_connection_id ?? undefined,
        localUpdates,
        photosSynced: syncPhotos || hasTitle || hasDesc || resyncFields,
      });
    }

    try {
      await createOrReplaceInventoryItem(userId, sku, {
        product: {
          title: finalTitle,
          description: reviseDesc,
          aspects:
            Object.keys(reviseWireAspects).length > 0
              ? reviseWireAspects
              : undefined,
          imageUrls,
          // Mirror the publish path (US: error 25002 <BrandMPN>): eBay requires a
          // Brand+MPN product identifier on every inventory_item PUT, so the
          // revise re-PUT must send the SAME defaults publish does — otherwise a
          // title/description/photo edit drops the MPN and eBay 400s the revision.
          brand:
            typeof item.brand === "string" && item.brand.trim()
              ? item.brand.trim()
              : "Unbranded",
          mpn: "Does Not Apply",
        },
        condition: reviseCondition,
        conditionDescription: reviseConditionDescription,
        availability: { shipToLocationAvailability: { quantity: 1 } },
      },
        // US-1507: revise via the listing's own connection (null → primary).
        row.listing.marketplace_connection_id ?? undefined);
    } catch (err) {
      console.error("[flipdesk-ebay] revise inventory_item failed:", err);
      // When the category bridge above failed, THIS error is a consequence of
      // that failure, not an independent fact: eBay is judging the new
      // specifics against a category we did not manage to move the listing out
      // of. Reporting only the downstream message is what made this look
      // unfixable — the seller is told to supply an aspect their category no
      // longer has, with no hint that a prior step is the reason. Carry the
      // cause, so the error names the step that actually broke.
      const reported = categoryBridgeError
        ? new Error(
            `${err instanceof Error ? err.message : String(err)} ` +
              `(the eBay category change did not apply first: ${categoryBridgeError})`,
          )
        : err;
      // US-1079: persist the failure on the listing (publish_error/
      // publish_failed_at) so the UI can surface it + offer a retry on reload.
      await persistReviseFailure(listingId, reported);
      // 422 (not 502): an eBay business-rule rejection is a data problem, not a
      // gateway failure. A 5xx gets intercepted by the Traefik/Coolify error page
      // (which strips CORS headers — see main.ts), so the browser sees a bare
      // "CORS blocked" instead of this detail. 422 passes through with the body.
      return jsonResult(
        {
          error: "eBay rejected the revision.",
          // US-1511: mapped/human detail only (mirrors the publish path's
          // US-567 contract) — the raw eBay blob stays in the log above.
          detail:
            ebayFailureDetail(err, EBAY_PUBLISH_GENERIC_FIX) +
            (categoryBridgeError
              ? " This listing's eBay category could not be changed first" +
                ` (${categoryBridgeError}), so eBay checked your item specifics` +
                " against its OLD category. Fix that and the specifics will" +
                " follow."
              : ""),
          ...(categoryBridgeError
            ? { category_bridge_error: categoryBridgeError }
            : {}),
        },
        422
      );
    }
  }

  // Offer side handles price + listing description + quantity + category
  // (offer.listingDescription overrides product.description, availableQuantity
  // controls the listed quantity, categoryId is the eBay leaf category). Batched
  // into one PUT. US-1490: a resync re-asserts the category on the live offer.
  // US-2395: never for a group. The group branch above returns, so reaching here
  // with groupRevise set would mean a new early-exit path skipped it — and the
  // offerId a group resolves to is the empty string, which would put a malformed
  // eBay request on the seller's live listing. Cheap guard against a mistake
  // that would only show up in production.
  if (!groupRevise && (hasPrice || hasDesc || hasQty || resyncFields)) {
    try {
      await updateOfferFields(userId, offerId, {
        price: hasPrice ? (nextPrice as number) : undefined,
        // US-1502: push the grade-promoted description (Cert # line) to the live
        // offer on a resync even when the seller didn't edit the description —
        // else a stored offer listingDescription shadows the product.description.
        listingDescription: hasDesc
          ? (nextDesc as string)
          : (reviseGradeDesc ?? undefined),
        availableQuantity: hasQty ? (nextQty as number) : undefined,
        categoryId: resyncFields && reviseCategoryId ? reviseCategoryId : undefined,
      },
        // US-1507: revise via the listing's own connection (null → primary).
        row.listing.marketplace_connection_id ?? undefined);
    } catch (err) {
      console.error("[flipdesk-ebay] revise offer failed:", err);
      // US-1079: persist the failure on the listing (publish_error/
      // publish_failed_at) so the UI can surface it + offer a retry on reload.
      await persistReviseFailure(listingId, err);
      // 422 (not 502): see the inventory_item branch above — an eBay rejection is
      // a data problem; a 5xx loses its CORS headers to the proxy error page.
      return jsonResult(
        {
          error: "eBay rejected the offer revision.",
          // US-1511: mapped/human detail only — raw blob stays in the log above.
          detail: ebayFailureDetail(err, EBAY_PUBLISH_GENERIC_FIX),
        },
        422
      );
    }
  }

  await clearReviseDrift(listingId, {
    restocked: hasQty && (nextQty as number) > 0,
  });

  return jsonResult({
    ok: true,
    listing_id: listingId,
    updated: localUpdates,
    photos_synced: syncPhotos || hasTitle || hasDesc || resyncFields,
  });
}

flipdeskEbayRoutes.post("/listings/:id/revise", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  let body: {
    title?: unknown;
    description?: unknown;
    listing_price?: unknown;
    quantity?: unknown;
    photos?: unknown;
    resync_ebay_fields?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const nextTitle =
    typeof body.title === "string" ? body.title.trim() : undefined;
  const nextDesc =
    typeof body.description === "string" ? body.description.trim() : undefined;
  const nextPrice =
    body.listing_price !== undefined && body.listing_price !== null
      ? Number(body.listing_price)
      : undefined;
  // US-1079: full eBay-owned field coverage — quantity pushes up too, not just
  // price. A non-negative integer (0 ends availability without withdrawing).
  const nextQty =
    body.quantity !== undefined && body.quantity !== null
      ? Number(body.quantity)
      : undefined;

  const hasTitle = nextTitle !== undefined;
  const hasDesc = nextDesc !== undefined;
  const hasPrice = nextPrice !== undefined;
  const hasQty = nextQty !== undefined;
  // `photos: true` forces the inventory_item re-PUT so the current photo set
  // and sort order reach eBay even when no text field changed.
  const syncPhotos = body.photos === true;
  // US-1490: `resync_ebay_fields: true` re-asserts the eBay-owned STRUCTURED
  // fields the seller edited post-publish — category, condition, and item
  // specifics — which the inventory re-PUT (aspects + condition) and the offer
  // category push below already source from the DB. It forces both pushes even
  // when no title/description/photo changed (a specifics/condition/category-only
  // edit), so "Save & resubmit" on the web composer reaches a live listing.
  const resyncFields = body.resync_ebay_fields === true;

  if (!hasTitle && !hasDesc && !hasPrice && !hasQty && !syncPhotos && !resyncFields) {
    return c.json(
      {
        error:
          "Provide at least one of: title, description, listing_price, quantity, photos, resync_ebay_fields",
      },
      400
    );
  }
  if (hasTitle && !nextTitle) {
    return c.json({ error: "title cannot be empty" }, 400);
  }
  if (
    hasPrice &&
    (!Number.isFinite(nextPrice) || (nextPrice as number) <= 0)
  ) {
    return c.json({ error: "listing_price must be a positive number" }, 400);
  }
  if (
    hasQty &&
    (!Number.isInteger(nextQty) || (nextQty as number) < 0)
  ) {
    return c.json(
      { error: "quantity must be a non-negative integer" },
      400
    );
  }

  const outcome = await reviseOneListing(listingId, userId, {
    title: nextTitle,
    description: nextDesc,
    listingPrice: nextPrice,
    quantity: nextQty,
    syncPhotos,
    resyncFields,
  });
  return c.json(outcome.body, outcome.status);
});

// ── Bulk resubmit (US-2404) ─────────────────────────────────────────
// POST /listings/bulk-revise — body { listing_ids: string[] }.
//
// The Active tab's bulk-bar equivalent of the composer's "Save & resubmit to
// eBay": for each selected listing, re-assert what is already SAVED in
// GradeThread — item specifics, category, condition (resync_ebay_fields) and the
// photo set (photos) — against the live eBay listing. It sends no new field
// values of its own, so there is nothing here for a stale render to get wrong.
//
// IT CALLS reviseOneListing, THE SAME FUNCTION THE SINGLE ROUTE CALLS. That is
// the whole point of the extraction above: every refusal the one-at-a-time path
// makes — a non-eBay platform row, an eBay-originated mirror listing (US-1080),
// a row the caller does not own — is made here identically, because it is the
// same code. A bulk action whose refusals drift from the single-item ones is how
// a seller gets told 40 listings were pushed when eBay refused 12.
//
// SEQUENTIAL, not parallel: a revise is several eBay API calls per listing
// (inventory PUT + offer update), and firing 25 of those at once is how you meet
// a rate limit. The client chunks the selection so each request stays short.
//
// PER-ROW RESULTS, never a bare success count. bulk-price's own header records
// what the shape before it did: it "quietly wrote the local price for every
// non-eBay row and reported it as updated locally only". A row eBay refused
// comes back ok:false with its reason, and reviseOneListing has already left
// that row's local state alone.
flipdeskEbayRoutes.post("/listings/bulk-revise", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  // Bulk multi-listing actions are a Pro+ feature (US-208), same gate as
  // /bulk-price and /listings/bulk-price-quantity.
  const gate = await requireFlipdesk(c, { feature: "bulkActions", userId });
  if (gate) return gate;

  let body: { listing_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const ids = Array.isArray(body.listing_ids)
    ? [...new Set(body.listing_ids.filter((x): x is string => typeof x === "string" && !!x))]
    : [];
  if (ids.length === 0) {
    return c.json({ error: "listing_ids is required." }, 400);
  }
  if (ids.length > MAX_BULK_REVISE_ITEMS) {
    return c.json(
      { error: `Too many listings (max ${MAX_BULK_REVISE_ITEMS}).` },
      400,
    );
  }

  const results: Array<{
    listing_id: string;
    ok: boolean;
    status: number;
    error?: string;
    code?: string;
  }> = [];
  for (const listingId of ids) {
    let outcome: ReviseOneResult;
    try {
      outcome = await reviseOneListing(listingId, userId, {
        syncPhotos: true,
        resyncFields: true,
      });
    } catch (err) {
      // One row throwing must not abandon the rest of the selection — the seller
      // would have no way to tell which of the remaining ids ran.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[flipdesk-ebay] bulk-revise ${listingId} threw:`, message);
      results.push({ listing_id: listingId, ok: false, status: 500, error: message });
      continue;
    }
    const ok = outcome.status === 200 && outcome.body.ok === true;
    results.push({
      listing_id: listingId,
      ok,
      status: outcome.status,
      ...(ok ? {} : {
        error: typeof outcome.body.error === "string"
          ? outcome.body.error
          : "eBay refused the update.",
        ...(typeof outcome.body.code === "string" ? { code: outcome.body.code } : {}),
      }),
    });
  }

  const pushed = results.filter((r) => r.ok).length;
  return c.json({
    ok: true,
    requested: ids.length,
    pushed,
    failed: ids.length - pushed,
    results,
  });
});


// US-1039: mark an eBay sale shipped + push the tracking number/carrier to eBay
// (Sell Fulfillment API). Without this, FlipDesk only recorded shipping locally
// — eBay never got the tracking, so the buyer saw none and the seller lost
// late-shipment / Seller Protection credit. Tenant-scoped: the sale is loaded
// THROUGH inventory_items.user_id, never by a raw id. Idempotent on a re-click
// with the same tracking (skips the eBay call).
flipdeskEbayRoutes.post("/orders/:saleId/ship", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const saleId = c.req.param("saleId");

  let body: { tracking_number?: unknown; carrier?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const trackingNumber =
    typeof body.tracking_number === "string" ? body.tracking_number.trim() : "";
  const carrier = typeof body.carrier === "string" ? body.carrier.trim() : null;
  if (!trackingNumber) {
    return c.json({ error: "tracking_number is required" }, 400);
  }

  // Tenant-scoped load (US-268): the sale must belong to the owner.
  const { data: saleRow } = await supabaseAdmin
    .from("sales")
    .select(
      "id, platform_order_id, shipped_at, tracking_number, inventory_items!inner(user_id)",
    )
    .eq("id", saleId)
    .eq("inventory_items.user_id", userId)
    .maybeSingle();
  const sale = saleRow as
    | {
      id: string;
      platform_order_id: string | null;
      shipped_at: string | null;
      tracking_number: string | null;
    }
    | null;
  if (!sale) return c.json({ error: "Sale not found." }, 404);
  if (!sale.platform_order_id) {
    return c.json(
      { error: "This sale has no eBay order id to mark shipped." },
      409,
    );
  }

  // Idempotent: an already-shipped sale with the same tracking just re-asserts
  // local state (eBay would reject a duplicate fulfillment).
  const alreadyShipped =
    sale.shipped_at != null && sale.tracking_number === trackingNumber;
  if (!alreadyShipped) {
    try {
      await createShippingFulfillment(userId, sale.platform_order_id, {
        trackingNumber,
        carrier,
      });
    } catch (err) {
      console.error("[flipdesk-ebay] createShippingFulfillment failed:", err);
      return c.json(
        {
          error: "eBay rejected the tracking upload.",
          detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
        502,
      );
    }
  }

  const { error: updErr } = await supabaseAdmin
    .from("sales")
    .update({
      shipped_at: sale.shipped_at ?? new Date().toISOString(),
      tracking_number: trackingNumber,
      // US-960: persist the carrier alongside the tracking number (column added
      // in 00250) so the Shipped tab can show it. Keep an existing value when
      // the caller didn't send one.
      ...(carrier ? { carrier } : {}),
    })
    .eq("id", sale.id);
  if (updErr) {
    console.error("[flipdesk-ebay] sale ship write-back failed:", updErr.message);
  }
  return c.json({ ok: true, pushed_to_ebay: !alreadyShipped });
});

// Compares the current eBay category against what the Taxonomy API would
// suggest for the listing's title today. Lets the user spot listings that
// are filed under a suboptimal category (which hurts search visibility).
//
// Returns the current category (id + name + breadcrumb) and the top 5
// suggestions. `match` is true iff the top suggestion equals the current.
flipdeskEbayRoutes.get("/listings/:id/category-check", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  // Load the listing + its title (from the joined inventory_item or the
  // listing's own listing_title). Ownership check via the item user_id.
  const { data: row } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_category_id, platform_listing_id, listing_title, inventory_items!inner(user_id, title, brand, style)"
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!row) return c.json({ error: "Listing not found" }, 404);
  const r = row as unknown as {
    id: string;
    platform_category_id: string | null;
    platform_listing_id: string | null;
    listing_title: string | null;
    inventory_items: {
      user_id: string;
      title: string | null;
      brand: string | null;
      style: string | null;
    };
  };
  if (r.inventory_items.user_id !== userId) {
    return c.json({ error: "Listing not found" }, 404);
  }

  // Title we'll feed into the Taxonomy query — use whatever's most
  // representative: the listing's actual title beats the item title.
  const queryParts = [r.listing_title ?? r.inventory_items.title]
    .filter((s): s is string => !!s && s.trim() !== "");
  if (queryParts.length === 0) {
    return c.json(
      { error: "Listing has no title — can't suggest a category." },
      400
    );
  }
  const query = queryParts[0]!;

  // Run current-category lookup + suggestions in parallel — independent calls.
  const [currentInfo, suggestions] = await Promise.all([
    r.platform_category_id
      ? getCategoryName(r.platform_category_id).catch(() => null)
      : Promise.resolve(null),
    suggestCategories(query).catch((err) => {
      console.error("[flipdesk-ebay] suggestCategories failed:", err);
      return [] as Awaited<ReturnType<typeof suggestCategories>>;
    }),
  ]);

  const top = suggestions[0] ?? null;
  const match =
    !!r.platform_category_id && !!top && top.categoryId === r.platform_category_id;

  return c.json({
    listing_id: listingId,
    current: r.platform_category_id
      ? {
          id: r.platform_category_id,
          name: currentInfo?.name ?? null,
          path: currentInfo?.path ?? null,
        }
      : null,
    suggested: suggestions.slice(0, 5).map((s) => ({
      id: s.categoryId,
      name: s.categoryName,
      path: s.categoryTreePath,
    })),
    match,
    query_used: query,
  });
});

flipdeskEbayRoutes.delete("/listings/:id", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return c.json(row.error, row.status);

  // US-1976: an eBay-originated listing is a read-only mirror — eBay owns its
  // lifecycle, so reject an end from FlipDesk with the same 409 + locked_fields
  // contract as /revise. Ending it here would either fight eBay's own state or
  // be overwritten on the next inbound sync. Checked BEFORE the offer-id branch
  // so an eBay-origin row that carries an offer id is still rejected as locked.
  const endLock = ebayOriginWriteLock(
    {
      listing_origin: row.listing.listing_origin,
      // US-2166: the row's own platform, not a literal.
      platform: row.listing.platform,
      platform_listing_id: row.listing.platform_listing_id,
      batch_id: row.listing.batch_id,
      synced_to_ebay_at: row.listing.synced_to_ebay_at,
    },
    ["listing_status", "is_active"],
  );
  if (endLock.locked) {
    return c.json(
      {
        error:
          "This listing was created on eBay, so eBay owns its lifecycle. End it on eBay — ending it here would be overwritten on the next sync.",
        locked_fields: endLock.lockedFields,
      },
      409
    );
  }

  // Best-effort withdraw of the live eBay offer, then ALWAYS reconcile the local
  // row to ended. A withdraw can legitimately fail because the listing is already
  // not live — the seller ended it on eBay, eBay removed it for a policy issue,
  // or a prior end already withdrew it. Previously that threw a 502 and left the
  // row stuck "active", so "End"/"Relist" became no-ops on a policy-removed
  // listing. Now only a TRANSIENT failure (rate-limit / eBay 5xx) blocks the end
  // so the user can retry; an already-not-live offer reconciles locally.
  let endedOnEbay = false;
  let note: string | null = null;

  // US-1506/US-1978: a withdraw (single-offer OR group) fails for the same three
  // reasons, handled identically. Returns an abort Response to return to the
  // caller, or a reconcile-note string when the listing was already not live.
  const classifyWithdrawFailure = (
    err: unknown,
  ): { abort: Response } | { note: string } => {
    // US-1506: a disconnected eBay account throws BEFORE the withdraw runs, so
    // the listing is still LIVE on eBay. Never reconcile it to ended — that would
    // tell the seller it's gone while buyers can still purchase it (oversell).
    // Fail with actionable reconnect copy instead.
    if (isNoEbayConnectionError(err)) {
      console.warn(
        "[flipdesk-ebay] end: no eBay connection — listing left active:",
        err instanceof Error ? err.message : String(err),
      );
      return {
        abort: c.json(
          {
            error:
              "Your eBay account isn't connected, so we couldn't end this live " +
              "listing on eBay. Reconnect eBay in Marketplaces, then end it again.",
          },
          409,
        ),
      };
    }
    if (!isOfferAlreadyEndedError(err)) {
      console.error("[flipdesk-ebay] withdraw failed (transient):", err);
      return {
        abort: c.json(
          {
            error: "eBay rejected the end-listing call. Please try again.",
            // US-1511: mapped/human detail only — raw blob stays in the log above.
            detail: ebayFailureDetail(
              err,
              "eBay couldn't end this listing just now. It's still live — try again in a moment.",
            ),
          },
          502,
        ),
      };
    }
    console.warn(
      "[flipdesk-ebay] end: listing already not live, reconciling locally:",
      err instanceof Error ? err.message : String(err),
    );
    return { note: "eBay shows this listing was already inactive; ended in FlipDesk." };
  };

  // US-1978 (AC1): a multi-variation listing is ONE eBay listing spanning an
  // inventory_item_group, so it has NO single platform_offer_id — it must be
  // ended by its GROUP KEY. resolveEndStrategy resolves group FIRST so a
  // variation listing never falls through to the "no offer linked" no-op that
  // previously left it live on eBay forever.
  const strategy = resolveEndStrategy({
    variations: row.listing.variations,
    // US-1999: the inventory_item_group was created under the BASE SKU at
    // publish, so the withdraw key is the PINNED sku — not the item's current
    // one, which a rename would have moved out from under the live group.
    itemSku: row.listing.inventory_sku ?? row.listing.item_sku,
    platformOfferId: row.listing.platform_offer_id,
  });
  // US-1507: end via the account that owns the listing (null → primary).
  const endConnectionId = row.listing.marketplace_connection_id ?? undefined;
  if (strategy.kind === "group") {
    try {
      await withdrawByInventoryItemGroup(userId, strategy.groupKey, endConnectionId);
      endedOnEbay = true;
    } catch (err) {
      const outcome = classifyWithdrawFailure(err);
      if ("abort" in outcome) return outcome.abort;
      note = outcome.note;
    }
  } else if (strategy.kind === "offer") {
    try {
      await withdrawOffer(userId, strategy.offerId, endConnectionId);
      endedOnEbay = true;
    } catch (err) {
      const outcome = classifyWithdrawFailure(err);
      if ("abort" in outcome) return outcome.abort;
      // US-2641: classifyWithdrawFailure INFERS "already not live" from a 4xx.
      // The inference is usually right, and when it is wrong the row is marked
      // ended while buyers can still buy — the failure the seller cannot see.
      // One read of the offer settles it, and only on this failure path.
      const stillLive = await getPublishedListingId(
        userId,
        strategy.offerId,
        endConnectionId,
      );
      if (stillLive) {
        console.error(
          `[flipdesk-ebay] end: withdraw of offer ${strategy.offerId} failed but ` +
            `listing ${stillLive} is STILL LIVE — refusing to mark it ended`,
        );
        return c.json(
          {
            error: "eBay refused to end this listing and it is still live.",
            detail:
              `eBay would not end listing ${stillLive}. End it in Seller Hub, ` +
              "then mark it ended here.",
          },
          502,
        );
      }
      note = outcome.note;
    }
  } else {
    note = "No eBay offer was linked; ended in FlipDesk only.";
  }

  await supabaseAdmin
    .from("listings")
    .update({ listing_status: "ended", is_active: false })
    .eq("id", listingId);
  // Move the item back to drafted so the user can relist if they want — but only
  // once nothing is live anywhere (US-2179). Ending the eBay listing of an item
  // that is still live on a cross-listed channel used to mark it a draft, which
  // both freed an activeListings slot the seller was still using and hid a
  // selling listing in the Drafts tab.
  await resyncItemListedStatus(row.listing.inventory_item_id, userId);

  return c.json({ ok: true, listing_id: listingId, ended_on_ebay: endedOnEbay, note });
});

flipdeskEbayRoutes.post("/listings/validate", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const itemId = await readItemId(c);
  if (!itemId) return c.json({ error: "inventory_item_id is required" }, 400);
  const result = await assemblePublishContext(userId, itemId);
  if (!result.ok) return c.json(result.error, result.status);
  return c.json({
    ok: result.blockers.length === 0,
    blockers: result.blockers,
    // US-1890: non-blocking title-quality warnings (duplicate/ALL-CAPS/filler).
    // US-1896 also folds picture-standards (hero <1600px zoom) warnings in here.
    warnings: result.warnings,
    // US-1896: hero-thumbnail reorder nudge (first photo is a tag/detail shot).
    photoNudge: result.photoNudge,
    // US-828: aspects that won't be sent for value-validation reasons, so the
    // composer can warn "X was not sent" before the seller publishes.
    aspectDiagnostics: result.aspectDiagnostics,
    // US-1895: recommended-aspect coverage (N/M + ranked missing) for the meter.
    recommendedCoverage: result.recommendedCoverage,
    // US-1897 (AC2): the 0-100 Listing Quality Score + component breakdown,
    // each component naming the surface that fixes it. Persisted as a
    // side-effect so the drafts list and pipeline board can sort by it.
    qualityScore: await scoreAndPersist(userId, result),
    summary: result.summary,
  });
});

// US-1897 (AC2): compute the score and persist the sortable scalar.
//
// The write is BEST-EFFORT and deliberately awaited-but-swallowed: preflight is
// what tells a seller whether they can publish, and it must not start failing
// because a score column is missing (this ships with migration 00476, and the
// edge can briefly run ahead of it) or because the row was deleted mid-request.
// A missing score costs a sort key; a thrown preflight costs the publish.
//
// Only the scalar is stored. The breakdown is recomputed every call so it can
// never drift from the live weights — see 00476.
async function scoreAndPersist(
  ownerId: string,
  ctx: PublishContextOk,
): Promise<ListingQualityScore> {
  const score = await buildQualityScore(ownerId, ctx);
  // A draft that has never been listed has no listings row yet; there is
  // nothing to sort, so nothing to store.
  if (!ctx.listing?.id) return score;
  try {
    // Tenant-safe without an extra filter: ctx.listing came from
    // assemblePublishContext, which loaded it scoped to this owner. The id is
    // ours by construction, never from the request body (US-268).
    await supabaseAdmin
      .from("listings")
      .update({
        quality_score: score.score,
        quality_blocked: score.blocked,
        quality_scored_at: new Date().toISOString(),
      })
      .eq("id", ctx.listing.id);
  } catch (err) {
    console.error(
      "US-1897 quality score persist (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
  return score;
}

// US-1897: assemble the quality score from the preflight's structured signals.
//
// Lives here rather than inside assemblePublishContext on purpose: it needs one
// extra DB read (business policies) and one extra check, and the publish and
// auto-publish paths share that function. Scoring is a validate-time concern, so
// the hot path should not pay for it.
async function buildQualityScore(
  ownerId: string,
  ctx: PublishContextOk,
): Promise<ListingQualityScore> {
  const qs = ctx.qualitySignals;

  // US-1894's consistency check shipped tested but was never called by any
  // production path — this is its first real caller. Guarded so a listing with
  // no resolved condition reports "unknown" rather than a confident verdict.
  const conditionText = ctx.summary.conditionDescription || null;
  const condition = ctx.summary.condition
    ? conditionDescriptionConsistency(
      ctx.summary.condition as Parameters<typeof conditionDescriptionConsistency>[0],
      conditionText,
    )
    : null;

  return computeListingQualityScore({
    title: {
      text: ctx.summary.title || null,
      policyViolations: qs.titlePolicyViolations,
      warnings: qs.titleWarnings,
    },
    aspects: {
      requiredMissing: qs.requiredMissing,
      recommendedFilled: ctx.recommendedCoverage.filled,
      recommendedTotal: ctx.recommendedCoverage.total,
    },
    photos: {
      blockers: qs.photoBlockers,
      warnings: qs.photoWarnings,
      nudge: ctx.photoNudge,
      count: qs.photoCount,
    },
    category: {
      leafStatus: qs.categoryLeafStatus,
      // We only KNOW the chosen category matches eBay's suggestion when we just
      // resolved it from one. Otherwise it is genuinely unknown — asserting
      // false would penalise every hand-picked category we never cross-checked.
      matchesSuggestion: qs.categoryWasSuggested ? true : null,
    },
    condition: {
      consistent: condition ? condition.ok : null,
      warnings: condition ? condition.warnings : [],
    },
    fulfillment: await loadFulfillmentSignals(ownerId),
    // US-2678: judged against what comparable items actually SOLD for, which is
    // what getRealizedComps returns and what active Browse comps are not.
    // Marketplace Insights is a gated scope, so null here is ordinary and makes
    // the component "unknown" rather than a guess.
    price: {
      // summary.priceValue is the resolved publish price as a fixed-2 STRING
      // (resolvePublishPrice -> toFixed), so it is parsed rather than read as a
      // number. "0.00" is the no-price sentinel and must not score as free.
      listingCents: (() => {
        const dollars = Number.parseFloat(ctx.summary.priceValue);
        return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null;
      })(),
      realized: await loadRealizedBand(ownerId, ctx),
    },
  });
}

/**
 * US-2678: the realized comp band for the quality score's price component.
 *
 * NON-THROWING. A quality SCORE must never be the reason a seller cannot see
 * their publish blockers, so every failure returns null, which the component
 * reads as "unknown" and drops from the score entirely.
 */
async function loadRealizedBand(
  ownerId: string,
  ctx: PublishContextOk,
): Promise<{ lowCents: number | null; medianCents: number | null; highCents: number | null; count: number } | null> {
  const categoryId = ctx.listing?.platform_category_id ?? ctx.item.ebay_category_id ?? null;
  if (!categoryId) return null;
  try {
    const realized = await getRealizedComps({
      ownerId,
      categoryId,
      brand: ctx.item.brand ?? undefined,
      q: ctx.summary.title || undefined,
      size: ctx.item.size ?? undefined,
    });
    if (!realized) return null;
    return {
      lowCents: realized.lowCents,
      medianCents: realized.medianCents,
      highCents: realized.highCents,
      count: realized.count,
    };
  } catch (err) {
    console.error("[flipdesk-ebay] realized band for quality score:", err);
    return null;
  }
}

// US-1895: bulk recommended-aspect coverage for the AutoLister drafts list, so a
// bulk session can sort/fix low-coverage drafts. Body { itemIds: string[] } →
// { coverage: { [itemId]: { filled, total, missing } } }. Tenant-scoped: only
// the caller's own items resolve (foreign ids simply don't match and are
// omitted). Category specs are cached + de-duped so a page of drafts sharing a
// category costs one Taxonomy read. Uses the same recommendedAspectCoverage
// rule as the composer meter + publish preflight (single source).
flipdeskEbayRoutes.post("/aspect-coverage", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { itemIds?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemIds = Array.isArray(body.itemIds)
    ? [...new Set(body.itemIds.filter((x): x is string => typeof x === "string"))]
        .slice(0, 200)
    : [];
  if (itemIds.length === 0) return c.json({ coverage: {} });

  // Owner-scoped: per-listing canonical aspects + category first, item mirror as
  // the fallback for drafts that never got a listing override.
  const [{ data: listingsRaw }, { data: itemsRaw }] = await Promise.all([
    supabaseAdmin
      .from("listings")
      .select("inventory_item_id, platform_category_id, item_specifics_override")
      .eq("user_id", userId)
      .in("inventory_item_id", itemIds),
    supabaseAdmin
      .from("inventory_items")
      .select("id, ebay_category_id, ebay_aspects")
      .eq("user_id", userId)
      .in("id", itemIds),
  ]);

  const listingByItem = new Map<
    string,
    { platform_category_id: string | null; item_specifics_override: Record<string, string[]> | null }
  >();
  for (const l of (listingsRaw ?? []) as Array<{
    inventory_item_id: string;
    platform_category_id: string | null;
    item_specifics_override: Record<string, string[]> | null;
  }>) listingByItem.set(l.inventory_item_id, l);

  const itemById = new Map<
    string,
    { ebay_category_id: string | null; ebay_aspects: Record<string, string[]> | null }
  >();
  for (const it of (itemsRaw ?? []) as Array<{
    id: string;
    ebay_category_id: string | null;
    ebay_aspects: Record<string, string[]> | null;
  }>) itemById.set(it.id, it);

  // Fetch each distinct category's spec once.
  const specCache = new Map<string, AspectSpecRaw[]>();
  async function specFor(categoryId: string): Promise<AspectSpecRaw[]> {
    const hit = specCache.get(categoryId);
    if (hit) return hit;
    try {
      const resp = await getCategoryAspects(categoryId);
      const raw = (resp.aspects as Record<string, unknown>).aspects;
      const list = Array.isArray(raw) ? (raw as AspectSpecRaw[]) : [];
      specCache.set(categoryId, list);
      return list;
    } catch {
      specCache.set(categoryId, []);
      return [];
    }
  }

  const coverage: Record<string, AspectCoverage> = {};
  for (const itemId of itemIds) {
    const listing = listingByItem.get(itemId);
    const item = itemById.get(itemId);
    if (!listing && !item) continue; // not owned → omit
    const categoryId = listing?.platform_category_id ?? item?.ebay_category_id ?? null;
    if (!categoryId) continue;
    const aspects = listing?.item_specifics_override ?? item?.ebay_aspects ?? {};
    coverage[itemId] = recommendedAspectCoverage(await specFor(categoryId), aspects);
  }

  return c.json({ coverage });
});

// US-561: lightweight category → suggested Promoted Listings ad rate. The
// composer surfaces this as the default ad rate so "promote by default" stays
// transparent — the seller accepts, adjusts, or opts out before publish. Pure
// (no eBay round-trip), so it's cheap to call on every category change.
flipdeskEbayRoutes.get("/marketing/ad-rate-suggestion", (c) => {
  const categoryId = c.req.query("category_id") ?? null;
  return c.json({
    category_id: categoryId,
    suggested_rate_pct: suggestedAdRateForCategory(categoryId),
  });
});

// US-561: refresh the live Promoted Listings ad status + bid for the
// workspace's promoted listings (user-triggered "Refresh" on the promotions
// surface). Tenant-scoped to the workspace owner inside the lib helper.
flipdeskEbayRoutes.post("/marketing/promoted/sync", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const result = await syncPromotedListingsForOwner(userId);
  return c.json({ ok: true, ...result });
});

// US-1044: read-only promotions overview — the seller's promoted listings plus
// roll-up performance for the management surface. Tenant-scoped to the workspace
// owner. Performance is what we reliably hold locally (live ad status, bid %,
// and the Cost-Per-Sale ad fee that eBay charges only on an attributed sale);
// click/impression metrics require eBay's async ad-report task and aren't
// surfaced synchronously here.
flipdeskEbayRoutes.get("/marketing/promoted/overview", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, listing_title, listing_url, listing_price, listing_status, promo_status, promo_rate_pct, promo_ad_fees_cents, promo_synced_at",
    )
    .eq("user_id", userId)
    .eq("platform", "ebay")
    .not("promo_ad_id", "is", null)
    .order("promo_synced_at", { ascending: false, nullsFirst: false })
    .limit(200);
  const listings = (data ?? []) as unknown as PromotedListingRow[];
  return c.json({ listings, summary: summarizePromotedListings(listings) });
});

// eBay allows at most 24 pictures per listing (Inventory API product.imageUrls).
// Sending more returns error 25601 ("The size for ImageLinks cannot exceed …").
// Photos arrive sorted by sort_order, so capping keeps the cover + best shots.
// De-dup/cap logic lives in lib/publish-preflight.ts (US-473) so it's shared
// with the pre-flight blocker check and unit-tested in isolation.
function toEbayImageUrls(urls: Array<string | null | undefined>): string[] {
  return dedupeAndCapImages(urls).urls;
}

/// Resolves the PUBLIC URL eBay should fetch for an `item_photos` row, or null
/// when the photo can't (and must not) be exposed publicly. Existing rows that
/// already carry a public `photo_url` keep working; a sensitive row whose
/// `photo_url` is empty (private bucket) is skipped rather than turned into a
/// broken `item-photos` public URL that 404s — eBay can't fetch a short-TTL
/// signed URL anyway, so these simply aren't pushed (US-979).
/// US-2265: the rule now lives in `publicItemPhotoUrl` (lib/item-photo-storage.ts)
/// so eBay, Depop, Etsy and Shopify share ONE definition of "may this photo be
/// handed to a public marketplace" — the adapters had drifted into minting a
/// public URL for private-bucket tag photos. Kept as a named wrapper because the
/// call sites read as `.map(ebayPublicPhotoUrl)`.
function ebayPublicPhotoUrl(p: {
  photo_url: string | null;
  storage_path: string | null;
  photo_type?: string | null;
}): string | null {
  return publicItemPhotoUrl(p);
}

// US-473: HEAD-probe an image URL for the pre-publish reachability check. Short
// deadline; a thrown error (network/timeout) propagates so checkImageReachability
// can treat it as "reachable" (best-effort). Some CDNs reject HEAD with 405 —
// that's not a 404/410/403, so it's correctly treated as reachable.
async function headProbe(url: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetchWithTimeout(url, { method: "HEAD" }, 5_000);
  return { ok: res.ok, status: res.status };
}

export type PublishItemResult =
  | {
    ok: true;
    listing_id: string;
    listing_url: string;
    offer_id: string;
    sku: string;
    // US-783: the listing is live on eBay but the local DB sync didn't land;
    // a reconcile marker was recorded for the pull-sync. The caller reports
    // success, not a publish failure.
    sync_pending?: boolean;
  }
  | { ok: false; status: 400 | 404 | 422 | 500 | 502 | 503; body: Record<string, unknown> };

// Publish one owned item to eBay (inventory PUT → offer POST → publish POST).
// Parameterized by ownerId so both the authed /listings/push handler and the
// scheduled publish-due worker (US-322) reuse the identical flow. Returns a
// result union instead of an HTTP response so non-HTTP callers can use it.
export async function publishItemForOwner(
  ownerId: string,
  itemId: string,
  opts: { relist?: boolean } = {},
): Promise<PublishItemResult> {
  const ctx = await assemblePublishContext(ownerId, itemId);
  if (!ctx.ok) return { ok: false, status: ctx.status, body: ctx.error };
  if (ctx.blockers.length > 0 || !ctx.policies) {
    return {
      ok: false,
      status: 422,
      body: {
        ok: false,
        blockers: ctx.blockers.length > 0
          ? ctx.blockers
          : ["eBay business policies are not configured."],
      },
    };
  }

  const { item, listing, photos, policies, sku } = ctx;

  // Grade authority signal — TEXT ONLY (eBay-policy pivot). We never overlay a
  // badge or attach the QR "slab" onto listing PHOTOS — third-party-grading
  // marks / QR codes burned into images risk eBay account suspension. Instead
  // the grade rides in a "Condition Grade" item specific + a cert link in the
  // description, and buyers verify on the standalone /cert/:id lookup page.
  // Runs ONLY on the real publish path (not the per-load /listings/validate).
  // Mutates ctx.summary.aspects in place + returns the updated description, so
  // it reaches both the single-SKU and variation publish paths below.
  ctx.summary.description = await applyGradeListingPromotion(
    item,
    ctx.summary.aspects,
    ctx.summary.description,
  );

  // US-473: pre-publish image reachability. eBay fetches imageUrls server-side
  // at publish; an unreachable URL fails the whole publish with an opaque error
  // (and our proxy can surface a 502). HEAD-probe the URLs first and turn a
  // definitive 404/410/403 into a fixable blocker. Best-effort — transient
  // errors/timeouts are treated as reachable so a flaky CDN moment never blocks
  // a legitimate publish. Kept out of assemblePublishContext (called on every
  // composer load) so it only costs the actual publish path.
  const reach = await checkImageReachability(
    photos.map((p) => p.public_url),
    headProbe,
  );
  const reachBlocker = reachabilityBlocker(reach);
  if (reachBlocker) {
    return { ok: false, status: 422, body: { ok: false, blockers: [reachBlocker] } };
  }

  // Relist (end-old-then-relist): when the caller asks to relist, withdraw any
  // existing offer first so the publish below mints a brand-new listing id
  // instead of publishOrAdoptOffer (US-464) adopting a stale/removed one. eBay
  // only allows one live offer per SKU, so we end the old listing rather than
  // create a duplicate. We attempt the withdraw whenever an offer id exists —
  // NOT only when our local row still reads "active" — because a listing eBay
  // removed for a policy issue (or one the seller ended on eBay) can still read
  // active locally yet must be withdrawn before a fresh publish; conversely a
  // stale offer the row already thinks ended must still be cleared. An
  // already-not-live offer throws here, which is expected (isOfferAlreadyEnded);
  // only an unexpected/transient failure is worth logging loudly.
  if (opts.relist) {
    const { data: liveRow } = await supabaseAdmin
      .from("listings")
      .select("platform_offer_id, is_active, listing_status, marketplace_connection_id")
      .eq("inventory_item_id", itemId)
      .eq("platform", "ebay")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const live = liveRow as
      | {
        platform_offer_id: string | null;
        is_active: boolean | null;
        listing_status: string | null;
        marketplace_connection_id: string | null;
      }
      | null;
    if (live?.platform_offer_id) {
      try {
        // US-1507: withdraw via the OLD listing's own connection (null → primary).
        await withdrawOffer(
          ownerId,
          live.platform_offer_id,
          live.marketplace_connection_id ?? undefined,
        );
      } catch (err) {
        if (!isOfferAlreadyEndedError(err)) {
          // Unexpected failure — proceed anyway; publish will adopt rather than
          // mint a fresh listing, which the caller can re-run.
          console.warn(
            "[flipdesk-ebay] relist: withdrawOffer before re-publish failed (continuing):",
            err instanceof Error ? err.message : String(err),
          );
        }
        // Already-not-live offer → nothing to withdraw; continue to re-publish.
      }
    }
  }

  // 1. Ensure the SKU is persisted on the item so reconciliation works
  //    (eBay's "Custom label" maps back to this).
  if (sku !== item.sku) {
    await supabaseAdmin
      .from("inventory_items")
      .update({ sku })
      .eq("id", itemId);
  }

  try {
    // US-568: multi-variant listings take a separate publish path — each variant
    // is its own inventory_item (SKU) grouped into an inventory_item_group, then
    // published as ONE multi-variation listing. Returns early; the single-SKU
    // flow below never runs for variation listings.
    if (ctx.summary.variations) {
      return await publishVariationListing({
        ownerId,
        itemId,
        baseSku: sku,
        ctx,
        item,
        listing,
        photos,
        policies,
        variations: ctx.summary.variations,
      });
    }

    // 2. Push inventory_item (idempotent PUT). Quantity, aspects, and
    //    condition all come from the publish context, which already resolved
    //    listing-row edits ahead of inventory defaults (US-319/320/321).
    await createOrReplaceInventoryItem(ownerId, sku, {
      product: {
        title: ctx.summary.title,
        description: ctx.summary.description,
        aspects: ctx.summary.aspects,
        imageUrls: toEbayImageUrls(photos.map((p) => p.public_url)),
        // eBay requires a Brand+MPN product identifier (error 25002
        // <BrandMPN>). Default Brand to "Unbranded" and MPN to "Does Not
        // Apply" — the standard values for used items without a manufacturer
        // part number — so the offer publishes instead of being rejected.
        brand:
          typeof item.brand === "string" && item.brand.trim()
            ? item.brand.trim()
            : "Unbranded",
        mpn: "Does Not Apply",
        // US-1475: adopt the eBay Catalog product if one was matched (optional;
        // eBay ignores an absent epid, so this is safe when unset).
        epid:
          typeof (item as { ebay_epid?: string | null }).ebay_epid === "string"
            ? ((item as { ebay_epid?: string | null }).ebay_epid as string)
            : undefined,
      },
      condition: ctx.summary.condition,
      conditionDescription:
        ctx.summary.conditionDescription || undefined,
      availability: {
        shipToLocationAvailability: { quantity: ctx.summary.quantity },
      },
    });

    // US-562: build the shared bestOfferTerms once so the create and re-sync
    // paths send identical auto-accept/decline thresholds. Omitted entirely
    // when Best Offer is off. US-568: eBay does not allow Best Offer on auction
    // offers, so it's suppressed unless the format is FIXED_PRICE.
    const bestOfferTerms: BestOfferTerms | undefined = ctx.summary
      .bestOfferEnabled && ctx.summary.format === "FIXED_PRICE"
      ? {
          bestOfferEnabled: true,
          ...(ctx.summary.bestOfferAutoAccept
            ? {
                autoAcceptPrice: {
                  value: ctx.summary.bestOfferAutoAccept,
                  currency: ctx.summary.currency,
                },
              }
            : {}),
          ...(ctx.summary.bestOfferAutoDecline
            ? {
                autoDeclinePrice: {
                  value: ctx.summary.bestOfferAutoDecline,
                  currency: ctx.summary.currency,
                },
              }
            : {}),
        }
      : undefined;

    // US-568: build the pricingSummary for the resolved format. FIXED_PRICE
    // sends `price`; AUCTION sends `auctionStartPrice` (+ optional reserve and a
    // Buy It Now `price`). listingDuration is GTC for fixed-price, DAYS_n for
    // auctions (resolved in assemblePublishContext).
    const pricingSummary: PricingSummary =
      ctx.summary.format === "AUCTION"
        ? {
            auctionStartPrice: {
              value: ctx.summary.auctionStartPrice ?? ctx.summary.priceValue,
              currency: ctx.summary.currency,
            },
            ...(ctx.summary.auctionReservePrice
              ? {
                  auctionReservePrice: {
                    value: ctx.summary.auctionReservePrice,
                    currency: ctx.summary.currency,
                  },
                }
              : {}),
            ...(ctx.summary.auctionBuyItNowPrice
              ? {
                  price: {
                    value: ctx.summary.auctionBuyItNowPrice,
                    currency: ctx.summary.currency,
                  },
                }
              : {}),
          }
        : {
            price: {
              value: ctx.summary.priceValue,
              currency: ctx.summary.currency,
            },
          };
    const listingDuration = ctx.summary.auctionDuration;

    // 3. Create or reuse an offer for this SKU.
    const offerPolicies = {
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      paymentPolicyId: policies.paymentPolicyId,
      returnPolicyId: policies.returnPolicyId,
      ...(bestOfferTerms ? { bestOfferTerms } : {}),
    };
    const mintOffer = () =>
      createOffer(ownerId, {
        sku,
        marketplaceId: getMarketplaceId(),
        format: ctx.summary.format,
        availableQuantity: ctx.summary.quantity,
        categoryId: ctx.summary.categoryId,
        listingDescription: ctx.summary.description,
        listingDuration,
        listingPolicies: offerPolicies,
        pricingSummary,
        merchantLocationKey: policies.merchantLocationKey,
      });

    let offerId: string;
    try {
      const created = await mintOffer();
      offerId = created.offerId;
    } catch (err) {
      if (!isOfferAlreadyExistsError(err)) throw err;
      const existing = await listOffersForSku(ownerId, sku);
      const found = existing.find((o) => !!o.offerId);
      if (!found) throw err;
      offerId = found.offerId;

      // US-2641: an offer eBay has bound to a DEAD listing cannot be published
      // again. When a seller ends the listing on eBay's own site, the offer
      // survives still pointing at the ended listing, and every re-publish of it
      // answers 25001 "A system error has occurred. Internal Server Error" —
      // which is what a seller who ended a listing on eBay and then relisted from
      // FlipDesk actually got, four times in a row, with nothing that could ever
      // clear it. eBay's recovery is to destroy the offer and create a new one.
      //
      // listOffersForSku already returns the offer's status and its listing's, so
      // the check costs no extra call. It is narrow by construction: an offer that
      // simply failed to publish (a missing item specific) carries no listingId
      // and is left alone, so an ordinary rejection never churns the offer id.
      if (
        isOfferBoundToDeadListing({
          status: found.status,
          listing: {
            listingId: found.listingId ?? undefined,
            listingStatus: found.listingStatus ?? undefined,
          },
        })
      ) {
        console.warn(
          `[flipdesk-ebay] offer ${offerId} is bound to dead listing ` +
            `${found.listingId} (offer status ${found.status ?? "?"}, listing ` +
            `status ${found.listingStatus ?? "?"}) — recreating it before publish`,
        );
        // deleteOffer is destructive and would end a LIVE listing as a side
        // effect; isOfferBoundToDeadListing has just established this one is not
        // live, which is the guard its contract asks the caller to supply.
        try {
          await deleteOffer(ownerId, offerId, ctx.connectionId ?? undefined);
        } catch (delErr) {
          if (!isAlreadyDeletedError(delErr)) throw delErr;
        }
        const remade = await mintOffer();
        offerId = remade.offerId;
      } else {
        // The existing offer was created on an earlier attempt and may carry a
        // stale shipping policy / price / category (eBay 25007 keeps firing on
        // publish until the offer itself is corrected). Push the current draft +
        // selected policies onto it before publishing.
        await syncExistingOffer(ownerId, offerId, {
          availableQuantity: ctx.summary.quantity,
          categoryId: ctx.summary.categoryId,
          listingDescription: ctx.summary.description,
          listingDuration,
          listingPolicies: offerPolicies,
          pricingSummary,
          merchantLocationKey: policies.merchantLocationKey,
        });
      }
    }

    // 4. Publish — or ADOPT an already-published listing (US-464). If a prior
    //    attempt published this offer remotely but crashed before persisting
    //    the local listings row (step 5), publishOrAdoptOffer returns that live
    //    listingId instead of re-publishing, so a retry can't create a duplicate
    //    live listing.
    const published = await publishOrAdoptOffer(ownerId, offerId);
    const listingId = published.listingId;
    const url = ebayListingUrl(listingId);

    // 5. Persist the live state. Upsert the listings row so a re-publish
    //    of the same item points at the new eBay listingId. synced_to_ebay_at
    //    marks the draft as live (clears any prior publish failure).
    const listingPayload = {
      inventory_item_id: itemId,
      platform: "ebay" as const,
      // US-1077: published from FlipDesk → GradeThread-originated.
      listing_origin: "gradethread" as const,
      // US-1507: stamp the connection that published this so a later revise/end/
      // price acts via the SAME account even after the primary is switched.
      marketplace_connection_id: ctx.connectionId,
      platform_listing_id: listingId,
      platform_offer_id: offerId,
      // US-1999: PIN the SKU this went live under. Every later Inventory call
      // reads this instead of re-deriving from the seller-editable
      // inventory_items.sku, so renaming the item's SKU can no longer orphan
      // the live listing.
      inventory_sku: sku,
      platform_category_id: ctx.summary.categoryId,
      listing_url: url,
      listing_price: Number(ctx.summary.priceValue),
      listing_title: ctx.summary.title,
      listing_description: ctx.summary.description,
      listing_status: "active" as const,
      is_active: true,
      listed_at: new Date().toISOString(),
      synced_to_ebay_at: new Date().toISOString(),
      publish_error: null,
      publish_failed_at: null,
    };

    // US-2704: record the FIRST publish, here rather than at the wire.
    //
    // The wire-level funnel resolves a listing by inventory_sku or
    // platform_offer_id, and neither is on the listings row until the persist
    // below runs — createOrReplaceInventoryItem is step 2 and this is step 5.
    // So the snapshot inside that call correctly skips, and the ORIGINAL
    // description, which is the single most useful row this table will ever
    // hold, would never be recorded at all. Deferred until after persist for
    // the same reason: the row it attaches to has to exist first.
    const recordFirstPublish = () =>
      recordPublication(supabaseAdmin, {
        ownerUserId: ownerId,
        sku,
        offerId,
        description: ctx.summary.description,
        aspects: ctx.summary.aspects,
        price: Number(ctx.summary.priceValue),
      });

    // US-783: the listing is LIVE on eBay now. A failure on the local writes
    // below is NOT a publish failure — retry, then fall back to a reconcile
    // marker (the pull-sync adopts the orphan by SKU) and return success with
    // sync_pending. NEVER surface a publish error for an eBay-side success.
    const { syncPending } = await finalizePublishedListing({
      persist: async () => {
        if (listing?.id) {
          const { error } = await supabaseAdmin
            .from("listings")
            .update(listingPayload)
            .eq("id", listing.id);
          if (error) throw new Error(`listings update: ${error.message}`);
        } else {
          const { error } = await supabaseAdmin.from("listings").insert(listingPayload);
          if (error) throw new Error(`listings insert: ${error.message}`);
        }
        const { error: itemErr } = await supabaseAdmin
          .from("inventory_items")
          .update({ status: "listed" })
          .eq("id", itemId);
        if (itemErr) throw new Error(`inventory_items update: ${itemErr.message}`);
      },
      recordReconcile: async () => {
        // Snapshot the orphaned-but-live listing into the same table the pull-
        // sync + Reconciliation page use, so it's adopted on the next sync.
        await supabaseAdmin
          .from("flipdesk_ebay_listings")
          .upsert(
            {
              user_id: ownerId,
              ebay_item_id: listingId,
              custom_label: sku,
              title: ctx.summary.title,
              current_price: Number(ctx.summary.priceValue),
              listing_url: url,
              raw: { offerId, source: "publish_orphan", inventory_item_id: itemId },
              match_status: "unmatched",
              imported_at: new Date().toISOString(),
            },
            { onConflict: "user_id,ebay_item_id" },
          );
        console.error(
          `[flipdesk-ebay] publish ${listingId} is LIVE but local write failed — ` +
            `recorded reconcile marker; pull-sync will adopt it`,
        );
      },
    });

    // US-2704: now the listings row exists, so the snapshot has something to
    // attach to. Awaited rather than fire-and-forget: this is the row a dispute
    // pack is built from, and a publish is rare enough to pay one write for it.
    // recordPublication swallows its own failures by contract, so this cannot
    // turn a live listing into a failed publish.
    await recordFirstPublish();

    // US-932: the listing is live → record it to the internal event stream (the
    // drip trigger substrate), alongside existing analytics. Fire-and-forget;
    // first_listing is once-per-user (idempotent via dedupe_key).
    void emitEvent(ownerId, "listing_published", {
      properties: { listing_id: listingId, sku },
    });
    void emitEvent(ownerId, "first_listing", {
      dedupeKey: firstOccurrenceKey("first_listing", ownerId),
    });

    // US-561: attach an eBay Promoted Listings ad at the resolved rate (the
    // seller's accepted/adjusted rate, or the category suggestion) unless they
    // opted out. BEST-EFFORT — the listing is already live, so a Marketing API
    // failure records promo_status='failed' on the row but never fails publish.
    if (ctx.summary.promotedAdRate != null && ctx.summary.promotedAdRate > 0) {
      await attachPromotionAtPublish({
        userId: ownerId,
        listingRowId: listing?.id ?? null,
        ebayListingId: listingId,
        ratePct: ctx.summary.promotedAdRate,
        // US-1447: honour the listing's chosen promotion mode (CPS / CPC / Smart).
        mode: ctx.summary.promotedMode,
      });
    }

    // US-547: capture the seller-acceptance signal — diff the AI's generated
    // snapshot against the now-published (post-edit) values, attributed to the
    // listing_gen prompt version. Non-fatal; no-op for non-AI drafts.
    if (listing?.id) {
      await captureListingAcceptance(listing.id);
    }

    return {
      ok: true,
      listing_id: listingId,
      listing_url: url,
      offer_id: offerId,
      sku,
      sync_pending: syncPending,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // US-567: keep the raw eBay detail SERVER-SIDE (logs only) and surface a
    // short, actionable message mapped from eBay's structured error IDs.
    console.error("[flipdesk-ebay] publish failed:", msg);
    const ebayErrorIds = (err as { ebayErrorIds?: number[] }).ebayErrorIds;
    // Surface eBay's REAL reason (25002 is overloaded — "Inseam is missing" et al.)
    const fix = resolveEbayFix(err, EBAY_PUBLISH_GENERIC_FIX);
    const userMessage = fix.message;
    // US-321: persist the failure on the draft listing so the queue/UI can
    // surface "last failed: X" on reload, and US-325 retry can target it. Store
    // the user-facing message (not the raw eBay blob).
    if (listing?.id) {
      try {
        await supabaseAdmin
          .from("listings")
          .update({
            publish_error: userMessage.slice(0, 1000),
            publish_failed_at: new Date().toISOString(),
          })
          .eq("id", listing.id);
      } catch (logErr) {
        console.error("[flipdesk-ebay] could not persist publish_error:", logErr);
      }
    }
    return {
      // 422, NOT 5xx: a publish rejection (eBay 400, policy gap, etc.) is a
      // business failure, not a gateway error. Traefik/Coolify intercepts
      // gateway-class 5xx (502/503/504) with its own error page that strips
      // CORS headers, so the browser shows an opaque CORS error instead of the
      // real eBay message. 422 stays inside the app's CORS-handled path so the
      // dialog can surface `detail` to the seller.
      ok: false,
      status: 422,
      body: {
        ok: false,
        error: "Publish failed",
        // US-567: actionable mapped message (raw eBay detail stays in logs).
        detail: userMessage,
        ...(fix?.field ? { fix_field: fix.field } : {}),
        ...(ebayErrorIds && ebayErrorIds.length > 0
          ? { ebay_error_ids: ebayErrorIds }
          : {}),
      },
    };
  }
}

// US-568: publish a multi-variant (size/color) listing. Each variant becomes
// its own inventory_item (SKU) carrying the variation aspects; they're tied
// together by an inventory_item_group and published as ONE listing via
// publish_by_inventory_item_group. Mirrors publishItemForOwner's persistence so
// the local listings/inventory rows end up identical to a single-SKU publish.
async function publishVariationListing(args: {
  ownerId: string;
  itemId: string;
  baseSku: string;
  ctx: PublishContextOk;
  item: PublishItem;
  listing: PublishListing | null;
  photos: PublishPhoto[];
  policies: PolicySet;
  variations: ListingVariations;
}): Promise<PublishItemResult> {
  const { ownerId, itemId, baseSku, ctx, item, listing, photos, policies, variations } =
    args;
  const imageUrls = toEbayImageUrls(photos.map((p) => p.public_url));
  const brand =
    typeof item.brand === "string" && item.brand.trim()
      ? item.brand.trim()
      : "Unbranded";

  // Build the varies-by specification → value-set map from the variant matrix.
  const specValues = new Map<string, Set<string>>();
  for (const spec of variations.specifications) specValues.set(spec, new Set());
  for (const v of variations.variants) {
    for (const spec of variations.specifications) {
      const val = v.aspects[spec];
      if (val) specValues.get(spec)!.add(val);
    }
  }

  // 1. Create each variant inventory item. Its aspects = the shared aspects plus
  //    this variant's variation values (eBay needs the varies-by aspect present
  //    on every member item). availability = the per-variant quantity.
  const variantSkus: string[] = [];
  for (const variant of variations.variants) {
    const vSku = variantSku(baseSku, variant);
    variantSkus.push(vSku);
    const aspects: Record<string, string[]> = { ...ctx.summary.aspects };
    for (const [name, value] of Object.entries(variant.aspects)) {
      aspects[name] = [value];
    }
    await createOrReplaceInventoryItem(ownerId, vSku, {
      product: {
        title: ctx.summary.title,
        description: ctx.summary.description,
        aspects,
        imageUrls,
        brand,
        mpn: "Does Not Apply",
      },
      condition: ctx.summary.condition,
      conditionDescription: ctx.summary.conditionDescription || undefined,
      availability: {
        shipToLocationAvailability: { quantity: variant.quantity },
      },
    });
  }

  // 2. Group the variants. variesBy declares the buyer-selectable specs; we let
  //    the photo vary by "Color" when it's one of the specs.
  const specifications = variations.specifications.map((name) => ({
    name,
    values: [...(specValues.get(name) ?? [])],
  }));
  const colorSpec = variations.specifications.find((s) => /colou?r/i.test(s));
  await createOrReplaceInventoryItemGroup(ownerId, baseSku, {
    title: ctx.summary.title,
    description: ctx.summary.description,
    imageUrls,
    aspects: ctx.summary.aspects,
    variantSKUs: variantSkus,
    variesBy: {
      specifications,
      ...(colorSpec ? { aspectsImageVariesBy: [colorSpec] } : {}),
    },
  });

  // US-568: Best Offer terms are valid for variation (fixed-price) listings.
  const bestOfferTerms: BestOfferTerms | undefined = ctx.summary.bestOfferEnabled
    ? {
        bestOfferEnabled: true,
        ...(ctx.summary.bestOfferAutoAccept
          ? {
              autoAcceptPrice: {
                value: ctx.summary.bestOfferAutoAccept,
                currency: ctx.summary.currency,
              },
            }
          : {}),
        ...(ctx.summary.bestOfferAutoDecline
          ? {
              autoDeclinePrice: {
                value: ctx.summary.bestOfferAutoDecline,
                currency: ctx.summary.currency,
              },
            }
          : {}),
      }
    : undefined;

  // 3. One offer per variant SKU (price = per-variant override, else the base
  //    price). Reuse an existing offer on retry (offer-already-exists → sync).
  for (const variant of variations.variants) {
    const vSku = variantSku(baseSku, variant);
    const value =
      variant.price_cents != null
        ? centsToMoneyString(variant.price_cents)
        : ctx.summary.priceValue;
    const offerFields = {
      availableQuantity: variant.quantity,
      categoryId: ctx.summary.categoryId,
      listingDescription: ctx.summary.description,
      listingPolicies: {
        fulfillmentPolicyId: policies.fulfillmentPolicyId,
        paymentPolicyId: policies.paymentPolicyId,
        returnPolicyId: policies.returnPolicyId,
        ...(bestOfferTerms ? { bestOfferTerms } : {}),
      },
      pricingSummary: { price: { value, currency: ctx.summary.currency } },
      merchantLocationKey: policies.merchantLocationKey,
    };
    try {
      await createOffer(ownerId, {
        sku: vSku,
        marketplaceId: getMarketplaceId(),
        format: "FIXED_PRICE",
        ...offerFields,
      });
    } catch (err) {
      if (!isOfferAlreadyExistsError(err)) throw err;
      const existing = await listOffersForSku(ownerId, vSku);
      const found = existing.find((o) => !!o.offerId);
      if (!found) throw err;
      await syncExistingOffer(ownerId, found.offerId, offerFields);
    }
  }

  // 4. Publish the whole group as one multi-variation listing (adopt on retry).
  const published = await publishItemGroupOrAdopt(
    ownerId,
    baseSku,
    variantSkus,
    getMarketplaceId(),
  );
  const listingId = published.listingId;
  const url = ebayListingUrl(listingId);

  // 5. Persist. Quantity is the total across variants; price is the base price.
  const totalQuantity = variations.variants.reduce(
    (sum, v) => sum + v.quantity,
    0,
  );
  const listingPayload = {
    inventory_item_id: itemId,
    platform: "ebay" as const,
    // US-1077: published from FlipDesk → GradeThread-originated.
    listing_origin: "gradethread" as const,
    // US-1507: stamp the publishing connection (see single-SKU payload above).
    marketplace_connection_id: ctx.connectionId,
    platform_listing_id: listingId,
    // US-1999: for a multi-variation listing the pinned SKU is the BASE sku —
    // it is the inventory_item_group key, and each variant SKU is derived from
    // it by variantSku(). Pinning the base therefore pins every variant.
    inventory_sku: baseSku,
    platform_category_id: ctx.summary.categoryId,
    listing_url: url,
    listing_price: Number(ctx.summary.priceValue),
    listing_title: ctx.summary.title,
    listing_description: ctx.summary.description,
    listing_status: "active" as const,
    is_active: true,
    quantity: totalQuantity,
    listed_at: new Date().toISOString(),
    synced_to_ebay_at: new Date().toISOString(),
    publish_error: null,
    publish_failed_at: null,
  };

  const { syncPending } = await finalizePublishedListing({
    persist: async () => {
      if (listing?.id) {
        const { error } = await supabaseAdmin
          .from("listings")
          .update(listingPayload)
          .eq("id", listing.id);
        if (error) throw new Error(`listings update: ${error.message}`);
      } else {
        const { error } = await supabaseAdmin.from("listings").insert(listingPayload);
        if (error) throw new Error(`listings insert: ${error.message}`);
      }
      const { error: itemErr } = await supabaseAdmin
        .from("inventory_items")
        .update({ status: "listed" })
        .eq("id", itemId);
      if (itemErr) throw new Error(`inventory_items update: ${itemErr.message}`);
    },
    recordReconcile: async () => {
      await supabaseAdmin.from("flipdesk_ebay_listings").upsert(
        {
          user_id: ownerId,
          ebay_item_id: listingId,
          custom_label: baseSku,
          title: ctx.summary.title,
          current_price: Number(ctx.summary.priceValue),
          listing_url: url,
          raw: {
            source: "publish_orphan_variation",
            inventory_item_id: itemId,
            group_key: baseSku,
          },
          match_status: "unmatched",
          imported_at: new Date().toISOString(),
        },
        { onConflict: "user_id,ebay_item_id" },
      );
      console.error(
        `[flipdesk-ebay] variation publish ${listingId} is LIVE but local write ` +
          `failed — recorded reconcile marker; pull-sync will adopt it`,
      );
    },
  });

  // US-932: variation group is live → internal event stream (drip substrate).
  void emitEvent(ownerId, "listing_published", {
    properties: { listing_id: listingId, sku: baseSku },
  });
  void emitEvent(ownerId, "first_listing", {
    dedupeKey: firstOccurrenceKey("first_listing", ownerId),
  });

  if (ctx.summary.promotedAdRate != null && ctx.summary.promotedAdRate > 0) {
    await attachPromotionAtPublish({
      userId: ownerId,
      listingRowId: listing?.id ?? null,
      ebayListingId: listingId,
      ratePct: ctx.summary.promotedAdRate,
      // US-1447: honour the listing's chosen promotion mode (CPS / CPC / Smart).
      mode: ctx.summary.promotedMode,
    });
  }

  if (listing?.id) await captureListingAcceptance(listing.id);

  return {
    ok: true,
    listing_id: listingId,
    listing_url: url,
    offer_id: variantSkus[0] ?? baseSku,
    sku: baseSku,
    sync_pending: syncPending,
  };
}

flipdeskEbayRoutes.post("/listings/push", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { itemId, relist } = await readPushBody(c);
  if (!itemId) return c.json({ error: "inventory_item_id is required" }, 400);

  // US-382: enforce the active-listing cap server-side (was UI-only). Skip the
  // +1 when this exact item is ALREADY listed — a re-publish/revise of a live
  // listing must not be blocked or counted twice (the cap counts items in
  // status 'listed', which already includes it).
  const { data: existing } = await supabaseAdmin
    .from("inventory_items")
    .select("status")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  const alreadyListed = (existing as { status?: string } | null)?.status === "listed";
  const capGate = await requireFlipdesk(c, {
    capacity: { kind: "activeListings", delta: alreadyListed ? 0 : 1 },
    userId,
  });
  if (capGate) return capGate;

  const result = await publishItemForOwner(userId, itemId, { relist });
  if (!result.ok) return c.json(result.body, result.status);
  return c.json({
    ok: true,
    listing_id: result.listing_id,
    listing_url: result.listing_url,
    offer_id: result.offer_id,
    sku: result.sku,
    // US-783: true → the listing is live on eBay but the local sync is pending;
    // the UI should say "live, syncing shortly" rather than treat it as failed.
    sync_pending: result.sync_pending ?? false,
  });
});

// US-560: quantity-aware relist of a sold-out evergreen item. One call
// replenishes the listing quantity, reuses the existing eBay offer for the SKU,
// and republishes — so a seller never has to rebuild a listing from scratch.
//   • Replenish: bumps listings.quantity to the requested value (default 1,
//     floored at 1) so assemblePublishContext resolves availableQuantity > 0.
//   • Reuse the offer: publishItemForOwner({ relist: true }) ends a still-live
//     offer then re-publishes the SAME SKU offer via syncExistingOffer +
//     publishOrAdoptOffer (no duplicate offer).
//   • Never live at 0: the publish context floors quantity at 1, and we floor
//     the replenish target at 1, so a previously-sold item can't go live empty.
//   • Idempotent: publishOrAdoptOffer adopts an already-live listing and the
//     quantity write is a fixed set, so a retry converges to the same state.
// ── US-9118: the relist body, as a function ────────────────────────────────
//
// The HTTP handler below calls this, and lib/ebay-publish-port.ts registers it
// so the connector's relist tool runs the SAME guards. Sliced verbatim out of
// the handler; the capacity gate swapped requireFlipdesk for its context-free
// sibling, which resolves the plan identically and refuses with the same
// numbers.
//
// ⚠ THE ORDER MATTERS: the quantity is replenished BEFORE publishing, so the
// publish context resolves a non-zero availableQuantity. Calling
// publishItemForOwner({relist:true}) directly would relist at quantity zero.

type RelistOutcome = { status: number; body: Record<string, unknown> };

const relistJson = (
  body: Record<string, unknown>,
  status = 200,
): RelistOutcome => ({ status, body });
const relistOk = (body: Record<string, unknown>): RelistOutcome => relistJson(body, 200);

export async function relistOwnedListing(
  userId: string,
  listingId: string,
  replenishQty: number,
): Promise<RelistOutcome> {
  if (!isEbayConfigured()) {
    return relistJson({ error: "eBay is not configured on this server." }, 503);
  }
  const row = await loadListingOwned(listingId, userId);
  if (!row.ok) return { status: row.status, body: row.error as Record<string, unknown> };
  // US-1507: refuse to relist an eBay-ORIGINATED (imported) listing. The withdraw
  // needs a platform_offer_id we never have for imported rows, so the old live
  // listing would never end AND the re-publish would upsert onto this same row —
  // repurposing the mirror of a still-live eBay-native listing into a duplicate
  // GradeThread listing with a corrupted mirror. Mirror the revise guard (US-1080)
  // and the iOS-side hide, defense in depth.
  const relistOrigin = deriveListingOrigin({
    platform: "ebay",
    platform_listing_id: row.listing.platform_listing_id,
    batch_id: row.listing.batch_id,
    synced_to_ebay_at: row.listing.synced_to_ebay_at,
  });
  if (relistOrigin === "ebay") {
    return relistJson(
      {
        error:
          "This listing was created on eBay, not in FlipDesk, so it can't be relisted here. End it on eBay (or in FlipDesk) and create a fresh FlipDesk listing to sell it again.",
      },
      409,
    );
  }
  if (!row.listing.inventory_item_id) {
    return relistJson(
      { error: "This listing is not linked to an inventory item; cannot relist." },
      409,
    );
  }
  const itemId = row.listing.inventory_item_id;

  // Enforce the active-listing cap (mirrors /listings/push). A sold-out item is
  // no longer in 'listed' status, so relisting re-occupies a slot (+1); skip the
  // increment when this exact item is somehow still counted as listed.
  const { data: existing } = await supabaseAdmin
    .from("inventory_items")
    .select("status")
    .eq("id", itemId)
    .eq("user_id", userId)
    .maybeSingle();
  const alreadyListed = (existing as { status?: string } | null)?.status === "listed";
  // US-9118: the context-free sibling, so the connector's relist tool cannot be
  // the one entry point that skips the active-listing cap. Same resolution and
  // the same numbers requireFlipdesk would have refused with.
  const cap = await capacityAllowedForUser(userId, {
    kind: "activeListings",
    delta: alreadyListed ? 0 : 1,
  });
  if (!cap.allowed) {
    return {
      status: 402,
      body: {
        error: "CAP_REACHED",
        cap: cap.cap,
        used: cap.used,
        delta: cap.delta,
        limit: cap.limit,
        plan: cap.plan,
      },
    };
  }

  // Replenish the quantity on the draft listing row BEFORE publishing so the
  // publish context resolves the new availableQuantity for both the inventory
  // PUT and the (reused) offer. Idempotent — a fixed set, safe under retry.
  const { error: qtyErr } = await supabaseAdmin
    .from("listings")
    .update({ quantity: replenishQty })
    .eq("id", listingId);
  if (qtyErr) {
    console.error("[flipdesk-ebay] relist: quantity replenish failed:", qtyErr);
    return relistJson({ error: "Could not replenish listing quantity." }, 500);
  }

  const result = await publishItemForOwner(userId, itemId, { relist: true });
  if (!result.ok) return { status: result.status, body: result.body };
  return relistOk({
    ok: true,
    listing_id: result.listing_id,
    listing_url: result.listing_url,
    offer_id: result.offer_id,
    sku: result.sku,
    quantity: replenishQty,
    sync_pending: result.sync_pending ?? false,
  });
}

flipdeskEbayRoutes.post("/listings/:id/relist", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");

  let body: { quantity?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  // Respect an explicit replenish quantity; otherwise default to 1. Floor at 1
  // (non-positive / non-integer requests clamp up) so a republished
  // previously-sold item never goes live at quantity 0.
  const requested = Number(body.quantity);
  const replenishQty =
    Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1;

  const outcome = await relistOwnedListing(userId, listingId, replenishQty);
  return c.json(outcome.body, outcome.status as 200);
});

// US-528: how long a publish claim is honored before it's considered stale and
// reclaimable. Must exceed the realistic worst-case publish wall-time (eBay
// latency + the bounded publishOffer retries) so a still-running publish is
// never reclaimed, while a crashed one is eventually retried.
const PUBLISH_CLAIM_STALE_MS = 10 * 60_000;

// US-407: a publish-due tick claims a SMALL, bounded batch — not the whole
// backlog — so the run reliably finishes inside the 240s job-lock lease (each
// publish makes several sequential eBay calls; 100 of them serially would blow
// past the lease, the lock would expire mid-run, and the next tick would
// overlap). Bounding the batch keeps each invocation idempotent and short; the
// cron (every 5 min) drains any larger backlog over successive ticks. Sized so
// the worst case (PUBLISH_BATCH_LIMIT × worst-case publish wall-time) stays
// comfortably under the lease. Overridable for ops tuning.
const PUBLISH_BATCH_DEFAULT = 15;
export function publishBatchLimit(): number {
  const n = Number(Deno.env.get("PUBLISH_DUE_BATCH_LIMIT"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : PUBLISH_BATCH_DEFAULT;
}

// Scheduled publishing worker (US-322). Job-secret gated (no user token) like
// /oauth/refresh — a cron hits this periodically. Publishes every draft whose
// scheduled_publish_at is due and that isn't already live, AS the listing's
// owner. Not under authMiddleware (path is /jobs/*, not /listings/*).
// US-528: each due draft is atomically CLAIMED before publishing so an
// overlapping cron tick (e.g. when a publish runs longer than the cron
// interval) can't double-publish it.
flipdeskEbayRoutes.post("/jobs/publish-due", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // US-503: coarse overlap guard so a slow 5-min tick can't race the next one.
  // (Per-row publish_claimed_at claim-lock below — US-528 — is the resource-
  // level idempotency; this just stops a wasteful overlapping scan.) 4-min lease
  // < the 5-min cadence so a crashed run frees the lock before the next tick.
  const lock = await acquireJobLock("publish-due", 240);
  if (!lock.acquired) {
    return c.json({ skipped: true, reason: lock.reason, scanned: 0, published: 0 });
  }
  try {
  const now = new Date().toISOString();
  // US-528: a claim older than this is "stale" and reclaimable — covers a
  // publish whose container crashed/redeployed mid-run so the draft isn't
  // stranded. Must comfortably exceed the worst-case publish wall-time.
  const staleBefore = new Date(Date.now() - PUBLISH_CLAIM_STALE_MS).toISOString();
  // US-407: bound the scan to a small batch so the tick finishes within the
  // lock lease; the cron drains any larger backlog over successive ticks. We
  // fetch one extra row to cheaply detect whether more work remains.
  const batchLimit = publishBatchLimit();
  // Due = scheduled at/before now, not yet synced live, still a draft, and not
  // currently claimed by an in-flight tick. The lte filter already excludes
  // NULL scheduled_publish_at rows.
  const { data: dueRows, error } = await supabaseAdmin
    .from("listings")
    .select("id, inventory_item_id")
    .lte("scheduled_publish_at", now)
    .is("synced_to_ebay_at", null)
    .eq("listing_status", "draft")
    .or(`publish_claimed_at.is.null,publish_claimed_at.lt.${staleBefore}`)
    .order("scheduled_publish_at", { ascending: true })
    .limit(batchLimit + 1);
  if (error) {
    console.error("[flipdesk-ebay] publish-due scan failed:", error);
    return c.json({ error: "Scan failed" }, 500);
  }

  const allDue = (dueRows ?? []) as { id: string; inventory_item_id: string }[];
  // US-407: we asked for batchLimit+1; a full extra row means the backlog
  // exceeds one tick. Process only batchLimit this invocation; the next cron
  // tick picks up the rest. `more` lets ops/monitoring see the backlog draining.
  const more = allDue.length > batchLimit;
  const due = allDue.slice(0, batchLimit);
  if (due.length === 0) {
    return c.json({ scanned: 0, published: 0, failed: 0, skipped: 0, more: false });
  }

  // Resolve each item's owner (the publish must run as them).
  const itemIds = Array.from(new Set(due.map((d) => d.inventory_item_id)));
  const { data: itemRows } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id")
    .in("id", itemIds);
  const ownerByItem = new Map(
    ((itemRows ?? []) as { id: string; user_id: string }[]).map((r) => [r.id, r.user_id]),
  );

  let published = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of due) {
    const owner = ownerByItem.get(row.inventory_item_id);
    if (!owner) {
      failed += 1;
      continue;
    }

    // US-528: atomically claim the draft before publishing so a concurrent (or
    // next-tick) cron run can't publish the same row while this publish is
    // still in flight. Only the tick that wins this conditional update — which
    // re-checks the same eligibility predicate under a row lock — proceeds; the
    // claim flips publish_claimed_at to a FRESH timestamp (not the scan-time
    // `now`, which can be many minutes old on a long batch), so the claim is
    // honored for the full stale window from the moment it is taken.
    const claimedAt = new Date().toISOString();
    // US-1552: two sequential conditional updates, NOT `.or()` — the prod
    // PostgREST rejects logical operators on mutations (42703 from the
    // update-CTE alias), which silently skipped every claim.
    let { data: claimed, error: claimErr } = await supabaseAdmin
      .from("listings")
      .update({ publish_claimed_at: claimedAt })
      .eq("id", row.id)
      .eq("listing_status", "draft")
      .is("synced_to_ebay_at", null)
      .is("publish_claimed_at", null)
      .select("id")
      .maybeSingle();
    if (!claimErr && !claimed) {
      ({ data: claimed, error: claimErr } = await supabaseAdmin
        .from("listings")
        .update({ publish_claimed_at: claimedAt })
        .eq("id", row.id)
        .eq("listing_status", "draft")
        .is("synced_to_ebay_at", null)
        .lt("publish_claimed_at", staleBefore)
        .select("id")
        .maybeSingle());
    }
    if (claimErr) {
      console.error(
        `[flipdesk-ebay] scheduled-publish claim failed for listing ${row.id}: ${claimErr.message}`,
      );
      skipped += 1;
      continue;
    }
    if (!claimed) {
      skipped += 1;
      continue;
    }

    try {
      const result = await publishItemForOwner(owner, row.inventory_item_id);
      if (result.ok) {
        published += 1;
      } else {
        failed += 1;
        const b = result.body;
        const msg = (b.detail ?? b.error ??
          (Array.isArray(b.blockers) ? (b.blockers as string[]).join("; ") : "Publish failed")) as string;
        await supabaseAdmin
          .from("listings")
          .update({ publish_error: msg.slice(0, 1000), publish_failed_at: now })
          .eq("id", row.id);
      }
    } catch (err) {
      failed += 1;
      await supabaseAdmin
        .from("listings")
        .update({
          publish_error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
          publish_failed_at: now,
        })
        .eq("id", row.id);
    }
  }

  return c.json({ scanned: due.length, published, failed, skipped, more });
  } finally {
    await lock.release();
  }
});

// US-561: scheduled refresh of Promoted Listings ad status + bid. Walks every
// owner that has at least one live ad and syncs their promoted listings from the
// Marketing API, so the seller's post-publish "Promoted" surface reflects the
// current eBay adStatus. Job-secret gated (path is /jobs/*, not /listings/*).
flipdeskEbayRoutes.post("/jobs/promoted-sync", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("promoted-sync", 240);
  if (!lock.acquired) {
    return c.json({ skipped: true, reason: lock.reason, owners: 0 });
  }
  try {
    // Distinct owners with at least one live ad. The partial index
    // idx_listings_promo_active keeps this scan cheap.
    const { data: rows, error } = await supabaseAdmin
      .from("listings")
      .select("user_id")
      .eq("platform", "ebay")
      .not("promo_ad_id", "is", null)
      .limit(5000);
    if (error) {
      console.error("[flipdesk-ebay] promoted-sync owner scan failed:", error);
      return c.json({ error: "Scan failed" }, 500);
    }
    const owners = Array.from(
      new Set(((rows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
    );
    let scanned = 0;
    let updated = 0;
    for (const owner of owners) {
      try {
        const res = await syncPromotedListingsForOwner(owner);
        scanned += res.scanned;
        updated += res.updated;
      } catch (err) {
        console.warn(
          `[flipdesk-ebay] promoted-sync for owner ${owner} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return c.json({ owners: owners.length, scanned, updated });
  } finally {
    await lock.release();
  }
});

// Imports an eBay Seller Hub "Payouts" CSV into payout_imports. Server-side
// parse so we can validate, dedupe, and reuse the parser for future webhook
// ingestion. Idempotent — repeated uploads of the same export skip rows that
// already match (payout_id + amount + date) for this user.
//
// Body: { csv: string }  Response: { imported, skipped, duplicates }
flipdeskEbayRoutes.post("/payouts/import-csv", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { csv?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.csv !== "string" || body.csv.trim().length === 0) {
    return c.json({ error: "csv (string) is required" }, 400);
  }
  // Soft cap — eBay payouts exports rarely exceed a few hundred KB.
  if (body.csv.length > 5 * 1024 * 1024) {
    return c.json({ error: "CSV exceeds 5MB limit" }, 413);
  }

  const { headerFound, payouts, skipped } = parseEbayPayoutsCsv(body.csv);
  if (!headerFound) {
    return c.json(
      {
        error:
          "Could not find a payouts table in this CSV. Export the report from Seller Hub → Payments → Payouts → Download.",
      },
      400,
    );
  }
  if (payouts.length === 0) {
    return c.json({ imported: 0, skipped, duplicates: 0 });
  }

  try {
    const { inserted, duplicates } = await ingestPayoutsForUser(
      userId,
      payouts,
      "csv_upload",
    );
    // US-1054: a manual CSV import is still a payout-arrival event — notify the
    // user (in-app + push, preference-gated) so it reconciles like the webhook
    // path. Dedup in ingest means this only fires for genuinely new rows.
    if (inserted > 0) {
      void notifyPayoutImported(userId, { count: inserted });
    }
    return c.json({ imported: inserted, skipped, duplicates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] payouts import failed:", msg);
    return c.json({ error: "Failed to write payouts.", detail: msg }, 502);
  }
});

// Live comps for the composer's pricing panel. Uses the Browse API + app token
// (no seller OAuth needed). US-1060: a narrow search auto-broadens down a ladder
// (drop size → drop trailing title tokens → brand+category → category) until it
// clears a configurable minimum, and the returned set is tagged with how broad
// it is. Sold (realized) comps via Marketplace Insights are merged in and tagged
// when the grant is enabled (graceful no-op otherwise).
flipdeskEbayRoutes.get("/comps", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const categoryId = c.req.query("category_id")?.trim();
  if (!categoryId) {
    return c.json({ error: "category_id is required" }, 400);
  }
  const q = c.req.query("q") ?? undefined;
  const brand = c.req.query("brand") ?? undefined;
  const size = c.req.query("size") ?? undefined;
  const conditionId = c.req.query("condition_id") ?? undefined;
  // US-2245: the tag's style code, when the item has one. Adds a rung ABOVE
  // exact; absent, the ladder behaves exactly as it did before.
  const styleCode = c.req.query("style_code")?.trim() || undefined;
  // US-2974: which item these comps are FOR, when the caller knows. Optional,
  // because this endpoint is otherwise item-agnostic (it takes brand/size/
  // category, not an id) and is also used for loose lookups. When present it is
  // what lets the comp stage earn XP: repricing_suggestions only exists once an
  // item has a listing, so a comp run during drafting left no mark at all.
  const compItemId = c.req.query("item_id")?.trim() || undefined;
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  try {
    const minResults = await getSetting<number>(
      COMP_MIN_RESULTS_SETTING_KEY,
      DEFAULT_MIN_COMP_RESULTS,
    );
    const result = await searchCompsWithLadder(
      {
        categoryId,
        q,
        brand,
        size,
        conditionId,
        styleCode,
        limit: Number.isFinite(limit) ? limit : undefined,
      },
      { minResults },
    );
    // Stamp AFTER a successful search: a failed lookup is not a comp. Set-once
    // and tenant-scoped inside markComped, and best-effort — a rewards
    // bookkeeping problem must not cost the seller the comps they asked for.
    if (compItemId) {
      const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
      if (ownerId) await markComped(ownerId, compItemId);
    }
    return c.json(result);
  } catch (err) {
    console.error("[flipdesk-ebay] comps search failed:", err);
    return c.json({ error: "Comps search failed" }, 502);
  }
});

// ── US-673: Best offers + send-offer + buyer messages ───────────────
//
// All of these operate against the caller's OWN eBay account: the token is
// resolved from the workspace owner's connection (getUserAccessToken), so a
// caller can only ever read/respond to offers + messages on their own listings.
// No cross-tenant id is accepted from the body for reads, and respond/reply act
// against the caller's eBay account — there is no way to target another tenant.

// US-1507: map eBay platform listing ids → the local listing's connection id so
// negotiation mutations run under the account that owns each listing. Ids with
// no local row (created outside GradeThread) or a legacy null connection map to
// undefined → the primary connection, the pre-1507 behavior. Tenant-scoped.
async function connectionIdsByPlatformListingId(
  userId: string,
  platformListingIds: string[],
): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  if (platformListingIds.length === 0) return out;
  const { data } = await supabaseAdmin
    .from("listings")
    .select("platform_listing_id, marketplace_connection_id")
    .eq("user_id", userId)
    .eq("platform", "ebay")
    .in("platform_listing_id", platformListingIds);
  for (
    const row of (data ?? []) as Array<{
      platform_listing_id: string | null;
      marketplace_connection_id: string | null;
    }>
  ) {
    if (row.platform_listing_id) {
      out.set(row.platform_listing_id, row.marketplace_connection_id ?? undefined);
    }
  }
  return out;
}

// GET /negotiation/offers — incoming best offers across the seller's listings.
flipdeskEbayRoutes.get("/negotiation/offers", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const offers = await getBestOffers(userId);
    // US-2236 AC2: attach the item's acquisition cost so the counter UI can show
    // the resulting margin (a counter below break-even is otherwise invisible).
    // US-2816: this used to assert that the returned itemIds are necessarily
    // the seller's own listings. They are not - GetBestOffers also returns
    // offers this account SENT on OTHER people's listings, which is how a
    // seller came to be emailed their own $12 bid with an Accept button.
    // getBestOffers now drops those, so what arrives here is inbound only.
    // The cost lookup is still tenant-scoped via the
    // owner-verified parent (inventory_items.user_id — the loadListingOwned
    // pattern, US-268) as defence in depth. acquired_price is numeric(10,2)
    // dollars, matching the eBay offer/counter price units.
    const itemIds = [...new Set(offers.map((o) => o.itemId).filter(Boolean))];
    const costByItemId = new Map<string, number>();
    if (itemIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from("listings")
        .select("platform_listing_id, inventory_items!inner(user_id, acquired_price)")
        .eq("platform", "ebay")
        .in("platform_listing_id", itemIds)
        .eq("inventory_items.user_id", userId);
      type CostRow = {
        platform_listing_id: string | null;
        // PostgREST returns a to-one embed as an object, but supabase-js types it
        // as an array — accept either.
        inventory_items:
          | { acquired_price: number | null }
          | { acquired_price: number | null }[]
          | null;
      };
      for (const r of (rows ?? []) as unknown as CostRow[]) {
        const inv = Array.isArray(r.inventory_items)
          ? r.inventory_items[0]
          : r.inventory_items;
        const cost = inv?.acquired_price;
        if (r.platform_listing_id && typeof cost === "number") {
          costByItemId.set(r.platform_listing_id, cost);
        }
      }
    }
    // US-2939 + US-2941: the asking price at the time of the offer, and what
    // this seller already knows about the buyer. Both come from the local
    // record, so the page shows margin and buyer history without a second eBay
    // call — and the list price is the SNAPSHOT, not today's number.
    const listPrices = await loadListPricesByItemId(userId, itemIds);
    const buyerHistory = await loadBuyerHistory(
      userId,
      offers.map((o) => o.buyerUsername).filter((b): b is string => !!b),
      // The offers on screen right now are not "prior" — counting them would
      // tell every first-time buyer they had offered before.
      offers.map((o) => o.bestOfferId),
    );
    // Record what this read saw, so a seller who never leaves the Offers page
    // still builds the history the analytics is computed from.
    await recordOffers(
      userId,
      offers.map((o) => incomingOfferToInput(o, listPrices.get(o.itemId))),
    );
    const enriched = offers.map((o) => ({
      ...o,
      itemCost: costByItemId.get(o.itemId) ?? null,
      listPriceCents: listPrices.get(o.itemId) ?? null,
      buyerHistory: o.buyerUsername ? (buyerHistory.get(o.buyerUsername) ?? null) : null,
    }));
    return c.json({ offers: enriched });
  } catch (err) {
    console.error("[flipdesk-ebay] getBestOffers failed:", err);
    return c.json({ error: "Couldn't load best offers from eBay." }, 502);
  }
});

// POST /negotiation/offers/:bestOfferId/respond — accept / decline / counter.
// Body: { item_id, action, counter_price?, counter_quantity?, message? }
flipdeskEbayRoutes.post("/negotiation/offers/:bestOfferId/respond", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const bestOfferId = c.req.param("bestOfferId");
  let body: {
    item_id?: unknown;
    action?: unknown;
    counter_price?: unknown;
    counter_quantity?: unknown;
    message?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  const action = body.action as BestOfferAction;
  if (!itemId) return c.json({ error: "item_id is required" }, 400);
  if (action !== "Accept" && action !== "Decline" && action !== "Counter") {
    return c.json({ error: "action must be Accept, Decline, or Counter" }, 400);
  }
  let counterPrice: number | undefined;
  if (action === "Counter") {
    counterPrice = Number(body.counter_price);
    if (!Number.isFinite(counterPrice) || (counterPrice ?? 0) <= 0) {
      return c.json({ error: "counter_price must be a positive number" }, 400);
    }
  }
  try {
    // US-1507: respond via the connection that owns this listing when a local
    // row records it; unknown/legacy listings keep the primary connection.
    const connByListing = await connectionIdsByPlatformListingId(userId, [itemId]);
    await respondToBestOffer(userId, {
      itemId,
      bestOfferId,
      action,
      counterPrice,
      counterQuantity: Number.isFinite(Number(body.counter_quantity))
        ? Number(body.counter_quantity)
        : undefined,
      sellerMessage: typeof body.message === "string" ? body.message : undefined,
    }, connByListing.get(itemId));
    // US-1055: notify the owner that this offer was accepted/declined/countered.
    // Useful for workspace teams (a member may have responded) and for an audit
    // trail across devices. Deduped per (offer, action) so a retry can't double-
    // notify; tenant-scoped to the workspace owner. Best-effort — fire-and-forget.
    const responded: OfferAction =
      action === "Accept" ? "accepted" : action === "Decline" ? "declined" : "countered";
    // US-2939: record the outcome the moment we make it, rather than inferring
    // it later from a state eBay will have dropped. A countered offer also
    // becomes a row of its OWN — our counter is a distinct event from the bid
    // it answered, and the conversion figures divide by both.
    await recordOfferResponse(userId, bestOfferId, responded, {
      amountCents: counterPrice != null ? Math.round(counterPrice * 100) : null,
    });
    if (action === "Counter" && counterPrice != null) {
      await recordOffers(userId, [{
        direction: "counter_sent",
        externalOfferId: bestOfferId,
        itemExternalId: itemId,
        amountCents: Math.round(counterPrice * 100),
        state: "Countered",
      }]);
    }
    void (async () => {
      const fresh = await claimMarketplaceEvent(
        userId,
        "offer",
        bestOfferId,
        `responded:${responded}`,
        "offer_responded",
      );
      if (fresh) await notifyOfferResponded(userId, null, responded);
    })();
    return c.json({ ok: true, best_offer_id: bestOfferId, action });
  } catch (err) {
    console.error("[flipdesk-ebay] respondToBestOffer failed:", err);
    // US-1510: an offer that was accepted/declined/expired elsewhere (buyer
    // retracted, another device responded, timer ran out) is a STALE-VIEW
    // problem, not a server failure — return a machine-readable 409 so the
    // client can show "no longer open" and refresh its inbox.
    if (isBestOfferNotOpenError(err)) {
      return c.json({
        error:
          "This offer is no longer open — it may have expired or already been answered.",
        code: "offer_not_open",
      }, 409);
    }
    // US-1511: human-readable detail only (raw Trading blob stays in the log).
    return c.json({
      error: "eBay rejected the best-offer response.",
      detail:
        "eBay couldn't apply this response. Refresh the offers list and try again.",
    }, 502);
  }
});

// US-1510: Trading's RespondToBestOffer failure LongMessages for an offer that
// isn't actionable anymore. Message-based (the XML error ids aren't parsed onto
// the thrown error), so match the stable phrasings conservatively.
function isBestOfferNotOpenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no longer|expired|already (been )?(accepted|declined|countered|responded)|not (a )?valid best offer|invalid best offer|best offer .*(ended|closed)/i
    .test(msg);
}

// US-1510: the sell.negotiation scope is deliberately absent from the production
// consent (see getScopes in ebay-client.ts) — every /sell/negotiation call 403s
// there. Gate the send-offer surfaces on a distinct machine-readable code so
// clients can render "Not available yet" instead of round-tripping into a
// guaranteed failure. The feature reactivates automatically once the scope is
// re-added (US-1421) — this check reads the live scope list, not a flag.
const NEGOTIATION_UNAVAILABLE = {
  error:
    "Sending offers to interested buyers isn't available yet on this eBay connection.",
  code: "feature_unavailable" as const,
};

// US-1421: when the DEPLOYMENT requests the scope but THIS token still 403s,
// the token predates the grant — a re-consent fixes it, so the client gets a
// distinct code (and the connection is flagged, mirroring
// analytics_access_denied) instead of the dead-end "feature unavailable".
const NEGOTIATION_RECONNECT = {
  error:
    "Your eBay authorization predates the send-offers permission. Reconnect your eBay account to enable it.",
  code: "reconnect_required" as const,
};

// Pure body pick for a scope-403 — exported for tests.
export function negotiationScope403Body(deploymentHasScope: boolean) {
  return deploymentHasScope ? NEGOTIATION_RECONNECT : NEGOTIATION_UNAVAILABLE;
}

// US-1967 DECISION: sell.negotiation stays UNLICENSED on the production keyset
// (eBay gates it behind extra contracts, and requesting it fails the whole
// consent screen — see getScopes in ebay-client.ts). So send-offer is DEFERRED,
// not shipped-broken: clients must be able to learn the capability is off
// BEFORE rendering an entry point, rather than discovering it from a 501 after
// the seller taps. That's what this pure resolver + /negotiation/capabilities
// exist for. Re-licensing needs no client change — add the scope to EBAY_SCOPES
// and every gated surface reappears on its own.
export interface NegotiationCapability {
  send_offer_available: boolean;
  /** Machine-readable reason when unavailable; null when the feature works. */
  code: "feature_unavailable" | "reconnect_required" | null;
  /** Honest, seller-facing copy for the disabled state; null when available. */
  detail: string | null;
}

/**
 * Pure capability resolution — exported for tests.
 * - deployment lacks the scope  → permanently unavailable; nothing the seller
 *   can do, so the copy must NOT suggest reconnecting (that's the US-1967 bug:
 *   a misleading "reconnect" prompt for an unfixable state).
 * - deployment has it but THIS token 403'd → the token predates the grant, so a
 *   re-consent genuinely fixes it.
 */
export function negotiationCapability(
  deploymentHasScope: boolean,
  connectionDenied: boolean,
): NegotiationCapability {
  if (!deploymentHasScope) {
    return {
      send_offer_available: false,
      code: NEGOTIATION_UNAVAILABLE.code,
      detail: NEGOTIATION_UNAVAILABLE.error,
    };
  }
  if (connectionDenied) {
    return {
      send_offer_available: false,
      code: NEGOTIATION_RECONNECT.code,
      detail: NEGOTIATION_RECONNECT.error,
    };
  }
  return { send_offer_available: true, code: null, detail: null };
}

// GET /negotiation/capabilities — can this connection send offers to buyers?
// Cheap by design: reads the deployment scope list + the connection's sticky
// denial flag, and NEVER calls eBay — clients hit it on every inbox open to
// decide whether to render the send-offer entry point at all.
flipdeskEbayRoutes.get("/negotiation/capabilities", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let denied = false;
  try {
    // US-268: service role bypasses RLS — scope to the tenant explicitly.
    const { data } = await supabaseAdmin
      .from("marketplace_connections")
      .select("negotiation_access_denied")
      .eq("user_id", userId)
      .eq("marketplace", "ebay")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    denied = (data as { negotiation_access_denied: boolean | null } | null)
      ?.negotiation_access_denied === true;
  } catch (err) {
    // A flag-read hiccup must not fabricate availability — fall back to the
    // deployment-level answer, which is the one that matters in production.
    console.warn("[flipdesk-ebay] negotiation capability flag read failed:", err);
  }
  return c.json(negotiationCapability(isNegotiationScopeAvailable(), denied));
});

// US-1421: persist the per-connection denial (tenant-scoped; service role
// bypasses RLS — US-268). Best-effort: the 501 must reach the client even if
// the flag write hiccups.
async function markNegotiationDenied(userId: string, denied: boolean): Promise<void> {
  try {
    let q = supabaseAdmin
      .from("marketplace_connections")
      .update({ negotiation_access_denied: denied })
      .eq("user_id", userId)
      .eq("marketplace", "ebay");
    // Clearing is conditional so the common success path writes nothing.
    if (!denied) q = q.eq("negotiation_access_denied", true);
    await q;
  } catch (err) {
    console.warn("[flipdesk-ebay] negotiation_access_denied update failed:", err);
  }
}

// A runtime 403 from /sell/negotiation means THIS connection's token lacks the
// scope even though the deployment requests it (e.g. consented before the scope
// was added) — same client treatment as the deployment-level gate.
function isScopeForbidden(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 403;
}

// GET /negotiation/eligible — listings eligible for a send-offer-to-buyers.
flipdeskEbayRoutes.get("/negotiation/eligible", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  if (!isNegotiationScopeAvailable()) {
    return c.json(NEGOTIATION_UNAVAILABLE, 501);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const eligible = await findEligibleNegotiationItems(userId);
    const listingIds = eligible.map((it) => it.listingId);

    // Join eBay's eligible listingIds to local listings (by platform_listing_id)
    // for this tenant only (US-268: service-role bypasses RLS, so scope on
    // user_id) to recover the seller's real title, price and condition.
    const localByListingId = new Map<string, EligibleEnrichment>();
    if (listingIds.length > 0) {
      const { data: listingRows } = await supabaseAdmin
        .from("listings")
        .select(
          "inventory_item_id, platform_listing_id, listing_title, listing_price, ebay_condition",
        )
        .eq("user_id", userId)
        .eq("platform", "ebay")
        .in("platform_listing_id", listingIds);
      const rows = (listingRows ?? []) as Array<{
        inventory_item_id: string;
        platform_listing_id: string | null;
        listing_title: string | null;
        listing_price: number | null;
        ebay_condition: string | null;
      }>;

      // Thumbnail: first photo (by sort_order) for each matched item.
      const itemIds = Array.from(
        new Set(rows.map((r) => r.inventory_item_id).filter(Boolean)),
      );
      const imageByItemId = new Map<string, string | null>();
      if (itemIds.length > 0) {
        const { data: photoRows } = await supabaseAdmin
          .from("item_photos")
          .select("inventory_item_id, storage_path, photo_url, photo_type, photo_role, sort_order")
          .in("inventory_item_id", itemIds)
          .order("sort_order", { ascending: true });
        for (
          // US-1549: skip 'internal' photos so a reference shot (price tag)
          // never becomes the representative image.
          const p of filterEbayPhotos(
            (photoRows ?? []) as Array<{
              inventory_item_id: string;
              storage_path: string | null;
              photo_url: string | null;
              photo_type: string | null;
              sort_order: number;
            }>,
          )
        ) {
          // Keep only the first (lowest sort_order) photo per item.
          if (imageByItemId.has(p.inventory_item_id)) continue;
          imageByItemId.set(p.inventory_item_id, ebayPublicPhotoUrl(p));
        }
      }

      for (const r of rows) {
        if (!r.platform_listing_id) continue;
        localByListingId.set(r.platform_listing_id, {
          title: r.listing_title,
          price: r.listing_price,
          currency: "USD",
          imageUrl: imageByItemId.get(r.inventory_item_id) ?? null,
          condition: r.ebay_condition,
        });
      }
    }

    // Fall back to a Browse lookup for any eligible listing with no local row.
    const browseByListingId = new Map<string, EligibleEnrichment>();
    const unresolved = listingIds.filter((id) => !localByListingId.has(id));
    if (unresolved.length > 0) {
      const lookups = await Promise.all(
        unresolved.map((id) => getBrowseItemByLegacyId(id)),
      );
      unresolved.forEach((id, i) => {
        const b = lookups[i];
        if (b) browseByListingId.set(id, b);
      });
    }

    const items = enrichEligibleItems(eligible, localByListingId, browseByListingId);
    // US-1421: the scope works on this token — clear any stale denial flag.
    await markNegotiationDenied(userId, false);
    return c.json({ items });
  } catch (err) {
    console.error("[flipdesk-ebay] findEligibleNegotiationItems failed:", err);
    // US-1510/US-1421: a token without the scope. When the deployment DOES
    // request it, this token predates the grant → flag the connection +
    // tell the client to reconnect; otherwise it's the deployment-level gate.
    if (isScopeForbidden(err)) {
      await markNegotiationDenied(userId, true);
      return c.json(negotiationScope403Body(isNegotiationScopeAvailable()), 501);
    }
    return c.json({ error: "Couldn't load eligible listings from eBay." }, 502);
  }
});

// GET /negotiation/send-offer-today — US-2943. The morning list.
//
// find_eligible_items is on-demand, and the whole value of send-offer is that
// it reaches people ALREADY watching an item who have not pulled the trigger.
// A list nobody thinks to open is a feature that does not exist.
//
// A PROPOSAL. Nothing sends from here; the seller picks and presses, and the
// exposure figure below tells them the largest number that can come out of it.
//
// When the restricted scope is missing this returns 200 with a typed
// `unavailable` reason and the MARKDOWN FALLBACK in the same response, rather
// than a bare 501 — a seller who cannot send offers can still put those exact
// items in a sale, and making them go and find that out separately is how the
// feature reads as broken rather than as gated.
flipdeskEbayRoutes.get("/negotiation/send-offer-today", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const discountPct = Math.min(Math.max(Number(c.req.query("discount_pct")) || 10, 1), 60);

  const unavailable = (detail: string) =>
    c.json({
      available: false,
      detail,
      // The fallback, offered here rather than somewhere the seller has to go
      // and look for it.
      fallback: {
        kind: "markdown_sale",
        detail:
          "You can still put these items in a markdown sale, which reaches the same watchers.",
        href: "/dashboard/flipdesk/promotions",
      },
      candidates: [],
      suppressed: [],
    });

  if (!isNegotiationScopeAvailable()) {
    return unavailable(NEGOTIATION_UNAVAILABLE.error);
  }

  try {
    // The SAME assembly the daily digest uses. A digest that counted a
    // different set from the page it links to is worse than no digest — the
    // seller clicks through and the number does not match.
    const ranked = await loadRankedOfferCandidates(userId);
    await markNegotiationDenied(userId, false);
    return c.json({
      available: true,
      cooldownDays: OFFER_COOLDOWN_DAYS,
      discountPct,
      ...ranked,
      exposureCents: totalDiscountExposureCents(ranked.candidates, discountPct),
    });
  } catch (err) {
    if (isScopeForbidden(err)) {
      await markNegotiationDenied(userId, true);
      return unavailable(negotiationScope403Body(isNegotiationScopeAvailable()).error);
    }
    return failSafe(
      c,
      502,
      "Couldn't load today's offer candidates.",
      err,
      "ebay.offers.send_today",
    );
  }
});

// POST /negotiation/send-offer — send a discount offer to interested buyers.
// Body: { listing_ids: string[], discount_percentage?: string, message? }
flipdeskEbayRoutes.post("/negotiation/send-offer", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  if (!isNegotiationScopeAvailable()) {
    return c.json(NEGOTIATION_UNAVAILABLE, 501);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { listing_ids?: unknown; discount_percentage?: unknown; message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const listingIds = Array.isArray(body.listing_ids)
    ? body.listing_ids.filter((x): x is string => typeof x === "string")
    : [];
  if (listingIds.length === 0) {
    return c.json({ error: "listing_ids must be a non-empty array" }, 400);
  }
  try {
    // US-1507: group listings by their owning connection and send one offer batch
    // per account — a mixed multi-store selection otherwise pushes every offer
    // through the primary token and eBay rejects the foreign listings.
    const connByListing = await connectionIdsByPlatformListingId(userId, listingIds);
    const groups = new Map<string | undefined, string[]>();
    for (const id of listingIds) {
      const key = connByListing.get(id);
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    for (const [connectionId, ids] of groups) {
      await sendOfferToInterestedBuyers(userId, {
        listingIds: ids,
        discountPercentage:
          typeof body.discount_percentage === "string" ? body.discount_percentage : undefined,
        message: typeof body.message === "string" ? body.message : undefined,
      }, connectionId);
    }
    // US-1421: offers went out — the scope works; clear any stale denial flag.
    await markNegotiationDenied(userId, false);
    // US-2939/US-2943: record what went out. This is what powers the discount
    // curve AND the cooldown — without it tomorrow's list offers the same
    // watchers the same discount, which teaches them to wait.
    //
    // The offer id is eBay's listing id: send-offer answers with no per-offer
    // id of its own, and the unique key is (offer id, direction), so a re-send
    // after the cooldown updates the row rather than making a second one. That
    // is a known limit and it is why `lastOfferedAt` reads created_at.
    const discountPct = typeof body.discount_percentage === "string"
      ? Number(body.discount_percentage)
      : Number.NaN;
    const listPrices = await loadListPricesByItemId(userId, listingIds);
    await recordOffers(
      userId,
      listingIds.map((id) => {
        const listCents = listPrices.get(id) ?? null;
        return {
          direction: "offer_sent" as const,
          externalOfferId: id,
          itemExternalId: id,
          listPriceCents: listCents,
          amountCents: listCents != null && Number.isFinite(discountPct)
            ? Math.round(listCents * (1 - discountPct / 100))
            : null,
          state: "Sent",
        };
      }),
    );
    return c.json({ ok: true, count: listingIds.length });
  } catch (err) {
    console.error("[flipdesk-ebay] sendOfferToInterestedBuyers failed:", err);
    // US-1510/US-1421: pre-scope token → flag + reconnect vs deployment gate.
    if (isScopeForbidden(err)) {
      await markNegotiationDenied(userId, true);
      return c.json(negotiationScope403Body(isNegotiationScopeAvailable()), 501);
    }
    // US-1511: mapped/human detail only — the raw blob stays in the log above.
    return c.json({
      error: "eBay rejected the offer.",
      detail: ebayFailureDetail(
        err,
        "eBay declined to send this offer. The listing may no longer be eligible — refresh and try again.",
      ),
    }, 502);
  }
});

// GET /messages — buyer member-message inbox (last 30 days).
flipdeskEbayRoutes.get("/messages", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const messages = await getMemberMessages(userId);
    return c.json({ messages });
  } catch (err) {
    console.error("[flipdesk-ebay] getMemberMessages failed:", err);
    return c.json({ error: "Couldn't load messages from eBay." }, 502);
  }
});

// POST /messages/:messageId/reply — reply to a buyer message.
// Body: { item_id, recipient_id, body }
flipdeskEbayRoutes.post("/messages/:messageId/reply", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const messageId = c.req.param("messageId");
  let body: { item_id?: unknown; recipient_id?: unknown; body?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  const recipientId = typeof body.recipient_id === "string" ? body.recipient_id : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!itemId || !recipientId || !text) {
    return c.json({ error: "item_id, recipient_id, and body are required" }, 400);
  }
  try {
    await replyToMemberMessage(userId, {
      itemId,
      parentMessageId: messageId,
      recipientId,
      body: text,
    });
    return c.json({ ok: true, message_id: messageId });
  } catch (err) {
    console.error("[flipdesk-ebay] replyToMemberMessage failed:", err);
    return c.json({ error: "eBay rejected the reply.", detail: String(err) }, 502);
  }
});

// US-1968: bring EXISTING eBay (Trading-created) listings under management.
//
// Imported listings are read-only mirrors: revise/reprice/withdraw/relist all
// refuse origin='ebay'. bulk_migrate_listing converts them into managed
// Inventory offers. See lib/ebay-migrate.ts for why the returned SKU is the
// load-bearing part — flipping origin without persisting it produces a row that
// is marked managed, is NOT addressable by any Inventory call, and has ALSO
// stopped being refreshed by the inbound pull (SYNC_SOURCE_OF_TRUTH only lets
// the pull overwrite EBAY_OWNED_LISTING_FIELDS while origin='ebay'). That is
// strictly worse than the mirror it replaced, so origin and inventory_sku are
// written in the SAME update, and only when eBay returned a SKU.
flipdeskEbayRoutes.post("/listings/migrate", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");

  let body: { listing_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const requestedIds = Array.isArray(body.listing_ids)
    ? [...new Set(body.listing_ids.filter((v): v is string => typeof v === "string"))]
    : [];
  if (requestedIds.length === 0) {
    return c.json({ error: "listing_ids (array) is required" }, 400);
  }
  if (requestedIds.length > MIGRATE_MAX_PER_REQUEST) {
    return c.json(
      {
        error:
          `Too many listings in one request (max ${MIGRATE_MAX_PER_REQUEST}). ` +
          `Migrate in smaller batches.`,
      },
      400,
    );
  }

  // US-268: the ids come from the request body, so they are attacker input.
  // Scope the read by the OWNER's tenant and act only on what comes back —
  // never on the requested ids directly.
  const { data: rows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, platform_listing_id, platform_offer_id, listing_origin, listing_status, is_active, inventory_sku, marketplace_connection_id, batch_id, synced_to_ebay_at",
    )
    .in("id", requestedIds)
    .eq("platform", "ebay")
    .eq("user_id", userId);
  const owned = (rows ?? []) as Array<{
    id: string;
    platform_listing_id: string | null;
    platform_offer_id: string | null;
    listing_origin: string | null;
    listing_status: string | null;
    is_active: boolean | null;
    inventory_sku: string | null;
    marketplace_connection_id: string | null;
    batch_id: string | null;
    synced_to_ebay_at: string | null;
  }>;

  // US-268: if NONE of the requested ids belong to this tenant, deny outright
  // rather than returning 200 with a per-item "not found". Two reasons: a bulk
  // 200 makes a cross-tenant probe indistinguishable from a success at the
  // status level (the tenant-isolation suite asserts on status, and so would a
  // reviewer), and "you asked only for listings that aren't yours" genuinely is
  // a 404. A MIXED request still returns 200 with per-item reasons, because the
  // caller's own listings must not be held hostage to one bad id.
  if (owned.length === 0) {
    return c.json({ error: "Listing not found" }, 404);
  }

  const results: Array<{
    listing_id: string;
    status: "migrated" | "already_managed" | "skipped" | "failed";
    sku?: string | null;
    offer_id?: string | null;
    reason?: string;
  }> = [];

  // Eligibility, and the reason for each rejection — AC3 applies to OUR skips
  // just as much as to eBay's, otherwise a listing vanishes from the result
  // with no explanation of why it was never attempted.
  const eligible: typeof owned = [];
  for (const id of requestedIds) {
    const row = owned.find((r) => r.id === id);
    if (!row) {
      results.push({ listing_id: id, status: "skipped", reason: "Listing not found" });
      continue;
    }
    // Idempotency (AC4): a row already migrated is a no-op, not an error, so a
    // retry after a partial batch is safe and reports the same end state.
    if (row.inventory_sku && row.listing_origin !== "ebay") {
      results.push({
        listing_id: id,
        status: "already_managed",
        sku: row.inventory_sku,
        offer_id: row.platform_offer_id,
      });
      continue;
    }
    const origin = deriveListingOrigin({
      listing_origin: row.listing_origin,
      platform: "ebay",
      platform_listing_id: row.platform_listing_id,
      batch_id: row.batch_id,
      synced_to_ebay_at: row.synced_to_ebay_at,
    });
    if (origin !== "ebay") {
      results.push({
        listing_id: id,
        status: "skipped",
        reason:
          "This listing was published from FlipDesk and is already managed — migration only applies to listings created on eBay.",
      });
      continue;
    }
    if (!row.platform_listing_id) {
      results.push({
        listing_id: id,
        status: "skipped",
        reason: "No eBay listing id on this row, so there is nothing to migrate.",
      });
      continue;
    }
    const live = row.is_active === true ||
      row.listing_status === "active" ||
      row.listing_status === "relisted";
    if (!live) {
      results.push({
        listing_id: id,
        status: "skipped",
        reason: "Only ACTIVE eBay listings can be migrated.",
      });
      continue;
    }
    eligible.push(row);
  }

  // eBay caps the call at 5 listings; chunk and keep going on a batch error so
  // one bad batch cannot fail the rest.
  for (const batch of chunkForMigrate(eligible)) {
    const byEbayId = new Map(batch.map((r) => [r.platform_listing_id as string, r]));
    let outcomes: ReturnType<typeof parseMigrateResponse>;
    try {
      const raw = await bulkMigrateListing(
        userId,
        batch.map((r) => r.platform_listing_id as string),
        // Migrate through the connection that owns the listing (null → primary),
        // or a multi-store seller's migration lands on the wrong account.
        batch[0]?.marketplace_connection_id ?? undefined,
      );
      outcomes = parseMigrateResponse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[flipdesk-ebay] bulkMigrateListing failed:", err);
      for (const r of batch) {
        results.push({ listing_id: r.id, status: "failed", reason: msg.slice(0, 300) });
      }
      continue;
    }

    // A listing eBay simply omitted from responses[] must not disappear.
    const answered = new Set<string>();
    for (const outcome of outcomes) {
      const row = byEbayId.get(outcome.listingId);
      if (!row) continue; // not ours / not in this batch — ignore defensively
      answered.add(outcome.listingId);

      if (!outcome.ok || !outcome.sku) {
        results.push({
          listing_id: row.id,
          status: "failed",
          reason: outcome.reason ?? "eBay declined the migration.",
        });
        continue;
      }

      // The single write that makes the row managed. inventory_sku and the
      // origin flip travel TOGETHER — see this block's header.
      const { error: updErr } = await supabaseAdmin
        .from("listings")
        .update({
          inventory_sku: outcome.sku,
          ...(outcome.offerId ? { platform_offer_id: outcome.offerId } : {}),
          listing_origin: "gradethread" as const,
        })
        .eq("id", row.id)
        .eq("user_id", userId);
      if (updErr) {
        // eBay migrated it but we failed to record it. Say so precisely: the
        // listing IS an Inventory offer now, and a retry is safe because the
        // migration itself is idempotent on eBay's side.
        results.push({
          listing_id: row.id,
          status: "failed",
          reason:
            `Migrated on eBay (SKU ${outcome.sku}) but could not be saved locally: ` +
            `${updErr.message}. Retry — the migration is idempotent.`,
        });
        continue;
      }
      results.push({
        listing_id: row.id,
        status: "migrated",
        sku: outcome.sku,
        offer_id: outcome.offerId,
      });
    }
    for (const r of batch) {
      if (!answered.has(r.platform_listing_id as string)) {
        results.push({
          listing_id: r.id,
          status: "failed",
          reason: "eBay returned no result for this listing.",
        });
      }
    }
  }

  const summary = {
    migrated: results.filter((r) => r.status === "migrated").length,
    already_managed: results.filter((r) => r.status === "already_managed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
  return c.json({ ok: true, summary, results });
});

// ── Helpers ─────────────────────────────────────────────────────────

// Random URL-safe state token for CSRF + replay protection.
function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}


// ── Manage helpers ─────────────────────────────────────────────────

interface ListingRowForManage {
  id: string;
  inventory_item_id: string;
  // US-2166: the row's REAL marketplace. These routes live in the eBay
  // namespace but loadListingOwned does not filter by platform, so a non-eBay
  // listing id can reach them — and every origin gate below used to hardcode
  // "ebay", which derives the wrong provenance for such a row and can lock (or
  // fail to lock) the wrong fields. Carrying the actual value removes the
  // guess.
  platform: string | null;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  // The values that were actually published. A photos-only revise re-PUTs the
  // inventory_item, so we need the live title/description as the basis to
  // avoid silently reverting them to the inventory_items mirror.
  listing_title: string | null;
  listing_description: string | null;
  // US-1080: provenance signals so callers can derive listing_origin (eBay vs
  // GradeThread) and lock eBay-owned fields on eBay-originated listings.
  batch_id: string | null;
  synced_to_ebay_at: string | null;
  // US-1507: the connection that owns this listing (null on legacy/imported rows
  // → callers fall back to the primary connection) + the stored origin so the
  // relist guard can reject imported listings without re-deriving from signals.
  marketplace_connection_id: string | null;
  listing_origin: "ebay" | "gradethread" | null;
  // US-1978 (AC1): the multi-variant matrix (listings.variations) + the parent
  // item's SKU (== the inventory_item_group key at publish, US-568). A non-null
  // variations matrix means this is a GROUP listing, ended via
  // withdrawByInventoryItemGroup rather than the single-offer withdraw path.
  variations: ListingVariations | null;
  // US-1999: the item's CURRENT sku — the seller's item number, freely editable.
  // Do NOT address eBay with it; it may differ from what the listing went live
  // under. Kept only as the derivation input for pre-00477 rows.
  item_sku: string | null;
  // US-1999 (00477): the SKU this listing was PUBLISHED under. Authoritative
  // for every Inventory-API call — including the group-withdraw key, since the
  // inventory_item_group was created under the base SKU at publish time.
  inventory_sku: string | null;
}

type LoadListingResult =
  | { ok: true; listing: ListingRowForManage }
  | { ok: false; error: { error: string }; status: 404 | 403 };

// Loads a local listings row by id and verifies the user owns the parent
// inventory_item (the listings table doesn't have a user_id column).
// US-1504: the single "which price wins" rule at publish. An AutoLister draft's
// listing_price may be an AI ESTIMATE (no eBay comps); when the seller set a real
// target price, the TARGET wins over the estimate — otherwise we'd publish at the
// stale estimate ($25) after the seller chose $40. A non-estimate draft price
// (seller-edited in the composer) leads; target is the fallback. Returns null
// when neither is a usable (> 0) price.
export function resolvePublishPrice(
  listingPrice: number | null,
  priceIsEstimated: boolean,
  targetPrice: number | null,
): number | null {
  const listingUsable = listingPrice != null && listingPrice > 0;
  const targetUsable = targetPrice != null && targetPrice > 0;
  if (targetUsable && priceIsEstimated) return targetPrice;
  if (listingUsable) return listingPrice;
  if (targetUsable) return targetPrice;
  return null;
}

// US-1978 (AC1): decide HOW to end a listing from its persisted shape — the
// pure, unit-tested core of the DELETE /listings/:id branch. A variation listing
// (a publishable variations matrix + a group key) ends via
// withdrawByInventoryItemGroup; a single-SKU listing with a live offer ends via
// withdrawOffer; anything else ends locally only. GROUP is resolved FIRST because
// a variation listing carries NO platform_offer_id and would otherwise no-op live
// on eBay forever.
export type EndStrategy =
  | { kind: "group"; groupKey: string }
  | { kind: "offer"; offerId: string }
  | { kind: "local" };

// US-2395 AC2: which mechanism revises this listing.
//
// Deliberately the same shape and the same ORDER as resolveEndStrategy below —
// group FIRST. A multi-variation listing is published through
// publish_by_inventory_item_group and eBay never mints a platform_offer_id for
// it, so an offer-first resolver reads a group listing as having no mechanism at
// all. That is exactly the bug: revise 409'd with "no eBay offer id" on a
// listing that was never going to have one, which froze every variation listing
// the moment it went live.
//
// The group key is the PINNED listings.inventory_sku, not the item's current
// sku. The inventory_item_group was created under the base SKU at publish, so a
// later SKU rename would otherwise point the revise at a group that does not
// exist — the same reasoning US-1999 applied to the withdraw path.
//
// `kind: "none"` is NOT the same as end's `"local"`: ending locally is a
// meaningful outcome (the listing is closed in FlipDesk), whereas a revise with
// no mechanism has done nothing and must say so.
export type ReviseStrategy =
  | { kind: "group"; groupKey: string }
  | { kind: "offer"; offerId: string }
  | { kind: "none" };

/**
 * US-2395 AC1/AC3: push a revision through the inventory_item_group.
 *
 * The publish path (publishVariationListing) is the reference for the shapes
 * here, and this is deliberately NOT a call into it: publish CREATES offers and
 * writes a listings row, and a revise must do neither. What it shares is the
 * payload shape, so a variant item built here matches one built there.
 *
 * Order matters and is the same as publish. Variant items first, because the
 * group references them; the group second, because it carries what the buyer
 * reads (title, description, photos); the per-variant offers third, because
 * price and category live there and not on the item; the publish call last.
 *
 * THE PUBLISH CALL AT THE END IS THE UNVERIFIED PART, said plainly rather than
 * buried. For an already-published group, publish_by_inventory_item_group is
 * how eBay applies pending item and group changes, and it returns the same
 * listing id. If eBay instead rejects it as already published, the error
 * surfaces as a 422 with its own message rather than being swallowed — which is
 * the failure mode worth having, because the alternative is reporting success
 * on a listing that did not change. US-2395 AC7 is the check against a real
 * multi-variation listing, and it stays open until someone runs it.
 *
 * QUANTITY IS DELIBERATELY REFUSED. Quantity on a group is per variant; one
 * number applied to every variant would multiply the seller's stock by the
 * number of variants, silently. The response says so instead.
 */
async function reviseVariationGroup(args: {
  userId: string;
  listingId: string;
  groupKey: string;
  variations: ListingVariations;
  title: string;
  description: string;
  aspects: Record<string, string[]>;
  imageUrls: string[];
  condition: string;
  conditionDescription: string | undefined;
  brand: string;
  price: number | undefined;
  categoryId: string | undefined;
  listingDescription: string | undefined;
  quantityRequested: boolean;
  connectionId: string | undefined;
  localUpdates: Record<string, unknown>;
  photosSynced: boolean;
}): Promise<ReviseOneResult> {
  const {
    userId,
    listingId,
    groupKey,
    variations,
    title,
    description,
    aspects,
    imageUrls,
    condition,
    conditionDescription,
    brand,
    price,
    categoryId,
    listingDescription,
    quantityRequested,
    connectionId,
    localUpdates,
    photosSynced,
  } = args;

  const variantSkus: string[] = [];
  const specValues = new Map<string, Set<string>>();
  for (const spec of variations.specifications) specValues.set(spec, new Set());
  for (const v of variations.variants) {
    for (const spec of variations.specifications) {
      const val = v.aspects[spec];
      if (val) specValues.get(spec)!.add(val);
    }
  }

  try {
    // 1. Every variant item carries the shared edit plus its own variation
    //    values. eBay needs the varies-by aspect present on every member item,
    //    so the per-variant values are written LAST and win.
    for (const variant of variations.variants) {
      const vSku = variantSku(groupKey, variant);
      variantSkus.push(vSku);
      const variantAspects: Record<string, string[]> = { ...aspects };
      for (const [name, value] of Object.entries(variant.aspects)) {
        variantAspects[name] = [value];
      }
      await createOrReplaceInventoryItem(
        userId,
        vSku,
        {
          product: {
            title,
            description,
            aspects:
              Object.keys(variantAspects).length > 0 ? variantAspects : undefined,
            imageUrls,
            brand,
            mpn: "Does Not Apply",
          },
          condition,
          conditionDescription,
          availability: {
            shipToLocationAvailability: { quantity: variant.quantity },
          },
        },
        connectionId,
      );
    }

    // 2. The group is what the buyer actually reads.
    const specifications = variations.specifications.map((name) => ({
      name,
      values: [...(specValues.get(name) ?? [])],
    }));
    const colorSpec = variations.specifications.find((s) => /colou?r/i.test(s));
    await createOrReplaceInventoryItemGroup(userId, groupKey, {
      title,
      description,
      imageUrls,
      aspects,
      variantSKUs: variantSkus,
      variesBy: {
        specifications,
        ...(colorSpec ? { aspectsImageVariesBy: [colorSpec] } : {}),
      },
    });

    // 3. Price and category live on the per-variant offers, which were created
    //    at publish and whose ids we never stored — that absence is the whole
    //    reason this listing has no platform_offer_id. Look each one up by SKU.
    //    A variant with a per-variant price keeps it: a base-price edit must not
    //    flatten a deliberately-differentiated variant.
    if (price !== undefined || categoryId || listingDescription) {
      for (const variant of variations.variants) {
        const vSku = variantSku(groupKey, variant);
        const offers = await listOffersForSku(userId, vSku);
        const live = offers.find((o) => !!o.offerId);
        if (!live) continue;
        await updateOfferFields(
          userId,
          live.offerId,
          {
            price:
              price !== undefined && variant.price_cents == null ? price : undefined,
            listingDescription,
            categoryId,
          },
          connectionId,
        );
      }
    }

    // 4. Apply it. See the note above on why this call is the unverified part.
    await publishOfferByInventoryItemGroup(userId, groupKey, getMarketplaceId());
  } catch (err) {
    console.error("[flipdesk-ebay] variation group revise failed:", err);
    await persistReviseFailure(listingId, err);
    return jsonResult(
      {
        error: "eBay rejected the variation revision.",
        detail: ebayFailureDetail(err, EBAY_PUBLISH_GENERIC_FIX),
      },
      422,
    );
  }

  await clearReviseDrift(listingId);
  await supabaseAdmin
    .from("listings")
    .update({ synced_to_ebay_at: new Date().toISOString() })
    .eq("id", listingId);

  return jsonResult({
    ok: true,
    listing_id: listingId,
    updated: localUpdates,
    photos_synced: photosSynced,
    variation_group: groupKey,
    variants_pushed: variantSkus.length,
    ...(quantityRequested
      ? {
          quantity_skipped:
            "Quantity on a variation listing is per variant. Edit the variant " +
            "quantities and resubmit; one number here would have been applied " +
            "to every variant.",
        }
      : {}),
  });
}

export function resolveReviseStrategy(input: {
  variations: ListingVariations | null;
  itemSku: string | null;
  platformOfferId: string | null;
}): ReviseStrategy {
  if (input.variations && input.itemSku) {
    return { kind: "group", groupKey: input.itemSku };
  }
  if (input.platformOfferId) {
    return { kind: "offer", offerId: input.platformOfferId };
  }
  return { kind: "none" };
}

export function resolveEndStrategy(input: {
  variations: ListingVariations | null;
  itemSku: string | null;
  platformOfferId: string | null;
}): EndStrategy {
  if (input.variations && input.itemSku) {
    return { kind: "group", groupKey: input.itemSku };
  }
  if (input.platformOfferId) {
    return { kind: "offer", offerId: input.platformOfferId };
  }
  return { kind: "local" };
}

async function loadListingOwned(
  listingId: string,
  userId: string
): Promise<LoadListingResult> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, platform, platform_offer_id, platform_listing_id, listing_title, listing_description, batch_id, synced_to_ebay_at, marketplace_connection_id, listing_origin, variations, inventory_sku, inventory_items!inner(user_id, sku)"
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!data) {
    return { ok: false, error: { error: "Listing not found" }, status: 404 };
  }
  const row = data as unknown as ListingRowForManage & {
    inventory_items: { user_id: string; sku: string | null };
  };
  if (row.inventory_items.user_id !== userId) {
    return { ok: false, error: { error: "Listing not found" }, status: 404 };
  }
  return {
    ok: true,
    listing: {
      id: row.id,
      inventory_item_id: row.inventory_item_id,
      platform: row.platform,
      platform_offer_id: row.platform_offer_id,
      platform_listing_id: row.platform_listing_id,
      listing_title: row.listing_title,
      listing_description: row.listing_description,
      batch_id: row.batch_id,
      synced_to_ebay_at: row.synced_to_ebay_at,
      marketplace_connection_id: row.marketplace_connection_id,
      listing_origin: row.listing_origin,
      // US-1978 (AC1): coerce the persisted matrix so a group listing ends via
      // the group path; carry the parent SKU (the group key) for the withdraw.
      variations: normalizeVariations(row.variations),
      item_sku: row.inventory_items.sku,
      inventory_sku: row.inventory_sku,
    },
  };
}

// ── Publish-flow helpers ───────────────────────────────────────────

async function readItemId(
  c: Context<EbayEnv>
): Promise<string | null> {
  try {
    const body = (await c.req.json()) as { inventory_item_id?: unknown };
    return typeof body.inventory_item_id === "string"
      ? body.inventory_item_id
      : null;
  } catch {
    return null;
  }
}

// Push body reader that also surfaces the optional `relist` flag. The body can
// only be consumed once, so callers that need both fields use this instead of
// readItemId().
async function readPushBody(
  c: Context<EbayEnv>
): Promise<{ itemId: string | null; relist: boolean }> {
  try {
    const body = (await c.req.json()) as {
      inventory_item_id?: unknown;
      relist?: unknown;
    };
    return {
      itemId:
        typeof body.inventory_item_id === "string"
          ? body.inventory_item_id
          : null,
      relist: body.relist === true,
    };
  } catch {
    return { itemId: null, relist: false };
  }
}

interface PublishPhoto {
  id: string;
  public_url: string;
  sort_order: number;
}

interface PublishItem {
  id: string;
  user_id: string;
  title: string | null;
  brand: string | null;
  sku: string | null;
  size: string | null;
  description: string | null;
  condition_notes: string | null;
  target_price: number | null;
  grade_value: number | null;
  grade_label: string | null;
  // Public certificate URL, populated when a FlipDesk item is graded
  // (grading-pipeline.ts). Read by the cert-number promotion (text only —
  // US-2382 removed the last image treatment).
  certificate_url: string | null;
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  // US-825: per-aspect provenance parallel to ebay_aspects.
  ebay_aspect_sources: AspectSourceMap | null;
  item_category: string | null;
  color: string | null;
  material: string | null;
  style: string | null;
  // US-821 canonical attributes (jsonb). US-822 maps these onto eBay aspects.
  attributes: Record<string, string | string[]> | null;
  status: string;
}

// US-568: multi-variant matrix persisted in listings.variations (migration
// 00160). Mirrors src/types/database.ts ListingVariation(s).
interface ListingVariation {
  aspects: Record<string, string>;
  quantity: number;
  price_cents?: number | null;
  sku_suffix?: string | null;
}
// US-2166: exported so the eBay adapter can type the variation matrix it now
// receives on delist (a group listing has no offer id and must end by group key).
export interface ListingVariations {
  specifications: string[];
  variants: ListingVariation[];
}

// US-568: defensively coerce the persisted JSON into a usable variation matrix.
// Returns null when there is nothing publishable (no specs, fewer than 2
// variants, or every variant out of stock) so the publish path stays on the
// single-SKU flow. Drops malformed variants rather than failing the publish.
export function normalizeVariations(
  raw: ListingVariations | null | undefined,
): ListingVariations | null {
  if (!raw || typeof raw !== "object") return null;
  const specs = Array.isArray(raw.specifications)
    ? raw.specifications
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim())
    : [];
  if (specs.length === 0) return null;
  const variants = Array.isArray(raw.variants)
    ? raw.variants
      .map((v): ListingVariation | null => {
        if (!v || typeof v !== "object" || !v.aspects) return null;
        const aspects: Record<string, string> = {};
        for (const spec of specs) {
          const val = v.aspects[spec];
          if (typeof val === "string" && val.trim() !== "") {
            aspects[spec] = val.trim();
          }
        }
        // Every varies-by spec must have a value for this combination.
        if (Object.keys(aspects).length !== specs.length) return null;
        const quantity =
          typeof v.quantity === "number" && v.quantity > 0
            ? Math.floor(v.quantity)
            : 0;
        return {
          aspects,
          quantity,
          price_cents:
            typeof v.price_cents === "number" && v.price_cents > 0
              ? v.price_cents
              : null,
          sku_suffix:
            typeof v.sku_suffix === "string" && v.sku_suffix.trim() !== ""
              ? v.sku_suffix.trim()
              : null,
        };
      })
      .filter((v): v is ListingVariation => v !== null && v.quantity > 0)
    : [];
  // A "variation" listing needs at least two purchasable combinations.
  if (variants.length < 2) return null;
  return { specifications: specs, variants };
}

// US-568: derive a stable, eBay-safe SKU for one variant from the base SKU. Uses
// the explicit suffix when present, else a slug of the variation values.
export function variantSku(baseSku: string, variant: ListingVariation): string {
  const suffix =
    variant.sku_suffix ??
    Object.values(variant.aspects)
      .join("-")
      .replace(/[^a-zA-Z0-9-]+/g, "")
      .toUpperCase();
  return `${baseSku}-${suffix || "V"}`.slice(0, 50);
}

/**
 * US-2944: what the item behind a listing cost, in cents, owner-scoped.
 *
 * Read here rather than added to the PublishListing select because it is needed
 * on exactly one branch (best-offer enabled with an active rule) and widening
 * the publish query would make every publish pay for it.
 *
 * Null on any miss — an unknown cost means the margin floor does not apply at
 * publish time, and the offer runner still enforces it hourly. Assuming zero
 * would make the floor push the auto-accept to nothing.
 */
async function acquiredCostCentsForListing(
  ownerId: string,
  listingId: string | null,
): Promise<number | null> {
  if (!listingId) return null;
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("inventory_items!inner(user_id, acquired_price)")
    .eq("id", listingId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  if (error) {
    console.error("[flipdesk-ebay] acquired cost lookup:", error.message);
    return null;
  }
  const row = data as
    | {
      inventory_items:
        | { acquired_price: number | null }
        | { acquired_price: number | null }[]
        | null;
    }
    | null;
  const inv = Array.isArray(row?.inventory_items) ? row?.inventory_items[0] : row?.inventory_items;
  const cost = inv?.acquired_price;
  return typeof cost === "number" && Number.isFinite(cost) ? Math.round(cost * 100) : null;
}

interface PublishListing {
  id: string;
  // US-1999 (00477): the SKU eBay holds this listing under. Authoritative for
  // every Inventory call on an already-published listing — a relist must reuse
  // it rather than re-derive from the seller-editable inventory_items.sku.
  inventory_sku: string | null;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  // US-312/US-1504: true when listing_price is the AI ESTIMATE (no eBay comps),
  // not a seller-chosen price. At publish, a real item.target_price wins over an
  // estimate so we never list at a stale estimate after the seller set a target.
  price_is_estimated: boolean | null;
  // US-319/320/321: edits made in the composer/bulk editor must reach eBay.
  // These mirror the columns added in 00052_autolister_schema.sql.
  ebay_condition: string | null;
  ebay_condition_description: string | null;
  quantity: number | null;
  best_offer_enabled: boolean | null;
  // US-562 / US-2405: per-listing best-offer auto-clear thresholds (cents), set
  // by the seller by hand. Null means no threshold — the offer waits for them.
  best_offer_auto_accept_cents: number | null;
  best_offer_auto_decline_cents: number | null;
  // US-542 comp range used to derive best-offer thresholds when no override.
  price_range_low_cents: number | null;
  price_range_high_cents: number | null;
  platform_category_id: string | null;
  item_specifics_override: Record<string, string[]> | null;
  // US-825: per-aspect provenance parallel to item_specifics_override.
  item_specifics_sources: AspectSourceMap | null;
  scheduled_publish_at: string | null;
  // US-2382: badge_enabled (00027) and slab_image_mode (00180) are NOT read
  // here on purpose, and are no longer selected either. They were still in the
  // SELECT list after the 2026-06-25 policy retired the image treatment, and
  // that is precisely how US-2247 concluded "publish reads these columns" and
  // shipped a seller-facing switch that did nothing. Being fetched is not
  // being used; the cheapest way to stop that inference recurring is to stop
  // fetching them.
  // US-555: per-listing eBay business-policy overrides (bulk-assigned in the
  // AutoLister grid). When set they win over the account-level defaults at
  // publish; null falls back to the seller's default policy set. Column names
  // mirror listings.{shipping,payment,return}_policy_id (00052).
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  // US-561: Promoted Listings — promo_rate_pct is the seller's accepted/adjusted
  // ad rate (null → use the category suggestion); promo_opt_out turns promotion
  // off for this listing entirely.
  promo_rate_pct: number | null;
  promo_opt_out: boolean | null;
  // 00432: tri-state per-listing promotion override (NULL = inherit the seller
  // default users.promote_listings_by_default; true/false explicit).
  promote_override: boolean | null;
  // US-1447: per-listing Promoted-Listings mode ('cps'|'cpc'|'smart'); null →
  // seller default → cps.
  promo_mode: string | null;
  // US-568: format + auction terms + variation matrix (migration 00160).
  listing_format: string | null;
  auction_start_price_cents: number | null;
  auction_reserve_price_cents: number | null;
  auction_buy_it_now_price_cents: number | null;
  auction_duration: string | null;
  variations: ListingVariations | null;
  // US-1509: provenance + live-state signals so publish never repurposes a row
  // that mirrors an eBay-native listing (deriveListingOrigin inputs + is_active).
  listing_origin: string | null;
  listing_status: string | null;
  is_active: boolean | null;
  platform_listing_id: string | null;
  batch_id: string | null;
  synced_to_ebay_at: string | null;
}

interface PublishContextOk {
  ok: true;
  // US-1507: the eBay connection this publish resolves to (primary), persisted onto
  // the listings row so a later revise/end/price acts via the SAME account.
  connectionId: string;
  item: PublishItem;
  listing: PublishListing | null;
  photos: PublishPhoto[];
  // null when blockers includes a missing-policy entry. Push must re-check.
  policies: PolicySet | null;
  blockers: string[];
  // US-1890: non-blocking title-quality findings (duplicate tokens, ALL-CAPS,
  // promotional filler) for the composer to surface. Publish is not blocked.
  // US-1896 also folds picture-standards (hero <1600px zoom-disabled) warnings here.
  warnings: string[];
  // US-1896: hero-thumbnail reorder nudge ("your search thumbnail is a tag shot —
  // drag a full front view first"), or null when the first photo is a full view.
  photoNudge: string | null;
  // US-1895: how many of eBay's RECOMMENDED aspects (ranked by 30-day buyer
  // search volume) the listing fills — surfaced non-blocking in the composer.
  recommendedCoverage: AspectCoverage;
  // US-828: aspect values omitted from the eBay payload for value-validation
  // reasons, so the client can surface "X was not sent" (empty = nothing dropped).
  aspectDiagnostics: PublishAspectDiagnostic[];
  // US-1897: raw signals for the Listing Quality Score — NOT a score. They are
  // values this function already computes for blockers/warnings; surfacing them
  // structured keeps the scorer off string-matching the blocker array, which
  // would break silently the first time a message is reworded.
  qualitySignals: {
    titlePolicyViolations: string[];
    titleWarnings: string[];
    photoBlockers: string[];
    photoWarnings: string[];
    photoCount: number;
    categoryLeafStatus: "leaf" | "non_leaf" | "not_found" | "unverified";
    categoryWasSuggested: boolean;
    requiredMissing: string[];
  };
  sku: string;
  summary: {
    title: string;
    description: string;
    priceValue: string; // eBay wants string-typed money
    currency: string;
    condition: string;
    conditionDescription: string;
    categoryId: string;
    aspects: Record<string, string[]>;
    quantity: number;
    bestOfferEnabled: boolean;
    // US-562: best-offer auto-clear thresholds as eBay money strings, already
    // clamped to eBay's constraints (decline < accept < price). Null when no
    // valid threshold applies — Best Offer is still enabled, just unbounded.
    bestOfferAutoAccept: string | null;
    bestOfferAutoDecline: string | null;
    // US-561: effective Promoted Listings ad rate (%) to attach at publish, or
    // null when the listing shouldn't be promoted (00432: off by default unless
    // the per-listing override or the seller default opts in).
    promotedAdRate: number | null;
    // 00432: resolved Promoted Listings mode (listing choice → seller default →
    // cps). Only meaningful when promotedAdRate != null.
    promotedMode: "cps" | "cpc" | "smart";
    // US-568: listing format + auction terms (money as eBay strings) + the
    // variation matrix. format is "FIXED_PRICE" (default) or "AUCTION"; the
    // auction* values are only meaningful for AUCTION. variations is null for a
    // single-SKU listing.
    format: "FIXED_PRICE" | "AUCTION";
    auctionStartPrice: string | null;
    auctionReservePrice: string | null;
    auctionBuyItNowPrice: string | null;
    auctionDuration: string;
    variations: ListingVariations | null;
  };
}

interface PublishContextErr {
  ok: false;
  error: { error: string };
  status: 400 | 404 | 500 | 503;
}

type PublishContext = PublishContextOk | PublishContextErr;

// eBay getCategoryAspects raw aspect shape (subset we read).
interface AspectSpecRaw {
  localizedAspectName?: string;
  aspectConstraint?: {
    aspectRequired?: boolean;
    aspectMode?: string;
    itemToAspectCardinality?: string; // "SINGLE" | "MULTI"
    // US-1895: "REQUIRED" | "RECOMMENDED" | "OPTIONAL".
    aspectUsage?: string;
    // "STRING" (default) | "NUMBER" | "DATE". NUMBER aspects are mode
    // FREE_TEXT but eBay still parses the value as a number — see
    // aspect-reconcile.ts coerceNumericAspectValue.
    aspectDataType?: string;
  };
  aspectValues?: Array<{ localizedValue?: string }>;
  // US-1895: eBay's real 30-day buyer-search-volume ranking for the aspect.
  relevanceIndicator?: { searchCount?: number };
}

// US-1503: name -> allowedValues[] map ([] = free-text) from the raw category
// spec, the shape resolveMeasurementAspects (measurements.ts) expects. Mirrors
// ai-listing.ts extractAllowedAspects, which isn't exported.
export function allowedAspectsFromSpec(
  aspectList: AspectSpecRaw[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const a of aspectList) {
    const name = (a.localizedAspectName ?? "").trim();
    if (!name) continue;
    out[name] = (a.aspectValues ?? [])
      .map((v) => v.localizedValue ?? "")
      .filter((v) => v.length > 0);
  }
  return out;
}

// Normalize eBay's raw aspect spec into the registry's RegistryAspect shape.
function toRegistryAspects(aspectList: AspectSpecRaw[]): RegistryAspect[] {
  return aspectList.map((a) => ({
    name: a.localizedAspectName ?? "",
    mode: a.aspectConstraint?.aspectMode,
    multi: a.aspectConstraint?.itemToAspectCardinality === "MULTI",
    allowedValues: (a.aspectValues ?? [])
      .map((v) => v.localizedValue ?? "")
      .filter((v) => v.length > 0),
  }));
}

// Map an item's canonical fields (legacy columns + US-821 attributes) onto a
// category's aspects so we can fill required specifics without an AI pass.
// US-822: this is now a thin adapter over the single-source ASPECT_REGISTRY —
// it normalizes eBay's raw aspect shape into the registry's RegistryAspect and
// delegates the field→aspect mapping + SELECTION_ONLY validation to
// resolveItemAspects. Returns only aspects NOT already in `existing`; user-set
// values are never overwritten.
function deriveAspectsFromItem(
  item: PublishItem,
  aspectList: AspectSpecRaw[],
  existing: Record<string, string[]>,
): Record<string, string[]> {
  return resolveItemAspects(item, toRegistryAspects(aspectList), existing);
}

// US-1088+: the structured columns (brand/size/color/material/style) OWN their
// eBay aspects. Force the CURRENT column values onto the aspect map so a later
// edit on the main listing (e.g. changing Size) propagates to eBay instead of
// the stale value surviving (resolveItemAspects never overwrites). Column-backed
// aspects are overwritten or cleared; AI / manual / attribute aspects untouched.
// When the category's real aspect spec isn't available, falls back to the
// registry's default aspect names (FREE_TEXT) so the common fields still sync.
function forceColumnAspects(
  item: RegistryItem,
  aspectList: AspectSpecRaw[] | null,
  existing: Record<string, string[]>,
): Record<string, string[]> {
  const aspects: RegistryAspect[] =
    aspectList && aspectList.length > 0
      ? toRegistryAspects(aspectList)
      : COLUMN_ASPECT_FALLBACK;
  return applyColumnAspects(existing, item, aspects);
}

// Default aspect names for the column-backed fields, used when no category spec
// is loaded (mirrors the registry's first candidate for each column entry). All
// treated as FREE_TEXT so the raw column value is sent verbatim.
const COLUMN_ASPECT_FALLBACK: RegistryAspect[] = [
  { name: "Brand", mode: "FREE_TEXT", multi: false },
  { name: "Size", mode: "FREE_TEXT", multi: false },
  { name: "Color", mode: "FREE_TEXT", multi: false },
  { name: "Material", mode: "FREE_TEXT", multi: false },
  { name: "Style", mode: "FREE_TEXT", multi: false },
];

// eBay-policy: the grade authority signal is TEXT ONLY and contains NO links.
// Two hard rules eBay enforces here:
//   • No badge/QR overlay on listing PHOTOS (third-party-grading marks risk
//     account suspension) — handled by NOT attaching any graded image.
//   • No off-eBay LINKS in the listing — eBay treats a certificate URL in the
//     description as "offering to buy/sell outside eBay" and HIDES the listing
//     (observed policy hit, ref 2-106523659851). So we never put the cert URL in
//     the description, and we strip any that an older saved description carries.
// The grade rides in a "Condition Grade" item specific + the grade text the
// client template already wrote (which references the cert by NUMBER, not URL).
// Applied to EVERY graded item. Mutates `aspects` in place; returns the
// link-stripped description.
//
// US-1284: the field name + item-specific key come from the shared GradeThread
// Standard (lib/gt-grade-standard.ts) so eBay embeds the grade the same canonical
// way every other adapter does. eBay is the one platform that must NOT carry the
// off-site machine-readable marker (it bans off-eBay links), so the grade rides
// the structured "Condition Grade" aspect + the cert NUMBER instead.
export async function applyGradeListingPromotion(
  // Narrow structural type — the publish path passes a full PublishItem, the
  // revise + grade-resync paths pass their own row; all this reads is the grade
  // + cert url.
  item: Pick<PublishItem, "grade_value" | "certificate_url">,
  aspects: Record<string, string[]>,
  description: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  let out = stripCertLinks(description);
  if (item.grade_value == null) return out;

  const grade = formatGtGrade(item.grade_value);

  // Item specific, e.g. "Condition Grade = GradeThread 9.5". Structured + shows
  // in the eBay spec table. On the publish path we never overwrite a value the
  // seller already set. US-1502: a grade RESYNC (opts.force) must overwrite it —
  // a grade earned after list-first, or a DOWNGRADED human re-review, has to
  // replace whatever (possibly overstated) value is live so we never leave an
  // inflated Condition Grade on eBay.
  const gradeSpecific = `${GT_GRADE_FIELD_NAME.replace(" Grade", "")} ${grade}`;
  if (opts.force || !aspects[GT_GRADE_ITEM_SPECIFIC]?.length) {
    aspects[GT_GRADE_ITEM_SPECIFIC] = [gradeSpecific];
  }

  // PSA-style certificate NUMBER as plain text — never a URL (eBay bans off-eBay
  // links). Buyers type it into /verify themselves. Ensure the report has a
  // number (lazy backfill), then make sure the description carries "Cert #...".
  const certId = certificateIdFromUrl(item.certificate_url);
  if (certId) {
    const number = await ensureCertificateNumber(certId);
    if (number && !out.includes(number)) out = appendCertNumber(out, grade, number);
  }
  return out;
}

// US-1502: push the current grade onto an item's LIVE GradeThread-origin eBay
// listing — the "Condition Grade" item specific + the "Cert #…" description line.
// Fired best-effort from the grading finalize path (grading-pipeline.ts
// applyTerminalCompletion) whenever a grade LANDS or is CORRECTED (incl. a human
// DOWNGRADE), so a list-first-then-grade item — or a re-review — never leaves an
// absent/overstated grade live. No-op unless the item has an active GT-origin
// listing (a real platform_offer_id, not an eBay-imported mirror) and a grade.
// MUST stay best-effort at the call site — a resync failure must never break
// grade completion.
export async function resyncGradeToLiveListing(
  userId: string,
  itemId: string,
): Promise<{ resynced: boolean; reason?: string }> {
  // 1) Guard: item exists, owned, graded.
  const { data: itemRow } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, size, color, material, style, item_category, attributes, sku, description, condition_notes, grade_value, grade_label, certificate_url, ebay_aspects, ebay_category_id",
    )
    .eq("id", itemId)
    .maybeSingle();
  const item = itemRow as
    | (Record<string, unknown> & { user_id: string; grade_value: number | null })
    | null;
  if (!item || item.user_id !== userId) {
    return { resynced: false, reason: "item_not_found" };
  }
  if (item.grade_value == null) return { resynced: false, reason: "no_grade" };

  // 2) Guard: an ACTIVE GradeThread-origin listing with a real offer id. eBay-
  //    imported listings (no offer id / listing_origin "ebay") are read-only
  //    mirrors — never push to them.
  const { data: listingRow } = await supabaseAdmin
    .from("listings")
    .select(
      "id, listing_title, platform_offer_id, platform_category_id, item_specifics_override, ebay_condition, ebay_condition_description, listing_description, listing_status, listing_origin, marketplace_connection_id, inventory_sku",
    )
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .not("platform_offer_id", "is", null)
    .in("listing_status", ["active", "relisted"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const listing = listingRow as
    | {
        id: string;
        listing_title: string | null;
        platform_offer_id: string | null;
        platform_category_id: string | null;
        item_specifics_override: Record<string, unknown> | null;
        ebay_condition: string | null;
        ebay_condition_description: string | null;
        listing_description: string | null;
        listing_status: string | null;
        listing_origin: string | null;
        marketplace_connection_id: string | null;
        // US-1999 (00477): the SKU this listing went live under.
        inventory_sku: string | null;
      }
    | null;
  if (!listing?.platform_offer_id) {
    return { resynced: false, reason: "no_live_listing" };
  }
  if (listing.listing_origin === "ebay") {
    return { resynced: false, reason: "ebay_origin" };
  }

  const offerId = listing.platform_offer_id;
  const categoryId = listing.platform_category_id ??
    (item.ebay_category_id as string | null) ?? null;

  // 3) Rebuild the aspect map from the columns (US-1088), then FORCE-assert the
  //    grade specific over whatever is live (US-1502 overwrite).
  const baseAspects = normalizeAspectMap(
    listing.item_specifics_override ??
      (item.ebay_aspects as Record<string, unknown> | null),
  );
  let aspectList: AspectSpecRaw[] | null = null;
  if (categoryId) {
    try {
      const resp = await getCategoryAspects(categoryId);
      const raw = (resp.aspects as Record<string, unknown>).aspects;
      if (Array.isArray(raw)) aspectList = raw as AspectSpecRaw[];
    } catch (err) {
      console.warn(
        "[flipdesk-ebay] grade-resync aspect spec fetch (non-blocking):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const aspects = forceColumnAspects(
    item as unknown as RegistryItem,
    aspectList,
    baseAspects,
  );

  // 4) Promote the CURRENT live/mirror description with the cert line.
  const baseDesc = (
    listing.listing_description ??
    (item.description as string | null) ??
    (item.title as string | null) ??
    ""
  ).trim();
  const promotedDesc = await applyGradeListingPromotion(
    {
      grade_value: item.grade_value,
      certificate_url: item.certificate_url as string | null,
    },
    aspects,
    baseDesc,
    { force: true },
  );

  // 5) Condition (same rule as publish/revise) + photos for the full re-PUT
  //    (createOrReplaceInventoryItem REPLACES the item, so we send full state).
  let condition = listing.ebay_condition?.trim() ||
    mapEbayCondition(item.grade_value, item.grade_label as string | null);
  if (categoryId) {
    try {
      const { conditionIds } = await getItemConditionPolicies(categoryId);
      // US-1894: apparel-aware resolve + allow-list remap; explicit value wins.
      const remapped = resolveEbayCondition({
        explicit: listing.ebay_condition,
        grade: item.grade_value,
        label: item.grade_label as string | null,
        allowedConditionIds: conditionIds,
      });
      if (remapped && remapped !== condition) condition = remapped;
    } catch { /* best-effort — leave the resolved condition */ }
  }
  const conditionDescription =
    (listing.ebay_condition_description ??
      (item.condition_notes as string | null) ??
      "").trim() || undefined;

  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    .select("storage_path, photo_url, photo_type, photo_role, sort_order")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });
  // US-1549: 'internal' photos (price tags, receipts) never go to eBay.
  const imageUrls = toEbayImageUrls(
    filterEbayPhotos(
      (photoRows ?? []) as Array<{
        storage_path: string | null;
        photo_url: string | null;
        photo_type: string | null;
      }>,
    ).map(ebayPublicPhotoUrl),
  );

  // US-1999: re-PUT the inventory item eBay actually has, not whatever the
  // seller's item number says today. This path is automated (it fires on grade
  // completion), so a mismatch here would silently create orphan inventory
  // items with no human in the loop to notice.
  const sku = resolveInventorySku(listing, { id: itemId, sku: item.sku as string | null });
  const finalTitle = (
    listing.listing_title ?? (item.title as string | null) ?? ""
  ).trim();

  // 6) Push to eBay. On failure, persist it on the listing (US-1079 retry banner)
  //    and report back — the caller keeps grade completion succeeding regardless.
  try {
    // US-1507: push via the listing's own connection (null → primary).
    const connId = listing.marketplace_connection_id ?? undefined;
    await createOrReplaceInventoryItem(userId, sku, {
      product: {
        title: finalTitle,
        description: promotedDesc,
        aspects: Object.keys(aspects).length > 0 ? aspects : undefined,
        imageUrls,
        brand:
          typeof item.brand === "string" && (item.brand as string).trim()
            ? (item.brand as string).trim()
            : "Unbranded",
        mpn: "Does Not Apply",
      },
      condition,
      conditionDescription,
      availability: { shipToLocationAvailability: { quantity: 1 } },
    }, connId);
    await updateOfferFields(userId, offerId, {
      listingDescription: promotedDesc,
      categoryId: categoryId ?? undefined,
    }, connId);
  } catch (err) {
    console.error("[flipdesk-ebay] grade-resync eBay push failed:", err);
    await persistReviseFailure(listing.id, err);
    return { resynced: false, reason: "ebay_error" };
  }

  // 7) Persist the rebuilt aspects + promoted description so the composer and the
  //    next publish/revise stay in sync.
  await supabaseAdmin
    .from("listings")
    .update({ item_specifics_override: aspects, listing_description: promotedDesc })
    .eq("id", listing.id);
  await supabaseAdmin
    .from("inventory_items")
    .update({ ebay_aspects: aspects })
    .eq("id", itemId);

  return { resynced: true };
}

// Extract the certificate_id (UUID) from a "<site>/cert/<id>" URL.
function certificateIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/cert\/([^/?#]+)/);
  return m?.[1] ?? null;
}

// Place "— Cert #GT-XXXXX" right after the "Condition Grade <n>" phrase the
// template wrote; if the description has no grade line, append a fresh one.
function appendCertNumber(
  description: string,
  grade: string,
  number: string,
): string {
  const re = new RegExp(`(Condition Grade\\s*${grade.replace(".", "\\.")})`);
  if (re.test(description)) return description.replace(re, `$1 — Cert #${number}`);
  const line = `Graded by GradeThread — Condition Grade ${grade} — Cert #${number}`;
  return description.trim() ? `${description.trim()}\n\n${line}` : line;
}

// Remove any off-eBay GradeThread link from a listing description so a
// published eBay listing never trips the off-eBay-links policy — covers the
// old template line ("View the full condition certificate: <url>"), any bare
// /cert/ URL, AND the US-1126 verified-seller credential block that older
// AutoLister generations embedded WITH an <a href> to /verified/<handle>
// (current generations are link-free, but stored drafts still carry it and
// eBay hides listings over it). Exported for tests.
export function stripCertLinks(description: string): string {
  return (
    description
      // Legacy linked credential block: drop the anchor entirely — "See every
      // verified grade ↗" is meaningless without its link. Non-greedy so only
      // the anchor goes, not the rest of the block (name + stats stay).
      .replace(
        /<a\b[^>]*href="[^"]*gradethread\.com\/verified\/[^"]*"[^>]*>.*?<\/a>/gis,
        "",
      )
      // Any other anchor pointing off-eBay at gradethread.com: unwrap to its
      // text so no URL survives in the markup.
      .replace(
        /<a\b[^>]*href="[^"]*gradethread\.com[^"]*"[^>]*>(.*?)<\/a>/gis,
        "$1",
      )
      .replace(/^.*View the full condition certificate:.*$/gim, "")
      .replace(/^.*https?:\/\/\S*\/cert\/\S*.*$/gim, "")
      // Bare /verified/ profile URLs in plain-text descriptions (the old
      // plain-variant "See every verified grade: <url>" line).
      .replace(/^.*See every verified grade:.*$/gim, "")
      .replace(/https?:\/\/\S*gradethread\.com\/verified\/\S*/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// NOTE: the Digital-Slab listing-image attachment (formerly slabImageUrlForItem
// / applySlabImagePromotion) was removed in the eBay-policy pivot — graded
// images are never attached to listings now (see applyGradeListingPromotion).
// The slab page itself (functions/slab/cert/[id].ts) still serves standalone /
// social use; we just don't ride it onto marketplace photos.

// Exported so the AutoLister auto-publish path (US-955) can run the SAME publish
// pre-flight (blockers + policies) the manual /listings/validate + publish use,
// to decide which green drafts are clean enough to auto-publish.
// ── US-9116: hand the publish path to lib/ebay-publish-port.ts ─────────────
//
// The connector's publish tool cannot import a route, so the route registers.
// The ADAPTING happens here, next to the context definition, so a new blocker
// or a renamed field is a compile error where someone is already looking rather
// than a silently-missing line in a preview a seller is about to approve.
//
// Registered at module load; main.ts imports this module, so any request that
// can reach the tool has already run it.
registerEbayPublisher({
  preview: async (ownerId, itemId) => {
    const ctx = await assemblePublishContext(ownerId, itemId);
    if (!ctx.ok) {
      return {
        ready: false,
        blockers: [String((ctx.error as { error?: unknown }).error ?? "Cannot publish this item.")],
        warnings: [],
        title: "",
        price: null,
        quantity: 0,
        categoryId: null,
        policiesReady: false,
        photoCount: 0,
        condition: null,
      };
    }
    return {
      // Mirrors publishItemForOwner's own gate exactly: it refuses when there
      // are blockers OR no policies, so a preview that called itself ready on
      // one of those would be a preview that lies.
      ready: ctx.blockers.length === 0 && ctx.policies !== null,
      blockers: ctx.blockers,
      warnings: ctx.warnings,
      title: ctx.listing?.listing_title ?? ctx.item.title ?? "",
      price: resolvePublishPrice(
        ctx.listing?.listing_price ?? null,
        ctx.listing?.price_is_estimated === true,
        ctx.item.target_price ?? null,
      ),
      quantity: Math.max(1, ctx.listing?.quantity ?? 1),
      categoryId: ctx.listing?.platform_category_id ?? ctx.item.ebay_category_id ?? null,
      policiesReady: ctx.policies !== null,
      photoCount: ctx.photos.length,
      condition: ctx.listing?.ebay_condition ?? null,
    };
  },
  publish: (ownerId, itemId, opts) => publishItemForOwner(ownerId, itemId, opts ?? {}),
  relist: (ownerId, listingId, quantity) =>
    relistOwnedListing(ownerId, listingId, quantity),
});

export async function assemblePublishContext(
  userId: string,
  itemId: string
): Promise<PublishContext> {
  if (!isEbayConfigured()) {
    return {
      ok: false,
      error: { error: "eBay is not configured on this server." },
      status: 503,
    };
  }

  // Verify connection up front so getDefaultPolicies + push share a fail-fast.
  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    // US-671: publish through the selected (primary) connection.
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) {
    return {
      ok: false,
      error: { error: "Connect your eBay account first." },
      status: 400,
    };
  }

  // NOTE: list_price is NOT a real column on inventory_items — it only exists
  // as a derived alias inside the items_full view (l.listing_price AS list_price).
  // Including it here triggers PostgreSQL 42703 (undefined column) and PostgREST
  // returns data:null, which the caller used to mis-report as "Item not found".
  // The publish-time price priority is now listing.listing_price → target_price.
  const { data: itemRow, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, sku, size, description, condition_notes, target_price, grade_value, grade_label, certificate_url, ebay_category_id, ebay_aspects, ebay_aspect_sources, ebay_epid, item_category, color, material, style, attributes, status"
    )
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr) {
    // PostgREST silently returns data: null when the SELECT column list is
    // invalid (missing column, etc.) — without this log we'd mis-diagnose
    // the failure as "row not found". The most common cause is a column
    // referenced in the select that hasn't been migrated yet.
    console.error(
      `[flipdesk-ebay] publish lookup: inventory_items query errored for ${itemId} ` +
        `— code=${itemErr.code} message=${itemErr.message} details=${itemErr.details ?? ""} hint=${itemErr.hint ?? ""}`,
    );
    return { ok: false, error: { error: "Item lookup failed" }, status: 500 };
  }
  if (!itemRow) {
    console.warn(
      `[flipdesk-ebay] publish lookup: inventory_items row ${itemId} does not exist (caller userId=${userId})`,
    );
    return { ok: false, error: { error: "Item not found" }, status: 404 };
  }
  if ((itemRow as PublishItem).user_id !== userId) {
    console.warn(
      `[flipdesk-ebay] publish lookup: ownership mismatch for item ${itemId} ` +
        `— row user_id=${(itemRow as PublishItem).user_id}, caller userId=${userId}`,
    );
    return { ok: false, error: { error: "Item not found" }, status: 404 };
  }
  const item = itemRow as PublishItem;

  // 00432: seller's Promoted-Listings defaults — used when a listing hasn't made
  // an explicit per-listing choice (promote_override IS NULL). Best-effort: a
  // missing row leaves promotion off-by-default (the safe direction).
  const { data: ownerRow } = await supabaseAdmin
    .from("users")
    .select(
      "promote_listings_by_default, default_promo_rate_pct, default_promo_mode",
    )
    .eq("id", userId)
    .maybeSingle();
  const owner = ownerRow as {
    promote_listings_by_default: boolean | null;
    default_promo_rate_pct: number | null;
    default_promo_mode: string | null;
  } | null;

  // Most recent eBay-platform listing draft for this item (if any).
  // Pull the AutoLister-edited columns too — composer/bulk-edit writes here
  // and these must reach eBay at publish (US-319/320/321).
  const { data: listingRow } = await supabaseAdmin
    .from("listings")
    .select(
      "id, listing_title, listing_description, listing_price, price_is_estimated, ebay_condition, ebay_condition_description, quantity, best_offer_enabled, best_offer_auto_accept_cents, best_offer_auto_decline_cents, price_range_low_cents, price_range_high_cents, platform_category_id, item_specifics_override, item_specifics_sources, scheduled_publish_at, shipping_policy_id, payment_policy_id, return_policy_id, promo_rate_pct, promo_opt_out, promote_override, promo_mode, listing_format, auction_start_price_cents, auction_reserve_price_cents, auction_buy_it_now_price_cents, auction_duration, variations, listing_origin, listing_status, is_active, platform_listing_id, batch_id, synced_to_ebay_at, inventory_sku",
    )
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let listing = (listingRow as PublishListing | null) ?? null;

  // US-1509: an eBay-ORIGINATED row is a read-only mirror of a listing that
  // lives natively on eBay — publish must never source draft fields from it and,
  // above all, never repurpose it in step 5 (that corrupted the mirror while the
  // real listing stayed live, yielding duplicate live listings). Drop it from
  // the context so a publish inserts a FRESH row; if the mirror is still LIVE,
  // block the publish outright — listing the same item again is exactly the
  // duplicate-live-listing class this guard exists to prevent.
  let liveEbayMirrorBlocker: string | null = null;
  if (listing) {
    const rowOrigin = deriveListingOrigin({
      listing_origin: listing.listing_origin,
      platform: "ebay",
      platform_listing_id: listing.platform_listing_id,
      batch_id: listing.batch_id,
      synced_to_ebay_at: listing.synced_to_ebay_at,
    });
    if (rowOrigin === "ebay") {
      const live = listing.is_active === true ||
        listing.listing_status === "active" ||
        listing.listing_status === "relisted";
      if (live) {
        liveEbayMirrorBlocker =
          "This item is already live on eBay (a listing created on eBay). " +
          "End it on eBay or unlink it before publishing from FlipDesk — " +
          "publishing again would create a duplicate live listing.";
      }
      listing = null;
    }
  }

  const { data: photoRows } = await supabaseAdmin
    .from("item_photos")
    // US-1896: width/height feed the picture-standards preflight (dimensions),
    // photo_type feeds the hero-thumbnail nudge.
    .select("id, storage_path, photo_url, photo_type, photo_role, sort_order, width, height")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });

  // US-1549: 'internal' photos (price tags, receipts) are excluded from the
  // whole publish context — they never reach eBay, never count toward the
  // photo blockers, and never surface as the composer's gallery.
  const listablePhotoRows = filterEbayPhotos((photoRows ?? []) as Array<{
    id: string;
    storage_path: string | null;
    photo_url: string | null;
    photo_type: string | null;
    // US-2462: declared so the select above cannot lose it silently.
    photo_role: string | null;
    sort_order: number;
    width: number | null;
    height: number | null;
  }>);
  const photos: PublishPhoto[] = listablePhotoRows.map((p) => {
    // Prefer the stored public URL; fall back to computing one from the
    // storage_path — but never for sensitive private-bucket photos (US-979).
    return {
      id: p.id,
      public_url: ebayPublicPhotoUrl(p) ?? "",
      sort_order: p.sort_order,
    };
  });

  const blockers: string[] = [];
  // US-1896: picture-standards results (non-blocking zoom warning + hero-thumbnail
  // reorder nudge) are collected here in the photo section below and merged into
  // the response after the title-quality warnings are built.
  const photoWarnings: string[] = [];
  let photoNudge: string | null = null;
  // US-1897: structured signals captured for the Listing Quality Score. These
  // are values already computed below for blockers/warnings; capturing them
  // keeps the score off string-sniffing the blocker array, which would break
  // silently the first time a message is reworded.
  let qsPhotoBlockers: string[] = [];
  let qsPhotoWarnings: string[] = [];
  let qsTitlePolicyViolations: string[] = [];
  let qsCategoryLeafStatus: "leaf" | "non_leaf" | "not_found" | "unverified" = "unverified";
  // US-1509: surfaced first — nothing else matters while the item is already live.
  if (liveEbayMirrorBlocker) blockers.push(liveEbayMirrorBlocker);
  // Category resolution: listing-row override wins (AutoLister writes here);
  // fall back to inventory_items for legacy / single-item composer flows.
  let categoryId = listing?.platform_category_id ?? item.ebay_category_id ?? null;
  // US-1893: track whether we JUST resolved the category from a Taxonomy
  // suggestion (which is always a leaf) so the leaf-guard below can skip a
  // redundant probe for it.
  let categoryWasSuggested = false;
  // Auto-resolve a real eBay leaf category when the item never got one. Items
  // created via the single-item composer / manual catalog skip AutoLister's
  // suggestCategories step (ai-listing.ts), so categoryId is null even though
  // the item has a brand/title. Our internal item_category enum is NOT an eBay
  // category, so we resolve against the Taxonomy API from the strongest free
  // text we have and persist the result so this lookup only runs once.
  if (!categoryId) {
    const query = [item.brand, item.title, item.item_category]
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0)
      .join(" ")
      .trim();
    if (query) {
      try {
        const suggestions = await suggestCategories(query);
        if (suggestions.length > 0) {
          categoryId = suggestions[0]!.categoryId;
          categoryWasSuggested = true; // a Taxonomy suggestion is always a leaf.
          qsCategoryLeafStatus = "leaf"; // US-1897: and it matches the suggestion.
          // Persist so subsequent publishes (and the composer) reuse it.
          // Prefer the listing row when one exists; always mirror onto the
          // item so legacy/no-listing flows pick it up too.
          if (listing?.id) {
            await supabaseAdmin
              .from("listings")
              .update({ platform_category_id: categoryId })
              .eq("id", listing.id);
          }
          await supabaseAdmin
            .from("inventory_items")
            .update({ ebay_category_id: categoryId })
            .eq("id", itemId);
        }
      } catch (err) {
        console.error("[flipdesk-ebay] publish category auto-resolve:", err);
      }
    }
  }
  if (!categoryId) blockers.push("Pick an eBay category.");
  // US-1893: leaf-category guard. A manually-set / imported / legacy category id
  // can be a PARENT node, which eBay rejects at publish with an opaque error (and
  // a non-leaf is filtered out of Browse and gets the wrong required-aspect set).
  // Verify leaf-ness up front — cache-first, so an already-validated category
  // costs no live Taxonomy call — and on a non-leaf/unknown id surface a fixable
  // blocker naming the top get_category_suggestions leaf as the one-click fix.
  // Skip when we JUST resolved the id from a suggestion (guaranteed leaf).
  if (categoryId && !categoryWasSuggested) {
    try {
      const leafStatus = await resolveCategoryLeafStatus(categoryId, {
        hasCachedLeaf: categoryHasCachedLeafAspects,
        probeLeafStatus: fetchCategoryLeafStatus,
      });
      qsCategoryLeafStatus = leafStatus;
      if (leafStatus === "non_leaf" || leafStatus === "not_found") {
        // Same suggestion mechanism the category-check card uses (suggestCategories).
        const fixQuery = [item.brand, item.title, item.item_category]
          .map((s) => (typeof s === "string" ? s.trim() : ""))
          .filter((s) => s.length > 0)
          .join(" ")
          .trim();
        let suggestion: LeafCategorySuggestion | null = null;
        if (fixQuery) {
          try {
            const suggestions = await suggestCategories(fixQuery);
            if (suggestions.length > 0) suggestion = suggestions[0]!;
          } catch (err) {
            console.error("[flipdesk-ebay] leaf-guard suggestion lookup:", err);
          }
        }
        const blocker = leafCategoryBlocker(categoryId, leafStatus, suggestion);
        if (blocker) blockers.push(blocker);
      }
    } catch (err) {
      // Never let the guard itself break a publish — log and continue.
      console.error("[flipdesk-ebay] leaf-category guard:", err);
    }
  }
  // Aspect map: prefer item_specifics_override (the AutoLister-edited copy);
  // fall back to the inventory mirror. The inventory mirror feeds legacy flows.
  // US-1505: coerce string-valued legacy rows ({Fit:"Slim"}) to string[] before
  // any array consumer (forceColumnAspects / reconcilePublishAspects) touches it.
  const aspectMap: Record<string, string[]> = normalizeAspectMap(
    (listing?.item_specifics_override as Record<string, unknown> | null) ??
      (item.ebay_aspects as Record<string, unknown> | null),
  );
  // Reverse column sync: a MANUAL Brand/Size/Color/Material/Style edit in a
  // specifics editor (composer, bulk edit, iOS) is the newest human intent for
  // that shared field — fold it back into the item column BEFORE
  // forceColumnAspects below re-asserts the columns, or the stale column would
  // clobber the edit and the seller would face the double-entry it was meant to
  // fix. AI-extracted values only fill blank columns; derived/unattributed
  // values never flow back. Pick the provenance map that pairs with whichever
  // store aspectMap came from.
  {
    const aspectSources = ((listing?.item_specifics_override != null
      ? listing.item_specifics_sources
      : item.ebay_aspect_sources) ?? {}) as Record<string, string | undefined>;
    const writeBack = reverseColumnAspects(
      item as unknown as RegistryItem,
      aspectMap,
      aspectSources,
    );
    if (Object.keys(writeBack).length > 0) {
      Object.assign(item, writeBack); // downstream projection reads the new values
      const { error: wbErr } = await supabaseAdmin
        .from("inventory_items")
        .update(writeBack as never)
        .eq("id", itemId);
      if (wbErr) {
        console.error(
          `[flipdesk-ebay] publish column write-back failed for ${itemId}: ${wbErr.message}`,
        );
      }
    }
  }
  let requiredMissing: string[] = [];
  // US-1895: recommended-aspect coverage (non-blocking); populated alongside the
  // required-blocker check below from the same category spec.
  let recommendedCoverage: AspectCoverage = { filled: 0, total: 0, missing: [] };
  // US-828: aspects the publish path declined to send for VALUE-validation
  // reasons (a SELECTION_ONLY value not in eBay's allowed set, even after the
  // US-823 normalizer). Surfaced in the publish/validate response so the client
  // can say "X was not sent" instead of the value vanishing silently.
  let aspectDiagnostics: PublishAspectDiagnostic[] = [];
  // The map actually sent to eBay — `aspectMap` minus value-validation omissions
  // (with near-misses normalized). Kept separate from the PERSISTED aspectMap so
  // the draft retains the seller's flagged values for them to fix (US-828 keeps
  // unmatched values visible rather than dropping them at generation).
  let sanitizedAspects: Record<string, string[]> = aspectMap;
  if (categoryId) {
    try {
      const aspectsResp = await getCategoryAspects(categoryId);
      const raw = (aspectsResp.aspects as Record<string, unknown>).aspects;
      const list = Array.isArray(raw) ? (raw as AspectSpecRaw[]) : [];

      // US-1088+: the structured columns (Brand/Size/Color/Material/Style) OWN
      // their eBay aspects. Force the current column values onto the map first —
      // overwriting any stale value a previous publish left behind (which buyers
      // would otherwise see as the old/<UNKNOWN> specific) and clearing aspects
      // whose column was blanked. resolveItemAspects (below) never overwrites, so
      // without this a later column edit would never reach an already-built map.
      const forced = forceColumnAspects(
        item as unknown as RegistryItem,
        list,
        aspectMap,
      );
      let columnAspectsChanged = false;
      for (const k of Object.keys(aspectMap)) {
        if (!(k in forced)) {
          delete aspectMap[k];
          columnAspectsChanged = true;
        }
      }
      for (const [k, v] of Object.entries(forced)) {
        if (JSON.stringify(aspectMap[k]) !== JSON.stringify(v)) {
          aspectMap[k] = v;
          columnAspectsChanged = true;
        }
      }

      // Auto-fill specifics from the item's structured columns so manually
      // cataloged items (which never ran AutoLister's AI aspect pass) don't
      // block publish on Brand/Size/Color/etc. that we already know. Only
      // fills aspects not already present; SELECTION_ONLY aspects are filled
      // only when the column value matches one of eBay's allowed values.
      const derived = deriveAspectsFromItem(item, list, aspectMap);
      if (Object.keys(derived).length > 0 || columnAspectsChanged) {
        Object.assign(aspectMap, derived);
        // US-825: record provenance for what we just auto-filled / re-asserted
        // from columns (inventory_derived), merged onto whatever sources already
        // existed so an AI- or user-attributed aspect is never downgraded —
        // except the column-owned ones we just forced, which ARE now derived.
        const priorSources =
          (listing?.id
            ? listing.item_specifics_sources
            : item.ebay_aspect_sources) ?? {};
        const derivedKeys = [
          ...new Set([...Object.keys(derived), ...Object.keys(forced)]),
        ];
        const sources = mergeSources(
          priorSources,
          sourcesFor(derivedKeys, "inventory_derived"),
          aspectMap,
        );
        // Persist so the offer payload AND the composer's specifics editor
        // reflect what we filled. item_specifics_override is the listing-level
        // canonical copy; mirror to the item when there's no listing row yet.
        if (listing?.id) {
          await supabaseAdmin
            .from("listings")
            .update({
              item_specifics_override: aspectMap,
              item_specifics_sources: sources,
            })
            .eq("id", listing.id);
        } else {
          // US-826: this deterministic (no-AI) gap-fill IS the recovery path
          // for a partial one-call prep — clear the refill flag now that the
          // item's aspects are populated from its own columns.
          await supabaseAdmin
            .from("inventory_items")
            .update({
              ebay_aspects: aspectMap,
              ebay_aspect_sources: sources,
              ebay_aspects_refill_needed: false,
            })
            .eq("id", itemId);
        }
      }

      // US-828: validate aspect VALUES against the category spec before the
      // offer build. SELECTION_ONLY near-misses are normalized (US-823) so they
      // publish; values eBay still won't accept are OMITTED from the outgoing
      // payload and recorded as diagnostics. Unknown aspect names + free-text
      // pass through unchanged, so this only ever omits for value-validation
      // reasons. The PERSISTED aspectMap is untouched — the draft keeps the
      // flagged value for the seller to fix.
      const reconcileSpecs: ReconcileSpec[] = list
        .map((a) => ({
          name: a.localizedAspectName ?? "",
          mode: a.aspectConstraint?.aspectMode ?? "FREE_TEXT",
          allowedValues: (a.aspectValues ?? [])
            .map((v) => v.localizedValue ?? "")
            .filter((v) => v.length > 0),
          dataType: a.aspectConstraint?.aspectDataType,
        }))
        .filter((s) => s.name.length > 0);
      const reconciled = reconcilePublishAspects(aspectMap, reconcileSpecs);
      sanitizedAspects = reconciled.aspects;
      aspectDiagnostics = reconciled.omitted;
      if (aspectDiagnostics.length > 0) {
        console.warn(
          `[flipdesk-ebay] omitted ${aspectDiagnostics.length} aspect value(s) for ` +
            `item ${itemId} (category ${categoryId}) — not in eBay's allowed set: ` +
            JSON.stringify(aspectDiagnostics),
        );
      }

      // US-825: the SAME required-aspect rule the client pre-publish checklist
      // uses (requiredMissingAspects) — blocker and checklist can't disagree.
      // Run on the sanitized map so a required aspect whose only value was
      // invalid (and thus omitted) correctly surfaces as a fixable blocker.
      requiredMissing = requiredMissingAspects(list, sanitizedAspects);
      // US-1895: recommended coverage from the SAME spec + sanitized map, so the
      // composer meter and the required blocker are computed from one source.
      recommendedCoverage = recommendedAspectCoverage(list, sanitizedAspects);
      if (requiredMissing.length > 0) {
        // Diagnostic: log WHY each missing aspect couldn't be auto-filled —
        // its mode, a sample of eBay's allowed values, and the item text we
        // tried to infer from. Lets us close the gap without guessing.
        const diag = requiredMissing.map((name) => {
          const spec = list.find((a) => a.localizedAspectName === name);
          const allowed = (spec?.aspectValues ?? [])
            .map((v) => v.localizedValue ?? "")
            .filter((v) => v.length > 0);
          return {
            name,
            mode: spec?.aspectConstraint?.aspectMode ?? "?",
            allowedSample: allowed.slice(0, 12),
            allowedCount: allowed.length,
          };
        });
        console.warn(
          `[flipdesk-ebay] required specifics unfilled for item ${itemId} ` +
            `(category ${categoryId}): ${JSON.stringify(diag)} ` +
            `| item title=${JSON.stringify(item.title)} style=${JSON.stringify(item.style)} ` +
            `item_category=${JSON.stringify(item.item_category)}`,
        );
        // A required aspect we OMITTED (value eBay wouldn't take) reads as
        // "unfilled" to the seller who can plainly see a value in the composer.
        // Say what was actually wrong with it instead.
        const omittedRequired = requiredMissing.filter((name) =>
          aspectDiagnostics.some((d) => d.aspect === name),
        );
        for (const name of omittedRequired.slice(0, 3)) {
          const bad = aspectDiagnostics.find((d) => d.aspect === name);
          const spec = list.find((a) => a.localizedAspectName === name);
          const numeric =
            (spec?.aspectConstraint?.aspectDataType ?? "").toUpperCase() === "NUMBER";
          blockers.push(
            `eBay won't accept "${bad?.omittedValues[0] ?? ""}" for ${name}` +
              (numeric
                ? " — it needs a number (e.g. 8.5), no units or words."
                : " — pick one of eBay's allowed values in the composer."),
          );
        }
        const plainMissing = requiredMissing.filter(
          (n) => !omittedRequired.includes(n),
        );
        if (plainMissing.length > 0) {
          blockers.push(
            `Fill required eBay specifics in the composer: ${plainMissing.slice(0, 4).join(", ")}${
              plainMissing.length > 4 ? "…" : ""
            }`
          );
        }
      }
    } catch (err) {
      // US-1505: distinguish an internal bug (e.g. a TypeError from a malformed
      // aspect map) from a genuine category-spec FETCH failure. The old code
      // surfaced BOTH as "Could not load eBay specifics… Try again." — a
      // retry-forever dead end when the real fault was code, not eBay.
      if (err instanceof TypeError) {
        console.error(
          "[flipdesk-ebay] INTERNAL aspect-reconcile error (not an eBay fetch):",
          err,
        );
        blockers.push(
          "Internal error preparing eBay specifics. Please contact support if this persists.",
        );
      } else {
        console.error("[flipdesk-ebay] aspect fetch for validate:", err);
        blockers.push(
          "Could not load eBay specifics for this category. Try again.",
        );
      }
    }
  }

  const photosWithUrl = photos.filter((p) => !!p.public_url);
  if (photosWithUrl.length === 0) {
    blockers.push("Add at least one photo.");
  } else {
    // US-473/US-566: enforce eBay's 24-image cap as a fixable pre-flight blocker
    // (with de-dup + sort_order preserved) so an over-cap set surfaces here
    // instead of a raw eBay 25601 mid-publish. Duplicates are silently de-duped;
    // only a genuine over-cap (after de-dup) blocks so the seller consciously
    // picks which shots to keep rather than losing a defect photo silently.
    const capResult = dedupeAndCapImages(
      photosWithUrl.map((p) => p.public_url),
      PREFLIGHT_MAX_IMAGES,
    );
    const capBlocker = imageCapBlocker(capResult, PREFLIGHT_MAX_IMAGES);
    if (capBlocker) blockers.push(capBlocker);

    // US-1896: eBay picture-standards preflight over the photos that will
    // actually reach eBay. A sub-500px photo is a fixable blocker; a hero under
    // 1600px is a zoom warning; a tag/detail/defect hero triggers the reorder
    // nudge. Fail-open on unknown dimensions (older rows without width/height).
    const standards = photoStandardsPreflight(
      listablePhotoRows
        .filter((p) => !!ebayPublicPhotoUrl(p))
        .map((p) => ({
          photo_type: p.photo_type,
          width: p.width ?? null,
          height: p.height ?? null,
          sort_order: p.sort_order,
        })),
    );
    for (const b of standards.blockers) blockers.push(b);
    for (const w of standards.warnings) photoWarnings.push(w);
    photoNudge = standards.nudge;
    qsPhotoBlockers = [...standards.blockers];
    qsPhotoWarnings = [...standards.warnings];
  }

  // Price priority: explicit listing edits beat inventory defaults so a user
  // who changed the price in the composer or bulk-edit actually publishes that.
  // A listing_price of 0 means "never priced" (bulk draft-create and old
  // composer saves wrote 0 when the price box was empty) — it must FALL
  // THROUGH to the item's target price instead of blocking publish on an item
  // the user already priced. (list_price isn't a real column on
  // inventory_items — only an alias on the items_full view — so it's not in
  // the fallback chain.)
  const priceNumber = resolvePublishPrice(
    listing?.listing_price ?? null,
    listing?.price_is_estimated === true,
    item.target_price ?? null,
  );
  if (!priceNumber || priceNumber <= 0) {
    blockers.push("Set a target price.");
  }

  // US-1890: guarantee an eBay-legal title before it reaches the Inventory API.
  // The composer caps input at 80, but a stored/bulk-edited/API-written title can
  // still be over-length or carry policy phrases — trim on a word boundary (the
  // legal form always feeds summary.title as a backstop) and surface a fixable
  // preflight blocker + policy/quality lint.
  const rawTitle = (listing?.listing_title ?? item.title ?? "").trim();
  const titleTrim = trimTitleWithReport(rawTitle);
  const title = titleTrim.title;
  const titleWarnings: string[] = [];
  if (!title) {
    blockers.push("Set a title.");
  } else if (titleTrim.trimmed) {
    blockers.push(
      `Title is over eBay's 80-character limit. Trim to: "${title}"`,
    );
  }
  if (rawTitle) {
    const lint = lintTitle(rawTitle);
    for (const v of lint.policyViolations) blockers.push(v);
    titleWarnings.push(...lint.warnings);
    qsTitlePolicyViolations = [...lint.policyViolations];
  }

  // US-2677 (AC2): does this read like one of the seller's OTHER live listings
  // in the same category? Scoped to the resolved owner inside the helper
  // (US-268), and excluding this listing's own row, which would otherwise match
  // itself perfectly on every edit.
  //
  // Warnings, never blockers. eBay penalises the STORE for near-duplicates
  // rather than rejecting the listing, so there is no publish-time error to
  // pre-empt -- only a slow store the seller would never connect to a cause.
  if (rawTitle && categoryId) {
    try {
      titleWarnings.push(
        ...(await duplicateTitleWarningsFor(userId, rawTitle, categoryId, listing?.id ?? null)),
      );
    } catch (err) {
      // A courtesy check must never be why a seller cannot see their blockers.
      console.error("[flipdesk-ebay] duplicate-title check:", err);
    }
  }

  // Look up policies last — only blocks if everything else is ready, but
  // surface the missing prereqs as part of `blockers` either way.
  // US-314: read from the cached business_policies table first; only refresh
  // from eBay when the cache is empty or partial.
  let policies: PolicySet | null = null;
  try {
    const policyResult = await resolveCachedDefaults(userId);
    if ("missing" in policyResult) {
      // Split the two failure modes: business policies are configured in eBay
      // Seller Hub, but a merchant (inventory) location can ONLY be created
      // from FlipDesk (eBay has no Seller Hub UI for it). Pointing both at the
      // business-policies help page is the wrong fix for a missing location.
      const missingPolicies = policyResult.missing.filter(
        (m) => m !== "merchant location",
      );
      if (missingPolicies.length > 0) {
        const help = policyResult.details?.helpUrl
          ? ` (set them up at ${policyResult.details.helpUrl})`
          : "";
        blockers.push(
          `Configure eBay business policies on your seller account: ${missingPolicies.join(", ")}.${help}`,
        );
      }
      if (policyResult.missing.includes("merchant location")) {
        blockers.push(
          "Set your eBay ship-from location: open FlipDesk → Marketplaces → eBay and add it (one-time).",
        );
      }
    } else {
      policies = policyResult;
      // US-555: a per-listing policy override (bulk-assigned in the AutoLister
      // grid) wins over the account default. Each id is left to fall back when
      // null, so a partial override (e.g. only return policy) still publishes
      // with the account defaults for the rest.
      if (listing) {
        policies = {
          ...policies,
          fulfillmentPolicyId:
            listing.shipping_policy_id ?? policies.fulfillmentPolicyId,
          paymentPolicyId:
            listing.payment_policy_id ?? policies.paymentPolicyId,
          returnPolicyId: listing.return_policy_id ?? policies.returnPolicyId,
        };
      }
    }
  } catch (err) {
    // Token-refresh / scope errors land here. Surface a hint so the seller
    // knows reconnecting eBay (re-consenting at /oauth/start) is the fix.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[flipdesk-ebay] policy lookup:", err);
    if (/invalid_scope|token refresh failed/i.test(msg)) {
      blockers.push(
        "Your eBay connection needs to be refreshed. Disconnect and reconnect eBay on the Marketplaces page to grant the latest permissions.",
      );
    } else {
      blockers.push("Could not load your eBay business policies. Try again.");
    }
  }

  const description = (listing?.listing_description ?? item.description ?? title).trim() ||
    title;
  // US-1999: a RELIST reuses the listing row, so the SKU eBay already holds it
  // under wins over item.sku (which the seller may have edited since). Only a
  // never-published item mints a fresh one.
  const sku = resolveInventorySku(listing, item);
  // Condition: explicit editor value wins; only fall back to grade-derived
  // mapping when the user/AI hasn't set one.
  let condition = (listing?.ebay_condition && listing.ebay_condition.trim())
    ? listing.ebay_condition.trim()
    : mapEbayCondition(item.grade_value, item.grade_label);
  const conditionDescription =
    (listing?.ebay_condition_description ?? item.condition_notes ?? "").trim();

  // US-566 / US-1296+: reconcile the resolved condition with the leaf category's
  // allowed conditions (Sell Metadata get_item_condition_policies, cached). eBay
  // rejects a publish (error 25021) when the condition id isn't accepted by the
  // category — e.g. apparel categories reject LIKE_NEW (2750). Auto-pick the
  // nearest ALLOWED condition of equal-or-worse quality so publish just works
  // without overstating; only block when no honest option exists (the category
  // accepts only better/unrepresentable conditions). Best-effort: a policy-fetch
  // failure or an unrestricted category leaves the condition untouched.
  if (categoryId) {
    try {
      const { conditionIds } = await getItemConditionPolicies(categoryId);
      // US-1894: apparel-aware resolve (2025 pre-loved bands on apparel leaves)
      // + allow-list remap. Non-apparel categories resolve identically to the
      // legacy base→remap path. Explicit editor value still wins.
      const remapped = resolveEbayCondition({
        explicit: listing?.ebay_condition,
        grade: item.grade_value,
        label: item.grade_label,
        allowedConditionIds: conditionIds,
      });
      if (remapped === null) {
        const condBlocker = validateConditionForCategory(condition, conditionIds);
        if (condBlocker) blockers.push(condBlocker);
      } else if (remapped !== condition) {
        console.log(
          `[flipdesk-ebay] condition "${condition}" resolved to "${remapped}" ` +
            `for category ${categoryId}`,
        );
        condition = remapped;
      }
    } catch (err) {
      console.warn(
        "[flipdesk-ebay] condition-policy validate (non-blocking):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Quantity: default 1 for single-item resellers; respect the column when set.
  const quantity = listing?.quantity && listing.quantity > 0 ? listing.quantity : 1;
  const bestOfferEnabled = listing?.best_offer_enabled === true;

  // US-562 / US-2405: the best-offer auto-accept/decline thresholds are the
  // seller's own numbers, read straight off the listing. NOTHING is derived
  // from the comp band any more — a NULL column means the seller left the box
  // blank, so no threshold is sent and every offer waits for them. The helper
  // clamps to eBay's constraints (decline < accept < price) and nulls anything
  // invalid.
  let bestOfferAutoAccept: string | null = null;
  let bestOfferAutoDecline: string | null = null;
  if (bestOfferEnabled) {
    const priceCents = priceNumber ? Math.round(priceNumber * 100) : 0;
    // US-2944: eBay's auto-accept fires the instant a bid lands and knows
    // nothing about the rule's margin floor, so a stored threshold BELOW an
    // active rule's number is a hole — an offer in the gap gets taken at a
    // price the rule would have refused. Raise it here, before it is pushed.
    //
    // One direction only. A blank threshold stays blank (US-2405), and a
    // seller stricter than their own rule is left alone.
    const activeRule = await loadActiveOfferRule(userId);
    const reconciled = reconcileAutoAcceptWithRule({
      priceCents,
      sellerAcceptCents: listing?.best_offer_auto_accept_cents ?? null,
      ruleAcceptAtPct: activeRule?.acceptAtPct ?? null,
      ruleMarginFloorPct: activeRule?.marginFloorPct ?? 10,
      itemCostCents: await acquiredCostCentsForListing(userId, listing?.id ?? null),
    });
    const thresholds = resolveBestOfferThresholds({
      priceCents,
      acceptCents: reconciled.autoAcceptCents,
      declineCents: listing?.best_offer_auto_decline_cents ?? null,
    });
    bestOfferAutoAccept =
      thresholds.autoAcceptCents != null
        ? centsToMoneyString(thresholds.autoAcceptCents)
        : null;
    bestOfferAutoDecline =
      thresholds.autoDeclineCents != null
        ? centsToMoneyString(thresholds.autoDeclineCents)
        : null;
  }

  // US-568: resolve the listing format + auction terms. Auction prices are
  // stored in cents; convert to eBay money strings. A draft marked 'auction'
  // without a start price falls back to the listing price as the starting bid.
  const format: "FIXED_PRICE" | "AUCTION" =
    listing?.listing_format === "auction" ? "AUCTION" : "FIXED_PRICE";
  const centsToStr = (c: number | null | undefined): string | null =>
    typeof c === "number" && c > 0 ? centsToMoneyString(c) : null;
  const auctionStartPrice =
    format === "AUCTION"
      ? (centsToStr(listing?.auction_start_price_cents) ??
        (priceNumber ? priceNumber.toFixed(2) : null))
      : null;
  const auctionReservePrice =
    format === "AUCTION"
      ? centsToStr(listing?.auction_reserve_price_cents)
      : null;
  const auctionBuyItNowPrice =
    format === "AUCTION"
      ? centsToStr(listing?.auction_buy_it_now_price_cents)
      : null;
  const auctionDuration =
    format === "AUCTION"
      ? (listing?.auction_duration?.trim() || "DAYS_7")
      : "GTC";
  // US-568: variation matrix — keep only non-empty, well-formed entries.
  const variations = normalizeVariations(listing?.variations ?? null);

  const summary: PublishContextOk["summary"] = {
    title,
    description,
    priceValue: priceNumber ? priceNumber.toFixed(2) : "0.00",
    currency: "USD",
    condition,
    conditionDescription,
    categoryId: categoryId ?? "",
    // US-828: send the value-validated map (near-misses normalized, invalid
    // SELECTION_ONLY values omitted), not the raw persisted aspectMap.
    aspects: sanitizedAspects,
    quantity,
    bestOfferEnabled,
    bestOfferAutoAccept,
    bestOfferAutoDecline,
    format,
    auctionStartPrice,
    auctionReservePrice,
    auctionBuyItNowPrice,
    auctionDuration,
    variations,
    // 00432: resolve the ad rate — a legacy opt-out wins, else the per-listing
    // override, else the seller default (off by default). Rate: listing choice →
    // seller default → category suggestion. The composer surfaces the same
    // suggestion so the resolution stays transparent + adjustable.
    promotedAdRate: resolvePublishAdRate({
      optOut: listing?.promo_opt_out,
      promoteOverride: listing?.promote_override,
      defaultPromote: owner?.promote_listings_by_default ?? false,
      chosenRatePct: listing?.promo_rate_pct,
      defaultRatePct: owner?.default_promo_rate_pct,
      categoryId,
    }),
    // Mode: per-listing choice → seller default → cps.
    promotedMode: promoModeFor(listing?.promo_mode ?? owner?.default_promo_mode),
  };

  return {
    ok: true,
    // US-1507: the connection publish resolved to (see the conn lookup above).
    connectionId: conn.id as string,
    item,
    listing,
    photos: photosWithUrl,
    policies,
    blockers,
    // US-1890 title-quality warnings + US-1896 picture-standards (zoom) warnings.
    warnings: [...titleWarnings, ...photoWarnings],
    // US-1896: hero-thumbnail reorder nudge ("your search thumbnail is a tag
    // shot — drag a full front view first"), or null when the hero is fine.
    photoNudge,
    recommendedCoverage,
    aspectDiagnostics,
    sku,
    summary,
    // US-1897: structured inputs for the Listing Quality Score. Deliberately
    // raw signals, not a score — the score is computed on the validate surface
    // so the publish hot path pays nothing for it.
    qualitySignals: {
      titlePolicyViolations: qsTitlePolicyViolations,
      titleWarnings: [...titleWarnings],
      photoBlockers: qsPhotoBlockers,
      photoWarnings: qsPhotoWarnings,
      photoCount: photosWithUrl.length,
      categoryLeafStatus: qsCategoryLeafStatus,
      categoryWasSuggested,
      requiredMissing: [...requiredMissing],
    },
  };
}

// Maps GradeThread's 1-10 grade to an eBay clothing condition string. Delegates
// to the shared, unit-tested base ladder in publish-preflight.ts (single-source
// with US-1894's apparel-band mapping). This produces the pre-remap DEFAULT; the
// publish/revise path resolves the final condition via resolveEbayCondition,
// which switches to eBay's 2025 pre-loved apparel bands on apparel leaves and
// then remaps against the category allow-list (never overstating quality).
function mapEbayCondition(
  grade: number | null,
  label: string | null,
): string {
  return mapGradeToBaseCondition(grade, label);
}

// Resolves an in-app path against the configured frontend origin. Used for
// the post-callback redirect so a sandbox deploy doesn't bounce users to
// production. Falls back to a relative path if no origin is configured.
function appUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const origin =
    Deno.env.get("FLIPDESK_APP_ORIGIN") ??
    Deno.env.get("GRADETHREAD_APP_ORIGIN") ??
    "https://gradethread.com";
  return `${origin.replace(/\/$/, "")}${
    pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`
  }`;
}
