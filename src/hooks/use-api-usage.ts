import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useTenantKey } from "@/hooks/use-tenant-key";

// GET /api/keys/usage: call volume, the rate tier, and two answers the whole
// Developers page hangs off. `api_access` is the workspace OWNER's plan, which
// is what every key route enforces, so the page gates on it rather than on the
// viewer's own plan. `overage` says whether any key carries a monthly quota,
// which is the only thing that ever spends overage credits.

export interface ApiUsageSummary {
  since: string;
  days: number;
  total_requests: number;
  success_requests: number;
  error_requests: number;
  sandbox_requests: number;
  by_endpoint: { endpoint: string; method: string; count: number }[];
  daily: { day: string; count: number }[];
}

export interface ApiUsageResponse {
  summary: ApiUsageSummary;
  /** Live (non-sandbox) calls that got a 1xx-3xx answer. */
  live_success_requests?: number;
  plan: string;
  api_access: boolean;
  overage: { quota_enabled: boolean; balance: number };
  rate_limits: {
    read_per_minute: number;
    write_per_minute: number;
    window_seconds: number;
  };
}

/** Carries the HTTP status so a 403 can show the server's own message. */
export class ApiUsageError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function useApiUsage(options: { enabled?: boolean } = {}) {
  const tenantKey = useTenantKey();
  return useQuery<ApiUsageResponse>({
    queryKey: ["api-usage", tenantKey],
    enabled: Boolean(tenantKey) && (options.enabled ?? true),
    staleTime: 60 * 1000,
    queryFn: async () => {
      const res = await edgeFetch("/api/keys/usage?days=30");
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "" }));
        throw new ApiUsageError(err.error || "Failed to fetch API usage", res.status);
      }
      const json = await res.json();
      return json.data as ApiUsageResponse;
    },
  });
}
