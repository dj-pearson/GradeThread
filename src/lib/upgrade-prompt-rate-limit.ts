import type { UpgradeReason } from "@/stores/upgrade-dialog-store";

// ── Upgrade-prompt rate limiting (US-1289) ──────────────────────
//
// The hard 402 upgrade dialog (UpgradeRequiredDialog) is the contextual
// prompt shown when a plan cap / credit limit is hit mid-flow. Without a
// throttle, a user who keeps retrying the blocked action gets the heavy modal
// re-popped on every 402 — nagging, not helpful. This module gates the modal
// to at most once per cooldown window per (cap/feature) subject; subsequent
// 402s within the window fall back to a lightweight, dismissible toast
// reminder instead (see edge-fetch.ts). Pure + storage-injectable so the
// policy is unit-testable with no DOM.

export const UPGRADE_PROMPT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/** Minimal get/set storage abstraction (localStorage in the browser). */
export interface PromptRateStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

// Falls back to an in-memory map when localStorage is unavailable (private
// mode / SSR) so the cooldown still works within the session.
const memoryStore: Record<string, string> = {};

function defaultStore(): PromptRateStore {
  return {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return memoryStore[key] ?? null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        memoryStore[key] = value;
      }
    },
  };
}

/**
 * Stable key for a prompt subject, scoped by user so a shared browser doesn't
 * leak one account's cooldown onto another.
 */
export function upgradePromptKey(
  reason: UpgradeReason,
  scope?: string | null,
): string {
  const subject =
    reason.type === "cap" ? `cap:${reason.kind}` : `feature:${reason.feature}`;
  return `gt_upgrade_prompt_${scope ?? "anon"}_${subject}`;
}

/** True when the prompt for `key` was last shown within the cooldown window. */
export function isUpgradePromptRateLimited(
  key: string,
  now: number,
  cooldownMs: number = UPGRADE_PROMPT_COOLDOWN_MS,
  store: PromptRateStore = defaultStore(),
): boolean {
  const raw = store.get(key);
  if (!raw) return false;
  const last = Number.parseInt(raw, 10);
  if (!Number.isFinite(last)) return false;
  return now - last < cooldownMs;
}

/** Stamp the prompt for `key` as shown at `now`. */
export function recordUpgradePromptShown(
  key: string,
  now: number,
  store: PromptRateStore = defaultStore(),
): void {
  store.set(key, String(now));
}
