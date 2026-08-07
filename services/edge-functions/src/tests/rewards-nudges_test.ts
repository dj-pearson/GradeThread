// US-1859: the re-engagement nudge policy, exercised without a database.
//
// Everything asserted here is a refusal or a bound. That is deliberate: the
// interesting failures of a nudge system are all "it fired when it shouldn't" —
// a streak reminder for someone with no streak, a near-miss for a badge already
// earned, a second nudge the same day, a lift number computed off a missing
// control arm. A test suite that only proved nudges FIRE would pass on a system
// that spams.

import { assert, assertEquals } from "@std/assert";

// These modules import lib/supabase.ts transitively, which throws at import time
// without env. Set it FIRST, then dynamic-import (a static import would hoist
// above these lines) — the ops-jobs_test.ts pattern. `??` defaults so a real
// value in the shell is never clobbered.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-role-key",
);

const {
  chooseNudge,
  DEFAULT_NUDGE_CONFIG,
  detectStreakRisk,
  evaluateNudgeConsent,
  expiringRewardCandidate,
  isHoldout,
  nearMissCandidate,
  normalizeNudgeConfig,
  NUDGE_TYPES,
  nudgeLink,
  questCandidate,
  scoreConversion,
  summarizeLift,
} = await import("../lib/rewards-nudges.ts");
const { BADGE_CATALOG, nearestBadge } = await import("../lib/rewards-badges.ts");

type NudgeConfig = Awaited<ReturnType<typeof normalizeNudgeConfig>>;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-06T12:00:00Z");

function config(over: Partial<NudgeConfig> = {}): NudgeConfig {
  return { ...DEFAULT_NUDGE_CONFIG, ...over };
}

const EMPTY_BADGE_CTX = {
  gradeCount: 0,
  perfect10Count: 0,
  nwtCount: 0,
  longestStreak: 0,
  shareCount: 0,
  viralFindCount: 0,
  marketplaceCount: 0,
  xpTotal: 0,
  level: 0,
};

// ── Badge catalog invariant ──────────────────────────────────────────────────

Deno.test("US-1859: every badge's progress agrees with its own criteria", () => {
  // The near-miss nudge reads `progress`; the award engine reads `criteria`. If
  // the two ever disagree, someone gets told they are one grade from a badge
  // they already hold — or worse, never told at all. Exercised at, below and
  // above each badge's own target rather than on a fixed grid, so a badge with
  // an unusual threshold is still probed at its boundary.
  for (const badge of BADGE_CATALOG) {
    const target = badge.progress(EMPTY_BADGE_CTX).target;
    assert(target >= 1, `${badge.key}: target must be at least 1`);
    for (const n of [0, 1, target - 1, target, target + 1, target * 2]) {
      if (n < 0) continue;
      // Set EVERY stat to n: each badge reads exactly one of them, so this
      // covers whichever it is without hard-coding the mapping here.
      const ctx = {
        gradeCount: n,
        perfect10Count: n,
        nwtCount: n,
        longestStreak: n,
        shareCount: n,
        viralFindCount: n,
        marketplaceCount: n,
        xpTotal: n,
        level: n,
      };
      const p = badge.progress(ctx);
      assertEquals(
        p.current >= p.target,
        badge.criteria(ctx),
        `${badge.key}: progress (${p.current}/${p.target}) disagrees with criteria at n=${n}`,
      );
    }
  }
});

Deno.test("US-1859: near miss skips earned, hidden and not-yet-started badges", () => {
  const cfg = config({ nearMissMaxRemaining: 3 });

  // 9 grades: one short of grades_10, and grades_10 is the closest.
  const ctx = { ...EMPTY_BADGE_CTX, gradeCount: 9 };
  const miss = nearestBadge(ctx, new Set(), cfg.nearMissMaxRemaining);
  assertEquals(miss?.badge.key, "grades_10");
  assertEquals(miss?.remaining, 1);

  // Already earned → skipped even though the criteria still reads false (the
  // earned set wins, because a badge is kept once earned).
  assertEquals(
    nearestBadge(ctx, new Set(["grades_10"]), cfg.nearMissMaxRemaining)?.badge.key,
    undefined,
    "an earned badge must never be offered as a near miss",
  );

  // A HIDDEN badge one step away must not leak. viral_find has target 1, so a
  // context with zero viral finds is exactly 1 away — the shape that would leak.
  const hiddenish = nearestBadge(
    { ...EMPTY_BADGE_CTX, viralFindCount: 0 },
    new Set(),
    5,
  );
  assertEquals(hiddenish, null, "no zero-progress badge is a near miss, hidden or not");

  // Zero progress on a visible badge is a catalog entry, not a near miss.
  assertEquals(nearestBadge(EMPTY_BADGE_CTX, new Set(), 50), null);
});

Deno.test("US-1859: near-miss candidate is keyed 'once' per badge", () => {
  const c = nearMissCandidate({ ...EMPTY_BADGE_CTX, gradeCount: 9 }, new Set(), config());
  assertEquals(c?.type, "badge_near_miss");
  assertEquals(c?.subjectKey, "grades_10");
  assertEquals(
    c?.periodKey,
    "once",
    "the distance only shrinks, so re-announcing the same near miss weekly is nagging",
  );
});

// ── Streak at risk ───────────────────────────────────────────────────────────

const WEEKS = ["w2026-08-03", "w2026-07-27", "w2026-07-20", "w2026-07-13", "w2026-07-06"];
const THIS_WEEK = WEEKS[0]!;
const PREV = WEEKS.slice(1);

Deno.test("US-1859: streak risk needs a chain, a gap, no freeze, and a deadline", () => {
  const cfg = config({ streakRiskDaysLeft: 3 });

  // The live case: two prior weeks active, this week empty, two days left.
  const live = detectStreakRisk(
    {
      activeWeeks: new Set([PREV[0]!, PREV[1]!]),
      thisWeekKey: THIS_WEEK,
      previousWeekKeys: PREV,
      daysLeftInWeek: 2,
    },
    cfg,
  );
  assert(live.atRisk, "a real two-week chain with an empty current week is at risk");
  assertEquals(live.runWeeks, 2);

  // No chain at all — nothing to lose. This is the one that would turn the
  // notification into noise for every brand-new account.
  assert(
    !detectStreakRisk(
      { activeWeeks: new Set(), thisWeekKey: THIS_WEEK, previousWeekKeys: PREV, daysLeftInWeek: 1 },
      cfg,
    ).atRisk,
  );

  // Already confirmed this week — the chain is safe.
  assert(
    !detectStreakRisk(
      {
        activeWeeks: new Set([THIS_WEEK, PREV[0]!]),
        thisWeekKey: THIS_WEEK,
        previousWeekKeys: PREV,
        daysLeftInWeek: 1,
      },
      cfg,
    ).atRisk,
  );

  // Too early in the week — the grace rule says the current week never breaks a
  // chain by being young, so a Monday warning is premature.
  assert(
    !detectStreakRisk(
      {
        activeWeeks: new Set([PREV[0]!]),
        thisWeekKey: THIS_WEEK,
        previousWeekKeys: PREV,
        daysLeftInWeek: 6,
      },
      cfg,
    ).atRisk,
  );
});

Deno.test("US-1859: a chain with a banked freeze is not at risk", () => {
  // Four consecutive active weeks bank one freeze, which bridges the miss — so
  // the streak genuinely survives and the nudge would be false.
  const four = new Set(PREV.slice(0, 4));
  const verdict = detectStreakRisk(
    {
      activeWeeks: four,
      thisWeekKey: THIS_WEEK,
      previousWeekKeys: PREV,
      daysLeftInWeek: 1,
    },
    config(),
  );
  assertEquals(verdict.runWeeks, 4);
  assertEquals(verdict.bankedFreezes, 1);
  assert(!verdict.atRisk, "a freeze bridges the missed week — nothing is at risk");
});

// ── Quests ───────────────────────────────────────────────────────────────────

const QUEST = {
  key: "weekly_five",
  name: "Grade five items",
  description: "Grade five items this week.",
  quest_type: "personal" as const,
  target: 5,
};
const WINDOW = { periodKey: "w2026-08-03", startMs: NOW - 2 * DAY, endMs: NOW + 5 * DAY };

Deno.test("US-1859: quest_expiring needs progress AND a near deadline", () => {
  const cfg = config({ questExpiringWithinHours: 48 });
  const closing = { ...WINDOW, endMs: NOW + 12 * HOUR };

  const due = questCandidate(
    { quest: QUEST, window: closing, current: 3, complete: false },
    cfg,
    NOW,
  );
  assertEquals(due?.type, "quest_expiring");
  assertEquals(due?.periodKey, closing.periodKey);
  assert(due!.body.includes("3 of 5"));

  // Zero progress at the deadline is a chore reminder, not a nudge.
  assertEquals(
    questCandidate({ quest: QUEST, window: closing, current: 0, complete: false }, cfg, NOW)?.type,
    undefined,
  );
  // Already finished — nothing to say, and saying it would be wrong.
  assertEquals(
    questCandidate({ quest: QUEST, window: closing, current: 5, complete: true }, cfg, NOW),
    null,
  );
  // A window that already closed can never produce a candidate.
  assertEquals(
    questCandidate(
      { quest: QUEST, window: { ...WINDOW, endMs: NOW - HOUR }, current: 2, complete: false },
      cfg,
      NOW,
    ),
    null,
  );
});

Deno.test("US-1859: quest_new only fires inside the opening hours", () => {
  const cfg = config({ questNewWithinHours: 36 });

  const fresh = { ...WINDOW, startMs: NOW - 6 * HOUR, endMs: NOW + 6 * DAY };
  const announced = questCandidate(
    { quest: QUEST, window: fresh, current: 0, complete: false },
    cfg,
    NOW,
  );
  assertEquals(announced?.type, "quest_new");

  // Same quest, four days into its window: an "announcement" nobody would read
  // as one.
  const stale = { ...WINDOW, startMs: NOW - 4 * DAY, endMs: NOW + 3 * DAY };
  assertEquals(
    questCandidate({ quest: QUEST, window: stale, current: 0, complete: false }, cfg, NOW),
    null,
  );
});

Deno.test("US-1859: a community challenge is named as one", () => {
  const c = questCandidate(
    {
      quest: { ...QUEST, quest_type: "community" },
      window: { ...WINDOW, startMs: NOW - HOUR },
      current: 0,
      complete: false,
    },
    config(),
    NOW,
  );
  assert(c!.title.startsWith("New challenge:"), `got: ${c!.title}`);
});

// ── Expiring rewards ─────────────────────────────────────────────────────────

Deno.test("US-1859: reward_available takes the soonest real deadline only", () => {
  const cfg = config({ rewardExpiringWithinDays: 10 });
  const grants = [
    // No expiry at all: granted credits already landed, so there is no deadline
    // to warn about and nothing to claim.
    { milestoneKey: "credits", label: "credits", rewardType: "free_grade_credits", rewardValue: 3, expiresAt: null },
    { milestoneKey: "far", label: "far", rewardType: "per_grade_discount", rewardValue: 20, expiresAt: new Date(NOW + 40 * DAY).toISOString() },
    { milestoneKey: "soon", label: "soon", rewardType: "per_grade_discount", rewardValue: 20, expiresAt: new Date(NOW + 3 * DAY).toISOString() },
    { milestoneKey: "gone", label: "gone", rewardType: "per_grade_discount", rewardValue: 20, expiresAt: new Date(NOW - DAY).toISOString() },
  ];
  const c = expiringRewardCandidate(grants, cfg, NOW);
  assertEquals(c?.subjectKey, "soon");
  assert(c!.body.includes("3 days"));
  // The period key is the expiry date, so the SAME deadline can never nudge twice.
  assertEquals(c?.periodKey, new Date(NOW + 3 * DAY).toISOString().slice(0, 10));

  assertEquals(expiringRewardCandidate([grants[0]!, grants[3]!], cfg, NOW), null);
});

// ── Ranking + frequency cap ──────────────────────────────────────────────────

const STREAK = {
  type: "streak_at_risk" as const,
  subjectKey: "streak",
  periodKey: THIS_WEEK,
  title: "t",
  body: "b",
  link: "/buyer/rewards",
};
const NEAR = {
  type: "badge_near_miss" as const,
  subjectKey: "grades_10",
  periodKey: "once",
  title: "t",
  body: "b",
  link: "/dashboard/rewards",
};

Deno.test("US-1859: exactly one nudge, ranked by urgency", () => {
  const d = chooseNudge([NEAR, STREAK], [], config(), NOW);
  assertEquals(d.action, "send");
  assertEquals(
    d.action === "send" ? d.candidate.type : null,
    "streak_at_risk",
    "a deadline the user can still act on outranks an open-ended near miss",
  );
});

Deno.test("US-1859: a subject already nudged for this window is not re-sent", () => {
  const recent = [
    { nudgeType: "streak_at_risk", subjectKey: "streak", periodKey: THIS_WEEK, sentAtMs: NOW - 20 * DAY },
  ];
  const d = chooseNudge([STREAK], recent, config(), NOW);
  assertEquals(d.action, "skip");
  assertEquals(d.action === "skip" ? d.reason : null, "no_candidate");
});

Deno.test("US-1859: a stale repeat candidate does not consume the weekly budget", () => {
  // The regression this guards: filtering AFTER the cap would let one permanently
  // -deduped candidate report the user as capped forever, so they would never see
  // any other nudge again.
  const recent = [
    { nudgeType: "streak_at_risk", subjectKey: "streak", periodKey: THIS_WEEK, sentAtMs: NOW - 20 * DAY },
  ];
  const d = chooseNudge([STREAK, NEAR], recent, config({ maxPerWeek: 1 }), NOW);
  assertEquals(d.action, "send");
  assertEquals(d.action === "send" ? d.candidate.type : null, "badge_near_miss");
});

Deno.test("US-1859: the weekly cap and the minimum gap both bite", () => {
  const cfg = config({ maxPerWeek: 2, minHoursBetween: 48 });

  // Two sends inside the last seven days → capped.
  const capped = chooseNudge([NEAR], [
    { nudgeType: "quest_new", subjectKey: "q1", periodKey: "w1", sentAtMs: NOW - 2 * DAY },
    { nudgeType: "quest_new", subjectKey: "q2", periodKey: "w1", sentAtMs: NOW - 5 * DAY },
  ], cfg, NOW);
  assertEquals(capped.action === "skip" ? capped.reason : null, "capped_week");

  // One send, but only six hours ago → the gap bites instead.
  const tooSoon = chooseNudge([NEAR], [
    { nudgeType: "quest_new", subjectKey: "q1", periodKey: "w1", sentAtMs: NOW - 6 * HOUR },
  ], cfg, NOW);
  assertEquals(tooSoon.action === "skip" ? tooSoon.reason : null, "capped_gap");

  // Old sends fall out of the window entirely.
  const clear = chooseNudge([NEAR], [
    { nudgeType: "quest_new", subjectKey: "q1", periodKey: "w1", sentAtMs: NOW - 30 * DAY },
    { nudgeType: "quest_new", subjectKey: "q2", periodKey: "w1", sentAtMs: NOW - 40 * DAY },
  ], cfg, NOW);
  assertEquals(clear.action, "send");
});

Deno.test("US-1859: the kill-switch and per-type switches are real", () => {
  const off = chooseNudge([STREAK, NEAR], [], config({ enabled: false }), NOW);
  assertEquals(off.action === "skip" ? off.reason : null, "disabled");

  const typed = config();
  typed.types = { ...typed.types, streak_at_risk: false };
  const d = chooseNudge([STREAK, NEAR], [], typed, NOW);
  assertEquals(d.action === "send" ? d.candidate.type : null, "badge_near_miss");

  // maxPerWeek 0 means "send nothing", not "send unbounded".
  const zero = chooseNudge([STREAK], [], config({ maxPerWeek: 0 }), NOW);
  assertEquals(zero.action === "skip" ? zero.reason : null, "capped_week");
});

// ── Holdout ──────────────────────────────────────────────────────────────────

Deno.test("US-1859: holdout assignment is stable and roughly proportional", () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `user-${i}-e2b1c4d6`);

  // Stability is the property that matters most: a user randomly held out one
  // day and nudged the next belongs to neither arm and pollutes both.
  for (const id of ids.slice(0, 50)) {
    assertEquals(isHoldout(id, 10), isHoldout(id, 10), `${id} flipped between calls`);
  }

  const held = ids.filter((id) => isHoldout(id, 10)).length;
  const pct = (held / ids.length) * 100;
  assert(pct > 6 && pct < 15, `10% holdout landed at ${pct.toFixed(1)}% — not uniform enough`);

  // 0 disables it entirely; the cap keeps a fat-fingered setting from holding
  // back most of the user base.
  assertEquals(ids.filter((id) => isHoldout(id, 0)).length, 0);
  const capped = ids.filter((id) => isHoldout(id, 500)).length / ids.length * 100;
  assert(capped <= 55, `holdout must be capped at 50%, got ${capped.toFixed(1)}%`);
});

// ── Consent ──────────────────────────────────────────────────────────────────

Deno.test("US-1859: consent honors the dedicated toggle, the umbrella and stop-suppressions", () => {
  const ok = evaluateNudgeConsent({}, null);
  assert(ok.allowed, "absence means enabled — the product-wide opt-out model");
  assertEquals(ok.channels, ["in_app", "push"]);

  // The dedicated category, both channels off.
  assertEquals(
    evaluateNudgeConsent({ reward_nudges: { in_app: false, push: false } }, null).reason,
    "pref_off",
  );
  // One channel off narrows delivery rather than blocking it.
  const pushOnly = evaluateNudgeConsent({ reward_nudges: { in_app: false } }, null);
  assert(pushOnly.allowed);
  assertEquals(pushOnly.channels, ["push"]);

  // The marketing umbrella — a nudge IS re-engagement messaging.
  assertEquals(
    evaluateNudgeConsent({ marketing: { email: false } }, null).reason,
    "marketing_opt_out",
  );

  // A COMPLAINT or a global unsubscribe means stop, on every channel…
  for (const reason of ["complaint", "unsubscribe_all"]) {
    assertEquals(evaluateNudgeConsent({}, reason).reason, "suppressed", reason);
  }
  // …but a hard bounce is a fact about one mailbox and says nothing about
  // in-app or push, which is all this surface uses.
  assert(
    evaluateNudgeConsent({}, "hard_bounce").allowed,
    "a bounced address must not silence in-app notifications",
  );
});

// ── Attribution ──────────────────────────────────────────────────────────────

Deno.test("US-1859: conversion counts the first signal strictly inside the window", () => {
  const cfg = config({ attributionWindowDays: 7 });
  const sent = NOW;
  const signals = [
    { occurredAtMs: sent - HOUR, kind: "before" },
    { occurredAtMs: sent + 3 * DAY, kind: "coverage_completed" },
    { occurredAtMs: sent + 2 * DAY, kind: "grade_confirmed" },
    { occurredAtMs: sent + 30 * DAY, kind: "way_after" },
  ];
  const v = scoreConversion(sent, signals, cfg, sent + 10 * DAY);
  assert(v.converted);
  assertEquals(v.kind, "grade_confirmed", "the FIRST in-window signal wins");
  assert(v.windowClosed);

  // A signal that predates the nudge cannot have been caused by it.
  const none = scoreConversion(sent, [signals[0]!], cfg, sent + DAY);
  assert(!none.converted);
  assert(!none.windowClosed);
});

Deno.test("US-1859: lift is null without a control arm, never the raw rate", () => {
  const rows = [
    // 3 of 4 nudged converted; 1 of 4 held out converted → +50pp.
    { nudge_type: "streak_at_risk", holdout: false, converted_at: "x", clicked_at: "c" },
    { nudge_type: "streak_at_risk", holdout: false, converted_at: "x", clicked_at: null },
    { nudge_type: "streak_at_risk", holdout: false, converted_at: "x", clicked_at: null },
    { nudge_type: "streak_at_risk", holdout: false, converted_at: null, clicked_at: null },
    { nudge_type: "streak_at_risk", holdout: true, converted_at: "x", clicked_at: null },
    { nudge_type: "streak_at_risk", holdout: true, converted_at: null, clicked_at: null },
    { nudge_type: "streak_at_risk", holdout: true, converted_at: null, clicked_at: null },
    { nudge_type: "streak_at_risk", holdout: true, converted_at: null, clicked_at: null },
    // A type with no holdout rows at all.
    { nudge_type: "quest_new", holdout: false, converted_at: "x", clicked_at: null },
    { nudge_type: "quest_new", holdout: false, converted_at: null, clicked_at: null },
  ];
  const [quest, streak] = summarizeLift(rows);

  assertEquals(streak!.nudge_type, "streak_at_risk");
  assertEquals(streak!.sent, 4);
  assertEquals(streak!.sent_converted, 3);
  assertEquals(streak!.sent_clicked, 1);
  assertEquals(streak!.holdout, 4);
  assertEquals(streak!.holdout_converted, 1);
  assertEquals(streak!.lift_pp, 50);

  assertEquals(quest!.nudge_type, "quest_new");
  assertEquals(
    quest!.lift_pp,
    null,
    "a missing control arm is not a control that measured zero — reporting 50% " +
      "here would be reporting the treated rate as lift",
  );
});

// ── Config + links ───────────────────────────────────────────────────────────

Deno.test("US-1859: config normalization clamps and never throws", () => {
  assertEquals(normalizeNudgeConfig(null), DEFAULT_NUDGE_CONFIG);
  assertEquals(normalizeNudgeConfig("nonsense"), DEFAULT_NUDGE_CONFIG);

  const wild = normalizeNudgeConfig({
    enabled: "yes",
    types: { streak_at_risk: false, bogus: true },
    max_per_week: 9999,
    min_hours_between: -5,
    holdout_pct: 99,
    attribution_window_days: 0,
  });
  assertEquals(wild.enabled, true, "a non-boolean falls back rather than disabling the feature");
  assertEquals(wild.types.streak_at_risk, false);
  assertEquals(wild.types.quest_new, true, "unlisted types keep their default");
  assertEquals(wild.maxPerWeek, 14);
  assertEquals(wild.minHoursBetween, 0);
  assertEquals(wild.holdoutPct, 50, "holdout is capped so a typo cannot mute the product");
  assertEquals(wild.attributionWindowDays, 1);

  // Every declared type has a switch — a type with no entry could never be
  // turned off.
  for (const t of NUDGE_TYPES) {
    assertEquals(typeof DEFAULT_NUDGE_CONFIG.types[t], "boolean", t);
  }
});

Deno.test("US-1859: the deep link carries the send id and the campaign", () => {
  const link = nudgeLink("/dashboard/rewards", "abc-123");
  assert(link.includes("?nudge=abc-123"));
  assert(link.includes("utm_campaign=reward_nudge"));

  // An existing query string is preserved, not clobbered.
  assert(nudgeLink("/dashboard/rewards?tab=quests", "abc").includes("?tab=quests&nudge=abc"));

  // No id (the claim came back without one) → a plain link, never a broken one.
  assertEquals(nudgeLink("/dashboard/rewards", null), "/dashboard/rewards");
});
