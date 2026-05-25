// Resolves the base URL for the Coolify-hosted Hono edge service.
//
// Order of resolution:
//   1. VITE_EDGE_API_URL if set (trimmed of any trailing slash).
//   2. Derived from VITE_SUPABASE_URL by swapping the `api.` subdomain to
//      `functions.` — i.e. `https://api.gradethread.com` → `https://functions.gradethread.com`.
//      This matches the Pearson Media DNS layout: Supabase Kong on `api.*`,
//      the Hono edge service on `functions.*`.
//   3. Throws — the app cannot call edge endpoints without one of the above.
//
// The previous fallback appended `/functions/v1` to the Supabase URL, which
// routed every request through Supabase Kong + edge-runtime and produced
// spurious 503s. We never deployed actual Supabase Edge Functions.

const RAW = import.meta.env.VITE_EDGE_API_URL?.trim();
const SUPABASE = import.meta.env.VITE_SUPABASE_URL?.trim();

function deriveFromSupabase(): string | null {
  if (!SUPABASE) return null;
  try {
    const url = new URL(SUPABASE);
    if (url.hostname.startsWith("api.")) {
      url.hostname = "functions." + url.hostname.slice(4);
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    /* malformed URL — fall through */
  }
  return null;
}

let cached: string | null | undefined;

export function edgeApiUrl(): string {
  if (cached === undefined) {
    const explicit = RAW ? RAW.replace(/\/$/, "") : null;
    cached = explicit || deriveFromSupabase();
  }
  if (!cached) {
    throw new Error(
      "Edge API URL is not configured. Set VITE_EDGE_API_URL in Cloudflare Pages (Production), or use a VITE_SUPABASE_URL whose host starts with `api.`."
    );
  }
  return cached;
}
