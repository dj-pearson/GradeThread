import { create } from "zustand";
import type { FlipdeskPlanKey } from "@/lib/constants";

// Drives a globally-mounted FlipdeskPlanPickerDialog (US-212) so it can be
// opened from outside the React tree — the soft-upgrade toast in edgeFetch and
// the US-209 usage-alert watcher both call show() with the suggested tier
// pre-highlighted. (The hard-cap UpgradeRequiredDialog keeps its own local
// picker instance; this store is for the soft/standalone open paths.)

interface PlanPickerState {
  open: boolean;
  highlightPlan: FlipdeskPlanKey | null;
  show: (args?: { highlightPlan?: FlipdeskPlanKey }) => void;
  hide: () => void;
}

export const usePlanPickerStore = create<PlanPickerState>((set) => ({
  open: false,
  highlightPlan: null,
  show: (args) =>
    set({ open: true, highlightPlan: args?.highlightPlan ?? null }),
  hide: () => set({ open: false }),
}));
