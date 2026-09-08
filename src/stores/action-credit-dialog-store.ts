import { create } from "zustand";

// US-3138: drives the global Action Credit top-up dialog.
//
// A Zustand store rather than component state because the trigger fires from
// edgeFetch, outside the React tree, when a metered endpoint answers 429 with
// `can_top_up: true`. Same shape as upgrade-dialog-store.ts, which does the
// equivalent job for 402.
//
// The important thing this store does NOT do: it never opens for a refusal
// that a purchase would not fix. A seller who hit their own AI cap, or whose
// plan does not include the connector at all, gets a different message with no
// offer to sell them anything. That decision is made by the server
// (`can_top_up`) and honored in edge-fetch.ts, not re-derived here.

interface ActionCreditDialogState {
  open: boolean;
  /**
   * The seller's balance when the refusal happened. Shown while the fresh
   * billing summary loads, so the dialog does not open reading "0 credits" for
   * someone who has 3.
   */
  balanceAtRefusal: number | null;
  /** How many credits the blocked action needed. Null when the server did not say. */
  creditsNeeded: number | null;
  /** Same-origin path to return to after checkout, so the seller lands back on the blocked work. */
  returnPath: string | null;
  /** For the conversion funnel: which wall opened this. */
  source: string;
  show: (args: {
    balanceAtRefusal?: number;
    creditsNeeded?: number;
    returnPath?: string;
    source?: string;
  }) => void;
  hide: () => void;
}

export const useActionCreditDialogStore = create<ActionCreditDialogState>((set) => ({
  open: false,
  balanceAtRefusal: null,
  creditsNeeded: null,
  returnPath: null,
  source: "unknown",
  show: ({ balanceAtRefusal, creditsNeeded, returnPath, source }) =>
    set({
      open: true,
      balanceAtRefusal: balanceAtRefusal ?? null,
      creditsNeeded: creditsNeeded ?? null,
      // Captured at open time rather than at checkout time: by the time the
      // seller picks a pack they may have navigated, and returning them to
      // wherever they drifted to is not the same as returning them to the work
      // that was blocked.
      returnPath: returnPath ?? (typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : null),
      source: source ?? "unknown",
    }),
  hide: () => set({ open: false }),
}));
