// US-2676: judging title variants by click-through instead of by sell-through.
//
// THE PROBLEM WITH SELL-THROUGH HERE. summarizeTitleVariantSellThrough (in
// demand-terms.ts, US-546) scores a variant by what fraction of the listings
// carrying it eventually sold. That is the right metric for a catalogue with
// repeat SKUs, where the same title runs a hundred times and the rate converges.
// FlipDesk sells one-of-a-kind second-hand clothing: each title runs on exactly
// one garment, that garment sells once or never, and the sample only grows as
// fast as inventory turns. A variant reaches a readable sell-through number
// somewhere around the time the seller has stopped caring.
//
// Click-through moves in days rather than months, because impressions accrue
// whether or not anything sells, and it measures the thing a title can actually
// influence: whether someone who SAW the search result clicked it. What happens
// after the click is the photos, the price and the description, none of which
// the title wrote.
//
// SO WHY KEEP SELL-THROUGH AT ALL. Because CTR alone rewards a title that wins
// the click and loses the sale -- the clickbait failure mode, which is real and
// which eBay's own policy language warns about. A readout here can name a CTR
// winner on its own; PROMOTING one requires sell-through to agree. That split
// is the whole design: report early, promote late.
//
// Pure. No I/O, no clock, no randomness. The caller fetches rows and scopes
// them (US-268); this file only does arithmetic.

import { supabaseAdmin } from "./supabase.ts";

/**
 * Impressions each label needs before a comparison means anything.
 *
 * Below this the difference between two CTRs is sampling noise wearing a
 * decimal point: at 20 impressions one extra click moves the rate by five
 * percentage points. Both labels must clear it independently -- a comparison is
 * only as sound as its thinner side, so a 10,000-impression champion tells you
 * nothing about a challenger that has been seen 30 times.
 */
export const MIN_VARIANT_IMPRESSIONS = 200;

/**
 * How much better a label's CTR must be, as a ratio, to be called a winner.
 *
 * 1.15 means "at least 15% better, relatively". Deliberately a ratio and not a
 * percentage-point gap: going from 0.4% to 0.8% and from 8% to 8.4% are both
 * "0.4 points" and only one of them is a real change in behaviour.
 */
export const MIN_CTR_LIFT = 1.15;

/** One listing's traffic, already joined to the variant label that was live. */
export interface VariantMetricRow {
  listingId: string;
  /** listings.active_title_variant. Blank is treated as "A", as elsewhere. */
  activeLabel: string;
  impressions: number;
  views: number;
  /**
   * eBay's own rate for the window, 0..1, or null when it reported none.
   * Recorded but NOT aggregated -- see the note on pooling below.
   */
  clickThroughRate: number | null;
  sold: boolean;
  /** listings.ai_prompt_version, so AC4 can slice CTR per prompt version. */
  promptVersion?: string | null;
}

export interface VariantPerformance {
  label: string;
  listings: number;
  impressions: number;
  views: number;
  /** Pooled views / impressions, 0..1. Null when the label had no impressions. */
  clickThroughRate: number | null;
  sold: number;
  sellThrough: number;
  /** Prompt versions that produced listings under this label, sorted. */
  promptVersions: string[];
}

export type VariantReadout =
  | {
    state: "not_enough_exposure";
    minImpressions: number;
    /** Labels still short of the floor, sorted. */
    short: string[];
    variants: VariantPerformance[];
  }
  | {
    state: "no_clear_winner";
    variants: VariantPerformance[];
  }
  | {
    state: "ctr_winner";
    label: string;
    /** Winner CTR divided by runner-up CTR. */
    ctrLift: number;
    /**
     * Whether the CTR winner ALSO has the better sell-through.
     *
     * False is not a failure, it is the interesting case: a title winning the
     * click and losing the sale. Auto-promotion must require true; a dashboard
     * should show the readout either way.
     */
    agreesWithSellThrough: boolean;
    variants: VariantPerformance[];
  };

function labelOf(raw: string): string {
  return (raw || "A").trim() || "A";
}

function finite(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Roll traffic rows up per variant label.
 *
 * CTR IS POOLED (total views / total impressions), NOT averaged across rows.
 * Averaging per-listing rates gives a garment seen 12 times the same say as one
 * seen 12,000 times, so a single dud listing with an accidental 50% rate can
 * outvote the whole rest of the label. Pooling asks the only question that
 * survives that: of everyone who saw a listing wearing this wording, what
 * fraction clicked.
 *
 * The eBay-reported per-row rate is kept on the input for auditing and is
 * deliberately not summed into anything -- it is a rate over a window we do not
 * control, and rates do not add.
 */
export function summarizeVariantCtr(rows: VariantMetricRow[]): VariantPerformance[] {
  const byLabel = new Map<string, {
    listings: number;
    impressions: number;
    views: number;
    sold: number;
    promptVersions: Set<string>;
  }>();

  for (const row of rows ?? []) {
    const label = labelOf(row.activeLabel);
    const agg = byLabel.get(label) ?? {
      listings: 0,
      impressions: 0,
      views: 0,
      sold: 0,
      promptVersions: new Set<string>(),
    };
    agg.listings += 1;
    agg.impressions += finite(row.impressions);
    agg.views += finite(row.views);
    if (row.sold) agg.sold += 1;
    if (row.promptVersion) agg.promptVersions.add(row.promptVersion);
    byLabel.set(label, agg);
  }

  const out: VariantPerformance[] = [];
  for (const [label, agg] of byLabel) {
    out.push({
      label,
      listings: agg.listings,
      impressions: agg.impressions,
      views: agg.views,
      clickThroughRate: agg.impressions > 0 ? agg.views / agg.impressions : null,
      sold: agg.sold,
      sellThrough: agg.listings > 0 ? agg.sold / agg.listings : 0,
      promptVersions: [...agg.promptVersions].sort(),
    });
  }

  // Deterministic: by label, not by performance. The ordering of this list is
  // not a ranking, and sorting it by CTR would invite reading it as one.
  out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return out;
}

/**
 * Decide whether the traffic so far names a winner.
 *
 * Three outcomes, and the first is the common one for a long time: not enough
 * exposure. Returning a state rather than a null keeps the caller honest --
 * "no winner yet" and "the variants tied" look identical in a nullable return
 * and mean completely different things to a seller.
 */
export function readVariantWinner(
  rows: VariantMetricRow[],
  opts: { minImpressions?: number; minLift?: number } = {},
): VariantReadout {
  const minImpressions = opts.minImpressions ?? MIN_VARIANT_IMPRESSIONS;
  const minLift = opts.minLift ?? MIN_CTR_LIFT;
  const variants = summarizeVariantCtr(rows);

  // A one-sided experiment is not an experiment. Reported as not-enough-exposure
  // rather than as a walkover, because the missing label has no exposure at all.
  const short = variants
    .filter((v) => v.impressions < minImpressions)
    .map((v) => v.label);
  if (variants.length < 2 || short.length > 0) {
    return {
      state: "not_enough_exposure",
      minImpressions,
      short: variants.length < 2 ? variants.map((v) => v.label) : short,
      variants,
    };
  }

  const ranked = [...variants].sort((a, b) =>
    (b.clickThroughRate ?? 0) - (a.clickThroughRate ?? 0)
  );
  const best = ranked[0]!;
  const next = ranked[1]!;
  const bestCtr = best.clickThroughRate ?? 0;
  const nextCtr = next.clickThroughRate ?? 0;

  // Everyone above the floor clicked nothing. Real, and not a tie to break.
  if (bestCtr <= 0) return { state: "no_clear_winner", variants };

  const ctrLift = nextCtr > 0 ? bestCtr / nextCtr : Infinity;
  if (ctrLift < minLift) return { state: "no_clear_winner", variants };

  return {
    state: "ctr_winner",
    label: best.label,
    ctrLift,
    // Ties count as agreement: sell-through has nothing to say against the CTR
    // winner, and on this inventory a tie is usually two zeroes.
    agreesWithSellThrough: best.sellThrough >= next.sellThrough,
    variants,
  };
}

/** Per-prompt-version traffic, for AC4's CTR-beside-keep-rate readout. */
export interface PromptCtr {
  promptVersion: string;
  listings: number;
  impressions: number;
  views: number;
  clickThroughRate: number | null;
}

/**
 * The same pooling, sliced by the prompt version that wrote the listing rather
 * than by the variant label.
 *
 * Rows with no prompt version are DROPPED, not bucketed under "unknown": a
 * bucket that mixes every unattributed listing produces a number that looks
 * comparable to the real ones and is not.
 */
export function summarizeCtrByPromptVersion(rows: VariantMetricRow[]): PromptCtr[] {
  const byVersion = new Map<string, { listings: number; impressions: number; views: number }>();

  for (const row of rows ?? []) {
    const version = row.promptVersion?.trim();
    if (!version) continue;
    const agg = byVersion.get(version) ?? { listings: 0, impressions: 0, views: 0 };
    agg.listings += 1;
    agg.impressions += finite(row.impressions);
    agg.views += finite(row.views);
    byVersion.set(version, agg);
  }

  const out: PromptCtr[] = [];
  for (const [promptVersion, agg] of byVersion) {
    out.push({
      promptVersion,
      listings: agg.listings,
      impressions: agg.impressions,
      views: agg.views,
      clickThroughRate: agg.impressions > 0 ? agg.views / agg.impressions : null,
    });
  }
  out.sort((a, b) => (a.promptVersion < b.promptVersion ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// The fetch. Everything above this line is pure; everything below touches the
// database and is therefore the part US-268 is about.
// ---------------------------------------------------------------------------


/**
 * Load one traffic row per listing for a single tenant.
 *
 * TENANT SCOPING (US-268). The edge runs on the service-role client, which
 * bypasses RLS, so both reads are filtered on the resolved owner id explicitly:
 * listing_metrics carries its own user_id column (migration 00159) and listings
 * is filtered the same way. The caller passes
 * workspaceOwnerId ?? userId -- a workspace member acting in someone's
 * workspace reads the OWNER's traffic, not their own.
 *
 * ONE ROW PER LISTING, THE LATEST, NEVER A SUM ACROSS DATES. The sync writes
 * eBay's rolling-window figures (impressions_7d and friends), so consecutive
 * daily snapshots overlap heavily. Adding them would count the same impression
 * up to seven times and inflate every label that has been live longer, which
 * is exactly the bias an A/B test must not have.
 */
export async function fetchVariantMetricRows(ownerId: string): Promise<VariantMetricRow[]> {
  const { data: metricsRaw, error: metricsErr } = await supabaseAdmin
    .from("listing_metrics")
    .select("listing_id, metric_date, impressions, views, click_through_rate")
    .eq("user_id", ownerId)
    .order("metric_date", { ascending: false });
  if (metricsErr) {
    throw new Error("Failed to load listing metrics: " + metricsErr.message);
  }

  const metrics = (metricsRaw ?? []) as Array<{
    listing_id: string;
    metric_date: string;
    impressions: number | null;
    views: number | null;
    click_through_rate: number | null;
  }>;

  // Ordered newest first, so the FIRST row seen for a listing is its latest.
  const latest = new Map<string, (typeof metrics)[number]>();
  for (const row of metrics) {
    if (!latest.has(row.listing_id)) latest.set(row.listing_id, row);
  }
  if (latest.size === 0) return [];

  const { data: listingsRaw, error: listingsErr } = await supabaseAdmin
    .from("listings")
    .select("id, active_title_variant, listing_status, ai_prompt_version")
    .eq("user_id", ownerId)
    .in("id", [...latest.keys()]);
  if (listingsErr) {
    throw new Error("Failed to load listings for variant CTR: " + listingsErr.message);
  }

  const listings = (listingsRaw ?? []) as Array<{
    id: string;
    active_title_variant: string | null;
    listing_status: string | null;
    ai_prompt_version: string | null;
  }>;

  const out: VariantMetricRow[] = [];
  for (const listing of listings) {
    // A metrics row whose listing did not come back belongs to another tenant
    // or has been deleted. Dropped rather than defaulted: the join is the
    // second half of the ownership check, not a convenience.
    const row = latest.get(listing.id);
    if (!row) continue;
    out.push({
      listingId: listing.id,
      activeLabel: listing.active_title_variant ?? "A",
      impressions: row.impressions ?? 0,
      views: row.views ?? 0,
      clickThroughRate: row.click_through_rate,
      sold: listing.listing_status === "sold",
      promptVersion: listing.ai_prompt_version,
    });
  }
  return out;
}

/** Convenience: fetch, then read the winner. Same scoping, one call. */
export async function readVariantWinnerForOwner(
  ownerId: string,
  opts: { minImpressions?: number; minLift?: number } = {},
): Promise<VariantReadout> {
  return readVariantWinner(await fetchVariantMetricRows(ownerId), opts);
}
