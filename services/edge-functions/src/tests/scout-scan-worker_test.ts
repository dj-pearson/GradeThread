// SRC-3: phase two, the paid half of a Scout scan.
//
// A cap hit on the first reservation and an all-failed run (an Anthropic
// outage) both used to come back as `candidates: []` with no flag, and the page
// told the seller to broaden a search that was fine. runShadowGrades now says
// which of the two it was.

// US-2379: FIRST, before anything that reaches lib/supabase.ts at import time.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { runShadowGrades } from "../routes/flipdesk-scout.ts";
import type { ScoutScored } from "../lib/scout-scoring.ts";

type Cand = { itemId: string };
const queue: Cand[] = Array.from({ length: 8 }, (_, i) => ({ itemId: `item-${i}` }));

function row(itemId: string): ScoutScored {
  return { itemId } as unknown as ScoutScored;
}

Deno.test("SRC-3: a cap refusal on the first reservation reports capReached with nothing scored", async () => {
  let reserves = 0;
  let grades = 0;
  const run = await runShadowGrades(queue, {
    reserve: () => {
      reserves++;
      return Promise.resolve(false);
    },
    refund: () => Promise.resolve(),
    grade: () => {
      grades++;
      return Promise.resolve({ overallScore: 8, confidence: 0.9 });
    },
    score: (c) => Promise.resolve(row(c.itemId)),
    concurrency: 1,
  });
  assertEquals(run.capReached, true);
  assertEquals(run.scored, []);
  assertEquals(run.queued, 8);
  assertEquals(reserves, 1);
  assertEquals(grades, 0);
});

Deno.test("SRC-3: a grade that always throws counts every listing as failed and refunds each", async () => {
  let refunds = 0;
  const run = await runShadowGrades(queue, {
    reserve: () => Promise.resolve(true),
    refund: () => {
      refunds++;
      return Promise.resolve();
    },
    grade: () => Promise.reject(new Error("anthropic 529")),
    score: (c) => Promise.resolve(row(c.itemId)),
    concurrency: 4,
  });
  assertEquals(run.capReached, false);
  assertEquals(run.failed, run.queued);
  assertEquals(run.failed, 8);
  assertEquals(refunds, 8);
  assertEquals(run.scored.length, 0);
});

Deno.test("SRC-3: a cap hit midway keeps what was graded", async () => {
  let n = 0;
  const run = await runShadowGrades(queue, {
    reserve: () => Promise.resolve(++n <= 3),
    refund: () => Promise.resolve(),
    grade: () => Promise.resolve({ overallScore: 7, confidence: 0.8 }),
    score: (c) => Promise.resolve(row(c.itemId)),
    concurrency: 1,
  });
  assertEquals(run.capReached, true);
  assertEquals(run.scored.map((r) => r.itemId), ["item-0", "item-1", "item-2"]);
});

// ── SRC-7: a re-scan never re-bills a listing it already graded ──────────────

import { createScoutShadowCache, scoutShadowKey } from "../lib/comps-cache.ts";
import type { SharedCacheStore } from "../lib/coherent-cache.ts";

function memoryStore(): SharedCacheStore {
  const rows = new Map<string, { value: string; expiresAt: number | null }>();
  return {
    getSignal: () => Promise.resolve(0),
    bumpSignal: () => Promise.resolve(1),
    readValue: (k) => Promise.resolve(rows.get(k) ?? null),
    writeValue: (k, value, expiresAt) => {
      rows.set(k, { value, expiresAt });
      return Promise.resolve();
    },
  };
}

type Photo = { itemId: string; imageUrl: string };
const photos: Photo[] = Array.from({ length: 8 }, (_, i) => ({
  itemId: `item-${i}`,
  imageUrl: `https://i.ebayimg.test/${i}.jpg`,
}));

Deno.test("SRC-7: eight cached listings reserve nothing and score all eight", async () => {
  const cache = createScoutShadowCache(memoryStore());
  for (const p of photos) await cache.remember("owner-a", p.itemId, p.imageUrl, { overallScore: 8, confidence: 0.9 });
  let reserves = 0;
  let grades = 0;
  const run = await runShadowGrades(photos, {
    reserve: () => {
      reserves++;
      return Promise.resolve(true);
    },
    refund: () => Promise.resolve(),
    grade: () => {
      grades++;
      return Promise.resolve({ overallScore: 5, confidence: 0.5 });
    },
    score: (c) => Promise.resolve(row(c.itemId)),
    cached: (c) => cache.lookup("owner-a", c.itemId, c.imageUrl),
    remember: (c, g) => cache.remember("owner-a", c.itemId, c.imageUrl, g),
    concurrency: 4,
  });
  assertEquals(reserves, 0);
  assertEquals(grades, 0);
  assertEquals(run.scored.length, 8);
  assertEquals(run.cachedGrades, 8);
});

Deno.test("SRC-7: a fresh grade is remembered, so the second scan is free", async () => {
  const cache = createScoutShadowCache(memoryStore());
  let reserves = 0;
  const deps = {
    reserve: () => {
      reserves++;
      return Promise.resolve(true);
    },
    refund: () => Promise.resolve(),
    grade: () => Promise.resolve({ overallScore: 7, confidence: 0.8 }),
    score: (c: Photo) => Promise.resolve(row(c.itemId)),
    cached: (c: Photo) => cache.lookup("owner-a", c.itemId, c.imageUrl),
    remember: (c: Photo, g: { overallScore: number; confidence: number }) =>
      cache.remember("owner-a", c.itemId, c.imageUrl, g),
    concurrency: 2,
  };
  await runShadowGrades(photos, deps);
  assertEquals(reserves, 8);
  const second = await runShadowGrades(photos, deps);
  assertEquals(reserves, 8, "the re-scan reserved again");
  assertEquals(second.cachedGrades, 8);
});

Deno.test("SRC-7: the key carries the owner, so B misses A's grade", async () => {
  assert(scoutShadowKey("owner-a", "item-1", "https://x/1.jpg").includes("owner-a"));
  assert(
    scoutShadowKey("owner-a", "item-1", "https://x/1.jpg") !==
      scoutShadowKey("owner-b", "item-1", "https://x/1.jpg"),
  );
  assert(
    scoutShadowKey("owner-a", "item-1", "https://x/1.jpg") !==
      scoutShadowKey("owner-a", "item-1", "https://x/2.jpg"),
    "a new photo is a new grade",
  );
  const cache = createScoutShadowCache(memoryStore());
  await cache.remember("owner-a", "item-1", "https://x/1.jpg", { overallScore: 9, confidence: 0.9 });
  assertEquals(await cache.lookup("owner-b", "item-1", "https://x/1.jpg"), null);
  assertEquals((await cache.lookup("owner-a", "item-1", "https://x/1.jpg"))?.overallScore, 9);
});
