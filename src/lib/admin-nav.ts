// US-3252: the admin sidebar, declared once.
//
// This was nine hand-maintained arrays inside src/layouts/admin-layout.tsx,
// each with its own copy-pasted `.map()` beside it, so nothing outside that
// component could read the admin nav at all. That is why the title hook and
// the route announcer stop at the dashboard: there was no admin list to
// resolve a page name against.
//
// A SECOND REGISTRY, DELIBERATELY. src/lib/surfaces.ts answers "what does the
// PRODUCT contain" and its fields are the questions you ask about a product
// surface: does iOS have it, which plan unlocks it, which workspace capability
// gates it, what does it do in one sentence. None of those apply here. Admin
// is operator tooling: it is web-only by construction, it has no plan tier, it
// has a super-admin flag and a live badge count that no product surface has,
// and several entries are consoles rather than features. Folding these into
// surfaces.ts would mean ~65 rows whose `ios` is null for a reason that is not
// a platform gap, which is exactly the false signal singleClientSurfaces() and
// onlyReason exist to prevent. src/lib/buyer-nav.ts is the precedent: one
// source per tree, each shaped like the tree it describes.
//
// src/lib/__tests__/admin-nav.test.ts holds this list against the router in
// both directions. src/test/admin-nav-distinct.test.ts and
// admin-nav-truth.test.ts hold it against the admin pages.

import {
  Activity,
  BarChart3,
  Bell,
  BookMarked,
  BookOpen,
  Bot,
  Brain,
  ClipboardCheck,
  DollarSign,
  DoorOpen,
  FileLock2,
  FileText,
  Filter,
  Flag,
  Gauge,
  Gift,
  GitMerge,
  Headset,
  Inbox,
  KeyRound,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  Lightbulb,
  LineChart,
  ListChecks,
  MailCheck,
  Mailbox,
  Map,
  Megaphone,
  MessageCircle,
  Newspaper,
  PiggyBank,
  PlugZap,
  RefreshCw,
  Ruler,
  Scale,
  ScanSearch,
  ScrollText,
  Search,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Ticket,
  TrendingUp,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * The live counts the sidebar polls for, keyed by what they count.
 *
 * `AdminNavItem.badge` names one of these, so an entry that wants a badge says
 * so in the list rather than the renderer carrying a chain of path equality
 * checks. A key added here without a poll behind it is a type error at the
 * call site, because the counts object below is a total Record.
 */
export type AdminBadgeKey =
  | "review"
  | "escalated"
  | "openTickets"
  | "failingJobs"
  | "opsCritical"
  | "marketplaceOps"
  | "complianceOpen";

/** Every badge count, polled in AdminLayout and passed down to the sidebar. */
export type AdminNavCounts = Record<AdminBadgeKey, number>;

export interface AdminNavItem {
  /** Absolute path. Must be a route in src/routes/admin-routes.tsx. */
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match the active route exactly (react-router NavLink `end`). */
  end?: boolean;
  /**
   * Hide the entry from anyone below super_admin.
   *
   * NOT a security boundary, and US-2357 holds the honest version of that: a
   * flagged entry's page must also render behind <SuperAdminOnly>, because
   * hiding a link an admin can still reach by typing the URL is a nav that
   * lies. The real enforcement is server-side scope plus an MFA step-up.
   */
  superAdminOnly?: boolean;
  /** Show this live count beside the label. */
  badge?: AdminBadgeKey;
}

export interface AdminNavSection {
  /** Section heading, or null for the leading block that renders without one. */
  title: string | null;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavSection[] = [
  {
    title: null,
    items: [
      { to: "/admin", icon: LayoutDashboard, label: "Dashboard", end: true },
      { to: "/admin/users", icon: Users, label: "Users" },
      { to: "/admin/bulk", icon: Layers, label: "Bulk Ops" },
      { to: "/admin/category-map", icon: Map, label: "Category Map" },
      { to: "/admin/identification-provenance", icon: ScanSearch, label: "Visual Identification" },
      // US-3354 RESTORED. US-2425 shipped this entry beside Category Map on
      // 2026-08-07 and merge 89f6664e5, the same day, resolved admin-layout.tsx
      // to the other branch's copy and took the one line with it. The page and
      // its route were new files, so they merged cleanly and kept working; only
      // the way in was lost, and it stayed lost for 35 days until the US-3252
      // guard named it. Sits beside Visual Identification because both are
      // cross-tenant consoles over the same AutoLister pipeline.
      { to: "/admin/listing-coverage", icon: Gauge, label: "Draft Coverage" },
      { to: "/admin/brand-knowledge", icon: BookMarked, label: "Brand Knowledge" },
      { to: "/admin/registered-numbers", icon: Tag, label: "Registered Numbers" },
      { to: "/admin/submissions", icon: FileText, label: "Submissions" },
      { to: "/admin/grading", icon: ClipboardCheck, label: "Review Queue", badge: "review" },
      { to: "/admin/authenticity", icon: ShieldCheck, label: "Authenticity" },
      { to: "/admin/disputes", icon: Scale, label: "Disputes" },
      { to: "/admin/claims", icon: ShieldCheck, label: "Guarantee Claims" },
      { to: "/admin/guarantee-pool", icon: PiggyBank, label: "Guarantee Pool" },
      { to: "/admin/measure-cards", icon: Ruler, label: "MeasureCards" },
      { to: "/admin/support", icon: Headset, label: "AI Escalations", end: true, badge: "escalated" },
      { to: "/admin/support-tickets", icon: Ticket, label: "Support Tickets", badge: "openTickets" },
      { to: "/admin/support/kb", icon: BookOpen, label: "Support Knowledge Base" },
      // US-2559: AI Models, AI Spend, AI Profitability and Assistant Monitoring
      // were four entries covering one domain. One destination, four tabs;
      // nothing was deleted, and every old path redirects into the matching tab.
      { to: "/admin/ai", icon: Brain, label: "AI Platform" },
      { to: "/admin/reliability", icon: BarChart3, label: "Reliability" },
      { to: "/admin/seo", icon: TrendingUp, label: "SEO Health" },
      { to: "/admin/ads", icon: Megaphone, label: "Ad Copy Studio" },
      { to: "/admin/keyword-research", icon: Search, label: "Keyword Research" },
      { to: "/admin/condition-index", icon: LineChart, label: "Condition Index" },
      { to: "/admin/coupons", icon: Tag, label: "Coupons" },
      { to: "/admin/pricing", icon: DollarSign, label: "Subscription Plans" },
      { to: "/admin/waitlist", icon: DoorOpen, label: "Waitlist" },
      { to: "/admin/tasks", icon: ListChecks, label: "Tasks" },
      { to: "/admin/system", icon: Wrench, label: "Platform Health" },
      { to: "/admin/jobs", icon: Server, label: "Jobs & Queues" },
      { to: "/admin/audit-log", icon: ScrollText, label: "Audit Log", superAdminOnly: true },
    ],
  },
  // Revenue Ops (US-891): operator MRR/ARR dashboard. Same admin + super_admin
  // access; read-only (no destructive actions, so no extra step-up).
  {
    title: "Revenue",
    items: [
      { to: "/admin/revenue", icon: DollarSign, label: "Revenue & MRR" },
      // US-893: past-due/paused accounts, failed invoices, Stripe-vs-DB
      // divergences, with re-sync / dunning / mark-resolved actions (step-up
      // gated server-side).
      { to: "/admin/billing/reconciliation", icon: RefreshCw, label: "Reconciliation" },
    ],
  },
  // Analytics (US-907): product funnel & weekly cohort retention. Read-only,
  // server-side aggregated; same admin + super_admin access (no destructive
  // actions). Complements the PostHog product analytics.
  {
    title: "Analytics",
    items: [
      { to: "/admin/analytics", icon: BarChart3, label: "Funnel & Retention" },
    ],
  },
  // Trust & Safety (US-888): moderation, the live abuse/fraud aggregate, and
  // the durable abuse-signal queue. Same admin + super_admin access; resolving
  // a signal / suspending is additionally super_admin + MFA step-up gated
  // server-side.
  {
    title: "Trust & Safety",
    items: [
      // US-2559: Moderation, Abuse & Fraud and Abuse Signals are one domain.
      // Rate Limits and Passport Integrity below are NOT (one is capacity
      // administration, the other is ledger integrity), so they keep entries.
      { to: "/admin/safety", icon: ShieldAlert, label: "Trust & Safety", end: true },
      // US-890 rate-limit administration: counters + temporary per-user overrides.
      { to: "/admin/safety/rate-limits", icon: Gauge, label: "Rate Limits" },
      // US-1103 Garment Passport integrity: impossible chains, duplicate
      // fingerprints, claim abuse. Keeps the ledger credible.
      { to: "/admin/safety/passport-integrity", icon: ShieldCheck, label: "Passport Integrity" },
    ],
  },
  // Growth / Promote suite (US-632): segments, broadcast campaigns, in-app
  // announcements. Same admin + super_admin access; the send/broadcast action
  // is additionally super_admin-gated server-side.
  {
    title: "Growth",
    items: [
      { to: "/admin/growth", icon: Megaphone, label: "Overview", end: true },
      { to: "/admin/growth/segments", icon: Layers, label: "Segments" },
      { to: "/admin/growth/campaigns", icon: Send, label: "Campaigns" },
      { to: "/admin/growth/announcements", icon: Bell, label: "Announcements" },
      { to: "/admin/growth/referrals", icon: Gift, label: "Referrals" },
      // US-2559: Quests, Milestone Rewards, Reward Economics, Reward North Star
      // and Incentives are one domain. The host DEFAULTS to Economics, because
      // that page opens with the payout kill switch and today's spend, and an
      // operator in an incident needs "is money still leaving?" answered first.
      { to: "/admin/growth/rewards", icon: Gift, label: "Rewards" },
      // US-1845 buyer funnel, plan mix, feature adoption + the two-sided flywheel.
      { to: "/admin/growth/buyer", icon: Users, label: "Buyer Growth" },
      // US-946 trial-conversion drip funnel/ROI analytics.
      { to: "/admin/growth/drip", icon: Filter, label: "Trial Conversion", end: true },
      // US-945 visual drip / journey builder.
      { to: "/admin/growth/drip/builder", icon: GitMerge, label: "Drip Builder" },
      // US-2559: Newsletter Health, Console, Subscribers and Suppressions are
      // one domain. This path already WAS Health, so it is now the host and
      // Health is its default view: an existing bookmark still shows what it
      // showed.
      { to: "/admin/growth/newsletter", icon: MailCheck, label: "Newsletter" },
      // US-929 lifecycle email journeys: welcome / trial-nurture / win-back.
      { to: "/admin/growth/journeys", icon: Mailbox, label: "Lifecycle Journeys" },
    ],
  },
  // Operations console (US-881): platform automation surface. Same admin +
  // super_admin access; the Run-now action is additionally super_admin + MFA
  // step-up gated server-side.
  {
    title: "Operations",
    items: [
      // US-1590 Agentic OS Mission Control, the agent fleet console.
      { to: "/admin/agents", icon: Bot, label: "Mission Control" },
      // US-906 real-time activity feed + critical-event alerting. List/ack is
      // admin; editing alert channels / sending a test is super_admin +
      // step-up gated.
      { to: "/admin/ops/activity", icon: Activity, label: "Activity Feed", badge: "opsCritical" },
      { to: "/admin/ops/health", icon: Activity, label: "Infrastructure Health" },
      { to: "/admin/ops/jobs", icon: Server, label: "Background Jobs", badge: "failingJobs" },
      { to: "/admin/ops/dead-letters", icon: Inbox, label: "Dead Letters" },
      // US-884 settings registry. Reads are admin; the PUT mutation is
      // super_admin + MFA step-up gated server-side.
      { to: "/admin/ops/settings", icon: SlidersHorizontal, label: "Settings Registry" },
      // US-908 granular RBAC scopes. Reads are admin; editing role/admin scopes
      // is super_admin + users:role scope + MFA step-up gated server-side.
      { to: "/admin/ops/roles", icon: KeyRound, label: "Roles & Permissions" },
      // US-1058 notification event catalog, a read-only event/channel/volume map.
      { to: "/admin/ops/notifications", icon: Bell, label: "Notification Catalog" },
      { to: "/admin/ops/pricing", icon: DollarSign, label: "Grading & Credit Prices" },
      // US-886 feature flags v2. List/toggle is admin; the targeting rule editor
      // is super_admin + MFA step-up gated server-side.
      { to: "/admin/ops/feature-flags", icon: Flag, label: "Feature Flags" },
      // US-887 maintenance mode + scheduled windows. List is admin; create/edit/
      // end is super_admin + MFA step-up gated server-side.
      { to: "/admin/ops/maintenance", icon: Wrench, label: "Maintenance" },
      // US-910 operational runbooks, the on-call playbook in-app, deep-linked to
      // the controls. Read-only, build-time bundled (no secrets).
      { to: "/admin/ops/runbooks", icon: BookOpen, label: "Runbooks" },
    ],
  },
  // Marketplace ops (US-897): cross-tenant marketplace-connection health. Same
  // admin + super_admin access; the per-connection refresh / flag-for-reconnect
  // actions are additionally super_admin + MFA step-up gated server-side.
  {
    title: "Marketplace",
    items: [
      { to: "/admin/marketplace-connections", icon: PlugZap, label: "Connections" },
      // US-898: cross-tenant sync runs, conflicts and orphan sales with
      // resolution actions (re-run / accept-side / orphan-match), super_admin +
      // step-up gated.
      { to: "/admin/marketplace-ops", icon: GitMerge, label: "Sync & Conflicts", badge: "marketplaceOps" },
    ],
  },
  // Compliance (US-903): GDPR/CCPA data-subject request queue. Same admin +
  // super_admin access; processing a deletion is additionally super_admin + MFA
  // step-up gated server-side.
  {
    title: "Compliance",
    items: [
      { to: "/admin/compliance", icon: FileLock2, label: "Data Requests", badge: "complianceOpen" },
      // US-904 legal/ToS version manager. Reads are admin; publishing a version
      // is super_admin + MFA step-up gated server-side.
      { to: "/admin/legal", icon: ScrollText, label: "Legal & Terms" },
    ],
  },
  // Content module: its own section in the admin sidebar. Same admin +
  // super_admin access as the rest of the panel (moved here from the regular
  // dashboard's "Content" group).
  {
    title: "Content",
    items: [
      { to: "/admin/content/blog", icon: Newspaper, label: "Blog" },
      { to: "/admin/content/authors", icon: Users, label: "Authors" },
      { to: "/admin/content/social", icon: MessageCircle, label: "Social" },
      { to: "/admin/content/topics", icon: Lightbulb, label: "Topic Bank" },
      { to: "/admin/content/knowledge", icon: BookOpen, label: "Content Knowledge" },
      { to: "/admin/content/help", icon: LifeBuoy, label: "Help Center" },
      { to: "/admin/content/changelog", icon: Megaphone, label: "What's New" },
      { to: "/admin/content/analytics", icon: Activity, label: "Analytics" },
      { to: "/admin/content/settings", icon: SlidersHorizontal, label: "Content Settings" },
    ],
  },
];

/**
 * Every entry, sections flattened, in sidebar order.
 *
 * The shape a consumer that does not care about grouping wants. Derived, so it
 * cannot fall out of step with ADMIN_NAV.
 */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = ADMIN_NAV.flatMap(
  (section) => section.items,
);
