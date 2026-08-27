// US-2756: how Scout identifies an item, as one swappable piece.
//
// THE PROBLEM THIS OPENS THE DOOR TO. Today Scout identifies an item from HINTS
// the seller supplies — a barcode, a keyword, a brand, a category — and grades
// the photo separately. That is why an in-store answer cannot be fast: the
// photo goes to a Vision model, and the hints have to be typed.
//
// The alternative is visual search: post the photo, get back visually similar
// live listings, which are both the identity and the comps in one call. eBay
// exposes exactly that at item_summary/search_by_image, and nothing in this
// codebase has ever called it.
//
// WHY IT IS A SEAM AND NOT A REWRITE. Nobody has measured eBay's visual search
// on thrift clothing. It may be excellent on a current-season Carhartt and
// useless on a faded 1990s one, and the only way to find out is to try it with
// real photos in production. So it arrives as a SECOND provider behind a flag
// that defaults to off, the same posture DEPOP_ENABLED takes: built and live are
// different claims, and a stock deployment gets today's behaviour exactly.
//
// The route asks for an identification and does not know who answered.

import {
  type BrowseCompsResult,
  searchBrowseCompsByImage,
} from "./ebay-client.ts";
import { cachedSearchBrowseComps } from "./comps-cache.ts";

export interface IdentifyRequest {
  imageDataUri: string | null;
  /**
   * What the photo SHOWS, when the caller knows — "front", "tag", "detail" and
   * so on. Optional, and its absence is meaningful: see roleCanIdentify.
   */
  imageRole?: string | null;
  barcode: string;
  q: string;
  brand: string;
  categoryId: string;
  size: string;
}

/**
 * Photo roles a visual search can actually identify from (US-2762).
 *
 * MEASURED, NOT GUESSED. The US-2758 spike put 24 real thrift photos through
 * eBay's search_by_image against production, and the photo's TYPE decided the
 * entire outcome:
 *
 *   whole-garment shot   5/5 correct brand, sometimes the exact style name,
 *                        with no tag anywhere in the frame
 *   brand-tag close-up   correct at rank 1, provided the WORDMARK is legible
 *   care/composition label  a midi dress, joggers and a mini skirt
 *   tape measure on a hem   mens dress pants
 *   defect macro of red fabric   red fabric sold BY THE YARD
 *
 * The failures are not eBay malfunctioning. It answers the question the photo
 * asks, and a frame containing only red fabric is a question about fabric. So
 * this is a gate on the INPUT, not a confidence filter on the output: there is
 * no signal in the result that says "this came from a ruler shot".
 *
 * `label` and `tag` are in because the brand-tag macro measured well. That is
 * the one entry here that is a judgement call rather than a clean result: a hem
 * tag carrying only a logo and no wordmark returned Athleta leggings for a
 * Faherty polo. The wordmark is what works, and we cannot tell from the role
 * alone whether the tag in the frame has one.
 */
export const IDENTIFYING_PHOTO_ROLES: ReadonlySet<string> = new Set([
  "front",
  "back",
  "flatlay",
  "label",
  "tag",
]);

/**
 * May visual search be shown a photo in this role?
 *
 * UNKNOWN MEANS NO (AC6). An absent or unrecognised role is not treated as
 * permission: a photo nobody labelled is likelier to be a detail shot than a
 * flatlay, and the cost of guessing wrong is not a miss but a confident wrong
 * answer that gets priced against. Declining is free — identifyWithFallback
 * reads a null as "not my case" and goes straight to hints without even
 * spending the timeout.
 */
export function roleCanIdentify(role: string | null | undefined): boolean {
  if (typeof role !== "string") return false;
  return IDENTIFYING_PHOTO_ROLES.has(role.trim().toLowerCase());
}

/**
 * HOW an identity was arrived at (US-2763).
 *
 * Not a confidence score, because these are different KINDS of claim rather than
 * different amounts of the same one:
 *
 *   barcode  a GTIN pins one manufactured product. There is nothing to be
 *            uncertain about.
 *   tag      a brand tag was READ. The words are printed on the garment, which
 *            is the strongest evidence short of a barcode - but OCR misreads,
 *            and a tag can be from a parent brand or a licensee, so it is still
 *            offered rather than saved.
 *   visual   eBay returned listings that LOOK like this. The spike measured a
 *            teal tank with no brand mark anywhere in frame returning five
 *            Lululemon tanks, with no expressed doubt. It may be right, and the
 *            photo cannot say.
 *   seller   A HUMAN HOLDING THE GARMENT typed it, correcting what the machine
 *            said (US-2923). This sits at the top of the ladder, above barcode:
 *            a barcode is authoritative about the tag it is printed on, and a
 *            thrifted garment is exactly where a tag and a garment part company.
 *            The seller can see both. Nothing else in this union has looked at
 *            the item.
 */
export type IdentitySource = "barcode" | "tag" | "visual" | "seller";

export interface IdentifyOutcome {
  /** Comps to value against. */
  comps: BrowseCompsResult;
  /** A product title this provider recognised, for prefilling /buy. */
  matchedTitle: string | null;
  /** How that title was arrived at, or null when nothing was identified. */
  identitySource: IdentitySource | null;
  /**
   * May `matchedTitle` be written into a field WITHOUT the seller confirming it?
   *
   * Only a barcode may. This exists because the two providers had opposite
   * postures and the wrong one was confident: hintsProvider already refused to
   * prefill from a keyword hit, on the stated grounds that "a keyword's top hit
   * is somebody else's listing title", while ebayImageProvider took
   * `items[0].title` unconditionally from a pure similarity match. The provider
   * with the weaker evidence was the more assertive one.
   *
   * A wrong brand does not merely mislabel the item; it prices it against the
   * wrong comps.
   */
  identityIsAuthoritative: boolean;
  provider: ProviderName;
}

export type ProviderName = "hints" | "ebay-image";

export interface IdentifyProvider {
  readonly name: ProviderName;
  /**
   * Identify and comp, or return null when this provider has nothing to say.
   *
   * Null is a first-class answer and means "not my case" — a visual search that
   * found no similar listings, say. It is distinct from throwing, which means
   * the provider broke. Both fall through to the next provider; only the
   * distinction between them is worth logging differently.
   */
  identify(
    req: IdentifyRequest,
    conditionId: string,
  ): Promise<IdentifyOutcome | null>;
}

/**
 * How long an EXPERIMENTAL provider gets before it is abandoned.
 *
 * Small on purpose. This runs before the work the seller actually asked for, so
 * an unproven provider that hangs would make every appraisal slower than not
 * having it at all — the worst possible outcome for a feature whose entire point
 * is speed. The default provider is deliberately exempt (see below).
 */
export const EXPERIMENTAL_TIMEOUT_MS = 1500;

/** Is the eBay visual-search experiment switched on for THIS request? */
export function ebayImageSearchEnabled(): boolean {
  // Read per call, never captured at module load. That is the difference
  // between switching a misbehaving experiment off from a phone in a shop and
  // needing a redeploy to do it.
  //
  // Exact-match "true", so a stale "false", a "1", or an operator's "yes" all
  // leave it off. A flag that guesses at intent is a flag that turns an
  // unproven path on in front of sellers by accident.
  return Deno.env.get("SCOUT_EBAY_IMAGE_SEARCH_ENABLED") === "true";
}

/**
 * The providers to try, in order.
 *
 * `hints` is always last and always present: it is the path that works today
 * and it must remain the floor under every experiment.
 */
export function chooseProviders(
  deps: { image?: IdentifyProvider; hints?: IdentifyProvider } = {},
): IdentifyProvider[] {
  const hints = deps.hints ?? hintsProvider;
  if (!ebayImageSearchEnabled()) return [hints];
  return [deps.image ?? ebayImageProvider, hints];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Try each provider until one answers.
 *
 * Falling back is SILENT to the seller and visible in the logs. They asked for
 * an appraisal, not for an experiment, so an image-search outage should cost
 * them a few hundred milliseconds and nothing else — but a fallback nobody can
 * see is an experiment nobody can evaluate.
 *
 * The LAST provider is never timed out. Cutting off the path sellers rely on in
 * order to protect them from the experimental one would be the wrong trade.
 */
export async function identifyWithFallback(
  providers: readonly IdentifyProvider[],
  req: IdentifyRequest,
  conditionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<IdentifyOutcome | null> {
  const timeoutMs = opts.timeoutMs ?? EXPERIMENTAL_TIMEOUT_MS;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const isLast = i === providers.length - 1;

    let outcome: IdentifyOutcome | null = null;
    if (isLast) {
      try {
        outcome = await provider.identify(req, conditionId);
      } catch (err) {
        console.error(
          `[scout.identify] ${provider.name} failed:`,
          err instanceof Error ? err.message : String(err),
        );
        outcome = null;
      }
    } else {
      outcome = await withTimeout(provider.identify(req, conditionId), timeoutMs);
      if (outcome === null) {
        console.warn(
          `[scout.identify] ${provider.name} did not answer within ${timeoutMs}ms or had nothing; falling back`,
        );
      }
    }

    if (outcome) return outcome;
  }
  return null;
}

// ── the concrete providers ───────────────────────────────────────────────────

/**
 * TODAY'S BEHAVIOUR, unchanged, and the floor under every experiment.
 *
 * Comps from the hints the seller supplied — barcode, keyword, brand, category,
 * size — through the shared comp cache (US-2754). This is the path that works,
 * and nothing about the seam is allowed to alter it.
 */
/** The comp lookup hintsProvider uses. A parameter so a test can stand here. */
export type CompFetcher = typeof cachedSearchBrowseComps;

/**
 * Build the hints provider over a given comp lookup.
 *
 * The fetcher is injectable only because ES modules are immutable and there is
 * otherwise nowhere for a test to stand: the barcode-vs-keyword distinction this
 * provider exists to make cannot be exercised without reaching Supabase and
 * eBay. Production uses the default and behaves exactly as before.
 */
export function createHintsProvider(
  fetchComps: CompFetcher = cachedSearchBrowseComps,
): IdentifyProvider {
  return {
    name: "hints",
    async identify(req, conditionId) {
      const args = req.barcode
        ? {
          gtin: req.barcode,
          categoryId: req.categoryId || undefined,
          brand: req.brand || undefined,
          limit: 25,
          conditionId,
        }
        : {
          categoryId: req.categoryId,
          q: req.q || undefined,
          brand: req.brand || undefined,
          size: req.size || undefined,
          limit: 25,
          conditionId,
        };
      const { result } = await fetchComps(args);
      // Only a barcode pins an exact product, so only a barcode match is worth
      // prefilling from. A keyword's top hit is somebody else's listing title.
      const byBarcode = Boolean(req.barcode);
      return {
        comps: result,
        matchedTitle: byBarcode ? (result.items[0]?.title ?? null) : null,
        identitySource: byBarcode ? "barcode" : null,
        identityIsAuthoritative: byBarcode,
        provider: "hints",
      };
    },
  };
}

/**
 * TODAY'S BEHAVIOUR, unchanged, and the floor under every experiment.
 *
 * Comps from the hints the seller supplied - barcode, keyword, brand, category,
 * size - through the shared comp cache (US-2754). This is the path that works,
 * and nothing about the seam is allowed to alter it.
 */
export const hintsProvider: IdentifyProvider = createHintsProvider();

/**
 * THE EXPERIMENT. Visually similar live listings, straight from the photo.
 *
 * Returns null rather than throwing when it finds nothing, because "no visual
 * match" is an ordinary outcome for a garment eBay has never seen, not a fault.
 * Either way the caller falls back to hints.
 */
/** The image search createEbayImageProvider uses. A parameter so a test can stand here. */
export type ImageSearch = typeof searchBrowseCompsByImage;

/**
 * Build the visual-search provider over a given image search.
 *
 * Injectable for the same reason hints is: ES modules are immutable, and the
 * contract worth testing here — that no answer from this provider is ever
 * authoritative — cannot be exercised against a network the test has no
 * credentials for.
 */
export function createEbayImageProvider(
  search: ImageSearch = searchBrowseCompsByImage,
): IdentifyProvider {
  return {
    name: "ebay-image",
    async identify(req, conditionId) {
      if (!req.imageDataUri) return null;
      // US-2762: the gate is BEFORE the call, not after it.
      //
      // A detail, defect or measurement shot does not produce a weak answer that
      // could be filtered downstream — it produces a confident one about the
      // wrong thing. There is nothing in the response to filter on, so the only
      // place this can be decided is here, on the input.
      if (!roleCanIdentify(req.imageRole)) return null;
      // eBay wants raw base64; a data: prefix is rejected.
      const comma = req.imageDataUri.indexOf(",");
      const base64 = comma === -1 ? req.imageDataUri : req.imageDataUri.slice(comma + 1);
      if (!base64) return null;

      const result = await search({
        imageBase64: base64,
        categoryId: req.categoryId || undefined,
        conditionId,
        limit: 25,
      });
      // Nothing similar, or nothing priced: not an identification.
      if (result.items.length === 0 || result.stats.count === 0) return null;
      return {
        comps: result,
        matchedTitle: result.items[0]?.title ?? null,
        // A LOOK-ALIKE, offered for confirmation, never written as fact.
        //
        // The top hit here is a real listing that resembles the photo, which is a
        // genuinely useful thing to show a seller and a dangerous thing to save
        // for them. US-2758 measured this returning five Lululemon tanks for a
        // garment carrying no brand mark at all.
        identitySource: "visual",
        identityIsAuthoritative: false,
        provider: "ebay-image",
      };
    },
  };
}

/**
 * THE EXPERIMENT. Visually similar live listings, straight from the photo.
 *
 * Returns null rather than throwing when it finds nothing, because "no visual
 * match" is an ordinary outcome for a garment eBay has never seen, not a fault.
 * Either way the caller falls back to hints.
 */
export const ebayImageProvider: IdentifyProvider = createEbayImageProvider();
