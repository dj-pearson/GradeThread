import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { medianSeconds, resolveReviewFlow } from "@/lib/review-flow";

// US-9204: the review flow's two settings reads and the one number it writes.
//
// Both reads tolerate the column being absent. The frontend auto-deploys on
// push while migration 00715 is applied by hand, and a `42703` on a column the
// page only needs for a default would otherwise take the whole intake page
// down with it. A failed read resolves to NULL, which is "decide by account
// age", which is what the page did before the column existed.

const REVIEW_FLOW_KEY = "review_flow_setting";
const REVIEW_MEDIAN_KEY = "review_approve_median";

export function reviewFlowSettingKey(userId: string | undefined) {
  return [REVIEW_FLOW_KEY, userId] as const;
}

/** The stored choice: true, false, or null for "never chose". */
export function useReviewFlowSetting() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: reviewFlowSettingKey(user?.id),
    enabled: !!user,
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<boolean | null> => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select("review_flow_enabled")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) return null;
      const v = (data as { review_flow_enabled?: boolean | null } | null)?.review_flow_enabled;
      return v === true || v === false ? v : null;
    },
  });
}

/**
 * Whether intake should hand off to the review screen: the stored choice, else
 * the account-age default. `chosen` says whether the seller ever flipped the
 * switch, so the intake page can show it once rather than forever.
 */
export function useReviewFlowEnabled(): {
  enabled: boolean;
  chosen: boolean;
  isLoading: boolean;
} {
  const profile = useAuthStore((s) => s.profile);
  const setting = useReviewFlowSetting();
  const stored = setting.data ?? null;
  return {
    enabled: resolveReviewFlow(stored, profile?.created_at),
    chosen: stored === true || stored === false,
    isLoading: setting.isLoading,
  };
}

export function useSetReviewFlow() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  return useMutation<void, Error, boolean>({
    mutationFn: async (enabled) => {
      if (!user) throw new Error("You must be signed in.");
      const { error } = await supabase
        .from("flipdesk_settings")
        .upsert(
          { user_id: user.id, review_flow_enabled: enabled } as never,
          { onConflict: "user_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [REVIEW_FLOW_KEY] });
    },
  });
}

/**
 * The seller's median seconds from first photo to Approve, over the newest 200
 * items that went through the review screen. Null until one has.
 */
export function useReviewApproveMedian() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: [REVIEW_MEDIAN_KEY, user?.id],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<{ median: number | null; count: number }> => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("review_approve_seconds")
        .not("review_approve_seconds", "is", null)
        .order("review_approved_at", { ascending: false })
        .limit(200);
      if (error) return { median: null, count: 0 };
      const values = ((data ?? []) as { review_approve_seconds: number | null }[])
        .map((r) => r.review_approve_seconds)
        .filter((v): v is number => typeof v === "number");
      return { median: medianSeconds(values), count: values.length };
    },
  });
}

/** Stamp the approve time on the item. Best effort: a miss here must never undo an Approve. */
export async function recordReviewApprove(itemId: string, seconds: number | null): Promise<void> {
  try {
    await supabase
      .from("inventory_items")
      .update({
        review_approve_seconds: seconds,
        review_approved_at: new Date().toISOString(),
      } as never)
      .eq("id", itemId);
  } catch {
    /* the analytics event already carries the number */
  }
}

export function reviewMedianKey(userId: string | undefined) {
  return [REVIEW_MEDIAN_KEY, userId] as const;
}
