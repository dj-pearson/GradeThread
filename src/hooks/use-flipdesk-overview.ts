import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  overviewRangeBounds,
  type OverviewRangeId,
} from "@/lib/overview-range";

// US-2547: the FlipDesk Overview's numbers, aggregated in SQL.
//
// This replaces a full `items_full` read plus a client-side loop over every row
// the account owns. `flipdesk_overview_metrics` (migration 00594) is SECURITY
// INVOKER over the same security_invoker view, so the rows counted are exactly
// the rows RLS would have handed the browser — the arithmetic just happens where
// the rows already are.
//
// Keyed under the ["items_full"] prefix so every existing
// invalidateQueries({ queryKey: ["items_full"] }) after a status change, a sale
// or an import refreshes the overview too. The range is part of the key: two
// windows are two different answers, not one answer to re-derive.

/** Days without movement before an item counts as aging / a listing as stale. */
export const OVERVIEW_AGING_DAYS = 14;

/** How many aging / stale rows the aggregate returns for "show all". */
export const OVERVIEW_LIST_LIMIT = 50;

export interface OverviewAgingRow {
  id: string;
  item_title: string | null;
  brand: string | null;
  status: string;
  days: number;
}

export interface OverviewStaleRow {
  id: string;
  item_title: string | null;
  brand: string | null;
  list_price: number | null;
  grade_value: number | null;
  days: number;
}

export interface OverviewBrandRow {
  brand: string;
  profit: number;
  sold: number;
}

export interface OverviewSaleRow {
  id: string;
  item_title: string | null;
  brand: string | null;
  sale_date: string | null;
  sale_price: number | null;
  net_profit: number | null;
}

export interface OverviewWeekRow {
  /** Monday of the week, YYYY-MM-DD, in the viewer's zone. */
  week: string;
  count: number;
}

export interface OverviewMetrics {
  total: number;
  byStatus: Record<string, number>;
  inventoryValue: number;
  listedInRange: number;
  soldInRange: number;
  grossInRange: number;
  netInRange: number;
  agingCount: number;
  agingItems: OverviewAgingRow[];
  staleCount: number;
  staleListings: OverviewStaleRow[];
  topBrands: OverviewBrandRow[];
  recentSales: OverviewSaleRow[];
  listWeeks: OverviewWeekRow[];
  lifetimeListed: number;
}

const EMPTY: OverviewMetrics = {
  total: 0,
  byStatus: {},
  inventoryValue: 0,
  listedInRange: 0,
  soldInRange: 0,
  grossInRange: 0,
  netInRange: 0,
  agingCount: 0,
  agingItems: [],
  staleCount: 0,
  staleListings: [],
  topBrands: [],
  recentSales: [],
  listWeeks: [],
  lifetimeListed: 0,
};

function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function useFlipdeskOverview(range: OverviewRangeId) {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: ["items_full", "overview_metrics", user?.id, range],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<OverviewMetrics> => {
      // Bounds are computed at FETCH time, not at render time: a tab left open
      // overnight would otherwise keep asking for yesterday's seven days.
      const { from, to } = overviewRangeBounds(range);
      const { data, error } = await supabase.rpc(
        "flipdesk_overview_metrics" as never,
        {
          p_from: from,
          p_to: to,
          p_tz: viewerTimeZone(),
          p_aging_days: OVERVIEW_AGING_DAYS,
          p_limit: OVERVIEW_LIST_LIMIT,
        } as never,
      );
      if (error) throw error;
      return { ...EMPTY, ...((data ?? {}) as Partial<OverviewMetrics>) };
    },
  });
}
