// US-2481: the pure half of the mobile→desktop extension work queue.
//
// Kept out of the route so the one rule that actually matters — the queue stores
// WHAT to do and never a way IN — is a unit-testable function rather than a
// paragraph in a handler. The same rule exists a third time as a CHECK
// constraint on extension_work_queue. Three copies sounds like duplication; it
// is not. Each catches a different failure: the constraint catches a future
// server path that forgets, this catches it early enough to say WHICH key was
// refused, and the test catches someone deleting either.
//
// The rule comes from vault/60-decisions/adr-no-server-side-marketplace-automation.md
// §3.1: GradeThread's servers never hold a marketplace password or session
// cookie for a no-API channel. A queue is exactly where that would erode — "we
// only need the cookie so the desktop can resume" is a sentence that ends with
// the cloud model this whole design refuses.

/**
 * The verbs the desktop extension can actually drain.
 *
 * `share` WAS here (US-2481) and was removed by US-2497, because the API was
 * accepting work nothing would ever run. A Poshmark share run is the US-2482
 * engagement pass, and that engine starts only against an active tab already on
 * the seller's own closet: the extension holds no Poshmark handle by design and
 * refuses to navigate to a URL that arrived in a message (US-1876). A background
 * drain has no such tab and nothing to build one from.
 *
 * The deciding reason is not the missing tab, which could be engineered around.
 * It is the fourth statement of the engagement clickwrap, which the seller has
 * to accept before any run: "GradeThread will stop and hand the tab back to me
 * if Poshmark asks for a human check." A run triggered from a phone has nobody
 * at the machine to hand it back to. Keeping the kind would mean either breaking
 * that promise or leaving a run stalled on a check while the seller's phone said
 * it was queued.
 *
 * So a share run stays a supervised action, started from the extension.
 */
// US-9202: `revise` carries a FlipDesk edit (price, title, description,
// photos) to a listing that is live on an extension channel. Like delist it
// names a listing the desktop opens; unlike delist it also carries which fields
// changed, and the values are read off the listing row when the job is built
// so a second edit before the drain never sends a stale number.
export const EXTENSION_QUEUE_KINDS = ["list", "delist", "revise"] as const;
export type ExtensionQueueKind = (typeof EXTENSION_QUEUE_KINDS)[number];

/**
 * Keys a queue payload may never carry, matched case-insensitively and
 * ignoring separators — so `session_cookie`, `sessionCookie` and `SESSION-COOKIE`
 * are all the same refusal. Mirrors the table's CHECK constraint.
 */
export const CREDENTIAL_KEYS = [
  "password",
  "passwd",
  "pass",
  "pwd",
  "cookie",
  "cookies",
  "sessioncookie",
  "session",
  "sessionid",
  "credential",
  "credentials",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "bearer",
  "csrf",
  "apikey",
  "secret",
] as const;

/** How long queued work stays runnable before it is reported as expired. */
export const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many jobs one tenant may have outstanding.
 *
 * Not an arbitrary number: without a cap, a seller queues a few hundred jobs
 * from their phone across a week, opens their laptop, and the extension starts
 * opening marketplace tabs it will not stop opening. Sixty is more than a real
 * week of sourcing and small enough to drain in one sitting.
 */
export const MAX_QUEUE_DEPTH = 60;

/** Bytes of JSON a payload may occupy. An instruction, not a document. */
const MAX_PAYLOAD_BYTES = 8 * 1024;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

function isCredentialKey(key: string): boolean {
  const k = normalizeKey(key);
  return (CREDENTIAL_KEYS as readonly string[]).some(
    (bad) => k === bad || k.endsWith(bad),
  );
}

export interface NormalizedPayload {
  value: Record<string, unknown>;
  /** The first refused key found, or null when the payload is clean. */
  rejectedKey: string | null;
}

/**
 * Validate and bound a queue payload.
 *
 * Walks NESTED objects, not just the top level: `{ auth: { cookie: "…" } }` is
 * the same leak wearing one more brace, and a top-level-only check is the kind
 * that passes review and fails in production.
 */
export function normalizeQueuePayload(input: unknown): NormalizedPayload {
  if (input == null) return { value: {}, rejectedKey: null };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { value: {}, rejectedKey: null };
  }

  const rejected = findCredentialKey(input as Record<string, unknown>, 0);
  if (rejected) return { value: {}, rejectedKey: rejected };

  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    // Circular or otherwise unserializable — not a payload, and not something to
    // try to salvage into one.
    return { value: {}, rejectedKey: null };
  }
  if (json.length > MAX_PAYLOAD_BYTES) {
    // Truncating a JSON document produces invalid JSON, and a "best effort"
    // partial instruction is worse than none: the extension would act on half a
    // job. Drop it and keep the row's ids, which are what the drain actually
    // needs.
    return { value: {}, rejectedKey: null };
  }
  return { value: input as Record<string, unknown>, rejectedKey: null };
}

function findCredentialKey(
  obj: Record<string, unknown>,
  depth: number,
): string | null {
  if (depth > 6) return null; // deeper than any real instruction goes
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialKey(key)) return key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = findCredentialKey(value as Record<string, unknown>, depth + 1);
      if (nested) return nested;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const nested = findCredentialKey(entry as Record<string, unknown>, depth + 1);
          if (nested) return nested;
        }
      }
    }
  }
  return null;
}

/** When a job queued at `nowMs` stops being runnable. */
export function planExpiry(nowMs: number): string {
  return new Date(nowMs + QUEUE_TTL_MS).toISOString();
}

/**
 * The sentence every client shows for a queued job.
 *
 * US-2481 AC7: a seller must never be told work completed that has not. The
 * string lives here so web, iOS and Android cannot each invent their own
 * cheerier version of it.
 */
export const QUEUED_NOTICE =
  "This runs the next time you open your desktop browser with the GradeThread " +
  "extension installed. Nothing happens on the marketplace until then.";

/**
 * US-2777: merge the seller's country domain into a queued job's payload.
 *
 * The DB read lives in the route; this is the decision, so it can be tested
 * without a database — the same split the rest of this file uses.
 *
 * `settings` is `flipdesk_settings.lister_locales` (00648): a platform ->
 * locale-KEY map, e.g. `{"vinted": "vinted.fr"}`. The value is a key the
 * extension resolves against its own bundled domain map, never a URL. That is
 * the US-1876 rule, and it is what makes a value that travels through the
 * database and three clients safe to act on.
 *
 * THREE REASONS IT RETURNS THE PAYLOAD UNTOUCHED, and each one is a real case:
 *  - The caller already named a locale. An explicit locale is a statement about
 *    THIS job; replacing it with an account default would make the field
 *    unusable for anything but the default, permanently.
 *  - No setting for this platform. Then the job names none, which is exactly
 *    what every client sends today, and the extension uses the platform
 *    default. Doing nothing has to stay the no-op.
 *  - The stored value is not a non-empty string. A null, a number or a nested
 *    object is a row somebody wrote by hand or an older shape; none of them is
 *    a locale, and coercing one into a key would ask the extension to resolve
 *    nonsense.
 *
 * A key the extension does not cover is passed THROUGH, deliberately. The
 * bundled map is the authority and it already refuses an uncovered domain by
 * name (US-2479 AC2). Filtering here would convert that loud refusal into a
 * silent fall back to the default domain, which is the precise failure US-2777
 * exists to end.
 */
export function withSellerLocale(
  payload: Record<string, unknown>,
  settings: unknown,
  platform: string,
): Record<string, unknown> {
  if (typeof payload.locale === "string" && payload.locale !== "") return payload;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return payload;
  }
  const locale = (settings as Record<string, unknown>)[platform];
  if (typeof locale !== "string" || locale === "") return payload;
  return { ...payload, locale };
}
