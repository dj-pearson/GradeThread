import { create } from "zustand";

// The in-flight account ZIP export (Settings > Data). It lives in a store
// rather than in DataSettingsTab's useState because the Settings page
// unmounts a tab when the user switches away: a component flag came back as
// `false` while the first export was still building, so the button re-enabled
// and a second click started a second export alongside it.

interface AccountExportState {
  exporting: boolean;
  stage: string;
  pct: number;
  /** Claims the export slot. Returns false when one is already running. */
  begin: () => boolean;
  progress: (stage: string, pct: number) => void;
  finish: () => void;
}

const IDLE = { exporting: false, stage: "", pct: 0 };

export const useAccountExportStore = create<AccountExportState>((set, get) => ({
  ...IDLE,
  begin: () => {
    if (get().exporting) return false;
    set({ exporting: true, stage: "Starting…", pct: 0 });
    return true;
  },
  progress: (stage, pct) => set({ exporting: true, stage, pct }),
  finish: () => set(IDLE),
}));
