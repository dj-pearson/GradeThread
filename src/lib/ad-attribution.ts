// US-1700: client-side ad click-id capture.
//
// On an inbound visit we read Google's click ids (gclid / gbraid / wbraid) from
// the URL query, store the first-party (localStorage) with a timestamp, and — once
// the visitor authenticates — POST it to /api/ads/attribution so the click links
// to the converting user. Click ids are opaque identifiers, NOT PII, and never
// leave first-party storage except that one authenticated call.

const STORAGE_KEY = "gt_ad_attribution";
const MAX_CLICK_ID_LEN = 512;

/** URL params we capture → the ad platform they belong to. */
export const CLICK_ID_PARAMS: Record<string, string> = {
  gclid: "google_ads",
  gbraid: "google_ads",
  wbraid: "google_ads",
};

export interface StoredAttribution {
  clickId: string;
  clickIdType: string;
  platform: string;
  landingAt: string;
  /** True once it's been POSTed to the server for the signed-in user. */
  persisted: boolean;
}

function readStore(): StoredAttribution | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredAttribution>;
    if (typeof v.clickId === "string" && typeof v.clickIdType === "string" && typeof v.platform === "string") {
      return {
        clickId: v.clickId,
        clickIdType: v.clickIdType,
        platform: v.platform,
        landingAt: typeof v.landingAt === "string" ? v.landingAt : "",
        persisted: v.persisted === true,
      };
    }
  } catch { /* corrupt / unavailable */ }
  return null;
}

function writeStore(a: StoredAttribution): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(a));
  } catch { /* storage unavailable (private mode / SSR) */ }
}

export function getStoredAttribution(): StoredAttribution | null {
  return readStore();
}

export function markAttributionPersisted(): void {
  const a = readStore();
  if (a && !a.persisted) writeStore({ ...a, persisted: true });
}

/** Normalize a raw click id — trim + length-bound; null when empty/oversized. */
export function normalizeClickId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > MAX_CLICK_ID_LEN) return null;
  return v;
}

/**
 * Capture a click id from the URL query into first-party storage. A fresh click
 * id (new landing) replaces any stored one and resets `persisted`. Returns the
 * current stored attribution (existing one when no new click id is present).
 * `search` is injectable for testing; defaults to the live location.
 */
export function captureClickIds(
  search: string = typeof window !== "undefined" ? window.location.search : "",
  nowIso: string = new Date().toISOString(),
): StoredAttribution | null {
  const params = new URLSearchParams(search);
  for (const [param, platform] of Object.entries(CLICK_ID_PARAMS)) {
    const clickId = normalizeClickId(params.get(param));
    if (clickId) {
      const attr: StoredAttribution = {
        clickId,
        clickIdType: param,
        platform,
        landingAt: nowIso,
        persisted: false,
      };
      writeStore(attr);
      return attr;
    }
  }
  return readStore();
}
