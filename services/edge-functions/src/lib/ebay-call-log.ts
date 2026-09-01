/**
 * US-3042: count every eBay API call.
 *
 * WHY THIS EXISTS. eBay's Application Growth Check asks for a call volume
 * estimate and will not raise a limit for an application that has no measured
 * usage. Every eBay request already funnelled through three well-behaved choke
 * points that timed out, retried, honored Retry-After and tripped a breaker —
 * and recorded nothing. So "how many calls a day do we make" had no answer.
 *
 * THE COST CONSTRAINT SHAPES THE DESIGN. This sits on the hot path of every
 * eBay request, including bulk publishes that fan out hundreds of calls. So a
 * call costs one map increment and nothing else: no await, no allocation beyond
 * a key string, no I/O. The buffer is drained on an interval by flush(), which
 * is the only thing that touches the database.
 *
 * NOTHING HERE MAY THROW. A counter that can break a publish is worse than no
 * counter. Every entry point swallows its own errors; the worst failure mode is
 * an undercount, which we would rather have than a failed listing.
 *
 * The three pure functions (classifyEbayApi, normalizeEbayEndpoint,
 * statusClassOf) carry the actual judgement and are unit tested without a
 * database or a network.
 */

import { supabaseAdmin } from "./supabase.ts";

/**
 * eBay publishes call limits per API family, so this is the grain their quota
 * uses and therefore the grain worth counting at. 'other' is deliberate: an
 * unrecognised host/path still gets counted, it just lands in the bucket that
 * says "somebody added an API and did not teach this function about it".
 */
export type EbayApiFamily =
  | "inventory"
  | "fulfillment"
  | "account"
  | "finances"
  | "marketing"
  | "compliance"
  | "browse"
  | "taxonomy"
  | "insights"
  | "logistics"
  | "postorder"
  | "notification"
  | "analytics"
  | "feed"
  | "trading"
  | "oauth"
  | "other";

/** Longest-prefix wins, so /sell/inventory beats /sell. Order matters. */
const PATH_FAMILY: ReadonlyArray<readonly [string, EbayApiFamily]> = [
  ["/sell/inventory", "inventory"],
  ["/sell/fulfillment", "fulfillment"],
  ["/sell/account", "account"],
  ["/sell/finances", "finances"],
  ["/sell/marketing", "marketing"],
  ["/sell/compliance", "compliance"],
  ["/sell/logistics", "logistics"],
  ["/sell/feed", "feed"],
  ["/sell/analytics", "analytics"],
  ["/buy/browse", "browse"],
  ["/buy/marketplace_insights", "insights"],
  ["/buy/offer", "browse"],
  ["/commerce/taxonomy", "taxonomy"],
  ["/commerce/notification", "notification"],
  ["/commerce/identity", "account"],
  ["/post-order", "postorder"],
  ["/developer/analytics", "analytics"],
  ["/identity/v1/oauth2", "oauth"],
  ["/ws/api.dll", "trading"],
];

/**
 * Which eBay API family a URL belongs to. Never throws: an unparseable URL is
 * 'other', because a counter that rejects bad input silently loses calls.
 */
export function classifyEbayApi(rawUrl: string): EbayApiFamily {
  let path: string;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    // Not absolute — treat the whole string as a path so a relative caller
    // still classifies rather than falling to 'other'.
    path = rawUrl.split("?")[0] ?? "";
  }
  for (const [prefix, family] of PATH_FAMILY) {
    if (path.startsWith(prefix)) return family;
  }
  return "other";
}

// A path segment that identifies one THING rather than one KIND of thing. These
// are what would turn a rollup into an event log if they reached the database.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /\d/;

function isIdSegment(seg: string): boolean {
  if (seg === "") return false;
  // v1, v1_beta, v2 are version markers, not ids, even though they contain a
  // digit. Without this every path would template its own version away and
  // /sell/inventory/v1/offer would collide with a hypothetical v2.
  if (/^v\d+(_beta)?$/i.test(seg)) return false;
  if (UUID_RE.test(seg)) return true;
  // Anything carrying a digit is an id (eBay item ids, offer ids, order ids,
  // SKUs, category ids). Anything very long is one too — SKUs are seller-chosen
  // and need not contain a digit.
  return ID_RE.test(seg) || seg.length > 24;
}

/**
 * Template a request path so a per-item call does not mint a row per item.
 * `/sell/inventory/v1/offer/8123456789` becomes `/sell/inventory/v1/offer/{id}`.
 *
 * THIS FUNCTION IS WHY THE TABLE STAYS SMALL. A change that lets a raw id
 * through turns the daily rollup into an unbounded event log, silently.
 *
 * @param callName Trading API call name (`X-EBAY-API-CALL-NAME`). The Trading
 *   API is one URL for every operation, so without this all of it collapses
 *   into a single indistinguishable row.
 */
export function normalizeEbayEndpoint(rawUrl: string, callName?: string): string {
  let path: string;
  try {
    path = new URL(rawUrl).pathname;
  } catch {
    path = rawUrl.split("?")[0] ?? "";
  }
  if (path === "") path = "/";

  const templated = path
    .split("/")
    .map((seg) => (isIdSegment(seg) ? "{id}" : seg))
    .join("/");

  const suffix = callName?.trim() ? `:${callName.trim()}` : "";
  // The column is capped at 200 in SQL; cap here too so the two agree and a
  // pathological path can never be silently truncated into a different bucket
  // than the one this function reports.
  return `${templated}${suffix}`.slice(0, 200);
}

export type EbayStatusClass = "2xx" | "3xx" | "4xx" | "429" | "5xx" | "error";

/**
 * 429 is split out from 4xx on purpose: it is the one status that means we are
 * at the ceiling, which is the entire question this table exists to answer.
 * `null` means the call never got a response at all (timeout, DNS, connection
 * reset), which is not the same as eBay refusing it.
 */
export function statusClassOf(status: number | null | undefined): EbayStatusClass {
  if (status == null) return "error";
  if (status === 429) return "429";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "error";
}

/** UTC, because eBay's call limits reset on a UTC day boundary. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface EbayCallRow {
  day: string;
  api: string;
  endpoint: string;
  method: string;
  status_class: string;
  calls: number;
}

// ── The buffer ──────────────────────────────────────────────────────

const buffer = new Map<string, EbayCallRow>();

/**
 * Hard ceiling on distinct buckets held in memory. With templated endpoints the
 * real number is in the low hundreds; this only bites if normalizeEbayEndpoint
 * regresses and starts letting ids through, in which case we would rather stop
 * counting than grow the heap without bound. Crossing it forces a flush.
 */
const MAX_BUCKETS = 2_000;

/** How often the buffer drains. Short enough that a container restart loses little. */
const FLUSH_INTERVAL_MS = 60_000;

// `ReturnType<typeof setInterval>` rather than `number`: Deno's lib types this
// as a Timeout object, and pinning it to number is the sort of thing that
// compiles locally and fails in CI on a lib-version bump.
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

/**
 * Count one eBay call. Synchronous, allocation-light, and cannot throw.
 * Call it AFTER the response (or failure) is known.
 */
export function recordEbayCall(args: {
  url: string | URL;
  method?: string;
  status?: number | null;
  callName?: string;
  now?: Date;
}): void {
  try {
    const url = typeof args.url === "string" ? args.url : args.url.toString();
    const day = utcDay(args.now);
    const api = classifyEbayApi(url);
    const endpoint = normalizeEbayEndpoint(url, args.callName);
    const method = (args.method ?? "GET").toUpperCase().slice(0, 10);
    const statusClass = statusClassOf(args.status);

    const key = `${day}|${api}|${endpoint}|${method}|${statusClass}`;
    const existing = buffer.get(key);
    if (existing) {
      existing.calls += 1;
    } else {
      if (buffer.size >= MAX_BUCKETS) {
        // Do not grow past the ceiling. Drop this one rather than the heap.
        void flushEbayCallLog();
        return;
      }
      buffer.set(key, {
        day,
        api,
        endpoint,
        method,
        status_class: statusClass,
        calls: 1,
      });
    }
    ensureFlushTimer();
  } catch {
    // An undercount beats a broken publish. Never propagate.
  }
}

function ensureFlushTimer(): void {
  if (flushTimer !== null) return;
  try {
    const id = setInterval(() => {
      void flushEbayCallLog();
    }, FLUSH_INTERVAL_MS);
    flushTimer = id;
    // Do not hold the process open on this timer alone — a one-shot script that
    // makes an eBay call should still exit.
    (Deno as { unrefTimer?: (id: number) => void }).unrefTimer?.(
      id as unknown as number,
    );
  } catch {
    flushTimer = null;
  }
}

/**
 * Drain the buffer into the daily rollup. Safe to call concurrently (a second
 * call while one is in flight is a no-op) and safe to call with nothing buffered.
 *
 * On failure the drained rows are merged BACK into the buffer rather than
 * dropped, so a transient database blip costs a delay and not the count. The
 * merge adds to whatever accumulated meanwhile, which is why the buffer holds
 * counts rather than events.
 */
export async function flushEbayCallLog(): Promise<number> {
  if (flushing || buffer.size === 0) return 0;
  flushing = true;
  const drained = [...buffer.values()];
  buffer.clear();
  try {
    const { error } = await supabaseAdmin.rpc("bump_ebay_api_calls", {
      p_rows: drained,
    });
    if (error) throw new Error(error.message);
    return drained.length;
  } catch (err) {
    for (const row of drained) {
      const key =
        `${row.day}|${row.api}|${row.endpoint}|${row.method}|${row.status_class}`;
      const existing = buffer.get(key);
      if (existing) existing.calls += row.calls;
      else if (buffer.size < MAX_BUCKETS) buffer.set(key, row);
    }
    console.error(
      "[ebay-call-log] flush failed; counts retained for next attempt:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  } finally {
    flushing = false;
  }
}

/** Test seam: how many buckets are pending. Not for production use. */
export function pendingEbayCallBuckets(): number {
  return buffer.size;
}

/** Test seam: drop everything buffered without writing. Not for production use. */
export function resetEbayCallLog(): void {
  buffer.clear();
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
