// Standardized edge error responses (US-359).
//
// Every error returned to a client must be a consistent, SAFE shape:
//   { error: string, code?: string }
// — never raw DB/provider text (which can disclose schema, internal hostnames,
// SQL, or PII). Use these helpers instead of `c.json({ error: dbErr.message })`.
//
//   jsonError(c, 404, "Suggestion not found")            // simple
//   jsonError(c, 402, "Plan required", "FEATURE_LOCKED") // with a code
//   failSafe(c, 500, "Couldn't load suggestions", err, "repricing.list")
//     → logs `[repricing.list] <redacted raw error>` server-side and returns
//       a generic 500 to the client.
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status.ts";
import { redactError } from "./log-redact.ts";

export interface ErrorBody {
  error: string;
  code?: string;
}

export function jsonError(
  c: Context,
  status: StatusCode,
  message: string,
  code?: string,
): Response {
  const body: ErrorBody = code ? { error: message, code } : { error: message };
  return c.json(body, status);
}

// Log the raw cause server-side (redacted) under a stable tag, return a generic
// client-safe message. The raw text NEVER reaches the response body.
export function failSafe(
  c: Context,
  status: StatusCode,
  clientMessage: string,
  cause: unknown,
  logTag: string,
  code?: string,
): Response {
  console.error(`[${logTag}] ${redactError(cause)}`);
  return jsonError(c, status, clientMessage, code);
}
