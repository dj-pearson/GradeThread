// Garment Passport physical-tag code generation (US-1096).
//
// A tag's short_code is the human-readable, QR-embedded handle printed on a
// physical tag. It is NOT a secret — security comes from opt-in issuance,
// server-side rate-limiting, and revocation. The code uses Crockford base32
// (no I/L/O/U — unambiguous when read off a printed tag or typed by hand),
// grouped for legibility. Pure (no DB, no env) so it's unit-tested directly.

// Crockford base32 alphabet (excludes I, L, O, U to avoid 1/l, 0/O, U/V mix-ups).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Raw N-char Crockford-base32 code (uppercase, unambiguous). */
function rawCode(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/**
 * A fresh tag short code, grouped as XXXX-XXXX-XX for legibility (10 base32
 * chars → ~50 bits; ample to avoid collisions while staying easy to read/type).
 */
export function generateTagCode(): string {
  const c = rawCode(10);
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 10)}`;
}

/**
 * Normalize a scanned/typed code for lookup: uppercase, strip anything that
 * isn't an alphabet char (so "gt-xxxx xxxx-xx", lowercase, or stray spaces all
 * resolve to the same canonical, ungrouped key).
 */
export function normalizeTagCode(input: string): string {
  const up = input.toUpperCase();
  let out = "";
  for (const ch of up) {
    if (ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

/** True when `code` is a syntactically valid tag code (10 base32 chars). */
export function isValidTagCode(code: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(normalizeTagCode(code));
}

/** The URL a tag's QR encodes — the public scan entry point. */
export function tagScanUrl(siteUrl: string, code: string): string {
  return `${siteUrl.replace(/\/$/, "")}/t/${normalizeTagCode(code)}`;
}
