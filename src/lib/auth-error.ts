// Shared auth error handling (US-1432, US-1436).
//
// Two concerns live here so the login/signup forms, the OAuth callback, and the
// password-reset flow all read auth failures the same way:
//   • readAuthError()      — pull a provider error out of the URL (query OR hash)
//   • classifyAuthFailure() — bucket a thrown sign-in/sign-up error so the UI can
//                             distinguish "rate limited" and "offline" from a
//                             genuine credential failure, instead of collapsing
//                             every failure into one generic message.

/** Distinct, enumeration-safe messages for the non-credential failure buckets. */
export const AUTH_RATE_LIMIT_MESSAGE =
  "Too many attempts. Please wait a minute and try again.";
export const AUTH_NETWORK_ERROR_MESSAGE =
  "We couldn't reach the server. Check your connection and try again.";

export type AuthFailureKind = "rate_limit" | "network" | "credentials";

/**
 * Bucket a thrown auth error. Supabase surfaces GoTrue failures as AuthError
 * (with numeric `status` + string `code`); fetch-level failures arrive as a
 * TypeError or an AuthRetryableFetchError with no real HTTP status. Neither
 * "rate limited" nor "offline" is a credential problem, so they must not read as
 * "check your password" (US-1432). Default to "credentials" for genuine 400/401.
 */
export function classifyAuthFailure(err: unknown): AuthFailureKind {
  const e = (err ?? {}) as {
    status?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = typeof e.code === "string" ? e.code.toLowerCase() : "";
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";

  // Rate limited: GoTrue returns 429 and/or an explicit over_*_rate_limit code.
  if (
    status === 429 ||
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit" ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  ) {
    return "rate_limit";
  }

  // Network / timeout: a request that never got an HTTP answer. fetch rejects
  // with a TypeError; supabase-js wraps retryable transport failures as
  // AuthRetryableFetchError (status 0 or a gateway 5xx).
  if (
    err instanceof TypeError ||
    name === "AuthRetryableFetchError" ||
    status === 0 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("load failed") ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return "network";
  }

  return "credentials";
}

/**
 * OAuth/recovery errors can arrive as query params OR in the URL hash fragment
 * (implicit flow). Read both. (Moved here from auth-callback.tsx so the
 * password-reset flow can reuse it — US-1436 AC3.)
 */
export function readAuthError(): { error: string; description: string | null } | null {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const error = query.get("error") ?? hash.get("error");
  if (!error) return null;
  const description =
    query.get("error_description") ?? hash.get("error_description");
  return { error, description };
}
