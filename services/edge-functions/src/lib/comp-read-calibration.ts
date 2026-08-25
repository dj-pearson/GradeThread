// US-2842: the arithmetic of the calibration spike, separated from the spike.
//
// The spike itself cannot run here: it needs production credentials and about a
// hundred real AI calls. What CAN be built and tested here is every number it
// reports, so that when the founder runs it the only new thing is the data.
//
// THE QUESTION THE SPIKE ASKS. We already know what our own certified garments
// grade at, because we graded them. If we re-read those same garments from their
// LISTING photos, the way we would read a stranger's comp, how far off is the
// answer? That gap is the error the whole condition-priced comps bet inherits.
//
// FOUR NUMBERS, AND THEY MEAN DIFFERENT THINGS.
//
//   meanSignedError    bias. Positive means comp reads run HIGH: we would think
//                      other people's listings are in better condition than they
//                      are, and price a seller's item down against them. A bias
//                      is correctable with an offset. It is the better failure.
//   meanAbsoluteError  noise. This one is not correctable, and it is the number
//                      that decides whether a fitted slope means anything.
//   testRetestDelta    how much the reader disagrees with ITSELF on identical
//                      input. Whatever this is, the error above cannot be
//                      smaller; it is the floor under everything.
//   dollarsPerRead     what the moat costs per sample, measured rather than
//                      estimated, from the budget the run actually moved.
//
// NO VERDICT IS COMPUTED HERE, and that is deliberate. The story ends in a
// written GO or NO-GO from the founder. A threshold picked in advance by the
// person who wants the answer to be yes is not a gate.

/** One garment: what we certified it at, and what the comp read said. */
export interface CalibrationRead {
  /** Opaque, stable, and NOT a submission id. Only for pairing retests. */
  ref: string;
  certifiedScore: number;
  /** Null when the read failed or returned no score. Counted, never skipped. */
  readScore: number | null;
  readConfidence: number | null;
  imagesAnalyzed: number;
  /** A second read of the identical photos, for test-retest. Null when not run. */
  retestScore?: number | null;
  error?: string | null;
}

export interface BandStat {
  band: string;
  n: number;
  meanSignedError: number | null;
  meanAbsoluteError: number | null;
}

export interface CalibrationSummary {
  /** Garments attempted. */
  attempted: number;
  /** Garments that produced a score. The denominator of every mean below. */
  scored: number;
  /** Garments that produced no score at all. A read we could not make is a cost. */
  failed: number;
  meanSignedError: number | null;
  meanAbsoluteError: number | null;
  medianAbsoluteError: number | null;
  /** Share of reads within half a grade point. The agreement band used elsewhere. */
  withinHalfPoint: number | null;
  withinOnePoint: number | null;
  worstAbsoluteError: number | null;
  /** Pairs where both reads produced a score. */
  retestPairs: number;
  meanTestRetestDelta: number | null;
  maxTestRetestDelta: number | null;
  /** Per grade band, because a reader can be fine at 8 and hopeless at 4. */
  byBand: BandStat[];
  meanImagesAnalyzed: number | null;
  meanReadConfidence: number | null;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return round2(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length / 2;
  return round2(s.length % 2 === 1 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Grade bands, matching how the product already talks about condition.
 *
 * Split because an average over the whole scale hides the shape. A reader that
 * is tight at 8.5 and wild at 4.0 has a mean that looks survivable and a
 * sourcing ceiling that is dangerous on exactly the cheap, worn items a
 * reseller buys most of.
 */
export function gradeBand(score: number): string {
  if (score >= 9.5) return "9.5-10 new";
  if (score >= 8.5) return "8.5-9.4 excellent";
  if (score >= 7) return "7.0-8.4 very good";
  if (score >= 5.5) return "5.5-6.9 good";
  return "1.0-5.4 fair or poor";
}

const BAND_ORDER = [
  "9.5-10 new",
  "8.5-9.4 excellent",
  "7.0-8.4 very good",
  "5.5-6.9 good",
  "1.0-5.4 fair or poor",
];

/**
 * Every number the spike reports, from the reads it made. Pure.
 *
 * FAILED READS ARE COUNTED, NEVER DROPPED. A reader that answers confidently on
 * the easy half and refuses the rest would otherwise post a beautiful mean
 * absolute error, and the refusals are the whole story.
 */
export function summarizeCalibration(reads: CalibrationRead[]): CalibrationSummary {
  const scored = reads.filter((r) => r.readScore != null);
  const signed = scored.map((r) => round2((r.readScore as number) - r.certifiedScore));
  const abs = signed.map((d) => Math.abs(d));

  const pairs = reads.filter((r) => r.readScore != null && r.retestScore != null);
  const deltas = pairs.map((r) =>
    round2(Math.abs((r.readScore as number) - (r.retestScore as number)))
  );

  const byBand: BandStat[] = [];
  for (const band of BAND_ORDER) {
    const inBand = scored.filter((r) => gradeBand(r.certifiedScore) === band);
    if (inBand.length === 0) continue;
    const d = inBand.map((r) => round2((r.readScore as number) - r.certifiedScore));
    byBand.push({
      band,
      n: inBand.length,
      meanSignedError: mean(d),
      meanAbsoluteError: mean(d.map(Math.abs)),
    });
  }

  const within = (limit: number): number | null =>
    abs.length === 0 ? null : round4(abs.filter((a) => a <= limit + 1e-9).length / abs.length);

  return {
    attempted: reads.length,
    scored: scored.length,
    failed: reads.length - scored.length,
    meanSignedError: mean(signed),
    meanAbsoluteError: mean(abs),
    medianAbsoluteError: median(abs),
    withinHalfPoint: within(0.5),
    withinOnePoint: within(1.0),
    worstAbsoluteError: abs.length === 0 ? null : round2(Math.max(...abs)),
    retestPairs: pairs.length,
    meanTestRetestDelta: mean(deltas),
    maxTestRetestDelta: deltas.length === 0 ? null : round2(Math.max(...deltas)),
    byBand,
    meanImagesAnalyzed: mean(scored.map((r) => r.imagesAnalyzed)),
    meanReadConfidence: mean(
      scored.filter((r) => r.readConfidence != null).map((r) => r.readConfidence as number),
    ),
  };
}

// ── cost ────────────────────────────────────────────────────────────

/** One row of ai_budget_status(), as much of it as this needs. */
export interface BudgetRow {
  feature: string;
  period: string;
  spendUsd: number;
}

export interface CostReport {
  feature: string;
  beforeUsd: number | null;
  afterUsd: number | null;
  spentUsd: number | null;
  reads: number;
  dollarsPerRead: number | null;
  /** Set when the number cannot be trusted, with the reason in plain words. */
  caveat: string | null;
}

/**
 * Dollars per read, from the budget the run actually moved.
 *
 * MEASURED, NOT ESTIMATED, and the difference matters: a token-count estimate
 * would be built from the same assumptions the spike exists to test. The
 * caveats are part of the answer, not a footnote. This machine has no way to
 * know whether anything else was grading at the same time, so if it cannot be
 * sure, it says so rather than quoting a per-read cost that includes somebody
 * else's traffic.
 */
export function costPerRead(
  before: BudgetRow[],
  after: BudgetRow[],
  reads: number,
  feature = "grading",
  period = "day",
): CostReport {
  const pick = (rows: BudgetRow[]): number | null => {
    const row = rows.find((r) => r.feature === feature && r.period === period);
    return row && Number.isFinite(row.spendUsd) ? row.spendUsd : null;
  };
  const b = pick(before);
  const a = pick(after);

  if (b == null || a == null) {
    return {
      feature,
      beforeUsd: b,
      afterUsd: a,
      spentUsd: null,
      reads,
      dollarsPerRead: null,
      caveat:
        `No '${feature}' budget on the '${period}' period, so there is no spend counter to difference. ` +
        `Create one in the admin AI budgets page and re-run, or read the cost off the spend dashboard by hand.`,
    };
  }
  if (reads <= 0) {
    return {
      feature,
      beforeUsd: b,
      afterUsd: a,
      spentUsd: round4(a - b),
      reads,
      dollarsPerRead: null,
      caveat: "No reads were made, so there is nothing to divide by.",
    };
  }

  const spent = round4(a - b);
  if (spent < 0) {
    return {
      feature,
      beforeUsd: b,
      afterUsd: a,
      spentUsd: spent,
      reads,
      dollarsPerRead: null,
      caveat:
        "Spend went DOWN across the run, which means the period rolled over mid-run " +
        "(a 'day' budget resets at midnight UTC). Re-run inside one period.",
    };
  }

  return {
    feature,
    beforeUsd: b,
    afterUsd: a,
    spentUsd: spent,
    reads,
    dollarsPerRead: round4(spent / reads),
    caveat:
      "Includes ALL grading spend in the window, not only this run. If anything else " +
      "was grading at the same time, this over-states the per-read cost.",
  };
}

// ── candidate selection ─────────────────────────────────────────────
//
// Lives here rather than in the script so the three-way join can be executed by
// a test instead of read. The risk it carries is not exotic: a garment
// qualifies only if it has a certified report AND a FlipDesk link AND a public
// photo, and a wrong filter anywhere in that chain returns zero rows, which
// looks exactly like "we have no data" rather than like a bug.

export interface CalibrationCandidate {
  ref: string;
  certifiedScore: number;
  brand: string | null;
  title: string | null;
  photoUrls: string[];
}

export interface ReportRow {
  id: string;
  submission_id: string | null;
  overall_score: number | string;
}
export interface LinkRow {
  inventory_item_id: string;
  submission_id: string;
}
export interface ItemRow {
  id: string;
  brand: string | null;
  title: string | null;
}
export interface PhotoRow {
  inventory_item_id: string;
  photo_url: string;
}

/** How many photos one read may use. The endpoint caps this too; this is ours. */
export const MAX_PHOTOS_PER_READ = 6;

/**
 * Only http(s) reaches the endpoint, which FETCHES these.
 *
 * A storage path is not a URL, and a data: URI is not something a comp read
 * would ever meet. Filtering here rather than letting the endpoint 400 keeps a
 * malformed row out of the failure count, where it would look like the reader
 * refusing a garment.
 */
export function isFetchableUrl(u: string | null | undefined): boolean {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}

/**
 * Pair the four row sets into candidates, newest first, capped at `limit`.
 *
 * Pure: the script does the four reads and hands the rows over. `makeRef` is
 * injected because hashing is async and a test wants a stable, boring ref.
 */
export function buildCandidates(
  reports: ReportRow[],
  links: LinkRow[],
  items: ItemRow[],
  photos: PhotoRow[],
  limit: number,
  makeRef: (reportId: string) => string,
): CalibrationCandidate[] {
  const itemBySubmission = new Map<string, string>();
  for (const l of links) itemBySubmission.set(l.submission_id, l.inventory_item_id);

  const itemById = new Map<string, ItemRow>();
  for (const i of items) itemById.set(i.id, i);

  const photosByItem = new Map<string, string[]>();
  for (const p of photos) {
    if (!isFetchableUrl(p.photo_url)) continue;
    const list = photosByItem.get(p.inventory_item_id) ?? [];
    list.push(p.photo_url.trim());
    photosByItem.set(p.inventory_item_id, list);
  }

  const out: CalibrationCandidate[] = [];
  for (const r of reports) {
    if (out.length >= limit) break;
    if (!r.submission_id) continue;
    const itemId = itemBySubmission.get(r.submission_id);
    if (!itemId) continue;
    const urls = photosByItem.get(itemId) ?? [];
    if (urls.length === 0) continue;
    const score = typeof r.overall_score === "number"
      ? r.overall_score
      : Number(r.overall_score);
    if (!Number.isFinite(score)) continue;
    const item = itemById.get(itemId);
    out.push({
      ref: makeRef(r.id),
      certifiedScore: score,
      brand: item?.brand ?? null,
      title: item?.title ?? null,
      photoUrls: urls.slice(0, MAX_PHOTOS_PER_READ),
    });
  }
  return out;
}

/**
 * Which of the three requirements is missing, in plain words.
 *
 * "No candidates" is the least useful message this could print: it reads as
 * "we have no graded garments" when the real answer is usually "they are graded
 * but not linked to a FlipDesk item" or "linked but never photographed". The
 * founder should not have to write SQL to find that out.
 */
export function explainNoCandidates(
  reports: ReportRow[],
  links: LinkRow[],
  photos: PhotoRow[],
): string {
  if (reports.length === 0) {
    return "No certified grade reports matched. Check the owner id, or pass --all-tenants.";
  }
  const withSubmission = reports.filter((r) => r.submission_id).length;
  if (withSubmission === 0) {
    return `${reports.length} certified report(s), but none carries a submission_id, so none can be traced to an item.`;
  }
  if (links.length === 0) {
    return `${withSubmission} certified report(s) with a submission, but none is linked to a FlipDesk inventory item (flipdesk_grading_submissions is empty for them). These were graded outside FlipDesk, so they have no listing photos to re-read.`;
  }
  const fetchable = photos.filter((p) => isFetchableUrl(p.photo_url)).length;
  if (fetchable === 0) {
    return `${links.length} linked item(s), but none has an http(s) listing photo (${photos.length} photo row(s) seen). Photos live in the public item-photos bucket; a storage path alone cannot be fetched.`;
  }
  return `Rows exist at every step (${reports.length} report(s), ${links.length} link(s), ${fetchable} photo(s)) but nothing paired up. The links and the photos probably belong to different items.`;
}
