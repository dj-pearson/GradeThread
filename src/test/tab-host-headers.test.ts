import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// US-2548. Four FlipDesk hosts and the Account hub rendered a bare TabsList and
// no title of their own, so the screen read: app chrome, an unlabelled row of
// tabs, then the CHILD page's heading. A seller who clicked Money in the sidebar
// landed on a page that said "Finances" and never said Money.
//
// The rule this asserts is one h1 per screen, owned by the host. It is a class
// guard, not five instance checks: any file that renders a TabsList and lazily
// hosts other PAGES has to name itself.

const HOSTS = [
  "src/pages/flipdesk/money.tsx",
  "src/pages/flipdesk/pricing.tsx",
  "src/pages/flipdesk/sourcing.tsx",
  "src/pages/flipdesk/autolister-host.tsx",
  "src/pages/account.tsx",
];

// Reached from a batch rather than from the AutoLister host: /autolister/queue
// and /autolister/bulk-edit are their OWN routes, so they keep an h1 of their
// own and must not be folded into HOSTED.
const STANDALONE = [
  "src/pages/flipdesk/autolister-queue.tsx",
  "src/pages/flipdesk/autolister-bulk-edit.tsx",
];

// The children each host mounts. Every one of them must route its heading
// through PageHeader, because that is the only thing the embed context can
// suppress — a hand-rolled <h1> stacks under the host title no matter what.
const HOSTED = [
  "src/pages/finances.tsx",
  "src/pages/flipdesk/expenses.tsx",
  "src/pages/flipdesk/reconcile.tsx",
  "src/pages/flipdesk/repricing.tsx",
  "src/pages/flipdesk/bulk-pricing.tsx",
  "src/pages/price-suggestions.tsx",
  "src/pages/flipdesk/automations.tsx",
  "src/pages/flipdesk/scout.tsx",
  "src/pages/flipdesk/scout-buy.tsx",
  "src/pages/flipdesk/radar.tsx",
  "src/pages/flipdesk/my-stores.tsx",
  "src/pages/flipdesk/sources.tsx",
  "src/pages/flipdesk/demand.tsx",
  "src/pages/flipdesk/autolister.tsx",
  "src/pages/flipdesk/autolister-drafts.tsx",
  "src/pages/settings.tsx",
  "src/pages/billing.tsx",
  "src/pages/team.tsx",
  "src/pages/api-keys.tsx",
  "src/pages/referrals.tsx",
];

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("a tab host names itself (US-2548 AC1, AC2)", () => {
  for (const rel of HOSTS) {
    it(`${rel} renders its own PageHeader`, () => {
      const src = read(rel);
      expect(src, "no PageHeader import").toContain(
        'from "@/components/ui/page-header"',
      );
      expect(src, "no PageHeader rendered").toContain("<PageHeader");
      expect(src).toMatch(/<PageHeader[\s\S]{0,200}title="/);
    });

    it(`${rel} puts its own header OUTSIDE the embed provider`, () => {
      // Inside it, the header suppresses itself: PageHeader returns null when
      // embedded and it has no actions, so the host title never renders and the
      // page looks exactly as broken as before the fix.
      const src = read(rel);
      const header = src.indexOf("<PageHeader");
      const provider = src.indexOf("<PageHostContext.Provider");
      expect(header).toBeGreaterThan(-1);
      expect(provider).toBeGreaterThan(-1);
      expect(header, "the host header is inside the provider").toBeLessThan(
        provider,
      );
    });

    it(`${rel} suppresses its children's headings`, () => {
      const src = read(rel);
      expect(src).toContain('from "@/hooks/use-page-host"');
      expect(src).toContain("<PageHostContext.Provider value={{ embedded: true }}>");
    });
  }

  it("no page hosts other pages in tabs without naming itself", () => {
    // The class, stated once. A file that lazily imports two or more PAGE
    // modules and renders a TabsList is a host by definition.
    const offenders: string[] = [];
    for (const rel of pageFiles()) {
      const src = read(rel);
      if (!src.includes("<TabsList")) continue;
      const lazyPages = (src.match(/lazy\(\(\) =>\s*\n?\s*import\("@\/pages\//g) ?? [])
        .length;
      if (lazyPages < 2) continue;
      if (!src.includes("<PageHeader")) offenders.push(rel);
    }
    expect(
      offenders,
      "these render a tab strip over other pages and never say where you are:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});

describe("a hosted page has no second h1 (US-2548 AC2)", () => {
  for (const rel of HOSTED) {
    it(`${rel} routes its heading through PageHeader`, () => {
      const src = read(rel);
      // A hand-rolled page <h1> cannot be suppressed by the embed context, so
      // it stacks a second title under the host's. Section-level <h2>s are
      // fine and deliberately not matched.
      expect(src, "hand-rolls a page <h1>").not.toMatch(
        /<h1 className="[^"]*text-2xl font-bold/,
      );
    });
  }
});

describe("a page reached from a batch still owns its h1", () => {
  for (const rel of STANDALONE) {
    it(rel + " renders a PageHeader", () => {
      // Demoting these to h2 while fixing the hosts would leave a real route
      // with no page title at all — they are not inside any host.
      const src = read(rel);
      expect(src).toContain("<PageHeader");
    });
  }
});

describe("the hosts show a skeleton, not a spinner (US-2548 AC3)", () => {
  for (const rel of HOSTS.filter((h) => h.includes("flipdesk"))) {
    it(`${rel} uses HostViewSkeleton`, () => {
      const src = read(rel);
      expect(src).toContain("HostViewSkeleton");
      expect(src, "still falls back to a bare spinner").not.toMatch(
        /fallback=\{<(ViewLoading|TabLoading)/,
      );
      expect(src).not.toContain("Loader2");
    });
  }
});

describe("Analytics has one date range for the page (US-2548 AC4)", () => {
  const src = read("src/pages/flipdesk/analytics.tsx");

  it("the control is rendered once, at page level", () => {
    expect(src).toContain("function RangeSelect()");
    expect((src.match(/<RangeSelect \/>/g) ?? []).length).toBe(1);
    // The three per-report copies are gone. They were one state behind three
    // controls, each with a different (and in two cases wrong) aria-label.
    expect(src).not.toContain('aria-label="Profit date range"');
    expect(src).not.toContain('aria-label="Sell-through date range"');
    expect(src).not.toContain('aria-label="Trends date range"');
    expect((src.match(/aria-label="Date range"/g) ?? []).length).toBe(1);
  });

  it("only the reports that use a range show one", () => {
    expect(src).toContain("RANGE_TABS");
    expect(src).toMatch(/actions=\{RANGE_TABS\.has\(tab\) \? <RangeSelect \/> : null\}/);
  });

  it("the range survives a tab click", () => {
    // The real defect: the value was already shared through ?preset=, and the
    // tab navigation threw the whole query string away.
    expect(src).toContain("+ location.search");
  });

  it("only RangeSelect can set the preset", () => {
    // Every other caller reads it. Two writers onto one URL param is how the
    // control and the data disagree.
    expect((src.match(/setPreset/g) ?? []).length).toBeGreaterThan(0);
    const setters = src.match(/const \[preset, setPreset\] = usePresetParam\(\)/g) ?? [];
    expect(setters.length).toBe(1);
  });
});

/** Every page module, so the class check finds hosts nobody listed. */
function pageFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
      if (e.name === "__tests__") continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".tsx")) out.push(rel);
    }
  };
  walk("src/pages");
  return out;
}
