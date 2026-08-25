// US-2754: a repeat comp lookup in the same store run should be free.
//
// Two halves are tested here and they fail differently.
//
// THE KEY is pure, and it decides correctness: two different queries sharing a
// key would serve one item's comps for another, which is a wrong price rather
// than a slow one. The tenant must never appear in it — comps are public market
// data, and a per-tenant key would multiply the misses for no benefit and leak
// nothing useful in exchange.
//
// THE CACHE is shared across replicas, per vault/10-ops/edge-runtime-invariants.md:
// "ask whether two replicas disagreeing about it would be a bug". For comps it
// would — the same seller scanning the same rack twice would get two different
// values depending on which replica answered — so it goes in edge_shared_cache
// rather than a module-level Map.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { createSharedJsonCache, type SharedCacheStore } from "../lib/coherent-cache.ts";
import { compsCacheKey, COMPS_CACHE_TTL_MS } from "../lib/comps-cache.ts";
import { gradeToConditionId } from "../lib/repricing.ts";
import { normalizeItemKey } from "../lib/condition-item-key.ts";

// ── an in-memory stand-in for edge_shared_cache ────────────────────────────

function fakeStore(): SharedCacheStore & { reads: number; writes: number; rows: Map<string, { value: string; expiresAt: number | null }> } {
  const rows = new Map<string, { value: string; expiresAt: number | null }>();
  return {
    reads: 0,
    writes: 0,
    rows,
    getSignal: () => Promise.resolve(0),
    bumpSignal: () => Promise.resolve(0),
    readValue(key) {
      (this as { reads: number }).reads++;
      return Promise.resolve(rows.get(key) ?? null);
    },
    writeValue(key, value, expiresAt) {
      (this as { writes: number }).writes++;
      rows.set(key, { value, expiresAt });
      return Promise.resolve();
    },
  };
}

// ── the key ────────────────────────────────────────────────────────────────

Deno.test("the same query shape produces the same key", () => {
  const a = compsCacheKey({ categoryId: "155183", q: "carhartt detroit", brand: "Carhartt", conditionId: "3000", limit: 25 });
  const b = compsCacheKey({ categoryId: "155183", q: "carhartt detroit", brand: "Carhartt", conditionId: "3000", limit: 25 });
  assertEquals(a, b);
});

Deno.test("key order and casing do not change the key", () => {
  // A seller typing "Carhartt" and "carhartt" is asking the same question, and
  // eBay's own matching is case-insensitive. Two keys here would halve the hit
  // rate for no reason.
  const a = compsCacheKey({ categoryId: "155183", q: "Carhartt Detroit", brand: "Carhartt", conditionId: "3000", limit: 25 });
  const b = compsCacheKey({ limit: 25, conditionId: "3000", brand: "carhartt", q: "  carhartt detroit  ", categoryId: "155183" });
  assertEquals(a, b);
});

Deno.test("every field that changes the eBay query changes the key", () => {
  const base = { categoryId: "155183", q: "carhartt", brand: "Carhartt", size: "L", conditionId: "3000", limit: 25 };
  const baseKey = compsCacheKey(base);
  const variants = [
    { ...base, categoryId: "57988" },
    { ...base, q: "levis" },
    { ...base, brand: "Levi" },
    { ...base, size: "M" },
    { ...base, conditionId: "1000" },
    { ...base, limit: 50 },
    { ...base, gtin: "0123456789012" },
  ];
  for (const v of variants) {
    assert(
      compsCacheKey(v) !== baseKey,
      `a query differing by one field shared a key: ${JSON.stringify(v)}`,
    );
  }
});

Deno.test("the key carries nothing tenant-specific", () => {
  // Comps are public market data. A tenant in the key would multiply misses and
  // buy nothing — every seller asking about the same jacket wants the same
  // answer, and that is the whole reason this cache is worth having.
  const key = compsCacheKey({ categoryId: "155183", q: "carhartt", conditionId: "3000", limit: 25 });
  for (const leak of ["user", "owner", "tenant", "workspace"]) {
    assert(!key.toLowerCase().includes(leak), `the cache key mentions "${leak}"`);
  }
});

Deno.test("absent optional fields are stable, not undefined-shaped", () => {
  const a = compsCacheKey({ categoryId: "155183", conditionId: "3000", limit: 25 });
  const b = compsCacheKey({ categoryId: "155183", conditionId: "3000", limit: 25, q: undefined, brand: undefined });
  assertEquals(a, b);
  assert(!a.includes("undefined"), "an absent field serialised as the string 'undefined'");
});

// ── the TTL ────────────────────────────────────────────────────────────────

Deno.test("the TTL is short enough to be honest and long enough to help", () => {
  const minutes = COMPS_CACHE_TTL_MS / 60_000;
  assert(minutes >= 5, `TTL is ${minutes}min — too short to survive a rack of similar items`);
  assert(minutes <= 60, `TTL is ${minutes}min — a value that stale is being presented as current`);
});

// ── the cache ──────────────────────────────────────────────────────────────

Deno.test("a repeat lookup issues NO second fetch", async () => {
  const store = fakeStore();
  const cache = createSharedJsonCache<{ n: number }>({ namespace: "t", ttlMs: 60_000, store });
  let loads = 0;
  const load = () => {
    loads++;
    return Promise.resolve({ n: loads });
  };

  const first = await cache.get("k", load);
  const second = await cache.get("k", load);

  assertEquals(loads, 1, "the second lookup re-fetched");
  assertEquals(first.hit, false);
  assertEquals(second.hit, true);
  assertEquals(second.value.n, 1, "the second lookup returned a different value");
});

Deno.test("a hit and a miss return the SAME value", async () => {
  // The cache may change latency and must never change the answer.
  const store = fakeStore();
  const cache = createSharedJsonCache<{ median: number }>({ namespace: "t", ttlMs: 60_000, store });
  const load = () => Promise.resolve({ median: 4250 });
  const miss = await cache.get("k", load);
  const hit = await cache.get("k", load);
  assertEquals(hit.value, miss.value);
});

Deno.test("an expired entry re-fetches", async () => {
  const store = fakeStore();
  let now = 1_000_000;
  const cache = createSharedJsonCache<{ n: number }>({
    namespace: "t",
    ttlMs: 60_000,
    store,
    now: () => now,
  });
  let loads = 0;
  const load = () => Promise.resolve({ n: ++loads });

  await cache.get("k", load);
  now += 59_000;
  await cache.get("k", load);
  assertEquals(loads, 1, "re-fetched before the TTL elapsed");
  now += 2_000;
  await cache.get("k", load);
  assertEquals(loads, 2, "did not re-fetch after the TTL elapsed");
});

Deno.test("different keys do not collide", async () => {
  const store = fakeStore();
  const cache = createSharedJsonCache<string>({ namespace: "t", ttlMs: 60_000, store });
  await cache.get("a", () => Promise.resolve("A"));
  const b = await cache.get("b", () => Promise.resolve("B"));
  assertEquals(b.value, "B");
  assertEquals(b.hit, false);
});

// ── failing safe ───────────────────────────────────────────────────────────

Deno.test("a broken store degrades to a plain fetch rather than an error", async () => {
  // A cache that can take the request down with it is worse than no cache.
  const broken: SharedCacheStore = {
    getSignal: () => Promise.reject(new Error("db down")),
    bumpSignal: () => Promise.reject(new Error("db down")),
    readValue: () => Promise.reject(new Error("db down")),
    writeValue: () => Promise.reject(new Error("db down")),
  };
  const cache = createSharedJsonCache<string>({ namespace: "t", ttlMs: 60_000, store: broken });
  const out = await cache.get("k", () => Promise.resolve("fresh"));
  assertEquals(out.value, "fresh");
  assertEquals(out.hit, false);
});

Deno.test("an unparseable cached row is treated as a miss, not a crash", async () => {
  const store = fakeStore();
  store.rows.set("t:k", { value: "{{{ not json", expiresAt: null });
  const cache = createSharedJsonCache<string>({ namespace: "t", ttlMs: 60_000, store });
  const out = await cache.get("k", () => Promise.resolve("fresh"));
  assertEquals(out.value, "fresh");
  assertEquals(out.hit, false);
});

Deno.test("a load that throws propagates — the cache does not invent a value", async () => {
  const store = fakeStore();
  const cache = createSharedJsonCache<string>({ namespace: "t", ttlMs: 60_000, store });
  let threw = false;
  try {
    await cache.get("k", () => Promise.reject(new Error("eBay is down")));
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message, "eBay is down");
  }
  assert(threw, "a failed load was swallowed and something else returned");
  assertEquals(store.writes, 0, "a failed load was written to the cache");
});

// A Scout scan values every candidate it grades, and the ONLY field that varies
// between those lookups is the eBay condition the grade maps to. There are four
// of those, and the wide "Used" band covers 3.0 through 8.5, which is where
// almost every shadow grade off a listing photo lands.
//
// So the eight value lookups in one scan are one or two distinct questions, not
// eight. This is the property the scan's fan-out depends on: if these keys ever
// stop collapsing, the scan quietly goes back to paying eBay per candidate.
Deno.test("value lookups at different grades in one condition band share a key", () => {
  const item = { categoryId: "155183", q: "carhartt detroit", brand: "Carhartt", limit: 25 };
  const keyAt = (grade: number) =>
    compsCacheKey({ ...item, conditionId: gradeToConditionId(grade) });

  // The whole used band, which is where shadow grades cluster.
  assertEquals(keyAt(3.0), keyAt(8.4));
  assertEquals(keyAt(5.5), keyAt(7.9));

  // And the bands that genuinely price differently must NOT collapse together,
  // or a scan would value a new-with-tags find against used comps.
  assert(keyAt(9.6) !== keyAt(8.0), "new with tags must not share used comps");
  assert(keyAt(8.6) !== keyAt(8.0), "new without tags must not share used comps");
  assert(keyAt(2.5) !== keyAt(8.0), "for-parts must not share used comps");
});

// ── US-2849: the measured flip does not touch either key ───────────────────
//
// The flip serves a range fitted from measured condition reads instead of the
// conditionId-filtered comp median, and it reaches this file because
// cachedValueAtGrade ends at the same choke point as valueAtGrade. Its own
// lookup is keyed by the MARKET CELL, which has to obey the same invariant as
// the comp key above or the flip would quietly undo what US-2754 bought.

Deno.test("the measured curve key is query-shaped and carries no tenant", () => {
  const key = normalizeItemKey({ categoryId: "155183", brand: "Carhartt", q: "detroit jacket" });
  for (const leak of ["user", "owner", "tenant", "workspace"]) {
    assert(!key.toLowerCase().includes(leak), `the curve key mentions "${leak}"`);
  }
  // Two sellers asking about the same jacket ask one question, as with comps.
  assertEquals(
    key,
    normalizeItemKey({ categoryId: "155183", brand: "carhartt", q: "  Detroit Jacket " }),
  );
});

Deno.test("the measured curve key ignores size, so it cannot fragment the comp key", () => {
  // ItemKey carries a size and the comp key uses it; the curve is fitted per
  // brand + category + keyword. A medium and a large are one market cell.
  const medium = { categoryId: "155183", brand: "Carhartt", q: "detroit jacket", size: "M" };
  const large = { ...medium, size: "XL" };
  assertEquals(normalizeItemKey(medium), normalizeItemKey(large));
});

Deno.test("the comp cache key is unchanged by the flip", () => {
  // Pinned literally. If a later edit adds anything to this key, this fails and
  // the reader has to decide on purpose rather than discover it in a hit rate.
  assertEquals(
    compsCacheKey({
      categoryId: "155183",
      q: "carhartt detroit",
      brand: "Carhartt",
      size: "M",
      conditionId: "3000",
      limit: 25,
    }),
    "c=155183|q=carhartt detroit|b=carhartt|s=m|k=3000|g=|n=25",
  );
});
