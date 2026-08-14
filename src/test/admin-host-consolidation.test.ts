import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_VIEWS,
  NEWSLETTER_VIEWS,
  REWARD_VIEWS,
  RETIRED_ADMIN_PATHS,
  SAFETY_VIEWS,
  resolveAiView,
  resolveNewsletterView,
  resolveRewardView,
  resolveSafetyView,
} from "@/pages/admin/admin-host-tabs";

// US-2559. Four admin domains were sixteen sidebar entries. This is a MERGE,
// not a de-duplication: every page does a distinct job, so nothing is deleted —
// sixteen pages become sixteen tabs across four hosts.

const ROUTES = "src/routes/admin-routes.tsx";
const NAV = "src/layouts/admin-layout.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("every resolver is total (US-2559 AC3)", () => {
  const cases = [
    [resolveRewardView, REWARD_VIEWS] as const,
    [resolveNewsletterView, NEWSLETTER_VIEWS] as const,
    [resolveAiView, AI_VIEWS] as const,
    [resolveSafetyView, SAFETY_VIEWS] as const,
  ];

  it("a known view resolves to itself", () => {
    for (const [resolve_, views] of cases) {
      for (const v of views) expect(resolve_(v)).toBe(v);
    }
  });

  it("absent, unknown and hostile values land on the first tab", () => {
    // A bad query string from an old bookmark or a truncated share link should
    // look like the page, not like a bug.
    for (const [resolve_, views] of cases) {
      for (const bad of [null, undefined, "", "nope", "__proto__", "<script>"]) {
        expect(resolve_(bad)).toBe(views[0]);
      }
    }
  });
});

describe("the payout kill switch stays immediate (US-2559 AC4)", () => {
  it("Economics is the rewards host's FIRST and default view", () => {
    // reward-economics opens with the kill switch and today's spend because an
    // operator in an incident wants "is money still leaving?" answered before
    // anything else. Any other default buries it one click deep.
    expect(REWARD_VIEWS[0]).toBe("economics");
    expect(resolveRewardView(null)).toBe("economics");
  });

  it("and the page still leads with the switch", () => {
    const src = read("src/pages/admin/growth/reward-economics.tsx");
    expect(src).toContain("kill-switch");
    expect(src).toMatch(/the payout switch, at the top, with today's spend beside it/);
  });
});

describe("an existing bookmark still shows what it showed (US-2559 AC5)", () => {
  it("the newsletter host defaults to Health, which that URL already was", () => {
    expect(NEWSLETTER_VIEWS[0]).toBe("health");
    expect(resolveNewsletterView(null)).toBe("health");
  });

  it("every retired path redirects into its host with the matching tab", () => {
    const routes = read(ROUTES);
    for (const [from, to] of Object.entries(RETIRED_ADMIN_PATHS)) {
      // The route table is relative to /admin, so strip the prefix.
      const rel = from.replace(/^\/admin\//, "");
      expect(routes, `${from} has no route`).toContain(`path="${rel}"`);
      expect(routes, `${from} does not redirect to ${to}`).toContain(
        `<Route path="${rel}" element={<Navigate to="${to}" replace />} />`,
      );
    }
  });

  it("the redirect target names a view the host actually has", () => {
    // A redirect to ?view=typo would silently dump the operator on the default
    // tab, which is exactly the failure this AC exists to prevent.
    const byHost: Record<string, readonly string[]> = {
      "/admin/growth/rewards": REWARD_VIEWS,
      "/admin/growth/newsletter": NEWSLETTER_VIEWS,
      "/admin/ai": AI_VIEWS,
      "/admin/safety": SAFETY_VIEWS,
    };
    for (const to of Object.values(RETIRED_ADMIN_PATHS)) {
      const [host, query] = to.split("?");
      const view = new URLSearchParams(query).get("view");
      expect(byHost[host!], `unknown host ${host}`).toBeDefined();
      expect(byHost[host!], `${to} names a view the host lacks`).toContain(view);
    }
  });

  it("it replaces rather than pushes, so Back does not bounce", () => {
    const routes = read(ROUTES);
    const redirects = routes.match(/<Navigate to="\/admin\/[^"]+" replace \/>/g) ?? [];
    expect(redirects.length).toBeGreaterThanOrEqual(
      Object.keys(RETIRED_ADMIN_PATHS).length,
    );
  });
});

describe("nothing was deleted (US-2559 AC2)", () => {
  it("all sixteen pages are still mounted, on a host", () => {
    const hosts = [
      "src/pages/admin/rewards-host.tsx",
      "src/pages/admin/newsletter-host.tsx",
      "src/pages/admin/ai-host.tsx",
      "src/pages/admin/safety-host.tsx",
    ].map(read).join("\n");
    for (const mod of [
      "@/pages/admin/growth/reward-economics",
      "@/pages/admin/growth/reward-milestones",
      "@/pages/admin/growth/quests",
      "@/pages/admin/growth/reward-north-star",
      "@/pages/admin/incentives",
      "@/pages/admin/newsletter-analytics",
      "@/pages/admin/newsletter",
      "@/pages/admin/newsletter-subscribers",
      "@/pages/admin/suppressions",
      "@/pages/admin/ai-models",
      "@/pages/admin/ai-spend",
      "@/pages/admin/ai-profitability",
      "@/pages/admin/monitoring",
      "@/pages/admin/moderation",
      "@/pages/admin/fraud",
      "@/pages/admin/safety-signals",
    ]) {
      expect(hosts, `${mod} is no longer mounted anywhere`).toContain(`"${mod}"`);
    }
  });

  it("the host tab count matches the declared view count", () => {
    const pairs: Array<[string, readonly string[]]> = [
      ["src/pages/admin/rewards-host.tsx", REWARD_VIEWS],
      ["src/pages/admin/newsletter-host.tsx", NEWSLETTER_VIEWS],
      ["src/pages/admin/ai-host.tsx", AI_VIEWS],
      ["src/pages/admin/safety-host.tsx", SAFETY_VIEWS],
    ];
    for (const [rel, views] of pairs) {
      const src = read(rel);
      for (const v of views) {
        expect(src, `${rel} has no "${v}" tab`).toContain(`value: "${v}"`);
      }
      const declared = src.match(/\{ value: "/g) ?? [];
      expect(declared.length, `${rel} tab count`).toBe(views.length);
    }
  });
});

describe("each host names itself (US-2559 AC3)", () => {
  it("the shared host renders a PageHeader above the tabs", () => {
    // US-2548 had to retrofit exactly this onto four FlipDesk hosts that
    // shipped a bare tab strip. Baked into the shared component so no host
    // here can repeat it.
    const src = read("src/pages/admin/admin-tab-host.tsx");
    expect(src.indexOf("<PageHeader")).toBeLessThan(src.indexOf("<TabsList>"));
    expect(src).toContain("TabHostContext.Provider");
    // Only the active view mounts — these pages poll.
    expect(src).toContain("{active === value && (");
  });

  it("every host passes a title", () => {
    for (const rel of [
      "src/pages/admin/rewards-host.tsx",
      "src/pages/admin/newsletter-host.tsx",
      "src/pages/admin/ai-host.tsx",
      "src/pages/admin/safety-host.tsx",
    ]) {
      expect(read(rel)).toMatch(/title="[^"]+"/);
    }
  });
});

describe("the sidebar is four entries, not sixteen (US-2559 AC1)", () => {
  const nav = () => read(NAV);

  it("the hosts are in the nav", () => {
    for (const to of [
      "/admin/growth/rewards",
      "/admin/growth/newsletter",
      "/admin/ai",
      "/admin/safety",
    ]) {
      expect(nav(), `${to} missing from the nav`).toContain(`to: "${to}"`);
    }
  });

  it("the retired entries are gone from it", () => {
    for (const to of Object.keys(RETIRED_ADMIN_PATHS)) {
      // /admin/growth/newsletter is NOT retired — it became the host.
      if (to === "/admin/growth/newsletter") continue;
      expect(nav(), `${to} is still a nav entry`).not.toContain(`to: "${to}"`);
    }
  });

  it("rate limits and passport integrity keep their own entries", () => {
    // Neither is abuse triage: one is capacity administration, the other is
    // ledger integrity. Merging them would have been the de-duplication this
    // story explicitly is not.
    expect(nav()).toContain('to: "/admin/safety/rate-limits"');
    expect(nav()).toContain('to: "/admin/safety/passport-integrity"');
  });
});
