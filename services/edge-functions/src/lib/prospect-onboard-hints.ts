// US-3099: what the phone already knows before it uploads anything.
//
// THE COST THIS REMOVES. /prospect spends a metered AI action to look at a
// photo and read the brand off the tag. The phone can already read that tag —
// `Vision/TagTextRecognizer.swift` runs `VNRecognizeTextRequest` on-device, for
// free, offline, in the time it takes the shutter to close. Until now the app
// threw that reading away and paid Claude to do it again from a JPEG that had
// to be uploaded first.
//
// So the client may send what it read. When the reading is CONFIDENT, the
// server takes it and does not call the identifier at all: one fewer AI action,
// one fewer round trip through a vision model, and an answer on screen before
// the upload would have finished.
//
// ── WHY A CONFIDENCE FLOOR, AND WHY 0.8 ─────────────────────────────────────
//
// Vision reports a per-candidate confidence. A low-confidence read of a
// crumpled care label is exactly the case Claude is better at, so taking it
// would trade an AI action for a wrong brand — which costs the seller a comp
// set that describes a different garment, and they have no way to tell.
//
// 0.8 is the floor `AIExtractManager` already treats as trustworthy for the
// same OCR on the same tags. One number, one meaning, both places.
//
// ── WHY A BARCODE NEEDS NO FLOOR ────────────────────────────────────────────
//
// A barcode is not a reading, it is a checksummed identifier: EAN-13 and UPC-A
// carry a check digit, and a misread fails it rather than producing a plausible
// wrong number. That is why `identitySource: "barcode"` is the one source
// `identityIsAuthoritative` is true for, and why a scan short-circuits the
// identifier outright.
//
// PURE. No I/O, so the decision is tested by reading it.

/** The floor at which an on-device OCR read is trusted over a Claude call. */
export const ONDEVICE_HINT_CONFIDENCE_FLOOR = 0.8;

/**
 * Fields as they arrive off the wire: `unknown`, deliberately.
 *
 * This module is the PARSER for them, so typing them as strings here would push
 * the validation back to the route and leave two places that have to agree
 * about what a barcode is. Everything below runs through `clean` or
 * `normalizeBarcode` before it is used.
 */
export interface OnDeviceHints {
  /** A barcode the phone scanned. Checksummed, so it needs no floor. */
  barcode?: unknown;
  /** Brand read off the tag on-device. */
  brandHint?: unknown;
  /** Size read off the tag on-device. */
  sizeHint?: unknown;
  /** Vision's own confidence in the two hints above, 0..1. */
  hintConfidence?: unknown;
}

export interface HintPlan {
  /** Skip `identifyProspectGarment` entirely — nothing needs identifying. */
  skipIdentify: boolean;
  /** What the identity came from, when it came from the client. */
  source: "barcode" | "tag" | null;
  /** True only for a barcode: a checksummed id, not a reading. */
  authoritative: boolean;
  /** The brand to use, when the hints carry one worth using. */
  brand: string | null;
  /** The size to use, same condition. */
  size: string | null;
  /** Short and stable enough to group a metric by. */
  reason:
    | "barcode"
    | "confident-tag-read"
    | "low-confidence"
    | "no-hints";
}

const NO_HINTS: HintPlan = {
  skipIdentify: false,
  source: null,
  authoritative: false,
  brand: null,
  size: null,
  reason: "no-hints",
};

/** Trim to a bounded, non-empty string, or null. */
function clean(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/**
 * A barcode, if the string is one.
 *
 * Digits only, and one of the four lengths the retail symbologies produce:
 * UPC-E is 8, EAN-8 is 8, UPC-A is 12, EAN-13 is 13. Anything else is a QR
 * payload or a thrift-store SKU sticker, neither of which identifies a product
 * in any catalogue we can query — passing one through as a `gtin` would return
 * an empty comp set that looks like a rare item.
 */
export function normalizeBarcode(value: unknown): string | null {
  const raw = clean(value, 32);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits !== raw) return null;
  return [8, 12, 13].includes(digits.length) ? digits : null;
}

/**
 * Decide what the client's own reading buys us.
 *
 * A barcode wins outright. A confident tag read skips the identifier. Anything
 * less is ignored — NOT blended, because a half-trusted brand is the one that
 * silently narrows a comp search to the wrong label.
 */
export function planFromHints(hints: OnDeviceHints): HintPlan {
  const barcode = normalizeBarcode(hints.barcode);
  if (barcode) {
    return {
      skipIdentify: true,
      source: "barcode",
      authoritative: true,
      // A barcode names the product; the brand comes from the catalogue lookup
      // that follows, not from anything the phone typed alongside it.
      brand: clean(hints.brandHint),
      size: clean(hints.sizeHint),
      reason: "barcode",
    };
  }

  const brand = clean(hints.brandHint);
  const size = clean(hints.sizeHint);
  if (!brand && !size) return NO_HINTS;

  const confidence = typeof hints.hintConfidence === "number" &&
      Number.isFinite(hints.hintConfidence)
    ? hints.hintConfidence
    : 0;

  // A size alone never skips the identifier. "M" is not an identification, and
  // a comp search on size with no brand returns every medium garment on eBay.
  if (!brand || confidence < ONDEVICE_HINT_CONFIDENCE_FLOOR) {
    return {
      skipIdentify: false,
      source: null,
      authoritative: false,
      brand: null,
      size: null,
      reason: brand || size ? "low-confidence" : "no-hints",
    };
  }

  return {
    skipIdentify: true,
    // A tag read is TEXT on the garment: stronger than a similarity match,
    // weaker than a barcode. Never authoritative — OCR misreads, and a tag can
    // name a parent brand or a licensee.
    source: "tag",
    authoritative: false,
    brand,
    size,
    reason: "confident-tag-read",
  };
}
