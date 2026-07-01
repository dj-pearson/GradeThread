import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables");
}

// US-1460: "Keep me signed in" (default) persists the session to localStorage —
// the prior behavior. Unchecking it ("shared device") scopes the session to
// sessionStorage so it's dropped when the browser/tab closes. The preference is
// a tiny localStorage flag the storage adapter honors on every read/write, so it
// survives reloads and applies across the whole auth lifecycle. All access is
// try/caught so it's a no-op under SSR/prerender (no localStorage) and never
// throws.
const KEEP_SIGNED_IN_KEY = "gt.keep_signed_in";

/** Call BEFORE sign-in: false routes this session to sessionStorage. */
export function setKeepSignedIn(keep: boolean): void {
  try {
    if (keep) localStorage.removeItem(KEEP_SIGNED_IN_KEY);
    else localStorage.setItem(KEEP_SIGNED_IN_KEY, "0");
  } catch {
    /* storage unavailable — default (persistent) applies */
  }
}

function sessionScoped(): boolean {
  try {
    return localStorage.getItem(KEEP_SIGNED_IN_KEY) === "0";
  } catch {
    return false;
  }
}

const hybridStorage = {
  getItem(key: string): string | null {
    try {
      const primary = sessionScoped() ? sessionStorage : localStorage;
      const secondary = sessionScoped() ? localStorage : sessionStorage;
      // Fall back to the other store so an in-flight session isn't lost if the
      // preference flips between writes.
      return primary.getItem(key) ?? secondary.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      if (sessionScoped()) {
        sessionStorage.setItem(key, value);
        // Don't leave a persistent copy behind on a shared device.
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
        sessionStorage.removeItem(key);
      }
    } catch {
      /* ignore */
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    flowType: "pkce",
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage: hybridStorage,
  },
});
