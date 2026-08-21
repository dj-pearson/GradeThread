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
  barcode: string;
  q: string;
  brand: string;
  categoryId: string;
  size: string;
}

export interface IdentifyOutcome {
  /** Comps to value against. */
  comps: BrowseCompsResult;
  /** A product title this provider recognised, for prefilling /buy. */
  matchedTitle: string | null;
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
export const hintsProvider: IdentifyProvider = {
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
    const { result } = await cachedSearchBrowseComps(args);
    return {
      comps: result,
      // Only a barcode pins an exact product, so only a barcode match is worth
      // prefilling from. A keyword's top hit is somebody else's listing title.
      matchedTitle: req.barcode ? (result.items[0]?.title ?? null) : null,
      provider: "hints",
    };
  },
};

/**
 * THE EXPERIMENT. Visually similar live listings, straight from the photo.
 *
 * Returns null rather than throwing when it finds nothing, because "no visual
 * match" is an ordinary outcome for a garment eBay has never seen, not a fault.
 * Either way the caller falls back to hints.
 */
export const ebayImageProvider: IdentifyProvider = {
  name: "ebay-image",
  async identify(req, conditionId) {
    if (!req.imageDataUri) return null;
    // eBay wants raw base64; a data: prefix is rejected.
    const comma = req.imageDataUri.indexOf(",");
    const base64 = comma === -1 ? req.imageDataUri : req.imageDataUri.slice(comma + 1);
    if (!base64) return null;

    const result = await searchBrowseCompsByImage({
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
      provider: "ebay-image",
    };
  },
};
