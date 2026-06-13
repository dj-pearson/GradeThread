// GradeThread Verified — shared client helpers (handle validation + embed code).
//
// The embed snippets reference the canonical production origin (gradethread.com)
// so the HTML a seller copies works no matter where the dashboard is running.

import { SITE_URL } from "@/lib/seo/public-routes";

// Keep in lockstep with the edge (verified.ts) + DB CHECK (migration 00057).
export const HANDLE_RE = /^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$/;

export type HandleValidation = { ok: true } | { ok: false; reason: string };

/** Validate a (lowercased) handle against the shared format rules. */
export function validateHandle(raw: string): HandleValidation {
  const handle = raw.trim().toLowerCase();
  if (handle.length < 3 || handle.length > 30) {
    return { ok: false, reason: "Handle must be 3–30 characters." };
  }
  if (!HANDLE_RE.test(handle)) {
    return {
      ok: false,
      reason:
        "Lowercase letters, numbers and hyphens only — no leading or trailing hyphen.",
    };
  }
  return { ok: true };
}

/** Public profile URL for a handle, e.g. https://gradethread.com/verified/jane. */
export function profileUrl(handle: string): string {
  return `${SITE_URL}/verified/${handle}`;
}

/** Certificate URL for a certificate id. */
export function certificateUrl(certId: string): string {
  return `${SITE_URL}/cert/${certId}`;
}

// Certificate ids are minted with crypto.randomUUID() (grading-pipeline.ts), so
// every public cert id is a UUID. Used by the buyer-facing /verify lookup to
// reject obvious junk before navigating to the certificate page.
export const CERT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract a certificate id from raw buyer input (US-593). Accepts either a bare
 * certificate id or a full certificate URL of ANY origin — e.g. what a buyer
 * pastes after scanning a QR or copying a link: `https://gradethread.com/cert/<id>?s=qr`.
 * Query string, hash, and surrounding whitespace are stripped. Returns the
 * lowercased id, or null when no valid certificate id is present (the caller
 * shows an error rather than navigating to a guaranteed 404).
 */
export function parseCertificateRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Pull the id out of a /cert/<id> URL or path, else treat the whole input as
  // the candidate. Then drop any trailing query/hash/whitespace from a paste.
  const urlMatch = trimmed.match(/\/cert\/([^/?#\s]+)/i);
  const candidate = (urlMatch?.[1] ?? trimmed).split(/[?#\s]/)[0] ?? "";
  const token = candidate.trim().toLowerCase();
  return CERT_ID_RE.test(token) ? token : null;
}

/** Per-listing badge image URL for a certificate id. */
export function certBadgeUrl(certId: string): string {
  return `${SITE_URL}/badge/cert/${certId}`;
}

/**
 * HTML snippet for a single item's verified badge — for pasting into an eBay /
 * Poshmark / Mercari listing description. A plain linked <img>, no script, so
 * it survives marketplace HTML sanitizers.
 */
export function certBadgeEmbedHtml(certId: string): string {
  const href = certificateUrl(certId);
  const img = certBadgeUrl(certId);
  return (
    `<a href="${href}" target="_blank" rel="noopener">` +
    `<img src="${img}" alt="GradeThread Verified condition grade" ` +
    `width="350" height="90" style="max-width:100%;height:auto;border:0" />` +
    `</a>`
  );
}

/** Plain-text fallback (for marketplaces that strip HTML entirely). */
export function certBadgeEmbedText(certId: string): string {
  return `✓ GradeThread Verified condition grade — verify: ${certificateUrl(certId)}`;
}

/** HTML snippet linking to the seller's whole verified profile. */
export function profileLinkEmbedHtml(handle: string): string {
  const href = profileUrl(handle);
  return (
    `<a href="${href}" target="_blank" rel="noopener" ` +
    `style="display:inline-block;background:#0C1E36;color:#fff;text-decoration:none;` +
    `padding:8px 16px;border-radius:999px;font:600 14px system-ui,sans-serif">` +
    `✓ GradeThread Verified Seller</a>`
  );
}
