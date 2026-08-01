// US-2161: tab identity + ?tab= resolution for the two consolidated FlipDesk
// hosts (Pricing and Sourcing). Kept in its own module — the same reason
// inventory-tabs.ts exists — so a unit test can import the mapping without
// dragging four lazily-loaded page modules into the graph.
//
// The resolvers are total: any unknown, absent or hostile ?tab= value lands on
// the first tab rather than an empty shell. A bad query string arriving from an
// old bookmark, a truncated share link or a typo should look like the page, not
// like a bug.

export const PRICING_TABS = [
  "repricing",
  "bulk",
  "suggestions",
  "automations",
] as const;
export type PricingTab = (typeof PRICING_TABS)[number];

export function resolvePricingTab(raw: string | null | undefined): PricingTab {
  return PRICING_TABS.includes(raw as PricingTab)
    ? (raw as PricingTab)
    : "repricing";
}

export const SOURCING_TABS = ["scout", "buy", "sources", "demand"] as const;
export type SourcingTab = (typeof SOURCING_TABS)[number];

export function resolveSourcingTab(
  raw: string | null | undefined,
): SourcingTab {
  return SOURCING_TABS.includes(raw as SourcingTab)
    ? (raw as SourcingTab)
    : "scout";
}

/**
 * Where each retired path now lives.
 *
 * This is the contract the router's Navigate entries implement, expressed once
 * so a test can assert every old path still resolves. A consolidation that
 * silently 404s a bookmarked URL is worse than the crowded nav it replaced.
 */
export const RETIRED_NAV_REDIRECTS: Readonly<Record<string, string>> = {
  "/dashboard/flipdesk/repricing": "/dashboard/flipdesk/pricing?tab=repricing",
  "/dashboard/flipdesk/bulk-pricing": "/dashboard/flipdesk/pricing?tab=bulk",
  "/dashboard/analytics/suggestions":
    "/dashboard/flipdesk/pricing?tab=suggestions",
  "/dashboard/flipdesk/automations":
    "/dashboard/flipdesk/pricing?tab=automations",
  "/dashboard/flipdesk/scout": "/dashboard/flipdesk/sourcing?tab=scout",
  "/dashboard/flipdesk/scout/buy": "/dashboard/flipdesk/sourcing?tab=buy",
  "/dashboard/flipdesk/sources": "/dashboard/flipdesk/sourcing?tab=sources",
  "/dashboard/flipdesk/demand": "/dashboard/flipdesk/sourcing?tab=demand",
  // Analytics keeps PATH-based tabs, because it already had them.
  "/dashboard/flipdesk/community": "/dashboard/flipdesk/analytics/community",
};
