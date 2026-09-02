import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { ANALYTICS_EVENTS } from "@/lib/analytics-events";
import {
  addWidget,
  addableWidgets,
  catalogGroups,
  hideWidget,
  layoutDiff,
  moveWidget,
  moveWidgetBy,
  normalize,
  resetLayout,
  resizeWidget,
  sameLayout,
} from "@/lib/dashboard-layout";
import {
  defaultLayoutFor,
  widgetsForSurface,
  type LayoutEntry,
  type WidgetDef,
} from "@/lib/dashboard-widgets";

// US-3074 AC5: every edit Customize mode can make is a pure action over a
// LayoutEntry[], so every one of them is a unit test rather than a click-through.
// The component only holds the draft these produce.

const registry = widgetsForSurface("grading");

// A FIXED four-widget board, not the shipped seller default.
//
// It WAS defaultLayoutFor("grading", "seller"), and US-3075 growing that
// default from four widgets to thirteen broke eleven assertions here that are
// about arrayMove and nothing else. What a reducer does to a list is not a
// claim about which list ships. Which list ships has its own tests:
// dashboard-widget-registry, dashboard-own-data-first and
// dashboard-board-order.
const startingBoard: readonly LayoutEntry[] = [
  { id: "grading.usage", size: "lg" },
  { id: "grading.charts", size: "lg" },
  { id: "grading.impact", size: "md" },
  { id: "grading.invite", size: "md" },
];

/** The four-widget board every action here starts from. */
function board(): LayoutEntry[] {
  return startingBoard.map((e) => ({ ...e }));
}

function ids(entries: readonly LayoutEntry[]): string[] {
  return entries.map((e) => e.id);
}

function sizeOf(entries: readonly LayoutEntry[], id: string): string | undefined {
  return entries.find((e) => e.id === id)?.size;
}

// A registry the shipped one cannot yet provide: US-3076 adds the FlipDesk
// widgets, and the persona rule has to be proven BEFORE they land, not after a
// buyer has been offered one.
const MIXED_REGISTRY: WidgetDef[] = [
  {
    id: "grading.impact",
    surface: "grading",
    title: "Circularity impact",
    blurb: "What reselling kept out of landfill.",
    category: "data",
    sizes: ["sm", "md"],
    defaultSize: "md",
    rangeAware: false,
    personas: ["seller", "buyer"],
    queryKeys: [],
    load: () => Promise.reject(new Error("not loaded in tests")),
  },
  {
    id: "flipdesk.sales",
    surface: "flipdesk",
    title: "Sales this month",
    blurb: "What sold and for how much.",
    category: "data",
    sizes: ["md", "lg"],
    defaultSize: "md",
    rangeAware: true,
    personas: ["seller", "consignment"],
    queryKeys: [],
    load: () => Promise.reject(new Error("not loaded in tests")),
  },
  {
    id: "flipdesk.relist",
    surface: "flipdesk",
    title: "Ready to relist",
    blurb: "Listings that have gone stale.",
    category: "action",
    sizes: ["md"],
    defaultSize: "md",
    rangeAware: false,
    personas: ["seller"],
    queryKeys: [],
    load: () => Promise.reject(new Error("not loaded in tests")),
  },
  {
    id: "grading.invite",
    surface: "grading",
    title: "Invite a friend",
    blurb: "Your referral link.",
    category: "promo",
    sizes: ["sm", "md"],
    defaultSize: "md",
    rangeAware: false,
    personas: ["seller", "buyer", "consignment", "developer"],
    queryKeys: [],
    load: () => Promise.reject(new Error("not loaded in tests")),
  },
];

describe("moveWidget (drag drop)", () => {
  it("puts the dragged widget where the one it was dropped on sits", () => {
    expect(ids(moveWidget(board(), "grading.invite", "grading.usage"))).toEqual([
      "grading.invite",
      "grading.usage",
      "grading.charts",
      "grading.impact",
    ]);
  });

  it("moves downward as well as up", () => {
    expect(ids(moveWidget(board(), "grading.usage", "grading.impact"))).toEqual([
      "grading.charts",
      "grading.impact",
      "grading.usage",
      "grading.invite",
    ]);
  });

  it("is a no-op when a widget is dropped on itself", () => {
    const next = moveWidget(board(), "grading.usage", "grading.usage");
    expect(next).toEqual(startingBoard);
  });

  it("is a no-op when either id is not on the board", () => {
    expect(moveWidget(board(), "grading.nope", "grading.usage")).toEqual(startingBoard);
    expect(moveWidget(board(), "grading.usage", "grading.nope")).toEqual(startingBoard);
  });

  it("does not mutate the layout it was given", () => {
    const before = board();
    moveWidget(before, "grading.invite", "grading.usage");
    expect(before).toEqual(startingBoard);
  });
});

describe("moveWidgetBy (the narrow-screen buttons)", () => {
  it("moves a widget up one place", () => {
    expect(ids(moveWidgetBy(board(), "grading.impact", -1))).toEqual([
      "grading.usage",
      "grading.impact",
      "grading.charts",
      "grading.invite",
    ]);
  });

  it("moves a widget down one place", () => {
    expect(ids(moveWidgetBy(board(), "grading.usage", 1))).toEqual([
      "grading.charts",
      "grading.usage",
      "grading.impact",
      "grading.invite",
    ]);
  });

  it("does not wrap off the top", () => {
    expect(moveWidgetBy(board(), "grading.usage", -1)).toEqual(startingBoard);
  });

  it("does not wrap off the bottom", () => {
    expect(moveWidgetBy(board(), "grading.invite", 1)).toEqual(startingBoard);
  });

  it("is a no-op for a widget that is not on the board", () => {
    expect(moveWidgetBy(board(), "grading.nope", 1)).toEqual(startingBoard);
  });
});

describe("resizeWidget", () => {
  it("applies a size the widget allows", () => {
    const next = resizeWidget(board(), "grading.impact", "sm", registry);
    expect(sizeOf(next, "grading.impact")).toBe("sm");
  });

  it("leaves every other widget alone", () => {
    const next = resizeWidget(board(), "grading.impact", "sm", registry);
    expect(sizeOf(next, "grading.usage")).toBe("lg");
    expect(ids(next)).toEqual(ids(startingBoard));
  });

  // AC5 names this one explicitly. normalize() CLAMPS a disallowed size, because
  // it reconciles an old document against a new registry. A live edit must not:
  // showing a size the seller did not pick reads as the control being broken.
  it("is a NO-OP for a size the widget does not allow, not a clamp", () => {
    const next = resizeWidget(board(), "grading.charts", "sm", registry);
    expect(next).toEqual(startingBoard);
    expect(sizeOf(next, "grading.charts")).toBe("lg");
  });

  it("is a no-op for a second disallowed size on a different widget", () => {
    // grading.usage allows md and lg only.
    expect(resizeWidget(board(), "grading.usage", "sm", registry)).toEqual(
      startingBoard,
    );
  });

  it("is a no-op for an id the registry does not know", () => {
    expect(resizeWidget(board(), "grading.nope", "sm", registry)).toEqual(
      startingBoard,
    );
  });

  it("is a no-op for a registered widget that is not on the board", () => {
    const without = hideWidget(board(), "grading.impact");
    expect(resizeWidget(without, "grading.impact", "sm", registry)).toEqual(without);
  });
});

describe("hideWidget", () => {
  it("takes the widget off the board and leaves the order", () => {
    expect(ids(hideWidget(board(), "grading.charts"))).toEqual([
      "grading.usage",
      "grading.impact",
      "grading.invite",
    ]);
  });

  it("is a no-op for a widget that is not there", () => {
    expect(hideWidget(board(), "grading.nope")).toEqual(startingBoard);
  });

  // The normalizer honors an empty widget list, so hiding everything has to be
  // reachable or Hide would look broken on the last card.
  it("can empty the board", () => {
    const empty = startingBoard.reduce<LayoutEntry[]>(
      (acc, entry) => hideWidget(acc, entry.id),
      board(),
    );
    expect(empty).toEqual([]);
  });
});

describe("addWidget", () => {
  it("appends the widget at its default size", () => {
    const trimmed = hideWidget(board(), "grading.impact");
    const next = addWidget(trimmed, "grading.impact", registry);
    expect(ids(next)).toEqual([
      "grading.usage",
      "grading.charts",
      "grading.invite",
      "grading.impact",
    ]);
    expect(sizeOf(next, "grading.impact")).toBe("md");
  });

  it("is a no-op when the widget is already on the board", () => {
    expect(addWidget(board(), "grading.usage", registry)).toEqual(startingBoard);
  });

  it("is a no-op for an id the registry does not know", () => {
    expect(addWidget(board(), "grading.nope", registry)).toEqual(startingBoard);
  });
});

describe("resetLayout", () => {
  it("restores the persona default", () => {
    const wrecked = hideWidget(moveWidgetBy(board(), "grading.invite", -1), "grading.usage");
    expect(resetLayout(registry, "seller")).toEqual(
      defaultLayoutFor("grading", "seller"),
    );
    expect(resetLayout(registry, "seller")).not.toEqual(wrecked);
  });

  it("is the same board a never-customized account gets", () => {
    expect(resetLayout(registry, "buyer")).toEqual(normalize(null, registry, "buyer"));
  });

  it("gives a buyer the buyer default, not the seller one", () => {
    expect(ids(resetLayout(registry, "buyer"))).toEqual([
      "grading.quick-actions",
      "grading.discover",
      "grading.invite",
    ]);
    expect(ids(resetLayout(registry, "buyer"))).not.toEqual(
      ids(defaultLayoutFor("grading", "seller")),
    );
  });
});

describe("addableWidgets (the Add sheet's list)", () => {
  it("offers what is not already on the board and nothing that is", () => {
    const trimmed = hideWidget(board(), "grading.impact");
    const offered = addableWidgets(trimmed, registry, "seller").map((w) => w.id);
    expect(offered).toContain("grading.impact");
    for (const entry of trimmed) expect(offered).not.toContain(entry.id);
  });

  it("offers nothing when every widget is on the board", () => {
    const everything = registry
      .filter((w) => w.personas.includes("seller"))
      .map((w) => ({ id: w.id, size: w.defaultSize }));
    expect(addableWidgets(everything, registry, "seller")).toEqual([]);
  });

  // AC3. A buyer has no FlipDesk surface, so a flipdesk.* card would query data
  // the account cannot read and render an error frame forever.
  it("never offers a buyer a flipdesk widget", () => {
    const offered = addableWidgets([], MIXED_REGISTRY, "buyer").map((w) => w.id);
    expect(offered).toEqual(["grading.impact", "grading.invite"]);
    expect(offered.some((id) => id.startsWith("flipdesk."))).toBe(false);
  });

  it("does offer a seller the same flipdesk widgets", () => {
    expect(addableWidgets([], MIXED_REGISTRY, "seller").map((w) => w.id)).toEqual([
      "grading.impact",
      "flipdesk.sales",
      "flipdesk.relist",
      "grading.invite",
    ]);
  });

  it("drops a widget whose persona list excludes the viewer", () => {
    // consignment is offered flipdesk.sales but not flipdesk.relist.
    expect(
      addableWidgets([], MIXED_REGISTRY, "consignment").map((w) => w.id),
    ).toEqual(["flipdesk.sales", "grading.invite"]);
  });

  // The guard for when US-3076 fills the flipdesk surface: a buyer must not be
  // able to reach one through the shipped registry either.
  it("holds for the shipped registry too", () => {
    for (const surface of ["grading", "flipdesk", "ios-home"] as const) {
      const offered = addableWidgets([], widgetsForSurface(surface), "buyer");
      expect(offered.filter((w) => w.id.startsWith("flipdesk."))).toEqual([]);
    }
  });
});

describe("catalogGroups", () => {
  it("groups in WIDGET_CATEGORIES order and drops empty sections", () => {
    const groups = catalogGroups(addableWidgets([], MIXED_REGISTRY, "seller"));
    expect(groups.map((g) => g.category)).toEqual(["data", "action", "promo"]);
    expect(groups[0]?.widgets.map((w) => w.id)).toEqual([
      "grading.impact",
      "flipdesk.sales",
    ]);
  });

  it("renders no section for a category with nothing in it", () => {
    const groups = catalogGroups(addableWidgets([], MIXED_REGISTRY, "buyer"));
    expect(groups.map((g) => g.category)).toEqual(["data", "promo"]);
  });
});

describe("sameLayout", () => {
  it("is true for the same ids, order and sizes", () => {
    expect(sameLayout(board(), board())).toBe(true);
  });

  it("is false when the order differs", () => {
    expect(sameLayout(board(), moveWidgetBy(board(), "grading.usage", 1))).toBe(false);
  });

  it("is false when a size differs", () => {
    expect(
      sameLayout(board(), resizeWidget(board(), "grading.impact", "sm", registry)),
    ).toBe(false);
  });

  it("is false when the lengths differ", () => {
    expect(sameLayout(board(), hideWidget(board(), "grading.usage"))).toBe(false);
  });
});

describe("layoutDiff (the counters on dashboard_layout_saved)", () => {
  it("counts nothing when nothing changed", () => {
    expect(layoutDiff(board(), board())).toEqual({
      moved: 0,
      resized: 0,
      hidden: 0,
      added: 0,
    });
  });

  it("counts a resize", () => {
    expect(
      layoutDiff(board(), resizeWidget(board(), "grading.impact", "sm", registry)),
    ).toEqual({ moved: 0, resized: 1, hidden: 0, added: 0 });
  });

  it("counts a hide", () => {
    expect(layoutDiff(board(), hideWidget(board(), "grading.charts"))).toEqual({
      moved: 0,
      resized: 0,
      hidden: 1,
      added: 0,
    });
  });

  it("counts an add", () => {
    const trimmed = hideWidget(board(), "grading.impact");
    expect(layoutDiff(trimmed, addWidget(trimmed, "grading.impact", registry))).toEqual({
      moved: 0,
      resized: 0,
      hidden: 0,
      added: 1,
    });
  });

  it("counts a move", () => {
    const counts = layoutDiff(board(), moveWidget(board(), "grading.invite", "grading.usage"));
    expect(counts.moved).toBeGreaterThan(0);
    expect(counts).toMatchObject({ resized: 0, hidden: 0, added: 0 });
  });

  // The reason moved is measured over the ids present in BOTH: hiding the top
  // widget shifts every index below it, and calling that three moves would make
  // the number useless for the one question it answers.
  it("does not report a hide as a move of everything under it", () => {
    expect(layoutDiff(board(), hideWidget(board(), "grading.usage"))).toEqual({
      moved: 0,
      resized: 0,
      hidden: 1,
      added: 0,
    });
  });

  it("does not report an append as a move", () => {
    const trimmed = hideWidget(board(), "grading.impact");
    expect(
      layoutDiff(trimmed, addWidget(trimmed, "grading.impact", registry)).moved,
    ).toBe(0);
  });

  it("counts a whole edit pass together", () => {
    let next = board();
    next = moveWidget(next, "grading.invite", "grading.usage");
    next = resizeWidget(next, "grading.impact", "sm", registry);
    next = hideWidget(next, "grading.charts");
    expect(layoutDiff(board(), next)).toMatchObject({
      resized: 1,
      hidden: 1,
      added: 0,
    });
    expect(layoutDiff(board(), next).moved).toBeGreaterThan(0);
  });
});

// AC6. A declared event nobody emits is a dashboard that stays flat and nobody
// notices; an emitted event with no note is a name a future reader has to guess
// the meaning of. Both halves are asserted.
describe("the Customize-mode analytics events", () => {
  const SOURCE = "src/components/dashboard/customize-board.tsx";
  const names = [
    "dashboard_layout_saved",
    "dashboard_layout_reset",
    "dashboard_widget_added",
    "dashboard_widget_hidden",
  ] as const;

  const source = readFileSync(resolve(process.cwd(), SOURCE), "utf8");

  it.each(names)("%s is declared with a note saying what it observes", (name) => {
    const note = ANALYTICS_EVENTS[name];
    expect(typeof note).toBe("string");
    expect(note.length).toBeGreaterThan(20);
  });

  it.each(names)("%s is emitted through track()", (name) => {
    expect(source).toContain(`track("${name}"`);
  });

  it("carries the properties the story names", () => {
    expect(source).toContain("widget_count");
    expect(source).toContain("widget_id");
    // moved / resized / hidden / added arrive spread from layoutDiff().
    expect(source).toContain("...counts");
  });
});
