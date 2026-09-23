// US-525/526: AutoLister generation reliability.
//   - deriveBatchStatus: a batch terminalizes correctly (and only) once no jobs
//     are open, so a run always reaches a terminal status.
//   - withTimeout: a hung per-item generation is capped with a clear error.
//
// flipdesk-autolister.ts imports the service-role supabase client at load, so
// set dummy env BEFORE the dynamic import (same pattern as the other tests).
//   deno test --allow-env src/tests/autolister-reliability_test.ts
import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  deriveBatchStatus,
  insufficientAiActionsBody,
  isHaltedBatchStatus,
  MAX_BATCH_ITEMS,
  MAX_JOB_ATTEMPTS,
  MAX_PUBLISH_BATCH_ITEMS,
  needsAiReservation,
  settleAfterGeneration,
  settleFailedGeneration,
  withTimeout,
} = await import("../routes/flipdesk-autolister.ts");

Deno.test("deriveBatchStatus: still running while any job is open", () => {
  assertEquals(deriveBatchStatus(5, 2, 1), null);
  assertEquals(deriveBatchStatus(0, 0, 10), null);
});

Deno.test("deriveBatchStatus: completed when all succeeded", () => {
  assertEquals(deriveBatchStatus(10, 0, 0), "completed");
});

Deno.test("deriveBatchStatus: failed when none succeeded", () => {
  assertEquals(deriveBatchStatus(0, 10, 0), "failed");
});

Deno.test("deriveBatchStatus: partial on a mix", () => {
  assertEquals(deriveBatchStatus(7, 3, 0), "partial");
});

// ── US-1923: batch cancel can't be reverted by an in-flight worker ────

Deno.test("US-1923: isHaltedBatchStatus true only for terminal statuses", () => {
  // Terminal (an operator cancel flips every open job to failed → terminal).
  assert(isHaltedBatchStatus("completed"));
  assert(isHaltedBatchStatus("failed"));
  assert(isHaltedBatchStatus("partial"));
  // Non-terminal / unknown → keep working.
  assert(!isHaltedBatchStatus("running"));
  assert(!isHaltedBatchStatus("pending"));
  assert(!isHaltedBatchStatus(null));
  assert(!isHaltedBatchStatus(undefined));
});

Deno.test("US-1923: a cancelled batch stays terminal (all open jobs → failed)", () => {
  // adminCancelGenerationBatch flips pending+running jobs to 'failed', then
  // finalizeBatch re-derives from the rows. With N succeeded already and the
  // rest cancelled, the batch is 'partial'; with none succeeded, 'failed'.
  assertEquals(deriveBatchStatus(0, 10, 0), "failed"); // cancelled before any success
  assertEquals(deriveBatchStatus(3, 7, 0), "partial"); // 3 done, 7 cancelled
  // And the worker's own finalize after cancel re-derives the SAME terminal
  // status (no open jobs remain), so it can't flip the batch back to completed.
});

Deno.test("US-1923: settleAfterGeneration — cancelled job refunds and skips item advance", () => {
  // Conditional success write won (job was still 'running'): advance + keep spend.
  assertEquals(settleAfterGeneration(true), { advanceItem: true, refundReservation: false });
  // Write matched nothing (cancel flipped the job to 'failed' mid-generation):
  // don't advance the item, refund the reserved AI action (reconcile the cap).
  assertEquals(settleAfterGeneration(false), { advanceItem: false, refundReservation: true });
});

// ── US-1545: 300-item batches + count-aware quota pre-check ─────────

Deno.test("US-1545: batch ceilings raised to 300 (generation + publish in lockstep)", () => {
  assertEquals(MAX_BATCH_ITEMS, 300);
  assertEquals(MAX_PUBLISH_BATCH_ITEMS, MAX_BATCH_ITEMS);
});

Deno.test("US-1545: a full-size 300-job batch terminalizes exactly like a small one", () => {
  // Synthetic large batch: the terminalization rule the worker + reclaim cron
  // roll up on must behave identically at the new ceiling.
  const n = MAX_BATCH_ITEMS;
  assertEquals(deriveBatchStatus(0, 0, n), null); // all open → running
  assertEquals(deriveBatchStatus(n - 1, 0, 1), null); // one job left → running
  assertEquals(deriveBatchStatus(n, 0, 0), "completed");
  assertEquals(deriveBatchStatus(0, n, 0), "failed");
  assertEquals(deriveBatchStatus(n - 40, 40, 0), "partial");
});

Deno.test("US-1545: insufficientAiActionsBody refuses only when the batch can't fit", () => {
  // Fits exactly → null (the per-item reservation still guards races).
  assertEquals(insufficientAiActionsBody(142, 750, 608), null);
  // Unlimited plan → null regardless.
  assertEquals(insufficientAiActionsBody(300, -1, 999_999), null);
  // One short → 402 body with the numbers the UI needs.
  const body = insufficientAiActionsBody(143, 750, 608);
  assert(body !== null);
  assertEquals(body.code, "INSUFFICIENT_AI_ACTIONS");
  assertEquals(body.needed, 143);
  assertEquals(body.remaining, 142);
  assertEquals(body.cap, 750);
  assert(body.error.includes("143"));
  assert(body.error.includes("142"));
});

Deno.test("US-1545: an already-over-cap month reports remaining 0, never negative", () => {
  const body = insufficientAiActionsBody(10, 200, 230);
  assert(body !== null);
  assertEquals(body.remaining, 0);
});

// ── US-1931: idempotent-per-job AI reservation (no crash-loop leak) ──

Deno.test("US-1931: needsAiReservation only when the job holds no reservation", () => {
  // Fresh job (flag absent / false / null) → must reserve.
  assert(needsAiReservation({}));
  assert(needsAiReservation({ ai_reserved: false }));
  assert(needsAiReservation({ ai_reserved: null }));
  // Already reserved on a prior (crashed) attempt → reuse, never re-charge.
  assert(!needsAiReservation({ ai_reserved: true }));
});

Deno.test("US-1931: crash-after-reserve → reclaim consumes exactly ONE reservation", () => {
  // Model the authoritative monthly counter + the job's persisted ai_reserved
  // flag, and replay runJob's reservation decision across a crash loop: reserve
  // only when needsAiReservation, and persist the flag immediately (as runJob
  // does via markJobReserved, BEFORE the long generateListing call). A crash
  // after that leaves ai_reserved=true, so the reclaimed attempt reuses it.
  let counter = 0; // reserve_ai_action increments; refund decrements
  const job: { ai_reserved: boolean } = { ai_reserved: false };

  // Attempt 1..MAX_JOB_ATTEMPTS-1: reserve (if needed), persist flag, then the
  // container dies mid-generation — no refund runs (that's the leak the fix
  // closes). The persisted flag is what survives the crash.
  for (let attempt = 1; attempt < MAX_JOB_ATTEMPTS; attempt++) {
    if (needsAiReservation(job)) {
      counter += 1; // reserveAiAction
      job.ai_reserved = true; // markJobReserved (persisted before work)
    }
    // ...crash here (no refund).
  }
  // Final reclaim attempt: reservation is reused, generation succeeds — the
  // reservation is legitimately kept (never refunded).
  if (needsAiReservation(job)) {
    counter += 1;
    job.ai_reserved = true;
  }

  assertEquals(counter, 1); // exactly one net reservation for the one item
});

Deno.test("US-1931: a genuinely-failed job releases its reservation, retry reserves afresh", () => {
  // Generation failure path refunds AND clears the flag (releaseJobReservation),
  // so an explicit retry reserves a fresh action rather than reusing a released
  // slot — and the counter nets back to zero for the failed item.
  let counter = 0;
  const job: { ai_reserved: boolean } = { ai_reserved: false };

  // First attempt: reserve, then generation throws → refund + clear flag.
  if (needsAiReservation(job)) {
    counter += 1;
    job.ai_reserved = true;
  }
  counter -= 1; // refundAiAction
  job.ai_reserved = false; // releaseJobReservation
  assertEquals(counter, 0);

  // Explicit retry: the released flag means a fresh reservation is charged.
  assert(needsAiReservation(job));
  if (needsAiReservation(job)) {
    counter += 1;
    job.ai_reserved = true;
  }
  assertEquals(counter, 1);
});

Deno.test("withTimeout: resolves when the work finishes in time", async () => {
  const fast = new Promise<string>((r) => setTimeout(() => r("ok"), 5));
  assertEquals(await withTimeout(fast, 1000, "work"), "ok");
});

Deno.test("withTimeout: rejects with a labeled error when too slow", async () => {
  const slow = new Promise<string>((r) => setTimeout(() => r("late"), 1000));
  const err = await assertRejects(
    () => withTimeout(slow, 10, "Listing generation"),
    Error,
    "Listing generation timed out",
  );
  assert(err instanceof Error);
});

// ── marketplaces plan action 3: a timeout stops the work, one eBay draft ──
//
// withTimeout used to be a bare Promise.race: the job was marked failed and
// its AI action refunded while generateListing kept running and then wrote a
// draft anyway. And the draft write was select-then-insert, so an orphan and a
// retry could both see no draft and both insert one (00832 is the index).

const { DraftWriteAbandonedError, readJobStillRunning, writeEbayDraft } = await import(
  "../lib/ai-listing.ts"
);
type EbayDraftStore = import("../lib/ai-listing.ts").EbayDraftStore;

/**
 * An in-memory listings table with 00832's rule: at most one eBay draft per
 * item, a second insert answers 23505. Every call yields first, so two
 * concurrent writers interleave the way two workers on two replicas do.
 */
function fakeDraftStore(jobRunning = true) {
  const rows: { id: string; inventory_item_id: string; fields: Record<string, unknown> }[] = [];
  let next = 1;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const store: EbayDraftStore = {
    async findDraftId(itemId) {
      await tick();
      return rows.find((r) => r.inventory_item_id === itemId)?.id ?? null;
    },
    async insertDraft(row) {
      await tick();
      const itemId = String(row.inventory_item_id);
      if (rows.some((r) => r.inventory_item_id === itemId)) {
        return { id: null, code: "23505", message: "duplicate key value violates unique constraint" };
      }
      const id = `listing-${next++}`;
      rows.push({ id, inventory_item_id: itemId, fields: { ...row } });
      return { id };
    },
    async updateDraft(listingId, fields) {
      await tick();
      const r = rows.find((x) => x.id === listingId);
      if (!r) return { message: "not found" };
      Object.assign(r.fields, fields);
      return null;
    },
    async jobStillRunning() {
      await tick();
      return jobRunning;
    },
  };
  return { store, rows };
}

const INSERT_ONLY = { inventory_item_id: "item-1", platform: "ebay" };

Deno.test("withTimeout: a timeout aborts the controller with the timeout error", async () => {
  const abort = new AbortController();
  let release!: () => void;
  const hung = new Promise<string>((r) => (release = () => r("late")));
  await assertRejects(
    () => withTimeout(hung, 10, "Listing generation", abort),
    Error,
    "Listing generation timed out",
  );
  assert(abort.signal.aborted, "the timeout must abort the work, not only stop waiting");
  assert(String((abort.signal.reason as Error).message).includes("timed out"));
  release();
});

Deno.test("a timed-out generation writes no draft", async () => {
  const { store, rows } = fakeDraftStore();
  const abort = new AbortController();
  let finishModelCall!: () => void;
  const modelCall = new Promise<void>((r) => (finishModelCall = r));
  // The generation: a slow model call, then the draft write. It outlives the
  // timeout, exactly like an Anthropic call on its third 120s retry.
  const generation = (async () => {
    await modelCall;
    return await writeEbayDraft("item-1", { listing_title: "t" }, INSERT_ONLY, {
      signal: abort.signal,
    }, store);
  })();
  await assertRejects(() => withTimeout(generation, 10, "Listing generation", abort));
  finishModelCall();
  await assertRejects(() => generation, Error, "timed out");
  assertEquals(rows.length, 0);
});

Deno.test("a job that is no longer running on this attempt gets no draft", async () => {
  const { store, rows } = fakeDraftStore(false);
  await assertRejects(
    () =>
      writeEbayDraft("item-1", { listing_title: "t" }, INSERT_ONLY, {
        job: { id: "job-1", attempt: 1 },
        batchId: "batch-1",
      }, store),
    DraftWriteAbandonedError,
  );
  assertEquals(rows.length, 0);
});

Deno.test("two concurrent generations for one item leave one eBay draft", async () => {
  const { store, rows } = fakeDraftStore();
  const [a, b] = await Promise.all([
    writeEbayDraft("item-1", { listing_title: "first" }, INSERT_ONLY, {}, store),
    writeEbayDraft("item-1", { listing_title: "second" }, INSERT_ONLY, {}, store),
  ]);
  assertEquals(rows.length, 1);
  assertEquals(a, b);
  assertEquals(rows[0].fields.platform, "ebay");
});

Deno.test("an existing draft is updated in place, not duplicated", async () => {
  const { store, rows } = fakeDraftStore();
  const first = await writeEbayDraft("item-1", { listing_title: "v1" }, INSERT_ONLY, {}, store);
  const second = await writeEbayDraft("item-1", { listing_title: "v2" }, INSERT_ONLY, {}, store);
  assertEquals(first, second);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].fields.listing_title, "v2");
});

// -- round-3 review: settling a job whose generation threw --

function recordingDeps() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      refund: () => {
        calls.push("refund");
        return Promise.resolve();
      },
      release: (id: string) => {
        calls.push(`release:${id}`);
        return Promise.resolve();
      },
      markFailed: (id: string, msg: string) => {
        calls.push(`markFailed:${id}:${msg}`);
        return Promise.resolve();
      },
    },
  };
}

Deno.test("an abandoned draft write refunds and releases but does not mark the job failed", async () => {
  const { calls, deps } = recordingDeps();
  await settleFailedGeneration(
    new DraftWriteAbandonedError("Job job-1 is no longer running on attempt 2; draft not written"),
    "job-1",
    deps,
  );
  // markFailed would overwrite an operator cancel's error, or fail a job a
  // reclaim now owns on a newer attempt.
  assertEquals(calls, ["refund", "release:job-1"]);
});

Deno.test("a real generation failure refunds, releases and marks the job failed", async () => {
  const { calls, deps } = recordingDeps();
  await settleFailedGeneration(new Error("Listing generation timed out after 240s"), "job-2", deps);
  assertEquals(calls, [
    "refund",
    "release:job-2",
    "markFailed:job-2:Listing generation timed out after 240s",
  ]);
});

// -- round-3 review: one read blip no longer throws a paid-for draft away --

type ReadAnswer = { data: unknown; error: { message: string } | null } | Error;

function scriptedReads(...answers: ReadAnswer[]) {
  let n = 0;
  const read = () => {
    const a = answers[Math.min(n++, answers.length - 1)];
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return { read, count: () => n };
}

const RUNNING_ON_2 = { data: { status: "running", attempts: 2 }, error: null };

Deno.test("jobStillRunning: a read error is retried once and the retry decides", async () => {
  const r = scriptedReads({ data: null, error: { message: "fetch failed" } }, RUNNING_ON_2);
  assertEquals(await readJobStillRunning(r.read, 2), true);
  assertEquals(r.count(), 2);
});

Deno.test("jobStillRunning: a thrown read is retried once too", async () => {
  const r = scriptedReads(new Error("connection reset"), RUNNING_ON_2);
  assertEquals(await readJobStillRunning(r.read, 2), true);
  assertEquals(r.count(), 2);
});

Deno.test("jobStillRunning: two failed reads fail closed", async () => {
  const r = scriptedReads(
    { data: null, error: { message: "fetch failed" } },
    { data: null, error: { message: "fetch failed" } },
    RUNNING_ON_2,
  );
  assertEquals(await readJobStillRunning(r.read, 2), false);
  assertEquals(r.count(), 2);
});

Deno.test("jobStillRunning: a clean answer is not retried", async () => {
  const gone = scriptedReads({ data: null, error: null }, RUNNING_ON_2);
  assertEquals(await readJobStillRunning(gone.read, 2), false);
  assertEquals(gone.count(), 1);
  const reclaimed = scriptedReads({ data: { status: "running", attempts: 3 }, error: null }, RUNNING_ON_2);
  assertEquals(await readJobStillRunning(reclaimed.read, 2), false);
  assertEquals(reclaimed.count(), 1);
  const cancelled = scriptedReads({ data: { status: "failed", attempts: 2 }, error: null }, RUNNING_ON_2);
  assertEquals(await readJobStillRunning(cancelled.read, 2), false);
  assertEquals(cancelled.count(), 1);
});
