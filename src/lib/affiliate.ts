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
import { SITE_URL } from "@/lib/seo/site";
import { siteBadgeHtml } from "@/lib/proof-of-grade";

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
  /**
   * The id of THIS visitor's logged click, from POST /api/affiliate/click.
   * Redeem sends it so the edge stamps this visitor's own click (and pays the
   * share reward for the cert they actually landed on), not the newest click
   * on the code.
   */
  clickId?: string;
}

// A reload of the same ?ref= link inside this window sends no second click, so
// a seller testing their own link does not inflate their own funnel.
const REPING_MS = 30 * 60 * 1000;

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
    const clickId = typeof parsed.clickId === "string" ? parsed.clickId : undefined;
    return { code: parsed.code, ts: parsed.ts, pendingClick, clickId };
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

/**
 * Anonymous, fire-and-forget click ping. Never rejects. When the edge answers
 * with a click_id, it is parked on the stored ref (only if that ref is still
 * for the same code) so the later redeem can name this visitor's own click.
 */
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
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { click_id?: unknown } | null) => {
        const id = json?.click_id;
        if (typeof id !== "string") return;
        const stored = readStored();
        if (stored && stored.code === click.code) writeStored({ ...stored, clickId: id });
      })
      .catch(() => {});
  } catch {
    /* edge URL unconfigured in this env — skip the ping */
  }
}

/** Channels a ?utm_source= may name on a click. Anything else counts as "link". */
export const AFFILIATE_CLICK_SOURCES = [
  "badge",
  "certificate",
  "copy",
  "x",
  "facebook",
  "whatsapp",
  "email",
  "qr",
] as const;
export type AffiliateClickSource = (typeof AFFILIATE_CLICK_SOURCES)[number];

function clickSource(raw: string | null): string {
  return raw && (AFFILIATE_CLICK_SOURCES as readonly string[]).includes(raw) ? raw : "link";
}

/**
 * Drop ref from the address bar once it has been captured, so a reload or a
 * copied URL does not re-attribute. utm_source stays: analytics (PostHog after
 * consent, the UTM capture, nudge attribution) read it from the URL later.
 */
function stripRefParams(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("ref")) return;
    url.searchParams.delete("ref");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* history unavailable — leaving the params is harmless */
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

  let source = "link";
  try {
    source = clickSource(new URLSearchParams(window.location.search).get("utm_source"));
  } catch {
    /* ignore */
  }
  const path = window.location.pathname;
  stripRefParams();

  // The same code captured moments ago: keep the stored ref (and its click id)
  // and send no second click.
  const prior = readStored();
  if (prior && prior.code === code && Date.now() - prior.ts < REPING_MS) {
    return code;
  }

  // No pendingClick: this path CAN reach the edge, so the ping goes out now.
  writeStored({ code, ts: Date.now() });
  postClickPing({ code, source, path, referrer: safeReferrerHost() });

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

/**
 * The stored, non-expired earned-link code, or null. READ-ONLY — it never
 * clears, never pings and never redeems, so a caller can stamp attribution onto
 * something else (US-1843 parks it on the anonymous buyer claim) without
 * consuming the last-touch ref that redeemStoredAffiliateRef still needs at
 * sign-in.
 */
export function storedAffiliateRefCode(): string | null {
  const stored = readStored();
  if (!stored) return null;
  if (Date.now() - stored.ts > TTL_MS) return null;
  return stored.code;
}

/**
 * The stored click id for `code`, if this browser landed on that code's link.
 * Lets a typed-in redeem of the same code still name the visitor's own click.
 */
export function storedAffiliateClickId(code: string): string | null {
  const stored = readStored();
  if (!stored || stored.code !== code.trim().toUpperCase()) return null;
  if (Date.now() - stored.ts > TTL_MS) return null;
  return stored.clickId ?? null;
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
      json: {
        code: stored.code,
        source: "affiliate",
        ...(stored.clickId ? { click_id: stored.clickId } : {}),
      },
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
 * The one canonical referral link for a code, tagged with the channel it was
 * shared on, e.g. https://gradethread.com/signup?ref=ABCD2345&utm_source=x
 *
 * Built on SITE_URL, not window.location.origin, so a link copied on a
 * preview deploy or localhost still sends friends to the real site. Every
 * copy box, share button and badge on the referral page uses this.
 */
export function referralLink(code: string, channel: AffiliateClickSource): string {
  return `${SITE_URL}/signup?ref=${encodeURIComponent(code)}&utm_source=${channel}`;
}

/**
 * Copy-paste HTML for the "Graded by GradeThread" badge, for the seller's OWN
 * site or blog. Never for a marketplace listing: eBay hides a listing whose
 * description links off eBay, and FlipDesk strips exactly this link on publish.
 * The marketplace-safe lines live in proof-of-grade.ts.
 */
export function affiliateBadgeEmbed(code: string): string {
  return siteBadgeHtml(referralLink(code, "badge"));
}
