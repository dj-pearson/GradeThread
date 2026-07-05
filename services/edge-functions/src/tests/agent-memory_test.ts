// US-1606: agent memory pure core — context selection (token + row caps),
// write-merge (dedup-by-key + cap eviction), and curation (decay + prune). No
// env/DB (pure module).
import { assert, assertEquals } from "@std/assert";
import {
  applyMemoryWrites,
  curateMemory,
  formatMemoryBlock,
  MEMORY_ROW_CAP,
  type MemoryRow,
  parseMemoryWrites,
  selectMemoryForContext,
} from "../lib/agent-memory.ts";

const row = (over: Partial<MemoryRow> = {}): MemoryRow => ({
  kind: "fact",
  key: "k",
  content: "some content",
  weight: 1,
  updated_at: "2026-07-01T00:00:00.000Z",
  ...over,
});

// ── Context selection ────────────────────────────────────────────────────────

Deno.test("selectMemoryForContext: strongest first, respects the row cap", () => {
  const rows = Array.from({ length: 20 }, (_, i) => row({ key: `k${i}`, weight: i }));
  const sel = selectMemoryForContext(rows, { maxRows: 5, tokenCap: 100_000 });
  assertEquals(sel.length, 5);
  assertEquals(sel.map((r) => r.weight), [19, 18, 17, 16, 15]); // top-5 by weight
});

Deno.test("selectMemoryForContext: respects the token cap (but always ≥1 row)", () => {
  const big = "x".repeat(4000); // ~1000 tokens each
  const rows = [row({ key: "a", weight: 3, content: big }), row({ key: "b", weight: 2, content: big })];
  const sel = selectMemoryForContext(rows, { maxRows: 8, tokenCap: 800 });
  assertEquals(sel.length, 1); // second would blow the 800 cap
  assertEquals(sel[0].key, "a"); // the stronger one
});

Deno.test("formatMemoryBlock: empty rows → empty string; else a self-describing block", () => {
  assertEquals(formatMemoryBlock([]), "");
  const block = formatMemoryBlock([row({ kind: "pref", key: "tz", content: "UTC" })]);
  assert(block.includes("MEMORY"));
  assert(block.includes("[pref] tz: UTC"));
});

// ── Write-merge ──────────────────────────────────────────────────────────────

Deno.test("applyMemoryWrites: dedup-by-key updates in place + bumps weight (no append)", () => {
  const existing = [row({ kind: "fact", key: "k1", content: "old", weight: 2 })];
  const { rows, upserts } = applyMemoryWrites(existing, [{ kind: "fact", key: "k1", content: "new" }], {
    nowIso: "2026-07-05T00:00:00.000Z",
  });
  assertEquals(rows.length, 1); // updated, not appended
  assertEquals(rows[0].content, "new");
  assertEquals(rows[0].weight, 3); // bumped 2 -> 3
  assertEquals(upserts.length, 1);
});

Deno.test("applyMemoryWrites: a new key is created at weight 1", () => {
  const { rows } = applyMemoryWrites([], [{ kind: "fact", key: "fresh", content: 1 }], { nowIso: "2026-07-05T00:00:00.000Z" });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].weight, 1);
});

Deno.test("applyMemoryWrites: enforces the row cap by evicting the weakest", () => {
  const existing = Array.from({ length: MEMORY_ROW_CAP }, (_, i) => row({ key: `k${i}`, weight: i + 5 }));
  // Add one brand-new weak memory → total exceeds cap → the weakest is evicted.
  const { rows, evicted } = applyMemoryWrites(existing, [{ kind: "fact", key: "new-weak", content: "x" }], {
    nowIso: "2026-07-05T00:00:00.000Z",
  });
  assertEquals(rows.length, MEMORY_ROW_CAP);
  assertEquals(evicted.length, 1);
  // The evicted one is the weakest — the new weight-1 row (weaker than all weight>=5).
  assertEquals(evicted[0].key, "new-weak");
});

Deno.test("applyMemoryWrites: ignores malformed writes (missing kind/key)", () => {
  const { rows } = applyMemoryWrites([], [{ kind: "", key: "x", content: 1 }, { kind: "f", key: "", content: 1 }], {
    nowIso: "2026-07-05T00:00:00.000Z",
  });
  assertEquals(rows.length, 0);
});

// ── Curation ─────────────────────────────────────────────────────────────────

Deno.test("curateMemory: decays weights and prunes rows that fall below the floor", () => {
  const rows = [
    row({ key: "strong", weight: 5 }), // 5*0.8 = 4 → kept
    row({ key: "weak", weight: 0.3 }), // 0.3*0.8 = 0.24 < 0.3 floor → pruned
  ];
  const { keep, drop, decayed } = curateMemory(rows);
  assertEquals(decayed, 2);
  assertEquals(keep.map((r) => r.key), ["strong"]);
  assertEquals(keep[0].weight, 4); // decayed
  assertEquals(drop.map((r) => r.key), ["weak"]);
});

Deno.test("curateMemory: enforces the row cap after decay", () => {
  const rows = Array.from({ length: MEMORY_ROW_CAP + 5 }, (_, i) => row({ key: `k${i}`, weight: i + 10 }));
  const { keep, drop } = curateMemory(rows);
  assertEquals(keep.length, MEMORY_ROW_CAP);
  assertEquals(drop.length, 5); // the 5 weakest
});

// ── Parse ────────────────────────────────────────────────────────────────────

Deno.test("parseMemoryWrites: keeps well-formed entries, drops the rest", () => {
  const writes = parseMemoryWrites([
    { kind: "fact", key: "k", content: { a: 1 } },
    { kind: "fact" }, // no key
    "nope",
    { kind: "pref", key: "tz" }, // content defaults to null
  ]);
  assertEquals(writes.length, 2);
  assertEquals(writes[1].content, null);
  assertEquals(parseMemoryWrites("not an array"), []);
});
