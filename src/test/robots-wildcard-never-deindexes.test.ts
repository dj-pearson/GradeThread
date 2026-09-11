// US-3383 AC5: the `User-agent: *` block in robots.txt can never become
// `Disallow: /`.
//
// A whole-site deindex is the largest reversible mistake this repo can make. It
// is one line, it ships on a green build, nothing in the app looks different,
// and the damage compounds for as long as it takes somebody to notice traffic
// is gone.
//
// Before this file there were exactly four `Disallow` assertions in the repo
// (src/test/seo-crawl.test.ts:41, :54, :76, :90) and all four assert a Disallow
// is PRESENT for a NAMED agent: the private-path list, and the hard blocks on
// Bytespider and the opted-out training crawlers. Not one of them says anything
// about the wildcard block. buildRobotsTxt hard-codes `Allow: /` there, so the
// site is safe today, but that is a property of the code rather than a stated
// rule, and a property nobody wrote down is a property the next edit is free to
// remove.
//
// This file supplements those four; it replaces none of them. They assert
// coverage (these agents ARE blocked); this asserts a ceiling (this agent is
// never blocked).
//
// Checked at both levels, because they can fail apart: the pure builder over
// every reachable input, and the /robots.txt Pages Function over every env.

// NOTE ON THE IMPORT. functions/robots.txt.ts declares PagesFunction, a Workers
// global only tsconfig.functions.json provides, so a static import pulls it into
// the app project and fails `tsc -b`. The specifier is assembled at runtime so
// TypeScript does not follow it; vitest resolves it. Same idiom as
// src/test/llms-txt-upstream-failure.test.ts. The pure builder below is imported
// normally, because seo-config.ts carries no Workers globals.

import { beforeAll, describe, expect, it } from "vitest";
import {
  buildRobotsTxt,
  trainingCrawlersAllowed,
  DISALLOWED_PATHS,
} from "../../functions/_shared/seo-config";
import type { PagesEnv } from "../../functions/_shared/blog-render";

type Handler = (context: unknown) => Promise<Response>;

let onRequestGet: Handler;

beforeAll(async () => {
  const specifier = "../../functions/" + "robots.txt";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    onRequestGet: Handler;
  };
  onRequestGet = mod.onRequestGet;
});

/**
 * Split a robots.txt into its groups. A group is one or more `User-agent:` lines
 * followed by the rules that apply to them, which is how a crawler reads the
 * file -- NOT line by line, which is how a substring assertion reads it.
 */
export function robotsGroups(
  txt: string,
): Array<{ agents: string[]; rules: string[] }> {
  const groups: Array<{ agents: string[]; rules: string[] }> = [];
  let current: { agents: string[]; rules: string[] } | null = null;
  let expectingAgents = true;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const ua = /^user-agent:\s*(.+)$/i.exec(line);
    if (ua) {
      if (!current || !expectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        expectingAgents = true;
      }
      current.agents.push((ua[1] ?? "").trim());
      continue;
    }
    if (/^(allow|disallow|crawl-delay):/i.test(line)) {
      if (current) {
        current.rules.push(line);
        expectingAgents = false;
      }
      continue;
    }
    // Sitemap:, LLM-Full: and friends are file-level, not group-level.
    expectingAgents = true;
    current = null;
  }
  return groups;
}

/** True when this group tells the agent the whole site is off limits. */
function deindexesEverything(rules: string[]): boolean {
  const disallows = rules
    .filter((r) => /^disallow:/i.test(r))
    .map((r) => r.replace(/^disallow:\s*/i, "").trim());
  // `Disallow: /` blocks the entire site. `Disallow:` (empty) means the
  // opposite, and `Disallow: /admin` is a path.
  return disallows.includes("/");
}

const SITE = "https://gradethread.com";

// Every value the deployed env can take. AI_TRAINING_CRAWLERS is the ONLY input
// the route feeds this builder, so this is the complete reachable input space,
// not a sample of it.
const TRAINING_POLICIES = [
  undefined,
  "",
  "true",
  "false",
  "TRUE",
  "no",
  "yes",
  "nonsense",
] as const;

describe("US-3383 AC5: robots.txt can never deindex the site", () => {
  it("parses into groups the way a crawler reads them (self-check)", () => {
    // Prove the parser can SEE a wildcard deindex before trusting it not to
    // find one. A parser that returns nothing looks exactly like a clean file.
    const bad = "User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n";
    const groups = robotsGroups(bad);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.agents).toEqual(["*"]);
    expect(deindexesEverything(groups[0]?.rules ?? [])).toBe(true);
    expect(deindexesEverything(groups[1]?.rules ?? [])).toBe(false);

    // And that a PATH disallow is not mistaken for a site-wide one, or this
    // guard would fail on the very file it is meant to protect.
    const fine = "User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /login\n";
    expect(deindexesEverything(robotsGroups(fine)[0]?.rules ?? [])).toBe(false);

    // Two agents sharing one rule block is a single group, and the wildcard in
    // it still counts. A line-by-line assertion misses this shape entirely.
    const shared = "User-agent: *\nUser-agent: GPTBot\nDisallow: /\n";
    const sharedGroups = robotsGroups(shared);
    expect(sharedGroups).toHaveLength(1);
    expect(sharedGroups[0]?.agents).toEqual(["*", "GPTBot"]);
    expect(deindexesEverything(sharedGroups[0]?.rules ?? [])).toBe(true);
  });

  it("the wildcard group allows the site under every training policy", () => {
    for (const policy of TRAINING_POLICIES) {
      const txt = buildRobotsTxt({
        siteUrl: SITE,
        allowTraining: trainingCrawlersAllowed(policy),
      });
      const wildcard = robotsGroups(txt).filter((g) => g.agents.includes("*"));
      expect(wildcard.length, `no wildcard group at all for policy=${policy}`).toBe(1);
      const rules = wildcard[0]?.rules ?? [];
      expect(
        deindexesEverything(rules),
        `AI_TRAINING_CRAWLERS=${policy} produced "User-agent: *" + "Disallow: /", ` +
          "which deindexes gradethread.com",
      ).toBe(false);
      expect(rules.some((r) => /^allow:\s*\/$/i.test(r))).toBe(true);
    }
  });

  it("fires on the REAL file once its wildcard Allow is flipped (sabotage)", () => {
    // The self-check above proves the detector works on hand-written input. This
    // proves it works on what buildRobotsTxt actually emits, which is the thing
    // that would change. The scope fence on this story forbids editing
    // functions/, so the mutation is applied to the produced string.
    const real = buildRobotsTxt({ siteUrl: SITE });
    const sabotaged = real.replace("User-agent: *\nAllow: /", "User-agent: *\nDisallow: /");
    // Assert the mutation LANDED. A replace that matched nothing returns the
    // input unchanged and the assertion below would then be testing the clean
    // file, passing for the wrong reason.
    expect(sabotaged, "the sabotage matched nothing").not.toBe(real);
    expect(sabotaged).toContain("User-agent: *\nDisallow: /");

    const wildcard = robotsGroups(sabotaged).filter((g) => g.agents.includes("*"));
    expect(wildcard).toHaveLength(1);
    expect(deindexesEverything(wildcard[0]?.rules ?? [])).toBe(true);
    // And the clean original is still clean, so this is not a detector that
    // says yes to everything.
    const clean = robotsGroups(real).filter((g) => g.agents.includes("*"));
    expect(deindexesEverything(clean[0]?.rules ?? [])).toBe(false);
  });

  it("the wildcard group is never SHARED with a hard-blocked agent", () => {
    // The other way to get there: `User-agent: *` appearing in the same group
    // as a blocked bot inherits that group's `Disallow: /`.
    const txt = buildRobotsTxt({ siteUrl: SITE });
    for (const g of robotsGroups(txt)) {
      if (!g.agents.includes("*")) continue;
      expect(g.agents, "the wildcard must stand alone in its group").toEqual(["*"]);
    }
  });

  it("no disallowed PATH is the site root", () => {
    // The cheap way to cause this by accident: a "/" slipping into
    // DISALLOWED_PATHS, which is interpolated into EVERY allowed group.
    for (const p of DISALLOWED_PATHS) {
      expect(p, "a bare / here blocks the whole site for every agent").not.toBe("/");
      expect(p.startsWith("/")).toBe(true);
      expect(p.length).toBeGreaterThan(1);
    }
  });

  it("the served /robots.txt agrees, for every env the route can see", async () => {
    // The builder being right is not the same as the route being right: the
    // route is what a crawler fetches.
    for (const policy of TRAINING_POLICIES) {
      const env: PagesEnv = {
        PUBLIC_SITE_URL: SITE,
        ...(policy === undefined ? {} : { AI_TRAINING_CRAWLERS: policy }),
      } as PagesEnv;
      const res = await onRequestGet({
        request: new Request(`${SITE}/robots.txt`),
        env,
        waitUntil: () => {},
      });
      expect(res.status).toBe(200);
      const txt = await res.text();
      const wildcard = robotsGroups(txt).filter((g) => g.agents.includes("*"));
      expect(wildcard).toHaveLength(1);
      expect(
        deindexesEverything(wildcard[0]?.rules ?? []),
        `/robots.txt served a whole-site Disallow for AI_TRAINING_CRAWLERS=${policy}`,
      ).toBe(false);
      // The file still has to be useful, or "never deindexes" is satisfied by
      // an empty response.
      expect(txt).toContain(`Sitemap: ${SITE}/sitemap.xml`);
      expect(robotsGroups(txt).length).toBeGreaterThan(5);
    }
  });
});
