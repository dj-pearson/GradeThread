// Global Claude concurrency + cost/volume ceiling (US-414).
//
// Problem (audit 2026-06-03): the grading pipeline fires Promise.all over every
// image with NO global cap, so a burst of concurrent grades (or autolister
// batches) can spike simultaneous Anthropic calls — tripping the provider rate
// limit and spiking spend. This wraps every Anthropic call that opts in with:
//   1. a process-wide SEMAPHORE bounding concurrent calls (AI_MAX_CONCURRENCY),
//   2. a GLOBAL daily volume ceiling (AI_GLOBAL_DAILY_CALL_CEILING) backed by
//      the shared rate_limit_counters store so it holds across replicas, and
//   3. withRetry (retry.ts) so an Anthropic 429/5xx backs off + retries.
//
// Per-ACCOUNT spend is already bounded elsewhere — FlipDesk AI actions by the
// atomic monthly reserve_ai_action quota (US-387) and grading by per-grade
// billing/credits (US-207) — so this module owns the GLOBAL dimension. New AI
// entry points should call runAiCall() to join the global bound.
//
// The semaphore + the ceiling decision are pure/injectable so they unit-test
// with no timers and no database.

import { withRetry } from "./retry.ts";

// ── Async semaphore (process-wide) ──────────────────────────────────

/**
 * FIFO counting semaphore. acquire() resolves immediately while slots are free,
 * otherwise queues; release() hands the slot to the longest-waiting caller.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    this.available = Math.max(1, Math.floor(max));
  }

  /** Slots currently in use (for tests/observability). */
  get inUse(): number {
    return Math.max(1, Math.floor(this.max)) - this.available;
  }
  /** Callers currently parked waiting for a slot. */
  get waiting(): number {
    return this.queue.length;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the held slot directly to the next waiter (count stays the same).
      next();
    } else {
      this.available = Math.min(
        this.available + 1,
        Math.max(1, Math.floor(this.max)),
      );
    }
  }

  /** Run `fn` while holding a slot; always releases, even on throw. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ── Config ──────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENCY = 8;
const DEFAULT_GLOBAL_DAILY_CEILING = 50_000;

function readPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function maxConcurrency(): number {
  return Math.max(1, readPositiveInt("AI_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY));
}

// Global daily call ceiling. 0 disables the ceiling (concurrency still applies).
function globalDailyCeiling(): number {
  return readPositiveInt("AI_GLOBAL_DAILY_CALL_CEILING", DEFAULT_GLOBAL_DAILY_CEILING);
}

// withRetry attempt budget. Mirrors AI_MAX_RETRIES (the SDK's old retry count,
// default 2) + the first try. Wrapped calls disable the SDK's own retries
// (per-call maxRetries: 0) so retry.ts is the single retry authority and a 429
// can't be retried twice (SDK × withRetry).
function retryAttempts(): number {
  return readPositiveInt("AI_MAX_RETRIES", 2) + 1;
}

// One process-wide semaphore, sized on first use so a test/CI run that never
// makes a call never reads the env. Sizing is fixed for the process lifetime.
let semaphore: Semaphore | null = null;
function aiSemaphore(): Semaphore {
  if (!semaphore) semaphore = new Semaphore(maxConcurrency());
  return semaphore;
}

// ── Global daily volume ceiling ─────────────────────────────────────

// Thrown when the global daily ceiling is hit. Callers map it to a 429 (the
// pipeline lets it fail the grade so the per-grade charge is reversed).
export class AiCeilingError extends Error {
  readonly code = "ai_global_ceiling";
  constructor(message: string) {
    super(message);
    this.name = "AiCeilingError";
  }
}

// Injectable counter (default = the shared rate_limit RPC) so the ceiling is
// distributed across replicas and unit-testable without a DB. Mirrors the rate
// limiter's RateLimitIncrementer contract: returns the post-increment count.
export type DailyCounter = (
  bucketKey: string,
  windowStartIso: string,
) => Promise<number>;

const defaultDailyCounter: DailyCounter = async (bucketKey, windowStartIso) => {
  const { supabaseAdmin } = await import("./supabase.ts");
  const { data, error } = await supabaseAdmin.rpc("increment_rate_limit", {
    p_bucket_key: bucketKey,
    p_window_start: windowStartIso,
  });
  if (error || typeof data !== "number") {
    throw error ?? new Error("increment_rate_limit returned non-number");
  }
  return data as number;
};

function startOfUtcDayIso(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Reserve one unit against the global daily ceiling. Returns the post-increment
 * count, or throws AiCeilingError if that would exceed the ceiling. Fails OPEN
 * on a counter-store error (a DB blip must not halt all grading) — the
 * concurrency semaphore still protects the provider from a spike.
 */
export async function reserveGlobalDailyBudget(
  counter: DailyCounter = defaultDailyCounter,
  now: Date = new Date(),
): Promise<void> {
  const ceiling = globalDailyCeiling();
  if (ceiling <= 0) return; // disabled
  let count: number;
  try {
    count = await counter("ai-global-daily", startOfUtcDayIso(now));
  } catch (err) {
    console.error(
      "[ai-limiter] global ceiling counter unavailable — allowing (fail-open):",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (count > ceiling) {
    throw new AiCeilingError(
      `Global daily AI call ceiling (${ceiling}) reached; try again later.`,
    );
  }
}

// ── The wrapper ─────────────────────────────────────────────────────

export interface RunAiCallOptions {
  // Skip the global daily ceiling for a call that must always run (e.g. a
  // health probe). Concurrency + retry still apply. Default false.
  skipCeiling?: boolean;
  // Test seams.
  counter?: DailyCounter;
  retrySleep?: (ms: number) => Promise<void>;
}

/**
 * Run an Anthropic call under the global bounds: reserve daily budget, acquire
 * a concurrency slot, then run `fn` with bounded backoff/retry on 429/5xx. The
 * standard wrapper for every Anthropic messages.create — adopt it at each AI
 * entry point so the whole process shares one concurrency + spend bound.
 */
export async function runAiCall<T>(
  fn: () => Promise<T>,
  opts: RunAiCallOptions = {},
): Promise<T> {
  if (!opts.skipCeiling) {
    await reserveGlobalDailyBudget(opts.counter);
  }
  return await aiSemaphore().run(() =>
    withRetry(fn, { maxAttempts: retryAttempts(), sleep: opts.retrySleep })
  );
}
