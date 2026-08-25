import { NavLink, useLocation } from "react-router";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  FileText,
  DollarSign,
  Menu,
  Plug,
  Ruler,
  Upload,
  Gauge,
  BarChart3,
  Boxes,
  Sparkles,
  ShieldCheck,
  Radar,
  Camera,
  ChevronDown,
  CircleUser,
  LifeBuoy,
  Code2,
  CalendarClock,
  Handshake,
  Tag,
  Tags,
  ShieldAlert,
  Search,
  ShoppingBag,
  Trophy,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { explainGate } from "@/lib/plan-gates";
import { useUpgradeDialogStore } from "@/stores/upgrade-dialog-store";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSavedViews } from "@/hooks/use-saved-views";
import { SidebarUsageWidget } from "@/components/dashboard/sidebar-usage-widget";
import { UploadProgressPill } from "@/components/flipdesk/upload-progress-pill";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useBillingSummary } from "@/hooks/use-billing-summary";
import { FLIPDESK_PLANS, type FlipdeskPlanKey } from "@/lib/constants";
import {
  ALL_SURFACES,
  NAV_GROUPS,
  type NavPlacement,
  type Surface,
  type SurfaceId,
} from "@/lib/surfaces";

// US-2876: the nav is BUILT from src/lib/surfaces.ts, not written here.
//
// This block used to be ~250 lines of object literals -- twenty-three
// destinations with their labels, their sentences and their gates -- and it was
// one of two hand-written answers to "what does this product contain". The
// other was ToolsHubView.swift, and the two disagreed. Adding a feature meant
// remembering both, so a feature usually landed on one.
//
// What stays here is what is genuinely a WEB RENDERING decision: which lucide
// icon a row uses, how a group collapses, how a locked row behaves. What moved
// out is the product information: the list, the words, and the gates.
//
// The exemption list that used to live in a prose comment above this block --
// the routes that are contextual or deep-link-only -- is now CONTEXTUAL_ROUTES
// in the registry, with a reason on each. Prose cannot fail;
// src/test/surface-registry.test.ts can, and does.

type NavItem = Omit<Surface, "web" | "nav"> & {
  /** The registry's `web` link. Named `to` because that is what NavLink takes. */
  to: string;
  icon: typeof LayoutDashboard;
  end: boolean;
};

// A subgroup is a labeled, independently-collapsible cluster of nav items
// rendered *inside* a parent group. Used to break the long FlipDesk list into
// manageable sections (US-609) so the section doesn't feel overwhelming.
type NavSubgroup = { title: string; description: string; items: NavItem[] };
type NavGroup = {
  title?: string;
  // Required whenever `title` is set — a titled section is a thing the user has
  // to understand too (US-2861). The one untitled group carries no description
  // because it renders no header to hang one on.
  description?: string;
  // A group renders either a flat list of `items` OR a set of `subgroups`.
  items?: NavItem[];
  subgroups?: NavSubgroup[];
  adminOnly?: boolean;
};

// One icon per surface. Typed as a total Record so tsc — not a reviewer —
// notices a surface added to the registry with no icon here.
const SURFACE_ICONS: Record<SurfaceId, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  snap: Camera,
  submissions: FileText,
  rewards: Trophy,
  "flipdesk-overview": Gauge,
  "flipdesk-search": Search,
  inventory: Boxes,
  autolister: Sparkles,
  "scheduled-drops": CalendarClock,
  verified: ShieldCheck,
  "listing-templates": FileText,
  import: Upload,
  sourcing: Radar,
  scout: Radar,
  sources: ShoppingBag,
  prospect: Camera,
  consignment: Handshake,
  marketplaces: Plug,
  offers: Tag,
  "post-sale": ShieldAlert,
  pricing: Tags,
  repricing: Tags,
  automations: Sparkles,
  money: DollarSign,
  reconciliation: DollarSign,
  "reconcile-intake": Boxes,
  "measure-card": Ruler,
  analytics: BarChart3,
  "community-insights": BarChart3,
  account: CircleUser,
  developers: Code2,
  referrals: Handshake,
  help: LifeBuoy,
};

/** Registry surfaces placed in one group/subgroup, in declaration order. */
function itemsFor(group: NavPlacement["group"], subgroup?: string): NavItem[] {
  return ALL_SURFACES.filter(
    (s): s is Surface & { nav: NavPlacement } =>
      s.nav !== null && s.nav.group === group && s.nav.subgroup === subgroup,
  ).map(({ nav, web, ...rest }) => ({
    ...rest,
    // Every nav-placed surface has a route; the registry has no way to place
    // one without a destination.
    to: web ?? "/dashboard",
    icon: SURFACE_ICONS[rest.id as SurfaceId],
    end: nav.end ?? false,
  }));
}

const navGroups: NavGroup[] = NAV_GROUPS.map((g) =>
  g.subgroups
    ? {
        title: g.title,
        description: g.description,
        subgroups: g.subgroups.map((sub) => ({
          title: sub.title,
          description: sub.description,
          items: itemsFor(g.group, sub.title),
        })),
      }
    : { title: g.title, description: g.description, items: itemsFor(g.group) },
);

const COLLAPSE_KEY = "gt-sidebar-collapsed";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}");
  } catch {
    return {};
  }
}

function SidebarNav({
  onNavigate,
  variant = "desktop",
}: {
  onNavigate?: () => void;
  // US-2861: decides how each entry's description is shown. There is no hover
  // on a phone, so the mobile sheet renders it inline instead of in a tooltip.
  variant?: "desktop" | "mobile";
}) {
  const profile = useAuthStore((s) => s.profile);
  const isAdmin =
    profile?.role === "admin" || profile?.role === "super_admin";
  const { can } = useWorkspace();
  // FlipDesk plan governs feature-flag sidebar entries (US-323).
  const { data: billing } = useBillingSummary();
  const showUpgrade = useUpgradeDialogStore((st) => st.show);
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

  /**
   * US-2872: THREE GATES, and only one of them may hide an item.
   *
   * `requires` is a CAPABILITY gate: a workspace member without permission is
   * not a sales prospect, they are someone the owner deliberately did not give
   * this to. Showing them a locked row would invite them to ask for an upgrade
   * that is not theirs to buy. Still hides.
   *
   * `hiddenWhenFlipdeskFlag` is a TIERING gate, the inverse: it hides Reconcile
   * once AutoLister supersedes it. Rendering "Reconcile (locked)" to somebody
   * who just paid for the better tool is nonsense. Still hides.
   *
   * `requiresFlipdeskFlag` is a PLAN gate, and that one becomes visible-but-
   * locked. A hidden feature cannot be wanted, and the moment of maximum
   * intent is when the seller is standing in the surface that would have used
   * it -- not when they go looking for a pricing table.
   */
  function isItemVisible(item: NavItem): boolean {
    if (item.requires && !can(item.requires)) return false;
    if (item.hiddenWhenFlipdeskFlag && flipdeskFlags[item.hiddenWhenFlipdeskFlag]) {
      return false;
    }
    return true;
  }

  /** True when the item is shown but the plan does not include it. */
  function isItemLocked(item: NavItem): boolean {
    return Boolean(
      item.requiresFlipdeskFlag && !flipdeskFlags[item.requiresFlipdeskFlag],
    );
  }

  function isRouteActive(item: Pick<NavItem, "to" | "end">): boolean {
    return item.end ? pathname === item.to : pathname.startsWith(item.to);
  }

  function groupHasActiveRoute(items: NavItem[]): boolean {
    return items.some(isRouteActive);
  }

  // US-2861: a titled section is a thing the user has to understand too, so
  // the header gets the same treatment as an item — tooltip on desktop, an
  // inline line on mobile.
  function renderSectionHeader(args: {
    title: string;
    description?: string;
    expanded: boolean;
    onToggle: () => void;
    className: string;
    chevronClassName: string;
  }) {
    const button = (
      <button
        type="button"
        onClick={args.onToggle}
        aria-expanded={args.expanded}
        className={args.className}
      >
        <span className="flex flex-col items-start gap-0.5 text-left">
          <span>{args.title}</span>
          {variant === "mobile" && args.description && (
            <span className="text-[0.65rem] font-normal normal-case tracking-normal text-white/55">
              {args.description}
            </span>
          )}
        </span>
        <ChevronDown className={args.chevronClassName} />
      </button>
    );
    if (variant === "mobile" || !args.description) return button;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-64">
          {args.description}
        </TooltipContent>
      </Tooltip>
    );
  }

  function renderNavLink(item: NavItem) {
    // US-2861: on a phone there is no hover, so the sentence renders inline.
    // On a desktop twenty-three two-line rows would be a wall, so it renders in
    // a tooltip that opens on hover AND on keyboard focus.
    const locked = isItemLocked(item);
    const gate = locked && item.requiresFlipdeskFlag
      ? explainGate(item.requiresFlipdeskFlag)
      : null;

    // US-2872: a locked row is a BUTTON, not a disabled link. A disabled link
    // is unfocusable and announces nothing, so the one user who most needs the
    // explanation -- somebody navigating by keyboard or screen reader -- is
    // the one who cannot reach it.
    const lockedRow = gate ? (
      <button
        key={item.to}
        type="button"
        onClick={() => {
          showUpgrade({
            reason: { type: "feature", feature: item.label },
            currentPlan: (billing?.subscription.plan as FlipdeskPlanKey) ?? "free",
            requiredPlan: gate.requiredPlan,
          });
          onNavigate?.();
        }}
        aria-label={`${item.label}. Included with the ${gate.requiredPlanLabel} plan. Open upgrade options.`}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-white/45 transition-colors hover:bg-white/10 hover:text-white/70",
          variant === "mobile" && "items-start",
        )}
      >
        <item.icon
          className={cn("h-5 w-5 flex-shrink-0", variant === "mobile" && "mt-0.5")}
        />
        {variant === "mobile" ? (
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              {item.label}
              <Lock className="h-3 w-3" aria-hidden="true" />
            </span>
            <span className="text-xs font-normal leading-snug text-white/40">
              {gate.what}
            </span>
          </span>
        ) : (
          <>
            <span className="flex-1">{item.label}</span>
            <Lock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          </>
        )}
      </button>
    ) : null;

    if (lockedRow) {
      if (variant === "mobile") return lockedRow;
      return (
        <Tooltip key={item.to}>
          <TooltipTrigger asChild>{lockedRow}</TooltipTrigger>
          <TooltipContent side="right" className="max-w-64">
            {gate!.what} Included with the {gate!.requiredPlanLabel} plan.
          </TooltipContent>
        </Tooltip>
      );
    }

    // The className is a STRING, never NavLink's `({ isActive }) => ...`
    // render prop. On desktop this link is the child of `<TooltipTrigger
    // asChild>`, and Radix's Slot merges className by string-joining the
    // parent's onto the child's -- so a function child lands in the DOM as its
    // own SOURCE TEXT. The row then kept every class that happened to sit after
    // a space (`items-center`, `gap-3`, `text-sm`) and lost `flex`, which was
    // glued to the opening backtick, so every entry rendered its icon on one
    // line and its label on the next. Active state is computed here instead.
    const active = isRouteActive(item);
    const link = (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        onClick={onNavigate}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
          active
            ? "bg-white/15 text-white"
            : "text-white/70 hover:bg-white/10 hover:text-white",
          variant === "mobile" && "items-start",
        )}
      >
        <item.icon
          className={cn("h-5 w-5 flex-shrink-0", variant === "mobile" && "mt-0.5")}
        />
        {variant === "mobile" ? (
          <span className="flex flex-col gap-0.5">
            <span>{item.label}</span>
            {/* Tinted from the navy surface rather than a flat gray, so it
                stays legible on the fixed brand background (US-451). */}
            <span className="text-xs font-normal leading-snug text-white/55">
              {item.description}
            </span>
          </span>
        ) : (
          item.label
        )}
      </NavLink>
    );

    if (variant === "mobile") return link;

    return (
      <Tooltip key={item.to}>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-64">
          {item.description}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    // US-2861: delayDuration 300 so a mouse crossing the nav on its way
    // somewhere else does not flash a tooltip at every entry it passes.
    <TooltipProvider delayDuration={300}>
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
          {group.title &&
            renderSectionHeader({
              title: group.title,
              description: group.description,
              expanded: !isCollapsed,
              onToggle: () => toggleGroup(group.title!),
              className:
                "flex w-full items-center justify-between rounded-md px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-white/70 transition-colors hover:text-white/90",
              chevronClassName: cn(
                "h-3.5 w-3.5 flex-shrink-0 transition-transform",
                isCollapsed && "-rotate-90",
              ),
            })}
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
                    {renderSectionHeader({
                      title: sg.title,
                      description: sg.description,
                      expanded: !sgCollapsed,
                      onToggle: () => toggleGroup(key),
                      className:
                        "flex w-full items-center justify-between rounded-md py-1.5 pl-3 pr-2 text-[0.7rem] font-medium uppercase tracking-wide text-white/70 transition-colors hover:text-white/90",
                      chevronClassName: cn(
                        "h-3 w-3 flex-shrink-0 transition-transform",
                        sgCollapsed && "-rotate-90",
                      ),
                    })}
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
    </TooltipProvider>
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
        <img src="/logo_white.png" width={1806} height={376} alt="GradeThread" className="h-8" />
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
        aria-label="More"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          className="w-64 bg-brand-navy p-0 text-white [&>button]:text-white"
          showCloseButton
        >
          {/* US-2880: "More", not "Navigation". The five everyday
              destinations are on the bottom tab bar now; this sheet holds
              everything else, grouped exactly as it was. */}
          <SheetTitle className="sr-only">More</SheetTitle>
          <div className="flex h-16 items-center px-6">
            <img src="/logo_white.png" width={1806} height={376} alt="GradeThread" className="h-8" />
          </div>
          <div className="flex flex-1 flex-col overflow-y-auto">
            <SidebarNav onNavigate={() => setOpen(false)} variant="mobile" />
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
