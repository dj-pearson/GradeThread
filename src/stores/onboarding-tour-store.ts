import { create } from "zustand";

// Lets the first-run welcome/product tour (OnboardingFlow) be re-opened from
// Settings even after a user has already completed or skipped it (US-378).
// Mirrors the FlipDesk-specific tour store, but drives the general onboarding
// dialog (welcome → use case → feature highlights).
interface OnboardingTourState {
  reopened: boolean;
  open: () => void;
  close: () => void;
}

export const useOnboardingTourStore = create<OnboardingTourState>((set) => ({
  reopened: false,
  open: () => set({ reopened: true }),
  close: () => set({ reopened: false }),
}));
