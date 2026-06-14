import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  FileText,
  MessageSquare,
  Scale,
  Headset,
  Brain,
  Wrench,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Tag,
  ListChecks,
  ArrowLeft,
  TrendingUp,
  BarChart3,
  Newspaper,
  MessageCircle,
  Lightbulb,
  BookOpen,
  Activity,
  SlidersHorizontal,
  Megaphone,
  Layers,
  Send,
  Bell,
  Gift,
  Server,
  DoorOpen,
  DollarSign,
  LineChart,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { edgeFetch } from "@/lib/edge-fetch";
import { AdminMfaGate } from "@/components/admin/admin-mfa-gate";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AppBillingDialogs } from "@/components/billing/app-billing-dialogs";

const adminNavItems = [
  { to: "/admin", icon: LayoutDashboard, label: "Dashboard", end: true, superAdminOnly: false },
  { to: "/admin/users", icon: Users, label: "Users", end: false, superAdminOnly: false },
  { to: "/admin/submissions", icon: FileText, label: "Submissions", end: false, superAdminOnly: false },
  { to: "/admin/reviews", icon: MessageSquare, label: "Reviews", end: false, superAdminOnly: false },
  { to: "/admin/disputes", icon: Scale, label: "Disputes", end: false, superAdminOnly: false },
  { to: "/admin/claims", icon: ShieldCheck, label: "Guarantee Claims", end: false, superAdminOnly: false },
  { to: "/admin/support", icon: Headset, label: "Support", end: true, superAdminOnly: false },
  { to: "/admin/support/kb", icon: BookOpen, label: "Knowledge Base", end: false, superAdminOnly: false },
  { to: "/admin/support/monitoring", icon: Activity, label: "Assistant Monitoring", end: false, superAdminOnly: false },
  { to: "/admin/moderation", icon: ShieldAlert, label: "Moderation", end: false, superAdminOnly: false },
  { to: "/admin/fraud", icon: ShieldX, label: "Abuse & Fraud", end: false, superAdminOnly: false },
  { to: "/admin/ai-models", icon: Brain, label: "AI Models", end: false, superAdminOnly: false },
  { to: "/admin/reliability", icon: BarChart3, label: "Reliability", end: false, superAdminOnly: false },
  { to: "/admin/seo", icon: TrendingUp, label: "SEO Health", end: false, superAdminOnly: false },
  { to: "/admin/condition-index", icon: LineChart, label: "Condition Index", end: false, superAdminOnly: false },
  { to: "/admin/coupons", icon: Tag, label: "Coupons", end: false, superAdminOnly: false },
  { to: "/admin/pricing", icon: DollarSign, label: "Plans & Pricing", end: false, superAdminOnly: false },
  { to: "/admin/waitlist", icon: DoorOpen, label: "Waitlist", end: false, superAdminOnly: false },
  { to: "/admin/tasks", icon: ListChecks, label: "Tasks", end: false, superAdminOnly: false },
  { to: "/admin/system", icon: Wrench, label: "System", end: false, superAdminOnly: false },
  { to: "/admin/jobs", icon: Server, label: "Jobs & Queues", end: false, superAdminOnly: false },
  { to: "/admin/audit-log", icon: ScrollText, label: "Audit Log", end: false, superAdminOnly: true },
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
];

// Content module — its own section in the admin sidebar. Same admin +
// super_admin access as the rest of the panel (moved here from the regular
// dashboard's "Content" group).
const contentNavItems = [
  { to: "/admin/content/blog", icon: Newspaper, label: "Blog", end: false },
  { to: "/admin/content/social", icon: MessageCircle, label: "Social", end: false },
  { to: "/admin/content/topics", icon: Lightbulb, label: "Topic Bank", end: false },
  { to: "/admin/content/knowledge", icon: BookOpen, label: "Knowledge", end: false },
  { to: "/admin/content/analytics", icon: Activity, label: "Analytics", end: false },
  { to: "/admin/content/settings", icon: SlidersHorizontal, label: "Content Settings", end: false },
];

// Shared NavLink styling for the admin sidebar (active = brand-red highlight).
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
    isActive
      ? "bg-brand-red/20 text-[#fb5e78]"
      : "text-white/70 hover:bg-white/10 hover:text-white"
  }`;

export function AdminLayout() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  const isSuperAdmin = profile?.role === "super_admin";
  const visibleNavItems = adminNavItems.filter(
    (item) => !item.superAdminOnly || isSuperAdmin
  );

  // US-775: pending human-review count for the nav badge (light poll, 60s stale).
  const { data: reviewCount } = useQuery({
    queryKey: ["admin-review-queue-count"],
    queryFn: async (): Promise<number> => {
      const res = await edgeFetch("/api/admin/grading/review-queue");
      const json = await res.json().catch(() => ({}));
      return res.ok ? Number(json.count ?? 0) : 0;
    },
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
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
    refetchInterval: 60 * 1000,
  });

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
      {/* Admin sidebar — darker treatment with brand-night bg */}
      <aside className="hidden w-64 flex-shrink-0 flex-col bg-brand-night text-white md:flex">
        <div className="flex h-16 items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <img src="/logo_icon.png" alt="GradeThread" className="h-7" />
            <span className="text-sm font-bold tracking-wide text-white/90">ADMIN</span>
          </div>
        </div>

        <nav className="mt-2 flex-1 space-y-1 overflow-y-auto px-3">
          {visibleNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={navLinkClass}
            >
              <item.icon className="h-5 w-5" />
              <span className="flex-1">{item.label}</span>
              {item.to === "/admin/reviews" && (reviewCount ?? 0) > 0 && (
                <span className="rounded-full bg-brand-red px-2 py-0.5 text-xs font-semibold text-white">
                  {reviewCount}
                </span>
              )}
              {item.to === "/admin/support" && (escalatedCount ?? 0) > 0 && (
                <span className="rounded-full bg-brand-red px-2 py-0.5 text-xs font-semibold text-white">
                  {escalatedCount}
                </span>
              )}
            </NavLink>
          ))}

          {/* Growth / Promote suite. */}
          <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
            Growth
          </div>
          {growthNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={navLinkClass}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </NavLink>
          ))}

          {/* Content module — visually grouped under its own heading. */}
          <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
            Content
          </div>
          {contentNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={navLinkClass}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Back to dashboard link at bottom */}
        <div className="border-t border-white/10 px-3 py-3">
          <button
            onClick={() => navigate("/dashboard")}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft className="h-5 w-5" />
            Back to Dashboard
          </button>
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Admin header */}
        <header className="flex h-16 items-center justify-between border-b bg-card px-6">
          <div className="flex items-center gap-2">
            <span className="rounded bg-brand-red/10 px-2 py-1 text-xs font-semibold text-brand-red-text">
              Admin Panel
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
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
          className="flex-1 overflow-y-auto bg-background p-6 outline-none"
        >
          {/* US-270: require MFA (AAL2) before any admin content renders. */}
          <AdminMfaGate>
            <Outlet />
          </AdminMfaGate>
        </main>
      </div>
      {/* Billing dialogs — also mounted here so admin routes (their own layout)
          still get the 402 hard-trigger; only one layout is ever live at once. */}
      <AppBillingDialogs />
    </div>
  );
}
