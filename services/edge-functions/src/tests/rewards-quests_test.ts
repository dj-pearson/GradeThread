// US-1852: quests — windows, predicates, and the payout ceiling.
//
// The properties worth proving are the ones an operator can get wrong from the
// admin form: a window that does not tile the calendar (so a quest pays twice or
// never), a criteria key this build has never heard of, and a payout typo. All
// three are handled here rather than trusted.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  clampQuestXp,
  computeQuestBoard,
  computeQuestProgress,
  QUEST_CRITERIA,
  QUEST_XP_MAX,
  questDefinitionFromRow,
  questWindow,
} = await import("../lib/rewards-quests.ts");
const { QUEST_XP_CEILING, REWARD_XP_CATALOG, xpForEvent } = await import(
  "../lib/rewards-engine.ts"
);

type Def = Parameters<typeof questWindow>[0];
type Ev = Parameters<typeof computeQuestBoard>[1][number];

const ms = (iso: string) => Date.parse(iso);

function def(over: Partial<Def> = {}): Def {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    questKey: "grade_3",
    title: "Grade 3 items this week",
    description: "",
    criteriaKey: "grade_items",
    target: 3,
    xpReward: 40,
    scope: "personal",
    windowKind: "weekly",
    startsAt: null,
    endsAt: null,
    enabled: true,
    sortOrder: 0,
    ...over,
  };
}

function events(type: Ev["eventType"], n: number, at: string, paid = true): Ev[] {
  return Array.from({ length: n }, () => ({
    eventType: type,
    occurredAt: at,
    verified: true,
    paid,
  }));
}

// ── The payout ceiling ───────────────────────────────────────────────────────

Deno.test("the two copies of the ceiling agree", () => {
  // One lives beside the clamp, the other beside xpForEvent. They are separate
  // so neither module has to import the other; a drift between them would mean
  // a quest that writes more than it is later scored at.
  assertEquals(QUEST_XP_MAX, QUEST_XP_CEILING);
});

Deno.test("clampQuestXp bounds an operator typo", () => {
  assertEquals(clampQuestXp(40), 40);
  assertEquals(clampQuestXp(500_000), QUEST_XP_MAX);
  assertEquals(clampQuestXp(-10), 0);
  assertEquals(clampQuestXp(Number.NaN), 0);
  assertEquals(clampQuestXp(12.9), 12);
});

Deno.test("xpForEvent honours a quest magnitude and re-clamps it", () => {
  assertEquals(xpForEvent("quest_completed", { magnitude: 40 }), 40);
  assertEquals(xpForEvent("quest_completed", { magnitude: 999_999 }), QUEST_XP_CEILING);
  assertEquals(xpForEvent("quest_completed", { magnitude: -5 }), 0);
  // No magnitude → the catalog floor, which is 0.
  assertEquals(xpForEvent("quest_completed"), REWARD_XP_CATALOG.quest_completed);
});

Deno.test("a magnitude on any OTHER type is ignored", () => {
  // Otherwise a metadata field an attacker might influence becomes an XP dial.
  assertEquals(xpForEvent("badge_embedded", { magnitude: 999 }), REWARD_XP_CATALOG.badge_embedded);
  assertEquals(xpForEvent("aspects_filled", { magnitude: 999 }), REWARD_XP_CATALOG.aspects_filled);
  assertEquals(xpForEvent("coverage_completed", { paid: true, magnitude: 999 }), 25);
});

Deno.test("an unverified quest completion still earns nothing", () => {
  assertEquals(xpForEvent("quest_completed", { verified: false, magnitude: 200 }), 0);
});

// ── Windows ──────────────────────────────────────────────────────────────────

Deno.test("a weekly window is Monday-anchored and seven days wide", () => {
  // 2026-08-07 is a Friday; its Monday is 2026-08-03.
  const w = questWindow(def(), ms("2026-08-07T16:00:00Z"))!;
  assertEquals(w.startIso, "2026-08-03T04:00:00.000Z"); // midnight ET
  assertEquals(w.endIso, "2026-08-10T04:00:00.000Z");
  assertEquals(w.instanceKey, "grade_3:2026-08-03");
});

Deno.test("consecutive weekly windows abut with no gap or overlap", () => {
  const a = questWindow(def(), ms("2026-08-07T16:00:00Z"))!;
  const b = questWindow(def(), ms("2026-08-12T16:00:00Z"))!;
  assertEquals(a.endMs, b.startMs);
  assert(a.instanceKey !== b.instanceKey, "next week must be a fresh dedupe key");
});

Deno.test("a weekly window survives the DST change inside it", () => {
  // US clocks move on 2026-11-01. The Monday of that week is 2026-10-26 (EDT),
  // and the window must still end on the following Monday's local midnight (EST)
  // rather than an hour out.
  const w = questWindow(def(), ms("2026-11-04T16:00:00Z"))!;
  assertEquals(w.startIso, "2026-11-02T05:00:00.000Z"); // EST midnight (UTC-5)
  const prev = questWindow(def(), ms("2026-10-28T16:00:00Z"))!;
  assertEquals(prev.startIso, "2026-10-26T04:00:00.000Z"); // EDT midnight
  assertEquals(prev.endMs, w.startMs); // still exactly abutting across the shift
});

Deno.test("a monthly window covers its own calendar month", () => {
  const w = questWindow(def({ windowKind: "monthly" }), ms("2026-08-07T16:00:00Z"))!;
  assertEquals(w.startIso, "2026-08-01T04:00:00.000Z");
  assertEquals(w.endIso, "2026-09-01T04:00:00.000Z");
});

Deno.test("a monthly window rolls the year at December", () => {
  const w = questWindow(def({ windowKind: "monthly" }), ms("2026-12-15T16:00:00Z"))!;
  assertEquals(w.endIso, "2027-01-01T05:00:00.000Z");
});

Deno.test("a fixed window runs only between its own bounds", () => {
  const d = def({
    windowKind: "fixed",
    startsAt: "2026-08-01T00:00:00Z",
    endsAt: "2026-09-01T00:00:00Z",
  });
  assert(questWindow(d, ms("2026-08-15T00:00:00Z")));
  assertEquals(questWindow(d, ms("2026-07-31T23:59:59Z")), null);
  // Half-open: the end instant is already outside.
  assertEquals(questWindow(d, ms("2026-09-01T00:00:00Z")), null);
});

Deno.test("a fixed window with missing bounds never runs", () => {
  assertEquals(questWindow(def({ windowKind: "fixed" }), ms("2026-08-07T00:00:00Z")), null);
  assertEquals(
    questWindow(def({ windowKind: "fixed", startsAt: "nope", endsAt: "nope" }), Date.now()),
    null,
  );
});

Deno.test("an operator window switches a repeating quest off", () => {
  const d = def({ endsAt: "2026-08-01T00:00:00Z" });
  assertEquals(questWindow(d, ms("2026-08-07T16:00:00Z")), null);
  const later = def({ startsAt: "2026-12-01T00:00:00Z" });
  assertEquals(questWindow(later, ms("2026-08-07T16:00:00Z")), null);
});

// ── Progress ─────────────────────────────────────────────────────────────────

Deno.test("only in-window, XP-earning events count", () => {
  const now = ms("2026-08-07T16:00:00Z");
  const p = computeQuestProgress(
    def(),
    [
      ...events("coverage_completed", 2, "2026-08-05T12:00:00Z"), // in window, paid
      ...events("coverage_completed", 5, "2026-07-20T12:00:00Z"), // last month
      ...events("badge_embedded", 9, "2026-08-05T12:00:00Z"), // wrong criteria
    ],
    now,
  )!;
  assertEquals(p.count, 2);
  assertEquals(p.target, 3);
  assertEquals(p.complete, false);
  assertEquals(p.pct, 67);
});

Deno.test("the paid gate still holds inside a quest", () => {
  const now = ms("2026-08-07T16:00:00Z");
  const unpaid = computeQuestProgress(
    def(),
    events("coverage_completed", 10, "2026-08-05T12:00:00Z", false),
    now,
  )!;
  assertEquals(unpaid.count, 0);
  assertEquals(unpaid.complete, false);
});

Deno.test("an unverified event never ticks a quest", () => {
  const now = ms("2026-08-07T16:00:00Z");
  const evs: Ev[] = Array.from({ length: 5 }, () => ({
    eventType: "verified_share",
    occurredAt: "2026-08-05T12:00:00Z",
    verified: false,
  }));
  const p = computeQuestProgress(def({ criteriaKey: "share_grades", target: 1 }), evs, now)!;
  assertEquals(p.count, 0);
});

Deno.test("a completed quest reports its clamped payout", () => {
  const now = ms("2026-08-07T16:00:00Z");
  const p = computeQuestProgress(
    def({ xpReward: 10_000 }),
    events("coverage_completed", 3, "2026-08-05T12:00:00Z"),
    now,
  )!;
  assertEquals(p.complete, true);
  assertEquals(p.pct, 100);
  assertEquals(p.xpReward, QUEST_XP_MAX);
});

Deno.test("a disabled quest is not scored at all", () => {
  assertEquals(
    computeQuestProgress(def({ enabled: false }), [], ms("2026-08-07T16:00:00Z")),
    null,
  );
});

Deno.test("an unknown criteria key is ignored, not thrown", () => {
  // A code rollback below a quest's criteria must not take the whole board down.
  assertEquals(
    computeQuestProgress(def({ criteriaKey: "from_the_future" }), [], ms("2026-08-07T16:00:00Z")),
    null,
  );
});

Deno.test("a target of zero cannot make everything instantly complete", () => {
  const p = computeQuestProgress(def({ target: 0 }), [], ms("2026-08-07T16:00:00Z"))!;
  assertEquals(p.target, 1);
  assertEquals(p.complete, false);
});

Deno.test("computeQuestBoard drops the quests that are not running", () => {
  const now = ms("2026-08-07T16:00:00Z");
  const board = computeQuestBoard(
    [
      def(),
      def({ questKey: "off", enabled: false }),
      def({ questKey: "later", startsAt: "2027-01-01T00:00:00Z" }),
      def({ questKey: "bogus", criteriaKey: "nope" }),
    ],
    events("coverage_completed", 3, "2026-08-05T12:00:00Z"),
    now,
  );
  assertEquals(board.map((q) => q.questKey), ["grade_3"]);
});

Deno.test("every criteria key maps to an event type the catalog scores", () => {
  for (const [key, c] of Object.entries(QUEST_CRITERIA)) {
    assert(
      REWARD_XP_CATALOG[c.eventType] !== undefined,
      `criteria ${key} points at an unscored event type`,
    );
    assert(c.label.length > 0);
  }
});

Deno.test("quest_completed is not itself a quest criteria", () => {
  // A quest that counted quest completions would pay for being paid.
  for (const c of Object.values(QUEST_CRITERIA)) {
    assert(c.eventType !== "quest_completed", "a quest cannot be its own criteria");
  }
});

// ── Row mapping ──────────────────────────────────────────────────────────────

Deno.test("questDefinitionFromRow tolerates a half-filled row", () => {
  const d = questDefinitionFromRow({ id: "x", quest_key: "k", criteria_key: "grade_items" });
  assertEquals(d.scope, "personal");
  assertEquals(d.windowKind, "weekly");
  assertEquals(d.enabled, false); // fail-closed on anything but a literal true
  assertEquals(d.startsAt, null);
  assertEquals(d.target, 0);
});

Deno.test("questDefinitionFromRow maps a full row", () => {
  const d = questDefinitionFromRow({
    id: "x",
    quest_key: "k",
    title: "T",
    description: "D",
    criteria_key: "share_grades",
    target: 10,
    xp_reward: 50,
    scope: "community",
    window_kind: "fixed",
    starts_at: "2026-08-01T00:00:00Z",
    ends_at: "2026-09-01T00:00:00Z",
    enabled: true,
    sort_order: 3,
  });
  assertEquals(d.scope, "community");
  assertEquals(d.windowKind, "fixed");
  assertEquals(d.enabled, true);
  assertEquals(d.xpReward, 50);
});

// ── The recursion guard ──────────────────────────────────────────────────────

Deno.test("grantReward does not re-enter quest evaluation on a quest payout", async () => {
  // PIN: a quest payout is itself a grantReward call. Without the type check the
  // evaluator would call itself forever on the first completed quest.
  const src = await Deno.readTextFile(new URL("../lib/rewards-engine.ts", import.meta.url));
  assert(
    /eventType\s*!==\s*"quest_completed"/.test(src),
    "grantReward must skip quest evaluation when paying a quest",
  );
});

Deno.test("the quest surface is fail-closed behind its flag", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/rewards-quests-award.ts", import.meta.url),
  );
  assert(
    /defaultEnabled:\s*false/.test(src),
    "quests must read their flag fail-closed, like the tangible rail",
  );
});
