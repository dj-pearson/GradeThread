// Access logger (US-359 / US-497 / US-508).
//
// Replaces Hono's built-in logger(). It logs ONLY method, the URL pathname
// (query string dropped — tokens/emails are sometimes passed as params),
// status, and duration. It never reads or logs request headers, so the
// Authorization / X-API-Key / signature headers can't land in a log sink. The
// pathname is run through redact() as a backstop in case an id-shaped secret
// is embedded in the path.
//
// US-497: every request gets a correlation id (reused from an inbound
// X-Request-Id / X-Correlation-Id when present, else generated). It's stored on
// the context (c.get("correlationId")) so handlers and their fire-and-forget
// tasks can stamp it onto logs + captured exceptions, and echoed back in the
// X-Request-Id response header. The access line is structured JSON.
// US-508: the same line is the per-request latency/throughput metric.
// US-578: the access line is the highest-volume log the edge emits, so it is
// the main lever on logging cost. Successful (status < 400) lines are sampled
// at EDGE_TRACE_SAMPLE_RATE (deterministic per correlation id, so a request's
// access line and its timed() spans are kept/dropped together). Every 4xx/5xx
// is ALWAYS logged — we never sample away error or audit signal. Retention,
// rotation, and the cost budget are documented in OBSERVABILITY.md.
import { createMiddleware } from "hono/factory";
import { redact } from "../lib/log-redact.ts";
import { logEvent, newCorrelationId, shouldSampleTrace } from "../lib/observability.ts";

// Default ON: the cost is one small line per request, and it is the only way to
// attribute a hung event loop to a route. See the note at its use site.
const LOG_REQUEST_START = (Deno.env.get("EDGE_LOG_REQUEST_START") ?? "1") !== "0";

export const accessLogger = createMiddleware(async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  // Pathname only — never the querystring, never headers.
  let path = c.req.path;
  try {
    path = new URL(c.req.url).pathname;
  } catch {
    // c.req.path is already the pathname; keep it.
  }
  const safePath = redact(path);

  // Reuse a caller-supplied id (e.g. from Cloudflare / a retrying webhook) when
  // it's a sane length, else mint one. Stored for handlers + propagated out.
  const inbound = (c.req.header("X-Request-Id") ?? c.req.header("X-Correlation-Id") ?? "")
    .trim()
    .slice(0, 64);
  const correlationId = inbound || newCorrelationId();
  c.set("correlationId", correlationId);
  c.header("X-Request-Id", correlationId);

  // US-2151: emit a line BEFORE the handler runs.
  //
  // The completion line below is the only access log we had, which meant a
  // request that never completed left no trace at all. On 2026-07-20 the event
  // loop entered a synchronous spin and the process hung — alive (so
  // `restart: unless-stopped` never fired) but serving nothing, so Traefik
  // dropped it and every route returned "no available server". The logs simply
  // stopped mid-stream with no error and no indication of which route did it.
  //
  // A start line makes the culprit self-identifying: after a hang, the LAST
  // http.request.start with no matching http.request completion IS the request
  // that blocked the loop. Correlate on correlationId.
  //
  // Deliberately NOT sampled — sampling is what would drop the one line that
  // matters, and a stall is by definition the rare case. Set
  // EDGE_LOG_REQUEST_START=0 to disable once the loop is found and fixed.
  if (LOG_REQUEST_START) {
    logEvent("info", "http.request.start", { correlationId, method, path: safePath });
  }

  await next();

  const ms = Date.now() - start;
  // Always log errors (4xx/5xx); sample successful requests to bound log cost.
  if (c.res.status >= 400 || shouldSampleTrace(correlationId)) {
    logEvent("info", "http.request", {
      correlationId,
      method,
      path: safePath,
      status: c.res.status,
      durationMs: ms,
    });
  }
});
