// US-3379: put a gated account on the waitlist it is being told it is on, and
// make a failure visible to the OPERATOR without ever showing it to the visitor.
//
// Extracted from src/pages/waitlist-pending.tsx, where the same call was a bare
// `void edgeFetch(...).catch(() => {})`. edgeFetch does not throw on a non-2xx
// (src/lib/edge-fetch.ts: "callers still inspect res.ok"), so a 500 produced no
// waitlist row, no exception, and no signal of any kind - while the page kept
// telling the visitor they were in the queue.
//
// ── What the visitor gets: nothing. Deliberately. ────────────────────────────
// The original comment was right about this half and it survives unchanged.
// They did not ask for this write, they cannot retry it, and an error on the
// page they were just redirected to is worse than useless. No toast, no state,
// no rendered difference. That is asserted by
// src/pages/__tests__/waitlist-pending-join.test.tsx.
//
// ── What the operator gets: a Sentry issue, at level error. ──────────────────
// captureMessage("waitlist join lost", tags { area: "waitlist.join" }), which
// lands in the app's Sentry project (the DSN in VITE_SENTRY_DSN) in the default
// `level:error` Issues view. Sentry is the right channel and not PostHog:
// PostHog's track() is a no-op until the visitor accepts the analytics cookie
// banner (src/lib/analytics.ts), and a gated visitor who never got past the
// waitlist page is exactly the person least likely to have accepted it. Sentry
// runs under legitimate interest with no consent gate.
//
// The payload carries the account's UUID and NOT the email address. That is the
// GDPR-minimising choice src/lib/sentry.ts already makes elsewhere, and a UUID
// is enough to name the row:
//
//   -- who signed up while the gate was closed and has no waitlist row
//   select u.id, u.email, u.created_at
//   from auth.users u
//   left join public.waitlist_entries w on lower(w.email) = lower(u.email)
//   where w.id is null
//   order by u.created_at desc;
//
// Anyone that query returns can be added from /admin/waitlist. The Sentry issue
// is the trigger to run it; the query is the recovery.
//
// ── The retry, and why it cannot double-write ────────────────────────────────
// POST /api/waitlist lowercases the email server-side and upserts with
// { onConflict: "email", ignoreDuplicates: true } against a column declared
// `email text not null unique` (00165_waitlist_gating.sql). So the duplicate is
// refused by the database as ON CONFLICT DO NOTHING, not by an application-level
// "check then insert" that could race. N identical POSTs produce at most one
// row, and an already-approved entry is never downgraded back to pending.
//
// Retries are bounded at 3 attempts, and only for the failures that a second
// attempt can actually fix: a thrown fetch (offline, DNS, the edge's documented
// "no available server" hang) and a 5xx. A 400 is a malformed email and will
// fail identically forever, so it signals immediately instead of burning the
// rate limiter - which is 10 POSTs per 60s per client, fail-closed
// (services/edge-functions/src/main.ts).
import { captureMessage } from "@/lib/sentry";
import { edgeFetch } from "@/lib/edge-fetch";

const MAX_ATTEMPTS = 3;
/** Backoff before attempt 2 and attempt 3. Total worst case: ~8s. */
const RETRY_DELAY_MS = [2_000, 6_000];

// One sequence per email per page load. The page's effect depends on both the
// email and the profile name, and the name arrives a beat after the user does,
// so without this a single visit fires the write twice - harmless at the DB but
// it would double the rate-limit spend and raise two Sentry issues for one
// visitor.
const started = new Set<string>();

export interface WaitlistJoinInput {
  email: string;
  fullName?: string | null;
  /** Supabase account id. Goes to Sentry so a lost join can be named. */
  userId?: string | null;
  source?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fire-and-forget: add this account to waitlist_entries. Never throws, never
 * renders, never toasts. Returns immediately; the work continues in the
 * background and reports only to Sentry.
 */
export function joinWaitlistOnce(input: WaitlistJoinInput): void {
  const email = input.email?.trim().toLowerCase() ?? "";
  if (!email) return;
  if (started.has(email)) return;
  started.add(email);
  void attemptJoin({ ...input, email });
}

async function attemptJoin(input: WaitlistJoinInput & { email: string }): Promise<void> {
  let lastStatus: number | null = null;
  let lastError: string | null = null;
  let used = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    used = attempt;
    try {
      const res = await edgeFetch("/api/waitlist", {
        method: "POST",
        unauthenticated: true,
        silentGate: true,
        json: {
          email: input.email,
          full_name: input.fullName || undefined,
          source: input.source ?? "signup-gated",
        },
      });
      if (res.ok) return;
      lastStatus = res.status;
      lastError = null;
      // 4xx is terminal: the request is wrong, not the moment.
      if (res.status < 500) break;
    } catch (e) {
      lastStatus = null;
      lastError = e instanceof Error ? e.message : String(e);
    }

    const delay = RETRY_DELAY_MS[attempt - 1];
    if (attempt < MAX_ATTEMPTS && delay !== undefined) {
      await sleep(delay);
    }
  }

  captureMessage("waitlist join lost", {
    level: "error",
    tags: { area: "waitlist.join" },
    extra: {
      // No email: see the GDPR note at the top. The UUID names the row.
      userId: input.userId ?? "unknown",
      source: input.source ?? "signup-gated",
      status: lastStatus,
      networkError: lastError,
      attempts: used,
    },
  });
}
