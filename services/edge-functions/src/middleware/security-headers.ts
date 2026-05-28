import { createMiddleware } from "hono/factory";

// Response-hardening headers applied to every edge response (US-263).
//
// CORS headers are owned by the cors() middleware + the explicit OPTIONS
// preflight handler in main.ts — this middleware must run AFTER cors() and
// only ADDS headers, never touches Access-Control-*.

// User-scoped surfaces whose responses must never be cached by a browser or
// shared intermediary. Public blog content (/api/content/public) and /health
// are deliberately omitted so they stay cacheable.
const NO_STORE_PREFIXES = [
  "/api/payments",
  "/api/keys",
  "/api/admin",
  "/api/workspace",
  "/api/v1",
  "/api/grade",
  "/api/flipdesk",
  "/api/notifications",
];

function isSensitivePath(path: string): boolean {
  return NO_STORE_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

export const securityHeaders = createMiddleware(async (c, next) => {
  await next();

  // Static hardening headers on every response (success or error).
  c.header(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload",
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Cross-Origin-Resource-Policy", "same-site");

  if (c.req.path !== "/health" && isSensitivePath(c.req.path)) {
    c.header("Cache-Control", "no-store");
  }
});
