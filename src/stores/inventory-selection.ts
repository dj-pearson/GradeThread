import { create } from "zustand";

// Shared multi-select for the unified Inventory surface (US-958). The table
// (listings) and kanban (pipeline) views each let the user select items for a
// bulk action; before consolidation each kept its own local useState, so
// switching views dropped the selection. This module-level store survives the
// unmount/remount that happens when the container swaps view modes, so a
// selection made in the table carries over to the kanban (and back). Selection
// is item-id based in both views, so the IDs are directly interchangeable.
//
// Not persisted to localStorage or the URL: a select-all can run to thousands
// of ids (would blow the URL length) and a stale selection across a full page
// reload is more confusing than helpful. Persistence across *view switches* —
// which keep the component tree mounted in the same SPA session — is the goal.
interface InventorySelectionState {
  selected: Set<string>;
  // Mirrors React's setState signature (value or updater) so existing call
  // sites that did setSelected(new Set()) / setSelected(prev => …) port over
  // unchanged.
  setSelected: (
    next: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => void;
  clear: () => void;
}

export const useInventorySelection = create<InventorySelectionState>((set) => ({
  selected: new Set(),
  setSelected: (next) =>
    set((state) => ({
      selected:
        typeof next === "function"
          ? (next as (prev: Set<string>) => Set<string>)(state.selected)
          : next,
    })),
  clear: () => set({ selected: new Set() }),
}));
