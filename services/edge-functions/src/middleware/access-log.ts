// Access logger (US-359).
//
// Replaces Hono's built-in logger(). It logs ONLY method, the URL pathname
// (query string dropped — tokens/emails are sometimes passed as params),
// status, and duration. It never reads or logs request headers, so the
// Authorization / X-API-Key / signature headers can't land in a log sink. The
// pathname is run through redact() as a backstop in case an id-shaped secret
// is embedded in the path.
import { createMiddleware } from "hono/factory";
import { redact } from "../lib/log-redact.ts";

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

  await next();

  const ms = Date.now() - start;
  console.log(`${method} ${safePath} ${c.res.status} ${ms}ms`);
});
