import { create } from "zustand";

// The in-flight account ZIP export (Settings > Data). It lives in a store
// rather than in DataSettingsTab's useState because the Settings page
// unmounts a tab when the user switches away: a component flag came back as
// `false` while the first export was still building, so the button re-enabled
// and a second click started a second export alongside it.
//
// The slot belongs to one user id. A store outlives sign-out (it is SPA
// navigation, no reload), so a bare flag left the NEXT person on a shared
// browser looking at a disabled button until the previous user's export
// settled. use-auth clears the slot on SIGNED_OUT, and a stale export's
// progress/finish calls are ignored once the slot is someone else's.

interface AccountExportState {
  /** Who the running export belongs to; null when idle. */
  ownerId: string | null;
  exporting: boolean;
  stage: string;
  pct: number;
  /** Claims the export slot for userId. Returns false when theirs is already running. */
  begin: (userId: string) => boolean;
  progress: (userId: string, stage: string, pct: number) => void;
  finish: (userId: string) => void;
  /** Drops the slot whoever holds it (sign-out). */
  clear: () => void;
}

const IDLE = { ownerId: null, exporting: false, stage: "", pct: 0 };

export const useAccountExportStore = create<AccountExportState>((set, get) => ({
  ...IDLE,
  begin: (userId) => {
    const s = get();
    if (s.exporting && s.ownerId === userId) return false;
    set({ ownerId: userId, exporting: true, stage: "Starting…", pct: 0 });
    return true;
  },
  progress: (userId, stage, pct) => {
    if (get().ownerId !== userId) return;
    set({ exporting: true, stage, pct });
  },
  finish: (userId) => {
    if (get().ownerId !== userId) return;
    set(IDLE);
  },
  clear: () => set(IDLE),
}));

/** Whether userId's export is running. Another user's never counts. */
export function isExportingFor(
  s: Pick<AccountExportState, "ownerId" | "exporting">,
  userId: string | null | undefined,
): boolean {
  return Boolean(userId) && s.exporting && s.ownerId === userId;
}
