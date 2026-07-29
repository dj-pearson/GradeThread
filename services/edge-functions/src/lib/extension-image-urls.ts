// Listing-image URL validation for the extension surfaces (US-1755 / US-2238 /
// US-2241) — PURE.
//
// Two endpoints take a list of public listing photos and hand them to
// quickGrade: the anonymous buyer read (/api/grading/public/grade-from-url) and
// the seller's sourcing appraisal (/api/flipdesk/scout/appraise-url). They used
// to carry near-identical copies of this parser in two heavy route files, where
// neither could be type-checked or unit-tested without hono, supabase and the
// eBay client resolving first.
//
// WHAT THIS DOES AND DOES NOT GUARANTEE. It is SHAPE validation: reject anything
// that is not a well-formed http(s) URL, and cap the count. The real SSRF
// defence is safeFetch inside quickGrade — a private-range blocklist that
// re-validates every redirect hop, which a pure function could not do correctly
// anyway (a perfectly public hostname can resolve to 169.254.169.254). This runs
// FIRST so obvious junk never reserves an AI action or opens a socket.

/**
 * Per-request photo ceiling for an ANONYMOUS caller. Also the floor: no resolved
 * tier can drop a caller below it.
 */
export const EXTENSION_MAX_IMAGES_ANON = 4;
/** Per-request photo ceiling for any authenticated PAID tier. */
export const EXTENSION_MAX_IMAGES_PAID = 8;

/**
 * Clamp a requested cap into [anon, paid].
 *
 * Defensive on purpose: the cap arrives from a resolved entitlement, and both
 * failure directions are real. Too high turns one request into an unbounded
 * number of Vision calls; zero or NaN starves a paying caller down to nothing.
 */
export function clampImageCap(requested: unknown): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n)) return EXTENSION_MAX_IMAGES_ANON;
  return Math.max(EXTENSION_MAX_IMAGES_ANON, Math.min(EXTENSION_MAX_IMAGES_PAID, n));
}

export interface UrlParseMessages {
  /** Shown when an entry is not a parseable URL. */
  malformed: string;
  /** Shown when an entry uses a scheme other than http(s). */
  scheme: string;
  /** Shown when nothing usable was provided at all. */
  empty: string;
}

/**
 * Validate + cap a list of listing image URLs.
 *
 * Accepts an array, or a single string (both endpoints have a singular form).
 * Non-string entries are SKIPPED rather than rejected — one junk element in a
 * gallery scrape shouldn't fail a request whose other four URLs are fine — but a
 * malformed or non-http(s) STRING is a hard error, because that is a caller
 * sending something they meant, and silently dropping `file:///etc/passwd` would
 * hide an attempt worth failing loudly.
 */
export function parseListingImageUrls(
  raw: unknown,
  cap: number,
  messages: UrlParseMessages,
): { ok: true; urls: string[] } | { ok: false; error: string } {
  const limit = clampImageCap(cap);
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const urls: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, error: messages.malformed };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: messages.scheme };
    }
    urls.push(trimmed);
    if (urls.length >= limit) break;
  }
  if (urls.length === 0) return { ok: false, error: messages.empty };
  return { ok: true, urls };
}
