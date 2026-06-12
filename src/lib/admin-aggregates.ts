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

type RpcClient = {
  rpc: ((
    fn: "admin_system_metrics",
    args?: Record<string, never>,
  ) => Promise<{ data: AdminSystemMetrics | null; error: { message: string } | null }>) &
    ((
      fn: "admin_user_list_stats",
      args: { p_user_ids: string[] },
    ) => Promise<{ data: AdminUserListStats | null; error: { message: string } | null }>) &
    ((
      fn: "admin_audit_log_filter_options",
      args?: Record<string, never>,
    ) => Promise<{ data: AdminAuditFilterOptions | null; error: { message: string } | null }>);
};

export async function fetchAdminSystemMetrics(): Promise<AdminSystemMetrics> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("admin_system_metrics");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No system metrics returned");
  return data;
}

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

export async function fetchAdminAuditFilterOptions(): Promise<AdminAuditFilterOptions> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("admin_audit_log_filter_options");
  if (error) throw new Error(error.message);
  return data ?? { actions: [], targetTypes: [], admins: [] };
}
