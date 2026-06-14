// US-890: temporary per-user rate-limit overrides — the limiter's read path +
// the admin write helpers' validation.
//
// `rate_limit_overrides` (migration 00214) holds at most one active override per
// user. The rate limiter consults it on EVERY request for a user subject, so the
// read MUST be cheap: this module serves it from a short-TTL in-process cache that
// holds ALL currently-active overrides (an admin tool — there are never many), one
// small query per cache window rather than a per-request lookup. Mirrors the
// system-settings registry's caching contract:
//   • getRateLimitOverrideSync() never blocks the hot path and never throws;
//   • a write busts the cache so an override lands on the next request;
//   • an EXPIRED override is ignored at read time (the load query filters by
//     expires_at AND the sync getter re-checks expiry), so no cleanup job is
//     needed to stop an override past its window (AC3).
//
// supabase is imported LAZILY (dynamic import inside the async refresh) so this
// module — pulled in by the rate-limit middleware — stays import-safe in test/CI
// runs that don't configure a database, exactly like the limiter's default
// incrementer.

export type RateLimitOverrideMode = "multiplier" | "cap" | "block";

export interface RateLimitOverride {
  subjectUserId: string;
  mode: RateLimitOverrideMode;
  multiplier: number | null;
  cap: number | null;
  reason: string;
  expiresAt: string; // ISO 8601
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OverrideRow {
  subject_user_id: string;
  mode: RateLimitOverrideMode;
  multiplier: number | null;
  cap: number | null;
  reason: string;
  expires_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToOverride(r: OverrideRow): RateLimitOverride {
  return {
    subjectUserId: r.subject_user_id,
    mode: r.mode,
    multiplier: r.multiplier === null ? null : Number(r.multiplier),
    cap: r.cap === null ? null : Number(r.cap),
    reason: r.reason,
    expiresAt: r.expires_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Short TTL — long enough to spare the DB on the limiter hot path, short enough
// that a write on another replica (which busts only its own cache) still lands
// within the window.
const TTL_MS = 30_000;

interface CacheSnapshot {
  byUser: Map<string, RateLimitOverride>;
  expiresAt: number;
}
let cache: CacheSnapshot | null = null;
let refreshing = false;

// Only the production call path touches Supabase; in test/CI without a database
// configured we skip the refresh so the limiter's override hook is simply inert
// (no override) rather than logging a connect failure on every request.
function dbConfigured(): boolean {
  return !!Deno.env.get("SUPABASE_URL");
}

async function loadActiveOverrides(): Promise<Map<string, RateLimitOverride>> {
  const { supabaseAdmin } = await import("./supabase.ts");
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("rate_limit_overrides")
    .select(
      "subject_user_id, mode, multiplier, cap, reason, expires_at, created_by, created_at, updated_at",
    )
    .gt("expires_at", nowIso);
  if (error) throw error;
  const map = new Map<string, RateLimitOverride>();
  for (const r of (data ?? []) as OverrideRow[]) {
    map.set(r.subject_user_id, rowToOverride(r));
  }
  return map;
}

// Refresh the cached snapshot of active overrides. Best-effort: on a DB error we
// keep the prior (possibly stale) snapshot rather than dropping all overrides —
// never throw on the limiter's behalf.
export async function refreshOverrideCache(): Promise<void> {
  try {
    const byUser = await loadActiveOverrides();
    cache = { byUser, expiresAt: Date.now() + TTL_MS };
  } catch (err) {
    console.error(
      "[rate-limit-overrides] refresh failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Synchronous getter for the limiter hot path. Returns the active override for a
// user (or null), firing a non-blocking background refresh when the snapshot is
// cold or stale. Double-checks expiry against the wall clock so a cached entry
// that lapsed since the snapshot is ignored without waiting for the next refresh.
export function getRateLimitOverrideSync(
  subjectUserId: string,
): RateLimitOverride | null {
  if ((!cache || cache.expiresAt <= Date.now()) && dbConfigured() && !refreshing) {
    refreshing = true;
    void refreshOverrideCache().finally(() => {
      refreshing = false;
    });
  }
  const ov = cache?.byUser.get(subjectUserId) ?? null;
  if (!ov) return null;
  if (Date.parse(ov.expiresAt) <= Date.now()) return null; // expired since snapshot
  return ov;
}

// Drop the cached snapshot so the next read re-fetches. Called by the admin
// set/clear handlers right after a successful write.
export function bustOverrideCache(): void {
  cache = null;
}

// TEST SEAM: seed the in-process cache directly so the limiter's override hook can
// be exercised without a database. Not used by production code.
export function __setOverrideCacheForTest(
  overrides: RateLimitOverride[] | null,
): void {
  if (overrides === null) {
    cache = null;
    return;
  }
  const byUser = new Map<string, RateLimitOverride>();
  for (const o of overrides) byUser.set(o.subjectUserId, o);
  cache = { byUser, expiresAt: Date.now() + TTL_MS };
}

// ── Pure helpers (validation + application) — shared by the route + tests ──────

// Apply a non-block override to a base limit. `multiplier` scales the base (can
// raise or lower it); `cap` pins an absolute ceiling. A block is handled by the
// caller (deny outright), never here, so this only ever returns a number.
export function applyRateLimitOverride(
  baseLimit: number,
  override: RateLimitOverride,
): number {
  if (override.mode === "cap" && typeof override.cap === "number") {
    return Math.max(0, Math.floor(override.cap));
  }
  if (override.mode === "multiplier" && typeof override.multiplier === "number") {
    return Math.max(0, Math.floor(baseLimit * override.multiplier));
  }
  return baseLimit;
}

export interface OverrideBounds {
  maxMultiplier: number;
  maxDurationMinutes: number;
}

export interface NormalizedOverride {
  mode: RateLimitOverrideMode;
  multiplier: number | null;
  cap: number | null;
  reason: string;
  expiresAt: string; // ISO
}

// Validate + normalize a raw override request body against the registry-driven
// bounds. Pure (now is injected) so the route handler and unit tests share one
// source of truth. Returns the normalized override or a human-readable error.
export function validateOverrideInput(
  raw: unknown,
  bounds: OverrideBounds,
  nowMs: number,
): { ok: true; value: NormalizedOverride } | { ok: false; error: string } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const mode = body.mode;
  if (mode !== "multiplier" && mode !== "cap" && mode !== "block") {
    return { ok: false, error: "`mode` must be one of multiplier|cap|block." };
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return { ok: false, error: "A reason is required." };

  const minutes = Number(body.expiresInMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, error: "`expiresInMinutes` must be a positive number." };
  }
  if (minutes > bounds.maxDurationMinutes) {
    return {
      ok: false,
      error: `Duration exceeds the maximum of ${bounds.maxDurationMinutes} minutes.`,
    };
  }
  const expiresAt = new Date(nowMs + minutes * 60_000).toISOString();

  let multiplier: number | null = null;
  let cap: number | null = null;

  if (mode === "multiplier") {
    const m = Number(body.multiplier);
    if (!Number.isFinite(m) || m < 0) {
      return { ok: false, error: "`multiplier` must be a number >= 0." };
    }
    if (m > bounds.maxMultiplier) {
      return {
        ok: false,
        error: `Multiplier exceeds the maximum of ${bounds.maxMultiplier}.`,
      };
    }
    multiplier = m;
  } else if (mode === "cap") {
    const cRaw = Number(body.cap);
    if (!Number.isFinite(cRaw) || cRaw < 0) {
      return { ok: false, error: "`cap` must be a number >= 0." };
    }
    cap = Math.floor(cRaw);
  }

  return { ok: true, value: { mode, multiplier, cap, reason, expiresAt } };
}
