import { supabase } from "@/lib/supabase";

// US-415: typed wrappers for the admin aggregation RPCs (migration 00147).
// These move per-page aggregation/pagination support into Postgres so the admin
// surfaces stop downloading whole tables to count + paginate in the browser.
// Same RPC-cast pattern as src/lib/finances-dashboard.ts — the functions are not
// in the generated Database types, so we narrow the client locally.

// ── admin_system_metrics ──────────────────────────────────────────────────

export interface AdminBucketPoint {
  start: string; // ISO timestamp of the bucket start
  submissions: number;
  uniqueUsers: number;
}

export interface AdminDailyUsersPoint {
  start: string;
  uniqueUsers: number;
}

export interface AdminErrorRatePoint {
  start: string;
  totalSubmissions: number;
  failedCount: number;
}

export interface AdminSystemMetrics {
  queue: {
    pendingCount: number;
    processingCount: number;
    avgProcessingTimeMin: number;
    failedLast24h: number;
  };
  storage: {
    totalImages: number;
  };
  subscriptions: {
    planCounts: Record<string, number>;
    totalPaid: number;
    churnFreeWithActivity: number;
  };
  hourlyTraffic: AdminBucketPoint[];
  dailyUsers: AdminDailyUsersPoint[];
  errorRate: AdminErrorRatePoint[];
}

// Per-user submission stats keyed by user id, bounded to the displayed page.
export type AdminUserListStats = Record<
  string,
  { count: number; last: string }
>;

export interface AdminAuditFilterOptions {
  actions: string[];
  targetTypes: string[];
  admins: Array<{ id: string; label: string }>;
}

// ── admin_audit_log_search (US-905) ────────────────────────────────────────
// Server-side full-text search (action/target/details) + actor/action/target/
// date filters, paginated with a window total_count. The console calls this
// instead of a direct table query so the jsonb `details` is searchable.

export interface AdminAuditSearchParams {
  search?: string | null;
  admin?: string | null;
  action?: string | null;
  targetType?: string | null;
  from?: string | null;
  to?: string | null;
  limit: number;
  offset: number;
}

export interface AdminAuditSearchRow {
  id: string;
  admin_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  total_count: number;
}

export interface AdminAuditSearchResult {
  rows: AdminAuditSearchRow[];
  totalCount: number;
}

// ── admin_revenue_metrics (US-583) ─────────────────────────────────────────
// Authoritative subscription revenue + AI token spend. MRR is computed
// client-side from `byPlanInterval` × FLIPDESK_PLANS pricing so prices live in
// one place (constants), never hard-coded in the RPC.

export interface AdminRevenueMetrics {
  subscriptions: {
    activePaid: number;
    trialing: number;
    pastDue: number;
    byPlanInterval: Array<{ plan: string; interval: string; count: number }>;
    canceledLast30d: number;
  };
  ai: {
    costTrackingActive: boolean;
    last24h: { costUsd: number; inputTokens: number; outputTokens: number; grades: number };
    last30d: { costUsd: number; inputTokens: number; outputTokens: number; grades: number };
    avgCostPerGradeUsd: number;
    daily: Array<{
      start: string;
      costUsd: number;
      grades: number;
      inputTokens: number;
      outputTokens: number;
    }>;
  };
}

// Only the RPCs the BROWSER still calls. admin_system_metrics and
// admin_revenue_metrics are absent on purpose: US-1565 moved the admin System
// page behind the edge, which calls both server-side in routes/admin-dashboard.ts,
// and US-2436 removed the browser wrappers that had been left behind. The
// AdminSystemMetrics / AdminRevenueMetrics interfaces above STAY — system.tsx
// still imports them to type what edgeFetch returns.
type RpcClient = {
  rpc: ((
    fn: "admin_user_list_stats",
    args: { p_user_ids: string[] },
  ) => Promise<{ data: AdminUserListStats | null; error: { message: string } | null }>) &
    ((
      fn: "admin_audit_log_filter_options",
      args?: Record<string, never>,
    ) => Promise<{ data: AdminAuditFilterOptions | null; error: { message: string } | null }>) &
    ((
      fn: "admin_audit_log_search",
      args: {
        p_search: string | null;
        p_admin: string | null;
        p_action: string | null;
        p_target_type: string | null;
        p_from: string | null;
        p_to: string | null;
        p_limit: number;
        p_offset: number;
      },
    ) => Promise<{ data: AdminAuditSearchRow[] | null; error: { message: string } | null }>);
};

export async function fetchAdminUserListStats(
  userIds: string[],
): Promise<AdminUserListStats> {
  if (userIds.length === 0) return {};
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("admin_user_list_stats", {
    p_user_ids: userIds,
  });
  if (error) throw new Error(error.message);
  return data ?? {};
}

export async function fetchAdminAuditSearch(
  params: AdminAuditSearchParams,
): Promise<AdminAuditSearchResult> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("admin_audit_log_search", {
    p_search: params.search?.trim() || null,
    p_admin: params.admin && params.admin !== "all" ? params.admin : null,
    p_action: params.action && params.action !== "all" ? params.action : null,
    p_target_type:
      params.targetType && params.targetType !== "all" ? params.targetType : null,
    p_from: params.from || null,
    p_to: params.to || null,
    p_limit: params.limit,
    p_offset: params.offset,
  });
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  return { rows, totalCount: rows[0]?.total_count ?? 0 };
}

export async function fetchAdminAuditFilterOptions(): Promise<AdminAuditFilterOptions> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("admin_audit_log_filter_options");
  if (error) throw new Error(error.message);
  return data ?? { actions: [], targetTypes: [], admins: [] };
}
