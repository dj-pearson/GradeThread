// US-1851 AC2: quarterly seasons — the seller-side track that replaces streaks.
//
// The two properties worth proving are boundary ones: the four quarters must
// PARTITION the year (no event double-counted at a rollover, none lost), and a
// season must reset cleanly without a job — which it does only because progress
// is a window over the log rather than stored state.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  computeSeasonProgress,
  currentSeason,
  earnedSeasonFrames,
  SEASON_FRAME_GOAL_THRESHOLD,
  SEASON_GOALS,
  SEASON_TIME_ZONE,
  seasonBounds,
  seasonFrameKey,
  seasonKeyAt,
  seasonRecap,
} = await import("../lib/rewards-seasons.ts");
const { REWARD_XP_CATALOG } = await import("../lib/rewards-engine.ts");

type Ev = Parameters<typeof computeSeasonProgress>[0][number];

const ms = (iso: string) => Date.parse(iso);

/** n events of one type, all inside the season, all XP-earning. */
function events(type: Ev["eventType"], n: number, at: string, paid = true): Ev[] {
  return Array.from({ length: n }, () => ({
    eventType: type,
    occurredAt: at,
    verified: true,
    paid,
  }));
}

// ── Season identity ──────────────────────────────────────────────────────────

Deno.test("seasonKeyAt partitions the year into four quarters", () => {
  assertEquals(seasonKeyAt(ms("2026-01-15T12:00:00Z")), "2026-Q1");
  assertEquals(seasonKeyAt(ms("2026-04-15T12:00:00Z")), "2026-Q2");
  assertEquals(seasonKeyAt(ms("2026-08-07T12:00:00Z")), "2026-Q3");
  assertEquals(seasonKeyAt(ms("2026-11-15T12:00:00Z")), "2026-Q4");
});

Deno.test("seasonKeyAt uses the anchor zone, not UTC", () => {
  // 2026-01-01T02:00Z is still 2025-12-31 21:00 in New York — Q4 of 2025.
  assertEquals(seasonKeyAt(ms("2026-01-01T02:00:00Z")), "2025-Q4");
  assertEquals(seasonKeyAt(ms("2026-01-01T06:00:00Z")), "2026-Q1");
});

Deno.test("seasonBounds is half-open — quarters abut with no gap or overlap", () => {
  const q1 = seasonBounds("2026-Q1")!;
  const q2 = seasonBounds("2026-Q2")!;
  const q3 = seasonBounds("2026-Q3")!;
  const q4 = seasonBounds("2026-Q4")!;
  assertEquals(q1.endMs, q2.startMs);
  assertEquals(q2.endMs, q3.startMs);
  assertEquals(q3.endMs, q4.startMs);
  assertEquals(q4.endMs, seasonBounds("2027-Q1")!.startMs);
});

Deno.test("seasonBounds survives the DST shift inside a quarter", () => {
  // Q1 starts on EST (-05:00), Q2 on EDT (-04:00). If the zoned→UTC conversion
  // used one fixed offset, one of these boundaries would be an hour wrong.
  assertEquals(seasonBounds("2026-Q1")!.startIso, "2026-01-01T05:00:00.000Z");
  assertEquals(seasonBounds("2026-Q2")!.startIso, "2026-04-01T04:00:00.000Z");
  assertEquals(seasonBounds("2026-Q4")!.startIso, "2026-10-01T04:00:00.000Z");
});

Deno.test("seasonBounds rejects a key that is not a season", () => {
  assertEquals(seasonBounds("2026-Q5"), null);
  assertEquals(seasonBounds("nope"), null);
  assertEquals(seasonBounds(""), null);
});

Deno.test("currentSeason resolves the key an instant falls in", () => {
  const s = currentSeason(ms("2026-08-07T12:00:00Z"));
  assertEquals(s.key, "2026-Q3");
  assertEquals(s.label, "Summer 2026");
});

Deno.test("season frame keys are namespaced away from level frames", () => {
  assert(seasonFrameKey("2026-Q3").startsWith("season:"));
  assertEquals(seasonFrameKey("2026-Q3"), "season:2026-Q3");
});

// ── Progress ─────────────────────────────────────────────────────────────────

Deno.test("only events inside the window count", () => {
  const inside = events("badge_embedded", 2, "2026-08-07T12:00:00Z");
  const before = events("badge_embedded", 5, "2026-06-01T12:00:00Z");
  const after = events("badge_embedded", 5, "2026-11-01T12:00:00Z");
  const p = computeSeasonProgress([...before, ...inside, ...after], ms("2026-08-07T12:00:00Z"));
  assertEquals(p.seasonKey, "2026-Q3");
  assertEquals(p.xpThisSeason, 2 * REWARD_XP_CATALOG.badge_embedded);
  assertEquals(p.goals.find((g) => g.key === "embeds")!.count, 2);
});

Deno.test("the rollover instant belongs to exactly one season", () => {
  const boundary = seasonBounds("2026-Q3")!.endIso; // = Q4's first instant
  const ev = events("badge_embedded", 1, boundary);
  assertEquals(computeSeasonProgress(ev, ms(boundary), SEASON_TIME_ZONE, "2026-Q3").xpThisSeason, 0);
  assert(computeSeasonProgress(ev, ms(boundary), SEASON_TIME_ZONE, "2026-Q4").xpThisSeason > 0);
});

Deno.test("a season resets cleanly with no rollover job", () => {
  // Same log, viewed from the next quarter — progress is zero because the
  // window moved, and the previous quarter stays reconstructable.
  const log = events("badge_embedded", 3, "2026-08-07T12:00:00Z");
  const q3 = computeSeasonProgress(log, ms("2026-08-07T12:00:00Z"));
  const q4 = computeSeasonProgress(log, ms("2026-11-01T12:00:00Z"));
  assertEquals(q3.goals.find((g) => g.key === "embeds")!.count, 3);
  assertEquals(q4.seasonKey, "2026-Q4");
  assertEquals(q4.xpThisSeason, 0);
  assertEquals(q4.goals.every((g) => g.count === 0), true);
});

Deno.test("goal counting respects the paid gate", () => {
  const at = "2026-08-07T12:00:00Z";
  const unpaid = computeSeasonProgress(events("coverage_completed", 30, at, false), ms(at));
  assertEquals(unpaid.goals.find((g) => g.key === "full_coverage")!.count, 0);
  assertEquals(unpaid.xpThisSeason, 0);

  const paid = computeSeasonProgress(events("coverage_completed", 30, at, true), ms(at));
  assertEquals(paid.goals.find((g) => g.key === "full_coverage")!.count, 30);
  assert(paid.goals.find((g) => g.key === "full_coverage")!.complete);
});

Deno.test("unverified events never tick a goal", () => {
  const at = "2026-08-07T12:00:00Z";
  const evs: Ev[] = Array.from({ length: 12 }, () => ({
    eventType: "verified_share",
    occurredAt: at,
    verified: false,
  }));
  const p = computeSeasonProgress(evs, ms(at));
  assertEquals(p.goals.find((g) => g.key === "shares")!.count, 0);
});

Deno.test("goal percentages clamp at 100 and never exceed it", () => {
  const at = "2026-08-07T12:00:00Z";
  const p = computeSeasonProgress(events("badge_embedded", 99, at), ms(at));
  const embeds = p.goals.find((g) => g.key === "embeds")!;
  assertEquals(embeds.pct, 100);
  assertEquals(embeds.count, 99); // the raw count is still honest
});

Deno.test("the frame is earned at the goal threshold, not before", () => {
  const at = "2026-08-07T12:00:00Z";
  const one = computeSeasonProgress(events("badge_embedded", 3, at), ms(at));
  assertEquals(one.goalsCompleted, 1);
  assertEquals(one.frameEarned, SEASON_FRAME_GOAL_THRESHOLD <= 1);

  const two = computeSeasonProgress(
    [...events("badge_embedded", 3, at), ...events("verified_share", 10, at)],
    ms(at),
  );
  assertEquals(two.goalsCompleted, 2);
  assert(two.frameEarned);
  assertEquals(two.frameKey, "season:2026-Q3");
});

Deno.test("daysRemaining counts down and floors at zero", () => {
  const bounds = seasonBounds("2026-Q3")!;
  const live = computeSeasonProgress([], bounds.endMs - 3 * 86_400_000);
  assertEquals(live.daysRemaining, 3);
  assertEquals(computeSeasonProgress([], bounds.endMs, SEASON_TIME_ZONE, "2026-Q3").daysRemaining, 0);
});

Deno.test("every goal maps to an event type the XP catalog scores", () => {
  for (const g of SEASON_GOALS) {
    assert(
      REWARD_XP_CATALOG[g.eventType] !== undefined,
      `season goal ${g.key} points at an unscored event type`,
    );
    assert(g.target > 0);
  }
});

// ── Recap ────────────────────────────────────────────────────────────────────

Deno.test("seasonRecap scores the finished quarter, not now", () => {
  const at = "2026-08-07T12:00:00Z";
  const recap = seasonRecap(events("badge_embedded", 3, at), "2026-Q3")!;
  assertEquals(recap.seasonKey, "2026-Q3");
  assertEquals(recap.label, "Summer 2026");
  assertEquals(recap.goalsCompleted, 1);
  assertEquals(recap.goalsTotal, SEASON_GOALS.length);
  assertEquals(recap.xpEarned, 3 * REWARD_XP_CATALOG.badge_embedded);
});

Deno.test("seasonRecap names the near miss, and only a real one", () => {
  const at = "2026-08-07T12:00:00Z";
  // 9 of 10 shares — closest unfinished goal.
  const recap = seasonRecap(
    [...events("badge_embedded", 3, at), ...events("verified_share", 9, at)],
    "2026-Q3",
  )!;
  assertEquals(recap.nearMiss?.key, "shares");
  assertEquals(recap.nearMiss?.count, 9);

  // Nothing attempted → no "so close" line to show.
  assertEquals(seasonRecap([], "2026-Q3")!.nearMiss, null);
});

Deno.test("seasonRecap rejects an unknown season", () => {
  assertEquals(seasonRecap([], "2026-Q9"), null);
});

// ── Earned frames ────────────────────────────────────────────────────────────

Deno.test("earnedSeasonFrames walks only the seasons the log spans", () => {
  const q2 = "2026-05-10T12:00:00Z";
  const q4 = "2026-11-10T12:00:00Z";
  const log = [
    ...events("badge_embedded", 3, q2),
    ...events("verified_share", 10, q2),
    ...events("badge_embedded", 3, q4),
    ...events("verified_share", 10, q4),
    // Q3: one goal only — not enough for a frame.
    ...events("badge_embedded", 3, "2026-08-07T12:00:00Z"),
  ];
  assertEquals(earnedSeasonFrames(log), ["season:2026-Q2", "season:2026-Q4"]);
});

Deno.test("earnedSeasonFrames is empty for an empty log", () => {
  assertEquals(earnedSeasonFrames([]), []);
});

Deno.test("an earned season frame survives its own season", () => {
  const q1 = "2026-02-10T12:00:00Z";
  const log = [...events("badge_embedded", 3, q1), ...events("verified_share", 10, q1)];
  // Read the same log much later — the frame is still derivable.
  assertEquals(earnedSeasonFrames(log), ["season:2026-Q1"]);
  assertEquals(seasonRecap(log, "2026-Q1")!.frameEarned, true);
});
