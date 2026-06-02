import { createMiddleware } from "hono/factory";

// Request body-size guard (US-267). Rejects oversized payloads with HTTP 413
// *before* the handler buffers the body, so a single request can't exhaust
// container memory. Enforcement uses the Content-Length header, which Traefik /
// Coolify always sets for these clients; a request that lies about (or omits)
// its length still can't beat the cap because the per-route handlers read the
// body through size-aware paths and the platform caps the socket.
//
// Two tiers, chosen per request path:
//   - UPLOAD paths (multipart image uploads + base64 grade payloads): 15 MB
//   - everything else (JSON-only control-plane endpoints): 256 KB
//
// Applied once on /api/* in main.ts; /health and the static OPTIONS handler
// never reach it.

export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
export const JSON_MAX_BYTES = 256 * 1024; // 256 KB

// Path prefixes that legitimately carry image bytes (multipart files or
// base64-in-JSON). Matched as exact path or `${prefix}/...`.
const UPLOAD_PREFIXES = [
  "/api/grade", // multipart garment photos
  "/api/v1/grades", // public API: base64 / url images in JSON
  "/api/flipdesk/grading", // bridge submit (copies stored photos; small JSON, but be lenient)
  "/api/flipdesk/images", // photo uploads
  "/api/flipdesk/disclosure", // annotated-photo data URLs
  "/api/flipdesk/autolister", // bulk photo batches
  "/api/content/images", // generated/edited content images
];

function isUploadPath(path: string): boolean {
  return UPLOAD_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function capForPath(path: string): number {
  return isUploadPath(path) ? UPLOAD_MAX_BYTES : JSON_MAX_BYTES;
}

export const bodyLimit = createMiddleware(async (c, next) => {
  const method = c.req.method;
  // Only bodied methods carry a payload worth guarding.
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    await next();
    return;
  }

  const cap = capForPath(c.req.path);
  const lenHeader = c.req.header("content-length");
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > cap) {
      return c.json(
        {
          error: "Request body too large",
          maxBytes: cap,
          receivedBytes: len,
        },
        413,
      );
    }
  }

  await next();
});
