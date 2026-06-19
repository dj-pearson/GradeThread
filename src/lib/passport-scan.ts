// Garment Passport "scan before you buy" lookup parsing (US-1106).
//
// The public buyer entry point (/scan) accepts whatever a buyer has in hand — a
// pasted passport link, a raw 32-hex passport slug, a physical-tag short code,
// or a /t/<code> tag URL — and resolves it to the right public destination:
//   • a passport slug  → /passport/:slug   (the public timeline, US-1093)
//   • a tag short code → /t/:code          (scan-to-resolve, US-1096)
// PURE (no network, no DOM) so it's unit-tested directly and shared by the page.

// Crockford base32 alphabet used by physical tag codes (mirrors the edge
// passport-tag.ts — excludes I/L/O/U so a printed code can't be misread).
const TAG_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type ScanTarget =
  | { kind: "passport"; slug: string; path: string }
  | { kind: "tag"; code: string; path: string };

/** Uppercase + strip any non-alphabet char, so "gt-xxxx xxxx-xx" → canonical key. */
export function normalizeTagCode(input: string): string {
  let out = "";
  for (const ch of input.toUpperCase()) {
    if (TAG_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

/** True when (already-normalized) `code` is a syntactically valid 10-char tag. */
export function isValidTagCode(code: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code);
}

/**
 * Resolve a pasted/scanned value to its public passport destination, or null
 * when it's not a recognizable passport reference. Checks explicit URL/path
 * forms first (most reliable), then bare slugs / tag codes.
 */
export function parseScanInput(raw: string): ScanTarget | null {
  const input = raw.trim();
  if (!input) return null;

  // Explicit passport link: …/passport/<32-hex-slug>.
  const passportUrl = input.match(/\/passport\/([0-9a-fA-F]{32})\b/);
  if (passportUrl?.[1]) {
    const slug = passportUrl[1].toLowerCase();
    return { kind: "passport", slug, path: `/passport/${slug}` };
  }

  // Explicit tag link: …/t/<code> (tolerant of grouping/case in the code).
  const tagUrl = input.match(/\/t\/([^/?#\s]+)/);
  if (tagUrl?.[1]) {
    const code = normalizeTagCode(tagUrl[1]);
    if (isValidTagCode(code)) return { kind: "tag", code, path: `/t/${code}` };
  }

  // Bare 32-hex passport slug.
  if (/^[0-9a-fA-F]{32}$/.test(input)) {
    const slug = input.toLowerCase();
    return { kind: "passport", slug, path: `/passport/${slug}` };
  }

  // Bare tag code (e.g. "ABCD-EFGH-JK" or "abcdefghjk").
  const code = normalizeTagCode(input);
  if (isValidTagCode(code)) return { kind: "tag", code, path: `/t/${code}` };

  return null;
}
