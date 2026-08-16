// US-2628: the certificate's "About this item" description, as plain text (PURE).
//
// A submission's description is usually the LISTING description, and a listing
// description is HTML: eBay renders it, so AutoLister writes <div>s into it and
// the disclosure + verified-seller blocks are appended as markup (ai-listing.ts,
// routes/flipdesk-disclosure.ts, seller-credentials.ts).
//
// The certificate page renders that same string as TEXT — React escapes it in
// the SPA, `escape()` escapes it in the SSR Pages Function — so a buyer saw the
// raw `<div style="border:1px solid #e5e7eb...">` printed as body copy.
// Rendering the HTML instead is not an option: it is seller-controlled input on
// an anonymous public page, which is stored XSS.
//
// So: convert to text here, ONCE, in the endpoint both renderers read
// (GET /api/content/public/certificates/:id). Same reasoning as certDisplayTitle
// — the SPA, the Cloudflare SSR page and the OG image are three runtimes that
// cannot share a module, so three implementations would drift.
//
// The two GradeThread-generated blocks are dropped rather than flattened. The
// certificate already states the grade, and it already renders the grader's
// standing from `seller_integrity` — repeating "GradeThread Verified Seller" in
// the seller's own description would be the same claim twice, in worse words.
//
// PURE (no I/O), unit-tested in tests/cert-description_test.ts.

import {
  findSellerCredentialBlock,
  SELLER_CREDENTIALS_MARKER,
} from "./seller-credentials.ts";

/** Mirrors DISCLOSURE_MARKER in routes/flipdesk-disclosure.ts. */
export const DISCLOSURE_MARKER = "<!--gradethread-disclosure-->";

/** Generated blocks removed whole, marker and element together. */
const GENERATED_MARKERS = [SELLER_CREDENTIALS_MARKER, DISCLOSURE_MARKER];

/** A description can't plausibly carry more than this many generated blocks. */
const MAX_BLOCK_REMOVALS = 8;

/** Named entities worth resolving; anything else is left exactly as written. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "-",
  mdash: "-",
  minus: "-",
  hellip: "...",
  times: "x",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  // Printable and intentional: these are what the seller typed, and dropping
  // them would change the copy rather than clean it.
  middot: String.fromCharCode(0x00b7),
  bull: String.fromCharCode(0x2022),
  check: String.fromCharCode(0x2713),
  deg: String.fromCharCode(0x00b0),
};

const ENTITY_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/**
 * True for code points that render as nothing, or as something other than what
 * they are: C0 controls, soft hyphen, zero-width joiners, bidi controls,
 * line/paragraph separators, BOM, and the Unicode tag block (which encodes
 * arbitrary ASCII invisibly). Pasted listing copy carries these routinely, and
 * they must never reach a public page. Tab and newline are real spacing and stay.
 *
 * Written as numeric comparisons rather than a regex character class on
 * purpose: the class would have to contain the very characters it removes, and
 * a source file holding invisible characters is unreviewable.
 */
function isInvisible(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a) return false;
  if (cp < 0x20 || cp === 0x7f) return true;
  if (cp === 0x00ad || cp === 0x034f || cp === 0x061c || cp === 0x180e) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp === 0x2028 || cp === 0x2029) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2060 && cp <= 0x2064) return true;
  if (cp >= 0x2066 && cp <= 0x2069) return true;
  if (cp === 0xfeff) return true;
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  return false;
}

/**
 * True for the spaces that are not U+0020: no-break space and the typographic
 * widths. They look like a space and break word-splitting, so they become one.
 */
function isExoticSpace(cp: number): boolean {
  if (cp === 0x00a0 || cp === 0x202f || cp === 0x205f || cp === 0x3000) return true;
  return cp >= 0x2000 && cp <= 0x200a;
}

function normalizeInvisible(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisible(cp)) continue;
    out += isExoticSpace(cp) ? " " : ch;
  }
  return out;
}

function decodeEntities(input: string): string {
  return input.replace(ENTITY_RE, (whole, body: string) => {
    if (body.charAt(0) === "#") {
      const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
      const cp = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/**
 * Delete a generated block: the marker plus the element that follows it. When
 * the marker is present but the element is not the shape we generate (an eBay
 * side edit, a truncated description), only the marker comment goes — the copy
 * around it is the seller's and is never guessed at.
 */
function removeMarkedBlock(input: string, marker: string): string {
  let out = input;
  for (let i = 0; i < MAX_BLOCK_REMOVALS; i++) {
    const at = out.indexOf(marker);
    if (at < 0) return out;
    const span = findSellerCredentialBlock(out, marker);
    out = span
      ? out.slice(0, at) + out.slice(span.end)
      : out.slice(0, at) + out.slice(at + marker.length);
  }
  return out;
}

/**
 * Pure: flatten listing-description HTML to readable plain text. Block-level
 * tags become line breaks so paragraphs and bullet lists survive the trip;
 * every other tag is dropped.
 */
export function htmlToPlainText(input: string): string {
  let s = input;
  // Contents too, not just the tags — a stray <style> block would otherwise
  // print its CSS as body copy.
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  // The bullet's line break comes from the OPENING tag, so the closing one adds
  // nothing — leaving it in the block list below put a blank line between every
  // two list items.
  s = s.replace(/<\s*\/\s*li\s*>/gi, "");
  s = s.replace(/<\s*li\b[^>]*>/gi, "\n- ");
  s = s.replace(
    /<\s*\/?\s*(p|div|ul|ol|table|tbody|thead|tfoot|tr|td|th|h[1-6]|section|article|header|footer|blockquote|hr|pre)\b[^>]*>/gi,
    "\n",
  );
  s = s.replace(/<[^<>]*>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, "\n");
  s = normalizeInvisible(s);
  // Collapse spacing WITHIN a line, trim each line, then collapse blank-line
  // runs — in that order, so "</div>\n\n<div>" leaves one blank line rather
  // than a wall of them.
  s = s.split("\n").map((line) => line.replace(/[^\S\n]+/g, " ").trim()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * Pure: the description to show on a public certificate.
 *
 * Drops the GradeThread-generated blocks, flattens the rest to plain text, and
 * returns null when nothing readable is left — so the caller's "About this item"
 * panel omits the paragraph instead of rendering an empty one.
 */
export function certDescriptionText(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  let s = raw;
  for (const marker of GENERATED_MARKERS) s = removeMarkedBlock(s, marker);
  const text = htmlToPlainText(s);
  return text.length > 0 ? text : null;
}
