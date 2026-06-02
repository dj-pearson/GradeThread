import type { Context } from "hono";
import { z, type ZodError, type ZodType } from "zod";

// Shared request-validation helpers (US-267).
//
// Goal: every POST/PATCH handler validates its body through a single,
// terse path that (a) enforces Content-Type, (b) parses JSON safely,
// (c) runs a zod schema, and (d) returns a 400 with field-level errors —
// never a 500 — on malformed input. Service-role queries downstream then
// only ever see shapes the schema allowed (no smuggled extra fields).

export { z };

// Flatten a ZodError into `["field.path: message", ...]` so the response
// `details` array matches the manual-validation style already used across the
// edge routes (e.g. grade.ts, api-v1.ts).
export function zodErrorDetails(err: ZodError): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export type ValidateOk<T> = { ok: true; data: T };
export type ValidateErr = {
  ok: false;
  status: 400 | 415;
  error: string;
  details: string[];
};

/**
 * Parse + validate a JSON request body against a zod schema.
 *
 * On success returns `{ ok: true, data }`. On failure returns a structured
 * error the caller renders as JSON — Content-Type mismatch is 415, malformed
 * JSON or schema failure is 400. The caller owns the response envelope so this
 * works for both the plain `{ error }` shape and the api-v1 `{ data, error }`
 * shape.
 */
export async function validateJson<T>(
  c: Context,
  schema: ZodType<T>,
): Promise<ValidateOk<T> | ValidateErr> {
  const contentType = c.req.header("content-type") ?? "";
  // Tolerate charset / boundary params: we only require the base type.
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 415,
      error: "Content-Type must be application/json",
      details: [],
    };
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body", details: [] };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      status: 400,
      error: "Validation failed",
      details: zodErrorDetails(result.error),
    };
  }
  return { ok: true, data: result.data };
}

// ── Base64 / data-URL image validation ──────────────────────────────────────

// MIME types we accept for grading images. Mirrors what Claude Vision accepts.
export const ALLOWED_IMAGE_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

export const MAX_DECODED_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image

export type DecodedImage = {
  bytes: Uint8Array;
  mime: AllowedImageMime;
};

export type DecodeImageResult =
  | { ok: true; image: DecodedImage }
  | { ok: false; error: string };

// Magic-byte signatures so a request can't declare image/png while shipping an
// executable or a 50-line SVG. We sniff the first bytes and require them to be
// consistent with the declared MIME.
function sniffMime(bytes: Uint8Array): AllowedImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif"; // GIF8
  }
  return null;
}

/**
 * Validate + decode a base64 (optionally data-URL-wrapped) image input before
 * it is forwarded to Claude Vision or written to storage (US-267).
 *
 * Checks, in order: declared MIME is on the allowlist, the base64 charset is
 * well-formed, the decoded byte size is within `maxBytes`, and the decoded
 * magic bytes are consistent with the declared MIME.
 */
export function decodeBase64Image(
  input: string,
  declaredMime: string | undefined,
  maxBytes: number = MAX_DECODED_IMAGE_BYTES,
): DecodeImageResult {
  // A data URL carries its own MIME: data:image/png;base64,XXXX
  let mime = (declaredMime ?? "").trim().toLowerCase();
  let b64 = input;
  const dataUrl = input.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (dataUrl) {
    if (!mime) mime = dataUrl[1].trim().toLowerCase();
    b64 = dataUrl[3];
  } else if (input.includes(",") && input.slice(0, 32).includes("base64")) {
    // Defensive: a malformed data-url-ish string — take the part after the comma.
    b64 = input.split(",")[1] ?? input;
  }

  if (!mime) {
    return { ok: false, error: "content_type is required for base64 image data" };
  }
  if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(mime)) {
    return {
      ok: false,
      error: `content_type must be one of: ${ALLOWED_IMAGE_MIME.join(", ")}`,
    };
  }

  // Strip whitespace/newlines that clients sometimes wrap base64 with.
  const clean = b64.replace(/\s+/g, "");
  if (clean.length === 0) {
    return { ok: false, error: "base64 image data is empty" };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    return { ok: false, error: "base64 image data is malformed" };
  }

  // Decoded size = 3 bytes per 4 base64 chars (minus padding). Reject *before*
  // allocating if the declared length already blows the cap.
  const approxBytes = Math.floor((clean.length * 3) / 4);
  if (approxBytes > maxBytes) {
    return {
      ok: false,
      error: `image exceeds ${maxBytes} bytes (got ~${approxBytes})`,
    };
  }

  let bytes: Uint8Array;
  try {
    const binary = atob(clean);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return { ok: false, error: "base64 image data could not be decoded" };
  }

  if (bytes.length > maxBytes) {
    return { ok: false, error: `image exceeds ${maxBytes} bytes` };
  }

  const sniffed = sniffMime(bytes);
  if (!sniffed) {
    return { ok: false, error: "image bytes are not a recognized image format" };
  }
  if (sniffed !== mime) {
    return {
      ok: false,
      error: `declared content_type ${mime} does not match image bytes (${sniffed})`,
    };
  }

  return { ok: true, image: { bytes, mime: sniffed } };
}
