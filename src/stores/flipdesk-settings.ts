import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ItemStatus } from "@/types/database";

// Per-device FlipDesk preferences. WIP limits cap how many items should sit in
// a pipeline column before it's flagged as a bottleneck. Kept in localStorage
// rather than the database — they are personal workflow tuning, not shared data.
interface FlipdeskSettingsState {
  wipLimits: Partial<Record<ItemStatus, number>>;
  setWipLimit: (status: ItemStatus, limit: number | null) => void;
  clearWipLimits: () => void;
}

export const useFlipdeskSettings = create<FlipdeskSettingsState>()(
  persist(
    (set) => ({
      wipLimits: {},
      setWipLimit: (status, limit) =>
        set((s) => {
          const next = { ...s.wipLimits };
          if (limit == null || !Number.isFinite(limit) || limit <= 0) {
            delete next[status];
          } else {
            next[status] = Math.floor(limit);
          }
          return { wipLimits: next };
        }),
      clearWipLimits: () => set({ wipLimits: {} }),
    }),
    { name: "flipdesk-pipeline-settings" },
  ),
);
