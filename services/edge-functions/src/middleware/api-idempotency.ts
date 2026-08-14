// US-2563: Idempotency-Key handling for the public API.
//
// WHY THIS IS MIDDLEWARE AND NOT ANOTHER KEY THREADED INTO runPaymentPrecedence.
// Two derived keys already exist and both are correct for what they guard:
// routes/grade.ts passes `grade_pay:<submissionId>` (US-2298) and
// lib/grading-batch-worker.ts passes `grade-batch-job:<jobId>` (US-2289). Neither
// can catch an HTTP retry, and not by oversight — by construction. By the time
// either key exists, the retry has already created a SECOND submission (or a
// second batch of N jobs) to derive its key from, so the two calls key
// differently and both charge.
//
// The unit that has to be deduplicated is the REQUEST. Nothing in the service
// modelled one. At $2-3 a garment, a load-balancer timeout on POST /grades/batch
// with 100 garments is 100 duplicate charges from a single retry.
//
// The contract is Stripe's, deliberately, so no integrator has to learn a new
// one:
//   • no header                  → pass through unchanged
//   • key, first time            → run the handler, store status + body
//   • key, same body, completed  → replay the stored response, handler never runs
//   • key, same body, in flight  → 409 + Retry-After
//   • key, different body        → 422
//
// GET and HEAD are untouched. They change nothing, and a replay would only serve
// a stale read.

import { createMiddleware } from "hono/factory";

// The service-role client is imported LAZILY, inside the request path, so this
// module stays import-safe for the unit tests that only exercise the pure
// decision table — lib/supabase.ts throws at import time when SUPABASE_URL is
// unset. Same idiom as middleware/rate-limit.ts and lib/grade-refund.ts.
async function admin() {
  const { supabaseAdmin } = await import("../lib/supabase.ts");
  return supabaseAdmin;
}

type IdempotencyEnv = {
  Variables: {
    userId: string;
    apiKeyId: string;
  };
};

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// How long an 'in_progress' claim is honoured before a retry may take it over.
// Must exceed the slowest handler this covers: POST /grades uploads images and
// runs payment precedence inline, while the batch endpoint answers 202 straight
// away. 120s clears both and is far under any sane client retry budget, so a
// container that died mid-handler does not lock a key out for the full retention
// window.
export const IN_FLIGHT_TTL_MS = 120_000;

// Endpoints where a MISSING key is itself a problem once clients have had a
// window to adopt one. Advisory by default so this ships without breaking live
// integrations; API_IDEMPOTENCY_REQUIRED=true enforces it.
const CHARGING_ENDPOINTS = new Set([
  "POST /api/v1/grades",
  "POST /api/v1/grades/batch",
]);

const MAX_KEY_LENGTH = 255;

function requireKeyOnChargingRoutes(): boolean {
  return Deno.env.get("API_IDEMPOTENCY_REQUIRED") === "true";
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function apiError(message: string, code: string) {
  return { data: null, error: { message, code, details: [] }, meta: null };
}

interface ExistingRecord {
  id: string;
  request_fingerprint: string;
  state: string;
  response_status: number | null;
  response_body: unknown;
  created_at: string;
}

/**
 * What to do with a key that is already claimed. Pure, so the branch table is
 * testable without a database — the four outcomes are the whole contract, and
 * three of them only happen under concurrency or client error.
 */
export type ClaimDecision =
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict" }
  | { kind: "fingerprint_mismatch" }
  | { kind: "takeover" };

export function decideOnExistingClaim(
  existing: Pick<ExistingRecord, "request_fingerprint" | "state" | "response_status" | "response_body" | "created_at">,
  fingerprint: string,
  now: number,
  ttlMs: number = IN_FLIGHT_TTL_MS,
): ClaimDecision {
  // Fingerprint FIRST. A client that recycled a key across two different
  // garments must be told, not quietly handed the first garment's grade — that
  // is a worse failure than the double charge this middleware prevents, because
  // it is wrong rather than merely expensive.
  if (existing.request_fingerprint !== fingerprint) return { kind: "fingerprint_mismatch" };
  if (existing.state === "completed") {
    return {
      kind: "replay",
      status: existing.response_status ?? 200,
      body: existing.response_body,
    };
  }
  const ageMs = now - new Date(existing.created_at).getTime();
  // NaN (an unparseable timestamp) must not read as "stale" and hand two callers
  // the same claim, so the comparison is written to fail closed.
  return ageMs < ttlMs || Number.isNaN(ageMs) ? { kind: "conflict" } : { kind: "takeover" };
}

export const apiIdempotencyMiddleware = createMiddleware<IdempotencyEnv>(
  async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (!MUTATING.has(method)) return await next();

    const endpoint = `${method} ${new URL(c.req.url).pathname}`;
    const rawKey = c.req.header("Idempotency-Key")?.trim() ?? "";

    if (!rawKey) {
      if (requireKeyOnChargingRoutes() && CHARGING_ENDPOINTS.has(endpoint)) {
        return c.json(
          apiError(
            "This endpoint charges per garment and requires an Idempotency-Key header " +
              "(any unique string — a UUID is fine — reused verbatim on every retry).",
            "IDEMPOTENCY_KEY_REQUIRED",
          ),
          400,
        );
      }
      if (CHARGING_ENDPOINTS.has(endpoint)) {
        console.warn(
          `[idempotency] ${endpoint} called without Idempotency-Key by ` +
            `user=${c.get("userId")} key=${c.get("apiKeyId") ?? "?"} — a retry of ` +
            `this request will charge again.`,
        );
      }
      return await next();
    }

    if (rawKey.length > MAX_KEY_LENGTH) {
      return c.json(
        apiError(
          `Idempotency-Key must be ${MAX_KEY_LENGTH} characters or fewer.`,
          "IDEMPOTENCY_KEY_INVALID",
        ),
        400,
      );
    }

    const userId = c.get("userId");

    // Clone the raw Request rather than calling c.req.text(): Hono caches its own
    // parsed body, and consuming the stream here would hand the handler an empty
    // body on some runtimes. A clone is cheap and total.
    let fingerprint: string;
    try {
      fingerprint = await sha256Hex(await c.req.raw.clone().text());
    } catch {
      // An unreadable body fails in the handler anyway; don't mask it here with
      // an idempotency error that points at the wrong thing.
      return await next();
    }

    const db = await admin();

    const release = async () => {
      await db
        .from("api_idempotency_records")
        .delete()
        .eq("owner_user_id", userId)
        .eq("endpoint", endpoint)
        .eq("idempotency_key", rawKey)
        .eq("state", "in_progress");
    };

    // ── Claim ──────────────────────────────────────────────────────────────
    // INSERT first and read on 23505, never SELECT-then-INSERT: two concurrent
    // retries must not both conclude they are the first, and only the unique
    // index can decide that.
    const { error: claimErr } = await db
      .from("api_idempotency_records")
      .insert({
        owner_user_id: userId,
        api_key_id: c.get("apiKeyId") ?? null,
        endpoint,
        idempotency_key: rawKey,
        request_fingerprint: fingerprint,
        state: "in_progress",
      });

    if (claimErr && (claimErr as { code?: string }).code !== "23505") {
      // A broken idempotency store must not silently degrade into the
      // double-charging behaviour this exists to prevent. 503 is honest: the
      // request has not run, and retrying with the same key is safe.
      console.error("[idempotency] claim failed:", claimErr.message);
      return c.json(
        apiError(
          "Request could not be processed safely right now. Retry with the same Idempotency-Key.",
          "IDEMPOTENCY_UNAVAILABLE",
        ),
        503,
      );
    }

    if (claimErr) {
      const { data } = await db
        .from("api_idempotency_records")
        .select("id, request_fingerprint, state, response_status, response_body, created_at")
        .eq("owner_user_id", userId)
        .eq("endpoint", endpoint)
        .eq("idempotency_key", rawKey)
        .maybeSingle();
      const existing = data as ExistingRecord | null;

      if (!existing) {
        // Raced with the prune job between the conflict and the read. Treat it as
        // a fresh request rather than failing a legitimate call over a row that
        // no longer exists.
        return await next();
      }

      const decision = decideOnExistingClaim(existing, fingerprint, Date.now());
      if (decision.kind === "fingerprint_mismatch") {
        return c.json(
          apiError(
            "This Idempotency-Key was already used with a different request body. " +
              "Use a new key for a new request.",
            "IDEMPOTENCY_KEY_REUSED",
          ),
          422,
        );
      }
      if (decision.kind === "replay") {
        c.header("Idempotent-Replay", "true");
        return c.json(
          decision.body as Record<string, unknown>,
          decision.status as 200,
        );
      }
      if (decision.kind === "conflict") {
        c.header("Retry-After", "5");
        return c.json(
          apiError(
            "A request with this Idempotency-Key is still being processed. Retry shortly.",
            "IDEMPOTENCY_IN_PROGRESS",
          ),
          409,
        );
      }
      // takeover — the previous claim is stale (a container died mid-handler).
      // Re-stamp it so THIS attempt owns the TTL, and so a third caller arriving
      // now sees a live claim rather than also taking it over.
      await db
        .from("api_idempotency_records")
        .update({ created_at: new Date().toISOString(), request_fingerprint: fingerprint })
        .eq("id", existing.id)
        .eq("state", "in_progress");
    }

    // ── Run the handler ────────────────────────────────────────────────────
    try {
      await next();
    } catch (err) {
      // Release, so the client's retry is a real attempt rather than a 409
      // against a request that produced nothing.
      await release();
      throw err;
    }

    const status = c.res.status;

    // Only SUCCESS is replayable. A 4xx should re-validate and a 5xx should
    // genuinely retry, so both release the claim. Storing them would turn a
    // transient failure into a permanent one for the life of the key.
    if (status < 200 || status >= 300) {
      await release();
      return;
    }

    let body: unknown = null;
    try {
      body = await c.res.clone().json();
    } catch {
      body = null; // non-JSON success; stored as null rather than guessed at.
    }

    const { error: finalizeErr } = await db
      .from("api_idempotency_records")
      .update({
        state: "completed",
        response_status: status,
        response_body: body,
        completed_at: new Date().toISOString(),
      })
      .eq("owner_user_id", userId)
      .eq("endpoint", endpoint)
      .eq("idempotency_key", rawKey);

    if (finalizeErr) {
      // The work is done and the client is getting its 2xx, so this cannot fail
      // the request. It IS worth a loud line: a retry will now find a stale
      // in_progress row, wait out the TTL, take it over and re-run — which
      // charges again, which is the exact outcome this middleware exists to stop.
      console.error(
        `[idempotency] FAILED to record completed response for ${endpoint} ` +
          `user=${userId} key=${rawKey}: ${finalizeErr.message}`,
      );
    }
  },
);
