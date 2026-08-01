import { NavLink, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  FileText,
  DollarSign,
  Menu,
  Plug,
  Ruler,
  Scale,
  Upload,
  Gauge,
  Wallet,
  BarChart3,
  Boxes,
  Sparkles,
  ShieldCheck,
  ClipboardList,
  Radar,
  Camera,
  ChevronDown,
  CircleUser,
  CalendarClock,
  Handshake,
  Tag,
  Tags,
  ShieldAlert,
  Search,
  ShoppingBag,
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
import { UploadProgressPill } from "@/components/flipdesk/upload-progress-pill";
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
  // Inverse gate: hide this item once the plan HAS the flag. Used to tier two
  // overlapping tools so a user never sees both — e.g. Reconcile (the ungated
  // bulk-photo→item tool) is hidden once AutoLister becomes available.
  hiddenWhenFlipdeskFlag?: keyof FlipdeskGateFlags;
};
// A subgroup is a labeled, independently-collapsible cluster of nav items
// rendered *inside* a parent group. Used to break the long FlipDesk list into
// manageable sections (US-609) so the section doesn't feel overwhelming.
type NavSubgroup = { title: string; items: NavItem[] };
type NavGroup = {
  title?: string;
  // A group renders either a flat list of `items` OR a set of `subgroups`.
  items?: NavItem[];
  subgroups?: NavSubgroup[];
  adminOnly?: boolean;
};

// US-1121 — Nav contract / route-discoverability audit.
//
// Every authenticated route is reachable. Routes NOT in this sidebar are
// intentionally contextual or deep-link-only — do NOT add them here:
//   • /dashboard/submissions/bulk — reached from the Submissions page's "Bulk
//     submit" button (submissions.tsx).
//   • /dashboard/flipdesk/autolister/queue + /autolister/bulk-edit — batch-
//     scoped (?batch=…); reached from the AutoLister / Drafts flow. A global
//     nav link is meaningless without a batch id, so they stay contextual.
//   • /dashboard/flipdesk/marketplaces/google — a sub-channel reached from the
//     Marketplaces page (marketplaces.tsx).
//   • /dashboard/flipdesk/intake — reached from the many "Add item" entry
//     points; not a standalone nav destination.
//   • Account / Billing / Team / API keys / Referrals / Settings / Support —
//     consolidated into the Account hub (US-741); the hub is the single nav
//     entry, individual routes remain for deep links + ⌘K.
//   • /dashboard/flipdesk/{overview,grid,prep,pipeline,listings,reconciliation}
//     and /dashboard/inventory* — legacy aliases that redirect (Navigate /
//     InventoryModeRedirect) to their canonical surfaces; kept for old links.
//   • US-2161 consolidated three clusters into tabbed hosts. The old paths all
//     still resolve — they Navigate to the canonical route plus its tab — so
//     deep links, the command palette and flipdesk-search keep working, and
//     they are deliberately NOT listed here because the host is the one nav
//     entry:
//       /flipdesk/{repricing,bulk-pricing,automations} and
//       /dashboard/analytics/suggestions   → /flipdesk/pricing?tab=…
//       /flipdesk/{scout,scout/buy,sources,demand}
//                                          → /flipdesk/sourcing?tab=…
//       /flipdesk/community                → /flipdesk/analytics/community
//     Analytics keeps PATH-based tabs (not ?tab=) because it already had them.
const navGroups: NavGroup[] = [
  {
    title: "Grading",
    items: [
      { to: "/dashboard", icon: LayoutDashboard, label: "Overview", end: true },
      { to: "/dashboard/snap", icon: Camera, label: "Snap to Value", end: false },
      { to: "/dashboard/submissions", icon: FileText, label: "Submissions", end: false },
      // Inventory consolidated into the FlipDesk section (US-740) — no duplicate
      // here; the single canonical inventory lives under FlipDesk.
      // Finances moved to the FlipDesk group — it reports purely on reseller
      // data (inventory/listings/sales) alongside Expenses/Reconciliation.
      // US-2161: Price Suggestions moved to FlipDesk → Pricing. It sat here
      // while the other three pricing surfaces sat under FlipDesk, so "change
      // my prices" was split across two sections of the nav.
    ],
  },
  {
    // The FlipDesk section is split into labeled, independently-collapsible
    // subgroups (US-609) so its ~20 destinations stay manageable. Overview +
    // Inventory sit at the top as the two everyday entry points.
    title: "FlipDesk",
    subgroups: [
      {
        title: "Catalog",
        items: [
          { to: "/dashboard/flipdesk", icon: Gauge, label: "Overview", end: true },
          { to: "/dashboard/flipdesk/search", icon: Search, label: "Search", end: false },
          // Inventory is one surface now. Its in-page tabs switch between
          // Table / Grid / Kanban / Prep views — see InventoryViewSwitcher.
          { to: "/dashboard/flipdesk/inventory", icon: Boxes, label: "Inventory", end: false },
        ],
      },
      {
        title: "List & sell",
        items: [
          { to: "/dashboard/flipdesk/autolister", icon: Sparkles, label: "AutoLister", end: false, requiresFlipdeskFlag: "autolister" },
          { to: "/dashboard/flipdesk/autolister/drafts", icon: ClipboardList, label: "Drafts", end: false, requiresFlipdeskFlag: "autolister" },
          { to: "/dashboard/flipdesk/scheduled-drops", icon: CalendarClock, label: "Scheduled drops", end: false },
          { to: "/dashboard/flipdesk/verified", icon: ShieldCheck, label: "Verified", end: false },
        ],
      },
      {
        title: "Sourcing",
        items: [
          { to: "/dashboard/flipdesk/import", icon: Upload, label: "Import", end: false },
          // US-2161: ScoutAI + Buy Decision + Sources + Buyer Demand were four
          // entries answering one question — what should I buy, and where from.
          // They are ?tab= tabs of this one destination now. NOT plan-gated at
          // the nav level any more: two of the four tabs need compPulls and two
          // do not, so gating the whole entry would hide Sources from a seller
          // who is entitled to it.
          { to: "/dashboard/flipdesk/sourcing", icon: Radar, label: "Sourcing", end: false },
          { to: "/dashboard/flipdesk/consignment", icon: Handshake, label: "Consignment", end: false },
        ],
      },
      {
        title: "Channels & money",
        items: [
          { to: "/dashboard/flipdesk/marketplaces", icon: Plug, label: "Marketplaces", end: false },
          { to: "/dashboard/flipdesk/offers", icon: Tag, label: "Offers & Messages", end: false },
          { to: "/dashboard/flipdesk/post-sale", icon: ShieldAlert, label: "Returns & Disputes", end: false },
          // US-2161: Repricing + Bulk pricing + Price Suggestions + Automations.
          { to: "/dashboard/flipdesk/pricing", icon: Tags, label: "Pricing", end: false },
          { to: "/dashboard/finances", icon: DollarSign, label: "Finances", end: false },
          { to: "/dashboard/flipdesk/expenses", icon: Wallet, label: "Expenses", end: false },
          // US-963: one Reconcile entry hosts Photos→Items, eBay SKU match,
          // Payouts & fees, and Cross-source as tabs. Always visible — it now
          // carries the reconciliation/payout flows, not just the photo tool.
          { to: "/dashboard/flipdesk/reconcile", icon: Scale, label: "Reconcile", end: false },
          // US-1579: MeasureCard info + PDF download + mailed-card request.
          { to: "/dashboard/flipdesk/measure-card", icon: Ruler, label: "MeasureCard", end: false },
        ],
      },
      {
        title: "Automate & insights",
        items: [
          // US-2161: Automations is a Pricing tab; Listing Performance and
          // Community Insights are Analytics tabs. `end: false` so the nav item
          // stays highlighted on every /analytics/* tab, not just the index.
          { to: "/dashboard/flipdesk/analytics", icon: BarChart3, label: "Analytics", end: false },
        ],
      },
    ],
  },
  {
    // Account, billing, team, API keys, and referrals are consolidated into
    // one hub (US-741) reached from this single entry; its tabs gate billing/
    // API by capability. Direct routes still work for deep links + ⌘K.
    items: [
      { to: "/dashboard/account", icon: CircleUser, label: "Account", end: false },
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

  function isItemVisible(item: NavItem): boolean {
    if (item.requires && !can(item.requires)) return false;
    if (item.requiresFlipdeskFlag && !flipdeskFlags[item.requiresFlipdeskFlag]) {
      return false;
    }
    if (item.hiddenWhenFlipdeskFlag && flipdeskFlags[item.hiddenWhenFlipdeskFlag]) {
      return false;
    }
    return true;
  }

  function groupHasActiveRoute(items: NavItem[]): boolean {
    return items.some((item) =>
      item.end ? pathname === item.to : pathname.startsWith(item.to),
    );
  }

  function renderNavLink(item: NavItem) {
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        onClick={onNavigate}
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
    );
  }

  return (
    <nav className="mt-2 flex-1 space-y-4 px-3">
      {navGroups
        .filter((g) => !g.adminOnly || isAdmin)
        .map((group, gi) => {
        const directItems = (group.items ?? []).filter(isItemVisible);
        // Subgroups, each filtered for visibility; drop any that end up empty.
        const subgroups = (group.subgroups ?? [])
          .map((sg) => ({ ...sg, items: sg.items.filter(isItemVisible) }))
          .filter((sg) => sg.items.length > 0);
        const allItems = [
          ...directItems,
          ...subgroups.flatMap((sg) => sg.items),
        ];
        if (allItems.length === 0) return null;
        // A collapsed section is force-opened while it contains the active
        // route, so the current page's nav item is never hidden.
        const hasActive = groupHasActiveRoute(allItems);
        const isCollapsed =
          !!group.title && (collapsed[group.title] ?? false) && !hasActive;
        return (
        <div key={gi} className="space-y-1">
          {group.title && (
            <button
              type="button"
              onClick={() => toggleGroup(group.title!)}
              aria-expanded={!isCollapsed}
              className="flex w-full items-center justify-between rounded-md px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-white/70 transition-colors hover:text-white/90"
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
              {directItems.map(renderNavLink)}
              {subgroups.map((sg) => {
                // Subgroup collapse state is namespaced under its parent so two
                // subgroups with the same label in different sections never clash.
                const key = group.title ? `${group.title}:${sg.title}` : sg.title;
                const sgHasActive = groupHasActiveRoute(sg.items);
                const sgCollapsed = (collapsed[key] ?? false) && !sgHasActive;
                return (
                  <div key={sg.title} className="space-y-1">
                    <button
                      type="button"
                      onClick={() => toggleGroup(key)}
                      aria-expanded={!sgCollapsed}
                      className="flex w-full items-center justify-between rounded-md py-1.5 pl-3 pr-2 text-[0.7rem] font-medium uppercase tracking-wide text-white/70 transition-colors hover:text-white/90"
                    >
                      {sg.title}
                      <ChevronDown
                        className={cn(
                          "h-3 w-3 transition-transform",
                          sgCollapsed && "-rotate-90",
                        )}
                      />
                    </button>
                    {!sgCollapsed && sg.items.map(renderNavLink)}
                  </div>
                );
              })}
              {/* Pinned saved views render below the FlipDesk group */}
              {group.title === "FlipDesk" && (
                <PinnedViews onNavigate={onNavigate} />
              )}
            </>
          )}
        </div>
        );
      })}
      {/* US-1802/1888: Etsy-style context switch to the buyer app. Shown to any
          account that can shop — every seller can (their plan bundles buyer
          functions, US-1887) plus explicit buyer-role accounts. */}
      {(profile?.is_buyer || profile?.is_seller) && (
        <NavLink
          to="/buyer"
          onClick={onNavigate}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          <ShoppingBag className="h-4 w-4" />
          <span>Switch to buying</span>
        </NavLink>
      )}
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
          {/* US-1542: live AutoLister upload progress — uploads keep running
              app-wide, so the affordance lives here where every page sees it. */}
          <UploadProgressPill />
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
              <UploadProgressPill />
              <SidebarUsageWidget />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
