// Web Storage that cannot take the app down with it.
//
// `localStorage` and `sessionStorage` are not "present or absent" — READING one
// can THROW. Chrome raises a SecurityError when the user has blocked site data
// for the origin, and in a cross-origin iframe whose storage access is
// partitioned or denied; Firefox and Safari do the same under their strict
// privacy modes. The property access itself throws, so `if (localStorage)` and
// `typeof localStorage !== "undefined"` are not guards.
//
// Why this file exists (US-3218): routes/lazy.tsx called
// `sessionStorage.removeItem(...)` inside the `.then()` of every lazy route
// import, to clear its stale-chunk flag on a successful load. Every route in
// this app is lazily loaded. So for a visitor whose browser blocks site data,
// that throw rejected the import promise for EVERY page — marketing pages,
// public certificates, the dashboard — and the `.catch()` recovery path touched
// sessionStorage too, so it threw on the way out as well. The whole product was
// an error boundary, on a setting the visitor chose and we never see.
//
// Rule: anything on a boot or route-critical path goes through this module.
// A feature that stores a dismissed banner may inline a try/catch instead; the
// distinction that matters is whether a throw costs the visitor a preference or
// the entire app.

function readStore(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Reads a key, or null if it is absent OR storage is unavailable. */
export function readStored(key: string, kind: "local" | "session" = "local"): string | null {
  try {
    return readStore(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Writes a key. Returns false when storage refused, so callers can branch. */
export function writeStored(
  key: string,
  value: string,
  kind: "local" | "session" = "local",
): boolean {
  try {
    const store = readStore(kind);
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    // Also the quota path: a full store throws QuotaExceededError on write.
    return false;
  }
}

/** Removes a key. Silent when storage is unavailable. */
export function removeStored(key: string, kind: "local" | "session" = "local"): void {
  try {
    readStore(kind)?.removeItem(key);
  } catch {
    // Nothing to do — the value we wanted gone is, by definition, not readable.
  }
}
