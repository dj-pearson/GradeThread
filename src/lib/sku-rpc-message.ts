// US-3417: the database's own words, on their way to the seller.
//
// WHY THIS IS NOT `toastError`. The house error path (src/lib/toast-error.tsx)
// runs a string through `friendlyError`, which classifies a SQLSTATE into a
// generic what-happened / what-it-means / what-to-do triple. That is the right
// call almost everywhere, because a database sentence is usually written for a
// DBA.
//
// These ones are not. `flipdesk_sku_validate` (migration 00804) returns
// sentences written for a seller to read and act on -- "A number with no
// leading zeros has to be last, or be followed by text that does not start with
// a digit" -- and there is no generic wording that improves on that. Rewording
// them here would also give one rule two phrasings, which is how somebody ends
// up unable to act on either.
//
// So: pass it through, and only invent a sentence when there is genuinely
// nothing to pass.

/** Pull the human message out of a PostgREST error, whatever shape it took. */
export function rpcMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown; hint?: unknown };
    for (const field of [e.message, e.details, e.hint]) {
      if (typeof field === "string" && field.trim()) return field;
    }
  }
  return "Something went wrong saving your SKU settings.";
}
