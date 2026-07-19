// US-573: grading-pipeline memory capacity controls.
//
// The grading pipeline downloads every submission image and buffers it as a
// base64 data URI IN-PROCESS (grading-pipeline.ts step 3), holding those
// multi-MB strings resident until the per-image vision analysis settles. Grades
// are kicked fire-and-forget (grade.ts → processSubmission().catch) from several
// places, so without a bound an unbounded number of submissions can buffer their
// images simultaneously and OOM the container (hard-capped 1.5 CPU / 1G before
// this story; right-sized to 2G — see vault/10-ops/capacity.md).
//
// This module is the process-wide cap on how many pipelines may hold image data
// resident at once. It bounds peak base64 residency to
// `gradingBufferConcurrency()` submissions regardless of how many grades are
// in flight; excess pipelines park (FIFO) on the semaphore — they hold only a
// closure (and their grading lease, US-569), NOT base64 data — until a slot
// frees. The AI concurrency limiter (ai-limiter.ts, AI_MAX_CONCURRENCY) bounds
// concurrent Claude CALLS but NOT image buffering, so this is a distinct gate.

import { Semaphore } from "./ai-limiter.ts";

// Generous default: 6 concurrent buffering pipelines. With worst-case images
// (~8 photos near the 15 MiB upload cap → ~100 MB resident per submission) this
// keeps peak base64 residency near ~600 MB, comfortably under the 2G limit's
// 30% headroom target. See vault/10-ops/capacity.md for the math + the scale-out rule.
const DEFAULT_MAX_BUFFERING_PIPELINES = 6;

function readPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Max grading pipelines allowed to hold base64 image data resident at once. */
export function gradingBufferConcurrency(): number {
  return Math.max(
    1,
    readPositiveInt("GRADING_MAX_CONCURRENT_PIPELINES", DEFAULT_MAX_BUFFERING_PIPELINES),
  );
}

// One process-wide semaphore, sized on first use (so a test/CI run that never
// grades never reads the env). Sizing is fixed for the process lifetime, like
// the AI limiter's semaphore.
let semaphore: Semaphore | null = null;
function imageBufferSemaphore(): Semaphore {
  if (!semaphore) semaphore = new Semaphore(gradingBufferConcurrency());
  return semaphore;
}

/**
 * Run `fn` (the image download → base64 → per-image analysis block) while
 * holding one of the bounded image-buffer slots. Always releases the slot,
 * even on throw, so a failed download/analysis can't leak capacity.
 */
export function withImageBufferSlot<T>(fn: () => Promise<T>): Promise<T> {
  return imageBufferSemaphore().run(fn);
}

// ── Memory accounting (drives /health/metrics + the load-test gate) ──────────

// Sustained RSS above this % of the container memory limit is the scale-out
// trigger (ties to US-501 replicas). The inverse — 30% — is the headroom target.
export const MEMORY_SCALE_OUT_PCT = 70;
// Above this we are in danger of OOM; the load-test gate fails here by default.
export const MEMORY_CRITICAL_PCT = 85;

export interface MemoryUsageBytes {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface MemorySummary {
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  // Configured container memory limit (EDGE_MEMORY_LIMIT_MB), null if unknown.
  limit_mb: number | null;
  rss_pct_of_limit: number | null;
  headroom_pct: number | null;
  pressure: "ok" | "elevated" | "critical" | "unknown";
}

function toMb(bytes: number): number {
  return Math.round((bytes / 1048576) * 10) / 10;
}

/**
 * Pure: turn a `Deno.memoryUsage()` snapshot + the known container memory limit
 * into MB figures, an RSS-vs-limit percentage, headroom, and a pressure verdict.
 * Unit-tested in health_test.ts; the route keeps no logic.
 */
export function summarizeMemory(
  usage: MemoryUsageBytes,
  limitMb: number | null,
): MemorySummary {
  const rss_mb = toMb(usage.rss);
  const limit = limitMb && limitMb > 0 ? limitMb : null;
  const pct = limit ? Math.round((rss_mb / limit) * 1000) / 10 : null;
  const headroom = pct === null ? null : Math.round((100 - pct) * 10) / 10;
  let pressure: MemorySummary["pressure"] = "unknown";
  if (pct !== null) {
    pressure = pct >= MEMORY_CRITICAL_PCT
      ? "critical"
      : pct >= MEMORY_SCALE_OUT_PCT
      ? "elevated"
      : "ok";
  }
  return {
    rss_mb,
    heap_used_mb: toMb(usage.heapUsed),
    heap_total_mb: toMb(usage.heapTotal),
    external_mb: toMb(usage.external),
    limit_mb: limit,
    rss_pct_of_limit: pct,
    headroom_pct: headroom,
    pressure,
  };
}
