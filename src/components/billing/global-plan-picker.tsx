import { FlipdeskPlanPickerDialog } from "@/components/billing/flipdesk-plan-picker-dialog";
import { usePlanPickerStore } from "@/stores/plan-picker-store";

// Globally-mounted plan picker (US-209/US-212). Opened from outside the React
// tree via usePlanPickerStore.show() — the soft-upgrade toast (edgeFetch) and
// the usage-alert watcher route their "Upgrade" CTAs here, pre-highlighting the
// suggested next tier.
export function GlobalPlanPicker() {
  const { open, highlightPlan, hide } = usePlanPickerStore();
  return (
    <FlipdeskPlanPickerDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) hide();
      }}
      highlightPlan={highlightPlan ?? undefined}
    />
  );
}
