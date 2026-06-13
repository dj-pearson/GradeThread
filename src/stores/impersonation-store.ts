import { create } from "zustand";

// Admin "view as" / impersonation state (US-581).
//
// When a super-admin impersonates a user the browser swaps its Supabase session
// for the target's. We keep a separate record of WHO is impersonating (and the
// admin's own tokens) so:
//   • a persistent banner can render across every authed route, and
//   • the "Exit" button can restore the admin's session even after a reload.
//
// Persisted to sessionStorage (per-tab, cleared on tab close) rather than
// localStorage so the saved admin tokens don't outlive the browsing session.

const STORAGE_KEY = "gt.impersonation";

export interface ImpersonationTarget {
  id: string;
  email: string;
  name: string | null;
}

export interface ImpersonationRecord {
  target: ImpersonationTarget;
  adminUserId: string;
  adminEmail: string | null;
  /** Admin's own tokens, stashed so "Exit" can restore the session. */
  adminAccessToken: string;
  adminRefreshToken: string;
  startedAt: string;
}

interface ImpersonationState {
  record: ImpersonationRecord | null;
  begin: (record: ImpersonationRecord) => void;
  clear: () => void;
}

function loadInitial(): ImpersonationRecord | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ImpersonationRecord;
  } catch {
    return null;
  }
}

function persist(record: ImpersonationRecord | null) {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (record) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // sessionStorage can throw in private-mode / quota cases — non-fatal.
  }
}

export const useImpersonationStore = create<ImpersonationState>((set) => ({
  record: loadInitial(),
  begin: (record) => {
    persist(record);
    set({ record });
  },
  clear: () => {
    persist(null);
    set({ record: null });
  },
}));
