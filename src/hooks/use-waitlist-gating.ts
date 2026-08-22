import { useEffect, useState } from "react";

// US-2449: is the staged-launch gate on right now?
//
// The public waitlist form renders ONLY when this is true. That is the whole
// point of the hook: US-1949 removed every public waitlist CTA because a "join
// the waitlist" button standing next to a live "Start Grading Free" button
// reads as vaporware, and it was right to. A waitlist shown only while the gate
// is actually closed is not the same claim — it is the accurate one.
//
// Fail-CLOSED here, which is the opposite of the server gate's fail-open and
// deliberately so. The server must never lock the product out over a DB blip;
// the marketing site must never show a waitlist over a network blip. Both
// defaults point at "the product is open".

const STATUS_PATH = "/api/waitlist/status";

// Module-scoped so the answer is fetched once per page load no matter how many
// components ask. The flag itself is cached fleet-wide for 30s server-side.
let cached: boolean | null = null;
let inFlight: Promise<boolean> | null = null;

/**
 * Clears the module cache `useWaitlistGating` keeps.
 *
 * NOTHING CALLS THIS, and the reason is worth a line rather than a deletion.
 * The suite next door tests `readWaitlistGating`, the UNCACHED read, which is
 * where the fail-closed rule lives and where a regression would be
 * user-visible. The cached hook has no test at all, so nothing has ever needed
 * to reset it. Kept because writing that test is the fix, and this is the tool
 * it would need; the previous comment said "reset between tests" as though a
 * test already did.
 */
export function resetWaitlistGatingCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * One uncached read of the gate state. Exported so the fail-closed rule can be
 * tested without a React renderer (this repo has no renderHook harness).
 */
export async function readWaitlistGating(): Promise<boolean> {
  try {
    // Dynamic import keeps edge-fetch (-> supabase client) out of the landing
    // page's SSR/prerender module graph, which has no VITE_SUPABASE_* env.
    // Same reason WaitlistForm and NewsletterSignup do it.
    const { edgeFetch } = await import("@/lib/edge-fetch");
    const res = await edgeFetch(STATUS_PATH, { unauthenticated: true, silentGate: true });
    if (!res.ok) return false;
    const json = (await res.json()) as { gatingActive?: unknown };
    return json.gatingActive === true;
  } catch {
    return false;
  }
}

export function useWaitlistGating(): boolean {
  const [active, setActive] = useState<boolean>(cached ?? false);

  useEffect(() => {
    if (cached !== null) {
      setActive(cached);
      return;
    }
    let alive = true;
    inFlight ??= readWaitlistGating().then((v) => {
      cached = v;
      inFlight = null;
      return v;
    });
    void inFlight.then((v) => {
      if (alive) setActive(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  return active;
}
