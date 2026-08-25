import { useState } from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";

// US-858: the `users.share_sale_outcomes` opt-in, surfaced wherever sale-outcome
// data flows back from (settings + the Grading-ROI proof view). When a graded
// item sells we share the sold price (no buyer info) so the AI grading model can
// learn how grades correlate with real resale values. Off by default; the flip
// is optimistic and reverts on failure — same save path settings.tsx uses.

export function ShareOutcomesToggle({ className }: { className?: string }) {
  const { user, profile, refreshProfile } = useAuth();
  const [shareOutcomes, setShareOutcomes] = useState(
    profile?.share_sale_outcomes ?? false,
  );
  const [saving, setSaving] = useState(false);

  async function handleToggle(next: boolean) {
    if (!user) return;
    setSaving(true);
    setShareOutcomes(next);
    try {
      const { supabase } = await import("@/lib/supabase");
      const { error } = await supabase
        .from("users")
        .update({ share_sale_outcomes: next } as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success(
        next
          ? "Thanks — your sale outcomes will help improve AI grading."
          : "Sale-outcome sharing turned off.",
      );
    } catch (err) {
      // Revert the optimistic flip if the save fails.
      setShareOutcomes(!next);
      toastError(err, "Failed to update sale-outcome sharing.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={className}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            Share sale outcomes with GradeThread
          </p>
          <p className="text-xs text-muted-foreground">
            When a graded item sells, share the sold price (no buyer info) so the
            AI grading model can learn how grades correlate with real resale
            values — and so more data feeds the proof below. Opt-in, off by
            default.
          </p>
        </div>
        <Switch
          checked={shareOutcomes}
          onCheckedChange={handleToggle}
          disabled={saving}
          aria-label="Share sale outcomes"
        />
      </div>
    </div>
  );
}
