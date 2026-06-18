// Zero-result fallback ladder for comps (US-1060).
//
// A narrow comp search (full title + brand + size, one category) frequently
// returns nothing, leaving the pricing panel blank. This module broadens the
// search PROGRESSIVELY until it clears a configurable minimum-results bar:
//   exact          → full query + brand + size
//   broadened      → drop the size, then drop trailing title tokens one by one
//                    (keeping brand + category so it stays on-topic)
//   brand_category → brand + category only (no free-text, no size)
//   category       → category alone (broadest meaningful rung)
// The first rung that returns >= minResults wins; if none do, the rung that
// returned the MOST items wins, so we always surface SOMETHING — tagged with how
// broad it actually is (`breadth`) so the UI can warn the comps were broadened.
//
// Sold (realized) comps from eBay Marketplace Insights (US-542 / US-1048) are
// merged in and tagged source:"sold" when the grant is enabled; when disabled
// the sold fetcher returns null and this is a graceful no-op (active comps only).
//
// The stage-building + rung-selection logic is pure (buildLadderStages takes/
// returns plain data, searchCompsWithLadder accepts injected fetchers) so the
// ladder is unit-tested without eBay or the database.

import {
  type BrowseComp,
  type BrowseCompsArgs,
  type BrowseCompsResult,
  isMarketplaceInsightsEnabled,
  searchBrowseComps,
  searchSoldComps,
} from "./ebay-client.ts";

export type CompBreadth = "exact" | "broadened" | "brand_category" | "category";

// system_settings key + factory default for the min-results threshold. Tunable
// deploy-free via the admin settings editor (migration 00243).
export const COMP_MIN_RESULTS_SETTING_KEY = "comps_min_results";
export const DEFAULT_MIN_COMP_RESULTS = 5;

export type CompSourceTag = "active" | "sold";

export interface LadderComp extends BrowseComp {
  /** Whether this row is an active asking-price comp or a realized sold comp. */
  source: CompSourceTag;
}

export interface CompLadderStage {
  breadth: CompBreadth;
  args: BrowseCompsArgs;
}

export interface CompLadderAttempt {
  breadth: CompBreadth;
  count: number;
}

export interface CompsLadderResult {
  /** Merged active + sold comps, each tagged with its source. */
  items: LadderComp[];
  /** Total reported by eBay for the winning ACTIVE rung. */
  total: number;
  /** Stats over the active comp set (the pricing basis stays active asks). */
  stats: BrowseCompsResult["stats"];
  /** Stats over the sold comp set, when sold comps were returned. */
  soldStats: BrowseCompsResult["stats"] | null;
  /** How broad the returned active set is. */
  breadth: CompBreadth;
  /** Convenience flag: the search had to broaden past the exact query. */
  broadened: boolean;
  /** The min-results threshold that drove the ladder. */
  minResults: number;
  /** Whether the Marketplace Insights (sold) grant is enabled. */
  soldEnabled: boolean;
  /** Each ladder rung that was tried, in order, with its active result count. */
  ladder: CompLadderAttempt[];
}

function norm(s: string | undefined): string {
  return (s ?? "").trim();
}

// Identity of a rung's effective query — used to dedupe no-op broadenings (e.g.
// no size + single-token query makes the first "broadened" rung equal "exact").
function stageKey(a: BrowseCompsArgs): string {
  return [
    a.categoryId ?? "",
    norm(a.q).toLowerCase(),
    norm(a.brand).toLowerCase(),
    norm(a.size).toLowerCase(),
    a.gtin ?? "",
    a.conditionId ?? "",
  ].join("|");
}

/**
 * Build the ordered broadening ladder for a comp search. Pure + exported for
 * unit testing. Consecutive/identical rungs are deduped (keeping the narrowest
 * label) so a no-op broadening doesn't repeat the previous rung.
 */
export function buildLadderStages(args: BrowseCompsArgs): CompLadderStage[] {
  const base: BrowseCompsArgs = {
    categoryId: args.categoryId,
    conditionId: args.conditionId,
    limit: args.limit,
    gtin: args.gtin,
  };
  const brand = norm(args.brand) || undefined;
  const size = norm(args.size) || undefined;
  const qTokens = norm(args.q).split(/\s+/).filter(Boolean);

  const stages: CompLadderStage[] = [];

  // 1. exact — everything the caller asked for.
  stages.push({
    breadth: "exact",
    args: {
      ...base,
      ...(qTokens.length ? { q: qTokens.join(" ") } : {}),
      ...(brand ? { brand } : {}),
      ...(size ? { size } : {}),
    },
  });

  // 2. broadened — drop the size first, then drop trailing title tokens one at a
  //    time while keeping brand + category so each rung stays on-topic.
  for (let n = qTokens.length; n >= 1; n--) {
    stages.push({
      breadth: "broadened",
      args: {
        ...base,
        q: qTokens.slice(0, n).join(" "),
        ...(brand ? { brand } : {}),
      },
    });
  }

  // 3. brand_category — brand + category only.
  if (brand) {
    stages.push({ breadth: "brand_category", args: { ...base, brand } });
  }

  // 4. category — the broadest meaningful rung.
  stages.push({ breadth: "category", args: { ...base } });

  const seen = new Set<string>();
  const deduped: CompLadderStage[] = [];
  for (const stage of stages) {
    const key = stageKey(stage.args);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(stage);
  }
  return deduped;
}

export interface CompsLadderOptions {
  /** Minimum active results a rung must return to stop broadening. */
  minResults?: number;
  /** Active-comp fetcher (default: eBay Browse). Injected in tests. */
  fetchActive?: (args: BrowseCompsArgs) => Promise<BrowseCompsResult>;
  /**
   * Sold-comp fetcher (default: eBay Marketplace Insights). Returns null when
   * the grant is disabled or the call fails. Injected in tests.
   */
  fetchSold?: (args: BrowseCompsArgs) => Promise<BrowseCompsResult | null>;
  /**
   * Whether the sold-comp grant is enabled (default: env flag). Lets tests drive
   * the labeling without touching Deno.env.
   */
  soldEnabled?: boolean;
}

const EMPTY_STATS: BrowseCompsResult["stats"] = {
  count: 0,
  currency: "USD",
  min: null,
  p25: null,
  median: null,
  p75: null,
  max: null,
};

/**
 * Run the broadening ladder, then merge in sold comps. Never throws on a fetch
 * failure — a failed rung counts as 0 and the ladder moves on; a failed sold
 * lookup degrades to active-only.
 */
export async function searchCompsWithLadder(
  args: BrowseCompsArgs,
  opts: CompsLadderOptions = {},
): Promise<CompsLadderResult> {
  const minResults = Math.max(
    1,
    Math.floor(opts.minResults ?? DEFAULT_MIN_COMP_RESULTS),
  );
  const fetchActive = opts.fetchActive ?? searchBrowseComps;
  const fetchSold = opts.fetchSold ?? searchSoldComps;
  const soldEnabled = opts.soldEnabled ?? isMarketplaceInsightsEnabled();

  const stages = buildLadderStages(args);
  const ladder: CompLadderAttempt[] = [];

  let chosen: { stage: CompLadderStage; result: BrowseCompsResult } | null =
    null;
  let best: { stage: CompLadderStage; result: BrowseCompsResult } | null = null;

  for (const stage of stages) {
    let result: BrowseCompsResult;
    try {
      result = await fetchActive(stage.args);
    } catch (err) {
      console.error(
        `[comps-ladder] active fetch failed at breadth=${stage.breadth}:`,
        err instanceof Error ? err.message : String(err),
      );
      ladder.push({ breadth: stage.breadth, count: 0 });
      continue;
    }
    ladder.push({ breadth: stage.breadth, count: result.stats.count });
    if (!best || result.stats.count > best.result.stats.count) {
      best = { stage, result };
    }
    if (result.stats.count >= minResults) {
      chosen = { stage, result };
      break;
    }
  }

  const winner = chosen ?? best;
  const activeResult: BrowseCompsResult = winner?.result ??
    { items: [], total: 0, stats: EMPTY_STATS };
  const breadth: CompBreadth = winner?.stage.breadth ?? "category";

  // Sold comps — searched at the winning breadth so the realized set matches the
  // active set we surfaced. Graceful no-op when disabled / unavailable.
  let soldResult: BrowseCompsResult | null = null;
  if (soldEnabled) {
    try {
      soldResult = await fetchSold(winner?.stage.args ?? args);
    } catch (err) {
      console.error(
        "[comps-ladder] sold fetch failed:",
        err instanceof Error ? err.message : String(err),
      );
      soldResult = null;
    }
  }

  const items: LadderComp[] = [
    ...activeResult.items.map((c) => ({ ...c, source: "active" as const })),
    ...(soldResult?.items ?? []).map((c) => ({ ...c, source: "sold" as const })),
  ];

  return {
    items,
    total: activeResult.total,
    stats: activeResult.stats,
    soldStats: soldResult?.stats ?? null,
    breadth,
    broadened: breadth !== "exact",
    minResults,
    soldEnabled,
    ladder,
  };
}
