// GradeThread Verified — shared client helpers (handle validation + embed code).
//
// The embed snippets reference the canonical production origin (gradethread.com)
// so the HTML a seller copies works no matter where the dashboard is running.

import { SITE_URL } from "@/lib/seo/site";

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

/**
 * Certificate URL carrying a share-source param for attribution (US-769) — e.g.
 * `?s=embed` for badge clicks coming from an off-platform listing/site.
 */
export function certificateShareUrl(certId: string, source: string): string {
  return `${certificateUrl(certId)}?s=${source}`;
}

// Certificate ids are minted with crypto.randomUUID() (grading-pipeline.ts), so
// every public cert id is a UUID. Used by the buyer-facing /verify lookup to
// reject obvious junk before navigating to the certificate page.
const CERT_ID_RE =
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

// ── Status badges (US-1913) ──────────────────────────────────────────
// Every embed badge has two formats, chosen by the seller PER EMBED in Badge
// Studio: `plain` (what has always shipped) and `status`, which adds the
// seller's Grade Integrity tier, reward level and confirmed-accuracy share.
//
// Two params, doing two different jobs, and conflating them was the trap:
//   • `?status=1` on the IMAGE url tells the edge which artwork to render.
//   • `?v=status` on the LINK url tells the click funnel which format earned the
//     click. `?s=embed` is untouched (AC5) — the source still means where the
//     arrival came from, so status and plain badges stay comparable inside it.
export type BadgeVariant = "plain" | "status";

/** Append the click-funnel variant marker to an already-`?s=`-tagged share URL. */
function withVariant(shareUrl: string, variant: BadgeVariant): string {
  return variant === "status" ? `${shareUrl}&v=status` : shareUrl;
}

/** Read the click-funnel variant marker off a landing URL. Unknown ⇒ plain. */
export function parseBadgeVariant(raw: string | null | undefined): BadgeVariant {
  return raw === "status" ? "status" : "plain";
}

// The one-sentence explanations behind the two status marks a buyer sees on a
// certificate and on a verified profile (US-1913 AC2). They are DIFFERENT
// claims and the tooltips exist so nobody reads one as the other: a level is
// how much a seller does, a tier is how right they have been proven. Both
// surfaces have two renderers (SPA + Pages Function SSR); the SSR halves cannot
// import from src/, so they repeat these sentences verbatim and
// src/test/badge-status-parity.test.ts holds the four copies together.
export const INTEGRITY_TIER_BASIS =
  "Earned from buyers confirming, after delivery, that the grade matched. It only appears once enough buyers have confirmed.";
export const LEVEL_FLAIR_BASIS =
  "Earned from grading and selling activity on GradeThread. It measures how much a seller does, not how accurate their grades are.";

/** Per-listing badge image URL for a certificate id. */
export function certBadgeUrl(certId: string, variant: BadgeVariant = "plain"): string {
  const base = `${SITE_URL}/badge/cert/${certId}`;
  return variant === "status" ? `${base}?status=1` : base;
}

/**
 * HTML snippet for a single item's verified badge — for pasting into an eBay /
 * Poshmark / Mercari listing description. A plain linked image, no script, so
 * it survives marketplace HTML sanitizers. The click carries ?s=embed for
 * share-source attribution (US-769).
 */
export function certBadgeEmbedHtml(
  certId: string,
  variant: BadgeVariant = "plain",
): string {
  const href = withVariant(certificateShareUrl(certId, "embed"), variant);
  const img = certBadgeUrl(certId, variant);
  return (
    `<a href="${href}" target="_blank" rel="noopener">` +
    `<img src="${img}" alt="GradeThread Verified condition grade" ` +
    `width="350" height="90" style="max-width:100%;height:auto;border:0" />` +
    `</a>`
  );
}

/** Script src for the injectable badge widget (US-860). */
export function certBadgeScriptUrl(
  certId: string,
  variant: BadgeVariant = "plain",
): string {
  const base = `${SITE_URL}/embed/cert/${certId}`;
  return variant === "status" ? `${base}?status=1` : base;
}

/**
 * Script embed snippet (US-860). On a site that allows scripts (a personal
 * store, Shopify, a blog) this injects the linked verified badge inline — the
 * click carries ?s=embed (US-769). The image snippet (certBadgeEmbedHtml) is
 * the fallback for marketplaces that strip scripts. An iframe isn't offered:
 * the zone's anti-clickjacking headers (X-Frame-Options/frame-ancestors) block
 * cross-site framing of our own pages.
 */
export function certBadgeScriptEmbed(
  certId: string,
  variant: BadgeVariant = "plain",
): string {
  return `<script async src="${certBadgeScriptUrl(certId, variant)}"></script>`;
}

/**
 * Plain-text fallback (for marketplaces that strip HTML entirely).
 *
 * There is no status variant of this one on purpose: the status format is an
 * IMAGE the edge redraws on every request, which is what keeps the number on it
 * current. Baking a tier into text a seller pastes once would be the exact thing
 * AC3 forbids — a claim frozen at copy time, correctable only by re-pasting.
 */
export function certBadgeEmbedText(certId: string): string {
  return `✓ GradeThread Verified condition grade — verify: ${certificateShareUrl(certId, "embed")}`;
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

// ── Garment Passport badges (US-1759) ────────────────────────────────
// A passport advertises a garment's FULL public history (grades, listings,
// ownership hops) rather than a single grade. There is no passport image asset,
// so the passport badge is a link/text badge only — honest about what it is.

/** Public Garment Passport URL for a slug, e.g. https://gradethread.com/passport/ab12. */
export function passportUrl(slug: string): string {
  return `${SITE_URL}/passport/${slug}`;
}

/** Passport URL carrying a share-source param for attribution (mirrors certificateShareUrl). */
export function passportShareUrl(slug: string, source: string): string {
  return `${passportUrl(slug)}?s=${source}`;
}

/** HTML link badge advertising a garment's full verified history. */
export function passportBadgeEmbedHtml(slug: string): string {
  const href = passportShareUrl(slug, "embed");
  return (
    `<a href="${href}" target="_blank" rel="noopener" ` +
    `style="display:inline-block;background:#0C1E36;color:#fff;text-decoration:none;` +
    `padding:8px 16px;border-radius:999px;font:600 14px system-ui,sans-serif">` +
    `✓ GradeThread Verified history</a>`
  );
}

/** Plain-text passport badge (for marketplaces that strip HTML entirely). */
export function passportBadgeEmbedText(slug: string): string {
  return `✓ GradeThread Verified history — see the full record: ${passportShareUrl(slug, "embed")}`;
}

// ── Verified-seller storefront badge (US-1761) ───────────────────────
// A profile-level badge (keyed to the handle, not a single cert) advertising the
// seller's whole track record. The image is rendered on the edge and proxied by
// /badge/verified/:handle; the embed wraps it in a link to the public profile.

export type SellerBadgeFormat = "wide" | "compact" | "listing_header";

export interface SellerBadgeFormatOption {
  id: SellerBadgeFormat;
  label: string;
  width: number;
  height: number;
}

export const SELLER_BADGE_FORMAT_OPTIONS: SellerBadgeFormatOption[] = [
  { id: "wide", label: "Wide", width: 700, height: 180 },
  { id: "compact", label: "Compact", width: 520, height: 120 },
  { id: "listing_header", label: "Listing header", width: 1200, height: 240 },
];

/** Storefront badge image URL for a handle + size format. */
export function verifiedSellerBadgeUrl(
  handle: string,
  format: SellerBadgeFormat = "wide",
  variant: BadgeVariant = "plain",
): string {
  return (
    `${SITE_URL}/badge/verified/${handle}?format=${format}` +
    (variant === "status" ? "&status=1" : "")
  );
}

/**
 * HTML snippet for the verified-seller storefront badge — a linked image that
 * survives marketplace HTML sanitizers (no script). Links to the seller's public
 * profile with ?s=embed for attribution.
 */
export function verifiedSellerBadgeEmbedHtml(
  handle: string,
  format: SellerBadgeFormat = "wide",
  variant: BadgeVariant = "plain",
): string {
  const href = withVariant(profileShareUrl(handle, "embed"), variant);
  const img = verifiedSellerBadgeUrl(handle, format, variant);
  const opt = SELLER_BADGE_FORMAT_OPTIONS.find((o) => o.id === format) ??
    { id: "wide" as const, label: "Wide", width: 700, height: 180 };
  return (
    `<a href="${href}" target="_blank" rel="noopener">` +
    `<img src="${img}" alt="GradeThread Verified Seller" ` +
    `width="${opt.width}" height="${opt.height}" style="max-width:100%;height:auto;border:0" />` +
    `</a>`
  );
}

/** Plain-text storefront badge fallback (for marketplaces that strip HTML). */
export function verifiedSellerBadgeEmbedText(handle: string): string {
  return `✓ GradeThread Verified Seller — see my grades: ${profileShareUrl(handle, "embed")}`;
}

/** Profile URL carrying a share-source param (mirrors certificateShareUrl). */
export function profileShareUrl(handle: string, source: string): string {
  return `${profileUrl(handle)}?s=${source}`;
}

// ── Achievement badge cards (US-1850) ────────────────────────────────
// An earned medal renders as its own shareable card image, keyed only by the
// catalog key — the card describes the ACHIEVEMENT, so it is public and
// long-cacheable. Rendered on the edge, proxied by /badge/achievement/:key.

/** Shareable card image URL for an achievement badge key. */
export function achievementBadgeUrl(key: string): string {
  return `${SITE_URL}/badge/achievement/${key}`;
}

// ── Badge Studio: per-marketplace snippet guidance (US-1759) ──────────
// Marketplaces differ in what HTML they allow in a listing description. The
// studio surfaces the RIGHT format for each: eBay renders a whitelist of HTML
// (a linked image survives, a script does not); Poshmark / Grailed / Mercari /
// Depop strip all HTML, so only a text+link works there; a seller's own store
// or blog can run the script widget.

export type BadgeFormatId = "image" | "script" | "text";

export interface BadgeFormat {
  id: BadgeFormatId;
  label: string;
  /** One-line description of the format + where to use it. */
  hint: string;
  /** Marketplaces / surfaces this format is the right choice for. */
  worksOn: string[];
}

export const BADGE_FORMATS: BadgeFormat[] = [
  {
    id: "image",
    label: "Image badge (HTML)",
    hint: "A linked badge image. Survives eBay's HTML whitelist (no script).",
    worksOn: ["eBay", "Your website", "Blog / Shopify"],
  },
  {
    id: "script",
    label: "Script embed",
    hint: "Auto-injects the live badge. Only where scripts run — not marketplaces.",
    worksOn: ["Your website", "Shopify", "Blog"],
  },
  {
    id: "text",
    label: "Text + link",
    hint: "Plain text with a verify link. Use where HTML is stripped.",
    worksOn: ["Poshmark", "Grailed", "Mercari", "Depop"],
  },
];
