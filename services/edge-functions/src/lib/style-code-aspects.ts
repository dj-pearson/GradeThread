// US-2751: learn a product name from what a seller FILLED IN, not from prose.
//
// The sweep's first design read eBay listing TITLES and took the run of words
// most of them shared. The owner rejected it, correctly, and the reasoning is
// worth keeping because it is the whole basis of this module:
//
//   A title is marketing text. "Lululemon Align Legging 25 Black Size 6 EUC" is
//   assembled by a seller who may have bought the garment with no tag beyond a
//   size dot and guessed the rest. A consensus over guesses is a confident
//   guess, not a fact.
//
//   An ITEM SPECIFIC is different. A seller who filled eBay's "Style Code" or
//   "MPN" field typed a code off a tag on purpose. When that code MATCHES the
//   one we are asking about, the listing's "Model" aspect is a name attached to
//   a verified identifier by someone holding the garment.
//
// ── AND THE LOOP THAT MADE IT WORSE ────────────────────────────────────────
//
// Our own sellers publish to eBay with titles our own AI wrote. Reading those
// titles back as independent market evidence means three of OUR listings
// agreeing is three copies of one guess. classifyListing takes the caller's set
// of our own listing ids so that feedback is excluded rather than counted.
//
// Pure. The eBay calls belong to the caller.

/** eBay returns item specifics as a list of {name, value} pairs. */
export interface ListingAspects {
  itemId: string;
  title: string;
  aspects: Record<string, string>;
}

/** Aspect names that carry a STYLE CODE, most authoritative first. eBay's
 *  clothing categories use several spellings and sellers pick whichever the
 *  category offered them. */
const CODE_ASPECTS = [
  "Style Code",
  "MPN",
  "Manufacturer Part Number",
  "Style Number",
  "Model Number",
];

/** Aspect names that carry a PRODUCT NAME. "Model" is eBay's field for what
 *  the product is called; "Style" is often a silhouette ("Jogger") rather than
 *  a name, so it ranks below and is only used when Model is absent. */
const NAME_ASPECTS = ["Model", "Product Line", "Style"];

/** Case-insensitive aspect read: sellers and categories vary the casing. */
function aspect(aspects: Record<string, string>, want: string): string | null {
  for (const [k, v] of Object.entries(aspects)) {
    if (k.trim().toLowerCase() === want.toLowerCase()) {
      const value = (v ?? "").trim();
      if (value) return value;
    }
  }
  return null;
}

/** The first non-empty value among a list of aspect names. */
function firstAspect(
  aspects: Record<string, string>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const v = aspect(aspects, name);
    if (v) return v;
  }
  return null;
}

/** The style code a listing DECLARES in a structured field, exactly as the
 *  seller typed it. Exported for US-2782: the discovery crawl keeps the raw
 *  spelling for display alongside the canonical key, and reading CODE_ASPECTS a
 *  second time in that module would be a second list to forget to update. */
export function declaredStyleCodeRaw(listing: ListingAspects): string | null {
  return firstAspect(listing.aspects, CODE_ASPECTS);
}

/** The style code a listing DECLARES in a structured field, normalized. */
export function declaredStyleCode(
  listing: ListingAspects,
  canonicalize: (raw: string) => string,
): string | null {
  const raw = declaredStyleCodeRaw(listing);
  if (!raw) return null;
  const canon = canonicalize(raw);
  return canon || null;
}

/** The product name a listing DECLARES in a structured field. */
export function declaredProductName(listing: ListingAspects): string | null {
  const raw = firstAspect(listing.aspects, NAME_ASPECTS);
  if (!raw) return null;
  const name = raw.trim();
  // A model field holding the code itself says nothing about the name, and a
  // one-word value is a silhouette rather than a product.
  if (name.split(/\s+/).filter(Boolean).length < 2) return null;
  if (name.length > 80) return null;
  return name;
}

export type ListingVerdict =
  /** Declares OUR code in a structured field and names a product. The only
   *  class of evidence this module treats as worth learning from. */
  | "confirmed"
  /** Declares a DIFFERENT code. Actively evidence that this listing is not the
   *  garment we asked about, whatever its title says. */
  | "contradicting"
  /** Ours — excluded so we cannot learn our own guesses back. */
  | "own_listing"
  /** No structured code, or no usable name. Not evidence either way. */
  | "unconfirmed";

export interface ClassifiedListing {
  itemId: string;
  verdict: ListingVerdict;
  /** Present only on `confirmed`. */
  name: string | null;
}

/**
 * What is this listing worth as evidence for `canonicalCode`?
 *
 * Deliberately harsh. A listing earns "confirmed" only by declaring the code in
 * a structured field AND naming a product in one — everything else is
 * "unconfirmed", including a listing whose title looks perfect. That is the
 * point: the old design would have believed the title.
 */
export function classifyListing(args: {
  listing: ListingAspects;
  canonicalCode: string;
  canonicalize: (raw: string) => string;
  ownItemIds: ReadonlySet<string>;
}): ClassifiedListing {
  const { listing, canonicalCode, canonicalize, ownItemIds } = args;
  if (ownItemIds.has(listing.itemId)) {
    return { itemId: listing.itemId, verdict: "own_listing", name: null };
  }

  const declared = declaredStyleCode(listing, canonicalize);
  if (!declared) {
    return { itemId: listing.itemId, verdict: "unconfirmed", name: null };
  }
  if (declared !== canonicalCode) {
    return { itemId: listing.itemId, verdict: "contradicting", name: null };
  }

  const name = declaredProductName(listing);
  return {
    itemId: listing.itemId,
    verdict: name ? "confirmed" : "unconfirmed",
    name,
  };
}

export interface AspectEvidence {
  /** The agreed name, or null when the confirmed listings do not agree. */
  name: string | null;
  /** How many CONFIRMED listings back it. Never counts unconfirmed ones. */
  confirming: number;
  /** Listings that declared a different code — worth reporting, because a code
   *  with many contradictions is one our canonicalization may be mangling. */
  contradicting: number;
  ownListings: number;
  unconfirmed: number;
}

/** Same-answer test: same words in the same order, ignoring case and
 *  punctuation. Matches the rule the admin queue and the re-key planner use. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) === norm(b);
}

/**
 * The name a code's CONFIRMED listings agree on.
 *
 * One confirmed listing is enough to return a name — unlike the title
 * consensus, which needed three, because the evidence is categorically
 * stronger: a structured code that matches, plus a structured name, from a
 * seller who typed both. The caller decides what confidence that earns.
 *
 * Disagreement among confirmed listings returns NULL rather than a majority.
 * Two people who both read the tag and disagree about the name is a question
 * for a human, not something to settle by counting.
 */
export function aspectEvidence(
  classified: readonly ClassifiedListing[],
): AspectEvidence {
  const confirmed = classified.filter((c) => c.verdict === "confirmed" && c.name);
  const counts = {
    confirming: confirmed.length,
    contradicting: classified.filter((c) => c.verdict === "contradicting").length,
    ownListings: classified.filter((c) => c.verdict === "own_listing").length,
    unconfirmed: classified.filter((c) => c.verdict === "unconfirmed").length,
  };
  if (confirmed.length === 0) return { name: null, ...counts };

  const first = confirmed[0]!.name!;
  const allAgree = confirmed.every((c) => sameName(c.name!, first));
  return { name: allAgree ? first : null, ...counts };
}

/**
 * What a name learned from item specifics is worth.
 *
 * Higher than a title consensus could ever earn — a structured code that
 * matches plus a structured name is evidence of a different kind, not more of
 * the same — and still below a seller correction and below a decoder hit, so it
 * can populate the index and never overrule it.
 *
 * US-2782 moved it here from the sweep route. Both the sweep and the discovery
 * crawl write names on identical evidence, and two copies of this number is one
 * place for them to drift apart.
 */
export function aspectNameConfidence(confirming: number): number {
  const n = Math.max(1, Math.floor(confirming));
  return Math.min(0.75, 0.6 + 0.05 * (n - 1));
}
