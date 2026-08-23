// Admin route table, split out of routes/index.tsx (US-2112).
//
// WHY THIS IS A SEPARATE MODULE: the ~250-route table in index.tsx is EAGER —
// the page components are lazy, but every lazy() declaration and route object
// itself ships in the entry chunk. At 213.52/215 KB gz the budget had 1.48 KB of
// headroom and the guard explicitly says not to raise the ceiling, because the
// cause is structural. These 81 admin routes are behind an auth gate that most
// visitors never pass, so they had no business in the bundle every marketing
// visitor downloads.
//
// Rendered as DESCENDANT routes under the "/admin/*" splat in index.tsx, so
// paths here are relative ("users", not "/admin/users"). That costs the data
// router APIs (loader/action) for this subtree — verified unused: no admin route
// declared either before the split.
import { Navigate, Route, Routes } from "react-router";
import { lazy, SuspenseWrapper } from "./lazy";

// Shared with the /dashboard/* 404 in index.tsx, so that declaration stays put.
// Declaring it again here is free — both point at the same dynamic import, so
// Vite emits a single chunk.
const InShellNotFound = lazy(() => import("@/pages/not-found").then(m => ({ default: m.InShellNotFound })));

const BlogListPage = lazy(() => import("@/pages/content/blog-list").then(m => ({ default: m.BlogListPage })));
const BlogEditorPage = lazy(() => import("@/pages/content/blog-editor").then(m => ({ default: m.BlogEditorPage })));
const AuthorsPage = lazy(() => import("@/pages/content/authors").then(m => ({ default: m.AuthorsPage })));
const SocialListPage = lazy(() => import("@/pages/content/social-list").then(m => ({ default: m.SocialListPage })));
const SocialEditorPage = lazy(() => import("@/pages/content/social-editor").then(m => ({ default: m.SocialEditorPage })));
const TopicBankPage = lazy(() => import("@/pages/content/topic-bank").then(m => ({ default: m.TopicBankPage })));
const KnowledgePage = lazy(() => import("@/pages/content/knowledge").then(m => ({ default: m.KnowledgePage })));
// US-2574. Named Help Center, never "Knowledge": /admin/content/knowledge above
// is the AI-prompt reference doc set, a different thing entirely.
const HelpListPage = lazy(() => import("@/pages/content/help-list").then(m => ({ default: m.HelpListPage })));
const HelpEditorPage = lazy(() => import("@/pages/content/help-editor").then(m => ({ default: m.HelpEditorPage })));
const HelpReportPage = lazy(() => import("@/pages/content/help-report").then(m => ({ default: m.HelpReportPage })));
const ContentSettingsPage = lazy(() => import("@/pages/content/content-settings").then(m => ({ default: m.ContentSettingsPage })));
const ContentAnalyticsPage = lazy(() => import("@/pages/content/analytics").then(m => ({ default: m.ContentAnalyticsPage })));
const ChangelogPage = lazy(() => import("@/pages/admin/changelog").then(m => ({ default: m.ChangelogPage })));
const AdminDashboardPage = lazy(() => import("@/pages/admin/dashboard").then(m => ({ default: m.AdminDashboardPage })));
const AdminUsersPage = lazy(() => import("@/pages/admin/users").then(m => ({ default: m.AdminUsersPage })));
const AdminBulkPage = lazy(() => import("@/pages/admin/bulk").then(m => ({ default: m.AdminBulkPage })));
const AdminCategoryMapPage = lazy(() => import("@/pages/admin/category-map").then(m => ({ default: m.AdminCategoryMapPage })));
const AdminListingCoveragePage = lazy(() => import("@/pages/admin/listing-coverage").then(m => ({ default: m.AdminListingCoveragePage })));
const AdminIdentificationProvenancePage = lazy(() => import("@/pages/admin/identification-provenance").then(m => ({ default: m.AdminIdentificationProvenancePage })));
const AdminBrandKnowledgePage = lazy(() => import("@/pages/admin/brand-knowledge").then(m => ({ default: m.AdminBrandKnowledgePage })));
const AdminRegisteredNumbersPage = lazy(() => import("@/pages/admin/registered-numbers").then(m => ({ default: m.AdminRegisteredNumbersPage })));
const AdminSubmissionsPage = lazy(() => import("@/pages/admin/submissions").then(m => ({ default: m.AdminSubmissionsPage })));
const AdminGradingQueuePage = lazy(() => import("@/pages/admin/grading").then(m => ({ default: m.AdminGradingQueuePage })));
const AdminAuthenticityPage = lazy(() => import("@/pages/admin/authenticity").then(m => ({ default: m.AdminAuthenticityPage })));
// US-2559: four consolidated hosts. Each lazily mounts only the view in
// ?view=, so opening a host pulls one page's bundle rather than five.
const AdminRewardsHostPage = lazy(() => import("@/pages/admin/rewards-host").then(m => ({ default: m.AdminRewardsHostPage })));
const AdminNewsletterHostPage = lazy(() => import("@/pages/admin/newsletter-host").then(m => ({ default: m.AdminNewsletterHostPage })));
const AdminAiHostPage = lazy(() => import("@/pages/admin/ai-host").then(m => ({ default: m.AdminAiHostPage })));
const AdminSafetyHostPage = lazy(() => import("@/pages/admin/safety-host").then(m => ({ default: m.AdminSafetyHostPage })));
const AdminReliabilityPage = lazy(() => import("@/pages/admin/reliability").then(m => ({ default: m.AdminReliabilityPage })));
const AdminMarketplaceConnectionsPage = lazy(() => import("@/pages/admin/marketplace-connections").then(m => ({ default: m.AdminMarketplaceConnectionsPage })));
const AdminMarketplaceOpsPage = lazy(() => import("@/pages/admin/marketplace-ops").then(m => ({ default: m.AdminMarketplaceOpsPage })));
const AdminSeoPage = lazy(() => import("@/pages/admin/seo").then(m => ({ default: m.AdminSeoPage })));
const AdminAdsPage = lazy(() => import("@/pages/admin/ads").then(m => ({ default: m.AdminAdsPage })));
const AdminKeywordResearchPage = lazy(() => import("@/pages/admin/keyword-research").then(m => ({ default: m.AdminKeywordResearchPage })));
const AdminConditionIndexPage = lazy(() => import("@/pages/admin/condition-index").then(m => ({ default: m.AdminConditionIndexPage })));
const AdminUserDetailPage = lazy(() => import("@/pages/admin/user-detail").then(m => ({ default: m.AdminUserDetailPage })));
const AdminDisputesPage = lazy(() => import("@/pages/admin/disputes").then(m => ({ default: m.AdminDisputesPage })));
const AdminClaimsPage = lazy(() => import("@/pages/admin/claims").then(m => ({ default: m.AdminClaimsPage })));
const AdminGuaranteePoolPage = lazy(() => import("@/pages/admin/guarantee-pool").then(m => ({ default: m.AdminGuaranteePoolPage })));
const AdminMeasureCardsPage = lazy(() => import("@/pages/admin/measure-cards").then(m => ({ default: m.AdminMeasureCardsPage })));
const AdminSupportPage = lazy(() => import("@/pages/admin/support").then(m => ({ default: m.AdminSupportPage })));
const AdminSupportTicketsPage = lazy(() => import("@/pages/admin/support-tickets").then(m => ({ default: m.AdminSupportTicketsPage })));
const AdminCompliancePage = lazy(() => import("@/pages/admin/compliance").then(m => ({ default: m.AdminCompliancePage })));
const AdminLegalPage = lazy(() => import("@/pages/admin/legal").then(m => ({ default: m.AdminLegalPage })));
const AdminKnowledgeBasePage = lazy(() => import("@/pages/admin/knowledge-base").then(m => ({ default: m.AdminKnowledgeBasePage })));
const AdminSystemPage = lazy(() => import("@/pages/admin/system").then(m => ({ default: m.AdminSystemPage })));
const AdminNotificationsPage = lazy(() => import("@/pages/admin/notifications").then(m => ({ default: m.AdminNotificationsPage })));
const AdminJobsPage = lazy(() => import("@/pages/admin/jobs").then(m => ({ default: m.AdminJobsPage })));
const AdminOpsHealthPage = lazy(() => import("@/pages/admin/ops-health").then(m => ({ default: m.AdminOpsHealthPage })));
const AdminOpsJobsPage = lazy(() => import("@/pages/admin/ops-jobs").then(m => ({ default: m.AdminOpsJobsPage })));
const AdminAgentsPage = lazy(() => import("@/pages/admin/agents").then(m => ({ default: m.AdminAgentsPage })));
const AdminOpsDeadLettersPage = lazy(() => import("@/pages/admin/ops-dead-letters").then(m => ({ default: m.AdminOpsDeadLettersPage })));
const AdminOpsActivityPage = lazy(() => import("@/pages/admin/ops-activity").then(m => ({ default: m.AdminOpsActivityPage })));
const AdminOpsRunbooksPage = lazy(() => import("@/pages/admin/ops-runbooks").then(m => ({ default: m.AdminOpsRunbooksPage })));
const AdminSettingsRegistryPage = lazy(() => import("@/pages/admin/settings-registry").then(m => ({ default: m.AdminSettingsRegistryPage })));
const AdminConfigPricingPage = lazy(() => import("@/pages/admin/config-pricing").then(m => ({ default: m.AdminConfigPricingPage })));
const AdminRolesPage = lazy(() => import("@/pages/admin/roles").then(m => ({ default: m.AdminRolesPage })));
const AdminMaintenancePage = lazy(() => import("@/pages/admin/maintenance").then(m => ({ default: m.AdminMaintenancePage })));
const AdminFeatureFlagsPage = lazy(() => import("@/pages/admin/feature-flags").then(m => ({ default: m.AdminFeatureFlagsPage })));
const AdminAuditLogPage = lazy(() => import("@/pages/admin/audit-log").then(m => ({ default: m.AdminAuditLogPage })));
const AdminRateLimitsPage = lazy(() => import("@/pages/admin/rate-limits").then(m => ({ default: m.AdminRateLimitsPage })));
const AdminPassportIntegrityPage = lazy(() => import("@/pages/admin/passport-integrity").then(m => ({ default: m.AdminPassportIntegrityPage })));
const AdminRevenuePage = lazy(() => import("@/pages/admin/revenue").then(m => ({ default: m.AdminRevenuePage })));
const AdminAnalyticsPage = lazy(() => import("@/pages/admin/analytics").then(m => ({ default: m.AdminAnalyticsPage })));
const AdminDripAnalyticsPage = lazy(() => import("@/pages/admin/drip-analytics").then(m => ({ default: m.AdminDripAnalyticsPage })));
const AdminDripBuilderPage = lazy(() => import("@/pages/admin/drip").then(m => ({ default: m.AdminDripBuilderPage })));
const AdminJourneysPage = lazy(() => import("@/pages/admin/journeys").then(m => ({ default: m.AdminJourneysPage })));
const AdminReconciliationPage = lazy(() => import("@/pages/admin/reconciliation").then(m => ({ default: m.AdminReconciliationPage })));
const AdminCouponsPage = lazy(() => import("@/pages/admin/coupons").then(m => ({ default: m.AdminCouponsPage })));
const AdminPricingPage = lazy(() => import("@/pages/admin/pricing").then(m => ({ default: m.AdminPricingPage })));
const AdminWaitlistPage = lazy(() => import("@/pages/admin/waitlist").then(m => ({ default: m.AdminWaitlistPage })));
const AdminTasksPage = lazy(() => import("@/pages/admin/tasks").then(m => ({ default: m.AdminTasksPage })));
const AdminTaskBoardPage = lazy(() => import("@/pages/admin/task-board").then(m => ({ default: m.AdminTaskBoardPage })));
const GrowthDashboardPage = lazy(() => import("@/pages/admin/growth/dashboard").then(m => ({ default: m.GrowthDashboardPage })));
const GrowthSegmentsPage = lazy(() => import("@/pages/admin/growth/segments").then(m => ({ default: m.GrowthSegmentsPage })));
const GrowthCampaignsPage = lazy(() => import("@/pages/admin/growth/campaigns").then(m => ({ default: m.GrowthCampaignsPage })));
const GrowthAnnouncementsPage = lazy(() => import("@/pages/admin/growth/announcements").then(m => ({ default: m.GrowthAnnouncementsPage })));
const GrowthReferralsPage = lazy(() => import("@/pages/admin/growth/referrals").then(m => ({ default: m.GrowthReferralsPage })));
const BuyerGrowthPage = lazy(() => import("@/pages/admin/growth/buyer").then(m => ({ default: m.BuyerGrowthPage })));

export function AdminRoutes() {
  return (
    <Routes>
      <Route index element={<SuspenseWrapper><AdminDashboardPage /></SuspenseWrapper>} />
      <Route path="users" element={<SuspenseWrapper><AdminUsersPage /></SuspenseWrapper>} />
      <Route path="bulk" element={<SuspenseWrapper><AdminBulkPage /></SuspenseWrapper>} />
      <Route path="category-map" element={<SuspenseWrapper><AdminCategoryMapPage /></SuspenseWrapper>} />
      <Route path="listing-coverage" element={<SuspenseWrapper><AdminListingCoveragePage /></SuspenseWrapper>} />
      <Route path="identification-provenance" element={<SuspenseWrapper><AdminIdentificationProvenancePage /></SuspenseWrapper>} />
      <Route path="brand-knowledge" element={<SuspenseWrapper><AdminBrandKnowledgePage /></SuspenseWrapper>} />
      <Route path="registered-numbers" element={<SuspenseWrapper><AdminRegisteredNumbersPage /></SuspenseWrapper>} />
      <Route path="users/:id" element={<SuspenseWrapper><AdminUserDetailPage /></SuspenseWrapper>} />
      <Route path="submissions" element={<SuspenseWrapper><AdminSubmissionsPage /></SuspenseWrapper>} />
      {/* US-2505: /admin/reviews and /admin/grading were two UIs over the SAME
          endpoints (approve / adjust / send-back on
          /api/admin/grading/review/:id), and only /admin/grading claimed the
          item first — so two operators, one on each page, could both finalize
          one report. Retired in favour of the Review Queue, which is the
          superset (claim + release, calibration, exemplar sets, garment
          baselines) and now carries the confidence filter this page owned.
          Redirect rather than 404 so bookmarks and notification deep-links keep
          working. */}
      <Route path="reviews" element={<Navigate to="/admin/grading" replace />} />
      <Route path="disputes" element={<SuspenseWrapper><AdminDisputesPage /></SuspenseWrapper>} />
      <Route path="claims" element={<SuspenseWrapper><AdminClaimsPage /></SuspenseWrapper>} />
      <Route path="guarantee-pool" element={<SuspenseWrapper><AdminGuaranteePoolPage /></SuspenseWrapper>} />
      <Route path="measure-cards" element={<SuspenseWrapper><AdminMeasureCardsPage /></SuspenseWrapper>} />
      <Route path="support" element={<SuspenseWrapper><AdminSupportPage /></SuspenseWrapper>} />
      <Route path="support/:id" element={<SuspenseWrapper><AdminSupportPage /></SuspenseWrapper>} />
      <Route path="support-tickets" element={<SuspenseWrapper><AdminSupportTicketsPage /></SuspenseWrapper>} />
      <Route path="support-tickets/:id" element={<SuspenseWrapper><AdminSupportTicketsPage /></SuspenseWrapper>} />
      // US-903 GDPR/CCPA data-subject request queue (admin + super_admin;
      // processing a deletion is additionally super_admin + step-up gated
      // server-side).
      <Route path="compliance" element={<SuspenseWrapper><AdminCompliancePage /></SuspenseWrapper>} />
      <Route path="compliance/:id" element={<SuspenseWrapper><AdminCompliancePage /></SuspenseWrapper>} />
      // US-904 legal/ToS version manager (publish + force re-acceptance;
      // publishing is super_admin + step-up gated server-side).
      <Route path="legal" element={<SuspenseWrapper><AdminLegalPage /></SuspenseWrapper>} />
      <Route path="support/monitoring" element={<Navigate to="/admin/ai?view=assistant" replace />} />
      <Route path="support/kb" element={<SuspenseWrapper><AdminKnowledgeBasePage /></SuspenseWrapper>} />
      <Route path="grading" element={<SuspenseWrapper><AdminGradingQueuePage /></SuspenseWrapper>} />
      <Route path="authenticity" element={<SuspenseWrapper><AdminAuthenticityPage /></SuspenseWrapper>} />
      <Route path="ai" element={<SuspenseWrapper><AdminAiHostPage /></SuspenseWrapper>} />
      <Route path="ai-models" element={<Navigate to="/admin/ai?view=models" replace />} />
      <Route path="ai-spend" element={<Navigate to="/admin/ai?view=spend" replace />} />
      <Route path="ai-profitability" element={<Navigate to="/admin/ai?view=profitability" replace />} />
      <Route path="reliability" element={<SuspenseWrapper><AdminReliabilityPage /></SuspenseWrapper>} />
      <Route path="marketplace-connections" element={<SuspenseWrapper><AdminMarketplaceConnectionsPage /></SuspenseWrapper>} />
      <Route path="marketplace-ops" element={<SuspenseWrapper><AdminMarketplaceOpsPage /></SuspenseWrapper>} />
      <Route path="seo" element={<SuspenseWrapper><AdminSeoPage /></SuspenseWrapper>} />
      <Route path="ads" element={<SuspenseWrapper><AdminAdsPage /></SuspenseWrapper>} />
      <Route path="keyword-research" element={<SuspenseWrapper><AdminKeywordResearchPage /></SuspenseWrapper>} />
      <Route path="condition-index" element={<SuspenseWrapper><AdminConditionIndexPage /></SuspenseWrapper>} />
      <Route path="revenue" element={<SuspenseWrapper><AdminRevenuePage /></SuspenseWrapper>} />
      <Route path="analytics" element={<SuspenseWrapper><AdminAnalyticsPage /></SuspenseWrapper>} />
      <Route path="growth/drip" element={<SuspenseWrapper><AdminDripAnalyticsPage /></SuspenseWrapper>} />
      <Route path="growth/drip/builder" element={<SuspenseWrapper><AdminDripBuilderPage /></SuspenseWrapper>} />
      <Route path="growth/newsletter" element={<SuspenseWrapper><AdminNewsletterHostPage /></SuspenseWrapper>} />
      <Route path="growth/newsletter-console" element={<Navigate to="/admin/growth/newsletter?view=console" replace />} />
      <Route path="growth/subscribers" element={<Navigate to="/admin/growth/newsletter?view=subscribers" replace />} />
      <Route path="growth/suppressions" element={<Navigate to="/admin/growth/newsletter?view=suppressions" replace />} />
      <Route path="growth/journeys" element={<SuspenseWrapper><AdminJourneysPage /></SuspenseWrapper>} />
      <Route path="billing/reconciliation" element={<SuspenseWrapper><AdminReconciliationPage /></SuspenseWrapper>} />
      <Route path="system" element={<SuspenseWrapper><AdminSystemPage /></SuspenseWrapper>} />
      <Route path="jobs" element={<SuspenseWrapper><AdminJobsPage /></SuspenseWrapper>} />
      <Route path="ops/activity" element={<SuspenseWrapper><AdminOpsActivityPage /></SuspenseWrapper>} />
      <Route path="ops/health" element={<SuspenseWrapper><AdminOpsHealthPage /></SuspenseWrapper>} />
      <Route path="ops/jobs" element={<SuspenseWrapper><AdminOpsJobsPage /></SuspenseWrapper>} />
      <Route path="agents" element={<SuspenseWrapper><AdminAgentsPage /></SuspenseWrapper>} />
      <Route path="ops/dead-letters" element={<SuspenseWrapper><AdminOpsDeadLettersPage /></SuspenseWrapper>} />
      <Route path="ops/settings" element={<SuspenseWrapper><AdminSettingsRegistryPage /></SuspenseWrapper>} />
      // US-908 granular RBAC scope management (admin read; super_admin + step-up to edit).
      <Route path="ops/roles" element={<SuspenseWrapper><AdminRolesPage /></SuspenseWrapper>} />
      // US-1058 notification event catalog (admin + super_admin; read-only).
      <Route path="ops/notifications" element={<SuspenseWrapper><AdminNotificationsPage /></SuspenseWrapper>} />
      <Route path="ops/pricing" element={<SuspenseWrapper><AdminConfigPricingPage /></SuspenseWrapper>} />
      <Route path="ops/feature-flags" element={<SuspenseWrapper><AdminFeatureFlagsPage /></SuspenseWrapper>} />
      <Route path="ops/maintenance" element={<SuspenseWrapper><AdminMaintenancePage /></SuspenseWrapper>} />
      // US-910 operational runbooks (admin + super_admin; read-only). Index + per-slug detail.
      <Route path="ops/runbooks" element={<SuspenseWrapper><AdminOpsRunbooksPage /></SuspenseWrapper>} />
      <Route path="ops/runbooks/:slug" element={<SuspenseWrapper><AdminOpsRunbooksPage /></SuspenseWrapper>} />
      <Route path="audit-log" element={<SuspenseWrapper><AdminAuditLogPage /></SuspenseWrapper>} />
      <Route path="coupons" element={<SuspenseWrapper><AdminCouponsPage /></SuspenseWrapper>} />
      <Route path="pricing" element={<SuspenseWrapper><AdminPricingPage /></SuspenseWrapper>} />
      <Route path="incentives" element={<Navigate to="/admin/growth/rewards?view=incentives" replace />} />
      <Route path="waitlist" element={<SuspenseWrapper><AdminWaitlistPage /></SuspenseWrapper>} />
      <Route path="safety" element={<SuspenseWrapper><AdminSafetyHostPage /></SuspenseWrapper>} />
      <Route path="moderation" element={<Navigate to="/admin/safety?view=moderation" replace />} />
      <Route path="fraud" element={<Navigate to="/admin/safety?view=fraud" replace />} />
      <Route path="safety/signals" element={<Navigate to="/admin/safety?view=signals" replace />} />
      <Route path="safety/rate-limits" element={<SuspenseWrapper><AdminRateLimitsPage /></SuspenseWrapper>} />
      <Route path="safety/passport-integrity" element={<SuspenseWrapper><AdminPassportIntegrityPage /></SuspenseWrapper>} />
      <Route path="tasks" element={<SuspenseWrapper><AdminTasksPage /></SuspenseWrapper>} />
      <Route path="tasks/:id" element={<SuspenseWrapper><AdminTaskBoardPage /></SuspenseWrapper>} />
      // Growth / Promote suite (US-632) — admin + super_admin; the
      // broadcast/send action is additionally super_admin-gated server-side.
      <Route path="growth" element={<SuspenseWrapper><GrowthDashboardPage /></SuspenseWrapper>} />
      <Route path="growth/segments" element={<SuspenseWrapper><GrowthSegmentsPage /></SuspenseWrapper>} />
      <Route path="growth/campaigns" element={<SuspenseWrapper><GrowthCampaignsPage /></SuspenseWrapper>} />
      <Route path="growth/announcements" element={<SuspenseWrapper><GrowthAnnouncementsPage /></SuspenseWrapper>} />
      <Route path="growth/referrals" element={<SuspenseWrapper><GrowthReferralsPage /></SuspenseWrapper>} />
      <Route path="growth/rewards" element={<SuspenseWrapper><AdminRewardsHostPage /></SuspenseWrapper>} />
      {/* US-2559 AC5: every retired path redirects into its host with the
          matching tab, so runbook links, bookmarks and the command palette all
          survive. `replace` so Back does not bounce off the redirect. */}
      <Route path="growth/quests" element={<Navigate to="/admin/growth/rewards?view=quests" replace />} />
      <Route path="growth/buyer" element={<SuspenseWrapper><BuyerGrowthPage /></SuspenseWrapper>} />
      <Route path="growth/reward-milestones" element={<Navigate to="/admin/growth/rewards?view=milestones" replace />} />
      <Route path="growth/reward-economics" element={<Navigate to="/admin/growth/rewards?view=economics" replace />} />
      <Route path="growth/reward-north-star" element={<Navigate to="/admin/growth/rewards?view=north-star" replace />} />
      // Content module — blog, social, topic bank, knowledge base,
      // analytics + settings. Lives in the admin dashboard (admin +
      // super_admin), behind the AdminMfaGate like every other admin
      // surface. Moved here from /dashboard/content/* (US: content move).
      <Route path="content/blog" element={<SuspenseWrapper><BlogListPage /></SuspenseWrapper>} />
      <Route path="content/blog/editor/:id" element={<SuspenseWrapper><BlogEditorPage /></SuspenseWrapper>} />
      <Route path="content/authors" element={<SuspenseWrapper><AuthorsPage /></SuspenseWrapper>} />
      <Route path="content/social" element={<SuspenseWrapper><SocialListPage /></SuspenseWrapper>} />
      <Route path="content/social/editor/:id" element={<SuspenseWrapper><SocialEditorPage /></SuspenseWrapper>} />
      <Route path="content/topics" element={<SuspenseWrapper><TopicBankPage /></SuspenseWrapper>} />
      <Route path="content/knowledge" element={<SuspenseWrapper><KnowledgePage /></SuspenseWrapper>} />
      <Route path="content/help" element={<SuspenseWrapper><HelpListPage /></SuspenseWrapper>} />
      <Route path="content/help/report" element={<SuspenseWrapper><HelpReportPage /></SuspenseWrapper>} />
      <Route path="content/help/editor/:id" element={<SuspenseWrapper><HelpEditorPage /></SuspenseWrapper>} />
      <Route path="content/analytics" element={<SuspenseWrapper><ContentAnalyticsPage /></SuspenseWrapper>} />
      <Route path="content/changelog" element={<SuspenseWrapper><ChangelogPage /></SuspenseWrapper>} />
      <Route path="content/settings" element={<SuspenseWrapper><ContentSettingsPage /></SuspenseWrapper>} />
      // In-shell 404: an unknown /admin/* path keeps the admin chrome.
      <Route path="*" element={<SuspenseWrapper><InShellNotFound homeTo="/admin" homeLabel="Back to admin" /></SuspenseWrapper>} />
    </Routes>
  );
}
