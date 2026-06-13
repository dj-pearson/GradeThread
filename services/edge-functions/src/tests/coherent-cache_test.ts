// US-571: cross-replica cache coherence. Verifies the two primitives in
// coherent-cache.ts with an injected in-memory store that stands in for the
// shared Postgres table — no DB required. "Replicas" are modelled as two cache
// instances pointed at the SAME fake store.
//
// coherent-cache.ts imports supabase.ts, which throws at module init without
// env, so set dummy creds first and dynamically import (mirrors job-lock_test).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
// A real 32-byte key so the encrypted-at-rest round-trip test exercises crypto-aes.
Deno.env.set(
  "EDGE_ENCRYPTION_KEY",
  Deno.env.get("EDGE_ENCRYPTION_KEY") ?? btoa("0123456789abcdef0123456789abcdef"),
);

const { createSharedTokenCache, createVersionedCache } = await import(
  "../lib/coherent-cache.ts"
);
type SharedCacheStore = import("../lib/coherent-cache.ts").SharedCacheStore;

function fakeStore() {
  const signals = new Map<string, number>();
  const values = new Map<string, { value: string; expiresAt: number | null }>();
  let signalReads = 0;
  let valueReads = 0;
  let valueWrites = 0;
  let failSignal = false;
  let failValueRead = false;
  const store: SharedCacheStore = {
    getSignal(key) {
      if (failSignal) return Promise.reject(new Error("signal down"));
      signalReads++;
      return Promise.resolve(signals.get(key) ?? 0);
    },
    bumpSignal(key) {
      const v = (signals.get(key) ?? 0) + 1;
      signals.set(key, v);
      return Promise.resolve(v);
    },
    readValue(key) {
      if (failValueRead) return Promise.reject(new Error("value down"));
      valueReads++;
      return Promise.resolve(values.get(key) ?? null);
    },
    writeValue(key, value, expiresAt) {
      valueWrites++;
      values.set(key, { value, expiresAt });
      return Promise.resolve();
    },
  };
  return {
    store,
    signals,
    values,
    stats: () => ({ signalReads, valueReads, valueWrites }),
    setFailSignal: (v: boolean) => (failSignal = v),
    setFailValueRead: (v: boolean) => (failValueRead = v),
  };
}

// ── createSharedTokenCache ───────────────────────────────────────────────────

Deno.test("shared token cache mints once, then serves from the local copy", async () => {
  const { store } = fakeStore();
  const cache = createSharedTokenCache({ cacheKey: "k", encrypt: false, store });
  let mints = 0;
  const mint = () => {
    mints++;
    return Promise.resolve({ token: `t${mints}`, expiresInMs: 60 * 60_000 });
  };
  assertEquals(await cache.get(mint), "t1");
  assertEquals(await cache.get(mint), "t1");
  assertEquals(mints, 1);
});

Deno.test("a second replica reuses the shared token instead of minting", async () => {
  const { store, stats } = fakeStore();
  const replicaA = createSharedTokenCache({ cacheKey: "k", encrypt: false, store });
  const replicaB = createSharedTokenCache({ cacheKey: "k", encrypt: false, store });
  let mintsA = 0;
  let mintsB = 0;
  const tokenA = await replicaA.get(() => {
    mintsA++;
    return Promise.resolve({ token: "shared", expiresInMs: 60 * 60_000 });
  });
  const tokenB = await replicaB.get(() => {
    mintsB++;
    return Promise.resolve({ token: "SHOULD-NOT-MINT", expiresInMs: 60 * 60_000 });
  });
  assertEquals(tokenA, "shared");
  assertEquals(tokenB, "shared"); // came from the shared store, not a new mint
  assertEquals(mintsA, 1);
  assertEquals(mintsB, 0);
  assertEquals(stats().valueWrites, 1); // only A wrote
});

Deno.test("encrypted-at-rest token round-trips across replicas", async () => {
  const { store, values } = fakeStore();
  const replicaA = createSharedTokenCache({ cacheKey: "ebay-app", store }); // encrypt: true (default)
  const replicaB = createSharedTokenCache({ cacheKey: "ebay-app", store });
  await replicaA.get(() =>
    Promise.resolve({ token: "secret-bearer", expiresInMs: 60 * 60_000 })
  );
  // Stored ciphertext must NOT equal the plaintext token.
  assert(values.get("ebay-app")!.value !== "secret-bearer");
  const tokenB = await replicaB.get(() =>
    Promise.resolve({ token: "SHOULD-NOT-MINT", expiresInMs: 60 * 60_000 })
  );
  assertEquals(tokenB, "secret-bearer");
});

Deno.test("re-mints when the shared token is within the expiry skew", async () => {
  const { store } = fakeStore();
  const cache = createSharedTokenCache({
    cacheKey: "k",
    encrypt: false,
    skewMs: 1_000,
    store,
  });
  let mints = 0;
  // expiresInMs (500) < skew (1000) → never "fresh" → re-mints every call.
  const mint = () => {
    mints++;
    return Promise.resolve({ token: `t${mints}`, expiresInMs: 500 });
  };
  await cache.get(mint);
  await cache.get(mint);
  assertEquals(mints, 2);
});

Deno.test("token cache fails safe (mints locally) when the store is down", async () => {
  const { store, setFailValueRead } = fakeStore();
  setFailValueRead(true);
  const cache = createSharedTokenCache({ cacheKey: "k", encrypt: false, store });
  let mints = 0;
  const token = await cache.get(() => {
    mints++;
    return Promise.resolve({ token: "local", expiresInMs: 60 * 60_000 });
  });
  assertEquals(token, "local");
  assertEquals(mints, 1);
});

// ── createVersionedCache ─────────────────────────────────────────────────────

Deno.test("versioned cache serves cached value until the signal version moves", async () => {
  const { store } = fakeStore();
  const cache = createVersionedCache<string>({
    signalKey: "sig",
    signalTtlMs: 0, // re-read the signal on every get → immediate propagation
    store,
  });
  let fetches = 0;
  const fetch = () => {
    fetches++;
    return Promise.resolve(`v${fetches}`);
  };
  assertEquals(await cache.get("e", fetch), "v1");
  assertEquals(await cache.get("e", fetch), "v1"); // version unchanged → cached
  assertEquals(fetches, 1);

  await store.bumpSignal("sig"); // another writer activated something
  assertEquals(await cache.get("e", fetch), "v2"); // version moved → refetch
  assertEquals(fetches, 2);
});

Deno.test("invalidate() bumps the signal and clears local entries", async () => {
  const { store, signals } = fakeStore();
  const cache = createVersionedCache<string>({ signalKey: "sig", signalTtlMs: 0, store });
  let fetches = 0;
  const fetch = () => {
    fetches++;
    return Promise.resolve(`v${fetches}`);
  };
  await cache.get("e", fetch);
  await cache.invalidate();
  assertEquals(signals.get("sig"), 1);
  assertEquals(await cache.get("e", fetch), "v2");
  assertEquals(fetches, 2);
});

Deno.test("cross-replica: after replica A activates, replica B takes effect immediately", async () => {
  const { store } = fakeStore();
  const replicaA = createVersionedCache<string>({ signalKey: "sig", signalTtlMs: 0, store });
  const replicaB = createVersionedCache<string>({ signalKey: "sig", signalTtlMs: 0, store });

  let aFetch = 0;
  let bFetch = 0;
  const fetchA = () => Promise.resolve(`A serves OLD ${++aFetch}`);
  // B's fetch reads "the DB"; before activation it returns OLD, after NEW.
  let dbActive = "OLD";
  const fetchB = () => {
    bFetch++;
    return Promise.resolve(`B serves ${dbActive}`);
  };

  await replicaA.get("e", fetchA);
  assertEquals(await replicaB.get("e", fetchB), "B serves OLD");
  assertEquals(bFetch, 1);

  // Admin activates a new prompt on replica A: it bumps the shared signal.
  dbActive = "NEW";
  await replicaA.invalidate();

  // Replica B, serving a later request, must now pick up NEW (not stale OLD).
  assertEquals(await replicaB.get("e", fetchB), "B serves NEW");
  assertEquals(bFetch, 2);
});

Deno.test("versioned cache degrades: serves last value while the signal store is down", async () => {
  const { store, setFailSignal } = fakeStore();
  const cache = createVersionedCache<string>({
    signalKey: "sig",
    signalTtlMs: 0,
    fallbackTtlMs: 60_000,
    store,
  });
  let fetches = 0;
  const fetch = () => {
    fetches++;
    return Promise.resolve(`v${fetches}`);
  };
  assertEquals(await cache.get("e", fetch), "v1");
  setFailSignal(true); // signal store unreachable
  assertEquals(await cache.get("e", fetch), "v1"); // keeps serving, no refetch storm
  assertEquals(fetches, 1);
});
