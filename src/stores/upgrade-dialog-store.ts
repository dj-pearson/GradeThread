import { create } from "zustand";
import type { FlipdeskPlanKey } from "@/lib/constants";
import { useAuthStore } from "@/stores/auth-store";
import {
  upgradePromptKey,
  isUpgradePromptRateLimited,
  recordUpgradePromptShown,
} from "@/lib/upgrade-prompt-rate-limit";

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
  /**
   * Open the upgrade dialog. Returns true if the modal was actually opened,
   * false if it was suppressed by the rate limit (US-1289) — the caller can
   * then fall back to a lightweight toast reminder. Explicit user-initiated
   * upsells (e.g. an "Upgrade to unlock" button) omit `rateLimit` so they
   * always open; only the automatic mid-flow 402 path sets it.
   */
  show: (args: {
    reason: UpgradeReason;
    currentPlan?: FlipdeskPlanKey;
    requiredPlan: FlipdeskPlanKey;
    offerCreditPack?: boolean;
    rateLimit?: boolean;
  }) => boolean;
  hide: () => void;
}

export const useUpgradeDialogStore = create<UpgradeDialogState>((set) => ({
  open: false,
  reason: null,
  currentPlan: null,
  requiredPlan: null,
  offerCreditPack: false,
  show: ({ reason, currentPlan, requiredPlan, offerCreditPack, rateLimit }) => {
    if (rateLimit) {
      const scope = useAuthStore.getState().user?.id ?? null;
      const key = upgradePromptKey(reason, scope);
      const now = Date.now();
      if (isUpgradePromptRateLimited(key, now)) return false;
      recordUpgradePromptShown(key, now);
    }
    set({
      open: true,
      reason,
      currentPlan: currentPlan ?? null,
      requiredPlan,
      offerCreditPack: offerCreditPack ?? false,
    });
    return true;
  },
  hide: () => set({ open: false }),
}));
