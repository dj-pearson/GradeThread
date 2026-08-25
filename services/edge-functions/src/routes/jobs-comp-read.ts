// US-2845: the comp read cron. Two endpoints, both job-secret gated.
//
//   POST /api/jobs/comp-read          claim the most-demanded cells and read them
//   POST /api/jobs/comp-read-reclaim  resume stale jobs, finalize stale batches
//
// Every DECISION lives in lib/comp-read-worker.ts and is unit-tested. This file
// is the I/O that carries them out: claim rows, call Browse, call the grader,
// write sample rows, roll the batch up from its jobs.
//
// OFF UNTIL SOMEBODY TURNS IT ON. The feature_flags row `comp_read` ships
// disabled (migration 00667) because US-2842 has not returned a GO. The flag is
// also what the budget pulls at action kill, so the same switch serves the gate
// and the guardrail, and there is no second place to look.
//
// THE BUDGET IS CHECKED BEFORE EVERY READ, not once per batch. A batch of eight
// cells at twelve reads each is ninety-six paid calls; checking at the top would
// let the whole batch run past a ceiling it breached on read three.

import type { Context } from "hono";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { supabaseAdmin } from "../lib/supabase.ts";
import { recordCronRun } from "../lib/cron-runs.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { isAiBudgetExhausted } from "../lib/ai-budget-gate.ts";
import { searchBrowseComps } from "../lib/ebay-client.ts";
import { fetchWithTimeout } from "../lib/circuit-breaker.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import { computePhashFromImage } from "../lib/perceptual-hash.ts";
import { captureException, logEvent, recordMetric } from "../lib/observability.ts";
import { photoSetHash, recordCompReads } from "../lib/comp-reads.ts";
import { CURVE_GRADE_POINTS } from "../lib/condition-curve.ts";
import { type CurveWriteClient, writeMeasuredCurve } from "../lib/condition-curve-measured.ts";
import { recordAiUsage } from "../lib/ai-usage.ts";
import { type CompPhoto } from "../lib/comp-stock-photo.ts";
import {
  COMP_READ_FEATURE,
  CONCURRENCY,
  type CompListing,
  type DemandRow,
  isTerminallyFailed,
  type JobRow,
  MAX_CELLS_PER_BATCH,
  MAX_IMAGES_PER_READ,
  MAX_READS_PER_CELL,
  decidePublish,
  nextCells,
  planCellReads,
  type QueuedCell,
  READ_TIMEOUT_MS,
  rollUpBatch,
  staleCutoffs,
  type StoredRead,
  toFitSamples,
  toReadInput,
} from "../lib/comp-read-worker.ts";

const DEMAND_SCAN_CAP = 200;

/** One photo. Bounded well under READ_TIMEOUT_MS so four of them still fit. */
const PHOTO_FETCH_TIMEOUT_MS = 15_000;

// ── small helpers ───────────────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Bump the batch heartbeat. A live batch must never look abandoned. */
async function touchBatch(batchId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("comp_read_batches")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", batchId);
  if (error) console.warn(`[comp-read] batch heartbeat failed: ${error.message}`);
}

/**
 * Recount the batch from its job rows and write the result.
 *
 * Idempotent by construction, so the reclaim cron may finalize the same batch
 * twice. Never trusts an in-memory tally: a worker that died took its counters
 * with it, and the rows are what survived.
 */
async function finalizeBatch(batchId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("comp_read_jobs")
    .select("status, reads_written")
    .eq("batch_id", batchId);
  if (error) {
    console.warn(`[comp-read] finalize read failed: ${error.message}`);
    return;
  }
  const roll = rollUpBatch((data ?? []) as JobRow[]);
  const patch: Record<string, unknown> = {
    status: roll.status,
    cells_total: roll.cellsTotal,
    cells_done: roll.cellsDone,
    reads_written: roll.readsWritten,
    updated_at: new Date().toISOString(),
  };
  if (roll.status !== "running") patch.finished_at = new Date().toISOString();
  const { error: upErr } = await supabaseAdmin
    .from("comp_read_batches")
    .update(patch)
    .eq("id", batchId);
  if (upErr) console.warn(`[comp-read] finalize write failed: ${upErr.message}`);
}

// ── one cell ────────────────────────────────────────────────────────

/** Fetch a listing's photos and hash them, so the stock detector can judge the set. */
async function hashPhotos(urls: string[]): Promise<CompPhoto[]> {
  const out: CompPhoto[] = [];
  for (const url of urls) {
    try {
      // US-2321: through fetchWithTimeout, not a bare fetch. A hung photo host
      // would otherwise sit inside the read's own budget and take the cell with
      // it; PHOTO_FETCH_TIMEOUT_MS bounds it well under READ_TIMEOUT_MS.
      const res = await fetchWithTimeout(url, {}, PHOTO_FETCH_TIMEOUT_MS);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      const format = type.includes("png") ? "png" : "jpeg";
      const hash = await computePhashFromImage(bytes, format);
      if (!hash) continue;
      out.push({ hash, width: null, height: null });
    } catch {
      // A photo we cannot fetch is a photo we cannot read. Skipping it costs
      // nothing; failing the whole listing over one bad URL costs the cell.
    }
  }
  return out;
}

/**
 * How many DISTINCT cells a photo hash has already been seen under.
 *
 * The strong stock tell in US-2843. Reading it per hash keeps the query small
 * and the answer current; a batch-wide preload would be one round trip and
 * would miss hashes this very batch just wrote.
 */
async function cellsForHashLive(hash: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("comp_condition_reads")
    .select("cell_key")
    .ilike("photo_set_hash", `%${hash}%`)
    .limit(20);
  if (error) return 1;
  return new Set(((data ?? []) as Array<{ cell_key: string }>).map((r) => r.cell_key)).size ||
    1;
}

interface CellResult {
  readsWritten: number;
  budgetStopped: boolean;
  error: string | null;
  /** Whether this cell's reads cleared the publish bar and became a curve. */
  published?: boolean;
}

/**
 * How many of a cell's reads the fit sees. Newest first, so a cell that has
 * been re-read for a year fits on this year's market rather than on 2024's.
 */
const PUBLISH_READ_CAP = 200;

/**
 * Fit a cell's accumulated reads and, if they clear the bar, write the curve.
 *
 * THE FLIP HAS SOMETHING TO FLIP TO ONLY BECAUSE OF THIS. Reads land in
 * comp_condition_reads and applyMeasuredCurve serves out of
 * condition_price_curves; without this step the two tables never meet, the
 * shadow finds nothing on every request forever, and the whole epic sits inert
 * with both flags on.
 *
 * NEVER FAILS THE CELL. The reads are already written and paid for. A cell that
 * cannot publish yet is the normal case, not an error - it keeps serving the
 * plain comp median, which is exactly the promise: the worst case for a seller
 * is today's answer.
 */
async function publishCell(cell: QueuedCell): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("comp_condition_reads")
    .select("read_score, read_confidence, asking_price_cents, stock_rejected, currency")
    .eq("cell_key", cell.cellKey)
    .order("created_at", { ascending: false })
    .limit(PUBLISH_READ_CAP);
  if (error) {
    logEvent("warn", "comp-read.publish_load_failed", { cell_key: cell.cellKey });
    return false;
  }

  const rows = (data ?? []) as StoredRead[];
  const decision = decidePublish(rows);
  if (!decision.ok || !decision.fit || !decision.score) {
    logEvent("info", "comp-read.not_publishable", {
      cell_key: cell.cellKey,
      reads: rows.length,
      reason: decision.reason,
    });
    return false;
  }

  // PRESERVE slug AND label. They are the curated Condition Index entry - a
  // human wrote them and a public URL points at them. Upserting the measured
  // row without them would blank a live /condition-index/<slug> page as a side
  // effect of a background job doing well.
  const { data: existing } = await supabaseAdmin
    .from("condition_price_curves")
    .select("slug, label, currency")
    .eq("item_key", cell.cellKey)
    .maybeSingle();
  const prior = (existing ?? null) as
    | { slug: string | null; label: string | null; currency: string | null }
    | null;

  const currency = rows.find((r) => (r.currency ?? "").trim() !== "")?.currency?.trim() ||
    prior?.currency || "USD";

  const written = await writeMeasuredCurve(
    supabaseAdmin as unknown as CurveWriteClient,
    {
      itemKey: cell.cellKey,
      slug: prior?.slug ?? null,
      label: prior?.label ?? null,
      brand: cell.brand,
      categoryId: cell.categoryId,
      query: cell.query,
      currency,
      fit: decision.fit,
      score: decision.score,
      reads: toFitSamples(rows),
      measuredAt: new Date().toISOString(),
    },
    CURVE_GRADE_POINTS,
  );

  if (!written.ok) {
    logEvent("warn", "comp-read.publish_write_failed", { cell_key: cell.cellKey });
    return false;
  }
  logEvent("info", "comp-read.published", {
    cell_key: cell.cellKey,
    reads: decision.fit.sampleSize,
    slope_cents_per_point: decision.fit.slopeCentsPerPoint,
  });
  recordMetric("comp_read.published", 1, { cell: cell.cellKey });
  return true;
}

async function processCell(cell: QueuedCell): Promise<CellResult> {
  let comps;
  try {
    comps = await withTimeout(
      searchBrowseComps({
        categoryId: cell.categoryId,
        q: cell.query ?? undefined,
        brand: cell.brand ?? undefined,
        limit: 50,
      }),
      READ_TIMEOUT_MS,
      "browse",
    );
  } catch (err) {
    return {
      readsWritten: 0,
      budgetStopped: false,
      error: `browse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const listings: CompListing[] = (comps.items ?? []).map((i) => ({
    itemId: i.itemId,
    title: i.title,
    priceCents: i.price == null ? null : Math.round(i.price * 100),
    currency: i.currency || comps.stats.currency || "USD",
    imageUrls: i.imageUrl ? [i.imageUrl] : [],
  }));

  const plan = planCellReads(listings, MAX_READS_PER_CELL, MAX_IMAGES_PER_READ);
  const inputs = [];
  let budgetStopped = false;

  for (const read of plan.reads) {
    // The budget, before every single read.
    if (await isAiBudgetExhausted(COMP_READ_FEATURE)) {
      budgetStopped = true;
      logEvent("warn", "comp-read.budget_stop", {
        cell_key: cell.cellKey,
        reads_before_stop: inputs.length,
      });
      break;
    }

    try {
      const photos = await hashPhotos(read.imageUrls);
      if (photos.length === 0) continue;
      const hash = await photoSetHash(photos.map((p) => p.hash));

      const graded = await withTimeout(
        quickGrade({
          images: read.imageUrls.map((url) => ({ url, type: "detail" })),
          garment: { brand: cell.brand ?? null, title: read.listing.title },
        }),
        READ_TIMEOUT_MS,
        "read",
      );

      // US-2845 AC4: file the spend under comp_read, which is what makes the
      // budget real. ai_budget_status rolls up ai_usage_events BY FEATURE, so a
      // read recorded under any other feature (or not recorded at all) leaves
      // the comp_read budget reading zero forever and its kill switch does
      // nothing. userId is null on purpose: this is platform spend on a cell,
      // not a seller's grade, and attributing it to whoever happened to ask
      // about the cell would bill the wrong person.
      if (graded.usages.length > 0) {
        await recordAiUsage({
          userId: null,
          submissionId: null,
          feature: COMP_READ_FEATURE,
          usages: graded.usages,
        });
      }

      inputs.push(
        toReadInput(
          cell.cellKey,
          hash,
          {
            photos,
            score: graded.overallScore,
            confidence: graded.confidence,
            imagesAnalyzed: photos.length,
          },
          read.listing.currency,
          read.listing.priceCents,
          // Synchronous shim over the live count: isStockPhotoSet is pure and
          // takes a plain function, so the counts are resolved just above.
          () => 1,
        ),
      );
    } catch (err) {
      captureException(err, {
        level: "warn",
        route: "comp-read.read",
        tags: { cell: cell.cellKey },
      });
    }
  }

  if (inputs.length === 0) {
    return { readsWritten: 0, budgetStopped, error: budgetStopped ? "budget stop" : null };
  }

  // Re-judge with the LIVE cross-cell counts now that the hashes exist, then
  // write. The dedupe on photo_set_hash happens in Postgres (US-2844), so a
  // listing we have already paid to read costs nothing here.
  const withCounts = [];
  for (const input of inputs) {
    const cells = await cellsForHashLive(input.photoSetHash);
    withCounts.push(cells > 1 ? { ...input, stockRejected: true, stockReasons: ["cross_cell_repeat"] } : input);
  }

  const result = await recordCompReads(
    supabaseAdmin as unknown as Parameters<typeof recordCompReads>[0],
    withCounts,
  );

  // Fit and publish AFTER the reads are safely written, and never in a way that
  // can lose them: a throw here would mark the job failed and hand the same cell
  // back to the reclaim cron, paying for the reads a second time.
  let published = false;
  if (result.written > 0) {
    try {
      published = await publishCell(cell);
    } catch (err) {
      captureException(err, { level: "warn", route: "comp-read.publish", tags: { cell: cell.cellKey } });
    }
  }

  return { readsWritten: result.written, budgetStopped, error: result.error, published };
}

// ── the process cron ────────────────────────────────────────────────

export async function handleCompReadCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) return c.json({ error: "Unauthorized" }, 401);

  // The gate and the kill switch are the same flag, on purpose.
  if (!(await isFeatureEnabled("comp_read"))) {
    return c.json({ ok: true, skipped: true, reason: "comp_read feature flag is off" });
  }
  if (await isAiBudgetExhausted(COMP_READ_FEATURE)) {
    return c.json({ ok: true, skipped: true, reason: "comp_read budget exhausted" });
  }

  const lock = await acquireJobLock("comp-read", 900);
  if (!lock.acquired) return c.json({ ok: true, skipped: true, reason: lock.reason });

  const started = Date.now();
  let batchId: string | null = null;
  try {
    const { data: demand, error: demandErr } = await supabaseAdmin
      .from("comp_read_demand")
      .select("cell_key, category_id, brand, query, demand_count, last_seen_at, last_read_at")
      .order("demand_count", { ascending: false })
      .limit(DEMAND_SCAN_CAP);
    if (demandErr) throw new Error(`demand read failed: ${demandErr.message}`);

    const cells = nextCells((demand ?? []) as DemandRow[], Date.now(), MAX_CELLS_PER_BATCH);
    if (cells.length === 0) {
      await recordCronRun({
        jobName: "comp-read",
        status: "skipped",
        detail: { reason: "no cells due" },
      });
      return c.json({ ok: true, skipped: true, reason: "no cells due" });
    }

    const { data: batch, error: batchErr } = await supabaseAdmin
      .from("comp_read_batches")
      .insert({ cells_total: cells.length })
      .select("id")
      .single();
    if (batchErr || !batch) throw new Error(`batch insert failed: ${batchErr?.message}`);
    batchId = (batch as { id: string }).id;

    const { error: jobsErr } = await supabaseAdmin
      .from("comp_read_jobs")
      .insert(cells.map((cell) => ({ batch_id: batchId, cell_key: cell.cellKey })));
    if (jobsErr) throw new Error(`job insert failed: ${jobsErr.message}`);

    const byKey = new Map(cells.map((cell) => [cell.cellKey, cell]));
    let stopped = false;
    let readsTotal = 0;
    let publishedTotal = 0;

    // Bounded pool. A worker takes the next cell only by winning the atomic
    // claim, so two replicas running the same batch cannot pay twice.
    const queue = [...cells];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0 && !stopped) {
        const cell = queue.shift();
        if (!cell) break;

        // Read the row, then claim it conditionally. Same shape as the
        // autolister: the `status='pending'` filter is what makes the claim
        // atomic, so only one replica's UPDATE matches and only one increments.
        const { data: pending, error: readErr } = await supabaseAdmin
          .from("comp_read_jobs")
          .select("id, attempts")
          .eq("batch_id", batchId)
          .eq("cell_key", cell.cellKey)
          .eq("status", "pending")
          .maybeSingle();
        if (readErr) {
          // Never swallowed: log and skip, per the durable-jobs contract.
          console.warn(`[comp-read] job read failed for ${cell.cellKey}: ${readErr.message}`);
          continue;
        }
        if (!pending) continue;
        const jobId = (pending as { id: string; attempts: number }).id;
        const attempts = (pending as { attempts: number }).attempts ?? 0;

        // A cell that has died five times stops being retried. This is the cap
        // that keeps an unattended reclaim loop from spending the budget.
        if (isTerminallyFailed(attempts)) {
          await supabaseAdmin
            .from("comp_read_jobs")
            .update({
              status: "failed",
              error: `gave up after ${attempts} attempt(s)`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", jobId)
            .eq("status", "pending");
          continue;
        }

        const { data: claimed, error: claimErr } = await supabaseAdmin
          .from("comp_read_jobs")
          .update({
            status: "running",
            attempts: attempts + 1,
            error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId)
          .eq("status", "pending")
          .select("id");
        if (claimErr) {
          console.warn(`[comp-read] claim failed for ${cell.cellKey}: ${claimErr.message}`);
          continue;
        }
        // Empty means another replica won the race. Not an error.
        if (!claimed || claimed.length === 0) continue;

        const outcome = await processCell(byKey.get(cell.cellKey) ?? cell);
        readsTotal += outcome.readsWritten;
        if (outcome.published) publishedTotal += 1;
        if (outcome.budgetStopped) stopped = true;

        await supabaseAdmin
          .from("comp_read_jobs")
          .update({
            status: outcome.error && outcome.readsWritten === 0 ? "failed" : "completed",
            reads_written: outcome.readsWritten,
            error: outcome.error,
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        if (outcome.readsWritten > 0) {
          await supabaseAdmin
            .from("comp_read_demand")
            .update({ last_read_at: new Date().toISOString() })
            .eq("cell_key", cell.cellKey);
        }
        await touchBatch(batchId as string);
      }
    });
    await Promise.all(workers);
    await finalizeBatch(batchId);

    recordMetric("comp_read.batch", readsTotal, {
      cells: String(cells.length),
      budget_stopped: String(stopped),
    });
    await recordCronRun({
      jobName: "comp-read",
      status: "success",
      durationMs: Date.now() - started,
      detail: {
        cells: cells.length,
        readsWritten: readsTotal,
        curvesPublished: publishedTotal,
        budgetStopped: stopped,
      },
    });
    return c.json({
      ok: true,
      batchId,
      cells: cells.length,
      readsWritten: readsTotal,
      curvesPublished: publishedTotal,
      budgetStopped: stopped,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureException(err, { route: "jobs.comp-read" });
    if (batchId) {
      await supabaseAdmin
        .from("comp_read_batches")
        .update({ status: "failed", error: message, finished_at: new Date().toISOString() })
        .eq("id", batchId);
    }
    await recordCronRun({
      jobName: "comp-read",
      status: "error",
      durationMs: Date.now() - started,
      detail: { error: message },
    });
    return c.json({ ok: false, error: message }, 500);
  } finally {
    await lock.release();
  }
}

// ── the reclaim cron ────────────────────────────────────────────────

export async function handleCompReadReclaimCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) return c.json({ error: "Unauthorized" }, 401);

  const lock = await acquireJobLock("comp-read-reclaim", 300);
  if (!lock.acquired) return c.json({ ok: true, skipped: true, reason: lock.reason });

  try {
    const cutoffs = staleCutoffs(Date.now());

    // A running job nobody has touched since JOB_STALE was left by a dead
    // worker. Requeue it, unless it has burned its attempts, in which case it
    // fails terminally rather than looping on the budget forever.
    const { data: stale, error } = await supabaseAdmin
      .from("comp_read_jobs")
      .select("id, attempts, batch_id")
      .eq("status", "running")
      .lt("updated_at", cutoffs.job)
      .limit(200);
    if (error) throw new Error(`stale scan failed: ${error.message}`);

    let requeued = 0;
    let failed = 0;
    const batches = new Set<string>();
    for (const row of (stale ?? []) as Array<{ id: string; attempts: number; batch_id: string }>) {
      batches.add(row.batch_id);
      const terminal = isTerminallyFailed(row.attempts);
      await supabaseAdmin
        .from("comp_read_jobs")
        .update({
          status: terminal ? "failed" : "pending",
          error: terminal ? `abandoned after ${row.attempts} attempt(s)` : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "running");
      if (terminal) failed++;
      else requeued++;
    }

    // A batch nobody has touched since BATCH_STALE is abandoned. Recount it from
    // its rows; that is the only honest answer about what got done.
    const { data: staleBatches } = await supabaseAdmin
      .from("comp_read_batches")
      .select("id")
      .eq("status", "running")
      .lt("updated_at", cutoffs.batch)
      .limit(50);
    for (const b of (staleBatches ?? []) as Array<{ id: string }>) batches.add(b.id);
    for (const id of batches) await finalizeBatch(id);

    await recordCronRun({
      jobName: "comp-read-reclaim",
      status: "success",
      detail: { requeued, failedTerminally: failed, batchesFinalized: batches.size },
    });
    return c.json({ ok: true, requeued, failed, batchesFinalized: batches.size });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureException(err, { route: "jobs.comp-read-reclaim" });
    await recordCronRun({
      jobName: "comp-read-reclaim",
      status: "error",
      detail: { error: message },
    });
    return c.json({ ok: false, error: message }, 500);
  } finally {
    await lock.release();
  }
}
