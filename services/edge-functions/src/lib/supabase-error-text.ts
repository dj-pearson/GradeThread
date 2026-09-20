// US-3436: what to print when a supabase-js call fails.
//
// MEASURED, not guessed. A storage `list()` against a URL with no Storage
// service resolves with a StorageApiError whose `message` is the literal
// string "{}" -- the response body, stringified -- while the useful part sits
// on `name` and `status`. So the obvious `${error.message}` prints
//
//     ! list failed at item-photos/: {}
//
// and an operator reading a diagnostic whose whole job is to report learns
// nothing. Found by running scripts/diagnose-missing-photo-objects.ts for the
// first time; it refused correctly and then could not say why.
//
// PostgREST errors are the opposite shape and already read well (message,
// details, hint, code), so this must not flatten those into something worse.

/** The fields supabase-js puts an explanation on, across its three clients. */
interface MaybeSupabaseError {
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  code?: unknown;
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
}

/** Is this message worth printing on its own? */
function useful(message: unknown): message is string {
  if (typeof message !== "string") return false;
  const m = message.trim();
  // "{}" is the stringified empty body a StorageApiError carries; "[object
  // Object]" is the other way a body reaches here with nothing in it.
  return m !== "" && m !== "{}" && m !== "[object Object]" && m !== "null";
}

/**
 * One line naming what went wrong, never empty.
 *
 * Prefers the message, falls back to the error's own name and HTTP status, and
 * appends a PostgREST code when there is one — those are what a person greps
 * for. Returns "unknown error" rather than "" so a log line never trails off.
 */
export function supabaseErrorText(error: unknown): string {
  if (error == null) return "unknown error";
  if (typeof error === "string") return useful(error) ? error : "unknown error";

  const e = error as MaybeSupabaseError;
  const parts: string[] = [];
  if (useful(e.message)) parts.push(e.message);

  const status = typeof e.status === "number"
    ? e.status
    : typeof e.statusCode === "number"
    ? e.statusCode
    : typeof e.statusCode === "string" && /^\d+$/.test(e.statusCode)
    ? Number(e.statusCode)
    : null;

  // Only when the message said nothing: a readable message plus "StorageApiError
  // 404" is noise, a bare "{}" is a dead end.
  if (parts.length === 0) {
    const name = typeof e.name === "string" && e.name ? e.name : "error";
    parts.push(status === null ? name : `${name} ${status}`);
  }

  if (typeof e.code === "string" && e.code) parts.push(`(${e.code})`);
  if (useful(e.details)) parts.push(`- ${e.details as string}`);
  return parts.join(" ");
}
