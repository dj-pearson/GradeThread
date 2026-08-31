// US-1126: verified-seller credential block for listing descriptions (PURE).
//
// A publicly-verified seller's accumulated, independently-certified grades are
// the trust signal that differentiates them from a plain marketplace seller.
// This module turns that signal into a buyer-facing block (total graded, average
// grade, a text-only "verify at GradeThread" pointer — NEVER a link/URL, see
// buildSellerCredentialBlock) that AutoLister embeds into the listing /
// cross-listing description.
//
// PURE (no I/O) so it's unit-tested directly; the impure loader that enforces
// eligibility + pulls the stats lives in seller-credentials-job.ts. No PII beyond
// what already lives on the PUBLIC verified profile (handle, display name,
// aggregate grade stats) is ever emitted.

export const DEFAULT_SITE = "https://gradethread.com";

/**
 * The HTML comment that anchors the credential block inside a listing
 * description. Injected by ai-listing.ts; kept in lockstep with the web mirror
 * (src/lib/listing-templates.ts SELLER_CREDENTIALS_MARKER).
 */
export const SELLER_CREDENTIALS_MARKER = "<!--gradethread-seller-credentials-->";

export interface SellerCredentialStats {
  total_graded: number;
  average_grade: number;
}

export interface SellerCredential {
  handle: string;
  display_name: string | null;
  stats: SellerCredentialStats;
}

export interface SellerCredentialBlock {
  plain: string;
  markdown: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Pure: render the verified-seller credential block in plain/markdown/html. The
 * stats line is only shown when the seller has at least one certified grade; the
 * verified badge always appears (the caller has already confirmed the seller is
 * publicly verified and opted in). No I/O — unit-tested.
 *
 * eBay-policy: NO LINKS, NO URLS in any variant. Every consumer of this block
 * is a marketplace listing description, and eBay treats an off-eBay URL in the
 * description as "offering to buy/sell outside eBay" and HIDES the listing
 * (observed policy hit, ref 2-106523659851 — same rule that keeps cert URLs
 * out, see applyGradeListingPromotion). Other marketplaces (Poshmark, Mercari)
 * prohibit external links too. The trust signal is the brand + handle + stats
 * as plain text; buyers find the profile by searching the seller handle. The
 * `siteUrl` parameter is retained so callers don't churn, but it no longer
 * appears in any output.
 */
export function buildSellerCredentialBlock(
  cred: SellerCredential,
  _siteUrl: string = DEFAULT_SITE,
): SellerCredentialBlock {
  const name = cred.display_name?.trim() || cred.handle;
  const { total_graded, average_grade } = cred.stats;
  const hasStats = total_graded > 0;
  const avg = average_grade.toFixed(1);
  const gradedLabel = `${total_graded} ${total_graded === 1 ? "item" : "items"}`;
  // Text-only pointer — a search phrase, never a URL.
  const verifyLine = `Verify grades at GradeThread — seller "${cred.handle}"`;

  // ── Plain text ──────────────────────────────────────────────────
  const plainLines: string[] = [];
  plainLines.push("GradeThread Verified Seller");
  plainLines.push(name);
  if (hasStats) {
    plainLines.push(
      `${gradedLabel} independently graded • Average condition grade ${avg} / 10`,
    );
  }
  plainLines.push(verifyLine);
  const plain = plainLines.join("\n");

  // ── Markdown ────────────────────────────────────────────────────
  const mdLines: string[] = [];
  mdLines.push(`**GradeThread Verified Seller — ${name}**`);
  if (hasStats) {
    mdLines.push(
      `${gradedLabel} independently graded · **${avg} / 10** average condition grade`,
    );
  }
  mdLines.push(verifyLine);
  const markdown = mdLines.join("\n\n");

  // ── HTML (for listing descriptions that render HTML, e.g. eBay) ──
  const htmlParts: string[] = [];
  htmlParts.push(
    `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;font:14px/1.5 system-ui,sans-serif">`,
  );
  htmlParts.push(
    `<div style="font-weight:700;color:#0F3460;margin-bottom:6px">✓ GradeThread Verified Seller — ${escapeHtml(name)}</div>`,
  );
  if (hasStats) {
    htmlParts.push(
      `<div style="margin-bottom:8px">${escapeHtml(gradedLabel)} independently graded · <strong>${escapeHtml(avg)} / 10</strong> average condition grade</div>`,
    );
  }
  htmlParts.push(
    `<div style="color:#0F3460;font-weight:600">${escapeHtml(verifyLine)}</div>`,
  );
  htmlParts.push(`</div>`);
  const html = htmlParts.join("");

  return { plain, markdown, html };
}

// ══════════════════════════════════════════════════════════════════
// US-2272: in-place refresh of an ALREADY-PUBLISHED block
// ══════════════════════════════════════════════════════════════════
//
// The block is rendered once, at draft time, and then frozen in the live eBay
// description — so a seller's 13th listing still advertises "13 items graded"
// after they've graded 19. eBay bans active content in descriptions (no script,
// no iframe, no remote include), so there is no live-updating embed: the only
// compliant fix is to REVISE the description, which the credentials-refresh
// cron does (routes/jobs-credentials-refresh.ts).
//
// Locating the block is the delicate part. The marker is appended before the
// grade/cert line (applyGradeListingPromotion runs after AutoLister), so a
// published description reads:
//
//   <body copy>
//   <!--gradethread-disclosure--><div>…</div>
//   <!--gradethread-seller-credentials--><div>…</div>
//
//   Graded by GradeThread — Condition Grade 7.9 — Cert #GT-X9RQ0J6
//
// "Everything after the marker" (what the web mirror's splitSellerCredentials
// does, safely, on an UNPUBLISHED draft) would swallow that cert line. So we
// walk <div> depth from the marker and replace exactly the one element.

/** Bounds of the credential block's outer <div>, marker excluded. */
export interface SellerCredentialBlockSpan {
  /** Index of the opening `<div` of the block. */
  start: number;
  /** Index one past the block's matching `</div>`. */
  end: number;
  /** The block markup currently occupying [start, end). */
  html: string;
}

/** Cap the tag walk so a truncated/malformed description can't spin. */
const MAX_TAG_SCAN = 500;

/**
 * Why the walk could not produce a span.
 *
 * `absent` is the ONLY benign one: the description never carried a block, and
 * leaving it alone is correct. The other three mean the description almost
 * certainly DOES carry a badge that the walk cannot parse — a stale count a
 * buyer is reading right now, on a listing the refresh cron skips every run.
 */
export type CredentialBlockReason =
  /** No marker comment anywhere in the description. */
  | "absent"
  /** Marker present, but the next thing after it is not a `<div>`. */
  | "no-element"
  /** A `<div>` opened after the marker and never closed. */
  | "unclosed"
  /** More than MAX_TAG_SCAN `div` tags before the block closed. */
  | "scan-limit";

/** The walk's full answer: the span, or the reason there isn't one. */
export type CredentialBlockLookup =
  | { found: true; span: SellerCredentialBlockSpan }
  | { found: false; reason: CredentialBlockReason };

/**
 * Pure: locate the credential block that follows the marker, and say why when
 * it cannot be found.
 *
 * US-3028. `findSellerCredentialBlock` collapses four situations into one
 * `null`, and the refresh cron counted all four as `no_block` — "this listing
 * never had a badge, leave it alone". Three of them are the opposite: the badge
 * is there, the walk failed, and the listing is skipped forever with no error
 * and no log line. Distinguishing them is a diagnosis, not a behaviour change:
 * every caller's response to a failed walk is still to leave the description
 * exactly as it is.
 *
 * `marker` is a parameter (US-2628) because the disclosure block is generated
 * the same way, marker comment then one <div>, and cert-description.ts strips
 * both. The walk is the delicate part; there should be one of it.
 */
export function locateSellerCredentialBlock(
  description: string,
  marker: string = SELLER_CREDENTIALS_MARKER,
): CredentialBlockLookup {
  const markerAt = description.indexOf(marker);
  if (markerAt < 0) return { found: false, reason: "absent" };

  const after = markerAt + marker.length;
  // Only whitespace may sit between the marker and its block; anything else
  // means this isn't the generated shape.
  const openMatch = /^\s*<div\b/i.exec(description.slice(after));
  if (!openMatch) return { found: false, reason: "no-element" };
  const start = after + openMatch[0].length - "<div".length;

  const tagRe = /<\s*(\/?)div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let depth = 0;
  let scanned = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(description)) !== null) {
    if (++scanned > MAX_TAG_SCAN) return { found: false, reason: "scan-limit" };
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) {
      const end = m.index + m[0].length;
      return { found: true, span: { start, end, html: description.slice(start, end) } };
    }
  }
  return { found: false, reason: "unclosed" };
}

/**
 * Pure: locate the credential block that follows the marker.
 *
 * Returns null when the marker is absent, when no <div> opens after it, or when
 * the element never closes — every "shape I don't recognise" case, because the
 * caller's only safe response to an unrecognised description is to leave it
 * exactly as it is. Callers that need to know WHICH case they hit use
 * `locateSellerCredentialBlock`.
 */
export function findSellerCredentialBlock(
  description: string,
  marker: string = SELLER_CREDENTIALS_MARKER,
): SellerCredentialBlockSpan | null {
  const found = locateSellerCredentialBlock(description, marker);
  return found.found ? found.span : null;
}

/**
 * Why the refresh cron left a listing alone.
 *
 * `no_marker` is the benign one and the only one the old `no_block` counter was
 * ever meant to mean.
 */
export type RefreshSkipKind =
  /** No badge in the stored description. A refresh must never inject one. */
  | "no_marker"
  /**
   * The badge is there and the div walk could not parse it. The listing has a
   * STALE count a buyer is reading, and the legacy path skips it every run.
   */
  | "unparseable"
  /**
   * `description_blocks` carries a `credentials` block but the stored string
   * has no marker, so the two columns disagree about what was published.
   */
  | "blocks_disagree";

// One literal `kind` per member, so a caller that has ruled out the other two
// gets `reason` narrowed rather than having to assert it.
export type RefreshSkipVerdict =
  | { skip: false }
  | { skip: true; kind: "no_marker" }
  | { skip: true; kind: "blocks_disagree" }
  | { skip: true; kind: "unparseable"; reason: CredentialBlockReason };

/**
 * Pure: decide whether the credentials cron can refresh this listing, and when
 * it cannot, say which of three different things "cannot" means.
 *
 * US-3028. The cron reported one number, `no_block`, for every listing it left
 * alone, and read it as "these sellers never had a badge". Two of the three
 * cases underneath it are the opposite — a badge that IS live and IS stale —
 * and one run reported 13 of 21 listings that way with nothing to tell them
 * apart. Splitting the verdict changes no behaviour: a skip is still a skip.
 *
 * `blocks` is typed structurally rather than as `DescriptionBlock[]` so this
 * module stays free of description-blocks.ts, which imports it.
 */
export function classifyRefreshSkip(
  blocks: ReadonlyArray<{ key: string }> | null | undefined,
  description: string,
): RefreshSkipVerdict {
  // Block-backed: the description is re-rendered from the blocks, so a walk
  // that cannot parse the old markup is irrelevant. All that matters is the
  // never-inject rule, and the marker is what proves the seller had a badge.
  if (blocks?.length) {
    if (description.includes(SELLER_CREDENTIALS_MARKER)) return { skip: false };
    return blocks.some((b) => b.key === "credentials")
      ? { skip: true, kind: "blocks_disagree" }
      : { skip: true, kind: "no_marker" };
  }

  const located = locateSellerCredentialBlock(description);
  if (located.found) return { skip: false };
  return located.reason === "absent"
    ? { skip: true, kind: "no_marker" }
    : { skip: true, kind: "unparseable", reason: located.reason };
}

/**
 * Pure: replace the credential block in `description` with freshly rendered
 * `html`, leaving every other byte — body copy, disclosure block, and the
 * trailing grade/cert line — untouched.
 *
 * Returns null when there is no block to replace. Null is NOT the same as "no
 * change needed": it means this description never carried a block (the seller
 * had not opted in when it was drafted, or an eBay-side edit stripped it), and
 * a refresh sweep must never INJECT the block into such a listing — that would
 * silently add marketing copy to a listing the seller wrote themselves.
 * Callers detect "already fresh" by comparing the returned string to the input.
 */
export function refreshSellerCredentialBlock(
  description: string,
  html: string,
): string | null {
  const span = findSellerCredentialBlock(description);
  if (!span) return null;
  return description.slice(0, span.start) + html + description.slice(span.end);
}
