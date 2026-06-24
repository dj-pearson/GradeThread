import { create } from "zustand";

// Admin "view as" / impersonation state (US-581).
//
// When a super-admin impersonates a user the browser swaps its Supabase session
// for the target's. We keep a separate record of WHO is impersonating so:
//   • a persistent banner can render across every authed route, and
//   • the "Exit" button can restore the admin's session even after a reload.
//
// We store only a one-time, short-lived admin RESUME token (minted server-side)
// to restore the admin session on Exit — NEVER the admin's long-lived refresh
// token (US-581 hardening), so an XSS during impersonation can't lift a
// credential that mints admin sessions indefinitely.
//
// Persisted to sessionStorage (per-tab, cleared on tab close) rather than
// localStorage so the saved record doesn't outlive the browsing session.

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
  /**
   * One-time, short-lived magic-link token_hash minted server-side for the
   * admin. "Exit" redeems it (verifyOtp) to restore the admin session. Single-
   * use + short TTL — NOT the admin's long-lived refresh token.
   */
  adminResumeTokenHash: string;
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
