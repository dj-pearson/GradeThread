import { useQuery } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import type { ConsignorRow, ConsignorPnlRow, ConsignorPayoutRow } from "@/types/database";

// US-600: a consignor merged with its P&L rollup, as returned by
// GET /api/flipdesk/consignment/consignors.
export interface ConsignorWithPnl extends ConsignorRow {
  pnl: ConsignorPnlRow | null;
}

export function useConsignors() {
  const ownerId = useAuthStore((s) => s.activeWorkspaceOwnerId ?? s.user?.id);
  return useQuery({
    queryKey: ["consignors", ownerId],
    enabled: !!ownerId,
    queryFn: async (): Promise<ConsignorWithPnl[]> => {
      const res = await edgeFetch("/api/flipdesk/consignment/consignors");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to load consignors");
      }
      const data = await res.json();
      return (data.consignors ?? []) as ConsignorWithPnl[];
    },
  });
}

export function useConsignorPayouts(consignorId?: string) {
  const ownerId = useAuthStore((s) => s.activeWorkspaceOwnerId ?? s.user?.id);
  return useQuery({
    queryKey: ["consignor-payouts", ownerId, consignorId ?? "all"],
    enabled: !!ownerId,
    queryFn: async (): Promise<ConsignorPayoutRow[]> => {
      const qs = consignorId ? `?consignor_id=${encodeURIComponent(consignorId)}` : "";
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
