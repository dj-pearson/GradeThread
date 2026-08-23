import { NavLink, Outlet, useNavigate } from "react-router";
import {
  LayoutDashboard,
  Users,
  FileText,
  BookMarked,
  Scale,
  Headset,
  Brain,
  Wrench,
  ScrollText,
  ShieldAlert,
  Ruler,
  ShieldCheck,
  PiggyBank,
  Tag,
  ListChecks,
  ArrowLeft,
  TrendingUp,
  BarChart3,
  Newspaper,
  MessageCircle,
  Lightbulb,
  LifeBuoy,
  BookOpen,
  Activity,
  Bot,
  SlidersHorizontal,
  Megaphone,
  Layers,
  Filter,
  Send,
  Bell,
  Gift,
  Server,
  Inbox,
  Ticket,
  FileLock2,
  DoorOpen,
  DollarSign,
  LineChart,
  Flag,
  Gauge,
  RefreshCw,
  PlugZap,
  GitMerge,
  KeyRound,
  MailCheck,
  Mailbox,
  ClipboardCheck,
  Menu,
  Map,
  ScanSearch,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Search } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { edgeFetch } from "@/lib/edge-fetch";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { AdminMfaGate } from "@/components/admin/admin-mfa-gate";
import { StepUpHost } from "@/components/admin/step-up-host";
import { AdminNotificationBell } from "@/components/admin/admin-notification-bell";
import { CommandPalette } from "@/components/admin/command-palette";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AppBillingDialogs } from "@/components/billing/app-billing-dialogs";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";

const adminNavItems = [
  { to: "/admin", icon: LayoutDashboard, label: "Dashboard", end: true, superAdminOnly: false },
  { to: "/admin/users", icon: Users, label: "Users", end: false, superAdminOnly: false },
  { to: "/admin/bulk", icon: Layers, label: "Bulk Ops", end: false, superAdminOnly: false },
  { to: "/admin/category-map", icon: Map, label: "Category Map", end: false, superAdminOnly: false },
  { to: "/admin/identification-provenance", icon: ScanSearch, label: "Visual Identification", end: false, superAdminOnly: false },
  { to: "/admin/brand-knowledge", icon: BookMarked, label: "Brand Knowledge", end: false, superAdminOnly: false },
  { to: "/admin/registered-numbers", icon: Tag, label: "Registered Numbers", end: false, superAdminOnly: false },
  { to: "/admin/submissions", icon: FileText, label: "Submissions", end: false, superAdminOnly: false },
  { to: "/admin/grading", icon: ClipboardCheck, label: "Review Queue", end: false, superAdminOnly: false },
  { to: "/admin/authenticity", icon: ShieldCheck, label: "Authenticity", end: false, superAdminOnly: false },
  { to: "/admin/disputes", icon: Scale, label: "Disputes", end: false, superAdminOnly: false },
  { to: "/admin/claims", icon: ShieldCheck, label: "Guarantee Claims", end: false, superAdminOnly: false },
  { to: "/admin/guarantee-pool", icon: PiggyBank, label: "Guarantee Pool", end: false, superAdminOnly: false },
  { to: "/admin/measure-cards", icon: Ruler, label: "MeasureCards", end: false, superAdminOnly: false },
  { to: "/admin/support", icon: Headset, label: "AI Escalations", end: true, superAdminOnly: false },
  { to: "/admin/support-tickets", icon: Ticket, label: "Support Tickets", end: false, superAdminOnly: false },
  { to: "/admin/support/kb", icon: BookOpen, label: "Support Knowledge Base", end: false, superAdminOnly: false },
  // US-2559: AI Models, AI Spend, AI Profitability and Assistant Monitoring
  // were four entries covering one domain. One destination, four tabs; nothing
  // was deleted, and every old path redirects into the matching tab.
  { to: "/admin/ai", icon: Brain, label: "AI Platform", end: false, superAdminOnly: false },
  { to: "/admin/reliability", icon: BarChart3, label: "Reliability", end: false, superAdminOnly: false },
  { to: "/admin/seo", icon: TrendingUp, label: "SEO Health", end: false, superAdminOnly: false },
  { to: "/admin/ads", icon: Megaphone, label: "Ad Copy Studio", end: false, superAdminOnly: false },
  { to: "/admin/keyword-research", icon: Search, label: "Keyword Research", end: false, superAdminOnly: false },
  { to: "/admin/condition-index", icon: LineChart, label: "Condition Index", end: false, superAdminOnly: false },
  { to: "/admin/coupons", icon: Tag, label: "Coupons", end: false, superAdminOnly: false },
  { to: "/admin/pricing", icon: DollarSign, label: "Subscription Plans", end: false, superAdminOnly: false },
  { to: "/admin/waitlist", icon: DoorOpen, label: "Waitlist", end: false, superAdminOnly: false },
  { to: "/admin/tasks", icon: ListChecks, label: "Tasks", end: false, superAdminOnly: false },
  { to: "/admin/system", icon: Wrench, label: "Platform Health", end: false, superAdminOnly: false },
  { to: "/admin/jobs", icon: Server, label: "Jobs & Queues", end: false, superAdminOnly: false },
  { to: "/admin/audit-log", icon: ScrollText, label: "Audit Log", end: false, superAdminOnly: true },
];

// Revenue Ops (US-891) — operator MRR/ARR dashboard. Same admin + super_admin
// access; read-only (no destructive actions, so no extra step-up).
const revenueNavItems = [
  { to: "/admin/revenue", icon: DollarSign, label: "Revenue & MRR", end: false },
  // US-893 — past-due/paused accounts, failed invoices, Stripe-vs-DB divergences,
  // with re-sync / dunning / mark-resolved actions (step-up gated server-side).
  { to: "/admin/billing/reconciliation", icon: RefreshCw, label: "Reconciliation", end: false },
];

// Analytics (US-907) — product funnel & weekly cohort retention. Read-only,
// server-side aggregated; same admin + super_admin access (no destructive
// actions). Complements the PostHog product analytics.
const analyticsNavItems = [
  { to: "/admin/analytics", icon: BarChart3, label: "Funnel & Retention", end: false },
];

// Trust & Safety (US-888) — moderation, the live abuse/fraud aggregate, and the
// durable abuse-signal queue. Same admin + super_admin access; resolving a
// signal / suspending is additionally super_admin + MFA step-up gated
// server-side.
const safetyNavItems = [
  // US-2559: Moderation, Abuse & Fraud and Abuse Signals are one domain.
  // Rate Limits and Passport Integrity below are NOT — one is capacity
  // administration, the other is ledger integrity — so they keep their entries.
  { to: "/admin/safety", icon: ShieldAlert, label: "Trust & Safety", end: true },
  // US-890 rate-limit administration: counters + temporary per-user overrides.
  { to: "/admin/safety/rate-limits", icon: Gauge, label: "Rate Limits", end: false },
  // US-1103 Garment Passport integrity: impossible chains, duplicate fingerprints,
  // claim abuse — keeps the ledger credible.
  { to: "/admin/safety/passport-integrity", icon: ShieldCheck, label: "Passport Integrity", end: false },
];

// Growth / Promote suite (US-632) — segments, broadcast campaigns, in-app
// announcements. Same admin + super_admin access; the send/broadcast action is
// additionally super_admin-gated server-side.
const growthNavItems = [
  { to: "/admin/growth", icon: Megaphone, label: "Overview", end: true },
  { to: "/admin/growth/segments", icon: Layers, label: "Segments", end: false },
  { to: "/admin/growth/campaigns", icon: Send, label: "Campaigns", end: false },
  { to: "/admin/growth/announcements", icon: Bell, label: "Announcements", end: false },
  { to: "/admin/growth/referrals", icon: Gift, label: "Referrals", end: false },
  // US-2559: Quests, Milestone Rewards, Reward Economics, Reward North Star and
  // Incentives are one domain. The host DEFAULTS to Economics, because that page
  // opens with the payout kill switch and today's spend and an operator in an
  // incident needs "is money still leaving?" answered first.
  { to: "/admin/growth/rewards", icon: Gift, label: "Rewards", end: false },
  // US-1845 buyer funnel, plan mix, feature adoption + the two-sided flywheel.
  { to: "/admin/growth/buyer", icon: Users, label: "Buyer Growth", end: false },
  // US-946 trial-conversion drip funnel/ROI analytics.
  { to: "/admin/growth/drip", icon: Filter, label: "Trial Conversion", end: true },
  // US-945 visual drip / journey builder.
  { to: "/admin/growth/drip/builder", icon: GitMerge, label: "Drip Builder", end: false },
  // US-2559: Newsletter Health, Console, Subscribers and Suppressions are one
  // domain. This path already WAS Health, so it is now the host and Health is
  // its default view — an existing bookmark still shows what it showed.
  { to: "/admin/growth/newsletter", icon: MailCheck, label: "Newsletter", end: false },
  // US-929 lifecycle email journeys — welcome / trial-nurture / win-back.
  { to: "/admin/growth/journeys", icon: Mailbox, label: "Lifecycle Journeys", end: false },
];

// Operations console (US-881) — platform automation surface. Same admin +
// super_admin access; the Run-now action is additionally super_admin + MFA
// step-up gated server-side.
const opsNavItems = [
  // US-1590 Agentic OS Mission Control — the agent fleet console.
  { to: "/admin/agents", icon: Bot, label: "Mission Control", end: false },
  // US-906 real-time activity feed + critical-event alerting. List/ack is admin;
  // editing alert channels / sending a test is super_admin + step-up gated.
  { to: "/admin/ops/activity", icon: Activity, label: "Activity Feed", end: false },
  { to: "/admin/ops/health", icon: Activity, label: "Infrastructure Health", end: false },
  { to: "/admin/ops/jobs", icon: Server, label: "Background Jobs", end: false },
  { to: "/admin/ops/dead-letters", icon: Inbox, label: "Dead Letters", end: false },
  // US-884 settings registry. Reads are admin; the PUT mutation is super_admin +
  // MFA step-up gated server-side.
  { to: "/admin/ops/settings", icon: SlidersHorizontal, label: "Settings Registry", end: false },
  // US-908 granular RBAC scopes. Reads are admin; editing role/admin scopes is
  // super_admin + users:role scope + MFA step-up gated server-side.
  { to: "/admin/ops/roles", icon: KeyRound, label: "Roles & Permissions", end: false },
  // US-1058 notification event catalog — read-only event/channel/volume map.
  { to: "/admin/ops/notifications", icon: Bell, label: "Notification Catalog", end: false },
  { to: "/admin/ops/pricing", icon: DollarSign, label: "Grading & Credit Prices", end: false },
  // US-886 feature flags v2. List/toggle is admin; the targeting rule editor is
  // super_admin + MFA step-up gated server-side.
  { to: "/admin/ops/feature-flags", icon: Flag, label: "Feature Flags", end: false },
  // US-887 maintenance mode + scheduled windows. List is admin; create/edit/end
  // is super_admin + MFA step-up gated server-side.
  { to: "/admin/ops/maintenance", icon: Wrench, label: "Maintenance", end: false },
  // US-910 operational runbooks — the on-call playbook in-app, deep-linked to
  // the controls. Read-only, build-time bundled (no secrets).
  { to: "/admin/ops/runbooks", icon: BookOpen, label: "Runbooks", end: false },
];

// Compliance (US-903) — GDPR/CCPA data-subject request queue. Same admin +
// super_admin access; processing a deletion is additionally super_admin + MFA
// step-up gated server-side.
const complianceNavItems = [
  { to: "/admin/compliance", icon: FileLock2, label: "Data Requests", end: false },
  // US-904 legal/ToS version manager. Reads are admin; publishing a version is
  // super_admin + MFA step-up gated server-side.
  { to: "/admin/legal", icon: ScrollText, label: "Legal & Terms", end: false },
];

// Marketplace ops (US-897) — cross-tenant marketplace-connection health. Same
// admin + super_admin access; the per-connection refresh / flag-for-reconnect
// actions are additionally super_admin + MFA step-up gated server-side.
const marketplaceNavItems = [
  { to: "/admin/marketplace-connections", icon: PlugZap, label: "Connections", end: false },
  // US-898 — cross-tenant sync runs, conflicts and orphan sales with resolution
  // actions (re-run / accept-side / orphan-match), super_admin + step-up gated.
  { to: "/admin/marketplace-ops", icon: GitMerge, label: "Sync & Conflicts", end: false },
];

// Content module — its own section in the admin sidebar. Same admin +
// super_admin access as the rest of the panel (moved here from the regular
// dashboard's "Content" group).
const contentNavItems = [
  { to: "/admin/content/blog", icon: Newspaper, label: "Blog", end: false },
  { to: "/admin/content/authors", icon: Users, label: "Authors", end: false },
  { to: "/admin/content/social", icon: MessageCircle, label: "Social", end: false },
  { to: "/admin/content/topics", icon: Lightbulb, label: "Topic Bank", end: false },
  { to: "/admin/content/knowledge", icon: BookOpen, label: "Content Knowledge", end: false },
  { to: "/admin/content/help", icon: LifeBuoy, label: "Help Center", end: false },
  { to: "/admin/content/changelog", icon: Megaphone, label: "What's New", end: false },
  { to: "/admin/content/analytics", icon: Activity, label: "Analytics", end: false },
  { to: "/admin/content/settings", icon: SlidersHorizontal, label: "Content Settings", end: false },
];

// Shared NavLink styling for the admin sidebar (active = brand-red highlight).
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
    isActive
      ? "bg-brand-red/20 text-brand-red-text"
      : "text-white/70 hover:bg-white/10 hover:text-white"
  }`;

// Nav badge counts, polled in AdminLayout and passed down so the sidebar body
// renders identically on desktop and in the mobile drawer.
interface AdminNavCounts {
  review: number;
  escalated: number;
  openTickets: number;
  failingJobs: number;
  opsCritical: number;
  marketplaceOps: number;
  complianceOpen: number;
}

function navBadge(count: number) {
  if (count <= 0) return null;
  return (
    <span className="rounded-full bg-brand-red px-2 py-0.5 text-xs font-semibold text-white">
      {count}
    </span>
  );
}

// The scrollable nav + the "Back to Dashboard" footer. Shared by the desktop
// `<aside>` and the mobile slide-in drawer. `onNavigate` is supplied only by the
// mobile drawer (to close the sheet after a tap); on desktop it's undefined.
function AdminSidebarBody({
  isSuperAdmin,
  counts,
  onNavigate,
}: {
  isSuperAdmin: boolean;
  counts: AdminNavCounts;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const visibleNavItems = adminNavItems.filter(
    (item) => !item.superAdminOnly || isSuperAdmin
  );

  return (
    <>
      <nav className="mt-2 flex-1 space-y-1 overflow-y-auto px-3">
        {visibleNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={navLinkClass}
            onClick={onNavigate}
          >
            <item.icon className="h-5 w-5" />
            <span className="flex-1">{item.label}</span>
            {/* US-2505: the review badge follows the queue now that
                /admin/reviews is retired. */}
            {item.to === "/admin/grading" && navBadge(counts.review)}
            {item.to === "/admin/support" && navBadge(counts.escalated)}
            {item.to === "/admin/support-tickets" && navBadge(counts.openTickets)}
          </NavLink>
        ))}

        {/* Revenue Ops (US-891). */}
        <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
          Revenue
        </div>
        {revenueNavItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={onNavigate}>
            <item.icon className="h-5 w-5" />
            {item.label}
          </NavLink>
        ))}

        {/* Analytics (US-907). */}
        <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
          Analytics
        </div>
        {analyticsNavItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={onNavigate}>
            <item.icon className="h-5 w-5" />
            {item.label}
          </NavLink>
        ))}

        {/* Trust & Safety (US-888). */}
        <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
          Trust &amp; Safety
        </div>
        {safetyNavItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={onNavigate}>
            <item.icon className="h-5 w-5" />
            {item.label}
          </NavLink>
        ))}

        {/* Growth / Promote suite. */}
        <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
          Growth
        </div>
        {growthNavItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={onNavigate}>
            <item.icon className="h-5 w-5" />
            {item.label}
          </NavLink>
        ))}

        {/* Operations console (US-881). */}
        <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
          Operations
        </div>
        {opsNavItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={onNavigate}>
            <item.icon className="h-5 w-5" />
            <span className="flex-1">{item.label}</span>
            {item.to === "/admin/ops/jobs" && navBadge(counts.failingJobs)}
            {item.to === "/admin/ops/activity" && navBadge(counts.opsCritical)}
          </NavLink>
        ))}

        {/* Marketplace ops (US-897). */}
        <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
          Marketplace
        </div>
        {marketplaceNavItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={onNavigate}>
            <item.icon className="h-5 w-5" />
            <span className="flex-1">{item.label}</span>
            {item.to === "/admin/marketplace-ops" && navBadge(counts.marketplaceOps)}
          </NavLink>
        ))}

        {/* Compliance (US-903). */}
        <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
          Compliance
        </div>
        {complianceNavItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={onNavigate}>
            <item.icon className="h-5 w-5" />
            <span className="flex-1">{item.label}</span>
            {item.to === "/admin/compliance" && navBadge(counts.complianceOpen)}
          </NavLink>
        ))}

        {/* Content module — visually grouped under its own heading. */}
        <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
          Content
        </div>
        {contentNavItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass} onClick={onNavigate}>
            <item.icon className="h-5 w-5" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Back to dashboard link at bottom */}
      <div className="border-t border-white/10 px-3 py-3">
        <button
          onClick={() => {
            onNavigate?.();
            navigate("/dashboard");
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft className="h-5 w-5" />
          Back to Dashboard
        </button>
      </div>
    </>
  );
}

// The ADMIN wordmark header, shared by the desktop aside and the mobile drawer.
function AdminSidebarHeader() {
  return (
    <div className="flex h-16 items-center gap-2 px-6">
      <img src="/logo_icon.png" width={512} height={512} alt="GradeThread" className="h-7" />
      <span className="text-sm font-bold tracking-wide text-white/90">ADMIN</span>
    </div>
  );
}

export function AdminLayout() {
  const { user, profile } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Mobile-only nav drawer (the desktop `<aside>` is hidden below `md`).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // US-901: Cmd/Ctrl-K opens the global admin command palette. allowInInput so
  // it still fires while focus is in a field (the standard palette behaviour).
  useKeyboardShortcuts([
    {
      key: "k",
      ctrlOrMeta: true,
      allowInInput: true,
      handler: () => setPaletteOpen((o) => !o),
    },
  ]);

  const isSuperAdmin = profile?.role === "super_admin";
  // US-2197: pause the nav badge polls while the tab is backgrounded so a parked
  // admin tab doesn't hit these 7 endpoints every minute indefinitely.
  const visible = useDocumentVisible();

  // US-775: pending human-review count for the nav badge (light poll, 60s stale).
  const { data: reviewCount } = useQuery({
    queryKey: ["admin-review-queue-count"],
    queryFn: async (): Promise<number> => {
      const res = await edgeFetch("/api/admin/grading/review-queue");
      const json = await res.json().catch(() => ({}));
      return res.ok ? Number(json.count ?? 0) : 0;
    },
    staleTime: 60 * 1000,
    refetchInterval: visible ? 60 * 1000 : false,
  });

  // US-839: escalated support conversations awaiting a human, for the nav badge.
  const { data: escalatedCount } = useQuery({
    queryKey: ["admin-support-escalated-count"],
    queryFn: async (): Promise<number> => {
      const res = await edgeFetch("/api/admin/support/conversations?status=escalated");
      const json = await res.json().catch(() => ({}));
      return res.ok ? (json.conversations?.length ?? 0) : 0;
    },
    staleTime: 60 * 1000,
    refetchInterval: visible ? 60 * 1000 : false,
  });

  // US-900: open/pending support tickets, for the Support Tickets nav badge.
  const { data: openTicketCount } = useQuery({
    queryKey: ["admin-support-tickets-open-count"],
    queryFn: async (): Promise<number> => {
      const res = await edgeFetch("/api/admin/support-tickets/count");
      const json = await res.json().catch(() => ({}));
      return res.ok ? Number(json.open_count ?? 0) : 0;
    },
    staleTime: 60 * 1000,
    refetchInterval: visible ? 60 * 1000 : false,
  });

  // US-881: count of background jobs with consecutive failures, for the
  // Operations > Background Jobs nav badge (light poll, like Reviews above).
  const { data: failingJobsCount } = useQuery({
    queryKey: ["admin-ops-failing-jobs-count"],
    queryFn: async (): Promise<number> => {
      const res = await edgeFetch("/api/admin/ops/jobs?page_size=1");
      const json = await res.json().catch(() => ({}));
      return res.ok ? Number(json.failing_count ?? 0) : 0;
    },
    staleTime: 60 * 1000,
    refetchInterval: visible ? 60 * 1000 : false,
  });

  // US-906: unacknowledged critical ops events, for the Activity Feed nav badge.
  const { data: opsCriticalCount } = useQuery({
    queryKey: ["admin-ops-events-critical-count"],
    queryFn: async (): Promise<number> => {
      const res = await edgeFetch("/api/admin/ops/events/unread-count");
      const json = await res.json().catch(() => ({}));
      return res.ok ? Number(json.critical_unacked ?? 0) : 0;
    },
    staleTime: 60 * 1000,
    refetchInterval: visible ? 60 * 1000 : false,
  });

  // US-898: open conflicts + unmatched orphans + stuck runs, for the Marketplace
  // > Sync & Conflicts nav badge (light poll, like the others above).
  const { data: marketplaceOpsCount } = useQuery({
    queryKey: ["admin-marketplace-ops-counts"],
    queryFn: async (): Promise<number> => {
      const res = await edgeFetch("/api/admin/marketplace/counts");
      const json = await res.json().catch(() => ({}));
      return res.ok ? Number(json.total ?? 0) : 0;
    },
    staleTime: 60 * 1000,
    refetchInterval: visible ? 60 * 1000 : false,
  });

  // US-903: open (received/processing) data-subject requests, for the Compliance
  // nav badge (light poll, like the others above).
  const { data: complianceOpenCount } = useQuery({
    queryKey: ["admin-compliance-open-count"],
    queryFn: async (): Promise<number> => {
      const res = await edgeFetch("/api/admin/compliance/data-requests/count");
      const json = await res.json().catch(() => ({}));
      return res.ok ? Number(json.open_count ?? 0) : 0;
    },
    staleTime: 60 * 1000,
    refetchInterval: visible ? 60 * 1000 : false,
  });

  const counts: AdminNavCounts = {
    review: reviewCount ?? 0,
    escalated: escalatedCount ?? 0,
    openTickets: openTicketCount ?? 0,
    failingJobs: failingJobsCount ?? 0,
    opsCritical: opsCriticalCount ?? 0,
    marketplaceOps: marketplaceOpsCount ?? 0,
    complianceOpen: complianceOpenCount ?? 0,
  };

  const initials = profile?.full_name
    ? profile.full_name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
    : user?.email?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="flex h-screen overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brand-red focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg"
      >
        Skip to content
      </a>
      {/* Admin sidebar — darker treatment with brand-night bg. Desktop only;
          below `md` it's replaced by the hamburger-triggered drawer below. */}
      <aside className="hidden w-64 flex-shrink-0 flex-col bg-brand-night text-white md:flex">
        <AdminSidebarHeader />
        <AdminSidebarBody isSuperAdmin={isSuperAdmin} counts={counts} />
      </aside>

      {/* Mobile nav drawer — the same sidebar body in a left-side sheet. */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          className="flex w-72 flex-col gap-0 border-white/10 bg-brand-night p-0 text-white"
        >
          <SheetTitle className="sr-only">Admin navigation</SheetTitle>
          <AdminSidebarHeader />
          <AdminSidebarBody
            isSuperAdmin={isSuperAdmin}
            counts={counts}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Admin header */}
        <header className="flex h-16 items-center justify-between border-b bg-card px-4 sm:px-6">
          <div className="flex items-center gap-2">
            {/* Mobile-only nav toggle (the desktop sidebar is always visible). */}
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="-ml-1 rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent/50 md:hidden"
              aria-label="Open admin navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="rounded bg-brand-red/10 px-2 py-1 text-xs font-semibold text-brand-red-text">
              Admin Panel
            </span>
          </div>
          <div className="flex items-center gap-3">
            {/* US-901 global search trigger (also Cmd/Ctrl-K). */}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50"
              aria-label="Open global search"
            >
              <Search className="h-4 w-4" />
              <span className="hidden sm:inline">Search…</span>
              <kbd className="hidden rounded border bg-muted px-1.5 text-[10px] font-medium sm:inline">
                ⌘K
              </kbd>
            </button>
            {/* US-909 admin notification center. */}
            <AdminNotificationBell />
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {profile?.full_name ?? user?.email}
            </span>
            <Avatar className="h-8 w-8">
              <AvatarImage src={profile?.avatar_url ?? undefined} />
              <AvatarFallback className="bg-brand-red text-white text-xs">
                {initials}
              </AvatarFallback>
            </Avatar>
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-y-auto bg-background p-4 outline-none sm:p-6"
        >
          {/* US-270: require MFA (AAL2) before any admin content renders. */}
          <AdminMfaGate>
            {/* The single step-up prompt edgeFetch raises on a
                403 STEP_UP_REQUIRED, for every admin surface. */}
            <StepUpHost />
            <Outlet />
          </AdminMfaGate>
        </main>
      </div>
      {/* Billing dialogs — also mounted here so admin routes (their own layout)
          still get the 402 hard-trigger; only one layout is ever live at once. */}
      <AppBillingDialogs />
      {/* US-901 global admin search / command palette. */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
