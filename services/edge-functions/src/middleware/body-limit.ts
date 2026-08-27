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
  "/api/flipdesk/expenses", // US-2228: one receipt image or PDF, multipart
  "/api/flipdesk/autolister", // bulk photo batches
  "/api/content/images", // generated/edited content images
  "/api/grading/public/grade-check", // US-1687: anon grade-checker (one base64 image in JSON)
  "/api/flipdesk/scout/prospect", // US-1107 prospecting: 1-2 base64 photos in JSON
  "/api/flipdesk/scout/appraise", // scout appraise: one base64 photo in JSON
  "/api/grading/public/authenticity-check", // US-2145: up to 4 base64 photos in JSON
  "/api/buyer/authenticity", // US-1840: same body, buyer surface
];

// Upload paths whose route carries a path PARAMETER, so a prefix can't reach
// them. Anchored and enumerated rather than matched by suffix: `/evidence` is
// the eBay multipart image upload on three dispute surfaces, and nothing else
// should inherit a 15 MB cap by accidentally ending in the same word.
const UPLOAD_PATTERNS = [
  // eBay evidence images (multipart `file` parts) on the case, return and
  // payment-dispute surfaces.
  /^\/api\/flipdesk\/ebay\/(cases|returns|payment-disputes)\/[^/]+\/evidence$/,
];

function isUploadPath(path: string): boolean {
  if (UPLOAD_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return true;
  return UPLOAD_PATTERNS.some((re) => re.test(path));
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

  // Fast path: an honest Content-Length over the cap is rejected up front with
  // a clean 413 before the body is touched.
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

  // US-362: the header can be omitted or lie (e.g. chunked transfer-encoding),
  // so we also count bytes AS THE HANDLER READS the body and abort the stream
  // the moment it exceeds the cap — a single request can't grow the buffer past
  // `cap` no matter what it claims. We swap the request's body for a wrapper
  // stream; the wrapper only advances when the handler pulls, so this stays
  // streaming (no eager buffering) and is a no-op for bodyless requests.
  const original = c.req.raw;
  if (original.body) {
    const guarded = new Request(original, {
      body: capBodyStream(original.body, cap),
      // Required by the Fetch/Deno runtime when a Request carries a stream body.
      duplex: "half",
    } as RequestInit);
    c.req.raw = guarded;
  }

  await next();
});

// Error thrown into the body stream when the handler reads past the cap. The
// handler's body parse (json()/formData()/arrayBuffer()) rejects with this, so
// the route fails closed instead of buffering an unbounded payload.
export class BodyTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`Request body exceeded ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

// Wraps a request body stream so reading it aborts once `cap` bytes have passed
// through. Pure pass-through below the cap; errors the stream above it.
export function capBodyStream(
  src: ReadableStream<Uint8Array>,
  cap: number,
): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > cap) {
        const err = new BodyTooLargeError(cap);
        controller.error(err);
        await reader.cancel(err);
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
