import { supabase } from "@/lib/supabase";

// US-403: shape of the single JSON document returned by the
// `finances_dashboard` Postgres RPC. All aggregation happens server-side; the
// Finances page and its chart components consume these pre-computed series
// instead of downloading the raw inventory_items / sales / shipments / listings
// tables and aggregating in the browser.

export interface FinSummary {
  total_revenue: number;
  total_costs: number;
  net_profit: number;
  profit_margin: number;
  items_sold: number;
  avg_profit_per_item: number;
  avg_days_to_sell: number;
  inventory_value: number;
}

export interface FinTimePoint {
  d: string; // YYYY-MM-DD
  revenue: number;
  profit: number;
}

export interface FinCostBreakdown {
  acquisition: number;
  shipping: number;
  platform_fees: number;
  grading: number;
}

export interface FinNameValue {
  name: string;
  value: number;
}

export interface FinRoiGroup {
  name: string;
  items_sold: number;
  total_profit: number;
  total_cost_basis: number;
}

export interface FinItemRoi {
  id: string;
  title: string;
  detail: string;
  profit: number;
  cost_basis: number;
  roi_pct: number;
}

export interface FinAgingBracket {
  label: string;
  count: number;
  value: number;
}

export interface FinStaleItem {
  id: string;
  title: string;
  status: string;
  age: number;
  acquired_price: number;
}

export interface FinGradePoint {
  grade: number;
  price: number;
  profit: number;
  category: string;
}

export interface FinTierStat {
  label: string;
  count: number;
  avg_price: number;
  avg_profit: number;
}

export interface FinCategoryTier {
  category: string;
  tier: string;
  avg_price: number;
}

export interface FinTomRow {
  name: string;
  avg_days: number;
  count: number;
}

export interface FinTomDist {
  range: string;
  count: number;
}

export interface FinSlowItem {
  id: string;
  title: string;
  brand: string | null;
  garment_type: string | null;
  status: string;
  days_listed: number;
}

export interface FinCfDaily {
  d: string;
  inflow: number;
  outflow: number;
}

export interface FinCfTxn {
  date: string;
  type: "inflow" | "outflow";
  category: string;
  description: string;
  amount: number;
}

export interface FinProfitRow {
  id: string;
  title: string;
  brand: string;
  category: string;
  acquired_price: number;
  listed_price: number;
  sale_price: number;
  platform_fees: number;
  shipping_cost: number;
  net_profit: number;
  profit_margin: number;
  sale_date: string;
}

export interface FinancesDashboard {
  summary: FinSummary;
  time_series: FinTimePoint[];
  cost_breakdown: FinCostBreakdown;
  top_brands: FinNameValue[];
  top_categories: FinNameValue[];
  roi_by_brand: FinRoiGroup[];
  roi_by_category: FinRoiGroup[];
  roi_by_source: FinRoiGroup[];
  roi_best_items: FinItemRoi[];
  roi_worst_items: FinItemRoi[];
  inventory_aging: {
    total_count: number;
    total_value: number;
    brackets: FinAgingBracket[];
  };
  stale_items: FinStaleItem[];
  stale_items_total: number;
  grade_points: FinGradePoint[];
  grade_points_total: number;
  grade_tier_stats: FinTierStat[];
  grade_category_tier: FinCategoryTier[];
  tom_overall_avg: number;
  tom_by_type: FinTomRow[];
  tom_by_brand: FinTomRow[];
  tom_distribution: FinTomDist[];
  tom_slow_moving: FinSlowItem[];
  tom_slow_moving_total: number;
  tom_has_sold_data: boolean;
  cash_flow_daily: FinCfDaily[];
  cash_flow_recent: FinCfTxn[];
  cash_flow_total: number;
  profit_rows: FinProfitRow[];
  profit_rows_total: number;
}

// Flat transaction record returned by the finances_export RPC (CSV/PDF export).
export interface FinExportTxn {
  date: string;
  type: "income" | "expense";
  category: "sale" | "acquisition" | "shipping" | "fee" | "grading";
  amount: number;
  itemTitle: string;
  platform: string;
}

// These RPCs are not in the generated Database types; call them through a
// narrowly-typed view of the client (same pattern as get_or_create_source etc.).
type RpcClient = {
  rpc: ((
    fn: "finances_dashboard",
    args: { p_period_start: string | null },
  ) => Promise<{ data: FinancesDashboard | null; error: { message: string } | null }>) &
    ((
      fn: "finances_export",
      args: { p_start: string; p_end: string },
    ) => Promise<{ data: FinExportTxn[] | null; error: { message: string } | null }>);
};

export async function fetchFinancesDashboard(
  periodStart: string | null,
): Promise<FinancesDashboard> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("finances_dashboard", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No finances data returned");
  return data;
}

export async function fetchFinancesExport(
  start: string,
  end: string,
): Promise<FinExportTxn[]> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("finances_export", {
    p_start: start,
    p_end: end,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}
