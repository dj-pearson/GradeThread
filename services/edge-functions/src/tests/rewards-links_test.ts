// R6: every rewards notification names the tab that holds what it is about.
//
// The Rewards page opens on "standing". A bare /dashboard/rewards link dropped a
// seller told "Quest complete" onto a tab with no quests on it. These pins read
// the source, so a new notifyUser call with a bare link fails here.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { REWARDS_LINKS } from "../lib/rewards-links.ts";
import {
  comebackCandidate,
  DEFAULT_NUDGE_CONFIG,
  expiringGrantLabel,
  expiringRewardCandidate,
  nudgeLink,
} from "../lib/rewards-nudges.ts";

const TABS = new Set(["standing", "season", "perks"]);

async function sources(dir: string): Promise<Array<{ path: string; text: string }>> {
  const out = [];
  for await (const e of Deno.readDir(new URL(dir, import.meta.url))) {
    if (!e.isFile || !e.name.endsWith(".ts")) continue;
    const url = new URL(dir + e.name, import.meta.url);
    out.push({ path: dir + e.name, text: await Deno.readTextFile(url) });
  }
  return out;
}

Deno.test("R6: every REWARDS_LINKS entry names a real tab", () => {
  for (const [name, href] of Object.entries(REWARDS_LINKS)) {
    const u = new URL(href, "https://x.test");
    assertEquals(u.pathname, "/dashboard/rewards", name);
    assert(TABS.has(u.searchParams.get("tab") ?? ""), `${name} has no valid ?tab=`);
  }
  assertEquals(REWARDS_LINKS.quests, "/dashboard/rewards?tab=season#quests");
  assertEquals(REWARDS_LINKS.milestones, "/dashboard/rewards?tab=season#milestones");
  assertEquals(REWARDS_LINKS.loyalty, "/dashboard/rewards?tab=standing#loyalty");
});

Deno.test("R6: no edge source links to the bare rewards page", async () => {
  const files = [...(await sources("../lib/")), ...(await sources("../routes/"))];
  const bare: string[] = [];
  for (const f of files) {
    if (f.path.endsWith("rewards-links.ts")) continue;
    for (const m of f.text.matchAll(/["'`](\/dashboard\/rewards[^"'`]*)["'`]/g)) {
      if (!/[?&]tab=(standing|season|perks)\b/.test(m[1])) bare.push(`${f.path}: ${m[1]}`);
    }
  }
  assertEquals(bare, [], "use REWARDS_LINKS, which names the tab");
});

Deno.test("R6: each rewards notification points at its own tab", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
  const quests = await read("../lib/rewards-quests.ts");
  assert(/title: "Quest complete"[\s\S]{0,200}link: REWARDS_LINKS\.quests/.test(quests));

  const nudges = await read("../lib/rewards-nudges.ts");
  const linkAfter = (type: string) => {
    const at = nudges.indexOf(`type: "${type}"`);
    assert(at > 0, type);
    return /link: (REWARDS_LINKS\.\w+)/.exec(nudges.slice(at))?.[1];
  };
  assertEquals(linkAfter("badge_near_miss"), "REWARDS_LINKS.badges");
  assertEquals(linkAfter("quest_expiring"), "REWARDS_LINKS.quests");
  assertEquals(linkAfter("quest_new"), "REWARDS_LINKS.quests");
  assertEquals(linkAfter("reward_available"), "REWARDS_LINKS.milestones");
  assertEquals(linkAfter("comeback"), "REWARDS_LINKS.season");

  const tangible = await read("../lib/rewards-tangible.ts");
  assert(tangible.includes("? REWARDS_LINKS.loyalty"), "the anniversary goes to the loyalty card");
  assert(!tangible.includes("celebrate=anniversary"), "nothing reads ?celebrate=");

  const integrity = await read("../lib/buyer-grade-confirmation.ts");
  assert(integrity.includes("link: REWARDS_LINKS.integrity"));
});

Deno.test("R6: a nudge's attribution goes before the anchor, not inside it", () => {
  const link = nudgeLink(REWARDS_LINKS.quests, "abc");
  const u = new URL(link, "https://x.test");
  assertEquals(u.searchParams.get("tab"), "season");
  assertEquals(u.searchParams.get("nudge"), "abc");
  assertEquals(u.hash, "#quests");
});

Deno.test("R6: the built candidates carry the tab links", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const expiring = expiringRewardCandidate(
    [{
      milestoneKey: "pgd_10_off",
      label: "10% off your plan",
      rewardType: "discount",
      rewardValue: 10,
      expiresAt: "2026-09-26T00:00:00.000Z",
    }],
    { ...DEFAULT_NUDGE_CONFIG, rewardExpiringWithinDays: 7 },
    now,
  );
  assertEquals(expiring?.link, REWARDS_LINKS.milestones);
  assertEquals(expiring?.title, "Your 10% off your plan reward expires soon");

  const back = comebackCandidate(
    {
      lastActivityMs: now - 90 * 86_400_000,
      quietDays: 30,
      level: 4,
      tenureLabel: null,
      tenureMonths: 2,
      seasonLabel: "Q3 2026",
      liveQuestCount: 1,
    } as Parameters<typeof comebackCandidate>[0],
    { ...DEFAULT_NUDGE_CONFIG, types: { ...DEFAULT_NUDGE_CONFIG.types, comeback: true } },
    now,
  );
  assertEquals(back?.link, REWARDS_LINKS.season);
});

Deno.test("R6: the expiring nudge names the catalog label, never the raw key", () => {
  const labels = new Map([["pgd_10_off", "10% off your plan"], ["anniversary_gift", "A free grade"]]);
  assertEquals(expiringGrantLabel("pgd_10_off", labels), "10% off your plan");
  assertEquals(expiringGrantLabel("anniversary_gift:y3", labels), "A free grade");
  assert(!expiringGrantLabel("mystery_key", labels).includes("mystery"));
});
