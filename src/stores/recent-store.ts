import { create } from "zustand";
import { persist } from "zustand/middleware";

// Tracks the last inventory items the user opened — feeds the command
// palette "Recent" section. Persisted to localStorage so it survives reload.
interface RecentState {
  recentItemIds: string[];
  pushRecent: (id: string) => void;
  clearRecent: () => void;
}

const MAX_RECENT = 10;

export const useRecentStore = create<RecentState>()(
  persist(
    (set) => ({
      recentItemIds: [],
      pushRecent: (id) =>
        set((s) => ({
          recentItemIds: [
            id,
            ...s.recentItemIds.filter((x) => x !== id),
          ].slice(0, MAX_RECENT),
        })),
      clearRecent: () => set({ recentItemIds: [] }),
    }),
    { name: "flipdesk-recent-items" },
  ),
);
