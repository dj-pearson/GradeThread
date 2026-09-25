import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import type { ConsignorRow, ConsignorPnlRow, ConsignorPayoutRow } from "@/types/database";

// US-600: a consignor merged with its P&L rollup, as returned by
// GET /api/flipdesk/consignment/consignors.
export interface ConsignorWithPnl extends ConsignorRow {
  pnl: ConsignorPnlRow | null;
}

export interface ConsignorList {
  consignors: ConsignorWithPnl[];
  // C10: the P&L read failed. Balances are unknown, not $0.00.
  pnlError: boolean;
}

export function useConsignors() {
  const ownerId = useAuthStore((s) => s.activeWorkspaceOwnerId ?? s.user?.id);
  return useQuery({
    queryKey: ["consignors", ownerId],
    enabled: !!ownerId,
    queryFn: async (): Promise<ConsignorList> => {
      const res = await edgeFetch("/api/flipdesk/consignment/consignors");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Couldn't load consignors.");
      }
      const data = await res.json();
      return {
        consignors: (data.consignors ?? []) as ConsignorWithPnl[],
        pnlError: data.pnl_error === true,
      };
    },
  });
}

// C11: `enabled` lets the history dialog fetch only while it is open.
// `statuses` narrows the read on the server. The ledger is paged (200 rows
// unfiltered), so the dashboard widget, which SUMS every unpaid row, asks for
// just those statuses and gets the larger filtered cap instead of the newest
// 200 rows of everything.
export function useConsignorPayouts(
  consignorId?: string,
  options: { enabled?: boolean; statuses?: readonly string[] } = {},
) {
  const ownerId = useAuthStore((s) => s.activeWorkspaceOwnerId ?? s.user?.id);
  const statusKey = options.statuses?.length ? [...options.statuses].sort().join(",") : "";
  return useQuery({
    queryKey: ["consignor-payouts", ownerId, consignorId ?? "all", statusKey],
    enabled: !!ownerId && (options.enabled ?? true),
    queryFn: async (): Promise<ConsignorPayoutRow[]> => {
      const params = new URLSearchParams();
      if (consignorId) params.set("consignor_id", consignorId);
      if (statusKey) params.set("status", statusKey);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await edgeFetch(`/api/flipdesk/consignment/payouts${qs}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to load payouts");
      }
      const data = await res.json();
      return (data.payouts ?? []) as ConsignorPayoutRow[];
    },
  });
}
