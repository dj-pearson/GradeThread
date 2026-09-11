import { NavLink, Outlet, useNavigate } from "react-router";
import { ArrowLeft, Menu, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
import { RouteAnnouncer } from "@/components/route-announcer";
import { useFocusOnNavigation } from "@/hooks/use-focus-on-navigation";
import { useSurfaceTitle } from "@/hooks/use-surface-title";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  ADMIN_NAV,
  type AdminNavCounts,
  type AdminNavItem,
} from "@/lib/admin-nav";

// Shared NavLink styling for the admin sidebar (active = brand-red highlight).
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
    isActive
      ? "bg-brand-red/20 text-brand-red-text"
      : "text-white/70 hover:bg-white/10 hover:text-white"
  }`;

function navBadge(count: number) {
  if (count <= 0) return null;
  return (
    <span className="rounded-full bg-brand-red px-2 py-0.5 text-xs font-semibold text-white">
      {count}
    </span>
  );
}

// One nav row. Every entry renders through this, so a badge is the presence of
// `item.badge` rather than the renderer knowing which paths are special: the
// seven path-equality checks this replaces were the reason a new badge meant
// editing the JSX as well as the list.
function AdminNavRow({
  item,
  counts,
  onNavigate,
}: {
  item: AdminNavItem;
  counts: AdminNavCounts;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={navLinkClass}
      onClick={onNavigate}
    >
      <item.icon className="h-5 w-5" />
      <span className="flex-1">{item.label}</span>
      {item.badge ? navBadge(counts[item.badge]) : null}
    </NavLink>
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
  // Sections render from ADMIN_NAV in order. The super-admin filter applies to
  // every section rather than only the first: no other entry carries the flag
  // today, and scoping it to one array is how the next flagged entry in the
  // wrong section would have shown to everyone.
  const sections = ADMIN_NAV.map((section) => ({
    title: section.title,
    items: section.items.filter((item) => !item.superAdminOnly || isSuperAdmin),
  })).filter((section) => section.items.length > 0);

  return (
    <>
      <nav className="mt-2 flex-1 space-y-1 overflow-y-auto px-3">
        {sections.map((section) => (
          <div key={section.title ?? "__top"} className="space-y-1">
            {section.title ? (
              <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-white/40">
                {section.title}
              </div>
            ) : null}
            {section.items.map((item) => (
              <AdminNavRow
                key={item.to}
                item={item}
                counts={counts}
                onNavigate={onNavigate}
              />
            ))}
          </div>
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

  // US-3244 AC4. Unlike the title hook, this needs nothing from the surfaces
  // registry -- it moves the cursor, it does not name anything -- so admin gets
  // it on the same terms as the other two trees. Note the drawer above: on a
  // phone every admin nav click closes a Sheet, and the hook deliberately
  // stands down while one is closing rather than fighting Radix's focus
  // restore. Desktop admin, where the sidebar is a plain <aside>, is where this
  // actually does its work.
  // US-3252: admin reads from ADMIN_NAV_ITEMS now, so a name resolves here.
  // Mounting this before the nav was extracted would have returned the
  // marketing default on every admin route, which reads like a fix and is not.
  useSurfaceTitle();
  useFocusOnNavigation("main-content");

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
      {/* US-3252: admin is not in the surfaces registry and should not be. It
          is operator tooling, not a product surface, so this announces the
          generic "Page changed" rather than a page name. Still better than the
          silence an operator navigating by screen reader used to get.

          The title hook is still NOT mounted here, and the reason changed with
          this commit. It used to be that admin had no readable nav at all;
          src/lib/admin-nav.ts is now that source, the same way buyer-nav.ts is
          the buyer tree's. What is left is wiring it into
          hooks/use-surface-title.ts, which is a separate file and a separate
          change. Mounting the hook before that lands would title every admin
          route with the marketing default while reading like a fix. */}
      <RouteAnnouncer />
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
