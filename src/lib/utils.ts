import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Convert a stored ISO timestamp to the value an <input type="datetime-local">
// expects (local "YYYY-MM-DDTHH:mm"). Returns "" for null/invalid.
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Inverse of isoToLocalInput: a datetime-local value → ISO string, or null.
export function localInputToIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// One sentence for "the request never got an answer at all". It deliberately
// names no host, port or service: the seller cannot act on which box was down,
// and printing it hands our internal topology to anyone whose wifi drops.
//
// Byte-identical to AUTH_NETWORK_ERROR_MESSAGE in auth-error.ts, and a test
// asserts they stay that way. They are two constants rather than one import
// because every component pulls utils.ts in for cn(), so importing the auth
// module here would drag it into the entry chunk (US-417 bundle budget).
export const UNREACHABLE_MESSAGE =
  "We couldn't reach the server. Check your connection and try again."

const GENERIC_FAILURE_MESSAGE = "Something went wrong. Please try again."

// A request that never got an HTTP answer — the service is down, busy behind a
// gateway, or the device is offline. None of those are worth a technical
// sentence; all of them are worth "try again".
//
// supabase-js is why the check has to look at text and not just the type: when a
// request never lands, postgrest-js resolves with a PLAIN OBJECT whose message
// is `"TypeError: Failed to fetch"` — the TypeError itself is already gone.
function isTransportFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true
  const e = (err ?? {}) as { message?: unknown; name?: unknown; status?: unknown }
  const status = typeof e.status === "number" ? e.status : undefined
  if (status === 0 || status === 502 || status === 503 || status === 504) return true
  if (e.name === "AuthRetryableFetchError") return true
  const text = typeof e.message === "string" ? e.message.toLowerCase() : ""
  return (
    text.includes("failed to fetch") ||
    text.includes("fetcherror") ||
    text.includes("networkerror") ||
    text.includes("network request failed") ||
    text.includes("load failed")
  )
}

// `    at https://…/assets/index-abc.js:1:2345` — a browser stack trace.
//
// This is not hypothetical tidying. On a failed request postgrest-js sets
// `details` to the WHOLE stack trace, and this function used to join
// message + details straight into the toast, so a composer save during an
// outage printed a stack (URLs included) over the seller's screen.
function looksLikeStackTrace(text: string): boolean {
  return /\n\s+at\s/.test(text) || /^\s*at\s+\S+:\d+:\d+/m.test(text)
}

// Last line of defence: no absolute URL and no *.gradethread.com host survives
// into anything a user reads, whatever produced it. Cheaper to enforce here once
// than to audit every future error path for what it happens to interpolate.
const URL_OR_INTERNAL_HOST =
  /https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+gradethread\.com(?::\d+)?/gi

function presentable(text: string): string {
  const clean = text
    .replace(URL_OR_INTERNAL_HOST, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    // Strip punctuation left dangling where a URL used to be ("failed at :").
    .replace(/[([{\s:—-]+$/, "")
    .trim()
  return clean || GENERIC_FAILURE_MESSAGE
}

// Human-readable message for any thrown value. Critically, supabase-js rejects
// with a PostgrestError — a PLAIN OBJECT { code, message, details, hint }, NOT an
// Error instance — so `err instanceof Error ? err.message : String(err)` renders
// it as the useless "[object Object]". This coalesces message/details/hint (and
// appends the SQLSTATE code) so DB failures surface something actionable.
//
// What it will NOT surface: a transport failure's internals, a stack trace, or
// any URL/internal hostname. A seller reading a toast can act on "try again" and
// on "title is required"; they can do nothing with an address of ours.
export function errorMessage(err: unknown): string {
  if (err == null) return "Unknown error"
  if (isTransportFailure(err)) return UNREACHABLE_MESSAGE
  if (typeof err === "string") return presentable(err)
  if (err instanceof Error && err.message) return presentable(err.message)
  if (typeof err === "object") {
    const e = err as {
      message?: unknown
      details?: unknown
      hint?: unknown
      code?: unknown
    }
    const parts = [e.message, e.details, e.hint].filter(
      (p): p is string =>
        typeof p === "string" && p.trim() !== "" && !looksLikeStackTrace(p),
    )
    if (parts.length > 0) {
      const base = parts.join(" — ")
      return presentable(
        typeof e.code === "string" && e.code ? `${base} (${e.code})` : base,
      )
    }
    // No readable field. A JSON dump of the raw object used to go out here,
    // which is how request URLs and internal ids reached the screen.
    return GENERIC_FAILURE_MESSAGE
  }
  return presentable(String(err))
}
