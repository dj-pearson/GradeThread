import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import { useUpgradeDialogStore } from "@/stores/upgrade-dialog-store";

/**
 * Shown in place of a reconciliation card when the edge refused the read on
 * plan grounds (402/403). Opens the same upgrade dialog TaxPnlExportCard uses,
 * so a locked feature reads as locked instead of as a clean result.
 */
export function PlanLockedNotice({ what }: { what: string }) {
  const { plan } = usePlanUsage();
  const showUpgrade = useUpgradeDialogStore((s) => s.show);
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <Lock className="h-5 w-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{what} is on the Business plan.</p>
      <p className="max-w-sm text-[13px] text-muted-foreground">
        Nothing has been checked, so this is not a clean bill of health.
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          showUpgrade({
            reason: { type: "feature", feature: "reconciliation" },
            currentPlan: plan,
            requiredPlan: "business",
          })
        }
      >
        See plans
      </Button>
    </div>
  );
}
