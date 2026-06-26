// Human-facing certificate number derived from the random `certificate_id` UUID.
//
// The full UUID stays the canonical id (it's the /cert/<id> URL and the lookup
// key, and being random it's unguessable/non-enumerable — the safe choice). This
// is ONLY a clean, PSA-style label for display on the certificate page and as a
// bare reference in listings (no URL — eBay forbids off-eBay links).
//
// Accepts either a bare cert id or a full ".../cert/<id>" URL.
export function certificateDisplayNumber(
  certIdOrUrl: string | null | undefined,
): string | null {
  if (!certIdOrUrl) return null;
  // Pull the id from a /cert/<id> URL, else use the whole string; drop any
  // query/hash/whitespace from a paste.
  const m = certIdOrUrl.match(/\/cert\/([^/?#\s]+)/i);
  const candidate = m?.[1] ?? certIdOrUrl;
  const id = candidate.split(/[?#\s]/)[0] ?? "";
  const hex = id.replace(/-/g, "").toUpperCase();
  if (hex.length < 8) return null;
  return `GT-${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

// Normalize buyer-typed input for a /verify lookup: uppercase, strip spaces +
// dashes, and ensure a single "GT-" prefix (so "gt 7k2m9", "7K2M9", "GT-7K2M9"
// all match). Mirrors normalizeCertNumber in the edge lib of the same name.
export function normalizeCertNumber(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  const bare = cleaned.startsWith("GT") ? cleaned.slice(2) : cleaned;
  return `GT-${bare}`;
}
