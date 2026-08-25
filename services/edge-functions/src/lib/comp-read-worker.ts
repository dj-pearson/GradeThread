// US-2845: the comp read worker. Demand-ordered, budget-capped, nothing crawled.
//
// Reads comp listings for condition so a cell can be fitted to a price-vs-grade
// slope (US-2846). Full contract and the demand-not-crawl argument live in
// vault/20-domain/comp-read-worker.md.
//
// THIS FILE IS PURE. Every decision the worker makes is here and unit-tested:
// which cells come next, which listings inside a cell get read, when a job is
// stale, when the budget stops everything. The I/O that carries those decisions
// out lives in routes/jobs-comp-read.ts behind injected deps, so the part that
// can be wrong is the part that is covered.
//
// THREE REFUSALS ARE STRUCTURAL, not policy that can be tuned later.
//
// 1. NO CRAWL. The queue is fed only by cells our own sellers asked about,
//    through applyMeasuredCurve, which every graded, scouted and listed value
//    already passes through. There is no catalogue enumeration anywhere, and
//    nothing here can produce a cell nobody asked for. Coverage follows demand
//    because demand is the only input.
//
// 2. NO SCRAPING. Listings come from searchBrowseComps, the eBay Browse API,
//    the same client the rest of the product uses. No marketplace HTML is
//    fetched or parsed.
//
// 3. NO UNBOUNDED SPEND. Every read is preceded by a budget check against the
//    comp_read budget at action kill, and a breach stops the batch where it
//    stands rather than at the end of the cell, the batch, or the cron tick.

import { type CompReadInput } from "./comp-reads.ts";
import {
  type CompReadSample,
  type CurveFit,
  fitCurve,
  type HoldOutScore,
  holdOutScore,
  publishable,
} from "./comp-curve-fit.ts";
import { type CompPhoto, type HashCellCount, isStockPhotoSet } from "./comp-stock-photo.ts";

// ── caps (AC5: named, exported, tested) ─────────────────────────────

/**
 * Photos sent to one read.
 *
 * Four. A comp listing's gallery leads with the shots that carry condition, and
 * the tail is packaging, tags and the seller's watermark. Paying for image five
 * buys noise, and it buys it on every read, forever.
 */
export const MAX_IMAGES_PER_READ = 4;

/**
 * Listings read from one cell in one pass.
 *
 * Twelve, which is MIN_HIGH_CONFIDENCE_READS in comp-curve-fit.ts. A cell needs
 * twelve confident reads before it may publish, so a pass that reads fewer
 * cannot finish a cell and a pass that reads more is buying sample for a cell
 * that already has enough to be scored. Reads accumulate across passes.
 */
export const MAX_READS_PER_CELL = 12;

/** Cells in one batch. Bounds the wall-clock of a single cron tick. */
export const MAX_CELLS_PER_BATCH = 8;

/**
 * How long before a cell may be read again.
 *
 * Seven days, matching the curve TTL in condition-curve.ts. Comps drift slowly,
 * and re-reading a cell the same afternoon spends money to confirm what we
 * already hold.
 */
export const CELL_REREAD_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

/**
 * A job started this many times fails terminally.
 *
 * Five, the same cap the autolister uses. This is what stops an unattended
 * reclaim loop from burning the AI budget forever: a cell that keeps dying
 * stops being retried rather than being retried until the budget kills it.
 */
export const MAX_JOB_ATTEMPTS = 5;

/**
 * The three timeouts, and the ordering between them is the contract.
 *
 * READ < JOB_STALE < BATCH_STALE. A live job must never look stale, or the
 * reclaim cron will hand a running cell to a second worker and both will pay
 * for the same reads.
 */
export const READ_TIMEOUT_MS = 120_000;
export const JOB_STALE_MS = 6 * 60_000;
export const BATCH_STALE_MS = 15 * 60_000;

/** Concurrent cells in one batch. Matches the autolister's bounded pool. */
export const CONCURRENCY = 2;

/** The ai_usage_events feature and the flag its budget kills. */
export const COMP_READ_FEATURE = "comp_read";

// ── the demand queue ────────────────────────────────────────────────

export interface DemandRow {
  cell_key: string;
  category_id: string | null;
  brand: string | null;
  query: string | null;
  demand_count: number;
  last_seen_at: string;
  last_read_at: string | null;
}

export interface QueuedCell {
  cellKey: string;
  categoryId: string;
  brand: string | null;
  query: string | null;
  demandCount: number;
}

/**
 * The next cells to read, most-asked first.
 *
 * A cell with no categoryId is DROPPED, not guessed at: searchBrowseComps needs
 * one, and inventing a category is how a Carhartt jacket gets comped against
 * handbags.
 *
 * Ties break on how recently the cell was asked about, so two equally popular
 * cells are separated by which one a seller touched this morning.
 */
export function nextCells(
  rows: DemandRow[],
  now: number,
  limit: number = MAX_CELLS_PER_BATCH,
  cooldownMs: number = CELL_REREAD_COOLDOWN_MS,
): QueuedCell[] {
  const due = rows.filter((r) => {
    if (!r.category_id || r.category_id.trim() === "") return false;
    if (!r.cell_key || r.cell_key.trim() === "") return false;
    if (!r.last_read_at) return true;
    const t = Date.parse(r.last_read_at);
    if (!Number.isFinite(t)) return true;
    return now - t >= cooldownMs;
  });

  due.sort((a, b) => {
    if (b.demand_count !== a.demand_count) return b.demand_count - a.demand_count;
    return (Date.parse(b.last_seen_at) || 0) - (Date.parse(a.last_seen_at) || 0);
  });

  return due.slice(0, Math.max(0, limit)).map((r) => ({
    cellKey: r.cell_key,
    categoryId: (r.category_id as string).trim(),
    brand: r.brand,
    query: r.query,
    demandCount: r.demand_count,
  }));
}

// ── what to read inside a cell ──────────────────────────────────────

/** A comp listing, as much of it as the worker needs. */
export interface CompListing {
  itemId: string;
  title: string;
  priceCents: number | null;
  currency: string;
  imageUrls: string[];
}

export interface PlannedRead {
  listing: CompListing;
  imageUrls: string[];
}

export interface ReadPlan {
  reads: PlannedRead[];
  /** Listings skipped because they carry no usable price or photo. */
  unusable: number;
  /** Listings skipped because the cell's per-pass cap was reached. */
  overCap: number;
}

/**
 * Decide which listings in a cell to read, and with how many photos.
 *
 * A listing with no price is skipped before it costs anything: the fit needs a
 * price, so a read without one is a read we would pay for and then discard.
 */
export function planCellReads(
  listings: CompListing[],
  cap: number = MAX_READS_PER_CELL,
  imagesPerRead: number = MAX_IMAGES_PER_READ,
): ReadPlan {
  const reads: PlannedRead[] = [];
  let unusable = 0;
  let overCap = 0;

  for (const l of listings) {
    const urls = (l.imageUrls ?? []).filter((u) => /^https?:\/\//i.test(u ?? ""));
    if (urls.length === 0 || l.priceCents == null || l.priceCents <= 0) {
      unusable++;
      continue;
    }
    if (reads.length >= cap) {
      overCap++;
      continue;
    }
    reads.push({ listing: l, imageUrls: urls.slice(0, imagesPerRead) });
  }
  return { reads, unusable, overCap };
}

// ── one read, turned into a row ─────────────────────────────────────

export interface ReadOutcome {
  photos: CompPhoto[];
  score: number | null;
  confidence: number | null;
  imagesAnalyzed: number;
}

/**
 * Build the sample row for one read, running the stock-photo detector first.
 *
 * A stock-rejected read is KEPT as a row and marked, never dropped: knowing how
 * much of a cell is catalog imagery is worth knowing, and comp-curve-fit.ts is
 * the only door into a curve and already refuses them.
 */
export function toReadInput(
  cellKey: string,
  photoSetHash: string,
  outcome: ReadOutcome,
  currency: string,
  priceCents: number | null,
  cellsForHash: HashCellCount,
): CompReadInput {
  const verdict = isStockPhotoSet({ cellKey, photos: outcome.photos }, cellsForHash);
  // "No photos" is unusable rather than stock, and the two must not be recorded
  // as the same thing. isStockPhotoSet already says so; this preserves it.
  const rejected = verdict.stock;
  return {
    cellKey,
    photoSetHash,
    readScore: rejected ? null : outcome.score,
    readConfidence: rejected ? null : outcome.confidence,
    imagesAnalyzed: outcome.imagesAnalyzed,
    askingPriceCents: priceCents,
    currency: currency || "USD",
    stockRejected: rejected,
    stockReasons: rejected ? verdict.reasons : [],
  };
}

// ── staleness ───────────────────────────────────────────────────────

export interface StaleCutoffs {
  job: string;
  batch: string;
}

/** ISO cutoffs for the reclaim scan. Pure so the ordering can be asserted. */
export function staleCutoffs(now: number): StaleCutoffs {
  return {
    job: new Date(now - JOB_STALE_MS).toISOString(),
    batch: new Date(now - BATCH_STALE_MS).toISOString(),
  };
}

/** A job that has burned its attempts is failed terminally, not re-queued. */
export function isTerminallyFailed(attempts: number): boolean {
  return attempts >= MAX_JOB_ATTEMPTS;
}

// ── finalizing from rows ────────────────────────────────────────────

export interface JobRow {
  status: "pending" | "running" | "completed" | "failed";
  reads_written: number;
}

export interface BatchRollup {
  status: "running" | "completed" | "failed";
  cellsTotal: number;
  cellsDone: number;
  readsWritten: number;
}

/**
 * The batch, recounted from its job rows.
 *
 * DERIVED, never trusted from an in-memory tally: a worker that dies mid-batch
 * takes its counters with it, and the rows are what survived. Idempotent, so
 * the reclaim cron can finalize the same batch twice without drift.
 *
 * A batch is `failed` only when EVERY job failed. One dead cell out of eight is
 * a batch that did its job and lost a cell, and calling that a failed batch
 * would hide seven cells of real work behind a red status.
 */
export function rollUpBatch(jobs: JobRow[]): BatchRollup {
  const done = jobs.filter((j) => j.status === "completed" || j.status === "failed");
  const failed = jobs.filter((j) => j.status === "failed");
  const settled = done.length === jobs.length && jobs.length > 0;
  return {
    status: settled ? (failed.length === jobs.length ? "failed" : "completed") : "running",
    cellsTotal: jobs.length,
    cellsDone: done.length,
    readsWritten: jobs.reduce((a, j) => a + (j.reads_written ?? 0), 0),
  };
}

// ── publishing a cell ───────────────────────────────────────────────
//
// THE SEGMENT THAT WAS MISSING. Reads land in comp_condition_reads and a curve
// is served from condition_price_curves, and until US-2845 nothing joined the
// two: reads would have accumulated forever, no measured curve would ever have
// been written, and the US-2849 flip would have had nothing to flip to. The
// whole epic would have been inert with both flags on.
//
// scripts/check-unwired-modules.mjs is what caught it, by noticing that
// condition-curve-measured.ts had no production caller. That is the check
// working exactly as intended: its tests passed and its feature did not run.

/** A comp_condition_reads row, as much of it as the fit needs. */
export interface StoredRead {
  read_score: number | string | null;
  read_confidence: number | string | null;
  asking_price_cents: number | string | null;
  stock_rejected: boolean;
  currency?: string | null;
}

/** PostgREST hands numerics back as strings often enough to matter. */
function num(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Rows into the shape comp-curve-fit.ts wants. Pure. */
export function toFitSamples(rows: StoredRead[]): CompReadSample[] {
  return rows.map((r) => ({
    readScore: num(r.read_score),
    readConfidence: num(r.read_confidence),
    askingPriceCents: num(r.asking_price_cents),
    stockRejected: r.stock_rejected === true,
  }));
}

export interface PublishDecision {
  /** Null when the cell may not publish. The reason always says why. */
  fit: CurveFit | null;
  score: HoldOutScore | null;
  ok: boolean;
  reason: string;
}

/**
 * Decide whether a cell's accumulated reads may become a published curve.
 *
 * DELEGATES THE GATE, never re-implements it. publishable() in comp-curve-fit.ts
 * owns the two bars (twelve high-confidence reads, and a leave-one-out error
 * that beats the plain median by five percent), and a second copy of that
 * arithmetic here is how the two would drift and how a cell would eventually
 * publish through the softer of them.
 */
export function decidePublish(rows: StoredRead[]): PublishDecision {
  const samples = toFitSamples(rows);
  const fit = fitCurve(samples);
  const score = holdOutScore(samples);
  const verdict = publishable(samples, fit, score);
  return {
    fit: verdict.ok ? fit : null,
    score: verdict.ok ? score : null,
    ok: verdict.ok,
    reason: verdict.reason,
  };
}
