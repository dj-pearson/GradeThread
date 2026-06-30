import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";

// Web-only idle auto-logout.
//
// GoTrue session policy is global (one instance serves web + iOS), so we keep
// the SERVER session long-lived for iOS and shorten the WEB session here, on the
// client — a browser is more often a shared / switched-user device. After 12h
// with no interaction the tab signs itself out.
//
// IMPORTANT: signOut uses `scope: "local"` so it clears ONLY this browser and
// never revokes the iOS (or any other device's) session — supabase-js defaults
// to `scope: "global"`, which would log the user out everywhere.

const IDLE_MS = 12 * 60 * 60 * 1000; // 12 hours
const STORAGE_KEY = "gt_last_activity";
// Persist at most this often so a mousemove storm doesn't thrash localStorage.
const ACTIVITY_THROTTLE_MS = 30_000;
// Re-evaluate idle on this cadence.
const CHECK_INTERVAL_MS = 60_000;

let initialized = false;
let lastPersist = 0;

function readLastActivity(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? n : Date.now();
  } catch {
    return Date.now();
  }
}

function markActivity(force = false): void {
  const t = Date.now();
  if (!force && t - lastPersist < ACTIVITY_THROTTLE_MS) return;
  lastPersist = t;
  try {
    localStorage.setItem(STORAGE_KEY, String(t));
  } catch {
    /* private mode / storage disabled — idle logout simply won't fire */
  }
}

function isSignedIn(): boolean {
  return !!useAuthStore.getState().session;
}

async function signOutIdle(): Promise<void> {
  try {
    // Local scope only — must NOT revoke the iOS / other-device sessions.
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    /* onAuthStateChange still resets the store even if the network call fails */
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  toast.info("Signed out after 12 hours of inactivity. Sign in again to continue.");
}

function check(): void {
  if (!isSignedIn()) return;
  if (Date.now() - readLastActivity() >= IDLE_MS) {
    void signOutIdle();
  }
}

/**
 * Starts the web idle-logout watcher. Safe to call repeatedly — it only wires up
 * once per page lifetime. No-op outside the browser (SSR/prerender).
 */
export function initIdleLogout(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  // A fresh load is itself an interaction. But if a session was restored after
  // the tab sat closed past the idle window, sign out immediately. (When the
  // session hasn't hydrated into the store yet, the interval check below catches
  // it within a minute.)
  if (isSignedIn() && Date.now() - readLastActivity() >= IDLE_MS) {
    void signOutIdle();
  } else {
    markActivity(true);
  }

  const onActivity = () => markActivity();
  const events: Array<keyof WindowEventMap> = [
    "pointerdown",
    "keydown",
    "scroll",
    "touchstart",
    "mousemove",
  ];
  for (const ev of events) {
    window.addEventListener(ev, onActivity, { passive: true });
  }
  // Returning focus to the tab counts as activity and forces a fresh check.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      markActivity(true);
      check();
    }
  });

  window.setInterval(check, CHECK_INTERVAL_MS);
}
