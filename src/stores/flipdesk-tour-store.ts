import { create } from "zustand";

// Lets the FlipDesk onboarding checklist be re-opened from Settings even
// after a user has already completed or skipped it.
interface FlipdeskTourState {
  reopened: boolean;
  open: () => void;
  close: () => void;
}

export const useFlipdeskTourStore = create<FlipdeskTourState>((set) => ({
  reopened: false,
  open: () => set({ reopened: true }),
  close: () => set({ reopened: false }),
}));
