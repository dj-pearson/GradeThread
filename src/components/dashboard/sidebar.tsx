import { NavLink, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  FileText,
  Package,
  DollarSign,
  Lightbulb,
  CreditCard,
  Key,
  Settings,
  Menu,
  MapPin,
  Plug,
  Scale,
  Upload,
  Gauge,
  Wallet,
  BarChart3,
  Boxes,
  Users,
  Sparkles,
  ShieldCheck,
  TrendingUp,
  Layers,
  ClipboardList,
  Radar,
  Camera,
  Gift,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { useSavedViews } from "@/hooks/use-saved-views";
import { SidebarUsageWidget } from "@/components/dashboard/sidebar-usage-widget";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { FLIPDESK_PLANS, type FlipdeskGateFlags, type FlipdeskPlanKey } from "@/lib/constants";
import type { WorkspaceCapability } from "@/lib/workspace-permissions";

type NavItem = {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  end: boolean;
  // Optional capability gate. If set, only render this item when the
  // current user can perform this action in the active workspace.
  requires?: WorkspaceCapability;
  // Optional FlipDesk plan-tier gate (US-323). When set, the item is only
  // shown if the workspace's current FlipDesk plan has this gate flag true.
  requiresFlipdeskFlag?: keyof FlipdeskGateFlags;
};
type NavGroup = { title?: string; items: NavItem[]; adminOnly?: boolean };

const navGroups: NavGroup[] = [
  {
    title: "Grading",
    items: [
      { to: "/dashboard", icon: LayoutDashboard, label: "Overview", end: true },
      { to: "/dashboard/snap", icon: Camera, label: "What's it worth?", end: false },
      { to: "/dashboard/submissions", icon: FileText, label: "Submissions", end: false },
      { to: "/dashboard/inventory", icon: Package, label: "Inventory", end: false },
      { to: "/dashboard/finances", icon: DollarSign, label: "Finances", end: false },
      { to: "/dashboard/analytics/suggestions", icon: Lightbulb, label: "Price Suggestions", end: false },
    ],
  },
  {
    title: "FlipDesk",
    items: [
      { to: "/dashboard/flipdesk", icon: Gauge, label: "Overview", end: true },
      // Inventory is one surface now. Its in-page tabs switch between
      // Table / Grid / Kanban / Prep views — see InventoryViewSwitcher.
      { to: "/dashboard/flipdesk/inventory", icon: Boxes, label: "Inventory", end: false },
      { to: "/dashboard/flipdesk/autolister", icon: Sparkles, label: "AutoLister", end: false, requiresFlipdeskFlag: "autolister" },
      { to: "/dashboard/flipdesk/autolister/drafts", icon: ClipboardList, label: "Drafts", end: false, requiresFlipdeskFlag: "autolister" },
      { to: "/dashboard/flipdesk/verified", icon: ShieldCheck, label: "Verified", end: false },
      { to: "/dashboard/flipdesk/import", icon: Upload, label: "Import", end: false },
      { to: "/dashboard/flipdesk/reconcile", icon: Layers, label: "Reconcile", end: false },
      { to: "/dashboard/flipdesk/sources", icon: MapPin, label: "Sources", end: false },
      { to: "/dashboard/flipdesk/marketplaces", icon: Plug, label: "Marketplaces", end: false },
      { to: "/dashboard/flipdesk/reconciliation", icon: Scale, label: "Reconciliation", end: false },
      { to: "/dashboard/flipdesk/expenses", icon: Wallet, label: "Expenses", end: false },
      { to: "/dashboard/flipdesk/repricing", icon: TrendingUp, label: "Repricing", end: false },
      { to: "/dashboard/flipdesk/scout", icon: Radar, label: "ScoutAI", end: false, requiresFlipdeskFlag: "compPulls" },
      { to: "/dashboard/flipdesk/analytics", icon: BarChart3, label: "Analytics", end: false },
    ],
  },
  {
    title: "Account",
    items: [
      { to: "/dashboard/team", icon: Users, label: "Team", end: false },
      { to: "/dashboard/referrals", icon: Gift, label: "Refer a friend", end: false },
      { to: "/dashboard/billing", icon: CreditCard, label: "Billing", end: false, requires: "manage_billing" },
      { to: "/dashboard/api-keys", icon: Key, label: "API Keys", end: false, requires: "manage_api_keys" },
      { to: "/dashboard/settings", icon: Settings, label: "Settings", end: false },
    ],
  },
];

const COLLAPSE_KEY = "gt-sidebar-collapsed";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const profile = useAuthStore((s) => s.profile);
  const isAdmin =
    profile?.role === "admin" || profile?.role === "super_admin";
  const { can } = useWorkspace();
  // FlipDesk plan governs feature-flag sidebar entries (US-323).
  const { data: billing } = useBillingSummary();
  const flipdeskFlags =
    FLIPDESK_PLANS[(billing?.subscription.plan as FlipdeskPlanKey) ?? "free"]
      .gateFlags;
  const { pathname } = useLocation();
  // Per-section collapse state, persisted so the user's layout sticks.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(
    loadCollapsed,
  );

  function toggleGroup(title: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [title]: !prev[title] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* storage may be unavailable (private mode) — ignore */
      }
      return next;
    });
  }

  function groupHasActiveRoute(items: NavItem[]): boolean {
    return items.some((item) =>
      item.end ? pathname === item.to : pathname.startsWith(item.to),
    );
  }

  return (
    <nav className="mt-2 flex-1 space-y-4 px-3">
      {navGroups
        .filter((g) => !g.adminOnly || isAdmin)
        .map((group, gi) => {
        const visibleItems = group.items.filter((item) => {
          if (item.requires && !can(item.requires)) return false;
          if (item.requiresFlipdeskFlag && !flipdeskFlags[item.requiresFlipdeskFlag]) {
            return false;
          }
          return true;
        });
        if (visibleItems.length === 0) return null;
        // A collapsed section is force-opened while it contains the active
        // route, so the current page's nav item is never hidden.
        const hasActive = groupHasActiveRoute(visibleItems);
        const isCollapsed =
          !!group.title && (collapsed[group.title] ?? false) && !hasActive;
        return (
        <div key={gi} className="space-y-1">
          {group.title && (
            <button
              type="button"
              onClick={() => toggleGroup(group.title!)}
              aria-expanded={!isCollapsed}
              className="flex w-full items-center justify-between rounded-md px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-white/40 transition-colors hover:text-white/70"
            >
              {group.title}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  isCollapsed && "-rotate-90",
                )}
              />
            </button>
          )}
          {!isCollapsed && (
            <>
              {visibleItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  title={`${item.label} — press ⌘K / Ctrl+K to jump anywhere`}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-white/15 text-white"
                        : "text-white/70 hover:bg-white/10 hover:text-white"
                    }`
                  }
                >
                  <item.icon className="h-5 w-5" />
                  {item.label}
                </NavLink>
              ))}
              {/* Pinned saved views render below the FlipDesk group */}
              {group.title === "FlipDesk" && (
                <PinnedViews onNavigate={onNavigate} />
              )}
            </>
          )}
        </div>
        );
      })}
    </nav>
  );
}

function PinnedViews({ onNavigate }: { onNavigate?: () => void }) {
  const { data: views = [] } = useSavedViews();
  const pinned = views.filter((v) => v.pinned);
  if (pinned.length === 0) return null;
  return (
    <>
      {pinned.map((v) => (
        <NavLink
          key={v.id}
          to={`/dashboard/flipdesk/inventory?view=${v.id}`}
          onClick={onNavigate}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          <span className="flex h-5 w-5 items-center justify-center text-xs">
            {v.emoji || "★"}
          </span>
          <span className="truncate">{v.name}</span>
        </NavLink>
      ))}
    </>
  );
}

export function Sidebar() {
  return (
    // US-451: the sidebar is an INTENTIONAL fixed-color region — brand navy with
    // white-on-navy nav items (text-white, bg-white/10..15) in BOTH light and
    // dark mode. The hardcoded white utilities here are deliberate and must not
    // be swapped for themeable tokens. Same for the admin layout's navy aside.
    <aside className="hidden w-64 flex-shrink-0 flex-col bg-brand-navy text-white md:flex">
      <div className="flex h-16 items-center px-6">
        <img src="/logo_white.png" alt="GradeThread" className="h-8" />
      </div>
      <div className="flex flex-1 flex-col overflow-y-auto">
        <SidebarNav />
        <div className="mt-auto pt-4">
          <SidebarUsageWidget />
        </div>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // Close the drawer when the route changes
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <div className="md:hidden">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          className="w-64 bg-brand-navy p-0 text-white [&>button]:text-white"
          showCloseButton
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-16 items-center px-6">
            <img src="/logo_white.png" alt="GradeThread" className="h-8" />
          </div>
          <div className="flex flex-1 flex-col overflow-y-auto">
            <SidebarNav onNavigate={() => setOpen(false)} />
            <div className="mt-auto pt-4">
              <SidebarUsageWidget />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
