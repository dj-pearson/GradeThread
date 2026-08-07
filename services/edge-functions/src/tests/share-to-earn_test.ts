// US-1854: the share-to-earn loop — pure policy. No DB.
//
// share-to-earn.ts pulls in lib/supabase.ts, which throws at import unless the
// service env is set, so the env dance comes FIRST and the import is dynamic.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  certIdFromLandingPath,
  dayWindowStart,
  isLikelyBotUserAgent,
  isShareTargetType,
  isViralShareMilestone,
  milestonesForClicks,
  nextShareMilestone,
  normalizeShareChannel,
  SHARE_CLICK_SOURCES,
  SHARE_MILESTONES,
  SHARE_SIGNUP_MILESTONE,
  visitorFingerprint,
} = await import("../lib/share-to-earn.ts");

const { QUEST_XP_MAX, xpForEvent } = await import("../lib/rewards-engine.ts");

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ─── The ladder ──────────────────────────────────────────────────────────────

Deno.test("the ladder escalates and its thresholds ascend", () => {
  for (let i = 1; i < SHARE_MILESTONES.length; i++) {
    assert(
      SHARE_MILESTONES[i]!.clicks > SHARE_MILESTONES[i - 1]!.clicks,
      "click thresholds must ascend",
    );
    assert(
      SHARE_MILESTONES[i]!.xp > SHARE_MILESTONES[i - 1]!.xp,
      "a later rung must pay more — a flat ladder is not an escalation",
    );
  }
});

Deno.test("every rung is inside the variable-XP ceiling", () => {
  // A hand-written event row cannot out-earn the catalog: clampQuestXp caps the
  // frozen award, so a rung above the ceiling would silently pay less than the
  // ladder advertises.
  for (const m of [...SHARE_MILESTONES, SHARE_SIGNUP_MILESTONE]) {
    assert(m.xp > 0 && m.xp <= QUEST_XP_MAX, `${m.key} outside 1..${QUEST_XP_MAX}`);
  }
});

Deno.test("rungs are reached by click count, cumulatively", () => {
  assertEquals(milestonesForClicks(0).map((m) => m.key), []);
  assertEquals(milestonesForClicks(2).map((m) => m.key), []);
  assertEquals(milestonesForClicks(3).map((m) => m.key), ["spark"]);
  assertEquals(milestonesForClicks(10).map((m) => m.key), ["spark", "buzz"]);
  assertEquals(
    milestonesForClicks(1000).map((m) => m.key),
    ["spark", "buzz", "viral"],
  );
  assertEquals(milestonesForClicks(Number.NaN), []);
});

Deno.test("nextShareMilestone points at the next rung, then nowhere", () => {
  assertEquals(nextShareMilestone(0)?.key, "spark");
  assertEquals(nextShareMilestone(3)?.key, "buzz");
  assertEquals(nextShareMilestone(24)?.key, "viral");
  assertEquals(nextShareMilestone(25), null);
});

Deno.test("only the top rung or a signup makes a find viral", () => {
  assert(isViralShareMilestone("viral"));
  assert(isViralShareMilestone(SHARE_SIGNUP_MILESTONE.key));
  assert(!isViralShareMilestone("spark"));
  assert(!isViralShareMilestone("buzz"));
});

Deno.test("a share_milestone's XP rides the event, not the catalog", () => {
  // The catalog constant is 0 — the amount is frozen into metadata at grant
  // time (award_xp) and clamped, exactly like a quest.
  assertEquals(xpForEvent("share_milestone", { xpAward: 60 }), 60);
  assertEquals(xpForEvent("share_milestone"), 0);
  assertEquals(xpForEvent("share_milestone", { xpAward: 9_999 }), QUEST_XP_MAX);
  // Unverified scores nothing, like every other event.
  assertEquals(xpForEvent("share_milestone", { xpAward: 60, verified: false }), 0);
});

// ─── Fraud gates (AC2) ───────────────────────────────────────────────────────

Deno.test("the bot gate fails CLOSED on a missing or short agent", () => {
  assert(isLikelyBotUserAgent(null));
  assert(isLikelyBotUserAgent(undefined));
  assert(isLikelyBotUserAgent(""));
  assert(isLikelyBotUserAgent("curl"));
});

Deno.test("link unfurlers and crawlers are not clicks", () => {
  for (
    const ua of [
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Twitterbot/1.0",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "WhatsApp/2.19.81 A",
      "Discordbot/2.0 (+https://discordapp.com)",
      "python-requests/2.31.0",
      "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0",
    ]
  ) {
    assert(isLikelyBotUserAgent(ua), `${ua} should not count as a human click`);
  }
});

Deno.test("an ordinary browser is a click", () => {
  assert(!isLikelyBotUserAgent(CHROME));
  assert(
    !isLikelyBotUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    ),
  );
});

Deno.test("no trustworthy IP means no fingerprint (fail-closed)", async () => {
  assertEquals(await visitorFingerprint(null, CHROME), null);
  assertEquals(await visitorFingerprint(undefined, CHROME), null);
  assertEquals(await visitorFingerprint("", CHROME), null);
});

Deno.test("the fingerprint is stable, salted and distinguishing", async () => {
  const a = await visitorFingerprint("1.2.3.4", CHROME);
  const again = await visitorFingerprint("1.2.3.4", CHROME);
  const otherIp = await visitorFingerprint("5.6.7.8", CHROME);
  const otherUa = await visitorFingerprint("1.2.3.4", `${CHROME} Edg/126`);

  assert(a && a.length === 32, "expected a 32-char hex handle");
  assertEquals(a, again, "same visitor must hash the same");
  assert(a !== otherIp, "a different IP must hash differently");
  assert(a !== otherUa, "a different agent must hash differently");
  // Not reversible to the input: the raw IP never appears in the handle.
  assert(!a.includes("1234"));
});

// ─── Inputs ──────────────────────────────────────────────────────────────────

Deno.test("only known share channels are accepted", () => {
  assertEquals(normalizeShareChannel("X"), "x");
  assertEquals(normalizeShareChannel(" native "), "native");
  assertEquals(normalizeShareChannel("myspace"), null);
  assertEquals(normalizeShareChannel(42), null);
  assertEquals(normalizeShareChannel(null), null);
});

Deno.test("cert is the only share target type today", () => {
  assert(isShareTargetType("cert"));
  assert(!isShareTargetType("seller"));
  assert(!isShareTargetType(undefined));
});

Deno.test("the share click source is the one the cert link carries", () => {
  assert(SHARE_CLICK_SOURCES.has("share"));
  assert(!SHARE_CLICK_SOURCES.has("embed"));
});

Deno.test("a signup is attributed to the find by its landing path", () => {
  assertEquals(certIdFromLandingPath("/cert/GT-ABC123"), "GT-ABC123");
  assertEquals(certIdFromLandingPath("/cert/GT-ABC123/"), "GT-ABC123");
  assertEquals(certIdFromLandingPath("/cert/GT-ABC123?s=share&ref=X"), "GT-ABC123");
  // Anything that isn't a certificate page attributes to no find at all.
  assertEquals(certIdFromLandingPath("/"), null);
  assertEquals(certIdFromLandingPath("/dashboard"), null);
  assertEquals(certIdFromLandingPath("/cert/"), null);
  assertEquals(certIdFromLandingPath("/cert/a/b"), null);
  assertEquals(certIdFromLandingPath(null), null);
});

Deno.test("the daily counter window is a UTC day floor", () => {
  const a = dayWindowStart(Date.parse("2026-08-07T00:00:00Z"));
  const b = dayWindowStart(Date.parse("2026-08-07T23:59:59Z"));
  assertEquals(a, b, "the same UTC day must share one bucket");
  assertEquals(a, "2026-08-07T00:00:00.000Z");
  assert(a !== dayWindowStart(Date.parse("2026-08-08T00:00:00Z")));
});
