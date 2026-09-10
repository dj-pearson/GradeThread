// US-3195 AC5: the listings table's empty states, out of the JSX.
//
// This was a four-deep nested ternary inside the <EmptyState> element, repeated
// once for the icon, once for the title and once for the description — three
// chains that had to be kept in the same order by hand. The Aged tab was added
// to the tab list and to none of them, so it fell to the final `else` and told
// a seller with two hundred healthy listings "No items yet" under a Rocket.
//
// A function per screen, not per chain: the three answers for one tab now sit
// on one line together, and a tab added later that forgets to add a branch is
// caught by a test rather than by a seller.

import {
  Clock,
  FileText,
  Rocket,
  RotateCcw,
  Sparkles,
  Star,
  TrendingDown,
  Truck,
  type LucideIcon,
} from "lucide-react";

import {
  DEFAULT_AGED_THRESHOLD_DAYS,
} from "@/lib/aged-inventory";
import {
  UNLISTED_FILTER_LABELS,
  type TabId,
  type UnlistedFilter,
} from "@/pages/flipdesk/inventory-tabs";

export interface ListingsEmptyState {
  icon: LucideIcon;
  title: string;
  description: string;
}

export function listingsEmptyState({
  tab,
  unlistedFilter,
  agedThresholdDays = DEFAULT_AGED_THRESHOLD_DAYS,
}: {
  tab: TabId;
  unlistedFilter: UnlistedFilter;
  /** The seller's own "too long". Named in the copy, so it must be theirs. */
  agedThresholdDays?: number;
}): ListingsEmptyState {
  switch (tab) {
    case "unlisted":
      return unlistedFilter === "all"
        ? {
            icon: Sparkles,
            title: "Nothing waiting to list",
            description:
              "Items you add will wait here until they are published. Add an item to get started.",
          }
        : {
            icon: FileText,
            title: `Nothing under ${UNLISTED_FILTER_LABELS[unlistedFilter]}`,
            description: "Pick All above to see every unlisted item.",
          };
    case "active":
      return {
        icon: Star,
        title: "No active listings",
        description:
          "Listings live on a marketplace will show here once you publish.",
      };
    // The one empty list on this page that is GOOD NEWS. It says what is true —
    // nothing has crossed the line the seller drew — and it names the line,
    // because the next question after "nothing?" is "nothing past what?".
    case "aged":
      return {
        icon: Clock,
        title: "Nothing has gone stale",
        description: `No live listing has sat longer than ${Math.floor(
          agedThresholdDays,
        )} days. Change the threshold above to look further back.`,
      };
    case "sold":
      return {
        icon: TrendingDown,
        title: "No sold items match this filter",
        description: "Sold items will appear here as orders come in.",
      };
    case "shipped":
      return {
        icon: Truck,
        title: "Nothing shipped yet",
        description: "Items you've marked shipped will be tracked here.",
      };
    case "returned":
      return {
        icon: RotateCcw,
        title: "No returns",
        description: "Returned orders will be tracked here.",
      };
    case "archived":
      return {
        icon: FileText,
        title: "Nothing archived",
        description: "Items you archive are kept here, out of the pipeline.",
      };
    // 'all' — and only 'all' — is the genuinely empty account.
    case "all":
      return {
        icon: Rocket,
        title: "No items yet",
        description: "Add an item to start building your listing pipeline.",
      };
  }
}
