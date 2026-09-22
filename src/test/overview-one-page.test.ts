import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  availableOverviewViews,
  overviewViewDef,
  overviewViewKey,
  readOverviewView,
  resolveOverviewView,
  writeOverviewView,
  DEFAULT_OVERVIEW_VIEW,
  OVERVIEW_VIEWS,
  OVERVIEW_VIEW_DEFS,
} from "@/lib/overview-view";
import { widgetsForSurface, DASHBOARD_SURFACES } from "@/lib/dashboard-widgets";

// US-3469. The product had two overviews and they were the same page twice:
// /dashboard was the grading board, /dashboard/flipdesk was the FlipDesk board,
// each a thin wrapper over CustomizableWidgetBoard with its own Customize
// button. A seller who grades AND resells checked two pages every morning.
//
// They are one page with two views now. What is worth a guard is not the
// merge -- that is visible in the diff -- but the four things that go quietly
// wrong afterwards: a link that stops meaning what it says, a buyer stranded on
// a board with no widgets, an old URL that 404s, and a second copy of the page
// left behind for somebody to edit by mistake.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("which view a seller lands on (AC1, AC2)", () => {
  it("the URL beats what they last used", () => {
    // The whole reason the view is a param. Someone hands a colleague
    // "/dashboard?view=flipdesk"; it has to open FlipDesk even for a colleague
    // who lives in the grading board.
    expect(resolveOverviewView("flipdesk", "grading", "seller")).toBe("flipdesk");
    expect(resolveOverviewView("grading", "flipdesk", "seller")).toBe("grading");
  });

  it("what they last used beats the shipped default", () => {
    expect(resolveOverviewView(null, "flipdesk", "seller")).toBe("flipdesk");
    expect(resolveOverviewView("", "flipdesk", "seller")).toBe("flipdesk");
  });

  it("the shipped default is the answer when nothing else says anything", () => {
    expect(resolveOverviewView(null, null, "seller")).toBe(DEFAULT_OVERVIEW_VIEW);
  });

  it("a value nobody recognises is ignored rather than rendered", () => {
    // A retired view id in a two-year-old bookmark must not produce a blank
    // page, and it must not fall through to the remembered value either when
    // that value is also junk.
    expect(resolveOverviewView("money", "nonsense", "seller")).toBe(
      DEFAULT_OVERVIEW_VIEW,
    );
  });
});

describe("a buyer is not offered a board that has nothing on it (AC5)", () => {
  it("sees one view", () => {
    expect(availableOverviewViews("buyer").map((v) => v.id)).toEqual(["grading"]);
  });

  it("every other persona sees both", () => {
    for (const persona of ["seller", "consignment", "developer"] as const) {
      expect(availableOverviewViews(persona).map((v) => v.id)).toEqual([
        "grading",
        "flipdesk",
      ]);
    }
  });

  it("a stale ?view=flipdesk in a buyer's bookmark lands on grading", () => {
    // Not on an empty FlipDesk board with an Add-widget sheet that offers
    // nothing: DEFAULT_LAYOUTS.flipdesk.buyer is [] and the catalog filters
    // `flipdesk.*` out for this persona, so the page would be a dead end.
    expect(resolveOverviewView("flipdesk", "flipdesk", "buyer")).toBe("grading");
  });
});

describe("each view is a real board", () => {
  it("names a registered surface with widgets on it", () => {
    for (const view of OVERVIEW_VIEW_DEFS) {
      expect(DASHBOARD_SURFACES).toContain(view.surface);
      expect(
        widgetsForSurface(view.surface).length,
        `${view.id} points at a surface with no widgets`,
      ).toBeGreaterThan(0);
    }
  });

  it("every id has exactly one definition", () => {
    expect(OVERVIEW_VIEW_DEFS.map((v) => v.id).sort()).toEqual(
      [...OVERVIEW_VIEWS].sort(),
    );
    for (const id of OVERVIEW_VIEWS) {
      expect(overviewViewDef(id).id).toBe(id);
    }
  });
});

describe("the remembered view (AC2)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is keyed per user, so two people sharing a browser do not swap tabs", () => {
    expect(overviewViewKey("a")).not.toBe(overviewViewKey("b"));
  });

  it("round-trips", () => {
    const key = overviewViewKey("a");
    writeOverviewView(key, "flipdesk");
    expect(readOverviewView(key)).toBe("flipdesk");
  });

  it("reads null rather than throwing on a value that is not a view", () => {
    const key = overviewViewKey("a");
    localStorage.setItem(key, "money");
    expect(readOverviewView(key)).toBeNull();
  });
});

describe("there is one Overview page, and the old URLs still land (AC4)", () => {
  it("the second overview page is deleted, not merely unreferenced", () => {
    expect(
      existsSync(resolve(ROOT, "src/pages/flipdesk/overview.tsx")),
      "src/pages/flipdesk/overview.tsx is back. A second copy of the Overview " +
        "is the thing US-3469 removed; add a view to src/lib/overview-view.ts " +
        "instead.",
    ).toBe(false);
  });

  it("both old FlipDesk overview URLs redirect onto the FlipDesk view", () => {
    const routes = read("src/routes/index.tsx");
    for (const path of [
      '{ path: "/dashboard/flipdesk", element:',
      '{ path: "/dashboard/flipdesk/overview", element:',
    ]) {
      const at = routes.indexOf(path);
      expect(at, `${path} is gone from the router`).toBeGreaterThan(-1);
      const line = routes.slice(at, routes.indexOf("\n", at));
      expect(line, `${path} no longer redirects to the Overview`).toContain(
        '<ViewRedirect to="/dashboard" view="flipdesk" />',
      );
    }
  });

  it("the redirect merges the query string rather than replacing it", () => {
    // /dashboard/flipdesk?range=30d is a real shared link. A bare <Navigate>
    // with a literal query would drop the window the sender chose.
    const routes = read("src/routes/index.tsx");
    const at = routes.indexOf("function ViewRedirect(");
    expect(at).toBeGreaterThan(-1);
    const body = routes.slice(at, at + 400);
    expect(body).toContain("new URLSearchParams(search)");
  });
});

describe("the page itself (AC1, AC3)", () => {
  const page = () => read("src/pages/dashboard.tsx");

  it("renders one board, whose surface comes from the view", () => {
    const src = page();
    expect((src.match(/<CustomizableWidgetBoard/g) ?? []).length).toBe(1);
    expect(src).toContain("surface={def.surface}");
    // Remounted on a view change: Customize mode holds a draft for ONE surface
    // in local state, and carrying it across would offer the grading board
    // FlipDesk widgets to save.
    expect(src).toContain("key={def.surface}");
  });

  it("keeps each view's own header actions", () => {
    const src = page();
    // Grading.
    expect(src).toContain("/dashboard/submissions/new");
    expect(src).toContain("<PwaInstallBanner");
    // FlipDesk.
    expect(src).toContain('aria-label="Reporting period"');
    expect(src).toContain("/dashboard/flipdesk/import");
    expect(src).toContain("/dashboard/flipdesk/intake");
  });

  it("gives the range picker to the FlipDesk view only", () => {
    // The grading board has no range-aware widget. A picker over numbers that
    // ignore it is exactly the lie src/lib/overview-range.ts exists to prevent.
    expect(page()).toContain('range={view === "flipdesk" ? range : undefined}');
  });

  it("puts the switcher in the board's lead slot, not in a second header", () => {
    const src = page();
    expect(src).toContain("<OverviewViewSwitcher");
    expect(src).not.toContain("<PageHeader");
  });

  it("writes the resolved view back to the URL", () => {
    // Without this a remembered FlipDesk view renders on a bare /dashboard and
    // the sidebar lights the Grading row, because the sidebar reads `?view=`.
    expect(page()).toContain("setViewParam(view)");
  });
});

describe("the sidebar can tell the two views apart", () => {
  const side = read("src/components/dashboard/sidebar.tsx");

  it("matches the params a registry link names, not the raw string", () => {
    // `pathname === "/dashboard?view=flipdesk"` is false for every URL there
    // is, which is how Scout, Sources, Repricing, Automations and Reconcile
    // ended up permanently unlit.
    expect(side).toContain("item.to.split(\"?\")");
    expect(side).toContain("new URLSearchParams(search)");
  });

  it("both Overview rows point at the one page", () => {
    const surfaces = read("src/lib/surfaces.ts");
    expect(surfaces).toContain('web: "/dashboard?view=grading"');
    expect(surfaces).toContain('web: "/dashboard?view=flipdesk"');
  });
});
