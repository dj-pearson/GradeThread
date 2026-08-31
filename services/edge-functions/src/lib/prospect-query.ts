// What /prospect actually searched for, and what it shows the seller (US-3026).
//
// THE COMPLAINT THIS ANSWERS. A seller scanned a We The Free off-the-shoulder
// cropped top. The card said "We The Free". The sold-comps link opened eBay's
// completed search for We The Free - a Free People sub-label with thousands of
// live listings across every garment they make - and the price spread on that
// page has nothing to do with the top in their hand.
//
// The cause was structural, not a bad model day. /prospect had ONE string doing
// three jobs:
//
//   the title shown to the seller
//   the free text handed to eBay Browse for the comp maths
//   the _nkw on the sold-comps deep link
//
// and it was built as `titleize([brand, ...keywords])`. Those three want
// DIFFERENT strings, and the conflict is not a matter of taste:
//
//   BROWSE wants breadth. It is computing a median, so it needs enough comps to
//   have a median. buildCompKeywords already strips colour and size for exactly
//   this reason: a red one and a blue one are one product.
//
//   THE DEEP LINK wants precision. A human is about to read that page with the
//   garment in their hand. Colour and cut are the whole point, and twenty rows
//   of the right top beats two thousand rows of the right brand.
//
//   THE TITLE wants to read like English, keep the brand's own capitalisation,
//   and be the thing the seller edits when we got it wrong.
//
// So this module takes a structured identity and returns all three, and the
// route stops deriving them from each other. Everything here is pure: no eBay,
// no Anthropic, no database.

import {
  isSizeToken,
  normalizeTitleToken,
  TITLE_COLOR_TOKENS,
  TITLE_FILLER_TOKENS,
  TITLE_LISTING_CHATTER,
} from "./title-tokens.ts";

/**
 * What we think the garment IS, in fields rather than in one blob of words.
 *
 * Fields rather than `keywords: string[]` because the three consumers above
 * need different subsets, and a flat array cannot be subsetted - which is how a
 * colour ended up stripped from a human-facing link that needs one and kept in
 * a comp query that throws it away. Every field is independently optional: a
 * tag macro with no garment in frame legitimately yields a brand and nothing
 * else.
 */
export interface GarmentIdentity {
  /** As printed on the tag, in the brand's own casing. */
  brand: string | null;
  /** The head noun: "cropped top", "flannel shirt", "wide leg jean". */
  garmentType: string | null;
  /** One colour word, the dominant one. */
  color: string | null;
  /** Cut, neckline, sleeve, pattern - what makes THIS one findable. */
  descriptors: string[];
  /** "cotton", "merino wool". Sometimes the whole reason for the price. */
  material: string | null;
  /** "women" | "men" | "unisex" | "kids", or null when nothing says. */
  gender: string | null;
  /** As printed. Never enters a comp query - buildCompKeywords strips sizes. */
  size: string | null;
  /** The brand's own product code off the tag. The strongest comp key there is. */
  styleCode: string | null;
  /** 0..1, the identifier's own read of how sure it is. */
  confidence: number;
}

export function emptyIdentity(): GarmentIdentity {
  return {
    brand: null,
    garmentType: null,
    color: null,
    descriptors: [],
    material: null,
    gender: null,
    size: null,
    styleCode: null,
    confidence: 0,
  };
}

/**
 * How many words after the brand may reach the sold-comps deep link.
 *
 * Five. eBay's site search ANDs every term, so each extra word is another way
 * for the page to come back empty - and an empty sold page reads as "nothing
 * like this ever sold", which is the most misleading answer this feature can
 * give. Five carries a colour, a cut and a garment type, which is the level of
 * detail a human standing in a shop is actually asking for.
 */
export const MAX_SOLD_QUERY_TOKENS = 5;

/** Tokens that are noise in every one of the three strings. */
function isNoise(tok: string): boolean {
  return TITLE_LISTING_CHATTER.has(tok) || isSizeToken(tok);
}

function words(s: string | null | undefined): string[] {
  return (s ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Is there enough here to comp at all?
 *
 * A brand alone is enough - that is a real, if broad, market question, and it
 * is what the route has always accepted. A garment type alone is NOT: "top"
 * priced against every top on eBay is a number with no meaning, and returning
 * it would be worse than admitting we could not read the photo. So a bare type
 * needs at least one thing that narrows it.
 */
export function identityIsUsable(id: GarmentIdentity): boolean {
  if (id.brand?.trim()) return true;
  if (id.styleCode?.trim()) return true;
  if (!id.garmentType?.trim()) return false;
  return Boolean(id.color?.trim() || id.descriptors.length > 0 || id.material?.trim());
}

/** "off the shoulder" -> "Off the Shoulder". Filler words stay lowercase. */
function titleize(phrase: string): string {
  return words(phrase)
    .map((w, i) => {
      const norm = normalizeTitleToken(w);
      if (i > 0 && TITLE_FILLER_TOKENS.has(norm)) return w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * The title on the card, and the text pre-filled into the correction field.
 *
 * Brand casing is preserved verbatim: "L'AGENCE" and "lululemon" are how those
 * brands write themselves, and title-casing them reads as the app having failed
 * to recognise the name. Everything the model wrote is title-cased, because it
 * arrives lowercase and a card is not a chat log.
 */
export function buildDisplayTitle(id: GarmentIdentity): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    for (const w of words(raw)) {
      const norm = normalizeTitleToken(w);
      if (!norm) continue;
      // Filler is exempt from de-duplication. "We The Free" seeds the seen set
      // with "the", and dropping the next one turns "off the shoulder" into
      // "off shoulder" - the title stops being English to save a word nobody
      // was going to notice twice.
      if (TITLE_FILLER_TOKENS.has(norm)) {
        parts.push(w);
        continue;
      }
      if (seen.has(norm)) continue;
      seen.add(norm);
      parts.push(w);
    }
  };

  const brand = (id.brand ?? "").trim();
  if (brand) {
    parts.push(brand);
    for (const w of words(brand)) {
      const norm = normalizeTitleToken(w);
      if (norm) seen.add(norm);
    }
  }
  if (id.color) push(titleize(id.color));
  for (const d of id.descriptors) push(titleize(d));
  if (id.material) push(titleize(id.material));
  if (id.garmentType) push(titleize(id.garmentType));

  return parts.join(" ").trim();
}

/** Quote a multi-word brand so eBay treats it as one phrase. */
function brandLead(brand: string): string {
  if (!brand) return "";
  return words(brand).length > 1 ? `"${brand}"` : brand;
}

/**
 * The `_nkw` on the sold-comps link: as specific as the evidence supports.
 *
 * A multi-word brand is QUOTED. Unquoted, eBay ANDs "we", "the" and "free"
 * against the whole site, and "free" alone matches every listing whose seller
 * wrote "free shipping" - which is most of them. The quotes are the difference
 * between a sub-label search and a shipping-policy search.
 *
 * A style code, when we have one, REPLACES the descriptive words rather than
 * joining them. Nobody writes "blue off the shoulder" in a listing title the
 * same way twice, and the code either is in the title or is not.
 */
export function buildSoldSearchQuery(id: GarmentIdentity): string {
  const brand = (id.brand ?? "").trim();
  const brandTokens = new Set(words(brand).map(normalizeTitleToken).filter(Boolean));
  const lead = brandLead(brand);

  const code = (id.styleCode ?? "").trim();
  if (code) return [lead, code].filter(Boolean).join(" ").trim();

  const tail: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null) => {
    for (const w of words(raw)) {
      if (tail.length >= MAX_SOLD_QUERY_TOKENS) return;
      const norm = normalizeTitleToken(w);
      if (!norm || seen.has(norm) || brandTokens.has(norm)) continue;
      // Filler is dropped here and kept in the display title: eBay ANDs "the",
      // so "off the shoulder" costs a term and buys nothing.
      if (TITLE_FILLER_TOKENS.has(norm) || isNoise(norm)) continue;
      seen.add(norm);
      tail.push(norm);
    }
  };

  // Colour before cut before type. If the budget runs out it should run out on
  // the least distinguishing word, and the garment type is the one word a
  // reader can supply themselves from the photo on the page.
  push(id.color);
  for (const d of id.descriptors) push(d);
  push(id.garmentType);

  return [lead, ...tail].filter(Boolean).join(" ").trim();
}

/**
 * The fallback link: brand plus the garment type, nothing else.
 *
 * Offered ALONGSIDE the specific one rather than instead of it. The specific
 * query is right until it is empty, and no amount of care here can tell in
 * advance which garment eBay has ten of and which it has none of - only the
 * seller looking at the page can. So they get both and pick.
 */
export function buildBroadSearchQuery(id: GarmentIdentity): string {
  const brand = (id.brand ?? "").trim();
  const lead = brandLead(brand);
  const brandTokens = new Set(words(brand).map(normalizeTitleToken).filter(Boolean));
  const type = words(id.garmentType)
    .map(normalizeTitleToken)
    .filter((t) => t && !brandTokens.has(t) && !isNoise(t) && !TITLE_FILLER_TOKENS.has(t));
  const out = [lead, ...type].filter(Boolean).join(" ").trim();
  // Never empty while we know anything at all: an empty _nkw opens eBay's front
  // page, which is a worse answer than a broad one.
  return out || lead || (id.garmentType ?? "").trim();
}

/**
 * The free text handed to eBay Browse for the comp maths.
 *
 * Colour is deliberately NOT here. buildCompKeywords would strip it anyway, and
 * for the right reason: a red one and a blue one of the same top sell for the
 * same money, so spending a comp term on colour halves the sample for nothing.
 * This is the one place where being broader is being more accurate.
 *
 * The brand is NOT joined in either - it travels as its own field, so it can
 * also become eBay's Brand aspect filter, which is a stronger constraint than a
 * keyword.
 */
export function buildCompQuerySeed(id: GarmentIdentity): string {
  const brandTokens = new Set(words(id.brand).map(normalizeTitleToken).filter(Boolean));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null) => {
    for (const w of words(raw)) {
      const norm = normalizeTitleToken(w);
      if (!norm || seen.has(norm) || brandTokens.has(norm)) continue;
      if (isNoise(norm) || TITLE_COLOR_TOKENS.has(norm)) continue;
      if (TITLE_FILLER_TOKENS.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
  };
  for (const d of id.descriptors) push(d);
  push(id.material);
  push(id.garmentType);
  return out.join(" ");
}

/** The head noun goes last in English, so the last surviving token is the type. */
function assignTypeAndDescriptors(id: GarmentIdentity, kept: string[]): void {
  if (kept.length === 0) return;
  id.garmentType = kept[kept.length - 1]!;
  id.descriptors = kept.slice(0, -1).slice(0, 4);
}

/**
 * Read an identity out of somebody else's eBay listing title.
 *
 * This is the visual-search path (US-2759): eBay hands back the title of the
 * closest-looking live listing, and /prospect used to take its first eight
 * tokens verbatim as the item's keywords. Those tokens are a SELLER'S SEO, not
 * a description - "NWT Free People We The Free Womens Blue Off The Shoulder
 * Crop Top Size M Boho" - and feeding them to a comp query searches for the
 * word "NWT" as hard as for the word "top".
 *
 * So the chatter comes out, and what is left is treated as descriptors with the
 * last surviving token as the garment type. `brandHint` is whatever we already
 * knew; the tokens it names are removed rather than repeated.
 */
export function identityFromListingTitle(
  title: string,
  brandHint: string | null = null,
): GarmentIdentity {
  const id = emptyIdentity();
  id.brand = brandHint?.trim() || null;
  const brandTokens = new Set(words(brandHint).map(normalizeTitleToken).filter(Boolean));

  const kept: string[] = [];
  for (const raw of words(title)) {
    const tok = normalizeTitleToken(raw);
    if (!tok || brandTokens.has(tok)) continue;
    if (isNoise(tok) || TITLE_FILLER_TOKENS.has(tok)) continue;
    if (TITLE_COLOR_TOKENS.has(tok)) {
      id.color ??= tok;
      continue;
    }
    if (!kept.includes(tok)) kept.push(tok);
  }

  assignTypeAndDescriptors(id, kept);
  return id;
}

/**
 * The legacy shape: a brand plus a flat keyword list.
 *
 * Kept because a seller's own corrected title (US-2923) arrives as free text
 * with no structure to it, and because a response that fails to produce fields
 * must still produce a title rather than a blank card.
 */
export function identityFromKeywords(
  brand: string | null,
  keywords: readonly string[],
): GarmentIdentity {
  const id = emptyIdentity();
  id.brand = brand?.trim() || null;
  const brandTokens = new Set(words(brand).map(normalizeTitleToken).filter(Boolean));

  const kept: string[] = [];
  for (const raw of keywords.flatMap((k) => words(k))) {
    const tok = normalizeTitleToken(raw);
    if (!tok || brandTokens.has(tok)) continue;
    if (isNoise(tok)) continue;
    if (TITLE_COLOR_TOKENS.has(tok)) {
      id.color ??= tok;
      continue;
    }
    if (TITLE_FILLER_TOKENS.has(tok)) continue;
    if (!kept.includes(tok)) kept.push(tok);
  }
  assignTypeAndDescriptors(id, kept);
  return id;
}

/**
 * The flat keyword list the response has always carried, rebuilt from the
 * identity so `item.keywords` keeps meaning what it meant.
 *
 * Both phone clients decode it, and one of them uses it to pre-fill the buy
 * sheet. Dropping it in favour of only the structured fields would have been
 * the tidier change and would have blanked that sheet on every phone running
 * the build that is already shipped.
 */
export function identityKeywords(id: GarmentIdentity): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [id.color, ...id.descriptors, id.material, id.garmentType]) {
    for (const w of words(raw)) {
      const norm = normalizeTitleToken(w);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
  }
  return out.slice(0, 12);
}
