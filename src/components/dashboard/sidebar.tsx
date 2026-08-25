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
import { FLIPDESK_PLANS, type FlipdeskGateFlags, type FlipdeskPlanKey } from "@/lib/constants";
import type { WorkspaceCapability } from "@/lib/workspace-permissions";

type NavItem = {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  // US-2861. Required, not optional. Twenty-three labels and nothing saying
  // what any of them was for: a seller who has never used the product cannot
  // tell Sourcing from Scout, Money from Pricing, or Verified from anything.
  // One sentence, plain words, saying what the destination is FOR. Ported from
  // ios/GradeThread/Tools/ToolsHubView.swift where a matching module exists —
  // the iOS Tools hub has carried these sentences since US-749 and the web nav
  // did not use them. Enforced by src/test/nav-descriptions.test.ts.
  description: string;
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
    description: "Send garments for a condition grade and read the reports.",
    items: [
      {
        to: "/dashboard",
        icon: LayoutDashboard,
        label: "Overview",
        description: "Your grades, your plan usage, and what needs you today.",
        end: true,
      },
      {
        to: "/dashboard/snap",
        icon: Camera,
        label: "Snap to Value",
        description: "Photograph a garment and get a free condition and price read.",
        end: false,
      },
      {
        to: "/dashboard/submissions",
        icon: FileText,
        label: "Submissions",
        description: "Every garment you have sent for grading, and its report.",
        end: false,
      },
      // US-1851: level + quarterly season track. Sits with Grading because XP
      // comes from grading acts, not from listing volume.
      {
        to: "/dashboard/rewards",
        icon: Trophy,
        label: "Rewards",
        description: "Your level, your season track, and the credit you have earned.",
        end: false,
      },
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
    description: "Everything from sourcing an item to reconciling the payout.",
    subgroups: [
      {
        title: "Catalog",
        description: "What you own, and where to find it.",
        items: [
          {
            to: "/dashboard/flipdesk",
            icon: Gauge,
            label: "Overview",
            description: "The day's numbers for buying, listing and selling.",
            end: true,
          },
          {
            to: "/dashboard/flipdesk/search",
            icon: Search,
            label: "Search",
            description: "Find any item, listing or sale by anything you remember about it.",
            end: false,
          },
          // Inventory is one surface now. Its in-page tabs switch between
          // Table / Grid / Kanban / Prep views — see InventoryViewSwitcher.
          {
            to: "/dashboard/flipdesk/inventory",
            icon: Boxes,
            label: "Inventory",
            description: "Everything you own, as a table, a grid, a board or a prep list.",
            end: false,
          },
        ],
      },
      {
        title: "List & sell",
        description: "Turn items into listings and get them live.",
        items: [
          // US-2161 (second pass): AutoLister hosts Generate + Drafts as ?view=
          // tabs. Drafts was never a separate destination — it is what AutoLister
          // produces — and a seller who has just generated drafts should not have
          // to find a second nav entry to see them.
          {
            to: "/dashboard/flipdesk/autolister",
            icon: Sparkles,
            label: "AutoLister",
            description: "Turn a pile of photos into drafted listings in one batch.",
            end: false,
            requiresFlipdeskFlag: "autolister",
          },
          {
            to: "/dashboard/flipdesk/scheduled-drops",
            icon: CalendarClock,
            label: "Scheduled drops",
            description: "Queue listings to publish when buyers are looking.",
            end: false,
          },
          {
            to: "/dashboard/flipdesk/verified",
            icon: ShieldCheck,
            label: "Verified",
            description: "Claim your public seller handle and trust badge.",
            end: false,
          },
        ],
      },
      {
        title: "Sourcing",
        description: "What to buy, and where it comes from.",
        items: [
          {
            to: "/dashboard/flipdesk/import",
            icon: Upload,
            label: "Import",
            description: "Bring inventory in from a CSV file or a Google Sheet.",
            end: false,
          },
          // US-2161: ScoutAI + Buy Decision + Sources + Buyer Demand were four
          // entries answering one question — what should I buy, and where from.
          // They are ?tab= tabs of this one destination now. NOT plan-gated at
          // the nav level any more: two of the four tabs need compPulls and two
          // do not, so gating the whole entry would hide Sources from a seller
          // who is entitled to it.
          {
            to: "/dashboard/flipdesk/sourcing",
            icon: Radar,
            label: "Sourcing",
            description: "What to buy and where from: Scout, buy calls, sources, demand.",
            end: false,
          },
          {
            to: "/dashboard/flipdesk/consignment",
            icon: Handshake,
            label: "Consignment",
            description: "Your consignors, their items, and their payout splits.",
            end: false,
          },
        ],
      },
      {
        title: "Channels & money",
        description: "Where you sell, and what you make.",
        items: [
          {
            to: "/dashboard/flipdesk/marketplaces",
            icon: Plug,
            label: "Marketplaces",
            description: "Connect eBay and the other channels you sell on.",
            end: false,
          },
          {
            to: "/dashboard/flipdesk/offers",
            icon: Tag,
            label: "Offers & Messages",
            description: "Buyer offers and messages, with replies drafted for you.",
            end: false,
          },
          {
            to: "/dashboard/flipdesk/post-sale",
            icon: ShieldAlert,
            label: "Returns & Disputes",
            description: "Returns, cases and disputes after a sale.",
            end: false,
          },
          // US-2161: Repricing + Bulk pricing + Price Suggestions + Automations.
          {
            to: "/dashboard/flipdesk/pricing",
            icon: Tags,
            label: "Pricing",
            description: "Reprice live listings, edit prices in bulk, and run pricing rules.",
            end: false,
          },
          // US-2161 (second pass): Finances + Expenses + Reconcile answered one
          // question — where did my money go — from three nav entries. One
          // destination now, ?view= carrying the choice. Reconcile keeps its own
          // four inner ?tab= tabs (US-963: Photos→Items, eBay SKU match, Payouts &
          // fees, Cross-source), which is exactly why the outer parameter is
          // ?view= and not ?tab=.
          {
            to: "/dashboard/flipdesk/money",
            icon: DollarSign,
            label: "Money",
            description: "What sold, what it cost, what you are owed, and your real profit.",
            end: false,
          },
          // US-1579: MeasureCard info + PDF download + mailed-card request.
          {
            to: "/dashboard/flipdesk/measure-card",
            icon: Ruler,
            label: "MeasureCard",
            description: "The printed card that puts a scale in every measurement photo.",
            end: false,
          },
        ],
      },
      {
        title: "Automate & insights",
        description: "Rules that run for you, and how it is all going.",
        items: [
          // US-2161: Automations is a Pricing tab; Listing Performance and
          // Community Insights are Analytics tabs. `end: false` so the nav item
          // stays highlighted on every /analytics/* tab, not just the index.
          {
            to: "/dashboard/flipdesk/analytics",
            icon: BarChart3,
            label: "Analytics",
            description: "How your listings, grades and returns are doing over time.",
            end: false,
          },
        ],
      },
    ],
  },
  {
    // Account, billing, team, API keys, and referrals are consolidated into
    // one hub (US-741) reached from this single entry; its tabs gate billing/
    // API by capability. Direct routes still work for deep links + ⌘K.
    items: [
      {
        to: "/dashboard/account",
        icon: CircleUser,
        label: "Account",
        // Worded so `plan` is never a bare comma-delimited token: the
        // frozen-column guard (src/test/legacy-user-plan-readers.test.ts)
        // treats "a, plan, b" as a select list and flags the file.
        description: "Your profile, plan and billing, your team and your referrals.",
        end: false,
      },
      // US-2554: findable. It was a tab inside Account, so the only way to
      // reach the API was to go looking for it under your profile.
      {
        to: "/dashboard/developers",
        icon: Code2,
        label: "Developers",
        description: "API keys and the sandbox for grading from your own app.",
        end: false,
        requires: "manage_api_keys",
      },
      // US-2583: the in-app help reader. A nav entry rather than only the
      // header's help menu, because the thing people look for when stuck is a
      // place in the sidebar, not an icon they have to remember.
      {
        to: "/dashboard/help",
        icon: LifeBuoy,
        label: "Help",
        description: "Guides and answers, without leaving the app.",
        end: false,
      },
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

  function groupHasActiveRoute(items: NavItem[]): boolean {
    return items.some((item) =>
      item.end ? pathname === item.to : pathname.startsWith(item.to),
    );
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

    const link = (
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
          } ${variant === "mobile" ? "items-start" : ""}`
        }
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
