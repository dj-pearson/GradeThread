import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "@/hooks/use-workspace";
import { fetchPayoutBreakdown, type PayoutBreakdown } from "@/lib/payout-breakdown";

// US-3413. Keyed on the workspace OWNER, not the signed-in user: a member
// looking at their employer's books must not read a breakdown cached under
// their own id, and must not have theirs overwritten by it.
//
// Enabled only when a payout is actually expanded. The Reconciliation page can
// list a dozen deposits and there is no reason to read twelve breakdowns to
// show one.
export function usePayoutBreakdown(payoutId: string | null) {
  const { workspaceOwnerId } = useWorkspace();
  return useQuery<PayoutBreakdown>({
    queryKey: ["payout-breakdown", workspaceOwnerId, payoutId],
    enabled: !!workspaceOwnerId && !!payoutId,
    queryFn: () => fetchPayoutBreakdown(workspaceOwnerId!, payoutId!),
  });
}
