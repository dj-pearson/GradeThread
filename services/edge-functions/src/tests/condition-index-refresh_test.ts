// US-1749: the pure staleness-tiering + budget logic that decides which Value
// Index / Condition Index seeds a refresh run fetches. The eBay-backed refresh
// itself needs a live stack; the tiering + budget cap that bound its cost are
// pure and unit-tested here.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");

const { selectDueSeeds, DEFAULT_SEED_REFRESH_CONFIG } = await import("../lib/condition-index.ts");

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function seed(slug: string) {
  return { slug, label: slug, brand: "Brand", categoryId: "1", q: slug };
}

const CONFIG = { ...DEFAULT_SEED_REFRESH_CONFIG }; // enabled, max 20, hot 1d, cold 7d, hotThresh 25

Deno.test("selectDueSeeds: a never-refreshed seed is always due, sorted first", () => {
  const seeds = [seed("fresh"), seed("new")];
  const states = new Map([
    ["fresh", { refreshedAtMs: NOW - 1000, totalSampleSize: 40 }],
  ]);
  const sel = selectDueSeeds(seeds, states, CONFIG, NOW);
  assertEquals(sel.batch.map((s) => s.slug), ["new"]);
  assertEquals(sel.freshCount, 1);
  assertEquals(sel.dueCount, 1);
});

Deno.test("selectDueSeeds: hot seeds refresh after hotDays, cold after coldDays", () => {
  const seeds = [seed("hot"), seed("cold")];
  const states = new Map([
    // hot: sample >= 25, refreshed 2 days ago → due (hotDays=1)
    ["hot", { refreshedAtMs: NOW - 2 * DAY, totalSampleSize: 100 }],
    // cold: sample < 25, refreshed 2 days ago → NOT due (coldDays=7)
    ["cold", { refreshedAtMs: NOW - 2 * DAY, totalSampleSize: 5 }],
  ]);
  const sel = selectDueSeeds(seeds, states, CONFIG, NOW);
  assertEquals(sel.batch.map((s) => s.slug), ["hot"]);
  assertEquals(sel.freshCount, 1);
});

Deno.test("selectDueSeeds: a long-tail seed past coldDays is due", () => {
  const seeds = [seed("cold")];
  const states = new Map([["cold", { refreshedAtMs: NOW - 10 * DAY, totalSampleSize: 5 }]]);
  const sel = selectDueSeeds(seeds, states, CONFIG, NOW);
  assertEquals(sel.batch.map((s) => s.slug), ["cold"]);
});

Deno.test("selectDueSeeds: the budget cap defers extra due seeds, oldest first", () => {
  const seeds = [seed("a"), seed("b"), seed("c")];
  const states = new Map([
    ["a", { refreshedAtMs: NOW - 3 * DAY, totalSampleSize: 100 }],
    ["b", { refreshedAtMs: NOW - 9 * DAY, totalSampleSize: 100 }], // oldest
    ["c", { refreshedAtMs: NOW - 5 * DAY, totalSampleSize: 100 }],
  ]);
  const sel = selectDueSeeds(seeds, states, { ...CONFIG, maxSeedsPerRun: 2 }, NOW);
  assertEquals(sel.batch.map((s) => s.slug), ["b", "c"]); // oldest two
  assert(sel.budgetCapped);
  assertEquals(sel.dueCount, 3);
});

Deno.test("selectDueSeeds: all-fresh yields an empty batch (no wasted calls)", () => {
  const seeds = [seed("a"), seed("b")];
  const states = new Map([
    ["a", { refreshedAtMs: NOW - 100, totalSampleSize: 100 }],
    ["b", { refreshedAtMs: NOW - 100, totalSampleSize: 100 }],
  ]);
  const sel = selectDueSeeds(seeds, states, CONFIG, NOW);
  assertEquals(sel.batch.length, 0);
  assertEquals(sel.freshCount, 2);
  assert(!sel.budgetCapped);
});
