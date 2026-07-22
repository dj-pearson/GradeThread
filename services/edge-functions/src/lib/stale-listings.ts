// Stale-listing playbook (US-1899).
//
// eBay's search team is explicit that end-and-relist DESTROYS a listing's
// accumulated performance data — the right move on a listing that isn't selling
// is a REVISE IN PLACE (better title, more photos, a price move toward comps),
// not a relist. This module turns the per-listing traffic history we already
// collect (listing_metrics, US-565, via Sell Analytics getTrafficReport) into a
// staleness verdict plus concrete revise suggestions.
//
// It is deliberately PURE: it takes already-aggregated signals and returns a
// decision, with no DB, clock, or network access, so every threshold and every
// suggestion branch is unit-testable. The route assembles the signals
// (tenant-scoped) and calls decideStaleListing().
//
// THE ONE HARD RULE (AC3): nothing here ends or relists anything. The strongest
// verdict it can reach is `sellSimilarEligible` — a HINT that a 90+-day
// zero-engagement listing MAY be worth a manual "Sell Similar", surfaced with a
// confirmation on the client. Auto end/relist is never emitted and never
// implied.

/** Default window (days) over which zero clicks marks a listing stale. */
export const DEFAULT_STALE_WINDOW_DAYS = 45;

/**
 * A listing must be zero-engagement for at least this long before "Sell Similar"
 * is even offered as a manual last resort. Longer than the stale window on
 * purpose: revising in place is always tried first; relisting is the escalation.
 */
export const DEFAULT_SELL_SIMILAR_MIN_DAYS = 90;

/** Below this photo count we suggest adding photos (eBay allows up to 24). */
export const MIN_PHOTOS = 3;

/**
 * eBay titles allow 80 characters; a title well under this is leaving keyword
 * budget — and buyer information — on the table. Treated as a weak-title signal.
 */
export const WEAK_TITLE_LEN = 60;

export type ReviseSuggestionKind =
  | "weak_title"
  | "add_photos"
  | "improve_thumbnail"
  | "reprice";

export interface ReviseSuggestion {
  kind: ReviseSuggestionKind;
  message: string;
}

/**
 * Already-aggregated inputs for one listing. The route computes these from
 * listings + listing_metrics + item_photos; the engine never touches a DB.
 */
export interface StaleListingSignal {
  listingId: string;
  /** Current listing title (for the weak-title heuristic). */
  title: string | null;
  /** Number of photos on the listing / its inventory item. */
  photoCount: number;
  /** How many days the listing has been live (active). */
  activeDays: number;
  /** Summed search impressions over the staleness window. */
  windowImpressions: number;
  /** Summed listing VIEWS (clicks from search) over the window. Zero = stale. */
  windowViews: number;
  /** Current watcher count. */
  watchers: number;
}

export interface StaleListingDecision {
  listingId: string;
  isStale: boolean;
  /** The window (days) the verdict was computed over. */
  windowDays: number;
  /** Why it is (or isn't) stale — a short operator-facing phrase. */
  reason: string;
  /** Concrete, actionable revise suggestions. Empty when not stale. */
  suggestions: ReviseSuggestion[];
  /**
   * True only for 90+-day zero-engagement listings: the client MAY offer a
   * manual "Sell Similar" with a confirmation. Never an instruction to relist.
   */
  sellSimilarEligible: boolean;
}

export interface StaleListingOptions {
  /** Zero-click window in days. Default 45; caller-configurable per AC2. */
  windowDays?: number;
  /** Min days of zero engagement before Sell Similar is offered. Default 90. */
  sellSimilarMinDays?: number;
}

function num(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Decide whether a listing is stale and, if so, what to revise.
 *
 * Stale = live for at least the whole window AND zero clicks (views) across it.
 * A listing younger than the window has not had a fair chance yet, so it is
 * never marked stale — that would flag brand-new listings and train sellers to
 * ignore the surface.
 */
export function decideStaleListing(
  signal: StaleListingSignal,
  options: StaleListingOptions = {},
): StaleListingDecision {
  const windowDays = num(options.windowDays ?? DEFAULT_STALE_WINDOW_DAYS) ||
    DEFAULT_STALE_WINDOW_DAYS;
  const sellSimilarMinDays =
    num(options.sellSimilarMinDays ?? DEFAULT_SELL_SIMILAR_MIN_DAYS) ||
    DEFAULT_SELL_SIMILAR_MIN_DAYS;

  const activeDays = num(signal.activeDays);
  const impressions = num(signal.windowImpressions);
  const views = num(signal.windowViews);
  const watchers = num(signal.watchers);
  const photoCount = num(signal.photoCount);

  const hadFairChance = activeDays >= windowDays;
  const zeroClicks = views === 0;
  const isStale = hadFairChance && zeroClicks;

  if (!isStale) {
    return {
      listingId: signal.listingId,
      isStale: false,
      windowDays,
      reason: !hadFairChance
        ? `Live ${activeDays}d — too new to judge (needs ${windowDays}d)`
        : `${views} click(s) in the last ${windowDays}d`,
      suggestions: [],
      sellSimilarEligible: false,
    };
  }

  const suggestions: ReviseSuggestion[] = [];

  // Impressed but never clicked → buyers SEE it in search and pass. The lead
  // photo (thumbnail) and title are what they judge in that half-second.
  if (impressions > 0) {
    suggestions.push({
      kind: "improve_thumbnail",
      message:
        `Shown ${impressions} time(s) but clicked 0 — the lead photo isn't ` +
        `winning the click. Try a brighter, better-framed front shot.`,
    });
  } else {
    // Not even being shown → keywords/price put it outside the results buyers
    // see. A price move toward comps and stronger title keywords widen reach.
    suggestions.push({
      kind: "reprice",
      message:
        `Barely surfaced in search over ${windowDays}d — a price move toward ` +
        `comps and stronger title keywords widen how often it's shown.`,
    });
  }

  // Weak/short title: under-using the 80-char budget is a common, cheap miss.
  const titleLen = (signal.title ?? "").trim().length;
  if (titleLen > 0 && titleLen < WEAK_TITLE_LEN) {
    suggestions.push({
      kind: "weak_title",
      message:
        `Title is ${titleLen}/80 chars — add brand, size, colour and material ` +
        `keywords buyers actually search.`,
    });
  }

  // Missing photos: fewer than MIN_PHOTOS is a trust and detail gap.
  if (photoCount < MIN_PHOTOS) {
    suggestions.push({
      kind: "add_photos",
      message:
        `Only ${photoCount} photo(s) — add more angles, the label, and any ` +
        `flaws close-up. More photos lift both clicks and buyer confidence.`,
    });
  }

  // Sell Similar is a MANUAL last resort, offered only after long, total
  // zero-engagement — never auto, never for a listing that still has watchers.
  const sellSimilarEligible =
    activeDays >= sellSimilarMinDays && views === 0 && watchers === 0;

  return {
    listingId: signal.listingId,
    isStale: true,
    windowDays,
    reason: `0 clicks in ${windowDays}d (live ${activeDays}d)`,
    suggestions,
    sellSimilarEligible,
  };
}
