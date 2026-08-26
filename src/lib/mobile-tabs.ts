import type { SurfaceId } from "@/lib/surfaces";

// US-2880. The five destinations the phone gets, and the three ways to add.
//
// Below the md breakpoint the web rendered the desktop sidebar inside a left
// Sheet: a hamburger, then twenty-three entries across five collapsible
// subgroups. iOS answers the same problem with five tabs and a Tools hub, and
// a large share of sellers reach the web from a phone while standing in a
// thrift store.
//
// Declared here rather than in the component so the parity guard can hold
// these against the `.tabItem` labels in ios/GradeThread/ContentView.swift.
// Two hand-written lists of "what the phone shows" is the failure US-2876
// exists to stop, and a tab bar is exactly the kind of thing that grows a
// sixth entry on one client only.

/** A bottom-bar destination. `add` is an action, not a route. */
export type MobileTab =
  | {
      kind: "route";
      /** The registry surface this tab lands on. */
      surface: SurfaceId;
      /** Exactly the iOS `.tabItem` label. */
      label: string;
      to: string;
      /** Only the two index routes match exactly. */
      end: boolean;
    }
  | { kind: "add"; label: string };

/**
 * The five, in iOS order.
 *
 * ORDER IS PART OF THE CONTRACT. A seller who uses both clients builds muscle
 * memory for position, not for the label -- putting Money where Marketplaces
 * sits costs more than a different icon would.
 */
export const MOBILE_TABS: readonly MobileTab[] = [
  {
    kind: "route",
    surface: "overview",
    label: "Home",
    to: "/dashboard",
    end: true,
  },
  {
    kind: "route",
    surface: "inventory",
    label: "Inventory",
    to: "/dashboard/flipdesk/inventory",
    end: false,
  },
  { kind: "add", label: "Add item" },
  {
    kind: "route",
    surface: "money",
    label: "Money",
    to: "/dashboard/flipdesk/money",
    end: false,
  },
  {
    kind: "route",
    surface: "marketplaces",
    label: "Marketplaces",
    to: "/dashboard/flipdesk/marketplaces",
    end: false,
  },
];

/**
 * The three ways to add an item, named as US-2860 named them.
 *
 * The web already had all three and called two of them something else --
 * "Snap & Catalog" for photos-first and "Bulk haul mode" for bulk. US-2860
 * fixed the naming on iOS and did not reach the web, so the same seller met
 * "Photos first" on the phone app and "Snap & Catalog" on the phone browser.
 * These are the canonical names; the vault note is
 * vault/20-domain/product-vocabulary.md.
 */
export const ADD_MODES: readonly { label: string; hint: string; to: string }[] = [
  {
    label: "Photos first",
    hint: "Shoot it now, fill in the details after.",
    to: "/dashboard/flipdesk/intake?mode=snap",
  },
  {
    label: "Details first",
    hint: "Type what you know, add photos later.",
    to: "/dashboard/flipdesk/intake",
  },
  {
    label: "Bulk with AI",
    hint: "A pile of photos becomes a pile of drafts.",
    to: "/dashboard/flipdesk/autolister",
  },
];

/** Routes the tab bar links to, for the guard and for the More sheet. */
export function tabRoutes(): readonly string[] {
  return MOBILE_TABS.filter((t) => t.kind === "route").map((t) => t.to);
}
