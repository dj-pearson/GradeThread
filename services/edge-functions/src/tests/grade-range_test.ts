// US-3339: a grade range from MEASURED regrade spreads, per category, and never
// from confidence_score.
//
//   deno test --allow-net --allow-env --allow-read src/tests/grade-range_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  appendSpreads,
  coerceRecord,
  type ConsistencyRecord,
  GRADE_RANGE_SETTING,
  percentile,
  publicRanges,
  RANGE_MAX_PER_CATEGORY,
  RANGE_MIN_SAMPLES,
  rangeForCategory,
} from "../lib/grade-range.ts";

const NOW = new Date("2026-09-11T00:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();

function record(cat: string, spreads: number[], daysAgo = 1): ConsistencyRecord {
  return { version: 1, updated_at: at(daysAgo), categories: { [cat]: spreads.map((spread) => ({ spread, at: at(daysAgo) })) } };
}

Deno.test("the range is the 80th percentile of measured spreads, rounded up to 0.1", () => {
  const r = rangeForCategory(record("jeans", [0, 0, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.5, 0.8]), "jeans", NOW);
  assertEquals(r, { half_width: 0.3, samples: 10 });
  const up = rangeForCategory(record("jeans", Array(10).fill(0.31)), "jeans", NOW);
  assertEquals(up?.half_width, 0.4, "0.31 rounds UP, never down to a tighter promise");
  assertEquals(percentile([5, 1, 3], 0.5), 3);
});

Deno.test("no range without enough recent measurements, and none for a spread of zero", () => {
  assertEquals(rangeForCategory(record("jeans", Array(RANGE_MIN_SAMPLES - 1).fill(0.4)), "jeans", NOW), null);
  assertEquals(rangeForCategory(record("jeans", Array(20).fill(0.4), 200), "jeans", NOW), null, "stale measurements do not count");
  assertEquals(rangeForCategory(record("jeans", Array(20).fill(0)), "jeans", NOW), null);
  assertEquals(rangeForCategory(record("jeans", Array(20).fill(0.4)), "sweater", NOW), null, "one category's spread is not another's");
  assertEquals(Object.keys(publicRanges({
    version: 1,
    updated_at: null,
    categories: { ...record("jeans", Array(12).fill(0.2)).categories, ...record("dress", [0.5]).categories },
  }, NOW)), ["jeans"]);
});

Deno.test("measurements append per category, lowercased, capped, and junk is dropped", () => {
  const base = coerceRecord(null);
  const next = appendSpreads(base, [
    { category: "Jeans", spread: 0.2, at: at(0) },
    { category: null, spread: 0.2, at: at(0) },
    { category: "jeans", spread: -1, at: at(0) },
    { category: "jeans", spread: Number.NaN, at: at(0) },
  ]);
  assertEquals(next.categories, { jeans: [{ spread: 0.2, at: at(0) }] });
  assertEquals(next.updated_at, at(0));
  const full = appendSpreads(next, Array.from({ length: RANGE_MAX_PER_CATEGORY + 5 }, (_, i) => ({ category: "jeans", spread: i / 1000, at: at(0) })));
  assertEquals(full.categories.jeans.length, RANGE_MAX_PER_CATEGORY);
  assertEquals(full.categories.jeans.at(-1)?.spread, 0.2, "newest kept, oldest dropped");
  assertEquals(coerceRecord({ categories: { jeans: [{ spread: "x" }, { spread: 0.1, at: "t" }], bad: 7 } }).categories, {
    jeans: [{ spread: 0.1, at: "t" }],
  });
});

// ── the job persists, by category ───────────────────────────────────────────

// supabaseAdmin binds fetch on first use: one stub for the whole file, reading
// variables, so every test below talks to it.
let stored: unknown = null;
let upserted: Record<string, unknown> | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  // Only the database is faked. Anything else (a module fetching its WASM on
  // import) goes to the real network.
  if (!url.includes("/rest/v1/")) return realFetch(input, init);
  if (url.includes("/rest/v1/system_settings") && method === "POST") {
    upserted = JSON.parse(String(init?.body));
    return Promise.resolve(new Response("[]", { status: 201, headers: { "Content-Type": "application/json" } }));
  }
  const rows = url.includes("/rest/v1/system_settings") && stored !== null ? [{ value: stored }] : [];
  const wantsObject = (new Headers(init?.headers).get("Accept") ?? "").includes("object");
  return Promise.resolve(new Response(JSON.stringify(wantsObject ? rows[0] ?? null : rows), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const { persistCategorySpreads } = await import("../routes/jobs-grading-self-consistency.ts");

Deno.test("the self-consistency job adds its measured spreads to the stored record, by category", async () => {
  stored = record("jeans", [0.1]);
  upserted = null;
  const ok = await persistCategorySpreads(
    [{ category: "jeans", spread: 0.4 }, { category: "dress", spread: 0.2 }],
    at(0),
  );
  assert(ok);
  assert(upserted, "the record was written");
  const row = upserted as unknown as { key: string; value: ConsistencyRecord };
  assertEquals(row.key, GRADE_RANGE_SETTING);
  assertEquals(row.value.categories.jeans.map((e) => e.spread), [0.1, 0.4]);
  assertEquals(row.value.categories.dress.map((e) => e.spread), [0.2]);
  const src = Deno.readTextFileSync(new URL("../routes/jobs-grading-self-consistency.ts", import.meta.url));
  assert(src.includes("measured.push({ category: s.garment_category, spread: result.max_spread });"));
  assert(src.includes("const persisted = await persistCategorySpreads(measured, new Date().toISOString());"));
});

Deno.test("the public endpoint returns only categories with a measured range", async () => {
  const { Hono } = await import("hono");
  const { contentPublicRoutes } = await import("../routes/content-public.ts");
  const { bustSettingCache } = await import("../lib/system-settings.ts");
  stored = {
    version: 1,
    updated_at: new Date().toISOString(),
    categories: {
      jeans: Array.from({ length: 12 }, () => ({ spread: 0.2, at: new Date().toISOString() })),
      dress: [{ spread: 0.9, at: new Date().toISOString() }],
    },
  };
  bustSettingCache(GRADE_RANGE_SETTING);
  const app = new Hono().route("/", contentPublicRoutes);
  const res = await app.request("/grade-ranges.json");
  assertEquals(res.status, 200);
  const body = await res.json() as { ranges: Record<string, unknown> };
  assertEquals(body.ranges, { jeans: { half_width: 0.2, samples: 12 } });
  bustSettingCache(GRADE_RANGE_SETTING);
});

// ── never from confidence ───────────────────────────────────────────────────

Deno.test("no range is ever derived from confidence_score", () => {
  const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const p of ["../lib/grade-range.ts", "../../../../src/lib/grade-range.ts", "../../../../src/hooks/use-grade-ranges.ts", "../../../../src/components/grading/grade-range-note.tsx"]) {
    assert(!/confidence/i.test(strip(read(p))), `${p} reads confidence`);
  }
  const route = read("../routes/content-public.ts");
  const start = route.indexOf('contentPublicRoutes.get("/grade-ranges.json"');
  const body = route.slice(start, route.indexOf("\n});\n", start));
  assert(start > 0 && !/confidence/i.test(body), "the public range route reads confidence");
  assert(body.includes("coerceRecord(await getSetting<unknown>(GRADE_RANGE_SETTING, null))"), "the route reads only the measured record");
});
