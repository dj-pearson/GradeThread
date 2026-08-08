// US-1852: the quest policy — windows, period keys, progress and standings.
//
// Everything asserted here is PURE, so the whole policy is testable without a DB
// or an env. The DB half (persistQuestProgress / loadQuestsState) is covered by
// the tenant-isolation suite, which is where a scoping bug would actually show.
//
// Env-then-dynamic-import: the module pulls in lib/supabase.ts, which throws at
// import when SUPABASE_URL is unset. A static import would run before these.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

import { assert, assertEquals } from "@std/assert";
import type { QuestDefinition, QuestEventInput } from "../lib/rewards-quests.ts";

const {
  computeQuestProgress,
  isQuestMetric,
  QUEST_METRICS,
  questWindow,
  rankStandings,
} = await import("../lib/rewards-quests.ts");
const { clampQuestXp, QUEST_XP_MAX, xpForEvent } = await import("../lib/rewards-engine.ts");

const TZ = "America/Chicago";

function quest(over: Partial<QuestDefinition> = {}): QuestDefinition {
  return {
    id: "q1",
    key: "week_grade_3",
    name: "Grade three items",
    description: "",
    quest_type: "personal",
    metric: "coverage_completed",
    target: 3,
    cadence: "weekly",
    starts_at: null,
    ends_at: null,
    xp_reward: 30,
    icon: "Camera",
    enabled: true,
    sort_order: 10,
    ...over,
  };
}

function ev(over: Partial<QuestEventInput> = {}): QuestEventInput {
  return {
    eventType: "coverage_completed",
    occurredAt: "2026-08-05T12:00:00.000Z",
    verified: true,
    paid: true,
    ...over,
  };
}

// ─── Windows ────────────────────────────────────────────────────────────────

Deno.test("weekly window is Monday-anchored and keyed by the Monday's date", () => {
  // 2026-08-05 is a Wednesday; its week starts Monday 2026-08-03.
  const w = questWindow(quest(), Date.parse("2026-08-05T18:00:00Z"), TZ)!;
  assertEquals(w.periodKey, "w2026-08-03");
  assert(w.startMs < Date.parse("2026-08-05T18:00:00Z"));
  assert(w.endMs > Date.parse("2026-08-05T18:00:00Z"));
  // Exactly seven days wide (no DST boundary in this week).
  assertEquals(w.endMs - w.startMs, 7 * 86_400_000);
});

Deno.test("a Monday and the Sunday after it share one weekly window", () => {
  const mon = questWindow(quest(), Date.parse("2026-08-03T13:00:00Z"), TZ)!;
  const sun = questWindow(quest(), Date.parse("2026-08-09T13:00:00Z"), TZ)!;
  assertEquals(mon.periodKey, sun.periodKey);
  // ...and the following Monday starts a NEW one, which is what makes a weekly
  // quest pay again rather than never.
  const next = questWindow(quest(), Date.parse("2026-08-10T13:00:00Z"), TZ)!;
  assertEquals(next.periodKey, "w2026-08-10");
});

Deno.test("the week key survives a year boundary that ISO week numbers do not", () => {
  // 2025-12-31 is a Wednesday; its week starts Monday 2025-12-29 and runs into
  // 2026. An ISO week NUMBER here is "2026-W01" while the date is in 2025 — the
  // exact ambiguity the date-based key avoids.
  const dec = questWindow(quest(), Date.parse("2025-12-31T12:00:00Z"), TZ)!;
  const jan = questWindow(quest(), Date.parse("2026-01-01T12:00:00Z"), TZ)!;
  assertEquals(dec.periodKey, "w2025-12-29");
  assertEquals(jan.periodKey, dec.periodKey, "the same week must keep one key");
});

Deno.test("monthly window keys by year-month and spans the calendar month", () => {
  const w = questWindow(quest({ cadence: "monthly" }), Date.parse("2026-08-20T12:00:00Z"), TZ)!;
  assertEquals(w.periodKey, "m2026-08");
  assertEquals(w.endMs - w.startMs, 31 * 86_400_000);
});

Deno.test("a fixed quest is null outside its dates and live inside them", () => {
  const q = quest({
    cadence: "fixed",
    quest_type: "community",
    starts_at: "2026-08-01T05:00:00.000Z",
    ends_at: "2026-09-01T05:00:00.000Z",
  });
  assertEquals(questWindow(q, Date.parse("2026-07-20T00:00:00Z"), TZ), null);
  assertEquals(questWindow(q, Date.parse("2026-09-02T00:00:00Z"), TZ), null);
  const live = questWindow(q, Date.parse("2026-08-15T00:00:00Z"), TZ)!;
  assertEquals(live.periodKey, "fixed");
});

Deno.test("a fixed quest with a broken window is not live rather than throwing", () => {
  const bad = quest({ cadence: "fixed", starts_at: "nonsense", ends_at: null });
  assertEquals(questWindow(bad, Date.now(), TZ), null);
});

// ─── Progress ───────────────────────────────────────────────────────────────

Deno.test("progress counts only matching events inside the window", () => {
  const w = questWindow(quest(), Date.parse("2026-08-05T18:00:00Z"), TZ)!;
  const p = computeQuestProgress(
    [
      ev(),
      ev({ occurredAt: "2026-08-06T09:00:00.000Z" }),
      // Wrong metric.
      ev({ eventType: "verified_share", paid: false }),
      // Previous week.
      ev({ occurredAt: "2026-07-30T09:00:00.000Z" }),
    ],
    quest(),
    w,
  );
  assertEquals(p.current, 2);
  assertEquals(p.complete, false);
  assertEquals(p.percent, 67);
});

Deno.test("an event that scores no XP moves no quest", () => {
  const w = questWindow(quest(), Date.parse("2026-08-05T18:00:00Z"), TZ)!;
  // Unverified, and unpaid — the two gates US-1849 AC4 put on XP itself. The
  // quest track reuses them rather than inventing a second anti-farming rule.
  const unverified = computeQuestProgress([ev({ verified: false })], quest(), w);
  const unpaid = computeQuestProgress([ev({ paid: false })], quest(), w);
  assertEquals(unverified.current, 0);
  assertEquals(unpaid.current, 0, "coverage_completed is a grading-spend event");
});

Deno.test("an xp-metric quest sums XP rather than counting events", () => {
  const q = quest({ metric: "xp", target: 60 });
  const w = questWindow(q, Date.parse("2026-08-05T18:00:00Z"), TZ)!;
  // coverage_completed is 25 XP; three of them is 75.
  const p = computeQuestProgress([ev(), ev(), ev()], q, w);
  assertEquals(p.current, 75);
  assertEquals(p.complete, true);
  assertEquals(p.percent, 100, "percent is clamped at 100");
});

// ─── The variable-XP guard ──────────────────────────────────────────────────

Deno.test("quest XP is clamped, so an operator-editable number is not a faucet", () => {
  assertEquals(clampQuestXp(30), 30);
  assertEquals(clampQuestXp(QUEST_XP_MAX + 5_000), QUEST_XP_MAX);
  assertEquals(clampQuestXp(-10), 0);
  assertEquals(clampQuestXp("abc"), 0);
  assertEquals(clampQuestXp(null), 0);
  assertEquals(clampQuestXp(12.9), 12, "fractional XP floors rather than rounding up");
});

Deno.test("quest_completed scores its frozen award; every other type ignores one", () => {
  assertEquals(xpForEvent("quest_completed", { xpAward: 30 }), 30);
  assertEquals(xpForEvent("quest_completed", {}), 0, "no award recorded ⇒ no XP");
  assertEquals(
    xpForEvent("verified_share", { xpAward: 9_999 }),
    20,
    "a stray xpAward must never inflate a catalog type",
  );
});

Deno.test("quest_completed is not itself an allowed quest metric", () => {
  // A quest counting quest completions would let two cheap quests bootstrap
  // each other into a loop. Mirrors the CHECK in migration 00543.
  assert(!isQuestMetric("quest_completed"));
  assert(!QUEST_METRICS.includes("quest_completed" as never));
  assert(isQuestMetric("coverage_completed"));
  assert(isQuestMetric("xp"));
});

// ─── Standings ──────────────────────────────────────────────────────────────

Deno.test("standings list public profiles only, ranked, with a stable tiebreak", () => {
  const { standings, viewerRank } = rankStandings(
    [
      { userId: "u1", handle: "zeta", displayName: "Zeta", score: 5 },
      { userId: "u2", handle: "alpha", displayName: null, score: 5 },
      { userId: "u3", handle: "beta", displayName: "Beta", score: 9 },
      // No public handle — scored, but not named.
      { userId: "u4", handle: null, displayName: null, score: 20 },
      // Zero score — not on the board at all.
      { userId: "u5", handle: "gamma", displayName: "Gamma", score: 0 },
    ],
    "u2",
  );
  assertEquals(standings.map((s) => s.handle), ["beta", "alpha", "zeta"]);
  assertEquals(standings[0].rank, 1);
  assertEquals(standings[1].display_name, "alpha", "display name falls back to the handle");
  assertEquals(viewerRank, 2);
  assert(standings[1].is_you);
});

Deno.test("a viewer with no public profile gets no rank", () => {
  const { standings, viewerRank } = rankStandings(
    [
      { userId: "u1", handle: "alpha", displayName: "Alpha", score: 3 },
      { userId: "me", handle: null, displayName: null, score: 99 },
    ],
    "me",
  );
  assertEquals(viewerRank, null, "being counted is not consent to be named");
  assertEquals(standings.length, 1);
});

Deno.test("standings are capped at the requested board size", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    userId: `u${i}`,
    handle: `h${String(i).padStart(2, "0")}`,
    displayName: null,
    score: 25 - i,
  }));
  assertEquals(rankStandings(rows, null).standings.length, 10);
  assertEquals(rankStandings(rows, null, 3).standings.length, 3);
});
