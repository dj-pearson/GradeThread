// US-603: affiliate / earned-link attribution (client side).
//
// A "Graded by GradeThread" badge or earned link points at the site with a
// ?ref=<code> query param. On first landing we:
//   1. capture the code into localStorage (last-touch, with a TTL window), and
//   2. fire an anonymous click ping so the code's owner sees their funnel.
// When that visitor later signs in (email confirm or OAuth), redeemStored()
// attributes the referral with source='affiliate'. The redeem endpoint is the
// single source of truth for the guards (self-referral, already-redeemed,
// suspended) — this just forwards a stored code once.

import { edgeApiUrl } from "@/lib/edge-api";
import { edgeFetch } from "@/lib/edge-fetch";

const STORAGE_KEY = "gt_affiliate_ref";
// Last-touch attribution window. A ?ref= older than this is ignored at redeem
// time so a stale code can't silently attribute a much later, unrelated signup.
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// US-2108 AC2: a click that was captured on a STANDALONE SSR page (cert, blog,
// verified, passport — see functions/_shared/affiliate-capture.ts) parks its
// ping payload here instead of sending it. Those pages don't mount the SPA and
// their CSP has no connect-src for the edge API, so the ping waits for a page
// that can make the call. Absent on a ref captured by captureAffiliateRef(),
// which sends immediately.
interface PendingClick {
  source: string;
  path: string;
  referrer: string | null;
}

interface StoredRef {
  code: string;
  ts: number;
  pendingClick?: PendingClick;
}

function readStored(): StoredRef | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredRef>;
    if (typeof parsed.code !== "string" || typeof parsed.ts !== "number") return null;
    const p = parsed.pendingClick;
    const pendingClick =
      p && typeof p.source === "string" && typeof p.path === "string"
        ? {
            source: p.source,
            path: p.path,
            referrer: typeof p.referrer === "string" ? p.referrer : null,
          }
        : undefined;
    return { code: parsed.code, ts: parsed.ts, pendingClick };
  } catch {
    return null;
  }
}

function writeStored(ref: StoredRef): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ref));
  } catch {
    /* storage unavailable — attribution degrades to this-tab only */
  }
}

/** Anonymous, fire-and-forget click ping. Never rejects. */
function postClickPing(click: PendingClick & { code: string }): void {
  try {
    void fetch(`${edgeApiUrl()}/api/affiliate/click`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        code: click.code,
        source: click.source,
        path: click.path,
        referrer: click.referrer,
      }),
    }).catch(() => {});
  } catch {
    /* edge URL unconfigured in this env — skip the ping */
  }
}

export function clearStoredAffiliateRef(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/**
 * Read ?ref= off the current URL. If present, store it (last-touch) and fire an
 * anonymous click ping. Safe to call on every app load — it no-ops when there's
 * no ref param. Returns the captured code (or null).
 */
export function captureAffiliateRef(): string | null {
  if (typeof window === "undefined") return null;
  let code: string;
  try {
    const params = new URLSearchParams(window.location.search);
    code = (params.get("ref") ?? "").trim().toUpperCase();
  } catch {
    return null;
  }
  if (!code || code.length > 32) return null;

  // No pendingClick: this path CAN reach the edge, so the ping goes out now.
  writeStored({ code, ts: Date.now() });

  // Anonymous, fire-and-forget click ping. utm_source=badge → 'badge', else 'link'.
  let source = "link";
  try {
    const src = new URLSearchParams(window.location.search).get("utm_source");
    if (src === "badge" || src === "certificate") source = src;
  } catch {
    /* ignore */
  }
  postClickPing({
    code,
    source,
    path: window.location.pathname,
    referrer: safeReferrerHost(),
  });

  return code;
}

/**
 * US-2108 AC2: send the click ping for a ref banked by a standalone SSR page.
 *
 * Safe to call on every app load — it no-ops unless a stored ref carries a
 * parked `pendingClick`. Single-shot: the marker is cleared BEFORE the request
 * goes out, so a failed ping is dropped rather than retried on every subsequent
 * page load (an affiliate's click count that inflates while the visitor browses
 * would be worse than one missed click). Expired refs are dropped with their
 * ping, since redeem would ignore them anyway.
 *
 * Returns true if a ping was sent.
 */
export function flushPendingAffiliateClick(): boolean {
  const stored = readStored();
  if (!stored?.pendingClick) return false;
  if (Date.now() - stored.ts > TTL_MS) {
    clearStoredAffiliateRef();
    return false;
  }
  const { pendingClick, ...rest } = stored;
  writeStored(rest);
  postClickPing({ code: stored.code, ...pendingClick });
  return true;
}

function safeReferrerHost(): string | null {
  try {
    if (!document.referrer) return null;
    return new URL(document.referrer).host || null;
  } catch {
    return null;
  }
}

/**
 * If a non-expired ?ref= was captured earlier, attribute the signed-in caller as
 * referred through the affiliate channel. Single-shot: clears the stored ref
 * after the attempt regardless of outcome (the endpoint is idempotent — an
 * already-redeemed / self-referral caller is a harmless 4xx). Returns true if a
 * redeem was attempted.
 */
export async function redeemStoredAffiliateRef(): Promise<boolean> {
  const stored = readStored();
  if (!stored) return false;
  if (Date.now() - stored.ts > TTL_MS) {
    clearStoredAffiliateRef();
    return false;
  }
  try {
    await edgeFetch("/api/referrals/redeem", {
      method: "POST",
      json: { code: stored.code, source: "affiliate" },
      silentGate: true,
    });
  } catch {
    /* network/auth hiccup — drop it; affiliate attribution is best-effort */
  } finally {
    clearStoredAffiliateRef();
  }
  return true;
}

/**
 * The shareable earned link for a code, e.g.
 *   https://gradethread.com/?ref=ABCD2345&utm_source=badge
 */
export function affiliateLink(code: string, source: "badge" | "link" = "link"): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://gradethread.com";
  return `${origin}/?ref=${encodeURIComponent(code)}&utm_source=${source}`;
}

/**
 * Copy-paste HTML for the "Graded by GradeThread" earned-link badge. Self-
 * contained inline-styled anchor — works in marketplace/site listings.
 */
export function affiliateBadgeEmbed(code: string): string {
  const href = affiliateLink(code, "badge");
  return [
    `<a href="${href}" target="_blank" rel="noopener"`,
    `   style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;`,
    `          border-radius:9999px;background:#0F3460;color:#fff;font:600 13px/1 Inter,Arial,sans-serif;`,
    `          text-decoration:none;">`,
    `  ✓ Graded by GradeThread`,
    `</a>`,
  ].join("\n");
}
