import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADD_MODES, MOBILE_TABS, tabRoutes } from "@/lib/mobile-tabs";
import { ALL_SURFACES } from "@/lib/surfaces";

// US-2880. The phone web was a hamburger over the desktop sidebar: twenty-three
// entries across five collapsible subgroups. iOS answers the same problem with
// five tabs, and a large share of sellers reach the web from a phone while
// standing in a shop.
//
// The five are declared in src/lib/mobile-tabs.ts and held here against the
// `.tabItem` labels in ios/GradeThread/ContentView.swift -- read out of the
// Swift, not copied into this file, because a copy would be a third list to
// keep in step.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const stripComments = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/\/?.*$/gm, "");

const BAR = "src/components/dashboard/mobile-tab-bar.tsx";
const LAYOUT = "src/layouts/dashboard-layout.tsx";
const SIDEBAR = "src/components/dashboard/sidebar.tsx";
const IOS = "ios/GradeThread/ContentView.swift";

/** The `.tabItem { Label("X", …) }` labels, in TabView order. */
function iosTabLabels(): string[] {
  const src = stripComments(read(IOS));
  const at = src.indexOf("TabView(selection: router.tabSelectionBinding)");
  expect(at, "the iOS TabView is gone").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("\n        .tint(", at));
  return [...body.matchAll(/\.tabItem\s*\{\s*Label\("([^"]+)"/g)].map((m) => m[1]!);
}

describe("five tabs, the same five iOS has (US-2880 AC1)", () => {
  const ios = iosTabLabels();

  it("the Swift extractor read something", () => {
    // A regex that finds nothing reads exactly like perfect parity.
    expect(ios.length, "no .tabItem labels parsed out of ContentView.swift").toBe(5);
  });

  it("the labels match, in the same order", () => {
    expect(
      MOBILE_TABS.map((t) => t.label),
      "the web tab bar and the iOS TabView disagree. Order is part of the " +
        "contract: a seller who uses both builds muscle memory for position.",
    ).toEqual(ios);
  });

  it("every route tab points at a surface the registry knows", () => {
    for (const tab of MOBILE_TABS) {
      if (tab.kind !== "route") continue;
      const s = ALL_SURFACES.find((x) => x.id === tab.surface);
      expect(s, `${tab.label} names surface "${tab.surface}", which is not in the registry`)
        .toBeDefined();
      expect(
        s!.web,
        `${tab.label} points at ${tab.to} but the registry says ${s!.web}`,
      ).toBe(tab.to);
    }
  });

  it("exactly one tab is the Add action", () => {
    const adds = MOBILE_TABS.filter((t) => t.kind === "add");
    expect(adds.length).toBe(1);
    // And it is in the middle, as it is on iOS.
    expect(MOBILE_TABS.findIndex((t) => t.kind === "add")).toBe(2);
  });

  it("the bar renders every tab rather than a hand-picked subset", () => {
    const bar = stripComments(read(BAR));
    expect(bar).toContain("MOBILE_TABS.map(");
    // COUNTED, not toContain: a bar that hardcodes four of the five still
    // contains the word MOBILE_TABS.
    const hardcoded = MOBILE_TABS.filter(
      (t) => t.kind === "route" && bar.includes(`to="${t.to}"`),
    );
    expect(hardcoded, "a tab is hardcoded in the component instead of mapped").toEqual([]);
  });

  it("each route tab has an icon", () => {
    const bar = stripComments(read(BAR));
    for (const t of MOBILE_TABS) {
      if (t.kind !== "route") continue;
      expect(bar, `no icon for ${t.label}`).toContain(`${t.label}:`);
    }
  });
});

describe("the Add tab offers the same three modes as iOS (US-2880 AC2)", () => {
  const ios = stripComments(read(IOS));

  it("the three names are the canonical ones", () => {
    expect(ADD_MODES.map((m) => m.label)).toEqual([
      "Photos first",
      "Details first",
      "Bulk with AI",
    ]);
  });

  it("iOS still names them the same way", () => {
    // US-2860 set these names on iOS. If iOS renames one, the web must follow
    // in the same commit rather than drifting for a quarter.
    for (const m of ADD_MODES) {
      expect(ios, `iOS no longer says "${m.label}"`).toContain(`Label("${m.label}"`);
    }
  });

  it("each mode goes somewhere different, and somewhere real", () => {
    const tos = ADD_MODES.map((m) => m.to);
    expect(new Set(tos).size, "two modes lead to the same place").toBe(3);
    const routes = read("src/routes/index.tsx");
    for (const to of tos) {
      const path = to.split("?")[0]!;
      expect(routes, `${path} is not a route`).toContain(`path: "${path}"`);
    }
  });

  it("the bar opens the chooser rather than jumping straight to one mode", () => {
    // The Add tab on iOS shows three choices. A web tab that navigated
    // straight to the form would silently pick one for the seller.
    const bar = stripComments(read(BAR));
    expect(bar).toContain("ADD_MODES.map(");
    expect(bar).toMatch(/setAddOpen\(true\)/);
  });

  it("the retired web names are gone from the chooser", () => {
    // The web already had all three modes and called two of them something
    // else -- "Snap & Catalog" and "Bulk haul mode". Same seller, same phone,
    // two vocabularies.
    const lib = stripComments(read("src/lib/mobile-tabs.ts"));
    for (const retired of ["Snap & Catalog", "Bulk haul mode"]) {
      expect(lib, `the chooser still says "${retired}"`).not.toContain(retired);
    }
  });
});

describe("the drawer is 'More' now (US-2880 AC3)", () => {
  const sidebar = stripComments(read(SIDEBAR));

  it("the trigger and the sheet both say More", () => {
    expect(sidebar).toContain('aria-label="More"');
    expect(sidebar).toContain(">More</SheetTitle>");
  });

  it("it still holds the whole nav, grouped as it was", () => {
    // "More" must not become a second, shorter list -- the point is that
    // everything not on the bar is still reachable.
    expect(sidebar).toContain("<SidebarNav");
    expect(sidebar).toContain('variant="mobile"');
  });
});

describe("the bar does not sit on top of the content (US-2880 AC4)", () => {
  // COMMENTS STRIPPED. Both files EXPLAIN their safe-area handling in prose,
  // so a bare read() matched the explanation after the code was deleted --
  // two of these three passed with the feature removed until this line.
  it("the bar itself respects the home indicator", () => {
    const bar = stripComments(read(BAR));
    expect(bar).toMatch(/paddingBottom:\s*"env\(safe-area-inset-bottom\)"/);
  });

  it("the scroll container leaves room for it, below md only", () => {
    // Both halves are needed. The bar's own inset positions it; without the
    // main's padding the last row of a list sits under it, and that looks
    // fine until you scroll.
    const layout = stripComments(read(LAYOUT));
    expect(layout).toContain("pb-[calc(5rem+env(safe-area-inset-bottom))]");
    expect(
      layout,
      "the padding is not undone on desktop, where there is no bar",
    ).toContain("md:pb-6");
  });

  it("the bar is hidden at md and up", () => {
    const bar = stripComments(read(BAR));
    expect(bar).toContain("md:hidden");
  });
});

describe("the buyer shell never gets it (US-2880 AC5)", () => {
  it("only the seller layout renders the bar", () => {
    const layout = read(LAYOUT);
    expect(layout).toContain("<MobileTabBar />");
    const buyer = read("src/layouts/buyer-layout.tsx");
    expect(buyer, "the buyer shell renders the seller tab bar").not.toContain("MobileTabBar");
  });

  it("the buyer shell has its own navigation to keep", () => {
    // If BuyerSidebar ever goes away, "hidden on the buyer shell" stops being
    // a decision and starts being a buyer with no nav at all.
    //
    // The RENDER, not the import. Replacing <BuyerSidebar /> with <div /> left
    // the import line intact and a bare toContain went straight past it.
    const buyer = stripComments(read("src/layouts/buyer-layout.tsx"));
    expect(buyer, "the buyer shell imports its sidebar and never renders it").toMatch(
      /<BuyerSidebar\b/,
    );
  });

  it("the bar is not rendered from inside Sidebar", () => {
    // Sidebar is shared; rendering the bar there is how it would leak.
    const sidebar = read(SIDEBAR);
    expect(sidebar).not.toContain("MobileTabBar");
  });
});

describe("the declaration is the only list", () => {
  it("tabRoutes agrees with MOBILE_TABS", () => {
    expect(tabRoutes().length).toBe(4);
    expect(tabRoutes()).toEqual(
      MOBILE_TABS.filter((t) => t.kind === "route").map((t) => t.to),
    );
  });

  it("the layout does not keep a second copy of the five", () => {
    // Matched as a QUOTED route, not a bare substring: the import path
    // "@/components/dashboard/mobile-tab-bar" contains "/dashboard", and the
    // first version of this assertion failed on its own import.
    const layout = stripComments(read(LAYOUT));
    for (const t of MOBILE_TABS) {
      if (t.kind !== "route") continue;
      expect(layout, `dashboard-layout hardcodes a link to ${t.to}`).not.toMatch(
        new RegExp(`(to|href)=["']${t.to}["']`),
      );
    }
  });
});
