// US-1851: quarterly seasons — timezone-correct windows, the goal reducer, and
// the recap builder.
//
// Env-then-dynamic-import: the module pulls in lib/supabase.ts through the
// rewards engine, which throws at import when SUPABASE_URL is unset.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

import { assert, assertEquals } from "@std/assert";

const {
  SEASON_GOALS,
  buildSeasonRecap,
  computeSeasonProgress,
  normalizeSeasonTimezone,
  previousSeason,
  seasonElapsedFraction,
  seasonForInstant,
} = await import("../lib/rewards-seasons.ts");

const CHI = "America/Chicago";

// ── Season windows ───────────────────────────────────────────────────────────

Deno.test("a mid-quarter instant resolves to that quarter", () => {
  const s = seasonForInstant(Date.parse("2026-08-07T12:00:00Z"), CHI);
  assertEquals(s.key, "2026-Q3");
  assertEquals(s.label, "Q3 2026");
  assertEquals(s.quarter, 3);
  assertEquals(s.year, 2026);
});

Deno.test("season boundaries are LOCAL midnight, not UTC midnight", () => {
  const s = seasonForInstant(Date.parse("2026-08-07T12:00:00Z"), CHI);
  // 1 July 2026 00:00 in Chicago is CDT (UTC-5) → 05:00Z.
  assertEquals(new Date(s.startMs).toISOString(), "2026-07-01T05:00:00.000Z");
  assertEquals(new Date(s.endMs).toISOString(), "2026-10-01T05:00:00.000Z");
});

Deno.test("the Q4→Q1 boundary crosses standard time correctly", () => {
  const q4 = seasonForInstant(Date.parse("2026-11-15T12:00:00Z"), CHI);
  assertEquals(q4.key, "2026-Q4");
  // 1 Oct is CDT (UTC-5); 1 Jan is CST (UTC-6). A naive fixed offset would put
  // one of these an hour out.
  assertEquals(new Date(q4.startMs).toISOString(), "2026-10-01T05:00:00.000Z");
  assertEquals(new Date(q4.endMs).toISOString(), "2027-01-01T06:00:00.000Z");
});

Deno.test("an instant in the UTC-side sliver of a boundary belongs to the LOCAL quarter", () => {
  // 1 July 2026 03:00Z is still 30 June 22:00 in Chicago → Q2, not Q3.
  const s = seasonForInstant(Date.parse("2026-07-01T03:00:00Z"), CHI);
  assertEquals(s.key, "2026-Q2");
});

Deno.test("previousSeason steps back, wrapping the year at Q1", () => {
  const q3 = seasonForInstant(Date.parse("2026-08-07T12:00:00Z"), CHI);
  assertEquals(previousSeason(q3, CHI).key, "2026-Q2");
  const q1 = seasonForInstant(Date.parse("2026-02-07T12:00:00Z"), CHI);
  assertEquals(previousSeason(q1, CHI).key, "2025-Q4");
  // The previous season ends exactly where the current one starts — no gap, no
  // overlap, so no event can land in both or neither.
  assertEquals(previousSeason(q3, CHI).endMs, q3.startMs);
});

Deno.test("an unknown timezone degrades to UTC instead of throwing", () => {
  assertEquals(normalizeSeasonTimezone("Mars/Olympus_Mons"), "UTC");
  assertEquals(normalizeSeasonTimezone(""), "America/Chicago");
  assertEquals(normalizeSeasonTimezone(null), "America/Chicago");
  assertEquals(normalizeSeasonTimezone("Europe/London"), "Europe/London");
  const s = seasonForInstant(Date.parse("2026-08-07T12:00:00Z"), "Mars/Olympus_Mons");
  assertEquals(s.key, "2026-Q3");
});

Deno.test("seasonElapsedFraction clamps at both ends", () => {
  const s = seasonForInstant(Date.parse("2026-08-07T12:00:00Z"), CHI);
  assertEquals(seasonElapsedFraction(s, s.startMs), 0);
  assertEquals(seasonElapsedFraction(s, s.startMs - 86_400_000), 0);
  assertEquals(seasonElapsedFraction(s, s.endMs + 86_400_000), 1);
  assert(seasonElapsedFraction(s, (s.startMs + s.endMs) / 2) > 0.49);
});

// ── Goal reducer ─────────────────────────────────────────────────────────────

const SEASON = seasonForInstant(Date.parse("2026-08-07T12:00:00Z"), CHI);
const MID = Date.parse("2026-08-07T12:00:00Z");

function ev(eventType: string, iso: string, opts: { verified?: boolean; paid?: boolean } = {}) {
  return {
    eventType: eventType as never,
    occurredAt: iso,
    verified: opts.verified ?? true,
    paid: opts.paid ?? true,
  };
}

Deno.test("only events inside the window count toward the season", () => {
  const p = computeSeasonProgress(
    [
      ev("verified_share", "2026-08-01T00:00:00Z"), // in
      ev("verified_share", "2026-06-30T00:00:00Z"), // last season
      ev("verified_share", "2026-11-01T00:00:00Z"), // next season
      ev("verified_share", "not-a-date"), // unparseable
    ],
    SEASON,
    MID,
  );
  const share = p.goals.find((g) => g.key === "share_the_work")!;
  assertEquals(share.current, 1);
  assertEquals(p.xpEarned, 20); // verified_share = 20 XP
});

Deno.test("an unverified event scores nothing — season and XP alike", () => {
  const p = computeSeasonProgress(
    [ev("verified_share", "2026-08-01T00:00:00Z", { verified: false })],
    SEASON,
    MID,
  );
  assertEquals(p.xpEarned, 0);
  assertEquals(p.goals.find((g) => g.key === "share_the_work")!.current, 0);
});

Deno.test("an UNPAID grading-spend event scores nothing (US-1849 AC4 holds here too)", () => {
  const p = computeSeasonProgress(
    [ev("coverage_completed", "2026-08-01T00:00:00Z", { paid: false })],
    SEASON,
    MID,
  );
  assertEquals(p.xpEarned, 0);
  assertEquals(p.goals.find((g) => g.key === "full_coverage")!.current, 0);
});

Deno.test("a goal completes at its target and clamps at 100%", () => {
  const events = Array.from({ length: 12 }, (_, i) =>
    ev("verified_share", `2026-08-0${(i % 9) + 1}T0${i % 10}:00:00Z`));
  const p = computeSeasonProgress(events, SEASON, MID);
  const share = p.goals.find((g) => g.key === "share_the_work")!;
  assertEquals(share.current, 12);
  assertEquals(share.complete, true);
  assertEquals(share.percent, 100);
  assertEquals(p.goalsTotal, SEASON_GOALS.length);
  assertEquals(p.goalsCompleted, 1);
});

Deno.test("the season XP goal reads the season's own XP, not lifetime", () => {
  // 50 badge_embedded events × 50 XP = 2,500 — well over the season XP goal.
  const events = Array.from({ length: 50 }, (_, i) =>
    ev("badge_embedded", `2026-08-01T00:00:${String(i).padStart(2, "0")}Z`));
  const p = computeSeasonProgress(events, SEASON, MID);
  assertEquals(p.xpEarned, 2500);
  assertEquals(p.goals.find((g) => g.key === "season_xp")!.complete, true);
});

Deno.test("every season goal names a real reward metric", () => {
  for (const g of SEASON_GOALS) {
    assert(g.target > 0, `${g.key} has a non-positive target`);
    // A goal keyed on a metric nothing emits is unreachable by construction —
    // the shipped-but-unwired trap. "xp" is the one synthetic metric.
    if (g.metric === "xp") continue;
    const p = computeSeasonProgress(
      [ev(g.metric, "2026-08-01T00:00:00Z")],
      SEASON,
      MID,
    );
    assertEquals(
      p.goals.find((x) => x.key === g.key)!.current,
      1,
      `${g.key} counts nothing — its metric (${g.metric}) is not a scoring reward event`,
    );
  }
});

// ── Recap ────────────────────────────────────────────────────────────────────

Deno.test("a swept season earns the top honour", () => {
  const events = [
    ...Array.from({ length: 15 }, (_, i) =>
      ev("coverage_completed", `2026-08-01T00:${String(i).padStart(2, "0")}:00Z`)),
    ...Array.from({ length: 3 }, (_, i) => ev("badge_embedded", `2026-08-02T0${i}:00:00Z`)),
    ...Array.from({ length: 10 }, (_, i) =>
      ev("verified_share", `2026-08-03T00:${String(i).padStart(2, "0")}:00Z`)),
    ...Array.from({ length: 25 }, (_, i) =>
      ev("aspects_filled", `2026-08-04T00:${String(i).padStart(2, "0")}:00Z`)),
  ];
  const p = computeSeasonProgress(events, SEASON, MID);
  // Sweeping the four ACTION goals must also clear the XP goal — otherwise a
  // seller could finish every task on the track and still not sweep it.
  assertEquals(p.goalsCompleted, p.goalsTotal);

  const recap = buildSeasonRecap(p, 8);
  assertEquals(recap.season_key, "2026-Q3");
  assertEquals(recap.level_at_end, 8);
  assertEquals(recap.tier_at_end, "curator");
  assert(recap.highlights.honours.includes("season_complete"));
  assertEquals(recap.highlights.goals.length, SEASON_GOALS.length);
});

Deno.test("an empty season recaps to nothing earned and no honours", () => {
  const recap = buildSeasonRecap(computeSeasonProgress([], SEASON, MID), 0);
  assertEquals(recap.xp_earned, 0);
  assertEquals(recap.goals_completed, 0);
  assertEquals(recap.highlights.honours, []);
  assertEquals(recap.tier_at_end, "thrifter");
});

Deno.test("a season recap pays only cosmetic honours — never value", () => {
  const events = Array.from({ length: 60 }, (_, i) =>
    ev("badge_embedded", `2026-08-01T00:00:${String(i).padStart(2, "0")}Z`));
  const recap = buildSeasonRecap(computeSeasonProgress(events, SEASON, MID), 12);
  // The whole payout surface is a list of strings. If a future change made a
  // season grant credits or a discount, this shape would have to change first —
  // and a season that resets must reset CLEANLY, which clawing back value isn't.
  for (const h of recap.highlights.honours) {
    assertEquals(typeof h, "string");
  }
  const asRecord = recap as unknown as Record<string, unknown>;
  assertEquals(Object.hasOwn(asRecord, "credits"), false);
  assertEquals(Object.hasOwn(asRecord, "reward_value"), false);
});
