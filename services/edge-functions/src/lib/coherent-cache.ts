// US-571: cross-replica cache coherence.
//
// ↳ The GENERAL rule this file is an instance of — "the edge runs N replicas,
//   therefore a module-level cache is a correctness bug" — is stated once in
//   vault/10-ops/edge-runtime-invariants.md. Read that before adding a cache
//   anywhere in the edge service.
//
// The edge service runs as multiple replicas (US-501). Several module-level
// caches were per-process, which broke once we scaled out:
//   - eBay app token (client_credentials) + GSC service-account token: each
//     replica minted its OWN, so N replicas = N× the token minting — quota /
//     rate pressure and needless churn on shared credentials.
//   - The eval-gated grading-prompt cache served a STALE prompt for up to its
//     TTL after an activation. A freshly activated prompt version (the gate is
//     defended by migration 00050) therefore took effect on each replica only
//     when that replica's local TTL happened to lapse — not immediately, and
//     not in lockstep across the cluster.
//
// This module provides two coherence primitives backed by ONE Postgres table
// (`edge_shared_cache`, migration 00162) — deliberately NO Redis dependency, to
// match the rest of the stack (Postgres + Supavisor, US-570):
//
//   1. createSharedTokenCache — a cluster-shared value store for minted bearer
//      tokens. A replica consults the shared row BEFORE minting, so the whole
//      cluster mints ~once per TTL window (a brief mint race between replicas is
//      possible and harmless) instead of once per replica. Tokens are encrypted
//      at rest (AES-GCM, AAD-bound to the cache key — see crypto-aes.ts).
//
//   2. createVersionedCache — a version-stamped local cache. Writers call
//      invalidate() on a mutation (e.g. prompt activation); readers cheaply
//      poll the shared signal version (micro-cached for a few seconds) and drop
//      their local entry the instant the version moves. Propagation latency is
//      bounded by the signal micro-TTL (default 5s), NOT the data TTL.
//
// The AES-key cache (crypto-aes.ts) is intentionally NOT migrated here: its
// inputs are environment variables — identical on every replica and changed
// only by a redeploy, which restarts every process — so it can never go stale
// or diverge between replicas. See crypto-aes.ts for the matching note.
//
// FAIL-SAFE: every store call is wrapped so a DB blip degrades gracefully — a
// token cache falls back to minting locally (cluster temporarily mints per
// replica, exactly the pre-US-571 behaviour) and a versioned cache keeps
// serving its last value for a bounded fallback window — rather than failing
// the request.
//
// `store` is injectable so both primitives are unit-testable without a DB
// (mirrors the job-lock / plan-gate injectable-deps pattern).

import { supabaseAdmin } from "./supabase.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";
import { captureException } from "./observability.ts";

// ── Shared store (Postgres `edge_shared_cache`) ──────────────────────────────
//
// A given cache_key is used for EITHER a signal (version) OR a value, never
// both. Signal rows are touched via the atomic bump/get RPCs; value rows via
// PostgREST upsert/select (service-role bypasses RLS).
export interface SharedCacheStore {
  /** Current signal version for a key; 0 if the key has never been bumped. */
  getSignal(key: string): Promise<number>;
  /** Atomically increment (and create) the signal; returns the new version. */
  bumpSignal(key: string): Promise<number>;
  /** Read a shared value row, or null if absent / value is null. */
  readValue(
    key: string,
  ): Promise<{ value: string; expiresAt: number | null } | null>;
  /** Upsert a shared value row. */
  writeValue(
    key: string,
    value: string,
    expiresAt: number | null,
  ): Promise<void>;
}

const defaultStore: SharedCacheStore = {
  async getSignal(key) {
    const { data, error } = await supabaseAdmin.rpc("get_cache_signal", {
      p_key: key,
    });
    if (error) throw new Error(error.message);
    return typeof data === "number" ? data : 0;
  },
  async bumpSignal(key) {
    const { data, error } = await supabaseAdmin.rpc("bump_cache_signal", {
      p_key: key,
    });
    if (error) throw new Error(error.message);
    return typeof data === "number" ? data : 0;
  },
  async readValue(key) {
    const { data, error } = await supabaseAdmin
      .from("edge_shared_cache")
      .select("value, expires_at")
      .eq("cache_key", key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as { value: string | null; expires_at: string | null };
    if (row.value == null) return null;
    return {
      value: row.value,
      expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
    };
  },
  async writeValue(key, value, expiresAt) {
    const { error } = await supabaseAdmin.from("edge_shared_cache").upsert(
      {
        cache_key: key,
        value,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "cache_key" },
    );
    if (error) throw new Error(error.message);
  },
};

// ── 1. Shared bearer-token cache ─────────────────────────────────────────────

export interface MintedToken {
  token: string;
  /** Milliseconds from now until the token expires. */
  expiresInMs: number;
}

export interface SharedTokenCache {
  /** Return a valid token, minting (and sharing) one only if needed. */
  get(mint: () => Promise<MintedToken>): Promise<string>;
  /** Test seam: drop the in-process copy. */
  _resetLocal(): void;
}

export function createSharedTokenCache(opts: {
  cacheKey: string;
  /** Refresh this long before the recorded expiry. Default 5 min. */
  skewMs?: number;
  /** Encrypt the token at rest in the shared store. Default true. */
  encrypt?: boolean;
  store?: SharedCacheStore;
}): SharedTokenCache {
  const store = opts.store ?? defaultStore;
  const skewMs = opts.skewMs ?? 5 * 60_000;
  const encrypt = opts.encrypt ?? true;
  let local: { token: string; expiresAt: number } | null = null;

  const fresh = (expiresAt: number, now: number) => expiresAt - skewMs > now;

  return {
    async get(mint) {
      const now = Date.now();
      // Fast path: this replica's own copy is still well within its lifetime.
      if (local && fresh(local.expiresAt, now)) return local.token;

      // Before minting, see whether another replica already minted a token we
      // can reuse — this is what collapses N×-minting down to ~1 per cluster.
      try {
        const shared = await store.readValue(opts.cacheKey);
        if (shared && shared.expiresAt != null && fresh(shared.expiresAt, now)) {
          const token = encrypt
            ? await decryptToken(shared.value, { aad: opts.cacheKey })
            : shared.value;
          local = { token, expiresAt: shared.expiresAt };
          return token;
        }
      } catch (err) {
        captureException(err, {
          level: "warn",
          route: "coherent-cache.read",
          tags: { key: opts.cacheKey },
        });
        // Fall through: serve availability by minting locally.
      }

      const minted = await mint();
      const expiresAt = now + minted.expiresInMs;
      local = { token: minted.token, expiresAt };
      try {
        const stored = encrypt
          ? await encryptToken(minted.token, { aad: opts.cacheKey })
          : minted.token;
        await store.writeValue(opts.cacheKey, stored, expiresAt);
      } catch (err) {
        captureException(err, {
          level: "warn",
          route: "coherent-cache.write",
          tags: { key: opts.cacheKey },
        });
        // The local copy is still valid; the cluster just won't share it.
      }
      return minted.token;
    },
    _resetLocal() {
      local = null;
    },
  };
}

// ── 2. Version-stamped local cache ───────────────────────────────────────────

export interface VersionedCache<T> {
  /** Return the cached entry if its version still matches, else (re)fetch. */
  get(entryKey: string, fetch: () => Promise<T>): Promise<T>;
  /**
   * Bump the shared signal AND clear this process's entries. Call from the
   * write path (e.g. prompt activation/deactivation) so the change propagates
   * to every replica within the signal micro-TTL and takes effect locally now.
   */
  invalidate(): Promise<void>;
  /** Test seam: drop local state without touching the store. */
  _reset(): void;
}

export function createVersionedCache<T>(opts: {
  signalKey: string;
  /** How long a fetched signal version is trusted before re-reading. Default 5s. */
  signalTtlMs?: number;
  /** Local TTL used ONLY while the signal store is unreachable. Default 60s. */
  fallbackTtlMs?: number;
  store?: SharedCacheStore;
}): VersionedCache<T> {
  const store = opts.store ?? defaultStore;
  const signalTtlMs = opts.signalTtlMs ?? 5_000;
  const fallbackTtlMs = opts.fallbackTtlMs ?? 60_000;

  const entries = new Map<
    string,
    { value: T; version: number; fallbackUntil: number }
  >();
  let cachedVersion = 0;
  let versionReadAt = 0;

  async function currentVersion(
    now: number,
  ): Promise<{ version: number; degraded: boolean }> {
    if (versionReadAt > 0 && now - versionReadAt < signalTtlMs) {
      return { version: cachedVersion, degraded: false };
    }
    try {
      const v = await store.getSignal(opts.signalKey);
      cachedVersion = v;
      versionReadAt = now;
      return { version: v, degraded: false };
    } catch (err) {
      captureException(err, {
        level: "warn",
        route: "coherent-cache.signal",
        tags: { key: opts.signalKey },
      });
      return { version: cachedVersion, degraded: true };
    }
  }

  return {
    async get(entryKey, fetch) {
      const now = Date.now();
      const { version, degraded } = await currentVersion(now);
      const hit = entries.get(entryKey);
      if (hit) {
        if (!degraded && hit.version === version) return hit.value;
        // Signal store unreachable: don't refetch-storm — keep serving the last
        // value until the bounded fallback window lapses.
        if (degraded && hit.fallbackUntil > now) return hit.value;
      }
      const value = await fetch();
      entries.set(entryKey, {
        value,
        version,
        fallbackUntil: now + fallbackTtlMs,
      });
      return value;
    },
    async invalidate() {
      entries.clear();
      cachedVersion = 0;
      versionReadAt = 0;
      try {
        await store.bumpSignal(opts.signalKey);
      } catch (err) {
        captureException(err, {
          level: "warn",
          route: "coherent-cache.bump",
          tags: { key: opts.signalKey },
        });
      }
    },
    _reset() {
      entries.clear();
      cachedVersion = 0;
      versionReadAt = 0;
    },
  };
}
