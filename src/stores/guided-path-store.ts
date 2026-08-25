import { create } from "zustand";
import {
  hasOptedOutOfGuidedPath,
  setGuidedPathOptOut,
} from "@/lib/guided-path";

// US-2873. Whether the guided path is switched on for this session.
//
// A store rather than a prop because the bar renders in the dashboard layout
// and the two things that turn it on live elsewhere: the activation
// checklist's first step (AC1) and the Help page's replay link (AC4).
//
// It holds NO progress. Where the seller is up to comes from their real data
// via nextGuidedStep(), so this store cannot fall out of step with the account
// -- there is nothing in it to fall out of step with.

interface GuidedPathState {
  active: boolean;
  /** Turn it on. Clears any previous opt-out, which is what replay means. */
  start: (userId: string | undefined) => void;
  /** Turn it off for now. The caller records the opt-out. */
  stop: () => void;
  /** Read the stored opt-out and switch on if the user never opted out. */
  resume: (userId: string | undefined) => void;
}

export const useGuidedPathStore = create<GuidedPathState>((set) => ({
  // Off until something asks for it. A first-run path that switches itself on
  // before the account has been looked at would flash on every reload.
  active: false,
  start: (userId) => {
    setGuidedPathOptOut(userId, false);
    set({ active: true });
  },
  stop: () => set({ active: false }),
  resume: (userId) => set({ active: !hasOptedOutOfGuidedPath(userId) }),
}));
