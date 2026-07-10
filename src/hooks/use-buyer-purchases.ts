import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuth } from "@/hooks/use-auth";
import type {
  ArrivalImageType,
  BuyerGradeOutcomeRow,
  BuyerGuaranteeClaimRow,
  BuyerPurchaseRow,
  BuyerRewardCreditsRow,
  PurchaseArrivalCaptureRow,
  PurchaseCoverageRow,
} from "@/types/database";

// US-1811: buyer rewards — link a purchase to its grade + capture arrival photos.
// READS go direct to Supabase under owner-read RLS (buyer sees only their own).
// WRITES go through the edge (/api/buyer/*, personal account → skipWorkspaceHeader)
// so the cert link is verified server-side and arrival images run through the
// hardened validate→strip→private-bucket pipeline.

export interface PurchaseWithCaptures extends BuyerPurchaseRow {
  captures: PurchaseArrivalCaptureRow[];
  coverage: PurchaseCoverageRow | null;
  // US-1812: the buyer's confirm/dispute verdict for this purchase, if recorded.
  outcome: BuyerGradeOutcomeRow | null;
  // US-1821: the guarantee claim filed for this purchase, if any.
  claim: BuyerGuaranteeClaimRow | null;
}

// US-1812: a structured mismatch the buyer reports when disputing a grade.
export interface DisputeIssue {
  defect: string;
  severity?: "minor" | "moderate" | "major";
  location?: string;
}

export interface ConfirmPurchaseInput {
  match_status: "confirmed" | "disputed";
  issues?: DisputeIssue[];
  dispute_reason?: string | null;
}

export interface LinkPurchaseInput {
  cert_number: string;
  purchase_price_cents?: number | null;
  marketplace?: string | null;
  purchased_at?: string | null;
}

export interface ArrivalUpload {
  image_type: ArrivalImageType;
  data_url: string;
}

export function useBuyerPurchases() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = user?.id;
  const key = ["buyer-purchases", userId];

  const query = useQuery<PurchaseWithCaptures[]>({
    queryKey: key,
    queryFn: async () => {
      const [purchasesRes, capturesRes, coverageRes, outcomesRes, claimsRes] = await Promise.all([
        supabase
          .from("buyer_purchases")
          .select("*")
          .eq("user_id", userId!)
          .order("created_at", { ascending: false }),
        supabase.from("purchase_arrival_captures").select("*").eq("user_id", userId!),
        supabase.from("purchase_coverage").select("*").eq("user_id", userId!),
        // US-1812: buyer_arrival outcomes — owner-read RLS returns only this
        // buyer's confirm/dispute rows (00421).
        supabase
          .from("grade_outcomes")
          .select("id, buyer_purchase_id, match_status, dispute_reason, dispute_severity, guarantee_eligible")
          .eq("buyer_user_id", userId!),
        // US-1821: guarantee claims (owner-read, 00424).
        supabase.from("buyer_guarantee_claims").select("*").eq("user_id", userId!),
      ]);
      if (purchasesRes.error) throw purchasesRes.error;
      if (capturesRes.error) throw capturesRes.error;
      if (coverageRes.error) throw coverageRes.error;
      if (outcomesRes.error) throw outcomesRes.error;
      if (claimsRes.error) throw claimsRes.error;
      const captures = (capturesRes.data ?? []) as PurchaseArrivalCaptureRow[];
      const coverage = (coverageRes.data ?? []) as PurchaseCoverageRow[];
      const outcomes = (outcomesRes.data ?? []) as BuyerGradeOutcomeRow[];
      const claims = (claimsRes.data ?? []) as BuyerGuaranteeClaimRow[];
      return ((purchasesRes.data ?? []) as BuyerPurchaseRow[]).map((p) => ({
        ...p,
        captures: captures.filter((cap) => cap.purchase_id === p.id),
        coverage: coverage.find((cov) => cov.purchase_id === p.id) ?? null,
        outcome: outcomes.find((o) => o.buyer_purchase_id === p.id) ?? null,
        claim: claims.find((cl) => cl.purchase_id === p.id) ?? null,
      }));
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const linkMutation = useMutation({
    mutationFn: async (input: LinkPurchaseInput) => {
      const res = await edgeFetch("/api/buyer/purchases", {
        method: "POST",
        json: input,
        skipWorkspaceHeader: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not link the purchase.");
      return json.purchase as BuyerPurchaseRow;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const arrivalMutation = useMutation({
    mutationFn: async ({ purchaseId, images }: { purchaseId: string; images: ArrivalUpload[] }) => {
      const res = await edgeFetch(`/api/buyer/purchases/${purchaseId}/arrival`, {
        method: "POST",
        json: { images },
        skipWorkspaceHeader: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Upload failed.");
      return json;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  const claimMutation = useMutation({
    mutationFn: async (purchaseId: string) => {
      const res = await edgeFetch(`/api/buyer/purchases/${purchaseId}/claim`, {
        method: "POST",
        json: {},
        skipWorkspaceHeader: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not file the claim.");
      return json.claim as { status: string; remedyCents: number; remedyCredits: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ["buyer-reward-credits", userId] });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async ({ purchaseId, input }: { purchaseId: string; input: ConfirmPurchaseInput }) => {
      const res = await edgeFetch(`/api/buyer/purchases/${purchaseId}/confirm`, {
        method: "POST",
        json: input,
        skipWorkspaceHeader: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not record your verdict.");
      return json.outcome;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      // A confirmation may have issued reward credits — refresh the balance.
      queryClient.invalidateQueries({ queryKey: ["buyer-reward-credits", userId] });
    },
  });

  // US-1813: the buyer's spendable reward-credit balance (owner-read, 00422).
  const rewardsQuery = useQuery<BuyerRewardCreditsRow | null>({
    queryKey: ["buyer-reward-credits", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("buyer_reward_credits")
        .select("*")
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      return (data as BuyerRewardCreditsRow | null) ?? null;
    },
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  return {
    purchases: query.data ?? [],
    isLoading: query.isLoading,
    rewardCredits: rewardsQuery.data ?? null,
    linkPurchase: (input: LinkPurchaseInput) => linkMutation.mutateAsync(input),
    isLinking: linkMutation.isPending,
    uploadArrival: (purchaseId: string, images: ArrivalUpload[]) =>
      arrivalMutation.mutateAsync({ purchaseId, images }),
    isUploading: arrivalMutation.isPending,
    confirmPurchase: (purchaseId: string, input: ConfirmPurchaseInput) =>
      confirmMutation.mutateAsync({ purchaseId, input }),
    isConfirming: confirmMutation.isPending,
    fileClaim: (purchaseId: string) => claimMutation.mutateAsync(purchaseId),
    isFilingClaim: claimMutation.isPending,
  };
}
