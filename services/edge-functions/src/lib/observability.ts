// Observability for the edge service.
//
//   US-491  exception tracking — Sentry-compatible HTTP ingest, gated on
//           SENTRY_DSN, tagged with the release/commit SHA.
//   US-497  structured JSON logs with a per-request correlation id that
//           propagates through fire-and-forget tasks; PII/secrets redacted.
//   US-508  latency / error / throughput metrics emitted as structured lines
//           the log aggregator scrapes (no extra runtime dependency).
//
// Everything here is DEPENDENCY-FREE (plain fetch) and FAIL-SAFE: capture and
// log never throw into the caller — observability must never break a request,
// webhook, or cron. Sentry transport is fire-and-forget with a bounded timeout.
//
// All output flows through redact() (log-redact.ts) so JWTs, API keys, eBay /
// OAuth tokens, webhook signatures, and emails can never reach a log sink or
// the error tracker.

import { redact } from "./log-redact.ts";
import { edgeEnv } from "./env.ts";

// The access logger sets correlationId on every request before any handler
// runs, so it's a required context var visible to every typed Context. (userId
// / workspaceOwnerId stay per-route via each route's Env generic — declaring
// them here would make them optional everywhere and break the routes that rely
// on `userId: string`.)
declare module "hono" {
  interface ContextVariableMap {
    correlationId: string;
  }
}

// Read a context variable that isn't in the route's typed Env (e.g. userId from
// the global onError handler). Returns undefined when absent. Cast-based on
// purpose: the global error handler runs under the default Env where these keys
// aren't statically known.
export function readCtxVar(
  c: { get: (key: string) => unknown },
  key: string,
): string | undefined {
  try {
    const v = (c.get as (k: string) => unknown)(key);
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

// ── Release identity ────────────────────────────────────────────────
// The deploy pipeline stamps the image with the commit SHA (US-513). We accept
// any of the common env names so the same code works on Coolify / CI / local.
let cachedRelease: string | null = null;
export function releaseSha(): string {
  if (cachedRelease !== null) return cachedRelease;
  const raw = (Deno.env.get("RELEASE_SHA") ??
    Deno.env.get("COMMIT_SHA") ??
    Deno.env.get("SOURCE_COMMIT") ??
    Deno.env.get("GIT_SHA") ??
    "unknown").trim();
  cachedRelease = raw === "" ? "unknown" : raw.slice(0, 40);
  return cachedRelease;
}

// ── Correlation id ──────────────────────────────────────────────────
export function newCorrelationId(): string {
  return crypto.randomUUID();
}

// ── Structured logging (US-497) ─────────────────────────────────────
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  /** Per-request correlation id; propagate into fire-and-forget tasks. */
  correlationId?: string;
  /** Route / handler tag, e.g. "grade.submit". */
  route?: string;
  /** Owning user/tenant id when known. */
  userId?: string;
  [key: string]: unknown;
}

// Emit one structured JSON line. The whole serialized line is run through
// redact() so a token/email nested anywhere in `fields` is scrubbed before it
// reaches stdout (and therefore the aggregator).
export function logEvent(
  level: LogLevel,
  event: string,
  fields: LogContext = {},
): void {
  let line: string;
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      release: releaseSha(),
      env: edgeEnv(),
      ...fields,
    });
  } catch {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      release: releaseSha(),
      _warn: "log fields not serializable",
    });
  }
  line = redact(line);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// ── Metrics (US-508) ────────────────────────────────────────────────
// Lightweight counter/timing emitter. Metrics are structured log lines
// (event:"metric") so the same aggregator (US-497) powers dashboards/alerts —
// no separate metrics-backend client needed at the edge. Each line carries the
// correlation id so a slow request can be traced across fan-out.
export function recordMetric(
  name: string,
  value: number,
  tags: LogContext = {},
): void {
  logEvent("info", "metric", { metric: name, value, ...tags });
}

// Measure an async operation: emits `<name>` latency (ms) + a success/error
// tag, and re-throws so callers keep their normal control flow.
export async function timed<T>(
  name: string,
  fn: () => Promise<T>,
  tags: LogContext = {},
): Promise<T> {
  const start = Date.now();
  try {
    const out = await fn();
    recordMetric(name, Date.now() - start, { ...tags, unit: "ms", outcome: "ok" });
    return out;
  } catch (err) {
    recordMetric(name, Date.now() - start, { ...tags, unit: "ms", outcome: "error" });
    throw err;
  }
}

// ── Exception tracking (US-491) ─────────────────────────────────────
export interface CaptureContext {
  level?: LogLevel;
  route?: string;
  userId?: string;
  correlationId?: string;
  method?: string;
  url?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

interface ParsedDsn {
  publicKey: string;
  endpoint: string; // …/api/<projectId>/store/
}

function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\/+/, "");
    if (!publicKey || !projectId) return null;
    return {
      publicKey,
      endpoint: `${u.protocol}//${u.host}/api/${projectId}/store/`,
    };
  } catch {
    return null;
  }
}

// Fire-and-forget exception capture. ALWAYS logs the error locally (structured,
// redacted) and, when SENTRY_DSN is set, ships it to the tracker. Never throws
// and never blocks the caller.
export function captureException(err: unknown, context: CaptureContext = {}): void {
  // Always leave a local structured breadcrumb even with no tracker configured.
  logEvent("error", "exception", {
    route: context.route,
    userId: context.userId,
    correlationId: context.correlationId,
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    ...context.tags,
  });
  void shipToSentry(err, context).catch(() => {
    // Transport failure must never escalate. The local log above is the floor.
  });
}

async function shipToSentry(err: unknown, context: CaptureContext): Promise<void> {
  const dsn = Deno.env.get("SENTRY_DSN")?.trim();
  if (!dsn) return; // not configured — local log only
  const parsed = parseDsn(dsn);
  if (!parsed) {
    logEvent("warn", "sentry.dsn_invalid", {});
    return;
  }

  const e = err instanceof Error
    ? err
    : new Error(typeof err === "string" ? err : safeStringify(err));

  const event = {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: context.level ?? "error",
    release: releaseSha(),
    environment: edgeEnv(),
    server_name: "gradethread-edge",
    transaction: context.route,
    tags: { route: context.route ?? "unknown", ...(context.tags ?? {}) },
    ...(context.userId ? { user: { id: context.userId } } : {}),
    ...(context.method || context.url
      ? { request: { method: context.method, url: context.url } }
      : {}),
    extra: {
      correlationId: context.correlationId,
      stack: e.stack ?? null,
      ...(context.extra ?? {}),
    },
    exception: {
      values: [{ type: e.name, value: e.message }],
    },
  };

  // Redact the FULL serialized payload (message, stack, extra, url) before it
  // leaves the process.
  const body = redact(safeStringify(event));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(parsed.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth":
          `Sentry sentry_version=7, sentry_client=gradethread-edge/1.0, sentry_key=${parsed.publicKey}`,
      },
      body,
      signal: ctrl.signal,
    });
    await res.body?.cancel();
  } finally {
    clearTimeout(timer);
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// True when an exception tracker is wired up. Used by /health to report
// observability readiness without leaking the DSN.
export function isErrorTrackingConfigured(): boolean {
  return !!Deno.env.get("SENTRY_DSN")?.trim();
}
