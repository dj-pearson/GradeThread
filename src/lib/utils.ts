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

// Human-readable message for any thrown value. Critically, supabase-js rejects
// with a PostgrestError — a PLAIN OBJECT { code, message, details, hint }, NOT an
// Error instance — so `err instanceof Error ? err.message : String(err)` renders
// it as the useless "[object Object]". This coalesces message/details/hint (and
// appends the SQLSTATE code) so DB failures surface something actionable.
export function errorMessage(err: unknown): string {
  if (err == null) return "Unknown error"
  if (typeof err === "string") return err
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "object") {
    const e = err as {
      message?: unknown
      details?: unknown
      hint?: unknown
      code?: unknown
    }
    const parts = [e.message, e.details, e.hint].filter(
      (p): p is string => typeof p === "string" && p.trim() !== "",
    )
    if (parts.length > 0) {
      const base = parts.join(" — ")
      return typeof e.code === "string" && e.code
        ? `${base} (${e.code})`
        : base
    }
    try {
      const json = JSON.stringify(err)
      if (json && json !== "{}") return json
    } catch {
      // fall through to String()
    }
  }
  return String(err)
}
