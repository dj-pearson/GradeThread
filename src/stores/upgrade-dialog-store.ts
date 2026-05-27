import { create } from "zustand";
import type { FlipdeskPlanKey } from "@/lib/constants";

// Drives the UpgradeRequiredDialog (US-210). Lives in a Zustand store
// because the trigger fires from edgeFetch — outside the React tree —
// when an edge endpoint returns 402 PAYMENT_REQUIRED.

export type UpgradeReason =
  | {
      type: "cap";
      kind: "activeListings" | "aiActions" | "marketplaces" | "includedGrades";
      used?: number;
      limit?: number;
      delta?: number;
    }
  | {
      type: "feature";
      feature: string;
    };

interface UpgradeDialogState {
  open: boolean;
  reason: UpgradeReason | null;
  currentPlan: FlipdeskPlanKey | null;
  requiredPlan: FlipdeskPlanKey | null;
  /** When true, the dialog also shows credit pack tiles inline (cap=includedGrades). */
  offerCreditPack: boolean;
  show: (args: {
    reason: UpgradeReason;
    currentPlan?: FlipdeskPlanKey;
    requiredPlan: FlipdeskPlanKey;
    offerCreditPack?: boolean;
  }) => void;
  hide: () => void;
}

export const useUpgradeDialogStore = create<UpgradeDialogState>((set) => ({
  open: false,
  reason: null,
  currentPlan: null,
  requiredPlan: null,
  offerCreditPack: false,
  show: ({ reason, currentPlan, requiredPlan, offerCreditPack }) =>
    set({
      open: true,
      reason,
      currentPlan: currentPlan ?? null,
      requiredPlan,
      offerCreditPack: offerCreditPack ?? false,
    }),
  hide: () => set({ open: false }),
}));
