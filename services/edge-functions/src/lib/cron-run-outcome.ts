// US-2312: read a cron's OUTCOME out of its response body, not just its status.
//
// Every /api/jobs/* run was recorded as "success" whenever it answered 2xx, and
// `job.failed` fired only on >= 400. But the sweeps that matter most report
// their failures IN THE BODY and still answer 200: affiliate-payouts and
// consignor-payouts return `{ok:true, failed:N}` (every transfer can fail and
// the console reads green), and guarantee-pool returns `{ok:true,
// discrepancies:N}` — an auto_approved claim with no pool drawdown, i.e.
// unaccounted financial exposure — with a console.error nobody reads.
//
// So the ledger and the alert now look at the body. This is deliberately ONE
// chokepoint in main.ts rather than an edit to each job: the next job that
// counts its own failures is covered without its author remembering to wire
// anything, which is the failure mode that produced this story.
//
// HTTP stays 200 on a partial failure ON PURPOSE. Coolify invokes these with
// `curl -fsS`, so returning 5xx for "3 of 500 transfers failed" would mark the
// scheduled TASK failed and, on some setups, retry the whole sweep. The run is
// instead recorded as `error` in cron_runs (so success_rate and the admin Jobs
// dashboard stop reading green) and an ops event is emitted at warning.

// `import type` only: the ledger and ops-event writers reach the supabase
// client, which throws at module load without SUPABASE_URL. They are imported
// dynamically inside finishCronRun (the same trick ai-config.ts uses for
// ai-usage.ts) so the pure readers above stay import-safe for unit tests that
// never make a real call.
import type { CronRunStatus } from "./cron-runs.ts";

/**
 * Body keys a job may use to report units of work that FAILED. A job wanting
 * this signal names its counter one of these; anything else is invisible here
 * by design, because guessing at arbitrary keys is how a false alert gets built.
 */
export const FAILURE_KEYS = [
  "failed",
  "failures",
  "errors",
  "discrepancies",
  "unaccounted",
] as const;

/**
 * Body keys read for `rows_processed`, in precedence order. A job that wants an
 * exact number returns `rowsProcessed` explicitly; the rest are the conventional
 * names already in use across the fleet. When a JSON object body carries NONE of
 * them the run is recorded as 0 rows rather than null — "ran but did nothing for
 * a week" has to be queryable, which was the whole point of the unused column.
 */
export const PROCESSED_KEYS = [
  "rowsProcessed",
  "rows_processed",
  "processed",
  "scanned",
  "count",
] as const;

/**
 * US-3112: the one body key that may carry SENTENCES rather than counts.
 *
 * Every key above is a number, so a job that knows exactly what went wrong had
 * nowhere to put it and the ledger recorded the count alone. That is how the
 * eBay notification reconcile's 2026-09-03 18:17 run came to say
 * `{"failures":{"errors":12}}` — twelve of what, on which topic, existed only in
 * a container log that has since rotated away, so the story asking somebody to
 * diagnose it needed SSH nobody has.
 *
 * A job returns `diagnostics: string[]`; they land in `cron_runs.detail` and the
 * `job.failed` ops event, which are both queryable with the service-role key.
 */
export const DIAGNOSTICS_KEY = "diagnostics";

/**
 * Bounds applied HERE, not trusted from the job. `detail` is a jsonb column
 * written on every run of every cron in the fleet; a misconfiguration that
 * produced one entry per topic per tick would otherwise grow the table without
 * limit, and the first few entries say what the last few say.
 */
export const MAX_DIAGNOSTICS = 10;
export const MAX_DIAGNOSTIC_CHARS = 300;

export interface JobOutcome {
  /**
   * A lower bound on the units of work that failed — the LARGEST single failure
   * counter, not their sum, because a job reporting both `failed` and `errors`
   * is usually describing one set of items twice. The full breakdown is in
   * `failures`.
   */
  failedItems: number;
  /** Every failure counter that was present and non-zero, by body key. */
  failures: Record<string, number>;
  /** Rows the run processed; null only when the body is not a JSON object. */
  rowsProcessed: number | null;
  /**
   * Short human-readable lines the job wrote about what failed, bounded and
   * truncated. Empty when the job said nothing — never fabricated from counts.
   */
  diagnostics: string[];
}

/** A count from a body value: a finite non-negative number, or an array length. */
function countOf(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (Array.isArray(value)) return value.length;
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The `diagnostics` body value, normalised. Non-strings are stringified only
 * when they are a plain scalar; an object is dropped rather than written as
 * `[object Object]`, which is a line that costs a reader time and tells them
 * nothing. Blank entries are dropped for the same reason.
 */
function readDiagnostics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= MAX_DIAGNOSTICS) break;
    let line: string;
    if (typeof entry === "string") line = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") line = String(entry);
    else continue;
    line = line.trim();
    if (!line) continue;
    out.push(
      line.length > MAX_DIAGNOSTIC_CHARS
        ? `${line.slice(0, MAX_DIAGNOSTIC_CHARS)}...`
        : line,
    );
  }
  return out;
}

/** Pure: what a parsed job response body says about its own outcome. */
export function readJobOutcome(body: unknown): JobOutcome {
  if (!isPlainObject(body)) {
    return { failedItems: 0, failures: {}, rowsProcessed: null, diagnostics: [] };
  }

  const failures: Record<string, number> = {};
  for (const key of FAILURE_KEYS) {
    if (!(key in body)) continue;
    const n = countOf(body[key]);
    if (n !== null && n > 0) failures[key] = n;
  }
  const failedItems = Object.values(failures).reduce((max, n) => Math.max(max, n), 0);

  let rowsProcessed = 0;
  for (const key of PROCESSED_KEYS) {
    if (!(key in body)) continue;
    const n = countOf(body[key]);
    if (n !== null) {
      rowsProcessed = n;
      break;
    }
  }

  return {
    failedItems,
    failures,
    rowsProcessed,
    diagnostics: readDiagnostics(body[DIAGNOSTICS_KEY]),
  };
}

/**
 * Pure: the ledger status for a run. A 2xx that reported failed units is an
 * `error` row — that is what makes it visible to success_rate, the admin Jobs
 * dashboard and the fleet report, none of which ever looked at a payload.
 */
export function cronRunStatusFor(httpStatus: number, failedItems: number): CronRunStatus {
  if (httpStatus >= 400) return "error";
  return failedItems > 0 ? "error" : "success";
}

/** The ops-event title for a failed run. Exported so its wording is pinned. */
export function jobFailureTitle(params: {
  jobName: string;
  httpStatus: number;
  outcome: JobOutcome;
}): string {
  const { jobName, httpStatus, outcome } = params;
  if (httpStatus >= 400) {
    return `Background job "${jobName}" failed (HTTP ${httpStatus})`;
  }
  // Named separately from the HTTP case: an operator seeing this needs to know
  // the request itself succeeded, or they go looking for a 500 that never
  // happened.
  const breakdown = Object.entries(outcome.failures)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  return `Background job "${jobName}" returned HTTP ${httpStatus} but reported ` +
    `${outcome.failedItems} failed item(s) (${breakdown})`;
}

/**
 * Parse a job's JSON response without consuming the response the caller gets.
 * Returns null for a non-JSON or unreadable body. The clone is taken
 * SYNCHRONOUSLY (before the response is sent) — reading it later would race the
 * consumed stream.
 */
export function cloneJsonBody(res: Response): Promise<unknown> | null {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return null;
  try {
    return res.clone().json().catch(() => null);
  } catch {
    return null;
  }
}

/**
 * Record one cron run and raise the ops event if it failed — by HTTP status OR
 * by its own reported failure counts. Fire-and-forget: never awaited by the
 * request path, never throws.
 */
export function finishCronRun(params: {
  jobName: string;
  response: Response;
  httpStatus: number;
  durationMs: number;
  triggeredBy: string;
}): void {
  const { jobName, httpStatus, durationMs, triggeredBy } = params;
  const bodyPromise = cloneJsonBody(params.response);

  void (async () => {
    let outcome: JobOutcome = {
      failedItems: 0,
      failures: {},
      rowsProcessed: null,
      diagnostics: [],
    };
    try {
      outcome = readJobOutcome(bodyPromise ? await bodyPromise : null);
    } catch {
      // A body we cannot read must not lose us the run record.
    }

    const status = cronRunStatusFor(httpStatus, outcome.failedItems);
    const hasFailures = Object.keys(outcome.failures).length > 0;
    const hasDiagnostics = outcome.diagnostics.length > 0;

    // US-3112: diagnostics are written whether or not a counter came with them.
    // A job can know what went wrong without being able to count it, and the
    // reverse — a count with no sentence — is the state this story exists to end.
    const detail: Record<string, unknown> = {};
    if (hasFailures) detail.failures = outcome.failures;
    if (hasDiagnostics) detail.diagnostics = outcome.diagnostics;

    const { recordCronRun } = await import("./cron-runs.ts");
    void recordCronRun({
      jobName,
      status,
      httpStatus,
      durationMs,
      triggeredBy,
      rowsProcessed: outcome.rowsProcessed ?? undefined,
      detail: hasFailures || hasDiagnostics ? detail : undefined,
    });

    if (status !== "error") return;

    const { emitOpsEvent } = await import("./ops-events.ts");
    void emitOpsEvent("job.failed", "warning", {
      title: jobFailureTitle({ jobName, httpStatus, outcome }),
      source: jobName,
      data: {
        job: jobName,
        http_status: httpStatus,
        triggered_by: triggeredBy,
        failed_items: outcome.failedItems,
        failures: outcome.failures,
        rows_processed: outcome.rowsProcessed,
        diagnostics: outcome.diagnostics,
      },
    });
  })();
}
