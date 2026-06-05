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
import { createMiddleware } from "hono/factory";
import { redact } from "../lib/log-redact.ts";
import { logEvent, newCorrelationId } from "../lib/observability.ts";

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

  await next();

  const ms = Date.now() - start;
  logEvent("info", "http.request", {
    correlationId,
    method,
    path: safePath,
    status: c.res.status,
    durationMs: ms,
  });
});
