// US-2845: the worker's decisions, none of which need a database.
//
// The two that matter most are refusals: a cell nobody asked for cannot enter
// the queue, and a breached budget stops reads where they stand.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  BATCH_STALE_MS,
  CELL_REREAD_COOLDOWN_MS,
  COMP_READ_FEATURE,
  CONCURRENCY,
  type CompListing,
  type DemandRow,
  isTerminallyFailed,
  JOB_STALE_MS,
  type JobRow,
  MAX_CELLS_PER_BATCH,
  MAX_IMAGES_PER_READ,
  MAX_JOB_ATTEMPTS,
  MAX_READS_PER_CELL,
  nextCells,
  planCellReads,
  READ_TIMEOUT_MS,
  rollUpBatch,
  decidePublish,
  staleCutoffs,
  type StoredRead,
  toFitSamples,
  toReadInput,
} from "../lib/comp-read-worker.ts";
import { fitCurve, HIGH_CONFIDENCE_BAR, MIN_HIGH_CONFIDENCE_READS } from "../lib/comp-curve-fit.ts";
import {
  clearAiBudgetGateCache,
  isAiBudgetExhausted,
} from "../lib/ai-budget-gate.ts";
import { FEATURE_FLAG_MAP, resolveFlagKey } from "../lib/ai-budget.ts";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function demand(over: Partial<DemandRow> = {}): DemandRow {
  return {
    cell_key: "patagonia|11450|better sweater",
    category_id: "11450",
    brand: "Patagonia",
    query: "better sweater",
    demand_count: 5,
    last_seen_at: iso(60_000),
    last_read_at: null,
    ...over,
  };
}

// -- the caps (AC5) --------------------------------------------------

Deno.test("the caps are named constants, and each is what it claims", () => {
  assertEquals(MAX_IMAGES_PER_READ, 4);
  assertEquals(MAX_READS_PER_CELL, 12);
  assertEquals(MAX_CELLS_PER_BATCH, 8);
  assertEquals(MAX_JOB_ATTEMPTS, 5);
  assertEquals(CONCURRENCY, 2);
});

Deno.test("the per-cell cap matches the bar a cell must clear to publish", () => {
  // Reading fewer than MIN_HIGH_CONFIDENCE_READS can never finish a cell;
  // reading more buys sample for a cell that already has enough to be scored.
  // If one of these ever moves, the other has to move with it on purpose.
  assertEquals(MAX_READS_PER_CELL, MIN_HIGH_CONFIDENCE_READS);
});

Deno.test("the three timeouts are ordered, which IS the contract", () => {
  // A live job must never look stale, or the reclaim cron hands a running cell
  // to a second worker and both pay for the same reads.
  assert(READ_TIMEOUT_MS < JOB_STALE_MS, "a read can outlive its own staleness window");
  assert(JOB_STALE_MS < BATCH_STALE_MS, "a batch goes stale before its jobs do");
});

// -- the demand queue (AC2) ------------------------------------------

Deno.test("cells come back most-asked first", () => {
  const out = nextCells([
    demand({ cell_key: "a", demand_count: 2 }),
    demand({ cell_key: "b", demand_count: 9 }),
    demand({ cell_key: "c", demand_count: 5 }),
  ], NOW);
  assertEquals(out.map((c) => c.cellKey), ["b", "c", "a"]);
});

Deno.test("a tie breaks on which cell a seller touched most recently", () => {
  const out = nextCells([
    demand({ cell_key: "old", demand_count: 4, last_seen_at: iso(86_400_000) }),
    demand({ cell_key: "fresh", demand_count: 4, last_seen_at: iso(60_000) }),
  ], NOW);
  assertEquals(out.map((c) => c.cellKey), ["fresh", "old"]);
});

Deno.test("a cell with no category is DROPPED, never guessed at", () => {
  // searchBrowseComps needs one. Inventing a category is how a Carhartt jacket
  // gets comped against handbags, and the row would sit at the top of the
  // demand list forever, unservable.
  const out = nextCells([
    demand({ cell_key: "no-cat", category_id: null }),
    demand({ cell_key: "blank-cat", category_id: "   " }),
    demand({ cell_key: "ok" }),
  ], NOW);
  assertEquals(out.map((c) => c.cellKey), ["ok"]);
});

Deno.test("a cell read inside the cooldown is not read again", () => {
  const out = nextCells([
    demand({ cell_key: "just-read", last_read_at: iso(CELL_REREAD_COOLDOWN_MS - 1000) }),
    demand({ cell_key: "due", last_read_at: iso(CELL_REREAD_COOLDOWN_MS + 1000) }),
    demand({ cell_key: "never-read", last_read_at: null }),
  ], NOW);
  assert(!out.some((c) => c.cellKey === "just-read"));
  assertEquals(out.length, 2);
});

Deno.test("an unparseable last_read_at is treated as never read, not as fresh", () => {
  // The safe direction: a garbled timestamp costs one extra read, where the
  // other reading would freeze a cell out of the queue permanently.
  const out = nextCells([demand({ last_read_at: "not a date" })], NOW);
  assertEquals(out.length, 1);
});

Deno.test("the batch size is bounded", () => {
  const rows = Array.from({ length: 50 }, (_, i) => demand({ cell_key: `c${i}` }));
  assertEquals(nextCells(rows, NOW).length, MAX_CELLS_PER_BATCH);
  assertEquals(nextCells(rows, NOW, 3).length, 3);
});

// -- what gets read inside a cell ------------------------------------

function listing(over: Partial<CompListing> = {}): CompListing {
  return {
    itemId: "v1|1|0",
    title: "Patagonia Better Sweater",
    priceCents: 4200,
    currency: "USD",
    imageUrls: ["https://i.ebayimg.com/a.jpg", "https://i.ebayimg.com/b.jpg"],
    ...over,
  };
}

Deno.test("a listing with no price is skipped BEFORE it costs anything", () => {
  // The fit needs a price. A read without one is a read we would pay for and
  // then discard.
  const plan = planCellReads([
    listing({ itemId: "1", priceCents: null }),
    listing({ itemId: "2", priceCents: 0 }),
    listing({ itemId: "3" }),
  ]);
  assertEquals(plan.reads.map((r) => r.listing.itemId), ["3"]);
  assertEquals(plan.unusable, 2);
});

Deno.test("a listing with no fetchable photo is skipped", () => {
  const plan = planCellReads([
    listing({ itemId: "1", imageUrls: [] }),
    listing({ itemId: "2", imageUrls: ["not-a-url"] }),
    listing({ itemId: "3" }),
  ]);
  assertEquals(plan.reads.map((r) => r.listing.itemId), ["3"]);
  assertEquals(plan.unusable, 2);
});

Deno.test("photos per read are capped, and the cap is applied per listing", () => {
  const many = Array.from({ length: 9 }, (_, i) => `https://i.ebayimg.com/${i}.jpg`);
  const plan = planCellReads([listing({ imageUrls: many })]);
  assertEquals(plan.reads[0].imageUrls.length, MAX_IMAGES_PER_READ);
});

Deno.test("reads per cell are capped, and the overflow is counted not silently dropped", () => {
  const lots = Array.from({ length: 30 }, (_, i) => listing({ itemId: `i${i}` }));
  const plan = planCellReads(lots);
  assertEquals(plan.reads.length, MAX_READS_PER_CELL);
  assertEquals(plan.overCap, 30 - MAX_READS_PER_CELL);
});

// -- the sample row --------------------------------------------------

const photos = [{ hash: "aaaa", width: 800, height: 800 }];

Deno.test("a stock-rejected read is KEPT as a row, with no score", () => {
  // Knowing how much of a cell is catalog imagery is worth knowing, and
  // comp-curve-fit is the only door into a curve and already refuses them.
  const row = toReadInput(
    "cell",
    "hash",
    { photos, score: 8, confidence: 0.9, imagesAnalyzed: 1 },
    "USD",
    4200,
    () => 3, // seen under three cells: the strong cross-cell tell
  );
  assertEquals(row.stockRejected, true);
  assertEquals(row.readScore, null);
  assertEquals(row.readConfidence, null);
  assert(row.stockReasons.length > 0, "a rejected read must carry its reasons");
  // The price still goes in: it is a fact about the market either way.
  assertEquals(row.askingPriceCents, 4200);
});

Deno.test("a clean read keeps its score", () => {
  const row = toReadInput(
    "cell",
    "hash",
    { photos, score: 8, confidence: 0.9, imagesAnalyzed: 1 },
    "USD",
    4200,
    () => 1,
  );
  assertEquals(row.stockRejected, false);
  assertEquals(row.readScore, 8);
  assertEquals(row.stockReasons, []);
});

// -- staleness and the attempts cap ----------------------------------

Deno.test("the stale cutoffs are ordered the same way the constants are", () => {
  const c = staleCutoffs(NOW);
  assert(Date.parse(c.job) > Date.parse(c.batch), "a batch would go stale before its jobs");
});

Deno.test("the attempts cap is what stops a reclaim loop eating the budget", () => {
  assertEquals(isTerminallyFailed(MAX_JOB_ATTEMPTS - 1), false);
  assertEquals(isTerminallyFailed(MAX_JOB_ATTEMPTS), true);
  assertEquals(isTerminallyFailed(MAX_JOB_ATTEMPTS + 1), true);
});

// -- finalizing from rows --------------------------------------------

const job = (status: JobRow["status"], reads = 0): JobRow => ({ status, reads_written: reads });

Deno.test("a batch is derived from its rows, never from a tally", () => {
  const r = rollUpBatch([job("completed", 12), job("completed", 8), job("failed")]);
  assertEquals(r.status, "completed");
  assertEquals(r.cellsTotal, 3);
  assertEquals(r.cellsDone, 3);
  assertEquals(r.readsWritten, 20);
});

Deno.test("a batch with work outstanding stays running", () => {
  const r = rollUpBatch([job("completed", 5), job("running")]);
  assertEquals(r.status, "running");
  assertEquals(r.cellsDone, 1);
});

Deno.test("one dead cell is not a failed batch", () => {
  // Seven cells of real work must not hide behind a red status.
  assertEquals(rollUpBatch([job("completed", 3), job("failed")]).status, "completed");
  // Every job failing IS a failed batch.
  assertEquals(rollUpBatch([job("failed"), job("failed")]).status, "failed");
});

Deno.test("finalizing twice gives the same answer", () => {
  const rows = [job("completed", 4), job("failed")];
  assertEquals(rollUpBatch(rows), rollUpBatch(rows));
});

// -- the budget (AC4) ------------------------------------------------

Deno.test("comp_read is wired to the flag its budget kills", () => {
  assertEquals(COMP_READ_FEATURE, "comp_read");
  assertEquals(FEATURE_FLAG_MAP[COMP_READ_FEATURE], "comp_read");
  assertEquals(resolveFlagKey(COMP_READ_FEATURE), "comp_read");
});

Deno.test("a breached comp_read budget at action kill stops the worker", async () => {
  clearAiBudgetGateCache();
  const breached = await isAiBudgetExhausted(COMP_READ_FEATURE, () =>
    Promise.resolve([
      {
        id: "b1",
        feature: "comp_read",
        period: "day",
        limitUsd: 5,
        action: "kill",
        enabled: true,
        spendUsd: 5.4,
        breached: true,
        pct: 108,
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
    ]));
  assertEquals(breached, true);
});

Deno.test("an unbreached budget lets the worker run", async () => {
  clearAiBudgetGateCache();
  const ok = await isAiBudgetExhausted(COMP_READ_FEATURE, () =>
    Promise.resolve([
      {
        id: "b1",
        feature: "comp_read",
        period: "day",
        limitUsd: 5,
        action: "kill",
        enabled: true,
        spendUsd: 1.2,
        breached: false,
        pct: 24,
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
    ]));
  assertEquals(ok, false);
  clearAiBudgetGateCache();
});

Deno.test("a breach at action alert does NOT stop the worker", async () => {
  // Only 'kill' hard-blocks. An alert budget is a notification, and treating it
  // as a stop would make every warning an outage.
  clearAiBudgetGateCache();
  const stopped = await isAiBudgetExhausted(COMP_READ_FEATURE, () =>
    Promise.resolve([
      {
        id: "b1",
        feature: "comp_read",
        period: "day",
        limitUsd: 5,
        action: "alert",
        enabled: true,
        spendUsd: 9,
        breached: true,
        pct: 180,
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
    ]));
  assertEquals(stopped, false);
  clearAiBudgetGateCache();
});

Deno.test("another feature's breach does not stop comp_read", async () => {
  clearAiBudgetGateCache();
  const stopped = await isAiBudgetExhausted(COMP_READ_FEATURE, () =>
    Promise.resolve([
      {
        id: "b2",
        feature: "autolister",
        period: "day",
        limitUsd: 5,
        action: "kill",
        enabled: true,
        spendUsd: 50,
        breached: true,
        pct: 1000,
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
    ]));
  assertEquals(stopped, false);
  clearAiBudgetGateCache();
});


// ── the publish decision ────────────────────────────────────────────
//
// The step that was missing until now: reads in comp_condition_reads become a
// curve in condition_price_curves, or they do not and the cell keeps serving
// the plain median.

/** Stored rows on a clean price-vs-grade line, exactly as PostgREST hands them back. */
function storedLine(n: number, slope: number, conf = 0.8, asStrings = false): StoredRead[] {
  return Array.from({ length: n }, (_, i) => {
    const grade = Math.round((4 + (i * 6) / (n - 1)) * 10) / 10;
    const price = Math.round(2000 + slope * grade);
    return {
      read_score: asStrings ? String(grade) : grade,
      read_confidence: asStrings ? String(conf) : conf,
      asking_price_cents: asStrings ? String(price) : price,
      stock_rejected: false,
      currency: "USD",
    };
  });
}

Deno.test("toFitSamples parses the numerics PostgREST returns as strings", () => {
  const samples = toFitSamples(storedLine(12, 500, 0.8, true));
  assertEquals(samples.length, 12);
  assertEquals(samples[0].readScore, 4);
  assertEquals(samples[0].readConfidence, 0.8);
  assertEquals(samples[0].askingPriceCents, 4000);
  assertEquals(samples[0].stockRejected, false);
});

Deno.test("toFitSamples turns junk into null rather than NaN", () => {
  const samples = toFitSamples([
    { read_score: null, read_confidence: "", asking_price_cents: "abc", stock_rejected: true },
  ]);
  assertEquals(samples[0].readScore, null);
  assertEquals(samples[0].readConfidence, null);
  assertEquals(samples[0].askingPriceCents, null);
  assertEquals(samples[0].stockRejected, true);
});

Deno.test("a cell on a clean slope with enough confident reads publishes", () => {
  const decision = decidePublish(storedLine(MIN_HIGH_CONFIDENCE_READS, 500));
  assertEquals(decision.ok, true, decision.reason);
  assert(decision.fit != null && decision.score != null);
  assert(decision.fit.slopeCentsPerPoint > 0);
});

Deno.test("one read short of the confidence bar does not publish", () => {
  const decision = decidePublish(storedLine(MIN_HIGH_CONFIDENCE_READS - 1, 500));
  assertEquals(decision.ok, false);
  assertEquals(decision.fit, null);
  assertEquals(decision.score, null);
  assert(decision.reason.startsWith("too_few_confident_reads"), decision.reason);
});

Deno.test("reads below the confidence bar do not buy a publish", () => {
  const doubtful = storedLine(MIN_HIGH_CONFIDENCE_READS + 4, 500, HIGH_CONFIDENCE_BAR - 0.1);
  const decision = decidePublish(doubtful);
  assertEquals(decision.ok, false, decision.reason);
});

Deno.test("a flat cell keeps serving the median instead of publishing", () => {
  const noise = [4200, 3800, 4100, 3900, 4300, 3700, 4000, 4400, 3600, 4050, 3950, 4150];
  const rows: StoredRead[] = noise.map((price, i) => ({
    read_score: 4 + i * 0.5,
    read_confidence: 0.8,
    asking_price_cents: price,
    stock_rejected: false,
  }));
  const decision = decidePublish(rows);
  assertEquals(decision.ok, false);
  assert(decision.reason.startsWith("no_better_than_median"), decision.reason);
});

Deno.test("no reads at all is a refusal, not a crash", () => {
  const decision = decidePublish([]);
  assertEquals(decision.ok, false);
  assertEquals(decision.fit, null);
});

Deno.test("decidePublish delegates the gate rather than re-deriving it", () => {
  // Same rows, same fit: if the two ever disagree, a cell publishes through
  // whichever copy of the bar is softer.
  const rows = storedLine(MIN_HIGH_CONFIDENCE_READS, 500);
  const direct = fitCurve(toFitSamples(rows));
  const decision = decidePublish(rows);
  assert(decision.fit != null && direct != null);
  assertEquals(decision.fit.slopeCentsPerPoint, direct.slopeCentsPerPoint);
  assertEquals(decision.fit.sampleSize, direct.sampleSize);
});
