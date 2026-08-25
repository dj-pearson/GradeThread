import { handleEbaySearchTermsCron } from "./routes/jobs-ebay-search-terms.ts";
import { handleStyleCodeSweepCron } from "./routes/jobs-style-code-sweep.ts";
import { handleStyleCodeDiscoveryCron } from "./routes/jobs-style-code-discovery.ts";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { accessLogger } from "./middleware/access-log.ts";
import { healthRoutes } from "./routes/health.ts";
import { gradeRoutes } from "./routes/grade.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { authHookRoutes } from "./routes/auth-hooks.ts";
import { emailSnsRoutes } from "./routes/email-sns.ts";
import { emailEngagementRoutes } from "./routes/email-engagement.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { appstoreVerifyRoutes, appstoreWebhookRoutes } from "./routes/appstore.ts";
import { googlePlayRtdnRoutes } from "./routes/google-play-rtdn.ts";
import { googlePlayVerifyRoutes } from "./routes/google-play.ts";
import { apiKeyRoutes } from "./routes/api-keys.ts";
import { apiV1Routes } from "./routes/api-v1.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import {
  handleListOAuthConnections,
  handleOAuthConsent,
  handleRevokeOAuthConnection,
  oauthRoutes,
} from "./routes/oauth.ts";
import { OPENAPI_SPEC } from "./lib/openapi-spec.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { pushRoutes } from "./routes/push.ts";
import { flipdeskEbayRoutes } from "./routes/flipdesk-ebay.ts";
import { flipdeskShopifyRoutes } from "./routes/flipdesk-shopify.ts";
import { flipdeskDepopRoutes } from "./routes/flipdesk-depop.ts";
import { flipdeskEtsyRoutes } from "./routes/flipdesk-etsy.ts";
import { flipdeskWhatnotRoutes } from "./routes/flipdesk-whatnot.ts";
import { installShutdownHandlers, trackInFlight } from "./lib/lifecycle.ts";
import {
  flipdeskWebhookRoutes,
  handleEbayPendingWebhooksCron,
} from "./routes/flipdesk-webhooks.ts";
import { flipdeskGradingRoutes } from "./routes/flipdesk-grading.ts";
import { flipdeskDemandRoutes } from "./routes/flipdesk-demand.ts";
import { passportRoutes } from "./routes/passport.ts";
import { passportIdentityRoutes } from "./routes/passport-identity.ts";
import { flipdeskPhotoProfilesRoutes } from "./routes/flipdesk-photo-profiles.ts";
import { flipdeskImageRoutes } from "./routes/flipdesk-images.ts";
import { flipdeskListingsRoutes } from "./routes/flipdesk-listings.ts";
import { flipdeskReconciliationRoutes } from "./routes/flipdesk-reconciliation.ts";
import { flipdeskSheetsRoutes } from "./routes/flipdesk-sheets.ts";
import {
  flipdeskImportRoutes,
  handleImportReclaimCron,
} from "./routes/flipdesk-import.ts";
import { flipdeskAiRoutes } from "./routes/flipdesk-ai.ts";
import { flipdeskScoutRoutes } from "./routes/flipdesk-scout.ts";
import { flipdeskRadarRoutes } from "./routes/flipdesk-radar.ts";
import { flipdeskMeasureRoutes } from "./routes/flipdesk-measure.ts";
import { flipdeskForecastRoutes } from "./routes/flipdesk-forecast.ts";
import { flipdeskEquityRoutes } from "./routes/flipdesk-equity.ts";
import { flipdeskProductRoutes } from "./routes/flipdesk-product.ts";
import { flipdeskTemplatesRoutes } from "./routes/flipdesk-templates.ts";
import {
  flipdeskAutolisterRoutes,
  handleAutolisterReclaimCron,
  handlePublishBatchReclaimCron,
} from "./routes/flipdesk-autolister.ts";
import { handleGradingBatchReclaimCron } from "./lib/grading-batch-worker.ts";
import { flipdeskGooglePhotosRoutes } from "./routes/flipdesk-google-photos.ts";
import { flipdeskGoogleRoutes } from "./routes/flipdesk-google.ts";
import { flipdeskGoogleSyncRoutes } from "./routes/flipdesk-google-sync.ts";
import { flipdeskDisclosureRoutes } from "./routes/flipdesk-disclosure.ts";
import { flipdeskExtensionQueueRoutes } from "./routes/flipdesk-extension-queue.ts";
import { extensionOrUserAuthMiddleware } from "./middleware/extension-or-user-auth.ts";
import { flipdeskSyncRoutes } from "./routes/flipdesk-sync.ts";
import { flipdeskExpensesRoutes } from "./routes/flipdesk-expenses.ts";
import { flipdeskConsignmentRoutes } from "./routes/flipdesk-consignment.ts";
import {
  flipdeskPricingRoutes,
  handleRepriceRulesCron,
  handleRepriceScanCron,
} from "./routes/flipdesk-pricing.ts";
import {
  flipdeskAutomationsRoutes,
  handleAutomationRulesCron,
} from "./routes/flipdesk-automations.ts";
import { flipdeskLogisticsRoutes } from "./routes/flipdesk-logistics.ts";
import { handleCredentialsRefreshCron } from "./routes/jobs-credentials-refresh.ts";
import { adminBillingRoutes } from "./routes/admin-billing.ts";
import { adminFlagsRoutes } from "./routes/admin-flags.ts";
import { adminPricingRoutes } from "./routes/admin-pricing.ts";
import { adminConfigRoutes } from "./routes/admin-config.ts";
import { adminCategoryMapRoutes } from "./routes/admin-category-map.ts";
import { adminListingCoverageRoutes } from "./routes/admin-listing-coverage.ts";
import { adminIdentificationProvenanceRoutes } from "./routes/admin-identification-provenance.ts";
import { adminWaitlistRoutes } from "./routes/admin-waitlist.ts";
import { waitlistRoutes } from "./routes/waitlist.ts";
import { accessGateMiddleware } from "./lib/access-gate.ts";
import { adminGradingRoutes } from "./routes/admin-grading.ts";
import { adminDisputesRoutes } from "./routes/admin-disputes.ts";
import { adminClaimsRoutes } from "./routes/admin-claims.ts";
import { adminGuaranteePoolRoutes } from "./routes/admin-guarantee-pool.ts";
import { handleGuaranteePoolCron } from "./routes/jobs-guarantee-pool.ts";
import { handlePortfolioAlertsCron } from "./routes/jobs-portfolio-alerts.ts";
import { handleDemandMatchesCron } from "./routes/jobs-demand-matches.ts";
import { handleRewardNudgesCron } from "./routes/jobs-reward-nudges.ts";
import { adminMeasureCardRoutes } from "./routes/admin-measure-cards.ts";
import { guaranteePublicRoutes } from "./routes/guarantee-public.ts";
import { adminSupportRoutes } from "./routes/admin-support.ts";
import { adminSupportTicketsRoutes } from "./routes/admin-support-tickets.ts";
import { adminComplianceRoutes } from "./routes/admin-compliance.ts";
import { adminLegalRoutes } from "./routes/admin-legal.ts";
import { adminMonitoringRoutes } from "./routes/admin-monitoring.ts";
import { adminNotificationsRoutes } from "./routes/admin-notifications.ts";
import { adminViewsRoutes } from "./routes/admin-views.ts";
import { adminKnowledgeBaseRoutes } from "./routes/admin-knowledge-base.ts";
import { adminBrandKnowledgeRoutes } from "./routes/admin-brand-knowledge.ts";
import { adminRegisteredNumbersRoutes } from "./routes/admin-registered-numbers.ts";
import { adminUsersRoutes } from "./routes/admin-users.ts";
import { adminScopesRoutes } from "./routes/admin-scopes.ts";
import { adminSearchRoutes } from "./routes/admin-search.ts";
import { adminImpersonationRoutes } from "./routes/admin-impersonation.ts";
import { adminMessagesRoutes } from "./routes/admin-messages.ts";
import { adminJobsRoutes } from "./routes/admin-jobs.ts";
import { adminOpsRoutes } from "./routes/admin-ops.ts";
import { maintenanceRoutes } from "./routes/maintenance.ts";
import { adminSettingsRoutes } from "./routes/admin-settings.ts";
import { adminBulkRoutes } from "./routes/admin-bulk.ts";
import { adminDashboardRoutes } from "./routes/admin-dashboard.ts";
import { adminTasksRoutes } from "./routes/admin-tasks.ts";
import { adminAgentsRoutes } from "./routes/admin-agents.ts";
import { adminModerationRoutes } from "./routes/admin-moderation.ts";
import { adminFraudRoutes } from "./routes/admin-fraud.ts";
import { adminSafetyRoutes } from "./routes/admin-safety.ts";
import { adminPassportIntegrityRoutes } from "./routes/admin-passport-integrity.ts";
import { adminRevenueRoutes } from "./routes/admin-revenue.ts";
import { adminAnalyticsRoutes } from "./routes/admin-analytics.ts";
import { adminDripRoutes } from "./routes/admin-drip.ts";
import { adminNewsletterRoutes } from "./routes/admin-newsletter.ts";
import { adminSuppressionsRoutes } from "./routes/admin-suppressions.ts";
import { adminSubscribersRoutes } from "./routes/admin-subscribers.ts";
import { adminChangelogRoutes } from "./routes/admin-changelog.ts";
import { changelogPublicRoutes } from "./routes/changelog.ts";
import { adminJourneyRoutes } from "./routes/admin-journeys.ts";
import { adminAiSpendRoutes } from "./routes/admin-ai-spend.ts";
import { adminAiBudgetsRoutes } from "./routes/admin-ai-budgets.ts";
import { adminMarketplaceConnectionsRoutes } from "./routes/admin-marketplace-connections.ts";
import { adminMarketplaceOpsRoutes } from "./routes/admin-marketplace-ops.ts";
import { adminMarketplacePipelineRoutes } from "./routes/admin-marketplace-pipeline.ts";
import { adminConditionIndexRoutes } from "./routes/admin-condition-index.ts";
import { adminAuditRoutes } from "./routes/admin-audit.ts";
import { handleAuditAnomalyCron } from "./routes/jobs-audit-anomaly.ts";
import { cronNameForPath } from "./lib/cron-runs.ts";
import { finishCronRun } from "./lib/cron-run-outcome.ts";
import { createMiddleware } from "hono/factory";
import { publicGradingRoutes } from "./routes/public-grading.ts";
import { handleGradingMonitorCron } from "./lib/grading-monitor.ts";
import { handleGradingSelfConsistencyCron } from "./routes/jobs-grading-self-consistency.ts";
import { handleStuckSubmissionsCron } from "./lib/stuck-submissions.ts";
import { handlePushTokenPruneCron } from "./lib/push-token-prune.ts";
import { handleSyncReaperCron } from "./lib/sync-run-lock.ts";
import { handleEmailRetryCron } from "./lib/email-retry.ts";
import { handleIntegrityScanCron } from "./lib/integrity-scan.ts";
import { handleCertIntegrityBackfillCron } from "./lib/cert-integrity-backfill.ts";
import { handleDataRetentionCron } from "./lib/data-retention.ts";
import { handleConditionIndexRefreshCron } from "./lib/condition-index.ts";
import { handleConditionIndexSeedGenCron } from "./lib/condition-index-seedgen.ts";
import { handleAppstoreExpirySweepCron } from "./lib/appstore/expiry-sweep.ts";
import { handleGooglePlayExpirySweepCron } from "./lib/google-play/expiry-sweep.ts";
import { handleTrialExpiryCron } from "./routes/jobs-trial-expiry.ts";
import { handleThumbnailBackfillCron } from "./routes/jobs-thumbnail-backfill.ts";
import { handleDurabilityAggregateCron } from "./routes/jobs-durability-aggregate.ts";
import { handleRadarAggregateCron } from "./routes/jobs-radar-aggregate.ts";
import { handleConsignorPayoutsCron } from "./routes/jobs-consignor-payouts.ts";
import { handleExpenseRecurrenceCron } from "./routes/jobs-expense-recurrence.ts";
import { handleAffiliatePayoutsCron } from "./routes/jobs-affiliate-payouts.ts";
import { handleAgentTickCron } from "./routes/jobs-agent-tick.ts";
import { handleAgentEvalCron } from "./routes/jobs-agent-eval.ts";
import { handleOperatorBriefCron } from "./routes/jobs-operator-brief.ts";
import { handleJourneyTickCron } from "./routes/jobs-journey-tick.ts";
import { handleNewsletterTuningCron } from "./routes/jobs-newsletter-tuning.ts";
import { handleNewsletterTopicBankRefillCron } from "./routes/jobs-newsletter-topic-bank.ts";
import { handleNewsletterAbFinalizeCron } from "./routes/jobs-newsletter-ab.ts";
import { handleNewsletterDispatchCron } from "./routes/jobs-newsletter-dispatch.ts";
import { handleAbuseScanCron } from "./routes/jobs-abuse-scan.ts";
import { watchdogHeartbeatHandler } from "./routes/jobs-watchdog-heartbeat.ts";
import { handlePassportIntegrityScanCron } from "./routes/jobs-passport-integrity-scan.ts";
import { handlePassportBackfillCron } from "./routes/jobs-passport-backfill.ts";
import { handleListingPromptPromoteCron } from "./routes/jobs-listing-prompt-promote.ts";
import { handleExemplarAssemblyCron } from "./routes/jobs-exemplar-assembly.ts";
import { handleConfidenceCalibrationCron } from "./routes/jobs-confidence-calibration.ts";
import {
  handleCompReadCron,
  handleCompReadReclaimCron,
} from "./routes/jobs-comp-read.ts";
import { handleNorthStarDigestCron } from "./routes/jobs-north-star.ts";
import { handleEquitySnapshotCron } from "./routes/jobs-equity-snapshot.ts";
import { handleBuyerDigestCron } from "./routes/jobs-buyer-digest.ts";
import { handleConditionAlertsCron } from "./lib/condition-alerts.ts";
import { handleContentWatchdogCron } from "./routes/jobs-content-watchdog.ts";
import { handleContentRefreshCron } from "./routes/jobs-content-refresh.ts";
import { handleKeywordResearchCron } from "./routes/jobs-keyword-research.ts";
import { handleAdsSyncCron } from "./routes/jobs-ads-sync.ts";
import { handleAdsConversionsUploadCron } from "./routes/jobs-ads-conversions-upload.ts";
import { handleRecordAttribution } from "./routes/ads-attribution.ts";
import { handleRecordUtm } from "./routes/utm-attribution.ts";
import { handleBillingReconciliationCron } from "./routes/jobs-billing-reconciliation.ts";
import { handleAiBudgetCron } from "./routes/jobs-ai-budget.ts";
import { handleCronFleetHealthCron } from "./routes/jobs-cron-fleet.ts";
import { handleMarketplaceEventsCron } from "./routes/jobs-marketplace-events.ts";
import { handleEbayOrderBackstopCron } from "./routes/jobs-ebay-order-backstop.ts";
import { handlePhotoArchiveCron } from "./routes/jobs-photo-archive.ts";
import { handleReconciliationSweepCron } from "./routes/jobs-reconciliation-sweep.ts";
import { handleEbayNotificationReconcileCron } from "./routes/jobs-ebay-notification-reconcile.ts";
import { adminSeoRoutes, handleGscSyncCron } from "./routes/admin-seo.ts";
import { adminGrowthRoutes, handleGrowthDispatchCron } from "./routes/admin-growth.ts";
import { adminRewardsRoutes } from "./routes/admin-rewards.ts";
import { adminAdsRoutes } from "./routes/admin-ads.ts";
import { announcementRoutes } from "./routes/announcements.ts";
import { referralRoutes } from "./routes/referrals.ts";
import { affiliateRoutes } from "./routes/affiliate.ts";
import { contentBlogRoutes } from "./routes/content-blog.ts";
import { contentAuthorsRoutes } from "./routes/content-authors.ts";
import { contentSocialRoutes } from "./routes/content-social.ts";
import { contentTopicsRoutes } from "./routes/content-topics.ts";
import { contentKnowledgeRoutes } from "./routes/content-knowledge.ts";
import { contentImagesRoutes } from "./routes/content-images.ts";
import { contentSettingsRoutes } from "./routes/content-settings.ts";
import { contentPublicRoutes } from "./routes/content-public.ts";
import { renderCardRoutes } from "./routes/render-card.ts";
import {
  helpAdminRoutes,
  helpPublicRoutes,
  helpReaderRoutes,
} from "./routes/help-center.ts";
import { contentSchedulerRoutes } from "./routes/content-scheduler.ts";
import { newsletterSchedulerRoutes } from "./routes/newsletter-scheduler.ts";
import { newsletterSubscribeRoutes } from "./routes/newsletter-subscribe.ts";
import { dripRoutes } from "./routes/drip.ts";
import { dripTrackingRoutes } from "./routes/drip-tracking.ts";
import { campaignTrackingRoutes } from "./routes/campaign-tracking.ts";
import { workspaceRoutes } from "./routes/workspace.ts";
import { accountRoutes } from "./routes/account.ts";
import { supportTicketRoutes } from "./routes/support-tickets.ts";
import { legalRoutes } from "./routes/legal.ts";
import { verifiedRoutes } from "./routes/verified.ts";
import { rewardsRoutes } from "./routes/rewards.ts";
import { showcaseRoutes } from "./routes/showcase.ts";
import { buyerPurchasesRoutes } from "./routes/buyer-purchases.ts";
import { buyerClosetRoutes } from "./routes/buyer-closet.ts";
import { buyerRewardsRoutes } from "./routes/buyer-rewards.ts";
import { buyerProfileRoutes } from "./routes/buyer-profile.ts";
import { buyerWantsRoutes } from "./routes/buyer-wants.ts";
import { buyerAuthenticityRoutes } from "./routes/buyer-authenticity.ts";
import { warnAuthenticityGate } from "./lib/authenticity-eval.ts";
import { buyerTrustRoutes } from "./routes/buyer-trust.ts";
import { supportAssistantRoutes } from "./routes/support-assistant.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { ebayAuthMiddleware } from "./middleware/ebay-auth.ts";
import { adminAuthMiddleware } from "./middleware/admin-auth.ts";
import { maintenanceGuard } from "./middleware/maintenance.ts";
import { apiKeyAuthMiddleware } from "./middleware/api-key-auth.ts";
import { mcpAuthMiddleware } from "./middleware/mcp-auth.ts";
import {
  authorizationServerMetadata,
  isOAuthEnabled,
  protectedResourceMetadata,
} from "./lib/oauth-metadata.ts";
import {
  bypassUnlessRead,
  bypassUnlessWrite,
  mcpClassifyMiddleware,
  mcpRateLimitBody,
  mcpReadLimit,
  mcpUsageMiddleware,
  mcpWriteLimit,
} from "./middleware/mcp-traffic.ts";
import { apiIdempotencyMiddleware } from "./middleware/api-idempotency.ts";
import { rateLimiter, pagesOriginBypass } from "./middleware/rate-limit.ts";
import { getSetting, getSettingSync } from "./lib/system-settings.ts";
import { refreshOverrideCache } from "./lib/rate-limit-overrides.ts";
import {
  apiV1RateLimitBody,
  apiV1ReadLimit,
  apiV1Subject,
  apiV1WriteLimit,
} from "./middleware/api-v1-rate.ts";
import { apiUsageMiddleware } from "./lib/api-usage-log.ts";
import { blockViewerWrites, workspaceMiddleware } from "./middleware/workspace.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { bodyLimit, BodyTooLargeError } from "./middleware/body-limit.ts";
import {
  assertAdminMfaConfig,
  assertKnownEdgeEnv,
  assertNoProdDebugFlags,
  isProduction,
} from "./lib/env.ts";
import { assertRequiredEnv, warnDeliverability, warnMissingFeatureGroups } from "./lib/env-validation.ts";
import { assertSchemaVersion, checkSchemaCompleteness } from "./lib/schema-version.ts";
import { redactError } from "./lib/log-redact.ts";
import { captureException, logEvent, readCtxVar, releaseSha } from "./lib/observability.ts";
import {
  RELEASE_ENV_KEYS,
  isPlaceholderRelease,
  unreadReleaseCandidates,
} from "./lib/release-identity.ts";
import { hasEnvAlertChannel } from "./lib/ops-events.ts";
import { featureGate } from "./lib/feature-flags.ts";
// US-9103: the origin allowlist moved to its own module so the MCP endpoint's
// DNS-rebinding guard and CORS share one definition of a trusted origin.
import { isAllowedOrigin } from "./lib/allowed-origins.ts";

const app = new Hono();

// The origin allowlist itself lives in lib/allowed-origins.ts so CORS here and
// the MCP endpoint's DNS-rebinding guard (US-9103) share one definition.

const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
  "X-Internal-Job-Secret",
  "X-Workspace-Owner",
  // US-1754: per-extension-instance quota key sent by the extension.
  "X-GT-Extension-Id",
];

// Re-apply the Access-Control-Allow-Origin (+ Vary) headers for an allowed
// caller. Used both by the OPTIONS preflight handler and by the terminal
// error/not-found handlers so a response built AFTER an early throw (e.g. an
// exception in a pre-cors() middleware, before cors() set the header) still
// carries CORS — otherwise the browser reports a misleading "blocked by CORS
// policy" that masks the real 4xx/5xx the operator needs to see.
function applyCorsOrigin(c: Context): void {
  const origin = c.req.header("Origin") ?? "";
  if (isAllowedOrigin(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
}

// Belt-and-suspenders: respond to every OPTIONS preflight FIRST, before any
// other middleware runs. Hono's cors() should already do this, but a defensive
// explicit handler here means a Traefik/Coolify edge or an upstream middleware
// quirk can't strip the headers — we always emit them.
app.use("*", async (c, next) => {
  if (c.req.method !== "OPTIONS") {
    await next();
    return;
  }
  applyCorsOrigin(c);
  c.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  // US-363: return the FIXED allowlist — never reflect
  // Access-Control-Request-Headers, which would let any client widen the set.
  c.header("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
  c.header("Access-Control-Max-Age", "86400");
  return c.body(null, 204);
});

// Middleware
// US-359: custom access logger (never logs request headers / querystrings) in
// place of Hono's logger(), so Authorization / X-API-Key / signatures can't
// leak into log sinks.
app.use("*", accessLogger);
app.use(
  "*",
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ALLOWED_HEADERS,
    maxAge: 86400,
  })
);

// Security hardening headers on every response (HSTS, nosniff, frame-deny,
// referrer policy, CORP) + no-store on user-scoped surfaces. Runs after cors()
// so it can't clobber Access-Control-* headers. (US-263)
app.use("*", securityHeaders);

// Request body-size guard (US-267) — reject oversized payloads with 413 before
// the handler buffers them. Per-route caps (15MB for image uploads, 256KB for
// JSON-only endpoints) are resolved inside the middleware by path. Scoped to
// /api/* so /health and the OPTIONS preflight never pay for it.
app.use("/api/*", bodyLimit);

// Auth middleware — applied to protected routes only (not health or webhooks)
app.use("/api/grade/*", authMiddleware);
app.use("/api/payments/*", authMiddleware);
app.use("/api/keys/*", authMiddleware);
app.use("/api/notifications/dispute-status", authMiddleware);
app.use("/api/notifications/dispute-filed", authMiddleware);
app.use("/api/notifications/register", authMiddleware);
// US-2557: the badge count. Session-scoped, so it needs the same guard.
app.use("/api/notifications/unread-count", authMiddleware);
app.use("/api/notifications/feedback", authMiddleware);
// US-1638: /welcome now derives its target from the verified token (was an
// unauthenticated body-userId → account-existence oracle).
app.use("/api/notifications/welcome", authMiddleware);
// US-1901: web push subscription management — authed + workspace-scoped so
// subscriptions are stored/read under the resolved owner (workspaceOwnerId ??
// userId), matching how notify.ts fans pushes out to the recipient owner.
app.use("/api/push/*", authMiddleware);
app.use("/api/push/*", workspaceMiddleware);
// Account data export / deletion — caller acts only on their own data. (US-275)
app.use("/api/account/*", authMiddleware);
// US-900: user-facing support ticket inbox — caller acts only on their own tickets.
app.use("/api/support-tickets/*", authMiddleware);
// US-377: ToS/Privacy clickwrap acceptance — caller acts only on their own record.
app.use("/api/legal/*", authMiddleware);
// US-628: in-app announcement reads — caller acts only on their own dismissals.
app.use("/api/announcements/*", authMiddleware);
// US-629 referral program — caller manages only their own code/attribution.
app.use("/api/referrals/*", authMiddleware);
// US-1700: persist a captured ad click id against the signed-in user (authed).
app.use("/api/ads/attribution", authMiddleware);
app.post("/api/ads/attribution", (c) => handleRecordAttribution(c));
// US-2101: first-/last-touch UTM channel attribution → the caller's user row.
app.use("/api/attribution/utm", authMiddleware);
app.post("/api/attribution/utm", (c) => handleRecordUtm(c));
// US-603: affiliate earned-link channel. /me is per-user (authed); /click is
// PUBLIC (anonymous badge clicks), so authMiddleware is scoped to /me only.
app.use("/api/affiliate/me", authMiddleware);
// US-1295: affiliate payout self-service (Stripe Connect onboarding + earnings)
// — per-user, authed. /click stays public.
app.use("/api/affiliate/connect", authMiddleware);
app.use("/api/affiliate/connect/*", authMiddleware);
app.use("/api/affiliate/payouts", authMiddleware);
// GradeThread Verified — seller manages their OWN public profile. No workspace
// middleware: the profile is the individual seller's account, not a tenant's.
app.use("/api/verified/*", authMiddleware);
// US-1851 rewards (level / season / perks / streaks) — PERSONAL, like the
// verified profile. Deliberately NOT workspace-scoped: XP and a tier belong to
// the human who earned them, so a workspace member must not read the owner's.
//
// ⚠ ONE registration only. Two US-1851 commits (79c5a1a8, e8e098de) each added
// this line with its own comment, and the duplicate survived review because
// running auth twice is functionally harmless. It is not free: authMiddleware
// calls supabaseAdmin.auth.getUser(), a network round-trip to GoTrue, so every
// /api/rewards/* request paid the auth latency twice until 2026-08-08. Hono
// runs each matching app.use in order — it does not dedupe.
app.use("/api/rewards/*", authMiddleware);
// US-1855 Showcase WRITES (per-find consent + reactions) — personal, like the
// verified profile. The public feed itself is anonymous and lives under
// /api/content/public/finds.json, so only this write half is authed.
app.use("/api/showcase/*", authMiddleware);
// Buyer surfaces (US-1811+) — personal account, no workspace middleware; every
// handler scopes by c.get("userId").
app.use("/api/buyer/*", authMiddleware);
// Garment Passport (US-1092): the public chain read (GET /api/passport/:slug) is
// anonymous; only the append path under /garments/* is authed + workspace-scoped.
app.use("/api/passport/garments/*", authMiddleware);
// US-1105: opt-in identity-reveal management is per-ACCOUNT (the caller's own
// passport hops), like the Verified profile — authed, NOT workspace-scoped.
app.use("/api/passport-identity/*", authMiddleware);
// FlipDesk: everything under /api/flipdesk is authed except inbound webhooks
// and the eBay OAuth callback (eBay redirects the browser there unauthenticated;
// the `state` token from oauth_states identifies the user) + the scheduled
// /oauth/refresh job (gated by FLIPDESK_INTERNAL_JOB_SECRET header).
app.use("/api/flipdesk/demand", authMiddleware);
app.use("/api/flipdesk/demand", workspaceMiddleware);
// eBay (US-2014 AC3): ONE deny-by-default mount, replacing the ~35 individual
// path patterns that used to live here. flipdesk-ebay.ts declares 80+ routes;
// under the old allowlist any route whose path was not named above shipped with
// no auth at all, and five of them did (US-1623/US-1978/US-1979/US-2233 all record
// the same trap). ebayAuthMiddleware runs authMiddleware for everything under the
// prefix and consults ONE explicit skip-list — middleware/ebay-auth.ts
// EBAY_SELF_AUTHENTICATING — for the OAuth callback and the four job-secret crons.
// A new eBay route is now closed unless someone writes down why it is open.
app.use("/api/flipdesk/ebay/*", ebayAuthMiddleware);
// Shopify (US-599): everything authed EXCEPT /oauth/callback (Shopify
// redirects the browser there unauthenticated; the `state` row identifies the
// user and the request is HMAC-verified with our app secret).
app.use("/api/flipdesk/shopify/oauth/start", authMiddleware);
app.use("/api/flipdesk/shopify/disconnect", authMiddleware);
app.use("/api/flipdesk/shopify/listings/*", authMiddleware);
// Depop (US-713/714): everything authed EXCEPT /oauth/callback (Depop redirects
// the browser there unauthenticated; the `state` row identifies the user) and
// /oauth/refresh (internal job secret). The order webhook is public + verified.
app.use("/api/flipdesk/depop/oauth/start", authMiddleware);
app.use("/api/flipdesk/depop/disconnect", authMiddleware);
app.use("/api/flipdesk/depop/sync", authMiddleware);
app.use("/api/flipdesk/depop/seller-addresses", authMiddleware);
app.use("/api/flipdesk/depop/orders/*", authMiddleware);
// Etsy (US-1659): everything authed EXCEPT /oauth/callback (Etsy redirects the
// browser there unauthenticated; the `state` row identifies the user + carries
// the PKCE verifier) and /oauth/refresh (internal job secret).
app.use("/api/flipdesk/etsy/oauth/start", authMiddleware);
app.use("/api/flipdesk/etsy/disconnect", authMiddleware);
app.use("/api/flipdesk/etsy/sync", authMiddleware);
app.use("/api/flipdesk/etsy/shipping-profiles", authMiddleware);
// Whatnot (US-1661): everything authed EXCEPT /oauth/callback (Whatnot redirects
// the browser there unauthed; the `state` row carries the PKCE verifier) and
// /oauth/refresh (internal job secret).
app.use("/api/flipdesk/whatnot/oauth/start", authMiddleware);
app.use("/api/flipdesk/whatnot/disconnect", authMiddleware);
app.use("/api/flipdesk/grading/submit", authMiddleware);
app.use("/api/flipdesk/grading/validate", authMiddleware);
app.use("/api/flipdesk/grading/submissions/*", authMiddleware);
app.use("/api/flipdesk/images/*", authMiddleware);
app.use("/api/flipdesk/listings/*", authMiddleware);
// US-2481: the mobile→desktop extension work queue. Both the bare path (POST
// to enqueue, GET to read) and the sub-paths (/claim, /:id/complete, DELETE
// /:id) — a wildcard alone would leave the bare mount open.
//
// US-2723: extensionOrUserAuthMiddleware, not authMiddleware. These are the two
// route groups the BROWSER EXTENSION calls, and the extension does not hold a
// Supabase JWT — it holds the signed token from lib/extension-token.ts. Under
// plain authMiddleware every call 401'd (observed live in the production edge
// log on 2026-08-20), so the queue never drained a row and no sold-sync
// observation ever landed. The wrapper accepts either credential and nothing
// more; see the middleware for why an extension token can never satisfy a
// step-up gate.
app.use("/api/flipdesk/extension-queue", extensionOrUserAuthMiddleware);
app.use("/api/flipdesk/extension-queue/*", extensionOrUserAuthMiddleware);
// US-2697: sold-sync observation intake. Both mounts for the same reason as
// the queue above - there is no bare route today and a wildcard alone would
// leave one open the day someone adds it.
app.use("/api/flipdesk/sync", extensionOrUserAuthMiddleware);
app.use("/api/flipdesk/sync/*", extensionOrUserAuthMiddleware);
// A workspace member syncing acts on the OWNER's tenant, not their own
// (US-268). Without this the route resolves ownerId to the member's id and
// would match a sold row against an empty set of listings.
app.use("/api/flipdesk/sync", workspaceMiddleware);
app.use("/api/flipdesk/sync/*", workspaceMiddleware);
app.use("/api/flipdesk/reconciliation/*", authMiddleware);
app.use("/api/flipdesk/sheets/*", authMiddleware);
app.use("/api/flipdesk/import/*", authMiddleware);
app.use("/api/flipdesk/ai/*", authMiddleware);
app.use("/api/flipdesk/scout/*", authMiddleware);
// US-1863: Thrift Radar network layer (read-only aggregates). Authed like
// scout — it is the same surface, one layer up.
app.use("/api/flipdesk/radar/*", authMiddleware);
app.use("/api/flipdesk/measure/*", authMiddleware);
app.use("/api/flipdesk/product/*", authMiddleware);
app.use("/api/flipdesk/templates/*", authMiddleware);
app.use("/api/flipdesk/autolister/*", authMiddleware);
app.use("/api/flipdesk/disclosure/*", authMiddleware);
// US-2228: expense receipt upload/read/delete. Nothing else on the expenses
// screen is an edge route — the direct supabase writes stay — but bytes must
// be sniffed and stripped server-side, which a browser cannot do.
app.use("/api/flipdesk/expenses/*", authMiddleware);
// US-600: consignment mode — consignor portal, splits, payouts. All authed.
app.use("/api/flipdesk/consignment/*", authMiddleware);
app.use("/api/flipdesk/pricing/*", authMiddleware);
app.use("/api/flipdesk/automations/*", authMiddleware);
app.use("/api/flipdesk/logistics/*", authMiddleware);
// US-268 hardening: these two routers were mounted (below) but were missing
// from this per-path auth whitelist, so they were silently reachable
// unauthenticated despite in-file comments claiming otherwise. forecast reads
// tenant data → needs auth + workspace context; photo-profiles serves config
// consumed inside the authed app. (See the deny-by-default guard test that now
// fails the build if a new /api/flipdesk/* router is added without auth.)
app.use("/api/flipdesk/forecast/*", authMiddleware);
app.use("/api/flipdesk/equity/*", authMiddleware);
app.use("/api/flipdesk/photo-profiles/*", authMiddleware);
// US-2134: photo-profiles stopped being purely static — it now hides the
// clothing authenticity macros from a seller who cannot use the add-on. That
// entitlement belongs to the WORKSPACE OWNER, not to whoever is holding the
// camera, so this needs workspaceOwnerId. Without it the `workspaceOwnerId ??
// userId` in the route is a dead expression: a member capturing inside a paid
// workspace would be judged on their own (usually free) plan and lose slots the
// owner paid for. Absent header = the caller's own id, so solo users are
// unaffected.
app.use("/api/flipdesk/photo-profiles/*", workspaceMiddleware);

// US-585: waitlist / beta access gate. Mounted AFTER authMiddleware for each
// path (so userId/user are set) on the core "do work" surfaces — grading and
// the AI-listing/scout flows. When gating is off (default) this is a single
// cached flag read and a no-op; when on, non-approved accounts get a 403
// { code: "waitlist_required" } and the SPA shows the waitlist-pending page.
// Read-only dashboard browsing stays open so an approved-later user isn't
// staring at a broken shell. Webhooks / OAuth callbacks are NOT gated (no auth
// ran there, and they resolve the user from a verified provider payload).
app.use("/api/grade/*", accessGateMiddleware);
app.use("/api/flipdesk/grading/submit", accessGateMiddleware);
app.use("/api/flipdesk/autolister/*", accessGateMiddleware);
app.use("/api/flipdesk/ai/*", accessGateMiddleware);
app.use("/api/flipdesk/scout/*", accessGateMiddleware);
app.use("/api/flipdesk/measure/*", accessGateMiddleware);

// US-585: authenticated access-status check for the SPA. Public capture
// (POST /api/waitlist) is unauthenticated + rate-limited below.
app.use("/api/waitlist/me", authMiddleware);
// Google Photos import — everything authed EXCEPT /oauth/callback (Google
// redirects the browser there unauthenticated; the `state` row identifies the
// user and the import is one-shot + tenant-scoped to the session's owner_id).
app.use("/api/flipdesk/google/photos/oauth/start", authMiddleware);
app.use("/api/flipdesk/google/photos/poll", authMiddleware);
app.use("/api/flipdesk/google/photos/import", authMiddleware);
app.use("/api/flipdesk/google/photos/config", authMiddleware);
// Google Sheets sync (US-146) — everything authed EXCEPT /oauth/callback
// (Google redirects the browser there unauthenticated; the single-use `state`
// row identifies the user). Listed per-path so the wildcard can't shadow the
// public Photos callback above.
app.use("/api/flipdesk/google/oauth/start", authMiddleware);
app.use("/api/flipdesk/google/connection", authMiddleware);
app.use("/api/flipdesk/google/config", authMiddleware);
app.use("/api/flipdesk/google/sheet/*", authMiddleware);
app.use("/api/flipdesk/google/disconnect", authMiddleware);
// US-147: manual "Sync now" is user-authed; /sync/push + /sync/pull are
// scheduled jobs gated inside the handler by the internal job secret.
app.use("/api/flipdesk/google/sync/now", authMiddleware);
// Workspace (team) management: auth + workspace context. The route handlers
// enforce per-action role checks (owner/admin required to invite, etc.).
app.use("/api/workspace/*", authMiddleware);
app.use("/api/workspace/*", workspaceMiddleware);

// US-834: AI Support Assistant — authed + workspace-scoped (subscription gate +
// tenant-scoped read tools live in the handler/engine). The subscriber/lockout
// gate runs inside POST /message before any model call.
app.use("/api/support/assistant/*", authMiddleware);
app.use("/api/support/assistant/*", workspaceMiddleware);

// Workspace context middleware — resolves X-Workspace-Owner into
// workspaceOwnerId/workspaceRole so routes can write to the correct tenant
// when a member is acting inside an owner's workspace. Sits after
// authMiddleware. No-ops (workspaceOwnerId === userId) for solo users.
app.use("/api/grade/*", workspaceMiddleware);
// US-1637: per-grade checkout must resolve the workspace owner so a member can
// pay to unlock the OWNER's submission (stored user_id = ownerId). Runs after
// authMiddleware (mounted above); no-ops for solo users (workspaceOwnerId ===
// userId). Other /api/payments/* routes read userId for the customer, so the
// added workspace context is harmless to them.
app.use("/api/payments/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/oauth/start", workspaceMiddleware);
app.use("/api/flipdesk/ebay/oauth/debug", workspaceMiddleware);
app.use("/api/flipdesk/ebay/disconnect", workspaceMiddleware);
app.use("/api/flipdesk/ebay/category/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/listings/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/payouts/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/comps", workspaceMiddleware);
app.use("/api/flipdesk/ebay/aspect-coverage", workspaceMiddleware);
app.use("/api/flipdesk/ebay/policies", workspaceMiddleware);
app.use("/api/flipdesk/ebay/policies/*", workspaceMiddleware);
// US-1623: workspace scope for the newly-authed eBay sub-paths (they resolve
// the tenant via workspaceOwnerId ?? userId), matching the other eBay routes.
app.use("/api/flipdesk/ebay/analytics/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/compliance/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/finances/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/catalog/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/promotions", workspaceMiddleware);
app.use("/api/flipdesk/ebay/promotions/*", workspaceMiddleware);
// US-673: best offers + send-offer + buyer messages.
app.use("/api/flipdesk/ebay/negotiation/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/messages", workspaceMiddleware);
app.use("/api/flipdesk/ebay/messages/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/sync-runs", workspaceMiddleware);
app.use("/api/flipdesk/ebay/orders/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/returns", workspaceMiddleware);
app.use("/api/flipdesk/ebay/returns/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/cancellations", workspaceMiddleware);
app.use("/api/flipdesk/ebay/cancellations/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/feedback", workspaceMiddleware);
app.use("/api/flipdesk/ebay/payment-disputes", workspaceMiddleware);
app.use("/api/flipdesk/ebay/payment-disputes/*", workspaceMiddleware);
app.use("/api/flipdesk/shopify/oauth/start", workspaceMiddleware);
app.use("/api/flipdesk/shopify/disconnect", workspaceMiddleware);
app.use("/api/flipdesk/shopify/listings/*", workspaceMiddleware);
// Depop (US-713/714): workspace-scope the user-authed routes so the connection,
// sales, and ship actions live under the workspace owner (mirrors eBay/Shopify).
app.use("/api/flipdesk/depop/oauth/start", workspaceMiddleware);
app.use("/api/flipdesk/depop/disconnect", workspaceMiddleware);
app.use("/api/flipdesk/depop/sync", workspaceMiddleware);
app.use("/api/flipdesk/depop/seller-addresses", workspaceMiddleware);
app.use("/api/flipdesk/depop/orders/*", workspaceMiddleware);
// Etsy (US-1659): workspace-scope the user-authed routes (connection lives under
// the workspace owner, mirrors eBay/Shopify/Depop).
app.use("/api/flipdesk/etsy/oauth/start", workspaceMiddleware);
app.use("/api/flipdesk/etsy/disconnect", workspaceMiddleware);
app.use("/api/flipdesk/etsy/sync", workspaceMiddleware);
app.use("/api/flipdesk/etsy/shipping-profiles", workspaceMiddleware);
// Whatnot (US-1661): workspace-scope the user-authed routes.
app.use("/api/flipdesk/whatnot/oauth/start", workspaceMiddleware);
app.use("/api/flipdesk/whatnot/disconnect", workspaceMiddleware);
app.use("/api/flipdesk/grading/submit", workspaceMiddleware);
app.use("/api/flipdesk/grading/validate", workspaceMiddleware);
app.use("/api/flipdesk/grading/submissions/*", workspaceMiddleware);
app.use("/api/flipdesk/images/*", workspaceMiddleware);
app.use("/api/flipdesk/listings/*", workspaceMiddleware);
app.use("/api/flipdesk/reconciliation/*", workspaceMiddleware);
app.use("/api/flipdesk/import/*", workspaceMiddleware);
app.use("/api/flipdesk/ai/*", workspaceMiddleware);
app.use("/api/flipdesk/scout/*", workspaceMiddleware);
app.use("/api/flipdesk/radar/*", workspaceMiddleware);
app.use("/api/flipdesk/measure/*", workspaceMiddleware);
app.use("/api/flipdesk/product/*", workspaceMiddleware);
app.use("/api/passport/garments/*", workspaceMiddleware);
app.use("/api/flipdesk/templates/*", workspaceMiddleware);
app.use("/api/flipdesk/autolister/*", workspaceMiddleware);
// Only /oauth/start needs the workspace owner (to stage imports under the
// owner); /poll + /import resolve the owner from the session row.
app.use("/api/flipdesk/google/photos/oauth/start", workspaceMiddleware);
// Google Sheets sync — workspace-scope every user-authed route so the grant
// and sync sheet live under the workspace owner (mirrors the eBay wiring).
app.use("/api/flipdesk/google/oauth/start", workspaceMiddleware);
app.use("/api/flipdesk/google/connection", workspaceMiddleware);
app.use("/api/flipdesk/google/sheet/*", workspaceMiddleware);
app.use("/api/flipdesk/google/disconnect", workspaceMiddleware);
app.use("/api/flipdesk/google/sync/now", workspaceMiddleware);
app.use("/api/flipdesk/disclosure/*", workspaceMiddleware);
app.use("/api/flipdesk/expenses/*", workspaceMiddleware);
app.use("/api/flipdesk/consignment/*", workspaceMiddleware);
app.use("/api/flipdesk/pricing/*", workspaceMiddleware);
app.use("/api/flipdesk/automations/*", workspaceMiddleware);
app.use("/api/flipdesk/logistics/*", workspaceMiddleware);
app.use("/api/flipdesk/forecast/*", workspaceMiddleware);
app.use("/api/flipdesk/equity/*", workspaceMiddleware);
app.use("/api/keys/*", workspaceMiddleware);

// US-1928: baseline write floor — a view-only workspace member (viewer) may not
// use any mutating verb on the FlipDesk / grade surface. Mounted broadly and
// AFTER every workspaceMiddleware line above so the role is already resolved;
// it fires only when the role is exactly "viewer" (public webhook/OAuth sub-paths
// and job-secret crons carry no role and pass through). Specific higher floors
// (admin disconnects, listing_manager publishes) stay as inline checks on top.
// The flipdesk-role-floor-coverage guard test fails the build if these mounts go
// missing or a mutating surface router is mounted outside their coverage.
app.use("/api/flipdesk/*", blockViewerWrites);
app.use("/api/grade/*", blockViewerWrites);

// US-584: cron-run ledger. Every /api/jobs/* hit that presents the internal
// job secret (i.e. a legit scheduled call, not an unauthenticated probe) is
// recorded to cron_runs after the handler runs, so the admin Jobs dashboard
// can show each cron's last-run time, outcome, and duration. Best-effort and
// fire-and-forget — the handlers still enforce the secret + their own locks.
app.use("/api/jobs/*", async (c, next) => {
  const isCron = Boolean(c.req.header("X-Internal-Job-Secret"));
  const startedMs = isCron ? Date.now() : 0;
  await next();
  if (!isCron) return;
  const httpStatus = c.res.status;
  const jobName = c.req.path.split("/").pop() ?? "unknown";
  // US-881: attribute the run. A manual Run-now from the Operations console
  // sets X-Triggered-By: admin:<uuid>; a scheduled Coolify cron does not.
  const triggeredBy = c.req.header("X-Triggered-By")?.trim() || "schedule";
  // US-906: a failed scheduled/manual job run is a significant ops event — feed
  // it through the activity stream (warning). This is the single chokepoint that
  // covers EVERY /api/jobs/* cron. Noisy persistently-failing jobs can be muted
  // per-type ("job.failed") from the alert config.
  // US-2312: "failed" now includes a 2xx run that reported failed units in its
  // OWN body (payout sweeps, guarantee-pool discrepancies), and the run's
  // rows_processed is populated here so an idle job is queryable. See
  // lib/cron-run-outcome.ts for why the HTTP status deliberately stays 2xx.
  finishCronRun({
    jobName,
    response: c.res,
    httpStatus,
    durationMs: Date.now() - startedMs,
    triggeredBy,
  });
});

// US-1645: the eBay crons run under /api/flipdesk/ebay/* (not /api/jobs/*), so
// the recorder above never saw them and a missed run was invisible. Record them
// too — resolving the canonical registry name from the path (their name differs
// from the last path segment) so a missing/failed run signals in the cron_runs
// ledger and the ops activity stream exactly like every /api/jobs/* cron. Gated
// on the internal job secret + a registered path, so ordinary eBay traffic is a
// no-op. Mounted only on the specific cron sub-paths.
const recordEbayCron = createMiddleware(async (c, next) => {
  // US-2617: BOTH internal-call shapes count. The static header is one way a
  // scheduler authenticates; the signed variant (HMAC + freshness + single-use,
  // verifySignedJobRequest) is the other, and the content, newsletter and drip
  // schedulers all accept it. Keying only on the static header would record a
  // cron that used the weaker path and silently skip the same job when it used
  // the stronger one — a ledger gap that appears when someone improves the
  // caller.
  //
  // This is a PRESENCE check, not authentication: it decides "was this an
  // internal scheduled call", and the handler still decides whether the secret
  // is valid. A forged header therefore buys nothing except a cron_runs row on
  // a request that is about to 401, which the recorder faithfully records as a
  // failure.
  const isCron = Boolean(
    c.req.header("X-Internal-Job-Secret") ?? c.req.header("X-Internal-Job-Signature"),
  );
  const startedMs = isCron ? Date.now() : 0;
  await next();
  if (!isCron) return;
  const jobName = cronNameForPath(c.req.path);
  if (!jobName) return; // not a registered cron path — don't record
  const httpStatus = c.res.status;
  const triggeredBy = c.req.header("X-Triggered-By")?.trim() || "schedule";
  // US-2312: same body-aware recorder as the /api/jobs/* chokepoint above, so
  // the eBay/Google crons cannot drift into a weaker failure definition.
  finishCronRun({
    jobName,
    response: c.res,
    httpStatus,
    durationMs: Date.now() - startedMs,
    triggeredBy,
  });
});
app.use("/api/flipdesk/ebay/jobs/*", recordEbayCron);
// The 5-min Google Sheet sync is a recorded cron too (cronNameForPath resolves
// "/api/flipdesk/google/sync/push" → "google-sheet-sync"); same generic recorder.
app.use("/api/flipdesk/google/sync/push", recordEbayCron);
app.use("/api/flipdesk/ebay/sync/performance", recordEbayCron);
// US-2617: the hourly token refresh. Its handler has always gated on
// requireJobSecret, so it was reachable as a cron — it simply was not mounted
// here, so it left no ledger row and cron-fleet-health could not tell whether it
// had stopped. If it stops, seller eBay tokens expire and listings stop syncing.
//
// EXPECT A STALL ALERT if the Coolify task does not exist: the detector computes
// expected slots from the schedule, not from prior runs, so a job that has never
// fired reads as stalled from the first hour. That is the finding, not a false
// positive — it is the question "is this task actually installed?" answering
// itself for the first time.
app.use("/api/flipdesk/ebay/oauth/refresh", recordEbayCron);
// US-2617: the content scheduler's two crons. They were recorded:false because
// they authenticate against CONTENT_INTERNAL_JOB_SECRET rather than the
// FLIPDESK one — but that is which SECRET the handler validates, and the
// recorder only cares which HEADER arrived. Both are X-Internal-Job-Secret (or
// the signed variant), so the same middleware works unchanged.
//
// content-tick is hourly and content-digest weekly; a stop on either is silent,
// which is the whole argument for recording them.
app.use("/api/content/scheduler/tick", recordEbayCron);
app.use("/api/content/scheduler/digest", recordEbayCron);

// Admin billing: user JWT auth, then admin role check
app.use("/api/admin/*", authMiddleware);
app.use("/api/admin/*", adminAuthMiddleware);

// US-582: ad-hoc operator → customer email. Cap per-admin sends so a compromised
// or fat-fingered admin session can't blast mail; keyed by the authed admin user
// (default subject) since the JWT+role check above already ran.
app.use("/api/admin/messages/*", rateLimiter(20, 60_000, "admin-messages", undefined, {
  methods: ["POST"],
}));

// Content module (blog + social): admin-only EXCEPT /api/content/public/*
// which is anonymous (powers the SSR worker for /blog). We carve the
// public surface out by listing the protected sub-paths explicitly
// instead of slapping middleware on /api/content/*. This mirrors the
// FlipDesk wiring above.
app.use("/api/content/blog/*", authMiddleware);
app.use("/api/content/blog/*", adminAuthMiddleware);
app.use("/api/content/authors/*", authMiddleware);
app.use("/api/content/authors/*", adminAuthMiddleware);
app.use("/api/content/social/*", authMiddleware);
app.use("/api/content/social/*", adminAuthMiddleware);
app.use("/api/content/topics/*", authMiddleware);
app.use("/api/content/topics/*", adminAuthMiddleware);
app.use("/api/content/knowledge/*", authMiddleware);
app.use("/api/content/knowledge/*", adminAuthMiddleware);
app.use("/api/content/images/*", authMiddleware);
app.use("/api/content/images/*", adminAuthMiddleware);
app.use("/api/content/settings/*", authMiddleware);
app.use("/api/content/settings/*", adminAuthMiddleware);
// Help Center authoring (US-2573). Both the base path and the sub-paths, because
// POST /api/content/help (create) sits at the mount root and `/*` alone misses
// it — the same reason /api/changelog registers both forms below.
app.use("/api/content/help", authMiddleware);
app.use("/api/content/help", adminAuthMiddleware);
app.use("/api/content/help/*", authMiddleware);
app.use("/api/content/help/*", adminAuthMiddleware);
// The members-only reader (US-2573). authMiddleware only: it is a customer
// surface, not an admin one. Admins get 'internal' articles through the role
// lookup in the handler, not through a second middleware.
app.use("/api/help", authMiddleware);
app.use("/api/help/*", authMiddleware);

// Rate limiting (US-265) — distributed (Postgres-backed), per-scope so budgets
// don't bleed across endpoint groups. Keyed by user when authed, else by IP.
// US-781: the only UNAUTHENTICATED, unmetered mount — the public content surface
// (blog/cert/seller reads + the cert view counter). Cap per-IP and FAIL-CLOSED
// (a store outage drops to the per-replica fallback, never unlimited), with a
// Pages-origin bypass so the blog/cert SSR workers — which proxy these endpoints
// for ALL visitors through one Cloudflare Pages IP — aren't starved. 60/min/IP
// is generous for legitimate cert sharing/scanning + QR badge fetches.
app.use(
  "/api/content/public/*",
  rateLimiter(60, 60_000, "content-public", undefined, {
    failClosed: true,
    bypass: pagesOriginBypass,
  }),
);
// US-1444: the remaining PUBLIC, unauthenticated GET surfaces — changelog,
// maintenance status, and the public-grading transparency/stats reads — run
// uncached (or cold-cache) DB reads per request with no limiter. Cap per-IP and
// fail-closed like content-public, with the Pages-origin bypass so the SSR
// workers that proxy them for all visitors through one Cloudflare IP aren't
// starved. The in-module TTL caches stay in place as defense-in-depth.
const publicReadLimiter = (name: string) =>
  rateLimiter(60, 60_000, name, undefined, { failClosed: true, bypass: pagesOriginBypass });
// changelog is served at the mount root (GET /api/changelog), so `/*` alone
// would miss it — register both the base and any future sub-paths.
const changelogLimiter = publicReadLimiter("changelog-public");
app.use("/api/changelog", changelogLimiter);
app.use("/api/changelog/*", changelogLimiter);
app.use("/api/maintenance/*", publicReadLimiter("maintenance-public"));
app.use("/api/grading/public/*", publicReadLimiter("grading-public"));
// US-585: public waitlist capture is unauthenticated — cap per-IP and
// fail-closed so a fresh-account spam flood can't fill the table.
app.use("/api/waitlist", rateLimiter(10, 60_000, "waitlist", undefined, { failClosed: true, methods: ["POST"] }));
// US-867: buyer trust-guarantee claim intake is UNAUTHENTICATED (buyers have no
// account) — cap tightly per-IP and fail-closed so a flood can't fill the table.
app.use("/api/guarantee/*", rateLimiter(5, 60_000, "guarantee", undefined, { failClosed: true, methods: ["POST"] }));
// US-1094/US-1096: the public Garment Passport claim + physical-tag scan/claim
// endpoints are UNAUTHENTICATED (buyers scanning a link/QR). Cap per-IP and
// fail-closed so a flood can't spam transfers. (The authed garments/* mint path
// is covered by auth + tenant scoping, not this limiter.)
app.use("/api/passport/claim", rateLimiter(10, 60_000, "passport-claim", undefined, { failClosed: true, methods: ["POST"] }));
app.use("/api/passport/tag/*", rateLimiter(20, 60_000, "passport-tag", undefined, { failClosed: true, methods: ["GET", "POST"] }));
// US-1096/US-1098: authed passport writes (tag mint, claim-token mint, event
// append) + the candidate-match service (US-1098) — capped per-IP on top of the
// auth + tenant scoping.
app.use("/api/passport/garments/*", rateLimiter(30, 60_000, "passport-garments", undefined, { methods: ["POST"] }));
// US-1420: the PUBLIC, unauthenticated chain read (GET /:slug) fans out into ~6
// uncached DB queries per request, so cap it per-IP and fail-closed — consistent
// with its abusable siblings above — so a flood can't drive unbounded DB load.
// GET-only, so it never double-limits the POST /claim or the /garments writes
// (those carry their own limiters); the single-segment `:slug` match also never
// reaches the multi-segment /tag/* and /garments/* paths.
app.use("/api/passport/:slug", rateLimiter(20, 60_000, "passport-read", undefined, { failClosed: true, methods: ["GET"] }));
// US-1105: identity-reveal management (authed) — capped per-IP on top of auth.
app.use("/api/passport-identity/*", rateLimiter(30, 60_000, "passport-identity"));
// US-884: the grade cap is read through the DB-backed settings registry
// (`rate_limit_grade_per_min`) via the per-request resolver so it can be retuned
// without a deploy. getSettingSync serves the cached value (default 60) and
// warms the cache in the background — no await on the request path.
// US-2013: fail CLOSED. This limiter and the AI spend kill-switch
// (lib/ai-budget-gate.ts, also fail-open) read the SAME Postgres, so they share
// a failure domain — a DB degradation removed per-user grading limits and the
// hard USD cap simultaneously, while Anthropic stayed up and billable. Each
// control failing open is defensible on its own; both failing together turns a
// blip into an unbounded bill. Grading is the most expensive call in the
// product, so this is the one to close: during a store outage a caller gets a
// 429 and retries, instead of an uncapped fan-out to the vision API.
app.use(
  "/api/grade/*",
  rateLimiter(
    (_) => getSettingSync<number>("rate_limit_grade_per_min", 60),
    60_000,
    "grade",
    undefined,
    { failClosed: true },
  ),
);
// Snap-to-Value (/api/grade/snap) is a FREE, uncertified Claude Vision call. The
// monthly SNAP_CAP bounds total volume, but the "business" tier is monthly-
// unlimited — so without a per-minute bound a single account could sustain the
// whole 60/min grade budget on free vision calls. Pin snap to a much tighter
// dedicated burst limit (this runs IN ADDITION to the grade-group limiter).
app.use(
  "/api/grade/snap",
  rateLimiter((_) => getSettingSync<number>("rate_limit_snap_per_min", 10), 60_000, "grade-snap", undefined, { methods: ["POST"] }),
);
app.use("/api/flipdesk/ebay/listings/*", rateLimiter(30, 60_000, "ebay-listings"));
app.use("/api/flipdesk/grading/*", rateLimiter(60, 60_000, "flipdesk-grading"));
// US-2013: fail closed for the same reason as /api/grade/* above — this is the
// other AI-spend surface that shares a failure domain with the budget gate.
app.use(
  "/api/flipdesk/ai/*",
  rateLimiter(20, 60_000, "flipdesk-ai", undefined, { failClosed: true }),
);
// US-2014: the support assistant is an LLM surface and was the ONE AI route
// with no limiter at all. It is not an open faucet — support-assistant.ts calls
// loadGateAndDecide() before any token spend, so metering exists — but every
// other AI surface carries a limiter too, and defence-in-depth is exactly what
// you want on the path where a loop costs money per iteration.
app.use(
  "/api/support/assistant/*",
  // US-2013 AC2: fail closed. This is an LLM surface, so it belongs with
  // /api/grade/* and /api/flipdesk/ai/* rather than with the read routes. It
  // needs the DB anyway (loadGateAndDecide meters before any token spend), so
  // during a store outage it cannot serve a correct response either way —
  // 429ing at the limiter is strictly better than failing deep inside AFTER
  // tokens have been bought.
  rateLimiter(20, 60_000, "support-assistant", undefined, { failClosed: true }),
);
// US-619: ScoutAI is expensive (grades N candidates per scan) - cap tightly.
app.use(
  "/api/flipdesk/scout/*",
  // US-2013 AC2: fail closed. Scout grades N candidates per scan, which makes it
  // the most expensive AI request on the platform after grading itself — the
  // 6/min cap exists precisely because one scan fans out. Leaving the cap
  // fail-open meant a store outage removed the bound on the highest-fan-out
  // surface while Anthropic stayed billable.
  rateLimiter(6, 60_000, "flipdesk-scout", undefined, { failClosed: true }),
);
// US-1572: calibration is CPU-bound image decode + CV (no model call) — cap
// enough for a capture-review loop without letting one client hog the worker.
app.use("/api/flipdesk/measure/*", rateLimiter(15, 60_000, "flipdesk-measure"));
// US-598: barcode/UPC lookup is a single cheap eBay Browse call — roomy budget
// so scanning a haul item-by-item never trips the limiter.
app.use("/api/flipdesk/product/*", rateLimiter(40, 60_000, "flipdesk-product"));
// AutoLister batch enqueue is cheap to call but kicks off heavy background
// work — cap submissions; per-item AI cost is governed by the quota check. The
// cap applies to WRITES only (POST: batch enqueue, classify-photos, photo-qa,
// retry). The read-only batch-status poll (GET /batch/:id) gets its own roomy
// budget below: the queue view polls every 1.5s (~40/min) for the minutes a
// batch generates, which would otherwise drain this write budget and 429 the
// poll mid-run (a batch DoS-ing its own status view).
// US-529: the validated staging-photo upload gets its own roomy budget — a
// bulk dump stages up to ~100 photos in a couple of minutes, which would
// instantly drain the 20/min write cap below (so that limiter bypasses this
// path). Uploads are cheap (sniff + strip + storage PUT), no AI cost.
app.use(
  "/api/flipdesk/autolister/staging/upload",
  rateLimiter(120, 60_000, "autolister-upload", undefined, { methods: ["POST"] }),
);
app.use(
  "/api/flipdesk/autolister/*",
  // US-2013 AC2: fail closed on the WRITE cap only. A batch enqueue kicks off
  // per-item generateListing calls, so this is an AI-spend surface even though
  // the request itself is cheap. The read-only poll below deliberately stays
  // fail-open — it buys no tokens, and 429ing a status poll during a blip would
  // break the queue view for a batch that is already running and already paid
  // for. That asymmetry is the point: close what spends, not what reads.
  rateLimiter(20, 60_000, "flipdesk-autolister", undefined, {
    methods: ["POST"],
    failClosed: true,
    bypass: (c) => c.req.path === "/api/flipdesk/autolister/staging/upload",
  }),
);
app.use(
  "/api/flipdesk/autolister/*",
  rateLimiter(120, 60_000, "autolister-poll", undefined, { methods: ["GET"] }),
);
// Disclosure reads are cheap; the annotated-photo upload writes storage.
app.use("/api/flipdesk/disclosure/*", rateLimiter(40, 60_000, "flipdesk-disclosure"));
// One receipt per expense, attached once — a tighter cap than the photo routes.
app.use("/api/flipdesk/expenses/*", rateLimiter(20, 60_000, "flipdesk-expenses"));
// US-600: consignment CRUD + Stripe Connect onboarding/payout calls.
app.use("/api/flipdesk/consignment/*", rateLimiter(30, 60_000, "flipdesk-consignment"));
// A repricing scan fans out to one eBay Browse call per listing — cap tightly.
app.use("/api/flipdesk/pricing/scan", rateLimiter(6, 60_000, "flipdesk-reprice-scan"));
app.use("/api/flipdesk/pricing/*", rateLimiter(60, 60_000, "flipdesk-pricing"));
// An automation run/dry-run scans every active listing — keep CRUD snappy but
// cap the whole surface.
app.use("/api/flipdesk/automations/*", rateLimiter(60, 60_000, "flipdesk-automations"));
// US-2160: tighter than its neighbours on purpose — every call here reaches
// eBay and one of them spends the seller's money.
app.use("/api/flipdesk/logistics/*", rateLimiter(20, 60_000, "flipdesk-logistics"));

// Broadened coverage: sensitive / abusable surfaces that previously had none.
app.use("/api/payments/*", rateLimiter(30, 60_000, "payments"));
app.use("/api/keys/*", rateLimiter(30, 60_000, "api-keys")); // incl. key creation
app.use("/api/workspace/*", rateLimiter(30, 60_000, "workspace")); // incl. invitation sends
app.use("/api/notifications/*", rateLimiter(60, 60_000, "notifications"));
app.use("/api/flipdesk/ebay/oauth/start", rateLimiter(10, 60_000, "ebay-oauth"));
app.use("/api/flipdesk/shopify/oauth/start", rateLimiter(10, 60_000, "shopify-oauth"));
app.use("/api/flipdesk/shopify/listings/*", rateLimiter(30, 60_000, "shopify-listings"));
// Policy reads/syncs are infrequent UI actions; this just blunts pathological spam.
app.use("/api/flipdesk/ebay/policies", rateLimiter(30, 60_000, "ebay-policies"));
app.use("/api/flipdesk/ebay/policies/*", rateLimiter(30, 60_000, "ebay-policies"));
app.use("/api/flipdesk/images/*", rateLimiter(30, 60_000, "flipdesk-images"));
app.use("/api/flipdesk/listings/*", rateLimiter(30, 60_000, "flipdesk-listings"));
// US-2481: a phone enqueues one job per tap, and the desktop drains in batches,
// so this sits above the listings limit without being an open door.
app.use("/api/flipdesk/extension-queue", rateLimiter(60, 60_000, "flipdesk-ext-queue"));
app.use("/api/flipdesk/extension-queue/*", rateLimiter(60, 60_000, "flipdesk-ext-queue"));
// One poll per channel per 30 minutes is the design; 60/min is far above any
// honest client and still bounds a stuck extension retrying in a loop.
app.use("/api/flipdesk/sync", rateLimiter(60, 60_000, "flipdesk-sync"));
app.use("/api/flipdesk/sync/*", rateLimiter(60, 60_000, "flipdesk-sync"));
app.use("/api/flipdesk/reconciliation/*", rateLimiter(30, 60_000, "flipdesk-recon"));
app.use("/api/flipdesk/sheets/*", rateLimiter(30, 60_000, "flipdesk-sheets"));
app.use("/api/flipdesk/import/*", rateLimiter(30, 60_000, "flipdesk-import"));
app.use("/api/flipdesk/google/oauth/start", rateLimiter(10, 60_000, "google-oauth"));
app.use("/api/flipdesk/google/sheet/*", rateLimiter(15, 60_000, "google-sheet"));
app.use("/api/content/scheduler/*", rateLimiter(60, 60_000, "content-scheduler"));
// US-923: autonomous newsletter kickoff trigger (own auth baked in, like /scheduler).
app.use("/api/newsletter/scheduler/*", rateLimiter(60, 60_000, "newsletter-kickoff"));
// US-912: public double-opt-in newsletter capture. Tight per-IP limit so the
// confirmation send can't be weaponized to blast arbitrary inboxes.
app.use("/api/newsletter/subscribe", rateLimiter(5, 60_000, "newsletter-subscribe"));
app.use("/api/newsletter/confirm", rateLimiter(30, 60_000, "newsletter-confirm"));
app.use("/api/drip/*", rateLimiter(60, 60_000, "drip-tick"));
// US-938: public, unauthenticated open/click tracking pixels — fail-closed
// against a flood (per-IP), but generous since one recipient can fire several.
app.use("/api/drip-track/*", rateLimiter(120, 60_000, "drip-track", undefined, { failClosed: true }));
// US-925: public open/click tracking for broadcast campaign emails (same shape).
app.use("/api/campaign-track/*", rateLimiter(120, 60_000, "campaign-track", undefined, { failClosed: true }));
// US-913: signed-token open/click tracking for marketing broadcast emails. Scoped
// to the tracking paths so the SES-notification webhook on /api/email is untouched.
app.use("/api/email/o/*", rateLimiter(120, 60_000, "email-track-open", undefined, { failClosed: true }));
app.use("/api/email/c/*", rateLimiter(120, 60_000, "email-track-click", undefined, { failClosed: true }));
app.use("/api/account/*", rateLimiter(10, 60_000, "account")); // data export is heavy
app.use("/api/legal/*", rateLimiter(30, 60_000, "legal"));
app.use("/api/announcements/*", rateLimiter(60, 60_000, "announcements"));
app.use("/api/referrals/*", rateLimiter(30, 60_000, "referrals"));
// US-603: /click is unauthenticated (per-IP) so it must fail-closed against a
// flood; /me rides the same scope but is keyed by user once authed.
app.use("/api/affiliate/*", rateLimiter(60, 60_000, "affiliate", undefined, { failClosed: true }));
app.use("/api/verified/*", rateLimiter(30, 60_000, "verified"));
// US-1852: the quests read is the expensive one in this group — it evaluates
// every live quest and scans cross-user events for each community challenge's
// standings. Its own tighter bucket, registered BEFORE the group limit so both
// apply and a refresh loop can't turn one screen into a table scan storm.
app.use("/api/rewards/quests", rateLimiter(10, 60_000, "rewards-quests"));
app.use("/api/rewards/*", rateLimiter(30, 60_000, "rewards"));

// Content AI endpoints — generation, research, image creation. Each
// call is expensive (multi-thousand-token Claude responses or OpenAI
// gpt-image-1). Cap at 20/min/user across these paths.
app.use("/api/content/blog/*/generate", rateLimiter(20, 60_000, "content-ai"));
// US-251 / US-252: streaming compose + section regen are long-lived SSE calls
// that each hold an upstream Claude stream open — cap tighter than batch gen.
app.use("/api/content/blog/*/compose-stream", rateLimiter(10, 60_000, "content-ai"));
app.use("/api/content/blog/*/regenerate-section", rateLimiter(20, 60_000, "content-ai"));
app.use("/api/content/social/*/generate", rateLimiter(20, 60_000, "content-ai"));
app.use("/api/content/social/*/suggest-hashtags", rateLimiter(30, 60_000, "content-ai"));
app.use("/api/content/topics/research", rateLimiter(20, 60_000, "content-ai"));
app.use("/api/content/images/*", rateLimiter(20, 60_000, "content-ai"));

// US-507: content-AI kill-switch on the same expensive paths.
app.use("/api/content/blog/*/generate", featureGate("content_ai"));
app.use("/api/content/blog/*/compose-stream", featureGate("content_ai"));
app.use("/api/content/blog/*/regenerate-section", featureGate("content_ai"));
app.use("/api/content/social/*/generate", featureGate("content_ai"));
app.use("/api/content/topics/research", featureGate("content_ai"));
app.use("/api/content/images/*", featureGate("content_ai"));

// US-1073: Ad Copy Studio generation is an expensive Claude call on the same
// kill-switch + per-min ceiling as the other content-AI paths.
// US-1709: rate-limit the Ads Command Center ops routes (sync / analyze / apply /
// upload) so a burst can't stampede the Google / Apple Ads APIs.
app.use("/api/admin/ads/*", rateLimiter(40, 60_000, "ads-ops"));
app.use("/api/admin/ads/generate", rateLimiter(20, 60_000, "ads-ai"));
app.use("/api/admin/ads/generate", featureGate("content_ai"));

// Coarse per-IP ceiling on the unauthenticated webhook receivers — blunts
// floods only. Legit Stripe/eBay bursts stay well under it, and a 429 just
// makes the provider retry (idempotency in US-277 makes that safe).
// US-354: these are the most abusable UNAUTHENTICATED surfaces, so they run
// fail-CLOSED — a counter-store outage drops to a per-replica fallback ceiling
// (never unlimited), and a header-stripped flood is bucketed, not waved through.
app.use("/api/webhooks/*", rateLimiter(600, 60_000, "webhook-stripe", undefined, { failClosed: true }));
app.use("/api/flipdesk/webhooks/*", rateLimiter(600, 60_000, "webhook-ebay", undefined, { failClosed: true }));
// GoTrue send-email auth hook — signature-authed, called server-to-server per
// auth email. GoTrue already caps email volume upstream (GOTRUE_RATE_LIMIT_EMAIL_SENT),
// so a generous ceiling here is just an anti-flood backstop; fail-open so a
// counter-store blip never blocks a legit confirmation email.
app.use("/api/auth/hooks/*", rateLimiter(600, 60_000, "auth-hook", undefined, { failClosed: false }));

// US-1793: the OpenAPI spec is PUBLIC — mounted before the api-key auth
// middleware so partners can fetch it without a key. Cached at the edge; the
// spec is a static object so this is cheap.
app.get("/api/v1/openapi.json", (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(OPENAPI_SPEC);
});

// Public API v1 — API key auth, then per-key, plan-tiered, fail-closed rate
// limits (US-800). Reads (GET) and the expensive writes (POST submit / PATCH
// webhook) get SEPARATE budgets keyed by the API key id — so one key can't
// drain another's, a read poll can't exhaust the submit budget, and a
// counter-store outage limits via the local fallback instead of handing a paid
// API unlimited throughput. Limit + subject + 429 envelope come from
// middleware/api-v1-rate.ts.
app.use("/api/v1/*", apiKeyAuthMiddleware);
app.use(
  "/api/v1/*",
  rateLimiter(apiV1ReadLimit, 60_000, "api-v1-read", undefined, {
    methods: ["GET"],
    subject: apiV1Subject,
    failClosed: true,
    errorBody: apiV1RateLimitBody,
  }),
);
app.use(
  "/api/v1/*",
  rateLimiter(apiV1WriteLimit, 60_000, "api-v1-write", undefined, {
    methods: ["POST", "PATCH", "PUT", "DELETE"],
    subject: apiV1Subject,
    failClosed: true,
    errorBody: apiV1RateLimitBody,
  }),
);
// US-2563: Idempotency-Key replay protection.
//
// AFTER apiKeyAuthMiddleware, which is what puts userId/apiKeyId on the context
// this middleware scopes its records by, and AFTER the rate limiter, so a flood
// of retries is shed before any of it reaches the table. BEFORE apiUsageMiddleware
// deliberately: a replayed request did not consume a grade, and logging it as a
// billable call would make the usage ledger count the retry the replay exists to
// make free.
app.use("/api/v1/*", apiIdempotencyMiddleware);
// US-596: append a usage-ledger row per authenticated /api/v1 call (after the
// auth + rate-limit gates, so only billable calls are logged) — powers the
// partner usage/billing dashboard. Fire-and-forget; never blocks the response.
app.use("/api/v1/*", apiUsageMiddleware);

// US-887: maintenance-window enforcement. Runs LAST in the middleware chain (so
// userId is already set by the per-prefix authMiddleware above) on the
// user-facing action surfaces. Under an effective 'blocked'/'read_only' window
// it 503s non-admin traffic; a no-op (one cached read) when nothing is active.
// /api/admin is intentionally NOT guarded — admins are never locked out (AC#6).
// US-9105: a maintenance window must stop connector traffic as well.
app.use("/mcp", maintenanceGuard);
app.use("/mcp/*", maintenanceGuard);
app.use("/api/grade/*", maintenanceGuard);
app.use("/api/flipdesk/*", maintenanceGuard);
app.use("/api/payments/*", maintenanceGuard);

// Routes
app.route("/health", healthRoutes);
// US-887: PUBLIC maintenance status — the SPA app-shell banner reads this with
// no auth so logged-out / public surfaces show the notice too.
app.route("/api/maintenance", maintenanceRoutes);
app.route("/api/grade", gradeRoutes);
// US-585: waitlist — public capture (POST /) + authed access check (GET /me).
app.route("/api/waitlist", waitlistRoutes);
// US-867: public, unauthenticated buyer trust-guarantee claim intake.
app.route("/api/guarantee", guaranteePublicRoutes);
app.route("/api/payments", paymentRoutes);
// StoreKit IAP: verify is authed (/api/payments/* covers it); the App Store
// Server Notifications webhook is unauthed (verified by Apple's JWS signature).
app.route("/api/payments/appstore", appstoreVerifyRoutes);
app.route("/api/payments/google", googlePlayVerifyRoutes);
app.route("/api/webhooks", webhookRoutes);
// GoTrue send-email auth hook (signature-authed; not behind authMiddleware).
app.route("/api/auth/hooks", authHookRoutes);
// US-914: SES bounce/complaint feedback via SNS (public, signature-verified).
app.route("/api/email", emailSnsRoutes);
// US-913: signed open pixel + click redirect (public, token-verified). Shares the
// /api/email prefix with email-sns; the /o/:token & /c/:token paths don't collide.
app.route("/api/email", emailEngagementRoutes);
app.route("/api/webhooks/appstore", appstoreWebhookRoutes);
// US-1650: Google Play RTDN Pub/Sub push (public, GOOGLE_RTDN_WEBHOOK_SECRET-verified).
app.route("/api/webhooks/google-play", googlePlayRtdnRoutes);
app.route("/api/keys", apiKeyRoutes);
app.route("/api/passport", passportRoutes);
app.route("/api/passport-identity", passportIdentityRoutes);
app.route("/api/v1", apiV1Routes);
// US-9103: the MCP endpoint for the Claude connector. Top-level /mcp because
// that is the URL a seller pastes into a client. Auth lands in US-9104; until
// then MCP_ENABLED is off in production and tools/list is empty.
// US-9122: the token and revoke endpoints. PUBLIC and unauthenticated, like
// every token endpoint - the credential IS the request body - and mounted
// before the MCP auth middleware for that reason. They 404 until
// MCP_OAUTH_ENABLED is set, same as the discovery documents below.
app.route("/oauth", oauthRoutes);

// US-9121: the consent callback the /connect/claude page posts to. AUTHENTICATED,
// unlike everything above it: the grant is written against the SESSION user, so
// the identity can never come from the request body. A consent endpoint that
// took a user id from its caller would let anyone mint a grant for anyone.
app.use("/api/oauth/consent", authMiddleware);
app.post("/api/oauth/consent", (c) => handleOAuthConsent(c));

// US-9122 AC9: what a seller sees and revokes on the API-keys page. The grant
// tables are deny-all with no policies, so these are the only way a seller ever
// reads or changes them. Authenticated and filtered on the SESSION user.
app.use("/api/oauth/connections", authMiddleware);
app.use("/api/oauth/connections/*", authMiddleware);
app.get("/api/oauth/connections", (c) => handleListOAuthConnections(c));
app.post("/api/oauth/connections/:id/revoke", (c) => handleRevokeOAuthConnection(c));

// US-9120: OAuth discovery. BOTH documents are public and mounted BEFORE the
// MCP auth middleware — they contain no secrets (endpoint URLs and supported
// parameters), and requiring a credential to discover how to get a credential
// is a loop. A client that gets a 401 from /mcp follows the WWW-Authenticate
// header here, then to the authorization server's own metadata.
//
// Cached at the edge and CORS-open, the same as /api/v1/openapi.json: a client
// may fetch these from a browser context during an interactive add.
for (
  const [path, body] of [
    ["/.well-known/oauth-protected-resource", protectedResourceMetadata],
    ["/.well-known/oauth-authorization-server", authorizationServerMetadata],
  ] as const
) {
  app.get(path, (c) => {
    // 404 until the endpoints these documents point at exist. A client that
    // cannot discover an authorization server falls back to a static
    // credential and works; one that discovers a server whose authorize
    // endpoint 404s does not.
    if (!isOAuthEnabled()) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "public, max-age=3600");
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(body());
  });
}

// US-9104: the connector authenticates with an API key in Authorization: Bearer
// (or X-API-Key). Applied to the whole prefix so the legacy GET/SSE and DELETE
// paths are covered too, not just POST.
app.use("/mcp/*", mcpAuthMiddleware);
app.use("/mcp", mcpAuthMiddleware);
// US-9105: classify read-vs-write from the JSON-RPC method BEFORE the limiters,
// because every MCP message is a POST and the /api/v1 method split cannot work
// here — a tools/list poll must not be able to drain the publish budget.
app.use("/mcp/*", mcpClassifyMiddleware);
app.use("/mcp", mcpClassifyMiddleware);
for (const path of ["/mcp", "/mcp/*"]) {
  app.use(
    path,
    rateLimiter(mcpReadLimit, 60_000, "mcp-read", undefined, {
      subject: apiV1Subject,
      bypass: bypassUnlessRead,
      failClosed: true,
      errorBody: mcpRateLimitBody,
    }),
  );
  app.use(
    path,
    rateLimiter(mcpWriteLimit, 60_000, "mcp-write", undefined, {
      subject: apiV1Subject,
      bypass: bypassUnlessWrite,
      failClosed: true,
      errorBody: mcpRateLimitBody,
    }),
  );
}
// US-596 equivalent for the connector: one ledger row per BILLABLE call,
// broken out by tool. Handshake, ping, discovery and tools/list create none.
app.use("/mcp/*", mcpUsageMiddleware);
app.use("/mcp", mcpUsageMiddleware);
app.route("/mcp", mcpRoutes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/push", pushRoutes);
app.route("/api/flipdesk/ebay", flipdeskEbayRoutes);
app.route("/api/flipdesk/shopify", flipdeskShopifyRoutes);
app.route("/api/flipdesk/depop", flipdeskDepopRoutes);
app.route("/api/flipdesk/etsy", flipdeskEtsyRoutes);
app.route("/api/flipdesk/whatnot", flipdeskWhatnotRoutes);
app.route("/api/flipdesk/webhooks", flipdeskWebhookRoutes);
app.route("/api/flipdesk/grading", flipdeskGradingRoutes);
app.route("/api/flipdesk/demand", flipdeskDemandRoutes);
app.route("/api/flipdesk/photo-profiles", flipdeskPhotoProfilesRoutes);
app.route("/api/flipdesk/images", flipdeskImageRoutes);
app.route("/api/flipdesk/listings", flipdeskListingsRoutes);
app.route("/api/flipdesk/reconciliation", flipdeskReconciliationRoutes);
app.route("/api/flipdesk/sheets", flipdeskSheetsRoutes);
// US-2518: durable CSV inventory import. The browser posts the mapped rows and
// polls; the worker survives the tab closing and every run is reversible.
app.route("/api/flipdesk/import", flipdeskImportRoutes);
app.route("/api/flipdesk/ai", flipdeskAiRoutes);
app.route("/api/flipdesk/scout", flipdeskScoutRoutes);
// US-1863: Thrift Radar aggregates — venue list by bounding box + venue detail.
// Read-only, Pro+ (compPulls), k-anonymity floor enforced server-side.
app.route("/api/flipdesk/radar", flipdeskRadarRoutes);
app.route("/api/flipdesk/measure", flipdeskMeasureRoutes);
// US-1104 Garment Passport resale-value & depreciation forecast — list price,
// days-to-sell, 12-month resale projection + CI from the owner's SKU-class sale
// ledger. Tenant-scoped; compPulls plan tier + passport_forecast kill-switch.
app.route("/api/flipdesk/forecast", flipdeskForecastRoutes);
// US-1869 Inventory Equity — conservative per-item liquidation value + tenant
// aggregate from CACHED comps (zero new eBay/AI calls). Tenant-scoped; base
// flipdesk gate + inventory_equity kill-switch. Display-only (US-1868 fence).
app.route("/api/flipdesk/equity", flipdeskEquityRoutes);
app.route("/api/flipdesk/product", flipdeskProductRoutes);
app.route("/api/flipdesk/templates", flipdeskTemplatesRoutes);
app.route("/api/flipdesk/autolister", flipdeskAutolisterRoutes);
app.route("/api/flipdesk/google/photos", flipdeskGooglePhotosRoutes);
app.route("/api/flipdesk/google", flipdeskGoogleRoutes);
app.route("/api/flipdesk/google", flipdeskGoogleSyncRoutes);
app.route("/api/flipdesk/disclosure", flipdeskDisclosureRoutes);
// US-2481: extension work queued from mobile, drained by the desktop Lister.
// Stores WHAT to do only — never a marketplace credential (the ADR bright line,
// enforced here, in lib/extension-queue.ts and as a CHECK on the table).
app.route("/api/flipdesk/extension-queue", flipdeskExtensionQueueRoutes);
app.route("/api/flipdesk/sync", flipdeskSyncRoutes);
app.route("/api/flipdesk/expenses", flipdeskExpensesRoutes);
app.route("/api/flipdesk/consignment", flipdeskConsignmentRoutes);
app.route("/api/flipdesk/pricing", flipdeskPricingRoutes);
app.route("/api/flipdesk/automations", flipdeskAutomationsRoutes);
app.route("/api/flipdesk/logistics", flipdeskLogisticsRoutes);
// US-834: AI Support Assistant (streaming chat + conversation history).
app.route("/api/support/assistant", supportAssistantRoutes);
// Condition-aware repricing cron. OUTSIDE /api/flipdesk so the user-JWT
// middleware above doesn't intercept it; the handler enforces
// X-Internal-Job-Secret itself (mirrors the GSC sync cron).
app.post("/api/jobs/reprice-scan", (c) => handleRepriceScanCron(c));
// US-2683: eBay Promoted Listings search-term ingest, daily.
app.post("/api/jobs/ebay-search-terms", (c) => handleEbaySearchTermsCron(c));
// US-2690: fill the learned style-code index from the market instead of waiting
// for a seller to photograph each tag.
app.post("/api/jobs/style-code-sweep", (c) => handleStyleCodeSweepCron(c));
app.post("/api/jobs/style-code-discovery", (c) => handleStyleCodeDiscoveryCron(c));
// US-672 repricing-automation cron — applies owner-defined rules. Same
// X-Internal-Job-Secret gate as reprice-scan.
app.post("/api/jobs/reprice-rules", (c) => handleRepriceRulesCron(c));
// US-150 price-drop/promo scheduler cron (hourly) — trigger/action/scope
// rules over active listings. Same X-Internal-Job-Secret gate.
app.post("/api/jobs/automation-rules", (c) => handleAutomationRulesCron(c));
// US-2272 verified-seller credential refresh. Re-renders the frozen "N items
// graded · X / 10 average" block on live eBay listings of GRADED items, since
// eBay bans active content so a description can never self-update. Same
// X-Internal-Job-Secret gate; capped + overlap-locked.
app.post("/api/jobs/credentials-refresh", (c) => handleCredentialsRefreshCron(c));
// US-525 AutoLister reclaim sweeper. OUTSIDE the /api/flipdesk/autolister/*
// JWT wildcard so a cron (no user token) can reach it; the handler enforces
// X-Internal-Job-Secret itself. Resumes batches whose worker died mid-run.
app.post("/api/jobs/autolister-reclaim", (c) => handleAutolisterReclaimCron(c));
// US-559 bulk-publish reclaim sweeper. Same job-secret gating; resumes durable
// publish batches whose worker died mid-run so nothing is stranded.
app.post("/api/jobs/publish-batch-reclaim", (c) => handlePublishBatchReclaimCron(c));
// US-1790 B2B batch-grading reclaim sweeper. Same job-secret gating; resumes
// durable grading batches whose worker died mid-run so no garment is stranded.
app.post("/api/jobs/grading-batch-reclaim", (c) => handleGradingBatchReclaimCron(c));
// US-2518 CSV-import reclaim sweeper. Same job-secret gating; resumes an import
// whose container died, from the row effects it had already recorded.
app.post("/api/jobs/flipdesk-import-reclaim", (c) => handleImportReclaimCron(c));
// US-1518 thumbnail backfill. Generates 320px thumbnails for item_photos missing
// one (existing photos + new iOS uploads); drain-to-zero scheduler. Same gate.
app.post("/api/jobs/thumbnail-backfill", (c) => handleThumbnailBackfillCron(c));
app.post("/api/jobs/durability-aggregate", (c) => handleDurabilityAggregateCron(c));
// US-1863: Thrift Radar aggregation + retention prune.
app.post("/api/jobs/radar-aggregate", (c) => handleRadarAggregateCron(c));
app.route("/api/admin", adminBillingRoutes);
// US-507 admin kill-switch management (admin JWT + MFA via /api/admin/* group).
app.route("/api/admin/feature-flags", adminFlagsRoutes);
// US-587 data-driven plan pricing/limits editor. Admin JWT + AAL2 via the
// /api/admin/* group; mutations additionally require super_admin + MFA step-up.
app.route("/api/admin/pricing", adminPricingRoutes);
// US-885 unified pricing config: plan entitlements (reuses pricing_plans) +
// per-grading-tier / per-credit-pack prices (pricing_config). Same admin JWT +
// AAL2; mutations require super_admin + MFA step-up.
app.route("/api/admin/config", adminConfigRoutes);
// US-722 per-platform category map: extend/override/confirm the no-API taxonomy
// mappings read by every seller's listing generation (admin JWT via /api/admin/*).
app.route("/api/admin/category-map", adminCategoryMapRoutes);
// US-2425: median eBay-aspect coverage of generated drafts, by leaf category.
app.route("/api/admin/listing-coverage", adminListingCoverageRoutes);
// US-2779: what the visual pass offered and what the model ruled, in aggregate.
app.route("/api/admin/identification-provenance", adminIdentificationProvenanceRoutes);
// US-585 waitlist/beta-gating admin surface (admin JWT + AAL2 via /api/admin/*).
app.route("/api/admin/waitlist", adminWaitlistRoutes);
app.route("/api/admin/grading", adminGradingRoutes);
// US-474 admin dispute resolution. Service-role writes (grade_reports/disputes/
// submissions) that used to no-op under RLS as browser calls; reseals the
// certificate on a grade adjustment. Admin JWT + MFA via the /api/admin/* group.
app.route("/api/admin/disputes", adminDisputesRoutes);
// US-867: buyer trust-guarantee claim review (admin + super_admin).
app.route("/api/admin/claims", adminClaimsRoutes);
app.route("/api/admin/guarantee-pool", adminGuaranteePoolRoutes);
// US-1579: MeasureCard mail-fulfillment queue (PII lives behind admin auth).
app.route("/api/admin/measure-cards", adminMeasureCardRoutes);
// US-839 admin support inbox — read/reply/resolve escalated AI-assistant
// conversations. Service-role writes (human_agent message + status flips) that
// would no-op under RLS as browser calls; notifies the user on reply/resolve.
// Admin JWT + MFA via the /api/admin/* group.
app.route("/api/admin/support", adminSupportRoutes);
// US-900 admin support-ticket queue — triage/reply/resolve user-opened tickets,
// add operator-only internal notes; public replies notify the user (US-582
// email). Distinct from the assistant inbox above. Admin JWT + MFA + audited.
app.route("/api/admin/support-tickets", adminSupportTicketsRoutes);
// US-909 per-admin saved views for the admin list pages (users/signals/tickets/
// reconciliation). Admin JWT + AAL2 via the /api/admin/* group; every read/write
// is scoped to the calling admin so views are private.
app.route("/api/admin/views", adminViewsRoutes);
// US-903 GDPR/CCPA data-subject request workflow — the operator queue for
// export/delete requests. List/detail/create/reject + process (export assembles
// a signed-URL archive; delete is super_admin + MFA step-up staged anonymize/
// erase that retains financial/audit records). Service-role reads/writes
// (data_requests is admin-select-only, never client-writable); admin JWT + AAL2
// MFA via the /api/admin/* group; every action audited.
app.route("/api/admin/compliance", adminComplianceRoutes);
// US-904 legal/ToS version manager — publish Terms/Privacy versions + force
// re-acceptance, with acceptance-coverage reporting. Reads are admin; publishing
// is super_admin + a fresh MFA step-up and is audited. Mounted at the more
// specific /legal sub-path so it doesn't overlap the compliance queue above.
app.route("/api/admin/compliance/legal", adminLegalRoutes);
// US-841 abuse & usage monitoring for the AI assistant — recent abuse events,
// per-user usage rollups vs the US-836 caps, current lockouts + manual unlock,
// and flagged messages. Service-role reads (usage/abuse/messages are RLS-no-
// policy, never client-readable) + the unlock write. Admin JWT + AAL2 MFA via
// the /api/admin/* group. Distinct prefix avoids overlap with the inbox above.
app.route("/api/admin/support-monitoring", adminMonitoringRoutes);
// US-1058 notification event catalog: every notification type, the preference
// category that gates it (from notify.ts PREF_KEY — the real send-time gate) and
// its delivery volume. Cross-tenant read; admin JWT + AAL2 MFA via /api/admin/*.
app.route("/api/admin/notifications", adminNotificationsRoutes);
// US-840 support knowledge-base authoring/publishing/versioning — the single
// control surface for the corpus the AI assistant may speak from. Service-role
// writes (support_kb_articles has no client write policy, 00183); admin JWT +
// AAL2 MFA via the /api/admin/* group.
app.route("/api/admin/knowledge-base", adminKnowledgeBaseRoutes);
app.route("/api/admin/brand-knowledge", adminBrandKnowledgeRoutes);
// US-2244: the RN/CA resolve queue — the most-sighted care-label registry numbers
// (US-2243) and the company each one turns out to belong to. Aggregate reference
// data, no tenant rows; admin JWT + AAL2 MFA + content:publish.
app.route("/api/admin/registered-numbers", adminRegisteredNumbersRoutes);
app.route("/api/admin/users", adminUsersRoutes);
// US-908 granular RBAC scope management: view/edit which permission scopes each
// role holds + per-admin additive grants. Reads are admin; mutations are
// super_admin + users:role scope + fresh MFA step-up + audited.
app.route("/api/admin/scopes", adminScopesRoutes);
// US-901 global admin search / command palette: unified, ranked lookup across
// users, submissions, certificates, listings, sales and tickets. Read-only;
// admin JWT + AAL2 via the /api/admin/* group is the authorization boundary.
app.route("/api/admin/search", adminSearchRoutes);
// US-581 super-admin impersonation / "view as" + audited start/stop. Admin JWT
// + AAL2 via the /api/admin/* group; start additionally requires super_admin +
// a fresh MFA step-up (it mints a real session as the target user).
app.route("/api/admin/impersonation", adminImpersonationRoutes);
// US-582 ad-hoc admin → customer transactional messaging. Admin JWT + AAL2 via
// the /api/admin/* group; per-admin rate-limited above; audited + recorded.
app.route("/api/admin/messages", adminMessagesRoutes);
// US-584 admin job/queue monitoring + manual retry/cancel + cron health. Admin
// JWT + AAL2 via the /api/admin/* group.
app.route("/api/admin/jobs", adminJobsRoutes);
// US-881 Operations console: background-jobs & scheduler view + manual Run-now
// (super_admin + MFA step-up + job_lock + audit). Admin JWT + AAL2 via group.
app.route("/api/admin/ops", adminOpsRoutes);
// US-884 DB-backed settings registry. Admin JWT + AAL2 via the /api/admin/*
// group; the PUT mutation is additionally super_admin + MFA step-up + audited.
app.route("/api/admin/settings", adminSettingsRoutes);
// US-589 bulk admin operations (bulk credit grant / suspend-unsuspend / regrade).
// Idempotency-keyed + audited; admin JWT + AAL2 via the /api/admin/* group,
// with credit/suspend additionally requiring a fresh MFA step-up.
app.route("/api/admin/bulk", adminBulkRoutes);
// US-1565: dashboard/system aggregates + task-board CRUD through the edge boundary.
app.route("/api/admin/dashboard", adminDashboardRoutes);
app.route("/api/admin/tasks", adminTasksRoutes);
// US-1657 Agentic OS proposal sign-off (list/approve/reject) — ops:write, audited
app.route("/api/admin/agents", adminAgentsRoutes);
// US-476/477 admin content moderation (approve/reject/ban) — audited
// service-role routes (admin JWT + AAL2 via the /api/admin/* group).
app.route("/api/admin/moderation", adminModerationRoutes);
// US-591 abuse / fraud dashboard — read-only cross-account aggregate view
// (repeat offenders, velocity / rate-limit abuse, duplicate-account /
// shared-payment, chargebacks). Admin JWT + AAL2 via the /api/admin/* group.
app.route("/api/admin/fraud", adminFraudRoutes);
// US-888 Trust & Safety — durable, triageable fraud/abuse signals queue
// (cross-account phash photo reuse + velocity), populated by the abuse-scan
// cron. List/triage API; suspend/void-grade actions reuse the existing audited
// moderation/user endpoints. Admin JWT + AAL2 via the /api/admin/* group;
// resolving a signal additionally requires a super_admin MFA step-up.
app.route("/api/admin/safety", adminSafetyRoutes);
// US-1103 Garment Passport integrity — durable, triageable ledger-integrity
// anomalies (wear reversal, duplicate fingerprint across owners, rapid re-claim,
// token replay), populated by the passport-integrity-scan cron. List/triage API
// + admin actions (flag, annotate, sever a probable link). Admin JWT + AAL2 via
// the /api/admin/* group; resolving/severing additionally requires a super_admin
// MFA step-up.
app.route("/api/admin/passport-integrity", adminPassportIntegrityRoutes);
// US-891 Revenue & MRR analytics dashboard — read-only server-side rollup
// (MRR/ARR, plan mix, MRR movement, trial conversion, credit-pack revenue +
// daily/weekly time series) from the revenue_dashboard RPC. Admin JWT + AAL2 via
// the /api/admin/* group; no writes, so no step-up.
app.route("/api/admin/revenue", adminRevenueRoutes);
// US-907 Product funnel & retention analytics — read-only server-side rollups
// (signup activation funnel + weekly cohort retention) from the funnel_metrics /
// retention_cohorts RPCs. Admin JWT + AAL2 via the /api/admin/* group; no writes,
// so no step-up. Complements (does not replace) the PostHog product analytics.
app.route("/api/admin/analytics", adminAnalyticsRoutes);
// US-946 Trial-conversion drip analytics — read-only funnel/ROI rollup
// (per-step funnel, signup-week cohorts, in-trial vs win-back + incentive +
// A/B splits, attention flags) from the drip_analytics RPC. Admin JWT + AAL2
// via the /api/admin/* group; no writes, so no step-up.
app.route("/api/admin/drip", adminDripRoutes);
// US-931 Newsletter program analytics & deliverability — read-only per-issue +
// program-level open/CTR/bounce/complaint/unsub rates + list size/growth from the
// newsletter_analytics RPC, plus a super_admin + step-up deliverability-guard
// enforce action (ops alert + auto-pause on a critical bounce/complaint breach).
// Admin JWT + AAL2 via the /api/admin/* group.
app.route("/api/admin/newsletter", adminNewsletterRoutes);
app.route("/api/admin/suppressions", adminSuppressionsRoutes);
// US-912 standalone newsletter subscriber list — admin view + CSV export of the
// double-opt-in lead registry. Admin JWT + AAL2 via the /api/admin/* group.
app.route("/api/admin/subscribers", adminSubscribersRoutes);
// US-916 product "What's New" changelog — admin CRUD + manual auto-capture
// trigger. Admin JWT + AAL2 via the /api/admin/* group.
app.route("/api/admin/changelog", adminChangelogRoutes);
// US-929 lifecycle email-journey console — view journeys + per-step metrics +
// enrollment roll-up; enable/disable each journey (super_admin + step-up + audited,
// since enabling starts autonomous sends). Admin JWT + AAL2 via /api/admin/*.
app.route("/api/admin/journeys", adminJourneyRoutes);
// US-894 AI spend & token-usage dashboard — token/cost rollups by
// model/feature/day from the ai_usage_events ledger (re-priced from the
// config-driven price table). Admin JWT + AAL2 via the /api/admin/* group;
// read-only, so no step-up.
app.route("/api/admin/ai", adminAiSpendRoutes);
// US-895 AI cost budget guardrails — operator-editable per-feature spend budgets
// (alert/throttle/kill) + breach history + one-click re-enable. Admin JWT + AAL2
// via the /api/admin/* group; writes are super_admin + MFA step-up + audited.
app.route("/api/admin/ai-budgets", adminAiBudgetsRoutes);
// US-897 Marketplace connection health console — cross-tenant view of every
// marketplace_connection's token expiry / refresh error / last sync with a
// derived health, plus admin-triggered token refresh and flag-for-reconnect.
// Reads are admin + AAL2 (read-only, no token material returned); the refresh /
// flag mutations are super_admin + MFA step-up + audited.
app.route("/api/admin/marketplace-connections", adminMarketplaceConnectionsRoutes);
// US-898 eBay sync & conflict-resolution console — cross-tenant view of
// flipdesk_sync_runs (with a config-driven STUCK flag), open sync_conflicts and
// orphan eBay sales, plus re-run / accept-side / orphan-match resolution actions.
// Reads are admin + AAL2; the three mutations are super_admin + MFA step-up +
// audited, and each resolves the owning tenant from the row before writing.
app.route("/api/admin/marketplace", adminMarketplaceOpsRoutes);
// US-899 cross-tenant listing/AutoLister pipeline oversight — failed/stuck
// generation & publish batches, failed generation jobs, and listings stuck
// "sending"/failed, with retry/cancel reusing the US-559 durable batch helpers.
// Reads are admin + AAL2; the four mutations are super_admin + MFA step-up +
// audited. Mounted under /marketplace/pipeline (collision-free with the ops
// routes above).
app.route("/api/admin/marketplace/pipeline", adminMarketplacePipelineRoutes);
// US-846 Condition Index catalog curation — list/create/edit/disable
// condition_index_seeds + on-demand comp refresh. Admin JWT + AAL2 via the
// /api/admin/* group; every mutation audited.
app.route("/api/admin/condition-index", adminConditionIndexRoutes);
// US-905: audit-log export (super-admin, audited) + anomaly triage.
app.route("/api/admin/audit", adminAuditRoutes);
// US-326 public transparency report. Lives at /api/grading/public (NOT
// /api/grade/*, which is JWT-gated) so the unauthenticated /transparency page
// can read platform-wide aggregate accuracy stats. Returns no per-tenant data.
app.route("/api/grading/public", publicGradingRoutes);
// US-327 grading regression monitor cron. OUTSIDE /api/admin so the wildcard
// admin-JWT middleware doesn't intercept it; the handler enforces
// X-Internal-Job-Secret itself (mirrors the GSC sync + reprice crons).
app.post("/api/jobs/grading-monitor", (c) => handleGradingMonitorCron(c));
// US-2035: sampled regrade reproducibility. Off unless GRADING_SELF_CONSISTENCY_SAMPLE is set.
app.post("/api/jobs/grading-self-consistency", (c) => handleGradingSelfConsistencyCron(c));
// US-895 AI cost budget guardrails cron. OUTSIDE /api/admin; the handler enforces
// X-Internal-Job-Secret itself. Evaluates per-feature spend budgets and, on a
// fresh breach, alerts + (for action=kill) flips the feature kill-switch off.
app.post("/api/jobs/ai-budget-guardrails", (c) => handleAiBudgetCron(c));
// US-2004: cron-fleet stall alerting. Same job-secret pattern. Emits a CRITICAL
// ops event when a recorded cron has missed its schedule, so a silently-dead
// payout / retention / stuck-submission job reaches a human instead of only
// being visible to an agent read-tool nobody thought to invoke.
app.post("/api/jobs/cron-fleet-health", (c) => handleCronFleetHealthCron(c));
// US-495 stuck-submission recovery sweep. OUTSIDE the JWT groups; the handler
// enforces X-Internal-Job-Secret itself. Fails orphaned 'processing' grades and
// reverses their charge so a crash/redeploy can't strand paid work.
app.post("/api/jobs/stuck-submissions", (c) => handleStuckSubmissionsCron(c));
// US-1588 Agentic OS scheduler: runs due agents on the shared cron rails.
app.post("/api/jobs/agent-tick", (c) => handleAgentTickCron(c));
// US-1607: weekly agent-eval gate (writes agents.eval_pass + agents.eval_results).
app.post("/api/jobs/agent-eval", (c) => handleAgentEvalCron(c));
// US-1592 Daily Operator Brief: one cross-agent digest to admins.
app.post("/api/jobs/operator-brief", (c) => handleOperatorBriefCron(c));
// US-795 push device-token prune. OUTSIDE the JWT groups; the handler enforces
// X-Internal-Job-Secret itself. Deletes long-inactive (signed-out / dead-token)
// rows so the table doesn't grow unbounded and send fan-outs stay cheap.
app.post("/api/jobs/push-token-prune", (c) => handlePushTokenPruneCron(c));
// US-456 eBay sync-run reaper. OUTSIDE the JWT groups; the handler enforces
// X-Internal-Job-Secret itself. Flips runs stuck in 'running' past the
// threshold to 'failed' so the Reconciliation UI unblocks even when no new pull
// is attempted (a crashed/killed pull would otherwise hang forever).
app.post("/api/jobs/sync-reaper", (c) => handleSyncReaperCron(c));
// US-498 transactional-email outbox retry sweep. OUTSIDE the JWT groups; the
// handler enforces X-Internal-Job-Secret itself. Re-sends failed critical
// emails with backoff and dead-letters after max attempts.
app.post("/api/jobs/email-retry", (c) => handleEmailRetryCron(c));
// US-504 periodic DB integrity scan (orphans/drift/stuck rows -> alert).
app.post("/api/jobs/integrity-scan", (c) => handleIntegrityScanCron(c));
// US-490 certificate-integrity backfill: seals pre-US-333 certified reports
// (hash + signature) so legacy certificates verify instead of reporting
// "unverifiable". Idempotent; run once at launch, safe to re-run any time.
app.post("/api/jobs/cert-integrity-backfill", (c) => handleCertIntegrityBackfillCron(c));
// US-521 data-retention / PII purge (delete grading photos past the window).
app.post("/api/jobs/data-retention", (c) => handleDataRetentionCron(c));
// US-621 Condition Index refresh — rebuilds the curated price-vs-grade curves.
app.post("/api/jobs/condition-index-refresh", (c) => handleConditionIndexRefreshCron(c));
// US-1746 Condition Index seed generation — proposes new seeds from graded demand.
app.post("/api/jobs/condition-index-seedgen", (c) => handleConditionIndexSeedGenCron(c));
// US-811 App Store subscription expiry sweep — backstop that lapses appstore-
// billed users to free when Apple's expiry notification was lost (stale
// flipdesk_period_end past a 72h grace window). Handler enforces the job secret.
app.post("/api/jobs/appstore-expiry-sweep", (c) => handleAppstoreExpirySweepCron(c));
// US-1619 / C6: Google Play backstop — lapse cancelled/expired Play subscriptions
// whose flipdesk_period_end is past the grace window (no RTDN webhook yet).
app.post("/api/jobs/googleplay-expiry-sweep", (c) => handleGooglePlayExpirySweepCron(c));
// US-383 daily trial-expiry downgrade cron. OUTSIDE /api/* JWT groups; the
// handler enforces X-Internal-Job-Secret itself (mirrors the other crons).
app.post("/api/jobs/trial-expiry", (c) => handleTrialExpiryCron(c));
// US-1112 consignor auto-payout sweep: pay each consignor their share when a
// consigned item sells. OUTSIDE /api/* JWT groups; handler enforces the
// internal-job-secret + reads the consignor_auto_payout_mode config flag.
app.post("/api/jobs/consignor-payouts", (c) => handleConsignorPayoutsCron(c));
// US-2228 AC3 recurring-expense sweep: copy each monthly template forward, one
// entry per month, up to today. OUTSIDE /api/* JWT groups; handler enforces the
// internal-job-secret. Idempotent by a partial unique index, so re-running it
// (or racing it) cannot duplicate a month.
app.post("/api/jobs/expense-recurrence", (c) => handleExpenseRecurrenceCron(c));
// US-1295 affiliate auto-payout sweep: accrue affiliate conversions + pay each
// affiliate their eligible balance over Stripe Connect. OUTSIDE /api/* JWT
// groups; handler enforces the internal-job-secret + reads affiliate_payout_config.
app.post("/api/jobs/affiliate-payouts", (c) => handleAffiliatePayoutsCron(c));
// US-929 daily lifecycle email-journey tick (welcome / trial-nurture / win-back).
// OUTSIDE /api/* JWT groups; the handler enforces X-Internal-Job-Secret itself.
// The /api/jobs/* middleware records the run to cron_runs automatically.
app.post("/api/jobs/journey-tick", (c) => handleJourneyTickCron(c));
// US-928 newsletter self-tuning: recompute topic/subject/send-hour weights from
// engagement so the assembler biases the next issue. Handler enforces the secret.
app.post("/api/jobs/newsletter-tuning", (c) => handleNewsletterTuningCron(c));
// US-917 newsletter topic-bank refill: top the evergreen educational topic bank up
// toward target when it drops below the minimum (Haiku). Handler enforces the secret.
app.post("/api/jobs/newsletter-topic-bank-refill", (c) => handleNewsletterTopicBankRefillCron(c));
// US-927 newsletter A/B finalize: sweep issues whose measurement window elapsed,
// pick the winning subject from holdout engagement, send it to the remainder.
app.post("/api/jobs/newsletter-ab-finalize", (c) => handleNewsletterAbFinalizeCron(c));
// US-926 newsletter dispatch: assign send windows to approved issues and release
// each due issue (cadence guard + per-recipient send-time optimization). Hourly.
app.post("/api/jobs/newsletter-dispatch", (c) => handleNewsletterDispatchCron(c));
// US-888 abuse-signal scan — populates the Trust & Safety queue with
// cross-account phash photo-reuse + submission-velocity signals. Idempotent
// (dedupe_key); the handler enforces X-Internal-Job-Secret itself.
app.post("/api/jobs/abuse-scan", (c) => handleAbuseScanCron(c));
// US-2447 host hang-watchdog check-in. NOT an edge cron — this is called BY the
// host script scripts/ops/edge-watchdog.sh (installed at
// /opt/gradethread/edge-watchdog.sh, every minute), which is the only thing
// that ends an edge hang. Recording it makes the watchdog's ABSENCE visible via
// /health/ready instead of only via the next outage. The handler enforces
// X-Internal-Job-Secret itself.
app.post("/api/jobs/watchdog-heartbeat", (c) => watchdogHeartbeatHandler(c));
// US-1103 Garment Passport integrity scan — populates the integrity queue with
// wear-reversal, duplicate-fingerprint-across-owners, rapid-reclaim and
// token-replay anomalies. Idempotent (dedupe_key); the handler enforces
// X-Internal-Job-Secret itself.
app.post("/api/jobs/passport-integrity-scan", (c) => handlePassportIntegrityScanCron(c));
// US-1124 Garment Passport backfill/repair — seed single-hop passports for any
// certificated grade_report left with a NULL garment_id by the live-seed race
// window. Idempotent; the handler enforces X-Internal-Job-Secret itself.
app.post("/api/jobs/passport-backfill", (c) => handlePassportBackfillCron(c));
// US-905 scheduled audit-log anomaly scan (role-change bursts, mass refunds,
// off-hours destructive actions). Thresholds in the settings registry; raises
// an ops alert + admin_audit_anomalies finding. Enforces the job secret itself.
app.post("/api/jobs/audit-anomaly-scan", (c) => handleAuditAnomalyCron(c));
// US-1055 marketplace-event notifications. Sweeps active eBay connections and
// notifies sellers of newly-opened offers, returns, and payment disputes across
// in-app + email + push. Idempotent (marketplace_event_notifications dedup);
// the handler enforces X-Internal-Job-Secret itself.
app.post("/api/jobs/marketplace-events", (c) => handleMarketplaceEventsCron(c));
// US-547 AutoLister listing-prompt A/B auto-promotion. Compares the in-trial
// challenger against the champion on seller keep-rate + sell-through and
// promotes (eval-gated) / ends the trial. Handler enforces the job secret.
app.post("/api/jobs/listing-prompt-promote", (c) => handleListingPromptPromoteCron(c));
// US-1535 grading learnings loop: assemble fresh human-correction exemplar
// sets, auto-run the golden-set eval, notify admins for one-click activation
// (auto-activate only behind grading_exemplar_auto_activate). Handler enforces
// the job secret. Schedule on Coolify cron (weekly, e.g. Sun 12:00 UTC);
// optional ?category= assembles a category-scoped set.
app.post("/api/jobs/exemplar-assembly", (c) => handleExemplarAssemblyCron(c));
// US-1557 per-category confidence calibration: recompute reliability curves +
// thresholds from human-review outcomes; enforcement stays behind the
// setting's own enabled flag. Weekly (e.g. Sun 13:00 UTC).
app.post("/api/jobs/confidence-calibration", (c) => handleConfidenceCalibrationCron(c));
// US-2845. Both job-secret gated. The process cron is inert until the
// `comp_read` feature flag is turned on, which US-2842 has not authorised yet.
app.post("/api/jobs/comp-read", (c) => handleCompReadCron(c));
app.post("/api/jobs/comp-read-reclaim", (c) => handleCompReadReclaimCron(c));
// US-597 North Star digest. Weekly (Monday) encouragement + milestone emails
// tied to items-listed-per-week, with streak tracking. Handler enforces the
// job secret. Schedule on Coolify cron (weekly, e.g. Mon 14:00 UTC).
app.post("/api/jobs/north-star-digest", (c) => handleNorthStarDigestCron(c));
// US-1870: nightly Inventory Equity snapshot for the equity-over-time trend.
app.post("/api/jobs/equity-snapshot", (c) => handleEquitySnapshotCron(c));
// US-1803: buyer notification digest (daily; weekly-mode buyers flushed Mondays).
app.post("/api/jobs/buyer-digest", (c) => handleBuyerDigestCron(c));
// US-1807 buyer condition-alerts matching sweep (public-cert universe).
app.post("/api/jobs/condition-alerts", (c) => handleConditionAlertsCron(c));
// US-472 eBay parked-webhook drain. Re-links payout/order/return events that
// arrived before the connection's account_handle/external_account_id hydrated,
// and dead-letters the ones that never link. Handler enforces the job secret.
app.post("/api/jobs/ebay-pending-webhooks", (c) => handleEbayPendingWebhooksCron(c));
// US-1965 eBay order-sync backstop. Safety net for dropped/unsubscribed
// notifications: sweeps the stalest active eBay connections and fires the same
// incremental idempotent order pull for them. Handler enforces the job secret;
// the /api/jobs/* middleware records it to cron_runs.
app.post("/api/jobs/ebay-order-backstop", (c) => handleEbayOrderBackstopCron(c));
app.post("/api/jobs/ebay-notification-reconcile", (c) =>
  handleEbayNotificationReconcileCron(c));
// US-2617: the nightly photo archive sweep. The registry used to point this at
// /api/flipdesk/images/archive, a seller route behind authMiddleware, so the
// Coolify task 401'd every night and left no ledger row (US-2310). It walks the
// fleet here and re-enters the per-owner archival for each owner it finds.
app.post("/api/jobs/photo-archive", (c) => handlePhotoArchiveCron(c));
// US-2617: the nightly payout reconciliation sweep, and the last of the three
// crons US-2310 found unreachable. Same shape and same reason as the one above.
app.post("/api/jobs/reconciliation-sweep", (c) => handleReconciliationSweepCron(c));
// US-308/US-309 admin SEO endpoints. /summary + /gsc/sync are admin JWT
// gated by the /api/admin/* middleware groups above.
app.route("/api/admin/seo", adminSeoRoutes);
// US-308 GSC daily-sync cron. Lives OUTSIDE /api/admin so the wildcard
// admin-JWT middleware doesn't intercept it; the handler enforces
// X-Internal-Job-Secret itself.
app.post("/api/jobs/gsc-sync", (c) => handleGscSyncCron(c));
// US-625..US-631 Growth/Promote suite (segments, campaigns, announcements,
// analytics). Admin JWT + MFA gated by the /api/admin/* middleware group.
app.route("/api/admin/growth", adminGrowthRoutes);
// US-1852 quest / community-challenge definitions (criteria, window, reward,
// per-quest kill-switch). Admin JWT + MFA gated by the /api/admin/* group; every
// mutation audit-logged.
app.route("/api/admin/rewards", adminRewardsRoutes);
// US-1073 AI Ad Copy Studio (Google Ads RSA + Apple Search Ads). Admin JWT + MFA
// gated by the /api/admin/* middleware group; cost tagged feature='ads'.
app.route("/api/admin/ads", adminAdsRoutes);
// US-1072 keyword-research ingestion cron. Refreshes the keyword library
// (volume/competition/CPC) from the Google Ads keyword planner. OUTSIDE
// /api/admin so the wildcard admin-JWT middleware doesn't intercept it; the
// handler enforces X-Internal-Job-Secret itself. Schedule on Coolify cron
// (suggested weekly, e.g. 0 6 * * 1). No-ops cleanly when Google Ads env unset.
app.post("/api/jobs/keyword-research", (c) => handleKeywordResearchCron(c));
app.post("/api/jobs/ads-sync", (c) => handleAdsSyncCron(c));
app.post("/api/jobs/ads-conversions-upload", (c) => handleAdsConversionsUploadCron(c));
// US-916 public "What's New" changelog feed (anonymous; published entries only,
// hard-filtered in the handler). OUTSIDE /api/admin so the wildcard admin-JWT
// middleware doesn't intercept it.
app.route("/api/changelog", changelogPublicRoutes);
// US-628 user-facing announcement reads (authed, per-user scoped).
app.route("/api/announcements", announcementRoutes);
// US-629 referral program (authed, per-user scoped).
app.route("/api/referrals", referralRoutes);
app.route("/api/affiliate", affiliateRoutes);
// US-627 scheduled-campaign dispatch cron. OUTSIDE /api/admin so the wildcard
// admin-JWT middleware doesn't intercept it; the handler enforces
// X-Internal-Job-Secret itself (mirrors the GSC sync + reprice crons).
app.post("/api/jobs/growth-dispatch", (c) => handleGrowthDispatchCron(c));
// US-869 content engine watchdog. Flags a stalled scheduler (no healthy tick in
// 3h) or an elevated publish-webhook failure rate (>25% over 24h) and alerts
// the owner. OUTSIDE /api/admin so the wildcard admin-JWT middleware doesn't
// intercept it; the handler enforces X-Internal-Job-Secret itself. Schedule on
// Coolify cron (suggested 0 */3 * * *).
app.post("/api/jobs/content-watchdog", (c) => handleContentWatchdogCron(c));
// US-875: content-freshness loop. Ranks published posts by staleness ×
// importance (GSC when available, else reading-time fallback), refreshes the
// top eligible post when the change is material — bumping dateModified, purging
// the CF cache, and re-pinging IndexNow — and honours a per-post cooldown.
// OUTSIDE /api/admin; the handler enforces X-Internal-Job-Secret itself.
// Schedule on Coolify cron (suggested daily, e.g. 30 4 * * *).
app.post("/api/jobs/content-refresh", (c) => handleContentRefreshCron(c));
// US-893: Stripe-vs-DB subscription reconciliation. Precomputes divergences
// (cached subscription_status/plan vs the latest recorded Stripe event) into
// billing_reconciliation_flags so the admin console reads a ready list instead of
// recomputing per page load. OUTSIDE /api/admin; enforces X-Internal-Job-Secret.
// Schedule on Coolify cron (suggested hourly, e.g. 15 * * * *).
app.post("/api/jobs/billing-reconciliation", (c) => handleBillingReconciliationCron(c));
app.post("/api/jobs/guarantee-pool", (c) => handleGuaranteePoolCron(c));
app.post("/api/jobs/portfolio-alerts", (c) => handlePortfolioAlertsCron(c));
app.post("/api/jobs/demand-matches", (c) => handleDemandMatchesCron(c));
// US-1859: re-engagement nudge sweep + the attribution pass that scores both
// arms (sent and holdout). A cron rather than a lazy read because the users it
// exists for are the ones not opening the app.
app.post("/api/jobs/reward-nudges", (c) => handleRewardNudgesCron(c));
app.route("/api/content/blog", contentBlogRoutes);
app.route("/api/content/authors", contentAuthorsRoutes);
app.route("/api/content/social", contentSocialRoutes);
app.route("/api/content/topics", contentTopicsRoutes);
app.route("/api/content/knowledge", contentKnowledgeRoutes);
app.route("/api/content/images", contentImagesRoutes);
app.route("/api/content/settings", contentSettingsRoutes);
app.route("/api/content/public", contentPublicRoutes);
// US-2619: rasterise markup for the Pages og/* routes. Mounted under
// /api/content/public because that is the prefix the Pages worker already
// reaches for its other server-to-server calls — but it is NOT public: the
// handler gates on requirePagesOrigin and refuses when CF_PAGES_ORIGIN_SECRET
// is unset, so it is closed today and stays closed until the secret is set on
// BOTH the edge and the Cloudflare Pages project (US-2612).
app.route("/api/content/public", renderCardRoutes);
// Help Center (US-2573). Three mounts because there are three audiences for the
// same table, and the difference between them is the whole security model:
//   /api/content/public/help  anonymous  → visibility 'public' only
//   /api/help                 authed     → + 'members'
//   /api/content/help         admin      → + 'internal', + drafts, + writes
// The public mount is a reviewed entry in PUBLIC_API_ROUTERS
// (flipdesk-auth-coverage_test.ts); it inherits the /api/content/public/*
// rate limiter registered above.
app.route("/api/content/public/help", helpPublicRoutes);
app.route("/api/help", helpReaderRoutes);
app.route("/api/content/help", helpAdminRoutes);
// /api/content/scheduler/* has its own auth middleware baked in (the
// route module short-circuits on X-Internal-Job-Secret OR falls back
// to admin JWT). Don't add /scheduler/* to the use() lines above.
app.route("/api/content/scheduler", contentSchedulerRoutes);
// US-923 autonomous newsletter kickoff trigger. Like /scheduler, /api/newsletter/
// scheduler/* has its own auth baked in (NEWSLETTER_INTERNAL_JOB_SECRET / signed
// request / admin JWT) — don't add it to the /api/* use() lines above.
app.route("/api/newsletter/scheduler", newsletterSchedulerRoutes);
// US-912 public double-opt-in newsletter capture (POST /subscribe + GET /confirm).
// Unauthenticated by design; rate-limited per IP via the use() lines above. The
// concrete /subscribe + /confirm paths don't collide with /scheduler/*.
app.route("/api/newsletter", newsletterSubscribeRoutes);
// US-943 autonomous drip orchestration tick. Like /scheduler, /api/drip/* has
// its own auth baked in (DRIP_INTERNAL_JOB_SECRET / signed request / admin JWT) —
// don't add it to the /api/* use() lines above.
app.route("/api/drip", dripRoutes);
// US-938: public open/click tracking pixels for drip emails. Sibling of /api/drip
// so it stays OUTSIDE the drip job-auth — email clients are unauthenticated.
app.route("/api/drip-track", dripTrackingRoutes);
// US-925: public open/click tracking pixels for broadcast campaign emails.
app.route("/api/campaign-track", campaignTrackingRoutes);
app.route("/api/workspace", workspaceRoutes);
app.route("/api/account", accountRoutes);
app.route("/api/support-tickets", supportTicketRoutes);
app.route("/api/legal", legalRoutes);
app.route("/api/verified", verifiedRoutes);
app.route("/api/rewards", rewardsRoutes);
app.route("/api/showcase", showcaseRoutes);
app.route("/api/buyer", buyerPurchasesRoutes);
app.route("/api/buyer", buyerClosetRoutes);
app.route("/api/buyer", buyerRewardsRoutes);
app.route("/api/buyer", buyerProfileRoutes);
app.route("/api/buyer", buyerWantsRoutes);
app.route("/api/buyer", buyerAuthenticityRoutes);
app.route("/api/buyer", buyerTrustRoutes);

// 404
app.notFound((c) => {
  applyCorsOrigin(c);
  return c.json({ error: "Not found" }, 404);
});

// Error handler
app.onError((err, c) => {
  // A response built here replaces whatever cors() may have set, and an error
  // thrown in a pre-cors() middleware means cors() never ran at all — so
  // re-apply the allow-origin header. Without it the browser masks every 4xx/5xx
  // as a "blocked by CORS policy" failure, hiding the real status from the admin
  // dashboard's console.
  applyCorsOrigin(c);
  // US-362: a body that overran the streaming cap surfaces here when the route
  // tried to read it — return a clean 413, not a generic 500.
  if (err instanceof BodyTooLargeError) {
    return c.json({ error: "Request body too large", maxBytes: err.maxBytes }, 413);
  }
  // US-359: redact before logging (no PII/secrets in the sink) and return a
  // generic body — never the raw error text.
  // US-491: report the exception to the tracker with request/route/user context
  // tagged with the release SHA, correlated to the access-log line by request id.
  let path = c.req.path;
  try {
    path = new URL(c.req.url).pathname;
  } catch { /* keep c.req.path */ }
  captureException(err, {
    route: `${c.req.method} ${path}`,
    method: c.req.method,
    url: path,
    correlationId: readCtxVar(c, "correlationId"),
    userId: readCtxVar(c, "userId") ?? readCtxVar(c, "workspaceOwnerId"),
  });
  console.error("Unhandled error:", redactError(err));
  return c.json({ error: "Internal server error" }, 500);
});

// US-2660 AC3: an EDGE_ENV nothing recognises is TREATED as production so no
// control is silently disabled, and said so here rather than left to be
// inferred from behaviour. First, because it explains everything that follows.
assertKnownEdgeEnv();

// Fail-closed safety net: warn loudly if a security-weakening debug flag is
// set in production (the flag is already ignored by isDebugAllowed). (US-266)
assertNoProdDebugFlags();

// US-357: refuse to boot in production with admin MFA silently disabled. Throws
// here (before Deno.serve) so a misconfigured deploy crashes loudly instead of
// serving admin routes without the AAL2 gate.
assertAdminMfaConfig();

// US-777: hard-fail at boot on a missing REQUIRED env var (prod only); warn on
// incomplete FEATURE groups (eBay / SMTP / Stripe prices / Google Photos) so a
// half-configured deploy is loud, not latent. Dev/test stay permissive.
assertRequiredEnv();
warnMissingFeatureGroups();
// US-915: deliverability pre-flight (SES config set / marketing identity /
// SPF-DKIM-DMARC attestation) — non-fatal, surfaced so spam-prone sends are loud.
warnDeliverability();

// US-778: refuse to start against a STALE DB in production (a build expecting a
// migration the DB hasn't applied corrupts data). Fail-open on an unreadable
// migrations table; fatal only on a confirmed behind-version in prod.
await assertSchemaVersion();
// US-2009: the max-version check above proves the HEAD landed and nothing
// beneath it. This compares the whole SET, catching a migration that failed
// mid-sequence (invisible to a watermark) and a version recorded with no file
// in this build. Deliberately non-fatal for now — see checkSchemaCompleteness.
await checkSchemaCompleteness();

// US-884: warm the settings cache for the hot-path keys so the first requests
// read the live registry value rather than the fallback (background, non-fatal).
void getSetting<number>("rate_limit_grade_per_min", 60);
void getSetting<number>("grading_review_confidence_threshold", 0.75);

// US-2130: the authenticity pass ships to real users (paid add-on, buyer check,
// and an unauthenticated public endpoint) while its eval gate has never run.
// Warn when a live authenticity prompt has no passing eval run, so "ungated"
// stops being silent. Deliberately backgrounded and non-throwing — a boot guard
// that can fail is how the schema check once crash-looped the service (US-778).
void warnAuthenticityGate();

// US-890: warm the per-user rate-limit override cache so an active throttle/block
// is enforced from the first request (background, non-fatal).
void refreshOverrideCache();

// Stability guard: a long-running edge server must NEVER die from a DETACHED
// background rejection. Deno treats an unhandled promise rejection (or uncaught
// error) as FATAL, so one stray reject from a fire-and-forget task crash-loops
// the whole container — which is exactly what happened in prod: denomailer's
// SMTPClient runs an internal connection read-loop that rejects independently
// of the awaited send()/close() when SES drops the socket mid-protocol, and
// every completed grade fires a best-effort lifecycle email. preventDefault()
// keeps the process alive; we log + report so the failure is still visible.
// In-request errors are unaffected (Hono's onError still handles those).
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const reason = event.reason;
  logEvent("error", "edge.unhandled_rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  try {
    captureException(reason, { route: "process.unhandledrejection" });
  } catch { /* the guard must never throw */ }
});
globalThis.addEventListener("error", (event) => {
  event.preventDefault();
  const err = event.error ?? event.message;
  logEvent("error", "edge.uncaught_error", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  try {
    captureException(err, { route: "process.uncaught_error" });
  } catch { /* the guard must never throw */ }
});

const port = parseInt(Deno.env.get("PORT") || "8787");
const bootRelease = releaseSha();
logEvent("info", "edge.boot", {
  port,
  release: bootRelease,
  errorTracking: !!Deno.env.get("SENTRY_DSN")?.trim(),
});

// US-2001: when the build has no identity, say what MIGHT hold one.
//
// "release: unknown" tells the operator something is wrong and nothing about
// what to do, which is why this story has been re-diagnosed three times. If a
// variable on this container already carries a commit under a name nothing
// reads, naming it turns the fix into one copy rather than another round of
// guessing at how Coolify exposes the build.
//
// NAMES ONLY. This lands in a deploy log; a value would put whatever the key
// holds somewhere it was never meant to be. Only when the release is unknown,
// so a healthy deploy logs nothing extra.
// US-2003 AC2: a production deploy that cannot page anyone says so at boot.
//
// Every alert channel is optional and every one of them degrades to silence, so
// the state "nothing can reach a human" was recorded only as an
// `ops_event.alert_undelivered` metric - which itself has no alert. The one
// message guaranteed not to arrive was the news that no message arrives.
//
// LOGGED, NOT FATAL, and that is the whole decision. AC2 offers "fail at boot
// (or emit at critical)", and refusing to start would trade a blind monitor for
// a dead service: the edge handles grading, payments and eBay writes, none of
// which get safer by being off. A deploy that cannot page is a serious problem
// and is not a reason to stop taking money.
//
// Env only, on purpose - see hasEnvAlertChannel. A settings-only setup reads as
// "none" here and still works at dispatch, which is a false alarm in the safe
// direction for an alarm that says "go and check your alert channels".
if (isProduction() && !hasEnvAlertChannel()) {
  logEvent("error", "edge.boot.no_alert_channel", {
    checked: ["MONITOR_ALERT_WEBHOOK", "MONITOR_ALERT_EMAIL", "SMTP_ADMIN_EMAIL"],
    hint:
      "No alert channel is configured, so a SEV1 reaches nobody. Set " +
      "MONITOR_ALERT_WEBHOOK on the edge resource. /health/ready reports " +
      "alerting: ok whenever ANY of these is set, which is a claim about " +
      "configuration and not about delivery - run the drill (US-2003 AC1).",
  });
}

if (isPlaceholderRelease(bootRelease)) {
  const candidates = unreadReleaseCandidates(Object.entries(Deno.env.toObject()));
  logEvent("warn", "edge.boot.release_unknown", {
    read: RELEASE_ENV_KEYS,
    unreadCandidates: candidates,
    hint: candidates.length
      ? "One of these looks like a build id and nothing reads it. Copy its value into SOURCE_COMMIT on the edge resource, or add the key to RELEASE_ENV_KEYS."
      : "No variable on this container looks like a build id. Set SOURCE_COMMIT on the edge resource in Coolify.",
  });
}

// US-2010: graceful shutdown. Without this a deploy SIGKILLs in-flight
// requests, and any job claimed just before the kill sits "running" for
// JOB_STALE_MS/BATCH_STALE_MS (6–15 min) until a reclaim sweep finds it — so a
// seller mid-batch sees minutes of apparent stall, not the ~30s SCALING.md
// documents. installShutdownHandlers stops NEW claims immediately (via the
// guard in acquireJobLock, which every cron passes through) and drains what is
// already running before exiting.
//
// The sweeps remain the correctness backstop for SIGKILL/OOM/host loss; this
// only improves the ORDERLY case, which is every routine deploy.
installShutdownHandlers();

Deno.serve({ port }, (req, info) => trackInFlight(async () => await app.fetch(req, info)));
