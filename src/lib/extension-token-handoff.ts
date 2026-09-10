// US-3296: keep the browser extension's account token alive without anybody
// pressing anything.
//
// THE BUG. mintExtensionToken issues 30 days, and the ONLY place it was ever
// handed to the extension was /connect-extension, from a button a seller
// presses once. Nothing re-minted it: no refresh on expiry, no re-handoff on
// sign-in, no warning as the end approached. So every connected seller silently
// dropped to the anonymous entitlements about a month after connecting, and
// every Lister action failed from then on. US-3295 made that failure say the
// right words; it did not stop the failure. The seller who found it was on
// Business and was being told to buy a plan.
//
// TWO HALVES, and they cover different holes:
//
//   this file  — the SaaS re-hands a fresh token whenever a signed-in seller
//                has a gradethread.com tab open and the stored token is missing
//                or near its end. Works from a cold start, because minting
//                needs a Supabase session and only the web app has one.
//
//   the edge   — POST /api/grading/public/extension-token/renew, which the
//                extension calls for itself (background.js renewTokenIfNeeded).
//                That is the half that saves a browser closed straight through
//                the expiry, where no tab is open to do the above.
//
// Neither is redundant. A seller who never opens gradethread.com is carried by
// the extension's own renewal; a seller whose token died past the grace window
// is carried by this one.

import { edgeFetch } from "@/lib/edge-fetch";
import {
  isExtensionInstalled,
  sendExtensionMessage,
  type ExtensionResponse,
} from "@/lib/lister-extension";

/**
 * What the extension says about its stored token. `null` for a build old
 * enough not to report one, which must read as "unknown", never as "fine" —
 * an install that cannot say when its token dies is exactly the install that
 * has been quietly anonymous for a month.
 */
export type ExtensionTokenStatus = "none" | "active" | "expiring" | "expired";

export interface ExtensionTokenSnapshot {
  status: ExtensionTokenStatus | null;
  expiresAt: string | null;
}

/** Read a ping answer into the token facts, tolerating every older build. */
export function tokenSnapshotFrom(
  pong: ExtensionResponse | null | undefined,
): ExtensionTokenSnapshot {
  const raw = pong?.tokenStatus;
  const status: ExtensionTokenStatus | null =
    raw === "none" || raw === "active" || raw === "expiring" || raw === "expired"
      ? raw
      : null;
  const expiresAt = typeof pong?.tokenExpiresAt === "string" ? pong.tokenExpiresAt : null;
  return { status, expiresAt };
}

/**
 * Does this snapshot want a fresh token handed to it?
 *
 * YES for every state except a comfortably-live one, and the default direction
 * is the point: an unknown status means an older build that has never told
 * anyone when its token ends, and re-handing one costs a single request the
 * seller never sees. Getting this backwards is how the original bug survived a
 * year — nothing ever decided the token needed replacing, so nothing did.
 */
export function needsFreshToken(snap: ExtensionTokenSnapshot): boolean {
  return snap.status !== "active";
}

/**
 * Mint a token for the signed-in account and hand it to the extension.
 *
 * Throws nothing: every failure resolves to `false`. This runs in the
 * background of an ordinary page load, so a hiccup must never surface as a
 * toast, an error boundary or a blocked render.
 */
export async function handOffExtensionToken(): Promise<boolean> {
  try {
    const res = await edgeFetch("/api/buyer/extension-token", {
      method: "POST",
      silentGate: true,
    });
    if (!res.ok) return false;
    const { token } = (await res.json()) as { token?: string };
    if (!token) return false;
    const pong = await sendExtensionMessage<ExtensionResponse>({
      type: "GT_SET_TOKEN",
      token,
    });
    return pong?.ok === true;
  } catch {
    return false;
  }
}

/**
 * How long to leave the extension alone between checks, per browser.
 *
 * The ping is cheap and the mint is not free, so this is not about load — it is
 * about a page that re-mounts on every navigation not minting a token on every
 * navigation. Six hours is far inside the 7-day renewal window, so a token can
 * never expire between two checks by a browser that is being used at all.
 */
export const HANDOFF_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "gt_ext_token_check_at";

export function shouldCheckNow(lastCheckedAt: number | null, now: number): boolean {
  if (lastCheckedAt === null || !Number.isFinite(lastCheckedAt)) return true;
  // A clock that moved backwards (timezone change, a stale value from another
  // profile) must not lock the check out for six hours.
  if (lastCheckedAt > now) return true;
  return now - lastCheckedAt >= HANDOFF_CHECK_INTERVAL_MS;
}

function readLastCheck(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_CHECK_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

function writeLastCheck(now: number): void {
  try {
    window.localStorage.setItem(LAST_CHECK_KEY, String(now));
  } catch {
    /* private mode / storage disabled — we just check again next load */
  }
}

export type EnsureOutcome =
  | "not-installed"
  | "throttled"
  | "unreachable"
  | "fresh"
  | "handed-off"
  | "failed";

/**
 * The whole of AC1: ask the extension how its token is doing and re-hand a new
 * one if it needs it. Silent, never throws, never blocks a render.
 *
 * Note what is NOT consulted: the account's plan. Whether a token should be
 * replaced is a question about a clock, and mixing the plan into it is how the
 * two got confused in the first place.
 */
export async function ensureExtensionTokenFresh(
  opts: { force?: boolean; now?: number } = {},
): Promise<EnsureOutcome> {
  if (!isExtensionInstalled()) return "not-installed";
  const now = opts.now ?? Date.now();
  if (!opts.force && !shouldCheckNow(readLastCheck(), now)) return "throttled";
  writeLastCheck(now);

  let pong: ExtensionResponse | null = null;
  try {
    pong = await sendExtensionMessage<ExtensionResponse>({ type: "GT_PING" });
  } catch {
    return "unreachable";
  }
  if (!pong || pong.ok === false) return "unreachable";

  if (!needsFreshToken(tokenSnapshotFrom(pong))) return "fresh";
  return (await handOffExtensionToken()) ? "handed-off" : "failed";
}
